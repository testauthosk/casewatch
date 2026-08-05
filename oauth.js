/* Вход через Google и Apple.

   Обычный серверный поток с кодом: браузер уходит к провайдеру, возвращается с
   одноразовым кодом, а мы меняем его на токен уже со своего сервера — секрет
   в браузер не попадает. Почту берём из id_token, который приходит прямо от
   провайдера по TLS в ответ на обмен.

   Пока переменные окружения не заданы, провайдер просто выключен: кнопка на
   странице не показывается, ручки отвечают «не настроено». */
const crypto = require('crypto');

const G_ID = () => process.env.GOOGLE_CLIENT_ID || '';
const G_SECRET = () => process.env.GOOGLE_CLIENT_SECRET || '';
const A_ID = () => process.env.APPLE_CLIENT_ID || '';

function base(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  return process.env.PUBLIC_URL || proto + '://' + req.headers.host;
}

function enabled() {
  return {
    google: !!(G_ID() && G_SECRET()),
    apple: !!(A_ID() && process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_KEY),
  };
}

/* state защищает от подмены: подписываем его и проверяем на возврате */
function makeState(secret) {
  const raw = crypto.randomBytes(12).toString('hex') + '.' + Date.now();
  const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex').slice(0, 24);
  return raw + '.' + sig;
}
function stateOk(state, secret) {
  const parts = String(state || '').split('.');
  if (parts.length !== 3) return false;
  const want = crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest('hex').slice(0, 24);
  if (want !== parts[2]) return false;
  return Date.now() - Number(parts[1]) < 15 * 60 * 1000;   // ссылка живёт 15 минут
}

function decodeIdToken(idToken) {
  const body = String(idToken || '').split('.')[1];
  if (!body) return null;
  try {
    return JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/* Apple требует, чтобы «секрет клиента» был подписанным JWT, а не строкой */
function appleSecret() {
  const header = { alg: 'ES256', kid: process.env.APPLE_KEY_ID };
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    iss: process.env.APPLE_TEAM_ID,
    iat: nowSec,
    exp: nowSec + 3600,
    aud: 'https://appleid.apple.com',
    sub: A_ID(),
  };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = b64(header) + '.' + b64(payload);
  const key = String(process.env.APPLE_KEY).replace(/\\n/g, '\n');
  const sig = crypto.createSign('SHA256').update(data).end()
    .sign({ key, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
  return data + '.' + sig;
}

function startUrl(provider, req, secret) {
  const redirect = base(req) + '/api/auth/' + provider + '/callback';
  const state = makeState(secret);
  if (provider === 'google') {
    const p = new URLSearchParams({
      client_id: G_ID(), redirect_uri: redirect, response_type: 'code',
      scope: 'openid email', state, prompt: 'select_account',
    });
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + p;
  }
  const p = new URLSearchParams({
    client_id: A_ID(), redirect_uri: redirect, response_type: 'code',
    scope: 'email', state, response_mode: 'form_post',
  });
  return 'https://appleid.apple.com/auth/authorize?' + p;
}

async function exchange(provider, code, req) {
  const redirect = base(req) + '/api/auth/' + provider + '/callback';
  const url = provider === 'google'
    ? 'https://oauth2.googleapis.com/token'
    : 'https://appleid.apple.com/auth/token';
  const body = new URLSearchParams({
    code, grant_type: 'authorization_code', redirect_uri: redirect,
    client_id: provider === 'google' ? G_ID() : A_ID(),
    client_secret: provider === 'google' ? G_SECRET() : appleSecret(),
  });
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id_token) {
    return { ok: false, error: (j && (j.error_description || j.error)) || 'token exchange failed' };
  }
  const claims = decodeIdToken(j.id_token) || {};
  const email = String(claims.email || '').toLowerCase();
  if (!email) return { ok: false, error: 'provider gave no email' };
  // Google отдаёт признак подтверждённой почты; Apple присылает только свои,
  // уже подтверждённые адреса (в том числе скрытые relay-адреса).
  const verified = provider === 'apple' ? true : claims.email_verified !== false;
  return { ok: true, email, verified };
}

module.exports = { enabled, startUrl, exchange, makeState, stateOk };
