const encoder = new TextEncoder();
const SESSION_COOKIE = 'admin_session';
const SESSION_SECONDS = 12 * 60 * 60;
const CAPTCHA_COOKIE = 'admin_captcha';
const CAPTCHA_SECONDS = 5 * 60;
export const ADMIN_LOGIN_MAX_FAILURES = 7;
export const ADMIN_LOGIN_LOCK_SECONDS = 10 * 60;
const ADMIN_LOGIN_WINDOW_SECONDS = 10 * 60;

function base64UrlEncode(text) {
  let binary = '';
  for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlDecode(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(normalized);
  return new TextDecoder().decode(Uint8Array.from(binary, (item) => item.charCodeAt(0)));
}

function equalText(left, right) {
  const a = encoder.encode(String(left ?? ''));
  const b = encoder.encode(String(right ?? ''));
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function cookieValue(request, name) {
  const item = (request.headers.get('cookie') ?? '').split(/;\s*/u).find((part) => part.startsWith(`${name}=`));
  return item ? item.slice(name.length + 1) : '';
}

function randomCaptcha() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((byte) => chars[byte % chars.length]).join('');
}

function normalizeCaptcha(value) {
  return String(value ?? '').trim().toUpperCase();
}

/**
 * 对验证码答案的证明。答案本身不进 cookie——之前 cookie 里放的是
 * base64 的 {"code":"6U7Y"}，谁都能在浏览器里直接读出答案，验证码等于没有。
 * 现在只存这个 HMAC，校验时用**提交上来的**答案重算再比对：
 * 拿到 cookie 也反推不出答案，只能靠提交去猜，而登录本身有失败次数限制。
 */
function captchaProof(secret, payload, code) {
  return hmac(secret, `EDGE_ADMIN_CAPTCHA
${payload}
${normalizeCaptcha(code)}`);
}

async function signedCaptcha(secret, code) {
  // 盐让同一个答案每次生成的 cookie 都不同，避免按 cookie 值反查答案。
  const payload = base64UrlEncode(JSON.stringify({
    expires_at: Date.now() + CAPTCHA_SECONDS * 1000,
    salt: crypto.randomUUID(),
  }));
  return `${payload}.${await captchaProof(secret, payload, code)}`;
}

async function verifyCaptcha(request, secret, supplied) {
  const token = cookieValue(request, CAPTCHA_COOKIE);
  const separator = token.lastIndexOf('.');
  if (!token || separator < 1) return false;
  const payload = token.slice(0, separator);
  let data;
  try { data = JSON.parse(base64UrlDecode(payload)); } catch { return false; }
  if (!(Number(data?.expires_at) > Date.now())) return false;
  // 证明同时绑定了 payload 和答案，所以改过期时间也会让它对不上，不用再单独验签。
  return equalText(token.slice(separator + 1), await captchaProof(secret, payload, supplied));
}

function captchaSvg(code) {
  const rotations = [-16, 11, -8, 15];
  const letters = [...code].map((letter, index) => `<text x="${16 + index * 24}" y="29" transform="rotate(${rotations[index]} ${16 + index * 24} 22)" fill="${['#42a5c9', '#8ea959', '#db8585', '#6d72c9'][index]}" font-size="25" font-family="monospace" font-style="italic">${letter}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="110" height="32" viewBox="0 0 110 32"><rect width="110" height="32" fill="#e0e0e0"/><path d="M0 9L110 23M5 28L103 4" stroke="#a7b0cf" stroke-width="1" opacity=".8"/>${letters}</svg>`;
}

export async function adminCaptchaResponse(env) {
  const secret = String(env.ADMIN_TOKEN ?? '');
  if (!secret) return new Response('管理员登录尚未配置', { status: 503 });
  const code = randomCaptcha();
  return new Response(captchaSvg(code), {
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store',
      'set-cookie': `${CAPTCHA_COOKIE}=${await signedCaptcha(secret, code)}; Path=/admin; Max-Age=${CAPTCHA_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
    },
  });
}

export async function isAdminSession(request, env) {
  const secret = String(env.ADMIN_TOKEN ?? '');
  const token = cookieValue(request, SESSION_COOKIE);
  if (!secret || !token) return false;
  const separator = token.lastIndexOf('.');
  if (separator < 1) return false;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!equalText(signature, await hmac(secret, payload))) return false;
  try {
    const data = JSON.parse(base64UrlDecode(payload));
    return data?.role === 'admin' && Number(data.expires_at) > Date.now();
  } catch {
    return false;
  }
}

export async function createAdminSession(env) {
  const payload = base64UrlEncode(JSON.stringify({ role: 'admin', expires_at: Date.now() + SESSION_SECONDS * 1000, nonce: crypto.randomUUID() }));
  const signature = await hmac(String(env.ADMIN_TOKEN), payload);
  return `${SESSION_COOKIE}=${payload}.${signature}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function clientAddress(request) {
  return String(
    request.headers.get('cf-connecting-ip')
    ?? request.headers.get('x-real-ip')
    ?? request.headers.get('x-forwarded-for')?.split(',', 1)[0]
    ?? 'unknown',
  ).trim() || 'unknown';
}

async function loginIdentity(request, env) {
  return hmac(String(env.ADMIN_TOKEN ?? 'unconfigured'), `admin-login:${clientAddress(request)}`);
}

async function loginLimit(env, identity) {
  return env.DB.prepare(`
    SELECT failure_count, locked_until, updated_at
    FROM admin_login_limits WHERE identity_hash = ?
  `).bind(identity).first();
}

async function clearLoginLimit(env, identity) {
  await env.DB.prepare('DELETE FROM admin_login_limits WHERE identity_hash = ?').bind(identity).run();
}

async function saveLoginFailure(env, identity, failureCount, lockedUntil, updatedAt) {
  await env.DB.prepare(`
    INSERT INTO admin_login_limits (identity_hash, failure_count, locked_until, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(identity_hash) DO UPDATE SET
      failure_count = excluded.failure_count,
      locked_until = excluded.locked_until,
      updated_at = excluded.updated_at
  `).bind(identity, failureCount, lockedUntil, updatedAt).run();
}

export async function verifyAdminLogin(request, env, nowMilliseconds = Date.now()) {
  const body = await request.text();
  const params = new URLSearchParams(body);
  const username = params.get('username') ?? '';
  const password = params.get('password') ?? '';
  const captcha = params.get('captcha') ?? '';
  const expectedUsername = String(env.ADMIN_USERNAME ?? 'admin');
  const now = Math.floor(Number(nowMilliseconds) / 1_000);
  const identity = await loginIdentity(request, env);
  const existing = await loginLimit(env, identity);
  const lockedUntil = Number(existing?.locked_until ?? 0);
  if (lockedUntil > now) {
    return { ok: false, locked: true, retryAfterSeconds: lockedUntil - now, remainingAttempts: 0 };
  }
  const verified = Boolean(env.ADMIN_TOKEN)
    && equalText(username.trim(), expectedUsername.trim())
    && equalText(password, env.ADMIN_TOKEN)
    && await verifyCaptcha(request, env.ADMIN_TOKEN, captcha);
  if (verified) {
    await clearLoginLimit(env, identity);
    return { ok: true, locked: false, retryAfterSeconds: 0, remainingAttempts: ADMIN_LOGIN_MAX_FAILURES };
  }
  const withinWindow = Number(existing?.updated_at ?? 0) > now - ADMIN_LOGIN_WINDOW_SECONDS;
  const failureCount = (withinWindow ? Number(existing?.failure_count ?? 0) : 0) + 1;
  const nextLockedUntil = failureCount >= ADMIN_LOGIN_MAX_FAILURES
    ? now + ADMIN_LOGIN_LOCK_SECONDS
    : 0;
  await saveLoginFailure(env, identity, failureCount, nextLockedUntil, now);
  return {
    ok: false,
    locked: nextLockedUntil > now,
    retryAfterSeconds: Math.max(0, nextLockedUntil - now),
    remainingAttempts: Math.max(0, ADMIN_LOGIN_MAX_FAILURES - failureCount),
  };
}

export async function verifyLoginPassword(request, env) {
  return (await verifyAdminLogin(request, env)).ok;
}

export function clearAdminSession() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
