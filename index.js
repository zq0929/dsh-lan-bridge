/**
 * lan-dsh-bridge — Host half.
 *
 * One bundle, two roles. As a listener this machine publishes a private socket
 * through which paired DSH peers may read, prompt and cancel the Sessions its
 * operator explicitly shared. As a controller it gives the local agent tools to
 * do the same to a peer. Both directions are off by default: no peer is
 * configured, no Session is shared, and nothing but loopback is ever bound.
 *
 * The wire contract lives in PROTOCOL.md next to this file.
 */
import { VERSION, resolveConfig } from './lib/config.js'
import { createStore } from './lib/store.js'
import { createApi } from './lib/api.js'
import { createServer } from './lib/server.js'
import { createPeerCache, createRemote } from './lib/remote.js'
import { installTools } from './lib/tools.js'
import { installUi } from './lib/ui.js'
import { createSettingsApplier, loadPersistedSettings } from './lib/settings.js'
import { createDiscovery } from './lib/mdns.js'

/** Loader entry identity, matching the row id in `cordis.patch.yml`. */
export const name = 'lan-bridge'

/** The panel routes need the browser Fetch carrier; everything else is optional. */
export const inject = ['connection']

/**
 * Mount the bridge.
 * @param ctx - the plugin context.
 * @param config - this row's `config:` block.
 */
export function apply(ctx, config) {
  const logger = ctx.logger
  const cfg = resolveConfig(config)
  if (cfg.name === '') cfg.name = process.env.HOSTNAME ?? 'this-machine'

  const store = createStore({ stateDir: cfg.stateDir, audit: cfg.audit, logger })
  // The remote client is built first: handing a task over needs both halves,
  // the api that executes the move and the client that reaches the receiver.
  const remote = createRemote({ cfg, store, logger })
  const api = createApi({ ctx, cfg, store, logger, remote })
  const server = createServer({ ctx, cfg, store, api, logger })
  const peerCache = createPeerCache()

  // Settings saved from the panel outlive the bundle row: they are stored in
  // `bridge.json` and win over `cordis.patch.yml`, so a host change made in the
  // UI survives a Host restart without anyone editing YAML.
  const ready = loadPersistedSettings({ cfg, store, logger })

  if (cfg.listening) {
    ctx.effect(() => {
      let stopped = false
      void ready
        .then(() => server.start())
        .catch((error) => {
          logger?.warn?.(`lan-bridge: listener start failed: ${String(error)}`)
        })
      return () => {
        if (stopped) return
        stopped = true
        void server.stop().catch(() => {})
      }
    }, 'lan-bridge: listener')
  }

  // mDNS is how a peer finds this machine without anyone typing an address.
  // It carries the name, port and version only — never a token, so discovery
  // narrows "where" and pairing still decides "who may".
  const discovery = createDiscovery({ cfg, logger, portOf: () => server.status.port ?? cfg.port })
  ctx.effect(() => {
    let stopped = false
    // Wait for the persisted settings: the switch lives in bridge.json, and it
    // must win over the row config, so reading `cfg` before `ready` would start
    // (or skip) the responder based on the wrong value.
    void ready.then(() => {
      if (stopped || cfg.discovery.enabled !== true) return
      void discovery.start()
    })
    return () => {
      if (stopped) return
      stopped = true
      discovery.stop()
    }
  }, 'lan-bridge: mdns')

  const applySettings = createSettingsApplier({ cfg, store, server, logger, ready })

  if (cfg.controlling) {
    installTools({ ctx, cfg, store, remote, server, logger, peerCache, discovery })
  }

  installUi({ ctx, cfg, store, server, remote, peerCache, logger, ready, applySettings, discovery })

  // One line the operator can find in the Host log: the bridge's whole posture.
  logger?.info?.(
    `lan-bridge v${VERSION}: role=${cfg.role} name=${cfg.name} state=${cfg.stateDir} `
    + `listen=${cfg.listening ? `${cfg.hostname}:${String(cfg.port)}` : 'off'} `
    + `tools=${cfg.controlling ? 'on' : 'off'} create=${cfg.allowPeersToCreateSessions ? 'allowed' : 'refused'} `
    + `discovery=${cfg.discovery.enabled ? 'on' : 'off'}`,
  )
}
