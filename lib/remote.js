/**
 * The controller half: this machine talking to a peer's listener.
 *
 * Unary calls only. The peer's `/events` stream exists for consumers that want
 * live frames (the protocol probe, a future remote panel); every tool here
 * resolves through one request, so there is no background socket to leak.
 */
import { BridgeError } from './util.js'

/**
 * Create the outbound client.
 * @param options - `{ cfg, store, logger }`.
 * @returns `{ rpc, hello, probe }`.
 */
export function createRemote({ cfg, store, logger }) {
  function endpoint(peer, path) {
    const base = String(peer.url).replace(/\/+$/, '')
    return `${base}${path}`
  }

  /**
   * Run one RPC against a peer.
   * @param peer - `{ name, url, token }`.
   * @param method - wire method name.
   * @param params - method parameters.
   * @param options - `{ signal, timeoutMs }`.
   * @returns the peer's `result` value.
   */
  async function rpc(peer, method, params = {}, { signal, timeoutMs } = {}) {
    const timeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 30_000
    const timeoutSignal = AbortSignal.timeout(timeout)
    const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
    let response
    try {
      response = await fetch(endpoint(peer, '/rpc'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-dsh-bridge': '1',
          authorization: `Bearer ${peer.token}`,
        },
        body: JSON.stringify({ id: `${Date.now().toString(36)}`, method, params }),
        signal: combined,
        redirect: 'error',
      })
    } catch (error) {
      if (error?.name === 'TimeoutError') {
        throw new BridgeError('bridge/timeout', `${peer.name} did not answer ${method} within ${String(timeout)}ms`, { peer: peer.name })
      }
      if (signal?.aborted === true) {
        throw new BridgeError('bridge/timeout', 'the call was cancelled', { peer: peer.name })
      }
      const cause = error?.cause?.code ?? error?.code ?? (error instanceof Error ? error.message : String(error))
      throw new BridgeError('bridge/unreachable', `${peer.name} is unreachable at ${peer.url} (${String(cause)})`, { peer: peer.name })
    }
    const text = await response.text()
    let payload
    try {
      payload = text === '' ? {} : JSON.parse(text)
    } catch {
      throw new BridgeError('bridge/internal', `${peer.name} returned a non-JSON body (HTTP ${String(response.status)})`, { peer: peer.name })
    }
    if (response.status !== 200) {
      const failure = payload?.error
      throw new BridgeError(
        typeof failure?.code === 'string' ? failure.code : 'bridge/internal',
        typeof failure?.message === 'string' ? failure.message : `HTTP ${String(response.status)} from ${peer.name}`,
        { peer: peer.name },
      )
    }
    if (payload?.ok !== true) {
      const failure = payload?.error
      throw new BridgeError(
        typeof failure?.code === 'string' ? failure.code : 'bridge/internal',
        typeof failure?.message === 'string' ? failure.message : `${peer.name} refused ${method}`,
        { peer: peer.name },
      )
    }
    return payload.result
  }

  /** Ask a peer who it is; also the reachability check. */
  async function hello(peer, options = {}) {
    const value = await rpc(peer, 'bridge.hello', {}, { timeoutMs: 5000, ...options })
    if (value?.protocol !== 1) {
      throw new BridgeError('bridge/method-unavailable', `${peer.name} speaks protocol ${String(value?.protocol)}; this bridge speaks 1`, { peer: peer.name })
    }
    return value
  }

  /**
   * Resolve one configured peer by name.
   * @param name - the `lan_dsh_peers add` name.
   * @returns `{ name, url, token }`.
   */
  async function peer(name) {
    const record = await store.outboundPeer(name)
    if (record === undefined) {
      const known = (await store.outbound()).map(item => item.name)
      throw new BridgeError('bridge/bad-request', known.length === 0
        ? `no peer named ${name}; this machine has no peers yet (use lan_dsh_peers add)`
        : `no peer named ${name}; known peers: ${known.join(', ')}`, { known })
    }
    return record
  }

  return { rpc, hello, peer }
}

/** Peer status as reported to tools and the panel. */
export async function describePeer(remote, record, cache, logger) {
  const cached = cache.get(record.name)
  if (cached !== undefined && Date.now() - cached.at < 10_000) return cached.value
  let value
  try {
    const hello = await remote.hello(record)
    value = { name: record.name, url: record.url, reachable: true, peerName: hello.name, capabilities: hello.capabilities }
  } catch (error) {
    logger?.info?.(`lan-bridge: peer ${record.name} unreachable: ${error instanceof Error ? error.message : String(error)}`)
    value = { name: record.name, url: record.url, reachable: false, error: error instanceof Error ? error.message : String(error) }
  }
  cache.set(record.name, { at: Date.now(), value })
  return value
}

/** Shared reachability cache for tools and the panel. */
export function createPeerCache() {
  return new Map()
}
