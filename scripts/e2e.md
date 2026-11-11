# dsh-lan-bridge — verification runbook (protocol v1)

Verifies the listener against `PROTOCOL.md` using only `scripts/probe.mjs`. Run from the
repo root; Node >= 22, no installs.

## Prerequisites

- `dsh-lan-bridge` installed and enabled; panel role `both`, listener on (default
  `127.0.0.1:5977`). Restart the profile after role/host/port changes.
- One **shared, idle** Session (panel → share); keep one **unshared** for the negative test.
- A paired **read+prompt** token, from the profile's own Web UI console (same-origin cookies):

  ```js
  await (await fetch('/api/lan-bridge.pair', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'probe-laptop', capabilities: ['read', 'prompt'] }) })).json()
  // → { ok: true, token: "lzb_…" }   (shown once; only its hash is stored)
  ```

  ```sh
  export LAN_BRIDGE_URL=http://127.0.0.1:5977 LAN_BRIDGE_TOKEN=lzb_…
  ```

## Run in order

1. `node scripts/probe.mjs health` → `ok true`, `protocol 1`, your `name`.
2. `… hello` → capabilities + `maxPromptBytes / maxWaitMs / maxMessages`.
3. `… list` → table of `sessionId/title/running/shared/cwd`; note an idle shared id.
4. `… fence` → `7/7 passed`, exit 0.
5. `… transcript --session <id> --max 5` → `cursor=… records=5` plus `seq type` lines.
6. `… events --session <id> --seconds 5` → `snapshot` then `event` frames; Ctrl-C is clean.
7. `… e2e --unshared <unshared-id>` → 9 PASS (last line SKIP if you can't name one).
8. `./scripts/smoke.sh` → fence then e2e, ending in `smoke: PASS`.

`prompt`/`wait`/`cancel` are covered by `e2e`; run them by hand when triaging.

## When it fails

- `cannot reach …` / ECONNREFUSED → listener down or wrong port: re-check the panel's
  host/port and restart the profile.
- `HTTP 401` / `bridge/unauthorized` → token wrong or revoked: revoke + re-pair, re-export.
- `HTTP 403` → fence. The probe always sends `X-DSH-Bridge: 1` and never `Origin`, so check
  `Host`/`trustedHosts`: use a `--url` that matches (`127.0.0.1`, `localhost`, trusted entry).
- `session/not-shared` → share that Session in the panel.
- `session/not-found` → stale id: re-run `list`.
- `session/busy` / `select session … is running` → pick an idle Session.
- `wait reason=input-required` → an approval/input is pending on the Host: answer it locally.
- `wait reason=timeout` → no idle within 120 s: inspect the Host turn.
- `no frame events within Ns` → wrong session id, or `maxStreamMs` too short.
- `HTTP 429` → rate limited: pause, retry.

## Second machine

1. Listener: bind the LAN interface (non-loopback needs `insecureHttp: true` unless TLS);
   add the peer's `Host` to `trustedHosts` if you reach it by another name.
2. Controller: point `--url` at the listener's LAN IP and repeat steps 4 and 7:

   ```sh
   node scripts/probe.mjs health --url http://192.168.1.8:5977 --token "$LAN_BRIDGE_TOKEN"
   node scripts/probe.mjs fence  --url http://192.168.1.8:5977 --token "$LAN_BRIDGE_TOKEN"
   node scripts/probe.mjs e2e    --url http://192.168.1.8:5977 --token "$LAN_BRIDGE_TOKEN"
   ```

3. Repeat in the other direction if the second machine also listens. A `403` here usually
   means the URL host is not in `trustedHosts`.
