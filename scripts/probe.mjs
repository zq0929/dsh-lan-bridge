#!/usr/bin/env node
/**
 * dsh-lan-bridge probe.mjs — dependency-free protocol-v1 CLI client + self-test.
 *
 * Contract: ../PROTOCOL.md, treated as fixed. Node >= 22 (global fetch); no deps.
 *
 *   node scripts/probe.mjs <command> [--url URL] [--token BEARER] [--json]
 *
 * Commands: health hello list transcript prompt wait cancel events fence e2e
 * Env: LAN_BRIDGE_URL (default http://127.0.0.1:5977), LAN_BRIDGE_TOKEN
 */
import http from 'node:http';

const DEFAULT_URL = 'http://127.0.0.1:5977';
const PROMPT_TEXT = 'Reply with exactly the word PONG and nothing else.';
const E2E_WAIT_CAP_MS = 120_000;

/* --------------------------------------------------------------- args ---- */

const VALUE_FLAGS = new Set(['url', 'token', 'session', 'max', 'text', 'timeout-ms', 'seconds', 'unshared']);

function parseArgv(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    let value = eq === -1 ? undefined : token.slice(eq + 1);
    if (VALUE_FLAGS.has(name)) {
      if (value === undefined) value = argv[++i];
      if (value === undefined) die(`--${name} needs a value`);
      flags[name] = value;
    } else flags[name] = true;
  }
  return { command: positional[0], flags };
}

function die(msg, code = 2) { console.error(`probe: ${msg}`); process.exit(code); }
function need(flags, name) {
  const v = flags[name];
  if (v === undefined || v === true || v === '') die(`--${name} is required for this command`);
  return String(v);
}
const num = (v, fallback) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };
const omit = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));

/* ------------------------------------------------------------- output ---- */

function emit(flags, data, human) {
  if (flags.json) console.log(JSON.stringify(data, null, 2));
  else if (human) human(data);
}

function renderTable(rows, columns) {
  if (!rows.length) return '(none)';
  const cells = rows.map((row) => columns.map((c) => String(c.get(row) ?? '')));
  const widths = columns.map((c, i) => Math.max(c.title.length, ...cells.map((r) => r[i].length)));
  const fmt = (vals) => vals.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  return [fmt(columns.map((c) => c.title)), fmt(widths.map((w) => '-'.repeat(w))), ...cells.map(fmt)].join('\n');
}

/* ------------------------------------------------------------ network ---- */

class BridgeError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function targetUrl(flags, pathname, search = '') {
  const url = new URL(flags.url || DEFAULT_URL);
  url.pathname = pathname;
  url.search = search;
  return url;
}

/** Fence headers on every request; bearer only when a token is known. */
function fenceHeaders(token, extra = {}) {
  const headers = { 'x-dsh-bridge': '1', ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

const optionalToken = (flags) => flags.token || process.env.LAN_BRIDGE_TOKEN || '';
function tokenOf(flags) {
  const token = optionalToken(flags);
  if (!token) die('missing --token (or set LAN_BRIDGE_TOKEN)');
  return token;
}

async function doFetch(url, init = {}) {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
      throw new BridgeError(`request to ${url.origin}${url.pathname} aborted or timed out`);
    }
    throw new BridgeError(`cannot reach ${url.origin}${url.pathname} (${e?.cause?.code || e.message}) — is the listener up and --url right?`);
  }
}

let rpcSeq = 0;
async function rpc(flags, method, params = {}, { timeoutMs } = {}) {
  const res = await doFetch(targetUrl(flags, '/rpc'), {
    method: 'POST',
    headers: fenceHeaders(tokenOf(flags), { 'content-type': 'application/json' }),
    body: JSON.stringify({ id: `probe-${process.pid}-${++rpcSeq}`, method, params }),
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); }
  catch { throw new BridgeError(`/rpc returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`, { status: res.status }); }
  if (!res.ok) throw new BridgeError(`HTTP ${res.status} from /rpc (${body?.error?.code ?? 'no code'})`, { status: res.status, code: body?.error?.code });
  if (body?.ok !== true) {
    const err = body?.error ?? {};
    throw new BridgeError(`${err.code ?? 'bridge/internal'}: ${err.message ?? 'method failed'}`, { status: res.status, code: err.code, details: err.details });
  }
  return body.result ?? {};
}

