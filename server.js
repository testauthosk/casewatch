/* CaseCheck — статика + учётные записи.

   Центр системы теперь сайт: здесь аккаунт, дела и каналы уведомлений.
   Вход в два шага — пароль, затем код на почту; регистрация тоже
   подтверждается кодом, чтобы в базе не оседали выдуманные адреса. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { db, q, now } = require('./db');
const mail = require('./mail');
const oauth = require('./oauth');
const wa = require('./whatsapp');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_DAYS = 30;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

/* ── мелочи ── */
const send = (res, code, body, type) => {
  res.writeHead(code, { 'content-type': type || 'application/json; charset=utf-8' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const email_ok = (v) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(String(v || '').trim());
const clean = (v) => String(v || '').trim().toLowerCase();

function hash(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pass, salt, 64).toString('hex');
}
function passOk(pass, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, key] = stored.split(':');
  const test = crypto.scryptSync(pass, salt, 64);
  const want = Buffer.from(key, 'hex');
  return test.length === want.length && crypto.timingSafeEqual(test, want);
}

/* Те же правила, что показывает форма: проверка на клиенте — подсказка,
   а не защита, отказать должен сервер. */
function strongEnough(pass) {
  const v = String(pass || '');
  return v.length >= 8 && /[A-Z]/.test(v) && /\d/.test(v) && /[^A-Za-z0-9\s]/.test(v);
}

function newCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function setSession(res, userId, ua) {
  const token = crypto.randomBytes(32).toString('hex');
  const exp = now() + SESSION_DAYS * 86400;
  q.addSession.run(token, userId, now(), exp, String(ua || '').slice(0, 200));
  const sig = crypto.createHmac('sha256', SECRET).update(token).digest('hex').slice(0, 32);
  res.setHeader('set-cookie',
    `cw=${token}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}; Secure`);
  return token;
}

function userFrom(req) {
  const m = /(?:^|;\s*)cw=([a-f0-9]{64})\.([a-f0-9]{32})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const want = crypto.createHmac('sha256', SECRET).update(m[1]).digest('hex').slice(0, 32);
  if (want !== m[2]) return null;
  const s = q.session.get(m[1], now());
  if (!s) return null;
  const u = q.userById.get(s.user_id);
  if (u) q.touch.run(now(), u.id);
  return u || null;
}

/* ── ограничения, чтобы почтой не долбили ── */
const hits = new Map();
function tooOften(key, limit, windowSec) {
  const t = now();
  const arr = (hits.get(key) || []).filter((x) => t - x < windowSec);
  arr.push(t);
  hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > limit;
}

const MAX_CASES = 3;   // больше трёх дел на аккаунт не держим

/* Оплата. Берём те же ссылки Stripe, что и у бота в телеграме: платёж уходит
   на страницу Stripe, а нам возвращается событие через веб-хук. Ссылку в
   браузере проверять нельзя — плательщика подтверждает только подпись Stripe. */
const PAY = {
  month: process.env.STRIPE_LINK_MONTH || '',
  year: process.env.STRIPE_LINK_YEAR || '',
};
const PLAN_DAYS = { month: 31, year: 366 };

/* Подпись веб-хука: заголовок вида «t=<время>,v1=<хэш>», где хэш — HMAC-SHA256
   строки «<время>.<тело>». Тело нужно СЫРОЕ, до разбора JSON. */
function stripeSigOk(raw, header) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
  if (!secret || !header) return false;
  let t = null; const v1 = [];
  String(header).split(',').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') t = v; else if (k === 'v1') v1.push(v);
  });
  if (!t || !v1.length) return false;
  const want = crypto.createHmac('sha256', secret).update(t + '.' + raw).digest('hex');
  return v1.some((got) => got.length === want.length
    && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)));
}

const planFromCents = (cents) => ((cents || 0) >= 5000 ? 'year' : 'month');

function grantPlan(userId, plan, amount, currency, ref) {
  const until = now() + (PLAN_DAYS[plan] || 31) * 86400;
  q.setPlan.run('monitoring', until, userId);
  q.addPayment.run(userId, (amount || 0) / 100, String(currency || 'usd').toUpperCase(), plan, 'stripe', ref || null, now());
  q.addEvent.run(userId, null, 'note', 'Monitoring turned on — ' + (plan === 'year' ? 'yearly' : 'monthly') + ' plan', now());
}

/* Куда ведёт кнопка поддержки. Ссылка в настройках, чтобы поменять адрес
   без выкатки: пока не задана — ведём в самого бота, как в телеграме. */
const SUPPORT = {
  tg: process.env.SUPPORT_TG_URL || 'https://t.me/eoircasestatus_bot',
  email: process.env.SUPPORT_EMAIL || 'support@uscasecheck.com',
};

/* Обращение из кабинета: сначала кладём в базу, потом пробуем донести до нас.
   Даже если телеграм и почта молчат, письмо не пропадает — лежит в support. */
async function tellSupport(ticketId, from, topic, text) {
  const token = process.env.TG_BOT_TOKEN || '';
  const chat = process.env.TG_SUPPORT_CHAT || '';
  let ok = false;

  if (token && chat) {
    const lines = ['🆘 <b>Обращение с сайта</b>', '', '<b>От:</b> ' + esc(from)];
    if (topic) lines.push('<b>Тема:</b> ' + esc(topic));
    lines.push('', esc(text));
    const body = lines.join('\n');
    try {
      const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: body, parse_mode: 'HTML' }),
      });
      ok = r.ok;
      if (!ok) console.error('[support] телеграм отказал:', r.status);
    } catch (e) { console.error('[support] телеграм недоступен:', e.message); }
  }

  if (mail.hasKey()) {
    const html = '<p><b>From:</b> ' + esc(from) + '</p>'
      + (topic ? '<p><b>Topic:</b> ' + esc(topic) + '</p>' : '')
      + '<pre style="font:14px/1.5 Arial,sans-serif;white-space:pre-wrap">' + esc(text) + '</pre>';
    const r = await mail.send(SUPPORT.email, 'Support — ' + (topic || 'message from the cabinet'), html, 'support');
    ok = ok || r.ok;
  }

  if (ok) q.markTicket.run(ticketId);
  return ok;
}

const esc = (v) => String(v).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

