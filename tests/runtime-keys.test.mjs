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
