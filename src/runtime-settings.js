const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(String(value));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
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
}

export async function readEncryptedJsonSetting(env, settingKey, secret, fallback) {
  const stored = await readSetting(env, settingKey);
  if (!stored) return fallback;
  const value = await decryptSetting(stored, secret, settingKey);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

export async function writeEncryptedJsonSetting(env, settingKey, secret, value) {
  await writeSetting(env, settingKey, await encryptSetting(value, secret, settingKey));
}

export async function readPlainJsonSetting(env, settingKey, fallback) {
  const stored = await readSetting(env, settingKey);
  if (!stored) return fallback;
  try { return JSON.parse(stored); } catch { throw new Error(`${settingKey} 运行配置不是合法 JSON`); }
}

export async function writePlainJsonSetting(env, settingKey, value) {
  await writeSetting(env, settingKey, JSON.stringify(value));
}
