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
import { CODE_GRACE_AFTER_FINISH_MINUTES, DELETE_RECORDING_AFTER_DAYS, ENDING_TIMEOUT_SECONDS, FINALISATION_GRACE_SECONDS, HOLD_SLACK_SECONDS, INGEST_TIMEOUT_SECONDS, MAX_ANCHOR_DRIFT_SECONDS, MAX_DURATION_MINUTES, STREAM_TICK_PERIOD_SECONDS, tunable } from "@/server/relay/config";
import { SEAZN_VIDEO_POLL_CEILING_MS } from "@/components/public-site/match-centre/seazn-video-schedule";
import { ACTIVE_STATES, TERMINAL_STATES, type SessionState } from "@/server/relay/domain/session";
import { codeStatus } from "@/server/relay/domain/stream-code";
import { stopSession } from "@/server/usecases/stream-sessions";
import { createPlaybackTokenCache } from "../cf-playback";
import { seaznFixtureVideo, seaznReplayPartNos } from "../seazn-video";
import { seaznVideoPlan } from "../seazn-video-plan";
import { FakeReplayHost } from "../replay-fake";
import { setSeaznOffered } from "@/server/usecases/stream-targets";
import { movedReplays } from "./_seazn-replay-rig";
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

  // Task 33 fix round 1 (m5): the org's Seazn switch (V559) gates only NEW Seazn picks and starts (owner ruling). Arm 1 (a Seazn session
  // or replay) never reads it, so a running or replayed Seazn fixture keeps its player; arm 3 (unstarted) reads it only through the
  // resolver, on purpose — the player appears exactly when Go live would stream to Seazn.
  it("fix round 1 (m5): the switch is NOT read for a fixture with a Seazn session or replay — off, a LIVE session's plan and a replayed fixture's plan are unchanged, whole (counted)", async () => {
    const r = await rig();
    const [running, replayed] = r.fixtureIds;
    const host = new FakeReplayHost();
    const m = await movedReplays(r, replayed, host, { parts: 2 });
    const sid = await live(r, running, r.seazn);
    expect(await kindOf(sid), "PREMISE: the running session is Seazn's").toBe("seazn");
    const at = new Date(m.t0 + 16 * 60_000);
    const plans = async () => ({ running: await seaznVideoPlan(running, at), replayed: await seaznVideoPlan(replayed, at) });
    const before = await plans();
    expect(before.running.player, "PREMISE: the running fixture plays Seazn").toBe("seazn");
    expect(before.replayed, "PREMISE: the replayed fixture lists its two parts").toMatchObject({ player: "seazn", replayParts: [1, 2] });
    expect(await setSeaznOffered(r.auth, r.auth.orgId, false), "PREMISE: the switch is off").toEqual({ offered: false });
    const after = await plans();
    let checked = 0;
    for (const k of ["running", "replayed"] as const) {
      expect(after[k], `${k}: the same plan, whole`).toEqual(before[k]);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(2);
  });

  it("fix round 1 (m5): an UNSTARTED fixture follows the switch, by its default and by its saved Seazn pick — off: external (the default falls to the pasted key; the saved pick resolves to none); on again: seazn", async () => {
    const r = await rig();
    const [byDefault, bySaved] = r.fixtureIds;
    await saveStreamSettings(r.auth, bySaved, { targetId: r.seazn });
    expect(await defaultPick(r, byDefault), "PREMISE: on, the default is Seazn").toBe(r.seazn);
    expect(await defaultPick(r, bySaved), "PREMISE: on, the saved pick is Seazn").toBe(r.seazn);
    expect([await playerOf(byDefault), await playerOf(bySaved)], "on").toEqual(["seazn", "seazn"]);
    await setSeaznOffered(r.auth, r.auth.orgId, false);
    expect(await defaultPick(r, byDefault), "PREMISE: off, the default falls to the pasted key").toBe(r.pasted);
    expect(await defaultPick(r, bySaved), "PREMISE: off, the saved Seazn pick resolves to none").toBeNull();
    expect([await playerOf(byDefault), await playerOf(bySaved)], "off").toEqual(["external", "external"]);
    await setSeaznOffered(r.auth, r.auth.orgId, true);
    expect([await playerOf(byDefault), await playerOf(bySaved)], "on again").toEqual(["seazn", "seazn"]);
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
// "the session": `seazn-video.ts` reads the latest by creation) is a Seazn session that is not yet live (requested through warming: the
// ladder, `MAX_ANCHOR_DRIFT_SECONDS` from the session's CREATION), is being stopped (`ending`: the ending backstop, then the recording's
// path, from `ending_at`), or COMPLETED a moment ago (the recording's path from its `ended_at`: Cloudflare's finish, the stream tick that
// locks it, one read). Every one is counted from the SESSION's own time, never from the render (review m1), so a page drawn late does not
// promise a video for longer than the session itself could take. A live session has none (its answer is the player), a failed one has
// none (it never recorded), and a later session of another kind ends it. Nor does an ending or completed one that NEVER went live
// (`started_at` null: a Go live stopped on its way up; T33f fix round 1, review I2): the domain fills no replay for it.
describe.skipIf(!HAS_DB)("seaznVideoPlan: the wait the island holds its box through (re-capture R2)", () => {
  const seazn = async (fixtureId: string, now: Date) => {
    const plan = await seaznVideoPlan(fixtureId, now);
    if (plan.player !== "seazn") throw new Error(`PREMISE: the plan is seazn, not ${plan.player}`);
    return plan;
  };
  const holdOf = async (fixtureId: string, now: Date) => (await seazn(fixtureId, now)).holdUntil?.toISOString() ?? null;
  const at = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000).toISOString();
  const ago = (base: Date, seconds: number) => new Date(base.getTime() - seconds * 1000);
  /** The session's own times, set by hand (each is the plan's INPUT; the producers that write them are other tasks' tests). */
  async function stamp(sid: string, s: { created?: Date; ending?: Date | null; ended?: Date | null }) {
    if (s.created !== undefined) await sql`update fixture_stream_sessions set created_at = ${s.created} where id = ${sid}`;
    if (s.ending !== undefined) await sql`update fixture_stream_sessions set ending_at = ${s.ending} where id = ${sid}`;
    if (s.ended !== undefined) await sql`update fixture_stream_sessions set ended_at = ${s.ended} where id = ${sid}`;
  }
  // The expected figures come from the engine's own declarations, never from the plan's: a recording reaches a viewer by the finalisation
  // grace after the end, then one whole tick period (the lock), then one read at the schedule's ceiling.
  const SHOWN_BY_S = FINALISATION_GRACE_SECONDS + STREAM_TICK_PERIOD_SECONDS + SEAZN_VIDEO_POLL_CEILING_MS / 1000;

  it("EMPTY CASE FIRST: an unstarted Seazn fixture (arm 3) has no wait", async () => {
    const r = await rig();
    expect(await holdOf(r.fixtureIds[0], new Date())).toBeNull();
  });

  it("review m1: a session on its way up (warming) holds the box for the ladder counted from the session's CREATION — a page drawn late holds only what is left, and none once it is past", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await goLive(r, f, r.seazn);
    expect(await stateOf(sid), "PREMISE: before the playing beat, warming").toBe("warming");
    const N = new Date();
    const created = ago(N, 13 * 60);
    await stamp(sid, { created });
    const closes = at(created, MAX_ANCHOR_DRIFT_SECONDS);
    expect(await holdOf(f, N), "drawn 13 minutes in: one minute left, not a whole ladder").toBe(closes);
    expect(Date.parse(closes) - N.getTime(), "PREMISE: that is shorter than the ladder (the old render-anchored wait gave the whole of it)").toBeLessThan(MAX_ANCHOR_DRIFT_SECONDS * 1000 / 2);
    expect(await holdOf(f, new Date(N.getTime() + 20_000)), "a render 20 s later holds the SAME instant: it does not move with the render").toBe(closes);
    expect(await holdOf(f, new Date(Date.parse(closes) - 1)), "a ms before the ladder closes: held").toBe(closes);
    expect(await holdOf(f, new Date(closes)), "at the instant: the session can no longer be warming").toBeNull();
    await stamp(sid, { created: ago(N, MAX_ANCHOR_DRIFT_SECONDS + 60) });
    expect(await holdOf(f, N), "created past the ladder ago: no wait (nothing legal is still warming)").toBeNull();
  });

  it("every state of the latest Seazn session, from the session domain's own lists, each counted from ITS OWN time: not-yet-live from creation, ending from ending_at, completed from ended_at; live and failed hold none — nor ending or completed when it NEVER went live", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await goLive(r, f, r.seazn);
    const N = new Date();
    // Three distinct instants, so a state that read the wrong one gives the wrong answer (and a fourth, the live's start, between them).
    const created = ago(N, 10 * 60), started = ago(N, 8 * 60), ending = ago(N, 90), ended = ago(N, 60);
    await stamp(sid, { created, ending });
    const liveAt = ACTIVE_STATES.indexOf("live");
    // A state past the ladder's live is swept both ways: after a live (the domain's `started_at`) and never live (fix round 1, I2).
    const cases = ([...ACTIVE_STATES, ...TERMINAL_STATES] as SessionState[]).flatMap((state) => {
      const beforeLive = ACTIVE_STATES.indexOf(state) !== -1 && ACTIVE_STATES.indexOf(state) < liveAt;
      return beforeLive ? [{ state, wentLive: false }] : state === "live" ? [{ state, wentLive: true }] : [{ state, wentLive: true }, { state, wentLive: false }];
    });
    let checked = 0;
    for (const { state, wentLive } of cases) {
      await sql`update fixture_stream_sessions set state = ${state}, started_at = ${wentLive ? started : null}, ended_at = ${TERMINAL_STATES.includes(state) ? ended : null} where id = ${sid}`.catch((e: unknown) => {
        throw new Error(`PREMISE: could not set state ${state}: ${(e as Error).message}`);
      });
      const expected =
        state === "live" || state === "failed" ? null
        : (state === "completed" || state === "ending") && !wentLive ? null
        : state === "completed" ? at(ended, SHOWN_BY_S)
        : state === "ending" ? at(ending, ENDING_TIMEOUT_SECONDS + SHOWN_BY_S)
        : at(created, MAX_ANCHOR_DRIFT_SECONDS);
      expect(await holdOf(f, N), `state ${state}, ${wentLive ? "went live" : "never live"}`).toBe(expected);
      checked++;
    }
    // 3 on the way up, live once, then ending, completed and failed each both ways: 3 + 1 + 3 × 2.
    expect(checked, "anti-vacuity: every case was checked").toBe(cases.length);
    expect(checked).toBe(10);
    expect(cases.filter((c) => (c.state === "ending" || c.state === "completed") && !c.wentLive), "the never-live stops are in the sweep").toHaveLength(2);
  });

  it("just stopped: the wait is the recording's path from the END — to the ms: a ms before it closes held, at it gone; a session with no end stamp counts from its creation", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.seazn);
    await stopAndSettle(r, f, sid);
    const N = new Date();
    const ended = ago(N, 20 * 60);
    await stamp(sid, { created: ago(ended, 3600), ending: ago(ended, 20), ended });
    const closes = at(ended, SHOWN_BY_S);
    expect(await holdOf(f, new Date(ended.getTime() + 60_000)), "a minute after the Stop").toBe(closes);
    expect(await holdOf(f, new Date(Date.parse(closes) - 1)), "a ms before the window closes").toBe(closes);
    expect(await holdOf(f, new Date(closes)), "at the instant it closes: nothing is waited for").toBeNull();
    expect(await holdOf(f, new Date(Date.parse(closes) + 1)), "after it").toBeNull();
    const created = ago(N, 60);
    await stamp(sid, { created, ending: null, ended: null });
    expect(await holdOf(f, N), "no end stamp: counted from the session's creation, a minute ago").toBe(at(created, SHOWN_BY_S));
  });

  it("review I1: a recording locked one stream-tick LATE (stg ticks every 5 minutes) — a page drawn the instant it lands still holds, with a read to spare; the old window (the grace) was gone by then", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.seazn);
    await stopAndSettle(r, f, sid);
    const N = new Date();
    const ended = ago(N, 3600);
    await stamp(sid, { created: ago(ended, 3600), ending: ago(ended, 20), ended });
    // The real path from the END, from the declarations: Cloudflare's own hold after the input goes, then the tick that locks it.
    const landsAfterEnd = INGEST_TIMEOUT_SECONDS + HOLD_SLACK_SECONDS + STREAM_TICK_PERIOD_SECONDS;
    expect(landsAfterEnd, "PREMISE: past the grace the old wait counted").toBeGreaterThan(FINALISATION_GRACE_SECONDS);
    const lands = new Date(ended.getTime() + landsAfterEnd * 1000);
    const hold = await holdOf(f, lands);
    expect(hold, "drawn when the late lock lands: still waiting").not.toBeNull();
    expect(Date.parse(hold!) - lands.getTime(), "with at least one read (the schedule's ceiling) to spare, so the page gets the recording").toBeGreaterThanOrEqual(SEAZN_VIDEO_POLL_CEILING_MS);
    expect(await holdOf(f, new Date(ended.getTime() + FINALISATION_GRACE_SECONDS * 1000)), "and at the old window's end it was well inside").not.toBeNull();
  });

  it("the REAL Stop: a session just stopped holds the box from ITS OWN stamps — ending from ending_at, completed from ended_at — and the same fixture decided long ago does not", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.seazn);
    await stopSession(r.auth, f, sid, r.deps);
    expect(await stateOf(sid), "PREMISE: ending").toBe("ending");
    const [stopping] = await sql<{ ending_at: Date }[]>`select ending_at from fixture_stream_sessions where id = ${sid}`;
    expect(stopping!.ending_at, "PREMISE: the Stop stamped ending_at").toBeInstanceOf(Date);
    expect(await holdOf(f, new Date(stopping!.ending_at.getTime() + 1_000)), "ending").toBe(at(stopping!.ending_at, ENDING_TIMEOUT_SECONDS + SHOWN_BY_S));
    await stopAndSettle(r, f, sid);
    const [done] = await sql<{ ended_at: Date }[]>`select ended_at from fixture_stream_sessions where id = ${sid}`;
    expect(done!.ended_at, "PREMISE: completing stamped ended_at").toBeInstanceOf(Date);
    expect(await holdOf(f, new Date(done!.ended_at.getTime() + 30_000)), "completed a moment ago").toBe(at(done!.ended_at, SHOWN_BY_S));
    expect(await holdOf(f, new Date(done!.ended_at.getTime() + (SHOWN_BY_S + 60) * 1000)), "the window has closed: nothing to wait for").toBeNull();
  });

  it("only the LATEST session counts: an earlier Seazn one just stopped is not waited for once a YouTube one follows; a live Seazn one after a stopped one has none; a warming one after one holds the ladder again", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const N = new Date();
    const first = await live(r, f, r.seazn);
    await stopAndSettle(r, f, first);
    await stamp(first, { created: ago(N, 3000), ending: ago(N, 60), ended: ago(N, 30) });
    expect(await holdOf(f, N), "PREMISE: the first, just stopped, holds").not.toBeNull();
    const second = await live(r, f, r.pasted);
    await stamp(second, { created: ago(N, 2000) });
    expect(await kindOf(second), "PREMISE: a YouTube session follows").not.toBe("seazn");
    expect(await holdOf(f, N), "a later session of another kind: nothing for Seazn to wait for").toBeNull();
    await stopAndSettle(r, f, second);
    await stamp(second, { ending: ago(N, 50), ended: ago(N, 40) });
    expect(await stateOf(second), "PREMISE: the YouTube session completed, a moment ago").toBe("completed");
    expect(await holdOf(f, N), "completed a moment ago, but YouTube's: Seazn's recording pass has nothing to lock for it").toBeNull();
    const third = await live(r, f, r.seazn);
    await stamp(third, { created: ago(N, 1000) });
    expect(await holdOf(f, N), "the latest is a Seazn session, live").toBeNull();
    await stopAndSettle(r, f, third);
    await stamp(third, { ending: ago(N, 40), ended: ago(N, 30) });
    const fourth = await goLive(r, f, r.seazn);
    const created = ago(N, 100);
    await stamp(fourth, { created });
    expect(await stateOf(fourth), "PREMISE: warming").toBe("warming");
    expect(await holdOf(f, N), "warming again: the ladder from ITS creation").toBe(at(created, MAX_ANCHOR_DRIFT_SECONDS));
  });
});

