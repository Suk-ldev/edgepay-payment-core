import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { fubeiReceiptPlugin, gatewaySign, normalizeBillPayments } = await import('../src/free-plugins/fubei/index.js');
const { pluginHelpers } = await import('../src/core/plugin-context.js');

const BILL_CONFIG = Object.freeze({
  watcher_username: 'fubei-user',
  watcher_password: 'fubei-password',
  receipt_bill_mode: 'bill',
});

/**
 * 假的付呗 b 站 gateway，按实测规则办事：必须同时带 access-token 与 JSID 会话 Cookie，
 * 缺一个就回 1003；登录返回 accessToken + uid 并种下 JSID。
 */
function fakeGateway({ failDeadline = false, payments = [] } = {}) {
  const calls = [];
  const token = 'token-live';
  const reply = (body, headers = {}) => new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
  });
  async function fetchImpl(url, options) {
    assert.equal(new URL(url).pathname, '/api/gateway');
    const form = new URLSearchParams(options.body);
    const method = form.get('method');
    const content = JSON.parse(form.get('content'));
    calls.push({
      method,
      content,
      token: options.headers['access-token'] ?? '',
      cookie: options.headers.cookie ?? '',
      signed: form.get('sign') === await gatewaySign(method, form.get('content')),
    });
    if (method === 'com.fshows.lifecircle.college.login') {
      return reply({ success: true, data: { accessToken: token, uid: 2673566 } }, {
        'set-cookie': 'JSID=session-live; Path=/; HttpOnly',
      });
    }
    if (options.headers['access-token'] !== token || !String(options.headers.cookie).includes('JSID=session-live')) {
      return reply({ success: false, errorCode: '1003', errorMsg: '请重新登录' });
    }
    const ok = (data) => reply({ success: true, data });
    switch (method) {
      case 'receipt.web.store.list':
        return ok({ storeList: [{ storeId: 1847807, storeName: '测试门店' }] });
      case 'receipt.web.receipt.add':
        return ok({ receiptId: 'R-0001' });
      case 'receipt.web.receipt.order.update':
        return failDeadline
          ? reply({ success: false, errorCode: '5001', errorMsg: '截止时间不合法' })
          : ok({ success: true });
      case 'receipt.web.receipt.share':
        return ok({ qrcode: { posterUrl: 'https://oss.example.com/qrcode/R-0001.png' } });
      case 'receipt.web.receipt.close':
        return ok({});
      case 'receipt.web.find.receipt.statistics.list':
        return ok({ list: payments, total: payments.length });
      default:
        throw new Error(`未预期的付呗接口：${method}`);
    }
  }
  return { calls, fetchImpl };
}

function prepareContext(overrides = {}) {
  return {
    config: BILL_CONFIG,
    amountFen: 1234,
    expiresAt: '2026-10-01T04:05:06.000Z',
    payType: 'wxpay',
    paymentNo: 'p_0123456789abcdef0123456789abcd',
    activePayments: [],
    state: {},
    helpers: pluginHelpers,
    ...overrides,
  };
}

test('收款单网关签名与付呗前端一致（实抓样本）', async () => {
  assert.equal(await gatewaySign('receipt.web.store.list', '{}'), 'c05f16359df662047ffa6eedbd7f6d12');
  assert.equal(
    await gatewaySign('receipt.web.receipt.share', '{"receiptId":"202609302327139893579118335"}'),
    '28a0bf8c759652717280cc392119b777',
  );
});

