// Seazn-hosted video T47: the camera's READS, against real Postgres and the REAL producers (the organiser's Go live and Stop, the stream
// tick's lock pass, discovery and the replay move, the organiser's delete, a YouTube broadcast row), and the agreement with the public MATCH PAGE.
//
// What is held here (the rule itself, over every status, is `hub-stream-flags.test.ts`):
//   - every SOURCE gives the right value in ONE batch: a Seazn live; a YouTube-kind (pasted key) live with no link (no camera: the page cannot play it); a Seazn recording still on Cloudflare;
//     a Seazn replay on the replay host (Bunny); a YouTube broadcast part; the club's own link in play; the club's own link on a decided
//     match; and nothing at all -> absent. Anti-vacuity: the batch's size is pinned, never "no throw";
//   - the batch is ONE statement for the facts, plus one for the Seazn recordings only when some match has Seazn video, whatever the number
//     of matches (statement counts, with the empty case: no match, no statement);
//   - the SEQUENCE: going live -> stop -> a recording appears -> Cloudflare's 30 days pass (no host copy: gone) -> a second session on the
//     same fixture goes live (live beats the replay) -> it ends; and a replay the organiser DELETES stops showing, the interim included;
//   - privacy: a private competition and a division still in setup never get a camera, however live; another sport's fixture (cricket) reads
//     the same; the answer is the enum alone (no address, uid or token anywhere in it);
//   - AGREEMENT with the match page (the one place a viewer would find the video): over every fixture status, a camera that is not
//     live never shows where the real page renders neither the player nor the button, and the Seazn side agrees with the video route's own
//     answer (`seaznFixtureVideo`, what the island plays) at every step above.
// ONE SPORT for the page sweep, on purpose (TEST-STRATEGY rule 6): the slot reads no sport rule; the cricket case proves the read is not
// sport-keyed. Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
vi.mock("next/cache", () => ({ unstable_cache: (fn: (...args: unknown[]) => unknown) => fn, revalidateTag: vi.fn() }));
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return { ...actual, useSearchParams: () => new URLSearchParams() };
});

