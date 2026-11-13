/**
 * Row config resolution. Everything here is defensive: a mistyped knob falls
 * back to its safe default instead of failing the plugin, because this row is
 * loaded by the Host at boot and a throw here would take the GUI down with it.
 */
import { homedir, networkInterfaces } from 'node:os'
import { FILE_DEFAULTS, normalizeFiles } from './files.js'
import { isAbsolute, join, resolve } from 'node:path'
import { isIP } from 'node:net'

/**
 * Capability bits a peer token can carry.
 *
 * `approve` is the only bit that lets a peer answer this machine's approval
 * prompts. It is deliberately absent from `DEFAULT_CAPABILITIES`: pairing a
 * machine must never hand it the power to allow tool calls here.
 */
export const CAPABILITIES = ['read', 'prompt', 'control', 'create', 'archive', 'collab', 'approve', 'files']

/** What a freshly paired peer may do: look, and talk. Nothing else. */
export const DEFAULT_CAPABILITIES = ['read', 'prompt']

/** Protocol version spoken on the wire; also the `bridge.hello` gate. */
export const PROTOCOL = 1

/** Plugin version, reported by `bridge.hello` and the UI panel. */
export const VERSION = '0.5.2'

/** Route prefix owned by the browser-facing (cookie-authenticated) UI routes. */
export const UI_PREFIX = '/api/lan-bridge'

/**
 * The knobs an operator may change from the panel while the Host runs. Limits
 * (prompt size, wait budget, rate limit) are deliberately not here: changing
 * them while a peer is mid-call would make the reported `limits` a lie.
 */
export const EDITABLE_KEYS = ['name', 'host', 'port', 'insecureHttp', 'allowPeersToCreateSessions', 'autoAcceptMirror', 'trustedHosts', 'tls', 'discovery', 'files']

/** Longest machine name the panel accepts; peers show it verbatim in lists. */
export const NAME_MAX = 64

const DEFAULTS = {
  host: '127.0.0.1',
  port: 5977,
  maxPromptBytes: 16 * 1024,
  maxWaitMs: 10 * 60 * 1000,
  maxMessages: 200,
  maxBodyBytes: 1024 * 1024,
  // How long an approval may wait for a remote decision before the local human
  // UI is asked instead. Bounded on purpose: silence must never wedge a turn.
  approvalRelayMs: 20_000,
  rateLimitPerMinute: 120,
}

/** mDNS defaults: off, because chatting on the network is an opt-in. */
const DISCOVERY_DEFAULTS = { enabled: false, intervalMs: 60_000 }

/**
 * Resolve the persisted state directory. The bridge keeps peer tokens and
 * share decisions next to the rest of the DSH home, never inside the plugin
 * package (which is replaced on reinstall).
 * @param env - process environment used for `DSH_HOME`.
 * @returns absolute path of the state directory.
 */
export function resolveStateDir(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'lan-bridge')
}

/**
 * Resolve one row config into a complete, validated settings object.
 * @param raw - the `config:` block of this plugin row.
 * @param env - process environment, for the default state directory.
 * @returns resolved settings.
 */
