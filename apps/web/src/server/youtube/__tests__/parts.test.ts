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
// Privacy (owner ruling A, 2026-10-28): a broadcast that is PRIVATE on YouTube is hidden from the public read and listed - flagged
// `private: true` - on the organiser's. So the two numberings agree unless privacies are mixed: the public numbers what it shows.
//
// Sport: not applicable - streaming is sport-agnostic (global-constraints "Test rules"); every rig rides `generic`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { linkIsOneOfParts, youtubeWatchUrl } from "@/lib/youtube";
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
/** The ORGANISER's shape of a list of parts: each part plus whether its broadcast is private on YouTube (false unless `priv` says so,
 *  index by index). The public read has no such flag. */
const mine = (parts: readonly { partNo: number; url: string }[], priv: readonly boolean[] = []) =>
  parts.map((p, i) => ({ ...p, private: priv[i] ?? false }));

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
  o: { state: string; ytId?: string | null; completedAt?: Date | null; id?: string; createdAt?: Date; privacy?: "unlisted" | "public" | "private" },
): Promise<{ id: string; ytId: string | null }> {
  const ytId = o.ytId === undefined ? vid() : o.ytId;
  const completedAt = o.completedAt === undefined ? (o.state === "complete" ? new Date() : null) : o.completedAt;
  const [row] = await sql<{ id: string }[]>`
    insert into youtube_broadcasts (id, org_id, connection_id, fixture_id, yt_broadcast_id, title, privacy, state, reserved_until, completed_at, created_at)
    values (${o.id ?? randomUUID()}, ${r.orgId}, ${r.connectionId}, ${fixtureId}, ${ytId}, 'Match', ${o.privacy ?? "unlisted"}, ${o.state},
            ${o.state === "reserved" ? new Date(Date.now() + 5 * MIN) : null}, ${completedAt}, ${o.createdAt ?? sql`now()`})
    returning id`;
  return { id: row!.id, ytId };
}

/** An org with a connected channel, one started fixture and what the REAL producers need (the session usecases, the end step), on a scripted
 *  clock. `playAndStop` is Go live -> live -> video arrives -> a minute of play -> Stop, and answers the broadcast the fake minted. */
