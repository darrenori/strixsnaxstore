#!/usr/bin/env node
/**
 * Stamp a version onto every asset URL, at build time.
 *
 *   node scripts/stamp-assets.js
 *
 * Telegram's Android WebView holds a copy of the CSS and the modules far
 * longer than the cache headers ask it to. Correct headers are already set,
 * `max-age=0, must-revalidate`, and it keeps serving the old file anyway. The
 * shopper then sees a fixed bug for days and the only reliable cure anybody
 * can offer is "force close Telegram", which is not something a shop can ask.
 *
 * A URL it has never seen cannot be served from a cache, so the deploy id is
 * appended to each one. ES modules treat two query strings as two modules,
 * which is why the relative imports have to be rewritten as well; stamping
 * only the entry point would leave every module it pulls in stale.
 *
 * This rewrites files inside public/ in place. On Vercel that is a throwaway
 * checkout. Run locally and it will edit your working tree, so it strips any
 * existing stamp first and is safe to run twice, and `git checkout -- public`
 * puts things back.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');

/** The deploy this is, in eight characters. */
function version() {
  const fromVercel = process.env.VERCEL_GIT_COMMIT_SHA;
  if (fromVercel) return fromVercel.slice(0, 8);
  try {
    return execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim().slice(0, 8);
  } catch {
    // No git and no Vercel, so this is somebody running it by hand. A
    // timestamp is still unique, which is the only property that matters.
    return Date.now().toString(36);
  }
}

const v = version();

/** Drop an existing stamp so running twice does not stack them. */
const unstamp = (url) => url.replace(/\?v=[A-Za-z0-9]+/g, '');
const stamp = (url) => `${unstamp(url)}?v=${v}`;

let changed = 0;

// --- the entry point --------------------------------------------------------
const indexPath = path.join(publicDir, 'index.html');
if (fs.existsSync(indexPath)) {
  const before = fs.readFileSync(indexPath, 'utf8');
  const after = before
    .replace(/(href=")(\/css\/[^"]+\.css)(")/g, (_, a, url, c) => `${a}${stamp(url)}${c}`)
    .replace(/(src=")(\/js\/[^"]+\.js)(")/g, (_, a, url, c) => `${a}${stamp(url)}${c}`);
  if (after !== before) { fs.writeFileSync(indexPath, after); changed += 1; }
}

// --- every module it reaches ------------------------------------------------
function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const jsDir = path.join(publicDir, 'js');
if (fs.existsSync(jsDir)) {
  for (const file of jsFiles(jsDir)) {
    const before = fs.readFileSync(file, 'utf8');
    // Only relative specifiers. A bare or absolute one is not ours to touch.
    const after = before.replace(
      /(from\s+['"])(\.\.?\/[^'"]+\.js)(['"])/g,
      (_, a, spec, c) => `${a}${stamp(spec)}${c}`
    );
    if (after !== before) { fs.writeFileSync(file, after); changed += 1; }
  }
}

console.log(`Stamped ${changed} file(s) with v=${v}`);
