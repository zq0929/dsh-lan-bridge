/**
 * Panel smoke harness for dsh-lan-bridge/client.js.
 *
 * No React is installed here, so this file implements the small
 * subset of React the panel uses (function components, class components,
 * Fragment, useState/useRef/useCallback/useEffect) as a single-pass renderer
 * with a path-keyed hook store and a dirty-loop. That is enough to render the
 * real panel, click the real handlers and assert on the produced host tree.
 */

import fs from 'node:fs'
import path from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const SRC = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')

// ---------------------------------------------------------------- mini react

const FRAGMENT = Symbol('fragment')

function createElement(type, props, ...children) {
  const merged = props === null || props === undefined ? {} : props
  // React puts children on props as well; the panel's boundary reads
  // this.props.children, so the harness has to do the same.
  if (children.length === 1) merged.children = children[0]
  else if (children.length > 1) merged.children = children
  const kids = children.length > 0 ? children : (merged.children === undefined ? [] : [].concat(merged.children))
  return { type, props: merged, children: kids }
}

class Component {
  constructor(props) {
    this.props = props
    this.state = {}
  }
}

const hookStore = new Map()
const hookStack = []
let dirty = false
let rendered = null
const effects = []

function currentKey() {
  const top = hookStack[hookStack.length - 1]
  if (top === undefined) throw new Error('hook outside a component')
  const key = `${top.path}#${top.i}`
  top.i += 1
  return key
}

function sameDeps(a, b) {
  if (a === undefined || b === undefined) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false
  return true
}

function useState(initial) {
  const key = currentKey()
  const slot = hookStore.get(key)
  if (slot === undefined) {
    hookStore.set(key, { value: typeof initial === 'function' ? initial() : initial })
  }
  const entry = hookStore.get(key)
  const set = (next) => {
    const resolved = typeof next === 'function' ? next(entry.value) : next
    if (Object.is(resolved, entry.value)) return
    entry.value = resolved
    dirty = true
  }
  return [entry.value, set]
}

function useRef(initial) {
  const key = currentKey()
  if (!hookStore.has(key)) hookStore.set(key, { value: { current: initial } })
  return hookStore.get(key).value
}

function useCallback(fn, deps) {
  const key = currentKey()
  const slot = hookStore.get(key)
  if (slot === undefined || !sameDeps(slot.deps, deps)) {
    hookStore.set(key, { value: fn, deps })
  }
  return hookStore.get(key).value
}

function useEffect(fn, deps) {
  const key = currentKey()
  const slot = hookStore.get(key)
  const changed = slot === undefined || !sameDeps(slot.deps, deps)
  if (!changed) return
  effects.push({ key, fn, deps })
}

const React = { createElement, Fragment: FRAGMENT, Component, useState, useRef, useCallback, useEffect }

// -------------------------------------------------------------- mini renderer

function isClass(type) {
  return typeof type === 'function' && type.prototype instanceof Component
}

const instances = new Map()

function renderInto(node, nodePath, out) {
  if (node === null || node === undefined || node === false || node === true) return
  if (typeof node === 'string' || typeof node === 'number') {
    out.push({ type: '#text', text: String(node), props: {}, children: [] })
    return
  }
  if (Array.isArray(node)) {
    node.forEach((child, index) => renderInto(child, `${nodePath}.${index}`, out))
    return
  }
  const { type, props, children } = node
  if (type === FRAGMENT) {
    const holder = []
    children.forEach((child, index) => renderInto(child, `${nodePath}.f${index}`, holder))
    out.push(...holder)
    return
  }
  if (typeof type === 'string') {
    const el = { type, text: null, props: props ?? {}, children: [] }
    out.push(el)
    const kids = children.length > 0 ? children : (props && props.children !== undefined ? [].concat(props.children) : [])
    kids.forEach((child, index) => renderInto(child, `${nodePath}.${index}`, el.children))
    return
  }
  if (isClass(type)) {
    const key = `${nodePath}.${type.name}`
    let instance = instances.get(key)
    if (instance === undefined) {
      instance = new type(props ?? {})
      instances.set(key, instance)
    } else {
      instance.props = props ?? {}
    }
    renderInto(instance.render(), `${key}.r`, out)
    return
  }
  if (typeof type === 'function') {
    const key = `${nodePath}.${type.name || 'anon'}`
    hookStack.push({ path: key, i: 0 })
    let result
    try {
      result = type(props ?? {})
    } finally {
      hookStack.pop()
    }
    renderInto(result, `${key}.r`, out)
    return
  }
  throw new Error(`unrenderable node type: ${String(type)}`)
}

function renderRoot(element) {
  const out = []
  renderInto(element, 'root', out)
  return out
}

function runEffects() {
  const pending = effects.splice(0, effects.length)
  for (const item of pending) {
    const slot = hookStore.get(item.key)
    if (slot !== undefined && typeof slot.cleanup === 'function') slot.cleanup()
    const cleanup = item.fn()
    const stored = hookStore.get(item.key) ?? {}
    stored.value = item.fn
    stored.deps = item.deps
    stored.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    hookStore.set(item.key, stored)
  }
}

/** Render until no state change and no effect is left, then let promises land. */
async function settle(rounds = 12) {
  for (let round = 0; round < rounds; round += 1) {
    dirty = false
    rendered = renderRoot(currentElement)
    runEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!dirty) {
      // One more pass so effects queued by the last state change run too.
      rendered = renderRoot(currentElement)
      runEffects()
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (!dirty) return
    }
  }
  throw new Error('renderer did not settle')
}

// ---------------------------------------------------------------- test utils

function walk(nodes, visit) {
  for (const node of nodes) {
    visit(node)
    if (node.children.length > 0) walk(node.children, visit)
  }
}

function textOf(nodes) {
  const parts = []
  walk(nodes, (node) => {
    if (node.type === '#text') parts.push(node.text)
  })
  return parts.join('')
}

function findAll(nodes, predicate) {
  const found = []
  walk(nodes, (node) => {
    if (node.type !== '#text' && predicate(node)) found.push(node)
  })
  return found
}

function byClass(nodes, className) {
  return findAll(nodes, (node) => (node.props.className ?? '').split(/\s+/).includes(className))
}

function byText(nodes, text) {
  const found = []
  walk(nodes, (node) => {
    if (node.type === '#text' && node.text.trim() === text) found.push(node)
  })
  return found
}

/** The nearest host node that carries an onClick and whose text contains `label`. */
function clickable(nodes, label) {
  const hosts = findAll(nodes, (node) => typeof node.props.onClick === 'function')
  for (const host of hosts) {
    if (textOf([host]).includes(label)) return host
  }
  return null
}

/** Only the per-session sharing switches; the panel renders other switches too. */
function sharingSwitches(nodes) {
  return findAll(nodes, (node) => (node.props.className ?? '').split(/\s+/).includes('dslb-switch')
    && node.props['aria-label'] === '共享给对等端')
}

/** The workspace-level switches; the per-session ones keep their own label. */
function wsSwitches(nodes) {
  return findAll(nodes, (node) => (node.props.className ?? '').split(/\s+/).includes('dslb-switch')
    && node.props['aria-label'] === '共享整个工作区')
}

/** The chevron/expand buttons, one per rendered workspace group. */
function wsToggles(nodes) {
  return findAll(nodes, (node) => (node.props.className ?? '').split(/\s+/).includes('dslb-wsToggle'))
}

