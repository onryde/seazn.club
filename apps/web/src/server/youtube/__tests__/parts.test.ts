// YouTube Connect T16 (server half): a fixture's replay PARTS — its complete YouTube broadcasts, numbered in the order they
// finished — as the public match page and the organiser's stream panel read them.
//
// Two readers, one numbering:
//   replayParts(fixtureId)              the PUBLIC read: public_fixture_youtube_parts_v on the privileged client (plan R7: the view
//                                       is not granted to app_user). Redaction lives in the view: a setup division and a private
//                                       competition have no row.
//   fixtureReplayParts(orgId, fixtureId) the ORGANISER's read, org-scoped, straight off youtube_broadcasts: an organiser of a private
//                                       competition still sees their own replays in their panel.
//
// Rows are built three ways, each where it is the honest producer: SQL for the shapes no producer makes on demand (a tie, a failed
// row between two complete ones, a private competition), and the REAL end step for the one flow the brief names - complete b1,
// Go live again, complete b2 (class 1: a seam is proven through its real producer). Expected urls are typed from the broadcast ids
// the FAKE YouTube minted and the broadcast rows hold, never taken back out of replayParts.
//
// Sport: not applicable - streaming is sport-agnostic (global-constraints "Test rules"); every rig rides `generic`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { youtubeWatchUrl } from "@/lib/youtube";
import type { AuthCtx } from "@/server/api-v1/auth";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { pairPresentPhone, rigUser, spendMonthlyStreamGrant } from "@/server/relay/__tests__/_session-rig";
import { divisionRig, seedOrg } from "@/server/usecases/__tests__/_rig";
import { startDivision } from "@/server/usecases/schedule";
import { grantCredits } from "@/server/usecases/stream-credits";
import { createSession as organiserStart, currentSession, stopSession, type SessionDeps } from "@/server/usecases/stream-sessions";
import { endDueBroadcasts } from "../end-step";
import { FakeYouTube } from "../fake";
import { fixtureReplayParts, replayParts } from "../parts";
import { connect } from "./_connect-rig";

const HAS_DB = !!process.env.DATABASE_URL;

