// YouTube Connect T14 (spec §6.4 "Races", §6.6, §6.7, §9.2; plan T14 with D15, the post-T1 amendment, P4, P6, R5; the controller's
// carry-ins): the END STEP. It claims the broadcasts that are due, ends them at YouTube (complete, or delete for one that never
// went live), finalizes them, writes the replay URL, and retries a failure with backoff.
//
// Everything runs through the REAL producers: Go live is the organiser's `createSession` against a FakeYouTube (so prepare, the pool,
// the session insert and the broadcast's attach are the real ones), Stop is `stopSession` / the capture phone's real beat /
// `applyExpiry` / the tick, the reconnect is the real connect save, and the replay is read back through `currentSession` — never a
// hand-built view. Rows are built by SQL only where no producer can make the shape (a crash is the producer there, and the
// test says so).
//
// A direct `prepareYoutubeBroadcast` call stands in for the organiser's Go live, so it names `startCause: "organiser"` (B4 fix round 2,
// F2: only an AUTOMATIC start consults the channel's recorded live-state refusal). No test here records such a refusal, so none depends
// on that short-circuit; "organiser" and "automatic" would behave identically on these rigs.
//
// Expected values are the spec's and Google's literals, typed here and never imported from the code under test:
//   - grace is 5 minutes after Stop (D4), a finished match's broadcast ends 2 minutes after Stop (D5);
//   - an orphan is a broadcast no session references that is older than 10 minutes (spec §6.2, P4);
//   - the retry backoff is 1, 2, 4, … minutes, capped at 60 (P6); a claim is leased for 2 minutes (the step's own choice, below);
//   - after the 5th failure of the `complete` call the life is re-read (the controller's errorStreamInactive bound).
// The instants are SCRIPTED on one injected clock (the session deps', the fake YouTube's and the step's), so "the video started
// at T" and "the step ran at T'" are values this file chose, and the stored actual_start_at / actual_end_at are compared with them.
//
// Sport: not applicable — streaming is sport-agnostic (global-constraints "Test rules"); every rig rides `generic`.
// Secrets: a key / token is compared by FINGERPRINT or by absence, so a failing assertion never prints one.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const sentry = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureError: sentry.captureError }));

/** prepare, spied: a pass-through unless a test installs `after` (run once, after the real prepare returned — the reservation is committed
 *  and admission has not yet inserted its session: race order A). */
const prepareHook = vi.hoisted(() => ({ after: null as null | ((p: unknown) => Promise<void>) }));
vi.mock("@/server/youtube/prepare", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/youtube/prepare")>();
  return {
    ...real,
    prepareYoutubeBroadcast: vi.fn(async (a: Parameters<typeof real.prepareYoutubeBroadcast>[0], port: Parameters<typeof real.prepareYoutubeBroadcast>[1]) => {
      const prepared = await real.prepareYoutubeBroadcast(a, port);
      const after = prepareHook.after;
      prepareHook.after = null;
      if (after) await after(prepared);
      return prepared;
    }),
  };
});

/** setFixtureStreamUrl, spied: a pass-through unless a test arms `fail` (the next call throws, once). */
const urlHook = vi.hoisted(() => ({ fail: false, calls: 0, actors: [] as { fixtureId: string; userId: string | null }[] }));
vi.mock("@/server/usecases/fixtures", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/usecases/fixtures")>();
  return {
    ...real,
    setFixtureStreamUrl: vi.fn(async (...a: Parameters<typeof real.setFixtureStreamUrl>) => {
      urlHook.calls++;
      urlHook.actors.push({ fixtureId: a[1], userId: a[0].userId ?? null });
      if (urlHook.fail) {
        urlHook.fail = false;
        throw new Error("the replay link write failed");
      }
      return real.setFixtureStreamUrl(...a);
    }),
  };
});

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { isYoutubeUrl, youtubeWatchUrl } from "@/lib/youtube";
import { CaptureBeat } from "@/server/api-v1/capture-schemas";
import { WARMING_TIMEOUT_MINUTES } from "@/server/relay/config";
import { disabledRelayDrivers } from "@/server/relay/drivers";
import { ACTIVE_STATES } from "@/server/relay/domain/session";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { openStreamCodeTok } from "@/server/relay/secret-columns";
import { pairPresentPhone, rigUser, spendMonthlyStreamGrant } from "@/server/relay/__tests__/_session-rig";
import { divisionRig, seedOrg } from "@/server/usecases/__tests__/_rig";
import { postBeat } from "@/server/usecases/capture-phone";
import { grantCredits } from "@/server/usecases/stream-credits";
import { createStreamTarget } from "@/server/usecases/stream-targets";
import {
  applyExpiry, createSession as organiserStart, currentSession, heartbeat, stopSession, tickSession, type SessionDeps,
} from "@/server/usecases/stream-sessions";
import { saveStreamSettings } from "@/server/usecases/stream-codes";
import type { AuthCtx } from "@/server/api-v1/auth";
import { saveConnectionFromGrant } from "../connections";
import { revokeConnection } from "../token-store";
import { EndRuleInvariantError } from "../end-rule";
import { endDueBroadcasts, type EndStepHooks, type YoutubeEndResult } from "../end-step";
import { FakeYouTube } from "../fake";
import { YouTubeError } from "../port";
import { prepareYoutubeBroadcast } from "../prepare";
import { connect as connectChannel, grant, refreshToken } from "./_connect-rig";

const HAS_DB = !!process.env.DATABASE_URL;

// ---- spec and Google literals -------------------------------------------------------------------------------------------
const MIN = 60_000;
const SEC = 1000;
const GRACE_MINUTES = 5;
const FINISHED_END_MINUTES = 2;
const ORPHAN_MINUTES = 10;
const BUDGET_MS = 15_000;
const ROOMY_STORAGE_MINUTES = 100_000_000;
const NEVER_MS = 3_600_000;
const ZERO: YoutubeEndResult = { ended: 0, neverLive: 0, orphans: 0, failed: 0, deferred: 0 };
/** V479's shape check on a stored error code. */
const CODE_SHAPE = /^[a-z_:]{1,64}$/;

