// Capture QR v2 PR-2 T5 (spec §7.3; W7, A4, A12, A15; plan FP7, FP8, FP13, Review Focus 2 and 4) — AUTOMATIC STOP, decided in
// the tick: `tickSession` ends a session `stop(auto_stopped)` once `autoStopDue`. DB-backed through the REAL organiser Go live,
// the REAL beat, the REAL tick callers (a beat, the organiser poll, the stream-tick pass, the daily sweep's backstop) and FAKE
// drivers on the rig's tickable clock.
//
// Two clocks, kept apart on purpose (Review Focus 4): `fixtures.finished_at` and `fixture_stream_sessions.created_at` are
// DATABASE stamps, compared with each other only; the 180 s delay is the rig's `deps.now()` against `finished_at`. Where a
// case needs a chosen instant it SETS `finished_at` itself, after the status write (FP8: the V430 trigger stamps only on a
// `status` update) — and sets `created_at` where a microsecond ordering matters.
//
// Every expected value is a declaration: `AUTO_STOP_AFTER_RESULT_SECONDS`, the conjunct list, the wire reason in the contract.
// "Another sport": one case runs the cricket rig. "Composed": one case ends a composed (runner) session through the runner.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { CaptureBeat, CaptureBeatAnswer } from "@/server/api-v1/capture-schemas";
import { pairPresentPhone } from "@/server/relay/__tests__/_session-rig";
import { AUTO_STOP_AFTER_RESULT_SECONDS, POLL_NEAR_SECONDS } from "@/server/relay/config";
import { AUTO_STOP_CONJUNCTS } from "@/server/relay/domain/auto-stream";
import { postBeat } from "../capture-phone";
import { sweepStreamSessions } from "../relay-sweep";
import { saveStreamSettings } from "../stream-codes";
import { createSession, currentSession, heartbeat, stopSession, tickOpenSessions, tickSession } from "../stream-sessions";
import { captureRig, phoneId, type CaptureRig } from "./_capture-rig";

const sentry = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureError: sentry.captureError }));
// A pass-through seam on the org money lock `apply` takes first (A7): a case parks the world between the tick's UNLOCKED
// judgement and its LOCKED decision (stream-tick.test.ts's seam), and counts how many applies a tick made.
const hook = vi.hoisted(() => ({ onLockOrg: null as null | ((orgId: string) => Promise<void>), calls: 0 }));
vi.mock("../stream-credits", async (importOriginal) => {
  const real = await importOriginal<typeof import("../stream-credits")>();
  return { ...real, lockOrg: async (...a: Parameters<typeof real.lockOrg>) => { hook.calls++; if (hook.onLockOrg) await hook.onLockOrg(a[1]); return real.lockOrg(...a); } };
});

