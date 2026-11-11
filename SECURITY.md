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

## Known, accepted limitations (not vulnerabilities)

- **Plaintext HTTP is the default transport.** The panel refuses to expose a non-loopback address
  without `insecureHttp: true` or TLS, but once enabled the bearer token travels unencrypted on the
  LAN. Use TLS (`tls.certFile` / `tls.keyFile`) on untrusted networks.
- **No approval relay.** A remote turn that stops on an approval or a question stays blocked and is
  reported as `input-required`; the human at the controlled machine must act. This is deliberate:
  letting a remote peer answer approvals would make the token equivalent to full local control.
- **Cross-machine prompt injection is possible.** Text read from a remote Session is untrusted data;
  `docs/peer-prompt.md` tells controlling agents to treat it that way.
- **Pre-stable upstream API.** The bridge maps `ctx.sessionController` / `ctx.workspaceController`
  one-to-one; an upstream signature change surfaces as `bridge/method-unavailable`, not memory unsafety.
