import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  channelTestFields, channelTestRecord, inferChannelTestDevice,
} from '../src/channel-tests.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.btoa) globalThis.btoa = (value) => Buffer.from(value, 'binary').toString('base64');
if (!globalThis.atob) globalThis.atob = (value) => Buffer.from(value, 'base64').toString('binary');

const { createAdminSession } = await import('../src/admin-auth.js');
const { encryptSetting } = await import('../src/runtime-settings.js');
const { definePlugin } = await import('../src/plugin-api.js');
const { PROVIDER_CALLBACK_MAX_BYTES, readBoundedText } = await import('../src/body-limits.js');
const { createTestWorker } = await import('./helpers/worker.mjs');
const worker = createTestWorker();

const channel = {
  id: 7,
  name: '测试通道',
  plugin_code: 'fubei_receipt',
  pay_types: ['wxpay'],
  weight: 100,
  enabled: true,
};

test('后台通道测试直接绑定当前通道，并生成 CHTEST 独立订单号', () => {
  const fields = channelTestFields({
    money: '1.23',
    name: '支付测试',
    pay_type: 'wxpay',
    device: 'auto',
    notify_url: 'https://merchant.example/notify',
    return_url: '',
  }, channel, {
    clientIp: '203.0.113.10, 10.0.0.2',
    userAgent: 'Mozilla/5.0 (iPhone) Mobile',
    now: new Date('2026-07-27T12:34:56.000Z'),
    randomSuffix: 'abcdef12',
  });

  assert.equal(fields.outTradeNo, 'CHTEST720260727123456abcdef12');
  assert.equal(fields.amountFen, 123);
  assert.equal(fields.type, 'wxpay');
  assert.equal(fields.device, 'mobile');
  assert.equal(fields.clientIp, '203.0.113.10');
  assert.equal(fields.param, 'channel_test');
});

test('后台通道测试拒绝未启用通道、跨通道支付方式和本地回调', () => {
  assert.throws(() => channelTestFields({ money: '1', name: '测试' }, { ...channel, enabled: false }));
  assert.throws(() => channelTestFields({ money: '1', name: '测试', pay_type: 'alipay' }, channel));
  assert.throws(() => channelTestFields({
    money: '1',
    name: '测试',
    notify_url: 'https://127.0.0.1/notify',
  }, channel));
});

test('自动支付环境与测试记录格式保持原后台语义', () => {
  assert.equal(inferChannelTestDevice('auto', 'MicroMessenger'), 'wechat');
  assert.equal(inferChannelTestDevice('auto', 'AlipayClient'), 'alipay');
  assert.equal(inferChannelTestDevice('pc', 'MicroMessenger'), 'pc');

  const record = channelTestRecord({
    payment_no: 'p_123',
    external_order_no: 'CHTEST123',
    plugin_code: 'wxpay_receipt',
    expected_amount_fen: 600,
    status: 'PAYING',
    provider_trade_no: '',
    created_at: '2026-07-27T12:00:00.000Z',
    metadata_json: JSON.stringify({
      is_test_order: true,
      channel_id: 1,
      channel_name: '个人微信',
      epay_type: 'wxpay',
      name: '支付测试',
    }),
  });
  assert.equal(record.money, '6.00');
  assert.equal(record.channel_id, 1);
  assert.equal(record.payment_page_path, '/payment/p_123');
});

