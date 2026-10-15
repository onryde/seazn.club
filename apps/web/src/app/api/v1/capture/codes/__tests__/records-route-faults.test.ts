// Capture record upload — the "cannot happen" guards, each REACHED (review fix 6 on PR #943; TEST-STRATEGY: an
// assumption is a guard plus a test that reaches it). Each one ends on the route's unmapped path: `captureRoute` answers
// the contract's `503 {code: unavailable}`, calls Sentry.captureException and logs at error. That path is where a line
// could leak, so each test sends lines carrying a distinctive value and asserts that NOTHING handed to Sentry or the
// logger — the error's message and stack included — holds a line's content or the tok.
//
//  - `the code's fixture is gone` (usecases/capture-record.ts): through its REAL path, a race — the fixture is deleted
//    while the body is still being read, after the code resolved;
//  - `a kept sid outside the code's sessions` (usecases/capture-record.ts): a FORCED fault — attribution made to keep
//    every line, so a foreign session's sid reaches the link step;
//  - `a body past both caps` (relay/record-body.ts): a FORCED fault — the identity read handed back more bytes than its
//    cap allowed (Buffer.concat, spied on that one call).
//
// ONE SPORT, on purpose: not applicable — no guard here reads a sport.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { inspect } from "node:util";

const sentry = vi.hoisted(() => ({ captured: [] as unknown[] }));
vi.mock("@sentry/nextjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/nextjs")>()),
  captureException: (e: unknown) => { sentry.captured.push(e); return "test-event-id"; },
  captureMessage: (m: unknown) => { sentry.captured.push(m); return "test-event-id"; },
}));
// The forced fault for the kept-sid guard: attribution made to keep every line, behind a switch.
const fault = vi.hoisted(() => ({ keepAll: false }));
vi.mock("@/server/relay/domain/capture-record", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/relay/domain/capture-record")>();
  return { ...real, keptLines: (...args: Parameters<typeof real.keptLines>) => (fault.keepAll ? args[0].map(() => true) : real.keptLines(...args)) };
});

import { sql } from "@/lib/db";
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { CAPTURE_RECORD_MAX_BYTES } from "@/server/api-v1/capture-schemas";
import { log } from "@/server/logger";
import { tokenTag } from "@/server/relay/domain/capture-record";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { captureRig as rawRig } from "@/server/usecases/__tests__/_capture-rig";
import { POST as RECORDS } from "../[code]/records/route";

const HAS_DB = !!process.env.DATABASE_URL;

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeAll(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.AUTH_SECRET = "records-route-faults-test";
});
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterAll(() => setRelayDriversForTest(null));
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

async function captureRig() {
  const r = await rawRig();
  setRelayDriversForTest(r.deps.drivers);
  return r;
}

const AT = "2026-10-11T21:19:03.123Z";
const BASE = "https://test.local/api/v1/capture/codes";
const line = (o: object) => JSON.stringify(o);
const post = (code: string, tok: string, body: BodyInit) =>
  RECORDS(new Request(`${BASE}/${code}/records`, {
    method: "POST", body, duplex: "half",
    headers: { "content-type": "application/x-ndjson", authorization: `Bearer ${tok}`, "x-forwarded-for": "203.0.113.77, 10.0.0.1" },
  } as RequestInit), { params: Promise.resolve({ code }) });

/** Everything handed to the logger and to Sentry, rendered whole: an Error's message AND stack, every nested field. */
let logged: unknown[][] = [];
const everythingSent = (): string =>
  [...logged.map((args) => inspect(args, { depth: 8 })), ...sentry.captured.map((e) => (e instanceof Error ? `${e.message}\n${e.stack}` : inspect(e, { depth: 8 })))].join("\n");

