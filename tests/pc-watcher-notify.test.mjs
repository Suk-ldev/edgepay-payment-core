/**
 * PC 监听器走 SmsForwarder 通道的心跳与收款通知。
 *
 * PC 端不做 Docker 轮询、不走 v1 签名，只复用 SmsForwarder v2 入口：
 * 心跳（msg=连通性探测 + watcher_kind=pc）刷 presence，真实收款通知确认订单。
 * 这里用最小内存 D1 驱动整条路由，验证 Worker 侧对 PC 类型的接纳。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { createTestWorker } = await import('./helpers/worker.mjs');
const { encryptSetting } = await import('../src/runtime-settings.js');
const { hmacSha256Base64, smsForwarderSignContent } = await import('../src/receipt-plugins.js');

const NOTIFY_PATH = '/api/pay/1/notify';

/** 只实现 runtime_settings 上心跳链路用到的语句。 */
class MemoryStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql.replace(/\s+/gu, ' ').trim();
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    if (this.sql.includes('FROM runtime_settings')) {
      const value = this.database.settings.get(String(this.values[0]));
      return value === undefined ? null : { value_text: value };
    }
    return null;
  }

  async all() {
    // presence 读取：键前缀过滤，直接把 LIKE 的第一个绑定参数去掉 % 用。
    if (this.sql.includes('setting_key LIKE ?')) {
      const prefix = String(this.values[0]).replace(/%/gu, '');
      const results = [...this.database.settings.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, row]) => ({ setting_key: key, ...row }));
      return { results };
    }
    if (this.sql.includes("setting_key = 'watcher_presence'")) {
      return { results: [] };
    }
    return { results: [] };
  }

  async run() {
    if (this.sql.includes('INSERT INTO runtime_settings')) {
      const [key, value, updatedAt, throttleBefore, sameValue] = this.values.map(String);
      const existing = this.database.settings.get(key);
      // 节流条件与真实 SQL 的 WHERE 一致：内容变了，或者上次写入已经够久。
      if (!existing || existing.value_text !== sameValue || existing.updated_at <= throttleBefore) {
        this.database.settings.set(key, { value_text: value, updated_at: updatedAt });
      }
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes('DELETE FROM runtime_settings')) {
      const prefix = String(this.values[0]).replace(/%/gu, '');
      const before = String(this.values[1]);
      for (const [key, row] of [...this.database.settings.entries()]) {
        if (key.startsWith(prefix) && row.updated_at < before) this.database.settings.delete(key);
      }
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
}

class MemoryDatabase {
  constructor(settings = new Map()) {
    this.settings = settings;
    this.payments = [];
  }

  prepare(sql) {
    return new MemoryStatement(this, sql);
  }
}

const secret = 'pc-watch-secret';
const configKey = 'pc-watcher-config-key';

async function buildEnv() {
  const settings = new Map([
    ['channels', JSON.stringify([{
      id: 1,
      name: '微信个人收款',
      plugin_code: 'wxpay_receipt',
      pay_types: ['wxpay'],
      weight: 100,
      enabled: true,
    }])],
    ['plugin_config', await encryptSetting({
      wxpay_receipt: {
        sms_forwarder_secret: secret,
        receipt_match_mode: 'amount',
      },
    }, configKey, 'plugin_config')],
  ]);
  return {
    ADMIN_TOKEN: 'pc-watcher-admin-token',
    ADMIN_USERNAME: 'admin',
    EPAY_PID: '1000',
    EPAY_KEY: 'test-epay-key',
    CONFIG_ENCRYPTION_KEY: configKey,
    DB: new MemoryDatabase(settings),
  };
}

/** 组一个已签名的 SmsForwarder v2 心跳/通知 POST。 */
async function signedNotify(env, content, path = NOTIFY_PATH) {
  const timestamp = String(Date.now());
  const input = {
    timestamp,
    from: 'com.tencent.mm',
    content: JSON.stringify(content),
  };
  const sign = `v2=${await hmacSha256Base64(secret, await smsForwarderSignContent({
    timestamp: input.timestamp,
    method: 'POST',
    path,
    from: input.from,
    content: input.content,
  }))}`;
  const body = new URLSearchParams({ ...input, sign }).toString();
  const request = new Request(`https://pay.example${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(body.length),
    },
    body,
  });
  return request;
}

test('PC 心跳刷出 kind=pc 的按通道 presence', async () => {
  const worker = createTestWorker();
  const env = await buildEnv();

  const response = await worker.fetch(await signedNotify(env, {
    title: '微信收款助手',
    msg: '连通性探测',
    watcher_kind: 'pc',
    watcher_instance: 'pcwatcher-1a2b3c',
  }), env, { waitUntil() {} });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.status, 'ready');

  const row = [...env.DB.settings.entries()]
    .find(([key]) => key === 'watcher_presence:id:pc-1-pcwatcher-1a2b3c');
  assert.ok(row, 'PC 心跳应按 自报实例 写一行 presence');
  const presence = JSON.parse(row[1].value_text);
  assert.equal(presence.kind, 'pc');
  assert.deepEqual(presence.channel_ids, [1]);
  assert.deepEqual(presence.plugins, ['wxpay_receipt']);
  assert.equal(presence.polling, false);
});

test('坏格式实例 ID 的 PC 心跳不写 presence，但心跳本身仍然成功', async () => {
  const worker = createTestWorker();
  const env = await buildEnv();

  const response = await worker.fetch(await signedNotify(env, {
    title: '微信收款助手',
    msg: '连通性探测',
    watcher_kind: 'pc',
    watcher_instance: 'not a valid id!',
  }), env, { waitUntil() {} });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.status, 'ready');
  assert.equal(
    [...env.DB.settings.keys()].some((key) => key.startsWith('watcher_presence:')),
    false,
  );
});

test('管理员通道数据里 PC presence 按 PC 文案的数据结构返回', async () => {
  const worker = createTestWorker();
  const env = await buildEnv();
  await worker.fetch(await signedNotify(env, {
    title: '微信收款助手',
    msg: '连通性探测',
    watcher_kind: 'pc',
    watcher_instance: 'pcwatcher-1a2b3c',
  }), env, { waitUntil() {} });

  const { createAdminSession } = await import('../src/admin-auth.js');
  const cookie = (await createAdminSession(env)).split(';', 1)[0];
  const response = await worker.fetch(new Request('https://pay.example/admin/api/channels', {
    headers: { cookie },
  }), env, { waitUntil() {} });
  const payload = await response.json();

  assert.equal(response.status, 200);
  const channel = payload.results.find(({ id }) => id === 1);
  assert.ok(channel?.listener_presence, 'sms_forwarder 通道应带 listener_presence');
  assert.equal(channel.listener_presence.status, 'online');
  assert.equal(channel.listener_presence.kind, 'pc');
});
