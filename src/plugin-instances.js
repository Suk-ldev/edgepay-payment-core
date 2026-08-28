/**
 * 插件副本（实例）。
 *
 * 同一个收款平台常常不止一个账号——一个微信收商业单，另一个微信收个人单。
 * 插件编码在构建期就固定了，所以副本不是"再装一个插件"，而是给同一个插件挂
 * 第二份配置：编码写成 `wxpay_receipt~2`，配置、通道、订单、轮询租约、流水去重
 * 全按这个编码各走各的，两个账号之间的分流则交给通道权重。
 *
 * 分隔符用 `~`：它在 URL 路径里是 unreserved 字符，不必转义；而插件清单的编码
 * 正则不允许它出现，所以基础编码与副本编码永远不会撞车。
 */

export const INSTANCE_SEPARATOR = '~';

/** 副本序号从 2 起：基础插件本身就是这个平台的 1 号账号。 */
export const MIN_INSTANCE_SEQUENCE = 2;
export const MAX_INSTANCE_SEQUENCE = 99;

const BASE_CODE_RE = /^[a-z][a-z0-9_]*$/u;
const INSTANCE_CODE_RE = /^[a-z][a-z0-9_]*~(?:[2-9]|[1-9][0-9])$/u;

/** 基础编码或副本编码都算合法的插件编码。用于路由与查询参数的格式校验。 */
export const PLUGIN_CODE_RE = /^[a-z][a-z0-9_]*(?:~(?:[2-9]|[1-9][0-9]))?$/u;

export function isPluginInstanceCode(code) {
  return INSTANCE_CODE_RE.test(String(code ?? ''));
}

/** 副本编码对应的基础插件编码；传基础编码时原样返回。 */
export function basePluginCode(code) {
  const text = String(code ?? '');
  const separator = text.indexOf(INSTANCE_SEPARATOR);
  return separator === -1 ? text : text.slice(0, separator);
}

/** 副本序号；基础插件返回 1。 */
export function pluginInstanceSequence(code) {
  const text = String(code ?? '');
  if (!isPluginInstanceCode(text)) return 1;
  return Number(text.slice(text.indexOf(INSTANCE_SEPARATOR) + 1));
}

export function pluginInstanceCode(baseCode, sequence) {
  const base = String(baseCode ?? '');
  const value = Number(sequence);
  if (!BASE_CODE_RE.test(base)) throw new Error(`插件编码不合法：${base}`);
  if (!Number.isSafeInteger(value) || value < MIN_INSTANCE_SEQUENCE || value > MAX_INSTANCE_SEQUENCE) {
    throw new Error(`插件副本序号必须是 ${MIN_INSTANCE_SEQUENCE}~${MAX_INSTANCE_SEQUENCE} 之间的整数`);
  }
  return `${base}${INSTANCE_SEPARATOR}${value}`;
}

/**
 * 已存在的编码里，下一个可用的副本序号。
 * 中间被删掉的号会被重新用上，避免删几次之后号越编越大。
 */
export function nextInstanceSequence(baseCode, existingCodes) {
  const used = new Set();
  for (const code of existingCodes ?? []) {
    if (basePluginCode(code) === baseCode) used.add(pluginInstanceSequence(code));
  }
  for (let sequence = MIN_INSTANCE_SEQUENCE; sequence <= MAX_INSTANCE_SEQUENCE; sequence += 1) {
    if (!used.has(sequence)) return sequence;
  }
  throw new Error(`${baseCode} 的副本数量已达上限 ${MAX_INSTANCE_SEQUENCE}`);
}

/** 副本在没有自定义名称时的显示名。 */
export function defaultInstanceName(baseName, sequence) {
  return `${baseName} ${sequence}`;
}
