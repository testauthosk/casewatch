/* Админский канал в телеграме.

   Отдельный бот и отдельный чат: рабочая переписка с клиентами не должна
   мешаться с внутренними оповещениями. Живёт прямо в сайте, а не отдельным
   процессом — здесь под рукой база, и нечему падать по отдельности.

   Настройки:
     ADMIN_BOT_TOKEN   токен бота от BotFather
     ADMIN_CHAT_ID     куда писать (можно несколько через запятую)
     ADMIN_DIGEST_UTC  час утренней сводки по UTC, по умолчанию 14 (10 утра в Нью-Йорке) */
const { db, q, now } = require('./db');

const TOKEN = () => process.env.ADMIN_BOT_TOKEN || '';
const CHATS = () => String(process.env.ADMIN_CHAT_ID || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const on = () => !!(TOKEN() && CHATS().length);

const esc = (v) => String(v == null ? '' : v)
  .replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

async function api(method, body) {
  if (!TOKEN()) return { ok: false };
  try {
    const base = process.env.TG_API_BASE || 'https://api.telegram.org';
    const r = await fetch(base + '/bot' + TOKEN() + '/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    return await r.json().catch(() => ({ ok: false }));
  } catch (e) {
    console.error('[admin]', method, e.message);
    return { ok: false };
  }
}

/* Оповещение. Никогда не ждём его отправки в обработчике запроса: клиент не
   должен ждать телеграм, а упавший телеграм не должен ронять регистрацию. */
function tell(text, chats) {
  if (!on()) return;
  const list = chats || CHATS();
  for (const chat of list) {
    api('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true })
      .then((r) => {
        if (!r.ok) return console.warn('[admin] не доставлено:', JSON.stringify(r).slice(0, 160));
        /* Сверка кодов символов: буквы в логах может испортить сам терминал,
           а числа — нет. Слева что отправили, справа что телеграм сохранил. */
        if (process.env.DEBUG_TG) {
          const codes = (v) => [...String(v)].slice(0, 10).map((c) => c.codePointAt(0)).join(',');
          console.log('[admin] коды исходные:', codes(text));
          console.log('[admin] коды у телеграма:', codes((r.result && r.result.text) || ''));
        }
      });
  }
}

/* Событие одной строкой: значок, заголовок, подробности парами. */
function event(icon, title, rows) {
  const body = (rows || []).filter((r) => r && r[1])
    .map((r) => '<b>' + esc(r[0]) + ':</b> ' + esc(r[1])).join('\n');
  tell(icon + ' <b>' + esc(title) + '</b>' + (body ? '\n' + body : ''));
}

/* ── счётчики ── */
const one = (sql) => { const st = db.prepare(sql); return (...a) => Object.values(st.get(...a) || {})[0] || 0; };

const count = {
  users: one('SELECT COUNT(*) n FROM users'),
  usersSince: one('SELECT COUNT(*) n FROM users WHERE created_at > ?'),
  verified: one('SELECT COUNT(*) n FROM users WHERE email_ok = 1'),
  paying: one("SELECT COUNT(*) n FROM users WHERE plan <> 'free' AND plan_until > ?"),
  cases: one('SELECT COUNT(*) n FROM cases'),
  watched: one('SELECT COUNT(*) n FROM cases WHERE monitoring = 1'),
  checkedSince: one('SELECT COUNT(*) n FROM cases WHERE checked_at > ?'),
  foundNow: one("SELECT COUNT(*) n FROM cases WHERE status = 'found'"),
  hearings: one("SELECT COUNT(*) n FROM cases WHERE hearing_at IS NOT NULL AND hearing_at <> ''"),
  alertsSince: one("SELECT COUNT(*) n FROM events WHERE kind IN ('hearing','decision','appeared') AND created_at > ?"),
  mailsSince: one('SELECT COUNT(*) n FROM mail_log WHERE created_at > ?'),
  mailFailsSince: one('SELECT COUNT(*) n FROM mail_log WHERE ok = 0 AND created_at > ?'),
  ticketsSince: one('SELECT COUNT(*) n FROM support WHERE created_at > ?'),
  moneySince: one('SELECT COALESCE(SUM(amount), 0) n FROM payments WHERE created_at > ?'),
  moneyAll: one('SELECT COALESCE(SUM(amount), 0) n FROM payments'),
  // подписки на сайте за всё время = сколько разных аккаунтов хоть раз платили
  subsSite: one('SELECT COUNT(DISTINCT user_id) n FROM payments'),
  tg: one('SELECT COUNT(*) n FROM users WHERE tg_id IS NOT NULL'),
  wa: one('SELECT COUNT(*) n FROM users WHERE wa_phone IS NOT NULL'),
  stuck: one('SELECT COUNT(*) n FROM cases WHERE fail_count >= 3'),
};

const money = (v) => '$' + Number(v || 0).toFixed(2);

/* Последний снимок цифр телеграм-бота (или null, если воркер ещё не присылал). */
function botSnap() {
  const row = q.getKv.get('botstats');
  if (!row) return null;
  try { return JSON.parse(row.value) || null; } catch (e) { return null; }
}

/* Цифры телеграм-бота. Его база на другой машине, поэтому здесь лежит
   присланный воркером снимок — и мы честно пишем, когда он снят. */
function botLines() {
  const row = q.getKv.get('botstats');
  if (!row) return ['', '<b>Телеграм-бот</b>', '\u00b7 цифр пока нет: воркер ещё не присылал снимок'];
  let b = {};
  try { b = JSON.parse(row.value) || {}; } catch (e) { return ['', '<b>Телеграм-бот</b>', '\u00b7 снимок не читается']; }
  const mins = Math.round((now() - row.at) / 60);
  const when = mins < 2 ? 'только что' : mins < 90 ? mins + ' мин назад' : Math.round(mins / 60) + ' ч назад';
  return ['', '<b>Телеграм-бот</b> <i>(снимок ' + when + ')</i>',
    '\u00b7 людей: ' + (b.users || 0) + ', пришли за сутки: ' + (b.usersDay || 0),
    '· платят деньгами: ' + (b.subsPaid != null ? b.subsPaid : (b.subs || 0))
      + (b.subsPaid != null && b.subs > b.subsPaid ? ' (+' + (b.subs - b.subsPaid) + ' выдано руками)' : '')
      + ' · за 30 дней: ' + money(b.money30 || 0)
      + ' \u00b7 всего: ' + money(b.moneyAll || 0),
    '\u00b7 дел: ' + (b.cases || 0) + ', под наблюдением: ' + (b.watched || 0),
    '\u00b7 бесплатных проверок в этом месяце: ' + (b.freeMonth || 0)];
}

function stats() {
  const t = now(), day = 86400;
  const bs = botSnap() || {};
  // платные подписчики бота за всё время; пока старый воркер не шлёт subsPaidAll — берём активных платных
  const siteSubs = count.subsSite(), botSubs = bs.subsPaidAll != null ? bs.subsPaidAll : (bs.subsPaid || 0);
  return [
    '📊 <b>CaseCheck — цифры</b>',
    '',
    '<b>Сайт — люди</b>',
    '· всего аккаунтов: ' + count.users() + ' (подтвердили почту ' + count.verified() + ')',
    '· пришли за сутки: ' + count.usersSince(t - day) + ', за неделю: ' + count.usersSince(t - 7 * day),
    '· телеграм привязан: ' + count.tg() + ' · WhatsApp: ' + count.wa(),
    '',
    '<b>Платные подписки за всё время</b>',
    '· на сайте: ' + siteSubs + ' · в боте: ' + botSubs + ' · всего: ' + (siteSubs + botSubs),
    '',
    '<b>Деньги</b>',
    '· платят сейчас: ' + count.paying(t),
    '· за 30 дней: ' + money(count.moneySince(t - 30 * day)) + ' · всего: ' + money(count.moneyAll()),
    '',
    '<b>Дела</b>',
    '· заведено: ' + count.cases() + ', под наблюдением: ' + count.watched(),
    '· найдены в EOIR: ' + count.foundNow() + ', со слушанием: ' + count.hearings(),
    '· проверены за сутки: ' + count.checkedSince(t - day),
    '· изменения за сутки: ' + count.alertsSince(t - day),
    count.stuck() ? '· ⚠️ не проверяются (3+ сбоя подряд): ' + count.stuck() : null,
    '',
    '<b>Почта и поддержка</b>',
    '· писем за сутки: ' + count.mailsSince(t - day)
      + (count.mailFailsSince(t - day) ? ' (не ушло ' + count.mailFailsSince(t - day) + ')' : ''),
    '· обращений за сутки: ' + count.ticketsSince(t - day),
  ].concat(botLines()).filter((l) => l !== null).join('\n');   // пустые строки — отбивка между разделами
}

/* Утренняя сводка: то же самое, но за прошедшие сутки и без воды. */
function digest() {
  const t = now(), day = 86400;
  const bs = botSnap() || {};
  // платные подписчики бота за всё время; пока старый воркер не шлёт subsPaidAll — берём активных платных
  const siteSubs = count.subsSite(), botSubs = bs.subsPaidAll != null ? bs.subsPaidAll : (bs.subsPaid || 0);
  /* Подписки — всегда, даже в тихий день: это итог за всё время, а не за сутки. */
  const subs = [
    '',
    '<b>Платные подписки за всё время</b>',
    '· на сайте: ' + siteSubs,
    '· в боте: ' + botSubs,
    '· всего: ' + (siteSubs + botSubs),
  ];
  const quiet = !count.usersSince(t - day) && !count.checkedSince(t - day)
    && !count.alertsSince(t - day) && !count.moneySince(t - day);
  const head = quiet
    ? ['🌅 <b>За сутки тихо</b>', 'Новых людей и изменений по делам за сутки нет.']
    : [
      '🌅 <b>Итоги суток</b>',
      '· новые аккаунты: ' + count.usersSince(t - day),
      '· оплаты: ' + money(count.moneySince(t - day)),
      '· проверок дел: ' + count.checkedSince(t - day),
      '· изменений в делах: ' + count.alertsSince(t - day),
      '· обращений: ' + count.ticketsSince(t - day),
      count.stuck() ? '· ⚠️ застряли на проверке: ' + count.stuck() : null,
    ];
  return head.concat(subs).concat(['', 'Подробнее — /stats'])
    .filter((l) => l !== null).join('\n');
}

/* Последние события — чтобы понять, чем живёт сервис, не заходя в базу. */
function feed() {
  const rows = db.prepare(
    `SELECT e.kind, e.text, e.created_at, u.email FROM events e
       JOIN users u ON u.id = e.user_id ORDER BY e.id DESC LIMIT 15`).all();
  if (!rows.length) return 'Событий пока нет.';
  return '🧾 <b>Последнее</b>\n' + rows.map((r) => {
    const ago = Math.max(0, now() - r.created_at);
    const when = ago < 3600 ? Math.round(ago / 60) + ' мин'
      : ago < 86400 ? Math.round(ago / 3600) + ' ч' : Math.round(ago / 86400) + ' дн';
    return '· ' + esc(r.text) + ' — ' + esc(r.email) + ', ' + when + ' назад';
  }).join('\n');
}

/* Кто вообще есть в базе: цифры в /stats отвечают «сколько», а этот список —
   «кто именно». Без него любой вопрос про число дел упирается в базу. */
const accountsQ = db.prepare(
  `SELECT u.id, u.email, u.plan, u.plan_until, u.tg_id, u.created_at,
          (SELECT COUNT(*) FROM cases c WHERE c.user_id = u.id) AS cases,
          (SELECT COUNT(*) FROM cases c WHERE c.user_id = u.id AND c.monitoring = 1) AS watched
     FROM users u ORDER BY u.id`);

function accounts() {
  const rows = accountsQ.all();
  if (!rows.length) return 'В базе пока никого.';
  const t = now();
  const lines = rows.map((r) => {
    const paid = r.plan !== 'free' && (r.plan_until || 0) > t;
    return '· ' + esc(r.email || ('id ' + r.id)) + ' — дел ' + r.cases
      + (r.watched !== r.cases ? ' (под наблюдением ' + r.watched + ')' : '')
      + ' · ' + (paid ? 'платит до ' + new Date(r.plan_until * 1000).toISOString().slice(0, 10) : 'бесплатный')
      + (r.tg_id ? ' · телеграм привязан' : '');
  });
  const cases = rows.reduce((n, r) => n + r.cases, 0);
  const nl = String.fromCharCode(10);
  return '👥 <b>Аккаунты сайта</b> — ' + rows.length + ', дел ' + cases + nl + nl
    + lines.join(nl) + nl + nl
    + '<i>Это база сайта. Подписчики телеграм-бота живут отдельно, пока не привяжут аккаунт.</i>';
}

/* ── команды ── */
const HELP = [
  '🤖 <b>Админский бот CaseCheck</b>',
  '',
  'Сюда падают все события сервиса: регистрации, оплаты, изменения в делах, обращения.',
  '',
  '/stats — полные цифры',
  '/today — что было за сутки',
  '/feed — последние события',
  '/who — кто зарегистрирован и сколько у кого дел',
  '/ping — проверить, что сайт жив',
].join('\n');

async function answer(chatId, text) {
  const cmd = String(text || '').trim().toLowerCase().split(/[\s@]/)[0];
  if (cmd === '/stats') return tell(stats(), [chatId]);
  if (cmd === '/today') return tell(digest(), [chatId]);
  if (cmd === '/feed') return tell(feed(), [chatId]);
  if (cmd === '/who') return tell(accounts(), [chatId]);
  if (cmd === '/ping') return tell('🟢 Сайт на связи. Аптайм процесса: '
    + Math.round(process.uptime() / 60) + ' мин.', [chatId]);
  return tell(HELP, [chatId]);
}

/* Кнопки команд в меню бота. Бот служебный, поэтому список команд виден
   только своим: телеграм умеет держать его отдельно для каждого чата, а из
   общего списка мы его убираем — посторонний не увидит даже, что бот умеет. */
async function setupMenu() {
  const commands = [
    { command: 'stats', description: 'Полные цифры сервиса' },
    { command: 'today', description: 'Что было за сутки' },
    { command: 'feed', description: 'Лента последних событий' },
    { command: 'who', description: 'Кто зарегистрирован и с чем' },
    { command: 'ping', description: 'Жив ли сайт' },
  ];
  await api('deleteMyCommands', { scope: { type: 'default' } });
  await api('deleteMyCommands', { scope: { type: 'all_group_chats' } });
  let ok = 0;
  for (const chat of CHATS()) {
    const r = await api('setMyCommands', { commands, scope: { type: 'chat', chat_id: chat } });
    if (r && r.ok) ok++;
    await api('setChatMenuButton', { chat_id: chat, menu_button: { type: 'commands' } });
  }
  console.log('[admin] меню команд: выставлено своим —', ok, 'из', CHATS().length);
}

/* Долгий опрос. Своего веб-хука не заводим: он потребовал бы отдельного пути
   наружу, а бот тут служебный — лишняя дверь ни к чему. */
async function listen() {
  if (!on()) return console.log('[admin] бот выключен: нет токена или чата');
  const allowed = new Set(CHATS().map(String));
  let offset = 0;
  await setupMenu();
  if (process.env.DEBUG_TG) {
    console.log('[admin] коды из исходника:',
      [...HELP].slice(0, 10).map((c) => c.codePointAt(0)).join(','));
  }
  console.log('[admin] бот на связи, чатов:', allowed.size);
  for (;;) {
    try {
      const r = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
      for (const u of (r && r.result) || []) {
        offset = u.update_id + 1;
        const m = u.message;
        if (!m || !m.text) continue;
        /* Посторонним не отвечаем вовсе. Любой ответ — уже подтверждение, что
           бот живой и чей-то; молчание не даёт даже этого. В группы бота не
           зовём: в BotFather у него выключено вступление в группы. */
        if (!allowed.has(String(m.chat.id))) {
          console.warn('[admin] чужой чат:', m.chat.id, '—', String(m.from && m.from.username || '').slice(0, 24));
          continue;
        }
        await answer(m.chat.id, m.text);
      }
    } catch (e) {
      console.error('[admin] опрос:', e.message);
      await new Promise((s) => setTimeout(s, 5000));
    }
  }
}

module.exports = { on, tell, event, stats, digest, feed, accounts, listen, setupMenu };
