/**
 * Handing a task to another machine.
 *
 * Ownership of a board task belongs to the machine that holds the record, so a
 * hand-over is a move: snapshot here, let the receiver adopt it, and only then
 * drop the local copy. Doing it in that order means a failed or refused
 * transfer leaves both boards exactly as they were — a task is never lost in
 * transit.
 *
 * @module dsh-lan-bridge/lib/transfer
 */

import { dropTask, snapshotTask } from './board.js'
import { requireString } from './util.js'

/**
 * Move one task from this machine's board to `to`.
 * @param options - `{ store, remote, cfg, taskId, to, expectedRevision? }`.
 * @returns `{ from, to, taskId, task }`, where `task` is the receiver's view.
 */
export async function handOver({ store, remote, cfg, taskId, to, expectedRevision, signal }) {
  const target = requireString(to, 'to', 64)
  if (target === cfg.name) {
    throw new Error('cannot hand a task to the machine that already owns it')
  }
  const request = { taskId, to: target }
  if (expectedRevision !== undefined) request.expectedRevision = expectedRevision
  const record = snapshotTask(await store.board(), request)
  const peer = await remote.peer(target)
  const value = await remote.rpc(peer, 'tasks.adopt', { task: record, from: cfg.name }, { signal, timeoutMs: 15_000 })
  await store.mutateBoard(board => {
    dropTask(board, record.id)
    return true
  })
  return { from: cfg.name, to: peer.name, taskId: record.id, task: value?.task ?? null }
}