import { randomUUID } from "node:crypto";
import { sql, statementCount } from "@/lib/db";
import { FIXTURE_STATUSES } from "@/lib/fixture-status";
import { ReplayEmbed } from "@/components/public-site/match-centre/replay-embed";
import { SeaznVideoIsland } from "@/components/public-site/match-centre/seazn-video-island";
import { DELETE_RECORDING_AFTER_DAYS } from "@/server/relay/config";
import { rigUser } from "@/server/relay/__tests__/_session-rig";
import { divisionRig, seedOrg, startedCricketDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { createPlaybackTokenCache } from "@/server/video/cf-playback";
import { deleteSeaznReplay } from "@/server/video/organiser-replays";
import { FakeReplayHost } from "@/server/video/replay-fake";
import { readReplayEntries, readPublicReplayEntriesMany } from "@/server/video/replay-entries";
import { seaznFixtureVideo, seaznReplayPartNos } from "@/server/video/seazn-video";
import { movedReplays } from "@/server/video/__tests__/_seazn-replay-rig";
import { type SeaznRig, installSeaznEnv, live, goLive, seaznRigFor, seedLockedRecording, stopAndSettle } from "@/server/video/__tests__/_seazn-session-rig";
import { createStreamTarget } from "@/server/usecases/stream-targets";
import { connect } from "@/server/youtube/__tests__/_connect-rig";
import { readHubStreamFlags, type HubStream } from "../hub-stream-flags";

const HAS_DB = !!process.env.DATABASE_URL;
installSeaznEnv("hub-stream-flags");

const DAY = 86_400_000;
const CLUB_LINK = "https://www.twitch.tv/seaznclub";
const vid = () => `t47${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const orgs: string[] = [];
afterAll(async () => {
  for (const orgId of orgs) await sql`delete from organizations where id = ${orgId}`.catch(() => undefined);
});

/** The flags for `ids`, the way the hub asks: each fixture with its status as the database holds it NOW. */
async function flags(ids: readonly string[], now: Date = new Date()): Promise<Map<string, HubStream>> {
  const rows = await sql<{ id: string; status: string }[]>`select id, status from fixtures where id in ${sql([...ids])}`;
  expect(rows.length, "PREMISE: every fixture asked about exists").toBe(ids.length);
  return readHubStreamFlags(rows, now);
}
const flagOf = async (id: string, now?: Date): Promise<HubStream | undefined> => (await flags([id], now)).get(id);
const setStatus = (id: string, status: string) => sql`update fixtures set status = ${status} where id = ${id}`;
const setLink = (id: string, url: string | null) => sql`update fixtures set stream_url = ${url} where id = ${id}`;

interface World { r: SeaznRig; ids: string[]; divisionId: string; competitionId: string; connectionId: string; host: FakeReplayHost; spare: string }
/** An org with `n` started fixtures in one PUBLIC competition, the Seazn session rig on them, and a connected YouTube channel. */
async function world(n = 10): Promise<World> {
  const seeded = await seedOrg();
  const auth = { ...seeded.auth, userId: await rigUser() };
  orgs.push(auth.orgId);
  let entrants = 2;
  while ((entrants * (entrants - 1)) / 2 < n) entrants++;
  const d = await divisionRig(auth, { entrants });
  const ids = d.fixtureIds.slice(0, n);
  const r = await seaznRigFor(auth, ids);
  const [div] = await sql<{ competition_id: string }[]>`select competition_id from divisions where id = ${d.divisionId}`;
  const c = await connect({ auth, orgId: auth.orgId, userId: auth.userId });
  const [vis] = await sql<{ visibility: string }[]>`select visibility from competitions where id = ${div!.competition_id}`;
  expect(vis!.visibility, "PREMISE: the rig's competition is public").toBe("public");
  // A second pasted key: one destination streams ONE match at a time, so a fixture that "streamed elsewhere" uses this one.
  const spare = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "Spare", streamKey: `yt-${randomUUID()}` });
  return { r, ids, divisionId: d.divisionId, competitionId: div!.competition_id, connectionId: c.connectionId, host: new FakeReplayHost(), spare: spare.id };
}

/** A complete YouTube broadcast of the fixture (the view's own row: complete, unlisted or public, division past setup). */
async function youtubePart(w: World, fixtureId: string): Promise<string> {
  const ytId = vid();
  await sql`
    insert into youtube_broadcasts (made_for_kids, org_id, connection_id, fixture_id, yt_broadcast_id, title, privacy, state, completed_at)
    values (false, ${w.r.auth.orgId}, ${w.connectionId}, ${fixtureId}, ${ytId}, 'Match', 'unlisted', 'complete', now())`;
  return ytId;
}

/** A YouTube-kind (pasted key) session that streamed and ended, as every YouTube replay part has behind it: the page's plan reads "this
 *  fixture has streamed elsewhere" from it (without a session an unstarted fixture whose default is Seazn gets the island instead). */
async function streamedElsewhere(w: World, fixtureId: string): Promise<void> {
  const sid = await live(w.r, fixtureId, w.spare);
  await stopAndSettle(w.r, fixtureId, sid);
}

/** What the match page's Seazn island is offered by the video route for this fixture (the island plays exactly this). */
async function routeAnswer(w: World, fixtureId: string, now: Date = new Date()) {
  return seaznFixtureVideo(fixtureId, now, { ingest: w.r.deps.drivers.ingest, tokenCache: createPlaybackTokenCache(), replay: w.host });
}

describe.skipIf(!HAS_DB)("the hub's camera flags: each source, the one-statement shape, the sequence, privacy", () => {
  it("EMPTY CASE FIRST: no match asks nothing of the database; matches with no stream and no recording are absent after ONE statement", async () => {
    const w = await world(3);
    const before0 = statementCount();
    expect((await readHubStreamFlags([], new Date())).size).toBe(0);
    expect(statementCount() - before0, "no match, no statement").toBe(0);
    const before = statementCount();
    const got = await flags(w.ids);
    const used = statementCount() - before - 1; // minus the test's own status read
    expect(got.size, "nothing known about any of them: nobody has a camera").toBe(0);
    expect(used, "no Seazn video anywhere: the facts statement alone").toBe(1);
  });

  it("EVERY SOURCE gives its value in ONE batch, and the batch is two statements however many matches (Seazn recordings are the second)", async () => {
    const w = await world(10);
    const [liveSeazn, livePasted, cfOnly, bunny, ytParts, linkLive, linkDecided, nothing] = w.ids as [string, string, string, string, string, string, string, string];
    // A Seazn live, and a pasted-key (YouTube-kind) live with no club link: only the Seazn one has a camera (the page plays only that).
    const seaznSid = await live(w.r, liveSeazn, w.r.seazn);
    const pastedSid = await live(w.r, livePasted, w.r.pasted);
    // A Seazn recording still on Cloudflare only.
    const cfSid = await live(w.r, cfOnly, w.r.seazn);
    await stopAndSettle(w.r, cfOnly, cfSid);
    await seedLockedRecording(cfSid, 5);
    // A Seazn replay on the replay host (made by the real lock pass, discovery and move).
    await movedReplays(w.r, bunny, w.host, { parts: 1 });
    // A YouTube broadcast part (decided match), the club's own link in play, and on a decided match.
    await streamedElsewhere(w, ytParts);
    await youtubePart(w, ytParts);
    await setStatus(ytParts, "decided");
    await setStatus(linkLive, "in_play");
    await setLink(linkLive, CLUB_LINK);
    await setStatus(linkDecided, "decided");
    await setLink(linkDecided, CLUB_LINK);
    // PREMISES from the producers, never the code under test: the sessions are in the states the cases are about.
    expect((await sql<{ state: string; k: string }[]>`select state, destination_kind as k from fixture_stream_sessions where id in ${sql([seaznSid, pastedSid])} order by destination_kind`).map((x) => `${x.k}:${x.state}`))
      .toEqual(["seazn:live", "youtube:live"]);

    const asked = w.ids.slice(0, 8);
    const before = statementCount();
    const got = await flags(asked);
    const used = statementCount() - before - 1;
    expect(Object.fromEntries(asked.map((id, i) => [i, got.get(id) ?? null]))).toEqual({
      0: "live", 1: null, 2: "replay", 3: "replay", 4: "replay", 5: "live", 6: "replay", 7: null,
    });
    expect(got.size, "anti-vacuity: six of the eight carry a camera (the pasted-key live has none)").toBe(6);
    expect(got.has(livePasted), "a pasted-key live with no link: no camera").toBe(false);
    expect(got.get(nothing)).toBeUndefined();
    expect(used, "the facts, then the Seazn recordings: two statements for eight matches").toBe(2);
    // The same two statements for ONE match as for all of them: the cost does not follow the number of matches.
    const b1 = statementCount();
    await flags([bunny]);
    expect(statementCount() - b1 - 1, "one Seazn match: still two").toBe(2);
    const b2 = statementCount();
    await flags([nothing, ytParts, linkDecided]);
    expect(statementCount() - b2 - 1, "no Seazn match among them: the facts alone").toBe(1);
  });

  it("T39: a Seazn recording locked but not yet playable (ready_at null) gives NO camera; once the pass has seen it ready, the same match is `replay`", async () => {
    const w = await world(2);
    const [pending, playable] = w.ids as [string, string];
    const pendingSid = await live(w.r, pending, w.r.seazn);
    await stopAndSettle(w.r, pending, pendingSid);
    const cf = await seedLockedRecording(pendingSid, 5, { ready: false });
    const playableSid = await live(w.r, playable, w.r.seazn);
    await stopAndSettle(w.r, playable, playableSid);
    await seedLockedRecording(playableSid, 5);
    const got = await flags([pending, playable]);
    expect(got.get(pending) ?? null, "locked, not ready: Cloudflare cannot play it, so no camera icon").toBeNull();
    expect(got.get(playable), "the ready twin of the same shape is offered").toBe("replay");
    expect(got.size, "anti-vacuity: exactly one of the two carries a camera").toBe(1);
    await sql`update seazn_locked_videos set ready_at = now() where cf_video_id = ${cf}`;
    expect((await flags([pending])).get(pending), "the pass sees it ready: the camera appears").toBe("replay");
  });

  it("the answer is the enum alone: nothing the batch returns carries an address, a uid or a token", async () => {
    const w = await world(3);
    const [a, b, c] = w.ids as [string, string, string];
    await live(w.r, a, w.r.seazn);
    await youtubePart(w, b);
    await setLink(c, CLUB_LINK);
    await setStatus(c, "decided");
    const got = await flags([a, b, c]);
    expect(got.size).toBe(3);
    expect([...got.values()].sort()).toEqual(["live", "replay", "replay"]);
    expect(JSON.stringify([...got.entries()])).not.toMatch(/https?:|youtu|twitch|t47|token|uid/i);
  });

  it("SEQUENCE: live -> stop (nothing yet) -> a recording on Cloudflare -> Cloudflare's days pass -> a second session goes live -> it ends", async () => {
    const w = await world(2);
    const f = w.ids[0]!;
    const sid = await live(w.r, f, w.r.seazn);
    expect(await flagOf(f), "going live").toBe("live");
    expect((await routeAnswer(w, f)).live, "the island's own answer agrees: a live to play").not.toBeNull();
    await stopAndSettle(w.r, f, sid);
    expect(await flagOf(f), "stopped, nothing recorded yet: no camera").toBeUndefined();
    expect((await routeAnswer(w, f)).replay, "the island has nothing to play either").toHaveLength(0);
    await seedLockedRecording(sid, 5);
    expect(await flagOf(f), "a recording still on Cloudflare").toBe("replay");
    expect((await routeAnswer(w, f)).replay.length, "the island lists it").toBe(1);
    const [{ created_at }] = await sql<{ created_at: Date }[]>`select created_at from fixture_stream_sessions where id = ${sid}`;
    const afterBound = new Date(new Date(created_at).getTime() + DELETE_RECORDING_AFTER_DAYS * DAY + 1000);
    expect(await flagOf(f, afterBound), "Cloudflare deleted its copy and no host row exists: no camera").toBeUndefined();
    expect((await routeAnswer(w, f, afterBound)).replay, "the island lists nothing either").toHaveLength(0);
    // A SECOND session on the same fixture: live beats the replay it still has.
    const second = await live(w.r, f, w.r.seazn);
    expect(await flagOf(f), "second session live, first recording still there: live wins").toBe("live");
    await stopAndSettle(w.r, f, second);
    expect(await flagOf(f), "second ended: the first recording is still a replay").toBe("replay");
  });

  it("a session that has not gone live (warming) is no live; only the LATEST session counts", async () => {
    const w = await world(2);
    const f = w.ids[0]!;
    const first = await live(w.r, f, w.r.seazn);
    await stopAndSettle(w.r, f, first);
    await seedLockedRecording(first, 5);
    const warming = await goLive(w.r, f, w.r.seazn);
    expect((await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${warming}`)[0]!.state, "PREMISE: the second session is not live").not.toBe("live");
    expect(await flagOf(f), "an earlier live is over; the latest is warming: the replay shows").toBe("replay");
  });

  it("a replay the organiser DELETES stops showing (the interim recording too), and a replay still encoding keeps its interim Cloudflare copy", async () => {
    const w = await world(2);
    const f = w.ids[0]!;
    const moved = await movedReplays(w.r, f, w.host, { parts: 1 });
    expect(await flagOf(f), "playable on the host").toBe("replay");
    expect((await routeAnswer(w, f)).replay.length, "PREMISE/agreement: the island lists it").toBe(1);
    await deleteSeaznReplay(w.r.auth, f, moved.rows[0]!.id, { replay: w.host });
    expect(await flagOf(f), "deleted: the replay row is removed, and no interim recording takes its place").toBeUndefined();
    expect((await routeAnswer(w, f)).replay, "the island lists nothing either").toHaveLength(0);
    // Encoding (no playable row yet): the interim part still plays, so the camera shows.
    const g = w.ids[1]!;
    await movedReplays(w.r, g, w.host, { parts: 1, playable: [] });
    expect(await flagOf(g), "encoding: the interim recording is the replay").toBe("replay");
    expect((await routeAnswer(w, g)).replay.length, "the island lists the interim part").toBe(1);
  });

  it("the batched entries ARE the single read's entries, fixture by fixture (one rule, two shapes)", async () => {
    const w = await world(4);
    await movedReplays(w.r, w.ids[0]!, w.host, { parts: 2 });
    await movedReplays(w.r, w.ids[1]!, w.host, { parts: 1, playable: [] });
    const s2 = await live(w.r, w.ids[2]!, w.r.seazn);
    await stopAndSettle(w.r, w.ids[2]!, s2);
    await seedLockedRecording(s2, 3);
    await seedLockedRecording(s2, 9);
    const many = await readPublicReplayEntriesMany(sql, w.ids);
    expect(many.size, "anti-vacuity: three fixtures have entries, the fourth none").toBe(3);
    let compared = 0;
    for (const id of w.ids) {
      const single = await readReplayEntries(sql, { fixtureId: id, orgId: null });
      expect(many.get(id) ?? [], id).toEqual(single);
      compared += single.length;
    }
    expect(compared, "anti-vacuity: entries compared").toBeGreaterThanOrEqual(5);
    expect((await readPublicReplayEntriesMany(sql, [])).size).toBe(0);
  });

  it("PRIVACY: a private competition and a division still in setup never get a camera, however live", async () => {
    const w = await world(3);
    const [a, b] = w.ids as [string, string, string];
    await live(w.r, a, w.r.seazn);
    await youtubePart(w, b);
    expect((await flags([a, b])).size, "PREMISE: public, both have a camera").toBe(2);
    await sql`update divisions set status = 'setup' where id = ${w.divisionId}`;
    expect((await flags([a, b])).size, "a division still in setup").toBe(0);
    await sql`update divisions set status = 'active' where id = ${w.divisionId}`;
    expect((await flags([a, b])).size, "back to active: they show again").toBe(2);
    await sql`update competitions set visibility = 'private' where id = ${w.competitionId}`;
    expect((await flags([a, b])).size, "a private competition").toBe(0);
    await sql`update competitions set visibility = 'unlisted' where id = ${w.competitionId}`;
    expect((await flags([a, b])).size, "unlisted is public to a link: shows").toBe(2);
  });

  it("ANOTHER SPORT: a cricket fixture reads the same (its own link in play is live, decided is a replay)", async () => {
    const seeded = await seedOrg();
    orgs.push(seeded.auth.orgId);
    const { fixtureId } = await startedCricketDivisionWithFixture(seeded.auth);
    expect((await sql<{ k: string }[]>`select d.sport_key as k from fixtures f join divisions d on d.id = f.division_id where f.id = ${fixtureId}`)[0]!.k, "PREMISE: it is cricket").toBe("cricket");
    expect(await flagOf(fixtureId)).toBeUndefined();
    await setLink(fixtureId, CLUB_LINK);
    await setStatus(fixtureId, "in_play");
    expect(await flagOf(fixtureId)).toBe("live");
    await setStatus(fixtureId, "decided");
    expect(await flagOf(fixtureId)).toBe("replay");
    await setStatus(fixtureId, "cancelled");
    expect(await flagOf(fixtureId), "a void match shows nothing whatever is stored").toBeUndefined();
  });
});

