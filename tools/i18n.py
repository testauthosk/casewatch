"""Сборка языковых версий сайта.

Английские страницы в корне — единственный источник правды. Отсюда генерируются
/es/, /ua/, /ru/: текст подменяется по словарю, ключ — сама английская строка.
Так правка английского текста не забывается в переводах: строка меняется, ключ
пропадает из словаря, и сборка прямо скажет, что именно осталось непереведённым.

  python tools/i18n.py extract   — собрать список строк в i18n/_strings.json
  python tools/i18n.py build     — собрать языковые папки
"""
from __future__ import annotations

import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = ("index.html", "login.html", "signup.html")
LANGS = {                     # папка -> (код языка для разметки, подпись на кнопке)
    "es": ("es", "ES"),
    "hi": ("hi", "हि"),
    "ru": ("ru", "RU"),
}
ATTRS = ("placeholder", "alt", "title", "aria-label", "content")

# что не переводим никогда: бренд, контакты, цифры, коды языков, служебные метки
NEVER = {
    "CaseCheck", "Case", "Check", "EOIR", "EN", "ES", "RU", "हि",
    "English", "Espanol", "Español", "Русский", "हिन्दी", "Language",
    "support@casecheck.app", "you@email.com", "240-974-400", "A240-974-400",
    "$9.99", "$75", "+$3", "000000", "Mexico", "Guatemala", "Honduras",
    "El Salvador", "Venezuela", "Cuba", "Nicaragua", "Colombia", "Brazil",
    "Ecuador", "Haiti", "Russia", "Ukraine", "Belarus", "India", "China",
    "Google", "Apple", "Telegram", "WhatsApp", "Stripe",
    "U.S. Department of Justice", "Chicago, IL", "Immigration Court",
}


def skip_report(v: str) -> bool:
    """Строка не считается непереведённой: её и не надо переводить."""
    return (v in NEVER or "@@SCRIPT" in v or v.startswith("width=device-width")
            or re.match(r"^[\d$¢%.,+\-/() ]+$", v) is not None)


# служебное, переводить нечего
IGNORE = re.compile(r"^[\s\d&#;·×—–\-•|/\\()\[\]{}.,:+*]*$")


SCRIPTISH = re.compile(r"<(script|style)[^>]*>.*?</(script|style)>", re.S | re.I)


def mask_scripts(html: str):
    """Прячем содержимое script и style до разбора.

    Внутри inline-скрипта попадается «<» в сравнениях (i<e.length), и наивное
    деление по тегам склеивало кусок кода с настоящей разметкой — из-за этого
    всё, что шло после такого скрипта, в разбор не попадало вообще.
    """
    kept = []

    def take(m):
        kept.append(m.group(0))
        return "@@SCRIPT%d@@" % (len(kept) - 1)

    return SCRIPTISH.sub(take, html), kept


def unmask_scripts(html: str, kept: list) -> str:
    for i, block in enumerate(kept):
        html = html.replace("@@SCRIPT%d@@" % i, block, 1)
    return html


def chunks(html: str):
    """Режем документ на куски: (текст|тег). Тег всегда начинается с '<'."""
    return re.split(r"(<[^>]+>)", html)


def svg_depth(part: str, depth: int) -> int:
    low = part.lower()
    if low.startswith("<svg"):
        return depth + 1
    if low.startswith("</svg"):
        return max(0, depth - 1)
    return depth


def collect(html: str) -> list:
    html, _ = mask_scripts(html)
    out, depth = [], 0
    for part in chunks(html):
        if part.startswith("<"):
            depth = svg_depth(part, depth)
            if depth:
                continue
            for a in ATTRS:
                for m in re.finditer(a + r'="([^"]+)"', part, re.I):
                    v = m.group(1).strip()
                    if v and not IGNORE.match(v) and not v.startswith(("http", "/", "#", "assets/")):
                        out.append(v)
            continue
        if depth:
            continue
        v = part.strip()
        if v and not IGNORE.match(v):
            out.append(v)
    return out


