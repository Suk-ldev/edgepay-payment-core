#!/usr/bin/env node
/**
 * 抓"用了却没导入"的模块级标识符。
 *
 * 起因：request-router.js 调了 receipt-poller.js 的 workerPollerAvailable 却没写进
 * import，三个调用点全是运行时 ReferenceError——Worker 侧收款轮询和收银台状态接口
 * 因此长期失效。node --check 只做语法解析，看不出这种问题；测试也只有真的走到那一行
 * 才会暴露。
 *
 * 判定很保守，只报几乎不可能误判的一种：某个名字是本包内另一个模块的具名导出，
 * 在本文件里被引用，却既没 import、也没在本文件任何位置声明过。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = path.join(root, 'src');

function walk(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, found);
    else if (/\.(?:js|mjs)$/u.test(entry)) found.push(full);
  }
  return found;
}

/** 本文件里出现过的所有具名声明：import 绑定、函数、类、变量、解构、形参。 */
function declaredNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/\bimport\s+([^;]+?)\s+from\s*['"]/gu)) {
    for (const name of match[1].matchAll(/([A-Za-z_$][\w$]*)(?:\s*,|\s*\}|\s*$)/gu)) names.add(name[1]);
  }
  for (const match of source.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/gu)) names.add(match[1]);
  for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gu)) names.add(match[1]);
  // 解构与形参：宁可多收也不要漏收，漏收只会让检查变松，不会误报。
  for (const match of source.matchAll(/[{,(]\s*([A-Za-z_$][\w$]*)\s*[,}:=)]/gu)) names.add(match[1]);
  return names;
}

/** 本文件具名导出的符号。 */
function exportedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gu)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/\bexport\s*\{([^}]*)\}/gu)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/u).pop()?.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** 去掉字符串、模板串和注释，避免把文本里的词当成代码引用。 */
function strippedCode(source) {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//gu, ' ')
    .replaceAll(/(^|[^:])\/\/[^\n]*/gu, '$1 ')
    .replaceAll(/`(?:\\.|[^`\\])*`/gu, ' ')
    .replaceAll(/'(?:\\.|[^'\\\n])*'/gu, ' ')
    .replaceAll(/"(?:\\.|[^"\\\n])*"/gu, ' ');
}

const files = walk(SOURCE_ROOT);
const sources = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));

// 包内所有具名导出 → 它来自哪个模块。
const exportOwners = new Map();
for (const [file, source] of sources) {
  for (const name of exportedNames(source)) {
    if (!exportOwners.has(name)) exportOwners.set(name, path.relative(root, file).replaceAll('\\', '/'));
  }
}

const problems = [];
for (const [file, source] of sources) {
  const declared = declaredNames(source);
  const own = exportedNames(source);
  const code = strippedCode(source);
  const seen = new Set();
  // 前一个字符不能是 . ? 或标识符字符：obj.text() 是成员调用，不是本模块作用域的名字。
  for (const match of code.matchAll(/(?:^|[^.?\w$])([A-Za-z_$][\w$]*)\s*\(/gu)) {
    const name = match[1];
    if (seen.has(name) || declared.has(name) || own.has(name) || !exportOwners.has(name)) continue;
    seen.add(name);
    const line = source.slice(0, source.indexOf(`${name}(`)).split('\n').length;
    problems.push({
      file: path.relative(root, file).replaceAll('\\', '/'),
      line,
      name,
      owner: exportOwners.get(name),
    });
  }
}

for (const problem of problems) {
  console.error(`[imports] ${problem.file}:${problem.line} 使用了 ${problem.name}()，但没有从 ${problem.owner} 导入`);
}
console.info(`[imports] 检查 ${files.length} 个模块，${problems.length} 处缺失导入`);
if (problems.length) process.exitCode = 1;
