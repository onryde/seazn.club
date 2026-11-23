// The REAL-lila backend of the chess load harness (e2e/load/chess-30-boards.load.ts, LOAD_LICHESS=lila).
//
// The fixture (lichess-fixture-server.ts) is a hand-written Lichess; this is the other way round: a real lila (Lichess's
// own server code, lila-docker's mono image, booted on the CI runner by e2e/load/lila-up.sh with `net.ratelimit = true`,
// i.e. PRODUCTION rate limits ON) answers every call, and this proxy stands where the fixture stood - :4321, so
// LICHESS_BASE_URL does not move - forwarding each request to lila untouched and recording {method, path, status, at}
// exactly as the fixture's `calls` does. The harness's Lichess counters, windows and per-phase tallies therefore read
// the same shape from either backend, and the status is what this backend adds: a 429 is lila's limiter speaking.
//
// What it must NOT do, each pinned in src/server/external-play/__tests__/lichess-recording-proxy.test.ts:
//   - change a request. The bearer is what lila's challenge limiter keys the challenger on (lila Challenge.scala
//     `limit.challengeUser(me, ...)`), so Authorization, User-Agent and the body go through byte for byte; only Host
//     becomes lila's (lila redirects a browser-shaped request on a wrong host, HttpFilter.redirectWrongDomain).
//   - change an answer. A 429 and its body are the measurement.
//   - buffer a board stream. Our server reads the first line of /api/board/game/stream/{id} and closes (board-api.ts
//     readGameStream); lila holds that stream open, so a buffering proxy would turn every reconcile into a 10 s timeout.
//     The caller leaving closes lila's side too.
//   - keep a token. A record carries no header and no body: lila's 400 for a bad bulk-pairing token ECHOES the token as
//     a JSON key (lila-spike-report.md), so nothing here ever logs or stores a body.
// A lila that does not answer is a 502 to the caller and a status-0 record ("no answer"), never a status lila did not send.
import { createServer, request as httpRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders, type Server } from "node:http";
import { LICHESS_FIXTURE_PORT } from "./lichess-fixture-server";
import { normalisePath } from "./load/load-stats";

export interface LichessProxyCall {
  method: string;
  /** Path without the query string (the fixture's convention: load-stats.ts normalisePath reads both). */
  path: string;
  /** lila's status. 0: no answer from lila (refused, reset, or the caller left before lila answered). */
  status: number;
  /** Epoch ms the request arrived. */
  at: number;
}

export interface LichessRecordingProxy {
  url: string;
  port: number;
  /** Every request, in arrival order, pushed BEFORE it is forwarded (a request lila never answers is still on the record). */
  calls: LichessProxyCall[];
  close(): Promise<void>;
}

/** RFC 9110 §7.6.1 connection-specific fields, plus Host (lila's own is set): never forwarded either way. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);

function forwardable(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = v;
  return out;
}

export async function startLichessRecordingProxy(opts: { upstream: string; port?: number }): Promise<LichessRecordingProxy> {
  const up = new URL(opts.upstream);
  if (up.protocol !== "http:") throw new Error(`lichess-recording-proxy: the upstream must be a plain http lila on the runner, got ${up.protocol}`);
  const calls: LichessProxyCall[] = [];
  const server: Server = createServer((req, res) => {
    const call: LichessProxyCall = { method: req.method ?? "GET", path: new URL(req.url ?? "/", "http://proxy").pathname, status: 0, at: Date.now() };
    calls.push(call);
    const upstreamReq = httpRequest(
      {
        hostname: up.hostname,
        port: up.port === "" ? 80 : Number(up.port),
        // The runner's lila is published on IPv4; "localhost" may resolve to ::1 first.
        ...(up.hostname === "localhost" ? { family: 4 } : {}),
        method: call.method,
        path: req.url ?? "/",
        headers: { ...forwardable(req.headers), host: up.host },
      },
      (upRes) => {
        call.status = upRes.statusCode ?? 0;
        res.writeHead(call.status, forwardable(upRes.headers));
        upRes.pipe(res);
        upRes.on("error", () => res.destroy());
      },
    );
    upstreamReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }).end('{"error":"lichess-recording-proxy: no answer from lila"}');
      else res.destroy();
    });
    // The caller left before the answer was through (a board stream read for its first line, a 10 s timeout): close lila's side.
    res.on("close", () => {
      if (!res.writableFinished) upstreamReq.destroy();
    });
    req.pipe(upstreamReq);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? LICHESS_FIXTURE_PORT, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : (opts.port ?? LICHESS_FIXTURE_PORT);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    calls,
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

/** What the report adds for the real-lila backend: how many 429s, the earliest (endpoint, raw path, second of the run), and
 *  per endpoint (ids folded by normalisePath) how many answers of each status. `startedAt` is the run's origin. */
export function proxyStatusSummary(calls: readonly LichessProxyCall[], startedAt: number): {
  calls: number;
  status429: number;
  first429: { endpoint: string; path: string; atSecond: number } | null;
  statusByPath: Record<string, Record<string, number>>;
} {
  const statusByPath: Record<string, Record<string, number>> = {};
  let first: LichessProxyCall | null = null;
  let status429 = 0;
  for (const c of calls) {
    const key = `${c.method} ${normalisePath(c.path)}`;
    const row = (statusByPath[key] ??= {});
    row[String(c.status)] = (row[String(c.status)] ?? 0) + 1;
    if (c.status === 429) {
      status429 += 1;
      if (first === null || c.at < first.at) first = c;
    }
  }
  return {
    calls: calls.length,
    status429,
    first429: first === null ? null : { endpoint: `${first.method} ${normalisePath(first.path)}`, path: `${first.method} ${first.path}`, atSecond: Math.round((first.at - startedAt) / 100) / 10 },
    statusByPath,
  };
}

