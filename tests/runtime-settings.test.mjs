import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { decryptSetting, encryptSetting } from '../src/runtime-settings.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

test('后台插件配置使用独立配置密钥派生 AES-GCM 密钥并可完整恢复', async () => {
  const config = {
    fubei_receipt: { watcher_username: 'account', watcher_password: 'secret-password' },
    usdt_trc20_receipt: { usdt_cny_rate: '7.000000' },
  };
  const encrypted = await encryptSetting(config, 'admin-token-for-test', 'plugin_config');
  assert.equal(encrypted.includes('secret-password'), false);
  assert.deepEqual(
    await decryptSetting(encrypted, 'admin-token-for-test', 'plugin_config'),
    config,
  );
});

test('后台插件配置密文不能被不同配置密钥或不同设置键解密', async () => {
  const encrypted = await encryptSetting({ ok: true }, 'correct-token', 'plugin_config');
  await assert.rejects(
    decryptSetting(encrypted, 'wrong-token', 'plugin_config'),
    /解密失败/u,
  );
  await assert.rejects(
    decryptSetting(encrypted, 'correct-token', 'channels'),
    /解密失败/u,
  );
});