const MIN = 60_000;
const SEC = 1000;
const ENV = ["RELAY_KEK", "YOUTUBE_TOKEN_KEK", "RELAY_IMAGE"] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
beforeAll(() => {
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex");
  process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:t16-test";
});
afterAll(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** An 11-character id of a real video's shape (the fake mints the same shape). */
const vid = () => `t16${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const at = (hhmm: string) => new Date(`2030-06-01T${hhmm}:00Z`);

interface Rig { auth: AuthCtx; orgId: string; connectionId: string; fixtures: string[]; divisionId: string; competitionId: string }

/** An org with one connected channel (through the real save) and a division of `fixtures` fixtures. `start: false` leaves the
 *  division in setup. */
async function rig(o: { fixtures?: number; start?: boolean } = {}): Promise<Rig> {
  const { auth } = await seedOrg();
  const n = o.fixtures ?? 1;
  let entrants = 2;
  while ((entrants * (entrants - 1)) / 2 < n) entrants++;
  const d = await divisionRig(auth, { entrants, ...(o.start === false ? { start: false } : {}) });
  const userId = await rigUser();
  const c = await connect({ auth: { ...auth, userId }, orgId: auth.orgId, userId });
  const [div] = await sql<{ competition_id: string }[]>`select competition_id from divisions where id = ${d.divisionId}`;
  return { auth, orgId: auth.orgId, connectionId: c.connectionId, fixtures: d.fixtureIds.slice(0, n), divisionId: d.divisionId, competitionId: div!.competition_id };
}

/** A broadcast row, SQL-built: `complete` ones carry the facts V479 requires (a finish time and a video id). */
async function broadcast(
  r: Pick<Rig, "orgId" | "connectionId">,
  fixtureId: string,
  o: { state: string; ytId?: string | null; completedAt?: Date | null; id?: string },
): Promise<{ id: string; ytId: string | null }> {
  const ytId = o.ytId === undefined ? vid() : o.ytId;
  const completedAt = o.completedAt === undefined ? (o.state === "complete" ? new Date() : null) : o.completedAt;
  const [row] = await sql<{ id: string }[]>`
    insert into youtube_broadcasts (id, org_id, connection_id, fixture_id, yt_broadcast_id, title, privacy, state, reserved_until, completed_at)
    values (${o.id ?? randomUUID()}, ${r.orgId}, ${r.connectionId}, ${fixtureId}, ${ytId}, 'Match', 'unlisted', ${o.state},
            ${o.state === "reserved" ? new Date(Date.now() + 5 * MIN) : null}, ${completedAt})
    returning id`;
  return { id: row!.id, ytId };
}

describe.skipIf(!HAS_DB)("YouTube Connect T16 - a fixture's replay parts", () => {
  // ---- the empty case, then order and numbering -----------------------------------------------------------------------------
  it("EMPTY CASE FIRST: a fixture with no broadcast has no parts, on both reads; the same call then lists one as soon as a broadcast completes", async () => {
    const r = await rig();
    const f = r.fixtures[0]!;
    expect(await replayParts(f)).toEqual([]);
    expect(await fixtureReplayParts(r.orgId, f)).toEqual([]);

    const b = await broadcast(r, f, { state: "complete", completedAt: at("10:00") });
    expect(await replayParts(f)).toEqual([{ partNo: 1, url: youtubeWatchUrl(b.ytId!) }]);
    expect(await fixtureReplayParts(r.orgId, f)).toEqual([{ partNo: 1, url: youtubeWatchUrl(b.ytId!) }]);
  });

  it("parts are numbered in the order they FINISHED, not the order they were inserted or sorted by id; a tie on the finish time breaks by id", async () => {
    const r = await rig();
    const f = r.fixtures[0]!;
    // The later-finished row is inserted FIRST, and its id sorts BELOW the earlier row's: insertion order and id order are both wrong.
    const [lowId, highId] = [randomUUID(), randomUUID()].sort() as [string, string];
    const late = await broadcast(r, f, { state: "complete", completedAt: at("11:00"), id: lowId });
    const early = await broadcast(r, f, { state: "complete", completedAt: at("10:00"), id: highId });
    const expected = [
      { partNo: 1, url: youtubeWatchUrl(early.ytId!) },
      { partNo: 2, url: youtubeWatchUrl(late.ytId!) },
    ];
    expect(await replayParts(f)).toEqual(expected);
    expect(await fixtureReplayParts(r.orgId, f)).toEqual(expected);

    // A tie: three rows, one instant, inserted in DESCENDING id order - the id decides.
    const g = await rig();
    const tieFixture = g.fixtures[0]!;
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    const made: Record<string, string> = {};
    for (const id of [...ids].reverse()) made[id] = (await broadcast(g, tieFixture, { state: "complete", completedAt: at("12:00"), id })).ytId!;
    const tied = ids.map((id, i) => ({ partNo: i + 1, url: youtubeWatchUrl(made[id]!) }));
    expect(await replayParts(tieFixture)).toEqual(tied);
    expect(await fixtureReplayParts(g.orgId, tieFixture)).toEqual(tied);
  });

  it("only COMPLETE broadcasts are parts: failed, created, bound, reserved, live and ending rows are not listed and take no number", async () => {
    const r = await rig();
    const f = r.fixtures[0]!;
    const first = await broadcast(r, f, { state: "complete", completedAt: at("09:00") });
    await broadcast(r, f, { state: "failed", ytId: null });                 // never reached YouTube
    await broadcast(r, f, { state: "failed" });                              // reached YouTube, then failed
    await broadcast(r, f, { state: "ending" });
    const second = await broadcast(r, f, { state: "complete", completedAt: at("10:30") });
    // Part 2 is still LIVE (the second Go live): it is not yet a part.
    const open = await broadcast(r, f, { state: "live" });
    const expected = [
      { partNo: 1, url: youtubeWatchUrl(first.ytId!) },
      { partNo: 2, url: youtubeWatchUrl(second.ytId!) },
    ];
    expect(await replayParts(f)).toEqual(expected);
    expect(await fixtureReplayParts(r.orgId, f)).toEqual(expected);

    // The open row becomes a part the moment it completes (a second call sees the change), numbered after the others.
    await sql`update youtube_broadcasts set state = 'complete', completed_at = ${at("11:30")} where id = ${open.id}`;
    const after = [...expected, { partNo: 3, url: youtubeWatchUrl(open.ytId!) }];
    expect(await replayParts(f)).toEqual(after);
    expect(await fixtureReplayParts(r.orgId, f)).toEqual(after);
  });

  it("another fixture's parts never leak in: each fixture numbers from 1", async () => {
    const r = await rig({ fixtures: 2 });
    const [f1, f2] = r.fixtures as [string, string];
    const a = await broadcast(r, f1, { state: "complete", completedAt: at("10:00") });
    const b = await broadcast(r, f2, { state: "complete", completedAt: at("09:00") });
    expect(await replayParts(f1)).toEqual([{ partNo: 1, url: youtubeWatchUrl(a.ytId!) }]);
    expect(await replayParts(f2)).toEqual([{ partNo: 1, url: youtubeWatchUrl(b.ytId!) }]);
    expect(await fixtureReplayParts(r.orgId, f1)).toEqual([{ partNo: 1, url: youtubeWatchUrl(a.ytId!) }]);
  });

  // ---- redaction (public) and tenancy (organiser) ---------------------------------------------------------------------------
  it("a setup division has no public parts (an unreleased division must not leak a replay); the same fixture lists them once the division starts - the organiser's own read lists them throughout", async () => {
    const r = await rig({ start: false });
    const f = r.fixtures[0]!;
    const b = await broadcast(r, f, { state: "complete", completedAt: at("10:00") });
    const expected = [{ partNo: 1, url: youtubeWatchUrl(b.ytId!) }];
    expect((await sql<{ status: string }[]>`select status from divisions where id = ${r.divisionId}`)[0]!.status, "premise: the division is in setup").toBe("setup");
    expect(await replayParts(f), "public: setup division").toEqual([]);
    expect(await fixtureReplayParts(r.orgId, f), "organiser: their own data").toEqual(expected);

    await startDivision(r.auth, r.divisionId);
    expect((await sql<{ status: string }[]>`select status from divisions where id = ${r.divisionId}`)[0]!.status, "premise: the division left setup").not.toBe("setup");
    expect(await replayParts(f), "public: after the division starts").toEqual(expected);
  });

  it("a PRIVATE competition has no public parts; public and unlisted do - and the organiser's read lists them under every visibility", async () => {
    const r = await rig();
    const f = r.fixtures[0]!;
    const b = await broadcast(r, f, { state: "complete", completedAt: at("10:00") });
    const expected = [{ partNo: 1, url: youtubeWatchUrl(b.ytId!) }];
    let checked = 0;
    for (const [visibility, publicSees] of [["private", false], ["unlisted", true], ["public", true]] as const) {
      await sql`update competitions set visibility = ${visibility} where id = ${r.competitionId}`;
      expect(await replayParts(f), `public read, ${visibility}`).toEqual(publicSees ? expected : []);
      expect(await fixtureReplayParts(r.orgId, f), `organiser read, ${visibility}`).toEqual(expected);
      checked++;
    }
    expect(checked, "anti-vacuity: all three visibilities were asserted").toBe(3);
  });

  it("the organiser's read is org-scoped: another organisation asking for this fixture's id gets nothing", async () => {
    const r = await rig();
    const other = await rig();
    const f = r.fixtures[0]!;
    const b = await broadcast(r, f, { state: "complete", completedAt: at("10:00") });
    expect(await fixtureReplayParts(r.orgId, f), "positive pair: the owner sees it").toEqual([{ partNo: 1, url: youtubeWatchUrl(b.ytId!) }]);
    expect(await fixtureReplayParts(other.orgId, f)).toEqual([]);
  });

  // ---- the real producer ----------------------------------------------------------------------------------------------------
  it("RESTART AFTER COMPLETION through the real end step: complete b1, Go live again, complete b2 gives Part 1 then Part 2, in that order, and the panel's read agrees with the public one", async () => {
    const seeded = await seedOrg();
    const auth = { ...seeded.auth, userId: await rigUser() };
    const d = await divisionRig(auth, { entrants: 2 });
    const f = d.fixtureIds[0]!;
    for (const key of ["streaming.overlay", "streaming.relay"]) {
      await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason) values (${auth.orgId}, ${key}, true, 't16 unit')
                on conflict (org_id, feature_key) do update set bool_value = true`;
    }
    await invalidateOrgEntitlements(auth.orgId);
    await pairPresentPhone(f);
    await grantCredits({ orgId: auth.orgId, delta: 2, createdBy: await rigUser(), note: "t16", idempotencyKey: randomUUID() });
    await spendMonthlyStreamGrant(auth.orgId);
    const c = await connect({ auth, orgId: auth.orgId, userId: auth.userId });

    let now = Date.now();
    const ingest = new FakeIngest({ clock: () => now, connectAfterMs: 3000 });
    ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: 100_000_000, videoCount: 0 };
    const fake = new FakeYouTube({ now: () => new Date(now) });
    const deps: SessionDeps = { drivers: { ingest, runner: new FakeRunner() }, now: () => new Date(now), appUrl: "http://app.test", youtube: fake };

    /** Go live -> live -> video arrives -> a minute of play -> Stop; returns the broadcast the fake minted for it. */
    const playAndStop = async (): Promise<string> => {
      await pairPresentPhone(f, { at: deps.now() });
      const { sessionId } = await organiserStart(auth, f, { mode: "passthrough", targetId: c.targetId }, deps);
      now += 3000;
      expect((await currentSession(auth, f, deps))!.state, "premise: the session went live").toBe("live");
      const [session] = await sql<{ youtube_broadcast_id: string }[]>`select youtube_broadcast_id from fixture_stream_sessions where id = ${sessionId}`;
      const [b] = await sql<{ yt_broadcast_id: string }[]>`select yt_broadcast_id from youtube_broadcasts where id = ${session!.youtube_broadcast_id}`;
      const ytId = b!.yt_broadcast_id;
      now += SEC;
      fake.videoOn(fake.inspectBroadcast(ytId)!.streamId!);
      now += MIN;
      await stopSession(auth, f, sessionId, deps);
      fake.videoOff(fake.inspectBroadcast(ytId)!.streamId!);
      return ytId;
    };
    const endAll = () => endDueBroadcasts(fake, { now: () => new Date(now), budgetMs: 15_000, orgIds: [auth.orgId] });

    // The panel reads the same list off the session view it already polls (`replayParts` beside `replayUrl`).
    const panelParts = async () => (await currentSession(auth, f, deps))!.replayParts;

    expect(await replayParts(f), "premise: nothing yet").toEqual([]);
    const first = await playAndStop();
    expect(await panelParts(), "a session that has not been ended at YouTube yet has no part").toEqual([]);
    expect(await replayParts(f), "Part 1 is not a part until the end step completes it").toEqual([]);
    now += 6 * MIN;
    expect(await endAll()).toMatchObject({ ended: 1 });
    expect(await replayParts(f)).toEqual([{ partNo: 1, url: youtubeWatchUrl(first) }]);
    expect(await panelParts(), "one part: the panel lists it").toEqual([{ partNo: 1, url: youtubeWatchUrl(first) }]);

    const second = await playAndStop();
    expect(second, "premise: the second Go live is a NEW broadcast").not.toBe(first);
    expect(await replayParts(f), "Part 2 is still open: only Part 1 is listed").toEqual([{ partNo: 1, url: youtubeWatchUrl(first) }]);
    now += 6 * MIN;
    expect(await endAll()).toMatchObject({ ended: 1 });
    const expected = [
      { partNo: 1, url: youtubeWatchUrl(first) },
      { partNo: 2, url: youtubeWatchUrl(second) },
    ];
    expect(await replayParts(f)).toEqual(expected);
    expect(await fixtureReplayParts(auth.orgId, f)).toEqual(expected);
    expect(await panelParts(), "two parts: the panel's session view lists both, in order").toEqual(expected);
  });
});
