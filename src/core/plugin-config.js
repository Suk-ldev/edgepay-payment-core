/**
 * 插件配置与清单的聚合。以前 plugins.js 里写死了一张包含免费和付费插件的大表，
 * 现在全部从注册表推导——构建里有哪些插件，管理台就只看得到哪些。
 */

import { pluginMissingFields } from '../plugin-api.js';
import {
  RECEIPT_DISCOVERY_WINDOW_SECONDS, receiptDiscoveryFields,
} from '../receipt-discovery.js';

/** 取出某个插件自己的那段配置。 */
export function configForPlugin(config, pluginCode) {
  const value = config?.[pluginCode];
  return value && !Array.isArray(value) && typeof value === 'object' ? value : {};
}

export function missingPluginFields(registry, config, pluginCode) {
  const plugin = registry.get(pluginCode);
  if (!plugin) return [];
  return pluginMissingFields(plugin, configForPlugin(config, pluginCode));
}

/**
 * 插件是否启用。管理员显式开关优先；没设过就看配置是否齐全。
 */
export function pluginEnabled(registry, config, pluginCode) {
  const settings = configForPlugin(config, pluginCode);
  if (typeof settings.enabled === 'boolean') return settings.enabled;
  return missingPluginFields(registry, config, pluginCode).length === 0;
}

/** 管理台插件列表。只暴露清单里的公开信息，不含任何实现细节。 */
export function publicPluginList(registry, config) {
  return registry.manifests().map((manifest) => {
    const missingFields = missingPluginFields(registry, config, manifest.code);
    return {
      code: manifest.code,
      name: manifest.name,
      version: manifest.version,
      tier: manifest.tier,
      mode: manifest.mode,
      runtime: manifest.runtime,
      payTypes: [...manifest.payTypes],
      required: [...manifest.required],
      note: manifest.note,
      // 运营配置文档随插件走，只有装载了该插件的部署才拿得到。
      docs: manifest.docs,
      configured: missingFields.length === 0,
      enabled: pluginEnabled(registry, config, manifest.code),
      missingFields,
    };
  });
}

/** 管理台配置表单。字段定义直接来自插件清单。 */
export function adminPluginForms(registry, config) {
  return registry.manifests().map((manifest) => {
    const settings = configForPlugin(config, manifest.code);
    const missingFields = missingPluginFields(registry, config, manifest.code);
    const discoveryFields = receiptDiscoveryFields(manifest);
    return {
      code: manifest.code,
      name: manifest.name,
      configured: missingFields.length === 0,
      enabled: pluginEnabled(registry, config, manifest.code),
      missingFields,
      receiptDiscovery: discoveryFields.length ? {
        fields: discoveryFields,
        windowSeconds: RECEIPT_DISCOVERY_WINDOW_SECONDS,
      } : null,
      fields: manifest.adminFields.map((field) => ({
        ...field,
        value: field.secret
          ? ''
          : (field.type === 'image'
              ? String(settings[field.key] ?? '').trim()
              : (settings[field.key] ?? (field.type === 'multiselect' ? [] : ''))),
        configured: field.secret ? Boolean(settings[field.key]) : undefined,
      })),
    };
  });
}
