/**
 * File transfer inside declared roots.
 *
 * The wire never carries an absolute path: a caller names a configured root and
 * a POSIX-style relative path, and this module is the only thing that turns that
 * into a real location. Every segment is validated before it reaches the
 * filesystem, and the resolved parent must still live inside the root after
 * `realpath`, so a symlink cannot walk out of a root either.
 *
 * Uploads are staged next to the bridge state and only `rename`d into place
 * after the digest matches, which keeps a half-sent file from ever appearing at
 * the destination under the caller's name.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { BridgeError, clampInt } from './util.js'

/** Defaults for the `files` block; everything is off until the operator opts in. */
export const FILE_DEFAULTS = {
  enabled: false,
  maxFileBytes: 256 * 1024 * 1024,
  chunkBytes: 256 * 1024,
  stagingTtlMs: 10 * 60 * 1000,
}

/** Smallest/largest chunk a caller may ask for; also bounds one base64 body. */
const CHUNK_MIN = 16 * 1024
const CHUNK_MAX = 512 * 1024

/** Names Windows refuses to create, whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

const SHA256 = /^[0-9a-f]{64}$/

/**
 * Normalise the `files` config block.
 *
 * Roots keep their configured path verbatim: it is local configuration, and the
 * panel shows it so the operator can see what was shared. The peer-facing
 * `files.roots` reply only ever carries the name, not the path.
 *
 * @param raw - `{ enabled?, maxFileBytes?, chunkBytes?, stagingTtlMs?, roots?: [] }`.
 * @returns a complete files block.
 */
export function normalizeFiles(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const positive = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback)
  const roots = []
  const seen = new Set()
  for (const entry of Array.isArray(source.roots) ? source.roots : []) {
    if (entry === null || typeof entry !== 'object') continue
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    const path = typeof entry.path === 'string' ? entry.path.trim() : ''
    if (name === '' || path === '') continue
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name)) continue
    if (seen.has(name)) continue
    seen.add(name)
    roots.push({ name, path, writable: entry.writable === true })
  }
  return {
    enabled: source.enabled === true,
    maxFileBytes: positive(source.maxFileBytes, FILE_DEFAULTS.maxFileBytes),
    chunkBytes: clampInt(positive(source.chunkBytes, FILE_DEFAULTS.chunkBytes), CHUNK_MIN, CHUNK_MAX, FILE_DEFAULTS.chunkBytes),
    stagingTtlMs: positive(source.stagingTtlMs, FILE_DEFAULTS.stagingTtlMs),
    roots,
  }
}

function bad(message, details) {
  return new BridgeError('bridge/bad-request', message, details)
}

function forbidden(message, details) {
  return new BridgeError('bridge/forbidden', message, details)
}

/**
 * Split a wire path into segments, rejecting everything that could address
 * something other than a file inside a root.
 * @param relPath - POSIX-style relative path; `''` and `'.'` mean the root.
 * @returns segment list; empty for the root itself.
 */
export function splitPath(relPath) {
  if (typeof relPath !== 'string') throw bad('path must be a string', { field: 'path' })
  if (relPath === '' || relPath === '.') return []
  // A malformed path is a bad request, not a privilege problem: telling the caller
  // to "go grant the files capability" here would send an operator chasing a
  // permission that is already fine.
  if (relPath.includes('\0')) throw bad('path contains NUL', { field: 'path' })
  if (relPath.startsWith('/') || relPath.startsWith('\\')) throw bad('path must be relative to the root, not absolute', { field: 'path' })
  if (/^[a-z]:/i.test(relPath)) throw bad('a drive-qualified path is not accepted; use ("root","relative/path")', { field: 'path' })
  if (relPath.includes('\\')) throw bad('use forward slashes in path; backslashes are rejected so the two platforms agree', { field: 'path' })
  const segments = relPath.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw bad(`path segment ${JSON.stringify(segment)} is not allowed`, { field: 'path' })
    }
    if (RESERVED.test(segment)) throw bad(`path segment ${JSON.stringify(segment)} is a reserved device name on Windows`, { field: 'path' })
    // Windows silently strips these, so a name that differs only by a trailing
    // dot/space would resolve to a different file than the caller thinks.
    if (/[. ]$/.test(segment)) throw bad(`path segment ${JSON.stringify(segment)} ends with a dot or space`, { field: 'path' })
    if (/[\u0000-\u001f\u007f<>:"|?*]/.test(segment)) throw bad(`path segment ${JSON.stringify(segment)} contains a character the filesystems reject`, { field: 'path' })
  }
  return segments
}

