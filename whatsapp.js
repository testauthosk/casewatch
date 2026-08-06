/* WhatsApp Cloud API — только транспорт: отправка, подпись, разбор входящего.

   Разговор с человеком живёт в server.js, здесь ничего не знают ни про базу,
   ни про дела. Пока в настройках нет токена и номера — модуль молчит и всё
   отдаёт как «выключено», сайт от этого не ломается. */
const crypto = require('crypto');

const VER = process.env.WA_API_VER || 'v21.0';
const TOKEN = process.env.WA_TOKEN || '';
const PHONE_ID = process.env.WA_PHONE_ID || '';
const APP_SECRET = process.env.WA_APP_SECRET || '';
const VERIFY = process.env.WA_VERIFY_TOKEN || '';

const on = () => !!(TOKEN && PHONE_ID);
/* Адрес Graph вынесен в настройку: на месте он всегда один, но так можно
   прогнать бота на заглушке, не трогая живой номер. */
const BASE = process.env.WA_API_BASE || 'https://graph.facebook.com';
const api = () => BASE + '/' + VER + '/' + PHONE_ID + '/messages';

/* Подпись Meta: заголовок «sha256=<хэш>» по сырому телу и секрету приложения.
   Секрет не задан — не проверяем, но и не притворяемся, что проверили. */
function sigOk(raw, header) {
  if (!APP_SECRET) return null;
  const got = String(header || '').replace(/^sha256=/, '');
  if (!got) return false;
  const want = crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
  return got.length === want.length
    && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/* Проверка вебхука при подключении: Meta зовёт GET и ждёт обратно свой challenge. */
function verify(query) {
  if (!VERIFY) return null;
  const mode = query.get('hub.mode');
  const token = query.get('hub.verify_token');
  if (mode === 'subscribe' && token === VERIFY) return query.get('hub.challenge') || '';
  return null;
}

async function post(body) {
  if (!on()) return { ok: false, reason: 'whatsapp off' };
  try {
    const r = await fetch(api(), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ messaging_product: 'whatsapp' }, body)),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = (j.error && j.error.message) || ('HTTP ' + r.status);
      console.error('[wa] не ушло:', e);
      return { ok: false, reason: e };
    }
    return { ok: true, id: j.messages && j.messages[0] && j.messages[0].id };
  } catch (e) {
    console.error('[wa]', e.message);
    return { ok: false, reason: e.message };
  }
}

/* Обычный текст. Работает только в сутках после сообщения человека —
   таково правило Meta, для холодных уведомлений есть шаблон ниже. */
const sendText = (to, body) => post({
  to: String(to).replace(/\D/g, ''),
  type: 'text',
  text: { preview_url: false, body: String(body).slice(0, 4000) },
});

/* Шаблон: единственный способ написать первым. Имя и язык — из настроек,
   потому что шаблон утверждает Meta и переименовать его на ходу нельзя. */
function sendTemplate(to, params, name, lang) {
  const tpl = name || process.env.WA_ALERT_TEMPLATE || '';
  if (!tpl) return Promise.resolve({ ok: false, reason: 'no template' });
  return post({
    to: String(to).replace(/\D/g, ''),
    type: 'template',
    template: {
      name: tpl,
      language: { code: lang || process.env.WA_TEMPLATE_LANG || 'en' },
      components: params && params.length
        ? [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: String(t).slice(0, 300) })) }]
        : undefined,
    },
  });
}

/* Входящее приводим к простому виду: от кого, что написал, как зовут.
   Кнопки и списки Meta кладёт в другое место — их текст достаём тоже. */
function incoming(payload) {
  const out = [];
  const entries = (payload && payload.entry) || [];
  for (const e of entries) {
    for (const ch of e.changes || []) {
      const v = ch.value || {};
      const names = {};
      for (const c of v.contacts || []) names[c.wa_id] = (c.profile && c.profile.name) || '';
      for (const m of v.messages || []) {
        let text = '';
        if (m.type === 'text') text = (m.text && m.text.body) || '';
        else if (m.type === 'button') text = (m.button && m.button.text) || '';
        else if (m.type === 'interactive') {
          const i = m.interactive || {};
          text = (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || '';
        }
        out.push({ from: String(m.from || '').replace(/\D/g, ''), text: String(text).trim(), name: names[m.from] || '', type: m.type, id: m.id });
      }
    }
  }
  return out;
}

module.exports = { on, sigOk, verify, sendText, sendTemplate, incoming, number: () => String(process.env.WA_NUMBER || '').replace(/\D/g, '') };
