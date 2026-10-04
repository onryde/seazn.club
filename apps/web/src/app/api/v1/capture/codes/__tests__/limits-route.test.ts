// Capture QR v2 §10.4 (amended §17.4, R4) over HTTP (T8c): the phone routes' rate limits, driven through the REAL
// handlers and the REAL limiter. Redis is replaced at the limiter's own test seam by a windowed counter on a tickable
// clock (the shape the Lua answers: {count, ttlMs}), so the 429s are executed, not assumed:
//   - CAPTURE_CODE_LIMIT: 120 per 60 s per code, ONE budget across the three routes; the 121st is 429;
//   - CAPTURE_START_LIMIT: 6 starts per 60 s per code, on top;
//   - CAPTURE_FAIL_LIMIT: 30 FAILED 401s per 60 s per client IP; a failure past it is 429 instead of 401 — and a VALID
//     tok from that IP is still admitted, whatever the bucket holds (B6 review I-1: the tok is 128 bits; refusing hits
//     let anyone sharing or forging a phone's IP lock it out);
//   - every 429 is the bare {code: rate_limited, message}, no-store, with Retry-After = the window's true remaining
//     seconds; and each limit RECOVERS once that many seconds have passed.
// The budgets are the spec's numbers (§10.4), never read back from rate-limit.ts.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): no limit reads a sport.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { CaptureBeat, CaptureRefusal } from "@/server/api-v1/capture-schemas";
import { saveStreamSettings } from "@/server/usecases/stream-codes";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { captureRig as rawRig, phoneId, type CaptureRig } from "@/server/usecases/__tests__/_capture-rig";
import { GET } from "../[code]/route";
import { POST as BEATS } from "../[code]/beats/route";
import { POST as START } from "../[code]/start/route";

const HAS_DB = !!process.env.DATABASE_URL;

/** The route builds its own deps (defaultDeps): it is pointed at the rig's fakes, whose storage pool is roomy, so no
 *  start here reads 503 storage_exhausted for a reason no test controls. */
async function captureRig(opts: Parameters<typeof rawRig>[0] = {}) {
  const r = await rawRig(opts);
  setRelayDriversForTest(r.deps.drivers);
  return r;
}
afterAll(() => setRelayDriversForTest(null));

/** §10.4's numbers, typed from the spec. */
const SPEC = { code: { max: 120, windowSeconds: 60 }, fail: { max: 30, windowSeconds: 60 }, start: { max: 6, windowSeconds: 60 } };

