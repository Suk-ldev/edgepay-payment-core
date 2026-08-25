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

test('内嵌静态资源保持 GET/HEAD/404 边界', async () => {
  assert.equal((await fetchBundledAsset(new Request('https://pay.example/styles.css', { method: 'HEAD' }))).status, 200);
  assert.equal((await fetchBundledAsset(new Request('https://pay.example/missing'))).status, 404);
  assert.equal((await fetchBundledAsset(new Request('https://pay.example/index.html', { method: 'POST' }))).status, 405);
});
