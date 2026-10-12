// Capture record upload over HTTP (spec 2026-10-12-capture-record-upload-design.md §3, §7, §8): the REAL route, the
// REAL `capturePhoneRoute` and the REAL limiter (Redis replaced at the limiter's own test seam by a windowed counter, the
// limits-route.test.ts shape). Every answer is judged against the PUBLISHED contract (capture-record.v1.json under ajv,
// the vendoring repo's view) AND the zod twin, with the capture cache headers.
//
// §8's two halves are pinned together: a records call leaves the code's shared budget untouched (a Send never pushes a
// live phone's beats into 429), and the 11th record in the hour is 429 — while beats on that code still answer 200.
// The numbers are the spec's, typed here (10 per 3600 s), never read back from rate-limit.ts.
//
// ONE SPORT, on purpose: not applicable — no limit and no record line reads a sport.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { CaptureBeat, CaptureRecordOk, CaptureRecordRefusal } from "@/server/api-v1/capture-schemas";
import { tokenTag } from "@/server/relay/domain/capture-record";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { captureRig as rawRig, phoneId, type CaptureRig } from "@/server/usecases/__tests__/_capture-rig";
import { POST as BEATS } from "../[code]/beats/route";
import { POST as RECORDS } from "../[code]/records/route";

const HAS_DB = !!process.env.DATABASE_URL;

async function captureRig(opts: Parameters<typeof rawRig>[0] = {}) {
  const r = await rawRig(opts);
  setRelayDriversForTest(r.deps.drivers);
  return r;
}
afterAll(() => setRelayDriversForTest(null));

/** §8, typed from the spec. */
const SPEC_RECORD = { max: 10, windowSeconds: 3600 };

