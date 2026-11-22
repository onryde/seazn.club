// Seazn-hosted video, Phase 1 Task 15: WHICH player the public match page mounts for a fixture (`seaznVideoPlan`): the Seazn island, or
// the page's YouTube / link slot exactly as it was. Decided from the fixture's OWN facts, in this order (controller ruling 2026-11-20 and
// the plan's three arms):
//   1. any session of the fixture with destination_kind = 'seazn' -> seazn, WHATEVER the LIVE flag is (LIVE gates new Seazn streams,
//      never playback of one that exists);
//   2. any other session, or a fixture that is over -> external (a fixture that has streamed elsewhere, or is decided, can never flip
//      to Seazn because the org's default pick changed under it: the blocker's regression);
//   3. no session and not over -> seazn only when LIVE is on and the fixture's resolved target (the saved choice, else the org's
//      default) is a `seazn` row; with LIVE off, external.
//
// Every session comes from a REAL producer (the organiser's Go live, `createSession`, and Stop), the saved choice from the real
// writer (`saveStreamSettings`), the default from the real resolver (`fixtureStreamTarget`, asserted as a premise wherever a case
// relies on it). Only the fixture's STATUS is set by hand: it is the input the plan reads, and the scorer that writes it is not
// under test. Expected answers for the status sweep come from the match page's own vocabulary (`streamLinkLabelKey`: scheduled and
// in_play are the pre-match/live bucket), never retyped here.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the plan reads no sport rule; every rig rides `generic`.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
// The REAL resolver, wrapped so a case can see whether the plan asked it (the LIVE-off short cut is invisible in the answer: the resolver
// hides the Seazn row under LIVE off too, so two guards give one answer and neither would be tested alone).
vi.mock("@/server/usecases/stream-codes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/stream-codes")>();
  return { ...actual, fixtureStreamTarget: vi.fn(actual.fixtureStreamTarget) };
});

import { sql } from "@/lib/db";
import { FIXTURE_STATUSES } from "@/lib/fixture-status";
import { fixtureStreamTarget, saveStreamSettings } from "@/server/usecases/stream-codes";
import { streamLinkLabelKey } from "../../../app/(public)/live/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/stream-link";
import { CODE_GRACE_AFTER_FINISH_MINUTES, DELETE_RECORDING_AFTER_DAYS, FINALISATION_GRACE_SECONDS, MAX_ANCHOR_DRIFT_SECONDS, MAX_DURATION_MINUTES, tunable } from "@/server/relay/config";
import { ACTIVE_STATES, TERMINAL_STATES, type SessionState } from "@/server/relay/domain/session";
import { codeStatus } from "@/server/relay/domain/stream-code";
import { stopSession } from "@/server/usecases/stream-sessions";
import { createPlaybackTokenCache } from "../cf-playback";
import { seaznFixtureVideo, seaznReplayPartNos } from "../seazn-video";
import { seaznVideoPlan } from "../seazn-video-plan";
import { type SeaznRig as Rig, goLive, installSeaznEnv, kindOf, live, seaznRig as rig, seedLockedRecording, stateOf, stopAndSettle } from "./_seazn-session-rig";

const HAS_DB = !!process.env.DATABASE_URL;
installSeaznEnv("seazn-video-plan-test");
const liveOff = () => vi.stubEnv("SEAZN_HOSTED_LIVE", "false");