test('收款单模式下单：会话失效时重登一次，建单、设截止时间、取收款码图', async () => {
  const gateway = fakeGateway();
  const prepared = await fubeiReceiptPlugin.prepareReceipt(prepareContext({
    fetchImpl: gateway.fetchImpl,
    state: {
      cookies: [['e_site', 'keep-me']],
      receipt_session: { token: 'token-stale', cookies: [['JSID', 'session-stale']] },
    },
  }));

  assert.deepEqual(gateway.calls.map((call) => call.method), [
    'receipt.web.store.list',
    'com.fshows.lifecircle.college.login',
    'receipt.web.store.list',
    'receipt.web.receipt.add',
    'receipt.web.receipt.order.update',
    'receipt.web.receipt.share',
  ]);
  assert.ok(gateway.calls.every((call) => call.signed), '每个请求都要按付呗规则签名');
  assert.equal(gateway.calls[1].content.password, await pluginHelpers.md5Hex('fubei-password'));

  const add = gateway.calls[3].content;
  assert.equal(add.storeId, 1847807);
  assert.equal(add.receiptMoney, 12.34);
  assert.equal(add.isLimit, 1);
  assert.equal(add.limitCount, 1);
  assert.equal(add.receiptTitle, 'EP23456789abcd');
  assert.ok(add.receiptTitle.length <= 15);

  // 截止时间 = 订单过期时间（北京时间），到点付呗自己关单。
  assert.deepEqual(gateway.calls[4].content, {
    receiptId: 'R-0001', receiptIsLong: 2, receiptEndTimeStr: '2026-10-01 12:05:06', receiptSource: 1,
  });

  const params = prepared.presentation.pay_params;
  assert.equal(params._page, 'receiptQrcode');
  assert.equal(params.amount, '12.34');
  assert.equal(params.qrcode_image, 'https://oss.example.com/qrcode/R-0001.png');
  assert.equal(params.qrcode, undefined, '不能给链接：微信里直接打开付呗链接会卡在公众号授权');
  assert.deepEqual(prepared.metadata.receipt_watcher, {
    mode: 'bill',
    receipt_id: 'R-0001',
    store_id: '1847807',
    amount_fen: 1234,
    expire_at: '2026-10-01T04:05:06.000Z',
    qrcode_image: 'https://oss.example.com/qrcode/R-0001.png',
  });

  assert.deepEqual(prepared.state.cookies, [['e_site', 'keep-me']], '码牌模式的 e 站会话不能被冲掉');
  assert.equal(prepared.state.receipt_session.token, 'token-live');
  assert.equal(prepared.state.receipt_session.uid, 2673566);
  assert.equal(prepared.state.receipt_session.store_id, '1847807');
  assert.deepEqual(prepared.state.receipt_session.cookies, [['JSID', 'session-live']]);
});

test('截止时间没设上就当场关单并让下单失败，不留长期有效的收款单', async () => {
  const gateway = fakeGateway({ failDeadline: true });
  await assert.rejects(
    fubeiReceiptPlugin.prepareReceipt(prepareContext({ fetchImpl: gateway.fetchImpl })),
    /截止时间不合法/u,
  );
  assert.equal(gateway.calls.at(-1).method, 'receipt.web.receipt.close');
  assert.deepEqual(gateway.calls.at(-1).content, { receiptId: 'R-0001' });
});

test('配置了门店 ID 就直接用，不再查门店列表', async () => {
  const gateway = fakeGateway();
  await fubeiReceiptPlugin.prepareReceipt(prepareContext({
    config: { ...BILL_CONFIG, receipt_account_no: '555' },
    fetchImpl: gateway.fetchImpl,
  }));
  assert.equal(gateway.calls.some((call) => call.method === 'receipt.web.store.list'), false);
  assert.equal(gateway.calls.find((call) => call.method === 'receipt.web.receipt.add').content.storeId, 555);
});

