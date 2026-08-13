# -*- coding: utf-8 -*-
"""Воркер сайта CaseCheck.

   Живёт рядом с телеграм-ботом на машине с мобильным прокси и делит с ним
   один движок ACIS: второй браузер на том же IP только мешал бы. Раз в
   несколько минут спрашивает у сайта, какие дела пора проверить, ходит в суд
   и возвращает разобранный ответ. Наружу машина при этом не выставлена —
   разговор всегда начинаем мы.

   Настройки в .env бота:
     SITE_API            https://uscasecheck.com
     SITE_WORKER_SECRET  общий секрет с сайтом
     SITE_POLL_SECONDS   как часто спрашивать очередь (по умолчанию 300)
     SITE_BATCH          сколько дел забирать за раз (по умолчанию 5)
"""
import asyncio
import json
import logging
import os
import re
import urllib.error
import urllib.request

import config   # подтягивает .env бота в окружение — до чтения настроек ниже
import countries

log = logging.getLogger("site")

SITE = (os.getenv("SITE_API") or "https://uscasecheck.com").rstrip("/")
SECRET = os.getenv("SITE_WORKER_SECRET") or ""
POLL = int(os.getenv("SITE_POLL_SECONDS") or 300)
BATCH = int(os.getenv("SITE_BATCH") or 5)
PAUSE = int(os.getenv("SITE_PAUSE_SECONDS") or 20)   # между делами, чтобы не долбить .gov


# ── разбор ответа ACIS ───────────────────────────────────────────────────────
# Страница отдаётся сплошным текстом; заголовки разделов — единственные опоры.
HEARING = re.compile(
    r"upcoming\s+(?P<kind>[A-Z]+)\s+hearing\s+is\s+(?:(?P<mode>[A-Z][A-Z\- ]*[A-Z])\s+)?on\s+"
    r"(?P<date>[A-Z][a-z]+ \d{1,2}, \d{4})\s+at\s+(?P<time>\d{1,2}:\d{2}\s*[AP]M)",
    re.I)
CITY = re.compile(r"^[A-Z][A-Z .'\-]+,\s*[A-Z]{2}(?:\s+\d{5})?$")


def _city(line):
    """«MIAMI, FL 33130» → «Miami, FL»: индекс лишний, штат капсом остаётся."""
    line = re.sub(r"\s+\d{5}$", "", line.strip())
    city, _, state = line.rpartition(",")
    return (city.title().strip() + ", " + state.strip().upper()) if city else line.title()


def _section(text, start, *stops):
    """Кусок между заголовком и следующим разделом."""
    i = text.find(start)
    if i < 0:
        return ""
    i += len(start)
    end = len(text)
    for s in stops:
        j = text.find(s, i)
        if 0 <= j < end:
            end = j
    return text[i:end].strip()


def _after(text, label):
    """Значение под подписью: у ACIS оно всегда следующей строкой."""
    lines = [l.strip() for l in text.splitlines()]
    for n, l in enumerate(lines):
        if l == label:
            for nxt in lines[n + 1:]:
                if nxt and nxt != "|":
                    return nxt
            return ""
    return ""


def parse(rendered):
    """Из текста страницы — поля, которые показывает кабинет."""
    t = rendered or ""
    out = {"name": "", "hearing": "", "judge": "", "court": "", "decision": ""}

    out["name"] = _after(t, "Name:")

    hear = _section(t, "Next Hearing Information", "Court Decision and Motion Information")
    m = HEARING.search(hear)
    if m:
        kind = m.group("kind").title()
        mode = (m.group("mode") or "").strip()
        when = m.group("date") + " · " + re.sub(r"\s+", " ", m.group("time").upper()).replace("AM", " AM").replace("PM", " PM").replace("  ", " ").strip()
        out["hearing"] = when + " · " + kind + (" · " + mode.title() if mode else "")
    out["judge"] = _after(hear, "JUDGE")

    if "WEBEX ADDRESS" in hear:
        out["court"] = "Online hearing (WebEx)"
    else:
        addr = _section(hear, "COURT ADDRESS")
        city = [l.strip() for l in addr.splitlines() if CITY.match(l.strip())]
        if city:
            out["court"] = _city(city[-1])
    if not out["court"]:
        addr = _section(t, "COURT ADDRESS", "PHONE NUMBER")
        city = [l.strip() for l in addr.splitlines() if CITY.match(l.strip())]
        if city:
            out["court"] = _city(city[-1])

    dec = _section(t, "Court Decision and Motion Information", "BIA Case Information", "Court Contact Information")
    # «дело рассматривается» — это не решение, а его отсутствие
    if dec and not re.match(r"^this case is pending\.?$", dec.strip(), re.I):
        out["decision"] = " ".join(dec.split())[:200]
    return out