const ENV_KEYS = ["RELAY_KEK", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS"] as const;
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

// The published contract, read as a vendoring repo reads it.
const CONTRACT = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../../../../../../docs/contracts/capture-record.v1.json"), "utf8")) as Record<string, unknown>;
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(CONTRACT);
const fileAdmits = (pointer: "ok" | "refusal", body: unknown): boolean =>
  ajv.getSchema(`https://seazn.club/contracts/capture-record.v1.json#/$defs/${pointer}`)!(body) as boolean;

const BASE = "https://test.local/api/v1/capture/codes";
type Opts = { tok?: string | null; ip?: string; extra?: Record<string, string> };
const headersOf = (o: Opts) => {
  const h: Record<string, string> = { "content-type": "application/x-ndjson", "x-forwarded-for": `${o.ip ?? "203.0.113.9"}, 10.0.0.1`, ...o.extra };
  if (o.tok !== null && o.tok !== undefined) h.authorization = `Bearer ${o.tok}`;
  return h;
};
const params = (code: string) => ({ params: Promise.resolve({ code }) });
const AT = "2026-10-11T21:19:03.123Z";
const ndjson = (lines: object[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
const goodBody = (tok: string) => ndjson([{ at: AT, kind: "pair", claim: "new", slot: 0, tokenTag: tokenTag(tok) }, { at: AT, kind: "thermal", status: 3 }]);
const record = (code: string, body: BodyInit, o: Opts) =>
  RECORDS(new Request(`${BASE}/${code}/records`, { method: "POST", headers: headersOf(o), body }), params(code));
function beatBody(r: CaptureRig, phone: string, claim: "new" | null) {
  return CaptureBeat.parse({
    code: r.code, slot: 0, phone, claim, device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "capture-test/1",
  });
}
const beat = (r: CaptureRig, phone: string, claim: "new" | null, o: Opts) =>
  BEATS(new Request(`${BASE}/${r.code}/beats`, { method: "POST", headers: { ...headersOf(o), "content-type": "application/json" }, body: JSON.stringify(beatBody(r, phone, claim)) }), params(r.code));

let answersChecked = 0;
/** Every answer here: no-store, and its body admitted by BOTH the published file and the twin. */
async function answer(res: Response, status: number, code?: string): Promise<Record<string, unknown>> {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(res.headers.get("pragma")).toBe("no-cache");
  const body = (await res.json()) as Record<string, unknown>;
  if (status === 201) {
    expect(fileAdmits("ok", body), JSON.stringify(body)).toBe(true);
    expect(CaptureRecordOk.parse(body)).toEqual(body);
  } else {
    expect(fileAdmits("refusal", body), JSON.stringify(body)).toBe(true);
    expect(CaptureRecordRefusal.parse(body)).toEqual(body);
    expect(body.code).toBe(code);
  }
  answersChecked++;
  return body;
}

describe.skipIf(!HAS_DB)("POST /api/v1/capture/codes/{code}/records (spec 2026-10-12)", () => {
  it("201 is the bare {ref, kept, dropped}; gzip is inflated; a BAD LINE is a 201 that drops it (owner ruling RL); every refusal is the contract's bare envelope — 401 (no Bearer, wrong tok), 404, 413, 422 (an encoding, an empty body), all no-store — counted", async () => {
    windowedRedis();
    const r = await captureRig();
    answersChecked = 0;
    expect(await answer(await record(r.code, goodBody(r.tok), { tok: r.tok }), 201)).toMatchObject({ kept: 2, dropped: 0 });
    expect(await answer(await record(r.code, gzipSync(Buffer.from(goodBody(r.tok))), { tok: r.tok, extra: { "content-encoding": "gzip" } }), 201))
      .toMatchObject({ kept: 2, dropped: 0 });
    await answer(await record(r.code, goodBody(r.tok), { tok: null }), 401, "code_ended");
    await answer(await record(r.code, goodBody(r.tok), { tok: "Zq9rT4mW2xK7pL1vN8cB3d" }), 401, "code_ended");
    await answer(await record("not-a-code!", goodBody(r.tok), { tok: r.tok }), 404, "not_a_stream_code");
    const big = ndjson(Array.from({ length: 1001 }, () => ({ at: AT, kind: "thermal" })));
    expect(await answer(await record(r.code, big, { tok: r.tok }), 413, "too_large")).toEqual({ code: "too_large", message: "the record is over 1000 lines or 1 MB" });
    // Owner ruling RL (2026-10-12): a bad line is dropped, never the body refused — alone, or among good lines.
    expect(await answer(await record(r.code, ndjson([{ at: AT, kind: "x", battery: 1 }]), { tok: r.tok }), 201)).toMatchObject({ kept: 0, dropped: 1 });
    expect(await answer(await record(r.code, `${goodBody(r.tok)}{"at":"${AT}","kind":"x","battery":2}\n`, { tok: r.tok }), 201))
      .toMatchObject({ kept: 2, dropped: 1 });
    await answer(await record(r.code, goodBody(r.tok), { tok: r.tok, extra: { "content-encoding": "br" } }), 422, "invalid");
    await answer(await record(r.code, "", { tok: r.tok }), 422, "invalid");
    expect(answersChecked).toBe(10);
  });

  it("§8: a records call spends its OWN bucket, never the code's; the 11th record in the hour is 429 with Retry-After — while beats on that code still answer 200; it recovers after the hour", async () => {
    const redis = windowedRedis();
    const r = await captureRig();
    const A = phoneId("a");
    expect((await beat(r, A, "new", { tok: r.tok })).status).toBe(200);
    redis.spent.length = 0;
    expect((await record(r.code, goodBody(r.tok), { tok: r.tok })).status).toBe(201);
    // Half one: the records call touched the record bucket alone.
    expect(redis.spent.filter((k) => k.startsWith("rl:capture-record:"))).toHaveLength(1);
    expect(redis.spent.filter((k) => k.startsWith("rl:capture-code:")), "a Send never spends the code's budget").toEqual([]);
    redis.advance(600_000);   // 10 minutes into the window: 3000 s remain
    for (let i = 1; i < SPEC_RECORD.max; i++) expect((await record(r.code, goodBody(r.tok), { tok: r.tok })).status, `record ${i + 1}`).toBe(201);
    // Half two: the 11th is 429 …
    const limited = await record(r.code, goodBody(r.tok), { tok: r.tok });
    await answer(limited, 429, "rate_limited");
    expect(limited.headers.get("retry-after")).toBe(String(SPEC_RECORD.windowSeconds - 600));
    // … and the live phone's beats on the same code are untouched.
    expect((await beat(r, A, null, { tok: r.tok })).status, "beats still answer").toBe(200);
    redis.advance((SPEC_RECORD.windowSeconds - 600) * 1000);
    expect((await record(r.code, goodBody(r.tok), { tok: r.tok })).status, "recovered after the hour").toBe(201);
  });

  it("§8: every attempt counts — five 422s (empty bodies) and five all-bad 201s spend the hour's budget, and the valid eleventh is 429; a 401 spends the client IP's failure budget", async () => {
    const redis = windowedRedis();
    const r = await captureRig();
    for (let i = 0; i < SPEC_RECORD.max; i++) {
      const empty = i % 2 === 0;
      expect((await record(r.code, empty ? "" : ndjson([{ at: AT, kind: "x", battery: i }]), { tok: r.tok })).status).toBe(empty ? 422 : 201);
    }
    await answer(await record(r.code, goodBody(r.tok), { tok: r.tok }), 429, "rate_limited");
    redis.spent.length = 0;
    expect((await record(r.code, goodBody(r.tok), { tok: "Zq9rT4mW2xK7pL1vN8cB3d", ip: "198.51.100.4" })).status).toBe(401);
    expect(redis.spent).toContain("rl:capture-fail:198.51.100.4");
  });
});
