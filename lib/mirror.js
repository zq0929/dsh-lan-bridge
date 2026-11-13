/**
 * Mirror pairing: one action on one machine leaves *both* machines paired, with
 * the same capability set in both directions.
 *
 * Why this exists. A bridge pair is two independent secrets — one per direction
 * — so the operator used to mint twice, mail a token each way, and `grant` each
 * side separately. Worse, the machine that was *called* had no way to call back:
 * it held no address and no token for the caller, so "can I reach them" and "can
 * they reach me" were unrelated questions.
 *
 * Shape of the handshake, with the human decision kept on the machine being
 * asked:
 *
 *   1. A mints a token for B (so B may call A with `capabilities`), then calls
 *      B's `pair.mirror` with `{ name, url, capabilities, token }`.
 *   2. B stores that as a *pending request* and shows it in its panel. When B's
 *      operator accepts, B stores an outbound peer for A using A's token, mints
 *      its own token for A with the same `capabilities`, and calls A's
 *      `pair.mirrorResult` with it.
 *
 * Both directions therefore end up holding the same capability set — the one
 * the initiator declared — and neither side gains a capability the other does
 * not also grant.
 *
 * Auto-accept (`cfg.autoAcceptMirror`) exists for a lab where the operator does
 * not want to click twice, but it is off by default: accepting a mirror hands a
 * bearer token to a machine that just introduced itself over the wire.
 */
import { BridgeError } from './util.js'
import { CAPABILITIES, DEFAULT_CAPABILITIES, localAddresses } from './config.js'

/**
 * Which of our addresses the peer is most likely able to dial.
 *
 * Machines routinely carry several: a VPN (`10.x`), a corporate LAN
 * (`172.17.x`), a container bridge. Announcing `addresses[0]` picks whichever
 * the OS lists first, which is exactly how a peer ends up with a URL it cannot
 * route to. When we know the peer's own address, prefer the interface on the
 * same network block — that is the one that just worked for this very request.
 */
export function preferSameSubnet(addresses, peerUrl) {
  const host = (() => {
    if (typeof peerUrl !== 'string') return undefined
    try {
      return new URL(peerUrl).hostname
    } catch {
      return undefined
    }
  })()
  if (host === undefined || !/^\d+\.\d+\.\d+\.\d+$/.test(host)) return addresses[0]
  // A /24 assumption is too narrow: two machines behind the same NAT router
  // routinely sit on different /24s (172.17.45.x and 172.17.46.x here) while a
  // VPN hands out something entirely different. Comparing the first two octets
  // catches "same private cloud, different subnet" and still rejects 10.x.
  const prefix = host.split('.').slice(0, 2).join('.')
  return addresses.find(value => value.startsWith(`${prefix}.`)) ?? addresses[0]
}

/**
 * The address a peer should use to reach this machine.
 *
 * `listen.host` is what we bound, which is frequently `0.0.0.0` — not something
 * a peer can dial. Pick the first real interface instead, and fail loudly rather
 * than announce a wildcard address that nobody can connect to.
 */
export function selfUrl(cfg, server, override, peerUrl) {
  if (typeof override === 'string' && override.trim() !== '') {
    const url = override.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(url)) {
      throw new BridgeError('bridge/bad-request', 'url must start with http:// or https://', { field: 'url' })
    }
    return url
  }
  const port = server?.status?.port ?? cfg.port
  const protocol = server?.status?.protocol ?? (cfg.tls == null ? 'http' : 'https')
  const host = cfg.listen?.host ?? '127.0.0.1'
  if (host === '0.0.0.0' || host === '::') {
    const addresses = localAddresses().filter(value => value !== '127.0.0.1')
    if (addresses.length === 0) {
      throw new BridgeError(
        'bridge/method-unavailable',
        'this machine has no non-loopback address to announce; pass `url` explicitly',
        {},
      )
    }
    return `${protocol}://${preferSameSubnet(addresses, peerUrl)}:${String(port)}`
  }
  return `${protocol}://${host}:${String(port)}`
}

/** Capabilities travel as one set in both directions, so they are read once. */
export function readCapabilities(input, fallback = DEFAULT_CAPABILITIES) {
  const requested = Array.isArray(input) ? input : fallback
  const capabilities = [...new Set(requested.filter(value => CAPABILITIES.includes(value)))]
  if (capabilities.length === 0) {
    throw new BridgeError(
      'bridge/bad-request',
      `capabilities must name at least one of: ${CAPABILITIES.join(', ')}`,
      { field: 'capabilities' },
    )
  }
  return capabilities
}

