import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { compareReleaseVersions, CURRENT_RELEASE_VERSION, fetchLatestRelease } from '../src/release.js';

test('兜底版本号跟得上当前发行，按语义版本比较', async () => {
  // 这个常量只在公开核心单独跑时用得到（正式部署以 buildInfo.release 为准），
  // 但它一度停在 1.2.1 而实际发行已经是 2.1.x，后台「当前版本」就显示了一个
  // 谁都不认识的号，update_available 还永远算成"有新版"。发行时顺手跟上。
  assert.match(CURRENT_RELEASE_VERSION, /^\d+\.\d+\.\d+$/u);
  const buildInfo = await readFile(
    new URL('../../payment-commercial/src/generated/build-info.js', import.meta.url),
    'utf8',
  ).catch(() => '');
  // 商业仓在检出范围内时（monorepo 开发态）顺带盯一眼两边没漂；
  // 发行 CI 只检出 core 时这条自动跳过。
  if (buildInfo) {
    const release = buildInfo.match(/release:\s*"([^"]+)"/u)?.[1];
    assert.equal(CURRENT_RELEASE_VERSION, release, '兜底版本号与本次构建版本不一致');
  }

  assert.equal(compareReleaseVersions('1.1.1', '1.1.0'), 1);
  assert.equal(compareReleaseVersions('1.1.1', '1.1.1'), 0);
  assert.equal(compareReleaseVersions('1.1.0', '1.1.1'), -1);
  assert.equal(compareReleaseVersions('2.1.12', '2.1.9'), 1, '按段比较，不能按字符串比');
});

test('版本检查认部署站返回的发行类型', async () => {
  // 原来只认 edition=public-commercial-encrypted，而部署站返回的是
  // commercial-entitlement-build，于是每次都被判成"发行类型不正确"——
  // 加上当时排在前面的 GitHub 源指向一个不存在的仓库，两个源全挂，
  // 后台「检查更新」从来没成功过一次。
  const urls = [];
  const manifest = await fetchLatestRelease(function (url, options) {
    assert.equal(this, globalThis);
    urls.push({ url, options });
    return Promise.resolve(Response.json({
      ok: true,
      name: 'edgepay-commercial-worker',
      edition: 'commercial-entitlement-build',
      version: '2.1.12',
    }));
  });
  assert.equal(manifest.version, '2.1.12');
  assert.deepEqual(urls.map((item) => item.url), ['https://deploy-api.imsuk.eu.org/api/latest-version']);
  assert.equal(urls[0].options.cache, 'no-store');
  assert.ok(urls[0].options.signal instanceof AbortSignal, '每个地址都要有超时');
});

test('先走 Custom Domain，失败了再退到 deploy.imsuk.cn', async () => {
  // 支付站和部署站在同一个 zone 时，Worker fetch 走路由的 deploy.imsuk.cn 会被送去 zone
  // 源站、卡到 522；排在前面的话维护者自己的站每次检查都要白等一个超时。
  const urls = [];
  const manifest = await fetchLatestRelease(async (url) => {
    urls.push(url);
    if (url.startsWith('https://deploy-api.imsuk.eu.org/')) return new Response('error code: 522', { status: 522 });
    return Response.json({ edition: 'commercial-entitlement-build', version: '2.1.16' });
  });
  assert.equal(manifest.version, '2.1.16');
  assert.deepEqual(urls, [
    'https://deploy-api.imsuk.eu.org/api/latest-version',
    'https://deploy.imsuk.cn/api/latest-version',
  ]);
});

test('两个地址都失败时，错误里带上各自的原因', async () => {
  await assert.rejects(
    () => fetchLatestRelease(async (url) => (url.includes('deploy.imsuk.cn')
      ? new Response('error code: 522', { status: 522 })
      : Promise.reject(new Error('connect timeout')))),
    /Deploy API connect timeout；Deploy HTTP 522（error code: 522）/u,
  );
});

test('清单没带 edition 也认，版本号格式不对才拒', async () => {
  const withoutEdition = await fetchLatestRelease(async () => Response.json({ version: '2.2.0' }));
  assert.equal(withoutEdition.version, '2.2.0');

  await assert.rejects(
    () => fetchLatestRelease(async () => Response.json({ edition: 'something-else', version: '2.2.0' })),
    /读取最新版本失败/u,
  );
  await assert.rejects(
    () => fetchLatestRelease(async () => Response.json({ edition: 'commercial-entitlement-build', version: 'latest' })),
    /读取最新版本失败/u,
  );
  await assert.rejects(
    () => fetchLatestRelease(async () => new Response('', { status: 504 })),
    /读取最新版本失败/u,
  );
});