async function issueCode(email, purpose) {
  // у показательного аккаунта код постоянный — письма не шлём и лимит не жжём
  const demoEmail = String(process.env.DEMO_EMAIL || '').toLowerCase();
  if (demoEmail && process.env.DEMO_CODE && email === demoEmail) return { ok: true, delivered: false };
  if (q.recentCodes.get(email, now() - 3600).n >= 6) return { ok: false, error: 'too many codes' };
  const code = newCode();
  q.addCode.run(email, code, purpose, now() + 600, now());
  const r = await mail.sendCode(email, code, purpose);
  // без ключа Resend письмо не уйдёт — код виден в логе, поток проверяем целиком
  if (!r.ok) console.warn('[auth] код для', email, '=', code, '(письмо не отправлено)');
  return { ok: true, delivered: r.ok };
}

function checkCode(email, purpose, code) {
  // Показательный аккаунт: пока почта не подключена, письма с кодом не уходят,
  // и войти было бы нельзя. Для одного адреса из настроек принимаем
  // фиксированный код — снимается удалением переменных окружения.
  const demoEmail = String(process.env.DEMO_EMAIL || '').toLowerCase();
  const demoCode = String(process.env.DEMO_CODE || '');
  if (demoEmail && demoCode && email === demoEmail && String(code).trim() === demoCode) {
    return { ok: true };
  }
  const row = q.liveCode.get(email, purpose, now());
  if (!row) return { ok: false, error: 'code expired' };
  if (row.tries >= 5) return { ok: false, error: 'too many attempts' };
  q.bumpTries.run(row.id);
  if (String(code).trim() !== row.code) return { ok: false, error: 'wrong code' };
  q.useCode.run(row.id);
  return { ok: true };
}

function publicUser(u) {
  const cases = q.cases.all(u.id);
  const prefs = q.prefs.get(u.id) || {};
  return {
    email: u.email, emailVerified: !!u.email_ok, plan: u.plan, smsAddon: !!u.sms_addon,
    createdAt: u.created_at, hasPassword: !!u.pass_hash,
    logins: q.identitiesOf.all(u.id).map((i) => ({ provider: i.provider, at: i.created_at })),
    telegram: u.tg_username || null, telegramId: u.tg_id || null, whatsapp: u.wa_phone || null,
    cases: cases.map((c) => ({
      id: c.id, aNumber: c.a_number, country: c.country, status: c.status,
      name: c.name, court: c.court, hearingAt: c.hearing_at, decision: c.decision,
      monitoring: !!c.monitoring, checkedAt: c.checked_at,
    })),
    events: q.events.all(u.id).map((e) => ({ kind: e.kind, text: e.text, at: e.created_at })),
    channels: q.channels.all(u.id).map((c) => ({ kind: c.kind, enabled: !!c.enabled, address: c.address, verified: !!c.verified })),
    prefs: { hearing: !!prefs.hearing, decision: !!prefs.decision, appeared: !!prefs.appeared, weekly: !!prefs.weekly },
  };
}

const waSeen = new Set();   // id уже обработанных сообщений: Meta любит присылать дубли

/* ── WhatsApp ──
   Привязка одна на два входа: короткий код человек присылает либо нашему
   номеру в Cloud API, либо стороннему боту, который зовёт /api/wa/link. */
function linkWhatsapp(code, phone) {
  const row = q.liveLink.get(String(code || '').trim().toUpperCase(), 'whatsapp', now());
  if (!row) return { ok: false, error: 'code expired' };
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 8) return { ok: false, error: 'no phone' };

  // один номер — один аккаунт: у прежнего владельца отбираем
  const busy = q.userByWa.get(digits);
  if (busy && busy.id !== row.user_id) {
    q.setWhatsapp.run(null, busy.id);
    q.upsertChannel.run(busy.id, 'whatsapp', 0, null, 0);
  }
  q.setWhatsapp.run(digits, row.user_id);
  q.upsertChannel.run(row.user_id, 'whatsapp', 1, digits, 1);
  q.useLink.run(row.token);
  q.addEvent.run(row.user_id, null, 'note', 'WhatsApp connected', now());
  const u = q.userById.get(row.user_id);
  return { ok: true, email: u ? u.email : null, userId: row.user_id };
}

const WA_HELP = [
  'CaseCheck — we watch your immigration court case and tell you the moment it changes.',
  '',
  'What you can send here:',
  '• *status* — how your cases look right now',
  '• *stop* — pause alerts on WhatsApp',
  '• *start* — turn them back on',
  '',
  'To connect this number, open ' + (process.env.PUBLIC_URL || 'https://uscasecheck.com')
    + '/alerts.html and press Connect WhatsApp — you get an eight-character code, send it here.',
].join('\n');

/* Короткая сводка по делам — то же, что видно в кабинете, только словами. */
function waCases(userId) {
  const rows = q.cases.all(userId);
  if (!rows.length) return 'No cases yet. Add one at ' + (process.env.PUBLIC_URL || 'https://uscasecheck.com') + '/app.html';
  const lines = rows.map((c) => {
    const bits = [];
    if (c.hearing_at) bits.push('hearing ' + c.hearing_at);
    if (c.decision) bits.push('decision: ' + c.decision);
    if (!bits.length) bits.push(c.status === 'found' ? 'in proceedings, no date yet' : 'no record yet');
    return '• ' + (c.name ? c.name + ' · ' : '') + c.a_number + ' — ' + bits.join(', ')
      + (c.monitoring ? '' : ' (paused)');
  });
  return ['Your cases:', ''].concat(lines).join('\n');
}

/* Разговор. Отвечаем всегда: молчащий бот выглядит сломанным. */
async function waTalk(m) {
  if (!m.from) return;
  const low = (m.text || '').toLowerCase();
  const user = q.userByWa.get(m.from);
  const code = /\b([0-9a-f]{8})\b/i.exec((m.text || '').replace(/[^0-9a-zA-Z\s]/g, ' '));

  if (code) {
    const r = linkWhatsapp(code[1], m.from);
    if (r.ok) {
      await wa.sendText(m.from, 'Connected ✅\nThis number is now linked to ' + r.email
        + '. Alerts about your cases will arrive right here.\n\nSend *status* any time to see where things stand.');
    } else {
      await wa.sendText(m.from, r.error === 'code expired'
        ? 'That code is not valid any more — codes live fifteen minutes. Get a fresh one on the Alerts page of your account.'
        : 'Could not read the number this message came from. Try again in a moment.');
    }
    return;
  }

  if (/^\s*(stop|unsubscribe|off|отписаться)\b/.test(low)) {
    if (user) {
      q.upsertChannel.run(user.id, 'whatsapp', 0, m.from, 1);
      q.addEvent.run(user.id, null, 'note', 'WhatsApp alerts paused', now());
    }
    return void await wa.sendText(m.from, 'Alerts on WhatsApp are off. Email still works. Send *start* to turn WhatsApp back on.');
  }

  if (/^\s*(start|on|resume)\b/.test(low) && user) {
    q.upsertChannel.run(user.id, 'whatsapp', 1, m.from, 1);
    return void await wa.sendText(m.from, 'Alerts on WhatsApp are on again.');
  }

  if (/\b(status|case|cases|hearing)\b/.test(low)) {
    if (!user) return void await wa.sendText(m.from, 'This number is not connected to an account yet.\n\n' + WA_HELP);
    return void await wa.sendText(m.from, waCases(user.id));
  }

  await wa.sendText(m.from, user
    ? 'You are connected as ' + user.email + '.\n\n' + WA_HELP
    : WA_HELP);
}

