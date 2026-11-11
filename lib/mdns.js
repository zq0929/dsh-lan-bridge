/**
 * Just enough mDNS to find other bridges on the LAN.
 *
 * The bridge deliberately has no dependencies, so this is a small, bounded
 * implementation of the parts that matter: PTR questions for one service type,
 * and PTR/SRV/TXT/A answers carrying the instance name, port and addresses.
 * It is not a full responder — it answers queries for its own service type,
 * announces itself now and then, and browses on request.
 *
 * @module dsh-lan-bridge/lib/mdns
 */

import dgram from 'node:dgram'
import os from 'node:os'

/** The DNS-SD service this bridge advertises. */
export const SERVICE = '_dsh-lanbridge._tcp.local'

/** Multicast group and port every mDNS peer listens on. */
export const GROUP = '224.0.0.251'
export const PORT = 5353

const TYPE_A = 1
const TYPE_PTR = 12
const TYPE_TXT = 16
const TYPE_SRV = 33
const CLASS_IN = 1
const CACHE_FLUSH = 0x8000
const TTL = 120

/**
 * Encode a DNS name as length-prefixed labels.
 * @param name - dotted name, trailing dot optional.
 * @returns label bytes including the root terminator.
 */
export function encodeName(name) {
  const out = []
  for (const label of name.replace(/\.$/, '').split('.').filter((part) => part !== '')) {
    const bytes = Buffer.from(label, 'utf8')
    if (bytes.length > 63) throw new Error(`dns label too long: ${label}`)
    out.push(Buffer.from([bytes.length]), bytes)
  }
  out.push(Buffer.from([0]))
  return Buffer.concat(out)
}

/**
 * Decode a possibly-compressed DNS name.
 * @param buffer - whole packet.
 * @param offset - where the name starts.
 * @returns `{ name, offset }` where offset is past the name in the original position.
 */
export function decodeName(buffer, offset) {
  const labels = []
  let cursor = offset
  let jumped = false
  let end = offset
  let guard = 0
  while (cursor < buffer.length) {
    if (guard++ > 128) throw new Error('dns name pointer loop')
    const length = buffer[cursor]
    if (length === 0) {
      cursor += 1
      if (!jumped) end = cursor
      break
    }
    if ((length & 0xc0) === 0xc0) {
      const pointer = ((length & 0x3f) << 8) | buffer[cursor + 1]
      if (!jumped) end = cursor + 2
      jumped = true
      cursor = pointer
      continue
    }
    labels.push(buffer.subarray(cursor + 1, cursor + 1 + length).toString('utf8'))
    cursor += 1 + length
  }
  return { name: labels.join('.'), offset: end }
}

/**
 * Build a PTR question for the bridge service.
 * @param id - transaction id (0 is fine for mDNS).
 * @returns query packet.
 */
export function buildQuery(id = 0) {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(id, 0)
  header.writeUInt16BE(0, 2)
  header.writeUInt16BE(1, 4)
  const question = Buffer.concat([
    encodeName(SERVICE),
    Buffer.from([0, TYPE_PTR, 0, CLASS_IN]),
  ])
  return Buffer.concat([header, question])
}

function rr(name, type, rdata, flush = true) {
  const head = Buffer.alloc(10)
  head.writeUInt16BE(type, 0)
  head.writeUInt16BE(CLASS_IN | (flush ? CACHE_FLUSH : 0), 2)
  head.writeUInt32BE(TTL, 4)
  head.writeUInt16BE(rdata.length, 8)
  return Buffer.concat([encodeName(name), head, rdata])
}

function txtRecord(entries) {
  const parts = []
  for (const [key, value] of Object.entries(entries)) {
    const text = Buffer.from(`${key}=${value}`, 'utf8')
    parts.push(Buffer.from([Math.min(text.length, 255)]), text.subarray(0, 255))
  }
  return Buffer.concat(parts)
}

/**
 * Build an announcement for this bridge.
 * @param options - `{ instance, host, port, address, txt }`.
 * @returns response packet.
 */
export function buildResponse({ instance, host, port, address, txt = {} }) {
  const instanceName = `${instance}.${SERVICE}`
  const target = `${host}.local`
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x8400, 2)
  header.writeUInt16BE(4, 6)
  const srv = Buffer.alloc(6)
  srv.writeUInt16BE(0, 0)
  srv.writeUInt16BE(0, 2)
  srv.writeUInt16BE(port, 4)
  const a = Buffer.from(address.split('.').map(Number))
  return Buffer.concat([
    header,
    rr(SERVICE, TYPE_PTR, encodeName(instanceName), false),
    rr(instanceName, TYPE_SRV, Buffer.concat([srv, encodeName(target)])),
    rr(instanceName, TYPE_TXT, txtRecord(txt)),
    rr(target, TYPE_A, a),
  ])
}

/**
 * Parse one mDNS packet into the records the bridge cares about.
 * @param buffer - packet bytes.
 * @returns `{ questions, ptr, srv, txt, a }`.
 */
