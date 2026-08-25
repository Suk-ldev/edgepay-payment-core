/**
 * 测试用的 Worker 工厂。
 *
 * 公开核心不再有默认导出（那是"公开源码但不可独立部署"的实现方式），
 * 集成测试要自己组装一个运行时。默认只装免费插件，与公开构建一致。
 */

import { createPaymentWorker, freePlugins } from '../../src/index.js';

/**
 * @param plugins 额外插件，用于在测试里模拟"装载了某个付费插件"的构建。
 * @param authorizePlugin 覆盖授权门；不传时沿用核心默认（付费插件一律拒绝）。
 */
export function createTestWorker({ plugins = [], authorizePlugin, license } = {}) {
  return createPaymentWorker({
    plugins: [...freePlugins, ...plugins],
    ...(authorizePlugin ? { authorizePlugin } : {}),
    ...(license ? { license } : {}),
    buildInfo: {
      release: '0.0.0-test',
      buildId: 'test',
      pluginApiVersion: 1,
      licenseProtocol: 'none',
      corePlugins: freePlugins.map((plugin) => plugin.manifest.code),
    },
  });
}

/** 放行一切的授权门。用于测试付费插件链路本身，而不是测授权。 */
export const allowAllPlugins = async () => {};

/** 把指定编码当作已授权的 License 客户端。 */
export function licenseAllowing(codes) {
  return {
    async state(_env, registry) {
      return {
        licensed: true,
        domain: 'pay.example.com',
        plugins: [...new Set([
          ...registry.manifests().filter((m) => m.tier === 'FREE').map((m) => m.code),
          ...codes,
        ])],
        entitlementVersion: 1,
      };
    },
    async attest() { throw new Error('测试环境不做在线证明'); },
    async grantEnvelope() { return null; },
    async packageBaseUrl() { return 'https://license.example.com'; },
  };
}