export type LilaAccount = { id: string; token: string; scopes: string[] };

/** lila user ids are lower-case (User.normalize); our minted ones are `szl0001`-shaped. */
const LILA_ID = /^[a-z0-9][a-z0-9_-]{1,29}$/;
const LILA_TOKEN = /^lip_[A-Za-z0-9_-]+$/;

/** The accounts lila-up.sh minted (a JSON array of {id, token, scopes}), checked before a single player is linked: at least `need`
 *  of them, ids and tokens unique and well formed, and every grant EXACTLY `scopes` (the product's own play grant, lib/oauth.ts) -
 *  a wider grant would hide a missing-scope refusal, a narrower one would red every seat. Returns the first `need`. A refusal names
 *  the account by index and id, never by token. */
export function parseLilaAccounts(raw: unknown, need: number, scopes: readonly string[]): LilaAccount[] {
  if (!Array.isArray(raw)) throw new Error("lila accounts: the file is not an array");
  if (raw.length < need) throw new Error(`lila accounts: ${need} needed, ${raw.length} minted`);
  const want = [...new Set(scopes)].sort().join(" ");
  const ids = new Set<string>();
  const tokens = new Set<string>();
  const out: LilaAccount[] = [];
  raw.forEach((a: unknown, i) => {
    const x = (a ?? {}) as { id?: unknown; token?: unknown; scopes?: unknown };
    if (typeof x.id !== "string" || !LILA_ID.test(x.id)) throw new Error(`lila accounts: account ${i}: id is not a lila user id`);
    if (typeof x.token !== "string" || !LILA_TOKEN.test(x.token)) throw new Error(`lila accounts: account ${i}: token is not a lip_ personal token`);
    if (!Array.isArray(x.scopes) || [...new Set(x.scopes.map(String))].sort().join(" ") !== want || x.scopes.length !== new Set(x.scopes).size) {
      throw new Error(`lila accounts: account ${i}: scopes are not exactly the play grant (${want})`);
    }
    if (ids.has(x.id)) throw new Error(`lila accounts: account ${i}: duplicate id ${x.id}`);
    if (tokens.has(x.token)) throw new Error(`lila accounts: account ${i}: duplicate token`);
    ids.add(x.id);
    tokens.add(x.token);
    out.push({ id: x.id, token: x.token, scopes: x.scopes.map(String) });
  });
  return out.slice(0, need);
}

/** lila's own account of each game: POST /api/games/export/_ids (anonymous: at most 300 ids a request, lila Game.exportByIds),
 *  NDJSON back, one line per game it knows - an unknown id is simply absent. Sent straight to lila, never through the proxy, so
 *  the run's own reading is not counted as the product's traffic. */
export async function lilaGameStatuses(lilaUrl: string, ids: readonly string[]): Promise<{ id: string; status: string; winner: string | null }[]> {
  const out: { id: string; status: string; winner: string | null }[] = [];
  for (let i = 0; i < ids.length; i += 300) {
    const res = await fetch(`${lilaUrl.replace(/\/$/, "")}/api/games/export/_ids`, {
      method: "POST",
      headers: { Accept: "application/x-ndjson", "Content-Type": "text/plain" },
      body: ids.slice(i, i + 300).join(","),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status !== 200) throw new Error(`lila export by ids answered ${res.status}`);
    for (const line of (await res.text()).split("\n")) {
      if (line.trim() === "") continue;
      const g = JSON.parse(line) as { id?: unknown; status?: unknown; winner?: unknown };
      out.push({ id: String(g.id), status: String(g.status), winner: typeof g.winner === "string" ? g.winner : null });
    }
  }
  return out;
}

/** Every minted token answers GET /api/account as ITS account (straight to lila, not through the proxy). `bad` names failures by
 *  index and id, never by token. Eight at a time. */
export async function verifyLilaTokens(lilaUrl: string, accounts: readonly LilaAccount[]): Promise<{ checked: number; bad: string[] }> {
  const bad: { i: number; why: string }[] = [];
  let checked = 0;
  for (let i = 0; i < accounts.length; i += 8) {
    await Promise.all(
      accounts.slice(i, i + 8).map(async (a, j) => {
        const n = i + j;
        const res = await fetch(`${lilaUrl.replace(/\/$/, "")}/api/account`, { headers: { Authorization: `Bearer ${a.token}`, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
        checked += 1;
        if (res.status !== 200) {
          await res.body?.cancel();
          bad.push({ i: n, why: `account ${n} (${a.id}): /api/account answered ${res.status}` });
          return;
        }
        const body = (await res.json()) as { id?: unknown };
        if (body.id !== a.id) bad.push({ i: n, why: `account ${n} (${a.id}): /api/account is ${String(body.id)}` });
      }),
    );
  }
  return { checked, bad: bad.sort((x, y) => x.i - y.i).map((b) => b.why) };
}
