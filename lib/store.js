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
/** Intent envelopes kept per Session. */
const INTENT_KEEP = 20
/** Sessions whose intent history is retained. */
const INTENT_SESSIONS = 50

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

  const empty = () => ({
    version: 1,
    inbound: {},
    outbound: {},
    shares: {},
    // Whole-workspace share rules, keyed by workspaceId. An entry exists only
    // while the rule is ON. `autoShares` records which per-Session share
    // decisions were made *by* a rule, so switching it off never revokes a
    // Session the operator shared by hand.
    workspaceShares: {},
    autoShares: {},
    settings: {},
    intents: {},
    board: { tasks: {}, goal: { revision: 0, title: '', text: '', updatedBy: '', updatedAt: 0 } },
  })

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
      workspaceShares: isRecord(parsed?.workspaceShares) ? parsed.workspaceShares : base.workspaceShares,
      autoShares: isRecord(parsed?.autoShares) ? parsed.autoShares : base.autoShares,
      // Operator listening settings edited from the panel. They outlive the
      // process and win over the bundle row's `config:`, so a host change made
      // in the UI survives the next Host start without editing YAML.
      settings: isRecord(parsed?.settings) ? parsed.settings : base.settings,
      // Intent envelopes received from peers, newest last, bounded per Session.
      // They are advisory metadata about why a prompt was sent, kept so the
      // operator (and the panel) can read the plan behind the text.
      intents: isRecord(parsed?.intents) ? parsed.intents : base.intents,
      // The shared board: tasks this machine owns plus the one goal document.
      // Both are replicated by pull, never by a central write.
      board: isRecord(parsed?.board) ? parsed.board : base.board,
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

    /**
     * Change what one already-paired peer may do, without re-issuing its token.
     *
     * This exists so an operator can promote a live machine (for example, grant
     * `approve` so it can answer approvals here) without mailing a new secret.
     * An unknown name is reported as `false`; the capability list is replaced,
     * not merged, so a caller always states the full intent.
     */
    grant(name, capabilities) {
      return mutate((state) => {
        const record = state.inbound[name]
        if (record === undefined) return false
        record.capabilities = [...capabilities]
        return true
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

    /** Read the shared board without mutating it. */
    async board() {
      const state = await load()
      return structuredClone(state.board)
    },

    /** Serialize one board mutation; the change runs against the persisted board. */
    mutateBoard(change) {
      return mutate((state) => {
        if (!isRecord(state.board)) state.board = empty().board
        if (!isRecord(state.board.tasks)) state.board.tasks = {}
        return change(state.board)
      })
    },

    /** Intent envelopes recorded for one Session, oldest first. */
    async intents(sessionId) {
      const state = await load()
      const list = state.intents[sessionId]
      return Array.isArray(list) ? list.map(entry => ({ ...entry })) : []
    },

    /** Remember one received intent envelope; bounded per Session and by Session count. */
    recordIntent({ sessionId, peer, intent }) {
      return mutate((state) => {
        const list = Array.isArray(state.intents[sessionId]) ? state.intents[sessionId] : []
        list.push({ at: Date.now(), peer, ...intent })
        state.intents[sessionId] = list.slice(-INTENT_KEEP)
        const sessions = Object.keys(state.intents)
        if (sessions.length > INTENT_SESSIONS) {
          const oldest = sessions
            .map(id => ({ id, at: newestAt(state.intents[id]) }))
            .sort((left, right) => left.at - right.at)
            .slice(0, sessions.length - INTENT_SESSIONS)
          for (const entry of oldest) delete state.intents[entry.id]
        }
        return list.length
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
        // A per-Session decision by the operator always wins over a rule's
        // bookkeeping: this id is no longer auto-managed by a workspace rule.
        delete state.autoShares[sessionId]
        return shared
      })
    },

    /** Active whole-workspace share rules, newest decision first. */
    async workspaceShares() {
      const state = await load()
      return Object.entries(state.workspaceShares)
        .map(([workspaceId, record]) => ({
          workspaceId,
          path: typeof record?.path === 'string' ? record.path : '',
          at: typeof record?.at === 'number' ? record.at : 0,
        }))
        .sort((left, right) => right.at - left.at)
    },

    /** Session ids whose current share decision came from a workspace rule. */
    async autoShares() {
      const state = await load()
      const out = {}
      for (const [sessionId, workspaceId] of Object.entries(state.autoShares)) {
        if (typeof workspaceId === 'string') out[sessionId] = workspaceId
      }
      return out
    },

    /** Enable or disable one workspace rule (a rule is present only while ON). */
    setWorkspaceShared({ workspaceId, path, shared }) {
      return mutate((state) => {
        if (!isRecord(state.workspaceShares)) state.workspaceShares = {}
        if (shared) state.workspaceShares[workspaceId] = { path, at: Date.now() }
        else delete state.workspaceShares[workspaceId]
        return shared
      })
    },

    /** Record/refresh a rule-owned share decision for one Session. */
    markAutoShared(sessionId, workspaceId) {
      return mutate((state) => {
        if (!isRecord(state.autoShares)) state.autoShares = {}
        state.shares[sessionId] = Date.now()
        state.autoShares[sessionId] = workspaceId
        return true
      })
    },

    /** Remove a rule-owned share decision (never touches a human decision). */
    clearAutoShared(sessionId) {
      return mutate((state) => {
        if (!isRecord(state.autoShares)) return false
        const workspaceId = state.autoShares[sessionId]
        if (typeof workspaceId !== 'string') return false
        delete state.autoShares[sessionId]
        delete state.shares[sessionId]
        return true
      })
    },

    /**
     * Reconcile all rule-owned decisions in one write. `on` maps Session id to
     * the workspace rule that owns it; every other recorded auto share is
     * dropped. Human decisions in `shares` are never read or removed here.
     */
    reconcileAutoShares(on) {
      return mutate((state) => {
        if (!isRecord(state.autoShares)) state.autoShares = {}
        const wanted = isRecord(on) ? on : {}
        const current = state.autoShares
        const same = Object.keys(current).length === Object.keys(wanted).length
          && Object.entries(wanted).every(([id, workspaceId]) => current[id] === workspaceId)
        // `api-session/added` also fires on ordinary agent churn. Skip the
        // disk write entirely when the rule-owned set is already correct.
        if (same) return Object.keys(wanted).length
        for (const [sessionId, workspaceId] of Object.entries(current)) {
          if (wanted[sessionId] !== workspaceId) delete state.shares[sessionId]
        }
        state.autoShares = {}
        for (const [sessionId, workspaceId] of Object.entries(wanted)) {
          state.shares[sessionId] = Date.now()
          state.autoShares[sessionId] = workspaceId
        }
        return Object.keys(wanted).length
      })
    },

    /**
     * The newest audit records, oldest first.
     *
     * The trail is written for an operator reading it after the fact, so it has
     * to be reachable from the panel and from a peer; both go through here.
     * Reads the rotated file too when the live one is short, and skips lines a
     * crashed writer left half-finished rather than failing the whole read.
     */
    async auditTail(limit = 20) {
      const want = Math.max(1, Math.min(200, Number.isInteger(limit) ? limit : 20))
      const read = async (path) => {
        const text = await readFile(path, 'utf8').catch(() => '')
        const lines = text.split('\n').filter(line => line.trim() !== '')
        const out = []
        for (const line of lines.slice(-want)) {
          try {
            out.push(JSON.parse(line))
          } catch {
            // A torn final line is expected after a hard stop; skip it.
          }
        }
        return out
      }
      const live = await read(auditPath)
      if (live.length >= want) return live
      const rotated = await read(`${auditPath}.1`)
      return [...rotated.slice(-(want - live.length)), ...live]
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

/** Timestamp of the newest intent entry in one Session's list. */
function newestAt(list) {
  const last = Array.isArray(list) && list.length > 0 ? list[list.length - 1] : undefined
  return typeof last?.at === 'number' ? last.at : 0
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
