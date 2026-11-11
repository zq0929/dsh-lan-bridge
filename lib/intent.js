/**
 * The intent envelope: the "why" that rides along with a prompt.
 *
 * A prompt carries text, and text is all the receiving agent can read. That is
 * why a controller that only sends text looks, from the far side, like a stream
 * of sentences with no plan behind them. An intent envelope is a small, strictly
 * validated structure that says what the sender is trying to achieve, how it
 * plans to get there, what it expects back, and by when — and the bridge renders
 * it into a deterministic, clearly delimited block ahead of the text, so the
 * receiving model can act on the purpose instead of guessing it from prose.
 *
 * The envelope is advisory metadata: it never changes Session semantics, and a
 * receiver that ignores it still sees an ordinary prompt.
 */
import { BridgeError } from './util.js'

/** Byte ceilings for one envelope; the rendered block is bounded too. */
export const INTENT_LIMITS = {
  goalBytes: 2000,
  planItems: 20,
  planItemBytes: 500,
  expectsBytes: 2000,
  deadlineBytes: 200,
  formatBytes: 200,
  totalBytes: 8000,
}

/** The opening marker of a rendered block; stable by contract. */
export const INTENT_OPEN = '[lan-bridge intent]'
/** The closing marker of a rendered block; stable by contract. */
export const INTENT_CLOSE = '[/lan-bridge intent]'

/**
 * Byte length of a string in UTF-8.
 * @param value - string to measure.
 * @returns the byte count.
 */
function byteLength(value) {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * Read one optional free-form field.
 * @param value - candidate value.
 * @param field - field name used in the rejection detail.
 * @param limit - byte ceiling.
 * @returns the trimmed string, or `undefined` when the field is absent.
 */
function optionalNote(value, field, limit) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new BridgeError('bridge/bad-request', `intent.${field} must be a string`, { field: `intent.${field}` })
  }
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (byteLength(trimmed) > limit) {
    throw new BridgeError('bridge/bad-request', `intent.${field} exceeds ${String(limit)} bytes`, { field: `intent.${field}` })
  }
  return trimmed
}

/**
 * Validate an intent envelope from an untrusted peer.
 *
 * Unknown properties are dropped rather than rejected: the envelope is
 * advisory, and a newer peer sending a field this build does not know must not
 * fail the prompt underneath it.
 * @param raw - the untrusted value from the request body.
 * @returns the normalized envelope, or `undefined` when none was supplied.
 */
export function parseIntent(raw) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BridgeError('bridge/bad-request', 'intent must be an object', { field: 'intent' })
  }
  const goal = optionalNote(raw.goal, 'goal', INTENT_LIMITS.goalBytes)
  if (goal === undefined) {
    throw new BridgeError('bridge/bad-request', 'intent.goal is required', { field: 'intent.goal' })
  }
  let plan
  if (raw.plan !== undefined && raw.plan !== null) {
    if (!Array.isArray(raw.plan)) {
      throw new BridgeError('bridge/bad-request', 'intent.plan must be an array of strings', { field: 'intent.plan' })
    }
    if (raw.plan.length > INTENT_LIMITS.planItems) {
      throw new BridgeError('bridge/bad-request', `intent.plan accepts at most ${String(INTENT_LIMITS.planItems)} steps`, { field: 'intent.plan' })
    }
    plan = []
    for (const [index, step] of raw.plan.entries()) {
      if (typeof step !== 'string' || step.trim() === '') {
        throw new BridgeError('bridge/bad-request', `intent.plan[${String(index)}] must be a non-empty string`, { field: 'intent.plan' })
      }
      const trimmed = step.trim()
      if (byteLength(trimmed) > INTENT_LIMITS.planItemBytes) {
        throw new BridgeError('bridge/bad-request', `intent.plan[${String(index)}] exceeds ${String(INTENT_LIMITS.planItemBytes)} bytes`, { field: 'intent.plan' })
      }
      plan.push(trimmed)
    }
  }
  const intent = { goal }
  if (plan !== undefined && plan.length > 0) intent.plan = plan
  const expects = optionalNote(raw.expects, 'expects', INTENT_LIMITS.expectsBytes)
  if (expects !== undefined) intent.expects = expects
  const deadline = optionalNote(raw.deadline, 'deadline', INTENT_LIMITS.deadlineBytes)
  if (deadline !== undefined) intent.deadline = deadline
  const format = optionalNote(raw.format, 'format', INTENT_LIMITS.formatBytes)
  if (format !== undefined) intent.format = format
  if (byteLength(JSON.stringify(intent)) > INTENT_LIMITS.totalBytes) {
    throw new BridgeError('bridge/bad-request', `intent exceeds ${String(INTENT_LIMITS.totalBytes)} bytes`, { field: 'intent' })
  }
  return intent
}

/**
 * Render one envelope into the block prepended to the prompt text.
 * @param intent - normalized envelope.
 * @returns the rendered block, ending with a blank line.
 */
export function renderIntentBlock(intent) {
  const lines = [INTENT_OPEN, `goal: ${intent.goal}`]
  if (intent.plan !== undefined) {
    lines.push('plan:')
    for (const [index, step] of intent.plan.entries()) lines.push(`${String(index + 1)}. ${step}`)
  }
  if (intent.expects !== undefined) lines.push(`expects: ${intent.expects}`)
  if (intent.deadline !== undefined) lines.push(`deadline: ${intent.deadline}`)
  if (intent.format !== undefined) lines.push(`format: ${intent.format}`)
  lines.push(INTENT_CLOSE, '')
  return `${lines.join('\n')}\n`
}

/**
 * Join an envelope and the prompt text into the single text part the Session
 * receives. Text without an envelope is returned unchanged, byte for byte.
 * @param intent - normalized envelope, or `undefined`.
 * @param text - the operator-authored prompt text.
 * @returns the text to submit.
 */
export function composePrompt(intent, text) {
  if (intent === undefined) return text
  return `${renderIntentBlock(intent)}${text}`
}

/**
 * One-line summary for tool rendering and logs.
 * @param intent - normalized envelope.
 * @returns a short human-readable summary.
 */
export function summarizeIntent(intent) {
  if (intent === undefined) return ''
  const steps = intent.plan === undefined ? 0 : intent.plan.length
  const parts = [`goal=${intent.goal}`]
  if (steps > 0) parts.push(`steps=${String(steps)}`)
  if (intent.expects !== undefined) parts.push(`expects=${intent.expects}`)
  return parts.join('; ')
}
