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
  "protocol": 1, "app": "dsh-lan-bridge", "version": "0.5.2", "name": "my-mac",
  "diskVersion": "0.5.2", "drift": false,
  "capabilities": {
    "session.list": true, "session.state": true, "session.transcript": true,
    "session.prompt": true, "session.wait": true, "session.cancel": true,
    "session.rename": true, "session.selectModel": true, "session.create": false,
    "session.archive": true, "session.unarchive": true,
    "session.intents": true,
    "tasks.list": true, "tasks.create": true, "tasks.update": true,
    "tasks.transfer": true, "tasks.adopt": true,
    "goal.get": true, "goal.set": true, "goal.clear": true, "goal.adopt": true,
    "approval.list": true, "approval.answer": true,
    "audit.tail": true,
    "files.roots": true, "files.stat": true, "files.list": true, "files.read": true,
    "files.begin": true, "files.chunk": true, "files.commit": true, "files.abort": true
  },
  "files": { "enabled": true, "maxFileBytes": 268435456, "chunkBytes": 262144,
             "roots": [ { "name": "workspace", "writable": true } ] },
  "limits": { "maxPromptBytes": 16384, "maxWaitMs": 600000, "maxMessages": 200,
             "allowPeersToCreateSessions": true,
             "maxFileBytes": 268435456, "chunkBytes": 262144, "fileTransfer": true }
}
```

`name` is the listener's configured peer-visible name. `session.create` is false unless
`allowPeersToCreateSessions`. `approval.list` / `approval.answer` are advertised `true` from
0.3.13, but answering still needs a token carrying the `approve` capability, which pairing never
grants by default. Capabilities are fixed per token: an already-issued token does not gain
`approve` on upgrade — the operator either pairs a new one or runs
`lan_dsh_peers action=grant name=<peer> capabilities=[…]` on the listening machine, which rewrites
that peer's capabilities in place and leaves its token valid. Each direction is independent: A may
answer B's approvals only if B's record for A carries `approve`.

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

### `session.prompt` → params `{ sessionId, text, requestId?, intent? }`

```json
{ "accepted": true, "sessionId": "session-…", "intent": true }
```

`text` is the message body. Empty/whitespace-only text is refused, and the composed bytes are capped by `maxPromptBytes`.

`intent` is optional and advisory: it carries *why* this prompt exists, so the receiving agent acts on a plan instead of inferring one from prose. Fields (`goal` required, the rest optional):

| field | limit | meaning |
|---|---|---|
| `goal` | 2000 B | what this prompt is trying to achieve, one sentence |
| `plan` | ≤ 20 steps × 500 B | ordered steps the sender intends to take across turns |
| `expects` | 2000 B | what the sender needs back, and what counts as done |
| `deadline` | 200 B | free-form time bound |
| `format` | 200 B | required shape of the reply |

The bridge renders the envelope into one delimited block **ahead of the text**, and the Session receives that single text part:

```
[lan-bridge intent]
goal: …
plan:
1. …
expects: …
[/lan-bridge intent]