const ENV_KEYS = ["RELAY_KEK", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_INGEST_HOST", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeAll(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
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

/** A fixed-window counter with the Lua's semantics: INCR, EXPIRE on the first hit, PTTL in the same answer. It records
 *  every key it was asked to spend, so a test can say which bucket a request touched. */
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
type Opts = { tok?: string | null; ip?: string; extra?: Record<string, string> };
const headersOf = (o: Opts) => {
  const h: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": `${o.ip ?? "203.0.113.7"}, 10.0.0.1`, ...o.extra };
  if (o.tok !== null && o.tok !== undefined) h.authorization = `Bearer ${o.tok}`;
  return h;
};
const params = (code: string) => ({ params: Promise.resolve({ code }) });
const get = (code: string, o: Opts) => GET(new Request(`${BASE}/${code}`, { headers: headersOf(o) }), params(code));
const start = (code: string, phone: string, o: Opts) =>
  START(new Request(`${BASE}/${code}/start`, { method: "POST", headers: headersOf(o), body: JSON.stringify({ phone }) }), params(code));
function beatBody(r: CaptureRig, phone: string, claim: "new" | null) {
  return CaptureBeat.parse({
    code: r.code, slot: 0, phone, claim, device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "capture-test/1",
  });
}
const beat = (r: CaptureRig, phone: string, claim: "new" | null, o: Opts) =>
  BEATS(new Request(`${BASE}/${r.code}/beats`, { method: "POST", headers: headersOf(o), body: JSON.stringify(beatBody(r, phone, claim)) }), params(r.code));

let limitedChecked = 0;
/** Every 429 here: the bare refusal, no-store, and Retry-After = the remaining seconds the test expects. */
async function expectLimited(res: Response, retryAfter: number) {
  expect(res.status).toBe(429);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(res.headers.get("pragma")).toBe("no-cache");
  expect(res.headers.get("retry-after")).toBe(String(retryAfter));
  const body = (await res.json()) as Record<string, unknown>;
  expect(CaptureRefusal.parse(body)).toEqual(body);
  expect(body).toEqual({ code: "rate_limited", message: expect.any(String) });
  limitedChecked++;
}

describe.skipIf(!HAS_DB)("the phone routes' rate limits (§10.4, R4)", () => {
  it("CAPTURE_CODE_LIMIT: ONE budget of 120 per code across GET and beats; the 121st is 429 with the window's remaining seconds; another code is untouched; it recovers after Retry-After", async () => {
    const redis = windowedRedis();
    const r = await captureRig();
    const other = await captureRig();
    const A = phoneId("a");
    expect((await beat(r, A, "new", { tok: r.tok })).status).toBe(200);
    redis.advance(17_400);   // the window opened 17.4 s ago: 42.6 s remain → Retry-After 43
    let ok = 1;
    for (; ok < SPEC.code.max; ok++) {
      const res = ok % 2 === 0 ? await get(r.code, { tok: r.tok }) : await beat(r, A, null, { tok: r.tok });
      expect(res.status, `request ${ok + 1}`).toBe(200);
    }
    expect(ok).toBe(SPEC.code.max);
    await expectLimited(await get(r.code, { tok: r.tok }), Math.ceil((SPEC.code.windowSeconds * 1000 - 17_400) / 1000));
    await expectLimited(await beat(r, A, null, { tok: r.tok }), 43);
    expect((await get(other.code, { tok: other.tok })).status, "per code, not global").toBe(200);
    redis.advance(42_599);
    await expectLimited(await get(r.code, { tok: r.tok }), 1);
    redis.advance(1);
    expect((await get(r.code, { tok: r.tok })).status, "recovered once Retry-After has passed").toBe(200);
  });

  it("CAPTURE_START_LIMIT: 6 starts per 60 s per code on top — the 1st 200, the next five already_live, the 7th 429; then recovery", async () => {
    const redis = windowedRedis();
    const r = await captureRig();
    const A = phoneId("a");
    expect((await beat(r, A, "new", { tok: r.tok })).status).toBe(200);
    await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.target.id });
    const answers: number[] = [];
    for (let i = 0; i < SPEC.start.max; i++) answers.push((await start(r.code, A, { tok: r.tok })).status);
    expect(answers).toEqual([200, 409, 409, 409, 409, 409]);
    await expectLimited(await start(r.code, A, { tok: r.tok }), SPEC.start.windowSeconds);
    expect((await get(r.code, { tok: r.tok })).status, "the start budget is the start's own").toBe(200);
    redis.advance(SPEC.start.windowSeconds * 1000);
    expect((await start(r.code, A, { tok: r.tok })).status, "recovered: already_live again").toBe(409);
  });

  it("CAPTURE_FAIL_LIMIT: 30 failed 401s per IP; the 31st FAILURE is 429 with Retry-After — while a VALID tok from that same IP is admitted on all three routes with the bucket full; another IP's failure is a plain 401; it recovers", async () => {
    const redis = windowedRedis();
    const r = await captureRig();
    const A = phoneId("a");
    const shared = "198.51.100.9";   // the venue Wi-Fi / CGNAT address the phone and the guesser share
    let fails = 0;
    for (; fails < SPEC.fail.max; fails++) {
      const res = fails % 3 === 0 ? await get(r.code, { tok: null, ip: shared }) : await get(r.code, { tok: `guess-${fails}`, ip: shared });
      expect(res.status, `failure ${fails + 1}`).toBe(401);
    }
    redis.advance(5_000);
    // The bucket is full. A valid tok is never refused by it (I-1).
    expect((await get(r.code, { tok: r.tok, ip: shared })).status, "a valid GET from the locked IP").toBe(200);
    expect((await beat(r, A, "new", { tok: r.tok, ip: shared })).status, "a valid beat from the locked IP").toBe(200);
    await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.target.id });
    expect((await start(r.code, A, { tok: r.tok, ip: shared })).status, "a valid start from the locked IP").toBe(200);
    // Failures past the budget are throttled: 429, Retry-After = the window's remaining seconds.
    await expectLimited(await get(r.code, { tok: "guess-x", ip: shared }), SPEC.fail.windowSeconds - 5);
    await expectLimited(await get(r.code, { tok: null, ip: shared }), SPEC.fail.windowSeconds - 5);
    expect((await get(r.code, { tok: "guess-y", ip: "192.0.2.44" })).status, "per IP: another IP's failure is a 401").toBe(401);
    redis.advance((SPEC.fail.windowSeconds - 5) * 1000);
    expect((await get(r.code, { tok: "guess-z", ip: shared })).status, "recovered: a failure is a 401 again").toBe(401);
  });

  it("the failure budget's IP prefers the PROXY's header: CF-Connecting-IP, then Fly-Client-IP, then the first X-Forwarded-For hop", async () => {
    const redis = windowedRedis();
    const r = await captureRig();
    const cases: [Opts["extra"], string][] = [
      [{ "cf-connecting-ip": "203.0.113.50", "fly-client-ip": "198.51.100.60" }, "capture-fail:203.0.113.50"],
      [{ "fly-client-ip": "198.51.100.60" }, "capture-fail:198.51.100.60"],
      [{}, "capture-fail:203.0.113.7"],   // headersOf's default first XFF hop
    ];
    let checked = 0;
    for (const [extra, key] of cases) {
      redis.spent.length = 0;
      expect((await get(r.code, { tok: "guess", extra })).status).toBe(401);
      expect(redis.spent.filter((k) => k.startsWith("rl:capture-fail:")), JSON.stringify(extra)).toEqual([`rl:${key}`]);
      checked++;
    }
    // A valid tok never touches the failure bucket at all.
    redis.spent.length = 0;
    expect((await get(r.code, { tok: r.tok })).status).toBe(200);
    expect(redis.spent.filter((k) => k.startsWith("rl:capture-fail:"))).toEqual([]);
    expect(checked).toBe(cases.length);
  });

  it("CAPTURE_FAIL_LIMIT counts 401s ONLY: past 30 refusals that are not a failed auth (422 a bad slot, 404 not a code), the IP is not limited", async () => {
    windowedRedis();
    const r = await captureRig();
    const ip = "198.51.100.77";
    let refusals = 0;
    for (; refusals <= SPEC.fail.max; refusals++) {
      const res = refusals % 2 === 0
        ? await GET(new Request(`${BASE}/${r.code}?slot=1`, { headers: headersOf({ tok: r.tok, ip }) }), params(r.code))
        : await get("NOT_A_CODE!", { tok: r.tok, ip });
      expect(res.status, `refusal ${refusals + 1}`).toBe(refusals % 2 === 0 ? 422 : 404);
    }
    expect(refusals).toBe(SPEC.fail.max + 1);
    expect((await get(r.code, { tok: r.tok, ip })).status, "a 422 or a 404 is not a failed auth").toBe(200);
  });

  it("the positive pair: under every budget nothing is limited — and with no counter at all (Redis not configured) the limits are inert", async () => {
    windowedRedis();
    const r = await captureRig();
    expect((await get(r.code, { tok: r.tok })).status).toBe(200);
    expect((await get(r.code, { tok: "wrong" })).status).toBe(401);
    __setRateLimitCounterForTests(null);
    for (let i = 0; i < 3; i++) expect((await get(r.code, { tok: r.tok })).status).toBe(200);
  });

  it("anti-vacuity: this file saw 429s", () => {
    expect(limitedChecked).toBeGreaterThanOrEqual(6);
  });
});
