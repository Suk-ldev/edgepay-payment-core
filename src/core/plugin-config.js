/**
 * 插件配置与清单的聚合。以前 plugins.js 里写死了一张包含免费和付费插件的大表，
 * 现在全部从注册表推导——构建里有哪些插件，管理台就只看得到哪些。
 */

import { pluginMissingFields } from '../plugin-api.js';
import {
  RECEIPT_DISCOVERY_WINDOW_SECONDS, receiptDiscoveryFields,
} from '../receipt-discovery.js';
import { basePluginCode, isPluginInstanceCode, pluginInstanceSequence } from '../plugin-instances.js';

/** 副本的自定义名称存在它自己那段配置里，不占用插件清单的字段。 */
export const INSTANCE_NAME_KEY = 'instance_name';

/** 取出某个插件自己的那段配置。 */
export function configForPlugin(config, pluginCode) {
  const value = config?.[pluginCode];
  return value && !Array.isArray(value) && typeof value === 'object' ? value : {};
}

/**
 * 当前存在的插件编码：注册表里的基础插件，加上配置里已经建过的副本。
 *
 * 副本没有自己的构建产物，它的存在性只由 `plugin_config` 里有没有那一段决定，
 * 所以这份列表必须每次从配置推导，不能像基础插件那样在模块初始化时算一次。
 */
export function pluginCodesWithInstances(registry, config) {
  const instances = new Map();
  for (const code of Object.keys(config ?? {})) {
    if (!isPluginInstanceCode(code)) continue;
    const base = basePluginCode(code);
    if (!registry.hasBase(base)) continue;
    if (!instances.has(base)) instances.set(base, []);
    instances.get(base).push(code);
  }
  for (const codes of instances.values()) {
    codes.sort((left, right) => pluginInstanceSequence(left) - pluginInstanceSequence(right));
  }
  // 副本紧跟在它的基础插件后面，管理台列表读起来才是一组一组的。
  return registry.codes().flatMap((code) => [code, ...(instances.get(code) ?? [])]);
}

/** 插件在管理台的显示名。副本可以改名，改过就用管理员起的那个。 */
export function pluginDisplayName(registry, config, pluginCode) {
  const plugin = registry.get(pluginCode);
  if (!plugin) return String(pluginCode);
  const custom = String(configForPlugin(config, pluginCode)[INSTANCE_NAME_KEY] ?? '').trim();
  return custom || plugin.manifest.name;
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
  return pluginCodesWithInstances(registry, config).map((code) => {
    const { manifest } = registry.get(code);
    const missingFields = missingPluginFields(registry, config, manifest.code);
    return {
      code: manifest.code,
      name: pluginDisplayName(registry, config, manifest.code),
      base_code: manifest.baseCode ?? manifest.code,
      base_name: manifest.baseCode ? registry.get(manifest.baseCode).manifest.name : manifest.name,
      instance_sequence: manifest.instanceSequence ?? 1,
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
  return pluginCodesWithInstances(registry, config).map((code) => {
    const { manifest } = registry.get(code);
    const settings = configForPlugin(config, manifest.code);
    const missingFields = missingPluginFields(registry, config, manifest.code);
    const discoveryFields = receiptDiscoveryFields(manifest);
    return {
      code: manifest.code,
      name: pluginDisplayName(registry, config, manifest.code),
      base_code: manifest.baseCode ?? manifest.code,
      instance_sequence: manifest.instanceSequence ?? 1,
      instance_name: String(settings[INSTANCE_NAME_KEY] ?? ''),
      configured: missingFields.length === 0,
      enabled: pluginEnabled(registry, config, manifest.code),
      missingFields,
      receiptDiscovery: discoveryFields.length ? {
        fields: discoveryFields,
        windowSeconds: RECEIPT_DISCOVERY_WINDOW_SECONDS,
      } : null,
      fields: manifest.adminFields.map((field) => ({
        ...field,
        // defaultValue 会直接填进输入框：像 USDT 主网合约、TronGrid 地址这种
        // "几乎所有人都填同一个值"的字段，空框只会让人去翻文档。
        // 密钥类字段永远不给默认值，图片走各自的默认图逻辑。
        value: field.secret
          ? ''
          : (field.type === 'image'
              ? String(settings[field.key] ?? '').trim()
              : (settings[field.key] ?? field.defaultValue ?? (field.type === 'multiselect' ? [] : ''))),
        configured: field.secret ? Boolean(settings[field.key]) : undefined,
      })),
    };
  });
}
