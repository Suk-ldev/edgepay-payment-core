/**
 * 插件副本：同一个平台挂第二个账号。
 *
 * 关键行为是"两份配置彻底分家"——配置、通道、订单、轮询租约、流水去重都按副本
 * 编码各走各的；权益、Watcher 能力声明这些"这是哪个平台"的判断则一律折回基础编码。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.btoa) globalThis.btoa = (value) => Buffer.from(value, 'binary').toString('base64');
if (!globalThis.atob) globalThis.atob = (value) => Buffer.from(value, 'base64').toString('binary');

const {
  basePluginCode, isPluginInstanceCode, nextInstanceSequence, pluginInstanceCode, pluginInstanceSequence,
} = await import('../src/plugin-instances.js');
const {
  adminPluginForms, configForPlugin, missingPluginFields, pluginCodesWithInstances, pluginDisplayName,
  pluginEnabled, publicPluginList,
} = await import('../src/core/plugin-config.js');
const { parseChannels, resolveChannel, weightedChannel } = await import('../src/channels.js');
const { createPluginRegistry, freePlugins } = await import('../src/index.js');
const { createAdminSession } = await import('../src/admin-auth.js');
const { encryptSetting, decryptSetting } = await import('../src/runtime-settings.js');
const { hmacSha256Base64 } = await import('../src/receipt-plugins.js');
const { createTestWorker } = await import('./helpers/worker.mjs');

const registry = createPluginRegistry([...freePlugins]);

test('副本编码在基础编码之外，两者永远不会撞车', () => {
  assert.equal(isPluginInstanceCode('wxpay_receipt'), false);
  assert.equal(isPluginInstanceCode('wxpay_receipt~2'), true);
  assert.equal(isPluginInstanceCode('wxpay_receipt~1'), false, '1 号就是基础插件自己');
  assert.equal(isPluginInstanceCode('wxpay_receipt~0'), false);
  assert.equal(isPluginInstanceCode('wxpay_receipt~100'), false);

  assert.equal(basePluginCode('wxpay_receipt~7'), 'wxpay_receipt');
  assert.equal(basePluginCode('wxpay_receipt'), 'wxpay_receipt');
  assert.equal(pluginInstanceSequence('wxpay_receipt~7'), 7);
  assert.equal(pluginInstanceSequence('wxpay_receipt'), 1);
  assert.equal(pluginInstanceCode('wxpay_receipt', 3), 'wxpay_receipt~3');
  assert.throws(() => pluginInstanceCode('wxpay_receipt', 1), /副本序号/u);
});

test('删掉中间的副本后，号会被重新用上', () => {
  const existing = ['wxpay_receipt', 'wxpay_receipt~2', 'wxpay_receipt~4', 'alipay_receipt~2'];
  assert.equal(nextInstanceSequence('wxpay_receipt', existing), 3);
  assert.equal(nextInstanceSequence('alipay_receipt', existing), 3);
  assert.equal(nextInstanceSequence('fubei_receipt', existing), 2);
});

test('注册表按副本编码返回同一个插件的视图，生命周期方法照旧', () => {
  const base = registry.get('fubei_receipt');
  const instance = registry.get('fubei_receipt~2');

  assert.equal(instance.manifest.code, 'fubei_receipt~2');
  assert.equal(instance.manifest.baseCode, 'fubei_receipt');
  assert.equal(instance.manifest.instanceSequence, 2);
  assert.equal(instance.manifest.name, `${base.manifest.name} 2`);
  assert.deepEqual([...instance.manifest.payTypes], [...base.manifest.payTypes]);
  assert.equal(instance.pollReceipts, base.pollReceipts, '副本调的是同一段实现');
  assert.equal(registry.get('fubei_receipt~2'), instance, '同一个副本编码必须拿到同一个对象');

  assert.equal(registry.has('fubei_receipt~2'), true);
  assert.equal(registry.hasBase('fubei_receipt~2'), false, 'Watcher 能力与权益只认基础编码');
  assert.equal(registry.hasBase('fubei_receipt'), true);
  assert.equal(registry.get('not_a_plugin~2'), null);
  assert.deepEqual(registry.codes().includes('fubei_receipt~2'), false, '注册表本身不含副本');
});

test('两份配置各管各的：副本缺配置不会连累基础插件', () => {
  const config = {
    wxpay_receipt: {
      sms_forwarder_secret: 'base-secret',
      receipt_qrcode_image: 'data:image/png;base64,AAA',
    },
    'wxpay_receipt~2': { instance_name: '微信个人 · 个人号' },
  };

  assert.deepEqual(missingPluginFields(registry, config, 'wxpay_receipt'), []);
  assert.deepEqual(
    missingPluginFields(registry, config, 'wxpay_receipt~2'),
    ['sms_forwarder_secret', 'receipt_qrcode_image'],
  );
  assert.equal(pluginEnabled(registry, config, 'wxpay_receipt'), true);
  assert.equal(pluginEnabled(registry, config, 'wxpay_receipt~2'), false);
  assert.equal(configForPlugin(config, 'wxpay_receipt~2').sms_forwarder_secret, undefined);
});

test('管理台列表把副本排在它的基础插件后面，并用管理员起的名字', () => {
  const config = {
    'wxpay_receipt~2': { instance_name: '微信个人 · 个人号' },
    'wxpay_receipt~3': {},
    not_a_plugin_at_all: { instance_name: '忽略我' },
  };
  const codes = pluginCodesWithInstances(registry, config);

  assert.deepEqual(
    codes.slice(codes.indexOf('wxpay_receipt'), codes.indexOf('wxpay_receipt') + 3),
    ['wxpay_receipt', 'wxpay_receipt~2', 'wxpay_receipt~3'],
  );
  assert.equal(codes.includes('not_a_plugin_at_all'), false);

  assert.equal(pluginDisplayName(registry, config, 'wxpay_receipt~2'), '微信个人 · 个人号');
  assert.equal(pluginDisplayName(registry, config, 'wxpay_receipt~3'), '微信个人收款监听 3');

  const listed = publicPluginList(registry, config).find((plugin) => plugin.code === 'wxpay_receipt~2');
  assert.equal(listed.name, '微信个人 · 个人号');
  assert.equal(listed.base_code, 'wxpay_receipt');
  assert.equal(listed.instance_sequence, 2);
  assert.deepEqual([...listed.payTypes], ['wxpay']);

  const form = adminPluginForms(registry, config).find((item) => item.code === 'wxpay_receipt~2');
  assert.equal(form.instance_name, '微信个人 · 个人号');
  assert.equal(form.fields.some((field) => field.key === 'sms_forwarder_secret'), true);

  const untouched = publicPluginList(registry, {}).filter((plugin) => plugin.code.includes('~'));
  assert.deepEqual(untouched, [], '没建过副本时列表里不该凭空多出账号位');
});

test('两个账号各一条通道，按权重分流', () => {
  const channels = parseChannels(registry, [
    { id: 1, name: '微信个人 · 商业号', plugin_code: 'wxpay_receipt', pay_types: ['wxpay'], weight: 70 },
    { id: 2, name: '微信个人 · 个人号', plugin_code: 'wxpay_receipt~2', pay_types: ['wxpay'], weight: 30 },
  ]);

  assert.equal(channels.length, 2);
  assert.equal(channels[1].plugin_code, 'wxpay_receipt~2');

  // 按支付方式路由时两条通道都是候选，权重决定各自的份额。
  assert.equal(weightedChannel(channels, 0.5).id, 1);
  assert.equal(weightedChannel(channels, 0.8).id, 2);

  // 直接点名基础插件编码时，副本的通道同样参与——上游只想走"微信个人收款"。
  assert.equal(resolveChannel(registry, channels, 'wxpay_receipt').plugin_code.startsWith('wxpay_receipt'), true);
  // 点名副本编码则只走那一个账号。
  assert.equal(resolveChannel(registry, channels, 'wxpay_receipt~2').id, 2);
});

class MemoryDatabase {
  constructor() {
    this.settings = new Map();
    this.payments = [];
  }

  prepare(sql) {
    const database = this;
    const text = sql.replace(/\s+/gu, ' ').trim();
    return {
      values: [],
      bind(...values) { this.values = values; return this; },
      async first() {
        if (!text.includes('runtime_settings')) return null;
        const value = database.settings.get(String(this.values[0]));
        return value === undefined ? null : { value_text: value };
      },
      async all() { return { results: [] }; },
      async run() {
        if (text.includes('INTO runtime_settings')) {
          database.settings.set(String(this.values[0]), String(this.values[1]));
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    };
  }
}

// 加密配置在 isolate 内按 setting+密钥缓存，同一把密钥会让相邻用例互相看见对方的配置。
let configKeySequence = 0;

async function fixture() {
  const worker = createTestWorker();
  configKeySequence += 1;
  const configKey = `plugin-instance-config-key-${configKeySequence}`;
  const env = {
    ADMIN_TOKEN: 'plugin-instance-admin-token',
    ADMIN_USERNAME: 'admin',
    CONFIG_ENCRYPTION_KEY: configKey,
    DB: new MemoryDatabase(),
  };
  const cookie = (await createAdminSession(env)).split(';', 1)[0];
  const call = (path, init = {}) => worker.fetch(new Request(`https://pay.example${path}`, {
    ...init,
    headers: {
      cookie,
      ...(init.body ? { origin: 'https://pay.example', 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  }), env, { waitUntil() {} });
  const storedConfig = () => {
    const stored = env.DB.settings.get('plugin_config');
    return stored ? decryptSetting(stored, configKey, 'plugin_config') : {};
  };
  const seedConfig = async (config) => {
    await env.DB.prepare('INSERT INTO runtime_settings')
      .bind('plugin_config', await encryptSetting(config, configKey, 'plugin_config'))
      .run();
  };
  return { env, call, configKey, storedConfig, seedConfig };
}

function storedChannels(env) {
  return JSON.parse(env.DB.settings.get('channels') ?? '[]');
}

test('复制插件建出副本与它自己的通道，两者都先停用', async () => {
  const { env, call, storedConfig, seedConfig } = await fixture();
  await seedConfig({
    wxpay_receipt: { sms_forwarder_secret: 'base-secret', receipt_qrcode_image: 'data:image/png;base64,AAA' },
  });

  const response = await call('/admin/api/plugins/duplicate', {
    method: 'POST',
    body: JSON.stringify({
      plugin_code: 'wxpay_receipt',
      name: '微信个人 · 个人号',
      channel: { pay_type: 'wxpay', weight: 30 },
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.plugin_code, 'wxpay_receipt~2');
  assert.equal(payload.channel.plugin_code, 'wxpay_receipt~2');
  assert.equal(payload.channel.weight, 30);
  assert.equal(payload.channel.enabled, false, '配置还没填就先别接单');

  const config = await storedConfig();
  assert.equal(config['wxpay_receipt~2'].instance_name, '微信个人 · 个人号');
  assert.equal(config['wxpay_receipt~2'].enabled, false);
  assert.equal(
    config['wxpay_receipt~2'].sms_forwarder_secret,
    undefined,
    '默认不复制配置，两个账号不该共用同一把投递密钥',
  );
  assert.equal(config.wxpay_receipt.sms_forwarder_secret, 'base-secret', '原插件的配置不受影响');
  assert.equal(storedChannels(env).length, 1);

  // 再复制一次拿到 3 号，且原有副本不受影响。
  const second = await call('/admin/api/plugins/duplicate', {
    method: 'POST',
    body: JSON.stringify({ plugin_code: 'wxpay_receipt~2', name: '微信个人 · 备用' }),
  });
  assert.equal((await second.json()).plugin_code, 'wxpay_receipt~3');
});

test('勾选复制配置时也不会带走密钥和收款码', async () => {
  const { call, storedConfig, seedConfig } = await fixture();
  await seedConfig({
    fubei_receipt: {
      watcher_username: 'shop-account',
      watcher_password: 'shop-password',
      receipt_qrcode_image: 'data:image/png;base64,AAA',
    },
  });

  await call('/admin/api/plugins/duplicate', {
    method: 'POST',
    body: JSON.stringify({ plugin_code: 'fubei_receipt', name: '付呗 · 二号店', copy_config: true }),
  });

  const copied = (await storedConfig())['fubei_receipt~2'];
  assert.equal(copied.watcher_username, 'shop-account', '非密钥字段可以省一次填写');
  assert.equal(copied.watcher_password, undefined);
  assert.equal(copied.receipt_qrcode_image, undefined, '收款码必须换成另一个账号自己的');
});

test('副本可以单独改名、单独配置，改名不碰基础插件', async () => {
  const { call, storedConfig } = await fixture();
  await call('/admin/api/plugins/duplicate', {
    method: 'POST',
    body: JSON.stringify({ plugin_code: 'wxpay_receipt', name: '微信个人 2' }),
  });

  const renamed = await call('/admin/api/plugins', {
    method: 'PUT',
    body: JSON.stringify({
      plugin_code: 'wxpay_receipt~2',
      instance_name: '微信个人 · 个人号',
      values: { sms_forwarder_secret: 'copy-secret' },
    }),
  });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).form.name, '微信个人 · 个人号');

  const config = await storedConfig();
  assert.equal(config['wxpay_receipt~2'].sms_forwarder_secret, 'copy-secret');
  assert.equal(config.wxpay_receipt?.sms_forwarder_secret, undefined);

  const baseRename = await call('/admin/api/plugins', {
    method: 'PUT',
    body: JSON.stringify({ plugin_code: 'wxpay_receipt', instance_name: '想改基础插件的名字' }),
  });
  assert.equal(baseRename.status, 400);
  assert.match((await baseRename.json()).error, /只有插件副本可以改名/u);
});

test('没建过的副本既不能保存配置，也不能被通道指过去', async () => {
  const { call } = await fixture();

  const save = await call('/admin/api/plugins', {
    method: 'PUT',
    body: JSON.stringify({ plugin_code: 'wxpay_receipt~5', values: { sms_forwarder_secret: 'x' } }),
  });
  assert.equal(save.status, 400);
  assert.match((await save.json()).error, /副本不存在/u);

  const channels = await call('/admin/api/channels', {
    method: 'PUT',
    body: JSON.stringify({
      channels: [{ id: 1, name: '凭空的通道', plugin_code: 'wxpay_receipt~5', pay_types: ['wxpay'], weight: 100 }],
    }),
  });
  assert.equal(channels.status, 400);
  assert.match((await channels.json()).error, /副本不存在/u);
});

test('删除副本连同它的通道一起删，基础插件删不掉', async () => {
  const { env, call, storedConfig } = await fixture();
  await call('/admin/api/plugins/duplicate', {
    method: 'POST',
    body: JSON.stringify({
      plugin_code: 'wxpay_receipt',
      name: '微信个人 · 个人号',
      channel: { pay_type: 'wxpay', weight: 30 },
    }),
  });
  assert.equal(storedChannels(env).length, 1);

  const removed = await call('/admin/api/plugins/wxpay_receipt~2', {
    method: 'DELETE',
    body: JSON.stringify({ confirm: true }),
  });
  const payload = await removed.json();
  assert.equal(removed.status, 200);
  assert.deepEqual(payload.removed_channels, [1]);
  assert.equal(storedChannels(env).length, 0);
  assert.equal('wxpay_receipt~2' in (await storedConfig()), false);

  const base = await call('/admin/api/plugins/wxpay_receipt', {
    method: 'DELETE',
    body: JSON.stringify({ confirm: true }),
  });
  // 删除路由的正则只认副本编码，基础插件连路由都匹配不上（落到静态资源兜底的 405）。
  assert.equal(base.status, 405);
  assert.equal('wxpay_receipt' in (await storedConfig()), false);
});

test('告警指名道姓说是哪条通道，两个账号各报各的', async () => {
  // 出事时要找的是通道，不是插件编码。两台监听器用同一个 event 名的话，第二条会被
  // 第一条的静默期吞掉——人只会看到一条告警，还不知道说的是哪个微信。
  const { env, call, configKey } = await fixture();
  await call('/admin/api/plugins/duplicate', {
    method: 'POST',
    body: JSON.stringify({
      plugin_code: 'wxpay_receipt',
      name: '微信个人 · 个人号',
      channel: { pay_type: 'wxpay', weight: 30 },
    }),
  });
  // 基础配置也来一条通道，凑齐"两个账号两条通道"。
  const channels = JSON.parse(env.DB.settings.get('channels'));
  channels.push({
    id: 8, name: '微信个人 · 商业号', plugin_code: 'wxpay_receipt', pay_types: ['wxpay'], weight: 70, sort: 9,
  });
  env.DB.settings.set('channels', JSON.stringify(channels));

  env.WATCHER_TRANSPORT_SECRET = 'alert-transport-secret';
  await env.DB.prepare('INSERT INTO runtime_settings').bind(
    'alert_config',
    await encryptSetting(
      { enabled: true, provider: 'webhook', url: 'https://hook.example/push', min_interval_seconds: 600 },
      configKey,
      'alert_config',
    ),
  ).run();

  const pushed = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    pushed.push(JSON.parse(init.body));
    return new Response('ok', { status: 200 });
  };
  try {
    const report = async (channelId) => {
      const body = JSON.stringify({
        event: 'yyb_login_expired:wxpay_receipt',
        level: 'critical',
        title: '应用宝协议监听掉登录',
        message: '登录态已失效。',
        channel_id: channelId,
      });
      const timestamp = String(Math.floor(Date.now() / 1_000));
      const path = '/api/watcher/alert';
      const signature = await hmacSha256Base64(env.WATCHER_TRANSPORT_SECRET, `${timestamp}.POST.${path}.${body}`);
      const response = await call(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-watcher-timestamp': timestamp,
          'x-watcher-signature': `v1=${signature}`,
        },
        body,
      });
      return response.json();
    };

    const first = await report(1);   // 副本那条通道
    const second = await report(8);  // 基础配置那条通道

    assert.equal(first.sent, true);
    assert.equal(second.sent, true, '两条通道必须各推一条，不能被静默期吞掉');
    assert.notEqual(first.event, second.event);
    assert.match(first.event, /:ch1$/u);
    assert.match(second.event, /:ch8$/u);

    // 正文开头就要说清是哪条通道：推到手机上只看得见前几行。
    assert.match(pushed[0].text ?? pushed[0].content ?? JSON.stringify(pushed[0]), /#1/u);
    const firstBody = JSON.stringify(pushed[0]);
    assert.match(firstBody, /微信个人 · 个人号/u);
    assert.match(firstBody, /配置 1/u);
    const secondBody = JSON.stringify(pushed[1]);
    assert.match(secondBody, /微信个人 · 商业号/u);
    assert.match(secondBody, /配置 0/u);
  } finally {
    globalThis.fetch = realFetch;
  }
});