/** Validate what a mirror request claims, before it reaches the store. */
function readRequest(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : ''
  if (name === '') throw new BridgeError('bridge/bad-request', 'name is required', { field: 'name' })
  if (name.length > 64) {
    throw new BridgeError('bridge/bad-request', 'name is limited to 64 characters', { field: 'name' })
  }
  const url = typeof input?.url === 'string' ? input.url.trim().replace(/\/+$/, '') : ''
  if (!/^https?:\/\/[^\s]+$/i.test(url)) {
    throw new BridgeError('bridge/bad-request', 'url must be an http(s) address', { field: 'url' })
  }
  const token = typeof input?.token === 'string' ? input.token.trim() : ''
  if (token === '') throw new BridgeError('bridge/bad-request', 'token is required', { field: 'token' })
  return { name, url, token, capabilities: readCapabilities(input?.capabilities, []) }
}

/**
 * Start a mirror: mint our token for the peer, then ask it to pair back.
 *
 * The local record is written before the call so a peer that accepts immediately
 * still has something to answer; on failure the record stays `pending` with the
 * error attached, so the panel can show "asked, no answer" instead of pretending
 * nothing happened.
 */
export async function requestMirror({ store, remote, cfg, server, peerName, capabilities, url, signal }) {
  const record = await store.outboundPeer(peerName)
  if (record === undefined) {
    throw new BridgeError('bridge/not-found', 'that peer is not configured on this machine', { peer: peerName })
  }
  const granted = readCapabilities(capabilities)
  const announced = selfUrl(cfg, server, url, record.url)
  const { token } = await store.pair({ name: record.name, capabilities: granted })
  await store.addMirrorOut({ name: record.name, url: record.url, capabilities: granted })
  try {
    const reply = await remote.rpc(
      record,
      'pair.mirror',
      { name: cfg.name, url: announced, capabilities: granted, token },
      { signal, timeoutMs: 20_000 },
    )
    const state = reply?.state === 'accepted' ? 'accepted' : 'pending'
    if (state === 'accepted') await store.setMirrorState('out', record.name, 'accepted')
    return { peer: record.name, url: announced, capabilities: granted, state, autoAccepted: state === 'accepted' }
  } catch (error) {
    await store.setMirrorState('out', record.name, 'pending', error instanceof Error ? error.message : String(error))
    throw error
  }
}

/**
 * Accept a pending mirror request on this machine.
 *
 * Order matters: the outbound peer is stored first (so we can call back), then
 * our token is minted, then the callback is attempted. A callback failure is not
 * fatal — the request stays `accepted` with the error attached, and accepting it
 * again mints a fresh token and retries (the peer never received the failed one).
 */
export async function acceptMirror({ store, remote, cfg, name, signal }) {
  const entry = await store.mirrorEntry('in', name)
  if (entry === undefined) {
    throw new BridgeError('bridge/not-found', 'no mirror request from that machine', { name })
  }
  if (entry.state === 'rejected') {
    throw new BridgeError('bridge/bad-request', 'that request was rejected; ask the peer again', {})
  }
  if (entry.state === 'accepted' && entry.error === undefined) {
    throw new BridgeError('bridge/bad-request', 'that request is already accepted and delivered', {})
  }
  await store.addOutbound({ name: entry.name, url: entry.url, token: entry.token })
  const { token } = await store.pair({ name: entry.name, capabilities: entry.capabilities })
  await store.setMirrorState('in', name, 'accepted')
  // Acceptance makes this machine able to *drive* the requester as well, so the
  // pairing is symmetric in the record too — otherwise `mirrors` shows an empty
  // outgoing list right after a successful handshake and the operator cannot tell
  // the difference between "paired both ways" and "half paired".
  await store.addMirrorOut({ name: entry.name, url: entry.url, capabilities: entry.capabilities })
  await store.setMirrorState('out', name, 'accepted')
  try {
    await remote.rpc(
      { name: entry.name, url: entry.url, token: entry.token },
      'pair.mirrorResult',
      { name: cfg.name, url: selfUrl(cfg, undefined, undefined), capabilities: entry.capabilities, token },
      { signal, timeoutMs: 20_000 },
    )
    return { name: entry.name, state: 'accepted', delivered: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await store.setMirrorState('in', name, 'accepted', message)
    return { name: entry.name, state: 'accepted', delivered: false, error: message }
  }
}

/** Refuse a pending mirror request; the peer keeps its own token, unused. */
export async function rejectMirror({ store, name }) {
  const entry = await store.mirrorEntry('in', name)
  if (entry === undefined) {
    throw new BridgeError('bridge/not-found', 'no mirror request from that machine', { name })
  }
  if (entry.state !== 'pending') {
    throw new BridgeError('bridge/bad-request', `that request is already ${String(entry.state)}`, { state: entry.state })
  }
  await store.setMirrorState('in', name, 'rejected')
  return { name, state: 'rejected' }
}
