#!/usr/bin/env node
// Syntax-checks every plain JavaScript file in the repository with `node --check`, so new files are covered
// automatically instead of relying on a hand-maintained list. React Native sources under apps/ use JSX and are skipped.
import { readdirSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const skip = new Set(['node_modules', 'dist', '.git', '.wrangler', '.expo', 'coverage', 'apps']);
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!skip.has(entry.name)) walk(join(dir, entry.name)); }
    else if (['.js', '.mjs'].includes(extname(entry.name))) files.push(join(dir, entry.name));
  }
})(root);

let failed = 0;
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { failed++; console.error('FAIL ' + relative(root, file) + '\n' + result.stderr); }
}
console.log(`Checked ${files.length} files, ${failed} failed.`);
process.exit(failed ? 1 : 0);
