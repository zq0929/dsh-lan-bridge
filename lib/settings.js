/**
 * Apply one operator settings patch to the running Host.
 *
 * This is the only path that changes the listener while the process lives: the
 * panel posts here, the validator in config.js decides what is legal, the
 * listener rebinds itself (and rolls back on failure), and the accepted values
 * are persisted so the next Host start comes up the same way. Keeping it in its
 * own module means the offline harness exercises exactly the code the panel
 * hits, not a copy of it.
 */
import { EDITABLE_KEYS, assignSettings, settingsOf, validateSettingsPatch } from './config.js'

/**
 * Replay settings saved by a previous run onto a freshly resolved config.
 *
 * The panel's values win over the bundle row, which is why a host change made
 * in the UI survives a Host restart without touching `cordis.patch.yml`. An
 * invalid or now-illegal saved value is ignored (never fatal): the safest
 * outcome of a stale file is to come up in the row's posture.
 *
 * @param options - `{ cfg, store, logger }`.
 * @returns `{ applied: string[], ignored?: string }`.
 */
export async function loadPersistedSettings({ cfg, store, logger }) {
  let persisted
  try {
    persisted = await store.settings()
  } catch (error) {
    return { applied: [], ignored: `unreadable settings: ${String(error)}` }
  }
  if (persisted === null || typeof persisted !== 'object' || Object.keys(persisted).length === 0) {
    return { applied: [] }
  }
  const { next, error } = validateSettingsPatch(cfg, persisted)
  if (error !== undefined) {
    logger?.warn?.(`lan-bridge: saved settings ignored — ${error.message}`)
    return { applied: [], ignored: error.message }
  }
  assignSettings(cfg, next)
  const applied = Object.keys(persisted)
  logger?.info?.(`lan-bridge: applied saved settings (${applied.join(', ')})`)
  return { applied }
}

/**
 * Build the settings applier.
 * @param options - `{ cfg, store, server, logger, ready }`.
 * @returns `async (input) => { ok: true } | { ok: false, error }`.
 */
export function createSettingsApplier({ cfg, store, server, logger, ready }) {
  const readyPromise = ready === undefined ? Promise.resolve() : ready

  return async function applySettings(input) {
    await readyPromise
    const { next, error } = validateSettingsPatch(cfg, input)
    if (error !== undefined) return { ok: false, error }
    try {
      await server.reconfigure(next)
    } catch (failure) {
      const detail = failure instanceof Error ? failure.message : String(failure)
      logger?.warn?.(`lan-bridge: settings change failed — ${detail}`)
      return { ok: false, error: { code: 'bridge/internal', message: detail, details: {} } }
    }
    const persisted = {}
    for (const key of EDITABLE_KEYS) persisted[key] = next[key]
    // `store.updateSettings` merges, so a future patch carrying a subset of the
    // form still keeps every knob saved earlier.
    await store.updateSettings(persisted)
    await store.audit({ peer: 'operator', method: 'settings.update', ok: true, fields: Object.keys(input ?? {}) })
    const view = settingsOf(cfg)
    logger?.info?.(`lan-bridge: settings applied — ${view.host}:${String(view.port)} tls=${view.tls === null ? 'off' : 'on'} create=${cfg.allowPeersToCreateSessions ? 'allowed' : 'refused'}`)
    return { ok: true }
  }
}
