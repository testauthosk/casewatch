/* WhatsApp — только транспорт: отправка, подпись, разбор входящего.

   Разговор с человеком живёт в server.js, здесь ничего не знают ни про базу,
   ни про дела. Пока в настройках нет доступов — модуль молчит и всё отдаёт
   как «выключено», сайт от этого не ломается.

   Транспорта два, выбирается сам по настройкам:

   • Green API (GREEN_ID + GREEN_TOKEN) — мост к обычному WhatsApp, номер
     привязан как второе устройство по QR. Ни шаблонов, ни одобрений Meta,
     ни суточного окна: пишем когда нужно. Берётся первым, если задан.
   • Cloud API (WA_TOKEN + WA_PHONE_ID) — официальный путь Meta. Оставлен
     целиком: если у нас появится нормальный доступ к бизнес-аккаунту,
     достаточно убрать переменные Green и ничего больше не трогать. */
const crypto = require('crypto');

/* ── Cloud API (Meta) ───────────────────────────────────────────────── */
const VER = process.env.WA_API_VER || 'v21.0';
const TOKEN = process.env.WA_TOKEN || '';
const PHONE_ID = process.env.WA_PHONE_ID || '';
const APP_SECRET = process.env.WA_APP_SECRET || '';
const VERIFY = process.env.WA_VERIFY_TOKEN || '';
const BASE = process.env.WA_API_BASE || 'https://graph.facebook.com';
const api = () => BASE + '/' + VER + '/' + PHONE_ID + '/messages';
const cloudOn = () => !!(TOKEN && PHONE_ID);

/* ── Green API ──────────────────────────────────────────────────────── */
const G_ID = String(process.env.GREEN_ID || '').trim();
const G_TOKEN = String(process.env.GREEN_TOKEN || '').trim();
/* У каждого инстанса свой хост вида https://7107.api.greenapi.com; общий
   api.green-api.com тоже отвечает, поэтому он и стоит по умолчанию. */
const G_BASE = (process.env.GREEN_API_URL || 'https://api.green-api.com').replace(/\/+$/, '');
/* Green не подписывает тело. Защита вебхука — общий секрет, который сам же
   Green шлёт заголовком Authorization: Bearer <...>, если его задать в консоли. */
const G_HOOK_TOKEN = String(process.env.GREEN_WEBHOOK_TOKEN || '').trim();
const greenOn = () => !!(G_ID && G_TOKEN);
const gUrl = (method) => G_BASE + '/waInstance' + G_ID + '/' + method + '/' + G_TOKEN;

const on = () => greenOn() || cloudOn();
const digits = (s) => String(s || '').replace(/\D/g, '');

/* Подпись входящего вебхука.
   Возвращаем true/false/null: null значит «проверять нечем» — так вызывающий
   не путает непроверенное с проверенным. Принимаем и весь набор заголовков,
   и одну строку (так звали раньше, когда транспорт был только один). */