/* ── проверки EOIR ──
   Сами в суд не ходим: у бота на машине с мобильным прокси уже есть рабочий
   движок, и второй такой же рядом только мешал бы — один IP, один браузер.
   Поэтому очередь держим здесь, а работу забирает воркер и приносит ответ. */
const CHECK_HOURS = Number(process.env.CHECK_HOURS || 12);

function workerOk(req) {
  const secret = process.env.WORKER_SECRET || '';
  if (!secret) return false;
  const given = String(req.headers['x-worker-secret'] || '');
  return given.length === secret.length
    && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

const prettyA = (a) => (String(a).length === 9
  ? 'A' + String(a).slice(0, 3) + '-' + String(a).slice(3, 6) + '-' + String(a).slice(6)
  : String(a));

/* Разброс во времени: без него все дела приходят на проверку одной пачкой. */
const nextCheck = () => now() + Math.round(CHECK_HOURS * 3600 * (0.85 + Math.random() * 0.3));

/* Разослать по всем каналам, которые человек оставил включёнными.
   Почта включена по умолчанию: строки в channels может ещё не быть. */
async function alertUser(u, m) {
  const ch = {};
  q.channels.all(u.id).forEach((c) => { ch[c.kind] = c; });
  const lines = [m.title, '', m.lead, ''].concat(m.rows.map((r) => r[0] + ': ' + r[1]));

  if (u.email && (!ch.email || ch.email.enabled)) {
    mail.sendAlert(u.email, m).catch((e) => console.error('[alert] почта:', e.message));
  }
  if (u.tg_id && ch.telegram && ch.telegram.enabled) {
    const token = process.env.TG_BOT_TOKEN || '';
    if (token) {
      fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: u.tg_id, text: lines.join('\n'), disable_web_page_preview: true }),
      }).catch((e) => console.error('[alert] телеграм:', e.message));
    }
  }
  if (u.wa_phone && ch.whatsapp && ch.whatsapp.enabled) {
    /* Meta пускает свободный текст только сутки после сообщения человека,
       поэтому сперва утверждённый шаблон, а текстом — если шаблона ещё нет. */
    const r = await wa.sendTemplate(u.wa_phone, [m.title, m.rows.map((x) => x[0] + ': ' + x[1]).join(', ')]);
    if (!r.ok) await wa.sendText(u.wa_phone, lines.join('\n'));
  }
}

/* Что именно изменилось — по этому решаем, будить человека или просто
   записать в ленту дела. Слушание и решение будят, мелочь — нет. */
function caseChanges(before, res) {
  const out = [];
  const was = (v) => String(v || '');
  if (was(before.hearing_at) !== was(res.hearing)) {
    if (!before.hearing_at && res.hearing) out.push({ kind: 'hearing', title: 'A hearing date appeared' });
    else if (before.hearing_at && !res.hearing) out.push({ kind: 'hearing', title: 'The hearing was taken off the calendar' });
    else out.push({ kind: 'hearing', title: 'The hearing was moved' });
  }
  if (was(before.decision) !== was(res.decision) && res.decision) {
    out.push({ kind: 'decision', title: 'The judge decision changed' });
  }
  if (was(before.court) !== was(res.court) && before.court && res.court) {
    out.push({ kind: 'court', title: 'The case moved to another court' });
  }
  return out;
}

/* Ответ воркера: сохранить, сравнить с прошлым снимком, разбудить кого надо. */
async function applyResult(row, res) {
  const u = q.userById.get(row.user_id);
  const label = prettyA(row.a_number);

  if (!res.ok) {
    // не достучались — отступаем, но не бесконечно: полчаса, час, два… до шести
    const back = Math.min(6 * 3600, 1800 * Math.pow(2, Math.min(4, row.fail_count || 0)));
    q.setCaseFail.run(now() + back, row.id);
    console.warn('[check] не вышло, дело', row.id, '—', res.error || 'без причины');
    return { ok: false };
  }

  if (!res.found) {
    const first = !row.checked_at;
    q.setCaseResult.run('not_found', null, null, null, null, null, 'NOTFOUND', res.message || '', now(), nextCheck(), row.id);
    if (first) q.addEvent.run(row.user_id, row.id, 'checked', 'Checked — EOIR has no record for ' + label + ' yet', now());
    else if (row.status === 'found') q.addEvent.run(row.user_id, row.id, 'note', 'EOIR no longer returns this case', now());
    return { ok: true, found: false };
  }

  const changes = row.checked_at ? caseChanges(row, res) : [];
  const appeared = row.status === 'not_found' && res.found;
  q.setCaseResult.run('found', res.name || null, res.court || null, res.hearing || null,
    res.decision || null, res.judge || null, res.sig || null, (res.rendered || '').slice(0, 4000),
    now(), nextCheck(), row.id);

  const rows = [['Case', label]];
  if (res.name) rows.push(['Name', res.name]);
  rows.push(['Hearing', res.hearing || 'None scheduled yet']);
  if (res.judge) rows.push(['Judge', res.judge]);
  if (res.court) rows.push(['Court', res.court]);
  rows.push(['Decision', res.decision || 'Pending']);

  if (!row.checked_at) {
    q.addEvent.run(row.user_id, row.id, 'checked', 'First check done — ' + (res.hearing
      ? 'hearing ' + res.hearing : 'no hearing scheduled yet'), now());
    return { ok: true, found: true, alerted: false };
  }

  if (appeared) changes.unshift({ kind: 'appeared', title: 'The case appeared in EOIR' });
  if (!changes.length) {
    if (res.sig && row.sig && res.sig !== row.sig) {
      q.addEvent.run(row.user_id, row.id, 'note', 'Minor update on the EOIR page', now());
    }
    return { ok: true, found: true, alerted: false };
  }

  const prefs = q.prefs.get(row.user_id) || { hearing: 1, decision: 1, appeared: 1 };
  let alerted = false;
  for (const ch of changes) {
    q.addEvent.run(row.user_id, row.id, ch.kind === 'decision' ? 'decision' : 'hearing', ch.title + ' — ' + label, now());
    const wanted = ch.kind === 'decision' ? prefs.decision
      : ch.kind === 'appeared' ? prefs.appeared : prefs.hearing;
    if (!wanted || !u) continue;
    await alertUser(u, {
      subject: ch.title + ' — ' + (res.name || label),
      title: ch.title,
      lead: ch.kind === 'decision'
        ? 'EOIR now shows a different decision on this case. Ask your attorney what it means for the next step.'
        : ch.kind === 'appeared'
          ? 'The number you were watching now has a record. Here is what the court publishes today.'
          : 'The court schedule for this case changed. Confirm the date before you travel.',
      rows,
    }).catch((e) => console.error('[alert]', e.message));
    alerted = true;
  }
  return { ok: true, found: true, alerted };
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 20000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve(null); } });
  });
}

