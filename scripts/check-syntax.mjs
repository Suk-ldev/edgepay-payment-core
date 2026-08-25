#!/usr/bin/env node
// 遍历 src/ 与 public/ 逐个 node --check。
// 以前 package.json 里手写文件清单，插件拆分后文件会增删，清单必然漂移，改成自动发现。

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['src', 'public', 'scripts'];

function walk(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    if (statSync(full).isDirectory()) walk(full, found);
    else if (/\.(?:js|mjs)$/u.test(entry)) found.push(full);
  }
  return found;
}

const files = roots
  .map((name) => path.join(root, name))
  .filter((dir) => { try { return statSync(dir).isDirectory(); } catch { return false; } })
  .flatMap((dir) => walk(dir));

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`[check] ${path.relative(root, file)}`);
    console.error(result.stderr.trim().split('\n').slice(0, 4).join('\n'));
  }
}

console.info(`[check] ${files.length - failed}/${files.length} 个文件语法通过`);
if (failed) process.exitCode = 1;