const HAS_DB = !!process.env.DATABASE_URL;

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_INGEST_HOST", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const KEK = randomBytes(32).toString("hex");
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = KEK;
  process.env.AUTH_SECRET = "stream-auto-stop-test-secret";
}
beforeAll(baseEnv);
beforeEach(() => { baseEnv(); hook.onLockOrg = null; hook.calls = 0; sentry.captureError.mockClear(); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

type Beat = ReturnType<typeof CaptureBeat.parse>;
const SEC = 1000;
/** The fake's connect delay: a session reaches live on the first beat that names it after this long. */
const CONNECT_MS = 3000;
const DELAY_MS = AUTO_STOP_AFTER_RESULT_SECONDS * SEC;

function body(r: CaptureRig, phone: string, over: Partial<Beat> = {}): Beat {
  return CaptureBeat.parse({
    code: r.code, slot: 0, phone, claim: null, device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "automatic", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "stream-auto-stop-test/1", ...over,
  });
}
async function beat(r: CaptureRig, phone: string, over: Partial<Beat> = {}) {
  const a = await postBeat(r.code, r.tok, body(r, phone, over), r.deps, r.now());
  expect(CaptureBeatAnswer.parse(a)).toEqual(a);
  return a;
}
/** The session's phone names its sid, publishing, in the AUTOMATIC mode: that beat's own tick is the `beat` caller. */
const sidBeat = (r: CaptureRig, phone: string, sid: string, over: Partial<Beat> = {}) =>
  beat(r, phone, { sid, state: "publishing", transport: "srt", ...over });

const setStatus = (fx: string, status: string) => sql`update fixtures set status = ${status} where id = ${fx}`;
type SessRow = { id: string; state: string; end_reason: string | null; created_at: Date; pairing_id: string | null; fixture_id: string | null };
const sessionOf = async (sid: string): Promise<SessRow> => (await sql<SessRow[]>`
  select id, state, end_reason, created_at, pairing_id, fixture_id from fixture_stream_sessions where id = ${sid}`)[0]!;
const isOpen = (s: SessRow) => !["ending", "completed", "failed"].includes(s.state);
const createdAt = async (sid: string) => (await sessionOf(sid)).created_at;
/** Moves the rig's clock to `at` (forward only: a backward move is a test bug). */
function clockTo(r: CaptureRig, at: Date): void {
  const delta = at.getTime() - r.now().getTime();
  r.tick(delta);
}
/** The match is decided; the trigger stamps `finished_at`, then it is set to `created_at(sid) + afterMs` — a chosen instant
 *  on the DATABASE clock the session's own `created_at` is on. Returns the stored instant (ms precision, as the use-case reads it). */
async function finishAt(r: CaptureRig, sid: string, afterMs: number): Promise<Date> {
  await setStatus(r.fixtureId, "decided");
  const [x] = await sql<{ finished_at: Date }[]>`
    update fixtures set finished_at = (select created_at from fixture_stream_sessions where id = ${sid}) + make_interval(secs => ${afterMs / 1000}::float8)
     where id = ${r.fixtureId} returning finished_at`;
  return x!.finished_at;
}
/** The domain's own ledger of `stop` decisions that moved the session (a no-op `ending × stop` writes none). */
const stopTransitions = async (sid: string) => (await sql<{ n: number }[]>`
  select count(*)::int as n from fixture_stream_events where session_id = ${sid} and kind = 'transition' and type = 'stop'`)[0]!.n;
const finishedAtOf = async (r: CaptureRig) => (await sql<{ finished_at: Date | null }[]>`select finished_at from fixtures where id = ${r.fixtureId}`)[0]!.finished_at;
const modeOf = async (pairingId: string) => (await sql<{ mode: string | null }[]>`select mode from fixture_stream_pairings where id = ${pairingId}`)[0]!.mode;

/** The rig every case begins from: credits, the match in play, the switch ON, the organiser's Go live on a present phone, and
 *  the phone's AUTOMATIC beat naming the session after the fake's connect delay — live. */
async function liveRig(opts: Parameters<typeof captureRig>[0] = {}, o: { autoStream?: boolean } = {}) {
  const r = await captureRig({ credits: 3, connectAfterMs: CONNECT_MS, ...opts });
  const phone = phoneId("a");
  await setStatus(r.fixtureId, "in_play");
  if (o.autoStream ?? true) await saveStreamSettings(r.auth, r.fixtureId, { autoStream: true });
  const sid = await r.start(phone);
  await goLive(r, phone, sid);
  return { r, phone, sid };
}
type Live = Awaited<ReturnType<typeof liveRig>>;
/** The beat that names the sid is coalesced with the armed read inside the poll interval, so tick the connect delay AND
 *  the near cadence (PR-1's ingest-read coalescing) — constants, never magic numbers. */
async function goLive(r: CaptureRig, phone: string, sid: string): Promise<void> {
  r.tick(CONNECT_MS + POLL_NEAR_SECONDS * SEC);
  const a = await sidBeat(r, phone, sid);
  expect(a, "PREMISE: the beat's own tick took the session live").toMatchObject({ state: "live", sid });
  expect((await sessionOf(sid)).state).toBe("live");
}
/** The tick's "ended by the tick" log lines whose rule is the auto stop's — what an operator reads to see WHY a broadcast ended. */
const autoStopLogs = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => (c[0] as { rule?: string } | undefined)?.rule === "auto-stop");
const sweepTick = (r: CaptureRig, sid: string) => tickSession(sid, r.deps, "sweep");

// ---------------------------------------------------------------------------------------------------------------------
describe("the tunable is read at the call site (AGENTS.md #20)", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  it("stream-sessions.ts reads AUTO_STOP_AFTER_RESULT_SECONDS only through tunable(NAME, NAME)", () => {
    const name = "AUTO_STOP_AFTER_RESULT_SECONDS";
    const code = strip(readFileSync(resolve(import.meta.dirname, "..", "stream-sessions.ts"), "utf8")).replace(/^import[\s\S]*?\bfrom\s*"[^"]*";?/gm, "");
    const viaTunable = new RegExp(`tunable\\(\\s*"${name}"\\s*,\\s*${name}\\s*\\)`, "g");
    expect([...code.matchAll(viaTunable)].length, `a tunable("${name}", ${name}) call`).toBeGreaterThan(0);
    expect(code.replace(viaTunable, "").match(new RegExp(`\\b${name}\\b`)), `${name} used outside tunable()`).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("automatic stop — fires AUTO_STOP_AFTER_RESULT_SECONDS after the result (test 1)", () => {
  it("+179.999 s open, +180 s ending/completed with end_reason auto_stopped, and the phone's next beat hears over S auto_stopped", async () => {
    const info = vi.spyOn(log, "info");
    const { r, phone, sid } = await liveRig();
    const finished = await finishAt(r, sid, SEC);
    clockTo(r, new Date(finished.getTime() + DELAY_MS - SEC));
    expect((await sweepTick(r, sid)).session?.state, "+179 s").toBe("live");
    clockTo(r, new Date(finished.getTime() + DELAY_MS - 1));
    expect((await sweepTick(r, sid)).session?.state, "1 ms short").toBe("live");
    expect(autoStopLogs(info), "nothing logged before the end").toHaveLength(0);
    clockTo(r, new Date(finished.getTime() + DELAY_MS));
    const t = await sweepTick(r, sid);
    expect(autoStopLogs(info)).toHaveLength(1);
    expect(autoStopLogs(info)[0]![0]).toMatchObject({ sid, orgId: r.auth.orgId, cause: "sweep", rule: "auto-stop" });
    expect(["ending", "completed"], t.session?.state).toContain(t.session?.state);
    expect(await sessionOf(sid)).toMatchObject({ end_reason: "auto_stopped" });
    expect(await sidBeat(r, phone, sid)).toMatchObject({ state: "over", sid, endReason: "auto_stopped" });
    // A second call: the next ticks of the same session decide nothing more.
    await sweepTick(r, sid);
    await currentSession(r.auth, r.fixtureId, r.deps);
    expect(await stopTransitions(sid), "exactly one stop transition however many ticks follow").toBe(1);
    expect(await sessionOf(sid)).toMatchObject({ end_reason: "auto_stopped" });
  });

  it("the walkthrough's override is honoured at the call site: with the shortened delay it fires at that delay, not 180 s (ENV_NAME=ci)", async () => {
    vi.stubEnv("ENV_NAME", "ci");
    vi.stubEnv("AUTO_STOP_AFTER_RESULT_SECONDS", "7");
    try {
      const { r, sid } = await liveRig();
      const finished = await finishAt(r, sid, SEC);
      clockTo(r, new Date(finished.getTime() + 7 * SEC - 1));
      expect(isOpen(await (async () => { await sweepTick(r, sid); return sessionOf(sid); })()), "6.999 s").toBe(true);
      clockTo(r, new Date(finished.getTime() + 7 * SEC));
      await sweepTick(r, sid);
      expect(await sessionOf(sid)).toMatchObject({ end_reason: "auto_stopped" });
      expect(7 * SEC, "the override is shorter than the declared delay").toBeLessThan(DELAY_MS);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("another sport (cricket): the cricket rig ends identically", async () => {
    const { r, sid } = await liveRig({ sport: "cricket" });
    const finished = await finishAt(r, sid, SEC);
    clockTo(r, new Date(finished.getTime() + DELAY_MS - 1));
    await sweepTick(r, sid);
    expect(isOpen(await sessionOf(sid))).toBe(true);
    clockTo(r, new Date(finished.getTime() + DELAY_MS));
    await sweepTick(r, sid);
    expect(await sessionOf(sid)).toMatchObject({ end_reason: "auto_stopped" });
  });
});

describe.skipIf(!HAS_DB)("automatic stop — every caller of the tick reaches it (test 2, FP7)", () => {
  // The cause is tickSession's own declared union ("poll" | "beat" | "sweep"); each caller passes the one that names it.
  const callers: [string, "poll" | "beat" | "sweep", (x: Live) => Promise<unknown>][] = [
    ["a phone beat (postBeat's tick)", "beat", ({ r, phone, sid }) => sidBeat(r, phone, sid)],
    ["the organiser's poll (currentSession)", "poll", ({ r }) => currentSession(r.auth, r.fixtureId, r.deps)],
    ["the stream-tick pass (tickOpenSessions)", "sweep", ({ r }) => tickOpenSessions(r.deps, { orgIds: [r.auth.orgId] })],
    ["the daily sweep's backstop (sweepStreamSessions)", "sweep", ({ r }) => sweepStreamSessions(r.deps, { orgIds: [r.auth.orgId] })],
  ];
  it("each caller leaves the session open 1 ms before the delay and ends it auto_stopped at the delay, logging ITS cause (4 callers)", async () => {
    const info = vi.spyOn(log, "info");
    let checked = 0;
    for (const [name, cause, call] of callers) {
      const x = await liveRig();
      const finished = await finishAt(x.r, x.sid, SEC);
      clockTo(x.r, new Date(finished.getTime() + DELAY_MS - 1));
      await call(x);
      expect(isOpen(await sessionOf(x.sid)), `${name}: not yet`).toBe(true);
      clockTo(x.r, new Date(finished.getTime() + DELAY_MS));
      await call(x);
      expect(await sessionOf(x.sid), `${name}: at the delay`).toMatchObject({ end_reason: "auto_stopped" });
      const logged = autoStopLogs(info).map((c) => c[0] as { sid?: string; cause?: string }).filter((l) => l.sid === x.sid);
      expect(logged, `${name}: one auto-stop line`).toHaveLength(1);
      expect(logged[0]!.cause, `${name}: the line names its caller`).toBe(cause);
      checked++;
    }
    expect(checked).toBe(callers.length);
    expect(checked).toBe(4);
    expect(new Set(callers.map(([, c]) => c)), "all three causes are exercised").toEqual(new Set(["beat", "poll", "sweep"]));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("automatic stop — the predicate through the use-case (test 3): each conjunct falsified alone", () => {
  type Row = { conjunct: string; falsify: (x: Live, finished: Date) => Promise<void>; restore: (x: Live, finished: Date) => Promise<void> };
  const due = (finished: Date) => new Date(finished.getTime() + DELAY_MS);
  const rows: Row[] = [
    {
      conjunct: "switch_on",
      falsify: ({ r }) => saveStreamSettings(r.auth, r.fixtureId, { autoStream: false }).then(() => undefined),
      restore: ({ r }) => saveStreamSettings(r.auth, r.fixtureId, { autoStream: true }).then(() => undefined),
    },
    {
      conjunct: "phone_automatic",
      falsify: async ({ sid }) => { await sql`update fixture_stream_pairings set mode = 'operator' where id = ${(await sessionOf(sid)).pairing_id}`; },
      restore: async ({ sid }) => { await sql`update fixture_stream_pairings set mode = 'automatic' where id = ${(await sessionOf(sid)).pairing_id}`; },
    },
    {
      conjunct: "fixture_finished",
      falsify: async ({ r }) => { await setStatus(r.fixtureId, "in_play"); },   // a revert: the trigger clears finished_at
      restore: async ({ r }, finished) => { await setStatus(r.fixtureId, "decided"); await sql`update fixtures set finished_at = ${finished} where id = ${r.fixtureId}`; },
    },
    {
      conjunct: "delay_elapsed",
      falsify: async ({ r }, finished) => { clockTo(r, new Date(due(finished).getTime() - SEC)); },
      restore: async ({ r }, finished) => { clockTo(r, due(finished)); },
    },
    {
      conjunct: "session_predates_result",
      // The result stood BEFORE the session was created: a post-result broadcast.
      falsify: async ({ r, sid }) => { await sql`update fixtures set finished_at = ${new Date((await createdAt(sid)).getTime() - SEC)} where id = ${r.fixtureId}`; },
      restore: async ({ r, sid }) => { await sql`update fixtures set finished_at = ${new Date((await createdAt(sid)).getTime() + SEC)} where id = ${r.fixtureId}`; },
    },
  ];

  it("each conjunct, falsified alone, leaves the session open at the due time — and the same rig with it undone ends it (5 rows)", async () => {
    let checked = 0;
    for (const row of rows) {
      const x = await liveRig();
      const finished = await finishAt(x.r, x.sid, SEC);
      clockTo(x.r, due(finished));
      await row.falsify(x, finished);
      if (row.conjunct === "session_predates_result") {
        // The stored instant moved, so the due time moves with it.
        const moved = (await finishedAtOf(x.r))!;
        clockTo(x.r, due(moved));
      }
      await sweepTick(x.r, x.sid);
      expect(isOpen(await sessionOf(x.sid)), `${row.conjunct} falsified: still open`).toBe(true);
      await row.restore(x, finished);
      if (row.conjunct === "session_predates_result") clockTo(x.r, due((await finishedAtOf(x.r))!));
      await sweepTick(x.r, x.sid);
      expect(await sessionOf(x.sid), `${row.conjunct} restored: ended`).toMatchObject({ end_reason: "auto_stopped" });
      checked++;
    }
    expect(checked).toBe(rows.length);
    expect(checked).toBe(AUTO_STOP_CONJUNCTS.length);
    expect(rows.map((x) => x.conjunct).sort()).toEqual(AUTO_STOP_CONJUNCTS.map((c) => c.name).sort());
  });

  it("an UNDUE tick costs no decision: with every conjunct but one holding, the live session's tick takes the org lock only for the reconcile (1 apply) — due, it takes more", async () => {
    const applies = async (falsify: (x: Live, finished: Date) => Promise<void>) => {
      const x = await liveRig();
      const finished = await finishAt(x.r, x.sid, SEC);
      clockTo(x.r, new Date(finished.getTime() + DELAY_MS));
      await falsify(x, finished);
      hook.calls = 0;
      await sweepTick(x.r, x.sid);
      return hook.calls;
    };
    const dueApplies = await applies(async () => undefined);
    const undue = [
      await applies(async ({ r }) => { await saveStreamSettings(r.auth, r.fixtureId, { autoStream: false }); }),
      await applies(async ({ r }, finished) => { clockTo(r, new Date(finished.getTime() + DELAY_MS - SEC)); }),
      await applies(async ({ r }) => { await setStatus(r.fixtureId, "in_play"); }),
    ];
    expect(undue, "the reconcile's apply and nothing else").toEqual([1, 1, 1]);
    expect(dueApplies, "due: the end decision (and its follow-up) as well").toBeGreaterThan(1);
  });

  it("the ordering differential, on ONE fixture and ONE result: a session created before the result ends; one created after it never does", async () => {
    const { r, phone, sid: before } = await liveRig();
    const finished = await finishAt(r, before, SEC);
    clockTo(r, due(finished));
    await sweepTick(r, before);
    expect(await sessionOf(before)).toMatchObject({ end_reason: "auto_stopped" });
    // The organiser goes live AFTER the result (a post-match broadcast): created_at is past finished_at.
    await sql`update fixture_stream_sessions set state = 'completed', ended_at = coalesce(ended_at, now()) where id = ${before} and state = 'ending'`;
    await beat(r, phone);
    const after = await r.start(phone);
    // The two stamps are the database's own clock, within milliseconds of each other here: place the broadcast a second AFTER the result.
    await sql`update fixture_stream_sessions set created_at = ${new Date((await finishedAtOf(r))!.getTime() + SEC)} where id = ${after}`;
    expect((await createdAt(after)).getTime(), "PREMISE: the second session postdates the result").toBeGreaterThan((await finishedAtOf(r))!.getTime());
    await goLive(r, phone, after);
    clockTo(r, new Date(due(finished).getTime() + 10 * 60 * SEC));
    await beat(r, phone);   // keeps the phone present; its own tick is a caller
    await sweepTick(r, after);
    await currentSession(r.auth, r.fixtureId, r.deps);
    expect(await sessionOf(after), "a post-result broadcast is never auto-stopped").toMatchObject({ state: "live", end_reason: null });
  });

  it("Review Focus 4: the comparison is the database's, at MICROsecond precision — a session created in the same millisecond as the result still predates it by 1 µs, and is not auto-stopped at 0 µs or -1 µs", async () => {
    const { r, sid } = await liveRig();
    // A created_at at a known sub-millisecond phase, so ±1 µs stays inside ONE millisecond.
    await sql`update fixture_stream_sessions set created_at = date_trunc('milliseconds', created_at) + interval '500 microseconds' where id = ${sid}`;
    const created = await createdAt(sid);
    await setStatus(r.fixtureId, "decided");
    clockTo(r, new Date(created.getTime() + DELAY_MS + 60 * SEC));
    const finishWith = async (delta: string) => {
      await sql.unsafe(`update fixtures set finished_at = (select created_at from fixture_stream_sessions where id = '${sid}') + interval '${delta}' where id = '${r.fixtureId}'`);
      const [same] = await sql<{ same_ms: boolean }[]>`
        select date_trunc('milliseconds', f.finished_at) = date_trunc('milliseconds', s.created_at) as same_ms
          from fixtures f, fixture_stream_sessions s where f.id = ${r.fixtureId} and s.id = ${sid}`;
      expect(same!.same_ms, `PREMISE: ${delta} lands in the session's own millisecond`).toBe(true);
    };
    await finishWith("0 microseconds");
    await sweepTick(r, sid);
    expect(isOpen(await sessionOf(sid)), "created_at = finished_at: not strictly before").toBe(true);
    await finishWith("-1 microseconds");
    await sweepTick(r, sid);
    expect(isOpen(await sessionOf(sid)), "created 1 µs AFTER the result").toBe(true);
    await finishWith("1 microsecond");
    await sweepTick(r, sid);
    expect(await sessionOf(sid), "created 1 µs BEFORE the result — a JS Date compare would call these equal").toMatchObject({ end_reason: "auto_stopped" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("automatic stop — every fixture status the database admits (test 3b: another status, a withdrawal, a void)", () => {
  // The two lists are the DATABASE's declarations: the status check constraint, and the finished set in V430's trigger.
  const declaredStatuses = async (): Promise<string[]> => {
    const [c] = await sql<{ def: string }[]>`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'fixtures_status_check'`;
    return [...c!.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!);
  };
  const finishedStatuses = (): string[] => {
    const sqlText = readFileSync(resolve(import.meta.dirname, "../../../../../../db/migration/deltas/V430__capture_stream_codes.sql"), "utf8");
    const list = /if new\.status in \(([^)]*)\) then/.exec(sqlText)![1]!;
    return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  };

  it("every FINISHED status (decided, finalized, forfeited, abandoned, cancelled) arms the stop at finished_at + delay; scheduled and in_play never do — 7 statuses", async () => {
    const all = await declaredStatuses();
    const finished = finishedStatuses();
    expect(all.length, "PREMISE: the constraint admits 7 statuses").toBe(7);
    expect(finished.length, "PREMISE: five are finished").toBe(5);
    expect(finished.every((st) => all.includes(st))).toBe(true);
    let checked = 0;
    for (const status of all) {
      const { r, sid } = await liveRig();
      await setStatus(r.fixtureId, status);
      const stamped = await finishedAtOf(r);
      expect(stamped !== null, `${status}: the trigger stamps exactly the finished statuses`).toBe(finished.includes(status));
      if (stamped !== null) {
        clockTo(r, new Date(stamped.getTime() + DELAY_MS - 1));
        await sweepTick(r, sid);
        expect(isOpen(await sessionOf(sid)), `${status}: 1 ms short`).toBe(true);
        clockTo(r, new Date(stamped.getTime() + DELAY_MS));
        await sweepTick(r, sid);
        expect(await sessionOf(sid), `${status}: at the delay`).toMatchObject({ end_reason: "auto_stopped" });
      } else {
        r.tick(60 * 60 * SEC);
        await sweepTick(r, sid);
        expect(await sessionOf(sid), `${status}: an hour on`).toMatchObject({ state: "live", end_reason: null });
      }
      checked++;
    }
    expect(checked).toBe(all.length);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("automatic stop — a reverted result cancels it, and a new result restarts the clock (test 4)", () => {
  it("finish, tick at +100 s, revert, tick at +200 s: open; finish again with a NEW finished_at: the delay runs from IT", async () => {
    const { r, sid } = await liveRig();
    const first = await finishAt(r, sid, SEC);
    clockTo(r, new Date(first.getTime() + 100 * SEC));
    await sweepTick(r, sid);
    expect(isOpen(await sessionOf(sid))).toBe(true);
    await setStatus(r.fixtureId, "in_play");
    expect(await finishedAtOf(r), "PREMISE: the revert cleared the stamp (T32)").toBeNull();
    clockTo(r, new Date(first.getTime() + 200 * SEC));
    await sweepTick(r, sid);
    expect(isOpen(await sessionOf(sid)), "the old clock would have fired by now").toBe(true);
    // Finish again at the rig's NOW: past the first result's due time, inside the new one's delay.
    const second = r.now();
    await setStatus(r.fixtureId, "decided");
    await sql`update fixtures set finished_at = ${second} where id = ${r.fixtureId}`;
    expect(second.getTime(), "PREMISE: the old result's due time has passed").toBeGreaterThan(first.getTime() + DELAY_MS - 1);
    await sweepTick(r, sid);
    expect(isOpen(await sessionOf(sid)), "restarted: not due yet").toBe(true);
    clockTo(r, new Date(second.getTime() + DELAY_MS - 1));
    await sweepTick(r, sid);
    expect(isOpen(await sessionOf(sid)), "1 ms short of the NEW delay").toBe(true);
    clockTo(r, new Date(second.getTime() + DELAY_MS));
    await sweepTick(r, sid);
    expect(await sessionOf(sid)).toMatchObject({ end_reason: "auto_stopped" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("automatic stop — A12 + A15 regression (test 5)", () => {
  it("auto start fires, the organiser Stops (the stamp), goes live by hand BEFORE the result, and the result ends THAT broadcast", async () => {
    const r = await captureRig({ credits: 5, connectAfterMs: CONNECT_MS });
    const phone = phoneId("a");
    await beat(r, phone, { claim: "new", mode: "automatic" });
    await saveStreamSettings(r.auth, r.fixtureId, { autoStream: true });
    await setStatus(r.fixtureId, "in_play");
    await beat(r, phone);   // the AUTOMATIC start
    const [auto] = await sql<{ id: string; start_cause: string }[]>`select id, start_cause from fixture_stream_sessions where fixture_id = ${r.fixtureId}`;
    expect(auto).toMatchObject({ start_cause: "automatic" });
    await goLive(r, phone, auto!.id);
    // The organiser's Stop: the A12 stamp, and the broadcast ends.
    await stopSession(r.auth, r.fixtureId, auto!.id, r.deps);
    await sql`update fixture_stream_sessions set state = 'completed', ended_at = coalesce(ended_at, now()) where id = ${auto!.id} and state = 'ending'`;
    expect((await sql<{ b: Date | null }[]>`select auto_start_blocked_at as b from fixture_stream_settings where fixture_id = ${r.fixtureId}`)[0]!.b, "PREMISE: the Stop stamped").not.toBeNull();
    // Go live by hand: the pairing's mode must still be automatic for the stop to apply (it is the phone's stored beat).
    await beat(r, phone);
    const manual = await r.start(phone);
    await beat(r, phone, { mode: "automatic" });
    await goLive(r, phone, manual);
    const finished = await finishAt(r, manual, SEC);
    clockTo(r, new Date(finished.getTime() + DELAY_MS));
    await sweepTick(r, manual);
    expect(await sessionOf(manual), "A15: a broadcast restarted by hand is auto-stopped").toMatchObject({ end_reason: "auto_stopped" });
  });

  it("a broadcast the organiser started by hand BEFORE the match (the fixture still scheduled) is also stopped once the result stands", async () => {
    const r = await captureRig({ credits: 3, connectAfterMs: CONNECT_MS });
    const phone = phoneId("a");
    await saveStreamSettings(r.auth, r.fixtureId, { autoStream: true });
    const sid = await r.start(phone);
    await goLive(r, phone, sid);
    await setStatus(r.fixtureId, "in_play");
    const finished = await finishAt(r, sid, SEC);
    clockTo(r, new Date(finished.getTime() + DELAY_MS));
    await sweepTick(r, sid);
    expect(await sessionOf(sid)).toMatchObject({ end_reason: "auto_stopped" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("automatic stop — the first reason wins (test 6)", () => {
  it("a session the ORGANISER already stopped keeps end_reason stopped, however due the auto stop is", async () => {
    const { r, sid } = await liveRig();
    const finished = await finishAt(r, sid, SEC);
    await stopSession(r.auth, r.fixtureId, sid, r.deps);
    clockTo(r, new Date(finished.getTime() + DELAY_MS));
    await sweepTick(r, sid);
    await currentSession(r.auth, r.fixtureId, r.deps);
    expect(await sessionOf(sid)).toMatchObject({ end_reason: "stopped" });
  });

  it("a session already `ending`, or already terminal, costs NO decision: ticking it with the auto stop due makes exactly as many applies as with the switch off at the same clock (2 states)", async () => {
    const ends: [string, (sid: string, at: Date) => Promise<unknown>, { state: string; end_reason: string }][] = [
      ["ending", (sid, at) => sql`update fixture_stream_sessions set state = 'ending', end_reason = 'stopped', ending_at = ${at}, desired_state = 'ending' where id = ${sid}`, { state: "ending", end_reason: "stopped" }],
      ["completed", (sid, at) => sql`update fixture_stream_sessions set state = 'completed', end_reason = 'operator_stopped', ended_at = ${at} where id = ${sid}`, { state: "completed", end_reason: "operator_stopped" }],
    ];
    let checked = 0;
    for (const [name, end, want] of ends) {
      const { r, sid } = await liveRig();
      const finished = await finishAt(r, sid, SEC);
      await end(sid, r.now());
      clockTo(r, new Date(finished.getTime() + DELAY_MS));
      await saveStreamSettings(r.auth, r.fixtureId, { autoStream: false });
      hook.calls = 0;
      await sweepTick(r, sid);
      const off = hook.calls;
      await saveStreamSettings(r.auth, r.fixtureId, { autoStream: true });
      hook.calls = 0;
      await sweepTick(r, sid);
      const on = hook.calls;
      expect(on, `${name}: applies with the auto stop due (${on}) vs not (${off})`).toBe(off);
      expect(await sessionOf(sid), name).toMatchObject(want);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a TERMINAL session is untouched, and a tick of it does not throw", async () => {
    const { r, sid } = await liveRig();
    const finished = await finishAt(r, sid, SEC);
    await sql`update fixture_stream_sessions set state = 'completed', end_reason = 'operator_stopped', ended_at = now() where id = ${sid}`;
    clockTo(r, new Date(finished.getTime() + DELAY_MS));
    await expect(sweepTick(r, sid)).resolves.toBeDefined();
    expect(await sessionOf(sid)).toMatchObject({ state: "completed", end_reason: "operator_stopped" });
  });

  it("phone_lost is judged FIRST when both hold: the same tick ends a silent warming session phone_lost, never auto_stopped", async () => {
    const info = vi.spyOn(log, "info");
    const r = await captureRig({ credits: 3, connectAfterMs: 3_600_000 });
    const phone = phoneId("a");
    await saveStreamSettings(r.auth, r.fixtureId, { autoStream: true });
    await setStatus(r.fixtureId, "in_play");
    const sid = await r.start(phone);
    await beat(r, phone, { mode: "automatic" });   // armed-mode phone, never connects
    const finished = await finishAt(r, sid, SEC);
    clockTo(r, new Date(finished.getTime() + DELAY_MS));   // far past ask 10's silence, and past the delay
    await sweepTick(r, sid);
    expect(await sessionOf(sid), "ask 10 first").toMatchObject({ end_reason: "phone_lost" });
    expect(info.mock.calls.filter((c) => (c[0] as { rule?: string } | undefined)?.rule === "ask-10"), "PREMISE: the tick logged ask 10's end").toHaveLength(1);
    expect(autoStopLogs(info), "and did not claim the auto stop's").toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("automatic stop — the locked re-take (test 7)", () => {
  // `apply` takes the org's money lock first (A7). A live passthrough session's tick applies twice: the reconcile's expiry
  // (1st), then the end decision (2nd) — stream-tick.test.ts's "a tick racing a phone BEAT". The change lands at the 2nd,
  // AFTER the tick's unlocked read judged the auto stop due and BEFORE the decision locks the row.
  const atSecondApply = (what: (r: CaptureRig) => Promise<void>, r: CaptureRig): { applies: () => number } => {
    let n = 0;
    hook.onLockOrg = async () => { n++; if (n === 2) await what(r); };
    return { applies: () => n };
  };

  it("a result reverted between the unlocked judgement and the decision ends nothing and writes no end_reason — and the SAME window with nothing changed DOES end it (the control)", async () => {
    const control = await liveRig();
    const cFinished = await finishAt(control.r, control.sid, SEC);
    clockTo(control.r, new Date(cFinished.getTime() + DELAY_MS));
    const seen = atSecondApply(async () => undefined, control.r);
    await sweepTick(control.r, control.sid);
    // The reconcile's apply, the end decision's, and (once it ends) the stop's own after-commit follow-up.
    expect(seen.applies(), "PREMISE: at least the reconcile's apply and the end decision's").toBeGreaterThanOrEqual(2);
    expect(await sessionOf(control.sid)).toMatchObject({ end_reason: "auto_stopped" });

    hook.onLockOrg = null;
    const x = await liveRig();
    const finished = await finishAt(x.r, x.sid, SEC);
    clockTo(x.r, new Date(finished.getTime() + DELAY_MS));
    const reverted = atSecondApply(async (r) => { await setStatus(r.fixtureId, "in_play"); }, x.r);
    await sweepTick(x.r, x.sid);
    expect(reverted.applies(), "PREMISE: the window was hit — the 2nd apply is the end decision").toBe(2);
    expect(await sessionOf(x.sid)).toMatchObject({ state: "live", end_reason: null });
    expect(await finishedAtOf(x.r), "the revert stood").toBeNull();
  });

  it("each other conjunct that moves inside the window is re-read too: the switch turned off, and the phone's mode flipped, between the unlocked read and the decision (2 rows + the control above)", async () => {
    const rows: [string, (r: CaptureRig, sid: string) => Promise<void>][] = [
      ["switch off", async (r) => { await saveStreamSettings(r.auth, r.fixtureId, { autoStream: false }); }],
      ["mode operator", async (_r, sid) => { await sql`update fixture_stream_pairings set mode = 'operator' where id = ${(await sessionOf(sid)).pairing_id}`; }],
    ];
    let checked = 0;
    for (const [name, change] of rows) {
      const x = await liveRig();
      const finished = await finishAt(x.r, x.sid, SEC);
      clockTo(x.r, new Date(finished.getTime() + DELAY_MS));
      const seen = atSecondApply((r) => change(r, x.sid), x.r);
      await sweepTick(x.r, x.sid);
      hook.onLockOrg = null;
      expect(seen.applies(), `${name}: PREMISE: the window was hit`).toBe(2);
      expect(await sessionOf(x.sid), name).toMatchObject({ state: "live", end_reason: null });
      checked++;
    }
    expect(checked).toBe(rows.length);
  });

  it("a session that ENDED for another reason in the window (ending or completed, max_duration) is not re-decided: no stop_requested_at is stamped on it, no stop transition is written and no auto-stop line is logged (2 forms)", async () => {
    const forms: [string, (r: CaptureRig, sid: string) => Promise<unknown>, string][] = [
      ["ending", (r, sid) => sql`update fixture_stream_sessions set state = 'ending', end_reason = 'max_duration', ending_at = ${r.now()}, desired_state = 'ending' where id = ${sid}`, "ending"],
      ["completed", (r, sid) => sql`update fixture_stream_sessions set state = 'completed', end_reason = 'max_duration', ended_at = ${r.now()} where id = ${sid}`, "completed"],
    ];
    let checked = 0;
    for (const [name, end, state] of forms) {
      const info = vi.spyOn(log, "info");
      const { r, sid } = await liveRig();
      const finished = await finishAt(r, sid, SEC);
      clockTo(r, new Date(finished.getTime() + DELAY_MS));
      const seen = atSecondApply(async () => { await end(r, sid); }, r);
      await sweepTick(r, sid);
      hook.onLockOrg = null;
      expect(seen.applies(), `${name}: PREMISE: the other end landed at the end decision's apply`).toBeGreaterThanOrEqual(2);
      const [row] = await sql<{ state: string; end_reason: string | null; stop_requested_at: Date | null }[]>`
        select state, end_reason, stop_requested_at from fixture_stream_sessions where id = ${sid}`;
      expect(row, `${name}: the first reason wins and nothing is stamped over it`).toEqual({ state, end_reason: "max_duration", stop_requested_at: null });
      expect(autoStopLogs(info), name).toHaveLength(0);
      expect(await stopTransitions(sid), name).toBe(0);
      info.mockRestore();
      checked++;
    }
    expect(checked).toBe(forms.length);
  });

  it("an organiser Stop that lands in the same window is not re-decided: end_reason stays stopped, the session has ONE stop, and the tick does not log the auto stop's rule", async () => {
    const info = vi.spyOn(log, "info");
    const { r, sid } = await liveRig();
    const finished = await finishAt(r, sid, SEC);
    clockTo(r, new Date(finished.getTime() + DELAY_MS));
    let n = 0;
    hook.onLockOrg = async () => {
      n++;
      if (n === 2) {
        hook.onLockOrg = null;   // the Stop's own apply must not re-enter this seam
        await stopSession(r.auth, r.fixtureId, sid, r.deps);
      }
    };
    await sweepTick(r, sid);
    hook.onLockOrg = null;
    expect(n, "PREMISE: the Stop landed at the end decision's apply").toBe(2);
    expect(await sessionOf(sid)).toMatchObject({ end_reason: "stopped" });
    expect(await stopTransitions(sid), "the auto stop did not decide a second stop").toBe(1);
    expect(autoStopLogs(info), "the end was the organiser's, not the auto stop's").toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("automatic stop — no phone, no settings row, no fixture (test 8): never stopped, never a throw", () => {
  it("each is judged on a session that would otherwise be due: untouched at the due time (3 rows) — and the intact session ends", async () => {
    let checked = 0;
    const dueRig = async (mutate: (x: Live) => Promise<void>) => {
      const x = await liveRig();
      const finished = await finishAt(x.r, x.sid, SEC);
      await mutate(x);
      clockTo(x.r, new Date(finished.getTime() + DELAY_MS));
      return x;
    };
    const cases: [string, (x: Live) => Promise<void>][] = [
      ["pairing_id null (a session open before V430)", async ({ sid }) => { await sql`update fixture_stream_sessions set pairing_id = null where id = ${sid}`; }],
      ["no settings row", async ({ r }) => { await sql`delete from fixture_stream_settings where fixture_id = ${r.fixtureId}`; }],
      ["fixture_id null (the fixture was deleted)", async ({ sid }) => { await sql`update fixture_stream_sessions set fixture_id = null where id = ${sid}`; }],
    ];
    for (const [name, mutate] of cases) {
      const x = await dueRig(mutate);
      await expect(sweepTick(x.r, x.sid), name).resolves.toBeDefined();
      expect(await sessionOf(x.sid), name).toMatchObject({ state: "live", end_reason: null });
      checked++;
    }
    expect(checked).toBe(3);
    const intact = await dueRig(async () => undefined);
    await sweepTick(intact.r, intact.sid);
    expect(await sessionOf(intact.sid), "the positive pair").toMatchObject({ end_reason: "auto_stopped" });
  });
});

describe.skipIf(!HAS_DB)("automatic stop — the session's phone is its pairing, ENDED or not (test 8b)", () => {
  it("a pairing that ended (replaced, operator_stopped, code_ended) still carries the mode its phone set: due ⇒ stopped; and one whose mode is operator is not (3 causes × 2 modes)", async () => {
    const causes = ["replaced", "operator_stopped", "code_ended"] as const;   // fixture_stream_pairings.end_cause's declared values
    let checked = 0;
    for (const cause of causes) {
      for (const mode of ["automatic", "operator"] as const) {
        const x = await liveRig();
        const finished = await finishAt(x.r, x.sid, SEC);
        const pairing = (await sessionOf(x.sid)).pairing_id!;
        await sql`update fixture_stream_pairings set mode = ${mode}, ended_at = ${x.r.now()}, end_cause = ${cause} where id = ${pairing}`;
        clockTo(x.r, new Date(finished.getTime() + DELAY_MS));
        await sweepTick(x.r, x.sid);
        if (mode === "automatic") expect(await sessionOf(x.sid), `${cause}/${mode}`).toMatchObject({ end_reason: "auto_stopped" });
        else expect(isOpen(await sessionOf(x.sid)), `${cause}/${mode}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(causes.length * 2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("automatic stop — the stored mode is what is judged (test 9, FP13: it lags a Settings flip by up to one interval)", () => {
  it("flip the stored mode to operator before the tick: not stopped; flip back: stopped — through the phone's REAL beats", async () => {
    const { r, phone, sid } = await liveRig();
    const finished = await finishAt(r, sid, SEC);
    clockTo(r, new Date(finished.getTime() + DELAY_MS));
    // The phone's Settings flips to operator; the beat that tells the server carries mode operator and ticks the session.
    await sidBeat(r, phone, sid, { mode: "operator" });
    expect(await modeOf((await sessionOf(sid)).pairing_id!)).toBe("operator");
    expect(isOpen(await sessionOf(sid)), "its own tick judged the stored (now operator) mode").toBe(true);
    await sidBeat(r, phone, sid, { mode: "automatic" });
    expect(await sessionOf(sid), "flipped back: the next tick stops").toMatchObject({ end_reason: "auto_stopped" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("automatic stop — a composed (runner) session ends through the runner (test 11)", () => {
  it("the stop reaches the runner without throwing and the session ends auto_stopped", async () => {
    const r = await captureRig({ credits: 3, connectAfterMs: CONNECT_MS });
    const phone = phoneId("a");
    await setStatus(r.fixtureId, "in_play");
    await saveStreamSettings(r.auth, r.fixtureId, { autoStream: true });
    await pairPresentPhone(r.fixtureId, { phone, at: r.now() });
    const { sessionId: sid } = await createSession(r.auth, r.fixtureId, { mode: "composed", targetId: r.target.id }, r.deps);
    await heartbeat(sid, r.runner.created[0]!.jobToken, { state: "playing" }, r.deps);
    expect((await sessionOf(sid)).state, "PREMISE: the Machine reported playing").toBe("live");
    await beat(r, phone, { mode: "automatic" });
    const finished = await finishAt(r, sid, SEC);
    clockTo(r, new Date(finished.getTime() + DELAY_MS - 1));
    await beat(r, phone, { mode: "automatic" });   // the phone stays present; its own tick is a caller
    await sweepTick(r, sid);
    expect(isOpen(await sessionOf(sid)), "1 ms short").toBe(true);
    clockTo(r, new Date(finished.getTime() + DELAY_MS));
    await expect(sweepTick(r, sid)).resolves.toBeDefined();
    const s = await sessionOf(sid);
    expect(["ending", "completed"], s.state).toContain(s.state);
    expect(s.end_reason).toBe("auto_stopped");
  });
});