export function resolveConfig(raw, env = process.env) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const text = (key, fallback) => {
    const value = source[key]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  }
  const positive = (key, fallback) => {
    const value = source[key]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
  }
  const flag = (key, fallback) => (typeof source[key] === 'boolean' ? source[key] : fallback)

  const discoveryRaw = source.discovery !== null && typeof source.discovery === 'object' ? source.discovery : {}
  const listenRaw = source.listen !== null && typeof source.listen === 'object' ? source.listen : {}
  const host = typeof listenRaw.host === 'string' && listenRaw.host.trim() !== ''
    ? listenRaw.host.trim()
    : DEFAULTS.host
  const portRaw = listenRaw.port
  // 0 means "let the OS pick", matching the DSH web listener's own convention.
  const port = typeof portRaw === 'number' && Number.isInteger(portRaw) && portRaw >= 0 && portRaw <= 65535
    ? portRaw
    : DEFAULTS.port
  const constPort = Number.isInteger(port) ? port : DEFAULTS.port

  const roleRaw = text('role', 'both').toLowerCase()
  const role = roleRaw === 'listener' || roleRaw === 'controller' ? roleRaw : 'both'

  const tlsRaw = source.tls
  const tls = tlsRaw !== null && typeof tlsRaw === 'object'
    && typeof tlsRaw.certFile === 'string' && typeof tlsRaw.keyFile === 'string'
    ? { certFile: absolute(tlsRaw.certFile), keyFile: absolute(tlsRaw.keyFile) }
    : null

  const trustedHosts = Array.isArray(source.trustedHosts)
    ? source.trustedHosts.filter(value => typeof value === 'string' && value.trim() !== '').map(value => value.trim())
    : []

  return {
    role,
    name: text('name', ''),
    hostname: host,
    port: constPort,
    insecureHttp: flag('insecureHttp', false),
    tls,
    trustedHosts,
    allowPeersToCreateSessions: flag('allowPeersToCreateSessions', false),
    // Accept a mirror pairing without asking this machine's operator. Off by
    // default: accepting one hands a bearer token to a machine that introduced
    // itself over the wire, which is the operator's decision, not the caller's.
    autoAcceptMirror: flag('autoAcceptMirror', false),
    maxPromptBytes: positive('maxPromptBytes', DEFAULTS.maxPromptBytes),
    maxWaitMs: positive('maxWaitMs', DEFAULTS.maxWaitMs),
    maxMessages: positive('maxMessages', DEFAULTS.maxMessages),
    maxBodyBytes: positive('maxBodyBytes', DEFAULTS.maxBodyBytes),
    approvalRelayMs: positive('approvalRelayMs', DEFAULTS.approvalRelayMs),
    rateLimitPerMinute: positive('rateLimitPerMinute', DEFAULTS.rateLimitPerMinute),
    audit: flag('audit', true),
    // mDNS is opt-in twice over: the row config says whether this machine may
    // announce itself, and the panel switch can turn it off again at runtime.
    discovery: {
      enabled: flag('discovery', false) || discoveryRaw.enabled === true,
      intervalMs: positive('discoveryIntervalMs', positive('discovery.intervalMs', DISCOVERY_DEFAULTS.intervalMs)),
    },
    // File transfer is off unless the row declares roots and turns it on: a
    // peer that cannot name a root has nothing to reach.
    files: normalizeFiles(source.files),
    version: VERSION,
    stateDir: resolveStateDir(env),
    listening: role !== 'controller',
    controlling: role !== 'listener',
  }
}

/**
 * Whether a bind address leaves the loopback interface.
 * @param host - the configured listen host literal.
 * @returns true for anything that is not loopback.
 */
export function isLoopback(host) {
  return host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === 'localhost'
}

/**
 * Settings that would expose this machine's sessions to the network without an
 * explicit acknowledgement. A listener cannot start while this returns a
 * reason, and the plugin says so instead of silently binding.
 * @param cfg - resolved settings.
 * @returns a human-readable refusal reason, or undefined when the bind is allowed.
 */
export function refuseReason(cfg) {
  if (cfg.listening && !isLoopback(cfg.hostname) && cfg.tls === null && !cfg.insecureHttp) {
    return `listen.host ${cfg.hostname} is not loopback and no TLS is configured: set insecureHttp: true to accept plain HTTP on this network, or configure tls.certFile/keyFile`
  }
  return undefined
}

function absolute(value) {
  const trimmed = value.trim()
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed)
}

/**
 * Every address this machine currently holds, loopback first. Used both for the
 * Host-header authority set (a peer reaches us at its own idea of our address)
 * and for the panel's host picker.
 * @returns interface literals, e.g. `['127.0.0.1', '192.168.1.8']`.
 */
export function localAddresses() {
  const out = ['127.0.0.1']
  const interfaces = networkInterfaces()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const family = entry.family === 4 || entry.family === 'IPv4' ? 4 : 6
      if (family !== 4) continue
      if (entry.internal === true) continue
      if (!out.includes(entry.address)) out.push(entry.address)
    }
  }
  return out
}

/**
 * The listen settings as the panel shows them.
 * @param cfg - resolved settings.
 * @returns plain object with the editable keys.
 */
export function settingsOf(cfg) {
  return {
    name: cfg.name,
    host: cfg.hostname,
    port: cfg.port,
    insecureHttp: cfg.insecureHttp === true,
    allowPeersToCreateSessions: cfg.allowPeersToCreateSessions === true,
    autoAcceptMirror: cfg.autoAcceptMirror === true,
    trustedHosts: [...cfg.trustedHosts],
    tls: cfg.tls === null ? null : { certFile: cfg.tls.certFile, keyFile: cfg.tls.keyFile },
    discovery: cfg.discovery?.enabled === true,
    files: {
      enabled: cfg.files?.enabled === true,
      maxFileBytes: cfg.files?.maxFileBytes ?? FILE_DEFAULTS.maxFileBytes,
      chunkBytes: cfg.files?.chunkBytes ?? FILE_DEFAULTS.chunkBytes,
      stagingTtlMs: cfg.files?.stagingTtlMs ?? FILE_DEFAULTS.stagingTtlMs,
      roots: (cfg.files?.roots ?? []).map(root => ({ name: root.name, path: root.path, writable: root.writable === true })),
    },
  }
}