async function streamRig(o: { privacy?: "unlisted" | "public" | "private" } = {}) {
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
  const c = await connect({ auth, orgId: auth.orgId, userId: auth.userId }, o.privacy ? { privacy: o.privacy } : {});

  let now = Date.now();
  const ingest = new FakeIngest({ clock: () => now, connectAfterMs: 3000 });
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: 100_000_000, videoCount: 0 };
  const fake = new FakeYouTube({ now: () => new Date(now) });
  const deps: SessionDeps = { drivers: { ingest, runner: new FakeRunner() }, now: () => new Date(now), appUrl: "http://app.test", youtube: fake };

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
  return {
    auth, f, fake, playAndStop,
    /** The channel's default for the NEXT Go live (a broadcast row keeps the privacy it was made with). */
    setChannelPrivacy: (privacy: "unlisted" | "public" | "private") =>
      sql`update org_youtube_connections set default_privacy = ${privacy} where id = ${c.connectionId}`,
    advance: (ms: number) => { now += ms; },
    endAll: () => endDueBroadcasts(fake, { now: () => new Date(now), budgetMs: 15_000, orgIds: [auth.orgId] }),
    /** The panel reads the same list off the session view it already polls (`replayParts` beside `replayUrl`). */
    panelParts: async () => (await currentSession(auth, f, deps))!.replayParts,
    streamUrl: async () => (await sql<{ stream_url: string | null }[]>`select stream_url from fixtures where id = ${f}`)[0]!.stream_url,
  };
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
    expect(await fixtureReplayParts(r.orgId, f)).toEqual(mine([{ partNo: 1, url: youtubeWatchUrl(b.ytId!) }]));
  });

  it("parts are numbered in the order they were STARTED, not the order they finished, were inserted or sorted by id; a tie on the start breaks by id", async () => {
    const r = await rig();
    const f = r.fixtures[0]!;
    // Part 1 started first and finished LAST (its end was retried): the restart's row finished before it. That row is inserted FIRST and
    // its id sorts BELOW Part 1's - so completion order, insertion order and id order are all wrong.
    const [lowId, highId] = [randomUUID(), randomUUID()].sort() as [string, string];
    const late = await broadcast(r, f, { state: "complete", createdAt: at("11:00"), completedAt: at("11:30"), id: lowId });
    const early = await broadcast(r, f, { state: "complete", createdAt: at("10:00"), completedAt: at("12:00"), id: highId });
    const expected = [
      { partNo: 1, url: youtubeWatchUrl(early.ytId!) },
      { partNo: 2, url: youtubeWatchUrl(late.ytId!) },
    ];
    expect(await replayParts(f)).toEqual(expected);
    expect(await fixtureReplayParts(r.orgId, f)).toEqual(mine(expected));

    // A tie: three rows, one start instant, inserted in DESCENDING id order and finishing in descending id order too - the id decides.
    const g = await rig();
    const tieFixture = g.fixtures[0]!;
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    const made: Record<string, string> = {};
    for (const [i, id] of [...ids].reverse().entries()) {
      made[id] = (await broadcast(g, tieFixture, { state: "complete", createdAt: at("12:00"), completedAt: at(`1${3 + i}:00`), id })).ytId!;
    }
    const tied = ids.map((id, i) => ({ partNo: i + 1, url: youtubeWatchUrl(made[id]!) }));
    expect(await replayParts(tieFixture)).toEqual(tied);
    expect(await fixtureReplayParts(g.orgId, tieFixture)).toEqual(mine(tied));
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
    expect(await fixtureReplayParts(r.orgId, f)).toEqual(mine(expected));

    // The open row becomes a part the moment it completes (a second call sees the change), numbered after the others.
    await sql`update youtube_broadcasts set state = 'complete', completed_at = ${at("11:30")} where id = ${open.id}`;
    const after = [...expected, { partNo: 3, url: youtubeWatchUrl(open.ytId!) }];
    expect(await replayParts(f)).toEqual(after);
    expect(await fixtureReplayParts(r.orgId, f)).toEqual(mine(after));
  });

  it("another fixture's parts never leak in: each fixture numbers from 1", async () => {
    const r = await rig({ fixtures: 2 });
    const [f1, f2] = r.fixtures as [string, string];
    const a = await broadcast(r, f1, { state: "complete", completedAt: at("10:00") });
    const b = await broadcast(r, f2, { state: "complete", completedAt: at("09:00") });
    expect(await replayParts(f1)).toEqual([{ partNo: 1, url: youtubeWatchUrl(a.ytId!) }]);
    expect(await replayParts(f2)).toEqual([{ partNo: 1, url: youtubeWatchUrl(b.ytId!) }]);
    expect(await fixtureReplayParts(r.orgId, f1)).toEqual(mine([{ partNo: 1, url: youtubeWatchUrl(a.ytId!) }]));
  });

  // ---- redaction (public) and tenancy (organiser) ---------------------------------------------------------------------------
  it("a setup division has no public parts (an unreleased division must not leak a replay); the same fixture lists them once the division starts - the organiser's own read lists them throughout", async () => {
    const r = await rig({ start: false });
    const f = r.fixtures[0]!;
    const b = await broadcast(r, f, { state: "complete", completedAt: at("10:00") });
    const expected = [{ partNo: 1, url: youtubeWatchUrl(b.ytId!) }];
    expect((await sql<{ status: string }[]>`select status from divisions where id = ${r.divisionId}`)[0]!.status, "premise: the division is in setup").toBe("setup");
    expect(await replayParts(f), "public: setup division").toEqual([]);
    expect(await fixtureReplayParts(r.orgId, f), "organiser: their own data").toEqual(mine(expected));

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
      expect(await fixtureReplayParts(r.orgId, f), `organiser read, ${visibility}`).toEqual(mine(expected));
      checked++;
    }
    expect(checked, "anti-vacuity: all three visibilities were asserted").toBe(3);
  });

  it("the organiser's read is org-scoped: another organisation asking for this fixture's id gets nothing", async () => {
    const r = await rig();
    const other = await rig();
    const f = r.fixtures[0]!;
    const b = await broadcast(r, f, { state: "complete", completedAt: at("10:00") });
    expect(await fixtureReplayParts(r.orgId, f), "positive pair: the owner sees it").toEqual(mine([{ partNo: 1, url: youtubeWatchUrl(b.ytId!) }]));
    expect(await fixtureReplayParts(other.orgId, f)).toEqual([]);
  });

  // ---- private on YouTube (owner ruling A) ----------------------------------------------------------------------------------
  it("a PRIVATE broadcast: the public read skips it (empty case first: private only is no public part), the organiser's read lists it flagged private - and flips to public/unlisted are parts on both", async () => {
    const r = await rig();
    const f = r.fixtures[0]!;
    const hidden = await broadcast(r, f, { state: "complete", completedAt: at("10:00"), createdAt: at("09:00"), privacy: "private" });
    expect(await replayParts(f), "private only: nothing public").toEqual([]);
    expect(await fixtureReplayParts(r.orgId, f), "the organiser keeps it, flagged").toEqual(mine([{ partNo: 1, url: youtubeWatchUrl(hidden.ytId!) }], [true]));

    // Positive pair: the broadcast's privacy is the ONLY difference. The same row made public / unlisted is a part on both reads.
    let checked = 0;
    for (const privacy of ["public", "unlisted"] as const) {
      const g = await rig();
      const gf = g.fixtures[0]!;
      const b = await broadcast(g, gf, { state: "complete", completedAt: at("10:00"), createdAt: at("09:00"), privacy });
      expect(await replayParts(gf), `public read, ${privacy}`).toEqual([{ partNo: 1, url: youtubeWatchUrl(b.ytId!) }]);
      expect(await fixtureReplayParts(g.orgId, gf), `organiser read, ${privacy}`).toEqual(mine([{ partNo: 1, url: youtubeWatchUrl(b.ytId!) }], [false]));
      checked++;
    }
    expect(checked, "anti-vacuity: both non-private privacies were asserted").toBe(2);
  });

  it("MIXED privacy: the organiser numbers every complete broadcast, the public only the ones it shows - the numbers may differ, and nothing is renumbered on the organiser's side", async () => {
    const r = await rig();
    const f = r.fixtures[0]!;
    // Part 1 public, Part 2 private: public sees ONE part (number 1); the organiser sees both.
    const p1 = await broadcast(r, f, { state: "complete", completedAt: at("10:00"), createdAt: at("09:00"), privacy: "unlisted" });
    const p2 = await broadcast(r, f, { state: "complete", completedAt: at("12:00"), createdAt: at("11:00"), privacy: "private" });
    expect(await replayParts(f)).toEqual([{ partNo: 1, url: youtubeWatchUrl(p1.ytId!) }]);
    expect(await fixtureReplayParts(r.orgId, f)).toEqual(mine([
      { partNo: 1, url: youtubeWatchUrl(p1.ytId!) },
      { partNo: 2, url: youtubeWatchUrl(p2.ytId!) },
    ], [false, true]));

    // Part 1 private, Part 2 public: the public's Part 1 is the organiser's Part 2 (accepted: the organiser's numbers never move).
    const g = await rig();
    const gf = g.fixtures[0]!;
    const q1 = await broadcast(g, gf, { state: "complete", completedAt: at("10:00"), createdAt: at("09:00"), privacy: "private" });
    const q2 = await broadcast(g, gf, { state: "complete", completedAt: at("12:00"), createdAt: at("11:00"), privacy: "public" });
    expect(await replayParts(gf), "public: the later one is the first it shows").toEqual([{ partNo: 1, url: youtubeWatchUrl(q2.ytId!) }]);
    expect(await fixtureReplayParts(g.orgId, gf), "organiser: still Part 1 private, Part 2 public").toEqual(mine([
      { partNo: 1, url: youtubeWatchUrl(q1.ytId!) },
      { partNo: 2, url: youtubeWatchUrl(q2.ytId!) },
    ], [true, false]));
  });

  // ---- the real producer ----------------------------------------------------------------------------------------------------
  it("RESTART AFTER COMPLETION through the real end step: complete b1, Go live again, complete b2 gives Part 1 then Part 2, in that order, and the panel's read agrees with the public one", async () => {
    const { auth, f, playAndStop, advance, endAll, panelParts, streamUrl } = await streamRig();

    expect(await replayParts(f), "premise: nothing yet").toEqual([]);
    const first = await playAndStop();
    expect(await panelParts(), "a session that has not been ended at YouTube yet has no part").toEqual([]);
    expect(await replayParts(f), "Part 1 is not a part until the end step completes it").toEqual([]);
    advance(6 * MIN);
    expect(await endAll()).toMatchObject({ ended: 1 });
    expect(await replayParts(f)).toEqual([{ partNo: 1, url: youtubeWatchUrl(first) }]);
    expect(await panelParts(), "one part: the panel lists it").toEqual(mine([{ partNo: 1, url: youtubeWatchUrl(first) }]));
    expect(await streamUrl(), "the end step wrote Part 1's address as the fixture's link").toBe(youtubeWatchUrl(first));

    const second = await playAndStop();
    expect(second, "premise: the second Go live is a NEW broadcast").not.toBe(first);
    expect(await replayParts(f), "Part 2 is still open: only Part 1 is listed").toEqual([{ partNo: 1, url: youtubeWatchUrl(first) }]);
    advance(6 * MIN);
    expect(await endAll()).toMatchObject({ ended: 1 });
    const expected = [
      { partNo: 1, url: youtubeWatchUrl(first) },
      { partNo: 2, url: youtubeWatchUrl(second) },
    ];
    expect(await replayParts(f)).toEqual(expected);
    expect(await fixtureReplayParts(auth.orgId, f)).toEqual(mine(expected));
    expect(await panelParts(), "two parts: the panel's session view lists both, in order").toEqual(mine(expected));
    // The contract the public page's dedupe (`linkIsOneOfParts`) and the panel's "Replay" row rely on: the link is Part 1's and Part 2
    // never replaces it - so a club's single link is never mistaken for a part, and a part is never shown twice.
    expect(await streamUrl(), "Part 2 did not take the link").toBe(youtubeWatchUrl(first));
    expect(await streamUrl()).not.toBe(youtubeWatchUrl(second));
  });

  it("PART 1 FINISHES LAST (its end is retried), through the real end step: the restart's broadcast completes first, yet once both are done Part 1 is the one that STARTED first - on the public read, the organiser's and the panel's - and the stored link is one of the parts, never a second link", async () => {
    const { auth, f, fake, playAndStop, advance, endAll, panelParts, streamUrl } = await streamRig();
    const first = await playAndStop();
    advance(6 * MIN);   // Part 1's end is due: the restart finds it due, claims it `ending` and makes a NEW broadcast
    const second = await playAndStop();
    expect(second, "premise: the restart is a new broadcast").not.toBe(first);
    advance(6 * MIN);   // both are due now
    fake.failNext("complete", "youtube_unavailable");   // Part 1's `complete` (oldest first) fails once and backs off a minute
    expect(await endAll(), "Part 1's end failed, the restart's went through").toMatchObject({ ended: 1, failed: 1 });
    // The restart's broadcast finished FIRST, so until Part 1 lands it is the only part and carries number 1.
    expect(await replayParts(f), "only the broadcast that has finished is a part").toEqual([{ partNo: 1, url: youtubeWatchUrl(second) }]);
    const linkAfterFirstPass = await streamUrl();

    advance(2 * MIN);   // past Part 1's backoff
    expect(await endAll(), "Part 1's retry").toMatchObject({ ended: 1 });
    const done = await sql<{ yt_broadcast_id: string; completed_at: Date }[]>`
      select yt_broadcast_id, completed_at from youtube_broadcasts where fixture_id = ${f} and state = 'complete'`;
    const finishedAt = (ytId: string) => done.find((d) => d.yt_broadcast_id === ytId)!.completed_at.getTime();
    expect(done, "premise: both broadcasts are complete").toHaveLength(2);
    expect(finishedAt(first), "premise: Part 1 finished AFTER the restart's broadcast").toBeGreaterThan(finishedAt(second));

    const expected = [
      { partNo: 1, url: youtubeWatchUrl(first) },
      { partNo: 2, url: youtubeWatchUrl(second) },
    ];
    expect(await replayParts(f), "public: numbered by start").toEqual(expected);
    expect(await fixtureReplayParts(auth.orgId, f), "organiser: the same numbers").toEqual(mine(expected));
    expect(await panelParts(), "panel: the same numbers").toEqual(mine(expected));
    // The end step writes the link only into an empty one, so the first FINALIZER holds it and Part 1's late completion leaves it alone.
    // What the page's dedupe needs is only that it is one of the parts.
    expect(await streamUrl(), "the later completion did not rewrite the link").toBe(linkAfterFirstPass);
    expect(linkIsOneOfParts((await streamUrl())!, expected), "the stored link is one of the parts, so the page shows no second pill").toBe(true);
  });

  it("PRIVATE through the real producers (Go live on a private channel, the real end step): the match completes, the fixture gets no link, the public read has nothing and the panel's session view lists the part flagged private", async () => {
    const { auth, f, playAndStop, advance, endAll, panelParts, streamUrl } = await streamRig({ privacy: "private" });
    expect(await replayParts(f), "premise: nothing yet").toEqual([]);
    const only = await playAndStop();
    advance(6 * MIN);
    expect(await endAll()).toMatchObject({ ended: 1 });
    expect((await sql<{ privacy: string }[]>`select privacy from youtube_broadcasts where fixture_id = ${f} and yt_broadcast_id = ${only}`)[0]!.privacy, "premise: the producer made a private broadcast").toBe("private");
    expect(await streamUrl(), "no link for a private video").toBeNull();
    expect(await replayParts(f), "the public sees no part").toEqual([]);
    const expected = mine([{ partNo: 1, url: youtubeWatchUrl(only) }], [true]);
    expect(await fixtureReplayParts(auth.orgId, f), "the organiser's read lists it").toEqual(expected);
    expect(await panelParts(), "and so does the session view the panel polls").toEqual(expected);
  });

  it("A channel switched from private to unlisted between two matches' broadcasts: each broadcast keeps the privacy it was made with - Part 1 stays private, Part 2 is public, and the link is Part 2's (the first public one to finish)", async () => {
    const { auth, f, playAndStop, advance, endAll, panelParts, streamUrl, setChannelPrivacy } = await streamRig({ privacy: "private" });
    const first = await playAndStop();
    advance(6 * MIN);
    expect(await endAll()).toMatchObject({ ended: 1 });
    expect(await streamUrl()).toBeNull();

    await setChannelPrivacy("unlisted");
    const second = await playAndStop();
    expect(second, "premise: a new broadcast").not.toBe(first);
    advance(6 * MIN);
    expect(await endAll()).toMatchObject({ ended: 1 });
    const mineBoth = mine([{ partNo: 1, url: youtubeWatchUrl(first) }, { partNo: 2, url: youtubeWatchUrl(second) }], [true, false]);
    expect(await fixtureReplayParts(auth.orgId, f)).toEqual(mineBoth);
    expect(await panelParts()).toEqual(mineBoth);
    expect(await replayParts(f), "public: only the unlisted one, as its own Part 1").toEqual([{ partNo: 1, url: youtubeWatchUrl(second) }]);
    expect(await streamUrl(), "the link is the public part's").toBe(youtubeWatchUrl(second));
  });
});
