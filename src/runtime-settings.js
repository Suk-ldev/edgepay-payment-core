const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ENCRYPTED_CACHE_MILLISECONDS = 60_000;
// 缓存挂在 globalThis 上：Makers 每个请求都会重新执行一遍模块，模块级变量每次都是新的，
// 只有 globalThis 跨请求保留（见 payment-makers/src/pg-pool.js）。放在模块里，
// Makers 上每个请求都得重新拉一遍插件配置和收款码图片，库在远端时这就是秒级的开销。
const encryptedJsonCache = (globalThis[Symbol.for('edgepay.settings.encryptedJsonCache')] ??= new Map());
// 明文配置按 env.DB 分开缓存，不同的库（测试里每个用例一个）互不串值。
const plainJsonCache = (globalThis[Symbol.for('edgepay.settings.plainJsonCache')] ??= new WeakMap());

function plainCacheOf(env) {
  const database = env.DB;
  if (!database || typeof database !== 'object') return null;
  let entries = plainJsonCache.get(database);
  if (!entries) plainJsonCache.set(database, (entries = new Map()));
  return entries;
}

function encryptedCacheKey(settingKey, secret) {
  return `${String(settingKey)}\u0000${String(secret)}`;
}

function invalidateEncryptedCache(settingKey) {
  const prefix = `${String(settingKey)}\u0000`;
  for (const key of encryptedJsonCache.keys()) {
    if (key.startsWith(prefix)) encryptedJsonCache.delete(key);
  }
}

// atob/btoa 只认"一字符一字节"的字符串，和 Uint8Array 之间必须逐字节搬。
// 这两个函数看着像样板代码，但 plugin_config 的密文有几百 KB（收款码图片就存在里面），
// 逐字节的写法在这里是致命的：`Uint8Array.from(binary, cb)` 要为每个字节调一次回调，
// 实测 560 KB 密文要 24 ms，而免费版 Worker 每请求只有 10 ms CPU——缓存一过期，
// 下一个读配置的请求就必然被砍成 Error 1102，而且它死在写回缓存之前，
// 于是后续请求接着解密、接着死。监听端看到的 503 全部出自这里。
// 预分配 + 下标循环把同样的事压到 1.3 ms。写侧同理，按块喂 String.fromCharCode，
// 与 alipay-plugin.js / poller-runtime.js 里的写法保持一致。
const BASE64_CHUNK_BYTES = 0x8000;

function toBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES));
  }
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(String(value));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function encryptionKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`payment-admin-settings:${secret}`));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSetting(value, secret, settingKey) {
  if (!secret) throw new Error('缺少管理配置加密密钥');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = encoder.encode(`runtime-setting:${settingKey}:v1`);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData },
    await encryptionKey(secret),
    encoder.encode(JSON.stringify(value)),
  );
  return JSON.stringify({ version: 1, iv: toBase64(iv), data: toBase64(new Uint8Array(ciphertext)) });
}

export async function decryptSetting(payload, secret, settingKey) {
  if (!secret) throw new Error('缺少管理配置解密密钥');
  let envelope;
  try { envelope = JSON.parse(String(payload)); } catch { throw new Error('管理配置密文格式不合法'); }
  if (envelope?.version !== 1 || !envelope.iv || !envelope.data) throw new Error('管理配置密文版本不支持');
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64(envelope.iv),
        additionalData: encoder.encode(`runtime-setting:${settingKey}:v1`),
      },
      await encryptionKey(secret),
      fromBase64(envelope.data),
    );
    return JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new Error('管理配置解密失败；请确认 CONFIG_ENCRYPTION_KEY 未被更换');
  }
}

export async function readSetting(env, settingKey) {
  const row = await env.DB.prepare(
    'SELECT value_text FROM runtime_settings WHERE setting_key = ?',
  ).bind(settingKey).first();
  return row ? String(row.value_text ?? '') : '';
}

export async function writeSetting(env, settingKey, valueText) {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO runtime_settings (setting_key, value_text, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET value_text = excluded.value_text, updated_at = excluded.updated_at
  `).bind(settingKey, String(valueText), now).run();
  invalidateEncryptedCache(settingKey);
  plainCacheOf(env)?.delete(String(settingKey));
}

export async function readEncryptedJsonSetting(env, settingKey, secret, fallback) {
  const cacheKey = encryptedCacheKey(settingKey, secret);
  const cached = encryptedJsonCache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return cached.value;
  const stored = await readSetting(env, settingKey);
  const decrypted = stored ? await decryptSetting(stored, secret, settingKey) : fallback;
  const value = decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted) ? decrypted : fallback;
  // 加密配置在一个请求周期内会被多处读取。用 setting+密钥作稳定键，避免 D1 binding
  // 代理换对象后 WeakMap 失效；写入函数会立即清掉对应项。
  encryptedJsonCache.set(cacheKey, { value, expiresAt: Date.now() + ENCRYPTED_CACHE_MILLISECONDS });
  if (encryptedJsonCache.size > 32) encryptedJsonCache.delete(encryptedJsonCache.keys().next().value);
  return value;
}

export async function writeEncryptedJsonSetting(env, settingKey, secret, value) {
  await writeSetting(env, settingKey, await encryptSetting(value, secret, settingKey));
  encryptedJsonCache.set(encryptedCacheKey(settingKey, secret), {
    value,
    expiresAt: Date.now() + ENCRYPTED_CACHE_MILLISECONDS,
  });
}

/**
 * 只在该设置还不存在时写入，返回库里最终那一份——自己写进去的，或别的请求抢先写进去的。
 *
 * 给"首次生成、之后永不改"的值用（比如 Worker 的授权设备身份）。新库刚上线时几个请求
 * 会同时发现"还没有"、各自生成；用 writeEncryptedJsonSetting 的话后写的覆盖先写的，
 * 而先写的那份可能已经被拿去用了（身份已在授权站绑定），从此两边对不上。
 */
export async function claimEncryptedJsonSetting(env, settingKey, secret, value) {
  await env.DB.prepare(`
    INSERT INTO runtime_settings (setting_key, value_text, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(setting_key) DO NOTHING
  `).bind(settingKey, await encryptSetting(value, secret, settingKey), new Date().toISOString()).run();
  // 之前读到的"不存在"还在缓存里，必须清掉再回读库里的胜出值。
  invalidateEncryptedCache(settingKey);
  return readEncryptedJsonSetting(env, settingKey, secret, null);
}

export async function readPlainJsonSetting(env, settingKey, fallback) {
  const stored = await readSetting(env, settingKey);
  if (!stored) return fallback;
  try { return JSON.parse(stored); } catch { throw new Error(`${settingKey} 运行配置不是合法 JSON`); }
}

/**
 * 带一分钟缓存的明文配置，只给"大而少变"的设置用（site_config 内联了联系人头像和二维码，
 * 一百 KB 上下，下单和收银台每次都要读）。租约、在线状态这类要求实时的设置不能走这里。
 * 返回值是共享的，调用方不能就地修改。
 */
export async function readCachedPlainJsonSetting(env, settingKey, fallback) {
  const entries = plainCacheOf(env);
  const cached = entries?.get(String(settingKey));
  if (cached?.expiresAt > Date.now()) return cached.value;
  const value = await readPlainJsonSetting(env, settingKey, fallback);
  entries?.set(String(settingKey), { value, expiresAt: Date.now() + ENCRYPTED_CACHE_MILLISECONDS });
  return value;
}

export async function writePlainJsonSetting(env, settingKey, value) {
  await writeSetting(env, settingKey, JSON.stringify(value));
}
