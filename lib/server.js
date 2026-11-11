/**
 * The listener: a private HTTP(S) endpoint for paired peers only.
 *
 * It is deliberately NOT the DSH Web listener. The desktop shell binds that one
 * to 127.0.0.1 and authenticates browsers with a launch-token cookie; a peer is
 * not a browser, so the bridge owns its own socket, its own bearer tokens and
 * its own request fence. Everything a peer can reach is decided here.
 */
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFile } from 'node:fs/promises'
import { BridgeError, RateLimiter, jsonResponse, parseAuthority, readBody, secretEquals } from './util.js'
import { assignSettings, localAddresses, refuseReason } from './config.js'

/** How long one `/events` stream may stay open before it is closed. */
const MAX_STREAM_MS = 30 * 60 * 1000
const HEARTBEAT_MS = 15_000

/**
 * Create the listener facade.
 * @param options - `{ ctx, cfg, store, api, logger }`.
 * @returns `{ start, stop, status, authorities }`.
 */
export function createServer({ ctx, cfg, store, api, logger }) {
  const status = { listening: false, host: cfg.hostname, port: cfg.port, protocol: cfg.tls === null ? 'http' : 'https', error: undefined }
  const limiter = new RateLimiter(cfg.rateLimitPerMinute, 60_000)
  const streams = new Set()
  let server
  let closing = false

  const authorities = new Set()
  function rememberAuthorities(port) {
    // A peer reaches us at its own idea of our address: whatever literal the
    // operator bound, every interface address, and any hostname the operator
    // allowlisted through `trustedHosts`.
    const list = [cfg.hostname, '127.0.0.1', 'localhost', '::1', '[::1]', ...localAddresses()]
    for (const host of list) {
      authorities.add(`${host}:${String(port)}`.toLowerCase())
      if (host === '::1') authorities.add(`[::1]:${String(port)}`.toLowerCase())
    }
    for (const entry of cfg.trustedHosts) authorities.add(entry.toLowerCase())
  }

  /** Rebuild the Host-header authority set after a settings change. */
  function rebuildAuthorities() {
    authorities.clear()
    rememberAuthorities(status.port)
  }

  /** Reject anything that is not a peer speaking to the authority we bound. */
  function checkFence(req) {
    if (req.headers.origin !== undefined) {
      throw new BridgeError('bridge/forbidden', 'browser origins are refused: peers are not browsers', {})
    }
    // `sec-fetch-site` / `sec-fetch-dest` only ever come from a browser. Plain
    // `sec-fetch-mode: cors` is what Node's own `fetch` sends, so it is not by
    // itself evidence of a browser — and a real browser cannot reach us anyway:
    // the custom `X-DSH-Bridge` header forces a preflight, which is refused below.
    if (req.headers['sec-fetch-site'] !== undefined || req.headers['sec-fetch-dest'] !== undefined) {
      throw new BridgeError('bridge/forbidden', 'browser fetch metadata is refused', {})
    }
    if (req.headers['x-dsh-bridge'] !== '1') {
      throw new BridgeError('bridge/forbidden', 'missing X-DSH-Bridge header', {})
    }
    const parsed = parseAuthority(req.headers.host)
    if (parsed === undefined) throw new BridgeError('bridge/forbidden', 'unparsable Host header', {})
    const normal = parsed.port === '' ? parsed.host : `${parsed.host}:${parsed.port}`
    const withPort = parsed.port === '' ? `${parsed.host}:${String(status.port)}` : normal
    if (!authorities.has(normal.toLowerCase()) && !authorities.has(withPort.toLowerCase())) {
      throw new BridgeError('bridge/forbidden', `Host ${normal} is not one of this bridge's authorities`, { host: normal })
    }
  }

  /** Resolve the bearer token to a peer and enforce the per-peer budget. */
  async function authenticate(req) {
    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) {
      throw new BridgeError('bridge/unauthorized', 'missing bearer token', {})
    }
    const token = header.slice(7).trim()
    const peer = await store.authenticate(token)
    if (peer === undefined) throw new BridgeError('bridge/unauthorized', 'unknown or revoked token', {})
    if (!limiter.hit(peer.name)) {
      throw new BridgeError('bridge/rate-limited', 'too many requests from this peer', {})
    }
    void store.touch(peer.name)
    return peer
  }

  async function handleRpc(req, res) {
    const peer = await authenticate(req)
    const raw = await readBody(req, cfg.maxBodyBytes)
    let envelope
    try {
      envelope = JSON.parse(raw === '' ? '{}' : raw)
    } catch {
      throw new BridgeError('bridge/bad-request', 'request body is not JSON', {})
    }
    const method = typeof envelope?.method === 'string' ? envelope.method : ''
    if (method === '') throw new BridgeError('bridge/bad-request', 'method is required', {})
    const id = envelope?.id
    const signal = new AbortController()
    const onClose = () => { signal.abort() }
    res.on('close', onClose)
    const started = Date.now()
    try {
      const result = await api.dispatch(method, envelope?.params ?? {}, peer, signal.signal)
      await store.audit({ peer: peer.name, method, ok: true, ms: Date.now() - started, sessionId: sessionIdOf(envelope?.params) })
      send(res, 200, { id, ok: true, result })
    } catch (error) {
      const failure = normalize(error)
      await store.audit({
        peer: peer.name,
        method,
        ok: false,
        code: failure.code,
        ms: Date.now() - started,
        sessionId: sessionIdOf(envelope?.params),
      })
      if (failure.code === 'bridge/timeout') {
        send(res, 200, { id, ok: false, error: failure })
        return
      }
      send(res, 200, { id, ok: false, error: failure })
    } finally {
      res.off('close', onClose)
    }
  }

  async function handleEvents(req, res) {
    const peer = await authenticate(req)
    if (!peer.capabilities.includes('read')) {
      throw new BridgeError('bridge/forbidden', `peer ${peer.name} lacks read`, {})
    }
    const url = new URL(req.url ?? '/', 'http://placeholder')
    const sessionId = url.searchParams.get('session') ?? ''
    if (sessionId === '') throw new BridgeError('bridge/bad-request', 'session query parameter is required', {})
    if (!await store.isShared(sessionId)) {
      throw new BridgeError('session/not-shared', `Session ${sessionId} is not shared by its operator`, { sessionId })
    }
    const assistant = url.searchParams.get('assistant') === '1'
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const controller = new AbortController()
    const heartbeat = setInterval(() => { safeWrite(res, ': heartbeat\n\n') }, HEARTBEAT_MS)
    const deadline = setTimeout(() => { controller.abort() }, MAX_STREAM_MS)
    const close = () => { controller.abort() }
    res.on('close', close)
    streams.add(controller)
    const service = ctx.get('sessionController')
    try {
      if (service === undefined) throw new BridgeError('bridge/method-unavailable', 'no sessionController', {})
      const request = { address: { kind: 'session', sessionId }, maxMessages: cfg.maxMessages }
      if (assistant) request.assistantStream = true
      for await (const frame of service.follow(request, controller.signal)) {
        if (res.writableEnded) break
        safeWrite(res, `event: frame\ndata: ${JSON.stringify(frame)}\n\n`)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        safeWrite(res, `event: error\ndata: ${JSON.stringify(normalize(error))}\n\n`)
      }
    } finally {
      clearInterval(heartbeat)
      clearTimeout(deadline)
      res.off('close', close)
      streams.delete(controller)
      await store.audit({ peer: peer.name, method: 'events', ok: true, sessionId })
      if (!res.writableEnded) res.end()
    }
  }

  async function handler(req, res) {
    try {
      const path = (req.url ?? '/').split('?')[0]
      if (path === '/healthz') {
        if (req.method !== 'GET') { send(res, 405, { ok: false }); return }
        send(res, 200, { ok: true, app: 'dsh-lan-bridge', protocol: 1, name: cfg.name })
        return
      }
      if (req.method === 'OPTIONS') {
        throw new BridgeError('bridge/forbidden', 'preflight requests are not served', {})
      }
      if (path === '/rpc') {
        if (req.method !== 'POST') { send(res, 405, { ok: false, error: normalize(new BridgeError('bridge/bad-request', 'POST required')) }); return }
        checkFence(req)
        await handleRpc(req, res)
        return
      }
      if (path === '/events') {
        if (req.method !== 'GET') { send(res, 405, { ok: false }); return }
        checkFence(req)
        await handleEvents(req, res)
        return
      }
      throw new BridgeError('bridge/not-found', `no route for ${path}`, {})
    } catch (error) {
      const failure = normalize(error)
      const httpStatus = statusFor(failure.code)
      if (!res.writableEnded) send(res, httpStatus, { ok: false, error: failure })
    }
  }

  /** Bind the socket from the current `cfg`. Failures are reported, not thrown. */
  async function startSocket() {
    const reason = refuseReason(cfg)
    if (reason !== undefined) {
      status.error = reason
      logger?.warn?.(`lan-bridge: listener not started — ${reason}`)
      return status
    }
    try {
      if (cfg.tls === null) {
        server = createHttpServer((req, res) => { void handler(req, res) })
      } else {
        const [cert, key] = await Promise.all([readFile(cfg.tls.certFile), readFile(cfg.tls.keyFile)])
        server = createHttpsServer({ cert, key }, (req, res) => { void handler(req, res) })
      }
      server.on('clientError', (_error, socket) => { socket.destroy() })
      const current = server
      await new Promise((resolve, reject) => {
        const onError = (error) => { current.off('listening', onListening); reject(error) }
        const onListening = () => { current.off('error', onError); resolve() }
        current.once('error', onError)
        current.once('listening', onListening)
        current.listen(cfg.port, cfg.hostname)
      })
      const address = current.address()
      if (address !== null && typeof address === 'object') status.port = address.port
      rememberAuthorities(status.port)
      status.listening = true
      status.error = undefined
      logger?.info?.(`lan-bridge: listening on ${status.protocol}://${cfg.hostname}:${String(status.port)} (${cfg.role})`)
    } catch (error) {
      status.listening = false
      status.error = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`lan-bridge: listener failed — ${status.error}`)
      server?.close()
      server = undefined
    }
    return status
  }

  return {
    status,
    authorities,

    /** Bind the socket. Failures are reported, never thrown into the Host boot. */
    start() {
      return startSocket()
    },

    /** Close the socket and every open stream. */
    async stop() {
      closing = true
      await closeSocket()
    },

    /** Rebuild the Host-header authority set (after `trustedHosts` changed). */
    refreshAuthorities() {
      rebuildAuthorities()
    },

    /**
     * Apply an operator settings change to the live listener.
     *
     * A bind-address or TLS change necessarily means closing the socket and
     * rebinding, so in-flight peer calls fail; if the new bind does not work
     * the previous settings are restored and the old socket comes back, which
     * keeps a bad host/port from leaving the machine unreachable until the next
     * Host restart. Every other field is applied without touching the socket.
     *
     * @param next - validated settings (`host/port/insecureHttp/tls/trustedHosts/...`).
     * @returns the listener status.
     */
    async reconfigure(next) {
      const before = {
        hostname: cfg.hostname,
        port: cfg.port,
        insecureHttp: cfg.insecureHttp,
        tls: cfg.tls,
        trustedHosts: [...cfg.trustedHosts],
        statusHost: status.host,
        statusPort: status.port,
        statusProtocol: status.protocol,
      }
      const tlsChanged = JSON.stringify(next.tls ?? null) !== JSON.stringify(cfg.tls ?? null)
      const rebind = next.host !== cfg.hostname || next.port !== cfg.port || tlsChanged
      assignSettings(cfg, next)
      status.host = cfg.hostname
      if (!rebind) {
        rebuildAuthorities()
        const reason = refuseReason(cfg)
        status.error = reason
        return status
      }
      await closeSocket()
      status.listening = false
      status.port = cfg.port
      status.protocol = cfg.tls === null ? 'http' : 'https'
      // A controller-only bridge owns tools, not a socket: persist the choice
      // but never bind it.
      if (!cfg.listening) {
        status.error = refuseReason(cfg)
        return status
      }
      const started = await startSocket()
      if (!started.listening) {
        // Put the operator back where they were instead of leaving them with a
        // dead socket: restore the previous settings and try the old bind once.
        const failure = status.error
        // Roll back to the exact socket we had: when the operator asked the OS
        // for a port (0), `before.port` is meaningless after the fact, so pin
        // the concrete port that was actually serving instead of drifting to a
        // new ephemeral one that peers do not know.
        const restoredPort = before.port === 0 ? before.statusPort : before.port
        assignSettings(cfg, {
          host: before.hostname,
          port: restoredPort,
          insecureHttp: before.insecureHttp,
          allowPeersToCreateSessions: cfg.allowPeersToCreateSessions,
          trustedHosts: before.trustedHosts,
          tls: before.tls,
        })
        status.host = before.statusHost
        status.port = before.statusPort
        status.protocol = before.statusProtocol
        await startSocket()
        throw new BridgeError(
          'bridge/internal',
          `监听重建失败：${String(failure)}（已恢复为 ${before.hostname}:${String(before.statusPort)}${status.listening ? '' : '，恢复也失败，请检查端口占用'}）`,
          { reason: failure, restored: status.listening },
        )
      }
      return status
    },

    /** Whether the listener is up and accepting peers. */
    get closed() {
      return closing
    },
  }

  /** Close the current socket without touching `closing` (reconfigure keeps serving). */
  async function closeSocket() {
    for (const controller of streams) controller.abort()
    streams.clear()
    const current = server
    server = undefined
    status.listening = false
    if (current === undefined) return
    await new Promise((resolve) => { current.close(() => { resolve() }) })
  }

  function send(res, statusCode, value) {
    if (res.writableEnded) return
    const text = JSON.stringify(value)
    res.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  function safeWrite(res, text) {
    if (res.writableEnded) return
    try { res.write(text) } catch { /* the peer went away */ }
  }
}

