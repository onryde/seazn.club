// Capture QR v2 §6.3.5 over HTTP (W27, owner sign-off 2026-10-06): `POST /api/v1/capture/codes/{code}/scoring-link`
// driven through its REAL handler and the REAL limiter (Redis replaced at the limiter's own test seam). The use-case
// (capture-scoring-link.test.ts) proves the decisions; this file proves the ROUTE carries them:
//   - the 2xx is the BARE `{url}` (no `ok`), parsed with the contract's twin, a repeat answering the same url;
//   - every refusal is `{code, message}` exactly, with its agreed status (replaced, match_finished, not_entitled, invalid,
//     code_ended);
//   - the body is STRICT: not JSON, an unknown key, a phone outside 16..64 → 422 invalid, nothing written;
//   - no Bearer and the org's own API key answer the ONE 401 body (never key-reachable);
//   - the limits: the code's budget (shared with the other phone routes) and the console's per-IP mint budget
//     (DEVICE_LINK_MINT_LIMIT, 10 per 60 s, in the console's `dlmint:<ip>` bucket) — the 11th is 429 with Retry-After;
//   - every answer is `private, no-store`; none is ever 410; the OpenAPI operation documents what was observed.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the route reads no sport (capture-scoring-link.test.ts pins cricket).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { captureRoute } from "@/server/api-v1/capture-http";
import { log } from "@/server/logger";
import { rigUser } from "@/server/relay/__tests__/_session-rig";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import { CaptureBeat, CaptureRefusal, CaptureScoringLinkOk } from "@/server/api-v1/capture-schemas";
import { createApiKey } from "@/server/usecases/api-keys";
import { postBeat } from "@/server/usecases/capture-phone";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { captureRig as rawRig, override, phoneId, type CaptureRig } from "@/server/usecases/__tests__/_capture-rig";
import { POST } from "../[code]/scoring-link/route";
import { POST as START } from "../[code]/start/route";

const HAS_DB = !!process.env.DATABASE_URL;

// Sentry's `captureException`, spied (http.test.ts's precedent) and otherwise the real module: it is what proves a
// refusal the phone acts on does not page anyone (review M4).
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/nextjs", async (io) => ({ ...(await io<Record<string, unknown>>()), captureException: sentry.captureException }));

async function captureRig(opts: Parameters<typeof rawRig>[0] = {}) {
  const r = await rawRig(opts);
  setRelayDriversForTest(r.deps.drivers);
  await override(r.auth.orgId, "scoring.device_links", true);
  return r;
}
afterAll(() => setRelayDriversForTest(null));

/** The brief's pattern, verbatim; §10.4's and the console's mint numbers, typed from the spec. */
const URL_PATTERN = /^https:\/\/[^/]+\/score\/dl_[A-Za-z0-9_-]{43}$/;
const MINT = { max: 10, windowSeconds: 60 };

const ENV_KEYS = ["RELAY_KEK", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS", "DEVICE_LINK_KEK"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeAll(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.DEVICE_LINK_KEK = randomBytes(32).toString("hex");
  process.env.OAUTH_BASE_URL = "https://scoring-link-route.test";
});
afterAll(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});
afterEach(() => __setRateLimitCounterForTests(null));

/** limits-route.test.ts's windowed counter: INCR, EXPIRE on the first hit, PTTL in the same answer; records every key. */
function windowedRedis() {
  let now = 0;
  const keys = new Map<string, { count: number; expiresAt: number }>();
  const spent: string[] = [];
  __setRateLimitCounterForTests(async (key, windowSeconds) => {
    spent.push(key);
    let k = keys.get(key);
    if (k && k.expiresAt <= now) { keys.delete(key); k = undefined; }
    if (!k) { k = { count: 0, expiresAt: now + windowSeconds * 1000 }; keys.set(key, k); }
    k.count++;
    return { count: k.count, ttlMs: k.expiresAt - now };
  });
  return { advance: (ms: number) => { now += ms; }, spent };
}

