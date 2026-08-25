import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const {
  adminCaptchaResponse, createAdminSession, isAdminSession, verifyAdminLogin, verifyLoginPassword,
} = await import('../src/admin-auth.js');
const {
  channelExpireMinutes, parseChannels: coreParseChannels, resolveChannel: coreResolveChannel, weightedChannel,
} = await import('../src/channels.js');
const {
  pluginEnabled: corePluginEnabled, publicPluginList: corePublicPluginList,
} = await import('../src/core/plugin-config.js');
const { createPluginRegistry, freePlugins } = await import('../src/index.js');

// 公开核心只带免费插件，注册表就按这个建。
const registry = createPluginRegistry([...freePlugins]);

// 注册表化之后这些函数都要先拿到 registry。用同名 shim 包一层，
// 测试体保持原样，读起来仍然是在测行为而不是测签名。
const pluginByCode = (code) => registry.get(code)?.manifest ?? null;
const pluginAdminFields = (code) => registry.get(code)?.manifest.adminFields ?? [];
const pluginEnabled = (config, code) => corePluginEnabled(registry, config, code);
const publicPluginList = (config) => corePublicPluginList(registry, config);
const parseChannels = (input) => coreParseChannels(registry, input);
const resolveChannel = (channels, type) => coreResolveChannel(registry, channels, type);

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.btoa) globalThis.btoa = (value) => Buffer.from(value, 'binary').toString('base64');
if (!globalThis.atob) globalThis.atob = (value) => Buffer.from(value, 'base64').toString('binary');

test('管理员登录建立 HTTP-only 签名会话', async () => {
  const limits = new Map();
  const DB = {
    prepare(sql) {
      return {
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() { return limits.get(this.values[0]) ?? null; },
        async run() {
          if (/^DELETE FROM admin_login_limits/u.test(sql.trim())) limits.delete(this.values[0]);
          else limits.set(this.values[0], {
            failure_count: this.values[1], locked_until: this.values[2], updated_at: this.values[3],
          });
          return { meta: { changes: 1 } };
        },
      };
    },
  };
  const env = { ADMIN_USERNAME: 'admin', ADMIN_TOKEN: 'test-admin-token', DB };
  const captchaResponse = await adminCaptchaResponse(env);
  const captchaSvg = await captchaResponse.text();
  const captcha = [...captchaSvg.matchAll(/>([A-Z0-9])<\/text>/gu)].map((match) => match[1]).join('');
  const captchaCookie = captchaResponse.headers.get('set-cookie').split(';', 1)[0];
  const loginRequest = (password, username = 'admin', captchaValue = captcha) => new Request('https://pay.example/admin/login', {
    method: 'POST',
    headers: { cookie: captchaCookie },
    body: new URLSearchParams({ username, password, captcha: captchaValue }).toString(),
  });
  assert.equal(await verifyLoginPassword(loginRequest('test-admin-token'), env), true);
  assert.equal(await verifyLoginPassword(loginRequest('test-admin-token', ' admin ', ` ${captcha.toLowerCase()} `), env), true);
  assert.equal(await verifyLoginPassword(loginRequest('wrong'), env), false);
  let locked;
  for (let attempt = 0; attempt < 6; attempt += 1) locked = await verifyAdminLogin(loginRequest('wrong'), env);
  assert.equal(locked.locked, true);
  assert.equal(locked.retryAfterSeconds, 600);
  assert.equal((await verifyAdminLogin(loginRequest('test-admin-token'), env)).locked, true);
  const unlocked = await verifyAdminLogin(loginRequest('test-admin-token'), env, Date.now() + 601_000);
  assert.equal(unlocked.ok, true);
  const cookie = await createAdminSession(env);
  const session = cookie.split(';', 1)[0];
  assert.equal(await isAdminSession(new Request('https://pay.example/admin', { headers: { cookie: session } }), env), true);
});

test('通道按类型筛选，并保留权重随机路由', () => {
  const channels = parseChannels([
    { id: 10, name: 'A', plugin_code: 'fubei_receipt', pay_types: ['wxpay'], weight: 10, enabled: true },
    { id: 11, name: 'B', plugin_code: 'wxpay_receipt', pay_types: ['wxpay'], weight: 90, enabled: true },
  ]);
  assert.ok([10, 11].includes(resolveChannel(channels, 'wxpay').id));
  assert.equal(resolveChannel(channels, 'fubei_receipt').id, 10);
  assert.equal(weightedChannel(channels, 0.01).id, 10);
  assert.equal(weightedChannel(channels, 0.99).id, 11);
});

test('插件可独立停用，未配置插件不会被误判为可用', () => {
  // 三种状态各测一次：配置齐全默认启用、显式停用、根本没配。
  // 原用例用的是 Stripe/PayPal，它们已归私有仓库，这里换成同样形态的免费插件。
  const configured = {
    alipay_api: {
      app_id: 'app',
      private_key: 'private',
      alipay_public_key: 'public',
    },
    wechat_api: {
      enabled: false,
      mch_id: 'mch',
      api_v2_key: 'key',
    },
  };
  assert.equal(pluginEnabled(configured, 'alipay_api'), true);
  assert.equal(pluginEnabled(configured, 'wechat_api'), false);
  assert.equal(pluginEnabled(configured, 'fubei_receipt'), false);
  // 显式停用不等于没配好：configured 仍然是 true。
  assert.equal(
    publicPluginList(configured).find((plugin) => plugin.code === 'wechat_api').configured,
    true,
  );
});

test('监听插件不再提供重复的订单有效期配置', () => {
  for (const pluginCode of ['wxpay_receipt', 'alipay_receipt', 'usdt_trc20_receipt', 'fubei_receipt']) {
    assert.equal(
      pluginAdminFields(pluginCode).some((field) => field.key === 'receipt_valid_seconds'),
      false,
    );
  }
  assert.deepEqual(
    pluginAdminFields('wechat_api')
      .filter((field) => ['cert_path', 'key_path'].includes(field.key)),
    [],
  );
});

test('支付宝插件配置提供原 MPay 六种支付产品与场景参数', () => {
  const fields = pluginAdminFields('alipay_api');
  const products = fields.find((field) => field.key === 'enabled_products');
  assert.deepEqual(products.options.map(([value]) => value), [
    'pos', 'scan', 'mini', 'app', 'h5', 'web',
  ]);
  for (const key of [
    'seller_id',
    'service_provider_id',
    'store_id',
    'operator_id',
    'terminal_id',
    'app_auth_token',
    'mini_app_id',
    'mini_launch_path',
    'sandbox',
  ]) {
    assert.equal(fields.some((field) => field.key === key), true);
  }
});

test('支付宝个人监听保持原 MPay 手机监听与收款码二选一约束', () => {
  const plugin = pluginByCode('alipay_receipt');
  const fields = pluginAdminFields('alipay_receipt');
  assert.deepEqual(plugin.payTypes, ['alipay']);
  assert.match(plugin.note, /安卓 SmsForwarder/u);
  assert.match(plugin.note, /无法区分，只能选择其中一个/u);
  assert.match(plugin.note, /不支持 PC/u);
  assert.deepEqual(fields.find((field) => field.key === 'receipt_code_type').options, [
    ['personal', '收钱码'], ['business', '经营码'],
  ]);
  assert.equal(fields.some((field) => field.key === 'receipt_qrcode_image'), true);
});

test('新安装不预置通道，管理员自行添加实际支付通道', () => {
  assert.deepEqual(parseChannels(), []);
});
