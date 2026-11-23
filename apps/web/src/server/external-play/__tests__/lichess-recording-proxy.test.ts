// The real-lila load backend's instruments (e2e/lichess-recording-proxy.ts). With LOAD_LICHESS=lila the load harness
// keeps LICHESS_BASE_URL at :4321 and puts this proxy there, in front of a real lila: every request our server sends
// Lichess passes through it and is recorded {method, path, status, at}, so the harness's Lichess counters, windows and
// per-phase tallies read the same shape the fixture's `calls` gave them.
//
// The proxy is a measuring instrument, so what it must NOT do is the contract here: it must not change a request
// (the token and the User-Agent are what lila's limiter keys on), must not change an answer (a 429 is the
// measurement), must not buffer a board stream (our server takes the first line and closes - a buffering proxy would
// turn every reconcile read into a 10 s timeout), and must not keep anything it was handed (no token in a record).
//
// Every expected value is typed from the request this file sent or a hand count - never read back out of the proxy.
// Anti-vacuity: every sweep says how many it checked, and zero is a failure.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  lilaGameStatuses,
  parseLilaAccounts,
  proxyStatusSummary,
  startLichessRecordingProxy,
  verifyLilaTokens,
  type LichessProxyCall,
  type LichessRecordingProxy,
} from "../../../../e2e/lichess-recording-proxy";

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string; closed: Promise<void> };

