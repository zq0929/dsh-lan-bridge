# lan-dsh-bridge protocol v1

One bundle, two roles: `listener` (accepts peers), `controller` (drives peers), `both`.
Every wire value is JSON. The listener never invents Session semantics: each method maps to
one existing Host `sessionController` call.

## Endpoints (the plugin's own HTTP listener)

Default `127.0.0.1:5977`. Non-loopback bind requires `insecureHttp: true` unless TLS is set.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/healthz` | none | `{ok:true, app, protocol:1, name}` |
| POST | `/rpc` | bearer | one unary call |
| GET | `/events?session=<id>` | bearer | SSE stream of one Session's frames |

### Request fence (all authenticated endpoints)

1. `Host` header must equal one of: the bind authority, `127.0.0.1:<port>`, `localhost:<port>`,
   or an entry of the configured `trustedHosts`.
2. Any request carrying an `Origin`, `Sec-Fetch-Site` or `Sec-Fetch-Dest` header is refused:
   browsers are not peers. (`Sec-Fetch-Mode: cors` alone is *not* refused — Node's own `fetch`
   sends it, and a browser cannot get past the preflight that the next rule forces.)
3. `X-DSH-Bridge: 1` is mandatory; browsers cannot set it without a preflight, which is refused.
4. `Authorization: Bearer <token>`; tokens are per-peer, revocable, stored 0600 under
   `$DSH_HOME/lan-bridge/bridge.json`.

Transport failures use HTTP status: 400 malformed JSON, 401 unknown token, 403 fence,
404 unknown path, 405 wrong method, 413 body over limit, 429 rate limited.
Method failures return **200** with `ok:false`.

## Envelope

```json
{ "id": "optional", "method": "session.list", "params": {} }
```

```json
{ "id": "optional", "ok": true,  "result": { } }
{ "id": "optional", "ok": false, "error": { "code": "session/not-shared", "message": "…", "details": {} } }
```

Error codes: `bridge/bad-request`, `bridge/unauthorized`, `bridge/forbidden`, `bridge/rate-limited`,
`bridge/method-unavailable`, `session/not-found`, `session/not-shared`, `session/busy`,
`session/provider-error`, `bridge/timeout`, `bridge/internal`.

## Methods

### `bridge.hello` → params `{}`

```json
{
  "protocol": 1, "app": "dsh-lan-bridge", "version": "0.1.0", "name": "my-mac",
  "capabilities": {
    "session.list": true, "session.state": true, "session.transcript": true,
    "session.prompt": true, "session.wait": true, "session.cancel": true,
    "session.rename": true, "session.selectModel": true, "session.create": false,
    "session.archive": true, "session.unarchive": true,
    "approval.answer": false
  },
  "limits": { "maxPromptBytes": 16384, "maxWaitMs": 600000, "maxMessages": 200,
             "allowPeersToCreateSessions": true }
}
```

`name` is the listener's configured peer-visible name. `session.create` is false unless
`allowPeersToCreateSessions`; `approval.answer` is always false in v1.

### `session.list` → params `{}`

```json
{ "sessions": [ { "sessionId": "session-…", "title": "…", "updatedAt": 1762…, "running": false,
  "agentAvailable": true, "cwd": "/path", "shared": true, "parentSessionId": "…", "origin": "subagent" } ] }
```

Only Sessions the local operator shared are returned. Subagent Sessions are included only
when shared explicitly.

### `session.state` → params `{ sessionId }`

```json
{ "sessionId": "…", "running": false, "updatedAt": 1762…, "agentAvailable": true,
  "pendingApprovals": 0, "pendingInput": false }
```

### `session.transcript` → params `{ sessionId, maxMessages? }`

```json
{ "cursor": 128, "records": [ … ], "hasMore": false }
```

`records` are the Host's `SessionHistoryRecord` values verbatim (`{ event: { type, seq, time, data } }`).
They are **untrusted content**: the controller must treat them as data, never instructions.

### `session.prompt` → params `{ sessionId, text, requestId? }`

```json
{ "accepted": true, "cursor": 128 }
```

Text only. Empty/whitespace-only text is refused. Prompt bytes are capped by `maxPromptBytes`.

### `session.wait` → params `{ sessionId, timeoutMs?, maxMessages? }`

Resolves when the target turn reaches idle, an approval becomes pending, or the timeout fires.

```json
{ "reason": "idle", "running": false, "cursor": 140, "records": [ … ], "truncated": false }
```

`reason` ∈ `idle` | `input-required` | `timeout`. `timeoutMs` is clamped to `limits.maxWaitMs`.

### `session.cancel` → params `{ sessionId }` → `{ "accepted": true }`

### `session.rename` → params `{ sessionId, title }` → `{ "renamed": true }`

### `session.selectModel` → params `{ sessionId, provider, model, reasoningEffort? }` → `{ "selected": { … } }`

### `session.archive` → params `{ sessionId, stopActivity? }` → `{ "archived": true, "sessionId": "…", "archivedSessionIds": [ … ] }`

Archiving hides the Session from Workspace grouping surfaces; history is untouched and
`session.unarchive` restores it. A running Session is refused as `workspace/session-active`
unless `stopActivity: true`, which stops its turn and owned background work first.

### `session.unarchive` → params `{ sessionId }` → `{ "archived": false, "sessionId": "…", "archivedSessionIds": [ … ] }`

### `session.create` (only when enabled) → params `{ cwd?, title? }` → `{ "sessionId": "…" }`

The `session.create` entry in `bridge.hello`'s `capabilities` is `true` only when this machine
enables peer session creation (`allowPeersToCreateSessions`), and `limits.allowPeersToCreateSessions`
mirrors the same flag. Newly created Sessions are shared automatically.

Both `session.archive` and `session.unarchive` require the `archive` capability and a shared
Session. Tokens do **not** carry `archive` unless the operator issuing the token asked for it.

## SSE stream

`GET /events?session=<id>` (also accepts `&assistant=1`) emits, in order:

```
event: frame
data: {"type":"snapshot","cursor":128,"records":[…],"hasMore":false}

