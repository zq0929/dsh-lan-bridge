/**
 * Offline integration test for the bridge.
 *
 * It runs the real listener, the real method table, the real store and the real
 * tools against a *fake* Host context: a stand-in `sessionController` with a
 * couple of in-memory Sessions. That covers everything a plugin owns — fence,
 * auth, capability bits, share gating, RPC framing, SSE framing, prompt→wait,
 * cancel, audit, rate limiting and the model-facing tools — without needing a
 * second machine or a running DSH.
 *
 *   node scripts/it-local.mjs
 *
 * Exit code 0 = every assertion passed.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adoptGoal, emptyBoard } from '../lib/board.js'
import { createStore } from '../lib/store.js'
import { createApi } from '../lib/api.js'
import { createServer } from '../lib/server.js'
import { request as requestFn } from 'node:http'
import { createPeerCache, createRemote } from '../lib/remote.js'
import { installTools } from '../lib/tools.js'
import { installUi } from '../lib/ui.js'
import { createSettingsApplier, loadPersistedSettings } from '../lib/settings.js'
import { localAddresses, resolveConfig } from '../lib/config.js'
import { SERVICE, buildQuery, buildResponse, decodeName, encodeName, parsePacket } from '../lib/mdns.js'
import { applyRulesToSession, materializeWorkspaceShares, pathKey, sessionGroups, setWorkspaceShare } from '../lib/workspaces.js'

let failures = 0
let passes = 0
const steps = []

function check(label, condition, detail) {
  if (condition) {
    passes += 1
    steps.push(`  ok   ${label}`)
    return
  }
  failures += 1
  steps.push(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** A skipped assertion that is not a failure: the environment cannot run it. */
function note(message) {
  steps.push(`  note ${message}`)
}

// A crash must not swallow the run: everything asserted so far is flushed to
// stdout before the process dies, so a platform-specific failure is readable.
function flushAndExit(reason) {
  console.log(steps.join('\n'))
  console.log('')
  console.log(`aborted: ${reason} (${String(passes)} passed before the crash)`)
  process.exitCode = 1
}
process.on('uncaughtException', (error) => { flushAndExit(error?.stack ?? String(error)) })
process.on('unhandledRejection', (reason) => { flushAndExit(String(reason?.stack ?? reason)) })

function equal(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/** Paths of every `undefined` value in a structure — the Host rejects these. */
function undefinedPaths(value, path = '') {
  if (value === undefined) return [path === '' ? '<root>' : path]
  if (value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => undefinedPaths(item, `${path}[${String(index)}]`))
  }
  return Object.entries(value).flatMap(([key, item]) => undefinedPaths(item, path === '' ? key : `${path}.${key}`))
}

// ---------------------------------------------------------------------------
// A minimal Cordis-shaped context: event bus, effects, service lookup.
// ---------------------------------------------------------------------------
function createFakeCtx() {
  const handlers = new Map()
  const services = new Map()
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(name, handler) {
      let set = handlers.get(name)
      if (set === undefined) {
        set = new Set()
        handlers.set(name, set)
      }
      set.add(handler)
      return () => set.delete(handler)
    },
    emit(name, ...args) {
      for (const handler of [...(handlers.get(name) ?? [])]) handler(...args)
    },
    effect(factory) {
      const dispose = factory()
      disposers.push(dispose)
      return dispose
    },
    get(name) {
      return services.get(name)
    },
    provide(name, value) {
      services.set(name, value)
    },
    /**
     * Drive one waterfall event the way Cordis does: the registered listener
     * receives the request and the `next` it may call to fall through.
     */
    async waterfall(name, request, fallback) {
      const listeners = [...(handlers.get(name) ?? [])]
      const inner = async () => (fallback === undefined ? 'unavailable' : fallback())
      let index = 0
      const next = async () => {
        const listener = listeners[index]
        index += 1
        if (listener === undefined) return inner()
        return listener(request, next)
      }
      return next()
    },
    async dispose() {
      for (const dispose of disposers.reverse()) {
        if (typeof dispose === 'function') await dispose()
      }
    },
  }
  return ctx
}

