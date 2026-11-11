/**
 * The shared board: tasks and one goal document that two machines converge on.
 *
 * Chat only carries utterances. A board carries state: what is being worked on,
 * what blocks what, and what "done" means. Two machines cannot share one
 * journal, so the board is replicated instead of centralised — each machine owns
 * the tasks it created and is the only writer of them, which removes conflicts
 * by construction. The goal document is the single place both sides write, and
 * it is protected by compare-and-set revisions rather than by locking.
 *
 * Replication is pull-based: reading the board merges each peer's own tasks.
 * That is eventually consistent on purpose — a board that cannot be written
 * while a peer is offline would be useless on a LAN.
 */
import { BridgeError, requireString } from './util.js'

/** Task lifecycle states. Readiness is derived, never stored. */
export const TASK_STATUSES = ['pending', 'in_progress', 'completed']

/** Supported compare-and-set actions on one task. */
export const TASK_ACTIONS = ['claim', 'release', 'complete', 'reopen', 'edit', 'set_dependencies', 'reassign', 'delete']

/** Caps that keep one board file bounded. */
export const BOARD_LIMITS = {
  tasks: 200,
  subjectBytes: 200,
  descriptionBytes: 4000,
  blockedByItems: 20,
  writeScopesItems: 40,
  writeScopeBytes: 200,
  goalTitleBytes: 200,
  goalTextBytes: 20000,
  tombstones: 50,
}

/**
 * Fresh board state.
 * @returns the empty board.
 */
export function emptyBoard() {
  return {
    tasks: {},
    goal: { revision: 0, title: '', text: '', updatedBy: '', updatedAt: 0 },
    // Deleting is a real delete from the board, but not from the record: the
    // tombstone keeps the subject and who removed it, so a reader never has to
    // wonder whether a task vanished or was never there.
    tombstones: [],
  }
}

/**
 * Byte length helper.
 * @param value - string.
 * @returns bytes.
 */
function bytes(value) {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * Read one bounded string field.
 * @param value - candidate.
 * @param field - error field name.
 * @param limit - byte ceiling.
 * @param required - whether absence is an error.
 * @returns the trimmed value or `undefined`.
 */
function bounded(value, field, limit, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new BridgeError('bridge/bad-request', `${field} is required`, { field })
    return undefined
  }
  if (typeof value !== 'string') {
    throw new BridgeError('bridge/bad-request', `${field} must be a string`, { field })
  }
  const trimmed = value.trim()
  if (trimmed === '') {
    if (required) throw new BridgeError('bridge/bad-request', `${field} must be a non-empty string`, { field })
    return undefined
  }
  if (bytes(trimmed) > limit) {
    throw new BridgeError('bridge/bad-request', `${field} exceeds ${String(limit)} bytes`, { field })
  }
  return trimmed
}

/**
 * Read one bounded array of short strings.
 * @param value - candidate.
 * @param field - error field name.
 * @param items - item ceiling.
 * @param itemBytes - per-item byte ceiling.
 * @returns the list or `undefined`.
 */
function boundedList(value, field, items, itemBytes) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new BridgeError('bridge/bad-request', `${field} must be an array`, { field })
  if (value.length > items) {
    throw new BridgeError('bridge/bad-request', `${field} accepts at most ${String(items)} entries`, { field })
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new BridgeError('bridge/bad-request', `${field}[${String(index)}] must be a non-empty string`, { field })
    }
    const trimmed = entry.trim()
    if (bytes(trimmed) > itemBytes) {
      throw new BridgeError('bridge/bad-request', `${field}[${String(index)}] exceeds ${String(itemBytes)} bytes`, { field })
    }
    return trimmed
  })
}

/**
 * Whether a task has no incomplete blocker among the tasks this board knows.
 * @param tasks - task map keyed by id.
 * @param task - the task to test.
 * @returns readiness; unknown blockers count as incomplete.
 */
function ready(tasks, task) {
  if (task.status !== 'pending') return false
  return task.blockedBy.every((id) => {
    const blocker = tasks[id]
    return blocker !== undefined && blocker.status === 'completed'
  })
}

/**
 * Project one stored task into its wire view.
 * @param tasks - task map, for readiness.
 * @param task - stored task.
 * @returns the view.
 */
