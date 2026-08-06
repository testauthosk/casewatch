/* Отправка писем через Resend.

   Ключа может ещё не быть — тогда письмо не теряется молча: код пишется в лог
   и в таблицу mail_log, чтобы поток регистрации можно было проверить целиком
   до подключения почты. Как только RESEND_API_KEY появится, письма пойдут
   сами, менять код не придётся.

   Вёрстка писем — таблицами и инлайновыми стилями: почтовые клиенты режут
   современный CSS, и то, что красиво в браузере, у половины людей развалится.
   К каждому письму идёт текстовая версия — без неё письмо чаще уходит в спам,
   а на часах и в простых клиентах его просто не прочитать. */
const { q, now } = require('./db');

const KEY = process.env.RESEND_API_KEY || '';
const FROM = process.env.MAIL_FROM || 'CaseCheck <onboarding@resend.dev>';
const SITE = process.env.PUBLIC_URL || 'https://uscasecheck.com';
const SUPPORT = process.env.SUPPORT_EMAIL || 'support@uscasecheck.com';

const NAVY = '#101E38';
const ACC = '#12A98D';
const INK = '#17233E';
const INK2 = '#54617D';
const MUTED = '#8B96AD';
const LINE = '#E4E9F1';
const FONT = "-apple-system,'Segoe UI',Roboto,Arial,sans-serif";

/* Шапка, подвал и оболочка одинаковы у всех писем — держим их в одном месте. */
function shell(inner) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  :root{ color-scheme:light dark; supported-color-schemes:light dark; }
  /* Outlook перекрашивает фон по-своему — возвращаем шапке её цвет */
  [data-ogsc] .hdr, [data-ogsb] .hdr{ background:${NAVY} !important; }
</style></head>
<body style="margin:0;padding:0;background:#F5F8FC;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F8FC;padding:28px 14px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFFFF;border:1px solid ${LINE};border-radius:16px;overflow:hidden;">
    <tr><td class="hdr" style="background-color:${NAVY};padding:0;line-height:0;">
      <a href="${SITE}" style="text-decoration:none;"><img src="${SITE}/assets/mail-header.png" width="480" alt="CaseCheck — U.S. immigration court, EOIR"
        style="display:block;width:100%;max-width:480px;height:auto;border:0;outline:none;color:#FFFFFF;font:700 18px/84px ${FONT};"></a>
    </td></tr>
    ${inner}
    <tr><td style="padding:18px 26px 24px;border-top:1px solid #EEF2F7;">
      <div style="font:400 12px/1.6 ${FONT};color:${MUTED};">
        Questions? Write to <a href="mailto:${SUPPORT}" style="color:${INK2};">${SUPPORT}</a>.<br>
        CaseCheck is an independent service, not affiliated with the U.S. Department of Justice or EOIR, and does not provide legal advice.
      </div>
    </td></tr>
  </table>
  <div style="font:400 11.5px/1.6 ${FONT};color:${MUTED};margin-top:14px;">
    <a href="${SITE}" style="color:${MUTED};">uscasecheck.com</a>
  </div>
