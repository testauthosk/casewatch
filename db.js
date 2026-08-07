/* База CaseCheck.

   Одна база на веб и бота: у человека может быть и почта, и телеграм, и дела
   в обоих местах — таблицы это учитывают заранее, чтобы потом не мигрировать.
   Файл лежит на диске Railway (DATA_DIR), поэтому переживает выкатки. */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DIR, { recursive: true });
// имя файла оставлено прежним: на диске Railway лежат живые данные,
// переименование файла означало бы пустую базу
const db = new DatabaseSync(path.join(DIR, 'casewatch.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT UNIQUE,
  pass_hash    TEXT,                    -- scrypt: соль:хэш
  email_ok     INTEGER NOT NULL DEFAULT 0,
  tg_id        INTEGER UNIQUE,          -- связка с ботом
  tg_username  TEXT,
  wa_phone     TEXT,
  sms_phone    TEXT,
  lang         TEXT NOT NULL DEFAULT 'en',
  plan         TEXT NOT NULL DEFAULT 'free',
  plan_until   INTEGER,
  sms_addon    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_seen    INTEGER
);

CREATE TABLE IF NOT EXISTS codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  code       TEXT NOT NULL,
  purpose    TEXT NOT NULL,             -- signup | login
  expires_at INTEGER NOT NULL,
  tries      INTEGER NOT NULL DEFAULT 0,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_codes_email ON codes(email, purpose);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ua         TEXT
);

CREATE TABLE IF NOT EXISTS cases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  a_number    TEXT NOT NULL,
  country     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | found | not_found | error
  name        TEXT,
  court       TEXT,
  hearing_at  TEXT,
  decision    TEXT,
  sig         TEXT,                              -- отпечаток ответа, по нему ловим изменения
  monitoring  INTEGER NOT NULL DEFAULT 1,
  checked_at  INTEGER,
  created_at  INTEGER NOT NULL,
  UNIQUE(user_id, a_number)
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_id    INTEGER REFERENCES cases(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,             -- hearing | decision | appeared | added | note
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL,               -- email | telegram | whatsapp | sms
  enabled  INTEGER NOT NULL DEFAULT 1,
  address  TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, kind)
);

CREATE TABLE IF NOT EXISTS prefs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hearing  INTEGER NOT NULL DEFAULT 1,
  decision INTEGER NOT NULL DEFAULT 1,
  appeared INTEGER NOT NULL DEFAULT 1,
  weekly   INTEGER NOT NULL DEFAULT 0
);

/* Внешние входы. Ключ — не почта, а постоянный идентификатор от провайдера:
   Google прямо просит опираться на sub, потому что почту человек меняет, а
   Apple почту присылает ТОЛЬКО при первом разрешении и потом не отдаёт вовсе.
   Отсюда: sub в ключе, почта сохраняется один раз, скрытый relay-адрес
   помечаем отдельно — на него нельзя писать без настройки домена у Apple. */
CREATE TABLE IF NOT EXISTS identities (
  provider      TEXT NOT NULL,             -- google | apple
  subject       TEXT NOT NULL,             -- sub из id_token, у Apple он свой на команду
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email         TEXT,                      -- каким пришёл при первом входе
  private_email INTEGER NOT NULL DEFAULT 0,-- Apple Hide My Email
  name          TEXT,                      -- Apple отдаёт имя тоже только один раз
  created_at    INTEGER NOT NULL,
  last_login    INTEGER,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);

CREATE TABLE IF NOT EXISTS support (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email      TEXT NOT NULL,
  topic      TEXT,
  text       TEXT NOT NULL,
  delivered  INTEGER NOT NULL DEFAULT 0,     -- дошло ли до нас телеграмом/почтой
  created_at INTEGER NOT NULL
);

/* Одноразовые коды привязки телеграма: человек жмёт «Connect» на сайте,
   уходит в бота по ссылке с кодом, бот отдаёт код нам вместе со своим id. */
CREATE TABLE IF NOT EXISTS link_codes (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'telegram',   -- telegram | whatsapp
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  amount     REAL NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'USD',
  plan       TEXT NOT NULL,              -- month | year
  source     TEXT NOT NULL,              -- stripe
  ref        TEXT,                       -- id подписки или сессии, по нему ловим продления
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_ref ON payments(ref);

/* Отметки «это письмо мы уже слали»: расписание крутится каждую минуту, и без
   них человек получил бы напоминание об окончании подписки шестьдесят раз. */
CREATE TABLE IF NOT EXISTS marks (
  user_id INTEGER NOT NULL,          -- 0 = отметка самого сервиса, не человека
  kind    TEXT NOT NULL,
  mark    TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, mark)
);

