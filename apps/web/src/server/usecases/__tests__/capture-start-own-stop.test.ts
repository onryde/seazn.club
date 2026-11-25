// Seazn-hosted video, Task 43 (stg session d908c90c, 2026-11-24): a phone's held stop ends its session before its next start,
// so a start is never refused `already_live` for a session its own owner already ended.
//
// What stg showed (task-43-report.md has the full timeline): the phone lost its network at 09:38:19, ended its hold locally at
// 09:41:22 (`hold-window-expired`) and could deliver its `stopped: S` beat only once its network came back — the server took it at
// 09:42:40.502 and S went `ending` 154 ms later. S then stayed `ending` while the relay drained (SIGINT, Machine `stopping`) until
// 09:42:56.009, and BOTH of the phone's starts in that window (09:42:43.85, 09:42:49.99) were answered 409 already_live naming the
// S the phone had just stopped — while the beat in between answered that no broadcast was running.
//
// The rules under test, typed from the brief and that timeline — never from capture-phone.ts:
//   - the stop itself is the authority: the phone's `stopped: S` beat moves S out of the live states at once (T23);
//   - a start from S's OWN phone while S is `ending` first lets the server observe S's Machine (one reconcile): gone → S completes
//     and the start goes ahead (200, a new sid); still draining → 503 `unavailable` (the phone's "try again"), never already_live;
//   - a start from a phone that does NOT hold S still meets already_live naming S, live or ending (the guard is not weakened);
//   - S's own phone while S is still live (it never stopped it) still meets already_live (T13, the lost-200 retry);
//   - the stop replayed is idempotent; a stop for an S the server already ended writes nothing;
//   - the stop and the start race through S's row lock: whichever commits first decides, both ways.
// The court path (T37's per-match sessions) is pinned in capture-court.test.ts's "Task 43" block.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): neither the stop nor the start reads a sport.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "@/lib/db";
import { CaptureRefusalError, captureRefusal } from "@/server/api-v1/capture-http";
import { CaptureBeat, CaptureRefusal, CaptureStartOk } from "@/server/api-v1/capture-schemas";
import { OWN_ENDING_DRAIN_SECONDS, OWN_ENDING_RETRY_AFTER_MAX_SECONDS, RUNNER_STOP_GRACE_SECONDS } from "@/server/relay/config";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { pairPresentPhone } from "@/server/relay/__tests__/_session-rig";
import { ownEndingRetryAfter, postBeat, postStart } from "../capture-phone";
import { saveStreamSettings } from "../stream-codes";
import { createSession, heartbeat } from "../stream-sessions";
import { captureRig, phoneId } from "./_capture-rig";

const HAS_DB = !!process.env.DATABASE_URL;

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS", "RELAY_IMAGE"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const KEK = randomBytes(32).toString("hex");
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = KEK;
  process.env.AUTH_SECRET = "capture-start-own-stop-secret";
  // A composed start is refused 503 composed_unavailable while RELAY_IMAGE is unset; the fake runner needs no real image.
  process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:capture-start-own-stop";
}
beforeAll(baseEnv);
beforeEach(baseEnv);
afterEach(() => setRelayDriversForTest(null));
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

type Beat = CaptureBeat;
const SEC = 1000;
const NEVER = 3_600_000;
const ACTIVE = ["requested", "provisioning", "warming", "live", "ending"];

/** d908c90c's shape: a COMPOSED session (the only mode whose ending drains a relay), its phone paired through the real path, live
 *  through the relay's own heartbeat, the fixture's pre-pick saved so the phone's own start has a destination. */