// ---------------------------------------------------------------------------
// A stand-in Session Controller with real enough timing.
// ---------------------------------------------------------------------------
function createFakeSessions(ctx) {
  const sessions = new Map()

  function put(session) {
    sessions.set(session.summary.sessionId, session)
    return session
  }

  function create({ sessionId, title, running = false, records = [], cwd = '/tmp', updatedAt = Date.now() }) {
    const session = {
      summary: {
        sessionId,
        agentAvailable: true,
        updatedAt,
        running,
        blank: records.length === 0,
        cwd,
        projections: { values: { title } },
      },
      title,
      records: [],
      cursor: 0,
      waiters: new Set(),
    }
    for (const record of records) append(session, record.type, record.data)
    return put(session)
  }

  function append(session, type, data) {
    session.cursor += 1
    session.records.push({ type: 'event', event: { type, seq: session.cursor, time: Date.now(), data } })
    session.summary.updatedAt = Date.now()
    ctx.emit('session/event', { id: session.summary.sessionId }, { type, seq: session.cursor, time: Date.now(), data })
  }

  function setRunning(session, running) {
    session.summary.running = running
    ctx.emit('api-session/status', session.summary.sessionId, running)
    if (!running) {
      for (const resolve of [...session.waiters]) resolve()
      session.waiters.clear()
    }
  }

  const controller = {
    async list(_request, _signal) {
      return { items: [...sessions.values()].map(session => ({ ...session.summary })) }
    },
    follow(request, signal) {
      const session = sessions.get(request.address.sessionId)
      if (session === undefined) throw new Error(`unknown session ${request.address.sessionId}`)
      const max = request.maxMessages ?? 200
      async function* frames() {
        let from = 0
        yield {
          type: 'snapshot',
          header: { sessionId: session.summary.sessionId },
          cursor: session.cursor,
          records: session.records.slice(Math.max(0, session.records.length - max)),
          hasMore: session.records.length > max,
          projections: { values: { title: session.title } },
        }
        for (;;) {
          if (signal.aborted) return
          if (from < session.records.length) {
            yield { type: 'event', event: session.records[from].event }
            from += 1
            continue
          }
          await new Promise((resolve) => {
            const done = () => {
              clearTimeout(timer)
              session.waiters.delete(wake)
              resolve()
            }
            const wake = () => done()
            const timer = setTimeout(done, 50)
            session.waiters.add(wake)
            signal.addEventListener('abort', done, { once: true })
          })
        }
      }
      return frames()
    },
    async prompt(request) {
      const session = sessions.get(request.sessionId)
      if (session === undefined) throw new Error(`unknown session ${request.sessionId}`)
      const text = (request.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('')
      append(session, 'turn/start', {})
      append(session, 'user/message', { parts: [{ type: 'text', text }] })
      setRunning(session, true)
      const reply = `PONG: ${text}`
      setTimeout(() => {
        append(session, 'assistant/message', { parts: [{ type: 'text', text: reply }] })
        setRunning(session, false)
      }, 25)
      return { accepted: true }
    },
    cancel({ sessionId }) {
      const session = sessions.get(sessionId)
      if (session === undefined) return { accepted: false }
      setRunning(session, false)
      return { accepted: true }
    },
    async rename({ sessionId, title }) {
      const session = sessions.get(sessionId)
      if (session !== undefined) session.title = title
      return { renamed: true }
    },
    async selectModel() {
      return { selected: true }
    },
    async create(request) {
      const sessionId = request.sessionId ?? `session-test-${String(sessions.size + 1)}`
      create({ sessionId, title: 'peer created', records: [] })
      return { sessionId }
    },
    async modelCatalog() {
      return { providers: [] }
    },
  }

  return { controller, sessions, create, append, setRunning }
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------
const stateDir = await mkdtemp(join(tmpdir(), 'lan-bridge-it-'))
const ctx = createFakeCtx()
const fake = createFakeSessions(ctx)
ctx.provide('sessionController', fake.controller)

// Archive lives in the Workspace registry, not the Session controller.
const archived = new Set()
ctx.provide('workspaceController', {
  archiveSession(request) {
    if (request.stopActivity !== true && fake.sessions.get(request.sessionId)?.summary?.running === true) {
      throw new Error('workspace/session-active: stop the Session first')
    }
    archived.add(request.sessionId)
    return Promise.resolve({ archivedSessionIds: [...archived] })
  },
  unarchiveSession(request) {
    archived.delete(request.sessionId)
    return Promise.resolve({ archivedSessionIds: [...archived] })
  },
})

// File transfer needs real directories to stand in for the operator's roots:
// one writable, one read-only, and one that is deliberately outside the root so
// a symlink escape can be attempted.
const filesRoot = await mkdtemp(join(tmpdir(), 'lan-bridge-drop-'))
const outsideRoot = await mkdtemp(join(tmpdir(), 'lan-bridge-outside-'))
await mkdir(join(filesRoot, 'docs'), { recursive: true })
await writeFile(join(filesRoot, 'docs', 'hello.txt'), 'hello from the harness\n')
await writeFile(join(outsideRoot, 'secret.txt'), 'must never cross the fence\n')
await symlink(join(outsideRoot, 'secret.txt'), join(filesRoot, 'escape.txt'))

const cfg = resolveConfig({
  role: 'both',
  name: 'it-machine',
  listen: { host: '127.0.0.1', port: 0 },
  insecureHttp: true,
  allowPeersToCreateSessions: false,
  rateLimitPerMinute: 600,
  audit: true,
  files: {
    enabled: true,
    maxFileBytes: 8 * 1024 * 1024,
    chunkBytes: 64 * 1024,
    roots: [
      { name: 'drop', path: filesRoot, writable: true },
      { name: 'readonly', path: outsideRoot, writable: false },
    ],
  },
}, { DSH_HOME: stateDir })
cfg.stateDir = stateDir

const store = createStore({ stateDir, audit: cfg.audit, logger: ctx.logger })
const remote = createRemote({ cfg, store, logger: ctx.logger })
const api = createApi({ ctx, cfg, store, logger: ctx.logger, remote })
const server = createServer({ ctx, cfg, store, api, logger: ctx.logger })
const peerCache = createPeerCache()

const tools = new Map()
ctx.provide('tools', {
  register(definition) {
    tools.set(definition.name, definition)
    return () => tools.delete(definition.name)
  },
})
installTools({ ctx, cfg, store, remote, server, logger: ctx.logger, peerCache })

// The panel routes are registered through `connection.fetch`; capture them so
// the settings form is exercised exactly as the browser would call it.
const uiRoutes = new Map()
ctx.provide('connection', {
  fetch: {
    register(route) {
      uiRoutes.set(route.path, route)
      return () => uiRoutes.delete(route.path)
    },
  },
})
// A stand-in responder: the applier only needs to see whether it is listening
// and to be told to converge. Keeping it here means the "the switch does
// something" assertions run the same code the panel hits.
const discoveryProbe = {
  listening: false,
  starts: 0,
  stops: 0,
  status() { return { listening: this.listening } },
  async start() { this.starts += 1; this.listening = true },
  stop() { this.stops += 1; this.listening = false },
}
const applySettings = createSettingsApplier({ cfg, store, server, logger: ctx.logger, ready: Promise.resolve(), discovery: discoveryProbe })
installUi({ ctx, cfg, store, server, remote, peerCache, logger: ctx.logger, ready: Promise.resolve(), applySettings })

async function uiCall(name, payload) {
  const route = uiRoutes.get(`/api/lan-bridge.${name}`)
  if (route === undefined) throw new Error(`no UI route ${name}`)
  const request = new Request(`http://127.0.0.1${route.path}`, {
    method: route.methods[0],
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  })
  const response = await route.fetch(request)
  return response.json()
}

await server.start()
const url = `http://127.0.0.1:${String(server.status.port)}`
equal('listener bound', server.status.listening, true)

function rawRequest(base, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(path, base)
    const request = requestFn({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers: { 'content-type': 'application/json', ...headers },
    }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    request.on('error', reject)
    if (body !== undefined) request.write(body)
    request.end()
  })
}

async function rpc(method, params, { token, headers = {}, omitBridge = false } = {}) {
  const init = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(omitBridge ? {} : { 'x-dsh-bridge': '1' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: JSON.stringify({ id: 'it', method, params }),
  }
  const response = await fetch(`${url}/rpc`, init)
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { parseError: text }
  }
  return { status: response.status, body }
}

// --- health & fence ------------------------------------------------------
{
  const response = await fetch(`${url}/healthz`)
  equal('healthz status', response.status, 200)
  const body = await response.json()
  equal('healthz protocol', body.protocol, 1)
  steps.push('')
  steps.push('fence')
  const rawStatus = (headers) => rawRequest(url, 'POST', '/rpc', headers, JSON.stringify({ id: 'it', method: 'bridge.hello', params: {} }))
  equal('missing X-DSH-Bridge → 403', await rawStatus({ authorization: 'Bearer lzb_deadbeef' }), 403)
  const withOrigin = await rpc('bridge.hello', {}, { token: 'lzb_deadbeef', headers: { origin: 'http://evil.test' } })
  equal('Origin present → 403', withOrigin.status, 403)
  const crossSite = await rpc('bridge.hello', {}, { token: 'lzb_deadbeef', headers: { 'sec-fetch-site': 'cross-site' } })
  equal('sec-fetch-site → 403', crossSite.status, 403)
  equal('foreign Host → 403', await rawStatus({ host: 'evil.test:5977', 'x-dsh-bridge': '1', authorization: 'Bearer lzb_deadbeef' }), 403)
  const noToken = await rpc('bridge.hello', {}, {})
  equal('missing bearer → 401', noToken.status, 401)
  const badToken = await rpc('bridge.hello', {}, { token: 'lzb_00000000000000000000000000000000' })
  equal('unknown bearer → 401', badToken.status, 401)
  const unknownPath = await fetch(`${url}/nope`, { headers: { 'x-dsh-bridge': '1' } })
  equal('unknown path → 404', unknownPath.status, 404)
  const wrongMethod = await fetch(`${url}/rpc`, { method: 'GET', headers: { 'x-dsh-bridge': '1' } })
  equal('GET /rpc → 405', wrongMethod.status, 405)
}

// --- pairing & hello -----------------------------------------------------
const { token } = await store.pair({ name: 'it-peer', capabilities: ['read', 'prompt', 'control'] })
const readOnly = await store.pair({ name: 'it-reader', capabilities: ['read'] })
{
  steps.push('')
  steps.push('hello')
  const hello = await rpc('bridge.hello', {}, { token })
  equal('hello ok', hello.body.ok, true)
  equal('hello protocol', hello.body.result.protocol, 1)
  equal('hello app', hello.body.result.app, 'dsh-lan-bridge')
  const unknown = await rpc('bridge.nope', {}, { token })
  equal('unknown method → ok:false', unknown.body.ok, false)
  equal('unknown method code', unknown.body.error.code, 'bridge/method-unavailable')
  equal('unknown method stays HTTP 200', unknown.status, 200)
  const badBody = await fetch(`${url}/rpc`, {
    method: 'POST',
    headers: { 'x-dsh-bridge': '1', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{not json',
  })
  equal('malformed body → 400', badBody.status, 400)
}

// --- share gating --------------------------------------------------------
const target = fake.create({
  sessionId: 'session-it-target',
  title: 'integration target',
  records: [
    { type: 'user/message', data: { parts: [{ type: 'text', text: 'hello from the log' }] } },
    { type: 'assistant/message', data: { parts: [{ type: 'text', text: 'hello back' }] } },
  ],
})
const other = fake.create({ sessionId: 'session-it-hidden', title: 'not shared' })
{
  steps.push('')
  steps.push('share gating')
  const listed = await rpc('session.list', {}, { token })
  equal('unshared sessions are invisible', listed.body.result.sessions.length, 0)
  const blocked = await rpc('session.transcript', { sessionId: other.summary.sessionId }, { token })
  equal('unshared transcript → session/not-shared', blocked.body.error.code, 'session/not-shared')
  await store.setShared(target.summary.sessionId, true)
  const sharedList = await rpc('session.list', {}, { token })
  equal('shared session appears', sharedList.body.result.sessions.length, 1)
  equal('listing carries the title', sharedList.body.result.sessions[0].title, 'integration target')
  equal('listing reports running flag', sharedList.body.result.sessions[0].running, false)
  const reader = await rpc('session.transcript', { sessionId: target.summary.sessionId }, { token: readOnly.token })
  equal('read-only peer may read', reader.body.ok, true)
  equal('transcript record count', reader.body.result.records.length, 2)
  equal('transcript cursor', reader.body.result.cursor, 2)
  const denied = await rpc('session.prompt', { sessionId: target.summary.sessionId, text: 'hi' }, { token: readOnly.token })
  equal('read-only peer cannot prompt', denied.body.error.code, 'bridge/forbidden')
  const state = await rpc('session.state', { sessionId: target.summary.sessionId }, { token })
  equal('state running flag', state.body.result.running, false)
  equal('state pendingInput empty', state.body.result.pendingInput, false)
}

// --- prompt → wait -------------------------------------------------------
{
  steps.push('')
  steps.push('prompt & wait')
  const before = (await rpc('session.transcript', { sessionId: target.summary.sessionId }, { token })).body.result.cursor
  const prompt = await rpc('session.prompt', { sessionId: target.summary.sessionId, text: 'ping' }, { token })
  equal('prompt accepted', prompt.body.ok, true)
  const waiting = await rpc('session.wait', { sessionId: target.summary.sessionId, timeoutMs: 5000, afterSeq: before }, { token })
  equal('wait ends idle', waiting.body.result.reason, 'idle')
  const texts = JSON.stringify(waiting.body.result.records)
  check('wait returns the assistant reply', texts.includes('PONG: ping'), texts.slice(0, 200))
  check('prompt reports the cursor to wait from', typeof prompt.body.result.cursor === 'number', JSON.stringify(prompt.body.result))
  // afterSeq is honoured: nothing at or below the baseline comes back, and a
  // quiet Session is reported as "nothing new within the budget" rather than a
  // false idle — with a cursor, silence is not proof the turn stopped.
  const again = await rpc('session.wait', { sessionId: target.summary.sessionId, timeoutMs: 1500, afterSeq: waiting.body.result.cursor }, { token })
  equal('a quiet tail past the cursor reports timeout', again.body.result.reason, 'timeout')
  equal('a quiet tail past the cursor returns no old records', again.body.result.records.length, 0)
  const seqs = waiting.body.result.records.map(record => record?.event?.seq ?? record?.seq).filter(value => typeof value === 'number')
  check('afterSeq filtered the tail', seqs.every(seq => seq > before), JSON.stringify(seqs))
}

// --- a queued prompt that has not started is not "idle" yet ---------------
{
  steps.push('')
  steps.push('wait race')
  // A turn that has not flipped `running` yet must not be reported idle on the
  // first read: that was the bug that made a fresh prompt look finished.
  fake.append(target, 'user/message', { message: { role: 'user', content: [{ type: 'text', text: 'queued but not started' }] } })
  const started = Date.now()
  const waiting = await rpc('session.wait', { sessionId: target.summary.sessionId, timeoutMs: 8000 }, { token })
  const elapsed = Date.now() - started
  equal('unstarted prompt still settles idle', waiting.body.result.reason, 'idle')
  check('wait did not return on the first tick', elapsed >= 1000, `elapsed ${String(elapsed)}ms`)
}

// --- intent envelope -----------------------------------------------------
{
  steps.push('')
  steps.push('intent envelope')
  const sent = await rpc('session.prompt', {
    sessionId: target.summary.sessionId,
    text: 'ping once',
    intent: {
      goal: 'prove the intent envelope rides along',
      plan: ['send one prompt', 'read the tail'],
      expects: 'PONG only',
      deadline: 'this turn',
      format: 'two letters',
    },
  }, { token })
  equal('prompt with intent accepted', sent.body.ok, true)
  equal('prompt reports the envelope', sent.body.result.intent, true)
  const tail = await rpc('session.transcript', { sessionId: target.summary.sessionId }, { token })
  const blob = JSON.stringify(tail.body.result.records)
  check('intent block is rendered', blob.includes('[lan-bridge intent]'), blob.slice(0, 300))
  check('intent goal is rendered', blob.includes('goal: prove the intent envelope rides along'))
  check('intent plan is numbered', blob.includes('1. send one prompt') && blob.includes('2. read the tail'))
  check('intent expects is rendered', blob.includes('expects: PONG only'))
  const stored = await rpc('session.intents', { sessionId: target.summary.sessionId }, { token })
  equal('intent is remembered', stored.body.result.intents.length, 1)
  equal('remembered intent keeps the goal', stored.body.result.intents[0].goal, 'prove the intent envelope rides along')
  equal('remembered intent names the sender', stored.body.result.intents[0].peer, 'it-peer')
  const badGoal = await rpc('session.prompt', { sessionId: target.summary.sessionId, text: 'x', intent: {} }, { token })
  equal('intent without a goal is rejected', badGoal.body.error.code, 'bridge/bad-request')
  const badPlan = await rpc('session.prompt', { sessionId: target.summary.sessionId, text: 'x', intent: { goal: 'g', plan: 'nope' } }, { token })
  equal('intent plan must be an array', badPlan.body.error.code, 'bridge/bad-request')
  const tooMany = await rpc('session.prompt', {
    sessionId: target.summary.sessionId,
    text: 'x',
    intent: { goal: 'g', plan: Array.from({ length: 21 }, (_, index) => `step ${String(index)}`) },
  }, { token })
  equal('intent plan is bounded', tooMany.body.error.code, 'bridge/bad-request')
  const plain = await rpc('session.prompt', { sessionId: target.summary.sessionId, text: 'no envelope' }, { token })
  equal('a plain prompt is unchanged', plain.body.result.intent, undefined)
  const reader = await rpc('session.intents', { sessionId: target.summary.sessionId }, { token: readOnly.token })
  equal('read-only peer may read intents', reader.body.ok, true)
}

// --- shared board --------------------------------------------------------
{
  steps.push('')
  steps.push('board')
  const collab = await store.pair({ name: 'it-collab', capabilities: ['read', 'collab'] })
  const denied = await rpc('tasks.list', {}, { token })
  equal('board needs the collab capability', denied.body.error.code, 'bridge/forbidden')
  const created = await rpc('tasks.create', {
    subject: 'ship the board',
    description: 'two machines agree on what done means',
    writeScopes: ['lib/board.js'],
  }, { token: collab.token })
  equal('task created', created.body.ok, true)
  const task = created.body.result.task
  equal('task starts pending', task.status, 'pending')
  equal('task starts ready', task.ready, true)
  equal('task names this machine as creator', created.body.result.name, cfg.name)
  const listed = await rpc('tasks.list', {}, { token: collab.token })
  equal('board lists the task', listed.body.result.tasks.length, 1)
  const stale = await rpc('tasks.update', { taskId: task.id, expectedRevision: 99, action: 'claim' }, { token: collab.token })
  equal('stale revision → board/conflict', stale.body.error.code, 'board/conflict')
  equal('conflict reports the current revision', stale.body.error.details.currentRevision, 1)
  const claimed = await rpc('tasks.update', { taskId: task.id, expectedRevision: 1, action: 'claim' }, { token: collab.token })
  equal('claim bumps the revision', claimed.body.result.task.revision, 2)
  equal('claim marks in progress', claimed.body.result.task.status, 'in_progress')
  const done = await rpc('tasks.update', { taskId: task.id, expectedRevision: 2, action: 'complete' }, { token: collab.token })
  equal('complete marks the task done', done.body.result.task.status, 'completed')
  const readyChild = await rpc('tasks.create', { subject: 'after the board', blockedBy: [task.id] }, { token: collab.token })
  equal('a task blocked by a done task is ready', readyChild.body.result.task.ready, true)
  const waitingChild = await rpc('tasks.create', { subject: 'waits on the unknown', blockedBy: ['t-missing'] }, { token: collab.token })
  equal('unknown blockers keep a task unready', waitingChild.body.result.task.ready, false)
  const unknownTask = await rpc('tasks.update', { taskId: 't-nope', expectedRevision: 1, action: 'claim' }, { token: collab.token })
  equal('unknown task → board/not-found', unknownTask.body.error.code, 'board/not-found')
  equal('goal read needs collab too',
    (await rpc('goal.get', {}, { token })).body.error.code, 'bridge/forbidden')
  const empty = await rpc('goal.get', {}, { token: collab.token })
  equal('a fresh goal is revision 0', empty.body.result.goal.revision, 0)
  const first = await rpc('goal.set', { expectedRevision: 0, title: 'ship v0.3', text: 'done = board tests green' }, { token: collab.token })
  equal('goal written', first.body.result.goal.revision, 1)
  equal('goal authoring is recorded', typeof first.body.result.goal.updatedBy === 'string' && first.body.result.goal.updatedBy !== '', true)
  const goalConflict = await rpc('goal.set', { expectedRevision: 0, text: 'silent overwrite' }, { token: collab.token })
  equal('stale goal write → board/conflict', goalConflict.body.error.code, 'board/conflict')
  equal('goal conflict carries the live document', goalConflict.body.error.details.goal.text, 'done = board tests green')
  const secondWrite = await rpc('goal.set', { expectedRevision: 1, text: 'done = board + ledger tests green' }, { token: collab.token })
  equal('a fresh revision writes through', secondWrite.body.result.goal.revision, 2)
  equal('goal keeps its title across writes', secondWrite.body.result.goal.title, 'ship v0.3')
  const persisted = await store.board()
  equal('board survives in the state file', Object.keys(persisted.tasks).length, 3)
  await store.revoke('it-collab')
}

// --- input-required ------------------------------------------------------
{
  steps.push('')
  steps.push('input-required')
  fake.append(target, 'approval/asked', { id: 'ap-1', toolName: 'shell' })
  // The approval set is fed by the Host event bus; the api listens on it.
  const waiting = await rpc('session.wait', { sessionId: target.summary.sessionId, timeoutMs: 5000 }, { token })
  equal('pending approval → input-required', waiting.body.result.reason, 'input-required')
  fake.append(target, 'approval/decided', { id: 'ap-1', outcome: 'denied' })
  const state = await rpc('session.state', { sessionId: target.summary.sessionId }, { token })
  equal('decided approval clears pendingInput', state.body.result.pendingInput, false)
}

// --- remote approval answering -------------------------------------------
{
  steps.push('')
  steps.push('approval relay')
  const approver = await store.pair({ name: 'it-approver', capabilities: ['read', 'approve'] })
  fake.append(target, 'approval/asked', { id: 'ap-relay', toolName: 'shell', reason: 'write outside the workspace' })
  const listed = await rpc('approval.list', {}, { token: approver.token })
  equal('approval.list sees the pending approval', listed.body.result.approvals.length, 1)
  equal('approval.list names the tool', listed.body.result.approvals[0].toolName, 'shell')
  equal('approval.list names the Session', listed.body.result.approvals[0].sessionId, target.summary.sessionId)
  const unprivileged = await rpc('approval.answer', { id: 'ap-relay', decision: 'allow' }, { token })
  equal('answering without approve → bridge/forbidden', unprivileged.body.error.code, 'bridge/forbidden')
  const badDecision = await rpc('approval.answer', { id: 'ap-relay', decision: 'maybe' }, { token: approver.token })
  equal('an unknown decision is a bad request', badDecision.body.error.code, 'bridge/bad-request')
  const unknown = await rpc('approval.answer', { id: 'nope', decision: 'allow' }, { token: approver.token })
  equal('answering an unknown approval → bridge/not-found', unknown.body.error.code, 'bridge/not-found')

  // The waterfall listener waits for the peer, so answer from the far side.
  const relayed = ctx.waterfall('approval/request', {
    agent: { session: { id: target.summary.sessionId } },
    toolName: 'shell',
    reason: 'write outside the workspace',
  }, () => 'unavailable')
  setTimeout(() => {
    void rpc('approval.answer', { id: 'ap-relay', decision: 'allow' }, { token: approver.token })
  }, 50)
  equal('a relayed approval returns the remote decision', await relayed, 'allowed-once')
  fake.append(target, 'approval/decided', { id: 'ap-relay', outcome: 'allowed-once' })

  // Silence falls back to the local answerers instead of blocking the turn.
  fake.append(target, 'approval/asked', { id: 'ap-silent', toolName: 'shell' })
  const aborter = new AbortController()
  const silent = ctx.waterfall('approval/request', {
    agent: { session: { id: target.summary.sessionId } },
    toolName: 'shell',
    signal: aborter.signal,
  }, () => 'unavailable')
  setTimeout(() => { aborter.abort() }, 50)
  equal('a silent peer falls through to the local UI', await silent, 'unavailable')
  fake.append(target, 'approval/decided', { id: 'ap-silent', outcome: 'unavailable' })

  // An answer that races ahead of the waterfall is held, then consumed.
  fake.append(target, 'approval/asked', { id: 'ap-early', toolName: 'shell' })
  const early = await rpc('approval.answer', { id: 'ap-early', decision: 'reject' }, { token: approver.token })
  equal('an early answer is recorded', early.body.result.outcome, 'rejected')
  const consumed = await ctx.waterfall('approval/request', {
    agent: { session: { id: target.summary.sessionId } },
    toolName: 'shell',
  }, () => 'unavailable')
  equal('the early answer is consumed by the waterfall', consumed, 'rejected')
  fake.append(target, 'approval/decided', { id: 'ap-early', outcome: 'rejected' })

  // An unshared Session is never relayed, even with an approving peer present.
  await store.setShared(target.summary.sessionId, false)
  fake.append(target, 'approval/asked', { id: 'ap-private', toolName: 'shell' })
  const privateList = await rpc('approval.list', {}, { token: approver.token })
  equal('approval.list hides unshared Sessions', privateList.body.result.approvals.length, 0)
  const notRelayed = await ctx.waterfall('approval/request', {
    agent: { session: { id: target.summary.sessionId } },
    toolName: 'shell',
  }, () => 'unavailable')
  equal('an unshared Session falls through locally', notRelayed, 'unavailable')
  fake.append(target, 'approval/decided', { id: 'ap-private', outcome: 'unavailable' })
  await store.setShared(target.summary.sessionId, true)
  const audited = await rpc('approval.answer', { id: 'ap-relay', decision: 'allow' }, { token: approver.token })
  equal('an already decided approval is gone', audited.body.error.code, 'bridge/not-found')
  await store.revoke('it-approver')
}

// --- cancel --------------------------------------------------------------
{
  steps.push('')
  steps.push('cancel')
  fake.setRunning(target, true)
  const cancelled = await rpc('session.cancel', { sessionId: target.summary.sessionId }, { token })
  equal('cancel accepted', cancelled.body.result.accepted, true)
  equal('cancel stops the turn', target.summary.running, false)
}

// --- create is refused by default ---------------------------------------
{
  steps.push('')
  steps.push('create gating')
  const withoutCapability = await rpc('session.create', { sessionId: 'session-it-new' }, { token })
  equal('create without capability → bridge/forbidden', withoutCapability.body.error.code, 'bridge/forbidden')
  const capable = await store.pair({ name: 'it-creator', capabilities: ['read', 'create'] })
  const byConfig = await rpc('session.create', { sessionId: 'session-it-new' }, { token: capable.token })
  equal('create refused by config → bridge/method-unavailable', byConfig.body.error.code, 'bridge/method-unavailable')
  await store.revoke('it-creator')
}

// --- archive / unarchive ------------------------------------------------
{
  steps.push('')
  steps.push('archive')
  const noCapability = await rpc('session.archive', { sessionId: target.summary.sessionId }, { token })
  equal('archive without capability → bridge/forbidden', noCapability.body.error.code, 'bridge/forbidden')
  const archiver = await store.pair({ name: 'it-archiver', capabilities: ['read', 'archive'] })
  const hidden = await rpc('session.archive', { sessionId: target.summary.sessionId }, { token: archiver.token })
  equal('archive ok', hidden.body.ok, true)
  equal('archive reports the new archive set', hidden.body.result.archived, true)
  check('archive set contains the Session', hidden.body.result.archivedSessionIds.includes(target.summary.sessionId))
  const restored = await rpc('session.unarchive', { sessionId: target.summary.sessionId }, { token: archiver.token })
  equal('unarchive ok', restored.body.ok, true)
  equal('archive set is empty again', restored.body.result.archivedSessionIds.length, 0)
  const unsharedId = [...fake.sessions.keys()].find(id => id !== target.summary.sessionId)
  const unshared = await rpc('session.archive', { sessionId: unsharedId }, { token: archiver.token })
  equal('archive honours the share gate', unshared.body.error.code, 'session/not-shared')
  // A running Session needs stopActivity, and the Host's refusal must surface.
  fake.setRunning(fake.sessions.get(target.summary.sessionId), true)
  const busy = await rpc('session.archive', { sessionId: target.summary.sessionId }, { token: archiver.token })
  equal('archive of a running Session surfaces the Host error', busy.body.ok, false)
  const forced = await rpc('session.archive', { sessionId: target.summary.sessionId, stopActivity: true }, { token: archiver.token })
  equal('archive with stopActivity succeeds', forced.body.ok, true)
  await rpc('session.unarchive', { sessionId: target.summary.sessionId }, { token: archiver.token })
  fake.setRunning(fake.sessions.get(target.summary.sessionId), false)
  await store.revoke('it-archiver')
}

// --- SSE ----------------------------------------------------------------
{
  steps.push('')
  steps.push('sse')
  const controller = new AbortController()
  const response = await fetch(`${url}/events?session=${target.summary.sessionId}`, {
    headers: { 'x-dsh-bridge': '1', authorization: `Bearer ${token}` },
    signal: controller.signal,
  })
  equal('events status', response.status, 200)
  equal('events content-type', (response.headers.get('content-type') ?? '').includes('text/event-stream'), true)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (!buffer.includes('event: frame')) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
  }
  check('sse opens with a frame event', buffer.includes('event: frame'), buffer.slice(0, 200))
  check('sse frame is a snapshot', buffer.includes('"type":"snapshot"'), buffer.slice(0, 300))
  controller.abort()
  await reader.cancel().catch(() => {})
}

// --- tools (controller side, pointed at our own listener) ---------------
{
  steps.push('')
  steps.push('tools')
  equal('fifteen tools registered', tools.size, 15)
  for (const name of ['lan_dsh_peers', 'lan_dsh_share', 'lan_dsh_sessions', 'lan_dsh_transcript', 'lan_dsh_prompt', 'lan_dsh_wait', 'lan_dsh_cancel', 'lan_dsh_archive', 'lan_dsh_board', 'lan_dsh_task', 'lan_dsh_goal', 'lan_dsh_approval', 'lan_dsh_push_file', 'lan_dsh_pull_file', 'lan_dsh_files']) {
    check(`tool ${name} present`, tools.has(name))
  }
  const exec = async (name, args) => tools.get(name).execute(args, { signal: undefined })
  // pair: this is how a machine mints a token for someone else, and the only
  // path to a control/create-capable token (the panel only issues read+prompt).
  const paired = await exec('lan_dsh_peers', { action: 'pair', name: 'ops', capabilities: ['read', 'control'] })
  check('pair returns a one-time token', typeof paired.token === 'string' && paired.token.startsWith('lzb_'), String(paired.token))
  equal('pair records the requested capabilities',
    paired.inbound.find(item => item.name === 'ops').capabilities.join(','), 'read,control')
  const opsState = await rpc('session.state', { sessionId: target.summary.sessionId }, { token: paired.token })
  equal('paired token may read', opsState.body.ok, true)
  const opsCancel = await rpc('session.cancel', { sessionId: target.summary.sessionId }, { token: paired.token })
  equal('paired token with control may cancel', opsCancel.body.ok, true)
  const limited = await exec('lan_dsh_peers', { action: 'pair', name: 'looker' })
  equal('pair without capabilities defaults to read+prompt',
    limited.inbound.find(item => item.name === 'looker').capabilities.join(','), 'read,prompt')

  // grant: promote a live peer in place. The token must keep working, because
  // the whole point is not having to mail a new secret.
  const granted = await exec('lan_dsh_peers', {
    action: 'grant', name: 'looker', capabilities: ['read', 'prompt', 'approve'],
  })
  equal('grant ok', granted.ok, true)
  equal('grant replaces the capability list',
    granted.inbound.find(item => item.name === 'looker').capabilities.join(','), 'read,prompt,approve')
  const lookerState = await rpc('session.state', { sessionId: target.summary.sessionId }, { token: limited.token })
  equal('the granted token is unchanged and still works', lookerState.body.ok, true)
  const emptyGrant = await exec('lan_dsh_peers', { action: 'grant', name: 'looker', capabilities: [] }).then(
    () => ({ ok: true }), (error) => ({ ok: false, code: error?.code }),
  )
  equal('grant without capabilities refused', emptyGrant.ok, false)
  equal('grant without capabilities names the field', emptyGrant.code, 'bridge/bad-request')
  const unknownGrant = await exec('lan_dsh_peers', { action: 'grant', name: 'nobody', capabilities: ['read'] }).then(
    () => ({ ok: true }), (error) => ({ ok: false, code: error?.code }),
  )
  equal('grant unknown peer refused', unknownGrant.ok, false)
  equal('grant unknown peer error code', unknownGrant.code, 'bridge/not-found')

  const added = await exec('lan_dsh_peers', { action: 'add', name: 'loopback', url, token })
  equal('peer add ok', added.ok, true)
  equal('peer add reachable', added.peers[0].reachable, true)
  const listedPeers = await exec('lan_dsh_peers', { action: 'list' })
  equal('peer list length', listedPeers.peers.length, 1)
  const peerSessions = await exec('lan_dsh_sessions', { peer: 'loopback' })
  equal('peer sessions visible', peerSessions.peers[0].sessions.length, 1)
  const transcript = await exec('lan_dsh_transcript', { peer: 'loopback', sessionId: target.summary.sessionId, maxMessages: 5 })
  equal('tool transcript ok', transcript.ok, true)
  const before = (await rpc('session.transcript', { sessionId: target.summary.sessionId }, { token })).body.result.cursor
  const prompted = await exec('lan_dsh_prompt', { peer: 'loopback', sessionId: target.summary.sessionId, text: 'from a tool', timeoutMs: 5000 })
  equal('tool prompt ok', prompted.ok, true)
  equal('tool prompt reason', prompted.reason, 'idle')
  check('tool prompt returns the reply', JSON.stringify(prompted).includes('PONG: from a tool'), JSON.stringify(prompted).slice(0, 200))
  const localShare = await exec('lan_dsh_share', { action: 'list' })
  equal('share list shows both local sessions', localShare.sessions.length, 2)
  equal('share list flags exactly one shared session', localShare.sessions.filter(item => item.shared === true).length, 1)
  // The Host validates every tool result as lossless JSON: one `undefined`
  // (an absent title or cwd) fails the whole call, which is exactly the bug a
  // peer hit in the wild.
  equal('share output stays lossless JSON', undefinedPaths(localShare).join(','), '')
  fake.create({ sessionId: 'session-it-untitled' })
  const shareUntitled = await exec('lan_dsh_share', { action: 'share', sessionId: 'session-it-untitled' })
  const untitledRow = shareUntitled.sessions.find(item => item.sessionId === 'session-it-untitled')
  equal('a Session without a title omits the key', untitledRow !== undefined && 'title' in untitledRow, false)
  equal('untitled share output stays lossless JSON', undefinedPaths(shareUntitled).join(','), '')
  await exec('lan_dsh_share', { action: 'unshare', sessionId: 'session-it-untitled' })
  const unshared = await exec('lan_dsh_share', { action: 'unshare', sessionId: target.summary.sessionId })
  equal('unshare ok', unshared.ok, true)
  const afterUnshare = await exec('lan_dsh_sessions', { peer: 'loopback' })
  equal('peer sees nothing after unshare', afterUnshare.peers[0].sessions.length, 0)
  // archive through a peer needs an archive-capable token, and the tool also
  // works on this machine when `peer` is omitted.
  await exec('lan_dsh_share', { action: 'share', sessionId: target.summary.sessionId })
  const archivePeer = await exec('lan_dsh_peers', { action: 'pair', name: 'it-archiver', capabilities: ['read', 'archive'] })
  await exec('lan_dsh_peers', { action: 'add', name: 'arch-peer', url, token: archivePeer.token })
  const toolArchived = await exec('lan_dsh_archive', { action: 'archive', peer: 'arch-peer', sessionId: target.summary.sessionId })
  equal('tool archive on a peer ok', toolArchived.ok, true)
  equal('tool archive reports archived', toolArchived.archived, true)
  const toolRestored = await exec('lan_dsh_archive', { action: 'unarchive', peer: 'arch-peer', sessionId: target.summary.sessionId })
  equal('tool unarchive on a peer ok', toolRestored.archived, false)
  const localArchived = await exec('lan_dsh_archive', { action: 'archive', sessionId: target.summary.sessionId })
  equal('tool archive on this machine ok', localArchived.ok, true)
  const localRestored = await exec('lan_dsh_archive', { action: 'unarchive', sessionId: target.summary.sessionId })
  equal('tool unarchive on this machine ok', localRestored.archived, false)
  await exec('lan_dsh_peers', { action: 'remove', name: 'arch-peer' })

  // board through the tools: local writes, then a merged read over the wire —
  // merging needs a peer whose token carries the collab capability.
  const collabPeer = await exec('lan_dsh_peers', { action: 'pair', name: 'board-peer', capabilities: ['read', 'collab'] })
  const localTask = await exec('lan_dsh_task', { action: 'create', subject: 'wire the board tool', assignee: cfg.name })
  equal('task tool creates a task', localTask.ok, true)
  equal('task tool returns the id', typeof localTask.task?.id, 'string')
  const claimedByTool = await exec('lan_dsh_task', {
    action: 'update',
    taskId: localTask.task.id,
    expectedRevision: localTask.task.revision,
    taskAction: 'claim',
  })
  equal('task tool claims', claimedByTool.task.status, 'in_progress')
  const staleToolWrite = await exec('lan_dsh_task', {
    action: 'update',
    taskId: localTask.task.id,
    expectedRevision: 1,
    taskAction: 'complete',
  }).then(value => value, error => ({ error: String(error?.message ?? error) }))
  check('stale tool write fails loudly', typeof staleToolWrite.error === 'string', JSON.stringify(staleToolWrite).slice(0, 200))
  const goalBefore = await exec('lan_dsh_goal', { action: 'get' })
  const goalSet = await exec('lan_dsh_goal', {
    action: 'set',
    expectedRevision: goalBefore.goal.revision,
    title: 'wire the goal tool',
    text: 'done = board tool reads back',
  })
  equal('goal tool writes', goalSet.goal.revision, goalBefore.goal.revision + 1)
  const goalRead = await exec('lan_dsh_goal', { action: 'get' })
  equal('goal tool reads back', goalRead.goal.title, 'wire the goal tool')
  await exec('lan_dsh_peers', { action: 'add', name: 'board-peer', url, token: collabPeer.token })
  const merged = await exec('lan_dsh_board', { peer: 'board-peer' })
  equal('board tool answers', merged.ok, true)
  const peerRow = merged.machines.find(machine => machine.name === 'board-peer')
  equal('board tool reaches the peer', peerRow.reachable, true)
  const localRow = merged.machines.find(machine => machine.name === cfg.name)
  check('merged read qualifies this machine\'s ids', JSON.stringify(localRow.tasks).includes(`${cfg.name}/${localTask.task.id}`), JSON.stringify(localRow.tasks).slice(0, 200))
  check('merged read qualifies the peer\'s ids', (peerRow.tasks ?? []).every(task => String(task.qualifiedId).startsWith('board-peer/')), JSON.stringify(peerRow.tasks).slice(0, 200))
  const remoteTask = await exec('lan_dsh_task', { action: 'create', peer: 'board-peer', subject: 'created over the wire' })
  equal('task tool writes on the peer', remoteTask.ok, true)
  const remoteGoal = await exec('lan_dsh_goal', { action: 'get', peer: 'board-peer' })
  equal('goal tool reads the peer document', remoteGoal.goal.title, 'wire the goal tool')
  equal('board tool output stays lossless JSON', undefinedPaths(merged).join(','), '')
  await exec('lan_dsh_peers', { action: 'remove', name: 'board-peer' })

  // --- deleting a task and clearing the goal ------------------------------
  // Deleting is a real delete from the board, but a tombstone keeps the subject
  // and who removed it; a blocker someone still waits on needs `force`.
  const blocker = await exec('lan_dsh_task', { action: 'create', subject: 'blocking task' })
  const dependent = await exec('lan_dsh_task', { action: 'create', subject: 'waits on the blocker', blockedBy: [blocker.task.id] })
  const refusedDelete = await exec('lan_dsh_task', {
    action: 'update',
    taskId: blocker.task.id,
    expectedRevision: blocker.task.revision,
    taskAction: 'delete',
  }).then(value => value, error => ({ error: String(error?.message ?? error) }))
  check('deleting a task someone waits on is refused', String(refusedDelete.error ?? '').includes('force=true'), JSON.stringify(refusedDelete).slice(0, 200))
  check('the refused delete kept the task', (await store.board()).tasks[blocker.task.id] !== undefined)
  const forcedDelete = await exec('lan_dsh_task', {
    action: 'update',
    taskId: blocker.task.id,
    expectedRevision: blocker.task.revision,
    taskAction: 'delete',
    force: true,
  })
  equal('forced delete succeeds', forcedDelete.deleted, true)
  check('the task is gone', (await store.board()).tasks[blocker.task.id] === undefined)
  const tombstone = (await store.board()).tombstones.at(-1)
  equal('a tombstone keeps the subject', tombstone.subject, 'blocking task')
  equal('a tombstone names who removed it', tombstone.deletedBy, cfg.name)
  check('the dependent task survives', (await store.board()).tasks[dependent.task.id] !== undefined)
  equal('a forced delete re-points its dependents', JSON.stringify((await store.board()).tasks[dependent.task.id].blockedBy), '[]')
  check('a forced delete reports what it unblocked', forcedDelete.message.includes(dependent.task.id), String(forcedDelete.message))
  const tombstoneReader = await store.pair({ name: 'tombstone-reader', capabilities: ['collab'] })
  equal('the tombstone is readable over the wire', (await rpc('tasks.list', {}, { token: tombstoneReader.token })).body.result.tombstones.at(-1).subject, 'blocking task')
  await store.revoke('tombstone-reader')
  const staleDelete = await exec('lan_dsh_task', {
    action: 'update',
    taskId: dependent.task.id,
    expectedRevision: 9,
    taskAction: 'delete',
  }).then(value => value, error => ({ error: String(error?.message ?? error) }))
  check('a stale delete is refused', String(staleDelete.error ?? '').includes('revision'), JSON.stringify(staleDelete).slice(0, 200))
  const liveDependent = (await store.board()).tasks[dependent.task.id]
  const completedDelete = await exec('lan_dsh_task', {
    action: 'update',
    taskId: dependent.task.id,
    expectedRevision: liveDependent.revision,
    taskAction: 'complete',
  })
  const completedDeleteNow = await exec('lan_dsh_task', {
    action: 'update',
    taskId: dependent.task.id,
    expectedRevision: completedDelete.task.revision,
    taskAction: 'delete',
  })
  equal('a completed task can be deleted (that is how the board stays readable)', completedDeleteNow.deleted, true)

  const goalBeforeClear = (await exec('lan_dsh_goal', { action: 'get' })).goal
  const cleared = await exec('lan_dsh_goal', { action: 'clear', expectedRevision: goalBeforeClear.revision })
  equal('clear bumps the revision', cleared.goal.revision, goalBeforeClear.revision + 1)
  equal('clear empties the text', cleared.goal.text, '')
  equal('clear empties the title', cleared.goal.title, '')
  const staleClear = await exec('lan_dsh_goal', { action: 'clear', expectedRevision: goalBeforeClear.revision })
    .then(value => value, error => ({ error: String(error?.message ?? error) }))
  check('a stale clear is refused', String(staleClear.error ?? '').includes('revision'), JSON.stringify(staleClear).slice(0, 200))
  const afterClear = await exec('lan_dsh_goal', { action: 'set', expectedRevision: cleared.goal.revision, title: 'post-clear', text: 'goal is writable after a clear' })
  equal('the goal is writable again after a clear', afterClear.goal.revision, cleared.goal.revision + 1)

  // --- task hand-over (ownership moves between boards) --------------------
  // A second bridge instance, because a hand-over needs a real other board;
  // pointing at our own listener cannot work (that would be a self-transfer).
  const peerStateDir = await mkdtemp(join(tmpdir(), 'lan-bridge-peer-'))
  const peerCfg = resolveConfig({
    role: 'both',
    name: 'hand-peer',
    listen: { host: '127.0.0.1', port: 0 },
    insecureHttp: true,
    allowPeersToCreateSessions: false,
    rateLimitPerMinute: 600,
    audit: true,
  }, { DSH_HOME: peerStateDir })
  peerCfg.stateDir = peerStateDir
  const peerStore = createStore({ stateDir: peerStateDir, audit: peerCfg.audit, logger: ctx.logger })
  const peerRemote = createRemote({ cfg: peerCfg, store: peerStore, logger: ctx.logger })
  const peerApi = createApi({ ctx, cfg: peerCfg, store: peerStore, logger: ctx.logger, remote: peerRemote })
  const peerServer = createServer({ ctx, cfg: peerCfg, store: peerStore, api: peerApi, logger: ctx.logger })
  await peerServer.start()
  const peerUrl = `http://127.0.0.1:${String(peerServer.status.port)}`
  const peerRpc = async (method, params, token) => {
    const response = await fetch(`${peerUrl}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-bridge': '1', authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: 'hand-peer', method, params }),
    })
    return { status: response.status, body: await response.json() }
  }
  const allCaps = ['read', 'prompt', 'control', 'create', 'archive', 'collab', 'approve', 'files']
  // Each side mints the credential the other one presents.
  const handToken = (await store.pair({ name: 'hand-peer', capabilities: allCaps })).token
  const peerToken = (await peerStore.pair({ name: 'it-machine', capabilities: allCaps })).token
  await store.addOutbound({ name: 'hand-peer', url: peerUrl, token: peerToken })
  await peerStore.addOutbound({ name: 'it-machine', url, token: handToken })

  // this machine → peer
  const seeded = await exec('lan_dsh_task', { action: 'create', subject: 'hand me over', assignee: cfg.name })
  const handed = await exec('lan_dsh_task', { action: 'transfer', taskId: seeded.task.id, to: 'hand-peer' })
  equal('transfer reports both ends', `${handed.task === undefined ? '' : 'task'}:${String(handed.message)}`.includes('it-machine'), true)
  equal('the task left this board', (await store.board()).tasks[seeded.task.id], undefined)
  const peerTasks = (await peerRpc('tasks.list', {}, peerToken)).body.result.tasks
  const adopted = peerTasks.find(task => task.id === seeded.task.id)
  check('the peer adopted the task', adopted !== undefined, JSON.stringify(peerTasks).slice(0, 200))
  equal('adoption records where it came from', adopted.origin.machine, cfg.name)
  equal('the adopted task keeps its subject', adopted.subject, 'hand me over')

  // a stale revision is refused and nothing moves
  const staleSeed = await exec('lan_dsh_task', { action: 'create', subject: 'stale hand-over' })
  const staleMove = await exec('lan_dsh_task', { action: 'transfer', taskId: staleSeed.task.id, to: 'hand-peer', expectedRevision: 9 })
    .then(value => value, error => ({ error: String(error?.message ?? error) }))
  check('a stale hand-over is refused', String(staleMove.error ?? '').includes('revision'), JSON.stringify(staleMove).slice(0, 200))
  check('a refused hand-over leaves the task here', (await store.board()).tasks[staleSeed.task.id] !== undefined)

  // completed tasks stay as history
  await exec('lan_dsh_task', { action: 'update', taskId: staleSeed.task.id, expectedRevision: 1, taskAction: 'complete' })
  const completedMove = await exec('lan_dsh_task', { action: 'transfer', taskId: staleSeed.task.id, to: 'hand-peer' })
    .then(value => value, error => ({ error: String(error?.message ?? error) }))
  check('a completed task cannot be handed over', String(completedMove.error ?? '').includes('completed'), JSON.stringify(completedMove).slice(0, 200))

  // an unreachable receiver changes nothing
  await store.addOutbound({ name: 'gone', url: 'http://127.0.0.1:1', token: 'lzb_gone' })
  const unreachableSeed = await exec('lan_dsh_task', { action: 'create', subject: 'nobody home' })
  const unreachableMove = await exec('lan_dsh_task', { action: 'transfer', taskId: unreachableSeed.task.id, to: 'gone' })
    .then(value => value, error => ({ error: String(error?.message ?? error) }))
  check('an unreachable receiver fails loudly', String(unreachableMove.error ?? '').length > 0, JSON.stringify(unreachableMove).slice(0, 200))
  check('an unreachable receiver leaves the task here', (await store.board()).tasks[unreachableSeed.task.id] !== undefined)
  await store.removeOutbound('gone')

  // peer → this machine, driven from here: the peer runs the move, we adopt
  const builtOnPeer = (await peerRpc('tasks.create', { subject: 'built on the peer' }, peerToken)).body.result.task
  const backHome = await exec('lan_dsh_task', { action: 'transfer', peer: 'hand-peer', taskId: builtOnPeer.id, to: cfg.name })
  equal('the peer hands its task back', backHome.ok, true)
  check('this board now owns it', (await store.board()).tasks[builtOnPeer.id] !== undefined)
  equal('the adopted record remembers the peer', (await store.board()).tasks[builtOnPeer.id].origin.machine, 'hand-peer')
  check('the peer dropped its copy', (await peerRpc('tasks.list', {}, peerToken)).body.result.tasks.every(task => task.id !== builtOnPeer.id))
  equal('hand-over output stays lossless JSON', undefinedPaths(backHome).join(','), '')

  // --- goal convergence (two copies, ordered by revision) -----------------
  // The board keeps one goal per machine, so "done" has to be decided
  // mechanically: higher revision wins, equal revision with different text is a
  // divergence to report. These assertions cover pull, push and that report.
  const localStart = (await exec('lan_dsh_goal', { action: 'get' })).goal.revision
  await exec('lan_dsh_goal', { action: 'set', expectedRevision: localStart, title: 'local plan', text: 'mine' })
  const pushedSync = await exec('lan_dsh_goal', { action: 'sync', peer: 'hand-peer' })
  equal('a newer local goal is pushed to the peer', pushedSync.synced[0].pushed, true)
  const peerGoalAfterPush = (await peerRpc('goal.get', {}, peerToken)).body.result.goal
  equal('the peer now holds this machine\'s goal', peerGoalAfterPush.title, 'local plan')
  equal('the peers agree on the revision', peerGoalAfterPush.revision, localStart + 1)

  // the peer writes next; a sync pulls it back
  await peerRpc('goal.set', { expectedRevision: localStart + 1, title: 'peer plan', text: 'theirs' }, peerToken)
  const pulledSync = await exec('lan_dsh_goal', { action: 'sync', peer: 'hand-peer' })
  equal('a newer peer goal is pulled', pulledSync.synced[0].applied, true)
  equal('this machine now shows the peer text', pulledSync.goal.text, 'theirs')

  // equal revision, different text: reported, never silently resolved
  const divergent = adoptGoal(
    { ...emptyBoard(), goal: { revision: 4, title: 'a', text: 'a', updatedBy: 'x', updatedAt: 1 } },
    { goal: { revision: 4, title: 'b', text: 'b' }, from: 'peer' },
    'it-machine',
  )
  equal('a same-revision divergence is not applied', divergent.applied, false)
  equal('a same-revision divergence is reported', divergent.diverged, true)
  const older = adoptGoal(
    { ...emptyBoard(), goal: { revision: 9, title: 'a', text: 'a', updatedBy: 'x', updatedAt: 1 } },
    { goal: { revision: 3, title: 'b', text: 'b' }, from: 'peer' },
    'it-machine',
  )
  equal('an older peer goal is ignored', older.applied, false)
  equal('an older peer goal keeps this copy', older.goal.title, 'a')

  // the RPC itself, and the board read that converges on its own
  const adoptRpc = await rpc('goal.adopt', { goal: { revision: 42, title: 'rpc plan', text: 'rpc' }, from: 'peer' }, { token: handToken })
  check('goal.adopt takes a higher revision over the wire', adoptRpc.body.result?.applied === true, JSON.stringify(adoptRpc.body).slice(0, 300))
  await exec('lan_dsh_goal', { action: 'sync', peer: 'hand-peer' })
  await peerRpc('goal.set', { expectedRevision: 42, title: 'peer ahead', text: 'ahead' }, peerToken)
  const boarded = await exec('lan_dsh_board', { peer: 'hand-peer' })
  check('reading the board converges the goal', (boarded.goalSync ?? []).some(entry => entry.applied === true), JSON.stringify(boarded.goalSync).slice(0, 200))
  equal('the board shows the converged text', boarded.goal.text, 'ahead')

  await peerServer.stop()
  await rm(peerStateDir, { recursive: true, force: true })
  await exec('lan_dsh_peers', { action: 'remove', name: 'hand-peer' })

  const removed = await exec('lan_dsh_peers', { action: 'remove', name: 'loopback' })
  equal('peer remove ok', removed.ok, true)
  equal('peer list empty after remove', (await exec('lan_dsh_peers', { action: 'list' })).peers.length, 0)
  void before
}

// --- listening settings (the panel form) ---------------------------------
{
  steps.push('')
  steps.push('settings')
  const initial = await uiCall('state')
  equal('state exposes settings.host', initial.settings.host, '127.0.0.1')
  equal('state exposes the create-session switch', initial.settings.allowPeersToCreateSessions, false)
  check('state lists local addresses', Array.isArray(initial.addresses) && initial.addresses.includes('127.0.0.1'), JSON.stringify(initial.addresses))
  equal('state has no restart pending', initial.restartRequired, false)

  const badHost = await uiCall('settings', { host: 'example.local' })
  equal('non-literal host refused', badHost.ok, false)
  equal('non-literal host error code', badHost.error.code, 'bridge/bad-request')

  const plainLan = await uiCall('settings', { host: '0.0.0.0', port: 0, insecureHttp: false })
  equal('lan bind without acknowledgement refused', plainLan.ok, false)
  equal('lan refusal code', plainLan.error.code, 'bridge/forbidden')

  const halfTls = await uiCall('settings', { tls: { certFile: '/tmp/a.pem' } })
  equal('half TLS pair refused', halfTls.ok, false)

  const widened = await uiCall('settings', { host: '0.0.0.0', port: 0, insecureHttp: true })
  equal('lan bind accepted after acknowledgement', widened.ok, true)
  equal('lan bind reports the bound host', widened.state.settings.host, '0.0.0.0')
  check('lan bind has a live port', widened.state.listen.port > 0, String(widened.state.listen.port))
  const lanPort = widened.state.listen.port
  const lanUrl = `http://127.0.0.1:${String(lanPort)}`
  equal('rebound listener answers healthz', await rawRequest(lanUrl, 'GET', '/healthz'), 200)
  const iface = localAddresses().find((address) => address !== '127.0.0.1')
  if (iface === undefined) {
    console.log('  note no non-loopback interface present; interface-authority check skipped')
  } else {
    const lanHostHeader = await rawRequest(lanUrl, 'GET', '/healthz', { host: `${iface}:${String(lanPort)}` })
    equal('interface address is an accepted authority', lanHostHeader, 200)
  }

  const back = await uiCall('settings', { host: '127.0.0.1', port: 0 })
  equal('loopback restore accepted', back.ok, true)
  equal('restore reports loopback', back.state.settings.host, '127.0.0.1')

  const persisted = await store.settings()
  equal('settings persisted to bridge.json', persisted.host, '127.0.0.1')
  equal('persisted port is what the operator asked for', persisted.port, 0)

  const port = server.status.port
  // Fail the rebind on an address this machine does not hold (TEST-NET-3,
  // RFC 5737). Port 1 is *not* a usable probe: Windows lets an unprivileged
  // process bind it, so that assertion only failed on POSIX.
  const broken = await uiCall('settings', { host: '203.0.113.7', port })
  equal('unbindable address refused', broken.ok, false)
  equal('unbindable address error code', broken.error.code, 'bridge/internal')
  equal('listener survived the failed rebind', server.status.listening, true)
  equal('listener kept its port', server.status.port, port)
  equal('listener kept its address after the rollback', (await store.settings()).host, '127.0.0.1')

  // --- machine name: editable, live, and it does not touch the socket ------
  equal('state exposes the machine name', initial.settings.name, 'it-machine')
  const emptyName = await uiCall('settings', { name: '   ' })
  equal('empty machine name refused', emptyName.ok, false)
  equal('empty machine name error code', emptyName.error.code, 'bridge/bad-request')
  const longName = await uiCall('settings', { name: 'n'.repeat(65) })
  equal('over-long machine name refused', longName.ok, false)
  const badName = await uiCall('settings', { name: 'bad\u0007name' })
  equal('control characters in the name refused', badName.ok, false)
  const portBeforeRename = server.status.port
  const renamed = await uiCall('settings', { name: '  renamed-it  ' })
  equal('rename accepted', renamed.ok, true)
  equal('rename is trimmed and applied', renamed.state.settings.name, 'renamed-it')
  equal('rename reached the live config', cfg.name, 'renamed-it')
  equal('rename did not rebuild the listener', server.status.port, portBeforeRename)
  // The module-level `url` still points at the pre-rebind port, so ask the
  // listener that is actually up right now.
  const liveUrl = `http://127.0.0.1:${String(server.status.port)}`
  const renamedHello = await fetch(`${liveUrl}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-bridge': '1', authorization: `Bearer ${token}` },
    body: JSON.stringify({ id: 'it', method: 'bridge.hello', params: {} }),
  }).then((response) => response.json())
  equal('hello advertises the new name', renamedHello.result.name, 'renamed-it')
  equal('renamed value persisted', (await store.settings()).name, 'renamed-it')
  const nameOnlyChange = await uiCall('settings', { trustedHosts: ['peer.local:5977'] })
  equal('a patch without a name keeps the current one', nameOnlyChange.state.settings.name, 'renamed-it')

  // The mDNS switch must act on save, not on the next Host start.
  const discoveryOn = await uiCall('settings', { discovery: true })
  equal('discovery switch saved', discoveryOn.ok, true)
  equal('discovery switch starts the responder immediately', discoveryProbe.listening, true)
  equal('discovery switch applied to the live config', cfg.discovery.enabled, true)
  await uiCall('settings', { discovery: false })
  equal('discovery switch stops the responder immediately', discoveryProbe.listening, false)
  equal('discovery is off in the live config again', cfg.discovery.enabled, false)
}

// --- the panel reads the switch, not the responder ------------------------
{
  steps.push('')
  steps.push('discovery state flag')
  // A responder that is bound while the operator's switch is off used to be
  // reported as `enabled: true`, so the panel's "off" empty state never showed.
  const probe = { listening: true, status() { return { listening: true } }, async start() {}, stop() {} }
  const flagCtx = createFakeCtx()
  const routes = new Map()
  flagCtx.provide('connection', {
    fetch: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  })
  const saved = cfg.discovery.enabled
  cfg.discovery.enabled = false
  installUi({ ctx: flagCtx, cfg, store, server, remote, peerCache, logger: flagCtx.logger, ready: Promise.resolve(), discovery: probe })
  const route = routes.get('/api/lan-bridge.state')
  const read = async () => (await route.fetch(new Request('http://127.0.0.1/api/lan-bridge.state'))).json()
  const off = await read()
  equal('a bound responder does not imply the switch is on', off.discovery.enabled, false)
  equal('responder liveness is still reported', off.discovery.listening, true)
  cfg.discovery.enabled = true
  const on = await read()
  equal('flipping the switch flips the reported flag', on.discovery.enabled, true)
  cfg.discovery.enabled = saved
  await flagCtx.dispose()

  const created = await uiCall('settings', { allowPeersToCreateSessions: true })
  equal('create-session switch saved', created.ok, true)
  equal('create-session switch applied live', cfg.allowPeersToCreateSessions, true)
  const hello = await uiCall('state')
  void hello

  // Boot overlay: a saved file wins over the row config, and an illegal saved
  // value is ignored instead of taking the listener down.
  await store.updateSettings({ host: '127.0.0.2', port: 0, insecureHttp: true, trustedHosts: ['it-host'] })
  const bootCfg = resolveConfig({ role: 'both', listen: { host: '127.0.0.1', port: 5977 } }, { DSH_HOME: stateDir })
  const boot = await loadPersistedSettings({ cfg: bootCfg, store, logger: ctx.logger })
  equal('boot overlay applied saved host', bootCfg.hostname, '127.0.0.2')
  equal('boot overlay applied saved trustedHosts', JSON.stringify(bootCfg.trustedHosts), JSON.stringify(['it-host']))
  check('boot overlay reports what it applied', boot.applied.includes('host'), JSON.stringify(boot.applied))
  await store.updateSettings({ host: '0.0.0.0', insecureHttp: false })
  const illegalCfg = resolveConfig({ role: 'both', listen: { host: '127.0.0.1', port: 5977 } }, { DSH_HOME: stateDir })
  const illegal = await loadPersistedSettings({ cfg: illegalCfg, store, logger: ctx.logger })
  equal('illegal saved settings fall back to the row config', illegalCfg.hostname, '127.0.0.1')
  check('illegal saved settings report why', typeof illegal.ignored === 'string' && illegal.ignored.length > 0, illegal.ignored)
  await store.updateSettings({ host: '127.0.0.1', port: 0, insecureHttp: cfg.insecureHttp, trustedHosts: [] })

  const archivePaired = await uiCall('pair', { name: 'it-ui-archiver', capabilities: ['read', 'archive'] })
  equal('panel can issue an archive token', archivePaired.ok, true)
  check('archive token carries archive', archivePaired.capabilities.includes('archive'), JSON.stringify(archivePaired.capabilities))
  await uiCall('revoke', { name: 'it-ui-archiver' })

  // The panel may mint any subset the Host knows, so an operator never has to
  // fall back to a pair command to get collab or control.
  const allCaps = ['read', 'prompt', 'control', 'create', 'archive', 'collab', 'approve', 'files']
  const everything = await uiCall('pair', { name: 'it-ui-everything', capabilities: allCaps })
  equal('panel can issue a token with every capability', everything.ok, true)
  equal('that token carries exactly those capabilities', JSON.stringify(everything.capabilities), JSON.stringify(allCaps))
  await uiCall('revoke', { name: 'it-ui-everything' })

  const collabOnly = await uiCall('pair', { name: 'it-ui-collab', capabilities: ['collab'] })
  equal('one capability is enough', collabOnly.ok, true)
  equal('collab survives alone', JSON.stringify(collabOnly.capabilities), JSON.stringify(['collab']))
  await uiCall('revoke', { name: 'it-ui-collab' })

  const noneAsked = await uiCall('pair', { name: 'it-ui-nothing', capabilities: [] })
  equal('an empty capability list is refused', noneAsked.error?.code, 'bridge/bad-request')
  equal('the refusal names the field', noneAsked.error?.details?.field, 'capabilities')

  const unknownAsked = await uiCall('pair', { name: 'it-ui-unknown', capabilities: ['teleport'] })
  equal('an unknown capability alone is refused', unknownAsked.error?.code, 'bridge/bad-request')

  const defaulted = await uiCall('pair', { name: 'it-ui-default' })
  equal('no list defaults to read+prompt', JSON.stringify(defaulted.capabilities), JSON.stringify(['read', 'prompt']))
  await uiCall('revoke', { name: 'it-ui-default' })
}

// --- every tool render survives an empty payload ------------------------
{
  steps.push('')
  steps.push('tool renderers')
  // A renderer that throws fails the whole call even though the data arrived
  // (the peer hit exactly that on `lan_dsh_peers` in 0.3.5). An empty payload is
  // the cheapest shape every renderer has to tolerate.
  for (const [name, definition] of tools) {
    let problem = null
    try {
      const out = definition.output.render({}, {})
      if (!Array.isArray(out) || out.some(part => typeof part?.text !== 'string')) problem = 'render did not return text parts'
    } catch (error) {
      problem = String(error).slice(0, 120)
    }
    check(`renderer of ${name} survives an empty payload`, problem === null, problem ?? '')
  }
}

// --- mDNS codec ----------------------------------------------------------
{
  steps.push('')
  steps.push('mdns codec')
  const name = `it-machine.${SERVICE}`
  const encoded = encodeName(name)
  const decoded = decodeName(encoded, 0)
  check('encodeName/decodeName round-trip', decoded.name === name, decoded.name)

  const query = parsePacket(buildQuery())
  check('query asks for the bridge service', query.questions[0]?.name === SERVICE && query.questions[0]?.type === 12, JSON.stringify(query.questions))

  const packet = parsePacket(buildResponse({
    instance: 'it-machine',
    host: 'it-machine',
    port: 5977,
    address: '192.168.1.8',
    txt: { name: 'it-machine', version: '0.3.5', protocol: '1' },
  }))
  check('announcement carries a PTR', packet.ptr[0]?.target === `it-machine.${SERVICE}`, JSON.stringify(packet.ptr))
  check('announcement carries SRV port and target', packet.srv[0]?.port === 5977 && packet.srv[0]?.target === 'it-machine.local', JSON.stringify(packet.srv))
  check('announcement carries TXT metadata', packet.txt[0]?.entries?.version === '0.3.5' && packet.txt[0]?.entries?.protocol === '1', JSON.stringify(packet.txt))
  check('announcement carries the address', packet.a[0]?.address === '192.168.1.8', JSON.stringify(packet.a))
  check('no token is ever announced', !JSON.stringify(packet).includes('lzb_'), 'txt/targets only')
}

// --- discovery tool without mDNS -----------------------------------------
{
  steps.push('')
  steps.push('peers discover (mDNS off)')
  const off = await tools.get('lan_dsh_peers').execute({ action: 'discover' }, { signal: undefined })
  check('discover explains that mDNS is off', off.ok === false && /mDNS is off/.test(off.message), JSON.stringify(off).slice(0, 160))
  check('discover still lists configured peers', Array.isArray(off.peers), `${String(off.peers?.length)} peer(s)`)
  // Tool output is handed to the model, so a bearer token must never ride along
  // in it. `store.outbound()` records do; described peers do not.
  const shipped = JSON.stringify(off)
  check('discover never ships a bearer token to the model', !/lzb_[0-9a-f]{8}/.test(shipped)
    && (off.peers ?? []).every(peer => peer.token === undefined), shipped.slice(0, 200))
  check('discover output is lossless JSON', undefinedPaths(off).length === 0, JSON.stringify(undefinedPaths(off)))
}

// --- the responder's own lifecycle ---------------------------------------
{
  steps.push('')
  steps.push('mdns responder lifecycle')
  const { createDiscovery } = await import('../lib/mdns.js')
  const { BridgeError } = await import('../lib/util.js')
  const liveCfg = resolveConfig({ role: 'both', name: 'it-life', listen: { host: '127.0.0.1', port: 0 }, discovery: { enabled: true } }, { DSH_HOME: stateDir })

  // Holding 5353 without SO_REUSEADDR makes the responder's bind fail, which is
  // exactly the Windows case (several apps own 5353 there). The failure used to
  // leave `start()` pending forever, and the panel awaits it when saving.
  const dgram = await import('node:dgram')
  const mdnsTestPort = Number(process.env.LAN_BRIDGE_MDNS_PORT ?? 5353)
  const squatter = dgram.createSocket({ type: 'udp4', reuseAddr: false })
  let squatted = false
  try {
    await new Promise((resolve, reject) => {
      squatter.once('error', reject)
      squatter.bind(mdnsTestPort, () => resolve())
    })
    squatted = true
  } catch {
    note(`UDP ${String(mdnsTestPort)} is already held by another app; skipping the busy-port assertions`)
  }

  if (squatted) {
    const busy = createDiscovery({ cfg: liveCfg, logger: ctx.logger, portOf: () => 0 })
    const settled = await Promise.race([
      busy.start().then(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 3_000)),
    ])
    check('a busy 5353 settles start() instead of hanging it', settled === 'settled', settled)
    check('a busy 5353 leaves the responder not listening', busy.status().listening === false, String(busy.status().listening))
    check('a busy 5353 records why', typeof busy.status().error === 'string' && busy.status().error.length > 0, String(busy.status().error))
    let browseError = null
    try {
      await busy.browse({ timeoutMs: 200 })
    } catch (error) {
      browseError = error
    }
    check('browsing an unbindable responder raises a typed error', browseError instanceof BridgeError, String(browseError))
    check('that error explains itself instead of saying "Not running"', /mDNS is not listening/.test(String(browseError)), String(browseError))
    busy.stop()
    squatter.close()
  }

  // The panel turns the switch off and on again without restarting the Host.
  const cycling = createDiscovery({ cfg: { ...liveCfg, name: 'it-cycle' }, logger: ctx.logger, portOf: () => 0 })
  const first = await cycling.start()
  if (first.listening !== true) {
    note(`multicast unavailable here (${String(first.error ?? 'unknown')}); skipping the stop/start cycle`)
  } else {
    check('start is idempotent', (await cycling.start()).listening, true)
    cycling.stop()
    check('stop turns the responder off', cycling.status().listening === false, String(cycling.status().listening))
    const rebind = await cycling.start()
    check('a stopped responder can bind again (the panel toggles it)', rebind.listening, true)
    cycling.stop()
  }
}

// --- discovery over real multicast (best effort) -------------------------
{
  steps.push('')
  steps.push('mdns discovery (live, best effort)')
  const { createDiscovery } = await import('../lib/mdns.js')
  const alphaCfg = resolveConfig({ role: 'both', name: 'it-alpha', listen: { host: '127.0.0.1', port: 0 }, discovery: { enabled: true } }, { DSH_HOME: stateDir })
  const betaCfg = resolveConfig({ role: 'both', name: 'it-beta', listen: { host: '127.0.0.1', port: 0 }, discovery: { enabled: true } }, { DSH_HOME: stateDir })
  let alphaPort = 0
  let betaPort = 0
  const alpha = createDiscovery({ cfg: alphaCfg, portOf: () => alphaPort })
  const beta = createDiscovery({ cfg: betaCfg, portOf: () => betaPort })
  await alpha.start()
  await beta.start()
  alphaPort = 5977
  betaPort = 5978
  const alphaStatus = alpha.status()
  if (alphaStatus.listening !== true) {
    note(`multicast unavailable here (${String(alphaStatus.error ?? 'unknown')}); skipping the live discovery assertions`)
  } else {
    const found = await alpha.browse({ timeoutMs: 900 })
    check('a peer announcing itself is discovered by name', found.some(entry => entry.name === 'it-beta'), JSON.stringify(found.map(entry => entry.name)))
    const entry = found.find(candidate => candidate.name === 'it-beta')
    check('the discovered entry carries a usable address and port', typeof entry?.address === 'string' && entry?.port === betaPort, JSON.stringify(entry))
    check('a peer learns this machine in turn', (await beta.browse({ timeoutMs: 400 })).some(candidate => candidate.name === 'it-alpha'), 'beta sees alpha')

    // The model-facing tool has to expose what the responder hears, or the
    // discovery is only visible to the code that made it.
    const discoverRegistry = new Map()
    const miniCtx = {
      logger: { info: () => {}, warn: () => {} },
      effect: (run) => { const dispose = run(); return () => dispose?.() },
      get: (service) => (service === 'tools' ? { register: (definition) => discoverRegistry.set(definition.name, definition) } : undefined),
      on: () => () => {},
    }
    installTools({ ctx: miniCtx, cfg: alphaCfg, store, remote, server, logger: miniCtx.logger, peerCache, discovery: alpha })
    const discovered = await discoverRegistry.get('lan_dsh_peers').execute({ action: 'discover', timeoutMs: 700 }, { signal: undefined })
    const leaked = JSON.stringify(discovered)
  check('live discover never ships a bearer token either', !/lzb_[0-9a-f]{8}/.test(leaked)
    && (discovered.peers ?? []).every(peer => peer.token === undefined), leaked.slice(0, 200))
  const candidate = (discovered.discovered ?? []).find(entry => entry.name === 'it-beta')
    check('peers discover lists the mDNS candidate', candidate !== undefined, JSON.stringify((discovered.discovered ?? []).map(entry => entry.name)))
    check('the candidate carries a URL the operator can add', candidate?.url === `http://${String(candidate?.address)}:${String(betaPort)}`, JSON.stringify(candidate))
    check('discover output is lossless JSON', undefinedPaths(discovered).length === 0, JSON.stringify(undefinedPaths(discovered)))
  }
  alpha.stop()
  beta.stop()
}

// --- workspace grouping & whole-workspace share --------------------------
{
  steps.push('')
  steps.push('workspace grouping')

  // A real DSH Workspace registration: stable UUID + canonical path + title.
  // `sessionIds` is exactly what WorkspaceEntity.sessionIds returns.
  const registrations = [
    {
      id: 'w-alpha',
      title: 'Alpha Project',
      path: '/home/dev/alpha',
      sessionIds: ['session-ws-a1', 'session-ws-a2'],
    },
    { id: 'w-empty', title: 'Empty Space', path: '/home/dev/empty', sessionIds: [] },
  ]
  ctx.provide('workspaceRegistry', {
    list() { return registrations },
  })
  const t0 = Date.now()
  fake.create({ sessionId: 'session-ws-a1', title: 'alpha one', cwd: '/home/dev/alpha', updatedAt: t0 + 30 })
  fake.create({ sessionId: 'session-ws-a2', title: 'alpha two', cwd: '/home/dev/alpha', updatedAt: t0 + 20 })
  fake.create({ sessionId: 'session-ws-b1', title: 'beta one', cwd: '/home/dev/beta', updatedAt: t0 + 10 })
  fake.create({ sessionId: 'session-ws-orphan', title: 'no cwd', cwd: '', updatedAt: t0 })

  const grouped = await sessionGroups({ ctx, store })
  const alpha = grouped.workspaces.find(group => group.workspaceId === 'w-alpha')
  const beta = grouped.workspaces.find(group => group.workspaceId === pathKey('/home/dev/beta'))
  const empty = grouped.workspaces.find(group => group.workspaceId === 'w-empty')
  const ungrouped = grouped.workspaces.find(group => group.workspaceId === 'ungrouped')
  check('registry group carries its title', alpha?.title === 'Alpha Project', JSON.stringify(alpha?.title))
  check('registry group holds both registered sessions', alpha?.sessions.length === 2, String(alpha?.sessions.length))
  check('cwd synthesizes a group for unregistered sessions', beta?.sessions.length === 1, JSON.stringify(beta))
  check('empty workspace is still listed', empty !== undefined && empty.sessions.length === 0, JSON.stringify(empty))
  check('no-cwd session lands in ungrouped', ungrouped?.sessions.length === 1, JSON.stringify(ungrouped))
  check('ungrouped is last', grouped.workspaces.at(-1)?.workspaceId === 'ungrouped', JSON.stringify(grouped.workspaces.map(group => group.workspaceId)))
  check('flat sessions view still present', Array.isArray(grouped.sessions) && grouped.sessions.length >= 4, String(grouped.sessions.length))
  check('grouped session shape has effective shared flag', alpha.sessions.every(session => typeof session.shared === 'boolean'))
  check('grouped session shape is lossless JSON', undefinedPaths(grouped).length === 0, JSON.stringify(undefinedPaths(grouped)))

  const stateBefore = await uiCall('state')
  check('panel state exposes workspaces', Array.isArray(stateBefore.workspaces) && stateBefore.workspaces.length >= 4, JSON.stringify(stateBefore.workspaces?.length))
  check('panel state keeps the flat legacy sessions', Array.isArray(stateBefore.sessions))

  // A human share must survive a rule being turned off.
  await store.setShared('session-ws-a2', true)

  const badWorkspace = await uiCall('shareWorkspace', { workspaceId: 'does-not-exist', shared: true })
  equal('unknown workspace refused', badWorkspace.ok, false)
  equal('unknown workspace error code', badWorkspace.error.code, 'bridge/bad-request')
  const missingId = await uiCall('shareWorkspace', { shared: true })
  equal('missing workspaceId refused', missingId.ok, false)

  const sharedAll = await uiCall('shareWorkspace', { workspaceId: 'w-alpha', shared: true })
  equal('whole-workspace share accepted', sharedAll.ok, true)
  const stateShared = await uiCall('state')
  const alphaShared = stateShared.workspaces.find(group => group.workspaceId === 'w-alpha')
  check('group reads back as shared', alphaShared?.shared === true, JSON.stringify(alphaShared?.shared))
  check('every session under the rule is effectively shared', alphaShared.sessions.every(session => session.shared === true), JSON.stringify(alphaShared.sessions))
  const liveUrl = `http://127.0.0.1:${String(server.status.port)}`
  const liveRpc = async (method, params) => {
    const response = await fetch(`${liveUrl}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-bridge': '1', authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: 'it', method, params }),
    })
    return response.json()
  }
  const listed = await liveRpc('session.list', {})
  const listedIds = listed.result.sessions.map(session => session.sessionId)
  check('rule materialized shares for session.list', listedIds.includes('session-ws-a1') && listedIds.includes('session-ws-a2'), JSON.stringify(listedIds))
  check('sessions outside the rule stay hidden', !listedIds.includes('session-ws-b1'), JSON.stringify(listedIds))
  const auto = await store.autoShares()
  equal('human-shared session was not adopted by the rule', auto['session-ws-a2'], undefined)
  equal('rule owns the other session', auto['session-ws-a1'], 'w-alpha')

  // A new Session announced by the Host joins the rule immediately. (it-local
  // wires the components directly, so it exercises the listener's handler
  // function rather than index.js's subscription.)
  fake.create({ sessionId: 'session-ws-a3', title: 'alpha three', cwd: '/home/dev/alpha' })
  await applyRulesToSession({ store, sessionId: 'session-ws-a3', cwd: '/home/dev/alpha' })
  equal('new Session joins the workspace rule', await store.isShared('session-ws-a3'), true)
  equal('repeat rule application is idempotent', await applyRulesToSession({ store, sessionId: 'session-ws-a3', cwd: '/home/dev/alpha' }), false)
  const beforeChurn = (await readFile(join(stateDir, 'bridge.json'), 'utf8'))
  await applyRulesToSession({ store, sessionId: 'session-ws-a3', cwd: '/home/dev/alpha' })
  equal('idempotent rule application does not rewrite bridge.json', await readFile(join(stateDir, 'bridge.json'), 'utf8'), beforeChurn)

  const off = await uiCall('shareWorkspace', { workspaceId: 'w-alpha', shared: false })
  equal('whole-workspace unshare accepted', off.ok, true)
  check('human-shared session survives rule off', await store.isShared('session-ws-a2'), true)
  equal('rule-owned session is revoked on rule off', await store.isShared('session-ws-a1'), false)
  equal('auto-owned new session is revoked on rule off', await store.isShared('session-ws-a3'), false)
  const autoOff = await store.autoShares()
  equal('autoShares cleared on rule off', Object.keys(autoOff).length, 0)

  // Startup reconciliation is idempotent and never adopts a human decision.
  await store.setWorkspaceShared({ workspaceId: 'w-alpha', path: '/home/dev/alpha', shared: true })
  const first = await materializeWorkspaceShares({ ctx, store })
  check('startup reconcile reports rule-owned sessions', first.sessions >= 2, JSON.stringify(first))
  const second = await materializeWorkspaceShares({ ctx, store })
  equal('startup reconcile is idempotent', second.sessions, first.sessions)
  check('startup reconcile keeps the human share', await store.isShared('session-ws-a2'), true)
  equal('startup reconcile did not adopt the human share', (await store.autoShares())['session-ws-a2'], undefined)

  // A cwd-based rule groups Sessions on a Host without the registry, too.
  await store.setWorkspaceShared({ workspaceId: 'w-beta-rule', path: '/home/dev/beta', shared: true })
  ctx.provide('workspaceRegistry', undefined)
  const noRegistry = await sessionGroups({ ctx, store })
  const betaRule = noRegistry.workspaces.find(group => group.workspaceId === 'w-beta-rule')
  check('cwd rule groups sessions without a registry', betaRule?.sessions.length === 1, JSON.stringify(betaRule))
  check('cwd rule reports shared without a registry', betaRule?.shared === true, JSON.stringify(betaRule?.shared))
  ctx.provide('workspaceRegistry', { list() { return registrations } })

  // Cleanup so later sections (audit) see a tidy store.
  await store.setWorkspaceShared({ workspaceId: 'w-alpha', path: '/home/dev/alpha', shared: false })
  await store.setWorkspaceShared({ workspaceId: 'w-beta-rule', path: '/home/dev/beta', shared: false })
  await materializeWorkspaceShares({ ctx, store })
  await store.setShared('session-ws-a2', false)
}

// --- files ---------------------------------------------------------------
{
  steps.push('')
  steps.push('files')
  const filesUrl = `http://127.0.0.1:${String(server.status.port)}`
  const filesToken = (await store.pair({ name: 'files-peer', capabilities: ['read', 'prompt', 'files'] })).token
  const readerToken = (await store.pair({ name: 'files-reader', capabilities: ['read'] })).token
  const filesRpc = async (method, params, token = filesToken) => {
    const response = await fetch(`${filesUrl}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-bridge': '1', authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: 'it', method, params }),
    })
    return response.json()
  }
  const filesOk = async (method, params, token) => {
    const body = await filesRpc(method, params, token)
    if (body.ok !== true) throw new Error(`${method} failed: ${JSON.stringify(body.error)}`)
    return body.result
  }
  const filesFail = async (method, params, code, token) => {
    const body = await filesRpc(method, params, token)
    equal(`${method} refused`, body.ok, false)
    equal(`${method} error code`, body.error?.code, code)
    return body.error
  }

  // roots: names and writability only. A local absolute path must never cross.
  const viewerRoots = await filesOk('files.roots', {}, readerToken)
  equal('roots readable with only the read bit', viewerRoots.roots.map(root => root.name).join(','), 'drop,readonly')
  const rootsJson = JSON.stringify(viewerRoots)
  check('roots never leak a local path', !rootsJson.includes(filesRoot) && !rootsJson.includes(outsideRoot), rootsJson.slice(0, 160))
  equal('root writability is reported', viewerRoots.roots.find(root => root.name === 'drop').writable, true)

  // stat / list on the happy path.
  const hello = await filesOk('files.stat', { root: 'drop', path: 'docs/hello.txt', digest: true })
  equal('stat reports the size', hello.size, Buffer.byteLength('hello from the harness\n'))
  equal('stat reports a digest', /^[0-9a-f]{64}$/.test(String(hello.sha256)), true)
  const listing = await filesOk('files.list', { root: 'drop', path: 'docs' })
  equal('list names the entry', listing.entries.map(entry => entry.name).join(','), 'hello.txt')
  equal('list marks a file as a file', listing.entries[0].isDirectory, false)

  // Path discipline: every one of these must be refused before the disk is touched.
  // A malformed path is bridge/bad-request — it is the caller's request that is
  // wrong, and the remedy is not "go grant more capability".
  await filesFail('files.stat', { root: 'drop', path: '../outside.txt' }, 'bridge/bad-request')
  await filesFail('files.stat', { root: 'drop', path: '/etc/passwd' }, 'bridge/bad-request')
  await filesFail('files.stat', { root: 'drop', path: 'C:/Windows/win.ini' }, 'bridge/bad-request')
  await filesFail('files.stat', { root: 'drop', path: 'docs\\hello.txt' }, 'bridge/bad-request')
  await filesFail('files.stat', { root: 'drop', path: 'nul' }, 'bridge/bad-request')
  await filesFail('files.stat', { root: 'drop', path: 'docs/hello.txt.' }, 'bridge/bad-request')
  await filesFail('files.stat', { root: 'drop', path: 'docs/CON.txt' }, 'bridge/bad-request')
  await filesFail('files.stat', { root: 'nope', path: 'x.txt' }, 'bridge/not-found')
  // A symlink that points outside the root resolves outside it, so it is refused
  // even though its own name looks innocent.
  await filesFail('files.stat', { root: 'drop', path: 'escape.txt' }, 'bridge/forbidden')

  // Capability gating: read alone cannot touch files at all.
  await filesFail('files.stat', { root: 'drop', path: 'docs/hello.txt' }, 'bridge/forbidden', readerToken)
  await filesFail('files.read', { root: 'drop', path: 'docs/hello.txt', offset: 0, length: 8 }, 'bridge/forbidden', readerToken)

  // read: chunks with an eof marker, base64 on the wire.
  const first = await filesOk('files.read', { root: 'drop', path: 'docs/hello.txt', offset: 0, length: 5 })
  equal('read returns the requested slice', Buffer.from(first.data, 'base64').toString(), 'hello')
  equal('read says it is not the end yet', first.eof, false)
  const last = await filesOk('files.read', { root: 'drop', path: 'docs/hello.txt', offset: 6, length: 4096 })
  equal('read the rest', Buffer.from(last.data, 'base64').toString(), 'from the harness\n')
  equal('read reports eof at the end', last.eof, true)

  // Upload: fail fast on the things that would waste a transfer.
  const source = Buffer.alloc(3 * 1024 * 1024)
  for (let index = 0; index < source.length; index += 1) source[index] = index % 251
  const sourceDigest = createHash('sha256').update(source).digest('hex')
  const tooBig = await filesRpc('files.begin', { root: 'drop', path: 'docs/big.bin', size: cfg.files.maxFileBytes + 1, sha256: sourceDigest })
  equal('oversized upload refused', tooBig.error?.code, 'bridge/bad-request')
  const badDigest = await filesRpc('files.begin', { root: 'drop', path: 'docs/big.bin', size: 3, sha256: 'nope' })
  equal('bad digest refused', badDigest.error?.code, 'bridge/bad-request')
  const readOnlyRoot = await filesRpc('files.begin', { root: 'readonly', path: 'x.txt', size: 3, sha256: sourceDigest })
  equal('write into a read-only root refused', readOnlyRoot.error?.code, 'bridge/forbidden')
  const clash = await filesRpc('files.begin', { root: 'drop', path: 'docs/hello.txt', size: 3, sha256: sourceDigest })
  equal('existing target without overwrite refused', clash.error?.code, 'bridge/conflict')

  const upload = await filesOk('files.begin', { root: 'drop', path: 'docs/uploaded.bin', size: source.length, sha256: sourceDigest })
  check('begin returns an upload id', typeof upload.uploadId === 'string', String(upload.uploadId))
  equal('begin reports the chunk size', upload.chunkBytes, cfg.files.chunkBytes)
  const outOfOrder = await filesRpc('files.chunk', { uploadId: upload.uploadId, index: 3, data: 'AAAA' })
  equal('out-of-order chunk refused', outOfOrder.error?.code, 'bridge/bad-request')
  let offset = 0
  let chunkIndex = 0
  while (offset < source.length) {
    const slice = source.subarray(offset, Math.min(offset + upload.chunkBytes, source.length))
    const sent = await filesOk('files.chunk', { uploadId: upload.uploadId, index: chunkIndex, data: slice.toString('base64') })
    offset += slice.length
    chunkIndex += 1
    if (offset >= source.length) equal('chunk reports the running total', sent.received, source.length)
  }
  const committed = await filesOk('files.commit', { uploadId: upload.uploadId })
  equal('commit returns the digest it verified', committed.sha256, sourceDigest)
  const stored = await filesOk('files.stat', { root: 'drop', path: 'docs/uploaded.bin', digest: true })
  equal('stored file has the source digest', stored.sha256, sourceDigest)
  equal('stored file has the source size', stored.size, source.length)

  // abort: nothing is left behind, and the staging area goes quiet.
  const aborted = await filesOk('files.begin', { root: 'drop', path: 'docs/aborted.bin', size: 10, sha256: sourceDigest })
  await filesOk('files.abort', { uploadId: aborted.uploadId })
  equal('abort drops the upload', api.files.pending(), 0)
  const staging = await readdir(join(stateDir, 'staging'))
  equal('abort removed the staged file', staging.filter(name => name.endsWith('.part')).length, 0)
  const afterAbort = await filesRpc('files.chunk', { uploadId: aborted.uploadId, index: 0, data: 'AAAA' }, filesToken)
  equal('a late chunk after abort is refused', afterAbort.error?.code, 'bridge/not-found')

  // TTL cleanup: a crash leaves *.part files; the next start sweeps them.
  await mkdir(join(stateDir, 'staging'), { recursive: true })
  const stale = join(stateDir, 'staging', 'stale.part')
  await writeFile(stale, 'x')
  const longAgo = new Date(Date.now() - cfg.files.stagingTtlMs - 60_000)
  await utimes(stale, longAgo, longAgo)
  await api.files.cleanup()
  const swept = await readdir(join(stateDir, 'staging')).catch(() => [])
  check('cleanup swept the stale staging file', !swept.includes('stale.part'), JSON.stringify(swept))

  // Tools: push, probe and pull through the real outbound client.
  const localDir = await mkdtemp(join(tmpdir(), 'lan-bridge-local-'))
  const textPath = join(localDir, 'note.txt')
  await writeFile(textPath, 'pushed through the tool\n')
  const binPath = join(localDir, 'blob.bin')
  await writeFile(binPath, source)
  await store.addOutbound({ name: 'self-files', url: filesUrl, token: filesToken })
  const execTool = async (name, args) => tools.get(name).execute(args, { signal: undefined })
  const toolRoots = await execTool('lan_dsh_files', { peer: 'self-files', action: 'roots' })
  equal('tool lists root names', toolRoots.roots.map(root => root.name).join(','), 'drop,readonly')
  check('tool roots stay path-free', !JSON.stringify(toolRoots).includes(filesRoot), JSON.stringify(toolRoots).slice(0, 160))
  const pushedText = await execTool('lan_dsh_push_file', { peer: 'self-files', localPath: textPath, root: 'drop', remotePath: 'docs/note.txt' })
  equal('tool push reports bytes', pushedText.bytes, Buffer.byteLength('pushed through the tool\n'))
  const pushedBin = await execTool('lan_dsh_push_file', { peer: 'self-files', localPath: binPath, root: 'drop', remotePath: 'docs/blob.bin' })
  equal('tool push of a 3 MiB binary matches the digest', pushedBin.sha256, sourceDigest)
  const pullPath = join(localDir, 'pulled.bin')
  const pulled = await execTool('lan_dsh_pull_file', { peer: 'self-files', root: 'drop', remotePath: 'docs/blob.bin', localPath: pullPath })
  equal('tool pull reports the digest', pulled.sha256, sourceDigest)
  const pulledBytes = await readFile(pullPath)
  equal('pulled bytes match byte for byte', pulledBytes.equals(source), true)
  const pullAgain = await execTool('lan_dsh_pull_file', { peer: 'self-files', root: 'drop', remotePath: 'docs/blob.bin', localPath: pullPath }).then(() => undefined, error => error)
  check('pull without overwrite refuses an existing local file', pullAgain instanceof Error && String(pullAgain.message).includes('already exists'), String(pullAgain))
  const listedTool = await execTool('lan_dsh_files', { peer: 'self-files', action: 'list', root: 'drop', path: 'docs' })
  check('tool list sees the pushed file', listedTool.entries.some(entry => entry.name === 'note.txt'), JSON.stringify(listedTool.entries.map(entry => entry.name)))
  const statTool = await execTool('lan_dsh_files', { peer: 'self-files', action: 'stat', root: 'drop', path: 'docs/note.txt' })
  equal('tool stat reports the size', statTool.entry.size, Buffer.byteLength('pushed through the tool\n'))
  // A read-only root is not a capability problem, so the tool must not send the
  // caller off to grant `files` — the peer reported that confusion in the field.
  const readOnlyPush = await execTool('lan_dsh_push_file', { peer: 'self-files', localPath: textPath, root: 'readonly', remotePath: 'nope.txt' }).then(() => undefined, error => error)
  check('read-only root says so', readOnlyPush instanceof Error && /read-only/.test(String(readOnlyPush.message)), String(readOnlyPush))
  check('read-only root does not advertise a grant',
    readOnlyPush instanceof Error && !String(readOnlyPush.message).includes('action=grant'), String(readOnlyPush))
  // A bad path is the caller's mistake too: still no grant advice.
  const pathPush = await execTool('lan_dsh_push_file', { peer: 'self-files', localPath: textPath, root: 'drop', remotePath: '../escape.txt' }).then(() => undefined, error => error)
  check('bad path is a bad request', pathPush instanceof Error && pathPush.code === 'bridge/bad-request', String(pathPush?.code))
  check('bad path does not advertise a grant',
    pathPush instanceof Error && !String(pathPush.message).includes('action=grant'), String(pathPush))
  // A real capability refusal keeps the hint, because that one is actionable.
  const weakToken = (await store.pair({ name: 'files-weak', capabilities: ['read', 'prompt'] })).token
  await store.addOutbound({ name: 'self-weak', url: filesUrl, token: weakToken })
  const forbiddenPush = await execTool('lan_dsh_push_file', { peer: 'self-weak', localPath: textPath, root: 'drop', remotePath: 'docs/denied.txt' }).then(() => undefined, error => error)
  check('missing files capability is forbidden', forbiddenPush instanceof Error && forbiddenPush.code === 'bridge/forbidden', String(forbiddenPush?.code))
  check('missing files capability explains the grant',
    forbiddenPush instanceof Error && String(forbiddenPush.message).includes('action=grant'), String(forbiddenPush))
  await store.removeOutbound('self-weak')
  await store.revoke('files-weak')
  await store.removeOutbound('self-files')
  await store.revoke('files-peer')
  await store.revoke('files-reader')
  await rm(localDir, { recursive: true, force: true })
}

// --- audit ---------------------------------------------------------------
{
  steps.push('')
  steps.push('audit')
  const text = await readFile(join(stateDir, 'audit.jsonl'), 'utf8')
  const lines = text.trim().split('\n').filter(line => line !== '').map(line => JSON.parse(line))
  check('audit recorded calls', lines.length > 5, `${String(lines.length)} lines`)
  check('audit names the peer', lines.some(line => line.peer === 'it-peer'))
  check('audit records the method', lines.some(line => line.method === 'session.prompt'))
  check('audit records failures', lines.some(line => line.ok === false))
}

await ctx.dispose()
await server.stop()
await rm(stateDir, { recursive: true, force: true })
await rm(filesRoot, { recursive: true, force: true })
await rm(outsideRoot, { recursive: true, force: true })

console.log(steps.join('\n'))
console.log('')
console.log(`${String(passes)} passed, ${String(failures)} failed`)
process.exit(failures === 0 ? 0 : 1)
