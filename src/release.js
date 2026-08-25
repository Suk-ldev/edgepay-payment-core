export const CURRENT_RELEASE_VERSION = '1.2.1';

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const SOURCES = Object.freeze([
  {
    name: 'GitHub',
    url: 'https://api.github.com/repos/Suk-ldev/edgepay-serverless-payment/contents/COMMERCIAL_BUILD.json?ref=main',
    options: {
      headers: {
        accept: 'application/vnd.github.raw+json',
        'cache-control': 'no-cache',
        'user-agent': 'edgepay-payment-worker',
      },
      cache: 'no-store',
    },
  },
  {
    name: 'Deploy',
    url: 'https://deploy.imsuk.cn/api/latest-version',
    options: { cache: 'no-store' },
  },
]);

function decodeBase64(value) {
  const binary = atob(String(value).replace(/\s+/gu, ''));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function parseManifest(response) {
  const text = await response.text();
  let value = JSON.parse(text);
  if (value && typeof value === 'object' && typeof value.content === 'string') {
    value = JSON.parse(new TextDecoder().decode(decodeBase64(value.content)));
  }
  if (!VERSION_RE.test(String(value?.version ?? ''))) throw new Error('版本清单格式不正确');
  if (value?.edition !== 'public-commercial-encrypted') throw new Error('版本清单发行类型不正确');
  return value;
}

export function compareReleaseVersions(left, right) {
  const numbers = (value) => String(value).split(/[+-]/u, 1)[0].split('.').map((part) => Number(part));
  const a = numbers(left);
  const b = numbers(right);
  for (let index = 0; index < 3; index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0) ? 1 : -1;
  }
  return 0;
}

export async function fetchLatestRelease(fetchImpl = fetch) {
  const failures = [];
  for (const source of SOURCES) {
    try {
      const url = source.name === 'GitHub' ? `${source.url}&_=${Date.now()}` : source.url;
      const response = await Reflect.apply(fetchImpl, globalThis, [url, source.options]);
      if (!response.ok) {
        failures.push(`${source.name} ${response.status}`);
        continue;
      }
      return await parseManifest(response);
    } catch (error) {
      failures.push(`${source.name} ${String(error)}`);
    }
  }
  throw new Error(`读取最新版本失败：${failures.join('；')}`);
}