async function getHealth(flags) {
  const res = await doFetch(targetUrl(flags, '/healthz'), { method: 'GET', headers: fenceHeaders(optionalToken(flags)) });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); }
  catch { throw new BridgeError(`/healthz returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`, { status: res.status }); }
  if (!res.ok) throw new BridgeError(`/healthz HTTP ${res.status}: ${text.slice(0, 200)}`, { status: res.status });
  return body;
}

/* ------------------------------------------------------------ records ---- */

/**
 * PROTOCOL.md types a transcript record as `{ event: { type, seq, time, data } }`.
 * Accept the wrapped shape first, and tolerate a bare inner event.
 */
const eventOf = (record) =>
  record && typeof record === 'object' && record.event && typeof record.event === 'object' ? record.event : record;
const seqOf = (record) => { const n = eventOf(record)?.seq; return typeof n === 'number' ? n : undefined; };

function deepStrings(value, out = [], depth = 0) {
  if (value == null || depth > 6) return out;
  if (typeof value === 'string') { out.push(value); return out; }
  if (Array.isArray(value)) { for (const v of value) deepStrings(v, out, depth + 1); return out; }
  if (typeof value === 'object') { for (const v of Object.values(value)) deepStrings(v, out, depth + 1); return out; }
  return out;
}

/* ----------------------------------------------------------- commands ---- */

async function cmdHealth(flags) {
  const body = await getHealth(flags);
  if (body.ok !== true) throw new BridgeError(`/healthz ok !== true: ${JSON.stringify(body)}`);
  if (body.protocol !== 1) throw new BridgeError(`/healthz protocol !== 1: ${JSON.stringify(body.protocol)}`);
  emit(flags, body, (b) => console.log(`ok       ${b.ok}\nprotocol ${b.protocol}\nname     ${b.name ?? '(unset)'}\napp      ${b.app ?? '(unset)'}${b.version ? ` (${b.version})` : ''}`));
}

async function cmdHello(flags) {
  const result = await rpc(flags, 'bridge.hello');
  if (result.protocol !== 1) throw new BridgeError(`hello protocol !== 1 (got ${JSON.stringify(result.protocol)})`);
  emit(flags, result, (r) => {
    console.log(`name ${r.name ?? '(unset)'}  app ${r.app ?? '?'}  version ${r.version ?? '?'}  protocol ${r.protocol ?? '?'}`);
    console.log('\ncapabilities');
    for (const key of Object.keys(r.capabilities ?? {}).sort()) console.log(`  ${r.capabilities[key] ? 'yes' : 'no '}  ${key}`);
    console.log('\nlimits');
    for (const key of Object.keys(r.limits ?? {}).sort()) console.log(`  ${key}: ${r.limits[key]}`);
  });
}

async function cmdList(flags) {
  const { sessions = [] } = await rpc(flags, 'session.list');
  emit(flags, { sessions }, (data) => {
    console.log(renderTable(data.sessions, [
      { title: 'sessionId', get: (s) => s.sessionId },
      { title: 'title', get: (s) => s.title },
      { title: 'running', get: (s) => s.running },
      { title: 'shared', get: (s) => s.shared },
      { title: 'cwd', get: (s) => s.cwd },
    ]));
    console.log(`\n${data.sessions.length} session(s)`);
  });
}

async function cmdTranscript(flags) {
  const sessionId = need(flags, 'session');
  const max = Math.max(1, num(flags.max, 20));
  const result = await rpc(flags, 'session.transcript', { sessionId, maxMessages: max });
  emit(flags, result, (r) => {
    if (flags.raw) { console.log(JSON.stringify(r, null, 2)); return; }
    const records = r.records ?? [];
    console.log(`cursor=${r.cursor ?? '?'} hasMore=${r.hasMore ?? '?'} records=${records.length}`);
    for (const record of records) {
      const event = eventOf(record);
      console.log(`${String(event?.seq ?? '?').padStart(6)}  ${event?.type ?? '(untyped)'}`);
    }
  });
}