function viewOf(tasks, task) {
  const view = {
    id: task.id,
    revision: task.revision,
    subject: task.subject,
    description: task.description,
    status: task.status,
    blockedBy: [...task.blockedBy],
    writeScopes: [...task.writeScopes],
    ready: ready(tasks, task),
    createdBy: task.createdBy,
    updatedBy: task.updatedBy,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
  if (task.assignee !== undefined) view.assignee = task.assignee
  // A handed-over task says where it came from, so a reader never mistakes it
  // for something this machine decided to do on its own.
  if (task.origin !== undefined) view.origin = task.origin
  return view
}

/**
 * List the tasks of one board, oldest first.
 * @param board - board state.
 * @returns task views.
 */
export function listTasks(board) {
  const tasks = board?.tasks ?? {}
  return Object.values(tasks)
    .sort((left, right) => left.createdAt - right.createdAt)
    .map(task => viewOf(tasks, task))
}

/**
 * Create one task owned by this machine.
 * @param board - board state (mutated in place).
 * @param raw - untrusted request.
 * @param who - machine name recorded as creator.
 * @returns the new task view.
 */
export function createTask(board, raw, who) {
  const subject = requireString(raw.subject, 'subject', BOARD_LIMITS.subjectBytes)
  const description = bounded(raw.description, 'description', BOARD_LIMITS.descriptionBytes) ?? ''
  const blockedBy = boundedList(raw.blockedBy, 'blockedBy', BOARD_LIMITS.blockedByItems, 80) ?? []
  const writeScopes = boundedList(raw.writeScopes, 'writeScopes', BOARD_LIMITS.writeScopesItems, BOARD_LIMITS.writeScopeBytes) ?? []
  const assignee = bounded(raw.assignee, 'assignee', 200)
  const now = Date.now()
  const id = `t-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const task = {
    id,
    subject,
    description,
    status: 'pending',
    blockedBy,
    writeScopes,
    revision: 1,
    createdBy: who,
    updatedBy: who,
    createdAt: now,
    updatedAt: now,
  }
  if (assignee !== undefined) task.assignee = assignee
  board.tasks[id] = task
  const ids = Object.keys(board.tasks)
  if (ids.length > BOARD_LIMITS.tasks) {
    const oldest = ids
      .map(key => ({ key, at: board.tasks[key].createdAt }))
      .sort((left, right) => left.at - right.at)
      .slice(0, ids.length - BOARD_LIMITS.tasks)
    for (const entry of oldest) delete board.tasks[entry.key]
  }
  return viewOf(board.tasks, task)
}

/**
 * Read one task record for hand-over, keeping every stored field.
 *
 * Ownership transfer is a move, not a copy: the sending board drops the record
 * only after the receiving board has accepted it, so a failed hand-over leaves
 * the task exactly where it was. Completed tasks are refused — they are the
 * history both sides read, and moving one would erase the trail.
 * @param board - board state.
 * @param raw - `{ taskId, expectedRevision? }`.
 * @returns a detached copy of the stored record.
 */
export function snapshotTask(board, raw) {
  const taskId = requireString(raw.taskId, 'taskId', 80)
  const task = board.tasks[taskId]
  if (task === undefined) {
    throw new BridgeError('board/not-found', `task ${taskId} is not on this board`, { taskId })
  }
  const expected = raw.expectedRevision
  if (expected !== undefined) {
    if (!Number.isInteger(expected) || expected < 1) {
      throw new BridgeError('bridge/bad-request', 'expectedRevision must be a positive integer', { field: 'expectedRevision' })
    }
    if (task.revision !== expected) {
      throw new BridgeError('board/conflict', `task ${taskId} is at revision ${String(task.revision)}, not ${String(expected)}`, {
        taskId,
        currentRevision: task.revision,
        task: viewOf(board.tasks, task),
      })
    }
  }
  if (task.status === 'completed') {
    throw new BridgeError('bridge/forbidden', `task ${taskId} is completed; completed tasks stay as history`, { taskId })
  }
  return structuredClone(task)
}

/**
 * Remove one task from this board (the second half of a hand-over).
 * @param board - board state (mutated in place).
 * @param taskId - task to drop.
 * @returns whether it was there.
 */
export function dropTask(board, taskId) {
  if (board.tasks[taskId] === undefined) return false
  delete board.tasks[taskId]
  return true
}

/**
 * Accept a task handed over by another machine.
 *
 * The receiving board becomes the owner, which is what makes the task editable
 * on this side afterwards. The record keeps its history in `origin`; blockers
 * that point at tasks this board does not know are dropped, because a blocker
 * nobody can complete would block the task forever.
 * @param board - board state (mutated in place).
 * @param raw - `{ task, from }`, where `task` is a detached record.
 * @param who - machine name recorded as the new owner-side editor.
 * @returns the adopted task view.
 */
export function adoptTask(board, raw, who) {
  const incoming = raw?.task
  if (incoming === null || typeof incoming !== 'object') {
    throw new BridgeError('bridge/bad-request', 'task is required', { field: 'task' })
  }
  const from = requireString(raw.from, 'from', 64)
  const subject = requireString(incoming.subject, 'subject', BOARD_LIMITS.subjectBytes)
  const description = bounded(incoming.description, 'description', BOARD_LIMITS.descriptionBytes) ?? ''
  const writeScopes = boundedList(incoming.writeScopes, 'writeScopes', BOARD_LIMITS.writeScopesItems, BOARD_LIMITS.writeScopeBytes) ?? []
  const assignee = bounded(incoming.assignee, 'assignee', 200)
  const status = incoming.status === undefined ? 'pending' : incoming.status
  if (!TASK_STATUSES.includes(status)) {
    throw new BridgeError('bridge/bad-request', `status must be one of ${TASK_STATUSES.join(', ')}`, { field: 'status' })
  }
  const requestedBlockers = boundedList(incoming.blockedBy, 'blockedBy', BOARD_LIMITS.blockedByItems, 80) ?? []
  const blockedBy = requestedBlockers.filter(id => board.tasks[id] !== undefined)
  const now = Date.now()
  let id = typeof incoming.id === 'string' && /^t-[a-z0-9-]{1,60}$/.test(incoming.id) ? incoming.id : `t-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  if (board.tasks[id] !== undefined) id = `t-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const task = {
    id,
    subject,
    description,
    status,
    blockedBy,
    writeScopes,
    revision: 1,
    createdBy: who,
    updatedBy: who,
    createdAt: now,
    updatedAt: now,
    origin: {
      machine: from,
      taskId: typeof incoming.id === 'string' ? incoming.id : '',
      revision: Number.isInteger(incoming.revision) ? incoming.revision : 0,
      at: now,
      droppedBlockers: requestedBlockers.length - blockedBy.length,
    },
  }
  if (assignee !== undefined) task.assignee = assignee
  board.tasks[id] = task
  const ids = Object.keys(board.tasks)
  if (ids.length > BOARD_LIMITS.tasks) {
    const oldest = ids
      .map(key => ({ key, at: board.tasks[key].createdAt }))
      .sort((left, right) => left.at - right.at)
      .slice(0, ids.length - BOARD_LIMITS.tasks)
    for (const entry of oldest) delete board.tasks[entry.key]
  }
  return viewOf(board.tasks, task)
}

/**
 * Apply one compare-and-set mutation to a task owned by this machine.
 * @param board - board state (mutated in place).
 * @param raw - untrusted request.
 * @param who - machine name recorded as updater.
 * @returns the updated task view.
 */
export function updateTask(board, raw, who) {
  const taskId = requireString(raw.taskId, 'taskId', 80)
  const action = requireString(raw.action, 'action', 40)
  if (!TASK_ACTIONS.includes(action)) {
    throw new BridgeError('bridge/bad-request', `action must be one of ${TASK_ACTIONS.join(', ')}`, { field: 'action' })
  }
  const expected = raw.expectedRevision
  if (!Number.isInteger(expected) || expected < 1) {
    throw new BridgeError('bridge/bad-request', 'expectedRevision must be a positive integer', { field: 'expectedRevision' })
  }
  const task = board.tasks[taskId]
  if (task === undefined) {
    throw new BridgeError('board/not-found', `task ${taskId} is not on this board`, { taskId })
  }
  if (task.revision !== expected) {
    throw new BridgeError('board/conflict', `task ${taskId} is at revision ${String(task.revision)}, not ${String(expected)}`, {
      taskId,
      currentRevision: task.revision,
      task: viewOf(board.tasks, task),
    })
  }
  switch (action) {
    case 'claim': {
      task.status = 'in_progress'
      const assignee = bounded(raw.assignee, 'assignee', 200)
      if (assignee !== undefined) task.assignee = assignee
      else if (task.assignee === undefined) task.assignee = who
      break
    }
    case 'release': {
      task.status = 'pending'
      delete task.assignee
      break
    }
    case 'complete':
      task.status = 'completed'
      break
    case 'reopen':
      task.status = 'pending'
      delete task.assignee
      break
    case 'edit': {
      const subject = bounded(raw.subject, 'subject', BOARD_LIMITS.subjectBytes)
      const description = bounded(raw.description, 'description', BOARD_LIMITS.descriptionBytes)
      if (subject === undefined && description === undefined) {
        throw new BridgeError('bridge/bad-request', 'edit needs subject or description', { field: 'subject' })
      }
      if (subject !== undefined) task.subject = subject
      if (description !== undefined) task.description = description
      break
    }
    case 'set_dependencies':
      task.blockedBy = boundedList(raw.blockedBy, 'blockedBy', BOARD_LIMITS.blockedByItems, 80) ?? []
      break
    case 'reassign': {
      const assignee = bounded(raw.assignee, 'assignee', 200)
      if (assignee === undefined) {
        delete task.assignee
      } else {
        task.assignee = assignee
        if (task.status === 'pending') task.status = 'in_progress'
      }
      break
    }
    case 'delete': {
      // Deleting a blocker would silently stall everything that waits on it, so
      // the caller is told who depends on the task and must repeat with
      // `force: true` to accept that consequence.
      const dependents = Object.values(board.tasks)
        .filter(other => other.id !== taskId && other.blockedBy.includes(taskId))
        .map(other => viewOf(board.tasks, other))
      if (dependents.length > 0 && raw.force !== true) {
        throw new BridgeError('board/conflict', `task ${taskId} still blocks ${String(dependents.length)} task(s); repeat with force=true to delete it anyway`, {
          taskId,
          dependents,
        })
      }
      delete board.tasks[taskId]
      // A forced delete must not leave anyone waiting forever: the dependents
      // are re-pointed at nothing (their blocker list loses this id) and get a
      // revision bump, so the board never shows a task stuck on a ghost.
      const relinked = []
      for (const other of Object.values(board.tasks)) {
        if (!other.blockedBy.includes(taskId)) continue
        other.blockedBy = other.blockedBy.filter(id => id !== taskId)
        other.revision += 1
        other.updatedBy = who
        other.updatedAt = Date.now()
        relinked.push(other.id)
      }
      const tombstones = board.tombstones ?? []
      tombstones.push({
        id: taskId,
        subject: task.subject,
        status: task.status,
        revision: task.revision,
        deletedBy: who,
        deletedAt: Date.now(),
      })
      // Keep the trail bounded: the oldest tombstone is the least interesting.
      board.tombstones = tombstones.slice(-BOARD_LIMITS.tombstones)
      return { deleted: true, taskId, subject: task.subject, dependents, relinked }
    }
    default:
      throw new BridgeError('bridge/bad-request', `unsupported action ${action}`, { field: 'action' })
  }
  task.revision += 1
  task.updatedBy = who
  task.updatedAt = Date.now()
  return viewOf(board.tasks, task)
}

/**
 * Read the goal document.
 * @param board - board state.
 * @returns the goal with its revision.
 */
export function getGoal(board) {
  const goal = board?.goal ?? emptyBoard().goal
  return {
    revision: goal.revision,
    title: goal.title,
    text: goal.text,
    updatedBy: goal.updatedBy,
    updatedAt: goal.updatedAt,
  }
}

/**
 * Compare-and-set the goal document.
 *
 * Both machines write here, so the revision is the only thing standing between
 * a deliberate edit and a silent overwrite: a stale `expectedRevision` is
 * refused with the current revision attached, and the caller re-reads.
 * @param board - board state (mutated in place).
 * @param raw - untrusted request.
 * @param who - machine name recorded as writer.
 * @returns the new goal.
 */
export function setGoal(board, raw, who) {
  const expected = raw.expectedRevision
  if (!Number.isInteger(expected) || expected < 0) {
    throw new BridgeError('bridge/bad-request', 'expectedRevision must be a non-negative integer', { field: 'expectedRevision' })
  }
  const current = getGoal(board)
  if (current.revision !== expected) {
    throw new BridgeError('board/conflict', `goal is at revision ${String(current.revision)}, not ${String(expected)}`, {
      currentRevision: current.revision,
      goal: current,
    })
  }
  const title = bounded(raw.title, 'title', BOARD_LIMITS.goalTitleBytes)
  const text = bounded(raw.text, 'text', BOARD_LIMITS.goalTextBytes, true)
  const next = {
    revision: current.revision + 1,
    title: title === undefined ? current.title : title,
    text,
    updatedBy: who,
    updatedAt: Date.now(),
  }
  board.goal = next
  return { ...next }
}

/**
 * Empty the goal document while keeping its revision history monotonic.
 *
 * A cleared goal is not revision 0: the next writer must still present the
 * revision they read, so two machines cannot fight over "empty".
 * @param board - board state (mutated in place).
 * @param raw - `{ expectedRevision }`.
 * @param who - machine name recorded as the clearer.
 * @returns the cleared goal, with `cleared: true`.
 */
export function clearGoal(board, raw, who) {
  const current = board.goal
  const expected = raw.expectedRevision
  if (!Number.isInteger(expected) || expected < 0) {
    throw new BridgeError('bridge/bad-request', 'expectedRevision must be a non-negative integer', { field: 'expectedRevision' })
  }
  if (current.revision !== expected) {
    throw new BridgeError('board/conflict', `goal is at revision ${String(current.revision)}, not ${String(expected)}`, {
      currentRevision: current.revision,
      goal: { ...current },
    })
  }
  const next = {
    revision: current.revision + 1,
    title: '',
    text: '',
    updatedBy: who,
    updatedAt: Date.now(),
  }
  board.goal = next
  return { ...next, cleared: true }
}

/**
 * Take a peer's goal document when it is genuinely newer.
 *
 * Two machines keep two copies, so "converged" has to mean something
 * mechanical: the copy with the higher revision wins, and an equal revision
 * with different content is a divergence the caller must be told about rather
 * than silently resolved (silently picking one is how a shared plan rots).
 * @param board - board state (mutated in place).
 * @param raw - `{ goal, from }`, where `goal` is the peer's document.
 * @param who - machine that offered the document.
 * @returns `{ applied, goal, diverged }`.
 */
export function adoptGoal(board, raw, who) {
  const incoming = raw?.goal
  if (incoming === null || typeof incoming !== 'object') {
    throw new BridgeError('bridge/bad-request', 'goal is required', { field: 'goal' })
  }
  const from = requireString(raw.from, 'from', 64)
  const revision = incoming.revision
  if (!Number.isInteger(revision) || revision < 0) {
    throw new BridgeError('bridge/bad-request', 'goal.revision must be a non-negative integer', { field: 'goal.revision' })
  }
  const title = bounded(incoming.title, 'title', BOARD_LIMITS.goalTitleBytes) ?? ''
  const text = bounded(incoming.text, 'text', BOARD_LIMITS.goalTextBytes) ?? ''
  const current = board.goal
  if (revision < current.revision) {
    return { applied: false, diverged: false, goal: { ...current }, reason: 'local copy is newer' }
  }
  if (revision === current.revision) {
    const same = current.title === title && current.text === text
    return {
      applied: false,
      diverged: !same,
      goal: { ...current },
      reason: same ? 'already converged' : 'same revision, different text',
    }
  }
  board.goal = {
    revision,
    title,
    text,
    updatedBy: typeof incoming.updatedBy === 'string' && incoming.updatedBy !== '' ? incoming.updatedBy : from,
    updatedAt: typeof incoming.updatedAt === 'number' ? incoming.updatedAt : Date.now(),
    appliedFrom: from,
  }
  return { applied: true, diverged: false, goal: { ...board.goal } }
}

/**
 * Prefix task ids with the machine that owns them, so a merged board has one
 * namespace and two machines cannot collide on `t-…` ids.
 * @param machine - owning machine name.
 * @param tasks - task views from that machine.
 * @returns qualified views.
 */
export function qualify(machine, tasks) {
  return tasks.map(task => ({ ...task, machine, qualifiedId: `${machine}/${task.id}` }))
}
