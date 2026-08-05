/* CaseWatch — статика + учётные записи.

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

/* Куда ведёт кнопка поддержки. Ссылка в настройках, чтобы поменять адрес
   без выкатки: пока не задана — ведём в самого бота, как в телеграме. */
const SUPPORT = {
  tg: process.env.SUPPORT_TG_URL || 'https://t.me/eoircasestatus_bot',
  email: process.env.SUPPORT_EMAIL || 'support@casewatch.app',
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
    telegram: u.tg_username || null, whatsapp: u.wa_phone || null,
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
    }
    setSession(res, u.id, req.headers['user-agent']);
    return send(res, 200, { ok: true, user: publicUser(q.userByEmail.get(email)) });
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

  if (url === '/api/me' && req.method === 'GET') {
    if (!me) return send(res, 401, { ok: false, error: 'no session' });
    return send(res, 200, { ok: true, user: publicUser(me), support: SUPPORT });
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
    // ответ всегда «принято»: обращение уже в базе, доставку добираем сами
    return send(res, 200, { ok: true, delivered });
  }

  if (url === '/api/cases' && req.method === 'POST') {
    if (!me) return send(res, 401, { ok: false, error: 'no session' });
    const b = await readBody(req);
    const a = String((b && b.aNumber) || '').replace(/\D/g, '');
    const c = String((b && b.country) || '').trim();
    if (a.length !== 9 || !c) return send(res, 400, { ok: false, error: 'need 9 digits and country' });
    if (q.caseByNumber.get(me.id, a)) return send(res, 409, { ok: false, error: 'already added' });
    const mine = q.countCases.get(me.id).n;
    if (me.plan === 'free' && mine >= 1) {
      return send(res, 402, { ok: false, error: 'free plan allows one case' });
    }
    // потолок на аккаунт: каждое дело — это наши запросы к EOIR, без границы аккаунт растащат
    if (mine >= MAX_CASES) {
      return send(res, 409, { ok: false, error: 'account limit', limit: MAX_CASES });
    }
    q.addCase.run(me.id, a, c, now());
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
      q.addCase.run(u.id, a, c, now());
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
    return send(res, 200, { ok: true, mail: mail.hasKey(), tg: !!(process.env.TG_BOT_TOKEN && process.env.TG_SUPPORT_CHAT) });
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
  console.log('CaseWatch on :' + PORT, '| почта:', mail.hasKey() ? 'Resend подключён' : 'ключа нет, коды в логе');
});