<text>
```

Unknown `intent` properties are dropped, not rejected (a newer peer must not break an older one). A malformed envelope — missing `goal`, non-array `plan`, oversized field — is `bridge/bad-request`. Without `intent` the text is submitted byte-for-byte unchanged, and the response omits `intent`.

### `session.intents` → params `{ sessionId }` → `{ sessionId, intents: [ … ] }`

The intent envelopes this machine has received for one Session, oldest first, bounded to the newest 20; each entry is `{ at, peer, goal, plan?, expects?, deadline?, format? }`. Requires the `read` capability and a shared Session, like `session.transcript`: a peer cannot learn whether an unshared Session exists from this call.

### Shared board: `tasks.*` and `goal.*`

Every method in this group requires the **`collab`** capability, which the panel
does not issue by default (`lan_dsh_peers action=pair name=… capabilities=["read","prompt","collab"]`).

The board is replicated, not centralised: each machine owns the tasks it created
and is the only writer of them, so two peers cannot produce a conflicting edit.
Reading merges the caller's own tasks with each peer's, and every task id is
qualified as `machine/id` for that merged view.

| method | params | result |
|---|---|---|
| `tasks.list` | `{}` | `{ "name": "my-mac", "tasks": [ … ], "tombstones": [ … ] }` — this machine's tasks and its last 10 deleted ones |
| `tasks.create` | `{ subject, description?, blockedBy?, writeScopes?, assignee? }` | `{ "name": …, "task": { … } }` |
| `tasks.update` | `{ taskId, expectedRevision, action, subject?, description?, blockedBy?, assignee? }` | `{ "name": …, "task": { … } }` |
| `tasks.transfer` | `{ taskId, to, expectedRevision? }` | `{ from, to, taskId, task }` — the task moves to `to` |
| `tasks.adopt` | `{ task, from }` | `{ "name": …, "adopted": true, "task": { … } }` — receiver side of a transfer |
| `goal.get` | `{}` | `{ "name": …, "goal": { revision, title, text, updatedBy, updatedAt } }` |
| `goal.set` | `{ expectedRevision, text, title? }` | `{ "name": …, "goal": { … } }` |
| `goal.clear` | `{ expectedRevision }` | `{ "name": …, "goal": { … , "cleared": true } }` |
| `goal.adopt` | `{ goal, from }` | `{ "name": …, "applied": bool, "diverged": bool, "goal": { … }, "reason"? }` |

Task view fields: `id`, `revision`, `subject`, `description`, `status`
(`pending` | `in_progress` | `completed`), `blockedBy`, `writeScopes`,
`assignee?`, `ready` (derived: pending and every blocker completed),
`createdBy`, `updatedBy`, `createdAt`, `updatedAt`.

`tasks.update` actions: `claim`, `release`, `complete`, `reopen`, `edit`,
`set_dependencies`, `reassign`, `delete`.

`delete` is a real delete from the board and returns
`{ deleted: true, taskId, subject, dependents, relinked }` instead of a task view.
A tombstone (bounded to 50) keeps the id, subject, status and who removed it, and
`tasks.list` exposes the last 10, so a reader never has to guess whether a task
vanished or was never there. Deleting a task that other tasks are blocked by is
refused with `board/conflict` and `details.dependents`; repeat with
`force: true` to accept it — the dependents then lose that blocker (bumped
revision, listed in `relinked`), so nothing is left waiting on a ghost.
Completed tasks may be deleted — that is how a board stays readable.

`goal.clear` empties the document and still bumps the revision, so the next
writer must present a revision they actually read; clearing is not "reset to 0". A write against a task this machine does not own
is `board/not-found`; a stale `expectedRevision` is `board/conflict` with
`details.currentRevision` and `details.task` (or `details.goal` for `goal.set`)
attached, so the caller re-reads instead of blind-retrying. `goal.set` accepts
`expectedRevision: 0` for the first write.

Handing a task over: ownership belongs to the machine that holds the record, so
a hand-over is a move, not a flag. `tasks.transfer` snapshots the task, asks `to`
to `tasks.adopt` it, and only drops the local copy after the receiver has
accepted — a refused or unreachable receiver therefore changes nothing on either
side, and a task is never lost in transit. The adopted record keeps its id and
status, gains `origin: { machine, taskId, revision, at, droppedBlockers }` (the
last hop — adopt overwrites it, so it never claims a chain the board cannot
prove), and
blockers that point at tasks the receiving board does not know are dropped
(a blocker nobody can complete would block the task forever). A completed task
cannot be handed over (`bridge/forbidden`), because completed tasks stay as
history. Both machines must know each other: the receiver needs the sender as a
configured outbound peer, and each side presents a token the other accepts.

Converging the goal: each machine keeps its own copy, so "agreed" has to mean
something mechanical. Revisions order the copies: `goal.adopt` takes a peer's
document only when its revision is strictly higher (`applied: true`,
`appliedFrom` records who handed it over), ignores a lower one, and — for the
case that actually needs a human — reports an **equal** revision with different
text as `diverged: true` instead of picking a winner. A reader that merges the
board (`lan_dsh_board`) also converges: it pulls the higher revision, or pushes
its own to peers that are behind, and prints `goal converged with X (rev N)`, so
a stale copy is corrected the next time anybody looks. `lan_dsh_goal
action=sync` runs the same exchange on demand for one peer or all of them.

There is deliberately no vector clock: revisions are monotonic per writer and a
lost race shows up as divergence, which is the honest signal. A machine that
was offline does not invent a merge — it either adopts a newer document or asks
its operator to write again.

Limits: 200 tasks, 50 tombstones, 20 blockers, 40 write scopes, 20 KB goal text.

### `session.wait` → params `{ sessionId, timeoutMs?, afterSeq? }`

Resolves when the target turn reaches idle, an approval becomes pending, or the timeout fires.

```json
{ "reason": "idle", "running": false, "cursor": 140, "records": [ … ], "truncated": false }
```

`reason` ∈ `idle` | `input-required` | `timeout`. `timeoutMs` is clamped to `limits.maxWaitMs`.

`afterSeq` filters the returned `records` to those newer than that sequence number, and
changes what silence means:

| `afterSeq` | A quiet Session is reported as |
|---|---|
| omitted | `idle` once it has been quiet for ~1.2 s — nothing can prove a turn is coming |
| given | `timeout` with an empty `records` — with a cursor, silence is not proof the turn stopped |

The wait samples the Session every 200 ms instead of subscribing to status events, because a
subscriber can miss the `running` flip that happens between the first read and the
subscription (the bug that made a freshly queued prompt look finished). A Session that never
started is therefore not reported `idle` on the first read.

`session.prompt` returns the `cursor` to use as `afterSeq`, so a caller never has to guess
which records belong to the turn it just queued.

### `approval.list` → params `{}` → `{ "approvals": [ … ] }`

```json
{ "approvals": [ { "id": "8b1d…", "sessionId": "session-…", "toolName": "shell",
                   "callId": "call-…", "reason": "writes outside the workspace",
                   "askedAt": 1765520000000 } ] }