const setStatus = (fixtureId: string, status: string) => sql`update fixtures set status = ${status} where id = ${fixtureId}`;
/** Which player the plan picks (its `settledAt` is the review-I2 cases' own). */
const playerOf = async (fixtureId: string) => (await seaznVideoPlan(fixtureId)).player;
const settledAtOf = async (fixtureId: string) => {
  const plan = await seaznVideoPlan(fixtureId);
  if (plan.player !== "seazn") throw new Error(`PREMISE: the plan is seazn, not ${plan.player}`);
  return plan.settledAt;
};
/** The page's poll hints (Phase 1 re-review N1): the kick-off, and until when the fixture counts as active. */
const hintsOf = async (fixtureId: string, now: Date) => {
  const plan = await seaznVideoPlan(fixtureId, now);
  if (plan.player !== "seazn") throw new Error(`PREMISE: the plan is seazn, not ${plan.player}`);
  return { kickoffAt: plan.kickoffAt?.toISOString() ?? null, activeUntil: plan.activeUntil?.toISOString() ?? null };
};
const setKickoff = (fixtureId: string, at: Date | null) => sql`update fixtures set scheduled_at = ${at} where id = ${fixtureId}`;
/** Whether the page holds the player's box before the first read (Phase 1 visual D1). */
const reserveOf = async (fixtureId: string) => {
  const plan = await seaznVideoPlan(fixtureId);
  if (plan.player !== "seazn") throw new Error(`PREMISE: the plan is seazn, not ${plan.player}`);
  return plan.reserve;
};
const setFinished = (fixtureId: string, at: Date | null) => sql`update fixtures set finished_at = ${at} where id = ${fixtureId}`;
/** The default the fixture would stream to, read the way the panel and the phone read it: the resolver's pick. */
const defaultPick = async (r: Rig, fixtureId: string) => (await fixtureStreamTarget(sql, { orgId: r.auth.orgId, fixtureId }))?.id ?? null;

