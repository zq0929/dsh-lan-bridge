/**
 * Browser-facing routes for the bridge panel.
 *
 * These are registered on the DSH Web listener through `ctx.connection.fetch`,
 * so only this profile's own GUI (with its launch-token cookie) can call them.
 * A LAN peer can never reach them: peers use the bridge's own socket and
 * bearer tokens. That separation is the whole point — the panel is the human's
 * control surface, not a remote API.
 */
import { BridgeError } from './util.js'
import { CAPABILITIES, DEFAULT_CAPABILITIES, localAddresses, settingsOf } from './config.js'
import { versionInfo } from './version.js'
import { describePeer } from './remote.js'
import { sessionGroups, setWorkspaceShare } from './workspaces.js'

const BASE = '/api/lan-bridge'

/**
 * Register the panel routes.
 * @param options - `{ ctx, cfg, store, server, remote, peerCache, logger }`.
 */
export function installUi({ ctx, cfg, store, server, remote, peerCache, logger, ready, applySettings, discovery }) {
  const readyPromise = ready === undefined ? Promise.resolve() : ready

  /** The listen settings as the panel edits them, plus the local address list. */
  async function settingsState() {
    await readyPromise
    return {
      settings: settingsOf(cfg),
      addresses: localAddresses(),
      restartRequired: false,
    }
  }
  const connection = ctx.get('connection')
  if (connection === undefined) {
    logger?.info?.('lan-bridge: no connection service; the panel routes are not registered')
    return
  }
  const fetchService = connection.fetch
  if (fetchService === undefined) {
    logger?.info?.('lan-bridge: connection exposes no fetch carrier; the panel routes are not registered')
    return
  }

  /** `sessions` is the flat legacy view; `workspaces` is the grouped view.
   * Both come from one pass so their `shared` flags never disagree. */
  async function state() {
    await readyPromise
    const outbound = []
    for (const record of await store.outbound()) {
      outbound.push(await describePeer(remote, record, peerCache, logger))
    }
    const { workspaces, sessions } = await sessionGroups({ ctx, store })
    return {
      role: cfg.role,
      name: cfg.name,
      listen: {
        host: server.status.host,
        port: server.status.port,
        protocol: server.status.protocol,
        listening: server.status.listening,
        error: server.status.error,
      },
      // `running` is the code this Host loaded; `disk` is what an upgrade left
      // behind. They differ until the Host restarts, and nothing else in the UI
      // can tell an operator that.
      version: await versionInfo(),
      capabilities: CAPABILITIES,
      limits: {
        maxPromptBytes: cfg.maxPromptBytes,
        maxWaitMs: cfg.maxWaitMs,
        maxMessages: cfg.maxMessages,
        rateLimitPerMinute: cfg.rateLimitPerMinute,
        allowPeersToCreateSessions: cfg.allowPeersToCreateSessions === true,
      },
      // `enabled` is the operator's stored decision, never the responder's
      // liveness: a discovery switch that is on but failed to bind must still
      // read as "on" so the panel can show why it is not announcing.
      discovery: {
        enabled: cfg.discovery?.enabled === true,
        ...(discovery === undefined
          ? { listening: false, error: undefined, found: [] }
          : discovery.status()),
      },
      // The panel's file card reads the same posture the peer sees, so an
      // operator can tell "on but no roots" from "off" without guessing.
      files: {
        enabled: cfg.files?.enabled === true,
        maxFileBytes: cfg.files?.maxFileBytes ?? 0,
        chunkBytes: cfg.files?.chunkBytes ?? 0,
        roots: (cfg.files?.roots ?? []).map(root => ({ name: root.name, writable: root.writable === true })),
      },
      inbound: await store.inbound(),
      outbound,
      audit: await store.auditTail(20),
      sessions,
      workspaces,
      ...(await settingsState()),
    }
  }

  /** Read one JSON body, tolerating an absent body. */
  async function body(request) {
    try {
      const text = await request.text()
      if (text.trim() === '') return {}
      const parsed = JSON.parse(text)
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      throw new BridgeError('bridge/bad-request', 'request body must be JSON', {})
    }
  }

  const routes = [
    {
      path: `${BASE}.state`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => respond(await state()),
    },
    {
      path: `${BASE}.share`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const input = await body(request)
        const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
        if (sessionId === '') throw new BridgeError('bridge/bad-request', 'sessionId is required', {})
        await store.setShared(sessionId, input.shared === true)
        return respond({ ok: true, sessionId, shared: input.shared === true })
      },
    },
    {
      path: `${BASE}.shareWorkspace`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const input = await body(request)
        const result = await setWorkspaceShare({
          ctx,
          store,
          workspaceId: input.workspaceId,
          shared: input.shared,
          logger,
        })
        return respond(result)
      },
    },
    {
      path: `${BASE}.pair`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const input = await body(request)
        const name = typeof input.name === 'string' ? input.name.trim() : ''
        if (name === '') throw new BridgeError('bridge/bad-request', 'name is required', {})
        if (name.length > 64) throw new BridgeError('bridge/bad-request', 'name is limited to 64 characters', {})
        // The panel may mint any subset of CAPABILITIES, including the ones the
        // operator rarely wants (control, create, archive, collab). Unknown
        // names are dropped here rather than trusted; an empty result is a
        // refusal, because a token that can do nothing is never the intent.
        const requested = Array.isArray(input.capabilities) ? input.capabilities : DEFAULT_CAPABILITIES
        const capabilities = [...new Set(requested.filter(value => CAPABILITIES.includes(value)))]
        if (capabilities.length === 0) {
          throw new BridgeError(
            'bridge/bad-request',
            `capabilities must name at least one of: ${CAPABILITIES.join(', ')}`,
            { field: 'capabilities' },
          )
        }
        const { token, record } = await store.pair({ name, capabilities })
        return respond({ ok: true, name, token, capabilities: record.capabilities })
      },
    },
    {
      path: `${BASE}.settings`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const input = await body(request)
        const result = await applySettings(input)
        if (result.ok !== true) return respond({ ok: false, error: result.error })
        // Read the post-change state back: `listen` carries the port the OS
        // actually assigned when the operator asked for 0.
        return respond({ ok: true, state: await state() })
      },
    },
    {
      path: `${BASE}.revoke`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const input = await body(request)
        const name = typeof input.name === 'string' ? input.name.trim() : ''
        if (name === '') throw new BridgeError('bridge/bad-request', 'name is required', {})
        const existed = await store.revoke(name)
        return respond({ ok: existed, name })
      },
    },
  ]

  // A refusal must reach the panel as JSON, not as a thrown handler: the
  // browser has no way to read a stack trace, and every other route answers
  // with `{ ok: false, error }`.
  const guarded = routes.map(route => ({
    ...route,
    fetch: async (request) => {
      try {
        return await route.fetch(request)
      } catch (error) {
        if (error instanceof BridgeError) {
          return respond({ ok: false, error: { code: error.code, message: error.message, details: error.details } })
        }
        throw error
      }
    },
  }))

  for (const route of guarded) {
    try {
      ctx.effect(() => fetchService.register(route), `lan-bridge: route ${route.path}`)
    } catch (error) {
      logger?.warn?.(`lan-bridge: route ${route.path} not registered: ${String(error)}`)
    }
  }
  logger?.info?.(`lan-bridge: ${String(routes.length)} panel routes registered under ${BASE}`)
}

function respond(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