describe.skipIf(!HAS_DB)("the hub document carries the camera through the real builder (the producer -> document seam)", () => {
  it("a built hub puts `stream` on exactly the cards that have one, and the document still parses", async () => {
    const w = await world(4);
    const [liveF, replayF, bareF] = w.ids as [string, string, string, string];
    await live(w.r, liveF, w.r.seazn);
    await setStatus(replayF, "decided");
    await setLink(replayF, CLUB_LINK);
    const [slugs] = await sql<{ org: string; comp: string }[]>`
      select o.slug as org, c.slug as comp from competitions c join organizations o on o.id = c.org_id where c.id = ${w.competitionId}`;
    await sql`update competitions set status = 'live' where id = ${w.competitionId}`;
    const { loadCompetitionHub } = await import("../competition-hub");
    const { CompetitionHubDoc } = await import("../competition-hub-schema");
    const doc = (await loadCompetitionHub(slugs!.org, slugs!.comp, new Date(), { uncached: true }))!;
    expect(doc.matches.length, "anti-vacuity: the hub lists the division's fixtures (4 entrants: 6)").toBeGreaterThanOrEqual(4);
    const byId = new Map(doc.matches.map((m) => [m.fixtureId, m.stream]));
    expect(byId.get(liveF)).toBe("live");
    expect(byId.get(replayF)).toBe("replay");
    expect(byId.get(bareF), "a card with neither: the key is not there at all").toBeUndefined();
    expect(Object.hasOwn(doc.matches.find((m) => m.fixtureId === bareF)!, "stream"), "absent, not undefined-valued: the document is what it was").toBe(false);
    expect(CompetitionHubDoc.safeParse(JSON.parse(JSON.stringify(doc))).success, "the cached round trip parses").toBe(true);
    expect(JSON.stringify(doc), "no address, uid or token in the document because of the camera").not.toContain(CLUB_LINK);
  });
});

