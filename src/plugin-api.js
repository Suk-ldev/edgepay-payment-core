/**
 * Payment 插件公开接口。核心层只认这个契约，不认具体插件编码。
 *
 * 免费插件随本仓库公开；付费插件在私有商业仓库里实现同一份契约，由私有 CI
 * 编译成独立模块，部署时按 License 权益挑选后与核心一起上传。因此这里的任何
 * 改动都是跨仓库的 ABI 变更，必须同步抬升 PLUGIN_API_VERSION。
 */

export const PLUGIN_API_VERSION = 1;

export const PLUGIN_TIERS = Object.freeze(['FREE', 'PAID']);
export const PLUGIN_MODES = Object.freeze(['direct', 'channel-notify']);
// direct=渠道直连；self=自监听（短信转发）；hybrid=Worker 可直查，Docker 在线时优先；
// docker=只能由 Docker Watcher 查询，Worker 侧仅有清单与配置表单。
export const PLUGIN_RUNTIMES = Object.freeze(['direct', 'self', 'hybrid', 'docker']);

// 收款通知从哪来。sms_forwarder 与 watcher 两条链路都是通用实现，留在公开核心，
// 插件只声明用哪条；真正有平台差异的地方才去覆盖 prepareReceipt / pollReceipts。
export const RECEIPT_SOURCES = Object.freeze(['watcher', 'sms_forwarder']);

// 回调正文怎么解析。auto 按 content-type 自动识别表单/JSON/查询串；xml 是微信 V2 那种固定 XML。
export const CALLBACK_FORMATS = Object.freeze(['auto', 'xml']);

/** 插件可实现的生命周期方法。未实现的方法由核心层给出明确错误，不做静默降级。 */
export const PLUGIN_HOOKS = Object.freeze([
  // mode=direct：渠道直连支付
  'createPayment',
  'handleCallback',
  'handleReturn',
  'queryPayment',
  'refundPayment',
  'refundCapability',
  // mode=channel-notify：收款码/流水监听
  'prepareReceipt',
  'matchReceipt',
  'pollReceipts',
  'canPollReceipts',
  // 通用
  'callbackResponse',
  'testChannel',
  'missingFields',
]);

const CODE_RE = /^[a-z][a-z0-9_]*$/u;
const VERSION_RE = /^\d+\.\d+\.\d+$/u;

function fail(message) {
  throw new Error(`插件定义无效：${message}`);
}

function assertText(value, field, pattern = null) {
  const text = String(value ?? '').trim();
  if (!text) fail(`${field} 不能为空`);
  if (pattern && !pattern.test(text)) fail(`${field} 格式不合法：${text}`);
  return text;
}

function assertEnum(value, field, allowed) {
  const text = String(value ?? '').trim();
  if (!allowed.includes(text)) fail(`${field} 只能是 ${allowed.join(' / ')}，收到 ${text || '空值'}`);
  return text;
}

function assertStringArray(value, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) fail(`${field} 必须是数组`);
  const values = value.map((item) => String(item ?? '').trim());
  if (values.some((item) => !item)) fail(`${field} 不能包含空字符串`);
  if (!allowEmpty && !values.length) fail(`${field} 不能为空数组`);
  return Object.freeze(values);
}

/**
 * Worker 轮询的节奏参数。以前这些按插件编码硬编码在轮询器里
 * （付呗租约 90 秒、USDT 冷却 10 秒且不存登录态），现在由插件自己声明。
 */
function assertPoll(value) {
  const input = value ?? {};
  if (typeof input !== 'object' || Array.isArray(input)) fail('manifest.poll 必须是对象');
  const leaseSeconds = Number(input.leaseSeconds ?? 60);
  const cooldownSeconds = Number(input.cooldownSeconds ?? 5);
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > 600) {
    fail(`manifest.poll.leaseSeconds 必须是 10~600 之间的整数，收到 ${input.leaseSeconds}`);
  }
  if (!Number.isSafeInteger(cooldownSeconds) || cooldownSeconds < 0 || cooldownSeconds > 600) {
    fail(`manifest.poll.cooldownSeconds 必须是 0~600 之间的整数，收到 ${input.cooldownSeconds}`);
  }
  return Object.freeze({
    leaseSeconds,
    cooldownSeconds,
    // 无登录态可存的插件（例如只读公链的 USDT）设为 true，省掉每轮的加解密读写。
    stateless: Boolean(input.stateless ?? false),
  });
}

