#!/usr/bin/env node
/**
 * Keep the three version strings in one place.
 *
 * `package.json` is the source of truth. The Host reads `lib/config.js`'s
 * `VERSION` at import time, and the Web panel carries its own copy because the
 * browser bundle is static and cannot read the file. Both are easy to forget:
 * the panel spent three releases (0.5.0, 0.5.1, 0.5.2) still claiming 0.4.4,
 * which made the version badge on the settings page lie.
 *
 * Usage:
 *   node scripts/sync-version.mjs           rewrite the two constants
 *   node scripts/sync-version.mjs --check   exit 1 when either drifted (CI)
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const files = {
  host: join(root, 'lib', 'config.js'),
  panel: join(root, 'client.js'),
}
const patterns = {
  host: /export const VERSION = '([^']+)'/,
  panel: /const PANEL_VERSION = '([^']+)'/,
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const want = pkg.version
const check = process.argv.includes('--check')
const drifted = []

for (const [label, path] of Object.entries(files)) {
  const source = await readFile(path, 'utf8')
  const found = source.match(patterns[label])
  if (found === null) {
    console.error(`${path}: could not find the version constant`)
    process.exit(1)
  }
  if (found[1] === want) continue
  drifted.push(`${label}: ${found[1]} -> ${want}`)
  if (check) continue
  await writeFile(path, source.replace(patterns[label], patterns[label].source.replace('([^\']+)', want)), 'utf8')
}

if (drifted.length === 0) {
  console.log(`versions agree on ${want}`)
  process.exit(0)
}
if (check) {
  console.error(`version drift:\n  ${drifted.join('\n  ')}\nrun: node scripts/sync-version.mjs`)
  process.exit(1)
}
console.log(`synced:\n  ${drifted.join('\n  ')}`)