async function composedLive() {
  const r = await captureRig({ credits: 3, connectAfterMs: NEVER });
  const phone = phoneId("own");
  await pairPresentPhone(r.fixtureId, { phone, at: r.now() });
  await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.target.id });
  const { sessionId: S } = await createSession(r.auth, r.fixtureId, { mode: "composed", targetId: r.target.id }, r.deps);
  const created = r.runner.created[0]!;
  r.tick(5 * SEC);
  await heartbeat(S, created.jobToken, { state: "playing" }, r.deps);
  expect((await row(S)).state, "PREMISE: S is live, as d908c90c was").toBe("live");
  const machineId = (await sql<{ machine_id: string }[]>`select machine_id from fixture_stream_sessions where id = ${S}`)[0]!.machine_id;
  expect(machineId, "PREMISE: S holds a Machine").toBeTruthy();
  const beat = (over: Partial<Beat>) => postBeat(r.code, r.tok, CaptureBeat.parse({
    code: r.code, slot: 0, phone, claim: null, device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "capture-start-own-stop/1", ...over,
  }), r.deps, r.now());
  return {
    r, S, phone, machineId, beat,
    /** The phone's held stop, delivered: `stopped: S`, no sid (the contract's rule), as stg's 09:42:40.502 beat. */
    heldStop: () => beat({ stopped: S }),
    start: (who = phone) => postStart(r.code, r.tok, { phone: who }, r.deps, r.now()),
    /** The relay still draining (d908c90c 09:42:40–09:42:56: observed `stopping`). */
    draining: () => r.runner.setObserved(machineId, "stopping"),
    /** The Machine has exited and is gone (auto-destroyed on a clean stop). */
    gone: () => r.runner.setObserved(machineId, "destroyed", { exitCode: 0, oomKilled: false, requestedStop: true }),
  };
}

type SessionRow = { state: string; end_reason: string | null; pairing_id: string | null; start_cause: string };
async function row(sid: string): Promise<SessionRow> {
  return (await sql<SessionRow[]>`select state, end_reason, pairing_id, start_cause from fixture_stream_sessions where id = ${sid}`)[0]!;
}
const openOf = async (fixtureId: string) =>
  sql<{ id: string; state: string }[]>`select id, state from fixture_stream_sessions where fixture_id = ${fixtureId} and state in ${sql(ACTIVE)}`;
const phoneStops = async (sid: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_events where session_id = ${sid} and source = 'phone' and kind = 'action' and type = 'stop'`)[0]!.n;
const eventCount = async (sid: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_events where session_id = ${sid}`)[0]!.n;

let refusalsChecked = 0;
/** The refusal's RAW wire body, parsed by the contract's union: `<status>:<code>` plus the body. */
async function refused(p: Promise<unknown>): Promise<{ wire: string; body: Record<string, unknown>; retryAfter: string | null }> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, "the start was refused with a capture refusal").toBeInstanceOf(CaptureRefusalError);
  const res = captureRefusal(err as CaptureRefusalError);   // the mapping captureRoute answers with
  const body = (await res.json()) as Record<string, unknown>;
  expect(CaptureRefusal.parse(body)).toEqual(body);
  expect(res.headers.get("cache-control"), "every capture answer stays private, no-store").toBe("private, no-store");
  refusalsChecked++;
  return { wire: `${res.status}:${String(body.code)}`, body, retryAfter: res.headers.get("retry-after") };
}

/** The drain the phone team is told to expect (from the rulebook: the Machine's stop grace, owner ruling D15) and their ceiling. */
const DRAIN_S = 20;
const CEILING_S = 20;