/** Workspaces start collapsed, so most session assertions expand the first one. */
async function expandFirstWorkspace() {
  const toggle = wsToggles(rendered)[0]
  assert(toggle !== undefined, 'expand: a workspace toggle is rendered')
  toggle.props.onClick()
  await settle()
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`)
}

// ------------------------------------------------------------------ environment

const calls = []
let handler = async () => ({ ok: true, status: 200, statusText: 'OK', body: {} })
let currentElement = null

const timers = []
const timeouts = []
const listeners = { window: [], document: [] }

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      globalThis.__definition = definition
    },
  },
  setInterval(fn, ms) {
    timers.push({ fn, ms, cleared: false })
    return timers.length
  },
  clearInterval(id) {
    const timer = timers[id - 1]
    if (timer !== undefined) timer.cleared = true
  },
  setTimeout(fn, ms) {
    timeouts.push({ fn, ms, cleared: false })
    return timeouts.length
  },
  clearTimeout(id) {
    const timer = timeouts[id - 1]
    if (timer !== undefined) timer.cleared = true
  },
  addEventListener(type) {
    listeners.window.push(type)
  },
  removeEventListener(type) {
    listeners.window = listeners.window.filter((entry) => entry !== type)
  },
}

globalThis.document = {
  baseURI: 'http://127.0.0.1:56997/',
  visibilityState: 'visible',
  addEventListener(type) {
    listeners.document.push(type)
  },
  removeEventListener(type) {
    listeners.document = listeners.document.filter((entry) => entry !== type)
  },
}

let transport = 'json'

globalThis.fetch = async (url, init) => {
  const call = { url, method: (init && init.method) || 'GET', body: init && init.body ? JSON.parse(init.body) : null }
  calls.push(call)
  if (transport === 'html') {
    return { ok: false, status: 401, statusText: 'Unauthorized', text: async () => '<html>login</html>' }
  }
  const result = await handler(call)
  if (result instanceof Error) throw result
  return {
    ok: result.ok,
    status: result.status,
    statusText: result.statusText,
    text: async () => (result.body === null ? '' : JSON.stringify(result.body)),
  }
}

const requireStub = (id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
}

// --------------------------------------------------------------------- loading

const definition = (() => {
  // The bundle is browser code; evaluating it only defines the module.
  // eslint-disable-next-line no-new-func
  new Function('window', SRC)(globalThis.window)
  return globalThis.__definition
})()

assert(definition.id === 'dsh-lan-bridge', 'bundle id')

const module_ = definition.factory(requireStub)
assert(Array.isArray(module_.inject), 'inject list')
assert(module_.inject.includes('slots') && module_.inject.includes('locale'), 'inject slots+locale')

// ------------------------------------------------------------- plugin context

const dictionaries = {}
const registered = []

const localeStub = {
  register(namespace, language, dict) {
    dictionaries[language] = dict
    return () => {}
  },
  bind(namespace) {
    return (key, params) => {
      const dict = dictionaries.zh ?? {}
      const raw = dict[key]
      if (raw === undefined) return key
      if (params === undefined) return raw
      return raw.replace(/\{(\w+)\}/g, (whole, name) => (params[name] === undefined ? whole : String(params[name])))
    }
  },
}

const ctx = {
  get(name) {
    return name === 'locale' ? localeStub : undefined
  },
  effect(run) {
    run()
    return () => {}
  },
  slots: {
    inject(slot, run) {
      return run()
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
    },
  },
  locale: localeStub,
}

module_.apply(ctx)

assert(registered.length === 2, `expected two slot registrations, got ${registered.length}`)
const section = registered.find((entry) => entry.options.name === 'settings.section')
const icon = registered.find((entry) => entry.options.name === 'settings.section.icon')
assert(section !== undefined, 'settings.section registered')
assert(icon !== undefined, 'settings.section.icon registered')
assert(section.options.locale === 'lanBridge', 'section binds its locale namespace')
assert(icon.options.id === section.options.id, 'icon matches the section id')
assert(typeof section.options.label === 'function', 'section label is a function')

const t = localeStub.bind('lanBridge')
assert(t('nav') === '局域网桥接', 'zh nav label resolves')

// ------------------------------------------------------------- locale coverage

const sourceKeys = new Set()
for (const match of SRC.matchAll(/\bt\(\s*'([A-Za-z0-9_.]+)'/g)) sourceKeys.add(match[1])
for (const language of ['zh', 'en']) {
  const dict = dictionaries[language]
  assert(dict !== undefined, `${language} dictionary registered`)
  const missing = [...sourceKeys].filter((key) => dict[key] === undefined)
  if (missing.length > 0) throw new Error(`${language} dictionary is missing: ${missing.join(', ')}`)
}
const zhKeys = Object.keys(dictionaries.zh)
const enKeys = Object.keys(dictionaries.en)
const zhOnly = zhKeys.filter((key) => !enKeys.includes(key))
const enOnly = enKeys.filter((key) => !zhKeys.includes(key))
if (zhOnly.length > 0 || enOnly.length > 0) {
  throw new Error(`dictionary key drift: zh only ${zhOnly}, en only ${enOnly}`)
}

// ------------------------------------------------------------------- fixtures

const STATE = {
  role: 'both',
  name: 'qian-mbp',
  listen: { host: '0.0.0.0', port: 5799 },
  inbound: [
    { name: 'study-nuc', masked: 'lzb_…4f2a', createdAt: 1731200000000, lastSeenAt: Date.now() - 120000, capabilities: ['read', 'prompt'] },
    { name: 'old-tablet', masked: 'lzb_…99c1', createdAt: 1731200000000, lastSeenAt: null, capabilities: ['read'] },
  ],
  outbound: [
    { name: 'work-mac', url: 'http://192.168.1.8:5799', reachable: true },
    { name: 'attic-box', url: 'http://192.168.1.44:5799', reachable: false },
  ],
  sessions: [
    { sessionId: 's1', title: '重构命令面板', running: true, cwd: '/home/dev/panel', shared: true },
    { sessionId: 's2', title: '写周报', running: false, cwd: '/home/dev/docs', shared: false },
  ],
  workspaces: [
    {
      workspaceId: 'w-panel',
      title: 'panel-project',
      path: '/home/dev/panel',
      shared: false,
      sessions: [
        { sessionId: 's1', title: '重构命令面板', running: true, cwd: '/home/dev/panel', shared: true },
        { sessionId: 's2', title: '写周报', running: false, cwd: '/home/dev/docs', shared: false },
      ],
    },
    { workspaceId: 'w-docs', title: 'docs-site', path: '/home/dev/docs', shared: false, sessions: [] },
    { workspaceId: 'ungrouped', title: '', path: '', shared: false, sessions: [] },
  ],
}

function mount(props) {
  currentElement = React.createElement(section.component, props === undefined ? { t } : props)
  return currentElement
}

// ------------------------------------------------------------------- scenarios

const results = []

async function scenario_loading() {
  hookStore.clear()
  instances.clear()
  calls.length = 0
  handler = () => new Promise(() => {})
  mount()
  dirty = false
  rendered = renderRoot(currentElement)
  runEffects()
  const text = textOf(rendered)
  assert(text.includes('局域网桥接'), 'loading: title')
  assert(text.includes('读取中'), 'loading: loading state')
  assert(byClass(rendered, 'dslb-root').length === 1, 'loading: one root')
  results.push('loading state renders')
}

async function scenario_ready() {
  hookStore.clear()
  instances.clear()
  calls.length = 0
  handler = async () => ({ ok: true, status: 200, statusText: 'OK', body: STATE })
  mount()
  await settle()
  const text = textOf(rendered)
  for (const expected of [
    '本机', '双向', 'qian-mbp', '0.0.0.0:5799',
    '会话', 'panel-project', '/home/dev/panel', '2 个会话 · 1 已共享', 'docs-site', '0 个会话',
    '全部展开',
    '对等端', '入站', 'study-nuc', 'lzb_…4f2a', '出站', 'work-mac', 'http://192.168.1.8:5799', '可达', '不可达',
    '配对新对等端',
  ]) {
    assert(text.includes(expected), `ready: missing ${expected}`)
  }
  assert(calls.some((call) => call.url === 'http://127.0.0.1:56997/api/lan-bridge.state'), 'ready: reads the Host route')
  // Sessions are collapsed by default: only the workspace rows are visible.
  const toggles = wsToggles(rendered)
  assert(toggles.length === 2, `ready: two workspace rows, got ${toggles.length}`)
  assert(toggles.every((node) => node.props['aria-expanded'] === 'false'), 'ready: workspaces start collapsed')
  assert(sharingSwitches(rendered).length === 0, 'ready: no session switches while collapsed')
  assert(!text.includes('重构命令面板'), 'ready: collapsed groups hide their sessions')
  const workspaceSwitches = wsSwitches(rendered)
  assert(workspaceSwitches.length === 2, `ready: one switch per workspace, got ${workspaceSwitches.length}`)
  assert(workspaceSwitches.every((node) => node.props.role === 'switch'), 'ready: workspace switch is a switch')
  const permission = findAll(rendered, (node) => (node.props.className ?? '').split(/\s+/).includes('dslb-switch')
    && node.props['aria-label'] === '允许对端新建会话')
  assert(permission.length === 1, 'ready: the create-sessions permission is its own switch')
  assert(permission[0].props['aria-checked'] === 'true', 'ready: create-sessions defaults on')
  assert(byClass(rendered, 'dslb-dot').length === 2, 'ready: the two peer dots only, sessions collapsed')
  results.push('ready state renders the workspace hierarchy collapsed, plus peers')
}

async function scenario_toggle_success() {
  hookStore.clear()
  instances.clear()
  calls.length = 0
  handler = async (call) => {
    if (call.url.endsWith('/api/lan-bridge.share')) return { ok: true, status: 200, statusText: 'OK', body: { ok: true } }
    return { ok: true, status: 200, statusText: 'OK', body: STATE }
  }
  mount()
  await settle()
  await expandFirstWorkspace()
  const switches = sharingSwitches(rendered)
  assert(switches.length === 2, `toggle: both session switches after expanding, got ${switches.length}`)
  assert(switches[0].props['aria-checked'] === 'true', 'toggle: shared session switch is on')
  assert(switches[1].props['aria-checked'] === 'false', 'toggle: unshared session switch is off')
  assert(switches[0].props.disabled !== true, 'toggle: switch enabled')
  switches[1].props.onClick()
  // Optimistic: the switch flips before the route answers.
  dirty = false
  rendered = renderRoot(currentElement)
  runEffects()
  assert(sharingSwitches(rendered)[1].props['aria-checked'] === 'true', 'toggle: optimistic flip')
  await settle()
  const share = calls.filter((call) => call.url.endsWith('/api/lan-bridge.share'))
  assert(share.length === 1, 'toggle: one share call')
  assert(share[0].method === 'POST', 'toggle: POST')
  assert(share[0].body.sessionId === 's2', 'toggle: sessionId in body')
  assert(share[0].body.shared === true, 'toggle: shared in body')
  assert(calls.filter((call) => call.url.endsWith('/api/lan-bridge.state')).length >= 2, 'toggle: re-reads state after the write')
  results.push('sharing toggle posts {sessionId, shared} and reloads')
}

async function scenario_toggle_failure() {
  hookStore.clear()
  instances.clear()
  calls.length = 0
  handler = async (call) => {
    if (call.url.endsWith('/api/lan-bridge.share')) {
      return { ok: false, status: 409, statusText: 'Conflict', body: { ok: false, error: 'session is not controllable' } }
    }
    return { ok: true, status: 200, statusText: 'OK', body: STATE }
  }
  mount()
  await settle()
  await expandFirstWorkspace()
  sharingSwitches(rendered)[1].props.onClick()
  await settle()
  const switches = sharingSwitches(rendered)
  assert(switches[1].props['aria-checked'] === 'false', 'failure: switch reverted')
  const text = textOf(rendered)
  assert(text.includes('共享状态切换失败'), 'failure: row explains the revert')
  assert(text.includes('session is not controllable'), 'failure: Host reason surfaces')
  results.push('failed share reverts and reports the Host reason')
}

async function scenario_revoke() {
  hookStore.clear()
  instances.clear()
  calls.length = 0
  handler = async (call) => {
    if (call.url.endsWith('/api/lan-bridge.revoke')) return { ok: true, status: 200, statusText: 'OK', body: { ok: true } }
    return { ok: true, status: 200, statusText: 'OK', body: STATE }
  }
  mount()
  await settle()
  const revoke = clickable(rendered, '撤销')
  assert(revoke !== null, 'revoke: button present')
  revoke.props.onClick()
  await settle()
  const confirm = clickable(rendered, '确认撤销')
  assert(confirm !== null, 'revoke: confirmation step')
  const revokeCalls = () => calls.filter((call) => call.url.endsWith('/api/lan-bridge.revoke'))
  assert(revokeCalls().length === 0, 'revoke: nothing sent before confirming')
  confirm.props.onClick()
  await settle()
  const sent = revokeCalls()
  assert(sent.length === 1, 'revoke: one call')
  assert(sent[0].body.name === 'study-nuc', 'revoke: name in body')
  results.push('revoke is confirmed, then posted with {name}')
}

async function scenario_pair() {
  hookStore.clear()
  instances.clear()
  calls.length = 0
  handler = async (call) => {
    if (call.url.endsWith('/api/lan-bridge.pair')) {
      return { ok: true, status: 200, statusText: 'OK', body: { ok: true, token: 'lzb_0123456789abcdef' } }
    }
    return { ok: true, status: 200, statusText: 'OK', body: STATE }
  }
  mount()
  await settle()
  const pair = clickable(rendered, '配对新对等端')
  assert(pair !== null, 'pair: entry point')
  pair.props.onClick()
  await settle()
  const input = findAll(rendered, (node) => node.type === 'input' && node.props['aria-label'] === '对等端名称')
  assert(input.length === 1, 'pair: name field')
  input[0].props.onChange({ currentTarget: { value: 'bench-box' } })
  await settle()
  const submit = clickable(rendered, '生成令牌')
  assert(submit !== null, 'pair: submit')
  submit.props.onClick()
  await settle()
  const pairCalls = calls.filter((call) => call.url.endsWith('/api/lan-bridge.pair'))
  assert(pairCalls.length === 1, 'pair: one call')
  assert(pairCalls[0].body.name === 'bench-box', 'pair: name in body')
  const text = textOf(rendered)
  assert(text.includes('令牌（仅显示一次）'), 'pair: token panel')
  assert(text.includes('关闭后无法再次查看'), 'pair: shown-once warning')
  assert(text.includes('bench-box'), 'pair: names the peer')
  const tokenInput = findAll(rendered, (node) => node.type === 'input' && node.props.readOnly === true)
  assert(tokenInput.length === 1, 'pair: read-only token field')
  assert(tokenInput[0].props.value === 'lzb_0123456789abcdef', 'pair: token field value')
  const dismiss = clickable(rendered, '关闭')
  assert(dismiss !== null, 'pair: dismiss')
  dismiss.props.onClick()
  await settle()
  assert(
    findAll(rendered, (node) => node.type === 'input' && node.props.readOnly === true).length === 0,
    'pair: dismissing forgets the token',
  )
  results.push('pairing shows a one-time token and forgets it on dismiss')
}

async function scenario_expand_workspace() {
  hookStore.clear()
  instances.clear()
  calls.length = 0
  handler = async () => ({ ok: true, status: 200, statusText: 'OK', body: STATE })
  mount()
  await settle()
  await expandFirstWorkspace()
  assert(wsToggles(rendered)[0].props['aria-expanded'] === 'true', 'expand: aria-expanded flips to true')
  const text = textOf(rendered)
  for (const expected of ['重构命令面板', '运行中', '写周报', '空闲', '/home/dev/panel', '/home/dev/docs']) {
    assert(text.includes(expected), `expand: missing ${expected}`)
  }
  assert(sharingSwitches(rendered).length === 2, 'expand: the group’s session switches appear')
  assert(byClass(rendered, 'dslb-dot').length === 4, 'expand: two peer dots + two session dots')
  // Collapsing puts the rows away again without losing the group.
  wsToggles(rendered)[0].props.onClick()
  await settle()
  assert(wsToggles(rendered)[0].props['aria-expanded'] === 'false', 'expand: aria-expanded flips back')
  assert(sharingSwitches(rendered).length === 0, 'expand: rows are hidden again')
  // The card head expands and collapses every group at once.
  clickable(rendered, '全部展开').props.onClick()
  await settle()
  assert(wsToggles(rendered).every((node) => node.props['aria-expanded'] === 'true'), 'expand: expand-all opens every group')
  assert(textOf(rendered).includes('暂无会话'), 'expand: the empty workspace explains itself')
  assert(textOf(rendered).includes('共享此工作区后，新建会话将自动共享'), 'expand: the empty workspace offers the next step')
  clickable(rendered, '全部收起').props.onClick()
  await settle()
  assert(wsToggles(rendered).every((node) => node.props['aria-expanded'] === 'false'), 'expand: collapse-all closes every group')
  results.push('workspaces start collapsed, expand individually and all at once')
}

/** A Host answer where the workspace rule is in force, as the real one would reply. */
function withWorkspaceShared(workspaceId) {
  const share = (session) => ({ ...session, shared: true })
  return {
    ...STATE,
    sessions: STATE.sessions.map(share),
    workspaces: STATE.workspaces.map((group) => (group.workspaceId === workspaceId
      ? { ...group, shared: true, sessions: group.sessions.map(share) }
      : group)),
  }
}

async function scenario_share_whole_workspace() {
  // The first read is the state before the rule; every later read is how a Host
  // that applied the rule would answer.
  let writes0 = 0
  reset(async (call) => {
    if (call.url.endsWith('/api/lan-bridge.shareWorkspace')) {
      writes0 += 1
      return { ok: true, status: 200, statusText: 'OK', body: { ok: true, workspaceId: 'w-panel', shared: true } }
    }
    const body = writes0 === 0 ? STATE : withWorkspaceShared('w-panel')
    return { ok: true, status: 200, statusText: 'OK', body }
  })
  mount()
  await settle()
  const switches = wsSwitches(rendered)
  assert(switches.length === 2, 'whole: one switch per workspace')
  assert(switches[0].props['aria-checked'] === 'false', 'whole: the workspace starts unshared')
  switches[0].props.onClick()
  dirty = false
  rendered = renderRoot(currentElement)
  runEffects()
  assert(wsSwitches(rendered)[0].props['aria-checked'] === 'true', 'whole: optimistic flip')
  await settle()
  const writes = calls.filter((call) => call.url.endsWith('/api/lan-bridge.shareWorkspace'))
  assert(writes.length === 1, 'whole: one workspace call')
  assert(writes[0].method === 'POST', 'whole: POST')
  assert(writes[0].body.workspaceId === 'w-panel', 'whole: workspaceId in body')
  assert(writes[0].body.shared === true, 'whole: shared in body')
  assert(calls.filter((call) => call.url.endsWith('/api/lan-bridge.state')).length >= 2, 'whole: the fresh read is applied')
  await expandFirstWorkspace()
  const text = textOf(rendered)
  assert(text.includes('工作区已整体共享，新会话自动共享'), 'whole: the rule is explained in the group')
  const rowSwitches = sharingSwitches(rendered)
  assert(rowSwitches.length === 2, 'whole: the sessions are still listed')
  assert(rowSwitches.every((node) => node.props['aria-checked'] === 'true'), 'whole: effective sharing is shown')
  assert(rowSwitches.every((node) => node.props.disabled === true), 'whole: per-session switches are locked')
  results.push('sharing a whole workspace posts {workspaceId, shared} and locks its sessions')
}

async function scenario_share_workspace_failure() {
  reset(async (call) => {
    if (call.url.endsWith('/api/lan-bridge.shareWorkspace')) {
      return {
        ok: false,
        status: 200,
        statusText: 'OK',
        body: { ok: false, error: { code: 'bridge/bad-request', message: 'unknown workspace', details: { workspaceId: 'w-panel' } } },
      }
    }
    return { ok: true, status: 200, statusText: 'OK', body: STATE }
  })
  mount()
  await settle()
  wsSwitches(rendered)[0].props.onClick()
  await settle()
  assert(wsSwitches(rendered)[0].props['aria-checked'] === 'false', 'whole failure: switch reverted')
  const text = textOf(rendered)
  assert(text.includes('工作区共享切换失败'), 'whole failure: the group explains the revert')
  assert(text.includes('unknown workspace'), 'whole failure: the Host sentence surfaces')
  results.push('a refused workspace toggle reverts and shows the Host sentence')
}

async function scenario_no_workspaces_key() {
  const { workspaces, ...flat } = STATE
  assert(workspaces !== undefined, 'fallback: the fixture really carries workspaces')
  reset(async () => ({ ok: true, status: 200, statusText: 'OK', body: flat }))
  mount()
  await settle()
  const text = textOf(rendered)
  assert(wsToggles(rendered).length === 0, 'fallback: no workspace rows without the key')
  assert(sharingSwitches(rendered).length === 2, 'fallback: the flat session list renders')
  assert(byClass(rendered, 'dslb-dot').length === 4, 'fallback: flat sessions keep their dots')
  for (const expected of ['重构命令面板', '写周报', '运行中', '空闲', '/home/dev/panel']) {
    assert(text.includes(expected), `fallback: missing ${expected}`)
  }
  assert(byClass(rendered, 'dslb-alert').length === 0, 'fallback: an older Host is not an error')
  results.push('a Host without workspaces falls back to the flat session list')
}

async function scenario_malformed() {
  hookStore.clear()
  instances.clear()
  calls.length = 0
  handler = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      role: 'nonsense',
      name: null,
      listen: 'not-an-object',
      inbound: [null, 42, { name: '' }, { name: 'ok-peer' }],
      outbound: 'nope',
      sessions: [null, { sessionId: '' }, { sessionId: 's9', title: null, running: 'yes', cwd: 7, shared: 1 }],
    },
  })
  mount()
  await settle()
  const text = textOf(rendered)
  assert(text.includes('未配置'), 'malformed: unknown role falls back')
  assert(text.includes('ok-peer'), 'malformed: valid peer kept')
  assert(text.includes('s9'), 'malformed: session id used when the title is unusable')
  assert(sharingSwitches(rendered).length === 1, 'malformed: only valid sessions switch')
  assert(text.includes('暂无出站对等端'), 'malformed: missing outbound list is empty, not fatal')
  results.push('malformed payload degrades instead of throwing')
}

async function scenario_transport_error() {
  hookStore.clear()
  instances.clear()
  calls.length = 0
  transport = 'html'
  mount()
  await settle()
  const text = textOf(rendered)
  assert(text.includes('状态读取失败'), 'transport: error state')
  assert(text.includes('重试'), 'transport: retry offered')
  assert(text.includes('HTTP 401 Unauthorized'), 'transport: HTTP status surfaces')
  transport = 'json'
  results.push('non-JSON auth failure becomes a retryable error state')
}

async function scenario_stale_after_error() {
  hookStore.clear()
  instances.clear()
  calls.length = 0
  let broken = true
  handler = async () => {
    if (broken) return { ok: false, status: 500, statusText: 'Server Error', body: { ok: false, error: 'boom' } }
    return { ok: true, status: 200, statusText: 'OK', body: STATE }
  }
  mount()
  await settle()
  assert(textOf(rendered).includes('状态读取失败'), 'stale: error state without data')
  assert(textOf(rendered).includes('boom'), 'stale: Host reason surfaces')
  broken = false
  const retry = clickable(rendered, '重试')
  assert(retry !== null, 'stale: retry offered')
  retry.props.onClick()
  await settle()
  assert(textOf(rendered).includes('panel-project'), 'stale: retry recovers the workspace rows')
  assert(wsToggles(rendered).length === 2, 'stale: the recovered state is fully rendered')
  results.push('retry recovers after a failed read')
}

async function scenario_no_translator() {
  hookStore.clear()
  instances.clear()
  handler = async () => ({ ok: true, status: 200, statusText: 'OK', body: STATE })
  mount({})
  await settle()
  assert(textOf(rendered).includes('局域网桥接'), 'no translator: falls back to the zh dictionary')
  results.push('renders without an injected translator')
}

async function scenario_lifecycle() {
  hookStore.clear()
  instances.clear()
  timers.length = 0
  listeners.window.length = 0
  listeners.document.length = 0
  handler = async () => ({ ok: true, status: 200, statusText: 'OK', body: STATE })
  mount()
  await settle()
  assert(timers.length === 1, `lifecycle: one interval, got ${timers.length}`)
  assert(timers[0].ms === 3000, `lifecycle: 3s cadence, got ${timers[0].ms}`)
  assert(listeners.window.includes('focus'), 'lifecycle: focus listener')
  assert(listeners.document.includes('visibilitychange'), 'lifecycle: visibility listener')
  const before = calls.length
  timers[0].fn()
  await settle()
  assert(calls.length > before, 'lifecycle: a tick re-reads state')
  // Unmount: the harness runs the effect cleanup and the panel must stop.
  const timer = timers[0]
  const cleanup = hookStore.get([...hookStore.keys()].find((key) => key.includes('useEffect')) ?? '')
  void cleanup
  // Run the recorded effect cleanup directly through a fresh render pass with
  // an empty element, which is what React does on unmount.
  currentElement = createElement('div', null)
  dirty = false
  rendered = renderRoot(currentElement)
  // The harness keeps hook slots; emulate unmount by invoking the stored cleanup.
  for (const slot of hookStore.values()) {
    if (typeof slot.cleanup === 'function') slot.cleanup()
  }
  assert(timer.cleared === true, 'lifecycle: interval cleared on unmount')
  assert(!listeners.window.includes('focus'), 'lifecycle: focus listener removed')
  assert(!listeners.document.includes('visibilitychange'), 'lifecycle: visibility listener removed')
  results.push('polls at 3s, reacts to ticks, and releases everything on unmount')
}

async function scenario_icon() {
  const nodes = renderRoot(createElement(icon.component, { size: 16, active: true }))
  const svgs = findAll(nodes, (node) => node.type === 'svg')
  assert(svgs.length === 1, 'icon: one svg')
  assert(svgs[0].props.viewBox === '0 0 24 24', 'icon: 24x24 viewBox')
  assert(svgs[0].props.width === 16 && svgs[0].props.height === 16, 'icon: honours the size prop')
  assert(svgs[0].props.stroke === 'currentColor', 'icon: monochrome via currentColor')
  assert(svgs[0].props.fill === 'none', 'icon: outline glyph')
  results.push('section icon renders at the slot-given size')
}


// ------------------------------------------------- listening-settings fixtures

const LIVE_STATE = {
  role: 'both',
  name: 'qian-mbp',
  listen: { host: '127.0.0.1', port: 5977, protocol: 'http', listening: true, error: null },
  settings: {
    host: '127.0.0.1',
    port: 5977,
    insecureHttp: false,
    allowPeersToCreateSessions: true,
    trustedHosts: ['mac.local:5977'],
    tls: null,
  },
  addresses: ['127.0.0.1', '172.17.46.12'],
  restartRequired: false,
  inbound: [{ name: 'study-nuc', masked: 'lzb_…4f2a', createdAt: 1731200000000, lastSeenAt: null, capabilities: ['read'] }],
  outbound: [{ name: 'work-mac', url: 'http://192.168.1.8:5977', reachable: true }],
  sessions: [
    { sessionId: 's1', title: '面板开发', running: true, cwd: '/home/dev/panel', shared: false },
  ],
}

function withState(patch) {
  return { ...LIVE_STATE, ...patch }
}

/** A failing settings write with a Host-authored message. */
function refusedSettings(message, code) {
  return {
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    body: { ok: false, error: { code, message, details: { host: '0.0.0.0', reason: 'insecure-http-required' } } },
  }
}

function reset(handlerFn) {
  hookStore.clear()
  instances.clear()
  calls.length = 0
  timers.length = 0
  timeouts.length = 0
  handler = handlerFn
}

function stateReads() {
  return calls.filter((call) => call.url.endsWith('/api/lan-bridge.state')).length
}

function settingsWrites() {
  return calls.filter((call) => call.url.endsWith('/api/lan-bridge.settings'))
}

function inputByLabel(nodes, label) {
  return findAll(nodes, (node) => node.type === 'input' && node.props['aria-label'] === label)
}

/** The save button, distinguishing it from the confirm pair and other buttons. */
function saveButton(nodes) {
  const buttons = findAll(nodes, (node) => node.type === 'button' && typeof node.props.onClick === 'function')
  for (const node of buttons) {
    const text = textOf([node]).trim()
    if (text === '保存' || text === '保存中…') return node
  }
  return null
}

function checkbox(nodes) {
  return findAll(nodes, (node) => node.type === 'input' && node.props.type === 'checkbox')
}

async function type(label, value) {
  const field = inputByLabel(rendered, label)
  assert(field.length === 1, `field ${label} present (got ${field.length})`)
  field[0].props.onChange({ currentTarget: { value } })
  await settle()
}

// --------------------------------------------------------------- scenarios

function chips(nodes) {
  return findAll(nodes, (node) => node.type === 'button' && node.props.className === 'dslb-chipPick')
}

function chipLabels(nodes) {
  return chips(nodes).map((node) => textOf([node]).trim())
}

async function scenario_settings_form_renders() {
  reset(async () => ({ ok: true, status: 200, statusText: 'OK', body: LIVE_STATE }))
  mount()
  await settle()
  const text = textOf(rendered)
  for (const expected of ['监听设置', '监听地址', '端口', '允许对端新建会话', '信任主机', 'TLS 证书', 'TLS 私钥', '允许明文 HTTP']) {
    assert(text.includes(expected), `form: missing ${expected}`)
  }
  assert(text.includes('监听失败') === false, 'form: no listener error while healthy')
  assert(text.includes('保存后监听会重建') === false, 'form: no rebuild warning until the address or port changes')
  assert(text.indexOf('监听设置') < text.indexOf('本机'), 'form: the listener section sits above the machine summary')
  assert(inputByLabel(rendered, '监听地址')[0].props.value === '127.0.0.1', 'form: host seeded')
  assert(inputByLabel(rendered, '端口')[0].props.value === '5977', 'form: port seeded')
  assert(inputByLabel(rendered, '端口').length === 1, 'form: one port field')
  assert(inputByLabel(rendered, '信任主机')[0].props.value === 'mac.local:5977', 'form: trusted hosts joined for editing')
  assert(inputByLabel(rendered, 'TLS 证书')[0].props.value === '', 'form: cert empty when tls is null')
  assert(inputByLabel(rendered, 'TLS 私钥')[0].props.value === '', 'form: key empty when tls is null')
  const labels = chipLabels(rendered)
  assert(labels.indexOf('0.0.0.0') !== -1 && labels.indexOf('172.17.46.12') !== -1, `form: chips offer interfaces (${labels})`)
  assert(labels.filter((value) => value === '127.0.0.1').length === 1, 'form: chips dedupe')
  assert(text.includes('本机地址'), 'form: chips are labelled')
  assert(findAll(rendered, (node) => node.type === 'option').length === 0, 'form: chips replaced the datalist')
  assert(checkbox(rendered).length === 1, 'form: the plaintext box is always visible')
  assert(checkbox(rendered)[0].props.checked === false, 'form: plaintext off by default')
  assert(text.includes('当前设置会被服务端拒绝') === false, 'form: no refusal warning for a loopback bind')
  const save = saveButton(rendered)
  assert(save !== null, 'form: save button')
  assert(save.props.disabled === true, 'form: save disabled while nothing changed')
  results.push('listening form seeds from the effective settings, with interface chips and an inert save')
}

async function scenario_settings_chips_fill_host() {
  reset(async () => ({ ok: true, status: 200, statusText: 'OK', body: LIVE_STATE }))
  mount()
  await settle()
  // The chip is a one-click fill, not a separate setting: it writes the host field.
  clickable(rendered, '172.17.46.12').props.onClick()
  await settle()
  assert(inputByLabel(rendered, '监听地址')[0].props.value === '172.17.46.12', 'chips: clicking fills the host field')
  assert(textOf(rendered).includes('当前设置会被服务端拒绝'), 'chips: an outward address warns about TLS pre-emptively')
  assert(textOf(rendered).includes('保存后监听会重建'), 'chips: an address change warns about the listener rebuild')
  assert(saveButton(rendered).props.disabled === false, 'chips: the save stays available')
  clickable(rendered, '127.0.0.1').props.onClick()
  await settle()
  assert(inputByLabel(rendered, '监听地址')[0].props.value === '127.0.0.1', 'chips: another chip replaces it')
  assert(textOf(rendered).includes('当前设置会被服务端拒绝') === false, 'chips: back to loopback clears the warning')
  assert(textOf(rendered).includes('保存后监听会重建') === false, 'chips: back to loopback clears the rebuild warning')
  results.push('interface chips fill the bind address and the warning follows the address')
}

async function scenario_settings_switch_does_not_warn_rebuild() {
  reset(async () => ({ ok: true, status: 200, statusText: 'OK', body: LIVE_STATE }))
  mount()
  await settle()
  const toggle = findAll(rendered, (node) => node.type === 'button' && node.props.role === 'switch' && node.props['aria-label'] === '允许对端新建会话')[0]
  assert(toggle !== undefined, 'switch: create-session toggle present')
  toggle.props.onClick()
  await settle()
  assert(textOf(rendered).includes('保存后监听会重建') === false, 'switch: a permission change does not predict a rebuild')
  assert(saveButton(rendered).props.disabled === false, 'switch: the change is saveable')
  results.push('only an address or port edit announces a listener rebuild')
}

async function scenario_settings_insecure_warns_not_blocks() {
  reset(async () => ({ ok: true, status: 200, statusText: 'OK', body: LIVE_STATE }))
  mount()
  await settle()
  await type('监听地址', '0.0.0.0')
  const text = textOf(rendered)
  assert(text.includes('允许明文 HTTP：token 会在局域网里明文传输'), 'insecure: the checkbox names the risk')
  assert(text.includes('当前设置会被服务端拒绝'), 'insecure: the refusal is predicted inline')
  assert(saveButton(rendered).props.disabled === false, 'insecure: the button is left live so the Host can teach the rule')
  const boxes = checkbox(rendered)
  assert(boxes.length === 1, 'insecure: one plaintext checkbox')
  boxes[0].props.onChange({ currentTarget: { checked: true } })
  await settle()
  assert(textOf(rendered).includes('当前设置会被服务端拒绝') === false, 'insecure: ticking clears the prediction')
  assert(saveButton(rendered).props.disabled === false, 'insecure: still saveable')
  assert(settingsWrites().length === 0, 'insecure: nothing is posted until save is pressed')
  results.push('a non-loopback bind without TLS warns inline but never blocks the save')
}

async function scenario_settings_save_outward() {
  const saved = withState({
    listen: { host: '0.0.0.0', port: 5977, protocol: 'http', listening: true, error: null },
    settings: { ...LIVE_STATE.settings, host: '0.0.0.0', insecureHttp: true },
  })
  reset(async (call) => {
    if (call.url.endsWith('/api/lan-bridge.settings')) return { ok: true, status: 200, statusText: 'OK', body: { ok: true, state: saved } }
    return { ok: true, status: 200, statusText: 'OK', body: LIVE_STATE }
  })
  mount()
  await settle()
  await type('监听地址', '0.0.0.0')
  checkbox(rendered)[0].props.onChange({ currentTarget: { checked: true } })
  await settle()
  saveButton(rendered).props.onClick()
  await settle()
  const writes = settingsWrites()
  assert(writes.length === 1, `outward: one settings write, no confirmation step (got ${writes.length})`)
  assert(writes[0].method === 'POST', 'outward: POST')
  const expected = {
    name: 'qian-mbp',
    host: '0.0.0.0',
    port: 5977,
    insecureHttp: true,
    discovery: false,
    allowPeersToCreateSessions: true,
    trustedHosts: ['mac.local:5977'],
    tls: null,
  }
  assert(JSON.stringify(writes[0].body) === JSON.stringify(expected), `outward: exact body (got ${JSON.stringify(writes[0].body)})`)
  assert(typeof writes[0].body.port === 'number', 'outward: the port is sent as a number')
  assert(stateReads() === 1, `outward: applies the returned state without re-reading (reads: ${stateReads()})`)
  const text = textOf(rendered)
  assert(text.includes('http://0.0.0.0:5977'), 'outward: this-machine line shows the new listener')
  assert(text.includes('已保存'), 'outward: success is reported')
  assert(checkbox(rendered).length === 1 && checkbox(rendered)[0].props.checked === true, 'outward: the box reflects the saved posture')
  assert(saveButton(rendered).props.disabled === true, 'outward: rebased form is clean again')
  assert(text.includes('当前设置会被服务端拒绝') === false, 'outward: no warning once plaintext is accepted')
  assert(text.includes('保存后监听会重建') === false, 'outward: the rebuild note clears after saving')
  results.push('save posts the whole settings set and replaces state from the answer, with no confirmation step')
}

async function scenario_settings_save_refused() {
  reset(async (call) => {
    if (call.url.endsWith('/api/lan-bridge.settings')) {
      return refusedSettings('不能把监听改到 0.0.0.0：这会把会话以明文 HTTP 暴露到局域网。', 'bridge/forbidden')
    }
    return { ok: true, status: 200, statusText: 'OK', body: LIVE_STATE }
  })
  mount()
  await settle()
  await type('监听地址', '0.0.0.0')
  saveButton(rendered).props.onClick()
  await settle()
  const text = textOf(rendered)
  assert(text.includes('保存失败'), 'refused: localized prefix')
  assert(text.includes('不能把监听改到 0.0.0.0：这会把会话以明文 HTTP 暴露到局域网。'), 'refused: Host message shown verbatim')
  assert(text.includes('bridge/forbidden'), 'refused: Host code kept for reporting')
  assert(inputByLabel(rendered, '监听地址')[0].props.value === '0.0.0.0', 'refused: the edit is kept for correction')
  assert(stateReads() === 1, 'refused: no extra state read')
  assert(text.includes('http://127.0.0.1:5977'), 'refused: this machine still reports the live listener')
  assert(saveButton(rendered).props.disabled === false, 'refused: retry is possible')
  const dismiss = clickable(rendered, '关闭')
  assert(dismiss !== null, 'refused: dismissable')
  dismiss.props.onClick()
  await settle()
  assert(textOf(rendered).includes('不能把监听改到') === false, 'refused: dismissal clears the banner')
  results.push('a refused save shows the Host sentence verbatim and keeps the edit')
}

async function scenario_settings_tls_half_filled() {
  reset(async () => ({ ok: true, status: 200, statusText: 'OK', body: LIVE_STATE }))
  mount()
  await settle()
  await type('监听地址', '0.0.0.0')
  await type('TLS 证书', '/etc/lan-bridge/cert.pem')
  const text = textOf(rendered)
  assert(text.includes('证书和私钥必须同时填写，或同时留空。'), 'tls: half pair is called out')
  assert(saveButton(rendered).props.disabled === true, 'tls: half pair blocks saving client-side')
  await type('TLS 私钥', '/etc/lan-bridge/key.pem')
  const after = textOf(rendered)
  assert(after.includes('证书和私钥必须同时填写') === false, 'tls: hint clears once the pair is complete')
  assert(after.includes('当前设置会被服务端拒绝') === false, 'tls: a complete pair removes the plaintext prediction')
  assert(checkbox(rendered).length === 1, 'tls: the plaintext box stays visible')
  assert(saveButton(rendered).props.disabled === false, 'tls: save available with a full pair')
  results.push('certificate and key are all-or-nothing in the form too')
}

async function scenario_settings_tls_pair_in_body() {
  const saved = withState({
    listen: { host: '0.0.0.0', port: 5977, protocol: 'https', listening: true, error: null },
    settings: { ...LIVE_STATE.settings, host: '0.0.0.0', tls: { certFile: '/etc/lan-bridge/cert.pem', keyFile: '/etc/lan-bridge/key.pem' } },
  })
  reset(async (call) => {
    if (call.url.endsWith('/api/lan-bridge.settings')) return { ok: true, status: 200, statusText: 'OK', body: { ok: true, state: saved } }
    return { ok: true, status: 200, statusText: 'OK', body: LIVE_STATE }
  })
  mount()
  await settle()
  await type('监听地址', '0.0.0.0')
  await type('TLS 证书', '/etc/lan-bridge/cert.pem')
  await type('TLS 私钥', '/etc/lan-bridge/key.pem')
  saveButton(rendered).props.onClick()
  await settle()
  const writes = settingsWrites()
  assert(writes.length === 1, 'tls body: one write')
  assert(JSON.stringify(writes[0].body.tls) === JSON.stringify({ certFile: '/etc/lan-bridge/cert.pem', keyFile: '/etc/lan-bridge/key.pem' }), `tls body: pair sent (got ${JSON.stringify(writes[0].body.tls)})`)
  assert(writes[0].body.insecureHttp === false, 'tls body: plaintext stays off when TLS is configured')
  assert(textOf(rendered).includes('https://0.0.0.0:5977'), 'tls body: the protocol follows the answer')
  results.push('a TLS pair is sent as both absolute paths and the listener switches to https')
}

async function scenario_settings_port_zero() {
  const saved = withState({
    listen: { host: '127.0.0.1', port: 61234, protocol: 'http', listening: true, error: null },
    settings: { ...LIVE_STATE.settings, port: 0 },
  })
  reset(async (call) => {
    if (call.url.endsWith('/api/lan-bridge.settings')) return { ok: true, status: 200, statusText: 'OK', body: { ok: true, state: saved } }
    return { ok: true, status: 200, statusText: 'OK', body: LIVE_STATE }
  })
  mount()
  await settle()
  await type('端口', '0')
  assert(textOf(rendered).includes('系统当前分配的端口：5977'), 'port 0: explains what 0 means using the live port')
  saveButton(rendered).props.onClick()
  await settle()
  const writes = settingsWrites()
  assert(writes.length === 1, 'port 0: saved in one click (still loopback)')
  assert(writes[0].body.port === 0, 'port 0: the literal 0 is sent, not the assigned port')
  assert(writes[0].body.port === 0, 'port 0: the literal 0 is sent, not the assigned port')
  assert(textOf(rendered).includes('系统当前分配的端口：61234'), 'port 0: shows the port the OS assigned')
  results.push('port 0 means "let the OS pick" and the assigned port is reported back')
}

async function scenario_settings_trusted_hosts_parsing() {
  reset(async (call) => {
    if (call.url.endsWith('/api/lan-bridge.settings')) {
      return { ok: true, status: 200, statusText: 'OK', body: { ok: true, state: LIVE_STATE } }
    }
    return { ok: true, status: 200, statusText: 'OK', body: LIVE_STATE }
  })
  mount()
  await settle()
  await type('信任主机', ' a:1 ,  b:2  c:3  ')
  assert(textOf(rendered).includes('从 127.0.0.1') === false, 'trusted: no confirmation for a loopback rebind')
  saveButton(rendered).props.onClick()
  await settle()
  const writes = settingsWrites()
  assert(writes.length === 1, 'trusted: save posted')
  assert(JSON.stringify(writes[0].body.trustedHosts) === '["a:1","b:2","c:3"]',
    `trusted: comma/space separated, trimmed (got ${JSON.stringify(writes[0].body.trustedHosts)})`)
  results.push('the trusted-host field parses commas, spaces and empty entries before saving')
}

async function scenario_settings_poll_keeps_edit() {
  reset(async () => ({ ok: true, status: 200, statusText: 'OK', body: LIVE_STATE }))
  mount()
  await settle()
  await type('监听地址', '10.0.0.5')
  assert(timers.length === 1, 'poll: one interval')
  timers[0].fn()
  await settle()
  assert(inputByLabel(rendered, '监听地址')[0].props.value === '10.0.0.5', 'poll: an unsaved edit survives a refresh')
  results.push('a poll never overwrites an unsaved edit')
}

async function scenario_settings_adopts_remote_change() {
  const remote = withState({ settings: { ...LIVE_STATE.settings, host: '172.17.46.12' } })
  let current = LIVE_STATE
  reset(async () => ({ ok: true, status: 200, statusText: 'OK', body: current }))
  mount()
  await settle()
  assert(inputByLabel(rendered, '监听地址')[0].props.value === '127.0.0.1', 'remote: starts from the live value')
  current = remote
  timers[0].fn()
  await settle()
  assert(inputByLabel(rendered, '监听地址')[0].props.value === '172.17.46.12', 'remote: another editor\'s saved value is adopted')
  results.push('a clean form follows settings changed elsewhere')
}

async function scenario_settings_listener_down() {
  reset(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    body: withState({
      listen: { host: '0.0.0.0', port: 5977, protocol: 'http', listening: false, error: 'EADDRINUSE' },
      restartRequired: true,
    }),
  }))
  mount()
  await settle()
  const text = textOf(rendered)
  assert(text.includes('未监听'), 'down: the listener state is shown')
  assert(text.includes('0.0.0.0:5977 · 未监听'), 'down: the configured address is not hidden')
  assert(text.includes('监听失败：EADDRINUSE'), 'down: the bind error is shown verbatim')
  assert(text.includes('部分改动需要重启 Host 才会完全生效。'), 'down: restart-required notice')
  results.push('a down listener and a pending restart are reported without hiding the configuration')
}

async function scenario_settings_envelope_shape() {
  const patched = withState({ settings: { ...LIVE_STATE.settings, allowPeersToCreateSessions: false } })
  reset(async (call) => {
    if (call.url.endsWith('/api/lan-bridge.settings')) {
      // A Host that answers a write with the bare state instead of { ok, state }.
      return { ok: true, status: 200, statusText: 'OK', body: patched }
    }
    // A Host that wraps reads in the mutation envelope.
    return { ok: true, status: 200, statusText: 'OK', body: { ok: true, state: LIVE_STATE } }
  })
  mount()
  await settle()
  assert(textOf(rendered).includes('qian-mbp'), 'envelope: a wrapped read payload renders')
  assert(inputByLabel(rendered, '监听地址')[0].props.value === '127.0.0.1', 'envelope: settings come from the wrapped state')
  const permission = () => findAll(rendered, (node) => (node.props.className ?? '').split(/\s+/).includes('dslb-switch')
    && node.props['aria-label'] === '允许对端新建会话')[0]
  permission().props.onClick()
  await settle()
  saveButton(rendered).props.onClick()
  await settle()
  assert(settingsWrites().length === 1, 'envelope: write posted')
  assert(settingsWrites()[0].body.allowPeersToCreateSessions === false, 'envelope: switch value sent')
  assert(permission().props['aria-checked'] === 'false', 'envelope: a bare-state answer is applied')
  assert(textOf(rendered).includes('已保存，监听器已按新配置重建。'), 'envelope: success reported')
  results.push('both {ok,state} and bare-state answers are accepted on reads and writes')
}

async function scenario_settings_malformed() {
  reset(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    body: withState({ settings: 'nope', addresses: 'x', listen: { host: '', port: null } }),
  }))
  mount()
  await settle()
  const text = textOf(rendered)
  assert(text.includes('监听设置'), 'malformed settings: the form still renders')
  assert(text.includes('请填写监听地址。'), 'malformed settings: an empty host is explained')
  assert(saveButton(rendered).props.disabled === true, 'malformed settings: nothing to save')
  assert(inputByLabel(rendered, '监听地址')[0].props.value === '', 'malformed settings: empty host, no crash')
  results.push('an unreadable settings block degrades to an empty, unsaveable form')
}

/**
 * The panel bundle reloads from disk on a page refresh; Host code only reloads
 * on restart. A panel newer than its Host therefore reads a state object with
 * no `discovery` key — which blanked the whole section once (`record(null).found`
 * threw) and surfaced as "状态读取失败". Older Hosts are a normal deployment,
 * not an error.
 */
async function scenario_host_older_than_panel() {
  hookStore.clear()
  instances.clear()
  calls.length = 0
  const older = { ...STATE }
  delete older.discovery
  handler = async () => ({ ok: true, status: 200, statusText: 'OK', body: older })
  mount()
  await settle()
  const text = textOf(rendered)
  assert(text.includes('局域网桥接'), 'older host: title')
  assert(byClass(rendered, 'dslb-alert').length === 0, 'older host: no failure alert')
  assert(!text.includes('状态读取失败'), 'older host: the section is not blanked')
  results.push('a Host without the discovery field still renders')
}

const scenarios = [
  scenario_host_older_than_panel,
  scenario_loading,
  scenario_ready,
  scenario_toggle_success,
  scenario_toggle_failure,
  scenario_expand_workspace,
  scenario_share_whole_workspace,
  scenario_share_workspace_failure,
  scenario_no_workspaces_key,
  scenario_revoke,
  scenario_pair,
  scenario_malformed,
  scenario_transport_error,
  scenario_stale_after_error,
  scenario_no_translator,
  scenario_lifecycle,
  scenario_icon,
  scenario_settings_form_renders,
  scenario_settings_chips_fill_host,
  scenario_settings_switch_does_not_warn_rebuild,
  scenario_settings_insecure_warns_not_blocks,
  scenario_settings_save_outward,
  scenario_settings_save_refused,
  scenario_settings_tls_half_filled,
  scenario_settings_tls_pair_in_body,
  scenario_settings_port_zero,
  scenario_settings_trusted_hosts_parsing,
  scenario_settings_poll_keeps_edit,
  scenario_settings_adopts_remote_change,
  scenario_settings_listener_down,
  scenario_settings_envelope_shape,
  scenario_settings_malformed,
]

let failed = 0
for (const scenario of scenarios) {
  try {
    await scenario()
    console.log(`ok   ${scenario.name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${scenario.name}: ${error.message}`)
  }
}

console.log('')
console.log(`locale keys: ${Object.keys(dictionaries.zh).length} zh / ${Object.keys(dictionaries.en).length} en, ${sourceKeys.size} referenced`)
for (const line of results) console.log(`  · ${line}`)
if (failed > 0) {
  console.log(`\n${failed} scenario(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall scenarios passed')
}
