import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  YYB_LOGOUT_TTL_MS, YYB_QR_FRESH_MS, claimYybLogout, recordYybLoginState, requestYybLogout,
  sanitizeYybLoginReport, yybLoginStatus,
} from '../src/yyb-login.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const QR = 'https://open.weixin.qq.com/connect/qrcode/0a1B2c3D4e5F6g7H';

/** 真 SQLite 上的最小 D1 外形：语句原样执行，SQL 写错了这里就会炸。 */
function sqliteEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE runtime_settings (setting_key TEXT PRIMARY KEY, value_text TEXT NOT NULL, updated_at TEXT NOT NULL)');
  return {
    db,
    DB: {
      prepare(sql) {
        const statement = db.prepare(sql);
        let values = [];
        return {
          bind(...next) { values = next; return this; },
          async first() { return statement.get(...values) ?? null; },
          async run() { return { meta: { changes: Number(statement.run(...values).changes) } }; },
        };
      },
    },
  };
}

function report(overrides = {}) {
  return sanitizeYybLoginReport({
    instance_id: 'yyb-bridge-1', state: 'alive', logged_in: true, nickname: 'Suk', qr_url: '', ...overrides,
  });
}

test('上报的登录状态只认已知取值，二维码只认微信托管的地址', () => {
  assert.throws(() => sanitizeYybLoginReport({ state: 'hacked' }), /不合法/u);
  assert.equal(report({ state: 'scanning', logged_in: false, qr_url: QR }).qr_url, QR);
  assert.equal(
    report({ state: 'scanning', logged_in: false, qr_url: 'https://evil.example/qr.png' }).qr_url,
    '',
    '后台会把它当图片直接显示，不能放任意链接进来',
  );
  assert.equal(report({ state: 'alive', qr_url: QR }).qr_url, '', '不在等扫码就不该带二维码');
  assert.equal(report({ nickname: ` ${'很长'.repeat(50)}\n` }).nickname.length, 64);
});

test('从没上报过时后台不显示登录信息', async () => {
  assert.equal(await yybLoginStatus(sqliteEnv(), NOW), null);
});

test('等扫码时后台拿到二维码；Watcher 停报太久后二维码不再显示', async () => {
  const env = sqliteEnv();
  await recordYybLoginState(env, report({ state: 'scanning', logged_in: false, qr_url: QR }), NOW);
  const fresh = await yybLoginStatus(env, NOW + 1_000);
  assert.equal(fresh.state, 'scanning');
  assert.equal(fresh.qr_url, QR);
  assert.equal(fresh.logout_pending, false);
  const stale = await yybLoginStatus(env, NOW + YYB_QR_FRESH_MS + 1);
  assert.equal(stale.state, 'scanning');
  assert.equal(stale.qr_url, '', '那张码早过期了，扫了也没用');
});

test('内容没变时节流写库，变了立刻写', async () => {
  const env = sqliteEnv();
  await recordYybLoginState(env, report(), NOW);
  await recordYybLoginState(env, report(), NOW + 30_000);
  assert.equal((await yybLoginStatus(env, NOW + 30_000)).updated_at, new Date(NOW).toISOString());
  await recordYybLoginState(env, report({ state: 'unknown' }), NOW + 60_000);
  const changed = await yybLoginStatus(env, NOW + 60_000);
  assert.equal(changed.state, 'unknown');
  assert.equal(changed.updated_at, new Date(NOW + 60_000).toISOString());
  await recordYybLoginState(env, report({ state: 'unknown' }), NOW + 60_000 + 120_000);
  assert.equal(
    (await yybLoginStatus(env, NOW + 180_000)).updated_at,
    new Date(NOW + 180_000).toISOString(),
    '超过节流窗口即便没变也要刷新时间',
  );
});

test('没有应用宝监听上报过时不能清除登录状态', async () => {
  await assert.rejects(requestYybLogout(sqliteEnv(), NOW), (error) => error.status === 409);
});

test('清除指令只被取走一次，取走后后台不再显示"等待执行"', async () => {
  const env = sqliteEnv();
  await recordYybLoginState(env, report(), NOW);
  const request = await requestYybLogout(env, NOW);
  assert.equal((await yybLoginStatus(env, NOW + 1_000)).logout_pending, true);

  const claimed = await claimYybLogout(env, NOW + 5_000);
  assert.deepEqual(claimed, { request_id: request.request_id });
  assert.equal(await claimYybLogout(env, NOW + 6_000), null, '两个实例同时上报也只有一个拿到');
  assert.equal((await yybLoginStatus(env, NOW + 6_000)).logout_pending, false);
});

test('过期没取走的清除指令作废，不会在 Watcher 回来后突然生效', async () => {
  const env = sqliteEnv();
  await recordYybLoginState(env, report(), NOW);
  await requestYybLogout(env, NOW);
  assert.equal(await claimYybLogout(env, NOW + YYB_LOGOUT_TTL_MS + 1), null);
  assert.equal((await yybLoginStatus(env, NOW + YYB_LOGOUT_TTL_MS + 1)).logout_pending, false);
});

test('路由与后台接上了登录状态上报和「清除登录状态」按钮', async () => {
  const [router, script] = await Promise.all([
    readFile(new URL('../src/core/request-router.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);
  assert.match(router, /pathname === '\/api\/watcher\/yyb-login' && request\.method === 'POST'/u);
  assert.match(router, /pathname === '\/admin\/api\/system-status\/yyb-logout' && request\.method === 'POST'/u);
  // 登录状态上报不能刷新 presence：掉登录的监听器仍要按掉线让通道自动暂停。
  const handler = router.slice(router.indexOf('async function watcherYybLoginApi'));
  assert.doesNotMatch(handler.slice(0, handler.indexOf('\n}\n')), /recordWatcherPresence/u);
  assert.match(script, /data-yyb-logout/u);
  assert.match(script, /\/admin\/api\/system-status\/yyb-logout/u);
  assert.match(script, /referrerpolicy="no-referrer"/u);
});
