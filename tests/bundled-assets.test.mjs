import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BUNDLED_ASSET_PATHS, fetchBundledAsset } from '../src/bundled-assets.js';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));

async function publicPaths(directory = publicRoot) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await publicPaths(full));
    else if (entry.isFile()) result.push(`/${path.relative(publicRoot, full).replaceAll('\\', '/')}`);
  }
  return result;
}

test('所有 public 文件都内嵌到 Worker 模块，不依赖 KV 或 Static Assets', async () => {
  assert.deepEqual([...BUNDLED_ASSET_PATHS].sort(), (await publicPaths()).sort());
  const index = await fetchBundledAsset(new Request('https://pay.example/index.html'));
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /^text\/html/u);
  assert.match(await index.text(), /EdgePay/u);
  const image = await fetchBundledAsset(new Request('https://pay.example/contact/default-avatar.png'));
  assert.deepEqual(
    new Uint8Array(await image.arrayBuffer()),
    new Uint8Array(await readFile(new URL('../public/contact/default-avatar.png', import.meta.url))),
  );
});

test('每个页面都带站点图标，浏览器标签页不会是空白默认图标', async () => {
  const pages = [...BUNDLED_ASSET_PATHS].filter((path) => path.endsWith('.html'));
  assert.ok(pages.length >= 4, '页面清单不该为空');
  for (const page of pages) {
    const html = await (await fetchBundledAsset(new Request(`https://pay.example${page}`))).text();
    assert.match(html, /<link rel="icon" href="\/favicon\.svg\?v=[0-9a-f]{12}"/u, `${page} 缺少站点图标`);
  }
  const icon = await fetchBundledAsset(new Request('https://pay.example/favicon.svg'));
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get('content-type'), /^image\/svg\+xml/u);
});

test('HTML 引用的静态资源都带内容指纹，升级后不会命中旧缓存', async () => {
  // 资源是 public, max-age=3600，HTML 是 no-store。dashboard.html 以前直接写
  // /app.js，升级完 HTML 立刻是新的、app.js 却还能在浏览器里旧一个小时，
  // 后台就会出现"新功能死活不出现"。指纹取自内容，改一个字节就换一个 URL。
  const html = await fetchBundledAsset(new Request('https://pay.example/dashboard.html'));
  const text = await html.text();
  for (const asset of ['/app.js', '/styles.css']) {
    assert.match(text, new RegExp(`${asset}\\?v=[0-9a-f]{12}`, 'u'), `${asset} 必须带内容指纹`);
    assert.doesNotMatch(text, new RegExp(`["']${asset}["']`, 'u'), `${asset} 不能出现不带指纹的裸引用`);
  }
  // 指纹只是查询串，服务端查表仍然按 pathname，带不带都要能取到同一份资源。
  const withVersion = await fetchBundledAsset(new Request('https://pay.example/app.js?v=deadbeef1234'));
  const plain = await fetchBundledAsset(new Request('https://pay.example/app.js'));
  assert.equal(withVersion.status, 200);
  assert.equal(await withVersion.text(), await plain.text());
});

test('收银台前端不带上一代品牌，也不引用打不开的默认 logo', async () => {
  // 收银台包里原本写死 MPAY 的站名和 /assets/brand/mpay-logo.svg。那个文件不在
  // public 里，订单数据到达之前每次首屏都会 404 一次；index.html 用
  // display:none 藏起 .brand-logo 并不能阻止浏览器去请求 src。
  const bundle = await readFile(new URL('../public/cashier/assets/cashier.js', import.meta.url), 'utf8');
  assert.doesNotMatch(bundle, /MPAY|MPay/u);
  assert.doesNotMatch(bundle, /mpay-logo/u);
  // 兜底 logo 必须是自包含的，不能是任何要走网络的路径。
  for (const match of bundle.matchAll(/logo:`([^`]*)`/gu)) {
    assert.match(match[1], /^data:image\//u, `兜底 logo 必须内联，实际是 ${match[1]}`);
  }
  const bundled = [...BUNDLED_ASSET_PATHS];
  for (const match of bundle.matchAll(/`(\/assets\/[^`]*)`/gu)) {
    assert.ok(bundled.includes(match[1]), `收银台引用了未内嵌的资源 ${match[1]}`);
  }
});

test('内嵌静态资源保持 GET/HEAD/404 边界', async () => {
  assert.equal((await fetchBundledAsset(new Request('https://pay.example/styles.css', { method: 'HEAD' }))).status, 200);
  assert.equal((await fetchBundledAsset(new Request('https://pay.example/missing'))).status, 404);
  assert.equal((await fetchBundledAsset(new Request('https://pay.example/index.html', { method: 'POST' }))).status, 405);
});
