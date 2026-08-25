import { readEncryptedJsonSetting, writeEncryptedJsonSetting } from './runtime-settings.js';

const SETTING_KEY = 'security_keys';
const GRACE_SECONDS = 30 * 60;
const CACHE_MILLISECONDS = 15_000;
const encoder = new TextEncoder();
const storeCache = new WeakMap();

function encryptionSecret(env) {
  return String(env.CONFIG_ENCRYPTION_KEY ?? env.ADMIN_TOKEN ?? '');
}

function keyFallback(env, code) {
  if (code === 'epay') return String(env.EPAY_KEY ?? '');
  if (code === 'watcher') return String(env.WATCHER_TRANSPORT_SECRET ?? env.EPAY_KEY ?? '');
  return '';
}

function validPrevious(slot, now = Date.now()) {
  const expiresAt = Date.parse(String(slot?.previous_expires_at ?? ''));
  return String(slot?.previous ?? '').trim() && Number.isFinite(expiresAt) && expiresAt > now
    ? String(slot.previous)
    : '';
}

function normalizedSlot(value, fallback) {
  const slot = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    current: String(slot.current ?? '').trim() || fallback,
    previous: String(slot.previous ?? '').trim(),
    previous_expires_at: String(slot.previous_expires_at ?? ''),
    rotated_at: String(slot.rotated_at ?? ''),
  };
}

async function readStore(env) {
  const database = env.DB;
  if (database && typeof database === 'object') {
    const cached = storeCache.get(database);
    if (cached?.expires_at > Date.now()) return cached.value;
  }
  const value = await readEncryptedJsonSetting(env, SETTING_KEY, encryptionSecret(env), {});
  if (database && typeof database === 'object') {
    storeCache.set(database, { value, expires_at: Date.now() + CACHE_MILLISECONDS });
  }
  return value;
}

function cacheStore(env, value) {
  const database = env.DB;
  if (database && typeof database === 'object') {
    storeCache.set(database, { value, expires_at: Date.now() + CACHE_MILLISECONDS });
  }
}

function randomKey(code) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  if (code === 'epay') {
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

async function fingerprint(value) {
  if (!value) return '';
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)]
    .slice(0, 6)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function runtimeKeyState(env) {
  const stored = await readStore(env);
  const epay = normalizedSlot(stored.epay, keyFallback(env, 'epay'));
  const watcher = normalizedSlot(stored.watcher, keyFallback(env, 'watcher'));
  return {
    epay,
    watcher,
    effective: {
      epay_key: epay.current,
      epay_previous_key: validPrevious(epay),
      watcher_key: watcher.current,
      watcher_previous_key: validPrevious(watcher),
    },
  };
}

export async function withRuntimeKeys(env) {
  const { effective } = await runtimeKeyState(env);
  return {
    ...env,
    EPAY_KEY: effective.epay_key,
    EPAY_PREVIOUS_KEY: effective.epay_previous_key,
    WATCHER_TRANSPORT_SECRET: effective.watcher_key,
    WATCHER_PREVIOUS_TRANSPORT_SECRET: effective.watcher_previous_key,
  };
}

export async function publicKeyStatus(env) {
  const state = await runtimeKeyState(env);
  return {
    epay: {
      configured: Boolean(state.epay.current),
      fingerprint: await fingerprint(state.epay.current),
      rotated_at: state.epay.rotated_at,
      previous_valid_until: validPrevious(state.epay) ? state.epay.previous_expires_at : '',
    },
    watcher: {
      configured: Boolean(state.watcher.current),
      fingerprint: await fingerprint(state.watcher.current),
      rotated_at: state.watcher.rotated_at,
      previous_valid_until: validPrevious(state.watcher) ? state.watcher.previous_expires_at : '',
    },
  };
}

export async function rotateRuntimeKey(env, code) {
  if (!['epay', 'watcher'].includes(code)) throw new Error('不支持的密钥类型');
  const stored = await readStore(env);
  const current = normalizedSlot(stored[code], keyFallback(env, code));
  if (!current.current) throw new Error('当前密钥尚未配置，不能轮换');
  const now = new Date();
  const nextValue = randomKey(code);
  const nextSlot = {
    current: nextValue,
    previous: current.current,
    previous_expires_at: new Date(now.getTime() + (GRACE_SECONDS * 1_000)).toISOString(),
    rotated_at: now.toISOString(),
  };
  const nextStore = { ...stored, version: 1, [code]: nextSlot };
  await writeEncryptedJsonSetting(env, SETTING_KEY, encryptionSecret(env), nextStore);
  cacheStore(env, nextStore);
  return {
    code,
    value: nextValue,
    previous_valid_until: nextSlot.previous_expires_at,
    fingerprint: await fingerprint(nextValue),
  };
}

export async function revokePreviousRuntimeKey(env, code) {
  if (!['epay', 'watcher'].includes(code)) throw new Error('不支持的密钥类型');
  const stored = await readStore(env);
  const current = normalizedSlot(stored[code], keyFallback(env, code));
  const nextStore = {
    ...stored,
    version: 1,
    [code]: { ...current, previous: '', previous_expires_at: '' },
  };
  await writeEncryptedJsonSetting(env, SETTING_KEY, encryptionSecret(env), nextStore);
  cacheStore(env, nextStore);
}
