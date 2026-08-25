/**
 * EdgePay Payment Core 的包入口。
 *
 * 注意这里**没有** `export default { fetch, scheduled }`：本仓库只导出一个工厂，
 * 必须由私有商业入口注入付费插件与 License Gate 才能得到可部署的 Worker。
 * 这就是"公开源码但不可独立部署"的落点，不要在这里补上默认导出。
 */

export { createPaymentWorker, DEFAULT_BUILD_INFO } from './core/create-worker.js';
export { createPluginRegistry } from './core/plugin-registry.js';
export { pluginHelpers } from './core/plugin-context.js';
export { RUNTIME_KEY, runtimeOf } from './core/runtime-env.js';
export { freePlugins, FREE_PLUGIN_CODES } from './free-plugins/index.js';
export {
  PLUGIN_API_VERSION, definePlugin, definePluginManifest, pluginMissingFields,
  pluginSupportsWorkerPoll, unsupportedHook,
} from './plugin-api.js';

// 少数模块被测试直接引用，保持可达。
export { normalizeSiteConfig, publicEndpointUrl, contactPublicConfig, isCashierShellPath, receiptPollResponse } from './core/request-router.js';
