/**
 * Workspace grouping for the operator's Sessions card, and the whole-workspace
 * share rule that sits behind it.
 *
 * A "workspace" here is one of two things:
 *   - a real DSH Workspace registration (stable UUID, canonical path, title),
 *     read from `ctx.workspaceRegistry.list()` when this Host mounts it;
 *   - a synthesized group keyed by a Session's canonical `cwd`, for Hosts that
 *     do not mount the registry, or for Sessions whose cwd is not covered by a
 *     registration. Sessions with no cwd land in the `ungrouped` bucket.
 *
 * A whole-workspace share rule is persisted in `bridge.json` alongside the
 * per-Session switches. Enabling one *materializes* explicit per-Session shares
 * for every Session currently in that workspace (and for every new Session that
 * appears later), so every existing gate — `store.isShared`, the SSE handler,
 * archive/unarchive — keeps working unchanged. The materialized decisions are
 * tracked separately from operator decisions so turning the rule back off never
 * revokes a Session the operator shared by hand.
 *
 * No package imports beyond node builtins and this bundle's own helpers.
 */
import { posix, win32 } from 'node:path'
import { BridgeError } from './util.js'

/** Bucket for Sessions whose `cwd` the Host does not report. */
export const UNGROUPED = 'ungrouped'
/** Prefix for synthesised group ids; the rest is the canonical cwd. */
const PATH_PREFIX = 'path:'

/** Trim trailing separators so `/tmp/` and `/tmp` name the same workspace. */
export function normalizePath(value) {
  if (typeof value !== 'string') return ''
  let text = value.trim()
  while (text.length > 1 && /[\\/]$/.test(text)) text = text.slice(0, -1)
  return text
}

/** Synthesised, stable id for one cwd. */
export function pathKey(cwd) {
  return `${PATH_PREFIX}${normalizePath(cwd)}`
}

/**
 * Whether a workspace rule's path covers a Session's cwd. DSH Workspaces group
 * by *exact* canonical cwd equality (`WorkspaceEntity.sessionIds`), so this is
 * deliberately not a prefix/subdirectory match.
 */
