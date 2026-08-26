import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import {
  publicKeyStatus, revokePreviousRuntimeKey, rotateRuntimeKey, runtimeKeyState,
} from '../src/runtime-keys.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

class Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    if (!this.sql.includes('SELECT value_text FROM runtime_settings')) return null;
    const value = this.database.settings.get(String(this.values[0]));
    return value === undefined ? null : { value_text: value };
  }

  async run() {
    if (this.sql.includes('INSERT INTO runtime_settings')) {
      this.database.settings.set(String(this.values[0]), String(this.values[1]));
    }
    return { success: true };
  }
}

class Database {
  constructor() {
    this.settings = new Map();
  }

  prepare(sql) {
    return new Statement(this, sql);
  }
}

test('运行时密钥可轮换、短时兼容旧值并支持主动撤销', async () => {
  const env = {
    DB: new Database(),
    CONFIG_ENCRYPTION_KEY: 'settings-encryption-test',
    EPAY_KEY: 'legacy-epay-key',
    WATCHER_TRANSPORT_SECRET: 'legacy-watcher-key',
  };

  const before = await publicKeyStatus(env);
  assert.equal(before.epay.configured, true);
  assert.equal(before.epay.fingerprint.length, 12);
  assert.equal('value' in before.epay, false);

  const rotated = await rotateRuntimeKey(env, 'epay');
  assert.equal(rotated.value.length, 64);
  assert.notEqual(rotated.value, env.EPAY_KEY);

  const state = await runtimeKeyState(env);
  assert.equal(state.effective.epay_key, rotated.value);
  assert.equal(state.effective.epay_previous_key, env.EPAY_KEY);

  await revokePreviousRuntimeKey(env, 'epay');
  const revoked = await runtimeKeyState(env);
  assert.equal(revoked.effective.epay_previous_key, '');
});

test('轮询触发 Token 也能在密钥管理里轮换，兼容期内新旧都认', async () => {
  // 后台文档一直写着"泄露后到上方密钥管理轮换轮询 Token"，但这里以前只认
  // epay 和 watcher 两种，点了就报"不支持的密钥类型"。
  const { withRuntimeKeys } = await import('../src/runtime-keys.js');
  const env = { DB: new Database(), CONFIG_ENCRYPTION_KEY: 'config-key', POLL_TRIGGER_TOKEN: 'original-poll-token' };

  const before = await runtimeKeyState(env);
  assert.equal(before.poll.current, 'original-poll-token', '没轮换过就用 Worker Secret 里的值');
  assert.equal((await publicKeyStatus(env)).poll.configured, true);

  const rotated = await rotateRuntimeKey(env, 'poll');
  assert.equal(rotated.code, 'poll');
  assert.notEqual(rotated.value, 'original-poll-token');
  // Token 要出现在 URL 查询串里，不能带需要转义的字符。
  assert.match(rotated.value, /^[A-Za-z0-9_-]+$/u);

  const effective = await withRuntimeKeys(env);
  assert.equal(effective.POLL_TRIGGER_TOKEN, rotated.value, '轮换后到处都用新 Token');
  assert.equal(effective.POLL_PREVIOUS_TRIGGER_TOKEN, 'original-poll-token', '兼容期内旧 Token 仍要放行');

  await revokePreviousRuntimeKey(env, 'poll');
  const revoked = await withRuntimeKeys(env);
  assert.equal(revoked.POLL_TRIGGER_TOKEN, rotated.value);
  assert.equal(revoked.POLL_PREVIOUS_TRIGGER_TOKEN, '', '撤销后旧 Token 立刻失效');
});

test('不认识的密钥类型仍旧拒绝', async () => {
  const env = { DB: new Database(), CONFIG_ENCRYPTION_KEY: 'config-key', EPAY_KEY: 'k' };
  await assert.rejects(rotateRuntimeKey(env, 'whatever'), /不支持的密钥类型/u);
  await assert.rejects(revokePreviousRuntimeKey(env, 'whatever'), /不支持的密钥类型/u);
});