describe.skipIf(!HAS_DB)("seaznVideoPlan: which player the match page mounts", () => {
  it("EMPTY CASE FIRST: an id that is not a uuid, and a fixture that does not exist, are external, and a malformed id never reaches the query (a 22P02 would throw)", async () => {
    expect(await playerOf("f1")).toBe("external");
    expect(await playerOf("")).toBe("external");
    expect(await playerOf("not-a-uuid'; drop table fixtures; --")).toBe("external");
    expect(await playerOf(randomUUID()), "a well-formed id that names nothing").toBe("external");
  });

  it("a fixture with a Seazn session is seazn WHATEVER LIVE is: while the session is live, and once it has ended and the fixture is decided", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.seazn);
    expect(await kindOf(sid), "PREMISE: the producer wrote the destination kind").toBe("seazn");
    expect(await playerOf(f), "LIVE on, session live").toBe("seazn");
    liveOff();
    expect(await playerOf(f), "LIVE OFF, session live (the ruling)").toBe("seazn");
    vi.stubEnv("SEAZN_HOSTED_LIVE", "true");
    await stopAndSettle(r, f, sid);
    await setStatus(f, "decided");
    expect(await playerOf(f), "LIVE on, ended and decided").toBe("seazn");
    liveOff();
    expect(await playerOf(f), "LIVE OFF, ended and decided (the ruling: a Seazn fixture keeps its player)").toBe("seazn");
  });

  it("a Seazn session wins over a later YouTube session on the same fixture (any Seazn session, not the latest)", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const first = await live(r, f, r.seazn);
    await stopAndSettle(r, f, first);
    const second = await live(r, f, r.pasted);
    expect(await kindOf(second), "PREMISE: the later session is external").not.toBe("seazn");
    expect(await playerOf(f)).toBe("seazn");
  });

  it("a fixture with one Seazn session stays seazn after the org's default moves (LIVE off) and after a saved YouTube pick", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.seazn);
    await stopAndSettle(r, f, sid);
    expect(await defaultPick(r, f), "PREMISE: the org's default is Seazn").toBe(r.seazn);
    liveOff();
    expect(await defaultPick(r, f), "PREMISE: with LIVE off the Seazn row is hidden from the resolver").not.toBe(r.seazn);
    expect(await playerOf(f)).toBe("seazn");
    vi.stubEnv("SEAZN_HOSTED_LIVE", "true");
    await saveStreamSettings(r.auth, f, { targetId: r.pasted });
    expect(await playerOf(f), "the organiser later picks YouTube for this match").toBe("seazn");
  });

  it("a PAST YouTube fixture with no saved choice stays external though the org's default now resolves Seazn (the blocker's regression), by its session and by its decided status each on its own", async () => {
    const r = await rig();
    // By its session: it streamed to YouTube and is still open (not decided), so only the session arm can answer.
    const bySession = r.fixtureIds[0];
    const sid = await live(r, bySession, r.pasted);
    await stopAndSettle(r, bySession, sid);
    expect(await kindOf(sid), "PREMISE: a YouTube session").not.toBe("seazn");
    // The organiser's Go live saved its pick; the fixture this case is about has NO saved choice (a phone start, an auto start, a
    // session from before picks were stored), which is the row a Stop stamp or the auto switch leaves: it has chosen nothing.
    await sql`update fixture_stream_settings set target_chosen = false where fixture_id = ${bySession}`;
    expect(await defaultPick(r, bySession), "PREMISE: its default pick is now Seazn").toBe(r.seazn);
    expect((await sql<{ status: string }[]>`select status from fixtures where id = ${bySession}`)[0]!.status, "PREMISE: still open").toBe("scheduled");
    expect(await playerOf(bySession), "the session arm").toBe("external");
    // By its status: decided with no session at all (a result entered by hand), so only the status arm can answer.
    const byStatus = r.fixtureIds[1];
    await setStatus(byStatus, "decided");
    expect(await defaultPick(r, byStatus), "PREMISE: its default pick is Seazn too").toBe(r.seazn);
    expect(await playerOf(byStatus), "the decided arm").toBe("external");
  });

  // Phase 1 visual D1: the box is held where a player is expected now — a fixture with a Seazn session (its live, or its recording) —
  // and NOT before kick-off, where "nothing yet" is the expected answer for hours and a held box would collapse on every load.
  it("review D1: EMPTY CASE FIRST — an unstarted Seazn fixture reserves no box; once it has a Seazn session it does, live and after it is decided", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    expect(await playerOf(f), "PREMISE: the unstarted arm").toBe("seazn");
    expect(await reserveOf(f), "before kick-off: no box").toBe(false);
    const sid = await live(r, f, r.seazn);
    expect(await reserveOf(f), "live on Seazn").toBe(true);
    await stopAndSettle(r, f, sid);
    await setStatus(f, "decided");
    expect(await reserveOf(f), "decided, its recording to play").toBe(true);
    liveOff();
    expect(await reserveOf(f), "LIVE off: the session's player and its box both stay").toBe(true);
  });

  // Phase 1 re-review N1: the island holds its 30 s floor while the match is hot. The plan hands it the kick-off (the island checks the
  // hour either side of it on the viewer's clock) and, when the fixture is in play or a Seazn session of it is not terminal as the page
  // is drawn, an "active until" bound: the drawing instant + MAX_DURATION_MINUTES, the longest a session runs (relay config), so a page
  // left open does not hold the floor for ever.
  it("review N1: EMPTY CASE FIRST — an unstarted fixture with no kick-off time and nothing happening has neither hint; its kick-off, once set, is handed over as is", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const now = new Date("2026-11-22T12:00:00.000Z");
    await setKickoff(f, null);
    expect(await hintsOf(f, now)).toEqual({ kickoffAt: null, activeUntil: null });
    const kickoff = new Date("2026-11-22T12:20:00.000Z");
    await setKickoff(f, kickoff);
    expect(await hintsOf(f, now)).toEqual({ kickoffAt: kickoff.toISOString(), activeUntil: null });
  });

  it("review N1: in play, or a Seazn session warming or live, is active until the drawing instant + MAX_DURATION_MINUTES; ended and decided is not", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const now = new Date("2026-11-22T12:00:00.000Z");
    const bound = new Date(now.getTime() + MAX_DURATION_MINUTES * 60_000).toISOString();
    await setStatus(f, "in_play");
    expect((await hintsOf(f, now)).activeUntil, "in play, no session (the unstarted arm)").toBe(bound);
    await setStatus(f, "scheduled");
    expect((await hintsOf(f, now)).activeUntil, "PREMISE: scheduled, no session: not active").toBeNull();
    const sid = await goLive(r, f, r.seazn);
    expect(await stateOf(sid), "PREMISE: the session is not live yet").not.toBe("live");
    expect((await hintsOf(f, now)).activeUntil, "a Seazn session on its way up (the session arm)").toBe(bound);
    await stopAndSettle(r, f, sid);
    expect((await hintsOf(f, now)).activeUntil, "its session ended, the match not in play: not active").toBeNull();
    const sid2 = await live(r, f, r.seazn);
    expect((await hintsOf(f, now)).activeUntil, "a second session, live").toBe(bound);
    await stopAndSettle(r, f, sid2);
    await setStatus(f, "decided");
    expect((await hintsOf(f, now)).activeUntil, "ended and decided").toBeNull();
  });

  it("an UNSTARTED fixture (no session, not over): seazn when its default is Seazn and LIVE is on; external with LIVE off, where the default is the pasted key", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    expect(await defaultPick(r, f), "PREMISE: LIVE on, the default is Seazn").toBe(r.seazn);
    expect(await playerOf(f)).toBe("seazn");
    liveOff();
    expect(await defaultPick(r, f), "PREMISE: LIVE off, the default is the pasted key").toBe(r.pasted);
    expect(await playerOf(f)).toBe("external");
  });

  it("an unstarted fixture follows its SAVED choice over the default: YouTube -> external, Seazn -> seazn, and a cleared choice (nothing to stream to) -> external", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    await saveStreamSettings(r.auth, f, { targetId: r.pasted });
    expect(await defaultPick(r, f), "PREMISE: the saved pick is the pasted key").toBe(r.pasted);
    expect(await playerOf(f)).toBe("external");
    await saveStreamSettings(r.auth, f, { targetId: r.seazn });
    expect(await playerOf(f)).toBe("seazn");
    await saveStreamSettings(r.auth, f, { targetId: null });
    expect(await defaultPick(r, f), "PREMISE: the organiser cleared the choice: nothing resolves").toBeNull();
    expect(await playerOf(f)).toBe("external");
  });

  it("LIVE off short-circuits: the resolver is not asked for an unstarted fixture; with LIVE on it is asked once, for this org and fixture", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const resolver = vi.mocked(fixtureStreamTarget);
    liveOff();
    resolver.mockClear();
    expect(await playerOf(f)).toBe("external");
    expect(resolver, "LIVE off: nothing is asked of the resolver (every page view of an unstarted match would pay for it)").not.toHaveBeenCalled();
    vi.stubEnv("SEAZN_HOSTED_LIVE", "true");
    resolver.mockClear();
    expect(await playerOf(f)).toBe("seazn");
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0]![1], "for this fixture's org").toEqual({ orgId: r.auth.orgId, fixtureId: f });
  });

  it("a fixture with a session never asks the resolver either (its own facts decide)", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.pasted);
    await stopAndSettle(r, f, sid);
    const resolver = vi.mocked(fixtureStreamTarget);
    resolver.mockClear();
    expect(await playerOf(f)).toBe("external");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("an org with no destination at all is external (nothing resolves)", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    await sql`update org_stream_targets set archived_at = now() where org_id = ${r.auth.orgId}`;
    expect(await defaultPick(r, f), "PREMISE: nothing resolves").toBeNull();
    expect(await playerOf(f)).toBe("external");
  });

  it("SWEEP every fixture status on an unstarted fixture whose default is Seazn: only the pre-match/live bucket is seazn (expected from the page's own vocabulary)", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    expect(await defaultPick(r, f), "PREMISE: the default is Seazn").toBe(r.seazn);
    let seazn = 0;
    let external = 0;
    for (const status of FIXTURE_STATUSES) {
      await setStatus(f, status);
      const expected = streamLinkLabelKey(status) === "overlay.watchLive" ? "seazn" : "external";
      expect(await playerOf(f), `status ${status}`).toBe(expected);
      if (expected === "seazn") seazn++;
      else external++;
    }
    expect(seazn + external, "anti-vacuity: every status was checked").toBe(FIXTURE_STATUSES.length);
    expect(seazn, "and the sweep saw both answers").toBeGreaterThan(0);
    expect(external).toBeGreaterThan(0);
  });

  // Phase 1 review I2: the island stops reading an empty answer once the fixture is SETTLED, which the plan says. Expected from the
  // stream code's OWN expiry rule (`codeStatus`, at the grace the code's expiry reads), never from a constant retyped here: settled is
  // the first instant a finished fixture's code is due to expire, so no new Go live can start on it.
  it("review I2: a Seazn fixture that is over and finished is settled at the instant its stream code falls due — not a ms before", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.seazn);
    await stopAndSettle(r, f, sid);
    const finishedAt = new Date("2026-11-21T15:00:00.000Z");
    await setStatus(f, "decided");
    await setFinished(f, finishedAt);
    const settledAt = await settledAtOf(f);
    expect(settledAt).toBeInstanceOf(Date);
    // The grace exactly as the code's expiry reads it (stream-sessions/start.ts, stream-codes.ts).
    const grace = tunable("CODE_GRACE_AFTER_FINISH_MINUTES", CODE_GRACE_AFTER_FINISH_MINUTES);
    const code = (at: number) => codeStatus({ endedAt: null, finishedAt }, new Date(at), false, grace);
    expect(code(settledAt!.getTime() - 1), "a ms before: the code still serves (a Go live could still start)").toBe("finishing");
    expect(code(settledAt!.getTime()), "at it: the code is due to expire").toBe("expiry_due");
  });

  it("review I2: the grace is the code's own TUNABLE one (a walkthrough's shortened grace moves the settle with it)", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.seazn);
    await stopAndSettle(r, f, sid);
    const finishedAt = new Date("2026-11-21T15:00:00.000Z");
    await setStatus(f, "decided");
    await setFinished(f, finishedAt);
    vi.stubEnv("ENV_NAME", "ci");
    vi.stubEnv("CODE_GRACE_AFTER_FINISH_MINUTES", "7");
    expect((await settledAtOf(f))?.toISOString()).toBe("2026-11-21T15:07:00.000Z");
  });

  it("review I2: EMPTY CASE FIRST — not settled (null) while the fixture is not over (the database keeps no finish time for it), then settled once decided; an unstarted fixture's island is never settled", async () => {
    const r = await rig();
    const [f, g] = r.fixtureIds;
    const finishedOf = async () => (await sql<{ finished_at: Date | null }[]>`select finished_at from fixtures where id = ${f}`)[0]!.finished_at;
    const sid = await live(r, f, r.seazn);
    expect(await settledAtOf(f), "live, before any result").toBeNull();
    await stopAndSettle(r, f, sid);
    await setStatus(f, "in_play");
    expect(await finishedOf(), "PREMISE: in play has no finish time (fixtures_track_finished)").toBeNull();
    expect(await settledAtOf(f), "in play").toBeNull();
    await setStatus(f, "decided");
    expect(await finishedOf(), "PREMISE: deciding it stamps the finish").toBeInstanceOf(Date);
    expect(await settledAtOf(f), "decided: settled").toBeInstanceOf(Date);
    expect(await defaultPick(r, g), "PREMISE: the second fixture's default is Seazn").toBe(r.seazn);
    expect(await settledAtOf(g), "arm 3: unstarted").toBeNull();
  });

  it("review I2: SWEEP every fixture status on a Seazn fixture, from in play — settled exactly for the statuses the page calls over", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.seazn);
    await stopAndSettle(r, f, sid);
    let settled = 0;
    let open = 0;
    for (const status of FIXTURE_STATUSES) {
      // Each status entered from in play, as a result enters it (the trigger stamps a finish on that transition alone).
      await setStatus(f, "in_play");
      await setStatus(f, status);
      const over = streamLinkLabelKey(status) !== "overlay.watchLive";
      expect((await settledAtOf(f)) !== null, `status ${status}`).toBe(over);
      if (over) settled++;
      else open++;
    }
    expect(settled + open, "anti-vacuity: every status was checked").toBe(FIXTURE_STATUSES.length);
    expect(settled).toBeGreaterThan(0);
    expect(open).toBeGreaterThan(0);
  });
});

