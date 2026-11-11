/**
 * Persisted bridge state: inbound peer tokens (hashed), outbound peer
 * credentials, the per-session share switch, and the audit trail.
 *
 * Everything lives under `$DSH_HOME/lan-bridge` (0600) rather than inside the
 * plugin directory, so reinstalling the bundle never revokes a pair.
 */
import { chmod, mkdir, readFile, rename, stat, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { issueToken, randomHex, sha256Hex } from './util.js'

const AUDIT_ROTATE_BYTES = 2 * 1024 * 1024

/**
 * Open the bridge state.
 * @param options - `{ stateDir, audit, logger }`.
 * @returns the state facade; every method is async and serialized on one write queue.
 */
export function createStore({ stateDir, audit, logger }) {
  const statePath = join(stateDir, 'bridge.json')
  const auditPath = join(stateDir, 'audit.jsonl')
  let loaded
  let stamp
  let queue = Promise.resolve()

  const empty = () => ({ version: 1, inbound: {}, outbound: {}, shares: {}, settings: {} })

  /**
   * Identity of the state file right now, used to notice writes made by another
   * process sharing this `$DSH_HOME` (a second Host on the same profile, or an
   * operator running an admin script). Absent file counts as one identity.
   */
  async function readStamp() {
    try {
      const info = await stat(statePath)
      return `${String(info.mtimeMs)}:${String(info.size)}`
    } catch {
      return 'absent'
    }
  }

  async function load() {
    const current = await readStamp()
    if (loaded !== undefined && current === stamp) return loaded
    await mkdir(stateDir, { recursive: true, mode: 0o700 }).catch(() => {})
    let parsed
    try {
      parsed = JSON.parse(await readFile(statePath, 'utf8'))
    } catch {
      parsed = undefined
    }
    const base = empty()
    loaded = {
      version: 1,
      inbound: isRecord(parsed?.inbound) ? parsed.inbound : base.inbound,
      outbound: isRecord(parsed?.outbound) ? parsed.outbound : base.outbound,
      shares: isRecord(parsed?.shares) ? parsed.shares : base.shares,
      // Operator listening settings edited from the panel. They outlive the
      // process and win over the bundle row's `config:`, so a host change made
      // in the UI survives the next Host start without editing YAML.
      settings: isRecord(parsed?.settings) ? parsed.settings : base.settings,
    }
    stamp = current
    return loaded
  }

  /** Serialize one mutation and persist the whole state atomically. */
  function mutate(change) {
    const task = queue.then(async () => {
      const state = await load()
      const result = change(state)
      const temp = `${statePath}.${randomHex(4)}.tmp`
      await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, statePath)
      await chmod(statePath, 0o600).catch(() => {})
      stamp = await readStamp()
      return result
    })
    queue = task.then(() => undefined, () => undefined)
    return task
  }

  return {
    statePath,
    auditPath,

    /** Resolve a presented bearer token to the peer it belongs to. */
    async authenticate(token) {
      const state = await load()
      if (typeof token !== 'string' || !token.startsWith('lzb_')) return undefined
      const digest = sha256Hex(token)
      for (const [name, record] of Object.entries(state.inbound)) {
        if (record?.hash === digest) return { name, capabilities: [...(record.capabilities ?? [])] }
      }
      return undefined
    },

    /** Record that a peer authenticated just now (best effort, at most once per minute). */
    async touch(name) {
      const state = await load()
      const record = state.inbound[name]
      if (record === undefined) return
      const now = Date.now()
      if (typeof record.lastSeenAt === 'number' && now - record.lastSeenAt < 60_000) return
      await mutate((current) => {
        const target = current.inbound[name]
        if (target !== undefined) target.lastSeenAt = now
      }).catch(() => {})
    },

    /**
     * Pair one new peer and return its token exactly once.
     * @param options - `{ name, capabilities }`.
     * @returns `{ token, record }`; the token is never recoverable again.
     */
    pair({ name, capabilities }) {
      const token = issueToken()
      return mutate((state) => {
        const record = {
          hash: sha256Hex(token),
          hint: token.slice(-4),
          createdAt: Date.now(),
          lastSeenAt: 0,
          capabilities,
        }
        state.inbound[name] = record
        return { token, record: publicInbound(name, record) }
      })
    },

    /** Revoke one peer; its token stops working immediately. */
    revoke(name) {
      return mutate((state) => {
        const existed = state.inbound[name] !== undefined
        delete state.inbound[name]
        return existed
      })
    },

    /** Inbound peers as shown to the operator: never the hash, only a hint. */
    async inbound() {
      const state = await load()
      return Object.entries(state.inbound).map(([name, record]) => publicInbound(name, record))
    },

    /** Outbound peers, including the bearer token this machine presents. */
    async outbound() {
      const state = await load()
      return Object.entries(state.outbound).map(([name, record]) => ({
        name,
        url: record?.url ?? '',
        token: record?.token ?? '',
        addedAt: record?.addedAt ?? 0,
      }))
    },

    /** One outbound peer, or undefined when it is not configured. */
    async outboundPeer(name) {
      const state = await load()
      const record = state.outbound[name]
      if (record === undefined) return undefined
      return { name, url: record.url, token: record.token }
    },

    /** Add or replace one outbound peer. */
    addOutbound({ name, url, token }) {
      return mutate((state) => {
        state.outbound[name] = { url, token, addedAt: Date.now() }
        return { name, url }
      })
    },

    /** Remove one outbound peer. */
    removeOutbound(name) {
      return mutate((state) => {
        const existed = state.outbound[name] !== undefined
        delete state.outbound[name]
        return existed
      })
    },

    /** Persisted operator settings (the panel's listen form). */
    async settings() {
      const state = await load()
      return { ...state.settings }
    },

    /** Merge one validated settings patch into the persisted store. */
    updateSettings(patch) {
      return mutate((state) => {
        state.settings = { ...state.settings, ...patch }
        return { ...state.settings }
      })
    },

    /** Whether this Session is shared with peers. */
    async isShared(sessionId) {
      const state = await load()
      return state.shares[sessionId] !== undefined
    },

    /** Shared Session ids, newest decision first. */
    async sharedSessions() {
      const state = await load()
      return Object.entries(state.shares).map(([sessionId, at]) => ({ sessionId, at }))
    },

    /** Turn the share switch on or off for one Session. */
    setShared(sessionId, shared) {
      return mutate((state) => {
        if (shared) state.shares[sessionId] = Date.now()
        else delete state.shares[sessionId]
        return shared
      })
    },

    /** Append one audit record; rotation keeps the file bounded. */
    async audit(entry) {
      if (!audit) return
      const line = `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`
      try {
        await mkdir(stateDir, { recursive: true, mode: 0o700 })
        const info = await stat(auditPath).catch(() => undefined)
        if (info !== undefined && info.size > AUDIT_ROTATE_BYTES) {
          await rename(auditPath, `${auditPath}.1`).catch(() => {})
        }
        await appendFile(auditPath, line, { mode: 0o600 })
      } catch (error) {
        logger?.warn?.(`lan-bridge: audit append failed: ${String(error)}`)
      }
    },
  }
}

function publicInbound(name, record) {
  return {
    name,
    masked: `lzb_…${record?.hint ?? '????'}`,
    createdAt: record?.createdAt ?? 0,
    lastSeenAt: record?.lastSeenAt ?? 0,
    capabilities: [...(record?.capabilities ?? [])],
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
