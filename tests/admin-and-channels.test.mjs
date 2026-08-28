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
  adminPluginForms: coreAdminPluginForms,
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
const adminPluginForms = (config) => coreAdminPluginForms(registry, config);
const parseChannels = (input) => coreParseChannels(registry, input);
const resolveChannel = (channels, type) => coreResolveChannel(registry, channels, type);

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.btoa) globalThis.btoa = (value) => Buffer.from(value, 'binary').toString('base64');
if (!globalThis.atob) globalThis.atob = (value) => Buffer.from(value, 'base64').toString('binary');

/** 登录失败计数用的内存 D1 替身。 */
function memoryLoginDb() {
  const limits = new Map();
  return {
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
}

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

test('管理员登录请求体超限时在解析前拒绝', async () => {
  const request = new Request('https://pay.example/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(70 * 1024) },
    body: 'username=admin',
  });
  await assert.rejects(
    () => verifyAdminLogin(request, { ADMIN_USERNAME: 'admin', ADMIN_TOKEN: 'test-admin-token', DB: memoryLoginDb() }),
    /超过/u,
  );
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

test('第三方收款插件表单声明可从最近流水回填的实际编号字段', () => {
  const forms = adminPluginForms({});
  const fubei = forms.find((form) => form.code === 'fubei_receipt');
  const shouqianba = forms.find((form) => form.code === 'shouqianba_receipt');
  assert.deepEqual(fubei.receiptDiscovery.fields.map((field) => field.key), [
    'receipt_terminal_no', 'receipt_account_no',
  ]);
  assert.deepEqual(shouqianba.receiptDiscovery.fields.map((field) => field.key), [
    'receipt_account_no', 'receipt_store_id', 'receipt_terminal_no', 'receipt_page_id',
  ]);
  assert.match(
    shouqianba.fields.find((field) => field.key === 'receipt_terminal_no').help,
    /最近流水/u,
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

test('验证码答案不进 cookie：拿到 cookie 也读不出答案', async () => {
  const env = { ADMIN_USERNAME: 'admin', ADMIN_TOKEN: 'test-admin-token', DB: memoryLoginDb() };
  const response = await adminCaptchaResponse(env);
  const svg = await response.text();
  const code = [...svg.matchAll(/>([A-Z0-9])<\/text>/gu)].map((match) => match[1]).join('');
  const cookie = response.headers.get('set-cookie').split(';', 1)[0];
  const value = cookie.slice(cookie.indexOf('=') + 1);
  const payload = value.slice(0, value.lastIndexOf('.'));

  // 曾经这里放的是 base64 的 {"code":"6U7Y"}，浏览器里直接就能读出答案，
  // 验证码等于形同虚设。现在 payload 只有过期时间和随机盐。
  const decoded = Buffer.from(payload.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8');
  assert.doesNotMatch(decoded, /code/u);
  assert.doesNotMatch(decoded, new RegExp(code, 'u'));
  assert.match(decoded, /expires_at/u);
  assert.match(decoded, /salt/u);
  // 整段 cookie 里也不能明文出现答案。
  assert.ok(!value.includes(code));

  const login = (captcha) => new Request('https://pay.example/admin/login', {
    method: 'POST',
    headers: { cookie },
    body: new URLSearchParams({ username: 'admin', password: 'test-admin-token', captcha }).toString(),
  });
  assert.equal(await verifyLoginPassword(login(code), env), true);
  assert.equal(await verifyLoginPassword(login(code.toLowerCase()), env), true);
  assert.equal(await verifyLoginPassword(login('ZZZZ'), env), false);
});

test('验证码 cookie 被改过期时间即失效', async () => {
  const env = { ADMIN_USERNAME: 'admin', ADMIN_TOKEN: 'test-admin-token', DB: memoryLoginDb() };
  const response = await adminCaptchaResponse(env);
  const svg = await response.text();
  const code = [...svg.matchAll(/>([A-Z0-9])<\/text>/gu)].map((match) => match[1]).join('');
  const cookie = response.headers.get('set-cookie').split(';', 1)[0];
  const value = cookie.slice(cookie.indexOf('=') + 1);
  const payload = value.slice(0, value.lastIndexOf('.'));
  const proof = value.slice(value.lastIndexOf('.') + 1);

  // 证明同时绑定 payload 与答案，所以延长有效期也会让它对不上。
  const decoded = JSON.parse(Buffer.from(payload.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'));
  decoded.expires_at = Date.now() + 86_400_000;
  const forged = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  const request = new Request('https://pay.example/admin/login', {
    method: 'POST',
    headers: { cookie: `admin_captcha=${forged}.${proof}` },
    body: new URLSearchParams({ username: 'admin', password: 'test-admin-token', captcha: code }).toString(),
  });
  assert.equal(await verifyLoginPassword(request, env), false);
});

test('后台字段可以带默认值，密钥字段永远不给', async () => {
  // 像 USDT 主网合约、TronGrid 地址这种"几乎所有人都填同一个值"的字段，
  // 空输入框只会让人去翻文档。默认值直接填进框里，存过值的以存的为准。
  const { definePlugin } = await import('../src/plugin-api.js');
  const withDefaults = createPluginRegistry([definePlugin({
    manifest: {
      code: 'defaults_demo', name: '默认值演示', version: '1.0.0', apiVersion: 1,
      tier: 'PAID', mode: 'direct', runtime: 'direct', payTypes: ['bank'], required: [],
      adminFields: [
        { key: 'contract', label: '合约地址', type: 'text', defaultValue: 'TR7NHq' },
        { key: 'api_key', label: '密钥', type: 'password', secret: true, defaultValue: '不该出现' },
        { key: 'plain', label: '无默认值', type: 'text' },
      ],
    },
    createPayment() { return {}; },
  })]);
  const fieldsOf = (config) => {
    const form = coreAdminPluginForms(withDefaults, config).find((item) => item.code === 'defaults_demo');
    return new Map(form.fields.map((field) => [field.key, field.value]));
  };

  const untouched = fieldsOf({});
  assert.equal(untouched.get('contract'), 'TR7NHq', '没存过值时用默认值填框');
  assert.equal(untouched.get('api_key'), '', '密钥字段不能带出任何默认值');
  assert.equal(untouched.get('plain'), '', '没有默认值就还是空');

  const saved = fieldsOf({ defaults_demo: { contract: 'TOther' } });
  assert.equal(saved.get('contract'), 'TOther', '存过值就以存的为准，默认值不能盖掉');

  // 显式存成空字符串是"我就是要留空"，同样不该被默认值顶回来。
  assert.equal(fieldsOf({ defaults_demo: { contract: '' } }).get('contract'), '');
});