</td></tr></table>
</body></html>`;
}

function codeHtml(code, purpose) {
  const title = purpose === 'signup' ? 'Confirm your email' : 'Your sign-in code';
  const lead = purpose === 'signup'
    ? 'Enter this code on CaseCheck to finish creating your account.'
    : 'Enter this code to finish signing in. If it was not you, ignore this email — nobody gets in without the code.';
  return shell(`<tr><td style="padding:28px 26px 6px;">
      <div style="font:700 21px/1.3 ${FONT};color:${INK};">${title}</div>
      <div style="font:400 15px/1.6 ${FONT};color:${INK2};margin-top:10px;">${lead}</div>
    </td></tr>
    <tr><td style="padding:20px 26px 4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td align="center" style="background:#F0F4FA;border:1px dashed #D3DAE6;border-radius:12px;padding:18px 10px;">
          <span style="font:500 30px/1.1 'SFMono-Regular',Menlo,Consolas,monospace;color:${INK};letter-spacing:.18em;">${code}</span>
        </td></tr>
      </table>
      <div style="font:400 13px/1.6 ${FONT};color:${MUTED};margin-top:12px;">The code works for 10 minutes and can be used once.</div>
    </td></tr>
    <tr><td style="padding:6px 26px 22px;">
      <div style="font:400 13px/1.6 ${FONT};color:${MUTED};">Never share this code. CaseCheck will not ask you for it by phone or message.</div>
    </td></tr>`);
}

function codeText(code, purpose) {
  const lead = purpose === 'signup'
    ? 'Enter this code on CaseCheck to finish creating your account.'
    : 'Enter this code to finish signing in. If it was not you, ignore this email.';
  return `${lead}\n\n    ${code}\n\nThe code works for 10 minutes and can be used once.\n`
    + `Never share it — CaseCheck will not ask for it by phone or message.\n\n${SITE}\nQuestions: ${SUPPORT}\n`;
}

/* Письмо об изменении в деле — пригодится рассылке уведомлений. */
function alertHtml(name, what, detail) {
  return shell(`<tr><td style="padding:28px 26px 6px;">
      <div style="font:700 21px/1.3 ${FONT};color:${INK};">${what}</div>
      <div style="font:400 15px/1.6 ${FONT};color:${INK2};margin-top:8px;">${name}</div>
    </td></tr>
    <tr><td style="padding:16px 26px 4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0F4FA;border-radius:12px;">
        <tr><td style="padding:16px 18px;font:500 15px/1.6 ${FONT};color:${INK};">${detail}</td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:18px 26px 24px;">
      <a href="${SITE}/app.html" style="display:inline-block;background:${ACC};color:#FFFFFF;text-decoration:none;font:700 15px/1 ${FONT};padding:14px 22px;border-radius:10px;">Open my cases</a>
      <div style="font:400 12.5px/1.6 ${FONT};color:${MUTED};margin-top:14px;">
        Court schedules change. Confirm a hearing date with the court, the EOIR hotline at 1-800-898-7180, or your attorney.
      </div>
    </td></tr>`);
}

async function send(to, subject, html, kind, text) {
  if (!KEY) {
    console.warn('[mail] RESEND_API_KEY не задан — письмо не отправлено:', kind, to);
    q.logMail.run(to, kind, 0, 'no api key', now());
    return { ok: false, reason: 'no-key' };
  }
  try {
    const payload = { from: FROM, to: [to], subject, html };
    if (text) payload.text = text;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await r.json().catch(() => ({}));
    const ok = r.ok;
    q.logMail.run(to, kind, ok ? 1 : 0, ok ? body.id || '' : JSON.stringify(body).slice(0, 300), now());
    if (!ok) console.error('[mail] resend отказал:', r.status, JSON.stringify(body).slice(0, 200));
    return { ok, id: body.id };
  } catch (e) {
    q.logMail.run(to, kind, 0, String(e.message).slice(0, 300), now());
    console.error('[mail] сбой отправки:', e.message);
    return { ok: false, reason: 'error' };
  }
}

function sendCode(to, code, purpose) {
  const subject = purpose === 'signup'
    ? `${code} — confirm your email · CaseCheck`
    : `${code} is your CaseCheck sign-in code`;
  return send(to, subject, codeHtml(code, purpose), 'code:' + purpose, codeText(code, purpose));
}

function sendAlert(to, name, what, detail) {
  return send(to, `${what} — ${name} · CaseCheck`, alertHtml(name, what, detail), 'alert',
    `${what}\n${name}\n\n${detail}\n\nOpen your cases: ${SITE}/app.html\n`);
}

module.exports = { send, sendCode, sendAlert, hasKey: () => !!KEY };