```

Every approval this machine is waiting on, for **shared** Sessions only, oldest first.
Requires `read`.

### `approval.answer` → params `{ id, decision }` → `{ "ok": true, "id": "…", "outcome": "allowed-once" }`

`decision` ∈ `allow` | `reject` | `cancel`, mapping to the Host's
`allowed-once` | `rejected` | `cancelled`. Requires the **`approve`** capability and a shared
Session; unknown ids answer `bridge/not-found`, a non-shared Session answers
`session/not-shared`, and an unknown `decision` answers `bridge/bad-request`.

The relay is a bounded wait, not a replacement for the local UI: the bridge intercepts the
approval ahead of the browser answerer, asks whichever peer holds an `approve` token, and
falls back to the local prompt when no answer arrives within `approvalRelayMs` (default 20 s)
or the request is cancelled. Relaying also requires that the peer was heard from recently
(within 10 minutes) — a granted capability is not the same as somebody being there, and waiting
on an absent machine only delays the local dialog. The Host's own `never` policy is applied before any answerer
runs, so it cannot be bypassed this way. Every remote decision is written to the audit log
(`method: "approval.answer"`) before it is handed to the waterfall.

### Files: `files.*` (0.4.0)

File transfer is opt-in twice: the listening machine must enable `files` in its settings **and**
the token must carry the `files` capability. Pairing never grants it, and roots are declared per
machine — a peer can only reach directories the operator listed.

The wire never carries an absolute path. A caller names a root and a POSIX-style relative path:

```json
{ "root": "workspace", "path": "docs/report.pdf" }
```

```json
// files.roots  (read)
{ "roots": [ { "name": "workspace", "writable": true, "maxBytes": 268435456 } ],
  "chunkBytes": 262144, "maxFileBytes": 268435456 }

// files.stat  (files)  { root, path, digest? }
{ "size": 1024, "mtimeMs": 1765520000000, "isDirectory": false, "sha256": "…" }

// files.list  (files)  { root, path }  — one level
{ "entries": [ { "name": "docs", "isDirectory": true, "size": 0, "mtimeMs": 1765520000000 } ] }

// files.read  (files)  { root, path, offset, length }
{ "data": "<base64>", "eof": false, "size": 1024, "offset": 0 }

// files.begin (files)  { root, path, size, sha256, overwrite?, createParents? }
{ "uploadId": "…", "chunkBytes": 262144, "expiresAt": 1765520600000 }

