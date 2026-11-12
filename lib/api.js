/**
 * The Session-facing half of the bridge: one method per existing Host
 * `sessionController` call, plus the two things the controller genuinely needs
 * and the Host does not expose as a single call (a readable history tail and a
 * "wait until this turn stops" primitive).
 *
 * Nothing here invents Session semantics. If a mapped Host method is missing in
 * this DSH build, the call reports `bridge/method-unavailable` instead of
 * degrading silently.
 */
import { VERSION } from './config.js'
import { adoptGoal, adoptTask, clearGoal, createTask, getGoal, listTasks, setGoal, updateTask } from './board.js'
import { createFiles } from './files.js'
import { handOver } from './transfer.js'
import { composePrompt, parseIntent } from './intent.js'
import { BridgeError, clampInt, requireString, sleep } from './util.js'

/**
 * Create the listener-side method table.
 * @param options - `{ ctx, cfg, store, logger }`.
 * @returns `{ methods, dispatch, pendingApprovals, describe }`.
 */
export function createApi({ ctx, cfg, store, logger, remote }) {
  /**
   * approvalId -> `{ sessionId, toolName, callId?, reason?, askedAt }` for every
   * approval that has been asked on this machine and not yet decided. Keyed by
   * id because a remote answer arrives with an id, not a Session.
   */
  const pendingApprovals = new Map()

  /** The peer-facing half of file transfer: roots, reads, and staged uploads. */
  const files = createFiles({ cfg, store, logger })

  /** approvalId -> `{ resolve, timer }` while a remote answer is being awaited. */
  const decisionWaiters = new Map()

  /** approvalId -> outcome answered before the waterfall asked us. */
  const earlyDecisions = new Map()

  ctx.on('session/event', (session, event) => {
    const type = event?.type
    if (type !== 'approval/asked' && type !== 'approval/decided') return
    const id = event?.data?.id
    if (typeof id !== 'string' || typeof session?.id !== 'string') return
    if (type === 'approval/asked') {
      const record = { sessionId: session.id, askedAt: Date.now() }
      for (const field of ['toolName', 'callId', 'reason']) {
        const value = event.data?.[field]
        if (typeof value === 'string') record[field] = value
      }
      pendingApprovals.set(id, record)
      return
    }
    pendingApprovals.delete(id)
    // A decision that arrived after every waiter gave up would otherwise leak.
    const waiter = decisionWaiters.get(id)
    if (waiter !== undefined) {
      clearTimeout(waiter.timer)
      decisionWaiters.delete(id)
      waiter.resolve(undefined)
    }
    earlyDecisions.delete(id)
  }, { global: true })

  /**
   * Decide whether this Session's approvals should be offered to a peer at all.
   * Both gates must pass: the operator shared the Session, and some inbound
   * token was granted `approve`. Anything else keeps the prompt local.
   */
  async function relayable(sessionId) {
    if (typeof sessionId !== 'string') return false
    if (!await store.isShared(sessionId)) return false
    const peers = await store.inbound()
    return peers.some(peer => Array.isArray(peer.capabilities) && peer.capabilities.includes('approve'))
  }

  /**
   * Wait for a peer's answer to one approval.
   *
   * Returns `undefined` when the peer stayed silent for the relay budget (or the
   * request was cancelled), which the caller turns into `next()` so the local
   * human UI still gets its prompt. That bounded-wait-then-fall-through shape is
   * why no dangling dialog is possible: the browser answerer is only invoked
   * once this listener calls `next()`.
   */
  function waitForPeerDecision(id, signal) {
    const early = earlyDecisions.get(id)
    if (early !== undefined) {
      earlyDecisions.delete(id)
      return Promise.resolve(early)
    }
    return new Promise((resolve) => {
      const budget = clampInt(cfg.approvalRelayMs, 5_000, 30 * 60 * 1000, 120_000)
      const settle = (outcome) => {
        const waiter = decisionWaiters.get(id)
        if (waiter === undefined) return
        decisionWaiters.delete(id)
        clearTimeout(waiter.timer)
        signal?.removeEventListener?.('abort', onAbort)
        resolve(outcome)
      }
      const onAbort = () => { settle(undefined) }
      const timer = setTimeout(() => { settle(undefined) }, budget)
      decisionWaiters.set(id, { resolve: settle, timer })
      signal?.addEventListener?.('abort', onAbort, { once: true })
    })
  }

  /**
   * Intercept every approval asked on this machine before the local answerers.
   *
   * Registered `prepend` + `global` so it runs ahead of both the Web UI relay
   * and any other answerer, and can see every Agent. It returns `next()` in all
   * cases where relaying is not allowed, so a machine without an approving peer
   * behaves exactly as before. The Host's own `never` policy is applied before
   * this waterfall runs, so that policy stays unbypassable.
   */
  ctx.on('approval/request', async (request, next) => {
    try {
      const sessionId = request?.agent?.session?.id
      if (!await relayable(sessionId)) return next()
      const candidate = newestPending(sessionId, request)
      if (candidate === undefined) return next()
      const outcome = await waitForPeerDecision(candidate.id, request.signal)
      if (outcome === undefined) return next()
      logger?.info?.(`lan-bridge: approval ${candidate.id} answered remotely (${outcome})`)
      return outcome
    } catch (error) {
      logger?.warn?.(`lan-bridge: approval relay failed (${String(error?.message ?? error)})`)
      return next()
    }
  }, { prepend: true, global: true })

  /** Newest undecided approval of one Session, preferring a matching tool call. */
  function newestPending(sessionId, request) {
    let best
    for (const [id, record] of pendingApprovals) {
      if (record.sessionId !== sessionId) continue
      if (typeof request?.toolName === 'string' && record.toolName !== undefined && record.toolName !== request.toolName) continue
      if (request?.callId !== undefined && record.callId !== undefined && record.callId !== request.callId) continue
      if (best === undefined || record.askedAt > best.record.askedAt) best = { id, record }
    }
    return best
  }

  function controller() {
    const service = ctx.get('sessionController')
    if (service === undefined) {
      throw new BridgeError('bridge/method-unavailable', 'this Host mounts no sessionController service', {})
    }
    return service
  }

  function workspace() {
    const service = ctx.get('workspaceController')
    if (service === undefined) {
      throw new BridgeError('bridge/method-unavailable', 'this Host mounts no workspaceController service', {})
    }
    return service
  }

  /**
   * Gate one archive mutation on the share decision only: an archived Session
   * may drop out of `session.list`, so the usual existence check would make
   * `session.unarchive` impossible to call.
   */
  async function requireSharedId(sessionId) {
    if (!await store.isShared(sessionId)) {
      throw new BridgeError('session/not-shared', `Session ${sessionId} is not shared by its operator`, { sessionId })
    }
  }

  /** How many approvals of this Session are waiting right now. */
  function inflight(sessionId) {
    let count = 0
    for (const record of pendingApprovals.values()) {
      if (record.sessionId === sessionId) count += 1
    }
    return count
  }

  /** Read the current summary of one Session, or fail with `session/not-found`. */
  async function summaryOf(sessionId, signal) {
    const value = await controller().list({}, signal)
    const found = (value?.items ?? []).find(item => item.sessionId === sessionId)
    if (found === undefined) {
      throw new BridgeError('session/not-found', `no Session ${sessionId} on this machine`, { sessionId })
    }
    return found
  }

  /** Refuse any Session the local operator has not shared. */
  async function requireShared(sessionId, signal) {
    if (!await store.isShared(sessionId)) {
      throw new BridgeError('session/not-shared', `Session ${sessionId} is not shared by its operator`, { sessionId })
    }
    await summaryOf(sessionId, signal)
  }

  /**
   * Read one Session's newest history page by opening a follow stream and
   * cancelling it after the opening snapshot.
   */
  async function readTail(sessionId, maxMessages, signal) {
    const local = new AbortController()
    const forward = () => { local.abort() }
    signal?.addEventListener('abort', forward, { once: true })
    const budget = clampInt(maxMessages, 1, cfg.maxMessages, cfg.maxMessages)
    const iterable = controller().follow({ address: { kind: 'session', sessionId }, maxMessages: budget }, local.signal)
    const iterator = iterable[Symbol.asyncIterator]()
    try {
      const first = await iterator.next()
      if (first.done === true) throw new BridgeError('bridge/internal', 'follow ended before its opening snapshot', {})
      const frame = first.value
      return {
        cursor: typeof frame?.cursor === 'number' ? frame.cursor : 0,
        records: Array.isArray(frame?.records) ? frame.records : [],
        hasMore: frame?.hasMore === true,
      }
    } finally {
      local.abort()
      try { await iterator.return?.() } catch { /* the stream is already closed */ }
      signal?.removeEventListener('abort', forward)
    }
  }

  /** Sequence number of one history record, or -1 when it carries none. */
  function seqOf(record) {
    const event = record?.event ?? record
    return typeof event?.seq === 'number' ? event.seq : -1
  }

  /** How long a quiet Session must stay quiet before we call it idle. */
  const POLL_MS = 200
  const SETTLE_MS = 1200

  /**
   * Follow one turn to its stopping point, then describe it.
   *
   * Bounded polling rather than event subscription on purpose: a subscriber can
   * miss the `running` flip that happens between the first summary read and the
   * subscription, which made a freshly queued prompt look idle. Each tick reads
   * the authoritative summary, the approval count, and the history tail, so a
   * Session that never started (`running` still false) is not reported idle
   * until either something ran, something new appeared after `afterSeq`, or
   * `SETTLE_MS` has passed.
   *
   * @param afterSeq - only report records whose seq is greater than this.
   * @returns `{ reason, running, cursor, records, truncated }`.
   */
  async function waitForTurn(sessionId, afterSeq, timeoutMs, signal) {
    const budget = clampInt(timeoutMs, 1000, cfg.maxWaitMs, 120_000)
    const baseline = typeof afterSeq === 'number' && Number.isFinite(afterSeq) ? Math.floor(afterSeq) : undefined
    const start = Date.now()
    let sawRunning = false
    let stable = 0
    for (;;) {
      if (signal?.aborted === true) {
        throw new BridgeError('bridge/timeout', 'the caller cancelled the wait', { sessionId })
      }
      const item = await summaryOf(sessionId, signal)
      const tail = await readTail(sessionId, cfg.maxMessages, signal)
      const fresh = baseline === undefined
        ? tail.records
        : tail.records.filter(record => seqOf(record) > baseline)
      const running = item.running === true
      const outcome = (reason) => ({
        reason,
        running,
        cursor: tail.cursor,
        records: fresh,
        truncated: tail.hasMore === true,
      })
      if (inflight(sessionId) > 0) return outcome('input-required')
      if (running) {
        sawRunning = true
        stable = 0
      } else {
        stable += 1
        // Without a cursor we cannot tell "new" records from the Session's older
        // history, so a quiet Session must stay quiet for the whole settle window
        // before it counts as idle. With a cursor, any record past it is proof the
        // turn did something.
        const settled = sawRunning
          || (baseline === undefined
            ? Date.now() - start >= SETTLE_MS
            : fresh.length > 0)
        if (settled && stable >= 2) return outcome('idle')
      }
      if (Date.now() - start >= budget) return outcome('timeout')
      await sleep(POLL_MS, signal)
    }
  }

  const methods = {
    'session.list': {
      capabilities: ['read'],
      run: async (_params, _peer, signal) => {
        const value = await controller().list({}, signal)
        const items = []
        for (const item of value?.items ?? []) {
          if (!await store.isShared(item.sessionId)) continue
          items.push(await describe(item))
        }
        items.sort((left, right) => right.updatedAt - left.updatedAt)
        return { sessions: items }
      },
    },

    'session.state': {
      capabilities: ['read'],
      run: async (params, _peer, signal) => {
        const sessionId = requireString(params.sessionId, 'sessionId')
        await requireShared(sessionId, signal)
        const item = await summaryOf(sessionId, signal)
        const pending = inflight(sessionId)
        return {
          sessionId,
          running: item.running === true,
          updatedAt: item.updatedAt,
          agentAvailable: item.agentAvailable === true,
          pendingApprovals: pending,
          pendingInput: pending > 0,
        }
      },
    },

    'session.transcript': {
      capabilities: ['read'],
      run: async (params, _peer, signal) => {
        const sessionId = requireString(params.sessionId, 'sessionId')
        await requireShared(sessionId, signal)
        const tail = await readTail(sessionId, params.maxMessages, signal)
        return tail
      },
    },

    'session.prompt': {
      capabilities: ['prompt'],
      run: async (params, peer, signal) => {
        const sessionId = requireString(params.sessionId, 'sessionId')
        await requireShared(sessionId, signal)
        const text = requireString(params.text, 'text', cfg.maxPromptBytes)
        const intent = parseIntent(params.intent)
        const composed = composePrompt(intent, text)
        if (Buffer.byteLength(composed, 'utf8') > cfg.maxPromptBytes) {
          throw new BridgeError('bridge/bad-request', `text exceeds ${String(cfg.maxPromptBytes)} bytes`, {})
        }
        const requestId = typeof params.requestId === 'string' && params.requestId.trim() !== ''
          ? params.requestId.trim()
          : `lan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
        await controller().prompt({
          requestId,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: composed }],
        }, signal)
        if (intent !== undefined) {
          await store.recordIntent({ sessionId, peer: peer.name, intent }).catch((error) => {
            logger?.warn?.(`lan-bridge: could not record intent (${String(error?.message ?? error)})`)
          })
        }
        // The cursor is the seq the caller should pass as `afterSeq` to
        // `session.wait`; handing it out here saves a round trip and removes the
        // "which records are new?" guesswork that used to leak old turns back.
        const tail = await readTail(sessionId, cfg.maxMessages, signal)
        const result = { accepted: true, sessionId, cursor: tail.cursor }
        if (intent !== undefined) result.intent = true
        return result
      },
    },

    'tasks.list': {
      capabilities: ['collab'],
      run: async () => {
        const board = await store.board()
        return {
          name: cfg.name,
          tasks: listTasks(board),
          // A tombstone is how a reader tells "deleted" from "never existed".
          tombstones: Array.isArray(board.tombstones) ? board.tombstones.slice(-10) : [],
        }
      },
    },

    'tasks.create': {
      capabilities: ['collab'],
      run: async (params) => ({
        name: cfg.name,
        task: await store.mutateBoard(board => createTask(board, params, cfg.name)),
      }),
    },

    'tasks.update': {
      capabilities: ['collab'],
      run: async (params) => ({
        name: cfg.name,
        task: await store.mutateBoard(board => updateTask(board, params, cfg.name)),
      }),
    },

    // Ownership transfer is a move between two boards: the sender keeps the
    // record until the receiver has accepted it, so a failed hand-over changes
    // nothing. Only the machine that owns a task may transfer it.
    'tasks.transfer': {
      capabilities: ['collab'],
      run: async params => handOver({
        store,
        remote,
        cfg,
        taskId: requireString(params.taskId, 'taskId', 80),
        to: params.to,
        expectedRevision: params.expectedRevision === undefined ? undefined : Number(params.expectedRevision),
      }),
    },

    'tasks.adopt': {
      capabilities: ['collab'],
      run: async (params) => ({
        name: cfg.name,
        adopted: true,
        task: await store.mutateBoard(board => adoptTask(board, params, cfg.name)),
      }),
    },

    'goal.get': {
      capabilities: ['collab'],
      run: async () => ({ name: cfg.name, goal: getGoal(await store.board()) }),
    },

    'goal.clear': {
      capabilities: ['collab'],
      run: async (params) => ({
        name: cfg.name,
        goal: await store.mutateBoard(board => clearGoal(board, params, cfg.name)),
      }),
    },

    'goal.adopt': {
      capabilities: ['collab'],
      run: async (params) => ({
        name: cfg.name,
        ...(await store.mutateBoard(board => adoptGoal(board, params, cfg.name))),
      }),
    },

    'goal.set': {
      capabilities: ['collab'],
      run: async (params) => ({
        name: cfg.name,
        goal: await store.mutateBoard(board => setGoal(board, params, cfg.name)),
      }),
    },

    'session.intents': {
      capabilities: ['read'],
      run: async (params) => {
        const sessionId = requireString(params.sessionId, 'sessionId')
        await requireSharedId(sessionId)
        return { sessionId, intents: await store.intents(sessionId) }
      },
    },

    'session.wait': {
      capabilities: ['prompt', 'read'],
      run: async (params, _peer, signal) => {
        const sessionId = requireString(params.sessionId, 'sessionId')
        await requireShared(sessionId, signal)
        return waitForTurn(sessionId, params.afterSeq, params.timeoutMs, signal)
      },
    },

    // Remote approval answering. Both methods are gated on the `approve`
    // capability, which pairing never grants by default, and `approval.list`
    // only ever shows approvals of Sessions the operator shared.
    'files.roots': {
      capabilities: ['read'],
      run: async () => files.roots(),
    },
    'files.stat': {
      capabilities: ['files'],
      run: async (input) => files.stat(input),
    },
    'files.list': {
      capabilities: ['files'],
      run: async (input) => files.list(input),
    },
    'files.read': {
      capabilities: ['files'],
      run: async (input, peer) => files.read(input, peer),
    },
    'files.begin': {
      capabilities: ['files'],
      run: async (input, peer) => files.begin(input, peer),
    },
    'files.chunk': {
      capabilities: ['files'],
      run: async (input, peer) => files.chunk(input, peer),
    },
    'files.commit': {
      capabilities: ['files'],
      run: async (input, peer) => files.commit(input, peer),
    },
    'files.abort': {
      capabilities: ['files'],
      run: async (input, peer) => files.abort(input, peer),
    },
    'approval.list': {
      capabilities: ['read'],
      run: async () => {
        const approvals = []
        for (const [id, record] of pendingApprovals) {
          if (!await store.isShared(record.sessionId)) continue
          approvals.push({
            id,
            sessionId: record.sessionId,
            ...(record.toolName === undefined ? {} : { toolName: record.toolName }),
            ...(record.callId === undefined ? {} : { callId: record.callId }),
            ...(record.reason === undefined ? {} : { reason: record.reason }),
            askedAt: record.askedAt,
          })
        }
        approvals.sort((left, right) => left.askedAt - right.askedAt)
        return { approvals }
      },
    },

    'approval.answer': {
      capabilities: ['approve'],
      run: async (params, peer) => {
        const id = requireString(params.id, 'id', 128)
        const decision = requireString(params.decision, 'decision', 16)
        const outcome = { allow: 'allowed-once', reject: 'rejected', cancel: 'cancelled' }[decision]
        if (outcome === undefined) {
          throw new BridgeError('bridge/bad-request', 'decision must be allow, reject or cancel', { field: 'decision' })
        }
        const record = pendingApprovals.get(id)
        if (record === undefined) {
          throw new BridgeError('bridge/not-found', `no pending approval ${id}`, { id })
        }
        // Only shared Sessions are answerable: sharing is the operator's gate,
        // and a token must not reach a Session it cannot already read.
        if (!await store.isShared(record.sessionId)) {
          throw new BridgeError('session/not-shared', `Session ${record.sessionId} is not shared by its operator`, { sessionId: record.sessionId })
        }
        // Every remote decision is audited before it is handed to the waterfall.
        await store.audit({
          peer: peer.name,
          method: 'approval.answer',
          sessionId: record.sessionId,
          ...(record.toolName === undefined ? {} : { toolName: record.toolName }),
          id,
          decision,
          outcome,
        })
        const waiter = decisionWaiters.get(id)
        if (waiter !== undefined) waiter.resolve(outcome)
        else {
          // The answer arrived before the waterfall reached us; hold it briefly
          // so the pending request can still consume it.
          earlyDecisions.set(id, outcome)
          const timer = setTimeout(() => { earlyDecisions.delete(id) }, 60_000)
          timer.unref?.()
        }
        return { ok: true, id, outcome, sessionId: record.sessionId }
      },
    },

    'session.cancel': {
      capabilities: ['control'],
      run: async (params, _peer, signal) => {
        const sessionId = requireString(params.sessionId, 'sessionId')
        await requireShared(sessionId, signal)
        const value = controller().cancel({ sessionId })
        return { accepted: value?.accepted === true }
      },
    },

    'session.rename': {
      capabilities: ['control'],
      run: async (params, _peer, signal) => {
        const sessionId = requireString(params.sessionId, 'sessionId')
        await requireShared(sessionId, signal)
        const title = requireString(params.title, 'title', 200)
        const value = await controller().rename({ sessionId, title })
        return { renamed: true, title: value?.title ?? title, seq: value?.seq ?? 0 }
      },
    },

    'session.selectModel': {
      capabilities: ['control'],
      run: async (params, _peer, signal) => {
        const sessionId = requireString(params.sessionId, 'sessionId')
        await requireShared(sessionId, signal)
        const provider = requireString(params.provider, 'provider', 128)
        const model = requireString(params.model, 'model', 200)
        const request = { sessionId, provider, model }
        if (typeof params.reasoningEffort === 'string' && params.reasoningEffort.trim() !== '') {
          request.reasoningEffort = params.reasoningEffort.trim()
        }
        const value = await controller().selectModel(request)
        return { selected: value?.selected ?? request }
      },
    },

    'session.archive': {
      capabilities: ['archive'],
      run: async (params, _peer) => {
        const sessionId = requireString(params.sessionId, 'sessionId')
        await requireSharedId(sessionId)
        const request = { sessionId }
        if (params.stopActivity === true) request.stopActivity = true
        const value = await workspace().archiveSession(request)
        return {
          archived: true,
          sessionId,
          stopped: params.stopActivity === true,
          archivedSessionIds: [...(value?.archivedSessionIds ?? [])],
        }
      },
    },

    'session.unarchive': {
      capabilities: ['archive'],
      run: async (params, _peer) => {
        const sessionId = requireString(params.sessionId, 'sessionId')
        await requireSharedId(sessionId)
        const value = await workspace().unarchiveSession({ sessionId })
        return {
          archived: false,
          sessionId,
          archivedSessionIds: [...(value?.archivedSessionIds ?? [])],
        }
      },
    },

    'session.create': {
      capabilities: ['create'],
      run: async (params, _peer, signal) => {
        if (!cfg.allowPeersToCreateSessions) {
          throw new BridgeError('bridge/method-unavailable', 'this machine does not let peers create Sessions', {})
        }
        const request = {}
        if (typeof params.cwd === 'string' && params.cwd.trim() !== '') request.cwd = params.cwd.trim()
        const value = await controller().create(request)
        const sessionId = value?.sessionId
        if (typeof sessionId !== 'string') {
          throw new BridgeError('bridge/internal', 'the Host created no Session', {})
        }
        await store.setShared(sessionId, true)
        return { sessionId, shared: true }
      },
    },
  }

  /**
   * Describe one Session for the wire. Titles come from the Host's `title`
   * projection; a Session without one is described by its id tail.
   */
  async function describe(item) {
    const values = item.projections?.values ?? {}
    const title = typeof values.title === 'string' && values.title.trim() !== '' ? values.title.trim() : undefined
    const description = {
      sessionId: item.sessionId,
      title: title ?? `Session ${String(item.sessionId).slice(-8)}`,
      updatedAt: item.updatedAt,
      running: item.running === true,
      agentAvailable: item.agentAvailable === true,
      shared: true,
    }
    if (typeof item.cwd === 'string') description.cwd = item.cwd
    if (typeof item.parentSessionId === 'string') description.parentSessionId = item.parentSessionId
    if (typeof item.origin === 'string') description.origin = item.origin
    return description
  }

  /** The capability list this machine actually advertises. */
  function capabilities() {
    const available = {
      'session.list': true,
      'session.state': true,
      'session.transcript': true,
      'session.prompt': true,
      'session.wait': true,
      'session.cancel': true,
      'session.rename': true,
      'session.selectModel': true,
      'session.archive': true,
      'session.unarchive': true,
      'session.create': cfg.allowPeersToCreateSessions,
      'session.intents': true,
      'tasks.list': true,
      'tasks.create': true,
      'tasks.update': true,
      'tasks.transfer': true,
      'tasks.adopt': true,
      'goal.get': true,
      'goal.set': true,
      'goal.clear': true,
      'goal.adopt': true,
      'approval.answer': true,
      'approval.list': true,
      'files.roots': true,
      'files.stat': true,
      'files.list': true,
      'files.read': true,
      'files.begin': true,
      'files.chunk': true,
      'files.commit': true,
      'files.abort': true,
    }
    return available
  }

  /**
   * Run one wire method for one authenticated peer.
   * @returns the JSON result.
   */
  async function dispatch(name, params, peer, signal) {
    if (name === 'bridge.hello') {
      return {
        protocol: 1,
        app: 'dsh-lan-bridge',
        version: VERSION,
        name: cfg.name,
        capabilities: capabilities(),
        limits: {
          maxPromptBytes: cfg.maxPromptBytes,
          maxWaitMs: cfg.maxWaitMs,
          maxMessages: cfg.maxMessages,
          allowPeersToCreateSessions: cfg.allowPeersToCreateSessions === true,
          maxFileBytes: cfg.files?.maxFileBytes ?? 0,
          chunkBytes: cfg.files?.chunkBytes ?? 0,
          fileTransfer: cfg.files?.enabled === true,
        },
      }
    }
    const method = methods[name]
    if (method === undefined) {
      throw new BridgeError('bridge/method-unavailable', `this machine does not serve ${name}`, { method: name })
    }
    const missing = method.capabilities.filter(capability => !peer.capabilities.includes(capability))
    if (missing.length > 0) {
      throw new BridgeError('bridge/forbidden', `peer ${peer.name} lacks ${missing.join(', ')}`, { missing })
    }
    const input = params !== null && typeof params === 'object' ? params : {}
    return method.run(input, peer, signal)
  }

  logger?.info?.(`lan-bridge: api ready (${String(cfg.name)})`)
  return { methods, dispatch, pendingApprovals, capabilities, files }
}
