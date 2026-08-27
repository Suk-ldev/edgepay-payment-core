import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { receiptPollResponse } from '../src/index.js';

test('后台导航使用六个独立 URL，不再使用长页面锚点', async () => {
  const html = await readFile(new URL('../public/dashboard.html', import.meta.url), 'utf8');
  for (const section of ['site', 'plugins', 'channels', 'orders', 'keys', 'docs']) {
    assert.match(html, new RegExp(`href="/admin/${section}" data-section-link="${section}"`, 'u'));
  }
  assert.doesNotMatch(html, /data-section-link(?:>|[\s])/u);
});

test('插件页支持搜索和启停，通道页用下拉框选择支付方式并可新增、删除通道', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('../public/dashboard.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="plugin-keyword"/u);
  assert.match(html, /id="plugin-status-filter"/u);
  assert.match(html, /id="channel-filters"/u);
  assert.match(html, /id="open-channel-create"/u);
  assert.match(html, /id="channel-create-dialog"/u);
  assert.match(html, /id="channel-create-plugin"/u);
  assert.match(html, /id="channel-create-pay-type"/u);
  assert.match(script, /data-toggle-plugin/u);
  assert.match(script, /<select class="channel-pay-type"/u);
  assert.match(script, /applyChannelFilters/u);
  assert.match(script, /function createChannel\(event\)/u);
  assert.match(script, /data-delete-channel/u);
  assert.match(script, /method: 'DELETE'/u);
  assert.match(script, /pay_types: \[payType\]/u);
  assert.doesNotMatch(script, /channel-pay-type:checked/u);
});

