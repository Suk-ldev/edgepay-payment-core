import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { createTestWorker, allowAllPlugins } = await import('./helpers/worker.mjs');
const { fakeDirectPlugin, fakeReceiptPlugin } = await import('./helpers/fake-plugins.mjs');
const { encryptSetting } = await import('../src/runtime-settings.js');

const worker = createTestWorker({
  plugins: [
    fakeReceiptPlugin('lakala_receipt', { name: '拉卡拉' }),
    fakeDirectPlugin('stripe_api', { name: 'Stripe支付API' }),
  ],
  authorizePlugin: allowAllPlugins,
});

// 解密后的插件配置按「设置键 + 密钥」在 isolate 里短暂缓存，每个用例换一把密钥，互不串味。
let configKeySequence = 0;
const ctx = { waitUntil() {} };

class SettingsDatabase {
  constructor(settings = new Map()) {
    this.settings = settings;
  }

  prepare(sql) {
    const database = this;
    let values = [];
    return {
      bind(...input) {
        values = input;
        return this;
      },
      async first() {
        if (!sql.includes('FROM runtime_settings')) return null;
        const value = database.settings.get(String(values[0]));
        return value === undefined ? null : { value_text: value };
      },
      async all() {
        return { results: [] };
      },
      async run() {
        return { meta: { changes: 0 } };
      },
    };
  }
}

async function envWith({ channels = null, pluginConfig = null, siteConfig = null } = {}) {
  const configKey = `home-config-key-${configKeySequence += 1}`;
  const settings = new Map();
  if (channels) settings.set('channels', JSON.stringify(channels));
  if (pluginConfig) settings.set('plugin_config', await encryptSetting(pluginConfig, configKey, 'plugin_config'));
  if (siteConfig) settings.set('site_config', JSON.stringify(siteConfig));
  return {
    DB: new SettingsDatabase(settings),
    EPAY_PID: '1000',
    EPAY_KEY: 'home-epay-key',
    CONFIG_ENCRYPTION_KEY: configKey,
  };
}

async function homeSummary(env) {
  const response = await worker.fetch(new Request('https://pay.example/api/home'), env, ctx);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const text = await response.text();
  return { text, data: JSON.parse(text) };
}

test('首页只列出此刻真正能收的支付方式，而不是写死的付呗', async () => {
  const channel = (id, pluginCode, payType, extra = {}) => ({
    id, name: `通道 ${id}`, plugin_code: pluginCode, pay_types: [payType], weight: 100, enabled: true, ...extra,
  });
  const env = await envWith({
    siteConfig: { merchant_name: '示例商户' },
    channels: [
      channel(1, 'wechat_api', 'wxpay'),
      channel(2, 'lakala_receipt', 'alipay'),
      // 管理员起的通道名、副本名可能带账号信息，不能出现在公开接口里。
      channel(3, 'lakala_receipt~2', 'wxpay', { name: '张三的拉卡拉通道' }),
      // 付呗插件随核心免费附带，但没配置，不该出现在首页。
      channel(4, 'fubei_receipt', 'wxpay'),
      channel(5, 'stripe_api', 'bank', { enabled: false }),
      channel(6, 'alipay_api', 'alipay', { weight: 0 }),
      channel(7, 'wxpay_receipt', 'wxpay'),
    ],
    pluginConfig: {
      wechat_api: { mch_id: '1900000001', api_v2_key: 'wechat-secret-value' },
      lakala_receipt: { receipt_qrcode_image: 'data:image/png;base64,AAAA' },
      'lakala_receipt~2': { receipt_qrcode_image: 'data:image/png;base64,BBBB', instance_name: '张三的拉卡拉' },
      stripe_api: { secret_key: 'sk_home' },
      alipay_api: { app_id: '2026', private_key: 'pk', alipay_public_key: 'pub' },
      // 配置齐全但被管理员关掉的插件同样不展示。
      wxpay_receipt: { sms_forwarder_secret: 'sms', receipt_qrcode_image: 'data:image/png;base64,CCCC', enabled: false },
    },
  });

  const { text, data } = await homeSummary(env);
  assert.equal(data.merchant_name, '示例商户');
  assert.equal(data.channel_count, 3);
  assert.deepEqual(data.methods, [
    { code: 'alipay', name: '支付宝', channel_count: 1 },
    { code: 'wxpay', name: '微信支付', channel_count: 2 },
  ]);
  // 公开接口只到支付方式为止：用哪家平台、是不是个人收款监听，都是商户不想公开的经营细节。
  assert.deepEqual(Object.keys(data).sort(), ['channel_count', 'merchant_name', 'methods']);
  assert.doesNotMatch(text, /付呗|拉卡拉|lakala|微信官方|wechat_api|Stripe|张三|通道 \d|secret|data:image|receipt/u);
});

test('没有可用通道时首页接口返回空列表，不回落到任何默认平台', async () => {
  const { data } = await homeSummary(await envWith());
  assert.deepEqual(data, { merchant_name: 'EdgePay', channel_count: 0, methods: [] });
});

test('首页 HTML 不写死任何支付平台，支付方式只来自 /api/home', async () => {
  const response = await worker.fetch(new Request('https://pay.example/'), await envWith(), ctx);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /\/home\.js\?v=[0-9a-f]{12}/u);
  assert.match(html, /\/home\.css\?v=[0-9a-f]{12}/u);
  assert.doesNotMatch(html, /付呗|FUBEI|Stripe|STRIPE|PayPal|USDT|微信个人收款/u);
});
