/**
 * 通用轮询运行时。只包含与平台无关的东西：HTTP/Cookie 会话、字段取值、时间窗口、
 * 流水行归一化。具体平台的接口地址、请求参数、签名规则、登录流程都属于插件实现，
 * 不在这里出现。
 *
 * 核心层通过插件上下文把这些工具注入给插件（见 core/plugin-context.js），
 * 因此付费插件模块无需各自复制一份引擎，也不会把引擎变成私有资产。
 */

const REQUEST_TIMEOUT_MS = 12_000;

function text(value, maximum = 200) {
  return String(value ?? '').replace(/[\r\n]+/gu, ' ').slice(0, maximum);
}

function valueAt(source, paths, fallback = undefined) {
  for (const path of Array.isArray(paths) ? paths : [paths]) {
    if (path === '' || path === undefined || path === null) continue;
    let value = source;
    for (const key of String(path).split('.')) value = value?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function rowsAt(source, paths) {
  for (const path of Array.isArray(paths) ? paths : [paths]) {
    const value = path === '' ? source : valueAt(source, path);
    if (Array.isArray(value)) return value;
  }
  return [];
}

function epochSeconds(value) {
  if (typeof value === 'number' || /^\d+$/u.test(String(value ?? '').trim())) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return Math.floor(numeric > 10_000_000_000 ? numeric / 1_000 : numeric);
  }
  const source = String(value ?? '').trim();
  if (!source) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/u.test(source)
    ? `${source.replace(' ', 'T')}+08:00`
    : source;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1_000) : null;
}

function formatShanghai(seconds) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(seconds * 1_000));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function moneyToFen(value) {
  const source = String(value ?? '').trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/u.test(source)) return null;
  const sign = source.startsWith('-') ? -1 : 1;
  const [integer, fraction = ''] = source.replace(/^-/, '').split('.', 2);
  return sign * ((Number(integer) * 100) + Number(fraction.padEnd(2, '0')));
}

function queryWindow(orders, nowSeconds = Math.floor(Date.now() / 1_000)) {
  const starts = orders
    .map((order) => epochSeconds(order.created_at ?? order.request_at))
    .filter(Number.isFinite);
  const ends = orders.map((order) => epochSeconds(order.expire_at)).filter(Number.isFinite);
  return {
    start: Math.max(nowSeconds - 86_400, (starts.length ? Math.min(...starts) : nowSeconds - 300) - 300),
    end: Math.min(nowSeconds + 300, (ends.length ? Math.max(...ends) : nowSeconds) + 60),
  };
}

function mapPayType(value, mapping = {}) {
  const source = String(value ?? '').trim();
  if (!source) return '';
  const normalized = source.toUpperCase().replace(/[\s_-]+/gu, '');
  const mapped = mapping[source] ?? mapping[normalized];
  if (mapped) return mapped;
  if (/ALIPAY|ALI|支付宝|ZFB/u.test(normalized)) return 'alipay';
  if (/WECHAT|WXPAY|WX|微信/u.test(normalized)) return 'wxpay';
  return '';
}

function normalizeRows(rows, descriptor, config = {}) {
  const records = [];
  const stats = {
    raw: Array.isArray(rows) ? rows.length : 0,
    successful: 0,
    scoped: 0,
    normalized: 0,
  };
  const expectedMerchant = String(config.receipt_account_no ?? '').trim();
  const expectedTerminal = String(config.receipt_terminal_no ?? '').trim();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (descriptor.isSuccessful && !descriptor.isSuccessful(row)) continue;
    stats.successful += 1;
    const merchant = String(valueAt(row, descriptor.merchant, '')).trim();
    const terminal = String(valueAt(row, descriptor.terminal, '')).trim();
    if (expectedMerchant && merchant && merchant !== expectedMerchant) continue;
    if (expectedTerminal && terminal && terminal !== expectedTerminal) continue;
    stats.scoped += 1;
    const orderNo = String(valueAt(row, descriptor.orderNo, '')).trim();
    const amountFen = descriptor.amountUnit === 'fen'
      ? Number(valueAt(row, descriptor.amount))
      : moneyToFen(valueAt(row, descriptor.amount));
    const paidAt = epochSeconds(valueAt(row, descriptor.paidAt));
    const payType = descriptor.defaultPayType
      ?? mapPayType(valueAt(row, descriptor.payType, ''), descriptor.payTypeMap);
    if (!orderNo || !['alipay', 'wxpay'].includes(payType)
      || !Number.isSafeInteger(amountFen) || amountFen <= 0 || paidAt === null) continue;
    records.push({
      order_no: orderNo.slice(0, 64),
      pay_type: payType,
      price: (amountFen / 100).toFixed(2),
      channel: terminal || merchant,
      remark: String(valueAt(row, descriptor.remark, '')).slice(0, 255),
      paid_at: paidAt,
    });
    stats.normalized += 1;
  }
  return { records, stats };
}

async function fetchWithTimeout(url, options = {}, fetchImpl = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    if (fetchImpl) return await fetchImpl(url, { ...options, signal: controller.signal });
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`请求超时：${new URL(url).origin}`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function splitSetCookie(value) {
  return String(value ?? '').split(/,(?=\s*[^;,=\s]+=)/u).filter(Boolean);
}

class WorkerHttpSession {
  constructor(baseUrl, state = {}, fetchImpl = null) {
    this.baseUrl = String(baseUrl ?? '').replace(/\/+$/u, '');
    this.cookies = new Map(Array.isArray(state.cookies) ? state.cookies : []);
    this.fetchImpl = fetchImpl;
  }

  cookieHeader() {
    return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
  }

  absorb(response) {
    const values = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : splitSetCookie(response.headers.get('set-cookie'));
    for (const value of values) {
      const pair = String(value).split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator > 0) this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }

  async request(pathname, options = {}) {
    const url = /^https?:\/\//u.test(String(pathname)) ? String(pathname) : `${this.baseUrl}${pathname}`;
    const headers = {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      ...(options.headers ?? {}),
    };
    const cookie = this.cookieHeader();
    if (cookie && !headers.cookie) headers.cookie = cookie;
    const response = await fetchWithTimeout(url, { ...options, headers }, this.fetchImpl);
    this.absorb(response);
    return response;
  }

  async json(pathname, options, label) {
    const response = await this.request(pathname, options);
    const raw = await response.text();
    if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
    try { return JSON.parse(raw); } catch { throw new Error(`${label}返回的不是 JSON：${text(raw, 80)}`); }
  }

  state(extra = {}) {
    return { cookies: [...this.cookies], ...extra };
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export {
  WorkerHttpSession,
  bytesToBase64,
  epochSeconds,
  fetchWithTimeout,
  formatShanghai,
  mapPayType,
  moneyToFen,
  normalizeRows,
  queryWindow,
  rowsAt,
  splitSetCookie,
  text,
  valueAt,
};