CREATE TABLE IF NOT EXISTS mail_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
`);

// таблица могла появиться до колонки kind — добавляем на месте, без миграций
try { db.exec("ALTER TABLE link_codes ADD COLUMN kind TEXT NOT NULL DEFAULT 'telegram'"); }
catch (e) { /* колонка уже есть */ }

/* Дела заводились, когда страна была просто текстом. ACIS же принимает свой
   код гражданства, без него дело не найдётся — колонку добавляем на месте.
   fail_count держит подряд неудачные проверки: по нему воркер отступает. */
for (const sql of [
  'ALTER TABLE cases ADD COLUMN nat_code TEXT',
  'ALTER TABLE cases ADD COLUMN judge TEXT',
  'ALTER TABLE cases ADD COLUMN rendered TEXT',
  'ALTER TABLE cases ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE cases ADD COLUMN next_check_at INTEGER',
  'ALTER TABLE cases ADD COLUMN queued INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE payments ADD COLUMN invoice TEXT',
  'ALTER TABLE payments ADD COLUMN mailed INTEGER NOT NULL DEFAULT 0',
]) { try { db.exec(sql); } catch (e) { /* колонка уже есть */ } }

const now = () => Math.floor(Date.now() / 1000);

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  createUser: db.prepare(
    'INSERT INTO users (email, pass_hash, created_at) VALUES (?, ?, ?)'),
  setPass: db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?'),
  markVerified: db.prepare('UPDATE users SET email_ok = 1 WHERE id = ?'),
  touch: db.prepare('UPDATE users SET last_seen = ? WHERE id = ?'),

  addCode: db.prepare(
    'INSERT INTO codes (email, code, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'),
  liveCode: db.prepare(
    `SELECT * FROM codes WHERE email = ? AND purpose = ? AND used = 0 AND expires_at > ?
     ORDER BY id DESC LIMIT 1`),
  bumpTries: db.prepare('UPDATE codes SET tries = tries + 1 WHERE id = ?'),
  useCode: db.prepare('UPDATE codes SET used = 1 WHERE id = ?'),
  recentCodes: db.prepare(
    'SELECT COUNT(*) AS n FROM codes WHERE email = ? AND created_at > ?'),

  addSession: db.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at, ua) VALUES (?, ?, ?, ?, ?)'),
  session: db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?'),
  dropSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  dropOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?'),

  cases: db.prepare('SELECT * FROM cases WHERE user_id = ? ORDER BY created_at DESC'),
  caseByNumber: db.prepare('SELECT * FROM cases WHERE user_id = ? AND a_number = ?'),
  addCase: db.prepare(
    'INSERT INTO cases (user_id, a_number, country, nat_code, created_at) VALUES (?, ?, ?, ?, ?)'),

  /* Очередь воркера: дело созрело, если время подошло, а у хозяина есть на что
     смотреть — платный план либо самая первая, бесплатная проверка. Свежие
     заводки идут вперёд: человек только что добавил дело и ждёт ответа. */
  dueCases: db.prepare(
    `SELECT c.id, c.a_number, c.country, c.nat_code, c.sig, c.status, c.checked_at, u.plan, u.plan_until
       FROM cases c JOIN users u ON u.id = c.user_id
      WHERE c.nat_code IS NOT NULL
        AND (c.next_check_at IS NULL OR c.next_check_at <= ?)
        AND (c.queued = 1                                        -- человек попросил проверить
             OR (c.monitoring = 1 AND u.plan <> 'free' AND u.plan_until > ?))
      ORDER BY c.queued DESC, c.checked_at IS NULL DESC, c.next_check_at IS NULL DESC, c.next_check_at
      LIMIT ?`),
  queueCase: db.prepare('UPDATE cases SET queued = 1, next_check_at = NULL WHERE id = ? AND user_id = ?'),
  unqueueCase: db.prepare('UPDATE cases SET queued = 0 WHERE id = ?'),
  usedMark: db.prepare('SELECT at FROM marks WHERE user_id = ? AND kind = ? AND mark = ?'),
  caseRow: db.prepare('SELECT * FROM cases WHERE id = ?'),
  setCaseResult: db.prepare(
    `UPDATE cases SET status = ?, name = COALESCE(?, name), court = ?, hearing_at = ?,
       decision = ?, judge = ?, sig = ?, rendered = ?, checked_at = ?, next_check_at = ?,
       fail_count = 0 WHERE id = ?`),
  // бронь: взятое в работу не должно попасть в очередь второй раз
  leaseCase: db.prepare('UPDATE cases SET next_check_at = ? WHERE id = ?'),
  setCaseFail: db.prepare(
    'UPDATE cases SET fail_count = fail_count + 1, next_check_at = ? WHERE id = ?'),
  setMonitoring: db.prepare('UPDATE cases SET monitoring = ? WHERE id = ? AND user_id = ?'),
  countCases: db.prepare('SELECT COUNT(*) AS n FROM cases WHERE user_id = ?'),
  caseById: db.prepare('SELECT * FROM cases WHERE id = ? AND user_id = ?'),
  caseEvents: db.prepare('SELECT * FROM events WHERE case_id = ? ORDER BY created_at DESC, id DESC LIMIT 30'),
  dropCase: db.prepare('DELETE FROM cases WHERE id = ? AND user_id = ?'),

  addEvent: db.prepare(
    'INSERT INTO events (user_id, case_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?)'),
  events: db.prepare('SELECT * FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 20'),

  channels: db.prepare('SELECT * FROM channels WHERE user_id = ?'),
  upsertChannel: db.prepare(
    `INSERT INTO channels (user_id, kind, enabled, address, verified) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, kind) DO UPDATE SET enabled = excluded.enabled,
       address = COALESCE(excluded.address, channels.address),
       verified = MAX(channels.verified, excluded.verified)`),

  prefs: db.prepare('SELECT * FROM prefs WHERE user_id = ?'),
  initPrefs: db.prepare('INSERT OR IGNORE INTO prefs (user_id) VALUES (?)'),
  setPrefs: db.prepare(
    'UPDATE prefs SET hearing = ?, decision = ?, appeared = ?, weekly = ? WHERE user_id = ?'),

  identity: db.prepare('SELECT * FROM identities WHERE provider = ? AND subject = ?'),
  linkIdentity: db.prepare(
    `INSERT INTO identities (provider, subject, user_id, email, private_email, name, created_at, last_login)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, subject) DO UPDATE SET last_login = excluded.last_login,
       email = COALESCE(identities.email, excluded.email),
       name = COALESCE(identities.name, excluded.name)`),
  touchIdentity: db.prepare(
    'UPDATE identities SET last_login = ? WHERE provider = ? AND subject = ?'),
  identitiesOf: db.prepare(
    'SELECT provider, email, private_email, created_at FROM identities WHERE user_id = ?'),

  addTicket: db.prepare(
    'INSERT INTO support (user_id, email, topic, text, delivered, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  markTicket: db.prepare('UPDATE support SET delivered = 1 WHERE id = ?'),
  myTickets: db.prepare(
    'SELECT id, topic, text, delivered, created_at FROM support WHERE user_id = ? ORDER BY id DESC LIMIT 10'),
  recentTickets: db.prepare(
    'SELECT COUNT(*) AS n FROM support WHERE user_id = ? AND created_at > ?'),

  addLink: db.prepare(
    'INSERT INTO link_codes (token, user_id, kind, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'),
  liveLink: db.prepare(
    'SELECT * FROM link_codes WHERE token = ? AND kind = ? AND used = 0 AND expires_at > ?'),
  useLink: db.prepare('UPDATE link_codes SET used = 1 WHERE token = ?'),
  setTelegram: db.prepare('UPDATE users SET tg_id = ?, tg_username = ? WHERE id = ?'),
  clearTelegram: db.prepare('UPDATE users SET tg_id = NULL, tg_username = NULL WHERE id = ?'),
  userByTg: db.prepare('SELECT * FROM users WHERE tg_id = ?'),
  setWhatsapp: db.prepare('UPDATE users SET wa_phone = ? WHERE id = ?'),
  userByWa: db.prepare('SELECT * FROM users WHERE wa_phone = ?'),

  setPlan: db.prepare('UPDATE users SET plan = ?, plan_until = ? WHERE id = ?'),
  addPayment: db.prepare(
    'INSERT INTO payments (user_id, amount, currency, plan, source, ref, invoice, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  payments: db.prepare(
    'SELECT amount, currency, plan, invoice, created_at FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 12'),
  // ссылка на инвойс приходит отдельным событием, позже самой оплаты
  setInvoice: db.prepare(
    'UPDATE payments SET invoice = ? WHERE id = (SELECT id FROM payments WHERE ref = ? ORDER BY id DESC LIMIT 1)'),
  markMailed: db.prepare('UPDATE payments SET mailed = 1 WHERE id = ?'),
  /* Письмо об оплате ждёт счёт: он приходит отдельным событием секундами позже.
     Если счёт так и не пришёл — отправляем без него, но не молчим. */
  unmailedPayments: db.prepare(
    'SELECT * FROM payments WHERE mailed = 0 AND created_at < ? ORDER BY id LIMIT 20'),
  // тот же платёж Stripe присылает дважды (сессия и счёт) — второй раз не начисляем
  paidRecently: db.prepare(
    'SELECT * FROM payments WHERE ref = ? AND created_at > ? ORDER BY id DESC LIMIT 1'),
  userByPaymentRef: db.prepare(
    'SELECT user_id FROM payments WHERE ref = ? AND user_id IS NOT NULL ORDER BY id DESC LIMIT 1'),

  // INSERT OR IGNORE: changes = 1 значит отметки ещё не было и письмо нужно слать
  addMark: db.prepare('INSERT OR IGNORE INTO marks (user_id, kind, mark, at) VALUES (?, ?, ?, ?)'),
  expiringSoon: db.prepare(
    "SELECT * FROM users WHERE plan <> 'free' AND plan_until BETWEEN ? AND ? AND email IS NOT NULL"),
  weeklyWanted: db.prepare(
    `SELECT u.* FROM users u JOIN prefs p ON p.user_id = u.id
      WHERE p.weekly = 1 AND u.email_ok = 1 AND u.email IS NOT NULL`),

  logMail: db.prepare(
    'INSERT INTO mail_log (email, kind, ok, detail, created_at) VALUES (?, ?, ?, ?, ?)'),
};

module.exports = { db, q, now };
