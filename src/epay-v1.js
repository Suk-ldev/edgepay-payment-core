import { safeWebhookUrl } from './security.js';

const textEncoder = new TextEncoder();

function asText(value) {
  return String(value ?? '').trim();
}

function sameText(left, right) {
  const a = textEncoder.encode(String(left ?? ''));
  const b = textEncoder.encode(String(right ?? ''));
  if (a.length !== b.length) return false;
  let different = 0;
  for (let index = 0; index < a.length; index += 1) different |= a[index] ^ b[index];
  return different === 0;
}

/**
 * ePay V1 的原始 MD5 规则来自原项目的 Md5Signer：
 * 参数名升序，忽略 sign/sign_type、空值和非标量，最后直接拼接商户 key。
 */
export function ePaySignContent(payload) {
  return Object.keys(payload)
    .sort()
    .flatMap((key) => {
      const value = payload[key];
      if (key === 'sign' || key === 'sign_type' || key === 'key') return [];
      if (value === null || value === '' || typeof value === 'object') return [];
      return [`${key}=${String(value)}`];
    })
    .join('&');
}

export async function md5Hex(value) {
  const source = textEncoder.encode(String(value));
  const paddingBytes = (64 - ((source.length + 9) % 64)) % 64;
  const input = new Uint8Array(source.length + 1 + paddingBytes + 8);
  input.set(source);
  input[source.length] = 0x80;
  const view = new DataView(input.buffer);
  const bitLength = source.length * 8;
  view.setUint32(input.length - 8, bitLength >>> 0, true);
  view.setUint32(input.length - 4, Math.floor(bitLength / 0x1_0000_0000), true);
  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const constants = Array.from({ length: 64 }, (_, index) => (
    Math.floor(Math.abs(Math.sin(index + 1)) * 0x1_0000_0000) >>> 0
  ));
  const rotateLeft = (number, bits) => ((number << bits) | (number >>> (32 - bits))) >>> 0;
  let state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let offset = 0; offset < input.length; offset += 64) {
    const words = Array.from({ length: 16 }, (_, index) => view.getUint32(offset + index * 4, true));
    let [a, b, c, d] = state;
    for (let index = 0; index < 64; index += 1) {
      let mixed;
      let wordIndex;
      if (index < 16) { mixed = (b & c) | (~b & d); wordIndex = index; }
      else if (index < 32) { mixed = (d & b) | (~d & c); wordIndex = (5 * index + 1) % 16; }
      else if (index < 48) { mixed = b ^ c ^ d; wordIndex = (3 * index + 5) % 16; }
      else { mixed = c ^ (b | ~d); wordIndex = (7 * index) % 16; }
      const previousD = d;
      d = c;
      c = b;
      const sum = (a + mixed + constants[index] + words[wordIndex]) >>> 0;
      b = (b + rotateLeft(sum, shifts[index])) >>> 0;
      a = previousD;
    }
    state = state.map((number, index) => (number + [a, b, c, d][index]) >>> 0);
  }
  const digest = new Uint8Array(16);
  const digestView = new DataView(digest.buffer);
  state.forEach((number, index) => digestView.setUint32(index * 4, number, true));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function signEpayV1(payload, key) {
  return md5Hex(`${ePaySignContent(payload)}${String(key ?? '')}`);
}

export async function verifyEpayV1(payload, env) {
  if (asText(payload.pid) !== asText(env.EPAY_PID)) throw new Error('商户ID不存在');
  if (asText(payload.sign_type).toUpperCase() !== 'MD5') throw new Error('仅支持 MD5 签名');
  const sign = asText(payload.sign);
  if (!sign || !env.EPAY_KEY) throw new Error('签名参数不完整');
  const keys = [env.EPAY_KEY, env.EPAY_PREVIOUS_KEY].filter(Boolean);
  for (const key of keys) {
    const expected = await signEpayV1(payload, key);
    if (sameText(expected.toLowerCase(), sign.toLowerCase())) return;
  }
  throw new Error('签名验证失败');
}

export async function readEpayPayload(request) {
  const url = new URL(request.url);
  const payload = Object.fromEntries(url.searchParams.entries());
  if (request.method === 'GET' || request.method === 'HEAD') return payload;

  const contentType = request.headers.get('content-type') ?? '';
  const raw = await request.text();
  if (!raw) return payload;
  if (contentType.includes('application/json')) {
    const body = JSON.parse(raw);
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('请求体格式不合法');
    return { ...payload, ...body };
  }
  return { ...payload, ...Object.fromEntries(new URLSearchParams(raw).entries()) };
}

export function moneyToFen(value) {
  const money = asText(value);
  if (!/^(?=.*[1-9])\d+(?:\.\d{1,2})?$/u.test(money)) throw new Error('金额格式不合法');
  const [integer, decimal = ''] = money.split('.');
  const fen = Number(integer) * 100 + Number(decimal.padEnd(2, '0'));
  if (!Number.isSafeInteger(fen) || fen <= 0 || fen > 100_000_000) throw new Error('金额超出允许范围');
  return fen;
}

export function fenToMoney(fen) {
  return (Number(fen) / 100).toFixed(2);
}

export function requireText(payload, key, maxLength = 255) {
  const value = asText(payload[key]);
  if (!value || value.length > maxLength) throw new Error(`${key} 参数不合法`);
  return value;
}

export function optionalText(payload, key, maxLength = 255) {
  const value = asText(payload[key]);
  if (value.length > maxLength) throw new Error(`${key} 参数过长`);
  return value;
}

export function isHttpsUrl(value) {
  return safeWebhookUrl(value);
}

export function appendQuery(urlText, params) {
  const url = new URL(urlText);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  return url.toString();
}
