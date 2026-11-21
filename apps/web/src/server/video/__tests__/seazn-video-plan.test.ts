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
import { seaznVideoPlan } from "../seazn-video-plan";
import { type SeaznRig as Rig, installSeaznEnv, kindOf, live, seaznRig as rig, stopAndSettle } from "./_seazn-session-rig";

const HAS_DB = !!process.env.DATABASE_URL;
installSeaznEnv("seazn-video-plan-test");
const liveOff = () => vi.stubEnv("SEAZN_HOSTED_LIVE", "false");

const setStatus = (fixtureId: string, status: string) => sql`update fixtures set status = ${status} where id = ${fixtureId}`;
/** The default the fixture would stream to, read the way the panel and the phone read it: the resolver's pick. */
const defaultPick = async (r: Rig, fixtureId: string) => (await fixtureStreamTarget(sql, { orgId: r.auth.orgId, fixtureId }))?.id ?? null;

describe.skipIf(!HAS_DB)("seaznVideoPlan: which player the match page mounts", () => {
  it("EMPTY CASE FIRST: an id that is not a uuid, and a fixture that does not exist, are external, and a malformed id never reaches the query (a 22P02 would throw)", async () => {
    expect(await seaznVideoPlan("f1")).toBe("external");
    expect(await seaznVideoPlan("")).toBe("external");
    expect(await seaznVideoPlan("not-a-uuid'; drop table fixtures; --")).toBe("external");
    expect(await seaznVideoPlan(randomUUID()), "a well-formed id that names nothing").toBe("external");
  });

  it("a fixture with a Seazn session is seazn WHATEVER LIVE is: while the session is live, and once it has ended and the fixture is decided", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.seazn);
    expect(await kindOf(sid), "PREMISE: the producer wrote the destination kind").toBe("seazn");
    expect(await seaznVideoPlan(f), "LIVE on, session live").toBe("seazn");
    liveOff();
    expect(await seaznVideoPlan(f), "LIVE OFF, session live (the ruling)").toBe("seazn");
    vi.stubEnv("SEAZN_HOSTED_LIVE", "true");
    await stopAndSettle(r, f, sid);
    await setStatus(f, "decided");
    expect(await seaznVideoPlan(f), "LIVE on, ended and decided").toBe("seazn");
    liveOff();
    expect(await seaznVideoPlan(f), "LIVE OFF, ended and decided (the ruling: a Seazn fixture keeps its player)").toBe("seazn");
  });

  it("a Seazn session wins over a later YouTube session on the same fixture (any Seazn session, not the latest)", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const first = await live(r, f, r.seazn);
    await stopAndSettle(r, f, first);
    const second = await live(r, f, r.pasted);
    expect(await kindOf(second), "PREMISE: the later session is external").not.toBe("seazn");
    expect(await seaznVideoPlan(f)).toBe("seazn");
  });

  it("a fixture with one Seazn session stays seazn after the org's default moves (LIVE off) and after a saved YouTube pick", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.seazn);
    await stopAndSettle(r, f, sid);
    expect(await defaultPick(r, f), "PREMISE: the org's default is Seazn").toBe(r.seazn);
    liveOff();
    expect(await defaultPick(r, f), "PREMISE: with LIVE off the Seazn row is hidden from the resolver").not.toBe(r.seazn);
    expect(await seaznVideoPlan(f)).toBe("seazn");
    vi.stubEnv("SEAZN_HOSTED_LIVE", "true");
    await saveStreamSettings(r.auth, f, { targetId: r.pasted });
    expect(await seaznVideoPlan(f), "the organiser later picks YouTube for this match").toBe("seazn");
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
    expect(await seaznVideoPlan(bySession), "the session arm").toBe("external");
    // By its status: decided with no session at all (a result entered by hand), so only the status arm can answer.
    const byStatus = r.fixtureIds[1];
    await setStatus(byStatus, "decided");
    expect(await defaultPick(r, byStatus), "PREMISE: its default pick is Seazn too").toBe(r.seazn);
    expect(await seaznVideoPlan(byStatus), "the decided arm").toBe("external");
  });

  it("an UNSTARTED fixture (no session, not over): seazn when its default is Seazn and LIVE is on; external with LIVE off, where the default is the pasted key", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    expect(await defaultPick(r, f), "PREMISE: LIVE on, the default is Seazn").toBe(r.seazn);
    expect(await seaznVideoPlan(f)).toBe("seazn");
    liveOff();
    expect(await defaultPick(r, f), "PREMISE: LIVE off, the default is the pasted key").toBe(r.pasted);
    expect(await seaznVideoPlan(f)).toBe("external");
  });

  it("an unstarted fixture follows its SAVED choice over the default: YouTube -> external, Seazn -> seazn, and a cleared choice (nothing to stream to) -> external", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    await saveStreamSettings(r.auth, f, { targetId: r.pasted });
    expect(await defaultPick(r, f), "PREMISE: the saved pick is the pasted key").toBe(r.pasted);
    expect(await seaznVideoPlan(f)).toBe("external");
    await saveStreamSettings(r.auth, f, { targetId: r.seazn });
    expect(await seaznVideoPlan(f)).toBe("seazn");
    await saveStreamSettings(r.auth, f, { targetId: null });
    expect(await defaultPick(r, f), "PREMISE: the organiser cleared the choice: nothing resolves").toBeNull();
    expect(await seaznVideoPlan(f)).toBe("external");
  });

  it("LIVE off short-circuits: the resolver is not asked for an unstarted fixture; with LIVE on it is asked once, for this org and fixture", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const resolver = vi.mocked(fixtureStreamTarget);
    liveOff();
    resolver.mockClear();
    expect(await seaznVideoPlan(f)).toBe("external");
    expect(resolver, "LIVE off: nothing is asked of the resolver (every page view of an unstarted match would pay for it)").not.toHaveBeenCalled();
    vi.stubEnv("SEAZN_HOSTED_LIVE", "true");
    resolver.mockClear();
    expect(await seaznVideoPlan(f)).toBe("seazn");
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
    expect(await seaznVideoPlan(f)).toBe("external");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("an org with no destination at all is external (nothing resolves)", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    await sql`update org_stream_targets set archived_at = now() where org_id = ${r.auth.orgId}`;
    expect(await defaultPick(r, f), "PREMISE: nothing resolves").toBeNull();
    expect(await seaznVideoPlan(f)).toBe("external");
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
      expect(await seaznVideoPlan(f), `status ${status}`).toBe(expected);
      if (expected === "seazn") seazn++;
      else external++;
    }
    expect(seazn + external, "anti-vacuity: every status was checked").toBe(FIXTURE_STATUSES.length);
    expect(seazn, "and the sweep saw both answers").toBeGreaterThan(0);
    expect(external).toBeGreaterThan(0);
  });
});