test('码牌模式不接管下单与匹配，必填项与运行位置按模式区分', () => {
  const plate = { watcher_username: 'u', watcher_password: 'p' };
  assert.equal(fubeiReceiptPlugin.prepareReceipt(prepareContext({ config: plate })), null);
  assert.equal(fubeiReceiptPlugin.matchReceipt({ record: { order_no: 'FB-1', price: '0.01' } }), null);
  assert.deepEqual(fubeiReceiptPlugin.missingFields(plate), ['receipt_terminal_no', 'receipt_qrcode_image']);
  assert.deepEqual(fubeiReceiptPlugin.missingFields(BILL_CONFIG), []);
  assert.equal(fubeiReceiptPlugin.workerOnly(plate), false);
  assert.equal(fubeiReceiptPlugin.workerOnly(BILL_CONFIG), true);
  assert.equal(fubeiReceiptPlugin.manifest.runtimeLabel, '码牌 Watcher + Worker，免输 Worker');
});

test('收款单付款记录：只收本系统的收款单与成功交易，支付方式 1 微信 2 支付宝', () => {
  const rows = [
    { receiptId: 'R-1', payOrderNo: 'PAY-1', payType: 1, realityAmount: 0.01, payTime: 1790782671, tradeStatus: 1 },
    { receiptId: 'R-2', payOrderNo: 'PAY-2', payType: 2, realityAmount: 12.5, payTime: 1790783256, tradeStatus: 1 },
    { receiptId: 'R-2', payOrderNo: 'PAY-3', payType: 2, realityAmount: 12.5, payTime: 1790783300, tradeStatus: 2 },
    { receiptId: 'OTHER', payOrderNo: 'PAY-4', payType: 1, realityAmount: 1, payTime: 1790783300, tradeStatus: 1 },
  ];
  const records = normalizeBillPayments(rows, new Set(['R-1', 'R-2']));
  assert.deepEqual(records.map((record) => [record.order_no, record.receipt_id, record.pay_type, record.price]), [
    ['PAY-1', 'R-1', 'wxpay', '0.01'],
    ['PAY-2', 'R-2', 'alipay', '12.50'],
  ]);
});

test('轮询按订单类型分流：收款单订单查 b 站，码牌订单仍查 e 站', async () => {
  const now = Math.floor(Date.now() / 1_000);
  const createdAt = new Date((now - 60) * 1_000).toISOString();
  const gateway = fakeGateway({
    payments: [{ receiptId: 'R-0001', payOrderNo: 'PAY-9', payType: 2, realityAmount: 12.34, payTime: now - 10, tradeStatus: 1 }],
  });
  const eSiteRequests = [];
  const fetchImpl = async (url, options) => {
    if (new URL(url).hostname === 'e.51fubei.com') {
      eSiteRequests.push(new URL(url).pathname);
      return new Response(JSON.stringify({
        status: 'ok',
        data: [{ order_sn: 'FB-1', pay_type: 1, order_sumprice: '0.01', device_no: 'T-1', pay_time: now - 5, pay_status: '1', type: '1' }],
      }), { headers: { 'content-type': 'application/json', 'set-cookie': 'e_sid=renewed; Path=/' } });
    }
    return gateway.fetchImpl(url, options);
  };
  const result = await fubeiReceiptPlugin.pollReceipts({
    account: {
      config: { ...BILL_CONFIG, receipt_terminal_no: 'T-1' },
      orders: [
        { created_at: createdAt, ext_json: { receipt_watcher: { mode: 'bill', receipt_id: 'R-0001' } } },
        { created_at: createdAt, ext_json: {} },
      ],
    },
    state: {},
    fetchImpl,
    helpers: pluginHelpers,
  });

  assert.deepEqual(result.records.map((record) => record.order_no), ['PAY-9', 'FB-1']);
  assert.equal(result.records[0].receipt_id, 'R-0001');
  assert.deepEqual(eSiteRequests, ['/User/NewFundManagement/tradestats']);
  const query = gateway.calls.find((call) => call.method === 'receipt.web.find.receipt.statistics.list');
  assert.equal(query.content.uid, 2673566, '付款查询必须带登录返回的 uid');
  assert.equal(result.state.receipt_session.token, 'token-live');
  assert.deepEqual(result.state.cookies, [['e_sid', 'renewed']]);
});