/** Constant-time comparison kept here so a future signed-header check reuses it. */
export const compareSecrets = secretEquals

function sessionIdOf(params) {
  const value = params !== null && typeof params === 'object' ? params.sessionId : undefined
  return typeof value === 'string' ? value : undefined
}

/** Turn any thrown value into the protocol's error shape. */
function normalize(error) {
  if (error instanceof BridgeError) {
    return { code: error.code, message: error.message, details: error.details ?? {} }
  }
  const code = typeof error?.code === 'string' ? error.code : undefined
  const message = error instanceof Error ? error.message : String(error)
  if (code !== undefined && code.startsWith('session/')) {
    return { code, message, details: error?.details ?? {} }
  }
  if (code !== undefined && (code.startsWith('gateway/') || code.startsWith('bridge/'))) {
    return { code, message, details: error?.details ?? {} }
  }
  return { code: 'bridge/internal', message, details: {} }
}

function statusFor(code) {
  if (code === 'bridge/unauthorized') return 401
  if (code === 'bridge/forbidden') return 403
  if (code === 'bridge/rate-limited') return 429
  if (code === 'bridge/not-found') return 404
  if (code === 'bridge/bad-request') return 400
  if (code === 'bridge/timeout') return 504
  return 500
}

/** Response helper shared with the browser-facing routes. */
export { jsonResponse }