export function pathMatches(rulePath, cwd) {
  const left = normalizePath(rulePath)
  const right = normalizePath(cwd)
  if (left === '' || right === '') return left === right
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function basenameOf(path) {
  if (typeof path !== 'string' || path === '') return ''
  const api = process.platform === 'win32' ? win32 : posix
  return api.basename(path) || api.parse(path).root || path
}

/**
 * Real DSH Workspace registrations, projected to plain JSON. An absent or
 * broken registry is a normal state (headless/SDK Hosts), never an error: the
 * panel still works with synthesized cwd groups.
 */
export function registryWorkspaces(ctx) {
  const registry = typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : undefined
  if (registry === undefined || typeof registry.list !== 'function') return []
  try {
    return registry.list().map((workspace) => {
      const path = typeof workspace.path === 'string' ? workspace.path : ''
      const id = String(workspace.id ?? '')
      const rawTitle = typeof workspace.title === 'string' ? workspace.title.trim() : ''
      return {
        workspaceId: id,
        title: rawTitle !== '' ? rawTitle : (basenameOf(path) || id),
        path,
        sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : [],
      }
    }).filter((workspace) => workspace.workspaceId !== '')
  } catch {
    return []
  }
}

function describeSession(item, shared) {
  const sessionId = String(item?.sessionId ?? '')
  const values = item?.projections?.values ?? {}
  const rawTitle = typeof values.title === 'string' ? values.title.trim() : ''
  const entry = {
    sessionId,
    title: rawTitle !== '' ? rawTitle : `Session ${sessionId.slice(-8)}`,
    running: item?.running === true,
    updatedAt: typeof item?.updatedAt === 'number' ? item.updatedAt : 0,
    shared: shared === true,
  }
  if (typeof item?.cwd === 'string' && item.cwd !== '') entry.cwd = item.cwd
  return entry
}

/**
 * Build both views of local Sessions in one pass:
 *   - `workspaces`: groups, newest-active first, `ungrouped` always last;
 *   - `sessions`: the original flat list (kept for older panels / tools).
 *
 * `shared` on every Session is the *effective* value: an explicit share, a
 * materialized auto-share, or a live workspace rule all count. A workspace with
 * zero Sessions is still emitted when a rule names it, so an operator can
 * un-share a workspace that has since gone empty.
 */
export async function sessionGroups({ ctx, store }) {
  const controller = typeof ctx?.get === 'function' ? ctx.get('sessionController') : undefined
  const value = controller === undefined ? undefined : await controller.list({}, undefined)
  const items = Array.isArray(value?.items) ? value.items : []
  const rules = await store.workspaceShares()
  const ruleIds = new Set(rules.map((rule) => rule.workspaceId))
  const explicit = new Set((await store.sharedSessions()).map((entry) => entry.sessionId))
  const registered = registryWorkspaces(ctx)

  const bySession = new Map()
  for (const workspace of registered) {
    for (const id of workspace.sessionIds) bySession.set(id, workspace.workspaceId)
  }

  const groups = new Map()
  /** A rule covers a group by its id, or by its canonical path (an older
   * synthesized rule may outlive a real Workspace registration). */
  function groupIsShared(id, path) {
    return rules.some((rule) => rule.workspaceId === id
      || (path !== '' && rule.path !== '' && pathMatches(rule.path, path)))
  }
  function groupFor(id, title, path) {
    let group = groups.get(id)
    if (group === undefined) {
      group = {
        workspaceId: id,
        title: title !== '' ? title : (basenameOf(path) || id),
        path,
        shared: groupIsShared(id, path),
        sessions: [],
      }
      groups.set(id, group)
    }
    return group
  }

  for (const workspace of registered) groupFor(workspace.workspaceId, workspace.title, workspace.path)
  // A rule may outlive its Workspace registration (or name a synthesized path
  // group that currently has no Sessions). It must remain visible so it can be
  // switched off.
  for (const rule of rules) {
    if (groups.has(rule.workspaceId)) continue
    const path = normalizePath(rule.path)
    const title = path === ''
      ? (rule.workspaceId === UNGROUPED ? 'Other sessions' : rule.workspaceId)
      : basenameOf(path)
    groupFor(rule.workspaceId, title, path)
  }

  const flat = []
  for (const item of items) {
    const sessionId = String(item?.sessionId ?? '')
    if (sessionId === '') continue
    const cwd = typeof item.cwd === 'string' ? item.cwd : ''
    let id = bySession.get(sessionId)
    if (id === undefined) {
      const covered = registered.find((workspace) => pathMatches(workspace.path, cwd))
      id = covered?.workspaceId ?? (cwd === '' ? UNGROUPED : pathKey(cwd))
    }
    // A cwd-based rule also groups Sessions on Hosts without the registry (and
    // Sessions whose cwd is not covered by a registration).
    if (id === pathKey(cwd)) {
      const ruled = rules.find((rule) => rule.workspaceId !== UNGROUPED && pathMatches(rule.path, cwd))
      if (ruled !== undefined) id = ruled.workspaceId
    }
    const group = groups.get(id) ?? groupFor(
      id,
      id === UNGROUPED ? 'Other sessions' : basenameOf(cwd),
      id === UNGROUPED ? '' : cwd,
    )
    const shared = explicit.has(sessionId) || group.shared === true
    const entry = describeSession(item, shared)
    group.sessions.push(entry)
    flat.push(entry)
  }

  for (const group of groups.values()) {
    group.sessions.sort((left, right) => right.updatedAt - left.updatedAt)
  }
  const workspaces = [...groups.values()].sort((left, right) => {
    if (left.workspaceId === UNGROUPED) return 1
    if (right.workspaceId === UNGROUPED) return -1
    const leftNew = left.sessions[0]?.updatedAt ?? 0
    const rightNew = right.sessions[0]?.updatedAt ?? 0
    if (leftNew !== rightNew) return rightNew - leftNew
    return left.title.localeCompare(right.title)
  })
  flat.sort((left, right) => right.updatedAt - left.updatedAt)
  return { workspaces, sessions: flat }
}

/**
 * Reconcile materialized per-Session shares with the active workspace rules.
 * Called at startup, after a rule change, and (mark-only) when a Session first
 * appears. Idempotent.
 */
export async function materializeWorkspaceShares({ ctx, store }) {
  const { workspaces } = await sessionGroups({ ctx, store })
  const active = new Set(workspaces.filter((group) => group.shared === true).map((group) => group.workspaceId))
  // A Session the operator shared by hand must keep its own decision. If we
  // adopted it into `autoShares`, turning the rule off would delete that share.
  // So a rule only takes ownership of Sessions that are currently auto-owned
  // or not shared at all.
  const auto = await store.autoShares()
  const shared = new Set((await store.sharedSessions()).map((entry) => entry.sessionId))
  const wanted = {}
  for (const group of workspaces) {
    if (group.shared !== true) continue
    for (const session of group.sessions) {
      const id = session.sessionId
      if (auto[id] === undefined && shared.has(id)) continue
      wanted[id] = group.workspaceId
    }
  }
  // One write replaces the whole auto-share set: Sessions that dropped out of
  // a rule (or vanished from the list) lose only their rule-owned decision.
  await store.reconcileAutoShares(wanted)
  return { active: [...active], count: workspaces.length, sessions: Object.keys(wanted).length }
}

/** Best-effort: a newly announced Session joins a shared workspace immediately. */
export async function applyRulesToSession({ store, sessionId, cwd }) {
  const rules = await store.workspaceShares()
  if (rules.length === 0) return false
  const match = rules.find((rule) => pathMatches(rule.path, cwd))
  if (match === undefined) return false
  // `api-session/added` fires on ordinary agent churn too. Avoid rewriting
  // bridge.json (and re-sharing a Session the operator just unshared) unless
  // this is genuinely a new rule-owned decision.
  const existing = await store.autoShares()
  if (existing[sessionId] === match.workspaceId) return false
  // A Session the operator shared by hand is not ours to manage; adopting it
  // would make a later rule-off revoke the human's decision.
  const shared = new Set((await store.sharedSessions()).map((entry) => entry.sessionId))
  if (shared.has(sessionId)) return false
  await store.reconcileAutoShares({ ...existing, [sessionId]: match.workspaceId })
  return true
}

/**
 * Validate and apply one whole-workspace share change from the panel (or the
 * local tool). The workspace id must name a group the Host can currently see —
 * otherwise a typo would create a rule that matches nothing forever.
 */
export async function setWorkspaceShare({ ctx, store, workspaceId, shared, logger }) {
  const id = typeof workspaceId === 'string' ? workspaceId.trim() : ''
  if (id === '') throw new BridgeError('bridge/bad-request', 'workspaceId is required', {})
  const { workspaces } = await sessionGroups({ ctx, store })
  const group = workspaces.find((entry) => entry.workspaceId === id)
  if (group === undefined) {
    throw new BridgeError('bridge/bad-request', 'unknown workspace', { workspaceId: id })
  }
  const want = shared === true
  await store.setWorkspaceShared({ workspaceId: id, path: group.path, shared: want })
  const outcome = await materializeWorkspaceShares({ ctx, store })
  logger?.info?.(`lan-bridge: workspace ${id} ${want ? 'shared' : 'unshared'} (${String(outcome.count)} groups)`)
  return { ok: true, workspaceId: id, shared: want }
}