test('收款单付款按收款单号认领，金额不符或订单已过期都不认', () => {
  const payment = {
    payment_no: 'p_1',
    expected_amount_fen: 1234,
    created_at: '2026-10-01T04:00:00.000Z',
    expires_at: '2026-10-01T04:05:00.000Z',
    metadata: { receipt_watcher: { mode: 'bill', receipt_id: 'R-0001' } },
  };
  const other = { ...payment, payment_no: 'p_2', metadata: { receipt_watcher: { mode: 'bill', receipt_id: 'R-0002' } } };
  const record = {
    order_no: 'PAY-9', receipt_id: 'R-0001', pay_type: 'alipay', price: '12.34',
    paid_at: Date.parse('2026-10-01T04:02:00.000Z') / 1_000,
  };
  const context = { payments: [other, payment], eventId: 'PAY-9', now: '2026-10-01T04:02:05.000Z', helpers: pluginHelpers };

  const matched = fubeiReceiptPlugin.matchReceipt({ ...context, record });
  assert.equal(matched.payment.payment_no, 'p_1');
  assert.equal(matched.eventAmountFen, 1234);
  assert.equal(matched.metadataKey, 'receipt_watcher');
  assert.equal(matched.receiptPatch.pay_order_no, 'PAY-9');

  assert.throws(() => fubeiReceiptPlugin.matchReceipt({ ...context, record: { ...record, price: '12.00' } }), /金额不一致/u);
  assert.throws(
    () => fubeiReceiptPlugin.matchReceipt({
      ...context,
      record: { ...record, paid_at: Date.parse('2026-10-01T04:06:00.000Z') / 1_000 },
    }),
    /未匹配到支付单/u,
  );
});

test('插件契约：workerOnly 必须配 pollReceipts，接口版本号不再卡加载', async () => {
  const { definePlugin, pluginWorkerOnly } = await import('../src/plugin-api.js');
  const { createPluginRegistry } = await import('../src/index.js');
  const manifest = {
    code: 'contract_demo', name: '契约演示', version: '1.0.0', apiVersion: 7,
    tier: 'PAID', mode: 'channel-notify', runtime: 'hybrid', payTypes: ['wxpay'],
  };
  assert.throws(() => definePlugin({ manifest, workerOnly: () => true }), /workerOnly，却没有实现 pollReceipts/u);

  const plugin = definePlugin({
    manifest,
    workerOnly: (config) => config.only === true,
    async pollReceipts() { return { records: [] }; },
  });
  assert.equal(createPluginRegistry([plugin]).has('contract_demo'), true, '版本号不同的老插件也要能加载');
  assert.equal(pluginWorkerOnly(plugin, { only: true }), true);
  assert.equal(pluginWorkerOnly(plugin, {}), false);
  assert.equal(pluginWorkerOnly({ manifest }, { only: true }), false);
});

test('管理台插件列表带上运行位置文案', async () => {
  const { publicPluginList } = await import('../src/core/plugin-config.js');
  const { createPluginRegistry, freePlugins } = await import('../src/index.js');
  const listed = publicPluginList(createPluginRegistry([...freePlugins]), {});
  assert.equal(listed.find((plugin) => plugin.code === 'fubei_receipt').runtimeLabel, '码牌 Watcher + Worker，免输 Worker');
  assert.equal(listed.find((plugin) => plugin.code === 'wxpay_receipt').runtimeLabel, '');
});