export function parsePacket(buffer) {
  if (buffer.length < 12) throw new Error('short dns packet')
  const questions = []
  const ptr = []
  const srv = []
  const txt = []
  const a = []
  const qd = buffer.readUInt16BE(4)
  const an = buffer.readUInt16BE(6)
  let offset = 12
  for (let i = 0; i < qd; i += 1) {
    const decoded = decodeName(buffer, offset)
    offset = decoded.offset
    questions.push({ name: decoded.name, type: buffer.readUInt16BE(offset) })
    offset += 4
  }
  for (let i = 0; i < an; i += 1) {
    const decoded = decodeName(buffer, offset)
    offset = decoded.offset
    if (offset + 10 > buffer.length) break
    const type = buffer.readUInt16BE(offset)
    const ttl = buffer.readUInt32BE(offset + 4)
    const length = buffer.readUInt16BE(offset + 8)
    offset += 10
    const rdata = buffer.subarray(offset, offset + length)
    offset += length
    if (type === TYPE_PTR) {
      ptr.push({ name: decoded.name, target: decodeName(buffer, offset - length).name, ttl })
    } else if (type === TYPE_SRV && length >= 7) {
      srv.push({
        name: decoded.name,
        port: rdata.readUInt16BE(4),
        target: decodeName(buffer, offset - length + 6).name,
        ttl,
      })
    } else if (type === TYPE_TXT) {
      const entries = {}
      let cursor = 0
      const start = offset - length
      while (cursor < length) {
        const size = buffer[start + cursor]
        const chunk = buffer.subarray(start + cursor + 1, start + cursor + 1 + size).toString('utf8')
        const eq = chunk.indexOf('=')
        if (eq > 0) entries[chunk.slice(0, eq)] = chunk.slice(eq + 1)
        cursor += 1 + size
      }
      txt.push({ name: decoded.name, entries, ttl })
    } else if (type === TYPE_A && length === 4) {
      a.push({ name: decoded.name, address: [...rdata].join('.'), ttl })
    }
  }
  return { questions, ptr, srv, txt, a }
}

function localIPv4() {
  const addresses = []
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address)
    }
  }
  return addresses
}

/**
 * Create a discovery agent: announces this bridge and browses for others.
 *
 * `portOf` resolves the port that is actually bound. It must be a function
 * rather than a number because a configured port of 0 means "let the OS pick",
 * and announcing 0 would send peers to the wrong place.
 *
 * @param options - `{ cfg, logger, portOf }`.
 * @returns `{ start, stop, browse, status, service }`.
 */
export function createDiscovery({ cfg, logger, portOf }) {
  const service = SERVICE
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  // The name is read at announce time: it can be changed from the panel, and a
  // responder that keeps announcing the name it was built with would be lying.
  const selfName = () => cfg.name
  const state = { listening: false, error: undefined, lastAnnounceAt: 0, found: new Map() }
  let interval

  const announce = () => {
    if (!state.listening) return
    const instance = selfName()
    const address = localIPv4()[0]
    if (address === undefined) return
    const packet = buildResponse({
      instance,
      host: instance.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase(),
      port: typeof portOf === 'function' ? portOf() : cfg.port,
      address,
      txt: { name: instance, version: cfg.version ?? '', protocol: '1' },
    })
    socket.send(packet, 0, packet.length, PORT, GROUP, (error) => {
      if (error !== undefined && error !== null) logger?.warn?.(`lan-bridge: mDNS announce failed: ${String(error)}`)
      else state.lastAnnounceAt = Date.now()
    })
  }

  socket.on('error', (error) => {
    state.error = String(error)
    logger?.warn?.(`lan-bridge: mDNS unavailable: ${String(error)}`)
  })

  socket.on('message', (message, remote) => {
    let parsed
    try {
      parsed = parsePacket(message)
    } catch {
      return
    }
    const askedForUs = parsed.questions.some((question) => question.type === TYPE_PTR && question.name === service)
    if (askedForUs) announce()
    // Learn from announcements we hear: name from TXT, host from SRV, address from A.
    const txtByName = new Map(parsed.txt.map((record) => [record.name, record.entries]))
    for (const record of parsed.srv) {
      const entries = txtByName.get(record.name) ?? {}
      const name = entries.name ?? record.name.split('.')[0]
      if (name === selfName()) continue
      const addressRecord = parsed.a.find((candidate) => candidate.name === record.target)
      state.found.set(name, {
        name,
        host: record.target,
        port: record.port,
        address: addressRecord?.address ?? remote.address,
        version: entries.version ?? '',
        protocol: entries.protocol ?? '',
        discoveredAt: Date.now(),
      })
    }
  })

  return {
    service,
    status: () => ({ ...state, found: [...state.found.values()] }),
    /**
     * Browse for a bounded window.
     * @param options - `{ timeoutMs }`.
     * @returns the peers heard during that window.
     */
    async browse({ timeoutMs = 1500 } = {}) {
      const packet = buildQuery()
      await new Promise((resolve) => {
        socket.send(packet, 0, packet.length, PORT, GROUP, () => resolve())
      })
      await new Promise((resolve) => setTimeout(resolve, timeoutMs))
      return [...state.found.values()].sort((left, right) => left.name.localeCompare(right.name))
    },
    start() {
      return new Promise((resolve) => {
        const onListening = () => {
          state.listening = true
          try {
            socket.addMembership(GROUP)
            socket.setMulticastTTL(255)
            socket.setMulticastLoopback(true)
          } catch (error) {
            state.error = String(error)
            logger?.warn?.(`lan-bridge: mDNS membership failed: ${String(error)}`)
          }
          announce()
          interval = setInterval(announce, cfg.discovery?.intervalMs ?? 60_000)
          interval.unref?.()
          resolve(state)
        }
        socket.once('listening', onListening)
        try {
          socket.bind(PORT)
        } catch (error) {
          state.error = String(error)
          resolve(state)
        }
      })
    },
    stop() {
      if (interval !== undefined) clearInterval(interval)
      try {
        socket.close()
      } catch {
        // already closed
      }
      state.listening = false
    },
  }
}
