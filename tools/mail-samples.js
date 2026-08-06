/* Показать все письма живьём: шлёт по одному образцу каждого вида.

   Запуск:  RESEND_API_KEY=... node tools/mail-samples.js you@example.com
   Данные в образцах выдуманные — это витрина шаблонов, а не реальная рассылка. */
process.env.DATA_DIR = process.env.DATA_DIR || require('path').join(require('os').tmpdir(), 'casecheck-samples');
process.env.PUBLIC_URL = process.env.PUBLIC_URL || 'https://uscasecheck.com';
process.env.SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@uscasecheck.com';
process.env.MAIL_FROM = process.env.MAIL_FROM || 'CaseCheck <noreply@uscasecheck.com>';

const mail = require('../mail');

const to = process.argv[2];
if (!to) {
  console.error('кому слать? node tools/mail-samples.js you@example.com');
  process.exit(1);
}

const samples = [
  ['код при регистрации', () => mail.sendCode(to, '482913', 'signup')],
  ['код при входе', () => mail.sendCode(to, '750164', 'login')],
  ['после регистрации', () => mail.sendWelcome(to)],
  ['появилась дата слушания', () => mail.sendAlert(to, {
    subject: 'Hearing scheduled — Maria Rodriguez',
    title: 'A hearing date appeared',
    lead: 'EOIR has published a hearing date for this case. Nothing else changed.',
    rows: [['Case', 'A240-974-400'], ['Hearing', 'May 14, 2026 · 9:00 AM'],
           ['Court', 'Chicago, IL — Immigration Court'], ['Judge decision', 'Pending']],
  })],
  ['слушание перенесли', () => mail.sendAlert(to, {
    subject: 'Hearing moved — Maria Rodriguez',
    title: 'The hearing was moved',
    lead: 'The court changed the date. The new one is below — confirm it before you travel.',
    rows: [['Case', 'A240-974-400'], ['Was', 'March 2, 2026 · 8:30 AM'],
           ['Now', 'May 14, 2026 · 9:00 AM'], ['Court', 'Chicago, IL — Immigration Court']],
  })],
  ['решение судьи', () => mail.sendAlert(to, {
    subject: 'Decision recorded — Jose Ramirez',
    title: 'The judge decision changed',
    lead: 'EOIR now shows a decision on this case. Ask your attorney what it means for the next step.',
    rows: [['Case', 'A215-330-118'], ['Decision', 'Terminated'],
           ['Court', 'Miami, FL — Immigration Court'], ['Seen', 'August 6, 2026']],
  })],
  ['дело появилось в системе', () => mail.sendAlert(to, {
    subject: 'Case found — A251-887-002',
    title: 'The case appeared in EOIR',
    lead: 'The number you were watching now has a record. Here is what the court publishes today.',
    rows: [['Case', 'A251-887-002'], ['Status', 'In proceedings'],
           ['Hearing', 'None scheduled yet'], ['Court', 'Newark, NJ — Immigration Court']],
  })],
  ['итог недели', () => mail.sendWeekly(to, [
    { name: 'Maria Rodriguez · A240-974-400', state: 'Hearing May 14, 2026' },
    { name: 'Jose Ramirez · A215-330-118', state: 'Terminated' },
    { name: 'A251-887-002', state: 'No record yet' },
  ])],
  ['оплата принята', () => mail.sendPaid(to, 'year', '75.00', 'August 6, 2027')],
  ['подписка кончается', () => mail.sendExpiring(to, 'August 20, 2026')],
  ['пароль изменён', () => mail.sendPasswordChanged(to)],
  ['обращение принято', () => mail.sendSupportAck(to, 'Case or hearing data')],
];

(async () => {
  for (const [name, run] of samples) {
    const r = await run();
    console.log((r.ok ? 'ок  ' : 'сбой') + ' — ' + name + (r.id ? '  ' + r.id : '  ' + (r.reason || '')));
    await new Promise((s) => setTimeout(s, 700));   // не долбим лимит Resend
  }
  process.exit(0);
})();
