/**
 * 插件注册器。核心层通过它按编码取插件，不再出现 `if (code === 'stripe_api')`。
 *
 * 注册表在 Worker 模块初始化时构建一次：编码重复、接口版本不符都在这里直接抛错，
 * 让构建产物在第一次请求之前就暴露问题，而不是在某条支付链路上才崩。
 *
 * 副本编码（`wxpay_receipt~2`）也从这里取：注册表按基础编码找到插件，再套一层
 * 只改 manifest.code / name 的视图返回。核心层其它地方一律用 `plugin.manifest.code`
 * 作配置键、订单插件列、租约键和流水去重源，所以拿到视图之后两个账号就自然分开了。
 */

import { PLUGIN_API_VERSION, PLUGIN_HOOKS, pluginMissingFields, unsupportedHook } from '../plugin-api.js';
import {
  basePluginCode, defaultInstanceName, isPluginInstanceCode, pluginInstanceSequence,
} from '../plugin-instances.js';

export function createPluginRegistry(plugins) {
  if (!Array.isArray(plugins)) throw new Error('插件列表必须是数组');
  const registry = new Map();

  for (const plugin of plugins) {
    const manifest = plugin?.manifest;
    if (!manifest?.code) throw new Error('插件缺少 manifest.code，可能未经 definePlugin 定义');
    if (manifest.apiVersion !== PLUGIN_API_VERSION) {
      throw new Error(`插件 ${manifest.code} 接口版本 ${manifest.apiVersion} 与核心 ${PLUGIN_API_VERSION} 不兼容`);
    }
    if (registry.has(manifest.code)) throw new Error(`插件编码重复：${manifest.code}`);
    registry.set(manifest.code, plugin);
  }

  const list = Object.freeze([...registry.values()]);
  const manifests = Object.freeze(list.map((plugin) => plugin.manifest));
  // 副本视图缓存。同一个副本编码必须始终拿到同一个对象，否则调用点之间的
  // `plugin === plugin` 比较和 WeakMap 缓存会失效。
  const instances = new Map();

  /**
   * 副本视图。生命周期方法直接复用基础插件的实现——它们只认上下文里的 config，
   * 不认编码，所以两份配置调的是同一段代码。
   */
  function instanceView(base, instanceCode) {
    const cached = instances.get(instanceCode);
    if (cached) return cached;
    const sequence = pluginInstanceSequence(instanceCode);
    const view = { manifest: null };
    for (const hook of PLUGIN_HOOKS) {
      if (typeof base[hook] === 'function') view[hook] = base[hook];
    }
    view.manifest = Object.freeze({
      ...base.manifest,
      code: instanceCode,
      // 授权、Docker Watcher 能力声明、插件目录这些"这是哪个平台"的判断都看它。
      baseCode: base.manifest.code,
      name: defaultInstanceName(base.manifest.name, sequence),
      instanceSequence: sequence,
    });
    const frozen = Object.freeze(view);
    instances.set(instanceCode, frozen);
    return frozen;
  }

  function resolve(code) {
    const text = String(code ?? '');
    const direct = registry.get(text);
    if (direct) return direct;
    if (!isPluginInstanceCode(text)) return null;
    const base = registry.get(basePluginCode(text));
    return base ? instanceView(base, text) : null;
  }

  return Object.freeze({
    get(code) {
      return resolve(code) ?? null;
    },

    /** 取插件；不存在就抛错。用于"编码来自 D1 通道或回调 URL"的路径。 */
    require(code) {
      const plugin = resolve(code);
      if (!plugin) throw new Error(`插件不存在或未包含在当前构建中：${code}`);
      return plugin;
    },

    /** 取插件并确认它实现了某个生命周期方法。 */
    requireHook(code, hook) {
      const plugin = this.require(code);
      if (typeof plugin[hook] !== 'function') throw unsupportedHook(plugin, hook);
      return plugin;
    },

    has(code) {
      return Boolean(resolve(code));
    },

    /** 只认基础插件。Docker Watcher 声明能力、License 权益比对都走它。 */
    hasBase(code) {
      return registry.has(String(code ?? ''));
    },

    list() {
      return list;
    },

    manifests() {
      return manifests;
    },

    codes() {
      return manifests.map((manifest) => manifest.code);
    },

    /** 某个插件缺少哪些必填配置。 */
    missingFields(code, config) {
      const plugin = resolve(code);
      return plugin ? pluginMissingFields(plugin, config ?? {}) : [];
    },
  });
}