// ─── The agreement with the match page ──────────────────────────────────────────────────────────────────────────────────────────────

/** The real page for a fixture of the world (its competition is public). */
async function pageOf(fixtureId: string) {
  const [row] = await sql<{ org: string; comp: string; div: string }[]>`
    select o.slug as org, c.slug as comp, d.slug as div from fixtures f
      join divisions d on d.id = f.division_id join competitions c on c.id = d.competition_id join organizations o on o.id = f.org_id where f.id = ${fixtureId}`;
  const { default: FixturePage } = await import("../../../app/(public)/live/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page");
  const tree = await FixturePage({ params: Promise.resolve({ orgSlug: row!.org, competitionSlug: row!.comp, divisionSlug: row!.div, fixtureId }) });
  return { tree, html: renderToStaticMarkup(tree) };
}
function mounted(node: unknown, type: unknown): boolean {
  if (Array.isArray(node)) return node.some((c) => mounted(c, type));
  if (!isValidElement(node)) return false;
  if (node.type === type) return true;
  return Object.values(node.props as Record<string, unknown>).some((v) => mounted(v, type));
}

describe.skipIf(!HAS_DB)("the camera never shows where the match page has no video and no button (agreement with the real page)", () => {
  it("YouTube side: every status x {no link, the club's link, a link that is the part} x {no part, a part}: a replay camera is on a page that has a player or a button", async () => {
    const w = await world(1);
    const f = w.ids[0]!;
    await streamedElsewhere(w, f);
    const ytId = await youtubePart(w, f);
    await sql`delete from youtube_broadcasts where fixture_id = ${f}`;
    let pages = 0;
    let cameras = 0;
    const gaps: string[] = [];
    for (const parts of [false, true]) {
      await sql`delete from youtube_broadcasts where fixture_id = ${f}`;
      const part = parts ? await youtubePart(w, f) : null;
      for (const link of [null, CLUB_LINK, part === null ? `https://www.youtube.com/watch?v=${ytId}` : `https://www.youtube.com/watch?v=${part}`]) {
        for (const status of FIXTURE_STATUSES) {
          await setStatus(f, status);
          await setLink(f, link);
          const { tree, html } = await pageOf(f);
          const shows = mounted(tree, ReplayEmbed) || html.includes('data-testid="public-stream-link"');
          const camera = await flagOf(f);
          const label = `${status} link=${link === null ? "none" : link === CLUB_LINK ? "club" : "part"} parts=${parts}`;
          pages++;
          if (camera !== undefined) cameras++;
          if (camera === "replay") expect(shows, `${label}: a replay camera needs a player or a button on the page`).toBe(true);
          // The converse, with its one deliberate gap named: the page's "Watch live" button on a match that has not started has no
          // camera yet (nothing is on).
          if (shows && camera === undefined) gaps.push(label);
        }
      }
    }
    expect(pages, "anti-vacuity: pages rendered").toBe(2 * 3 * FIXTURE_STATUSES.length);
    expect(cameras, "and the sweep saw cameras, so 'no camera shows nowhere' is not the whole of it").toBeGreaterThan(10);
    for (const gap of gaps) expect(gap, "the only page with a video slot and no camera is the not-yet-started 'Watch live' button").toMatch(/^scheduled link=(club|part) parts=false$/);
    expect(gaps.length, "anti-vacuity: the named gap was actually reached").toBeGreaterThan(0);
  });

  it("Seazn side: at every step the camera is what the video route offers the island (a live to play, a part to play), and a void status changes neither", async () => {
    const w = await world(2);
    const f = w.ids[0]!;
    const agree = async (label: string) => {
      const answer = await routeAnswer(w, f);
      const camera = await flagOf(f);
      expect(camera, label).toBe(answer.live !== null ? "live" : answer.replay.length > 0 ? "replay" : undefined);
      return camera;
    };
    expect(await agree("nothing yet")).toBeUndefined();
    const sid = await live(w.r, f, w.r.seazn);
    expect(await agree("live")).toBe("live");
    await stopAndSettle(w.r, f, sid);
    expect(await agree("stopped, no recording")).toBeUndefined();
    await seedLockedRecording(sid, 5);
    expect(await agree("recording on Cloudflare")).toBe("replay");
    for (const status of FIXTURE_STATUSES) {
      await setStatus(f, status);
      expect(await agree(`status ${status}`), `status ${status}: the island lists its parts whatever the status`).toBe("replay");
    }
    expect((await seaznReplayPartNos(f, new Date())).length, "the plan's own numbering agrees").toBe(1);
  });

  it("the ruling's reach, stated: only a live the page can PLAY has a camera (Seazn, or the club's own link in play); a pasted-key or YouTube live alone has none", async () => {
    const w = await world(2);
    const [f, g] = w.ids as [string, string];
    // A pasted-key (YouTube-kind) live, no club link: the page has no player and no button, so no camera.
    const pastedSid = await live(w.r, f, w.r.pasted);
    expect(
      (await sql<{ state: string; k: string }[]>`select state, destination_kind as k from fixture_stream_sessions where id = ${pastedSid}`).map((x) => `${x.k}:${x.state}`),
      "PREMISE: the session is a live on a YouTube-kind destination",
    ).toEqual(["youtube:live"]);
    expect(await flagOf(f), "pasted-key live, no link: no camera").toBeUndefined();
    const bare = await pageOf(f);
    expect(mounted(bare.tree, ReplayEmbed), "the page has no YouTube player for a live").toBe(false);
    expect(bare.html, "and no club link button (none saved)").not.toContain('data-testid="public-stream-link"');
    // With the club's link saved and the match in play, the page shows the "Watch live" button, and the camera follows it.
    await setStatus(f, "in_play");
    await setLink(f, CLUB_LINK);
    expect((await pageOf(f)).html, "the button is there").toContain('data-testid="public-stream-link"');
    expect(await flagOf(f), "the same live with the club's link and the match in play: camera").toBe("live");
    // A Seazn live on another fixture: the camera, and the page plays it (the island is mounted).
    await live(w.r, g, w.r.seazn);
    expect(await flagOf(g), "a Seazn live: camera").toBe("live");
    expect(mounted((await pageOf(g)).tree, SeaznVideoIsland), "the page mounts the Seazn player for it").toBe(true);
  });
});