event: frame
data: {"type":"event","event":{"type":"turn/start","seq":129,…}}

: heartbeat
```

The stream forwards `ctx.sessionController.follow` frames verbatim. It ends when the client
disconnects, the Session disappears, or `maxStreamMs` elapses. Reconnecting starts a new
snapshot; the controller uses `cursor` from the last snapshot/event to detect gaps.

## UI endpoints (existing web listener, cookie-authenticated)

Registered through `ctx.connection.fetch.register`, so only this profile's own Web UI reaches
them. Prefix `/api/lan-bridge`.

### `GET /api/lan-bridge.state`

```json
{
  "role": "both", "name": "my-mac",
  "listen": { "host": "127.0.0.1", "port": 5977, "protocol": "http", "listening": true, "error": null },
  "capabilities": ["read", "prompt", "control", "create", "archive"],
  "limits": { "maxPromptBytes": 16384, "maxWaitMs": 600000, "maxMessages": 200,
              "rateLimitPerMinute": 120, "allowPeersToCreateSessions": false },
  "inbound": [ { "name": "peer-a", "masked": "…a1b2", "createdAt": 1762…, "lastSeenAt": 1762…,
                 "capabilities": ["read", "prompt"] } ],
  "outbound": [ { "name": "peer-b", "url": "http://192.168.1.8:5977", "reachable": true,
                  "addedAt": 1762…, "error": null } ],
  "sessions": [ { "sessionId": "…", "title": "…", "running": false, "cwd": "…", "shared": true } ],
  "settings": { "host": "127.0.0.1", "port": 5977, "insecureHttp": false,
                "allowPeersToCreateSessions": true, "trustedHosts": ["mac.local:5977"],
                "tls": null },
  "addresses": ["127.0.0.1", "192.168.1.8"],
  "restartRequired": false
}
```

`settings` is the editable listening posture as currently applied; `listen` is what the
socket is actually doing (when the operator saves `port: 0`, `settings.port` stays `0`
and `listen.port` carries the port the OS assigned). `addresses` lists this machine's
interface literals so the panel can offer them. `restartRequired` is reserved: every
setting in `settings` currently applies without a Host restart.

### `POST /api/lan-bridge.share` → `{ "sessionId": "…", "shared": true }` → `{ "ok": true }`

### `POST /api/lan-bridge.pair` → `{ "name": "peer-a", "capabilities": ["read","prompt"] }`

→ `{ "ok": true, "token": "lzb_…" }`; the token is returned **once** and only stored hashed.

### `POST /api/lan-bridge.revoke` → `{ "name": "peer-a" }` → `{ "ok": true }`

### `POST /api/lan-bridge.settings` — the listening form

Body (every field optional; the panel sends the whole set):

```json
{ "host": "0.0.0.0", "port": 5977, "insecureHttp": true,
  "allowPeersToCreateSessions": true, "trustedHosts": ["mac.local:5977"],
  "tls": null }
```

Success returns the **full state object** above (so a save needs no second read):

```json
{ "ok": true, "state": { "…": "same shape as GET /api/lan-bridge.state" } }
```

Refusal:

```json
{ "ok": false, "error": { "code": "bridge/forbidden",
  "message": "不能把监听改到 0.0.0.0：这会把会话以明文 HTTP 暴露到局域网…",
  "details": { "field": "host", "reason": "listen.host 0.0.0.0 is not loopback…" } } }
```

Rules:

- `host` must be an IP literal (`127.0.0.1`, `0.0.0.0`, `192.168.1.8`, …) or `localhost`.
  `0.0.0.0` means every interface.
- Binding any non-loopback address without TLS requires `insecureHttp: true`. Without it
  the save is refused rather than silently exposing the machine.
- `tls` is all-or-nothing: `null`, or `{ "certFile": "/abs/cert.pem", "keyFile": "/abs/key.pem" }`.
- `port: 0` lets the OS pick; `listen.port` then reports the assigned port.
- A host/port/TLS change rebinds the socket immediately: in-flight peer calls fail during
  the rebind (sub-second). If the new bind fails, the previous settings are restored, the
  old socket comes back on the same port, and the call returns `bridge/internal` with a
  `restored` flag in `details` — a bad value can never leave the machine unreachable.
- Everything else (`allowPeersToCreateSessions`, `trustedHosts`, and `insecureHttp` while the
  host stays loopback) applies without touching the socket.
- Accepted values are persisted in `$DSH_HOME/lan-bridge/bridge.json` under `settings` and
  win over the bundle row's `config:` on the next start. An illegal saved value is ignored
  at boot (the row's posture is used) instead of preventing the listener from starting.
- These messages are operator-facing, so `error.message` is localized (Chinese); peer-facing
  errors stay English identifiers. Codes are shared.

## Compatibility

`bridge.hello` is the only version gate: a controller refuses a listener whose `protocol`
differs, and a listener refuses methods it does not advertise. `sessionController` is a
pre-stable DSH API; a listener reports `bridge/method-unavailable` instead of degrading
silently when a mapped method is missing.