function assertExpireMinutes(value) {
  const minutes = Number(value);
  if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > 1440) {
    fail(`manifest.defaultExpireMinutes 必须是 0~1440 之间的整数，收到 ${value}`);
  }
  return minutes;
}

function assertGrace(value) {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 86_400) {
    fail(`manifest.receiptGraceSeconds 必须是 0~86400 之间的整数，收到 ${value}`);
  }
  return seconds;
}

function assertAdminFields(value) {
  if (!Array.isArray(value)) fail('manifest.adminFields 必须是数组');
  const keys = new Set();
  for (const field of value) {
    if (!field || typeof field !== 'object') fail('manifest.adminFields 元素必须是对象');
    const key = assertText(field.key, 'adminFields[].key');
    if (keys.has(key)) fail(`adminFields 字段重复：${key}`);
    keys.add(key);
    assertText(field.label, `adminFields[${key}].label`);
    assertText(field.type, `adminFields[${key}].type`);
  }
  return Object.freeze(value.map((field) => Object.freeze({ ...field })));
}

/**
 * 校验并冻结一份插件清单。清单是公开信息（编码、名称、支付方式、配置字段），
 * 不包含任何平台实现细节。
 */
export function definePluginManifest(input) {
  if (!input || typeof input !== 'object') fail('manifest 必须是对象');
  const manifest = {
    code: assertText(input.code, 'manifest.code', CODE_RE),
    name: assertText(input.name, 'manifest.name'),
    version: assertText(input.version, 'manifest.version', VERSION_RE),
    apiVersion: Number(input.apiVersion),
    tier: assertEnum(input.tier, 'manifest.tier', PLUGIN_TIERS),
    mode: assertEnum(input.mode, 'manifest.mode', PLUGIN_MODES),
    runtime: assertEnum(input.runtime, 'manifest.runtime', PLUGIN_RUNTIMES),
    payTypes: assertStringArray(input.payTypes, 'manifest.payTypes', { allowEmpty: false }),
    required: assertStringArray(input.required ?? [], 'manifest.required'),
    adminFields: assertAdminFields(input.adminFields ?? []),
    // 该插件的运营配置文档（HTML 片段）。跟着插件走，不随公开核心分发给所有人——
    // 付费插件的文档会点名平台接口与登录方式，属于实现细节。
    docs: String(input.docs ?? ''),
    receiptSource: assertEnum(input.receiptSource ?? 'watcher', 'manifest.receiptSource', RECEIPT_SOURCES),
    // 到账确认允许晚于订单过期多久。链上转账需要等区块确认，所以 USDT 之类的插件
    // 会声明一段宽限期，在这段时间内仍然可以把 EXPIRED 订单改成 PAID。
    receiptGraceSeconds: assertGrace(input.receiptGraceSeconds ?? 0),
    // 流水事件在报错信息里的称呼，例如"USDT 流水 txid"。
    receiptEventLabel: String(input.receiptEventLabel ?? '流水'),
    poll: assertPoll(input.poll),
    // 该插件的通道默认订单有效期（分钟）。0 表示跟随站点设置。
    // 链上转账要等确认，默认给得比常规收款码短，避免地址金额长时间被占住。
    defaultExpireMinutes: assertExpireMinutes(input.defaultExpireMinutes ?? 0),
    // 下单前需要先把用户跳去渠道做一次网页授权（微信 JSAPI 的 openid 就是这么来的），
    // 核心会为此签发一枚带签名的 state，回跳时校验后再继续下单。
    needsOauthState: Boolean(input.needsOauthState ?? false),
    // 回调正文格式。绝大多数渠道是表单或 JSON，自动识别即可；微信 V2 固定是 XML。
    callbackFormat: assertEnum(input.callbackFormat ?? 'auto', 'manifest.callbackFormat', CALLBACK_FORMATS),
    // 回调金额必须与订单金额完全一致才算数。渠道可能按外币结算，所以默认不开。
    verifyCallbackAmount: Boolean(input.verifyCallbackAmount ?? false),
    note: String(input.note ?? ''),
  };
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    fail(`${manifest.code} 声明的接口版本 ${input.apiVersion} 与当前 ${PLUGIN_API_VERSION} 不兼容`);
  }
  return Object.freeze(manifest);
}

