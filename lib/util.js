/**
 * Dependency-free helpers shared by both halves of the bridge: digests for
 * tokens, response framing, the request fence's authority parsing, and the
 * inbound rate limiter. No package may be imported here beyond node builtins.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Hex SHA-256 of a UTF-8 string. */
export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Random hex identifier; `bytes` is the entropy, the resulting text is twice as long. */
export function randomHex(bytes = 16) {
  return randomBytes(bytes).toString('hex')
}

/** Issue one wire token: `lzb_` plus 32 hex characters. */
export function issueToken() {
  return `lzb_${randomHex(16)}`
}

/** Compare two secrets without leaking their first differing byte through timing. */
export function secretEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (left.length === 0 || right.length === 0) return false
  const a = Buffer.from(sha256Hex(left), 'hex')
  const b = Buffer.from(sha256Hex(right), 'hex')
  return timingSafeEqual(a, b)
}

/** JSON response that no cache may keep. */
export function jsonResponse(status, value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  })
}

/** Clamp an integer argument, falling back when it is absent or not a number. */
export function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/** Required non-empty string argument. */
export function requireString(value, field, maxLength = 512) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BridgeError('bridge/bad-request', `${field} must be a non-empty string`, { field })
  }
  const trimmed = value.trim()
  if (trimmed.length > maxLength) {
    throw new BridgeError('bridge/bad-request', `${field} is longer than ${String(maxLength)} characters`, { field })
  }
  return trimmed
}

/** Await a timer, cancellation-aware. */
export function sleep(ms, signal) {
  if (signal === undefined) return new Promise(resolve => { setTimeout(resolve, ms) })
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return }
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** Read a request body under a byte cap. */
export async function readBody(req, limitBytes) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) {
      throw new BridgeError('bridge/bad-request', `request body exceeds ${String(limitBytes)} bytes`, {})
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Parse an authority (`host:port`, `[::1]:port`, or a bare host) into its parts.
 * @param value - raw header or config text.
 * @returns `{ host, port }` with the port as a string, or undefined when unparsable.
 */
export function parseAuthority(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim().toLowerCase()
  if (text === '' || text.includes('/') || text.includes('@')) return undefined
  if (text.startsWith('[')) {
    const close = text.indexOf(']')
    if (close < 0) return undefined
    const host = text.slice(1, close)
    const rest = text.slice(close + 1)
    const port = rest.startsWith(':') ? rest.slice(1) : ''
    return { host, port }
  }
  const first = text.indexOf(':')
  if (first < 0) return { host: text, port: '' }
  return { host: text.slice(0, first), port: text.slice(first + 1) }
}

/** A typed failure carrying the protocol's error code. */
export class BridgeError extends Error {
  /**
   * @param code - protocol error code, e.g. `session/not-shared`.
   * @param message - operator-readable detail.
   * @param details - structured extras returned to the caller.
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.details = details
  }
}

/** Sliding-window limiter keyed by peer name. */
export class RateLimiter {
  /**
   * @param limit - allowed hits per window.
   * @param windowMs - window length.
   */
  constructor(limit, windowMs) {
    this.limit = limit
    this.windowMs = windowMs
    this.hits = new Map()
  }

  /**
   * Record one hit.
   * @param key - the peer identity.
   * @returns false when this hit is over the budget.
   */
  hit(key) {
    const now = Date.now()
    const since = now - this.windowMs
    const list = (this.hits.get(key) ?? []).filter(time => time > since)
    if (list.length >= this.limit) {
      this.hits.set(key, list)
      return false
    }
    list.push(now)
    this.hits.set(key, list)
    return true
  }
}