test('微信通道测试可明确选择五类产品并传入对应 openid', () => {
  const wechatChannel = {
    id: 3,
    name: '微信官方支付',
    plugin_code: 'wechat_api',
    pay_types: ['wxpay'],
    enabled: true,
  };
  const jsapi = channelTestFields({
    money: '0.01',
    name: 'JSAPI 测试',
    pay_type: 'wxpay',
    device: 'auto',
    wechat_product: 'mp',
    openid: 'mp-openid',
  }, wechatChannel);
  assert.equal(jsapi.device, 'wechat');
  assert.equal(jsapi.wechatProduct, 'mp');
  assert.equal(jsapi.openid, 'mp-openid');

  const app = channelTestFields({
    money: '0.01',
    name: 'APP 测试',
    pay_type: 'wxpay',
    device: 'auto',
    wechat_product: 'app',
  }, wechatChannel);
  assert.equal(app.device, 'app');
  assert.equal(app.wechatProduct, 'app');

  assert.throws(() => channelTestFields({
    money: '0.01',
    name: '非法产品',
    pay_type: 'wxpay',
    wechat_product: 'unknown',
  }, wechatChannel), /微信测试产品不支持/u);
});

test('支付宝通道测试可明确选择六类产品及付款身份参数', () => {
  const alipayChannel = {
    id: 5,
    name: '支付宝官方支付',
    plugin_code: 'alipay_api',
    pay_types: ['alipay'],
    enabled: true,
  };
  const mini = channelTestFields({
    money: '0.01',
    name: '支付宝小程序测试',
    pay_type: 'alipay',
    device: 'auto',
    alipay_product: 'mini',
    sub_appid: '2026000000000099',
    buyer_open_id: 'buyer-open-contract',
  }, alipayChannel);
  assert.equal(mini.device, 'alipay');
  assert.equal(mini.alipayProduct, 'mini');
  assert.equal(mini.subAppId, '2026000000000099');
  assert.equal(mini.buyerOpenId, 'buyer-open-contract');

  const pos = channelTestFields({
    money: '0.01',
    name: '支付宝当面付测试',
    pay_type: 'alipay',
    device: 'auto',
    alipay_product: 'pos',
    auth_code: '28763443825664394',
  }, alipayChannel);
  assert.equal(pos.device, 'pc');
  assert.equal(pos.alipayProduct, 'pos');
  assert.equal(pos.authCode, '28763443825664394');

  assert.throws(() => channelTestFields({
    money: '0.01',
    name: '非法产品',
    pay_type: 'alipay',
    alipay_product: 'unknown',
  }, alipayChannel), /支付宝测试产品不支持/u);
});

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
    if (this.sql.includes('WHERE external_order_no = ?')) {
      return this.database.payments.find((payment) => payment.external_order_no === this.values[0]) ?? null;
    }
    return null;
  }

  async all() {
    if (this.sql.includes("WHERE plugin_code = ? AND status = 'PAYING'")) {
      return { results: this.database.payments.filter((payment) => payment.plugin_code === this.values[0] && payment.status === 'PAYING') };
    }
    if (this.sql.includes("json_extract(metadata_json, '$.is_test_order')")) {
      const channelId = Number(this.values[0]);
      const pluginCode = String(this.values[1]);
      const limit = Number(this.values[2]);
      return {
        results: this.database.payments
          .filter((payment) => {
            const metadata = JSON.parse(payment.metadata_json);
            return metadata.is_test_order === true
              && Number(metadata.channel_id) === channelId
              && payment.plugin_code === pluginCode;
          })
          .slice(0, limit),
      };
    }
    return { results: [] };
  }

  async run() {
    if (this.sql.includes('INSERT INTO payment_attempts')) {
      const [
        paymentNo, externalOrderNo, pluginCode, amountFen, notifyUrl,
        expiresAt, metadataJson, createdAt, updatedAt,
      ] = this.values;
      this.database.payments.push({
        payment_no: paymentNo,
        external_order_no: externalOrderNo,
        plugin_code: pluginCode,
        expected_amount_fen: amountFen,
        currency: 'CNY',
        status: 'PAYING',
        notify_url: notifyUrl,
        provider_trade_no: '',
        paid_at: null,
        expires_at: expiresAt,
        metadata_json: metadataJson,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
}

class MemoryDatabase {
  constructor(settings = new Map()) {
    this.payments = [];
    this.settings = settings;
  }

  prepare(sql) {
    return new MemoryStatement(this, sql);
  }
}

test('插件配置接口用授权目录展示未购买插件', async () => {
  let licenseStateCalls = 0;
  const unpaidWorker = createTestWorker({
    license: {
      async state(_env, registry) {
        licenseStateCalls += 1;
        const freeCodes = registry.manifests()
          .filter((manifest) => manifest.tier === 'FREE')
          .map((manifest) => manifest.code);
        return {
          licensed: true,
          domain: 'pay.example',
          plugins: freeCodes,
          catalog: [
            { code: 'stripe_api', name: 'Stripe Checkout', runtime: 'worker', tier: 'PAID', version: '2.0.14' },
          ],
          entitlementVersion: 1,
        };
      },
      async attest() { throw new Error('测试环境不做在线证明'); },
      async grantEnvelope() { return null; },
      async packageBaseUrl() { return 'https://license.example.com'; },
    },
  });
  const env = {
    ADMIN_TOKEN: 'test-admin-password',
    ADMIN_USERNAME: 'admin',
    CONFIG_ENCRYPTION_KEY: 'plugin-catalog-config-key',
    DB: new MemoryDatabase(),
  };
  const cookie = (await createAdminSession(env)).split(';', 1)[0];
  const response = await unpaidWorker.fetch(new Request('https://pay.example/admin/api/plugins', {
    headers: { cookie },
  }), env, { waitUntil() {} });
  const payload = await response.json();
  const stripe = payload.results.find((plugin) => plugin.code === 'stripe_api');

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-edgepay-cache'), 'MISS');
  assert.equal(stripe?.licensed, false);
  assert.equal(stripe?.installed, false);
  assert.equal(stripe?.name, 'Stripe Checkout');
  assert.equal(payload.forms.some((form) => form.code === 'stripe_api'), false);

  const cachedResponse = await unpaidWorker.fetch(new Request('https://pay.example/admin/api/plugins', {
    headers: { cookie },
  }), env, { waitUntil() {} });
  assert.equal(cachedResponse.status, 200);
  assert.equal(cachedResponse.headers.get('x-edgepay-cache'), 'HIT');
  assert.equal(licenseStateCalls, 1, '缓存命中时不应重新读取授权与组装插件目录');

  const updateResponse = await unpaidWorker.fetch(new Request('https://pay.example/admin/api/plugins', {
    method: 'PUT',
    headers: {
      cookie,
      origin: 'https://pay.example',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ plugin_code: 'fubei_receipt', enabled: false }),
  }), env, { waitUntil() {} });
  assert.equal(updateResponse.status, 200);
  assert.equal(licenseStateCalls, 2, '保存插件配置时应重新校验当前授权');

  const refreshedResponse = await unpaidWorker.fetch(new Request('https://pay.example/admin/api/plugins', {
    headers: { cookie },
  }), env, { waitUntil() {} });
  assert.equal(refreshedResponse.status, 200);
  assert.equal(refreshedResponse.headers.get('x-edgepay-cache'), 'MISS');
  assert.equal(licenseStateCalls, 3, '保存插件配置后必须立即失效列表缓存');
});

test('管理 API 请求体超限时保留 413 状态码', async () => {
  const env = {
    ADMIN_TOKEN: 'test-admin-password',
    ADMIN_USERNAME: 'admin',
    DB: new MemoryDatabase(),
  };
  const cookie = (await createAdminSession(env)).split(';', 1)[0];
  const response = await worker.fetch(new Request('https://pay.example/admin/api/site', {
    method: 'PUT',
    headers: {
      cookie,
      origin: 'https://pay.example',
      'content-type': 'application/json',
      'content-length': String(1_000_001),
    },
    body: '{}',
  }), env, { waitUntil() {} });
  const payload = await response.json();

  assert.equal(response.status, 413);
  assert.match(payload.error, /过大/u);
});

test('通道 notify 回调请求体超限时保留 413 状态码', async () => {
  const boundedDirectPlugin = definePlugin({
    manifest: {
      code: 'bounded_direct',
      name: '有界直连测试',
      version: '1.0.0',
      apiVersion: 1,
      tier: 'FREE',
      mode: 'direct',
      runtime: 'direct',
      payTypes: ['bank'],
      required: [],
      adminFields: [],
    },
    createPayment() {
      return { pay_page: 'jump', pay_action: 'redirect', pay_params: { url: 'https://checkout.example/bounded' } };
    },
    async handleCallback({ request }) {
      await readBoundedText(request, PROVIDER_CALLBACK_MAX_BYTES, '渠道回调请求体');
      return { status: 'pending', payNo: 'p_bounded' };
    },
  });
  const notifyWorker = createTestWorker({ plugins: [boundedDirectPlugin] });
  const env = {
    DB: new MemoryDatabase(new Map([['channels', JSON.stringify([{
      id: 42,
      name: '有界直连',
      plugin_code: 'bounded_direct',
      pay_types: ['bank'],
      weight: 100,
      enabled: true,
    }])]])),
  };
  const response = await notifyWorker.fetch(new Request('https://pay.example/api/pay/42/notify', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(PROVIDER_CALLBACK_MAX_BYTES + 1),
    },
    body: '{}',
  }), env, { waitUntil() {} });

  assert.equal(response.status, 413);
});