def apply_dict(html: str, d: dict, missing: set) -> str:
    html, kept = mask_scripts(html)
    parts = chunks(html)
    depth = 0
    for i, part in enumerate(parts):
        if part.startswith("<"):
            depth = svg_depth(part, depth)
            if depth:
                continue
            new_tag = part
            for a in ATTRS:
                def sub(m, a=a):
                    v = m.group(1).strip()
                    if not v or IGNORE.match(v) or v.startswith(("http", "/", "#", "assets/")):
                        return m.group(0)
                    if v in d:
                        return a + '="' + d[v] + '"'
                    if not skip_report(v):
                        missing.add(v)
                    return m.group(0)
                new_tag = re.sub(a + r'="([^"]+)"', sub, new_tag, flags=re.I)
            parts[i] = new_tag
            continue
        if depth:
            continue
        v = part.strip()
        if not v or IGNORE.match(v):
            continue
        if v in d:
            parts[i] = part.replace(v, d[v], 1)
        elif not skip_report(v):
            missing.add(v)
    return unmask_scripts("".join(parts), kept)


def localize_paths(html: str) -> str:
    """Страница лежит на уровень глубже — правим ссылки на общие файлы."""
    html = re.sub(r'(src|href)="assets/', r'\1="../assets/', html)
    html = re.sub(r'(src|href)="(favicon[^"]*)"', r'\1="../\2"', html)
    return html


def head_links(html: str, folder: str) -> str:
    """Языковые связи для поиска + канонический адрес.

    Сначала вычищаем прежние: английская страница уже несёт свой блок, и без
    очистки у языковой версии оказывалось два канонических адреса сразу —
    для поиска это прямое противоречие, страница может выпасть из выдачи.
    """
    html = re.sub(r'\s*<link rel="(canonical|alternate)"[^>]*>', "", html)
    base = os.environ.get("SITE_URL", "https://web-production-d3f84.up.railway.app")
    page = "PAGE"
    alts = [f'<link rel="alternate" hreflang="en" href="{base}/{page}">']
    for f, (code, _) in LANGS.items():
        alts.append(f'<link rel="alternate" hreflang="{code}" href="{base}/{f}/{page}">')
    alts.append(f'<link rel="alternate" hreflang="x-default" href="{base}/{page}">')
    canon = f'<link rel="canonical" href="{base}/{folder + "/" if folder else ""}{page}">'
    block = "\n" + canon + "\n" + "\n".join(alts) + "\n"
    return html.replace("</head>", block + "</head>", 1)


def build_page(src_html: str, folder: str, d: dict, missing: set) -> str:
    code = LANGS[folder][0] if folder else "en"
    out = apply_dict(src_html, d, missing) if folder else src_html
    out = re.sub(r'<html lang="[^"]*"', f'<html lang="{code}"', out, count=1)
    if folder:
        out = localize_paths(out)
    out = head_links(out, folder)
    return out


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "build"
    i18n_dir = os.path.join(ROOT, "i18n")
    os.makedirs(i18n_dir, exist_ok=True)

    if cmd == "extract":
        seen, order = set(), []
        for p in PAGES:
            html = io.open(os.path.join(ROOT, p), encoding="utf-8").read()
            for s in collect(html):
                if s not in seen:
                    seen.add(s)
                    order.append(s)
        path = os.path.join(i18n_dir, "_strings.json")
        io.open(path, "w", encoding="utf-8").write(json.dumps(order, ensure_ascii=False, indent=1))
        print(f"строк для перевода: {len(order)} -> {path}")
        return

    total_missing = {}
    for folder in LANGS:
        dict_path = os.path.join(i18n_dir, folder + ".json")
        if not os.path.exists(dict_path):
            print(f"пропускаю {folder}: нет {dict_path}")
            continue
        d = json.load(io.open(dict_path, encoding="utf-8"))
        missing = set()
        out_dir = os.path.join(ROOT, folder)
        os.makedirs(out_dir, exist_ok=True)
        for p in PAGES:
            src = io.open(os.path.join(ROOT, p), encoding="utf-8").read()
            html = build_page(src, folder, d, missing).replace("PAGE", p if p != "index.html" else "")
            io.open(os.path.join(out_dir, p), "w", encoding="utf-8", newline="").write(html)
        total_missing[folder] = sorted(missing)
        print(f"{folder}: страниц {len(PAGES)}, без перевода строк — {len(missing)}")

    # английские страницы тоже получают языковые связи
    for p in PAGES:
        src = io.open(os.path.join(ROOT, p), encoding="utf-8").read()
        if True:
            html = head_links(src, "").replace("PAGE", p if p != "index.html" else "")
            io.open(os.path.join(ROOT, p), "w", encoding="utf-8", newline="").write(html)

    if any(total_missing.values()):
        path = os.path.join(i18n_dir, "_missing.json")
        io.open(path, "w", encoding="utf-8").write(json.dumps(total_missing, ensure_ascii=False, indent=1))
        print("непереведённое выписано в", path)


if __name__ == "__main__":
    main()
