/**
 * Converging the goal document between two machines.
 *
 * Each machine keeps its own copy, ordered by revision. Convergence is a
 * two-step exchange: read the peer's copy, take it if it is newer, otherwise
 * offer ours if it is. An equal revision with different text is reported as a
 * divergence instead of being silently resolved — a shared plan that quietly
 * picks a winner is a plan nobody can trust.
 *
 * @module dsh-lan-bridge/lib/sync
 */

import { adoptGoal, getGoal } from './board.js'

/**
 * Bring this machine's goal and one peer's goal into agreement.
 * @param options - `{ store, remote, cfg, peer, signal }`.
 * @returns `{ machine, before, after, peerRevision, applied, pushed, diverged }`.
 */
export async function convergeGoal({ store, remote, cfg, peer, signal }) {
  const options = { signal, timeoutMs: 10_000 }
  const local = getGoal(await store.board())
  const remoteDoc = (await remote.rpc(peer, 'goal.get', {}, options))?.goal ?? { revision: 0, title: '', text: '' }
  let current = local
  let applied = false
  let pushed = false
  let diverged = false

  if ((remoteDoc.revision ?? 0) > (local.revision ?? 0)) {
    const adopted = await store.mutateBoard(board => adoptGoal(board, { goal: remoteDoc, from: peer.name }, cfg.name))
    applied = adopted.applied === true
    diverged = adopted.diverged === true
    current = adopted.goal
  } else if ((local.revision ?? 0) > (remoteDoc.revision ?? 0)) {
    const result = await remote.rpc(peer, 'goal.adopt', { goal: local, from: cfg.name }, options)
    pushed = result?.applied === true
    diverged = result?.diverged === true
  } else {
    diverged = (local.title ?? '') !== (remoteDoc.title ?? '') || (local.text ?? '') !== (remoteDoc.text ?? '')
  }

  return {
    machine: peer.name,
    before: local.revision ?? 0,
    after: current.revision ?? 0,
    peerRevision: remoteDoc.revision ?? 0,
    applied,
    pushed,
    diverged,
  }
}