# ── разговор с сайтом ────────────────────────────────────────────────────────
def _call(path, payload=None, timeout=30):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        SITE + path, data=data, method="POST" if data else "GET",
        headers={"content-type": "application/json", "x-worker-secret": SECRET,
                 # без своего имени Cloudflare режет python-urllib как бота (1010)
                 "user-agent": "CaseCheck-worker/1.0 (+https://uscasecheck.com)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or "{}")


def _nat_label(country, code):
    """Сайт отдаёт код гражданства, движку нужен ярлык ровно как в их списке."""
    code = (code or "").upper()
    for c, name, label in countries.COUNTRIES:
        if c == code:
            return label
    hit = countries.search(country or "")
    return hit[0][2] if hit else ""


async def _one(engine, case):
    label = _nat_label(case.get("country"), case.get("natCode"))
    if not label:
        return {"id": case["id"], "ok": False, "error": "unknown nationality"}

    res = await engine.lookup(case["aNumber"], label)
    if not res.get("ok"):
        return {"id": case["id"], "ok": False, "error": str(res.get("error"))[:200]}
    if not res.get("found"):
        return {"id": case["id"], "ok": True, "found": False, "message": res.get("message", "")}

    fields = parse(res.get("rendered", ""))
    return {
        "id": case["id"], "ok": True, "found": True,
        "name": res.get("name") or fields["name"],
        "hearing": fields["hearing"], "judge": fields["judge"],
        "court": fields["court"], "decision": fields["decision"],
        "sig": res.get("sig"), "rendered": (res.get("rendered") or "")[:4000],
    }


def bot_numbers():
    """Цифры из базы бота. Сайт их сам не видит: база лежит здесь, на машине
    с движком, поэтому считаем на месте и отдаём готовыми."""
    import sqlite3
    import time as _t
    db = sqlite3.connect(config.DB_PATH)
    one = lambda sql, *a: (db.execute(sql, a).fetchone() or [0])[0] or 0   # noqa: E731
    now_ts = int(_t.time())
    ym = _t.strftime("%Y-%m", _t.gmtime(now_ts))
    try:
        return {
            "users": one("SELECT COUNT(*) FROM users"),
            "usersDay": one("SELECT COUNT(*) FROM users WHERE created_at > ?", now_ts - 86400),
            "subs": one("SELECT COUNT(*) FROM subs WHERE expires_at > ?", now_ts),
            # подписок в боте за всё время = сколько разных людей хоть раз подписывались
            "subsAll": one("SELECT COUNT(DISTINCT tg_id) FROM subs"),
            # выданные руками не должны выглядеть как выручка
            "subsPaid": one("SELECT COUNT(*) FROM subs WHERE expires_at > ? AND source = 'stripe'", now_ts),
            "money30": one("SELECT COALESCE(SUM(amount),0) FROM payments WHERE created_at > ?", now_ts - 30 * 86400),
            "moneyAll": one("SELECT COALESCE(SUM(amount),0) FROM payments"),
            "cases": one("SELECT COUNT(*) FROM cases"),
            "watched": one("SELECT COUNT(*) FROM cases WHERE monitoring = 1"),
            "freeMonth": one("SELECT COUNT(*) FROM free_checks WHERE ym = ? AND used > 0", ym),
        }
    finally:
        db.close()


async def run_site_worker(engine):
    """Вечный цикл. Молчит, если сайт не настроен — бот от этого не страдает."""
    if not SECRET:
        log.info("site worker off: нет SITE_WORKER_SECRET")
        return
    log.info("site worker on: %s, опрос раз в %s с", SITE, POLL)
    await asyncio.sleep(60)   # даём боту и движку подняться

    while True:
        try:
            # снимок цифр бота: сайту он нужен, чтобы показывать оба канала в одном месте
            try:
                await asyncio.to_thread(_call, "/api/worker/botstats", bot_numbers())
            except Exception as e:                           # noqa: BLE001
                log.debug("site: цифры бота не ушли: %s", e)

            got = await asyncio.to_thread(_call, "/api/worker/queue?limit=%d" % BATCH)
            cases = got.get("cases") or []
            if cases:
                log.info("site: взято дел — %d", len(cases))
            for case in cases:
                try:
                    out = await _one(engine, case)
                except Exception as e:                       # noqa: BLE001
                    out = {"id": case["id"], "ok": False, "error": str(e)[:200]}
                try:
                    await asyncio.to_thread(_call, "/api/worker/result", out)
                    log.info("site: дело %s — %s", case["aNumber"],
                             "ошибка: " + out.get("error", "") if not out.get("ok")
                             else ("найдено" if out.get("found") else "нет записи"))
                except Exception as e:                       # noqa: BLE001
                    log.warning("site: результат не отдался: %s", e)
                await asyncio.sleep(PAUSE)
        except urllib.error.HTTPError as e:
            log.warning("site: сайт ответил %s", e.code)
        except Exception as e:                               # noqa: BLE001
            log.warning("site: %s", e)
        await asyncio.sleep(POLL)
