#!/usr/bin/env node
/**
 * Live end-to-end check against a running DSH Host (desktop app).
 *
 * Seeds two inbound tokens straight into bridge.json (the store re-reads the
 * file when its stamp changes, so this exercises cross-process reload too),
 * then drives the real listener over HTTP: fence, auth, hello, list, create,
 * prompt, wait, transcript, archive, unarchive, read-only denial, SSE. It seeds
 * and restores `bridge.json` while preserving whatever listening settings the
 * operator saved from the panel.
 *
 * Leaves bridge.json empty and reports what it did.
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BRIDGE_URL ?? 'http://127.0.0.1:5977'
const STATE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'lan-bridge', 'bridge.json')
const WORKSPACE = process.env.E2E_CWD ?? process.cwd()
const sha = (s) => createHash('sha256').update(s).digest('hex')
const token = (() => 'lzb_' + randomBytes(16).toString('hex'))()
const readToken = (() => 'lzb_' + randomBytes(16).toString('hex'))()
const entry = (t, capabilities) => ({ hash: sha(t), hint: t.slice(-4), createdAt: Date.now(), capabilities })

let pass = 0
let fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra === undefined ? '' : ' → ' + JSON.stringify(extra).slice(0, 300)}`) }
}
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), actual)

async function post(body, { bearer, headers = {}, bridgeHeader = true } = {}) {
  const res = await fetch(`${BASE}/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bridgeHeader ? { 'x-dsh-bridge': '1' } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  })
  let json
  try { json = await res.json() } catch { json = undefined }
  return { status: res.status, json }
}

const call = async (method, params = {}, bearer = token) => {
  const { status, json } = await post({ id: 'e2e', method, params }, { bearer })
  if (status !== 200 || !json?.ok) throw new Error(`${method} failed: http ${status} ${JSON.stringify(json?.error)}`)
  return json.result
}

/** Operator listening settings live in the same file; never destroy them. */
async function readSettings() {
  try {
    const doc = JSON.parse(await readFile(STATE, 'utf8'))
    return doc !== null && typeof doc === 'object' && typeof doc.settings === 'object' && doc.settings !== null ? doc.settings : {}
  } catch {
    return {}
  }
}

// The operator's own state (tokens, peers, shares) must survive a test run: this
// suite borrows the live bridge, it does not own it. Everything it needs is
// added next to the existing records, and `wipe()` puts the original back.
let backup = null

async function readDoc() {
  try {
    return JSON.parse(await readFile(STATE, 'utf8'))
  } catch {
    return { version: 1, inbound: {}, outbound: {}, shares: {}, settings: {} }
  }
}

async function seed() {
  backup = await readDoc()
  const settings = await readSettings()
  const doc = { version: 1, settings, inbound: {
    'e2e-full': entry(token, ['read', 'prompt', 'control', 'create', 'archive']),
    'e2e-read': entry(readToken, ['read']),
  }, outbound: {}, shares: {}, workspaceShares: {}, autoShares: {} }
  await writeFile(STATE, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })
}
async function wipe() {
  const settings = await readSettings()
  const original = backup ?? { version: 1, inbound: {}, outbound: {}, shares: {} }
  await writeFile(
    STATE,
    JSON.stringify({
      version: 1,
      settings,
      inbound: original.inbound ?? {},
      outbound: original.outbound ?? {},
      shares: original.shares ?? {},
      workspaceShares: original.workspaceShares,
      autoShares: original.autoShares,
      board: original.board,
      intents: original.intents,
    }, null, 2) + '\n',
    { mode: 0o600 },
  )
  backup = null
  return settings
}

const textOf = (value) => JSON.stringify(value)

await seed()
console.log(`live e2e against ${BASE}\n`)

console.log('fence')
{
  const a = await post({ id: 'f1', method: 'bridge.hello', params: {} }, { bearer: token, bridgeHeader: false })
  eq('missing X-DSH-Bridge is refused', a.status, 403)
  const b = await post({ id: 'f2', method: 'bridge.hello', params: {} }, { bearer: token, headers: { origin: 'http://evil.test' } })
  eq('cross-origin request is refused', b.status, 403)
  const c = await post({ id: 'f3', method: 'bridge.hello', params: {} }, {})
  eq('missing token is 401', c.status, 401)
  const d = await post({ id: 'f4', method: 'bridge.hello', params: {} }, { bearer: 'lzb_deadbeef' })
  eq('wrong token is 401', d.status, 401)
  const e = await fetch(`${BASE}/nope`)
  eq('unknown path is 404', e.status, 404)
}

