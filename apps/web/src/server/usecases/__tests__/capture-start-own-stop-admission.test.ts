// Seazn-hosted video, Task 43 — the phone start's SECOND read: a session that opened (or moved) between the start's early read and
// `startBroadcast`'s admission. Admission then refuses `active_session` naming it, and the start names it to the phone by the same
// rule as the early read (`startOverSession`): the caller's own ending session → 503 unavailable (never already_live); anyone
// else's running session → 409 already_live naming it; a session already over by the time it is read → 503 "try again" (before
// Task 43 this answered already_live naming a session that had ended).
//
// The race itself cannot be timed from a test, so ONE seam is stood in: `startBroadcast` (the admission) moves the named session to
// the state under test and throws the refusal the REAL admission throws (`HttpError(409, …, "active_session", {sessionId})`, the
// shape capture-start.test.ts's table builds). Everything else — the code, the claim, the pre-pick, the read and the wire body —
// is the real code on the real database. The early read's own judgement is pinned in capture-start-own-stop.test.ts.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the start reads no sport.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { CaptureRefusalError, captureRefusal } from "@/server/api-v1/capture-http";
import { CaptureBeat, CaptureRefusal } from "@/server/api-v1/capture-schemas";
import { postBeat, postStart } from "../capture-phone";
import { saveStreamSettings } from "../stream-codes";
import { captureRig, phoneId } from "./_capture-rig";

const box = vi.hoisted(() => ({ race: null as null | (() => Promise<never>) }));
vi.mock("../stream-sessions", async (io) => {
  const real = await io<typeof import("../stream-sessions")>();
  return { ...real, startBroadcast: (...a: Parameters<typeof real.startBroadcast>) => (box.race ? box.race() : real.startBroadcast(...a)) };
});

const HAS_DB = !!process.env.DATABASE_URL;
const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const KEK = randomBytes(32).toString("hex");
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = KEK;
  process.env.AUTH_SECRET = "capture-start-own-stop-admission";
}
beforeAll(baseEnv);
beforeEach(() => { baseEnv(); box.race = null; });
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** The phone current on the fixture's code, its pre-pick saved, and a session S of this fixture that is OVER at the start's early
 *  read (so the early read finds nothing open and the start reaches the admission). */
async function raced() {
  const r = await captureRig({ credits: 2 });
  const A = phoneId("a");
  await postBeat(r.code, r.tok, CaptureBeat.parse({
    code: r.code, slot: 0, phone: A, claim: "new", device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null, appVersion: "t43-admission/1",
  }), r.deps, r.now());
  await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.target.id });
  const S = await r.start(A);
  const mine = (await sql<{ id: string }[]>`
    select p.id from fixture_stream_pairings p join fixture_stream_codes c on c.id = p.code_id
     where c.fixture_id = ${r.fixtureId} and p.phone = ${A} and p.ended_at is null`)[0]!.id;
  await sql`update fixture_stream_sessions set state = 'completed', desired_state = 'ending', end_reason = 'operator_stopped', ended_at = ${r.now()}, pairing_id = ${mine} where id = ${S}`;
  /** Admission meets S in `state`, held by `pairing` — and refuses `active_session` naming S, as the real admission does. */
  const racing = (state: "ending" | "live" | "completed", pairing: string | null) => {
    box.race = async () => {
      await sql`update fixture_stream_sessions set state = ${state}, pairing_id = ${pairing}, desired_state = ${state === "live" ? "live" : "ending"},
                  end_reason = ${state === "live" ? null : "operator_stopped"},
                  ended_at = ${state === "completed" ? r.now() : null}, ending_at = ${state === "ending" ? r.now() : null} where id = ${S}`;
      throw new HttpError(409, "an active session exists", "active_session", { sessionId: S });
    };
  };
  return { r, A, S, mine, racing, start: () => postStart(r.code, r.tok, { phone: A }, r.deps, r.now()) };
}

let checked = 0;
async function wire(p: Promise<unknown>): Promise<Record<string, unknown> & { status: number }> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, "a capture refusal").toBeInstanceOf(CaptureRefusalError);
  const res = captureRefusal(err as CaptureRefusalError);
  const body = (await res.json()) as Record<string, unknown>;
  expect(CaptureRefusal.parse(body)).toEqual(body);
  checked++;
  return { status: res.status, ...body };
}

describe.skipIf(!HAS_DB)("Task 43 — the start's second read, after admission refuses active_session", () => {
  it("PREMISE: S is over at the early read, so the start reaches the admission", async () => {
    const t = await raced();
    let reached = 0;
    box.race = async () => { reached++; throw new HttpError(409, "x", "active_session", { sessionId: t.S }); };
    await t.start().catch(() => undefined);
    expect(reached, "the admission was asked").toBe(1);
  });

  it("S became the caller's OWN ending session: 503 unavailable, never already_live", async () => {
    const t = await raced();
    t.racing("ending", t.mine);
    expect(await wire(t.start())).toMatchObject({ status: 503, code: "unavailable" });
  });

  it("S became ANOTHER's running session (no pairing, live): 409 already_live naming S — unchanged", async () => {
    const t = await raced();
    t.racing("live", null);
    expect(await wire(t.start())).toMatchObject({ status: 409, code: "already_live", sid: t.S });
  });

  it("S became another's ENDING session: still already_live naming S (not this phone's stop)", async () => {
    const t = await raced();
    t.racing("ending", null);
    expect(await wire(t.start())).toMatchObject({ status: 409, code: "already_live", sid: t.S });
  });

  it("S is already over when read: 503 unavailable (the phone's try again), never already_live naming an ended session", async () => {
    const t = await raced();
    t.racing("completed", t.mine);
    const got = await wire(t.start());
    expect(got).toMatchObject({ status: 503, code: "unavailable" });
    expect(got).not.toHaveProperty("sid");
  });

  afterAll(() => { if (HAS_DB) expect(checked, "anti-vacuity: every wire case ran").toBe(4); });
});