/**
 * Copy editable settings onto a resolved config object.
 * @param cfg - resolved settings, mutated in place.
 * @param next - a validated settings object.
 */
export function assignSettings(cfg, next) {
  // `name` is optional in a patch: a rollback path (or an older caller) that
  // omits it must not blank the advertised identity.
  if (typeof next.name === 'string' && next.name !== '') cfg.name = next.name
  cfg.hostname = next.host
  cfg.port = next.port
  cfg.insecureHttp = next.insecureHttp === true
  cfg.allowPeersToCreateSessions = next.allowPeersToCreateSessions === true
  cfg.autoAcceptMirror = next.autoAcceptMirror === true
  if (typeof next.discovery === 'boolean') cfg.discovery = { ...(cfg.discovery ?? DISCOVERY_DEFAULTS), enabled: next.discovery }
  if (next.files !== undefined) cfg.files = normalizeFiles(next.files)
  cfg.trustedHosts = [...next.trustedHosts]
  cfg.tls = next.tls === null ? null : { certFile: next.tls.certFile, keyFile: next.tls.keyFile }
  return cfg
}

/**
 * Merge an operator patch over the current settings and validate the result.
 *
 * This is the single gate for the panel form: it rejects nonsense (a hostname
 * that is not an address literal, a half-configured TLS pair) and it refuses
 * any bind that would expose sessions over the network without either TLS or
 * the operator's explicit `insecureHttp` acknowledgement.
 *
 * @param cfg - current resolved settings.
 * @param patch - `{ name?, host?, port?, insecureHttp?, allowPeersToCreateSessions?, trustedHosts?, tls? }`.
 * @returns `{ next }` on success, `{ error }` with `{ code, message, details }` otherwise.
 */