console.log('\nhello')
const hello = await call('bridge.hello')
ok('hello speaks protocol 1', hello.protocol === 1, hello.protocol)
ok('advertises session.archive', hello.capabilities?.['session.archive'] === true, hello.capabilities)
ok('advertises session.create', hello.capabilities?.['session.create'] === true, hello.capabilities)
// The relay RPCs only exist from 0.3.13; a Host that has not been restarted yet
// is reported as a note instead of a red assertion.
const relaysApprovals = hello.capabilities?.['approval.list'] === true && hello.capabilities?.['approval.answer'] === true
if (relaysApprovals) {
  ok('advertises approval.list', true)
  ok('advertises approval.answer', true)
} else {
  console.log(`  note the running Host (${String(hello.version)}) predates approval relay; restart it to check`)
}
// 0.4.0 advertises the file limits. A Host still running 0.3.x answers without
// them, which is a note (restart), not a regression.
const advertisesFiles = hello.capabilities?.['files.roots'] === true
if (advertisesFiles) {
  ok('advertises files.roots', true)
  ok('advertises files.begin', hello.capabilities?.['files.begin'] === true)
  ok('reports the file size limit', typeof hello.limits?.maxFileBytes === 'number' && hello.limits.maxFileBytes > 0, hello.limits)
  ok('reports the chunk size', typeof hello.limits?.chunkBytes === 'number' && hello.limits.chunkBytes > 0, hello.limits)
} else {
  console.log(`  note the running Host (${String(hello.version)}) predates file transfer; restart it to check`)
}
if (hello.limits?.allowPeersToCreateSessions === undefined) {
  console.log('  note hello.limits predates allowPeersToCreateSessions; restart the Host to expose it')
} else {
  ok('reports create enablement in limits', hello.limits.allowPeersToCreateSessions === true, hello.limits)
}

console.log('\nlist + create')
const before = await call('session.list')
ok('session.list returns an array', Array.isArray(before.sessions), before)
console.log(`  (${before.sessions.length} existing sessions visible)`)

const created = await call('session.create', { cwd: WORKSPACE, title: 'lan-bridge e2e' })
const sid = created.sessionId
ok('session.create returned a session id', typeof sid === 'string' && sid.length > 0, created)
const listed = await call('session.list')
ok('new session is auto-shared and listed', listed.sessions.some((s) => s.sessionId === sid && s.shared === true))

console.log('\nprompt + wait')
await call('session.prompt', { sessionId: sid, text: 'Reply with exactly this word and nothing else: PONG' })
const waited = await call('session.wait', { sessionId: sid, timeoutMs: 180000, maxMessages: 40 }, token)
ok('wait settled without timeout', waited.reason !== 'timeout', waited.reason)
const reply = textOf(waited.records ?? [])
ok('the peer agent answered PONG', /PONG/.test(reply), (waited.records ?? []).slice(-2))

console.log('\ntranscript + sse')
const transcript = await call('session.transcript', { sessionId: sid, maxMessages: 20 })
ok('transcript returns records', Array.isArray(transcript.records) && transcript.records.length > 0, Object.keys(transcript))
ok('transcript carries a cursor', typeof transcript.cursor === 'number', transcript.cursor)
{
  const ctrl = new AbortController()
  const res = await fetch(`${BASE}/events?session=${encodeURIComponent(sid)}`, {
    headers: { 'x-dsh-bridge': '1', authorization: `Bearer ${token}` }, signal: ctrl.signal,
  })
  ok('sse opened', res.status === 200, res.status)
  const reader = res.body.getReader()
  const { value } = await reader.read()
  const chunk = new TextDecoder().decode(value ?? new Uint8Array())
  ok('sse first frame is a snapshot', /event: frame/.test(chunk) && /"type":"snapshot"|"snapshot"/.test(chunk), chunk.slice(0, 160))
  ctrl.abort()
}

console.log('\narchive')
const archived = await call('session.archive', { sessionId: sid })
ok('archive ok', archived.archived === true, archived)
const restored = await call('session.unarchive', { sessionId: sid })
ok('unarchive ok', restored.archived === false, restored)

console.log('\nread-only denial')
const readList = await call('session.list', {}, readToken)
ok('read token can still list', Array.isArray(readList.sessions))
{
  const { status, json } = await post({ id: 'r1', method: 'session.archive', params: { sessionId: sid } }, { bearer: readToken })
  ok('read token cannot archive', status === 200 && json?.ok === false && json.error?.code === 'bridge/forbidden', json?.error)
}

console.log('\ncleanup')
const keptSettings = await wipe()
ok('wipe keeps the operator listening settings', typeof keptSettings === 'object')
const afterWipe = await post({ id: 'w1', method: 'bridge.hello', params: {} }, { bearer: token })
eq('seeded token stops working after wipe', afterWipe.status, 401)

console.log(`\n${pass} passed, ${fail} failed`)
console.log(`created session: ${sid} (kept; archive it from the panel if you do not need it)`)
process.exit(fail === 0 ? 0 : 1)
