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
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

  function create({ sessionId, title, running = false, records = [] }) {
    const session = {
      summary: {
        sessionId,
        agentAvailable: true,
        updatedAt: Date.now(),
        running,
        blank: records.length === 0,
        cwd: '/tmp',
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

const cfg = resolveConfig({
  role: 'both',
  name: 'it-machine',
  listen: { host: '127.0.0.1', port: 0 },
  insecureHttp: true,
  allowPeersToCreateSessions: false,
  rateLimitPerMinute: 600,
  audit: true,
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
const applySettings = createSettingsApplier({ cfg, store, server, logger: ctx.logger, ready: Promise.resolve() })
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
  equal('eleven tools registered', tools.size, 11)
  for (const name of ['lan_dsh_peers', 'lan_dsh_share', 'lan_dsh_sessions', 'lan_dsh_transcript', 'lan_dsh_prompt', 'lan_dsh_wait', 'lan_dsh_cancel', 'lan_dsh_archive', 'lan_dsh_board', 'lan_dsh_task', 'lan_dsh_goal']) {
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
  const allCaps = ['read', 'prompt', 'control', 'create', 'archive', 'collab']
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
  const broken = await uiCall('settings', { port: 1 })
  equal('unbindable port refused', broken.ok, false)
  equal('unbindable port error code', broken.error.code, 'bridge/internal')
  equal('listener survived the failed rebind', server.status.listening, true)
  equal('listener kept its port', server.status.port, port)

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
  const allCaps = ['read', 'prompt', 'control', 'create', 'archive', 'collab']
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

console.log(steps.join('\n'))
console.log('')
console.log(`${String(passes)} passed, ${String(failures)} failed`)
process.exit(failures === 0 ? 0 : 1)
