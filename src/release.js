/**
 * 公开核心单独运行时的版本号（本仓库构建不出可部署的 Worker，所以正常情况下用不到它）。
 *
 * 真正在跑的版本以商业构建注入的 `buildInfo.release` 为准——那个值由
 * generate-build-info.mjs 每次发行现写，不会漂。这里只是兜底，
 * 发行时顺手跟上，别让它再退化成一个谁都不认识的数字。
 */
export const CURRENT_RELEASE_VERSION = '2.1.22';

export const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

/**
 * 最新发行版本的来源：部署站。
 *
 * 部署站本来就是发行的权威出口：wizard 钉住哪个版本，商户能升到的就是哪个版本。
 * （这里原来还排着一个 GitHub 源，指向一个不存在的仓库，已删。）
 *
 * 为什么有两个地址、为什么 Custom Domain 排在前面：deploy.imsuk.cn 挂在 imsuk.eu.org
 * 这个 zone 的 Worker 路由上。支付站如果也在这个 zone（套件维护者自己的站就是），Worker
 * fetch 同 zone 上走路由的 Worker 会被送去 zone 源站，卡十几秒后 522，检查更新就永远失败。
 * Custom Domain 上的 Worker 不受这个限制，从任何 zone 都能直接打到，所以先走它；
 * deploy.imsuk.cn 留作备用。两个地址是同一个部署站 Worker。
 */
const SOURCES = Object.freeze([
  { name: 'Deploy API', url: 'https://deploy-api.imsuk.eu.org/api/latest-version' },
  { name: 'Deploy', url: 'https://deploy.imsuk.cn/api/latest-version' },
]);

/** 单个地址的超时。版本检查在后台首屏之后才跑，但也不能让一个挂住的地址拖住整次请求。 */
const SOURCE_TIMEOUT_MS = 5_000;

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
      const response = await Reflect.apply(fetchImpl, globalThis, [source.url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
      }]);
      if (!response.ok) {
        // 1042 之类的拦截页正文里带错误码，截一小段进错误信息，下次一眼能看出是什么挡住了。
        const detail = (await response.text().catch(() => '')).replace(/\s+/gu, ' ').trim().slice(0, 80);
        failures.push(`${source.name} HTTP ${response.status}${detail ? `（${detail}）` : ''}`);
        continue;
      }
      return await parseManifest(response);
    } catch (error) {
      failures.push(`${source.name} ${String(error?.message ?? error)}`);
    }
  }
  throw new Error(`读取最新版本失败：${failures.join('；')}`);
}