/* ── API ── */
async function api(req, res, url) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

  if (url === '/api/auth/signup' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b) return send(res, 400, { ok: false, error: 'bad json' });
    const email = clean(b.email);
    const pass = String(b.password || '');
    if (!email_ok(email)) return send(res, 400, { ok: false, error: 'bad email' });
    if (!strongEnough(pass)) return send(res, 400, { ok: false, error: 'weak password' });
    if (tooOften('signup:' + ip, 10, 3600)) return send(res, 429, { ok: false, error: 'slow down' });

    const existing = q.userByEmail.get(email);
    if (existing && existing.email_ok) return send(res, 409, { ok: false, error: 'email in use' });
    if (existing) q.setPass.run(hash(pass), existing.id);
    else q.createUser.run(email, hash(pass), now());

    const r = await issueCode(email, 'signup');
    if (!r.ok) return send(res, 429, { ok: false, error: r.error });
    return send(res, 200, { ok: true, next: 'verify', delivered: r.delivered });
  }

  if (url === '/api/auth/login' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b) return send(res, 400, { ok: false, error: 'bad json' });
    const email = clean(b.email);
    if (tooOften('login:' + ip, 12, 3600)) return send(res, 429, { ok: false, error: 'slow down' });
    const u = q.userByEmail.get(email);
    // один и тот же ответ, чтобы по нему нельзя было перебирать существующие адреса
    if (!u || !passOk(String(b.password || ''), u.pass_hash)) {
      return send(res, 401, { ok: false, error: 'wrong email or password' });
    }
    const r = await issueCode(email, 'login');
    if (!r.ok) return send(res, 429, { ok: false, error: r.error });
    return send(res, 200, { ok: true, next: '2fa', delivered: r.delivered });
  }

  if ((url === '/api/auth/verify' || url === '/api/auth/2fa') && req.method === 'POST') {
    const b = await readBody(req);
    if (!b) return send(res, 400, { ok: false, error: 'bad json' });
    const email = clean(b.email);
    const purpose = url.endsWith('verify') ? 'signup' : 'login';
    if (tooOften('code:' + ip, 20, 3600)) return send(res, 429, { ok: false, error: 'slow down' });
    const r = checkCode(email, purpose, b.code);
    if (!r.ok) return send(res, 400, { ok: false, error: r.error });

    const u = q.userByEmail.get(email);
    if (!u) return send(res, 400, { ok: false, error: 'no user' });
    if (purpose === 'signup') {
      q.markVerified.run(u.id);
      q.initPrefs.run(u.id);
      q.upsertChannel.run(u.id, 'email', 1, email, 1);
      q.addEvent.run(u.id, null, 'note', 'Account created', now());
      mail.sendWelcome(u.email).catch(() => {});   // первое письмо: что делать дальше
    }
    setSession(res, u.id, req.headers['user-agent']);
    return send(res, 200, { ok: true, user: publicUser(q.userByEmail.get(email)) });
  }

  /* Забыл пароль. Отвечаем одинаково и когда адрес есть, и когда его нет:
     иначе по этой ручке можно перебирать, кто у нас зарегистрирован. */
  if (url === '/api/auth/forgot' && req.method === 'POST') {
    const b = await readBody(req);
    const email = clean(b && b.email);
    if (!email_ok(email)) return send(res, 400, { ok: false, error: 'bad email' });
    if (tooOften('forgot:' + ip, 8, 3600)) return send(res, 429, { ok: false, error: 'slow down' });
    const u = q.userByEmail.get(email);
    if (u) {
      const r = await issueCode(email, 'reset');
      if (!r.ok) return send(res, 429, { ok: false, error: r.error });
    }
    return send(res, 200, { ok: true, next: 'reset' });
  }

  if (url === '/api/auth/reset' && req.method === 'POST') {
    const b = await readBody(req);
    const email = clean(b && b.email);
    const pass = String((b && b.password) || '');
    if (tooOften('reset:' + ip, 12, 3600)) return send(res, 429, { ok: false, error: 'slow down' });
    const r = checkCode(email, 'reset', b && b.code);
    if (!r.ok) return send(res, 400, { ok: false, error: r.error });
    if (!strongEnough(pass)) return send(res, 400, { ok: false, error: 'weak password' });
    const u = q.userByEmail.get(email);
    if (!u) return send(res, 400, { ok: false, error: 'no user' });

    q.setPass.run(hash(pass), u.id);
    q.markVerified.run(u.id);                    // код с почты и есть подтверждение
    q.dropOtherSessions.run(u.id, '');           // чужие сессии закрываем все до единой
    q.addEvent.run(u.id, null, 'note', 'Password reset', now());
    mail.sendPasswordChanged(u.email).catch(() => {});
    setSession(res, u.id, req.headers['user-agent']);
    return send(res, 200, { ok: true, user: publicUser(u) });
  }

  if (url === '/api/auth/resend' && req.method === 'POST') {
    const b = await readBody(req);
    const email = clean(b && b.email);
    const purpose = (b && b.purpose) === 'login' ? 'login' : 'signup';
    if (!email_ok(email)) return send(res, 400, { ok: false });
    if (tooOften('resend:' + ip, 6, 3600)) return send(res, 429, { ok: false, error: 'slow down' });
    const r = await issueCode(email, purpose);
    return send(res, r.ok ? 200 : 429, r);
  }

  if (url === '/api/auth/providers' && req.method === 'GET') {
    return send(res, 200, { ok: true, ...oauth.enabled() });
  }

  // вход через Google или Apple: уводим к провайдеру
  const startMatch = /^\/api\/auth\/(google|apple)\/start$/.exec(url);
  if (startMatch && req.method === 'GET') {
    const provider = startMatch[1];
    if (!oauth.enabled()[provider]) return send(res, 404, { ok: false, error: 'provider off' });
    res.writeHead(302, { location: oauth.startUrl(provider, req, SECRET), 'cache-control': 'no-store' });
    return res.end();
  }

  // возврат от провайдера: меняем код на токен и заводим сессию
  const backMatch = /^\/api\/auth\/(google|apple)\/callback$/.exec(url);
  if (backMatch) {
    const provider = backMatch[1];
    if (!oauth.enabled()[provider]) return send(res, 404, { ok: false, error: 'provider off' });

    let code, state, appleUser = null;
    if (req.method === 'POST') {                       // Apple возвращает формой
      const raw = await new Promise((resolve) => {
        let d = ''; req.on('data', (c) => { d += c; if (d.length > 20000) req.destroy(); });
        req.on('end', () => resolve(d));
      });
      const f = new URLSearchParams(raw);
      code = f.get('code'); state = f.get('state');
      appleUser = f.get('user');                       // имя приходит только в первый раз
    } else {
      const f = new URL(req.url, 'http://x').searchParams;
      code = f.get('code'); state = f.get('state');
    }
    if (!code || !oauth.stateOk(state, SECRET)) {
      res.writeHead(302, { location: '/login.html?e=oauth' });
      return res.end();
    }
    const r = await oauth.exchange(provider, code, req, { user: appleUser });
    if (!r.ok) {
      console.error('[oauth]', provider, r.error);
      res.writeHead(302, { location: '/login.html?e=oauth' });
      return res.end();
    }
    /* Узнаём человека по sub провайдера, а не по почте: Google просит опираться
       на sub, потому что почта меняется, а Apple со второго входа почту вообще
       не присылает — по ней мы бы его просто не нашли. */
    const known = q.identity.get(provider, r.sub);
    let u = known ? q.userById.get(known.user_id) : null;

    if (!u && r.email) u = q.userByEmail.get(r.email);

    if (!u) {
      if (!r.email) {                       // нечего связывать: аккаунта нет, почты нет
        res.writeHead(302, { location: '/login.html?e=oauth' });
        return res.end();
      }
      q.createUser.run(r.email, null, now());
      u = q.userByEmail.get(r.email);
      q.initPrefs.run(u.id);
      // на скрытый relay-адрес Apple писать без настройки домена нельзя — канал не включаем
      q.upsertChannel.run(u.id, 'email', r.private ? 0 : 1, r.email, 1);
      q.addEvent.run(u.id, null, 'note', 'Account created with ' + provider, now());
      mail.sendWelcome(u.email).catch(() => {});
    }

    q.linkIdentity.run(provider, r.sub, u.id, r.email || null, r.private ? 1 : 0, r.name || null, now(), now());
    q.touchIdentity.run(now(), provider, r.sub);
    if (r.verified) q.markVerified.run(u.id);
    setSession(res, u.id, req.headers['user-agent']);
    res.writeHead(302, { location: '/app.html' });
    return res.end();
  }

  if (url === '/api/auth/logout' && req.method === 'POST') {
    const m = /(?:^|;\s*)cw=([a-f0-9]{64})\./.exec(req.headers.cookie || '');
    if (m) q.dropSession.run(m[1]);
    res.setHeader('set-cookie', 'cw=; Path=/; HttpOnly; Max-Age=0');
    return send(res, 200, { ok: true });
  }

  const me = userFrom(req);

  /* Зовёт бот, а не браузер: сессии тут нет, доверяем общему секрету.
     Секрета нет в настройках — ручка выключена, а не открыта настежь. */
  if (url === '/api/tg/link' && req.method === 'POST') {
    const secret = process.env.TG_LINK_SECRET || '';
    if (!secret) return send(res, 503, { ok: false, error: 'linking off' });
    const given = String(req.headers['x-link-secret'] || '');
    if (given.length !== secret.length
      || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
      return send(res, 403, { ok: false, error: 'bad secret' });
    }
    const b = (await readBody(req)) || {};
    const row = q.liveLink.get(String(b.token || ''), 'telegram', now());
    if (!row) return send(res, 404, { ok: false, error: 'code expired' });
    const tgId = Number(b.tgId || 0);
    if (!tgId) return send(res, 400, { ok: false, error: 'no telegram id' });

    // один телеграм — один аккаунт: отвязываем от прежнего, если он был
    const busy = q.userByTg.get(tgId);
    if (busy && busy.id !== row.user_id) q.clearTelegram.run(busy.id);

    q.setTelegram.run(tgId, String(b.username || '').replace(/^@/, '') || null, row.user_id);
    q.upsertChannel.run(row.user_id, 'telegram', 1, String(b.username || '') || String(tgId), 1);
    q.useLink.run(row.token);
    q.addEvent.run(row.user_id, null, 'note', 'Telegram connected', now());

    /* Подписка, купленная в боте, не должна теряться на сайте: если у бота срок
       дальше нашего, продлеваем. Наоборот сайт ничего не отнимает. */
    const until = Number(b.planUntil || 0);
    if (until > now()) {
      const u0 = q.userById.get(row.user_id) || {};
      if (until > (u0.plan_until || 0)) {
        q.setPlan.run('monitoring', until, row.user_id);
        q.addEvent.run(row.user_id, null, 'note', 'Monitoring carried over from the Telegram bot', now());
      }
    }
    const u = q.userById.get(row.user_id);
    return send(res, 200, { ok: true, email: u ? u.email : null });
  }

  /* Зовёт будущий бот WhatsApp: код из сообщения плюс номер отправителя. */
  if (url === '/api/wa/link' && req.method === 'POST') {
    const secret = process.env.WA_LINK_SECRET || process.env.TG_LINK_SECRET || '';
    if (!secret) return send(res, 503, { ok: false, error: 'linking off' });
    const given = String(req.headers['x-link-secret'] || '');
    if (given.length !== secret.length
      || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
      return send(res, 403, { ok: false, error: 'bad secret' });
    }
    const b = (await readBody(req)) || {};
    const r = linkWhatsapp(b.code || b.token, b.phone);
    if (!r.ok) return send(res, r.error === 'code expired' ? 404 : 400, r);
    return send(res, 200, { ok: true, email: r.email });
  }

  if (url === '/api/me' && req.method === 'GET') {
    if (!me) return send(res, 401, { ok: false, error: 'no session' });
    return send(res, 200, { ok: true, user: publicUser(me), support: SUPPORT });
  }

  /* Смена пароля: старый обязателен, иначе чужая открытая вкладка = чужой аккаунт.
     Все прочие сессии после смены закрываем — это и есть смысл смены. */
  if (url === '/api/account/password' && req.method === 'POST') {
    if (!me) return send(res, 401, { ok: false, error: 'no session' });
    const b = await readBody(req);
    const cur = String((b && b.current) || '');
    const next = String((b && b.next) || '');
    if (tooOften('pass:' + ip, 10, 3600)) return send(res, 429, { ok: false, error: 'slow down' });
    if (me.pass_hash && !passOk(cur, me.pass_hash)) {
      return send(res, 403, { ok: false, error: 'wrong password' });
    }
    if (!strongEnough(next)) return send(res, 400, { ok: false, error: 'weak password' });
    q.setPass.run(hash(next), me.id);
    const keep = /(?:^|;\s*)cw=([a-f0-9]{64})\./.exec(req.headers.cookie || '');
    q.dropOtherSessions.run(me.id, keep ? keep[1] : '');
    q.addEvent.run(me.id, null, 'note', 'Password changed', now());
    mail.sendPasswordChanged(me.email).catch(() => {});   // письмо-сторож, ответ не ждём
    return send(res, 200, { ok: true });
  }

  /* Привязка телеграма. Сайт выдаёт одноразовый код и ссылку в бота; бот,
     получив /start с этим кодом, зовёт нас со своим общим секретом. Сам код
     живёт пятнадцать минут — этого хватает, чтобы дойти до бота и нажать. */
  if (url === '/api/channels/telegram/link' && req.method === 'POST') {
    if (!me) return send(res, 401, { ok: false, error: 'no session' });
    if (tooOften('tglink:' + ip, 10, 3600)) return send(res, 429, { ok: false, error: 'slow down' });
    const token = crypto.randomBytes(16).toString('hex');
    q.addLink.run(token, me.id, 'telegram', now() + 900, now());
    const bot = process.env.TG_BOT_USERNAME || 'eoircasestatus_bot';
    return send(res, 200, { ok: true, url: 'https://t.me/' + bot + '?start=link_' + token });
  }

  if (url === '/api/channels/telegram/unlink' && req.method === 'POST') {
    if (!me) return send(res, 401, { ok: false, error: 'no session' });
    q.clearTelegram.run(me.id);
    q.upsertChannel.run(me.id, 'telegram', 0, null, 0);
    q.addEvent.run(me.id, null, 'note', 'Telegram disconnected', now());
    return send(res, 200, { ok: true });
  }

  /* WhatsApp. Тот же приём, что и с телеграмом: сайт выдаёт короткий код,
     человек отправляет его нашему номеру, бот подтверждает вызовом сюда.
     Номер берём из настроек — пока он не задан, канал выключен. */
  if (url === '/api/channels/whatsapp/link' && req.method === 'POST') {
    if (!me) return send(res, 401, { ok: false, error: 'no session' });
    const number = String(process.env.WA_NUMBER || '').replace(/\D/g, '');
    if (!number) return send(res, 503, { ok: false, error: 'whatsapp not configured' });
    if (tooOften('walink:' + ip, 10, 3600)) return send(res, 429, { ok: false, error: 'slow down' });
    // короткий код: его человек отправляет руками, длинный никто не наберёт
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    q.addLink.run(code, me.id, 'whatsapp', now() + 900, now());
    const text = 'CaseCheck link ' + code;
    return send(res, 200, {
      ok: true, code,
      url: 'https://wa.me/' + number + '?text=' + encodeURIComponent(text),
      number,
    });
  }

  if (url === '/api/channels/whatsapp/unlink' && req.method === 'POST') {
    if (!me) return send(res, 401, { ok: false, error: 'no session' });
    q.setWhatsapp.run(null, me.id);
    q.upsertChannel.run(me.id, 'whatsapp', 0, null, 0);
    q.addEvent.run(me.id, null, 'note', 'WhatsApp disconnected', now());
    return send(res, 200, { ok: true });
  }

  if (url === '/api/billing/checkout' && req.method === 'POST') {
    if (!me) return send(res, 401, { ok: false, error: 'no session' });
    const b = (await readBody(req)) || {};
    const plan = b.plan === 'year' ? 'year' : 'month';
    if (!PAY[plan]) return send(res, 503, { ok: false, error: 'payments not configured' });
    // по этой метке веб-хук поймёт, чей платёж: у бота там id телеграма, у нас — «web-<id>»
    const url2 = PAY[plan] + '?client_reference_id=web-' + me.id
      + '&prefilled_email=' + encodeURIComponent(me.email);
    return send(res, 200, { ok: true, url: url2 });
  }

  if (url === '/api/billing/history' && req.method === 'GET') {
    if (!me) return send(res, 401, { ok: false, error: 'no session' });
    return send(res, 200, {
      ok: true,
      paid: q.payments.all(me.id).map((p) => ({
        amount: p.amount, currency: p.currency, plan: p.plan, at: p.created_at,
      })),
      ready: !!(PAY.month && PAY.year),
      until: (q.userById.get(me.id) || {}).plan_until || null,
    });
  }

  if (url === '/api/account/sessions' && req.method === 'POST') {
    if (!me) return send(res, 401, { ok: false, error: 'no session' });
    const keep = /(?:^|;\s*)cw=([a-f0-9]{64})\./.exec(req.headers.cookie || '');
    q.dropOtherSessions.run(me.id, keep ? keep[1] : '');
    return send(res, 200, { ok: true });
  }

  if (url === '/api/support' && req.method === 'GET') {
    if (!me) return send(res, 401, { ok: false, error: 'no session' });
    const list = q.myTickets.all(me.id).map((t) => ({
      id: t.id, topic: t.topic, text: t.text, at: t.created_at, delivered: !!t.delivered,
    }));
    return send(res, 200, { ok: true, tickets: list, support: SUPPORT });
  }

  if (url === '/api/support' && req.method === 'POST') {
    if (!me) return send(res, 401, { ok: false, error: 'no session' });
    const b = await readBody(req);
    const topic = String((b && b.topic) || '').trim().slice(0, 80);
    const text = String((b && b.text) || '').trim().slice(0, 4000);
    if (text.length < 5) return send(res, 400, { ok: false, error: 'write a bit more' });
    if (tooOften('support:' + ip, 5, 3600) || q.recentTickets.get(me.id, now() - 3600).n >= 5) {
      return send(res, 429, { ok: false, error: 'too many messages' });
    }
    q.addTicket.run(me.id, me.email, topic || null, text, 0, now());
    const id = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    const delivered = await tellSupport(id, me.email, topic, text);
    mail.sendSupportAck(me.email, topic).catch(() => {});   // человеку — подтверждение
    // ответ всегда «принято»: обращение уже в базе, доставку добираем сами
    return send(res, 200, { ok: true, delivered });
  }

  /* Воркер: забрать пачку дел и вернуть по ним ответ. Секрет общий, свой у
     каждой машины смысла не имеет — воркер один и стоит рядом с ботом. */
  if (url.startsWith('/api/worker/')) {
    if (!workerOk(req)) return send(res, 403, { ok: false, error: 'bad secret' });

    if (url === '/api/worker/queue' && req.method === 'GET') {
      const want = Number(new URL(req.url, 'http://local').searchParams.get('limit')) || 5;
      const limit = Math.max(1, Math.min(20, want));
      const rows = q.dueCases.all(now(), now(), limit);
      // бронируем на десять минут: воркер может спросить снова, пока возится
      rows.forEach((r) => q.leaseCase.run(now() + 600, r.id));
      return send(res, 200, { ok: true, cases: rows.map((r) => ({
        id: r.id, aNumber: r.a_number, country: r.country, natCode: r.nat_code,
        firstCheck: !r.checked_at,
      })) });
    }

    if (url === '/api/worker/result' && req.method === 'POST') {
      const b = (await readBody(req)) || {};
      const row = q.caseRow.get(Number(b.id));
      if (!row) return send(res, 404, { ok: false, error: 'no such case' });
      const done = await applyResult(row, b);
      return send(res, 200, Object.assign({ ok: true }, done));
    }

    return send(res, 404, { ok: false, error: 'unknown worker call' });
  }

  if (url === '/api/cases' && req.method === 'POST') {
    if (!me) return send(res, 401, { ok: false, error: 'no session' });
    const b = await readBody(req);
    const a = String((b && b.aNumber) || '').replace(/\D/g, '');
    const c = String((b && b.country) || '').trim();
    // код гражданства из списка ACIS: без него запрос в суд не сойдётся
    const nat = String((b && b.natCode) || '').trim().toUpperCase();
    if (a.length !== 9 || !c) return send(res, 400, { ok: false, error: 'need 9 digits and country' });
    if (!/^[A-Z]{2}$/.test(nat)) return send(res, 400, { ok: false, error: 'pick the country from the list' });
    if (q.caseByNumber.get(me.id, a)) return send(res, 409, { ok: false, error: 'already added' });
    const mine = q.countCases.get(me.id).n;
    if (me.plan === 'free' && mine >= 1) {
      return send(res, 402, { ok: false, error: 'free plan allows one case' });
    }
    // потолок на аккаунт: каждое дело — это наши запросы к EOIR, без границы аккаунт растащат
    if (mine >= MAX_CASES) {
      return send(res, 409, { ok: false, error: 'account limit', limit: MAX_CASES });
    }
    q.addCase.run(me.id, a, c, nat, now());
    const row = q.caseByNumber.get(me.id, a);
    q.addEvent.run(me.id, row.id, 'added', `Case A${a.slice(0, 3)}-${a.slice(3, 6)}-${a.slice(6)} added`, now());
    return send(res, 200, { ok: true, user: publicUser(me) });
  }

  // одно дело со своей историей — под страницу дела
  const oneCase = /^\/api\/cases\/(\d+)$/.exec(url);
  if (oneCase && req.method === 'GET') {
    if (!me) return send(res, 401, { ok: false, error: 'no session' });
    const c = q.caseById.get(Number(oneCase[1]), me.id);
    if (!c) return send(res, 404, { ok: false, error: 'not found' });
    return send(res, 200, { ok: true, case: {
      id: c.id, aNumber: c.a_number, country: c.country, status: c.status,
      name: c.name, court: c.court, hearingAt: c.hearing_at, decision: c.decision,
      monitoring: !!c.monitoring, checkedAt: c.checked_at, createdAt: c.created_at,
    }, events: q.caseEvents.all(c.id).map((e) => ({ kind: e.kind, text: e.text, at: e.created_at })) });
  }
  if (oneCase && req.method === 'DELETE') {
    if (!me) return send(res, 401, { ok: false, error: 'no session' });
    q.dropCase.run(Number(oneCase[1]), me.id);
    return send(res, 200, { ok: true });
  }

  if (url === '/api/cases/monitoring' && req.method === 'POST') {
    if (!me) return send(res, 401, { ok: false, error: 'no session' });
    const b = await readBody(req);
    q.setMonitoring.run(b && b.on ? 1 : 0, Number(b && b.id), me.id);
    return send(res, 200, { ok: true });
  }

  if (url === '/api/prefs' && req.method === 'POST') {
    if (!me) return send(res, 401, { ok: false, error: 'no session' });
    const b = (await readBody(req)) || {};
    q.initPrefs.run(me.id);
    q.setPrefs.run(b.hearing ? 1 : 0, b.decision ? 1 : 0, b.appeared ? 1 : 0, b.weekly ? 1 : 0, me.id);
    return send(res, 200, { ok: true });
  }

  if (url === '/api/channels' && req.method === 'POST') {
    if (!me) return send(res, 401, { ok: false, error: 'no session' });
    const b = (await readBody(req)) || {};
    const kind = ['email', 'telegram', 'whatsapp', 'sms'].includes(b.kind) ? b.kind : null;
    if (!kind) return send(res, 400, { ok: false, error: 'bad channel' });
    q.upsertChannel.run(me.id, kind, b.enabled ? 1 : 0, b.address || null, 0);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { ok: false, error: 'unknown endpoint' });
}