// files.chunk (files)  { uploadId, index, data }        → { "received": 524288 }
// files.commit (files) { uploadId }                     → { "root": "workspace", "path": "docs/a.bin", "size": 1048576, "sha256": "…" }
// files.abort (files)  { uploadId }                     → { "ok": true, "dropped": true }
```

Rules, in the order they are checked: capability → `files.enabled` → the root exists and (for
writes) is `writable` → every path segment → the resolved parent still inside the root after
`realpath` → the size limit. Rejected segments include `..`, `.`, empty, absolute paths, drive
letters, backslashes, trailing dots/spaces, control characters, and Windows device names
(`CON`, `NUL`, `COM1`…). A malformed path is `bridge/bad-request` (details carry
`field: "path"`): the request is wrong, and no extra capability would fix it. Anything that
resolves outside a root — including a symlink whose own name looks fine — is
`bridge/forbidden`; a read-only root is `bridge/forbidden` too, and a target that already
exists without `overwrite: true` is `bridge/conflict`.

`files.begin` fails fast: unknown root (`bridge/not-found`), oversized (`bridge/bad-request`), and
an existing target without `overwrite: true` (`bridge/conflict`). Bytes are staged under
`<stateDir>/staging/` and only moved into place after the declared `sha256` matches; a crash or
an `abort` leaves nothing behind, and a stale `*.part` older than `stagingTtlMs` is swept on the
next start.

`files.commit` re-checks `overwrite` rather than trusting the promise made at `files.begin`: if the
target appears while the bytes are in flight and the upload did not ask for `overwrite: true`, the
commit is refused with `bridge/conflict` and the file that is already there is left untouched.
Staging and the shared root may sit on different volumes (the normal Windows case); the move then
copies into the target directory and renames, so the visible path still appears in one step. One upload per peer at a time (`bridge/rate-limited`). Every committed upload and
every completed read is written to the audit log with `direction`, `root`, `path`, `bytes` and
`sha256`.

### Waiting longer than one HTTP call

`maxWaitMs` may be larger than what a single fetch can hold open: the fetch stack gives up on
response headers after 300 s and reports `UND_ERR_HEADERS_TIMEOUT`, which looks exactly like an
offline peer. The bundled tools therefore wait in slices (`session.wait` twice, carrying
`afterSeq` forward and merging `records`), and every RPC caps a single call at 240 s. Direct
clients should do the same rather than passing a `timeoutMs` above ~4 minutes.

## Mirror pairing: `pair.mirror`, `pair.mirrorResult`, `pair.status` (0.5.0)

Two rules constrain what a mirror request may ask for, and they exist because a
mirror request is a token-minting path, not a note:

- **A request may only ask for capabilities the calling token already holds.** The
  bridge intersects the request with the caller's own capability list; asking for
  more is not an error, it is silently narrowed, and if nothing survives the
  intersection the call is `bridge/bad-request` with `details.held`.
- **`autoAcceptMirror` never grants beyond `read` and `prompt`.** A request that
  asks for `approve`, `files`, `create`, `archive`, `collab` or `control` stays
  `pending` even with auto-accept on, because accepting it is an operator
  decision, not a machine one.


A pair is two independent secrets, one per direction. Mirroring turns that into
one action: the machine that initiates a pair also asks the other one to pair
back, with **the same capability set**. The accepting machine never decides on
its own — `pair.mirror` only creates a request that its operator sees in the
panel (`设置 → 局域网桥接 → 对等端`), unless that machine turned on
`autoAcceptMirror`.

### `pair.mirror` → params `{ name, url, capabilities, token }` → `{ "ok": true, "state": "pending" | "accepted" }`

Sent by the initiating machine. `token` is the credential the initiator just
minted for this machine, so the accepting side can call back; `url` is the
address it should dial; `capabilities` is the set that both directions will hold.

Requires the `read` capability: any already-paired machine may *ask*, and the
human on the receiving side decides. The request is recorded
(`state = "pending"`), audited as `pair.mirror`, and listed by `pair.status` and
in the panel. With `autoAcceptMirror: true` on the receiving machine the same
call completes the handshake immediately and answers
`{ "ok": true, "state": "accepted", "autoAccepted": true, "delivered": true }`.

### `pair.mirrorResult` → params `{ name, url?, capabilities?, token }` → `{ "name": "…", "state": "accepted" }`

Called by the accepting machine once its operator approved: `token` is *its* new
credential for the initiator. The initiator stores an outbound peer pointing at
the address it already knows, so from then on both sides can drive each other.
Requires `read`, and only answers when an outgoing mirror for that `name` exists
(`bridge/not-found` otherwise) — an unsolicited token is not silently adopted.

### `pair.status` → params `{}` → `{ "in": [ … ], "out": [ … ] }`

Both directions, newest first, tokens masked (`lzb_…1234`). Accepting or rejecting
is deliberately **not** an RPC: it happens only in the panel, so a peer can never
accept its own request.

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

### `audit.tail` → params `{ limit? }` → `{ "entries": [ … ] }`

The receiver's own audit trail, newest last, at most 200 lines (default 20). Each
line is what that machine recorded for one call: `{ t, peer, method, path?, outcome?, code?, ok? }`.
Reading it needs `read`, and it only ever covers that machine's own trail — a
peer cannot ask for someone else's. Rotated trails (`audit.jsonl.1`) are included
when the live file is short, and a torn final line from a hard stop is skipped.

## Versions: `version`, `diskVersion`, `drift`

`version` is the code this Host loaded at startup. `diskVersion` is what
`package.json` says right now. They are separate because the Host does not
hot-reload plugins: after an upgrade the process keeps running the old code until
it restarts, and `drift: true` is how a caller learns that. It is advice, never an
error — the older code keeps serving.

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
  "version": { "running": "0.5.2", "disk": "0.5.2", "drift": false },
  "capabilities": ["read", "prompt", "control", "create", "archive", "collab"],
  "limits": { "maxPromptBytes": 16384, "maxWaitMs": 600000, "maxMessages": 200,
              "rateLimitPerMinute": 120, "allowPeersToCreateSessions": false },
  "audit": [ { "t": "2026-11-12T09:03:11.000Z", "peer": "peer-b", "method": "session.prompt",
               "outcome": "ok" } ],
  "inbound": [ { "name": "peer-a", "masked": "…a1b2", "createdAt": 1762…, "lastSeenAt": 1762…,
                 "capabilities": ["read", "prompt"] } ],
  "outbound": [ { "name": "peer-b", "url": "http://192.168.1.8:5977", "reachable": true,
                  "addedAt": 1762…, "error": null } ],
  "mirrors": {
    "in":  [ { "name": "peer-b", "url": "http://192.168.1.8:5977", "capabilities": ["read","prompt"],
               "state": "pending", "at": 1762…, "token": "lzb_…a1b2" } ],
    "out": [ { "name": "peer-a", "url": "http://192.168.1.9:5977", "capabilities": ["read","prompt"],
               "state": "accepted", "at": 1762…, "token": "" } ]
  },
  "sessions": [ { "sessionId": "…", "title": "…", "running": false, "updatedAt": 1762…, "cwd": "…", "shared": true } ],
  "workspaces": [
    { "workspaceId": "w-panel", "title": "panel-project", "path": "/home/dev/panel", "shared": true,
      "sessions": [ { "sessionId": "…", "title": "…", "running": false, "updatedAt": 1762…, "cwd": "…", "shared": true } ] },
    { "workspaceId": "w-docs", "title": "docs-site", "path": "/home/dev/docs", "shared": false, "sessions": [] },
    { "workspaceId": "ungrouped", "title": "Other sessions", "path": "", "shared": false, "sessions": [] }
  ],
  "settings": { "name": "my-mac", "host": "127.0.0.1", "port": 5977, "insecureHttp": false,
                "allowPeersToCreateSessions": true, "autoAcceptMirror": false,
                "trustedHosts": ["mac.local:5977"],
                "tls": null, "discovery": true },
  "discovery": { "enabled": true, "listening": true, "error": null,
                 "found": [ { "name": "my-pc", "host": "my-pc.local", "port": 5977,
                              "address": "192.168.1.9", "version": "0.3.6", "protocol": "1" } ] },
  "addresses": ["127.0.0.1", "192.168.1.8"],
  "restartRequired": false
}
```