test('公开管理台只内置免费插件教程，付费插件教程随插件下发', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('../public/dashboard.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);
  // 付费插件的教程会点名平台接口与登录方式，属于实现细节，不能随公开核心发给所有人。
  // 它们已经搬进各自插件的 manifest.docs，由管理台按实际装载的插件动态渲染。
  const documented = [...html.matchAll(/data-plugin-doc="([a-z0-9_]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(documented, []);
  assert.match(html, /id="plugin-docs-dynamic"/u);
  assert.match(script, /renderPluginDocs/u);
  // 回调地址位不再给某个渠道写死，改成对任何带占位的插件文档都生效。
  assert.doesNotMatch(script, /docs-paypal-webhook|docs-stripe-webhook/u);
  assert.match(script, /\[id\^="docs-"\]\[id\$="-webhook"\]/u);
  // 通用的配置指引仍然留在公开管理台。
  for (const text of ['配置顺序', 'Docker Watcher', '通道管理', '测试']) assert.match(html, new RegExp(text, 'u'));
});

test('付呗和收钱吧教程随插件提供最近流水查号步骤且不拿其他产品作宣传文案', async () => {
  const [fubei, shouqianba] = await Promise.all([
    readFile(new URL('../src/free-plugins/fubei-receipt.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/free-plugins/shouqianba-receipt.js', import.meta.url), 'utf8'),
  ]);
  for (const source of [fubei, shouqianba]) {
    assert.match(source, /查询最近流水/u);
    assert.match(source, /填入编号/u);
    assert.doesNotMatch(source, /MPay/u);
  }
  assert.match(fubei, /device_no/u);
  assert.match(fubei, /store_id/u);
  assert.match(fubei, /order_sn.*不能当终端号/u);
});

test('管理后台会检查发行版本并提供升级入口，但不让它拖慢首屏', async () => {
  const [html, script, worker] = await Promise.all([
    readFile(new URL('../public/dashboard.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/core/request-router.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="version-update-dialog"/u);
  assert.match(html, /原 D1、插件配置、支付通道、环境变量、Secrets、定时任务和路由都会保留/u);
  assert.match(script, /request\('\/admin\/api\/version'\)/u);
  // 版本检查排在首屏数据之后：以前它和插件列表同时发出去，插件都回来了页面
  // 还在等版本转圈。服务端也要缓存，不能每开一次后台就打一次外网。
  assert.match(script, /load\(\)\.finally\(checkVersionUpdate\)/u);
  assert.doesNotMatch(script, /checkVersionUpdate\(\);\s*\nload\(\)/u);
  assert.match(worker, /RELEASE_CHECK_TTL_MS/u);
  assert.match(worker, /readPlainJsonSetting\(env, RELEASE_CHECK_KEY/u);
  assert.match(script, /location\.assign\(payload\.deploy_url\)/u);
  assert.match(worker, /pathname === '\/admin\/api\/version'/u);
  assert.match(worker, /https:\/\/deploy\.imsuk\.cn\//u);
});

test('支付宝通道测试只显示当前产品所需字段', async () => {
  const [html, script, styles] = await Promise.all([
    readFile(new URL('../public/dashboard.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
  ]);
  for (const control of [
    'channel-test-alipay-product',
    'channel-test-alipay-auth-code',
    'channel-test-alipay-mini-app-id',
    'channel-test-alipay-buyer-open-id',
    'channel-test-alipay-buyer-id',
  ]) {
    assert.match(html, new RegExp(`id="${control}"`, 'u'));
  }
  assert.match(script, /function syncChannelTestProductFields\(\)/u);
  assert.match(script, /alipay_product: data\.get\('alipay_product'\)/u);
  assert.match(styles, /html \[hidden\]\s*\{\s*display:none !important;\s*\}/u);
});

test('订单页提供搜索筛选、分页、回调与通知列及七个详情标签', async () => {
  const [html, script, styles] = await Promise.all([
    readFile(new URL('../public/dashboard.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
  ]);
  for (const control of [
    'order-search-field',
    'order-keyword',
    'order-plugin-filter',
    'order-status-filter',
    'order-callback-filter',
    'orders-prev-page',
    'orders-next-page',
  ]) {
    assert.match(html, new RegExp(`id="${control}"`, 'u'));
  }
  assert.match(html, /<th>回调状态<\/th><th>回调次数<\/th><th>通知状态<\/th>/u);
  for (const label of ['概览', '时间线', '收款监听', '上游回调', '商户通知', '退款', '操作记录']) {
    assert.match(script, new RegExp(`'${label}'`, 'u'));
  }
  assert.match(script, /data-order-tab/u);
  assert.match(script, /data-order-panel/u);
  assert.match(html, /class="ui-table-wrap ui-order-table-wrap"/u);
  assert.match(html, /class="ui-order-col-actions"/u);
  assert.match(styles, /\.ui-orders-table th:last-child,.ui-orders-table td:last-child\s*\{[^}]*position:sticky;[^}]*right:0;/u);
  assert.match(styles, /\.ui-order-actions\s*\{[^}]*white-space:nowrap;/u);
});

test('外部轮询响应汇总待监听订单、确认与失败明细', () => {
  const response = receiptPollResponse(
    [{}, {}],
    [
      {
        plugin_code: 'fubei_receipt',
        status: 'ok',
        current_orders: 2,
        records: 1,
        confirmed: 1,
        duplicates: 0,
        ignored: 0,
        failed: 0,
        confirmations: [{ payment_no: 'p_1', status: 'confirmed' }],
        errors: [],
      },
      {
        plugin_code: 'usdt_trc20_receipt',
        status: 'error',
        current_orders: 1,
        records: 0,
        confirmed: 0,
        duplicates: 0,
        ignored: 0,
        failed: 0,
        confirmations: [],
        errors: [{ status: 'failed', message: 'TronGrid HTTP 503' }],
      },
    ],
    '2026-07-28T00:00:00.000Z',
    '2026-07-28T00:00:01.000Z',
  );
  assert.equal(response.ok, false);
  assert.equal(response.status, 'partial_failure');
  assert.equal(response.summary.current_orders, 3);
  assert.equal(response.summary.confirmed_orders, 1);
  assert.equal(response.summary.failed_accounts, 1);
  assert.equal(response.results[0].confirmations[0].payment_no, 'p_1');
  assert.match(response.message, /成功确认 1 笔/u);
});

test('没有待监听订单时返回明确空闲状态', () => {
  const response = receiptPollResponse(
    [{}, {}],
    [
      { status: 'idle', current_orders: 0 },
      { status: 'idle', current_orders: 0 },
    ],
    '2026-07-28T00:00:00.000Z',
    '2026-07-28T00:00:00.100Z',
  );
  assert.equal(response.ok, true);
  assert.equal(response.status, 'idle');
  assert.equal(response.summary.current_orders, 0);
  assert.equal(response.message, '当前没有待监听订单。');
});

test('在线 Docker 接管后轮询响应明确标记已委派', () => {
  const response = receiptPollResponse(
    [{}],
    [{ status: 'docker', current_orders: 2, records: 0, confirmed: 0 }],
    '2026-08-24T00:00:00.000Z',
    '2026-08-24T00:00:00.100Z',
  );
  assert.equal(response.status, 'docker');
  assert.equal(response.summary.docker_accounts, 1);
  assert.match(response.message, /已交给在线 Docker Watcher 处理/u);
});

test('Docker 快照上报插件能力，在线时优先于 Worker 原生轮询', async () => {
  const worker = await readFile(new URL('../src/core/request-router.js', import.meta.url), 'utf8');
  assert.match(worker, /x-edgepay-watcher-plugins/u);
  // 在线状态的读写已经搬到 watcher-presence.js（每实例一行 + 取并集），
  // 这里只确认路由仍然经由它记录，具体行为由 watcher-presence.test.mjs 覆盖。
  assert.match(worker, /recordWatcherPresence\(/u);
  const presence = await readFile(new URL('../src/watcher-presence.js', import.meta.url), 'utf8');
  assert.match(presence, /watcher_presence/u);
  assert.match(worker, /delegated: 'docker_watcher'/u);
  assert.match(worker, /request\.method === 'GET' \? 'external_get' : 'signed_post',\s*true,/u);
});