/** Pick one configured root by name. */
export function rootOf(cfg, name) {
  const roots = cfg.files?.roots ?? []
  const match = roots.find(entry => entry.name === name)
  if (match === undefined) {
    const known = roots.map(entry => entry.name).join(', ')
    throw new BridgeError('bridge/not-found', `no configured root named ${JSON.stringify(String(name))}`, { root: String(name), known })
  }
  return match
}

async function realRoot(root) {
  try {
    return await realpath(root.path)
  } catch {
    throw new BridgeError('bridge/not-found', `root ${JSON.stringify(root.name)} is not available on this machine`, { root: root.name })
  }
}

/**
 * Resolve `(root, path)` to a real location, refusing anything that escapes.
 * @param root - one configured root.
 * @param relPath - wire path.
 * @param options - `{ createParents }` for writes.
 * @returns `{ base, target }`.
 */
export async function resolveTarget(root, relPath, { createParents = false } = {}) {
  const segments = splitPath(relPath)
  const base = await realRoot(root)
  const target = segments.length === 0 ? base : join(base, ...segments)
  if (!(target === base || target.startsWith(base + sep))) {
    throw forbidden('path escapes the root', { root: root.name })
  }
  if (segments.length === 0) return { base, target, segments }
  const parent = dirname(target)
  if (createParents) {
    try {
      await mkdir(parent, { recursive: true })
    } catch {
      throw bad('could not create the parent directory', { field: 'path' })
    }
  }
  let realParent
  try {
    realParent = await realpath(parent)
  } catch {
    throw new BridgeError('bridge/not-found', 'parent directory does not exist', { field: 'path' })
  }
  if (!(realParent === base || realParent.startsWith(base + sep))) {
    throw forbidden('the parent directory resolves outside the root (symlink?)', { root: root.name })
  }
  return { base, target, segments }
}

/**
 * Follow an existing path and refuse it if it lands outside the root.
 *
 * The lexical check in `resolveTarget` cannot see through a symlink, so every
 * operation that actually touches an existing entry re-checks after `realpath`.
 * A missing path is not an escape: the caller decides what absence means.
 *
 * @returns the real path when it exists, `undefined` when it does not.
 */
async function realInside(base, target) {
  let real
  try {
    real = await realpath(target)
  } catch {
    return undefined
  }
  if (!(real === base || real.startsWith(base + sep))) {
    throw forbidden('the path resolves outside the root (symlink?)')
  }
  return real
}

/** SHA-256 of one file, streamed so a large file never lands in memory. */
export function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => { resolvePromise(hash.digest('hex')) })
  })
}

/**
 * The peer-facing file service for this machine.
 *
 * One upload at a time per peer keeps a single caller from filling the staging
 * area, and each staged byte is counted as it arrives so the size limit is
 * enforced before the disk sees more than it should.
 *
 * @param options - `{ cfg, store, logger }`.
 * @returns the method set used by the RPC table.
 */
