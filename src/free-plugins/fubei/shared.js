/**
 * 付呗两个后台（e 站商户后台、b 站收款单）共用的小工具：时间/金额换算、带超时的请求、Cookie 罐。
 */

const REQUEST_TIMEOUT_MS = 12_000;

export const BROWSER_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/122 Safari/537.36';

export function safeText(value, maximum = 160) {
  return String(value ?? '').replace(/[\r\n]+/gu, ' ').slice(0, maximum);
}

export function epochSeconds(value) {
  if (typeof value === 'number' || /^\d+$/u.test(String(value ?? '').trim())) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return Math.floor(numeric > 10_000_000_000 ? numeric / 1_000 : numeric);
  }
  const text = String(value ?? '').trim();
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/u.test(text)
    ? `${text.replace(' ', 'T')}+08:00`
    : text;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1_000) : null;
}

/** 付呗两个后台都按北京时间收发 `YYYY-MM-DD HH:mm:ss`。 */
export function formatShanghai(seconds) {
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

export function moneyToFen(value) {
  const text = String(value ?? '').trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/u.test(text)) return null;
  const sign = text.startsWith('-') ? -1 : 1;
  const unsigned = text.replace(/^-/, '');
  const [integer, fraction = ''] = unsigned.split('.', 2);
  return sign * ((Number(integer) * 100) + Number(fraction.padEnd(2, '0')));
}

/** 付呗流水里的支付方式编号。e 站 pay_type 与 b 站 payType 用的是同一套。 */
export function fubeiPayType(value) {
  const numeric = Number(value);
  if (numeric === 1) return 'wxpay';
  if (numeric === 2) return 'alipay';
  return '';
}

export async function fetchWithTimeout(url, options = {}, fetchImpl = null) {
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

export async function jsonResponse(response, label) {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}返回的不是 JSON：${safeText(text, 80)}`);
  }
}

function parseSetCookie(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const first = text.split(';', 1)[0];
  const separator = first.indexOf('=');
  if (separator <= 0) return null;
  return [first.slice(0, separator).trim(), first.slice(separator + 1).trim()];
}

function responseSetCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
  const combined = response.headers.get('set-cookie');
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;,=\s]+=)/u);
}

export class CookieJar {
  constructor(entries = []) {
    this.values = new Map(Array.isArray(entries) ? entries : []);
  }

  header() {
    return [...this.values].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  absorb(response) {
    for (const value of responseSetCookies(response)) {
      const entry = parseSetCookie(value);
      if (entry) this.values.set(...entry);
    }
  }

  clear() {
    this.values.clear();
  }

  toJSON() {
    return [...this.values];
  }
}