/** Backends blocked on a row lock in a statement matching `pattern` (an ILIKE). */
async function lockWaiters(pattern: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_stat_activity
     where wait_event_type = 'Lock' and query ilike ${pattern} and pid <> pg_backend_pid()` as { n: number }[];
  return n;
}
/** Wait until `n` backends are blocked on `pattern` — a race test that never reaches the lock would pass without exercising it,
 *  so the premise is asserted, not assumed. */
async function untilWaiting(pattern: string, n: number): Promise<void> {
  let seen = 0;
  for (let i = 0; i < 200 && seen < n; i++) {
    seen = await lockWaiters(pattern);
    if (seen < n) await new Promise((res) => setTimeout(res, 25));
  }
  expect(seen, `PREMISE: ${n} statement(s) matching ${pattern} are waiting on a row lock`).toBeGreaterThanOrEqual(n);
}
const SESSION_LOCK = "%from fixture_stream_sessions%for update%";

describe("Task 43 — Retry-After on the 503 for the phone's own ending session (pure, the phone team's rule)", () => {
  const T = new Date("2026-11-24T09:42:40.656Z");          // d908c90c's ending_at
  const at = (s: number) => new Date(T.getTime() + s * 1000);
  it("the constants are the rulebook's: the drain is the stop grace (D15: 20 s), the phone's ceiling is 20 s", () => {
    expect(RUNNER_STOP_GRACE_SECONDS).toBe(DRAIN_S);
    expect(OWN_ENDING_DRAIN_SECONDS, "the drain expectation IS the stop grace").toBe(RUNNER_STOP_GRACE_SECONDS);
    expect(OWN_ENDING_RETRY_AFTER_MAX_SECONDS).toBe(CEILING_S);
  });
  it.each([
    ["just began ending (0 s)", 0, 20],
    ["d908c90c's first start (3.194 s in)", 3.194, 17],   // 16.806 s left, rounded UP
    ["d908c90c's second start (9.34 s in)", 9.34, 11],
    ["one fractional second left (19.5 s in)", 19.5, 1],
    ["FLOOR: the drain exactly spent (20 s in)", 20, 1],
    ["FLOOR: long overdue (300 s in)", 300, 1],
    ["CEILING: ending_at ahead of the clock (skew, -5 s)", -5, 20],
    ["CEILING: far ahead (-3600 s)", -3600, 20],
  ] as const)("%s (%s s in) → Retry-After %i", (_name, elapsed, want) => {
    expect(ownEndingRetryAfter(T, at(elapsed))).toBe(want);
  });
  it("no ending_at (the write lost, F22): the whole drain, capped — never more than the ceiling", () => {
    expect(ownEndingRetryAfter(null, at(0))).toBe(Math.min(DRAIN_S, CEILING_S));
  });
  it("always an integer in [1, 20] — a sweep over -60 s … 60 s in 0.1 s steps", () => {
    let checked = 0;
    for (let tenths = -600; tenths <= 600; tenths++) {
      const v = ownEndingRetryAfter(T, at(tenths / 10));
      expect(Number.isInteger(v) && v >= 1 && v <= CEILING_S, `${tenths / 10} s → ${v}`).toBe(true);
      checked++;
    }
    expect(checked).toBe(1201);
  });
});

describe.skipIf(!HAS_DB)("Task 43 — the phone's held stop, then its own start (fixture code)", () => {
  it("d908c90c: hold → the held stop → S ending at once; a start while the relay drains is 503 unavailable, NEVER already_live; once the Machine is gone the start completes S and goes ahead (200, a new sid)", async () => {
    const s = await composedLive();
    // The phone was silent through its outage; its held stop arrives late.
    s.r.tick(260 * SEC);
    const a = await s.heldStop();
    expect(a, "the beat that delivered the stop hears `over` for S").toMatchObject({ state: "over", sid: s.S });
    expect(await row(s.S), "the stop is the authority: S leaves live at once, operator_stopped").toMatchObject({ state: "ending", end_reason: "operator_stopped" });

    // 09:42:43.85: the first start, the relay still draining.
    s.draining();
    const observe = vi.spyOn(s.r.runner, "observe");
    s.r.tick(3 * SEC);
    const first = await refused(s.start());
    expect(first.wire, "not already_live: S is the session this phone stopped").toBe("503:unavailable");
    expect(first.body).not.toHaveProperty("sid");
    expect(observe, "its own ending session's Machine was observed once").toHaveBeenCalledTimes(1);
    expect(first.retryAfter, "Retry-After: the drain left, 3 s into it").toBe(String(DRAIN_S - 3));
    expect(await openOf(s.r.fixtureId), "nothing new was opened; S still drains").toEqual([{ id: s.S, state: "ending" }]);

    // 09:42:49.99: the second start, still draining — the same answer, still no second session.
    s.r.tick(6 * SEC);
    const second = await refused(s.start());
    expect(second.wire).toBe("503:unavailable");
    expect(second.retryAfter, "9 s into the drain").toBe(String(DRAIN_S - 9));

    // The Machine exits and is gone: the next start observes it, completes S, and starts.
    s.gone();
    s.r.tick(6 * SEC);
    const ok = await s.start();
    expect(CaptureStartOk.parse(ok)).toEqual(ok);
    expect(ok.sid, "a NEW session").not.toBe(s.S);
    expect(await row(s.S), "S completed as part of answering, its reason kept").toMatchObject({ state: "completed", end_reason: "operator_stopped" });
    expect(await row(ok.sid), "the new one is the phone's own operator start").toMatchObject({ start_cause: "operator", pairing_id: (await row(s.S)).pairing_id });
    expect((await openOf(s.r.fixtureId)).map((o) => o.id), "exactly one open session: the new one").toEqual([ok.sid]);
  });

  it("the held stop replayed (the phone retries after a lost answer): S ends ONCE — one phone stop, the replay answers `over` and writes no stop; the start still answers 503 while S drains", async () => {
    const s = await composedLive();
    await s.heldStop();
    s.draining();
    expect(await phoneStops(s.S), "PREMISE: the first stop wrote one").toBe(1);
    const before = await row(s.S);
    s.r.tick(2 * SEC);
    const again = await s.heldStop();
    expect(again).toMatchObject({ state: "over", sid: s.S });
    expect(await phoneStops(s.S), "idempotent: still one").toBe(1);
    expect(await row(s.S)).toEqual(before);
    expect((await refused(s.start())).wire).toBe("503:unavailable");
  });

  it("a stop for an S the server ALREADY ended (completed) is a no-op: no event, the row unchanged; the start then goes ahead", async () => {
    const s = await composedLive();
    await s.heldStop();
    s.gone();
    s.r.tick(2 * SEC);
    const ok = await s.start();                                     // completes S on the way
    expect((await row(s.S)).state, "PREMISE: S is completed").toBe("completed");
    const before = { row: await row(s.S), events: await eventCount(s.S) };
    s.r.tick(2 * SEC);
    await s.beat({ stopped: s.S });
    expect(await row(s.S)).toEqual(before.row);
    expect(await eventCount(s.S), "nothing written on the ended S").toBe(before.events);
    expect((await openOf(s.r.fixtureId)).map((o) => o.id), "the stop of the old S touched nothing of the new one").toEqual([ok.sid]);
  });

  it("S's own phone, S still LIVE (it never stopped it): already_live naming S, startedBy organiser — the lost-200 retry rule is unchanged", async () => {
    const s = await composedLive();
    // The fake would report the Machine GONE if asked: a start that observed a live session would move it. It must not ask.
    s.gone();
    const observe = vi.spyOn(s.r.runner, "observe");
    const got = await refused(s.start());
    expect(got).toEqual({ wire: "409:already_live", body: { code: "already_live", message: expect.any(String), sid: s.S, startedBy: "organiser" }, retryAfter: null });
    expect(observe, "a LIVE session is never observed by a start, even its own").not.toHaveBeenCalled();
    expect((await row(s.S)).state).toBe("live");
  });

  it("a start from a phone that does NOT hold S: already_live naming S while S is live AND while S is ending (another's stop never opens the slot to it)", async () => {
    const s = await composedLive();
    // S is held by no pairing (its phone's pairing gone from it): the code's current pairing is the caller, but not S's owner.
    await sql`update fixture_stream_sessions set pairing_id = null where id = ${s.S}`;
    const live = await refused(s.start());
    expect(live.body).toMatchObject({ code: "already_live", sid: s.S });
    // The organiser's Stop ends S; while it drains, this phone still meets already_live.
    await sql`update fixture_stream_sessions set state = 'ending', desired_state = 'ending', end_reason = 'stopped', ending_at = ${s.r.now()} where id = ${s.S}`;
    // The fake reports the Machine GONE: observing it would complete S. Another's session must not be observed at all.
    s.gone();
    const observe = vi.spyOn(s.r.runner, "observe");
    const ending = await refused(s.start());
    expect(ending.body, "not S's owner: the guard is not widened").toMatchObject({ code: "already_live", sid: s.S });
    expect(ending.retryAfter, "already_live carries no Retry-After").toBeNull();
    expect(observe, "another's ending session is never observed by this start").not.toHaveBeenCalled();
    expect((await row(s.S)).state, "and so never completed behind its owner's back").toBe("ending");
  });

  describe("RACE: the held stop and the start, through S's row lock", () => {
    it("the STOP commits first: the start, queued behind it on S's row, reads S ending and answers 503 — never already_live", async () => {
      const s = await composedLive();
      s.draining();
      let start: Promise<unknown> = Promise.resolve();
      let stop: Promise<unknown> = Promise.resolve();
      await sql.begin(async (tx) => {
        await tx`select id from fixture_stream_sessions where id = ${s.S} for update`;
        stop = s.heldStop();
        await untilWaiting(SESSION_LOCK, 1);                       // the stop's apply is queued on S's row
        start = s.start().then(() => null, (e: unknown) => e);
        await untilWaiting(SESSION_LOCK, 2);                       // the start's own read is queued behind it
      });
      await stop;
      const err = await start;
      expect(err).toBeInstanceOf(CaptureRefusalError);
      expect(`${(err as CaptureRefusalError).status}:${(err as CaptureRefusalError).code}`).toBe("503:unavailable");
      refusalsChecked++;
      expect((await row(s.S)).state).toBe("ending");
    });

    it("the START reads first: it meets S still live (already_live, truthful at that instant); the stop queued behind it then ends S, and the next start answers 503", async () => {
      const s = await composedLive();
      s.draining();
      let start: Promise<unknown> = Promise.resolve();
      let stop: Promise<unknown> = Promise.resolve();
      await sql.begin(async (tx) => {
        await tx`select id from fixture_stream_sessions where id = ${s.S} for update`;
        start = s.start().then(() => null, (e: unknown) => e);
        await untilWaiting(SESSION_LOCK, 1);                       // the start's read is queued on S's row
        stop = s.heldStop();
        await untilWaiting(SESSION_LOCK, 2);                       // the stop's apply behind it
      });
      const err = await start;
      expect(err).toMatchObject({ status: 409, code: "already_live", extras: { sid: s.S } });
      refusalsChecked++;
      await stop;
      expect((await row(s.S)).state, "the stop still ended S").toBe("ending");
      s.draining();                                                // the stop's own effect told the fake to stop; it still drains
      expect((await refused(s.start())).wire, "the next start").toBe("503:unavailable");
    });

    it("the lock is what orders them: an uncommitted move to ending is WAITED for, not read past (the start answers 503 once it commits)", async () => {
      const s = await composedLive();
      s.draining();
      let start: Promise<unknown> = Promise.resolve();
      await sql.begin(async (tx) => {
        await tx`update fixture_stream_sessions set state = 'ending', desired_state = 'ending', end_reason = 'operator_stopped', ending_at = ${s.r.now()} where id = ${s.S}`;
        start = s.start().then(() => null, (e: unknown) => e);
        await untilWaiting(SESSION_LOCK, 1);
      });
      const err = await start;
      expect(`${(err as CaptureRefusalError).status}:${(err as CaptureRefusalError).code}`).toBe("503:unavailable");
      refusalsChecked++;
    });
  });

  afterAll(() => {
    if (HAS_DB) expect(refusalsChecked, "anti-vacuity: every refusal case ran").toBeGreaterThanOrEqual(10);
  });
});