// LAST in the file on purpose: it resets the module registry (to stand a failing reader in), which would split any later test's component
// identities from the page's.
describe.skipIf(!HAS_DB)("a failing stream read is no camera, never a hub-down (T47)", () => {
  it("the hub is still built, with no card carrying a camera, and the failure is logged by competition", async () => {
    const w = await world(2);
    await live(w.r, w.ids[0]!, w.r.seazn);
    const [slugs] = await sql<{ org: string; comp: string }[]>`
      select o.slug as org, c.slug as comp from competitions c join organizations o on o.id = c.org_id where c.id = ${w.competitionId}`;
    await sql`update competitions set status = 'live' where id = ${w.competitionId}`;
    vi.resetModules();
    vi.doMock("../hub-stream-flags", () => ({ readHubStreamFlags: async () => { throw new Error("stream read down"); } }));
    try {
      const { loadCompetitionHub } = await import("../competition-hub");
      const { log } = await import("@/server/logger");
      const warn = vi.spyOn(log, "warn");
      const doc = await loadCompetitionHub(slugs!.org, slugs!.comp, new Date(), { uncached: true });
      expect(doc, "the hub is built").not.toBeNull();
      expect(doc!.matches.length, "anti-vacuity: with cards").toBeGreaterThan(0);
      expect(doc!.matches.some((m) => m.stream !== undefined), "no camera on any card").toBe(false);
      expect(warn.mock.calls.some((c) => String(c[1]).includes("stream flags read failed")), "and the failure is reported").toBe(true);
    } finally {
      vi.doUnmock("../hub-stream-flags");
      vi.resetModules();
    }
  });
});
