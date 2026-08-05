/* Отправка писем через Resend.

   Ключа может ещё не быть — тогда письмо не теряется молча: код пишется в лог
   и в таблицу mail_log, чтобы поток регистрации можно было проверить целиком
   до подключения почты. Как только RESEND_API_KEY появится, письма пойдут
   сами, менять код не придётся. */
const { q, now } = require('./db');

const KEY = process.env.RESEND_API_KEY || '';
const FROM = process.env.MAIL_FROM || 'CaseWatch <onboarding@resend.dev>';
const BRAND = '#12A98D';
const NAVY = '#101E38';

function codeHtml(code, purpose) {
  const title = purpose === 'signup' ? 'Confirm your email' : 'Your sign-in code';
  const lead = purpose === 'signup'
    ? 'Enter this code on CaseWatch to finish creating your account.'
    : 'Enter this code to sign in. If it wasn’t you, ignore this email.';
  return `<div style="font-family:Arial,Helvetica,sans-serif;background:#F5F8FC;padding:28px">
  <div style="max-width:460px;margin:0 auto;background:#fff;border:1px solid #E4E9F1;border-radius:14px;overflow:hidden">
    <div style="background:${NAVY};padding:18px 24px;color:#fff">
      <span style="font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:${BRAND}">CaseWatch</span>
      <div style="font-size:20px;font-weight:bold;margin-top:4px">${title}</div>
    </div>
    <div style="padding:24px">
      <p style="margin:0 0 18px;color:#54617D;font-size:15px;line-height:1.55">${lead}</p>
      <div style="font-family:'IBM Plex Mono',Menlo,monospace;font-size:30px;letter-spacing:.22em;
                  text-align:center;background:#F0F4FA;border:1px dashed #D3DAE6;border-radius:10px;padding:16px">${code}</div>
      <p style="margin:18px 0 0;color:#8B96AD;font-size:13px">The code expires in 10 minutes.</p>
    </div>
    <div style="padding:14px 24px 20px;border-top:1px solid #EEF2F7;color:#8B96AD;font-size:12px;line-height:1.5">
      CaseWatch is an independent service and is not affiliated with EOIR or any government agency.
    </div>
  </div>
</div>`;
}

async function send(to, subject, html, kind) {
  if (!KEY) {
    console.warn('[mail] RESEND_API_KEY не задан — письмо не отправлено:', kind, to);
    q.logMail.run(to, kind, 0, 'no api key', now());
    return { ok: false, reason: 'no-key' };
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, html }),
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
    ? 'Confirm your email — CaseWatch'
    : `${code} is your CaseWatch sign-in code`;
  return send(to, subject, codeHtml(code, purpose), 'code:' + purpose);
}

module.exports = { send, sendCode, hasKey: () => !!KEY };