async function cmdPrompt(flags) {
  const result = await rpc(flags, 'session.prompt', { sessionId: need(flags, 'session'), text: need(flags, 'text') });
  emit(flags, result, (r) => console.log(`accepted=${r.accepted} cursor=${r.cursor ?? '?'}`));
}

async function cmdWait(flags) {
  const timeoutMs = Math.max(1, num(flags['timeout-ms'], 60_000));
  const result = await rpc(flags, 'session.wait', { sessionId: need(flags, 'session'), timeoutMs }, { timeoutMs: timeoutMs + 20_000 });
  emit(flags, result, (r) => console.log(
    `reason=${r.reason ?? '?'} running=${r.running} cursor=${r.cursor ?? '?'} newRecords=${r.records?.length ?? 0} truncated=${r.truncated ?? '?'}`));
}

async function cmdCancel(flags) {
  const result = await rpc(flags, 'session.cancel', { sessionId: need(flags, 'session') });
  emit(flags, result, (r) => console.log(`accepted=${r.accepted}`));
}

/** SSE: `field: value` lines, `:` comments/heartbeats, blank-line dispatch, CRLF + chunk-boundary safe. */
async function cmdEvents(flags) {
  const sessionId = need(flags, 'session');
  const seconds = Math.max(1, num(flags.seconds, 15));
  const controller = new AbortController();
  let stopReason = 'timeout';
  const onSigint = () => { stopReason = 'sigint'; controller.abort(); };
  const timer = setTimeout(() => controller.abort(), seconds * 1000);
  process.once('SIGINT', onSigint);
  const frames = [];
  let heartbeats = 0;
  let ignored = 0;
  const startedAt = Date.now();
  const printFrame = (frame) => {
    const at = `[+${((Date.now() - startedAt) / 1000).toFixed(1)}s]`;
    const p = frame.payload ?? {};
    if (p.type === 'snapshot') console.log(`${at} snapshot cursor=${p.cursor ?? '?'} records=${p.records?.length ?? 0} hasMore=${p.hasMore ?? '?'}`);
    else if (p.type === 'event') console.log(`${at} event type=${p.event?.type ?? '?'} seq=${p.event?.seq ?? '?'}`);
    else console.log(`${at} frame (unrecognized payload) ${JSON.stringify(p).slice(0, 160)}`);
  };
  try {
    const res = await doFetch(targetUrl(flags, '/events', `?session=${encodeURIComponent(sessionId)}`), {
      method: 'GET',
      headers: fenceHeaders(tokenOf(flags), { accept: 'text/event-stream' }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new BridgeError(`/events HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`, { status: res.status });
    const decoder = new TextDecoder();
    let buffer = '';
    let eventName = '';
    let dataLines = [];
    const dispatch = () => {
      if (dataLines.length) {
        let payload = null;
        try { payload = JSON.parse(dataLines.join('\n')); } catch { /* keep null */ }
        if (eventName === '' || eventName === 'frame') {
          const frame = { atMs: Date.now() - startedAt, event: eventName || null, payload };
          frames.push(frame);
          if (!flags.json) printFrame(frame);
        } else ignored++;
      }
      eventName = '';
      dataLines = [];
    };
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') { dispatch(); continue; }
        if (line.startsWith(':')) { heartbeats++; continue; }
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') eventName = value;
        else if (field === 'data') dataLines.push(value);
      }
    }
    dispatch();
  } catch (error) {
    if (!(stopReason === 'sigint' || controller.signal.aborted || error?.name === 'AbortError')) throw error;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', onSigint);
  }
  emit(flags, { summary: { stopReason, frames: frames.length, heartbeats, unrecognizedEvents: ignored }, frames }, () => {
    console.log(`\n${frames.length} frame(s), ${heartbeats} heartbeat(s), ${ignored} unrecognized event(s) — stop: ${stopReason}`);
  });
  if (!frames.length && stopReason === 'timeout') {
    throw new BridgeError(`no frame events within ${seconds}s — check the session id, sharing, and maxStreamMs`);
  }
}

/* -------------------------------------------------------------- fence ---- */

function rawRequest(flags, { method = 'POST', path = '/rpc', hostHeader, headers = {}, body } = {}) {
  const url = new URL(flags.url || DEFAULT_URL);
  const finalHeaders = { ...headers };
  if (hostHeader) finalHeaders.host = hostHeader;
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  if (payload !== undefined) finalHeaders['content-length'] = Buffer.byteLength(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port || 80, path, method, headers: finalHeaders }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* null */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function cmdFence(flags) {
  const token = tokenOf(flags); // valid auth isolates every 403/404 from a 401
  const good = { 'content-type': 'application/json', 'x-dsh-bridge': '1', authorization: `Bearer ${token}` };
  const hello = { id: 'probe-fence', method: 'bridge.hello', params: {} };
  const cases = [
    ['a', 'no X-DSH-Bridge header', 403, () => rawRequest(flags, { headers: omit(good, ['x-dsh-bridge']), body: hello })],
    ['b', 'Origin: http://evil.test', 403, () => rawRequest(flags, { headers: { ...good, origin: 'http://evil.test' }, body: hello })],
    ['c1', 'wrong bearer', 401, () => rawRequest(flags, { headers: { ...good, authorization: 'Bearer lzb_probe_invalid_token' }, body: hello })],
    ['c2', 'absent bearer', 401, () => rawRequest(flags, { headers: omit(good, ['authorization']), body: hello })],
    ['d', 'foreign Host: evil.test', 403, () => rawRequest(flags, { headers: good, hostHeader: 'evil.test', body: hello })],
    ['e', 'unknown path GET /probe-unknown-path', 404, () => rawRequest(flags, { method: 'GET', path: '/probe-unknown-path', headers: good })],
    ['f', 'unknown method probe.unknown.method', '200 + ok:false bridge/*', () => rawRequest(flags, { headers: good, body: { id: 'probe-fence-f', method: 'probe.unknown.method', params: {} } })],
  ];
  const verdict = (expect, res) => {
    if (expect === 403 || expect === 401 || expect === 404 || expect === 405) {
      return { ok: res.status === expect, got: `HTTP ${res.status}` };
    }
    const code = res.json?.error?.code;
    const ok = res.status === 200 && res.json?.ok === false && typeof code === 'string' && code.startsWith('bridge/');
    return { ok, got: `HTTP ${res.status} ok=${res.json?.ok} code=${code ?? '-'}` };
  };
  const rows = [];
  for (const [id, name, expect, run] of cases) {
    let check;
    let hint = '';
    try {
      const res = await run();
      check = verdict(expect, res);
      if (!check.ok) hint = `body=${res.text.slice(0, 120).replace(/\s+/g, ' ')}`;
      if (res.status === 429) hint = 'HTTP 429 rate-limited — pause and re-run this case';
    } catch (error) {
      check = { ok: false, got: 'transport error' };
      hint = error.message;
    }
    rows.push({ id, name, expect: String(expect), got: check.got, verdict: check.ok ? 'PASS' : 'FAIL', hint });
  }
  const failed = rows.filter((r) => r.verdict === 'FAIL').length;
  emit(flags, { target: targetUrl(flags, '/').origin, cases: rows, passed: rows.length - failed, failed }, () => {
    console.log(renderTable(rows, [
      { title: '#', get: (r) => r.id },
      { title: 'case', get: (r) => r.name },
      { title: 'expect', get: (r) => r.expect },
      { title: 'got', get: (r) => r.got },
      { title: 'verdict', get: (r) => r.verdict },
      { title: 'hint', get: (r) => r.hint },
    ]));
    console.log(`\n${rows.length - failed}/${rows.length} passed against ${targetUrl(flags, '/').origin}`);
  });
  if (failed) process.exitCode = 1;
}

/* ---------------------------------------------------------------- e2e ---- */

async function cmdE2e(flags) {
  const steps = [];
  const origin = targetUrl(flags, '/').origin;
  const add = (name, status, note = '') => {
    steps.push({ name, status, note });
    if (!flags.json) console.log(`${status.padEnd(4)}  ${name}${note ? `  ${note}` : ''}`);
  };
  const finish = () => {
    const pass = steps.every((s) => s.status !== 'FAIL');
    if (flags.json) console.log(JSON.stringify({ target: origin, pass, steps }, null, 2));
    else {
      const counts = steps.reduce((acc, s) => ({ ...acc, [s.status]: (acc[s.status] ?? 0) + 1 }), {});
      console.log(`\n${pass ? 'PASS' : 'FAIL'}  ${origin}  (${counts.PASS ?? 0} pass, ${counts.FAIL ?? 0} fail, ${counts.SKIP ?? 0} skip)`);
    }
    if (!pass) process.exitCode = 1;
  };
  /** Run one step; a thrown error records FAIL and the caller aborts. */
  const step = async (name, fn) => {
    try { add(name, 'PASS', await fn()); return true; }
    catch (error) { add(name, 'FAIL', error.message); return false; }
  };
  // health → hello → list
  let health;
  if (!(await step('health', async () => {
    health = await getHealth(flags);
    if (health.ok !== true) throw new Error(`ok !== true (${JSON.stringify(health.ok)})`);
    if (health.protocol !== 1) throw new Error(`protocol !== 1 (${JSON.stringify(health.protocol)})`);
    return `name=${health.name}`;
  }))) return finish();
  let hello;
  if (!(await step('hello', async () => {
    hello = await rpc(flags, 'bridge.hello');
    return `protocol=${hello.protocol} maxWaitMs=${hello.limits?.maxWaitMs ?? '?'}`;
  }))) return finish();
  let sessions;
  if (!(await step('list', async () => {
    ({ sessions = [] } = await rpc(flags, 'session.list'));
    if (!sessions.length) throw new Error('no shared sessions — share one in the UI panel first');
    return `${sessions.length} session(s)`;
  }))) return finish();
  // target selection: explicit --session, else first shared idle one
  let targetId = flags.session ? String(flags.session) : undefined;
  let target = sessions.find((s) => s.sessionId === targetId);
  if (!targetId) {
    target = sessions.find((s) => s.shared !== false && s.running !== true);
    if (!target) { add('select session', 'FAIL', 'no shared, non-running session — pass --session <id>'); return finish(); }
    targetId = target.sessionId;
  } else if (!target) {
    add('select session', 'FAIL', `--session ${targetId} is not in session.list (unshared or unknown)`);
    return finish();
  } else if (target.running === true) {
    add('select session', 'FAIL', `${targetId} is running — pass an idle session so a fresh turn is observable`);
    return finish();
  }
  add('select session', 'PASS', `${targetId} (${target.title ?? 'untitled'})`);
  // baseline cursor, then the prompt round-trip
  let baselineCursor = 0;
  if (!(await step('baseline transcript', async () => {
    const before = await rpc(flags, 'session.transcript', { sessionId: targetId, maxMessages: 1 });
    if (typeof before.cursor === 'number') baselineCursor = before.cursor;
    return `cursor=${before.cursor ?? '?'}`;
  }))) return finish();
  if (!(await step('prompt', async () => {
    const res = await rpc(flags, 'session.prompt', { sessionId: targetId, text: PROMPT_TEXT });
    if (res.accepted !== true) throw new Error(`accepted !== true (${JSON.stringify(res.accepted)})`);
    return `cursor=${res.cursor ?? '?'}`;
  }))) return finish();
  const maxWait = Math.min(E2E_WAIT_CAP_MS, Number(hello.limits?.maxWaitMs) || E2E_WAIT_CAP_MS);
  let waitResult;
  if (!(await step('wait', async () => {
    waitResult = await rpc(flags, 'session.wait', { sessionId: targetId, timeoutMs: maxWait }, { timeoutMs: maxWait + 20_000 });
    if (waitResult.reason !== 'idle') {
      throw new Error(waitResult.reason === 'input-required'
        ? 'reason=input-required (approval/input pending on the Host)'
        : `reason=${waitResult.reason} — no idle within ${maxWait}ms`);
    }
    return `idle within <=${maxWait}ms, newRecords=${waitResult.records?.length ?? 0}`;
  }))) return finish();
  // assert /PONG/i in records newer than the baseline cursor
  await step('assert PONG', async () => {
    const limit = Math.min(200, Number(hello.limits?.maxMessages) || 200);
    const after = await rpc(flags, 'session.transcript', { sessionId: targetId, maxMessages: limit });
    const fresh = [...(waitResult.records ?? []), ...(after.records ?? [])].filter((record) => {
      const seq = seqOf(record);
      return seq === undefined || seq > baselineCursor;
    });
    const hit = fresh.find((record) => deepStrings(eventOf(record)?.data ?? record).some((text) => /PONG/i.test(text)));
    if (!hit) throw new Error(`no /PONG/i text in ${fresh.length} new record(s) — did the Host agent answer?`);
    const event = eventOf(hit);
    return `seq=${event?.seq ?? '?'} type=${event?.type ?? '?'} in ${fresh.length} new record(s)`;
  });
  // unshared session must be refused (SKIP when the list exposes none)
  const unsharedId = flags.unshared ? String(flags.unshared) : sessions.find((s) => s.shared === false)?.sessionId;
  if (!unsharedId) {
    add('unshared rejected', 'SKIP', 'session.list only exposes shared sessions; pass --unshared <sessionId> to test it');
  } else {
    try {
      await rpc(flags, 'session.transcript', { sessionId: unsharedId, maxMessages: 1 });
      add('unshared rejected', 'FAIL', `session.transcript succeeded on ${unsharedId} — expected session/not-shared`);
    } catch (error) {
      if (error.code === 'session/not-shared') add('unshared rejected', 'PASS', `session/not-shared for ${unsharedId}`);
      else add('unshared rejected', 'FAIL', `${unsharedId}: got ${error.code ?? error.message}, expected session/not-shared`);
    }
  }
  return finish();
}

/* --------------------------------------------------------------- main ---- */

const USAGE = `dsh-lan-bridge probe (protocol v1)
  node scripts/probe.mjs <command> [flags]

Commands
  health | hello | list                  GET /healthz, bridge.hello, session.list
  transcript --session <id> [--max N] [--raw]
  prompt --session <id> --text "..."     wait --session <id> [--timeout-ms N]
  cancel --session <id>                  events --session <id> [--seconds N]
  fence                                  negative fence/auth cases via raw node:http
  e2e [--session <id>] [--unshared <id>]

Flags
  --url <http://127.0.0.1:5977>          listener base URL  (env LAN_BRIDGE_URL)
  --token <bearer>                       per-peer token     (env LAN_BRIDGE_TOKEN)
  --json                                 machine-readable output
`;

async function main() {
  const { command, flags } = parseArgv(process.argv.slice(2));
  if (!command || command === 'help' || flags.help) { console.log(USAGE); return; }
  const commands = {
    health: cmdHealth, hello: cmdHello, list: cmdList, transcript: cmdTranscript, prompt: cmdPrompt,
    wait: cmdWait, cancel: cmdCancel, events: cmdEvents, fence: cmdFence, e2e: cmdE2e,
  };
  const handler = commands[command];
  if (!handler) die(`unknown command "${command}" (try --help)`);
  await handler(flags);
}

main().catch((error) => {
  console.error(`probe: ${error?.message ?? error}`);
  if (error?.code) console.error(`probe: code=${error.code}`);
  process.exitCode = 1;
});