/** A stand-in lila: records what reached it, answers with `answer`. */
async function fakeLila(answer: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<{ url: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const closed = new Promise<void>((resolve) => res.on("close", () => resolve()));
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body, closed });
      answer(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) await o.close();
});
async function track(server: Server): Promise<void> {
  open.push({ close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
}
async function proxyTo(upstream: string): Promise<LichessRecordingProxy> {
  const p = await startLichessRecordingProxy({ upstream, port: 0 });
  open.push(p);
  return p;
}

describe("startLichessRecordingProxy: forwards untouched, records {method, path, status, at}", () => {
  it("a create: method, path, query, form body, Authorization and User-Agent reach lila as sent, and the answer comes back as lila gave it", async () => {
    const lila = await fakeLila((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "x-lila": "yes" }).end('{"id":"cj5LgNEc","status":"created"}');
    });
    await track(lila.server);
    const proxy = await proxyTo(lila.url);
    const before = Date.now();
    const res = await fetch(`${proxy.url}/api/challenge/szl0002?keepAliveStream=false`, {
      method: "POST",
      headers: { Authorization: "Bearer lip_unit_secret", "User-Agent": "seazn-unit/1", "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: "clock.limit=600&clock.increment=5&rated=false&color=white&variant=standard",
    });
    const text = await res.text();
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(text).toBe('{"id":"cj5LgNEc","status":"created"}');
    expect(res.headers.get("x-lila"), "lila's own headers come back").toBe("yes");
    expect(lila.seen.length, "lila saw exactly the one request").toBe(1);
    const got = lila.seen[0]!;
    expect(got.method).toBe("POST");
    expect(got.url, "path AND query reach lila").toBe("/api/challenge/szl0002?keepAliveStream=false");
    expect(got.body, "the form body, byte for byte").toBe("clock.limit=600&clock.increment=5&rated=false&color=white&variant=standard");
    expect(got.headers.authorization, "the bearer lila's limiter keys the challenger on").toBe("Bearer lip_unit_secret");
    expect(got.headers["user-agent"], "the caller's User-Agent, not the proxy's").toBe("seazn-unit/1");
    expect(got.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(got.headers.accept).toBe("application/json");
    expect(got.headers.host, "Host is lila's (a wrong host is lila's redirect, not an API answer)").toBe(new URL(lila.url).host);

    expect(proxy.calls.length, "one call recorded").toBe(1);
    const call = proxy.calls[0]!;
    expect(Object.keys(call).sort(), "the record is {method, path, status, at} and nothing else: no token, no body").toEqual(["at", "method", "path", "status"]);
    expect(call.method).toBe("POST");
    expect(call.path, "path without the query, the fixture's convention").toBe("/api/challenge/szl0002");
    expect(call.status).toBe(200);
    expect(call.at).toBeGreaterThanOrEqual(before);
    expect(call.at).toBeLessThanOrEqual(after);
    expect(JSON.stringify(proxy.calls), "the token is in no record").not.toContain("lip_unit_secret");
  });

  it("a 429 is passed through as lila sent it, status and body, and recorded as a 429", async () => {
    const lila = await fakeLila((_req, res) => {
      res.writeHead(429, { "content-type": "application/json" }).end('{"error":"Too many requests. Try again later."}');
    });
    await track(lila.server);
    const proxy = await proxyTo(lila.url);
    const res = await fetch(`${proxy.url}/api/challenge/szl0004`, { method: "POST", headers: { Authorization: "Bearer lip_b" }, body: "clock.limit=600" });
    expect(res.status).toBe(429);
    expect(await res.text()).toBe('{"error":"Too many requests. Try again later."}');
    expect(res.headers.get("retry-after"), "the proxy invents no Retry-After (lila sends none)").toBeNull();
    expect(proxy.calls.map((c) => c.status)).toEqual([429]);
  });

  it("a board stream is not buffered: the first line arrives while lila holds the stream open, and the caller's cancel closes lila's side", async () => {
    const lila = await fakeLila((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write('{"type":"gameFull","id":"g1"}\n'); // ...and never end: lila holds a board stream open until the reader goes.
    });
    await track(lila.server);
    const proxy = await proxyTo(lila.url);
    const abort = new AbortController();
    const res = await fetch(`${proxy.url}/api/board/game/stream/g1`, { headers: { Authorization: "Bearer lip_s", Accept: "application/x-ndjson" }, signal: abort.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await Promise.race([
      reader.read().then((r) => new TextDecoder().decode(r.value)),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error("no first line in 2 s: the proxy buffered the stream")), 2_000)),
    ]);
    expect(first).toBe('{"type":"gameFull","id":"g1"}\n');
    expect(proxy.calls.map((c) => c.status), "the status is recorded at the headers, not at the end").toEqual([200]);
    abort.abort();
    await Promise.race([
      lila.seen[0]!.closed,
      new Promise<void>((_, rej) => setTimeout(() => rej(new Error("lila's stream still open 2 s after the caller left")), 2_000)),
    ]);
  });

  it("a lila that does not answer: the caller gets a 502, the record says status 0 (no answer), never a status lila did not send", async () => {
    // A port nothing listens on: bind one, read it, close it.
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", () => r()));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const proxy = await proxyTo(`http://127.0.0.1:${port}`);
    const res = await fetch(`${proxy.url}/api/account/playing?nb=50`, { headers: { Authorization: "Bearer lip_x" } });
    expect(res.status).toBe(502);
    expect(proxy.calls).toEqual([expect.objectContaining({ method: "GET", path: "/api/account/playing", status: 0 })]);
  });

  it("refuses to start in front of anything but a plain-http lila (the runner's own; it never fronts an https host)", async () => {
    let checked = 0;
    for (const upstream of ["https://127.0.0.1:9", "ws://127.0.0.1:9"]) {
      const started = startLichessRecordingProxy({ upstream, port: 0 });
      started.then((p) => open.push(p), () => undefined); // a proxy that wrongly starts is still closed
      await expect(started, upstream).rejects.toThrow(/the upstream must be a plain http lila on the runner, got (https|ws):/);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("the sequence: a second call and twenty concurrent ones are each recorded once, in arrival order, with lila's own status", async () => {
    const lila = await fakeLila((req, res) => {
      const code = req.url!.includes("bad") ? 400 : 200;
      res.writeHead(code, { "content-type": "application/json" }).end(code === 200 ? '{"ok":true}' : '{"error":"Not your turn, or game already over"}');
    });
    await track(lila.server);
    const proxy = await proxyTo(lila.url);
    await fetch(`${proxy.url}/api/board/game/g1/move/e2e4`, { method: "POST", headers: { Authorization: "Bearer lip_w" } });
    await fetch(`${proxy.url}/api/board/game/g1/move/bad`, { method: "POST", headers: { Authorization: "Bearer lip_w" } });
    await Promise.all(Array.from({ length: 20 }, (_, i) => fetch(`${proxy.url}/game/export/g${i}?moves=false`).then((r) => r.text())));
    expect(proxy.calls.length, "1 + 1 + 20 calls (zero would be a vacuous record)").toBe(22);
    expect(lila.seen.length, "and lila saw every one").toBe(22);
    expect(proxy.calls.slice(0, 2).map((c) => [c.path, c.status])).toEqual([
      ["/api/board/game/g1/move/e2e4", 200],
      ["/api/board/game/g1/move/bad", 400],
    ]);
    const exports = proxy.calls.slice(2);
    expect(new Set(exports.map((c) => c.path)).size, "twenty distinct exports").toBe(20);
    let checked = 0;
    for (let i = 1; i < proxy.calls.length; i += 1) {
      expect(proxy.calls[i]!.at, "arrival order").toBeGreaterThanOrEqual(proxy.calls[i - 1]!.at);
      checked += 1;
    }
    expect(checked).toBe(21);
  });
});

describe("proxyStatusSummary: the 429 count, the first 429, the status histogram per endpoint", () => {
  const T0 = 1_000_000;
  const call = (method: string, path: string, status: number, atS: number): LichessProxyCall => ({ method, path, status, at: T0 + atS * 1_000 });

  it("empty: nothing called is 0 calls, 0 429s, no first 429 and an empty histogram", () => {
    expect(proxyStatusSummary([], T0)).toEqual({ calls: 0, status429: 0, first429: null, statusByPath: {} });
  });

  it("hand-counted: the histogram groups by endpoint (ids folded), the first 429 is the EARLIEST by time, not the first in the list", () => {
    const calls = [
      call("POST", "/api/challenge/szl0002", 200, 1),
      call("POST", "/api/challenge/szl0004", 429, 42.5), // listed first of the 429s, but later
      call("POST", "/api/challenge/szl0006", 429, 12.25),
      call("POST", "/api/challenge/AbCd1234/accept", 200, 2),
      call("GET", "/api/board/game/stream/AbCd1234", 200, 3),
      call("GET", "/api/board/game/stream/EfGh5678", 0, 4),
      call("GET", "/game/export/AbCd1234", 429, 50),
    ];
    expect(proxyStatusSummary(calls, T0)).toEqual({
      calls: 7,
      status429: 3,
      first429: { endpoint: "POST /api/challenge/:id", path: "POST /api/challenge/szl0006", atSecond: 12.3 },
      statusByPath: {
        "POST /api/challenge/:id": { "200": 1, "429": 2 },
        "POST /api/challenge/:id/accept": { "200": 1 },
        "GET /api/board/game/stream/:id": { "200": 1, "0": 1 },
        "GET /game/export/:id": { "429": 1 },
      },
    });
  });

  it("no 429 at all: first429 is null and the count 0, with the other statuses still counted", () => {
    const s = proxyStatusSummary([call("GET", "/api/account/playing", 200, 1), call("POST", "/api/board/game/x/resign", 400, 2)], T0);
    expect(s.status429).toBe(0);
    expect(s.first429).toBeNull();
    expect(s.statusByPath).toEqual({ "GET /api/account/playing": { "200": 1 }, "POST /api/board/game/:id/resign": { "400": 1 } });
  });
});

describe("parseLilaAccounts: the minted lila users the harness links its players to", () => {
  const SCOPES = ["board:play", "challenge:write", "challenge:read"];
  const acct = (n: number, over: Record<string, unknown> = {}) => ({ id: `szl${String(n).padStart(4, "0")}`, token: `lip_tok${n}secret`, scopes: [...SCOPES], ...over });

  it("returns the first `need` accounts when every one is well formed and carries exactly the play grant", () => {
    const out = parseLilaAccounts([acct(1), acct(2), acct(3)], 2, SCOPES);
    expect(out.map((a) => a.id)).toEqual(["szl0001", "szl0002"]);
    expect(out[0]!.token).toBe("lip_tok1secret");
  });

  it("the scopes are compared as a set (lila's order is not ours), and a missing or extra scope is refused", () => {
    expect(parseLilaAccounts([acct(1, { scopes: ["challenge:read", "board:play", "challenge:write"] })], 1, SCOPES)).toHaveLength(1);
    expect(() => parseLilaAccounts([acct(1, { scopes: ["board:play", "challenge:write"] })], 1, SCOPES)).toThrow(/account 0: scopes/);
    expect(() => parseLilaAccounts([acct(1, { scopes: [...SCOPES, "challenge:bulk"] })], 1, SCOPES)).toThrow(/account 0: scopes/);
  });

  it("refuses too few accounts, a duplicate id or token, a malformed id or token, and a non-array - and never echoes a token", () => {
    const refusals: [unknown, number, RegExp][] = [
      [[acct(1)], 2, /2 needed, 1 minted/],
      [[acct(1), acct(1, { token: "lip_other" })], 2, /duplicate id szl0001/],
      [[acct(1), acct(2, { token: "lip_tok1secret" })], 2, /account 1: duplicate token/],
      [[acct(1, { id: "Not An Id" })], 1, /account 0: id/],
      [[acct(1, { token: "lio_e2e_x" })], 1, /account 0: token/],
      // The same SET as the grant, but a scope listed twice: the set comparison alone would pass it.
      [[acct(1, { scopes: [...SCOPES, "board:play"] })], 1, /account 0: scopes/],
      [{ accounts: [] }, 1, /not an array/],
      [[], 1, /1 needed, 0 minted/],
    ];
    let checked = 0;
    for (const [raw, need, re] of refusals) {
      let message = "";
      try {
        parseLilaAccounts(raw, need, SCOPES);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, `refused: ${re}`).toMatch(re);
      expect(message, "no token in the refusal").not.toMatch(/lip_tok|lip_other|lio_e2e_x/);
      checked += 1;
    }
    expect(checked).toBe(refusals.length);
  });
});

describe("lilaGameStatuses: lila's own account of the run's games", () => {
  it("exports by ids in batches of at most 300 (lila's anonymous cap) and returns every game lila sent", async () => {
    const lila = await fakeLila((req, res, body) => {
      if (req.url !== "/api/games/export/_ids") return res.writeHead(404).end();
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      // An unknown id is simply absent from lila's answer (nothing for "zz").
      for (const id of body.split(",").filter((x) => x !== "zz")) res.write(JSON.stringify({ id, status: id === "g7" ? "outoftime" : "resign", winner: "black" }) + "\n");
      res.end();
    });
    await track(lila.server);
    const ids = [...Array.from({ length: 301 }, (_, i) => `g${i}`), "zz"];
    const games = await lilaGameStatuses(lila.url, ids);
    expect(lila.seen.map((s) => s.body.split(",").length), "302 ids in two posts: 300, then 2").toEqual([300, 2]);
    expect(lila.seen.every((s) => s.method === "POST" && s.headers.accept === "application/x-ndjson")).toBe(true);
    expect(games.length, "every game lila knows (the unknown one is absent)").toBe(301);
    expect(games.find((g) => g.id === "g7")).toEqual({ id: "g7", status: "outoftime", winner: "black" });
    expect(games.filter((g) => g.status === "resign").length).toBe(300);
  });

  it("an empty id list asks lila nothing", async () => {
    const lila = await fakeLila((_req, res) => res.writeHead(500).end());
    await track(lila.server);
    expect(await lilaGameStatuses(lila.url, [])).toEqual([]);
    expect(lila.seen.length).toBe(0);
  });

  it("an export lila refuses (a 429, a 500) is a named throw, never a body parsed into a game", async () => {
    let checked = 0;
    for (const [code, body] of [[429, '{"error":"Too many requests. Try again later."}'], [500, "<html>oops</html>"]] as const) {
      const lila = await fakeLila((_req, res) => res.writeHead(code, { "content-type": "application/json" }).end(body));
      await track(lila.server);
      await expect(lilaGameStatuses(lila.url, ["g1", "g2"]), `export answered ${code}`).rejects.toThrow(`lila export by ids answered ${code}`);
      checked += 1;
    }
    expect(checked).toBe(2);
  });
});

describe("verifyLilaTokens: lila's own account of every minted token - whose it is, and the grant lila STORED", () => {
  const SCOPES = ["board:play", "challenge:write", "challenge:read"];
  /** A stand-in lila: `/api/account` by bearer, `/api/token/test` keyed by token (lila OAuth.testTokens: the body is the tokens,
   *  comma-separated; each answered null or {userId, scopes comma-joined, expires}). */
  async function lilaKnowing(tokens: Record<string, { userId: string; scopes: string } | null>) {
    return fakeLila((req, res, body) => {
      if (req.url === "/api/token/test" && req.method === "POST") {
        const out = Object.fromEntries(body.split(",").map((t) => [t, tokens[t] ? { ...tokens[t], expires: null } : null]));
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
      }
      const t = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      const who = tokens[t]?.userId;
      if (req.url !== "/api/account" || !who) return res.writeHead(401, { "content-type": "application/json" }).end('{"error":"No such token"}');
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: who, username: who }));
    });
  }
  const acct = (n: number) => ({ id: `szl000${n}`, token: `lip_a${n}`, scopes: [...SCOPES] });

  it("every token asked twice (identity, then grant) - and a clean set reports nothing", async () => {
    const lila = await lilaKnowing({
      lip_a1: { userId: "szl0001", scopes: "board:play,challenge:write,challenge:read" },
      lip_a2: { userId: "szl0002", scopes: "challenge:read,board:play,challenge:write" }, // lila's order is not ours
    });
    await track(lila.server);
    const out = await verifyLilaTokens(lila.url, [acct(1), acct(2)], SCOPES);
    expect(out).toEqual({ checked: 2, scopesChecked: 2, bad: [] });
    expect(lila.seen.filter((s) => s.url === "/api/account").length, "one identity read per token").toBe(2);
    const tested = lila.seen.filter((s) => s.url === "/api/token/test");
    expect(tested.length, "one grant read for the batch").toBe(1);
    expect(tested[0]!.body, "the tokens, comma-separated, as lila reads them").toBe("lip_a1,lip_a2");
  });

  it("names, by index and id and never by token: a stranger's token, an unknown one, a narrower grant, a wider grant, a repeated scope", async () => {
    const lila = await lilaKnowing({
      lip_a1: { userId: "szl0001", scopes: "board:play,challenge:write,challenge:read" },
      lip_a2: { userId: "someoneelse", scopes: "board:play,challenge:write,challenge:read" },
      lip_a3: null,
      lip_a4: { userId: "szl0004", scopes: "board:play,challenge:write" },
      lip_a5: { userId: "szl0005", scopes: "board:play,challenge:write,challenge:read,challenge:bulk" },
      lip_a6: { userId: "szl0006", scopes: "board:play,challenge:write,challenge:read,board:play" },
    });
    await track(lila.server);
    const out = await verifyLilaTokens(lila.url, [1, 2, 3, 4, 5, 6].map(acct), SCOPES);
    expect(out.checked).toBe(6);
    expect(out.scopesChecked).toBe(6);
    expect(out.bad).toEqual([
      "account 1 (szl0002): /api/account is someoneelse",
      "account 1 (szl0002): lila's token belongs to someoneelse",
      "account 2 (szl0003): /api/account answered 401",
      "account 2 (szl0003): lila does not know the token",
      "account 3 (szl0004): lila's grant is board:play challenge:write, not board:play challenge:read challenge:write",
      "account 4 (szl0005): lila's grant is board:play challenge:bulk challenge:read challenge:write, not board:play challenge:read challenge:write",
      "account 5 (szl0006): lila's grant is board:play board:play challenge:read challenge:write, not board:play challenge:read challenge:write",
    ]);
    expect(JSON.stringify(out), "no token in the verdict").not.toMatch(/lip_a/);
  });

  it("a token test lila refuses is one named failure for the batch, never a pass", async () => {
    const lila = await fakeLila((req, res) => {
      if (req.url === "/api/token/test") return res.writeHead(429, { "content-type": "application/json" }).end('{"error":"Too many requests. Try again later."}');
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "szl0001" }));
    });
    await track(lila.server);
    const out = await verifyLilaTokens(lila.url, [acct(1)], SCOPES);
    expect(out.bad).toEqual(["/api/token/test answered 429 for accounts 0-0"]);
    expect(out.scopesChecked, "nothing was checked, and the count says so").toBe(0);
  });
});