// Phase 1 visual re-capture R2 (a warming session made the page shift 0.0856): the island holds its box through a WAIT, and the page
// says whether one is on as it is drawn (`holdUntil`). A wait is on while the fixture's LATEST session (the route's own definition of
// "the session": `seazn-video.ts` reads the latest by creation) is a Seazn session that is not yet live (requested through ending: the
// whole ladder is bounded by MAX_ANCHOR_DRIFT_SECONDS) or that COMPLETED a moment ago (its recording can still be locked for
// FINALISATION_GRACE_SECONDS after the end: the tick's Seazn pass waits out that same grace). A live session has none (its answer is
// the player), a failed one has none (it never recorded), and a later session of another kind ends it.
describe.skipIf(!HAS_DB)("seaznVideoPlan: the wait the island holds its box through (re-capture R2)", () => {
  const N = new Date("2026-11-22T12:00:00.000Z");
  const seazn = async (fixtureId: string, now: Date = N) => {
    const plan = await seaznVideoPlan(fixtureId, now);
    if (plan.player !== "seazn") throw new Error(`PREMISE: the plan is seazn, not ${plan.player}`);
    return plan;
  };
  const holdOf = async (fixtureId: string, now: Date = N) => (await seazn(fixtureId, now)).holdUntil?.toISOString() ?? null;
  const at = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000).toISOString();
  const endedAt = (sid: string, when: Date) => sql`update fixture_stream_sessions set ended_at = ${when} where id = ${sid}`;
  const LADDER = at(N, MAX_ANCHOR_DRIFT_SECONDS);

  it("EMPTY CASE FIRST: an unstarted Seazn fixture (arm 3) has no wait", async () => {
    const r = await rig();
    expect(await holdOf(r.fixtureIds[0])).toBeNull();
  });

  it("a session on its way up (warming) holds the box for the whole ladder to live, counted from the render", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await goLive(r, f, r.seazn);
    expect(await stateOf(sid), "PREMISE: before the playing beat, warming").toBe("warming");
    expect(await holdOf(f), "warming").toBe(LADDER);
    expect(await holdOf(f, new Date(N.getTime() + 120_000)), "the render's own instant, not the session's").toBe(at(new Date(N.getTime() + 120_000), MAX_ANCHOR_DRIFT_SECONDS));
  });

  it("every state of the latest Seazn session, from the session domain's own lists: not-yet-live and ending hold the ladder, completed holds the lock window, live and failed hold none", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await goLive(r, f, r.seazn);
    const ended = new Date(N.getTime() - 60_000);
    let checked = 0;
    for (const state of [...ACTIVE_STATES, ...TERMINAL_STATES] as SessionState[]) {
      // The state is set by hand: each one is the plan's INPUT, and the producers that write them are other tasks' tests.
      await sql`update fixture_stream_sessions set state = ${state}, ended_at = ${TERMINAL_STATES.includes(state) ? ended : null} where id = ${sid}`.catch((e: unknown) => {
        throw new Error(`PREMISE: could not set state ${state}: ${(e as Error).message}`);
      });
      const expected =
        state === "live" || state === "failed" ? null
        : state === "completed" ? at(ended, FINALISATION_GRACE_SECONDS)
        : LADDER;
      expect(await holdOf(f), `state ${state}`).toBe(expected);
      checked++;
    }
    expect(checked, "anti-vacuity: every state was checked").toBe(ACTIVE_STATES.length + TERMINAL_STATES.length);
    expect(checked).toBeGreaterThanOrEqual(7);
  });

  it("just stopped: the wait is the recording's lock window from the END — to the ms: a ms before it closes held, at it gone; a session with no end stamp counts from its creation", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.seazn);
    await stopAndSettle(r, f, sid);
    const ended = new Date("2026-11-22T11:50:00.000Z");
    await endedAt(sid, ended);
    const closes = at(ended, FINALISATION_GRACE_SECONDS);
    expect(await holdOf(f, new Date(ended.getTime() + 60_000)), "a minute after the Stop").toBe(closes);
    expect(await holdOf(f, new Date(Date.parse(closes) - 1)), "a ms before the window closes").toBe(closes);
    expect(await holdOf(f, new Date(closes)), "at the instant it closes: nothing is waited for").toBeNull();
    expect(await holdOf(f, new Date(Date.parse(closes) + 1)), "after it").toBeNull();
    await sql`update fixture_stream_sessions set ended_at = null, created_at = ${new Date(N.getTime() - 60_000)} where id = ${sid}`;
    expect(await holdOf(f), "no end stamp: counted from the session's creation, a minute ago").toBe(at(new Date(N.getTime() - 60_000), FINALISATION_GRACE_SECONDS));
  });

  it("the REAL Stop: a session just stopped (ending, then completed) holds the box; the same fixture decided long ago does not", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.seazn);
    await stopSession(r.auth, f, sid, r.deps);
    expect(await stateOf(sid), "PREMISE: ending").toBe("ending");
    expect(await holdOf(f), "ending").toBe(LADDER);
    await stopAndSettle(r, f, sid);
    const soon = new Date(Date.now() + 30_000);
    expect((await seazn(f, soon)).holdUntil, "completed a moment ago").toBeInstanceOf(Date);
    const later = new Date(Date.now() + (FINALISATION_GRACE_SECONDS + 60) * 1000);
    expect((await seazn(f, later)).holdUntil, "the lock window has closed: nothing to wait for").toBeNull();
  });

  it("only the LATEST session counts: an earlier Seazn one just stopped is not waited for once a YouTube one follows; a live Seazn one after a stopped one has none; a warming one after one holds the ladder again", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const first = await live(r, f, r.seazn);
    await stopAndSettle(r, f, first);
    await endedAt(first, new Date(N.getTime() - 30_000));
    expect(await holdOf(f), "PREMISE: the first, just stopped, holds").not.toBeNull();
    const second = await live(r, f, r.pasted);
    expect(await kindOf(second), "PREMISE: a YouTube session follows").not.toBe("seazn");
    expect(await holdOf(f), "a later session of another kind: nothing for Seazn to wait for").toBeNull();
    await stopAndSettle(r, f, second);
    expect(await stateOf(second), "PREMISE: the YouTube session completed, a moment ago").toBe("completed");
    expect(await holdOf(f), "completed a moment ago, but YouTube's: Seazn's recording pass has nothing to lock for it").toBeNull();
    const third = await live(r, f, r.seazn);
    expect(await holdOf(f), "the latest is a Seazn session, live").toBeNull();
    await stopAndSettle(r, f, third);
    await endedAt(third, new Date(N.getTime() - 30_000));
    const fourth = await goLive(r, f, r.seazn);
    expect(await stateOf(fourth), "PREMISE: warming").toBe("warming");
    expect(await holdOf(f), "warming again").toBe(LADDER);
  });
});