**A panel may be newer than the Host it talks to.** The panel bundle reloads from disk on a
page refresh, Host code only on restart, so for a while the UI is 0.3.7 and the state object
comes from 0.3.4. Every field here is therefore additive: a consumer must treat a missing
key as "this Host predates that feature", never as an error. (0.3.5 shipped a panel that read
`discovery.found` unconditionally and blanked the whole section on such a Host.)

`settings` is the editable posture as currently applied (`name` is the identity this machine
advertises in `bridge.hello` and in peers' lists); `listen` is what the
socket is actually doing (when the operator saves `port: 0`, `settings.port` stays `0`
and `listen.port` carries the port the OS assigned). `addresses` lists this machine's
interface literals so the panel can offer them. `restartRequired` is reserved: every
setting in `settings` currently applies without a Host restart.

`workspaces` is the grouped view of `sessions` (added in 0.3.12, so it is additive too —
a panel that does not see this key falls back to the flat `sessions` list). A group is
built from `ctx.workspaceRegistry.list()` when the Host has one; a session whose cwd is
not claimed by any registered workspace gets a synthetic group keyed by that cwd (id
`path:<cwd>`, title = basename), and a session with no cwd lands in `ungrouped` (always
last). Workspaces with zero sessions are still listed so the operator can share them
before creating anything. Groups are ordered by their newest session's `updatedAt`.
`group.shared` is the rule state; `session.shared` inside a group is the **effective**
value (its own decision OR the whole-workspace rule). Matching a session to a workspace
is **exact cwd equality**, not a path prefix — the same rule DSH's own
`WorkspaceEntity.sessionIds` uses. On Hosts without a workspace registry the cwd-synthetic
groups still work, so the panel behaves the same everywhere.

### `POST /api/lan-bridge.share` → `{ "sessionId": "…", "shared": true }` → `{ "ok": true }`

### `POST /api/lan-bridge.shareWorkspace` → `{ "workspaceId": "…", "shared": true }` → `{ "ok": true }`

Shares (or unshares) an entire workspace at once. Turning a rule on **materializes** it:
every session currently in the group is written into the same `shares` map that
`POST /api/lan-bridge.share` and `session.list`/SSE already read, and any session created
later in that cwd is added to it automatically (the Host subscribes to
`api-session/added`). Only decisions the rule itself made are tracked in `autoShares`;
turning the rule off removes exactly those, and **never revokes a session the operator
shared by hand**. A manual `POST /api/lan-bridge.share` clears a session's auto marker, so
the human decision always wins. An unknown `workspaceId` (or a missing one) is refused
with `bridge/bad-request` and `details.workspaceId`. The reply is `{ "ok": true,
"workspaceId": "…", "shared": true }`; a refused mutation uses the panel's
`{ "ok": false, "error": { code, message, details } }` shape instead of throwing.

### `POST /api/lan-bridge.pair` → `{ "name": "peer-a", "capabilities": ["read","prompt"] }`

→ `{ "ok": true, "name": "peer-a", "token": "lzb_…", "capabilities": ["read","prompt"] }`; the
token is returned **once** and only stored hashed.

`capabilities` is optional and may name any subset of
`read`, `prompt`, `control`, `create`, `archive`, `collab` — the panel offers all six as
toggles, so an operator can mint the same token here that `lan_dsh_peers action=pair` mints.
Omitted → `["read","prompt"]`. Unknown names are ignored; a list that leaves no known
capability is refused with `bridge/bad-request` and `details.field = "capabilities"` — a token
that can do nothing is never what the operator meant. The panel also answers a refused
mutation this way (`{ "ok": false, "error": { code, message, details } }`) instead of throwing.

### `POST /api/lan-bridge.peer` — add, edit, probe or forget an outbound peer

```json
{ "action": "update", "name": "peer-b", "url": "http://192.168.1.44:5977", "token": "" }
```

| action | body | answer |
|---|---|---|
| `add` | `{ name, url, token }` | `{ ok: true, peer: { name, url, reachable, peerName?, capabilities? } }` |
| `update` | `{ name, url?, token? }` | same; an omitted/empty `token` keeps the stored one, which is what the edit form sends when the operator only fixes an address |
| `check` | `{ name }` | same shape, re-probed immediately (the 10s cache is cleared) |
| `remove` | `{ name }` | `{ ok: <existed>, name, removed }` |

This is the fix for "that machine took a new address": previously the only way to
move a peer was a tool call from an agent. `url` must be `http(s)://…`, an
explicit `token` must look like `lzb_…`; an unknown name answers
`bridge/not-found`, and every accepted change is audited as `peer.<action>`.

Notes a client needs, because they differ from a plain mutation:

- **`check` uses `ok` for reachability, not for success.** An unreachable peer
  answers `{ ok: false, peer: { name, url, reachable: false, error } }` with
  HTTP 200 and *no* `error` object at the top level. Render `peer.error`, not a
  generic failure.
- **`remove`/`forget` report `ok` = "existed".** Deleting something that was not
  there answers `ok: false`; a UI that treats `ok:false` as failure will report a
  harmless click as an error. "Target state already holds" is the friendlier read.

### `POST /api/lan-bridge.mirror` — decide a reverse-pairing request

```json
{ "action": "accept", "name": "peer-b" }
```

| action | meaning | answer |
|---|---|---|
| `accept` | store an outbound peer for the requester, mint our token for it with the same capabilities, and deliver that token back | `{ ok: true, name, state: "accepted", delivered: true }`; `delivered: false` with `error` means the peer could not be reached — accepting again mints a fresh token and retries |
| `reject` | refuse a still-pending request (a non-pending one answers `bridge/bad-request`) | `{ ok: true, name, state: "rejected" }` |
| `forget` | drop the record without touching the peer | `{ ok: <existed>, name }` |

A record whose state is `accepted` **with** an `error` is the honest middle state:
this machine has already stored the outbound peer and minted a token, but the
requester has not received it yet (it was offline). Accepting again mints a fresh
token and retries delivery, so a client can keep offering "retry" for exactly
those rows. `mirrors.out` entries stay in the list after acceptance; only
`pending` ones are waiting on somebody.

Accepting is operator-only by design: it lives on the cookie-authenticated panel
route, never on `/rpc`, so no peer can complete a pairing on its own behalf.

### `POST /api/lan-bridge.revoke` → `{ "name": "peer-a" }` → `{ "ok": true }`

### `POST /api/lan-bridge.settings` — the listening form

Body (every field optional; the panel sends the whole set):

```json
{ "name": "my-mac", "host": "0.0.0.0", "port": 5977, "insecureHttp": true,
  "allowPeersToCreateSessions": true, "autoAcceptMirror": false,
  "trustedHosts": ["mac.local:5977"], "tls": null, "discovery": false }
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

- `name` is 1–64 characters after trimming, with no control characters. It is the name peers
  see: `bridge.hello` returns it immediately and `lan_dsh_peers list` shows it on the other
  machine after its next handshake. Renaming never rebinds the socket and never drops a
  connected peer.
- `discovery` is a boolean: whether mDNS announces this machine (see *LAN discovery*
  below). It applies on the next start of the plugin and never rebinds the HTTP listener.
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
- Everything else (`name`, `allowPeersToCreateSessions`, `trustedHosts`, and `insecureHttp` while
  the host stays loopback) applies without touching the socket.
- Accepted values are persisted in `$DSH_HOME/lan-bridge/bridge.json` under `settings` and
  win over the bundle row's `config:` on the next start. An illegal saved value is ignored
  at boot (the row's posture is used) instead of preventing the listener from starting.
- These messages are operator-facing, so `error.message` is localized (Chinese); peer-facing
  errors stay English identifiers. Codes are shared.

## LAN discovery (mDNS, optional)

With `discovery.enabled` on (panel: 局域网发现, or `config.discovery.enabled`),
the bridge announces itself with a bounded mDNS responder: a PTR question for
`_dsh-lanbridge._tcp.local` on `224.0.0.251:5353` is answered with one PTR, one
SRV (the listening port, resolved *after* the bind, so a port of 0 still
advertises a real number), one TXT (`name`, `version`, `protocol`) and one A
record for the first non-loopback IPv4 address. Announcements repeat every
`discovery.intervalMs` (default 60 s) and answer a query immediately.

`lan_dsh_peers action=discover` browses for 1.5 s and returns
`{ name, address, port, version, url, known }` per bridge heard.

The switch takes effect on save: turning it on starts the responder, turning it off stops
it. A Host older than 0.3.9 needs a restart for either direction.

A bind that cannot happen (another app owns UDP 5353 — routine on Windows) is reported, not
swallowed: `start()` settles with `listening: false` and `status().error` carries the reason,
browsing raises `bridge/method-unavailable` with that text, and saving settings still
succeeds. Before 0.3.10 that case left `start()` pending forever.

**mDNS is link-local.** `224.0.0.251` is not routed, so discovery only crosses machines
that share a link (same subnet, or one bridged/VPN segment). Two machines that can reach
each other's unicast port but sit behind a router will not see each other this way — that
is a property of mDNS, not of the bridge. In that case give the address by hand
(`lan_dsh_peers action=add`), which works regardless of topology.

Discovery is advertisement only. It carries **no token** and grants nothing: a
discovered machine is a candidate, and driving it still needs a paired bearer
token (`lan_dsh_peers action=add`) and an explicitly shared Session. That split
is the point — the network may learn *where* a bridge is; only its operator
decides *who may*.

## Compatibility

`bridge.hello` is the only version gate: a controller refuses a listener whose `protocol`
differs, and a listener refuses methods it does not advertise. `sessionController` is a
pre-stable DSH API; a listener reports `bridge/method-unavailable` instead of degrading
silently when a mapped method is missing.