/**
 * 定义一个插件。只保留 manifest 与 PLUGIN_HOOKS 中声明过的方法，
 * 避免插件往核心层塞入未约定的接口。
 */
export function definePlugin(input) {
  if (!input || typeof input !== 'object') fail('插件必须是对象');
  const manifest = definePluginManifest(input.manifest);
  const plugin = { manifest };
  for (const hook of PLUGIN_HOOKS) {
    if (input[hook] === undefined) continue;
    if (typeof input[hook] !== 'function') fail(`${manifest.code}.${hook} 必须是函数`);
    plugin[hook] = input[hook];
  }
  if (manifest.mode === 'direct' && !plugin.createPayment) {
    fail(`${manifest.code} 声明 mode=direct，必须实现 createPayment`);
  }
  if (manifest.mode === 'direct' && manifest.receiptSource === 'sms_forwarder') {
    fail(`${manifest.code} 是渠道直连插件，不能声明 receiptSource=sms_forwarder`);
  }
  if (manifest.mode === 'direct' && manifest.receiptGraceSeconds > 0) {
    fail(`${manifest.code} 是渠道直连插件，不应声明 receiptGraceSeconds`);
  }
  if (plugin.canPollReceipts && !plugin.pollReceipts) {
    fail(`${manifest.code} 声明了 canPollReceipts，却没有实现 pollReceipts`);
  }
  if (manifest.runtime === 'docker' && plugin.pollReceipts) {
    fail(`${manifest.code} 声明 runtime=docker，不应实现 pollReceipts`);
  }
  return Object.freeze(plugin);
}

/** 插件缺少哪些必填配置。插件可用 missingFields 覆盖（例如填了 Token 就不再要求账号密码）。 */
export function pluginMissingFields(plugin, config = {}) {
  if (plugin.missingFields) {
    return assertStringArray(plugin.missingFields(config) ?? [], `${plugin.manifest.code}.missingFields() 返回值`);
  }
  return plugin.manifest.required.filter((field) => !config[field]);
}

/** 插件未实现某个生命周期方法时的统一错误，便于上层区分"没买"和"不支持"。 */
export function unsupportedHook(plugin, hook) {
  return Object.assign(
    new Error(`${plugin.manifest.name}不支持${HOOK_LABELS[hook] ?? hook}`),
    { code: 'plugin_hook_unsupported', pluginCode: plugin.manifest.code, hook },
  );
}

const HOOK_LABELS = Object.freeze({
  createPayment: '下单',
  handleCallback: '支付回调',
  handleReturn: '同步返回',
  queryPayment: '主动查询',
  refundPayment: '退款',
  refundCapability: '退款能力声明',
  prepareReceipt: '收款码展示',
  matchReceipt: '流水匹配',
  pollReceipts: 'Worker 轮询',
  callbackResponse: '回调应答',
  testChannel: '通道测试',
});

/**
 * 这个插件此刻能否由 Worker 自己轮询流水。
 * 部分插件要先填平台 Token 或 Cookie，否则只能交给 Docker Watcher。
 */
export function pluginSupportsWorkerPoll(plugin, config = {}) {
  if (!plugin?.pollReceipts) return false;
  return plugin.canPollReceipts ? Boolean(plugin.canPollReceipts(config)) : true;
}
