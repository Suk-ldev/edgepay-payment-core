import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const workerModule = await import('../src/index.js');
const { createTestWorker, allowAllPlugins } = await import('./helpers/worker.mjs');
const { fakeDirectPlugin } = await import('./helpers/fake-plugins.mjs');
// 核心没有默认导出，集成测试自己组装运行时。银行卡通道原本由 Stripe/PayPal 提供，
// 它们已归私有仓库，这里用同编码的假插件覆盖核心侧的路由与换通道行为。
const worker = createTestWorker({
  plugins: [
    fakeDirectPlugin('stripe_api', { name: 'Stripe支付API' }),
    fakeDirectPlugin('paypal_api', { name: 'PayPal收款API' }),
  ],
  authorizePlugin: allowAllPlugins,
});
const { isCashierShellPath } = workerModule;
const { encryptSetting } = await import('../src/runtime-settings.js');

class ReadStatement {
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
    if (this.sql.includes('WHERE payment_no = ?')) {
      return this.database.payment.payment_no === this.values[0] ? this.database.payment : null;
    }
    if (this.sql.includes('WHERE external_order_no = ?')) {
      return this.database.payment.external_order_no === this.values[0] ? this.database.payment : null;
    }
    return null;
  }

  async all() {
    return { results: [] };
  }

  async run() {
    if (
      this.sql.includes("SET status = 'EXPIRED'")
      && ['PENDING', 'PAYING'].includes(this.database.payment.status)
      && Date.parse(this.database.payment.expires_at) <= Date.parse(this.values[1])
    ) {
      this.database.payment.status = 'EXPIRED';
      this.database.payment.updated_at = this.values[0];
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
}

class ReadDatabase {
  constructor(payment, settings = new Map()) {
    this.payment = payment;
    this.settings = settings;
  }

  prepare(sql) {
    return new ReadStatement(this, sql);
  }
}

async function fixture() {
  const payment = {
    payment_no: 'p_cashiercontract',
    external_order_no: 'ORDER-CASHIER-1',
    plugin_code: 'stripe_api',
    expected_amount_fen: 2000,
    currency: 'CNY',
    status: 'PAYING',
    notify_url: 'https://merchant.example/notify',
    provider_trade_no: 'cs_contract',
    paid_at: null,
    expires_at: '2099-01-01T00:00:00.000Z',
    created_at: '2026-07-27T12:00:00.000Z',
    updated_at: '2026-07-27T12:00:00.000Z',
    metadata_json: JSON.stringify({
      protocol: 'epay_v1',
      epay_type: 'bank',
      name: '原收银台合同测试',
      return_url: '',
      channel_id: 6,
      channel_name: 'Stripe Checkout',
      presentation: {
        pay_page: 'jump',
        pay_type: 'bank',
        pay_product: 'card_checkout',
        pay_action: 'checkout.sessions.create',
        pay_params: {
          url: 'https://checkout.stripe.example/session',
          raw: { provider_response: 'internal-only' },
        },
      },
    }),
  };
  const configEncryptionKey = 'cashier-config-key';
  const channels = [
    {
      id: 3,
      name: '微信官方支付',
      plugin_code: 'wechat_api',
      pay_types: ['wxpay'],
      weight: 100,
      enabled: true,
    },
    {
      id: 4,
      name: 'USDT TRC20 收款',
      plugin_code: 'usdt_trc20_receipt',
      pay_types: ['usdt'],
      weight: 100,
      enabled: true,
    },
    {
      id: 5,
      name: '支付宝官方支付',
      plugin_code: 'alipay_api',
      pay_types: ['alipay'],
      weight: 100,
      enabled: true,
    },
    {
      id: 6,
      name: 'Stripe Checkout',
      plugin_code: 'stripe_api',
      pay_types: ['bank'],
      weight: 100,
      enabled: true,
    },
    {
      id: 7,
      name: 'PayPal Checkout',
      plugin_code: 'paypal_api',
      pay_types: ['bank'],
      weight: 100,
      enabled: true,
    },
  ];
  const pluginConfig = {
    wechat_api: {
      mch_id: '1900000001',
      api_v2_key: 'wechat-contract-key',
    },
    usdt_trc20_receipt: {
      trc20_addresses: 'TYHeSa52LmnrpBffr3Q7MM5hUZXfYpVNj1',
    },
    alipay_api: {
      app_id: '2026000000000001',
      private_key: 'alipay-contract-private-key',
      alipay_public_key: 'alipay-contract-public-key',
    },
    stripe_api: {
      secret_key: 'sk_contract',
      webhook_secret: 'whsec_contract',
      min_pay_amount_yuan: '20',
    },
    paypal_api: {
      client_id: 'client_contract',
      client_secret: 'secret_contract',
      webhook_id: 'webhook_contract',
    },
  };
  const settings = new Map([
    ['channels', JSON.stringify(channels)],
    ['plugin_config', await encryptSetting(pluginConfig, configEncryptionKey, 'plugin_config')],
  ]);
  return {
    env: {
      DB: new ReadDatabase(payment, settings),
      EPAY_PID: '1000',
      EPAY_KEY: 'cashier-contract-key',
      CONFIG_ENCRYPTION_KEY: configEncryptionKey,
    },
  };
}

test('原 MPay 收银台路由、跳转展示和银行卡换通道合同保持一致', async () => {
  const { env } = await fixture();
  const ctx = { waitUntil() {} };

  const page = await worker.fetch(
    new Request('https://pay.example/payment/p_cashiercontract'),
    env,
    ctx,
  );
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="app"/u);

  const legacy = await worker.fetch(
    new Request('https://pay.example/pay/p_cashiercontract'),
    env,
    ctx,
  );
  assert.equal(legacy.status, 302);
  assert.equal(legacy.headers.get('location'), 'https://pay.example/payment/p_cashiercontract');

  const detailResponse = await worker.fetch(
    new Request('https://pay.example/api/cashier/pay-order?pay_no=p_cashiercontract'),
    env,
    ctx,
  );
  const detail = await detailResponse.json();
  assert.equal(detail.code, 200, JSON.stringify(detail));
  assert.equal(detail.data.presentation.pay_page, 'jump');
  assert.equal(
    detail.data.presentation.pay_params.url,
    'https://checkout.stripe.example/session',
  );
  assert.equal('raw' in detail.data.presentation.pay_params, false);
  assert.equal(detail.data.cashier_path, '/cashier/ORDER-CASHIER-1');

  const contextResponse = await worker.fetch(
    new Request('https://pay.example/api/cashier/context?biz_no=ORDER-CASHIER-1'),
    env,
    ctx,
  );
  const context = await contextResponse.json();
  assert.equal(context.code, 200, `收银台上下文失败：${JSON.stringify(context)}`);
  assert.equal(context.data.can_pay, true);
  assert.equal(context.data.public_config.show_pay_type_desc, false);
  assert.deepEqual(
    context.data.available_pay_types.map((method) => method.code),
    ['bank_ch_6', 'bank_ch_7'],
  );
  assert.equal(context.data.active_pay_order.pay_type_name, '银行卡');
  assert.equal(
    context.data.active_pay_order.payment_page_path,
    '/payment/p_cashiercontract',
  );
});

test('收银台接口会把已过期支付单真实落为超时状态', async () => {
  const { env } = await fixture();
  env.DB.payment.expires_at = '2020-01-01T00:00:00.000Z';
  const response = await worker.fetch(
    new Request('https://pay.example/api/cashier/pay-order-status?pay_no=p_cashiercontract'),
    env,
    { waitUntil() {} },
  );
  const payload = await response.json();
  assert.equal(payload.code, 200);
  assert.equal(payload.data.status_text, '已超时');
  assert.equal(env.DB.payment.status, 'EXPIRED');
  assert.ok(payload.data.timeout_at);
});

test('收银台页面路由不会吞掉 custom.js 等静态资源', () => {
  assert.equal(isCashierShellPath('/cashier/2026072721070531961034216'), true);
  assert.equal(isCashierShellPath('/payment/p_cdb909a2c8f84a25831e80252d1d6c'), true);
  assert.equal(isCashierShellPath('/cashier/custom.js'), false);
  assert.equal(isCashierShellPath('/cashier/assets/cashier.js'), false);
});
