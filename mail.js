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

/* Шапка, подвал и оболочка одинаковы у всех писем — держим их в одном месте.
   Картинку шапки кешируют и Cloudflare, и почтовые клиенты, поэтому при правке
   меняем ИМЯ файла: иначе неделю будет ходить старая. */
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
      <a href="${SITE}" style="text-decoration:none;"><img src="${SITE}/assets/mail-header-v2.png" width="480" alt="CaseCheck — U.S. immigration court, EOIR"
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


/* Кирпичики: из них собраны все письма, чтобы отступы и типографика не разъезжались. */
const head = (t) => `<tr><td style="padding:28px 26px 4px;"><div style="font:700 21px/1.3 ${FONT};color:${INK};">${t}</div></td></tr>`;
const para = (t, pad) => `<tr><td style="padding:${pad || '10px 26px 0'};"><div style="font:400 15px/1.62 ${FONT};color:${INK2};">${t}</div></td></tr>`;
const small = (t) => `<tr><td style="padding:12px 26px 22px;"><div style="font:400 12.5px/1.6 ${FONT};color:${MUTED};">${t}</div></td></tr>`;
const button = (label, href) => `<tr><td style="padding:20px 26px 6px;">
      <a href="${href}" style="display:inline-block;background:${ACC};color:#FFFFFF;text-decoration:none;font:700 15px/1 ${FONT};padding:14px 22px;border-radius:10px;">${label}</a>
    </td></tr>`;

/* Плашка с фактами: слева подпись, справа значение. */
const facts = (rows) => `<tr><td style="padding:18px 26px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0F4FA;border-radius:12px;">
        ${rows.map(function (r, i) {
          const top = i ? '10px' : '14px';
          const bottom = i === rows.length - 1 ? '14px' : '0';
          return `<tr>
          <td style="padding:${top} 18px ${bottom} 18px;font:400 13px/1.5 ${FONT};color:${MUTED};">${r[0]}</td>
          <td align="right" style="padding:${top} 18px ${bottom} 18px;font:600 14px/1.5 ${FONT};color:${INK};">${r[1]}</td>
        </tr>`;
        }).join('')}
      </table>
    </td></tr>`;

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

/* Изменение в деле — то, ради чего человек и подписывался. */
function alertHtml(m) {
  return shell(head(m.title) + para(m.lead)
    + facts(m.rows)
    + button('Open my cases', SITE + '/app.html')
    + small('Court schedules change. Confirm a hearing date with the court, the EOIR hotline at 1-800-898-7180, or your attorney.'));
}

/* Первое письмо после регистрации: что дальше и чего ждать. */
function welcomeHtml() {
  return shell(head('Your account is ready')
    + para('Add the A-Number and we start watching the case. When the hearing date or the judge decision changes, you hear about it — by email, in Telegram, or on WhatsApp, whichever you connect.')
    + facts([['Free plan', 'One case, one check'],
             ['Monitoring', '$9.99 / month or $75 / year'],
             ['Cases per account', 'Up to 3']])
    + button('Add my case', SITE + '/app.html')
    + small('CaseCheck reads the public EOIR record. It does not give legal advice and cannot change what the court publishes.'));
}

/* Итог недели — уходит тем, кто попросил его в настройках. */
function weeklyHtml(items) {
  const body = items.length
    ? facts(items.map(function (i) { return [i.name, i.state]; }))
    : para('Nothing moved this week. Your cases are being checked around the clock.', '18px 26px 0');
  return shell(head('Your week on CaseCheck')
    + para('A short summary of what we saw. No changes is good news — it means nothing was rescheduled.')
    + body
    + button('Open my cases', SITE + '/app.html')
    + small('You can turn this summary off on the Alerts page inside your account.'));
}

/* Оплата принята. */
function paidHtml(plan, amount, until) {
  return shell(head('Monitoring is on')
    + para('Payment received — thank you. Your cases are now re-checked around the clock and alerts are live.')
    + facts([['Plan', plan === 'year' ? 'Yearly' : 'Monthly'],
             ['Amount', '$' + amount],
             ['Paid until', until]])
    + button('Open my cases', SITE + '/app.html')
    + small('Cancel any time on the Plan &amp; billing page — the plan keeps working until the end of the paid period.'));
}

/* Подписка заканчивается. */
function expiringHtml(until) {
  return shell(head('Your plan ends soon')
    + para('Monitoring stays on until ' + until + '. After that we stop re-checking the cases and the alerts go quiet — the account and its history stay with you.')
    + button('Renew monitoring', SITE + '/billing.html')
    + small('If you meant to stop, ignore this letter. Nothing is charged without your action.'));
}

/* Смена пароля — письмо-сторож. */
function passwordHtml() {
  return shell(head('Your password was changed')
    + para('The password for your CaseCheck account has just been changed, and every other device has been signed out.')
    + para('If that was you, nothing else is needed. If it was not, write to us right away — we will lock the account.', '12px 26px 0')
    + button('Write to support', 'mailto:' + SUPPORT)
    + small('We never ask for your password or sign-in codes by email, phone, or message.'));
}

/* Ответ на обращение в поддержку. */
function supportAckHtml(topic) {
  return shell(head('We got your message')
    + para('A person reads every message here — not a robot. We answer within one business day, usually sooner.')
    + facts([['Topic', topic || 'General question']])
    + small('If something changes in your case meanwhile, the alerts keep working as usual.'));
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

const plain = (title, lines) => `${title}\n\n${lines.join('\n')}\n\n${SITE}\nQuestions: ${SUPPORT}\n`;

function sendAlert(to, m) {
  return send(to, m.subject + ' · CaseCheck', alertHtml(m), 'alert',
    plain(m.title, [m.lead].concat(m.rows.map(function (r) { return r[0] + ': ' + r[1]; }))));
}

function sendWelcome(to) {
  return send(to, 'Your CaseCheck account is ready', welcomeHtml(), 'welcome',
    plain('Your account is ready', ['Add the A-Number and we start watching the case.',
      'Free plan: one case, one check. Monitoring: $9.99/month or $75/year.']));
}

function sendWeekly(to, items) {
  return send(to, 'Your week on CaseCheck', weeklyHtml(items || []), 'weekly',
    plain('Your week on CaseCheck', (items || []).map(function (i) { return i.name + ': ' + i.state; })));
}

function sendPaid(to, plan, amount, until) {
  return send(to, 'Monitoring is on · CaseCheck', paidHtml(plan, amount, until), 'paid',
    plain('Monitoring is on', ['Plan: ' + plan, 'Amount: $' + amount, 'Paid until: ' + until]));
}

function sendExpiring(to, until) {
  return send(to, 'Your CaseCheck plan ends soon', expiringHtml(until), 'expiring',
    plain('Your plan ends soon', ['Monitoring stays on until ' + until + '.']));
}

function sendPasswordChanged(to) {
  return send(to, 'Your CaseCheck password was changed', passwordHtml(), 'password',
    plain('Your password was changed', ['Every other device has been signed out.',
      'If that was not you, write to ' + SUPPORT + ' right away.']));
}

function sendSupportAck(to, topic) {
  return send(to, 'We got your message · CaseCheck', supportAckHtml(topic), 'support-ack',
    plain('We got your message', ['Topic: ' + (topic || 'General question'),
      'We answer within one business day.']));
}

module.exports = {
  send, sendCode, sendAlert, sendWelcome, sendWeekly, sendPaid, sendExpiring,
  sendPasswordChanged, sendSupportAck, hasKey: () => !!KEY,
};
