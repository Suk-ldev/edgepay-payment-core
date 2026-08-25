import assert from 'node:assert/strict';
import test from 'node:test';
import { compareReleaseVersions, CURRENT_RELEASE_VERSION, fetchLatestRelease } from '../src/release.js';

test('商业发行版本固定为本次构建版本并按语义版本比较', () => {
  assert.equal(CURRENT_RELEASE_VERSION, '1.2.1');
  assert.equal(compareReleaseVersions('1.1.1', '1.1.0'), 1);
  assert.equal(compareReleaseVersions('1.1.1', '1.1.1'), 0);
  assert.equal(compareReleaseVersions('1.1.0', '1.1.1'), -1);
});

test('版本检查优先读取 GitHub 仓库中的商业发行清单', async () => {
  let captured;
  const manifest = await fetchLatestRelease(function (url, options) {
    assert.equal(this, globalThis);
    captured = { url, options };
    return Promise.resolve(Response.json({ edition: 'public-commercial-encrypted', version: '1.2.3' }));
  });
  assert.equal(manifest.version, '1.2.3');
  assert.match(captured.url, /api\.github\.com\/repos\/Suk-ldev\/edgepay-serverless-payment/u);
  assert.equal(captured.options.headers.accept, 'application/vnd.github.raw+json');
});

test('GitHub 暂时失败时使用部署站锁定的发行清单', async () => {
  const urls = [];
  const manifest = await fetchLatestRelease(async (url) => {
    urls.push(url);
    if (url.includes('api.github.com')) return new Response('', { status: 504 });
    return Response.json({ edition: 'public-commercial-encrypted', version: '1.2.4' });
  });
  assert.equal(manifest.version, '1.2.4');
  assert.equal(urls.length, 2);
  assert.equal(urls[1], 'https://deploy.imsuk.cn/api/latest-version');
});