// ---- KEKs and the composed image ----------------------------------------------------------------------------------------
const ENV = ["RELAY_KEK", "YOUTUBE_TOKEN_KEK", "RELAY_IMAGE"] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
beforeAll(() => {
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex");
  process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:t14-test";
});
afterAll(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
beforeEach(() => {
  sentry.captureError.mockClear();
  urlHook.fail = false;
  urlHook.calls = 0;
  urlHook.actors = [];
});
afterEach(() => {
  prepareHook.after = null;
  urlHook.fail = false;
});

const fp = (t: { url: string; streamKey: string }) => createHash("sha256").update(`${t.url}\n${t.streamKey}`).digest("hex").slice(0, 12);

// ---- the world ----------------------------------------------------------------------------------------------------------
type Mode = "passthrough" | "composed";
interface World {
  auth: AuthCtx; orgId: string; userId: string; fixtures: string[]; targetId: string; connectionId: string; token: string;
  fake: FakeYouTube; ingest: FakeIngest; runner: FakeRunner; deps: SessionDeps;
  /** The one injected clock: the session deps', the fake YouTube's, and what `step` hands the end step. */
  now(): number; setNow(ms: number): void; tick(ms: number): void;
  issued: { url: string; streamKey: string }[];
  outputs: { inputId: string; target: { url: string; streamKey: string } }[];
  /** While true, taking a Cloudflare output off its input fails (a release that does not happen — releaseOutput reports and leaves it). */
  breakRelease: { on: boolean };
  /** One pass of the end step on the injected clock, scoped to this org. */
  step(over?: { at?: number; hooks?: EndStepHooks; budgetMs?: number; wallClock?: () => number; port?: FakeYouTube }): Promise<YoutubeEndResult>;
  /** Video arrives on the broadcast's stream: YouTube makes it `live` (auto-start), stamping actualStartTime from the clock. */
  video(ytId: string): void;
}

async function override(orgId: string, key: string, value: boolean) {
  await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
            values (${orgId}, ${key}, ${value}, 't14 unit')
            on conflict (org_id, feature_key) do update set bool_value = ${value}`;
  await invalidateOrgEntitlements(orgId);
}

/** An org with the relay, `fixtures` fixtures each with a present phone, `credits` match credits, and a channel connected through
 *  the real save (its connection and API destination). Its own FakeYouTube, so every count is this test's. */
async function world(o: { fixtures?: number; credits?: number; connectAfterMs?: number; connectionUser?: string } = {}): Promise<World> {
  const seeded = await seedOrg();
  const auth = { ...seeded.auth, userId: await rigUser() };
  const n = o.fixtures ?? 1;
  let entrants = 2;
  while ((entrants * (entrants - 1)) / 2 < n) entrants++;
  const d = await divisionRig(auth, { entrants });
  if (d.fixtureIds.length < n) throw new Error(`rig made ${d.fixtureIds.length} fixtures, the test needs ${n}`);
  await override(auth.orgId, "streaming.overlay", true);
  await override(auth.orgId, "streaming.relay", true);
  const fixtures = d.fixtureIds.slice(0, n);
  for (const f of fixtures) await pairPresentPhone(f);
  if ((o.credits ?? 1) > 0) await grantCredits({ orgId: auth.orgId, delta: o.credits ?? 1, createdBy: await rigUser(), note: "t14", idempotencyKey: randomUUID() });
  await spendMonthlyStreamGrant(auth.orgId);
  const c = await connectChannel({ auth, orgId: auth.orgId, userId: o.connectionUser ?? auth.userId });

  let now = Date.now();
  const ingest = new FakeIngest({ clock: () => now, connectAfterMs: o.connectAfterMs ?? 3000 });
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
  const outputs: World["outputs"] = [];
  const addOutput = ingest.addOutput.bind(ingest);
  ingest.addOutput = async (inputId, target, meta) => {
    outputs.push({ inputId, target: { url: target.url, streamKey: target.streamKey } });
    return addOutput(inputId, target, meta);
  };
  const breakRelease = { on: false };
  const removeOutput = ingest.removeOutput.bind(ingest);
  ingest.removeOutput = async (...a: Parameters<typeof removeOutput>) => {
    if (breakRelease.on) throw new Error("the output could not be removed");
    return removeOutput(...a);
  };
  const runner = new FakeRunner();
  const fake = new FakeYouTube({ now: () => new Date(now) });
  const issued: World["issued"] = [];
  const insertStream = fake.insertStream.bind(fake);
  fake.insertStream = async (at, a) => {
    const s = await insertStream(at, a);
    issued.push({ url: s.ingest.url, streamKey: s.ingest.streamKey });
    return s;
  };
  const deps: SessionDeps = { drivers: { ingest, runner }, now: () => new Date(now), appUrl: "http://app.test", youtube: fake };
  const w: World = {
    auth, orgId: auth.orgId, userId: auth.userId, fixtures, targetId: c.targetId, connectionId: c.connectionId, token: c.token,
    fake, ingest, runner, deps,
    now: () => now, setNow: (ms) => { now = ms; }, tick: (ms) => { now += ms; },
    issued, outputs, breakRelease,
    step: (over = {}) => {
      if (over.at !== undefined) now = over.at;
      return endDueBroadcasts(over.port ?? fake, {
        now: () => new Date(now), budgetMs: over.budgetMs ?? BUDGET_MS, orgIds: [auth.orgId],
        ...(over.wallClock ? { wallClock: over.wallClock } : {}), ...(over.hooks ? { hooks: over.hooks } : {}),
      });
    },
    video: (ytId) => {
      const stream = fake.inspectBroadcast(ytId)?.streamId;
      if (!stream) throw new Error("premise: the broadcast is bound to a stream");
      fake.videoOn(stream);
    },
  };
  return w;
}

/** The organiser's Go live, on the start's own clock (W5 needs the phone present at it). */
async function goLive(w: World, fixtureId: string, mode: Mode = "passthrough", targetId = w.targetId, deps = w.deps) {
  await pairPresentPhone(fixtureId, { at: deps.now() });
  return organiserStart(w.auth, fixtureId, { mode, targetId }, deps);
}
async function refusalOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => { throw new Error("expected the call to be refused, it resolved"); }, (e: unknown) => e);
}

interface SessionRow {
  id: string; state: string; youtube_broadcast_id: string | null; ended_at: Date | null; end_reason: string | null; fail_reason: string | null;
}
const sessionRow = async (id: string): Promise<SessionRow> =>
  (await sql<SessionRow[]>`select id, state, youtube_broadcast_id, ended_at, end_reason, fail_reason from fixture_stream_sessions where id = ${id}`)[0]!;
interface BRow {
  id: string; fixture_id: string; connection_id: string; state: string; key_id: string | null; yt_broadcast_id: string | null;
  last_session_id: string | null; last_error_code: string | null; attempts: number; next_attempt_at: Date | null;
  claimed_at: Date | null; completed_at: Date | null; actual_start_at: Date | null; actual_end_at: Date | null;
  reserved_until: Date | null; created_at: Date;
}
const bCols = sql`id, fixture_id, connection_id, state, key_id, yt_broadcast_id, last_session_id, last_error_code, attempts,
                  next_attempt_at, claimed_at, completed_at, actual_start_at, actual_end_at, reserved_until, created_at`;
const broadcastRow = async (id: string): Promise<BRow> =>
  (await sql<BRow[]>`select ${bCols} from youtube_broadcasts where id = ${id}`)[0]!;
const broadcastsOf = (fixtureId: string) =>
  sql<BRow[]>`select ${bCols} from youtube_broadcasts where fixture_id = ${fixtureId} order by created_at, id`;
const callsOf = (f: FakeYouTube, method: string) => f.calls.filter((c) => c.method === method).length;
const setStatus = (fixtureId: string, status: string) => sql`update fixtures set status = ${status} where id = ${fixtureId}`;
const finishedAtOf = async (fixtureId: string) =>
  (await sql<{ finished_at: Date | null }[]>`select finished_at from fixtures where id = ${fixtureId}`)[0]!.finished_at;
const streamUrlOf = async (fixtureId: string) =>
  (await sql<{ stream_url: string | null }[]>`select stream_url from fixtures where id = ${fixtureId}`)[0]!.stream_url;
const connectionStatus = async (id: string) =>
  (await sql<{ status: string }[]>`select status from org_youtube_connections where id = ${id}`)[0]!.status;
const min = (n: number) => n * MIN;

/** Live: passthrough, the fake ingest connects 3 s after its input was made; composed, the Machine reports playing. */
async function reachLive(w: World, fixtureId: string, sid: string, mode: Mode): Promise<void> {
  if (mode === "passthrough") w.tick(3000);
  else await heartbeat(sid, w.runner.created.at(-1)!.jobToken, { state: "playing" }, w.deps);
  expect((await currentSession(w.auth, fixtureId, w.deps))!.state, "premise: the session went live").toBe("live");
}
/** Stop, carried to COMPLETED: passthrough completes on the stop itself; composed exits its Machine, observed by a poll. */
async function stopToEnd(w: World, fixtureId: string, sid: string, mode: Mode): Promise<void> {
  await stopSession(w.auth, fixtureId, sid, w.deps);
  if (mode === "composed") {
    const created = w.runner.created.find((c) => c.sessionId === sid)!;
    await heartbeat(sid, created.jobToken, { state: "stopped" }, w.deps);
    await currentSession(w.auth, fixtureId, w.deps);
  }
  expect((await sessionRow(sid)).state, "premise: the Stop carried the session to its end").toBe("completed");
}

interface Match { sessionId: string; broadcastId: string; ytId: string; startedAtMs: number; endedAt: Date }
/** Go live → live → video arrives (at a scripted instant) → a minute of play → Stop. Returns the Stop's recorded ended_at. */
async function playAndStop(w: World, fixtureId: string, mode: Mode = "passthrough"): Promise<Match> {
  const { sessionId } = await goLive(w, fixtureId, mode);
  await reachLive(w, fixtureId, sessionId, mode);
  const s = await sessionRow(sessionId);
  const b = await broadcastRow(s.youtube_broadcast_id!);
  w.tick(SEC);
  const startedAtMs = w.now();
  w.video(b.yt_broadcast_id!);
  w.tick(MIN);
  await stopToEnd(w, fixtureId, sessionId, mode);
  // The Stop released the Cloudflare output, so the encoder is no longer sending: the key carries no video any more. (The broadcast
  // itself stays `live` at YouTube — enableAutoStop is false — until the end step completes it.)
  w.fake.videoOff(w.fake.inspectBroadcast(b.yt_broadcast_id!)!.streamId!);
  const ended = (await sessionRow(sessionId)).ended_at;
  expect(ended, "premise: the Stop wrote ended_at").toBeInstanceOf(Date);
  return { sessionId, broadcastId: b.id, ytId: b.yt_broadcast_id!, startedAtMs, endedAt: ended! };
}
const afterStop = (m: Match, ms: number) => m.endedAt.getTime() + ms;

/** A failed step's stored code, checked against V479's shape — and never a camelCase Google reason. */
function expectOurCode(row: BRow, code: string): void {
  expect(row.last_error_code).toBe(code);
  expect(row.last_error_code, "an error is stored as OUR code, never Google's reason token").toMatch(CODE_SHAPE);
}

describe.skipIf(!HAS_DB)("YouTube Connect T14 — the end step", () => {
  // ═══ the empty case, the refusal, the happy path ═══════════════════════════════════════════════════════════════════
  it("EMPTY CASE FIRST: an org with no broadcast → all zeros and YouTube is asked nothing; the same step then ends a real one (the positive pair)", async () => {
    const w = await world();
    expect(await w.step()).toEqual(ZERO);
    expect(w.fake.calls, "nothing to end, nothing to ask").toEqual([]);
    const m = await playAndStop(w, w.fixtures[0]!);
    expect(await w.step({ at: afterStop(m, min(GRACE_MINUTES)) })).toMatchObject({ ended: 1 });
  });

  it("orgIds: [] is refused (an empty filter must never read as 'every org'); a named org is accepted", async () => {
    const w = await world();
    await expect(endDueBroadcasts(w.fake, { now: () => new Date(w.now()), budgetMs: BUDGET_MS, orgIds: [] })).rejects.toThrow(/orgIds is empty/);
    expect(w.fake.calls, "refused before it asked YouTube anything").toEqual([]);
    await expect(endDueBroadcasts(w.fake, { now: () => new Date(w.now()), budgetMs: BUDGET_MS, orgIds: [w.orgId] })).resolves.toEqual(ZERO);
  });

  for (const mode of ["passthrough", "composed"] as const) {   // §9.2: both modes
    it(`${mode}: Go live → Stop → not ended at Stop + 4:59 → ended at +6 min (complete called once, the row complete with the scripted actual times) → the NEXT Go live is a NEW broadcast`, async () => {
      const w = await world({ credits: 2 });
      const f = w.fixtures[0]!;
      const m = await playAndStop(w, f, mode);

      const calls0 = w.fake.calls.length;
      expect(await w.step({ at: afterStop(m, min(GRACE_MINUTES) - SEC) })).toEqual(ZERO);
      expect(w.fake.calls.length, "inside the grace the step asks YouTube nothing").toBe(calls0);
      expect(await broadcastRow(m.broadcastId)).toMatchObject({ state: "live", completed_at: null, actual_start_at: null, actual_end_at: null });

      const stepAt = afterStop(m, min(6));
      expect(await w.step({ at: stepAt })).toEqual({ ...ZERO, ended: 1 });
      expect(callsOf(w.fake, "complete"), "transition called once").toBe(1);
      expect(callsOf(w.fake, "deleteBroadcast")).toBe(0);
      expect(w.fake.inspectBroadcast(m.ytId)!.life).toBe("complete");
      const done = await broadcastRow(m.broadcastId);
      expect(done).toMatchObject({ state: "complete", last_error_code: null, next_attempt_at: null });
      expect(done.completed_at!.getTime()).toBe(stepAt);
      // D15: YouTube's own times, here the instants this test scripted (the video arrived at startedAtMs; the end ran at stepAt).
      expect(done.actual_start_at!.getTime()).toBe(m.startedAtMs);
      expect(done.actual_end_at!.getTime()).toBe(stepAt);
      expect(sentry.captureError, "a normal end reports nothing").not.toHaveBeenCalled();

      // The sequence: the same match goes live again → a NEW broadcast (the complete one is gone), and the old row is untouched.
      const second = await goLive(w, f, mode);
      const s2 = await sessionRow(second.sessionId);
      expect(s2.youtube_broadcast_id).not.toBe(m.broadcastId);
      expect(callsOf(w.fake, "insertBroadcast"), "two broadcasts made at YouTube").toBe(2);
      expect((await broadcastsOf(f)).map((b) => b.state)).toEqual(["complete", "live"]);
      expect((await broadcastRow(m.broadcastId)).state).toBe("complete");
    });
  }

  it("a second firing finds it complete and does nothing: no YouTube call, no count, the row unchanged", async () => {
    const w = await world();
    const m = await playAndStop(w, w.fixtures[0]!);
    expect(await w.step({ at: afterStop(m, min(6)) })).toMatchObject({ ended: 1 });
    const before = await broadcastRow(m.broadcastId);
    const calls = w.fake.calls.length;
    expect(await w.step({ at: afterStop(m, min(7)) })).toEqual(ZERO);
    expect(w.fake.calls.length).toBe(calls);
    expect(await broadcastRow(m.broadcastId)).toEqual(before);
  });

  it("finished, then Stop: due at +2 — not ended at +1:59, ended at +2:00 (and the right answer differs from the +5 of an unfinished match)", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const { sessionId } = await goLive(w, f);
    await reachLive(w, f, sessionId, "passthrough");
    const b = await broadcastRow((await sessionRow(sessionId)).youtube_broadcast_id!);
    w.video(b.yt_broadcast_id!);
    await setStatus(f, "decided");   // the trigger stamps finished_at with the database's clock
    const F = (await finishedAtOf(f))!;
    w.setNow(Math.max(w.now(), F.getTime()) + 5 * SEC);   // the Stop is after the result
    await stopToEnd(w, f, sessionId, "passthrough");
    const S = (await sessionRow(sessionId)).ended_at!;
    expect(S.getTime(), "premise: the result landed before the Stop").toBeGreaterThan(F.getTime());

    expect(await w.step({ at: S.getTime() + min(FINISHED_END_MINUTES) - SEC })).toEqual(ZERO);
    expect(await broadcastRow(b.id)).toMatchObject({ state: "live" });
    expect(await w.step({ at: S.getTime() + min(FINISHED_END_MINUTES) })).toEqual({ ...ZERO, ended: 1 });
    expect((await broadcastRow(b.id)).state).toBe("complete");
  });

  it("after a void: Stop, the result lands (+1 → due +3), then is voided (+2) → due falls back to Stop + 5: not ended at +3 or +4:59, ended at +5", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const m = await playAndStop(w, f);
    // Wall-clock database stamp for finished_at: the Stop is `1 min` of the injected clock behind, so read F back and judge against it.
    w.setNow(Math.max(w.now(), Date.now()));
    await setStatus(f, "decided");
    const F = (await finishedAtOf(f))!;
    const resultDue = Math.max(m.endedAt.getTime(), F.getTime()) + min(FINISHED_END_MINUTES);
    expect(resultDue, "premise: the result makes it due before Stop + 5").toBeLessThan(afterStop(m, min(GRACE_MINUTES)));
    await setStatus(f, "in_play");   // voided: the trigger clears finished_at
    expect(await finishedAtOf(f)).toBeNull();
    expect(await w.step({ at: resultDue + SEC })).toEqual(ZERO);
    expect(await w.step({ at: afterStop(m, min(GRACE_MINUTES) - SEC) })).toEqual(ZERO);
    expect(await w.step({ at: afterStop(m, min(GRACE_MINUTES)) })).toMatchObject({ ended: 1 });
  });

  // ═══ each end path anchors the rule at ended_at ════════════════════════════════════════════════════════════════════
  it("each of the SIX end paths fires the rule from the session's ended_at: not ended a second before its time, ended on it — Stop + 5, or + 2 for the auto-stop that only follows a result (checked === 6)", async () => {
    type Path = { name: string; reason: string; dueMinutes: number; world?: Parameters<typeof world>[0]; end(w: World, f: string, sid: string): Promise<void>; skipLive?: boolean; refused?: boolean };
    const paths: Path[] = [
      { name: "organiser Stop (stopSession)", reason: "stopped", dueMinutes: GRACE_MINUTES, end: async (w, f, sid) => { await stopSession(w.auth, f, sid, w.deps); } },
      {
        name: "capture phone Stop (the real beat)", reason: "operator_stopped", dueMinutes: GRACE_MINUTES,
        end: async (w, f, sid) => {
          const [code] = await sql<{ id: string; code: string }[]>`select id, code from fixture_stream_codes where fixture_id = ${f} and ended_at is null`;
          const tok = (await sql.begin((tx) => openStreamCodeTok(tx, code!.id))) as string;
          const [pairing] = await sql<{ phone: string }[]>`select phone from fixture_stream_pairings where code_id = ${code!.id} and slot = 0 and ended_at is null`;
          const at = w.deps.now();
          const answer = await postBeat(code!.code, tok, CaptureBeat.parse({
            code: code!.code, slot: 0, phone: pairing!.phone, claim: null, device: null, sid, at: at.toISOString(), state: "ended",
            cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
            delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
            appVersion: "t14-test/1", endReason: "operator-stopped",
          }), w.deps, at);
          expect(answer.state, "premise: the phone's Stop was accepted").toBe("over");
        },
      },
      {
        // Auto-stop only ever fires on a FINISHED fixture (a result stands), so D5's rule applies: Stop + 2, not Stop + 5.
        name: "automatic stop after the result (the tick's auto-stop)", reason: "auto_stopped", dueMinutes: FINISHED_END_MINUTES,
        end: async (w, f, sid) => {
          await saveStreamSettings(w.auth, f, { autoStream: true });
          await sql`update fixture_stream_pairings set mode = 'automatic'
                     where id = (select pairing_id from fixture_stream_sessions where id = ${sid})`;
          await setStatus(f, "decided");   // the session predates the result
          const F = (await finishedAtOf(f))!;
          w.setNow(Math.max(w.now(), F.getTime()) + 181 * SEC);   // past the 180 s the auto-stop waits after the result
          await tickSession(sid, w.deps, "sweep");
        },
      },
      {
        name: "the deadline (applyExpiry on a session that never connected)", reason: "expiry", dueMinutes: GRACE_MINUTES, world: { connectAfterMs: NEVER_MS }, skipLive: true,
        end: async (w, _f, sid) => {
          w.tick((WARMING_TIMEOUT_MINUTES + 1) * MIN);
          await applyExpiry(sid, w.deps);
        },
      },
      {
        name: "the output could not be added (failClosedOnOutput)", reason: "output_failed", dueMinutes: GRACE_MINUTES, skipLive: true, refused: true,
        end: async () => { /* the failure IS the Go live: see below */ },
      },
      {
        name: "no relay on this deployment (stopSession under disabled drivers)", reason: "relay_disabled", dueMinutes: GRACE_MINUTES,
        end: async (w, f, sid) => { await stopSession(w.auth, f, sid, { ...w.deps, drivers: disabledRelayDrivers() }); },
      },
    ];
    let checked = 0;
    for (const p of paths) {
      const w = await world(p.world ?? {});
      const f = w.fixtures[0]!;
      let sid: string;
      if (p.refused) {
        w.ingest.addOutput = async () => { throw new Error("the destination output could not be added"); };
        expect(await refusalOf(goLive(w, f)), p.name).toMatchObject({ status: 503, code: "ingest_unavailable" });
        sid = (await sql<{ id: string }[]>`select id from fixture_stream_sessions where fixture_id = ${f}`)[0]!.id;
      } else {
        sid = (await goLive(w, f)).sessionId;
        if (!p.skipLive) await reachLive(w, f, sid, "passthrough");
        w.tick(SEC);
        await p.end(w, f, sid);
      }
      const s = await sessionRow(sid);
      expect(["completed", "failed"], `${p.name}: premise — the session is over (${s.state})`).toContain(s.state);
      expect(s.ended_at, `${p.name}: the domain wrote ended_at`).toBeInstanceOf(Date);
      if (p.reason !== "expiry") expect(s.end_reason ?? s.fail_reason, `${p.name}: the path taken`).toBe(p.reason);
      else expect(s.fail_reason, `${p.name}: a deadline failure`).not.toBeNull();
      const b = await broadcastRow(s.youtube_broadcast_id!);
      expect(b.state, `${p.name}: premise — the broadcast is still live (the session is what ended)`).toBe("live");
      w.video(b.yt_broadcast_id!);   // video had flowed: the broadcast ends by complete, whatever way the session ended
      const S = s.ended_at!.getTime();

      expect(await w.step({ at: S + min(p.dueMinutes) - SEC }), `${p.name}: ${p.dueMinutes} min - 1 s`).toEqual(ZERO);
      expect((await broadcastRow(b.id)).state, `${p.name}: just before`).toBe("live");
      expect(await w.step({ at: S + min(p.dueMinutes) }), `${p.name}: ${p.dueMinutes} min`).toEqual({ ...ZERO, ended: 1 });
      expect((await broadcastRow(b.id)).state, `${p.name}: at its time`).toBe("complete");
      checked++;
    }
    expect(paths).toHaveLength(6);
    expect(checked, "all six end paths were driven").toBe(6);
  });

  // ═══ never live, orphans ═══════════════════════════════════════════════════════════════════════════════════════════
  it("never live: bound, the video never arrived, the session ended → deleteBroadcast (complete not called), the row failed 'never_live', no actual times, not a replay part", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const { sessionId } = await goLive(w, f);
    await reachLive(w, f, sessionId, "passthrough");
    await stopToEnd(w, f, sessionId, "passthrough");
    const S = (await sessionRow(sessionId)).ended_at!;
    const b = await broadcastRow((await sessionRow(sessionId)).youtube_broadcast_id!);
    expect(w.fake.inspectBroadcast(b.yt_broadcast_id!)!.life, "premise: no video ever arrived").toBe("ready");

    expect(await w.step({ at: S.getTime() + min(GRACE_MINUTES) })).toEqual({ ...ZERO, neverLive: 1 });
    expect(callsOf(w.fake, "deleteBroadcast")).toBe(1);
    expect(callsOf(w.fake, "complete"), "a broadcast that never ran is deleted, not completed").toBe(0);
    expect(w.fake.inspectBroadcast(b.yt_broadcast_id!), "gone at YouTube").toBeNull();
    const row = await broadcastRow(b.id);
    expect(row).toMatchObject({ state: "failed", actual_start_at: null, actual_end_at: null });
    expectOurCode(row, "never_live");
    expect(row.completed_at!.getTime()).toBe(S.getTime() + min(GRACE_MINUTES));
    expect(await streamUrlOf(f), "no replay link for a broadcast that never ran").toBeNull();
    expect(urlHook.calls).toBe(0);
  });

  it("orphan: a bound broadcast no session ever used — 9 min old untouched (0 YouTube calls), 11 min old deleted at YouTube and failed 'orphan' (a prepare is the producer)", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const p = (await prepareYoutubeBroadcast({ orgId: w.orgId, fixtureId: f, targetId: w.targetId, now: w.deps.now(), startCause: "organiser" }, w.fake))!;
    const row0 = await broadcastRow(p.broadcastId);
    expect(row0.state, "premise: prepare left it bound with no session").toBe("bound");
    const bornAt = row0.created_at.getTime();
    const calls = w.fake.calls.length;

    expect(await w.step({ at: bornAt + 9 * MIN })).toEqual(ZERO);
    expect(w.fake.calls.length, "inside the 10 minutes nothing is asked").toBe(calls);
    expect((await broadcastRow(p.broadcastId)).state).toBe("bound");

    expect(await w.step({ at: bornAt + 11 * MIN })).toEqual({ ...ZERO, orphans: 1 });
    expect(callsOf(w.fake, "deleteBroadcast")).toBe(1);
    expect(callsOf(w.fake, "complete")).toBe(0);
    expect(w.fake.inspectBroadcast(row0.yt_broadcast_id!), "deleted at YouTube").toBeNull();
    const row = await broadcastRow(p.broadcastId);
    expect(row.state).toBe("failed");
    expectOurCode(row, "orphan");
    expect(ORPHAN_MINUTES).toBe(10);
  });

  it("orphan shape: a `created` row with a key but NO YouTube id (a crash between the insert and the failRow) → failed 'orphan' with NO YouTube call at all (the real prepare, left mid-call, is the producer)", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    // The process dies inside liveBroadcasts.insert: the call never answers, so prepare never reaches failRow.
    w.fake.insertBroadcast = () => new Promise<never>(() => { /* never answers */ });
    void prepareYoutubeBroadcast({ orgId: w.orgId, fixtureId: f, targetId: w.targetId, now: w.deps.now(), startCause: "organiser" }, w.fake).catch(() => undefined);
    let row: BRow | undefined;
    for (let i = 0; i < 100 && !(row?.key_id); i++) {
      row = (await broadcastsOf(f))[0];
      if (!row?.key_id) await new Promise((r) => setTimeout(r, 50));
    }
    expect(row, "premise: the row was inserted before the call").toBeDefined();
    expect(row).toMatchObject({ state: "created", yt_broadcast_id: null });
    expect(row!.key_id, "premise: it holds a key").not.toBeNull();
    const calls = w.fake.calls.length;

    expect(await w.step({ at: row!.created_at.getTime() + 9 * MIN })).toEqual(ZERO);
    expect(await w.step({ at: row!.created_at.getTime() + 11 * MIN })).toEqual({ ...ZERO, orphans: 1 });
    expect(w.fake.calls.length, "no YouTube id, so nothing to ask — not even a token").toBe(calls);
    const after = await broadcastRow(row!.id);
    expect(after.state).toBe("failed");
    expectOurCode(after, "orphan");
    // The key it held is free again: a fresh prepare takes it (0 new streams).
    const streams = w.issued.length;
    w.fake.insertBroadcast = FakeYouTube.prototype.insertBroadcast.bind(w.fake);
    const again = await prepareYoutubeBroadcast({ orgId: w.orgId, fixtureId: f, targetId: w.targetId, now: new Date(w.now()), startCause: "organiser" }, w.fake);
    expect(again!.keyId).toBe(row!.key_id);
    expect(w.issued.length).toBe(streams);
  });

  it("orphan shape: a reused bound row whose ONLY session failed provisioning (live, last_session_id null, no session left) → failed 'orphan' once 10+ minutes old (the real Go live is the producer)", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const p = (await prepareYoutubeBroadcast({ orgId: w.orgId, fixtureId: f, targetId: w.targetId, now: w.deps.now(), startCause: "organiser" }, w.fake))!;   // a bound row two Go lives would share
    w.ingest.createLiveInput = async () => { throw new Error("cloudflare is down"); };
    await refusalOf(goLive(w, f));
    const row0 = await broadcastRow(p.broadcastId);
    const sessions = (await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${f}`)[0]!.n;
    expect({ state: row0.state, last_session_id: row0.last_session_id, sessions }, "premise: nothing references the live row").toEqual({ state: "live", last_session_id: null, sessions: 0 });

    expect(await w.step({ at: row0.created_at.getTime() + 9 * MIN })).toEqual(ZERO);
    expect(await w.step({ at: row0.created_at.getTime() + 11 * MIN })).toEqual({ ...ZERO, orphans: 1 });
    const row = await broadcastRow(p.broadcastId);
    expect(row.state).toBe("failed");
    expectOurCode(row, "orphan");
    expect(callsOf(w.fake, "deleteBroadcast")).toBe(1);
  });

  it("orphan shape: a row prepare claimed `ending` on ANOTHER channel (the destination was switched) with no session → deleted with ITS channel's token, failed 'orphan'", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const two = await connectChannel({ auth: w.auth, orgId: w.orgId, userId: w.userId });
    const first = (await prepareYoutubeBroadcast({ orgId: w.orgId, fixtureId: f, targetId: w.targetId, now: w.deps.now(), startCause: "organiser" }, w.fake))!;
    const second = (await prepareYoutubeBroadcast({ orgId: w.orgId, fixtureId: f, targetId: two.targetId, now: w.deps.now(), startCause: "organiser" }, w.fake))!;
    expect(second.broadcastId).not.toBe(first.broadcastId);
    const r1 = await broadcastRow(first.broadcastId);
    expect(r1.state, "premise: the cross-channel claim left it ending").toBe("ending");
    expect((await broadcastRow(second.broadcastId)).connection_id).toBe(two.connectionId);

    const result = await w.step({ at: r1.created_at.getTime() + 11 * MIN });
    expect(result.orphans, "both are orphans: the claimed one and the new one nobody streamed into").toBe(2);
    expect(await broadcastRow(first.broadcastId)).toMatchObject({ state: "failed", last_error_code: "orphan" });
    expect(await broadcastRow(second.broadcastId)).toMatchObject({ state: "failed", last_error_code: "orphan" });
    expect(w.fake.inspectBroadcast(r1.yt_broadcast_id!), "deleted on its own channel").toBeNull();
  });

  it("orphan shape: a lapsed reservation with no session (an admission died after reserving) → orphan; an UNLAPSED reservation, however old the row, is left to its admission", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const p = (await prepareYoutubeBroadcast({ orgId: w.orgId, fixtureId: f, targetId: w.targetId, now: w.deps.now(), startCause: "organiser" }, w.fake))!;
    const born = (await broadcastRow(p.broadcastId)).created_at.getTime();
    w.setNow(born + 11 * MIN);
    await prepareYoutubeBroadcast({ orgId: w.orgId, fixtureId: f, targetId: w.targetId, now: w.deps.now(), startCause: "organiser" }, w.fake);   // reuse → reserved for 2 min
    const reserved = await broadcastRow(p.broadcastId);
    expect(reserved.state, "premise: reserved").toBe("reserved");
    expect(reserved.reserved_until!.getTime(), "premise: the reservation is still held").toBeGreaterThan(w.now());

    expect(await w.step({ at: born + 11 * MIN })).toEqual(ZERO);
    expect((await broadcastRow(p.broadcastId)).state, "an unlapsed reservation is an admission in progress").toBe("reserved");
    expect(await w.step({ at: reserved.reserved_until!.getTime() + SEC })).toEqual({ ...ZERO, orphans: 1 });
    expect(await broadcastRow(p.broadcastId)).toMatchObject({ state: "failed", last_error_code: "orphan", reserved_until: null });
  });

  it("an old broadcast with a session on it is NOT an orphan: a live session 25 minutes in leaves the row alone and asks YouTube nothing", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const { sessionId } = await goLive(w, f);
    await reachLive(w, f, sessionId, "passthrough");
    const b = await broadcastRow((await sessionRow(sessionId)).youtube_broadcast_id!);
    const calls = w.fake.calls.length;
    expect(await w.step({ at: w.now() + 25 * MIN })).toEqual(ZERO);
    expect(w.fake.calls.length).toBe(calls);
    expect((await broadcastRow(b.id)).state).toBe("live");
  });

  it("an `ending` row with no YouTube id (the claim of a row that never reached YouTube) finalizes FAILED, never complete, with no YouTube call", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const [row] = await sql<{ id: string }[]>`
      insert into youtube_broadcasts (org_id, connection_id, fixture_id, title, privacy, state, claimed_at)
      values (${w.orgId}, ${w.connectionId}, ${f}, 't14', 'unlisted', 'ending', ${new Date(w.now())})
      returning id`;
    expect(await w.step({ at: w.now() + SEC })).toEqual({ ...ZERO, neverLive: 1 });
    expect(w.fake.calls, "no id, nothing to ask").toEqual([]);
    const after = await broadcastRow(row!.id);
    expect(after.state).toBe("failed");
    expectOurCode(after, "never_live");
  });

  // ═══ the replay link ═══════════════════════════════════════════════════════════════════════════════════════════════
  it("stream_url: null → the watch URL (through the real stream-link path), seen by the REAL currentSession as a replay the panel's icon gate accepts; already set by the club → untouched", async () => {
    const w = await world({ fixtures: 2, credits: 2 });
    const [f1, f2] = w.fixtures as [string, string];
    const m1 = await playAndStop(w, f1);
    expect(await streamUrlOf(f1), "premise: no link yet").toBeNull();
    expect(await w.step({ at: afterStop(m1, min(6)) })).toMatchObject({ ended: 1 });
    expect(await streamUrlOf(f1)).toBe(youtubeWatchUrl(m1.ytId));
    // Producer → consumer: the view an organiser's panel is served.
    const view = await currentSession(w.auth, f1, w.deps);
    expect(view!.replayUrl).toBe(`https://www.youtube.com/watch?v=${m1.ytId}`);
    expect(isYoutubeUrl(view!.replayUrl!), "the panel shows the YouTube mark for it").toBe(true);

    // The club's own link wins (Part 1 rule).
    await sql`update fixtures set stream_url = 'https://example.com/club-stream' where id = ${f2}`;
    const m2 = await playAndStop(w, f2);
    expect(await w.step({ at: afterStop(m2, min(6)) })).toMatchObject({ ended: 1 });
    expect(await streamUrlOf(f2), "the club's link is untouched").toBe("https://example.com/club-stream");
    expect((await broadcastRow(m2.broadcastId)).state).toBe("complete");
  });

  it("Part 2 never replaces Part 1: a second broadcast on the fixture completes later and the stream_url stays the first part's (a link is still written when last_session_id was nulled)", async () => {
    const w = await world({ credits: 2 });
    const f = w.fixtures[0]!;
    const m1 = await playAndStop(w, f);
    // Null the session link (the FK's set null after a session delete): the actor must still resolve.
    await sql`update youtube_broadcasts set last_session_id = null where id = ${m1.broadcastId}`;
    expect(await w.step({ at: afterStop(m1, min(6)) })).toMatchObject({ ended: 1 });
    expect(await streamUrlOf(f)).toBe(youtubeWatchUrl(m1.ytId));
    const m2 = await playAndStop(w, f);
    expect(m2.ytId).not.toBe(m1.ytId);
    expect(await w.step({ at: afterStop(m2, min(6)) })).toMatchObject({ ended: 1 });
    expect(await streamUrlOf(f), "Part 2 did not take the link").toBe(youtubeWatchUrl(m1.ytId));
    expect((await broadcastRow(m2.broadcastId)).state).toBe("complete");
  });

  it("the replay link is written AS the session's creator, and — when last_session_id was nulled — AS the connection's creator: two distinct people, the exact actor passed to the stream-link path in each branch", async () => {
    const connectionUser = await rigUser();
    const w = await world({ fixtures: 2, credits: 2, connectionUser });
    expect(connectionUser, "premise: two different people").not.toBe(w.userId);
    const [f1, f2] = w.fixtures as [string, string];
    const m1 = await playAndStop(w, f1);   // started by the organiser, w.userId
    const m2 = await playAndStop(w, f2);
    await sql`update youtube_broadcasts set last_session_id = null where id = ${m2.broadcastId}`;
    expect(await w.step({ at: afterStop(m2, min(6)) })).toEqual({ ...ZERO, ended: 2 });
    const byFixture = new Map(urlHook.actors.map((a) => [a.fixtureId, a.userId]));
    expect(urlHook.actors, "one link write per fixture").toHaveLength(2);
    expect(byFixture.get(f1), "session branch: the organiser who ran the session").toBe(w.userId);
    expect(byFixture.get(f2), "fallback branch: the person who connected the channel").toBe(connectionUser);
    expect(await streamUrlOf(f1)).toBe(youtubeWatchUrl(m1.ytId));
    expect(await streamUrlOf(f2)).toBe(youtubeWatchUrl(m2.ytId));
  });

  it("a port that throws something that is NOT a port refusal (a driver bug) is recorded as youtube_unavailable AND reported once, with ids only: the original message — which could hold a secret — is in no report", async () => {
    const w = await world();
    const m = await playAndStop(w, w.fixtures[0]!);
    const secret = `ya29.${randomBytes(12).toString("hex")}`;
    w.fake.broadcastLife = async () => { throw new TypeError(`cannot read ${secret}`); };
    expect(await w.step({ at: afterStop(m, min(6)) })).toEqual({ ...ZERO, failed: 1 });
    const row = await broadcastRow(m.broadcastId);
    expect(row).toMatchObject({ state: "ending", attempts: 1 });
    expectOurCode(row, "youtube_unavailable");
    expect(sentry.captureError, "reported once, not swallowed").toHaveBeenCalledTimes(1);
    const [err, ctx] = sentry.captureError.mock.calls[0] as [unknown, { orgId?: string; route?: string; extra?: Record<string, unknown> }];
    expect(err).toBeInstanceOf(Error);
    expect(ctx).toMatchObject({ orgId: w.orgId, extra: { broadcastId: m.broadcastId } });
    const everything = [String((err as Error).message), String((err as Error).stack), JSON.stringify(ctx)].join("\n");
    expect(everything, "the original message is not in the report").not.toContain(secret);
    expect(everything, "nor is the channel's token").not.toContain(w.token);
  });

  it("a failed read of YouTube's actual times is reported (once, ids only) and never keeps the broadcast from completing; the start time from the first read is kept, the end is null", async () => {
    const w = await world();
    const m = await playAndStop(w, w.fixtures[0]!);
    const lifeReal = w.fake.broadcastLife.bind(w.fake);
    let reads = 0;
    w.fake.broadcastLife = async (...a: Parameters<typeof lifeReal>) => {
      if (++reads === 2) throw new YouTubeError("youtube_unavailable");   // the read after `complete`
      return lifeReal(...a);
    };
    expect(await w.step({ at: afterStop(m, min(6)) })).toEqual({ ...ZERO, ended: 1 });
    expect(reads, "premise: the second read was reached").toBe(2);
    const row = await broadcastRow(m.broadcastId);
    expect(row.state).toBe("complete");
    expect(row.actual_start_at!.getTime(), "the first read's start time stands (the scripted video instant)").toBe(m.startedAtMs);
    expect(row.actual_end_at, "the end time was not read").toBeNull();
    expect(sentry.captureError).toHaveBeenCalledTimes(1);
    const [, ctx] = sentry.captureError.mock.calls[0] as [unknown, { orgId?: string; extra?: Record<string, unknown> }];
    expect(ctx).toMatchObject({ orgId: w.orgId, extra: { broadcastId: m.broadcastId } });
    expect(JSON.stringify(sentry.captureError.mock.calls)).not.toContain(w.token);
  });

  it("a replay-link write that fails does NOT keep the broadcast from ending: it completes, the failure is reported (no secret in it), and the parts list still has it", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const m = await playAndStop(w, f);
    urlHook.fail = true;
    expect(await w.step({ at: afterStop(m, min(6)) })).toEqual({ ...ZERO, ended: 1 });
    expect((await broadcastRow(m.broadcastId)).state).toBe("complete");
    expect(await streamUrlOf(f), "the link was not written").toBeNull();
    expect(sentry.captureError).toHaveBeenCalledTimes(1);
    const reported = JSON.stringify(sentry.captureError.mock.calls);
    expect(reported).not.toContain(w.token);
  });

  // ═══ the races ═════════════════════════════════════════════════════════════════════════════════════════════════════
  it("two overlapping firings (Promise.all) → exactly ONE complete call; ended sums to 1", async () => {
    const w = await world();
    const m = await playAndStop(w, w.fixtures[0]!);
    w.setNow(afterStop(m, min(6)));
    const [a, b] = await Promise.all([w.step(), w.step()]);
    expect(a.ended + b.ended, "one end").toBe(1);
    expect(callsOf(w.fake, "complete"), "one transition").toBe(1);
    expect((await broadcastRow(m.broadcastId)).state).toBe("complete");
  });

  it("a second firing that runs entirely inside the first's claim → call window finds the row leased: it asks YouTube NOTHING, and the first still ends it once", async () => {
    const w = await world();
    const m = await playAndStop(w, w.fixtures[0]!);
    let inner: YoutubeEndResult | null = null;
    let callsInside = -1;
    let claimedRow: BRow | null = null;
    const res = await w.step({
      at: afterStop(m, min(6)),
      hooks: {
        afterClaim: async (id) => {
          // The claim is committed and visible: the row is `ending`, claimed now, and LEASED for 2 minutes.
          claimedRow = await broadcastRow(id);
          const before = w.fake.calls.length;
          inner = await w.step();
          callsInside = w.fake.calls.length - before;
        },
      },
    });
    expect(inner, "the hook ran").not.toBeNull();
    expect(claimedRow).toMatchObject({ state: "ending", attempts: 0 });
    expect(claimedRow!.claimed_at!.getTime(), "claimed at the step's clock").toBe(afterStop(m, min(6)));
    expect(claimedRow!.next_attempt_at!.getTime(), "leased for 2 minutes").toBe(afterStop(m, min(6)) + 2 * MIN);
    expect(inner).toEqual(ZERO);
    expect(callsInside, "the second firing made no YouTube call").toBe(0);
    expect(res).toEqual({ ...ZERO, ended: 1 });
    expect(callsOf(w.fake, "complete")).toBe(1);
  });

  it("the RETRY of a crashed claim takes a fresh lease too: a firing past the first lease re-claims the `ending` row, and a third firing inside THAT claim's call window asks YouTube nothing; the broadcast is completed once", async () => {
    const w = await world();
    const m = await playAndStop(w, w.fixtures[0]!);
    const t0 = afterStop(m, min(6));
    let leaseOfRetry: Date | null = null;
    let third: YoutubeEndResult | null = null;
    let callsInThird = -1;
    let retried: YoutubeEndResult | null = null;
    // Firing 1 claims at t0 (lease to t0+2) and "stalls" in its call window; firing 2 arrives at t0+3, past that lease.
    const first = await w.step({
      at: t0,
      hooks: {
        afterClaim: async () => {
          retried = await w.step({
            at: t0 + 3 * MIN,
            hooks: {
              afterClaim: async (id) => {
                leaseOfRetry = (await broadcastRow(id)).next_attempt_at;
                const before = w.fake.calls.length;
                third = await w.step({ at: t0 + 3 * MIN });
                callsInThird = w.fake.calls.length - before;
              },
            },
          });
        },
      },
    });
    expect(retried, "the second firing ran").not.toBeNull();
    expect(leaseOfRetry!.getTime(), "the retry took a lease of its own, 2 minutes on").toBe(t0 + 3 * MIN + 2 * MIN);
    expect(third).toEqual(ZERO);
    expect(callsInThird, "the third firing found the retry's lease and asked YouTube nothing").toBe(0);
    expect(retried).toEqual({ ...ZERO, ended: 1 });
    expect(first, "the stalled first firing finds it complete and does not announce it again").toEqual(ZERO);
    expect(callsOf(w.fake, "complete"), "one transition in all").toBe(1);
    expect(await broadcastRow(m.broadcastId)).toMatchObject({ state: "complete" });
  });

  it("a row another firing holds LOCKED is skipped, not waited for (`skip locked`): the step returns while the lock is held, calls nothing, and the row is ended once the lock is gone", async () => {
    const w = await world();
    const m = await playAndStop(w, w.fixtures[0]!);
    w.setNow(afterStop(m, min(6)));
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const holder = sql.begin(async (tx) => {
      await tx`select id from youtube_broadcasts where id = ${m.broadcastId} for update`;
      locked();
      await held;
    });
    try {
      await isLocked;
      const outcome = await Promise.race([w.step(), new Promise<"blocked">((r) => setTimeout(() => r("blocked"), 3000))]);
      expect(outcome, "the step did not wait on the held row").toEqual(ZERO);
      expect(callsOf(w.fake, "complete")).toBe(0);
    } finally {
      release();
      await holder;
    }
    expect(await w.step()).toEqual({ ...ZERO, ended: 1 });
  });

  it("no row lock is held across ANY YouTube call: every port call is probed with `for update nowait` on the broadcast row and on the connection row", async () => {
    const w = await world();
    const m = await playAndStop(w, w.fixtures[0]!);
    const probed: string[] = [];
    const probe = async (method: string) => {
      await sql.begin(async (tx) => {
        await tx`select id from youtube_broadcasts where id = ${m.broadcastId} for update nowait`;
        await tx`select id from org_youtube_connections where id = ${w.connectionId} for update nowait`;
      });
      probed.push(method);
    };
    for (const method of ["accessToken", "broadcastLife", "complete", "deleteBroadcast"] as const) {
      const real = (w.fake[method] as (...a: never[]) => Promise<unknown>).bind(w.fake);
      (w.fake as unknown as Record<string, unknown>)[method] = async (...a: never[]) => {
        await probe(method);
        return real(...a);
      };
    }
    expect(await w.step({ at: afterStop(m, min(6)) })).toMatchObject({ ended: 1 });
    expect(probed, "accessToken, the life read, complete, and the actual-times read were all probed").toEqual(["accessToken", "broadcastLife", "complete", "broadcastLife"]);
  });

  it("race, order A: admission reserves first → the step sees the reservation → not due; the session attaches and the broadcast stays live (and ends later, once)", async () => {
    const w = await world({ credits: 2 });
    const f = w.fixtures[0]!;
    const m = await playAndStop(w, f);
    // Go live again 4:50 after the Stop (inside the grace): prepare reserves; between the reservation and the session insert the step fires,
    // by which time the grace would have lapsed (+5:10).
    w.setNow(afterStop(m, 4 * MIN + 50 * SEC));
    let during: YoutubeEndResult | null = null;
    let stateDuring = "";
    prepareHook.after = async () => {
      stateDuring = (await broadcastRow(m.broadcastId)).state;
      during = await w.step({ at: afterStop(m, 5 * MIN + 10 * SEC) });
    };
    w.setNow(afterStop(m, 4 * MIN + 50 * SEC));
    const second = await goLive(w, f);
    expect(stateDuring, "premise: the step ran while the broadcast was reserved").toBe("reserved");
    expect(during).toEqual(ZERO);
    expect(callsOf(w.fake, "complete"), "the step ended nothing").toBe(0);
    const s2 = await sessionRow(second.sessionId);
    expect(s2.youtube_broadcast_id, "the session attached to the SAME broadcast").toBe(m.broadcastId);
    expect(await broadcastRow(m.broadcastId)).toMatchObject({ state: "live", last_session_id: second.sessionId });
    expect(w.fake.inspectBroadcast(m.ytId)!.life).toBe("live");
  });

  it("race, order B: the step claims first (afterClaim pauses it) → admission takes the new-broadcast path; the claimed row ends complete, the new one is live; no active session references an ended broadcast", async () => {
    const w = await world({ credits: 2 });
    const f = w.fixtures[0]!;
    const m = await playAndStop(w, f);
    let second: { sessionId: string } | null = null;
    const stepAt = afterStop(m, min(6));
    const res = await w.step({
      at: stepAt,
      hooks: { afterClaim: async () => { second = await goLive(w, f); } },
    });
    expect(second, "premise: Go live ran inside the claim → call window").not.toBeNull();
    expect(res).toEqual({ ...ZERO, ended: 1 });
    const s2 = await sessionRow(second!.sessionId);
    expect(s2.youtube_broadcast_id, "admission did not reuse the claimed row").not.toBe(m.broadcastId);
    expect(await broadcastRow(m.broadcastId)).toMatchObject({ state: "complete" });
    expect(await broadcastRow(s2.youtube_broadcast_id!)).toMatchObject({ state: "live", last_session_id: second!.sessionId });
    const bad = await sql<{ n: number }[]>`
      select count(*)::int as n from fixture_stream_sessions s join youtube_broadcasts b on b.id = s.youtube_broadcast_id
       where s.fixture_id = ${f} and s.state in ${sql([...ACTIVE_STATES])} and b.state in ('complete', 'failed')`;
    expect(bad[0]!.n, "no active session references a finished broadcast").toBe(0);
    expect(callsOf(w.fake, "insertBroadcast"), "the second Go live made its own broadcast").toBe(2);
  });

  it("finalize only moves an `ending` row: if something else finalized it between the claim and the finalize, the step does not overwrite it, counts nothing and writes no link", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const m = await playAndStop(w, f);
    const res = await w.step({
      at: afterStop(m, min(6)),
      hooks: { afterClaim: async (id) => { await sql`update youtube_broadcasts set state = 'failed', last_error_code = 'other_writer' where id = ${id}`; } },
    });
    expect(res, "the row was no longer the step's to finalize").toEqual(ZERO);
    expect(await broadcastRow(m.broadcastId)).toMatchObject({ state: "failed", last_error_code: "other_writer", completed_at: null });
    expect(await streamUrlOf(f)).toBeNull();
  });

  it("a crashed claim is retried after its 2-minute lease and not before: a row left `ending` with the lease still running is not called; once it lapses the next run ends it", async () => {
    const w = await world();
    const m = await playAndStop(w, w.fixtures[0]!);
    const claimedAt = afterStop(m, min(6));
    // What a process that died between the claim's commit and the YouTube call leaves behind: claimed, leased, nothing called.
    await sql`update youtube_broadcasts set state = 'ending', claimed_at = ${new Date(claimedAt)}, next_attempt_at = ${new Date(claimedAt + 2 * MIN)} where id = ${m.broadcastId}`;
    expect(await w.step({ at: claimedAt + 2 * MIN - SEC })).toEqual(ZERO);
    expect(callsOf(w.fake, "complete")).toBe(0);
    expect(await w.step({ at: claimedAt + 2 * MIN })).toEqual({ ...ZERO, ended: 1 });
    expect((await broadcastRow(m.broadcastId)).state).toBe("complete");
  });

  // ═══ failures and the backoff ══════════════════════════════════════════════════════════════════════════════════════
  it("backoff: a failure sets attempts and next_attempt_at = now + 1, then + 2, then + 4 minutes (P6); the row stays ending and is not selected before its time; then it ends and the code clears", async () => {
    const w = await world();
    const m = await playAndStop(w, w.fixtures[0]!);
    const t0 = afterStop(m, min(6));
    for (const code of ["youtube_unavailable", "youtube_unavailable", "youtube_unavailable"] as const) w.fake.failNext("complete", code);

    expect(await w.step({ at: t0 })).toEqual({ ...ZERO, failed: 1 });
    let row = await broadcastRow(m.broadcastId);
    expect(row).toMatchObject({ state: "ending", attempts: 1 });
    expectOurCode(row, "youtube_unavailable");
    expect(row.next_attempt_at!.getTime()).toBe(t0 + 1 * MIN);

    const calls = w.fake.calls.length;
    expect(await w.step({ at: t0 + 1 * MIN - SEC })).toEqual(ZERO);
    expect(w.fake.calls.length, "not selected before its time").toBe(calls);

    expect(await w.step({ at: t0 + 1 * MIN })).toEqual({ ...ZERO, failed: 1 });
    row = await broadcastRow(m.broadcastId);
    expect(row).toMatchObject({ state: "ending", attempts: 2 });
    expect(row.next_attempt_at!.getTime()).toBe(t0 + 1 * MIN + 2 * MIN);

    expect(await w.step({ at: t0 + 3 * MIN })).toEqual({ ...ZERO, failed: 1 });
    row = await broadcastRow(m.broadcastId);
    expect(row.attempts).toBe(3);
    expect(row.next_attempt_at!.getTime()).toBe(t0 + 3 * MIN + 4 * MIN);

    expect(await w.step({ at: t0 + 7 * MIN })).toEqual({ ...ZERO, ended: 1 });
    expect(await broadcastRow(m.broadcastId)).toMatchObject({ state: "complete", last_error_code: null, next_attempt_at: null });
  });

  it("backoff is capped at 60 minutes: attempts 5 → 32 min, 6 → 60 (not 64), 9 → 60 (not 512)", async () => {
    const w = await world({ fixtures: 3, credits: 3 });
    const checks: { attempts: number; minutes: number }[] = [{ attempts: 5, minutes: 32 }, { attempts: 6, minutes: 60 }, { attempts: 9, minutes: 60 }];
    let checked = 0;
    for (let i = 0; i < checks.length; i++) {
      const m = await playAndStop(w, w.fixtures[i]!);
      const t = afterStop(m, min(6));
      await sql`update youtube_broadcasts set attempts = ${checks[i]!.attempts} where id = ${m.broadcastId}`;
      w.fake.failNext("accessToken", "youtube_unavailable");
      expect(await w.step({ at: t }), `attempts ${checks[i]!.attempts}`).toEqual({ ...ZERO, failed: 1 });
      const row = await broadcastRow(m.broadcastId);
      expect(row.attempts).toBe(checks[i]!.attempts + 1);
      expect(row.next_attempt_at!.getTime() - t, `attempts ${checks[i]!.attempts}`).toBe(checks[i]!.minutes * MIN);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("token killed mid-match: the video keeps flowing, the connection goes reconnect_needed, complete is NOT called, and the row is RETRIED at +1 and then +2 minutes (a token attempt each time); after the real reconnect the next run ends it at once", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const m = await playAndStop(w, f);
    const stream = w.fake.inspectBroadcast(m.ytId)!.streamId!;
    w.fake.killToken(w.token);
    const t0 = afterStop(m, min(6));

    // R5: not counted as a failure — a known state — but the row is claimed and backed off.
    expect(await w.step({ at: t0 })).toEqual(ZERO);
    expect(await connectionStatus(w.connectionId)).toBe("reconnect_needed");
    let row = await broadcastRow(m.broadcastId);
    expect(row).toMatchObject({ state: "ending", attempts: 1 });
    expectOurCode(row, "youtube_reconnect_needed");
    expect(row.next_attempt_at!.getTime()).toBe(t0 + 1 * MIN);
    expect(callsOf(w.fake, "complete"), "a dead token never reaches complete").toBe(0);
    expect(w.fake.inspectBroadcast(m.ytId)!.life, "the video keeps flowing: the broadcast is still live").toBe("live");
    expect(w.fake.boundOpenCount(stream)).toBe(1);

    const tokenAttempts = () => callsOf(w.fake, "accessToken");
    const a1 = tokenAttempts();
    expect(await w.step({ at: t0 + 1 * MIN - SEC })).toEqual(ZERO);
    expect(tokenAttempts(), "not before +1 min").toBe(a1);
    expect(await w.step({ at: t0 + 1 * MIN })).toEqual(ZERO);
    expect(tokenAttempts(), "a connection in reconnect_needed is RETRIED, never skipped (R5)").toBe(a1 + 1);
    row = await broadcastRow(m.broadcastId);
    expect(row.attempts).toBe(2);
    expect(row.next_attempt_at!.getTime()).toBe(t0 + 1 * MIN + 2 * MIN);
    expect(await w.step({ at: t0 + 3 * MIN })).toEqual(ZERO);
    expect(tokenAttempts(), "and again at the 2-minute mark").toBe(a1 + 2);

    // The real reconnect (T8's save): a fresh token for the SAME YouTube channel; it clears the backoff.
    const fresh = refreshToken();
    w.fake.seedGrant({ refreshToken: fresh, channelId: w.fake.channelOf(w.token), channelTitle: "Solo United" });
    const [conn] = await sql<{ channel_id: string; channel_title: string }[]>`select channel_id, channel_title from org_youtube_connections where id = ${w.connectionId}`;
    const g = await grant({ auth: w.auth, orgId: w.orgId, userId: w.userId }, {
      connectionId: w.connectionId, channels: [{ id: conn!.channel_id, title: conn!.channel_title }], token: fresh,
    });
    await saveConnectionFromGrant({ pendingId: g.id, channelId: conn!.channel_id, userId: w.userId }, w.fake);
    expect(await connectionStatus(w.connectionId)).toBe("connected");
    expect((await broadcastRow(m.broadcastId)).next_attempt_at, "the reconnect cleared the backoff").toBeNull();

    // Same instant as before the reconnect would still have been backed off (t0 + 3 + 4 min); it ends NOW.
    expect(await w.step({ at: t0 + 3 * MIN + 10 * SEC })).toEqual({ ...ZERO, ended: 1 });
    expect((await broadcastRow(m.broadcastId)).state).toBe("complete");
    const reported = JSON.stringify(sentry.captureError.mock.calls);
    expect(reported, "no token in anything reported").not.toContain(w.token);
    expect(reported).not.toContain(fresh);
  });

  it("the candidate rule is RE-READ under the lock: a row another firing leased, or something else failed, after this firing listed it is not called and not resurrected (checked === 2)", async () => {
    const variants = [
      { name: "leased by another firing", poke: (id: string) => sql`update youtube_broadcasts set next_attempt_at = ${new Date(Date.now() + 3_600_000 * 24)} where id = ${id}`, state: "live" },
      { name: "failed by another writer", poke: (id: string) => sql`update youtube_broadcasts set state = 'failed', last_error_code = 'other_writer' where id = ${id}`, state: "failed" },
    ];
    let checked = 0;
    for (const v of variants) {
      const w = await world({ fixtures: 2, credits: 2 });
      const [f1, f2] = w.fixtures as [string, string];
      const m1 = await playAndStop(w, f1);
      const m2 = await playAndStop(w, f2);
      const at = afterStop(m2, min(6));
      const res = await w.step({
        at,
        hooks: { afterClaim: async (id) => { if (id === m1.broadcastId) await v.poke(m2.broadcastId); } },
      });
      expect(res, `${v.name}: only the first was this firing's`).toEqual({ ...ZERO, ended: 1 });
      expect(callsOf(w.fake, "complete"), v.name).toBe(1);
      expect((await broadcastRow(m1.broadcastId)).state, v.name).toBe("complete");
      expect((await broadcastRow(m2.broadcastId)).state, `${v.name}: the second was left exactly as the other writer left it`).toBe(v.state);
      checked++;
    }
    expect(checked).toBe(variants.length);
  });

  it("a failure that lands AFTER another firing completed the row leaves it alone: recordFailure only touches an open row (the row stays complete, attempts 0, no backoff, no error code)", async () => {
    const w = await world();
    const m = await playAndStop(w, w.fixtures[0]!);
    const t0 = afterStop(m, min(6));
    const realToken = w.fake.accessToken.bind(w.fake);
    let tokens = 0;
    w.fake.accessToken = async (...a: Parameters<typeof realToken>) => {
      if (++tokens === 2) throw new YouTubeError("youtube_unavailable");   // the stalled first firing's call, after the second one finished
      return realToken(...a);
    };
    let second: YoutubeEndResult | null = null;
    const first = await w.step({ at: t0, hooks: { afterClaim: async () => { second = await w.step({ at: t0 + 3 * MIN }); } } });
    expect(second, "the second firing (past the first lease) completed it").toEqual({ ...ZERO, ended: 1 });
    expect(tokens, "premise: the first firing's call was reached and refused").toBe(2);
    expect(first.ended, "the stalled firing ended nothing").toBe(0);
    expect(callsOf(w.fake, "complete")).toBe(1);
    expect(await broadcastRow(m.broadcastId)).toMatchObject({ state: "complete", attempts: 0, next_attempt_at: null, last_error_code: null });
  });

  it("a connection revoked between the claim and the call (no token left): failed 'youtube_token_missing' with backoff, reported once with ids only, and the revoked connection's row is not a candidate again", async () => {
    const w = await world();
    const m = await playAndStop(w, w.fixtures[0]!);
    const t0 = afterStop(m, min(6));
    const calls = w.fake.calls.length;
    const res = await w.step({ at: t0, hooks: { afterClaim: async () => { await revokeConnection(sql, w.orgId, w.connectionId); } } });
    expect(res).toEqual({ ...ZERO, failed: 1 });
    expect(w.fake.calls.length, "no token, no call").toBe(calls);
    const row = await broadcastRow(m.broadcastId);
    expect(row).toMatchObject({ state: "ending", attempts: 1 });
    expectOurCode(row, "youtube_token_missing");
    expect(sentry.captureError).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sentry.captureError.mock.calls)).not.toContain(w.token);
    expect(await w.step({ at: t0 + 10 * MIN }), "a revoked connection's rows are not candidates").toEqual(ZERO);
  });

  it("a connection revoked AFTER the pass listed a row but BEFORE its claim: the claim re-checks the connection under the lock — the row is not claimed, not attempted, not failed", async () => {
    const w = await world({ fixtures: 2, credits: 2 });
    const [f1, f2] = w.fixtures as [string, string];
    const m1 = await playAndStop(w, f1);
    const m2 = await playAndStop(w, f2);
    const res = await w.step({
      at: afterStop(m2, min(6)),
      hooks: { afterClaim: async (id) => { if (id === m1.broadcastId) await revokeConnection(sql, w.orgId, w.connectionId); } },
    });
    expect(res, "only the first was claimed (it was, before the revoke): it finds no token").toEqual({ ...ZERO, failed: 1 });
    expect(await broadcastRow(m1.broadcastId)).toMatchObject({ state: "ending", attempts: 1 });
    expect(await broadcastRow(m2.broadcastId), "the second was never claimed nor attempted").toMatchObject({ state: "live", attempts: 0, last_error_code: null });
  });

  it("a stored token that will not open (the KEK was rotated): failed 'youtube_token_unreadable', the connection is NOT moved to reconnect_needed (it is ours to fix), no YouTube call; with the key back, the next run ends it", async () => {
    const w = await world();
    const m = await playAndStop(w, w.fixtures[0]!);
    const t0 = afterStop(m, min(6));
    const calls = w.fake.calls.length;
    const kek = process.env.YOUTUBE_TOKEN_KEK;
    process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex");
    try {
      expect(await w.step({ at: t0 })).toEqual({ ...ZERO, failed: 1 });
    } finally {
      process.env.YOUTUBE_TOKEN_KEK = kek;
    }
    expect(w.fake.calls.length, "nothing was asked of YouTube").toBe(calls);
    expect(await connectionStatus(w.connectionId), "not the club's to fix").toBe("connected");
    const row = await broadcastRow(m.broadcastId);
    expect(row).toMatchObject({ state: "ending", attempts: 1 });
    expectOurCode(row, "youtube_token_unreadable");
    expect(sentry.captureError).toHaveBeenCalledTimes(1);
    expect(await w.step({ at: t0 + 1 * MIN })).toEqual({ ...ZERO, ended: 1 });
  });

  it("broadcastLife 'revoked' (YouTube removed the broadcast by administrator action: NOT a lost grant) → the row is finalized FAILED 'broadcast_revoked' with no call after the life read, the connection stays connected, its key is free, and the next Go live on the channel is not refused", async () => {
    const w = await world({ fixtures: 2, credits: 2 });
    const [fa, fb] = w.fixtures as [string, string];
    const m = await playAndStop(w, fa);
    w.fake.revokeBroadcast(m.ytId);
    const t0 = afterStop(m, min(6));
    const before = w.fake.calls.length;
    expect(await w.step({ at: t0 }), "settled, not a failure to retry").toEqual({ ...ZERO, neverLive: 1 });
    const asked = w.fake.calls.slice(before).map((c) => c.method);
    expect(asked, "the life was read").toContain("broadcastLife");
    expect(asked.slice(asked.lastIndexOf("broadcastLife") + 1), "nothing is asked after the life read: no complete, no delete").toEqual([]);
    const row = await broadcastRow(m.broadcastId);
    expect(row).toMatchObject({ state: "failed", attempts: 0, next_attempt_at: null, actual_start_at: null, actual_end_at: null });
    expectOurCode(row, "broadcast_revoked");
    expect(await connectionStatus(w.connectionId), "the club's grant is fine: no reconnect prompt").toBe("connected");
    expect(await streamUrlOf(fa), "a removed broadcast has no replay").toBeNull();
    expect(await w.step({ at: t0 + 10 * MIN }), "a settled row is not a candidate again").toEqual(ZERO);
    // The channel is usable: Go live on another fixture is admitted, on the freed key (0 insertStream).
    const next = await goLive(w, fb);
    expect(w.issued, "A's key was free: B grew no stream").toHaveLength(1);
    expect((await sessionRow(next.sessionId)).youtube_broadcast_id).not.toBe(m.broadcastId);
  });

  it("an EndRuleInvariantError on one broadcast does not stop the pass: it is caught PER broadcast, reported with a code, the row gets backoff and OUR code, and the next broadcast still ends", async () => {
    const w = await world({ fixtures: 2, credits: 2 });
    const [bad, good] = w.fixtures as [string, string];
    const mBad = await playAndStop(w, bad);
    const mGood = await playAndStop(w, good);
    // The terminal session loses its ended_at: the rule's invariant (every terminal entry writes it) is broken. The bad one is the OLDEST.
    await sql`update fixture_stream_sessions set ended_at = null where id = ${mBad.sessionId}`;
    const t0 = afterStop(mGood, min(6));
    const res = await w.step({ at: t0 });
    expect(res, "the good one ended, the bad one counted failed").toEqual({ ...ZERO, ended: 1, failed: 1 });
    const badRow = await broadcastRow(mBad.broadcastId);
    expect(badRow).toMatchObject({ state: "live", attempts: 1 });
    expectOurCode(badRow, "end_rule_invariant");
    expect(badRow.next_attempt_at!.getTime()).toBe(t0 + 1 * MIN);
    expect((await broadcastRow(mGood.broadcastId)).state).toBe("complete");
    expect(sentry.captureError).toHaveBeenCalledTimes(1);
    const [err, ctx] = sentry.captureError.mock.calls[0]!;
    expect(err).toBeInstanceOf(EndRuleInvariantError);
    expect(ctx).toMatchObject({ orgId: w.orgId, extra: { broadcastId: mBad.broadcastId } });
    // Backed off: the next firing does not try it again before its time (and does not report it again).
    sentry.captureError.mockClear();
    expect(await w.step({ at: t0 + 30 * SEC })).toEqual(ZERO);
    expect(sentry.captureError).not.toHaveBeenCalled();
    // Positive pair: stamped again, it ends on the following firing after its backoff.
    await sql`update fixture_stream_sessions set ended_at = ${mBad.endedAt} where id = ${mBad.sessionId}`;
    expect(await w.step({ at: t0 + 1 * MIN })).toEqual({ ...ZERO, ended: 1 });
  });

  it("errorStreamInactive on complete after the video stopped is BOUNDED: failures 1–4 back off; on the 5th the life is re-read and, if the broadcast is gone / complete, it is settled instead of retried forever", async () => {
    type Variant = { name: string; settle(w: World, m: Match): void; expectState: "failed" | "complete" | "ending"; code?: string; counted: Partial<YoutubeEndResult> };
    const variants: Variant[] = [
      { name: "deleted at YouTube meanwhile", settle: (w, m) => w.fake.deleteVideo(m.ytId), expectState: "failed", code: "never_live", counted: { neverLive: 1 } },
      {
        name: "completed at YouTube meanwhile (the answer was lost)", settle: (w, m) => { void m; void w; }, expectState: "complete", counted: { ended: 1 },
      },
      { name: "still live (a real fault): keeps backing off", settle: () => undefined, expectState: "ending", counted: { failed: 1 } },
    ];
    let checked = 0;
    for (const v of variants) {
      const w = await world();
      const m = await playAndStop(w, w.fixtures[0]!);
      let t = afterStop(m, min(6));
      let clock = 0;
      for (let attempt = 1; attempt <= 4; attempt++) {
        w.fake.failNext("complete", "youtube_unavailable", "errorStreamInactive");
        expect(await w.step({ at: t }), `${v.name}: failure ${attempt}`).toEqual({ ...ZERO, failed: 1 });
        const row = await broadcastRow(m.broadcastId);
        expect(row, `${v.name}: failure ${attempt}`).toMatchObject({ state: "ending", attempts: attempt });
        expectOurCode(row, "youtube_unavailable");
        t = row.next_attempt_at!.getTime();
        clock++;
      }
      // The 5th failure: the `complete` call itself changes what YouTube holds (or not), then answers errorStreamInactive again.
      const realComplete = w.fake.complete.bind(w.fake);
      w.fake.complete = async (at, id) => {
        if (v.name.startsWith("completed")) await realComplete(at, id);
        v.settle(w, m);
        throw new YouTubeError("youtube_unavailable", "errorStreamInactive");
      };
      const res = await w.step({ at: t });
      expect(res, `${v.name}: the 5th failure`).toEqual({ ...ZERO, ...v.counted });
      const row = await broadcastRow(m.broadcastId);
      expect(row.state, v.name).toBe(v.expectState);
      if (v.code) expectOurCode(row, v.code);
      if (v.expectState === "ending") {
        expect(row.attempts, v.name).toBe(5);
        expect(row.next_attempt_at!.getTime(), `${v.name}: 16 minutes (2^4), still bounded by the cap`).toBe(t + 16 * MIN);
      }
      if (v.expectState === "complete") {
        expect(row.actual_end_at, `${v.name}: YouTube's own end time`).toBeInstanceOf(Date);
      }
      expect(clock).toBe(4);
      checked++;
    }
    expect(checked).toBe(variants.length);
  });

  it("the budget: wallClock past 15 s after the first row → the rest are counted deferred, not failed; the next firing reaches them", async () => {
    const w = await world({ fixtures: 3, credits: 3 });
    const matches: Match[] = [];
    for (const f of w.fixtures) matches.push(await playAndStop(w, f));
    let clock = 0;
    const realComplete = w.fake.complete.bind(w.fake);
    w.fake.complete = async (at, id) => {
      const r = await realComplete(at, id);
      clock += 16_000;   // the first end took its 16 s
      return r;
    };
    const at = afterStop(matches.at(-1)!, min(6));
    const first = await w.step({ at, wallClock: () => clock, budgetMs: BUDGET_MS });
    expect(first.ended, "the first row was processed").toBe(1);
    expect(first.deferred, "the other two are deferred").toBe(2);
    expect(first.failed, "deferred is not a failure").toBe(0);
    clock = 0;
    const second = await w.step({ at: at + SEC, wallClock: () => 0 });
    expect(second.ended, "the next firing ends the rest").toBe(2);
    expect(second.deferred).toBe(0);
  });

  it("V480's floor: the database itself refuses actual times on a row that is not `complete` (a live one, a failed one), and accepts them on a complete one", async () => {
    const w = await world();
    const m = await playAndStop(w, w.fixtures[0]!);
    const t = new Date(m.endedAt.getTime());
    const write = (id: string) => sql`update youtube_broadcasts set actual_start_at = ${t}, actual_end_at = ${t} where id = ${id}`;
    await expect(write(m.broadcastId), "live").rejects.toMatchObject({ constraint_name: "youtube_broadcasts_actual_times_only_complete" });
    await sql`update youtube_broadcasts set state = 'failed', last_error_code = 'never_live' where id = ${m.broadcastId}`;
    await expect(write(m.broadcastId), "failed").rejects.toMatchObject({ constraint_name: "youtube_broadcasts_actual_times_only_complete" });
    await sql`update youtube_broadcasts set state = 'live', last_error_code = null where id = ${m.broadcastId}`;
    expect(await w.step({ at: afterStop(m, min(6)) })).toEqual({ ...ZERO, ended: 1 });
    await write(m.broadcastId);   // complete: accepted
    expect((await broadcastRow(m.broadcastId)).actual_end_at!.getTime()).toBe(t.getTime());
  });

  it("the LISTING leaves a revoked connection's rows out (not only the claim): they are not counted `deferred` when the budget is already spent, while the same rows on a live connection are", async () => {
    // A budget already gone on the first look makes the listing itself visible: whatever it lists and the loop never reaches is `deferred`.
    const spent = () => { let calls = 0; return () => (calls++ === 0 ? 0 : BUDGET_MS + 1); };
    const counts: number[] = [];
    for (const revoke of [false, true]) {
      const w = await world({ fixtures: 2, credits: 2 });
      const ms: Match[] = [];
      for (const f of w.fixtures) ms.push(await playAndStop(w, f));
      if (revoke) await revokeConnection(sql, w.orgId, w.connectionId);
      for (const m of ms) expect((await broadcastRow(m.broadcastId)).state, "premise: the rows are still open").toBe("live");
      const res = await w.step({ at: afterStop(ms.at(-1)!, min(6)), wallClock: spent() });
      expect(res.ended + res.failed, "the budget was spent before any row was started").toBe(0);
      counts.push(res.deferred);
    }
    expect(counts, "live connection: both rows listed and deferred; revoked connection: neither is listed").toEqual([2, 0]);
  });

  it("orgIds scopes the pass: with two orgs due, [A] ends only A's and leaves B's untouched; [A, B] ends both", async () => {
    const a = await world();
    const b = await world();
    const ma = await playAndStop(a, a.fixtures[0]!);
    const mb = await playAndStop(b, b.fixtures[0]!);
    const at = Math.max(afterStop(ma, min(6)), afterStop(mb, min(6)));
    a.setNow(at);
    b.setNow(at);
    expect(await endDueBroadcasts(a.fake, { now: () => new Date(at), budgetMs: BUDGET_MS, orgIds: [a.orgId] })).toEqual({ ...ZERO, ended: 1 });
    expect((await broadcastRow(ma.broadcastId)).state).toBe("complete");
    expect((await broadcastRow(mb.broadcastId)).state, "the other org's row was not touched").toBe("live");
    // Each org's broadcasts live on its own fake, so B's pass runs on B's.
    expect(await endDueBroadcasts(b.fake, { now: () => new Date(at), budgetMs: BUDGET_MS, orgIds: [a.orgId, b.orgId] })).toEqual({ ...ZERO, ended: 1 });
    expect((await broadcastRow(mb.broadcastId)).state).toBe("complete");
  });

  it("RF3: the fixture is switched to a pasted key inside the grace and a pasted session is LIVE — the API broadcast still ends at Stop + 5", async () => {
    const w = await world({ credits: 2 });
    const f = w.fixtures[0]!;
    const m = await playAndStop(w, f);
    w.tick(2 * MIN);
    const pasted = await createStreamTarget(w.auth, w.orgId, { kind: "youtube", label: "Pasted", streamKey: `pasted-${randomUUID()}` });
    const live = await goLive(w, f, "passthrough", pasted.id);
    expect((await sessionRow(live.sessionId)).youtube_broadcast_id, "premise: a pasted session carries no broadcast").toBeNull();
    expect(["warming", "live"]).toContain((await sessionRow(live.sessionId)).state);

    expect(await w.step({ at: afterStop(m, min(GRACE_MINUTES) - SEC) })).toEqual(ZERO);
    expect(await w.step({ at: afterStop(m, min(GRACE_MINUTES)) }), "the pasted session does not hold the API broadcast open").toEqual({ ...ZERO, ended: 1 });
    expect((await broadcastRow(m.broadcastId)).state).toBe("complete");
    expect(["warming", "live"], "and the pasted session itself is untouched").toContain((await sessionRow(live.sessionId)).state);
  });

  // ═══ D15: the actual times ═════════════════════════════════════════════════════════════════════════════════════════
  it("actual_start_at / actual_end_at: set on a complete row from YouTube's scripted times; NULL while live, on a failed (never-live) row, and when YouTube does not say — the broadcast still ends", async () => {
    const w = await world({ fixtures: 3, credits: 3 });
    const [f1, f2, f3] = w.fixtures as [string, string, string];
    // (1) a normal end
    const m1 = await playAndStop(w, f1);
    const live1 = await broadcastRow(m1.broadcastId);
    expect([live1.actual_start_at, live1.actual_end_at], "null while live").toEqual([null, null]);
    expect(await w.step({ at: afterStop(m1, min(6)) })).toMatchObject({ ended: 1 });
    const done1 = await broadcastRow(m1.broadcastId);
    expect(done1.actual_start_at!.getTime()).toBe(m1.startedAtMs);
    expect(done1.actual_end_at!.getTime()).toBe(afterStop(m1, min(6)));
    // (2) never live
    const { sessionId } = await goLive(w, f2);
    await reachLive(w, f2, sessionId, "passthrough");
    await stopToEnd(w, f2, sessionId, "passthrough");
    const S2 = (await sessionRow(sessionId)).ended_at!.getTime();
    expect(await w.step({ at: S2 + min(6) })).toMatchObject({ neverLive: 1 });
    const failed = await broadcastRow((await sessionRow(sessionId)).youtube_broadcast_id!);
    expect([failed.state, failed.actual_start_at, failed.actual_end_at], "null on a failed row").toEqual(["failed", null, null]);
    // (3) YouTube says no times
    const m3 = await playAndStop(w, f3);
    const lifeReal = w.fake.broadcastLife.bind(w.fake);
    w.fake.broadcastLife = async (at, id) => ({ ...(await lifeReal(at, id)), actualStartAt: null, actualEndAt: null });
    expect(await w.step({ at: afterStop(m3, min(6)) })).toMatchObject({ ended: 1 });
    expect(await broadcastRow(m3.broadcastId)).toMatchObject({ state: "complete", actual_start_at: null, actual_end_at: null });
  });

  // ═══ key freeing, end to end ═══════════════════════════════════════════════════════════════════════════════════════
  for (const mode of ["passthrough", "composed"] as const) {   // B4 batch forward: both modes
    it(`${mode}: key freeing end to end — Go live A → Stop → the step past due → complete → Go live C on a DIFFERENT fixture takes A's key with 0 insertStream, and its output carries that key`, async () => {
      const w = await world({ fixtures: 3, credits: 3 });
      const [fa, fb, fc] = w.fixtures as [string, string, string];
      const a = await playAndStop(w, fa, mode);
      expect(w.issued, "premise: one key issued for A").toHaveLength(1);
      // While A still holds the key (not yet ended), a second Go live must NOT take it: a second stream is grown.
      const held = await goLive(w, fb, mode);
      expect(w.issued, "A's broadcast is open, so its key is held: B grew its own").toHaveLength(2);
      await reachLive(w, fb, held.sessionId, mode);
      await stopToEnd(w, fb, held.sessionId, mode);
      // Now end A (and B, which is due too) with the step, then go live on the THIRD fixture: it re-uses A's key.
      const stepAt = Math.max(afterStop(a, min(6)), (await sessionRow(held.sessionId)).ended_at!.getTime() + min(6));
      expect(await w.step({ at: stepAt })).toEqual({ ...ZERO, ended: 1, neverLive: 1 });   // A ran (video on); B's video never arrived
      expect((await broadcastRow(a.broadcastId)).state).toBe("complete");
      const streams = w.issued.length;
      const c = await goLive(w, fc, mode);   // another fixture: it takes the lowest free key — A's
      expect(w.issued, "no stream was inserted: a freed key was reused").toHaveLength(streams);
      const cs = await sessionRow(c.sessionId);
      const onFixture = (await sql<{ fixture_id: string }[]>`select fixture_id from fixture_stream_sessions where id = ${c.sessionId}`)[0]!.fixture_id;
      expect(onFixture, "premise: the final Go live is on a different fixture from A and B").toBe(fc);
      expect(cs.youtube_broadcast_id).not.toBe(a.broadcastId);
      expect(fp(w.outputs.at(-1)!.target), "the output carries the first (lowest-slot) key, freed by the end step").toBe(fp(w.issued[0]!));
    });
  }

  it("key freeing reaches ANOTHER FIXTURE: A ends via the step, then Go live on fixture B takes A's key (issued stays 1); and a claimed `ending` key is freed once the step finalizes it", async () => {
    const w = await world({ fixtures: 3, credits: 3 });
    const [fa, fb, fc] = w.fixtures as [string, string, string];
    const a = await playAndStop(w, fa);
    expect(await w.step({ at: afterStop(a, min(6)) })).toMatchObject({ ended: 1 });
    const b = await goLive(w, fb);
    expect(w.issued, "B took A's key: 0 insertStream").toHaveLength(1);
    expect(fp(w.outputs.at(-1)!.target)).toBe(fp(w.issued[0]!));
    await reachLive(w, fb, b.sessionId, "passthrough");
    await stopToEnd(w, fb, b.sessionId, "passthrough");

    // A key held by a CLAIMED row: C's Go live after Stop + 6 claims C's old broadcast (prepare, P7) and needs a new key.
    const bEnded = (await sessionRow(b.sessionId)).ended_at!.getTime();
    w.setNow(bEnded + min(6));
    const claimedBy = await broadcastRow((await sessionRow(b.sessionId)).youtube_broadcast_id!);
    const again = await goLive(w, fb);   // fixture B again: its old broadcast is due → claimed ending; a new key is grown
    expect((await broadcastRow(claimedBy.id)).state, "premise: prepare claimed the due row").toBe("ending");
    expect(w.issued, "the claimed row still holds the key").toHaveLength(2);
    // The step finalizes the claimed row (a crash-retry / prepare claim: no lease), freeing the key.
    expect(await w.step({ at: w.now() + SEC })).toMatchObject({ neverLive: 1 });   // its video never arrived
    expect((await broadcastRow(claimedBy.id)).state).toBe("failed");
    await stopToEnd(w, fb, again.sessionId, "passthrough");
    const streams = w.issued.length;
    await goLive(w, fc);
    expect(w.issued, "the freed key is taken again").toHaveLength(streams);
  });

  for (const mode of ["passthrough", "composed"] as const) it(`${mode}: an output that could not be released keeps the key HELD even though its broadcast is complete (freeKey's unreleased-output clause, through the real Stop and the real end step); once released — by the retry the same fixture's next Go live runs — the key is taken again`, async () => {
    const w = await world({ fixtures: 2, credits: 3 });
    const [fa, fb] = w.fixtures as [string, string];
    w.breakRelease.on = true;
    const a = await playAndStop(w, fa, mode);   // the Stop's release fails: reported, the output stays on its input
    const out = (await sql<{ output_uid: string | null; output_released_at: Date | null }[]>`select output_uid, output_released_at from fixture_stream_sessions where id = ${a.sessionId}`)[0]!;
    expect(out.output_uid, "premise: an output was added").not.toBeNull();
    expect(out.output_released_at, "premise: and not released").toBeNull();
    expect(await w.step({ at: afterStop(a, min(6)) })).toMatchObject({ ended: 1 });
    expect((await broadcastRow(a.broadcastId)).state, "premise: the broadcast is complete").toBe("complete");

    // Another fixture, same channel: A's broadcast is complete, but its output may still be publishing to the key.
    const b = await goLive(w, fb, mode);
    expect(w.issued, "A's key is still being published to: B must grow its own").toHaveLength(2);
    expect(fp(w.outputs.at(-1)!.target)).toBe(fp(w.issued[1]!));
    await stopToEnd(w, fb, b.sessionId, mode);

    // Cloudflare answers again. The retry owner for an API key's unreleased output is the SAME fixture's next admission
    // (releasePriorOutputs; the daily sweep is the other): A goes live again, releases its old output, and takes the freed key.
    w.breakRelease.on = false;
    await goLive(w, fa, mode);
    expect((await sql<{ output_released_at: Date | null }[]>`select output_released_at from fixture_stream_sessions where id = ${a.sessionId}`)[0]!.output_released_at, "premise: released at that admission").not.toBeNull();
    expect(w.issued, "A's old output was released, so its freed key was taken: 0 insertStream").toHaveLength(2);
    expect(fp(w.outputs.at(-1)!.target)).toBe(fp(w.issued[0]!));
  });
});