class OrderStatement {
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
    if (this.sql.includes('WHERE external_order_no = ?')) {
      return this.database.payments.find((payment) => payment.external_order_no === this.values[0]) ?? null;
    }
    return null;
  }

  async all() {
    if (this.sql.includes("WHERE plugin_code = ? AND status = 'PAYING'")) {
      return { results: this.database.payments.filter((payment) => payment.plugin_code === this.values[0]) };
    }
    return { results: [] };
  }

  async run() {
    if (this.sql.includes('INSERT INTO runtime_settings')) {
      this.database.settings.set(String(this.values[0]), String(this.values[1]));
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes('INSERT INTO payment_attempts')) {
      const [paymentNo, externalOrderNo, pluginCode, amountFen, notifyUrl, expiresAt, metadataJson, createdAt] = this.values;
      this.database.payments.push({
        payment_no: paymentNo,
        external_order_no: externalOrderNo,
        plugin_code: pluginCode,
        expected_amount_fen: amountFen,
        status: 'PAYING',
        notify_url: notifyUrl,
        expires_at: expiresAt,
        metadata_json: metadataJson,
        created_at: createdAt,
      });
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
}

// 走真实下单入口（后台"通道测试"会建一笔真实待支付单），验证核心把支付单号、登录态交给插件，
// 并把插件返回的收款单展示和新会话落库。
test('下单链路：收款单模式建单后订单带收款码，登录态加密落库', async () => {
  const { encryptSetting, readEncryptedJsonSetting } = await import('../src/runtime-settings.js');
  const { createAdminSession } = await import('../src/admin-auth.js');
  const { createTestWorker } = await import('./helpers/worker.mjs');
  const configKey = 'fubei-bill-order-key';
  const settings = new Map([
    ['channels', JSON.stringify([{
      id: 7, name: '付呗免输', plugin_code: 'fubei_receipt', pay_types: ['alipay'], weight: 100, enabled: true,
    }])],
    ['plugin_config', await encryptSetting({ fubei_receipt: { ...BILL_CONFIG } }, configKey, 'plugin_config')],
  ]);
  const database = { settings, payments: [], prepare(sql) { return new OrderStatement(this, sql); } };
  const env = {
    ADMIN_TOKEN: 'test-admin-password',
    ADMIN_USERNAME: 'admin',
    EPAY_PID: '1000',
    EPAY_KEY: 'test-epay-key',
    CONFIG_ENCRYPTION_KEY: configKey,
    DB: database,
  };
  const gateway = fakeGateway();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = gateway.fetchImpl;
  try {
    const cookie = (await createAdminSession(env)).split(';', 1)[0];
    const response = await createTestWorker().fetch(new Request('https://pay.example/admin/api/channels/7/test', {
      method: 'POST',
      headers: { cookie, origin: 'https://pay.example', 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
      body: JSON.stringify({
        money: '12.34', name: '收款单测试', pay_type: 'alipay', device: 'auto',
        notify_url: 'https://merchant.example/notify', return_url: '',
      }),
    }), env, { waitUntil() {} });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(database.payments.length, 1);
  const [payment] = database.payments;
  const metadata = JSON.parse(payment.metadata_json);
  assert.equal(metadata.receipt_watcher.receipt_id, 'R-0001');
  assert.equal(metadata.presentation.pay_params.qrcode_image, 'https://oss.example.com/qrcode/R-0001.png');
  assert.equal(metadata.personal_receipt, undefined, '收款单模式不走金额偏移');
  const add = gateway.calls.find((call) => call.method === 'receipt.web.receipt.add').content;
  assert.equal(add.receiptTitle, `EP${payment.payment_no.slice(-12)}`, '核心要把刚生成的支付单号交给插件');
  const deadline = gateway.calls.find((call) => call.method === 'receipt.web.receipt.order.update').content;
  assert.equal(
    Date.parse(`${deadline.receiptEndTimeStr.replace(' ', 'T')}+08:00`),
    Math.floor(Date.parse(payment.expires_at) / 1_000) * 1_000,
    '收款单截止时间就是订单过期时间',
  );

  const stored = await readEncryptedJsonSetting(env, 'receipt_poller_state:fubei_receipt', configKey, {});
  assert.equal(stored.receipt_session.token, 'token-live');
  assert.equal(String(settings.get('receipt_poller_state:fubei_receipt')).includes('token-live'), false, '登录态必须加密存');
});
