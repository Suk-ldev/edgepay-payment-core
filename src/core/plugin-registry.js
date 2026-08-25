/**
 * 插件注册器。核心层通过它按编码取插件，不再出现 `if (code === 'stripe_api')`。
 *
 * 注册表在 Worker 模块初始化时构建一次：编码重复、接口版本不符都在这里直接抛错，
 * 让构建产物在第一次请求之前就暴露问题，而不是在某条支付链路上才崩。
 */

import { PLUGIN_API_VERSION, pluginMissingFields, unsupportedHook } from '../plugin-api.js';

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

  return Object.freeze({
    get(code) {
      return registry.get(String(code ?? '')) ?? null;
    },

    /** 取插件；不存在就抛错。用于"编码来自 D1 通道或回调 URL"的路径。 */
    require(code) {
      const plugin = registry.get(String(code ?? ''));
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
      const plugin = registry.get(String(code ?? ''));
      return plugin ? pluginMissingFields(plugin, config ?? {}) : [];
    },
  });
}