export function validateSettingsPatch(cfg, patch) {
  const source = patch !== null && typeof patch === 'object' ? patch : {}
  const current = settingsOf(cfg)
  const next = { ...current }

  if (source.name !== undefined) {
    const raw = typeof source.name === 'string' ? source.name.trim() : null
    if (raw === null) {
      return { error: { code: 'bridge/bad-request', message: '本机名称必须是字符串', details: { field: 'name' } } }
    }
    if (raw === '') {
      return { error: { code: 'bridge/bad-request', message: '本机名称不能为空', details: { field: 'name' } } }
    }
    if (raw.length > NAME_MAX) {
      return {
        error: { code: 'bridge/bad-request', message: `本机名称最多 ${String(NAME_MAX)} 个字符，收到 ${String(raw.length)} 个`, details: { field: 'name' } },
      }
    }
    if (/[\u0000-\u001f\u007f]/.test(raw)) {
      return { error: { code: 'bridge/bad-request', message: '本机名称不能包含控制字符或换行', details: { field: 'name' } } }
    }
    next.name = raw
  }

  if (source.autoAcceptMirror !== undefined) {
    if (typeof source.autoAcceptMirror !== 'boolean') {
      return { error: { code: 'bridge/bad-request', message: 'autoAcceptMirror 必须是布尔值（是否自动接受反向配对请求）', details: { field: 'autoAcceptMirror' } } }
    }
    next.autoAcceptMirror = source.autoAcceptMirror
  }

  if (source.discovery !== undefined) {
    if (typeof source.discovery !== 'boolean') {
      return { error: { code: 'bridge/bad-request', message: 'discovery 必须是布尔值（是否用 mDNS 在局域网里广播自己）', details: { field: 'discovery' } } }
    }
    next.discovery = source.discovery
  }

  if (source.files !== undefined) {
    const raw = source.files
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: { code: 'bridge/bad-request', message: 'files 配置必须是对象（enabled / maxFileBytes / roots）', details: { field: 'files' } } }
    }
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
      return { error: { code: 'bridge/bad-request', message: 'files.enabled 必须是布尔值（是否允许对端在这些根目录里读写文件）', details: { field: 'files.enabled' } } }
    }
    if (raw.maxFileBytes !== undefined) {
      const limit = raw.maxFileBytes
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
        return { error: { code: 'bridge/bad-request', message: 'files.maxFileBytes 必须是正整数（字节）', details: { field: 'files.maxFileBytes' } } }
      }
    }
    if (raw.roots !== undefined) {
      if (!Array.isArray(raw.roots)) {
        return { error: { code: 'bridge/bad-request', message: 'files.roots 必须是数组', details: { field: 'files.roots' } } }
      }
      const names = new Set()
      for (const entry of raw.roots) {
        if (entry === null || typeof entry !== 'object') {
          return { error: { code: 'bridge/bad-request', message: '每个根目录必须是 { name, path, writable }', details: { field: 'files.roots' } } }
        }
        const name = typeof entry.name === 'string' ? entry.name.trim() : ''
        if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name)) {
          return { error: { code: 'bridge/bad-request', message: '根目录名只能用字母、数字、下划线和短横线（1–32 字符）', details: { field: 'files.roots', name } } }
        }
        if (names.has(name)) {
          return { error: { code: 'bridge/bad-request', message: `根目录名重复：${name}`, details: { field: 'files.roots', name } } }
        }
        names.add(name)
        const path = typeof entry.path === 'string' ? entry.path.trim() : ''
        if (path === '') {
          return { error: { code: 'bridge/bad-request', message: `根目录 ${name} 缺少 path`, details: { field: 'files.roots', name } } }
        }
        if (!isAbsolute(path)) {
          return { error: { code: 'bridge/bad-request', message: `根目录 ${name} 的 path 必须是绝对路径`, details: { field: 'files.roots', name } } }
        }
        if (entry.writable !== undefined && typeof entry.writable !== 'boolean') {
          return { error: { code: 'bridge/bad-request', message: `根目录 ${name} 的 writable 必须是布尔值`, details: { field: 'files.roots', name } } }
        }
      }
    }
    next.files = normalizeFiles({ ...current.files, ...raw })
  }

  if (source.host !== undefined) {
    const host = typeof source.host === 'string' ? source.host.trim() : ''
    if (host === '' || (host !== 'localhost' && isIP(host) === 0)) {
      return {
        error: {
          code: 'bridge/bad-request',
          message: `监听地址必须是 IP 字面量（如 127.0.0.1 / 0.0.0.0 / 192.168.1.8）或 localhost，收到 ${JSON.stringify(String(source.host ?? ''))}`,
          details: { field: 'host' },
        },
      }
    }
    next.host = host
  }

  if (source.port !== undefined) {
    const port = source.port
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
      return {
        error: { code: 'bridge/bad-request', message: '端口必须是 0–65535 的整数（0 表示由系统分配）', details: { field: 'port' } },
      }
    }
    next.port = port
  }

  if (source.insecureHttp !== undefined) {
    if (typeof source.insecureHttp !== 'boolean') {
      return { error: { code: 'bridge/bad-request', message: 'insecureHttp 必须是布尔值', details: { field: 'insecureHttp' } } }
    }
    next.insecureHttp = source.insecureHttp
  }

  if (source.allowPeersToCreateSessions !== undefined) {
    if (typeof source.allowPeersToCreateSessions !== 'boolean') {
      return {
        error: {
          code: 'bridge/bad-request',
          message: 'allowPeersToCreateSessions 必须是布尔值',
          details: { field: 'allowPeersToCreateSessions' },
        },
      }
    }
    next.allowPeersToCreateSessions = source.allowPeersToCreateSessions
  }

  if (source.trustedHosts !== undefined) {
    const raw = Array.isArray(source.trustedHosts)
      ? source.trustedHosts
      : typeof source.trustedHosts === 'string' ? source.trustedHosts.split(',') : null
    if (raw === null) {
      return { error: { code: 'bridge/bad-request', message: 'trustedHosts 必须是字符串数组', details: { field: 'trustedHosts' } } }
    }
    const list = raw
      .filter(value => typeof value === 'string')
      .map(value => value.trim())
      .filter(value => value !== '')
    next.trustedHosts = list
  }

  if (source.tls !== undefined) {
    if (source.tls === null) {
      next.tls = null
    } else if (typeof source.tls === 'object') {
      const certFile = typeof source.tls.certFile === 'string' ? source.tls.certFile.trim() : ''
      const keyFile = typeof source.tls.keyFile === 'string' ? source.tls.keyFile.trim() : ''
      if (certFile === '' && keyFile === '') {
        next.tls = null
      } else if (certFile === '' || keyFile === '') {
        return {
          error: { code: 'bridge/bad-request', message: 'TLS 证书和私钥必须同时配置（或都不配置）', details: { field: 'tls' } },
        }
      } else {
        next.tls = { certFile: absolute(certFile), keyFile: absolute(keyFile) }
      }
    } else {
      return { error: { code: 'bridge/bad-request', message: 'tls 必须是 null 或 { certFile, keyFile }', details: { field: 'tls' } } }
    }
  }

  const probe = {
    ...cfg,
    name: next.name,
    hostname: next.host,
    port: next.port,
    insecureHttp: next.insecureHttp,
    tls: next.tls,
    trustedHosts: next.trustedHosts,
  }
  const reason = refuseReason(probe)
  if (reason !== undefined) {
    return {
      error: {
        code: 'bridge/forbidden',
        message: `不能把监听改到 ${next.host}：这会把会话以明文 HTTP 暴露到局域网。请勾选"允许明文 HTTP"（承认风险）或配置 TLS 证书后再保存`,
        details: { field: 'host', reason },
      },
    }
  }

  return { next }
}