beforeEach(() => {
  logged = [];
  sentry.captured.length = 0;
  fault.keepAll = false;
  __setRateLimitCounterForTests(async () => ({ count: 1, ttlMs: 3_600_000 }));
  for (const level of ["info", "warn", "error", "debug"] as const) {
    vi.spyOn(log, level).mockImplementation(((...args: unknown[]) => { logged.push(args); }) as never);
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  __setRateLimitCounterForTests(null);
});

/** The unmapped path's answer, and what it handed Sentry: exactly the named guard, once. */
async function expect503(res: Response, guard: RegExp): Promise<void> {
  expect(res.status).toBe(503);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(await res.json()).toEqual({ code: "unavailable", message: "the server could not answer; try again" });
  const errors = sentry.captured.filter((e): e is Error => e instanceof Error);
  expect(errors.map((e) => e.message)).toEqual([expect.stringMatching(guard)]);
  expect(logged.some((args) => inspect(args).includes(errors[0]!.message)), "the guard is logged at error").toBe(true);
}

describe.skipIf(!HAS_DB)("records route: each assumption guard reached, and nothing of a line in log or Sentry (review fix 6)", () => {
  it("REAL PATH — the fixture deleted mid-upload (after the code resolved, while the body streams): `the code's fixture is gone` → 503, nothing stored", async () => {
    const r = await captureRig();
    const secret = `FAKE-RACE-${randomUUID()}`;
    const bytes = new TextEncoder().encode(`${line({ at: AT, kind: "pair", claim: "new", slot: 0, tokenTag: tokenTag(r.tok), message: secret })}\n`);
    let deleted = 0;
    // `highWaterMark: 0` is what makes `pull` LAZY. With the default (1) a ReadableStream calls `pull` once as soon as it is
    // constructed, before anyone reads it, so the delete below raced the route's own resolve of the code: when the delete
    // committed first the code was gone before the route looked it up and the answer was 401 `code_ended`, not the 503 this
    // test reaches for (CI, PR #961: `expected 401 to be 503`; passes or fails on timing alone). The route reads the body only
    // AFTER it resolved the code, so a lazy pull puts the delete exactly where the test says it is: mid-upload.
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        // The race: the organiser deletes the fixture (its code cascades) between the code's resolve and the store.
        deleted = (await sql`delete from fixtures where id = ${r.fixtureId}`).count;
        ctrl.enqueue(bytes);
        ctrl.close();
      },
    }, { highWaterMark: 0 });
    // The guard for the above, made deterministic: give an eager pull ample time to run its delete, then require that it did
    // not. Without this the test passes or fails on how fast the route happens to get to its first query.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(deleted, "premise: nothing reads the body before the route does, so the delete cannot precede the code's resolve").toBe(0);
    await expect503(await post(r.code, r.tok, body), /^postCaptureRecord: the code's fixture is gone$/);
    expect(deleted, "premise: the race really deleted the fixture").toBe(1);
    expect((await sql`select 1 from capture_records where fixture_id = ${r.fixtureId}`).count).toBe(0);
    const sent = everythingSent();
    expect(sent.length).toBeGreaterThan(0);
    for (const leaked of [secret, r.tok, AT]) expect(sent, leaked).not.toContain(leaked);
  });

  it("FORCED — attribution keeps every line, so a foreign session's sid reaches the link step: `a kept sid outside the code's sessions` → 503, nothing stored", async () => {
    const r = await captureRig();
    fault.keepAll = true;
    const secret = `FAKE-FOREIGN-${randomUUID()}`;
    const body = [
      line({ at: AT, kind: "pair", claim: "new", slot: 0, tokenTag: tokenTag(r.tok) }),
      line({ at: AT, kind: "live", sid: randomUUID(), transport: "srt", message: secret }),
    ].join("\n");
    await expect503(await post(r.code, r.tok, body), /^postCaptureRecord: a kept sid outside the code's sessions$/);
    expect((await sql`select 1 from capture_records where fixture_id = ${r.fixtureId}`).count).toBe(0);
    const sent = everythingSent();
    for (const leaked of [secret, r.tok, AT]) expect(sent, leaked).not.toContain(leaked);
    // Its positive pair: the same body with attribution intact is a 201 that drops the foreign line.
    fault.keepAll = false;
    sentry.captured.length = 0;
    const ok = await post(r.code, r.tok, body);
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ kept: 1, dropped: 1 });
    expect(sentry.captured).toEqual([]);
  });

  it("FORCED — the identity read hands back more than its cap: `a body past both caps` → 503, nothing stored", async () => {
    const r = await captureRig();
    const secret = `FAKE-OVERSIZE-${randomUUID()}`;
    const body = `${line({ at: AT, kind: "pair", claim: "new", slot: 0, tokenTag: tokenTag(r.tok), message: secret })}\n`;
    const mark = Buffer.from(secret);
    const realConcat = Buffer.concat.bind(Buffer);
    let forced = 0;
    vi.spyOn(Buffer, "concat").mockImplementation(((list: readonly Uint8Array[], total?: number) => {
      const out = realConcat(list, total);
      if (!out.includes(mark)) return out;
      forced++;
      return realConcat([out, Buffer.alloc(CAPTURE_RECORD_MAX_BYTES)]);   // past the 1 MB the read was capped at
    }) as typeof Buffer.concat);
    await expect503(await post(r.code, r.tok, body), /^readRecordBody: a body past both caps$/);
    expect(forced, "premise: the fault was injected on the body's read").toBe(1);
    expect((await sql`select 1 from capture_records where fixture_id = ${r.fixtureId}`).count).toBe(0);
    const sent = everythingSent();
    for (const leaked of [secret, r.tok, AT]) expect(sent, leaked).not.toContain(leaked);
  });
});
