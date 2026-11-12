/**
 * Which version is this machine actually running?
 *
 * Two different things can be true at once: the code the Host loaded when it
 * started (`VERSION`, baked into the module) and the code sitting on disk now
 * (`package.json`, which a `git pull` or an npm upgrade rewrites). The Host does
 * not hot-reload plugins, so after an upgrade the running side lags silently —
 * the panel even reloads on every refresh, which makes the pair look newer than
 * the Host driving it. This module reads the second number so both can be shown.
 *
 * @module dsh-lan-bridge/lib/version
 */
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { VERSION } from './config.js'

const MANIFEST = fileURLToPath(new URL('../package.json', import.meta.url))

/** @type {{ stamp: string, version: string } | undefined} */
let cache

/**
 * The version recorded on disk, or `undefined` when the manifest is unreadable.
 * Cached by mtime+size so a polling panel does not stat JSON every 3 seconds.
 */
export async function diskVersion() {
  try {
    const info = await stat(MANIFEST)
    const stamp = `${String(info.mtimeMs)}:${String(info.size)}`
    if (cache?.stamp === stamp) return cache.version
    const parsed = JSON.parse(await readFile(MANIFEST, 'utf8'))
    const version = typeof parsed?.version === 'string' ? parsed.version : undefined
    if (version !== undefined) cache = { stamp, version }
    return version
  } catch {
    return undefined
  }
}

/**
 * Both numbers plus the only conclusion they support.
 *
 * `drift: true` means "the disk has newer code than this process is running" —
 * it is advice to restart the Host, not an error: the older code keeps working.
 */
export async function versionInfo() {
  const disk = await diskVersion()
  return {
    running: VERSION,
    disk,
    drift: disk !== undefined && disk !== VERSION,
  }
}
