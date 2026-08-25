/**
 * Payment Worker 工厂。
 *
 * 公开仓库只导出这个工厂，不导出 `export default { fetch, scheduled }`，
 * 所以单靠本仓库的源码构建不出可部署的 Worker——必须由私有商业入口
 * 注入付费插件与 License Gate。这是"公开源码但不可独立部署"的实现方式。
 */

import { createPluginRegistry } from './plugin-registry.js';
import { createHandlers } from './request-router.js';
import { PLUGIN_API_VERSION } from '../plugin-api.js';

/** 没有 License Gate 时的默认授权：只放行免费插件。 */
function freeOnlyAuthorize({ plugin }) {
  if (plugin.manifest.tier === 'FREE') return;
  throw Object.assign(
    new Error(`${plugin.manifest.name}是付费插件，当前构建没有装载授权模块`),
    { status: 403, code: 'plugin_not_licensed' },
  );
}

/** 没有 License 客户端时的默认状态：免费可用，付费一律未授权。 */
const freeOnlyLicense = Object.freeze({
  async state(_env, registry) {
    return {
      licensed: false,
      domain: '',
      plugins: registry.manifests().filter((m) => m.tier === 'FREE').map((m) => m.code),
      entitlementVersion: 0,
    };
  },
  async attest() {
    throw Object.assign(new Error('当前构建不支持 License 在线证明'), { status: 501 });
  },
  async grantEnvelope() {
    return null;
  },
  async packageBaseUrl() {
    return '';
  },
});

export const DEFAULT_BUILD_INFO = Object.freeze({
  release: '0.0.0-dev',
  buildId: 'dev',
  coreSha: '',
  commercialSha: '',
  pluginApiVersion: PLUGIN_API_VERSION,
  licenseProtocol: 'none',
  // 核心包里固定带的插件（免费插件）。付费插件是部署时按权益拼装的，
  // 每个客户装到的都不一样，所以不在这里声明、也不参与下面的完整性校验。
  corePlugins: [],
});

/**
 * @param plugins        免费插件 + 本次构建装载的付费插件
 * @param authorizePlugin 每次插件调用前的授权门，由私有 License Gate 提供
 * @param license        License 状态/证明/Grant 的来源，同样来自私有实现
 * @param buildInfo      构建元信息，会参与 Grant 校验并展示在管理台
 */
export function createPaymentWorker({
  plugins,
  authorizePlugin = freeOnlyAuthorize,
  license = freeOnlyLicense,
  buildInfo = DEFAULT_BUILD_INFO,
} = {}) {
  const registry = createPluginRegistry(plugins ?? []);

  if (buildInfo.pluginApiVersion !== undefined && buildInfo.pluginApiVersion !== PLUGIN_API_VERSION) {
    throw new Error(`构建声明的插件接口版本 ${buildInfo.pluginApiVersion} 与核心 ${PLUGIN_API_VERSION} 不一致`);
  }

  // 核心包承诺自带的插件必须真的注册上了，避免"以为打进去了其实没有"。
  const missing = (buildInfo.corePlugins ?? []).filter((code) => !registry.has(code));
  if (missing.length) throw new Error(`构建清单声明的核心插件未注册：${missing.join('、')}`);

  const runtime = Object.freeze({
    registry,
    authorizePlugin,
    license,
    buildInfo: Object.freeze({ ...buildInfo }),
  });

  return createHandlers(runtime);
}