/* ── статика ── */
function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  if (!path.extname(rel)) rel += '.html';
  const file = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden', 'text/plain');

  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(ROOT, 'index.html'), (e2, home) => {
        if (e2) return send(res, 404, 'not found', 'text/plain');
        res.writeHead(404, { 'content-type': MIME['.html'] });
        res.end(home);
      });
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const headers = { 'content-type': MIME[ext] || 'application/octet-stream' };
    const revalidate = ['.html', '.css', '.js'].includes(ext);
    headers['cache-control'] = revalidate ? 'no-cache, must-revalidate' : 'public, max-age=604800';
    const st = fs.statSync(file);
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.round(st.mtimeMs).toString(16) + '"';
    headers.etag = etag;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, headers);
    res.end(data);
  });
}

/* Показательный аккаунт с парой дел — чтобы было что посмотреть внутри. */
function seedDemo() {
  const email = String(process.env.DEMO_EMAIL || '').toLowerCase();
  const pass = process.env.DEMO_PASS;
  if (!email || !pass) return;
  let u = q.userByEmail.get(email);
  if (!u) {
    q.createUser.run(email, hash(pass), now());
    u = q.userByEmail.get(email);
    console.log('[demo] аккаунт создан:', email);
  }
  // показательный аккаунт держим в известном состоянии: пароль из настроек,
  // иначе после смены имени или ротации доступ пришлось бы чинить руками
  q.setPass.run(hash(pass), u.id);
  q.markVerified.run(u.id);
  q.initPrefs.run(u.id);
  q.upsertChannel.run(u.id, 'email', 1, email, 1);

  const day = 86400;
  const samples = [
    ['240974400', 'Mexico', 'found', 'Maria Rodriguez', 'Chicago, IL — Immigration Court', 'May 14, 2026 · 9:00 AM', 'Pending', [
      ['hearing', 'Hearing moved from March 2 to May 14, 2026 · 9:00 AM', 3600],
      ['note', 'Court changed to Chicago, IL — Immigration Court', day * 12],
      ['added', 'Case added to monitoring', day * 21],
    ]],
    ['215330118', 'Guatemala', 'found', 'Jose Ramirez', 'Miami, FL — Immigration Court', null, 'Terminated', [
      ['decision', 'Judge decision: Terminated', day * 3],
      ['appeared', 'Case appeared in the EOIR system', day * 15],
      ['added', 'Case added to monitoring', day * 16],
    ]],
    ['251887002', 'Ukraine', 'not_found', null, null, null, null, [
      ['added', 'Case added to monitoring — no record in EOIR yet', day * 9],
    ]],
  ];
  const hasEvents = db.prepare('SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND case_id = ?');
  let added = 0;
  for (const [a, c, st, name, court, hearing, decision, events] of samples) {
    let row = q.caseByNumber.get(u.id, a);
    if (!row) {
      q.addCase.run(u.id, a, c, null, now());   // у показательных дел гражданства нет: воркер их не трогает
      row = q.caseByNumber.get(u.id, a);
      db.prepare('UPDATE cases SET status=?, name=?, court=?, hearing_at=?, decision=?, checked_at=? WHERE id=?')
        .run(st, name, court, hearing, decision, now() - 600, row.id);
      added++;
    }
    // события привязаны к делу, иначе на странице дела пустая история
    if (!hasEvents.get(u.id, row.id).n) {
      for (const [kind, text, ago] of events) q.addEvent.run(u.id, row.id, kind, text, now() - ago);
    }
  }
  // старые демо-события без дела только мусорят ленту
  db.prepare("DELETE FROM events WHERE user_id = ? AND case_id IS NULL AND kind <> 'note'").run(u.id);
  if (added) console.log('[demo] дела добавлены:', added);
}

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/healthz') {
    return send(res, 200, { ok: true, mail: mail.hasKey(), wa: wa.on(),
      tg: !!(process.env.TG_BOT_TOKEN && process.env.TG_SUPPORT_CHAT) });
  }
  /* Веб-хук Stripe. Стоит до общего разбора тела: подпись считается по сырым
     байтам, любой предварительный JSON.parse её сломает. */
  if (url === '/stripe/webhook' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 200000) req.destroy(); });
    req.on('end', () => {
      if (!stripeSigOk(raw, req.headers['stripe-signature'])) {
        console.warn('[stripe] подпись не сошлась');
        return send(res, 400, { ok: false, error: 'bad signature' });
      }
      let ev = null;
      try { ev = JSON.parse(raw); } catch { return send(res, 400, { ok: false, error: 'bad json' }); }
      const o = (ev.data && ev.data.object) || {};
      try {
        if (ev.type === 'checkout.session.completed') {
          const ref = String(o.client_reference_id || '');
          const m = /^web-(\d+)$/.exec(ref);
          if (!m) {
            // платёж из телеграм-бота: у него своя метка и свой обработчик
            console.log('[stripe] чужая метка, пропускаем:', ref || '(пусто)');
          } else {
            const uid = Number(m[1]);
            if (q.userById.get(uid)) {
              grantPlan(uid, planFromCents(o.amount_total), o.amount_total, o.currency,
                String(o.subscription || o.id || ''));
              console.log('[stripe] оплата принята, аккаунт', uid);
            }
          }
        } else if (ev.type === 'invoice.paid' && o.billing_reason === 'subscription_cycle') {
          const row = q.userByPaymentRef.get(String(o.subscription || ''));
          if (row) grantPlan(row.user_id, planFromCents(o.amount_paid), o.amount_paid, o.currency,
            String(o.subscription || ''));
        }
      } catch (e) { console.error('[stripe]', e.message); }
      return send(res, 200, { ok: true });
    });
    return;
  }

  /* Веб-хук WhatsApp. При подключении Meta зовёт GET и ждёт назад свой challenge,
     дальше шлёт сообщения POST-ом. Тело нужно сырыми байтами: по ним подпись,
     да и эмодзи не переживут склейку кусков через строку. */
  if (url === '/wa/webhook' && req.method === 'GET') {
    const answer = wa.verify(new URL(req.url, 'http://local').searchParams);
    if (answer === null) return send(res, 403, 'no', 'text/plain');
    return send(res, 200, answer, 'text/plain');
  }
  if (url === '/wa/webhook' && req.method === 'POST') {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 400000) return req.destroy(); chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (wa.sigOk(raw, req.headers['x-hub-signature-256']) === false) {
        console.warn('[wa] подпись не сошлась');
        return send(res, 403, { ok: false, error: 'bad signature' });
      }
      // Meta ждёт 200 сразу, иначе присылает то же самое снова; отвечаем и лишь потом разговариваем
      send(res, 200, { ok: true });
      let payload = null;
      try { payload = JSON.parse(raw.toString('utf8')); } catch { return; }
      for (const m of wa.incoming(payload)) {
        if (m.id && waSeen.has(m.id)) continue;          // повтор доставки — не отвечаем дважды
        if (m.id) { waSeen.add(m.id); if (waSeen.size > 500) waSeen.clear(); }
        waTalk(m).catch((e) => console.error('[wa]', e.message));
      }
    });
    return;
  }

  if (url.startsWith('/api/')) {
    return api(req, res, url).catch((e) => {
      console.error('[api]', e);
      send(res, 500, { ok: false, error: 'server error' });
    });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', 'text/plain');
  serveStatic(req, res);
}).listen(PORT, () => {
  try { seedDemo(); } catch (e) { console.error('[demo]', e.message); }
  console.log('CaseCheck on :' + PORT, '| почта:', mail.hasKey() ? 'Resend подключён' : 'ключа нет, коды в логе');
});