function sigOk(raw, headers) {
  const head = (name) => {
    if (!headers) return '';
    if (typeof headers === 'string') return headers;
    return headers[name] || headers[name.toLowerCase()] || '';
  };

  if (greenOn()) {
    if (!G_HOOK_TOKEN) return null;
    const got = String(head('authorization')).replace(/^Bearer\s+/i, '');
    if (!got) return false;
    const a = Buffer.from(got);
    const b = Buffer.from(G_HOOK_TOKEN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  if (!APP_SECRET) return null;
  const got = String(head('x-hub-signature-256')).replace(/^sha256=/, '');
  if (!got) return false;
  const want = crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
  return got.length === want.length
    && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/* Проверка вебхука при подключении: так делает только Meta — зовёт GET и
   ждёт обратно свой challenge. Green ничего подобного не спрашивает. */
function verify(query) {
  if (greenOn() || !VERIFY) return null;
  const mode = query.get('hub.mode');
  const token = query.get('hub.verify_token');
  if (mode === 'subscribe' && token === VERIFY) return query.get('hub.challenge') || '';
  return null;
}

async function postJson(url, body, headers) {
  const r = await fetch(url, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return { r, j };
}

async function cloudPost(body) {
  try {
    const { r, j } = await postJson(api(), Object.assign({ messaging_product: 'whatsapp' }, body),
      { authorization: 'Bearer ' + TOKEN });
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

async function greenSend(to, text) {
  try {
    const { r, j } = await postJson(gUrl('sendMessage'), {
      chatId: digits(to) + '@c.us',
      message: String(text).slice(0, 4000),
    });
    if (!r.ok || !j.idMessage) {
      const e = j.message || j.error || ('HTTP ' + r.status);
      console.error('[wa green] не ушло:', e);
      return { ok: false, reason: String(e) };
    }
    return { ok: true, id: j.idMessage };
  } catch (e) {
    console.error('[wa green]', e.message);
    return { ok: false, reason: e.message };
  }
}

/* Обычный текст. На Cloud API он работает только сутки после сообщения
   человека — таково правило Meta; у Green такого ограничения нет. */
function sendText(to, body) {
  if (!on()) return Promise.resolve({ ok: false, reason: 'whatsapp off' });
  if (greenOn()) return greenSend(to, body);
  return cloudPost({
    to: digits(to),
    type: 'text',
    text: { preview_url: false, body: String(body).slice(0, 4000) },
  });
}

/* Шаблон — способ Meta написать первым. У Green шаблонов нет и не нужно:
   отвечаем «не вышло», и вызывающий сам отправит обычный текст, который
   у него уже собран целиком и читается лучше склейки из параметров. */
function sendTemplate(to, params, name, lang) {
  if (greenOn()) return Promise.resolve({ ok: false, reason: 'green api: templates not used' });
  if (!cloudOn()) return Promise.resolve({ ok: false, reason: 'whatsapp off' });
  const tpl = name || process.env.WA_ALERT_TEMPLATE || '';
  if (!tpl) return Promise.resolve({ ok: false, reason: 'no template' });
  return cloudPost({
    to: digits(to),
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
   Форматы у транспортов разные, наружу отдаём один и тот же. */
function greenIncoming(p) {
  /* Своё же исходящее Green присылает тем же вебхуком — на него отвечать
     нельзя, иначе бот заговорит сам с собой. Группы тоже не наше дело. */
  if (!p || p.typeWebhook !== 'incomingMessageReceived') return [];
  const s = p.senderData || {};
  if (!s.chatId || !String(s.chatId).endsWith('@c.us')) return [];

  const d = p.messageData || {};
  let text = '';
  if (d.textMessageData) text = d.textMessageData.textMessage || '';
  else if (d.extendedTextMessageData) text = d.extendedTextMessageData.text || d.extendedTextMessageData.description || '';
  else if (d.buttonsResponseMessage) text = d.buttonsResponseMessage.selectedButtonText || '';
  else if (d.listResponseMessage) text = d.listResponseMessage.title || '';
  else if (d.templateButtonReplyMessage) text = d.templateButtonReplyMessage.selectedDisplayText || '';

  return [{
    from: digits(s.sender || s.chatId),
    text: String(text).trim(),
    name: s.senderName || '',
    type: d.typeMessage || 'text',
    id: p.idMessage || '',
  }];
}

function cloudIncoming(payload) {
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
        out.push({ from: digits(m.from), text: String(text).trim(), name: names[m.from] || '', type: m.type, id: m.id });
      }
    }
  }
  return out;
}

const incoming = (payload) => (greenOn() ? greenIncoming(payload) : cloudIncoming(payload));

/* Состояние инстанса Green — для диагностики: authorized значит номер
   привязан и телефон на связи, notAuthorized — надо заново сканировать QR. */
async function state() {
  if (!greenOn()) return { transport: cloudOn() ? 'cloud' : 'off' };
  try {
    const r = await fetch(gUrl('getStateInstance'));
    const j = await r.json().catch(() => ({}));
    return { transport: 'green', state: j.stateInstance || ('HTTP ' + r.status) };
  } catch (e) {
    return { transport: 'green', state: 'error: ' + e.message };
  }
}

module.exports = {
  on,
  sigOk,
  verify,
  sendText,
  sendTemplate,
  incoming,
  state,
  transport: () => (greenOn() ? 'green' : cloudOn() ? 'cloud' : 'off'),
  number: () => digits(process.env.WA_NUMBER),
};
