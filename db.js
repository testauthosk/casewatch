/* База CaseWatch.

   Одна база на веб и бота: у человека может быть и почта, и телеграм, и дела
   в обоих местах — таблицы это учитывают заранее, чтобы потом не мигрировать.
   Файл лежит на диске Railway (DATA_DIR), поэтому переживает выкатки. */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DIR, { recursive: true });
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

CREATE TABLE IF NOT EXISTS mail_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
`);

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

  cases: db.prepare('SELECT * FROM cases WHERE user_id = ? ORDER BY created_at DESC'),
  caseByNumber: db.prepare('SELECT * FROM cases WHERE user_id = ? AND a_number = ?'),
  addCase: db.prepare(
    'INSERT INTO cases (user_id, a_number, country, created_at) VALUES (?, ?, ?, ?)'),
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

  logMail: db.prepare(
    'INSERT INTO mail_log (email, kind, ok, detail, created_at) VALUES (?, ?, ?, ?, ?)'),
};

module.exports = { db, q, now };
