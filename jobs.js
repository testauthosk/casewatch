/* Расписание.

   Одна минутная стрелка на всё, что нельзя сделать в момент события: письма,
   которые ждут документ из Stripe, напоминания об окончании подписки, итог
   недели и утренняя сводка в админский чат.

   Внешний планировщик сюда не нужен: сайт и так работает без остановки, а
   отдельный крон означал бы вторую машину, которая может не проснуться.
   Всё, что уже отправлено, помечается в базе — перезапуск не рассылает дубли. */
const { q, now } = require('./db');
const mail = require('./mail');
const admin = require('./admin');

const DAY = 86400;
const hourUTC = () => new Date().getUTCHours();
const dayKey = () => new Date().toISOString().slice(0, 10);
const weekKey = () => {
  const d = new Date();
  const jan = Date.UTC(d.getUTCFullYear(), 0, 1);
  return d.getUTCFullYear() + '-w' + Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - jan) / (7 * DAY * 1000));
};

/* Отметка «сделано»: возвращает true только первому, кто её поставил. */
const once = (userId, kind, mark) => q.addMark.run(userId, kind, String(mark), now()).changes === 1;

/* 1. Письмо об оплате, которое ждало счёт. Stripe присылает документ отдельным
      событием через несколько секунд; если он не пришёл за три минуты —
      отправляем без вложения, молчать нельзя. */
function paidMailSweep(mailPaid) {
  for (const pay of q.unmailedPayments.all(now() - 180)) {
    try {
      mailPaid(pay, pay.invoice || '', '');
      console.log('[jobs] письмо об оплате ушло без счёта, платёж', pay.id);
    } catch (e) { console.error('[jobs] оплата:', e.message); }
  }
}

/* 2. Подписка кончается через три дня. Один раз на каждый оплаченный срок:
      отметка привязана к дате окончания, продлил — получит снова. */
function expiring() {
  const t = now();
  for (const u of q.expiringSoon.all(t + 2 * DAY, t + 3 * DAY)) {
    if (!once(u.id, 'expiring', u.plan_until)) continue;
    const when = new Date(u.plan_until * 1000).toLocaleDateString('en-US',
      { month: 'long', day: 'numeric', year: 'numeric' });
    mail.sendExpiring(u.email, when).catch((e) => console.error('[jobs] expiring:', e.message));
    admin.event('⏳', 'Подписка кончается через три дня', [['Кто', u.email], ['До', when]]);
  }
}

/* 3. Итог недели — только тем, кто сам его включил. */
function weekly() {
  const key = weekKey();
  for (const u of q.weeklyWanted.all()) {
    if (!once(u.id, 'weekly', key)) continue;
    const items = q.cases.all(u.id).map((c) => ({
      name: (c.name ? c.name + ' · ' : '') + 'A' + String(c.a_number).replace(/(\d{3})(\d{3})(\d{3})/, '$1-$2-$3'),
      state: c.hearing_at ? 'Hearing ' + c.hearing_at
        : c.decision ? c.decision
          : c.status === 'found' ? 'In proceedings, no date yet' : 'No record yet',
    }));
    mail.sendWeekly(u.email, items).catch((e) => console.error('[jobs] weekly:', e.message));
  }
}

/* 4. Утренняя сводка в админский чат. */
function digest() {
  if (!admin.on()) return;
  if (!once(0, 'digest', dayKey())) return;
  admin.tell(admin.digest());
}

let started = false;
function start(hooks) {
  if (started) return;
  started = true;
  const digestHour = Number(process.env.ADMIN_DIGEST_UTC || 14);

  const tick = () => {
    try { paidMailSweep(hooks.mailPaid); } catch (e) { console.error('[jobs]', e.message); }
    const h = hourUTC();
    const m = new Date().getUTCMinutes();
    // остальное раз в час, в начале часа: чаще незачем, а точность тут не нужна
    if (m > 2) return;
    try { expiring(); } catch (e) { console.error('[jobs] expiring:', e.message); }
    if (h === digestHour) { try { digest(); } catch (e) { console.error('[jobs] digest:', e.message); } }
    // понедельник, тот же час — итог недели
    if (h === digestHour && new Date().getUTCDay() === 1) {
      try { weekly(); } catch (e) { console.error('[jobs] weekly:', e.message); }
    }
  };

  setTimeout(tick, 20000);                 // первый прогон — после того как всё поднялось
  setInterval(tick, 60000).unref();
  console.log('[jobs] расписание запущено, сводка в', digestHour + ':00 UTC');
}

module.exports = { start, expiring, weekly, digest, paidMailSweep };