export function createFiles({ cfg, store, logger }) {
  /** uploadId -> staged upload. */
  const uploads = new Map()
  /** peer -> uploadId, so one peer cannot run two uploads at once. */
  const busy = new Map()

  const stagingDir = () => join(cfg.stateDir, 'staging')

  function filesGuard() {
    if (cfg.files?.enabled !== true) {
      throw forbidden('file transfer is off on this machine (files.enabled): ask the operator to enable it and grant the "files" capability', { field: 'files' })
    }
  }

  function rootFor(name, { writable = false } = {}) {
    const root = rootOf(cfg, name)
    if (writable && root.writable !== true) {
      throw forbidden(`root ${JSON.stringify(root.name)} is read-only`, { root: root.name })
    }
    return root
  }

  async function cleanupOne(upload, reason) {
    uploads.delete(upload.id)
    if (upload.timer !== undefined) clearTimeout(upload.timer)
    if (busy.get(upload.peer) === upload.id) busy.delete(upload.peer)
    try { await upload.handle?.close() } catch { /* already closed */ }
    try { await unlink(upload.temp) } catch { /* already gone */ }
    if (reason !== undefined) logger?.info?.(`lan-bridge: dropped staging ${upload.id} (${reason})`)
  }

  return {
    /** `files.roots` — names only, never the local directory layout. */
    roots() {
      filesGuard()
      return {
        roots: (cfg.files?.roots ?? []).map(root => ({
          name: root.name,
          writable: root.writable === true,
          maxBytes: cfg.files.maxFileBytes,
        })),
        chunkBytes: cfg.files.chunkBytes,
        maxFileBytes: cfg.files.maxFileBytes,
      }
    },

    async stat({ root, path, digest }) {
      filesGuard()
      const target = await resolveTarget(rootFor(root), String(path ?? ''))
      const real = (await realInside(target.base, target.target)) ?? target.target
      let info
      try {
        info = await stat(real)
      } catch {
        throw new BridgeError('bridge/not-found', 'no such file or directory inside that root', { field: 'path' })
      }
      const result = { size: info.size, mtimeMs: info.mtimeMs, isDirectory: info.isDirectory() }
      if (digest === true && info.isDirectory() !== true) result.sha256 = await sha256File(real)
      return result
    },

    async list({ root, path }) {
      filesGuard()
      const target = await resolveTarget(rootFor(root), String(path ?? ''))
      const realDir = (await realInside(target.base, target.target)) ?? target.target
      const names = await readdir(realDir, { withFileTypes: true }).catch(() => {
        throw new BridgeError('bridge/not-found', 'no such directory inside that root', { field: 'path' })
      })
      const entries = []
      for (const entry of names) {
        const full = join(realDir, entry.name)
        let info
        try {
          info = await stat(full)
        } catch {
          continue
        }
        entries.push({ name: entry.name, isDirectory: info.isDirectory(), size: info.size, mtimeMs: info.mtimeMs })
      }
      entries.sort((left, right) => (left.isDirectory === right.isDirectory ? left.name.localeCompare(right.name) : left.isDirectory ? -1 : 1))
      return { entries, path: String(path ?? '') }
    },

    async read({ root, path, offset, length }, peer) {
      filesGuard()
      const target = await resolveTarget(rootFor(root), String(path ?? ''))
      const realFile = (await realInside(target.base, target.target)) ?? target.target
      const info = await stat(realFile).catch(() => {
        throw new BridgeError('bridge/not-found', 'no such file inside that root', { field: 'path' })
      })
      if (info.isDirectory()) throw bad('path names a directory, not a file', { field: 'path' })
      const start = clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0)
      const want = clampInt(length, 1, cfg.files.chunkBytes, cfg.files.chunkBytes)
      const handle = await open(realFile, 'r')
      try {
        const buffer = Buffer.alloc(Math.max(0, Math.min(want, info.size - start)))
        const { bytesRead } = buffer.length === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, buffer.length, start)
        const data = buffer.subarray(0, bytesRead)
        const eof = start + bytesRead >= info.size
        if (eof) {
          const digest = await sha256File(realFile)
          await store.audit({
            peer: peer?.name ?? '?', method: 'files.read', direction: 'read',
            root: String(root), path: String(path ?? ''), bytes: info.size, sha256: digest, outcome: 'ok',
          })
        }
        return { data: data.toString('base64'), eof, size: info.size, offset: start }
      } finally {
        await handle.close()
      }
    },

    async begin({ root, path, size, sha256, overwrite, createParents }, peer) {
      filesGuard()
      const bytes = size
      if (!Number.isInteger(bytes) || bytes < 0) throw bad('size must be a non-negative integer', { field: 'size' })
      if (bytes > cfg.files.maxFileBytes) {
        throw bad(`file is ${String(bytes)} bytes, larger than this machine allows (${String(cfg.files.maxFileBytes)})`, { field: 'size', maxFileBytes: cfg.files.maxFileBytes })
      }
      const digest = typeof sha256 === 'string' ? sha256.toLowerCase() : ''
      if (!SHA256.test(digest)) throw bad('sha256 must be 64 lowercase hex characters', { field: 'sha256' })
      const peerName = peer?.name ?? '?'
      if (busy.has(peerName)) {
        throw new BridgeError('bridge/rate-limited', 'this peer already has one upload in flight; finish or abort it first', { peer: peerName })
      }
      const writableRoot = rootFor(root, { writable: true })
      const target = await resolveTarget(writableRoot, String(path ?? ''), { createParents: createParents === true })
      if (target.segments.length === 0) throw bad('path must name a file, not the root', { field: 'path' })
      let existing
      try {
        existing = await stat(target.target)
      } catch {
        existing = undefined
      }
      if (existing !== undefined) {
        if (existing.isDirectory()) throw bad('path already exists as a directory', { field: 'path' })
        if (overwrite !== true) {
          throw new BridgeError('bridge/conflict', 'target already exists; pass overwrite: true to replace it', { field: 'path' })
        }
      }
      await mkdir(stagingDir(), { recursive: true })
      const id = randomUUID()
      const temp = join(stagingDir(), `${id}.part`)
      const handle = await open(temp, 'w+')
      const upload = {
        id, peer: peerName, root: writableRoot.name, relPath: String(path ?? ''), temp,
        size: bytes, sha256: digest, received: 0, nextIndex: 0, handle, target: target.target,
        expiresAt: Date.now() + cfg.files.stagingTtlMs,
      }
      upload.timer = setTimeout(() => { void cleanupOne(upload, 'expired') }, cfg.files.stagingTtlMs)
      upload.timer.unref?.()
      uploads.set(id, upload)
      busy.set(peerName, id)
      return { uploadId: id, chunkBytes: cfg.files.chunkBytes, expiresAt: upload.expiresAt }
    },

    async chunk({ uploadId, index, data }, peer) {
      filesGuard()
      const upload = uploads.get(String(uploadId ?? ''))
      if (upload === undefined) throw new BridgeError('bridge/not-found', 'no such upload (expired or aborted)', { field: 'uploadId' })
      if (upload.peer !== (peer?.name ?? '?')) throw forbidden('this upload belongs to another peer', { field: 'uploadId' })
      if (Date.now() > upload.expiresAt) {
        await cleanupOne(upload, 'expired')
        throw new BridgeError('bridge/timeout', 'upload expired before it was committed', { field: 'uploadId' })
      }
      if (index !== upload.nextIndex) {
        throw bad(`expected chunk ${String(upload.nextIndex)}, received ${String(index)}`, { field: 'index' })
      }
      if (typeof data !== 'string' || data === '') throw bad('data must be a non-empty base64 string', { field: 'data' })
      const buffer = Buffer.from(data, 'base64')
      if (buffer.length > cfg.files.chunkBytes) {
        throw bad(`chunk is ${String(buffer.length)} bytes, larger than chunkBytes ${String(cfg.files.chunkBytes)}`, { field: 'data' })
      }
      if (upload.received + buffer.length > upload.size) {
        throw bad('chunks add up to more than the declared size', { field: 'data' })
      }
      await upload.handle.write(buffer, 0, buffer.length, upload.received)
      upload.received += buffer.length
      upload.nextIndex += 1
      return { received: upload.received }
    },

    async commit({ uploadId }, peer) {
      filesGuard()
      const upload = uploads.get(String(uploadId ?? ''))
      if (upload === undefined) throw new BridgeError('bridge/not-found', 'no such upload (expired or aborted)', { field: 'uploadId' })
      if (upload.peer !== (peer?.name ?? '?')) throw forbidden('this upload belongs to another peer', { field: 'uploadId' })
      await upload.handle.close()
      if (upload.received !== upload.size) {
        await cleanupOne(upload, 'size mismatch')
        throw bad(`received ${String(upload.received)} bytes but the upload declared ${String(upload.size)}`, { field: 'size' })
      }
      const actual = await sha256File(upload.temp)
      if (actual !== upload.sha256) {
        await cleanupOne(upload, 'digest mismatch')
        throw bad('sha256 of the received bytes does not match the declared digest', { field: 'sha256', expected: upload.sha256, actual })
      }
      // Re-check containment right before the move: a directory could have been
      // swapped for a symlink while the bytes were in flight.
      const target = await resolveTarget({ name: upload.root, path: rootOf(cfg, upload.root).path }, upload.relPath)
      await rename(upload.temp, target.target)
      const record = { root: upload.root, path: upload.relPath, size: upload.size, sha256: actual }
      uploads.delete(upload.id)
      if (upload.timer !== undefined) clearTimeout(upload.timer)
      if (busy.get(upload.peer) === upload.id) busy.delete(upload.peer)
      await store.audit({
        peer: upload.peer, method: 'files.commit', direction: 'write',
        root: upload.root, path: upload.relPath, bytes: upload.size, sha256: actual, outcome: 'ok',
      })
      return record
    },

    async abort({ uploadId }, peer) {
      filesGuard()
      const upload = uploads.get(String(uploadId ?? ''))
      if (upload === undefined) return { ok: true, dropped: false }
      if (upload.peer !== (peer?.name ?? '?')) throw forbidden('this upload belongs to another peer', { field: 'uploadId' })
      await cleanupOne(upload, 'aborted by peer')
      return { ok: true, dropped: true }
    },

    /** Drop staging files left over by a crash, and stage nothing older than TTL. */
    async cleanup() {
      try {
        const names = await readdir(stagingDir())
        const now = Date.now()
        for (const name of names) {
          if (!name.endsWith('.part')) continue
          const full = join(stagingDir(), name)
          try {
            const info = await stat(full)
            if (now - info.mtimeMs > cfg.files.stagingTtlMs) await rm(full, { force: true })
          } catch { /* a concurrent upload may have taken it */ }
        }
      } catch { /* no staging directory yet */ }
    },

    /** Stop every timer, so a Host shutdown is not held open by staging. */
    async close() {
      for (const upload of [...uploads.values()]) await cleanupOne(upload, 'shutdown')
    },

    /** Test/reporting hook: how many uploads are live right now. */
    pending() {
      return uploads.size
    },
  }
}