test('后台 API 只在管理员主动提交后创建真实待支付测试单，并可读取记录', async () => {
  const configEncryptionKey = 'channel-test-config-key';
  const settings = new Map([
    ['channels', JSON.stringify([{
      id: 1,
      name: '个人微信',
      plugin_code: 'wxpay_receipt',
      pay_types: ['wxpay'],
      weight: 100,
      enabled: true,
    }])],
    ['plugin_config', await encryptSetting({
      wxpay_receipt: {
        sms_forwarder_secret: 'test-sms-secret',
        receipt_match_mode: 'remark',
        receipt_qrcode_image: 'data:image/png;base64,iVBORw0KGgo=',
      },
    }, configEncryptionKey, 'plugin_config')],
  ]);
  const database = new MemoryDatabase(settings);
  const env = {
    ADMIN_TOKEN: 'test-admin-password',
    ADMIN_USERNAME: 'admin',
    EPAY_PID: '1000',
    EPAY_KEY: 'test-epay-key',
    CONFIG_ENCRYPTION_KEY: configEncryptionKey,
    DB: database,
  };
  const cookie = (await createAdminSession(env)).split(';', 1)[0];
  const request = new Request('https://pay.example/admin/api/channels/1/test', {
    method: 'POST',
    headers: {
      cookie,
      origin: 'https://pay.example',
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0',
    },
    body: JSON.stringify({
      money: '6.00',
      name: '回调测试',
      pay_type: 'wxpay',
      device: 'auto',
      notify_url: 'https://merchant.example/notify',
      return_url: '',
    }),
  });
  const response = await worker.fetch(request, env, { waitUntil() {} });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'PAYING');
  assert.equal(database.payments.length, 1);
  const metadata = JSON.parse(database.payments[0].metadata_json);
  assert.equal(metadata.is_test_order, true);
  assert.equal(metadata.source, 'admin_channel_test');
  assert.equal(metadata.channel_id, 1);
  assert.equal(database.payments[0].payment_no.length, 32);

  database.payments.unshift({
    ...database.payments[0],
    payment_no: 'p_legacy_wrong_plugin',
    external_order_no: 'CHTEST_LEGACY_WRONG_PLUGIN',
    plugin_code: 'stripe_api',
  });
  const recordsResponse = await worker.fetch(new Request(
    'https://pay.example/admin/api/channels/1/test-records',
    { headers: { cookie } },
  ), env, { waitUntil() {} });
  const records = await recordsResponse.json();
  assert.equal(recordsResponse.status, 200);
  assert.equal(records.results.length, 1);
  assert.equal(records.results[0].external_order_no, result.external_order_no);
});
