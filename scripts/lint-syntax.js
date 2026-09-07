#!/usr/bin/env node
/** Parse every source file so a typo cannot reach a deploy. */
import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { execFileSync } from 'node:child_process';

const roots = ['src', 'public/js', 'scripts'];
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (extname(full) === '.js') files.push(full);
  }
}
for (const root of roots) walk(root);

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed += 1;
    console.error(`❌ ${file}`);
    console.error(String(err.stderr ?? err.message).trim().split('\n').slice(0, 4).join('\n'));
  }
}

console.log(`${failed ? '❌' : '✅'} ${files.length - failed}/${files.length} files parsed cleanly`);
process.exit(failed ? 1 : 0);
