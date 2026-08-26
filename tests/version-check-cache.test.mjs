/**
 * 后台版本检查的缓存合同。
 *
 * 原来每打开一次后台都要现查一遍 GitHub（失败再退到部署站），两次外网请求串行，
 * 插件页一直等着它转。发行版本一天也变不了几次，没必要每次都问。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { createTestWorker } = await import('./helpers/worker.mjs');
const { createAdminSession } = await import('../src/admin-auth.js');

const worker = createTestWorker();
const ADMIN_TOKEN = 'admin-token-for-version-cache';

function memoryDb(settings = new Map()) {
  return {
    settings,
    prepare(sql) {
      return {
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          if (!sql.includes('runtime_settings')) return null;
          const value = settings.get(String(this.values[0]));
          return value === undefined ? null : { value_text: value };
        },
        async all() { return { results: [] }; },
        async run() {
          if (sql.includes('INTO runtime_settings')) settings.set(String(this.values[0]), String(this.values[1]));
          return { meta: { changes: 0 } };
        },
      };
    },
  };
}

/** 记录外网请求次数的 fetch 替身。 */
function countingFetch(version, { fail = false } = {}) {
  const state = { calls: 0 };
  const impl = async () => {
    state.calls += 1;
    if (fail) throw new Error('网络不可达');
    return new Response(JSON.stringify({ version, edition: 'public-commercial-encrypted' }), { status: 200 });
  };
  return { state, impl };
}

async function callVersionApi(env) {
  const cookie = (await createAdminSession(env)).split(';', 1)[0];
  const response = await worker.fetch(
    new Request('https://pay.example/admin/api/version', { headers: { cookie } }),
    env,
    { waitUntil() {} },
  );
  return response.json();
}

function fixture(settings) {
  return {
    DB: memoryDb(settings),
    ADMIN_TOKEN,
    CONFIG_ENCRYPTION_KEY: 'config-key',
    EDGEPAY_PROJECT_NAME: 'edgepay',
  };
}

test('版本检查结果会缓存，连续打开后台不会反复打外网', async () => {
  const settings = new Map();
  const env = fixture(settings);
  const { state, impl } = countingFetch('9.9.9');
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    const first = await callVersionApi(env);
    assert.equal(first.ok, true);
    assert.equal(first.latest_version, '9.9.9');
    assert.equal(first.update_available, true);
    assert.equal(state.calls, 1);

    for (let index = 0; index < 5; index++) await callVersionApi(env);
    assert.equal(state.calls, 1, '缓存期内再怎么开后台都不该重新查');
  } finally {
    globalThis.fetch = original;
  }

  const cached = JSON.parse(settings.get('release_check'));
  assert.equal(cached.version, '9.9.9');
  assert.ok(Date.parse(cached.checked_at), 'checked_at 必须是可解析的时间戳');
});

test('缓存过期后重新查，拿到的是新版本号', async () => {
  const settings = new Map([['release_check', JSON.stringify({
    version: '1.0.0',
    checked_at: new Date(Date.now() - (7 * 60 * 60 * 1000)).toISOString(),
  })]]);
  const env = fixture(settings);
  const { state, impl } = countingFetch('2.5.0');
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    assert.equal((await callVersionApi(env)).latest_version, '2.5.0');
    assert.equal(state.calls, 1);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(JSON.parse(settings.get('release_check')).version, '2.5.0');
});

test('查不到时继续用上一次的结果，一次网络抖动不该把升级提示弄没', async () => {
  const settings = new Map([['release_check', JSON.stringify({
    version: '3.1.4',
    checked_at: new Date(Date.now() - (7 * 60 * 60 * 1000)).toISOString(),
  })]]);
  const env = fixture(settings);
  const { state, impl } = countingFetch('', { fail: true });
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    const payload = await callVersionApi(env);
    assert.equal(payload.ok, true);
    assert.equal(payload.latest_version, '3.1.4');
    assert.ok(state.calls > 0, '过期了还是要试一次');
  } finally {
    globalThis.fetch = original;
  }
});

test('没有登录态时不做任何版本查询', async () => {
  const { state, impl } = countingFetch('9.9.9');
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    const response = await worker.fetch(
      new Request('https://pay.example/admin/api/version'),
      fixture(new Map()),
      { waitUntil() {} },
    );
    assert.equal(response.status, 401);
    assert.equal(state.calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});
