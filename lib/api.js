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
import { adoptTask, clearGoal, createTask, getGoal, listTasks, setGoal, updateTask } from './board.js'
import { handOver } from './transfer.js'
import { composePrompt, parseIntent } from './intent.js'
import { BridgeError, clampInt, requireString } from './util.js'

/**
 * Create the listener-side method table.
 * @param options - `{ ctx, cfg, store, logger }`.
 * @returns `{ methods, dispatch, pendingApprovals, describe }`.
 */
export function createApi({ ctx, cfg, store, logger, remote }) {
  /** sessionId -> Set of approval ids that have been asked and not yet decided. */
  const pendingApprovals = new Map()

  ctx.on('session/event', (session, event) => {
    const type = event?.type
    if (type !== 'approval/asked' && type !== 'approval/decided') return
    const id = event?.data?.id
    if (typeof id !== 'string' || typeof session?.id !== 'string') return
    let set = pendingApprovals.get(session.id)
    if (set === undefined) {
      set = new Set()
      pendingApprovals.set(session.id, set)
    }
    if (type === 'approval/asked') set.add(id)
    else set.delete(id)
  }, { global: true })

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

  async function inflight(sessionId) {
    return pendingApprovals.get(sessionId)?.size ?? 0
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

  /**
   * Resolve when the Session's current turn stops, an approval starts waiting,
   * or the budget expires.
   * @returns `{ reason, running }`.
   */
  async function waitForStop(sessionId, timeoutMs, signal) {
    const current = await summaryOf(sessionId, signal)
    // A turn already parked on an approval is not "idle" for a caller: it will
    // never finish on its own until the human at this machine acts.
    if (await inflight(sessionId) > 0) return { reason: 'input-required', running: current.running === true }
    if (current.running !== true) return { reason: 'idle', running: false }
    const budget = clampInt(timeoutMs, 1000, cfg.maxWaitMs, 120_000)
    return new Promise((resolve, reject) => {
      let settled = false
      let grace
      const timer = setTimeout(() => finish('timeout'), budget)
      const offStatus = ctx.on('api-session/status', (id, running) => {
        if (id !== sessionId || running === true) return
        // The turn stopped, but it may have stopped *on* an approval.
        void inflight(sessionId).then(count => finish(count > 0 ? 'input-required' : 'idle', false))
      })
      const offEvent = ctx.on('session/event', (session, event) => {
        if (session?.id !== sessionId) return
        if (event?.type === 'approval/asked') {
          clearTimeout(grace)
          grace = setTimeout(() => finish('input-required'), 400)
        } else if (event?.type === 'approval/decided') {
          clearTimeout(grace)
        }
      }, { global: true })
      const onAbort = () => {
        if (settled) return
        settled = true
        cleanup()
        reject(new BridgeError('bridge/timeout', 'the caller cancelled the wait', { sessionId }))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      function cleanup() {
        clearTimeout(timer)
        clearTimeout(grace)
        offStatus?.()
        offEvent?.()
        signal?.removeEventListener('abort', onAbort)
      }
      function finish(reason, running = reason !== 'timeout') {
        if (settled) return
        settled = true
        cleanup()
        resolve({ reason, running })
      }
    })
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
        const pending = await inflight(sessionId)
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
        const result = { accepted: true, sessionId }
        if (intent !== undefined) result.intent = true
        return result
      },
    },

    'tasks.list': {
      capabilities: ['collab'],
      run: async () => ({ name: cfg.name, tasks: listTasks(await store.board()) }),
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
        const outcome = await waitForStop(sessionId, params.timeoutMs, signal)
        const tail = await readTail(sessionId, params.maxMessages, signal)
        return {
          reason: outcome.reason,
          running: outcome.running,
          cursor: tail.cursor,
          records: tail.records,
          truncated: tail.hasMore === true,
        }
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
      'approval.answer': false,
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
  return { methods, dispatch, pendingApprovals, capabilities }
}
