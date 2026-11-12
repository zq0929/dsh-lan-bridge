# Security policy

This plugin hands another machine the ability to **read and prompt your DSH sessions**. Treat a
leaked peer token the same way you would treat shell access to your account.

## Reporting

Please report vulnerabilities through GitHub's private advisory flow:
**Security → Advisories → Report a vulnerability** (do not open a public issue for an unpatched
vulnerability). A reproducer and the affected version (`bridge.hello` → `version`) help a lot.

## What is in scope

- Escaping the per-session share switch (reading/prompting a Session that was never shared).
- Escaping capability bits (a `read`-only token performing `prompt`/`control`/`create`/`archive`).
- Beating the request fence (browser origins, missing `X-DSH-Bridge`, unlisted `Host`) or the
  bearer authentication / rate limiter.
- Path traversal or arbitrary file access through the TLS options or the state directory.
- Persistent privilege after `revoke` (a revoked token must fail on the next request).

## File transfer (0.4.0) is a high-privilege capability

`files` lets a peer read and write any file **inside the named roots this machine declared**, and
nowhere else. It is off by default twice over: `files.enabled` must be set in the settings, and the
token must carry the `files` bit, which pairing never grants. Absolute paths never cross the wire;
segments are validated and every resolved path is re-checked with `realpath`, so `..`, drive
letters, Windows device names and symlink escapes are refused. Bytes are staged in
`<DSH_HOME>/lan-bridge/staging/`, verified against the declared SHA-256, and only then renamed into
place. Each committed upload and completed read is audited. Treat a `files` token like shell access
to those directories: issue it only to a machine you would let run commands there.

## Known, accepted limitations (not vulnerabilities)

- **Plaintext HTTP is the default transport.** The panel refuses to expose a non-loopback address
  without `insecureHttp: true` or TLS, but once enabled the bearer token travels unencrypted on the
  LAN. Use TLS (`tls.certFile` / `tls.keyFile`) on untrusted networks.
- **Approval relay is opt-in, bounded, and audited (0.3.13+).** A remote turn that stops on an
  approval stays blocked and reports `input-required` unless the operator mints a token with the
  `approve` capability, which pairing never grants by default. When granted, the peer can allow or
  refuse the specific tool calls DSH's own policy already stopped: the Host's `never` policy runs
  first and cannot be bypassed, only *shared* Sessions are visible or answerable, silence falls back
  to the local human prompt after `approvalRelayMs` (default 120 s), and every decision appends an
  audit line. Treat `approve` as the strongest bit in the set — it is the power to let work run on
  the other machine. Questions (`ask_user_question`) are still never answered remotely.
- **Cross-machine prompt injection is possible.** Text read from a remote Session is untrusted data;
  `docs/peer-prompt.md` tells controlling agents to treat it that way.
- **Pre-stable upstream API.** The bridge maps `ctx.sessionController` / `ctx.workspaceController`
  one-to-one; an upstream signature change surfaces as `bridge/method-unavailable`, not memory unsafety.