// Review m2: the box is held before the first read only where a player is EXPECTED: a Seazn session still in flight, a wait that is on, or
// a recording the route will offer. A fixture whose last Seazn session ended with nothing to play (a Go live that failed, a stop that
// recorded nothing, a recording Cloudflare has since deleted) answers the empty video on every load, so a reserved box there is a
// guaranteed collapse; a Go live that comes later on that open page is caught by the island's loop as it would be before kick-off.
describe.skipIf(!HAS_DB)("seaznVideoPlan: the box is reserved only where a player is expected (review m2)", () => {
  const planAt = async (fixtureId: string, now: Date) => {
    const plan = await seaznVideoPlan(fixtureId, now);
    if (plan.player !== "seazn") throw new Error(`PREMISE: the plan is seazn, not ${plan.player}`);
    return plan;
  };
  const ago = (base: Date, seconds: number) => new Date(base.getTime() - seconds * 1000);
  const PAST_WINDOW_S = FINALISATION_GRACE_SECONDS + STREAM_TICK_PERIOD_SECONDS + SEAZN_VIDEO_POLL_CEILING_MS / 1000 + 60;
  /** A session that ended `secondsAgo`: its three stamps, the end the plan reads. */
  async function endedAgo(sid: string, N: Date, secondsAgo: number) {
    await sql`update fixture_stream_sessions set created_at = ${ago(N, secondsAgo + 3600)}, ending_at = ${ago(N, secondsAgo + 20)}, ended_at = ${ago(N, secondsAgo)} where id = ${sid}`;
  }

  it("EMPTY CASE FIRST: the plan for a Seazn session that ended with nothing to play, past its window, reserves no box, holds no wait, and lists no part — the island is still mounted for a Go live that comes later", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.seazn);
    await stopAndSettle(r, f, sid);
    const N = new Date();
    await endedAgo(sid, N, PAST_WINDOW_S);
    const plan = await planAt(f, N);
    expect(plan.reserve, "no player is coming").toBe(false);
    expect(plan.holdUntil).toBeNull();
    expect(plan.replayParts).toEqual([]);
  });

  it("a Go live that FAILED reserves nothing either (it never recorded); the same fixture with a recording locked under an earlier session reserves again, and lists the part", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const first = await live(r, f, r.seazn);
    await stopAndSettle(r, f, first);
    const second = await goLive(r, f, r.seazn);
    await sql`update fixture_stream_sessions set state = 'failed', ended_at = ${new Date()} where id = ${second}`;
    const N = new Date();
    await endedAgo(first, N, PAST_WINDOW_S + 7200);
    await sql`update fixture_stream_sessions set created_at = ${ago(N, PAST_WINDOW_S + 100)}, ended_at = ${ago(N, PAST_WINDOW_S)} where id = ${second}`;
    expect(await stateOf(second), "PREMISE: the latest session failed").toBe("failed");
    expect((await planAt(f, N)).reserve, "latest failed, nothing recorded: no box").toBe(false);
    await seedLockedRecording(first, 90);
    const withPart = await planAt(f, N);
    expect(withPart.replayParts, "PREMISE: the route will list the one part").toEqual([1]);
    expect(withPart.reserve, "a recording to play: the box is held").toBe(true);
  });

  it("every state of the latest Seazn session: in flight (requested through ending) and live reserve; completed reserves while its wait is on and, past it, only with a recording", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await goLive(r, f, r.seazn);
    const N = new Date();
    // In flight: created a minute ago, stopping a few seconds ago, so each state's own anchor is recent.
    await sql`update fixture_stream_sessions set created_at = ${ago(N, 60)}, ending_at = ${ago(N, 5)} where id = ${sid}`;
    let checked = 0;
    for (const state of ACTIVE_STATES as SessionState[]) {
      await sql`update fixture_stream_sessions set state = ${state} where id = ${sid}`;
      expect((await planAt(f, N)).reserve, `state ${state}`).toBe(true);
      checked++;
    }
    expect(checked, "anti-vacuity: every in-flight state").toBe(ACTIVE_STATES.length);
    // T33f fix round 1 (review I2): completed 30 s ago having NEVER gone live (stopped on its way up): no recording is coming, no box.
    await sql`update fixture_stream_sessions set state = 'completed', started_at = null, ended_at = ${ago(N, 30)} where id = ${sid}`;
    expect((await planAt(f, N)).reserve, "completed 30 s ago, never live: nothing is coming").toBe(false);
    await sql`update fixture_stream_sessions set started_at = ${ago(N, 45)} where id = ${sid}`;
    expect((await planAt(f, N)).reserve, "completed 30 s ago after a live: its wait is on").toBe(true);
    await sql`update fixture_stream_sessions set ended_at = ${ago(N, PAST_WINDOW_S)}, created_at = ${ago(N, PAST_WINDOW_S + 3600)}, ending_at = ${ago(N, PAST_WINDOW_S + 20)} where id = ${sid}`;
    expect((await planAt(f, N)).reserve, "completed past its wait, nothing recorded: no box").toBe(false);
    await seedLockedRecording(sid, 90);
    expect((await planAt(f, N)).reserve, "the same, with a recording: the box").toBe(true);
  });

  it("a YouTube session after a Seazn one: the box is held only for the Seazn recordings the route will offer, never for its own sake", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const first = await live(r, f, r.seazn);
    await stopAndSettle(r, f, first);
    const second = await live(r, f, r.pasted);
    await stopAndSettle(r, f, second);
    const N = new Date();
    await endedAgo(first, N, PAST_WINDOW_S + 7200);
    await endedAgo(second, N, PAST_WINDOW_S);
    expect(await kindOf(second), "PREMISE: the later session is another kind").not.toBe("seazn");
    expect((await planAt(f, N)).reserve, "nothing of Seazn's to play").toBe(false);
    await seedLockedRecording(first, 90);
    expect((await planAt(f, N)).reserve, "a Seazn recording to play").toBe(true);
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

// Task 33c (owner 2026-11-23): the live player carries one more row, the delay line. Where a LIVE is what the page expects next — the
// fixture's LATEST session is a Seazn one on its way up or live — the box the page holds keeps that row's place, so the live player's
// arrival still moves nothing (`liveExpected`). Where a RECORDING comes next (ending, completed) or nothing (failed), it must not: the
// recording would then land a row short. The video route answers `live` only for a session in state `live` (seazn-live.ts), and the
// domain's ACTIVE_STATES is the session's ladder in order, so "on its way up or live" is every active state up to and including `live`.
describe.skipIf(!HAS_DB)("seaznVideoPlan: whether a live is what the page expects next (Task 33c, the delay line's row)", () => {
  const liveExpectedOf = async (fixtureId: string) => {
    const plan = await seaznVideoPlan(fixtureId);
    if (plan.player !== "seazn") throw new Error(`PREMISE: the plan is seazn, not ${plan.player}`);
    return plan.liveExpected;
  };

  it("EMPTY CASE FIRST: an unstarted Seazn fixture (arm 3: no session yet) expects no live — the island draws no box there to hold a row in", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    expect(await playerOf(f), "PREMISE: arm 3 answers seazn").toBe("seazn");
    expect(await liveExpectedOf(f)).toBe(false);
  });

  it("every state of the latest Seazn session, from the session domain's own ladder: requested through live expect a live; ending, completed and failed do not", async () => {
    const liveAt = ACTIVE_STATES.indexOf("live");
    expect(liveAt, "PREMISE: live is on the ladder, before ending").toBeGreaterThan(0);
    expect(ACTIVE_STATES.indexOf("ending"), "PREMISE: ending follows live").toBeGreaterThan(liveAt);
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await goLive(r, f, r.seazn);
    let yes = 0;
    let no = 0;
    for (const state of [...ACTIVE_STATES, ...TERMINAL_STATES] as SessionState[]) {
      await sql`update fixture_stream_sessions set state = ${state}, ended_at = ${TERMINAL_STATES.includes(state) ? new Date() : null} where id = ${sid}`;
      const expected = ACTIVE_STATES.includes(state) && ACTIVE_STATES.indexOf(state) <= liveAt;
      expect(await liveExpectedOf(f), `state ${state}`).toBe(expected);
      if (expected) yes++;
      else no++;
    }
    expect(yes, "anti-vacuity: the states on the way up, and live").toBe(liveAt + 1);
    expect(no, "anti-vacuity: ending and the terminal states").toBe(ACTIVE_STATES.length - liveAt - 1 + TERMINAL_STATES.length);
  });

  it("only the LATEST session counts: a live Seazn session followed by a YouTube one expects none; a second Seazn Go live after it expects one again", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const first = await live(r, f, r.seazn);
    expect(await liveExpectedOf(f), "PREMISE: the Seazn session is live").toBe(true);
    await stopAndSettle(r, f, first);
    expect(await liveExpectedOf(f), "stopped: a recording comes next, not a live").toBe(false);
    const second = await live(r, f, r.pasted);
    expect(await kindOf(second), "PREMISE: a YouTube session follows").not.toBe("seazn");
    expect(await liveExpectedOf(f), "the latest is YouTube's: the Seazn player expects no live").toBe(false);
    await stopAndSettle(r, f, second);
    const third = await goLive(r, f, r.seazn);
    expect(await stateOf(third), "PREMISE: the second Seazn Go live is warming").toBe("warming");
    expect(await liveExpectedOf(f), "warming again: a live comes next").toBe(true);
  });
});
