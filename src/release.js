/**
 * 公开核心单独运行时的版本号（本仓库构建不出可部署的 Worker，所以正常情况下用不到它）。
 *
 * 真正在跑的版本以商业构建注入的 `buildInfo.release` 为准——那个值由
 * generate-build-info.mjs 每次发行现写，不会漂。这里只是兜底，
 * 发行时顺手跟上，别让它再退化成一个谁都不认识的数字。
 */
export const CURRENT_RELEASE_VERSION = '2.1.13';

export const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

/**
 * 最新发行版本的来源：部署站。
 *
 * 这里原来还排在前面一个 GitHub 源
 * （api.github.com/repos/Suk-ldev/edgepay-serverless-payment/contents/COMMERCIAL_BUILD.json）——
 * 那个仓库不存在（带 token 查也是 404），Worker 又不带 GitHub 凭据，所以它永远 404；
 * 而且构建出来的 COMMERCIAL_BUILD.json 里根本没有 edition 字段，就算仓库在也会被
 * 下面的校验挡掉。加上部署站返回的 edition 是 commercial-entitlement-build、
 * 与原先写死要求的 public-commercial-encrypted 对不上，两个源全部失败，
 * 后台的"检查更新"从来没有真正成功过一次。
 *
 * 部署站本来就是发行的权威出口：wizard 钉住哪个版本，商户能升到的就是哪个版本，
 * 所以直接认它，不再绕 GitHub。
 */
const SOURCES = Object.freeze([
  {
    name: 'Deploy',
    url: 'https://deploy.imsuk.cn/api/latest-version',
    options: { cache: 'no-store' },
  },
]);

/** 认得出的发行类型。字段缺失时不拦——清单本身没带 edition，版本号格式对就够了。 */
const KNOWN_EDITIONS = Object.freeze([
  'commercial-entitlement-build',
  'public-commercial-encrypted',
]);

async function parseManifest(response) {
  const value = JSON.parse(await response.text());
  if (!VERSION_RE.test(String(value?.version ?? ''))) throw new Error('版本清单格式不正确');
  const edition = String(value?.edition ?? '');
  if (edition && !KNOWN_EDITIONS.includes(edition)) throw new Error('版本清单发行类型不正确');
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