const BASE = "https://test.local/api/v1/capture/codes";
const IP = "203.0.113.9";
function call(code: string, payload: unknown, opts: { auth?: string | null; raw?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": `${opts.ip ?? IP}, 10.0.0.1` };
  if (opts.auth !== null && opts.auth !== undefined) headers.authorization = opts.auth;
  return POST(new Request(`${BASE}/${code}/scoring-link`, { method: "POST", headers, body: opts.raw ?? JSON.stringify(payload) }), { params: Promise.resolve({ code }) });
}
const statuses: number[] = [];
async function read(res: Response) {
  statuses.push(res.status);
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, cache: res.headers.get("cache-control"), pragma: res.headers.get("pragma"), retryAfter: res.headers.get("retry-after") };
}
const NO_STORE = { cache: "private, no-store", pragma: "no-cache" };

async function claim(r: CaptureRig, phone: string) {
  await postBeat(r.code, r.tok, CaptureBeat.parse({
    code: r.code, slot: 0, phone, claim: "new", device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "capture-test/1",
  }), r.deps, r.now());
}
const linkCount = async (r: CaptureRig) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from device_links where fixture_id = ${r.fixtureId}`)[0]!.n;

let refusalsChecked = 0;
function expectRefusal(a: Awaited<ReturnType<typeof read>>, status: number, code: string, why: string) {
  expect(a, why).toMatchObject({ status, ...NO_STORE, body: { code } });
  expect(CaptureRefusal.parse(a.body), why).toEqual(a.body);
  expect(Object.keys(a.body).sort(), why).toEqual(["code", "message"]);
  refusalsChecked++;
}

describe.skipIf(!HAS_DB)("POST /api/v1/capture/codes/{code}/scoring-link", () => {
  it("200: the bare {url} on the agreed pattern, no-store; a repeat answers the SAME url and writes nothing; a stranger is 409 replaced on the wire", async () => {
    const r = await captureRig();
    const A = phoneId("a");
    await claim(r, A);
    const ok = await read(await call(r.code, { phone: A }, { auth: `Bearer ${r.tok}` }));
    expect(ok).toMatchObject({ status: 200, ...NO_STORE });
    expect(Object.keys(ok.body)).toEqual(["url"]);
    expect(CaptureScoringLinkOk.parse(ok.body)).toEqual(ok.body);
    expect(String(ok.body.url)).toMatch(URL_PATTERN);
    const again = await read(await call(r.code, { phone: A }, { auth: `Bearer ${r.tok}` }));
    expect(again).toMatchObject({ status: 200, ...NO_STORE, body: { url: ok.body.url } });
    expect(await linkCount(r)).toBe(1);
    expectRefusal(await read(await call(r.code, { phone: phoneId("x") }, { auth: `Bearer ${r.tok}` })), 409, "replaced", "a stranger");
  });

  it("the refusals on the wire: 409 match_finished (nothing written), 402 not_entitled (nothing written) — each {code, message} exactly, no-store", async () => {
    const finished = await captureRig();
    const A = phoneId("a");
    await claim(finished, A);
    await sql`update fixtures set status = 'finalized' where id = ${finished.fixtureId}`;
    expectRefusal(await read(await call(finished.code, { phone: A }, { auth: `Bearer ${finished.tok}` })), 409, "match_finished", "finalized");
    expect(await linkCount(finished)).toBe(0);
    const unpaid = await captureRig();
    const B = phoneId("b");
    await claim(unpaid, B);
    await override(unpaid.auth.orgId, "scoring.device_links", false);
    expectRefusal(await read(await call(unpaid.code, { phone: B }, { auth: `Bearer ${unpaid.tok}` })), 402, "not_entitled", "no plan");
    expect(await linkCount(unpaid)).toBe(0);
  });

  it("STRICT body: not JSON, an unknown key, a phone of 15 or 65 characters, a missing phone → 422 invalid, no-store, nothing written", async () => {
    const r = await captureRig();
    const A = phoneId("a");
    await claim(r, A);
    const auth = `Bearer ${r.tok}`;
    const cases: [string, unknown, string?][] = [
      ["not JSON", null, "{nope"],
      ["an unknown key", { phone: A, slot: 0 }],
      ["a phone of 15", { phone: "p".repeat(15) }],
      ["a phone of 65", { phone: "p".repeat(65) }],
      ["no phone", {}],
    ];
    let checked = 0;
    for (const [why, payload, raw] of cases) {
      expectRefusal(await read(await call(r.code, payload, { auth, raw })), 422, "invalid", why);
      checked++;
    }
    expect(checked).toBe(5);
    expect(await linkCount(r)).toBe(0);
  });

  it("A17/C1: no Bearer, a wrong tok and the org's own API key answer the ONE 401 body; a malformed code is 404; nothing written", async () => {
    const r = await captureRig();
    const A = phoneId("a");
    await claim(r, A);
    await override(r.auth.orgId, "api.access", true);
    await override(r.auth.orgId, "api.write", true);
    const { secret } = await createApiKey(r.auth, { name: `capture-${randomUUID().slice(0, 6)}`, scopes: ["manage"] });
    const none = await read(await call(r.code, { phone: A }, { auth: null }));
    const wrong = await read(await call(r.code, { phone: A }, { auth: "Bearer wrong-tok" }));
    const key = await read(await call(r.code, { phone: A }, { auth: `Bearer ${secret}` }));
    for (const [why, a] of [["no Bearer", none], ["wrong tok", wrong], ["API key", key]] as const) {
      expectRefusal(a, 401, "code_ended", why);
      expect(a.body).toEqual(none.body);
    }
    expectRefusal(await read(await call("NOT_A_CODE!", { phone: A }, { auth: `Bearer ${r.tok}` })), 404, "not_a_stream_code", "malformed code");
    expect(await linkCount(r)).toBe(0);
  });

  it("the limits: each call spends the code's ONE phone budget (the start's own bucket untouched) and the console's dlmint:<ip> bucket; the 11th call from one IP in 60 s is 429 with the window's remaining seconds, another IP is untouched, and it recovers", async () => {
    const redis = windowedRedis();
    const r = await captureRig();
    const A = phoneId("a");
    await claim(r, A);
    const first = await read(await call(r.code, { phone: A }, { auth: `Bearer ${r.tok}` }));
    expect(first.status).toBe(200);
    const mine = redis.spent.slice();
    expect(mine.filter((k) => k.startsWith(`rl:capture-code:${r.code}:`)), "the code's budget, once").toHaveLength(1);
    expect(mine.filter((k) => k.startsWith("rl:capture-start:")), "never the start's own budget").toEqual([]);
    expect(mine.filter((k) => k.includes("dlmint:")), "the console's mint bucket, keyed on the client IP").toEqual([`rl:dlmint:${IP}`]);
    expect(mine, "nothing else").toHaveLength(2);
    // The code's budget is the SAME bucket the start spends (one budget across the phone routes).
    redis.spent.length = 0;
    await START(new Request(`${BASE}/${r.code}/start`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": IP, authorization: `Bearer ${r.tok}` }, body: JSON.stringify({ phone: A }) }), { params: Promise.resolve({ code: r.code }) });
    expect(redis.spent.filter((k) => k.startsWith("rl:capture-code:"))).toEqual(mine.filter((k) => k.startsWith("rl:capture-code:")));
    redis.advance(20_400);   // the dlmint window opened 20.4 s ago: 39.6 s remain → Retry-After 40
    for (let i = 2; i <= MINT.max; i++) expect((await read(await call(r.code, { phone: A }, { auth: `Bearer ${r.tok}` }))).status, `call ${i}`).toBe(200);
    const limited = await read(await call(r.code, { phone: A }, { auth: `Bearer ${r.tok}` }));
    expect(limited).toMatchObject({ status: 429, ...NO_STORE, retryAfter: "40", body: { code: "rate_limited" } });
    expect(CaptureRefusal.parse(limited.body)).toEqual(limited.body);
    expect(Object.keys(limited.body).sort()).toEqual(["code", "message"]);
    expect((await read(await call(r.code, { phone: A }, { auth: `Bearer ${r.tok}`, ip: "198.51.100.4" }))).status, "another IP").toBe(200);
    redis.advance(40_000);
    expect((await read(await call(r.code, { phone: A }, { auth: `Bearer ${r.tok}` }))).status, "recovered").toBe(200);
    expect(await linkCount(r), "every 200 was the same link").toBe(1);
  });

  it("the mint budget is spent ONLY past the tok and holder checks (review M2): no Bearer, a wrong tok, a stranger phone and a replaced phone are refused WITHOUT touching dlmint:<ip>; the current phone then spends it exactly once", async () => {
    const redis = windowedRedis();
    const r = await captureRig();
    const A = phoneId("a"), B = phoneId("b");
    await claim(r, A);
    const auth = `Bearer ${r.tok}`;
    const mintKeys = () => redis.spent.filter((k) => k.includes("dlmint:"));
    const refusedCalls: [string, () => Promise<Response>, number, string][] = [
      ["no Bearer", () => call(r.code, { phone: A }, { auth: null }), 401, "code_ended"],
      ["a wrong tok", () => call(r.code, { phone: A }, { auth: "Bearer wrong-tok" }), 401, "code_ended"],
      ["a stranger phone", () => call(r.code, { phone: phoneId("x") }, { auth }), 409, "replaced"],
      ["the replaced phone", async () => { await claim(r, B); return call(r.code, { phone: A }, { auth }); }, 409, "replaced"],
    ];
    let checked = 0;
    for (const [why, run, status, code] of refusedCalls) {
      redis.spent.length = 0;
      expectRefusal(await read(await run()), status, code, why);
      expect(redis.spent.length, `${why}: the limiter did run (the code's budget)`).toBeGreaterThan(0);
      expect(mintKeys(), `${why}: the mint bucket is untouched`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(4);
    // The positive pair: the current phone (B, after the take-over) is past both checks, and spends the bucket once.
    redis.spent.length = 0;
    expect((await read(await call(r.code, { phone: B }, { auth }))).status).toBe(200);
    expect(mintKeys()).toEqual([`rl:dlmint:${IP}`]);
  });

  it("the code's issuer DELETED → 401 code_ended on the wire, the ONE 401 body; never reported to Sentry, never an error log, nothing written (review M4) — and the spy does see an unmapped error (the positive pair)", async () => {
    const r = await captureRig();
    const A = phoneId("a");
    await claim(r, A);
    const gone = await rigUser();
    await sql`update fixture_stream_codes set issued_by = ${gone} where fixture_id = ${r.fixtureId} and ended_at is null`;
    await sql`delete from users where id = ${gone}`;
    sentry.captureException.mockClear();
    const error = vi.spyOn(log, "error");
    let errored: unknown[][];
    try {
      const a = await read(await call(r.code, { phone: A }, { auth: `Bearer ${r.tok}` }));
      expectRefusal(a, 401, "code_ended", "the issuer deleted");
      const wrong = await read(await call(r.code, { phone: A }, { auth: "Bearer wrong-tok" }));
      expect(a.body, "C1: the same body as a wrong tok").toEqual(wrong.body);
    } finally {
      errored = [...error.mock.calls];
      error.mockRestore();
    }
    expect(sentry.captureException, "no Sentry report").not.toHaveBeenCalled();
    expect(errored, "no error log").toEqual([]);
    expect(await linkCount(r)).toBe(0);
    const silenced = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      expect((await captureRoute(async () => { throw new Error("an unmapped failure"); })).status).toBe(503);
    } finally {
      silenced.mockRestore();
    }
    expect(sentry.captureException, "the positive pair: an unmapped error IS reported").toHaveBeenCalledTimes(1);
  });

  it("OpenAPI (A16): under the internal `capture` tag, BARE, captureTok, the strict body; documents every status this file observed and the agreed 503", () => {
    const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, { tags: string[]; security: unknown[]; requestBody?: unknown; responses: Record<string, unknown> }>> };
    const op = doc.paths["/api/v1/capture/codes/{code}/scoring-link"]!.post!;
    expect(op.tags).toEqual(["capture"]);
    expect(op.security).toEqual([{ captureTok: [] }]);
    expect(op.requestBody).toBeDefined();
    const observed = [...new Set(statuses)].sort();
    expect(observed).toEqual([200, 401, 402, 404, 409, 422, 429]);
    for (const s of [...observed, 503]) expect(op.responses[String(s)], String(s)).toBeDefined();
  });

  it("never 410, and every refusal was the bare body: the file did answer", () => {
    expect(statuses.length).toBeGreaterThan(20);
    expect(statuses).not.toContain(410);
    // replaced, match_finished, not_entitled, invalid ×5, code_ended ×3, not_a_stream_code; the mint budget's
    // code_ended ×2 and replaced ×2; the deleted issuer's code_ended.
    expect(refusalsChecked).toBe(17);
  });
});