// Visual re-capture R1: a replay of two or more parts mounts its picker row (56 px with its gap) with the route's first answer, and the
// Summary panel moved 56 px. The plan hands the island the parts' numbers as the ROUTE will number them (`seazn-video.ts` is the one
// authority: recording order, numbered over every locked recording before any is left out), so the box holds the row from the server
// render. While the latest session is live the route's answer is the live player, which has no picker, so none is held.
describe.skipIf(!HAS_DB)("seaznVideoPlan: the replay's part numbers the island holds a picker row for (re-capture R1)", () => {
  const planParts = async (fixtureId: string) => {
    const plan = await seaznVideoPlan(fixtureId);
    if (plan.player !== "seazn") throw new Error(`PREMISE: the plan is seazn, not ${plan.player}`);
    return plan.replayParts;
  };
  /** The route's own numbering of the same rows. */
  const routeParts = async (r: Rig, fixtureId: string) => {
    const answer = await seaznFixtureVideo(fixtureId, new Date(), { ingest: r.deps.drivers.ingest, tokenCache: createPlaybackTokenCache() });
    return answer.replay.map((p) => p.partNo);
  };

  it("EMPTY CASE FIRST: no recording is no parts, and so is a fixture with nothing locked but sessions; an unstarted fixture has none either", async () => {
    const r = await rig();
    const [f, g] = r.fixtureIds;
    expect(await planParts(g), "arm 3").toEqual([]);
    const sid = await live(r, f, r.seazn);
    await stopAndSettle(r, f, sid);
    expect(await planParts(f)).toEqual([]);
    expect(await routeParts(r, f), "premise: the route lists none either").toEqual([]);
  });

  it("the parts of two sessions are numbered as the route numbers them, over every recording in recording order — checked against the route's own answer", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const first = await live(r, f, r.seazn);
    await seedLockedRecording(first, 50);
    await stopAndSettle(r, f, first);
    const second = await live(r, f, r.seazn);
    await seedLockedRecording(second, 20);
    await seedLockedRecording(second, 30);
    await stopAndSettle(r, f, second);
    expect(await planParts(f)).toEqual([1, 2, 3]);
    expect(await routeParts(r, f), "the route's own numbers").toEqual([1, 2, 3]);
  });

  it("a part past Cloudflare's own delete is left out and leaves a gap, as the route leaves it (the plan reads the same rows)", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const first = await live(r, f, r.seazn);
    await seedLockedRecording(first, 50);
    await stopAndSettle(r, f, first);
    const second = await live(r, f, r.seazn);
    await seedLockedRecording(second, 20);
    await seedLockedRecording(second, 30);
    await stopAndSettle(r, f, second);
    await sql`update fixture_stream_sessions set created_at = now() - ${DELETE_RECORDING_AFTER_DAYS + 1} * interval '1 day' where id = ${first}`;
    expect(await routeParts(r, f), "PREMISE: the route lists the two of the second session, numbered 2 and 3").toEqual([2, 3]);
    expect(await planParts(f)).toEqual([2, 3]);
  });

  it("a recording under a session of ANOTHER kind is never a part, for the plan as for the route (even with a row locked under it)", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const seaznSid = await live(r, f, r.seazn);
    await seedLockedRecording(seaznSid, 40);
    await stopAndSettle(r, f, seaznSid);
    const yt = await live(r, f, r.pasted);
    await seedLockedRecording(yt, 10);
    await stopAndSettle(r, f, yt);
    expect(await routeParts(r, f), "PREMISE: the route lists only the Seazn session's").toEqual([1]);
    expect(await planParts(f)).toEqual([1]);
  });

  it("while the latest session is LIVE the route's answer is the live player and has no picker, so no part is held — and the parts come back once it stops", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const first = await live(r, f, r.seazn);
    await seedLockedRecording(first, 50);
    await stopAndSettle(r, f, first);
    const second = await live(r, f, r.seazn);
    await seedLockedRecording(second, 5);
    expect(await planParts(f), "live now").toEqual([]);
    await stopAndSettle(r, f, second);
    expect(await planParts(f), "stopped").toEqual([1, 2]);
    const third = await goLive(r, f, r.seazn);
    expect(await stateOf(third), "PREMISE: warming").toBe("warming");
    expect(await planParts(f), "warming again: the route answers the recordings, with their picker").toEqual([1, 2]);
  });

  it("an id that is not a uuid names no fixture: no parts, and the query is never reached (22P02 would be a 500); an unknown uuid has none either", async () => {
    await rig();
    for (const id of ["", "not-a-uuid", "00000000-0000-0000-0000-00000000000"]) {
      expect(await seaznReplayPartNos(id, new Date()), JSON.stringify(id)).toEqual([]);
    }
    expect(await seaznReplayPartNos(randomUUID(), new Date()), "a uuid no fixture has").toEqual([]);
  });

  it("the other arms hold no parts: a YouTube fixture is external, an unstarted one is seazn with none", async () => {
    const r = await rig();
    const [f, g] = r.fixtureIds;
    const sid = await live(r, f, r.pasted);
    await stopAndSettle(r, f, sid);
    expect((await seaznVideoPlan(f)).player).toBe("external");
    expect(await planParts(g)).toEqual([]);
  });
});
