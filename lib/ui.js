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
import { CAPABILITIES, localAddresses, settingsOf } from './config.js'
import { describePeer } from './remote.js'

const BASE = '/api/lan-bridge'

/**
 * Register the panel routes.
 * @param options - `{ ctx, cfg, store, server, remote, peerCache, logger }`.
 */
export function installUi({ ctx, cfg, store, server, remote, peerCache, logger, ready, applySettings }) {
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

  async function localSessions() {
    const service = ctx.get('sessionController')
    if (service === undefined) return []
    const value = await service.list({}, undefined)
    const shared = new Set((await store.sharedSessions()).map(item => item.sessionId))
    const items = []
    for (const item of value?.items ?? []) {
      const title = item.projections?.values?.title
      items.push({
        sessionId: item.sessionId,
        title: typeof title === 'string' && title.trim() !== '' ? title.trim() : `Session ${String(item.sessionId).slice(-8)}`,
        running: item.running === true,
        updatedAt: item.updatedAt,
        cwd: item.cwd,
        shared: shared.has(item.sessionId),
      })
    }
    items.sort((left, right) => right.updatedAt - left.updatedAt)
    return items
  }

  async function state() {
    await readyPromise
    const outbound = []
    for (const record of await store.outbound()) {
      outbound.push(await describePeer(remote, record, peerCache, logger))
    }
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
      capabilities: CAPABILITIES,
      limits: {
        maxPromptBytes: cfg.maxPromptBytes,
        maxWaitMs: cfg.maxWaitMs,
        maxMessages: cfg.maxMessages,
        rateLimitPerMinute: cfg.rateLimitPerMinute,
        allowPeersToCreateSessions: cfg.allowPeersToCreateSessions === true,
      },
      inbound: await store.inbound(),
      outbound,
      sessions: await localSessions(),
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
      path: `${BASE}.pair`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const input = await body(request)
        const name = typeof input.name === 'string' ? input.name.trim() : ''
        if (name === '') throw new BridgeError('bridge/bad-request', 'name is required', {})
        if (name.length > 64) throw new BridgeError('bridge/bad-request', 'name is limited to 64 characters', {})
        const capabilities = Array.isArray(input.capabilities)
          ? input.capabilities.filter(value => CAPABILITIES.includes(value))
          : ['read', 'prompt']
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

  for (const route of routes) {
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
