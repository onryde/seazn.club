// Seazn-hosted video, Phase 1 Task 15 (e2e): a public match with a Seazn session behind it, for the specs that look at the match
// page's player (public-fixture.spec.ts at 320 / 768 / 1280, mobile/public-pages.spec.ts in the seven width projects).
//
// WHAT IS SEEDED, AND WHY IT IS NOT A REAL "Go live". The competition, division, entrants and fixture are made through the real API
// (the sponsor rig's own shape). The SESSION is a row written by SQL: a started Seazn session needs a paired phone, a stream slot of
// the fake ingest's shared storage pool (stream-slot-pool.ts: only the walkthrough leg holds one) and, for a Seazn destination,
// SEAZN_HOSTED_LIVE=true and SEAZN_VIDEO_ORIGINS in the SERVER's env, none of which the default e2e job sets. A fake-driver Seazn run
// that really does Go live (streaming-destinations.spec.ts case 11) therefore needs SEAZN_VIDEO_ORIGINS on the server beside the flag.
// The row is the producer's output, and the producer is proved against the real route in vitest (server/video/__tests__/seazn-video
// .test.ts drives `createSession`, the Machine's beat and Stop and reads the answer back). What these specs prove is everything AFTER the
// row: the page (the plan sees a Seazn session whatever LIVE is), the island, the REAL route and the REAL (fake-driver) signer, and the
// player in a browser. The signed address is therefore the server's own (`https://playback.fake.invalid/fake.<uid>.<exp>/manifest/...`).
//
// The two moments an organiser's Go live passes through are two calls: `seedSeaznMatch` leaves the session WARMING (the route answers
// no live: the island holds the player's box with its one quiet line, re-capture R2), and `goLive` is the Machine's beat (state `live`, with the programme input's uid
// the route signs). `finishSeaznMatch` completes the row, so a shared org is never left with a live session.
//
// Task 17 (Match Day): the same row on a fixture the CALLER already made (`seedSeaznSession`: Match Day's seed places and starts its own
// matches, in the courts it names), so the spec drives the board's own court and the organiser's own video route, not a public page.
import { expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { activeOrg, addEntrantsViaApi, apiJson, createStageAndGenerate, setOrgPlanBySql, withDb } from "../helpers";
import { routes } from "../../src/lib/routes";
import { FAKE_REPLAY_EMBED_HOST } from "../../src/server/relay/config";
import { FAKE_REPLAY_LENGTH_SECONDS, FAKE_REPLAY_LIBRARY_ID } from "../../src/server/video/replay-fake";

/** A Seazn session row and the uid its programme input will carry once live (`goLive`). */
export interface SeaznSession {
  sessionId: string;
  /** The programme input's uid the signer is given (written by `goLive`); it is the middle of the signed address. */
  programmeUid: string;
}

export interface SeaznMatch extends SeaznSession {
  orgId: string;
  fixtureId: string;
  publicPath: string;
  /** Task 26: the organiser's fixture page (its Stream panel lists the Seazn replays). */
  fixturePath: string;
}

/** The address the fake driver signs for a programme uid: `https://<fake host>/fake.<uid>.<exp seconds>/manifest/video.m3u8`
 *  (fakes.ts `playbackToken`, cf-playback.ts). Read from the server's own declarations by the caller, never retyped here beyond the
 *  uid, which this file writes. */
export const signedAddressPattern = (uid: string): RegExp =>
  new RegExp(`^https://playback\\.fake\\.invalid/fake\\.${uid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+/manifest/video\\.m3u8$`);

export async function seedSeaznMatch(page: Page, o: { name: string; ensurePro?: boolean; live?: boolean }): Promise<SeaznMatch> {
  const request = page.request;
  const org = await activeOrg(page);
  // A fresh org is on community, whose public-dashboard cap quietly turns a public competition private: Pro first where the org is the
  // test's own. The shared Pro org is already there.
  if (o.ensurePro) await setOrgPlanBySql({ orgId: org.id }, "pro");
  const comp = await apiJson<{ id: string; slug: string; visibility: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: o.name,
    visibility: "public",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  expect(comp.data!.visibility, "premise: the competition is public").toBe("public");
  const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open",
    sport_key: "badminton",
    variant_key: "bwf",
  });
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  expect((await addEntrantsViaApi(request, div.data!.id, ["Seazn One", "Seazn Two"])).status).toBe(201);
  const { fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "League" });
  expect(fixtureIds.length, "a two-entrant league seats one fixture").toBe(1);
  expect((await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST")).status).toBeLessThan(300);
  const fixtureId = fixtureIds[0]!;

  const session = await seedSeaznSession(org.id, fixtureId);
  const [fixture] = await withDb((sql) => sql<{ no: number }[]>`select fixture_no as no from fixtures where id = ${fixtureId}`);
  expect(typeof fixture?.no, "premise: the fixture has its number").toBe("number");
  const match: SeaznMatch = {
    orgId: org.id,
    fixtureId,
    ...session,
    publicPath: routes.publicFixture(org.slug, comp.data!.slug, div.data!.slug, fixtureId),
    fixturePath: `/o/${org.slug}/c/${comp.data!.slug}/d/${div.data!.slug}/f/${fixture!.no}`,
  };
  if (o.live) await goLive(match);
  return match;
}

/** A WARMING Seazn session on a fixture that already exists (the org's own Seazn destination, V541), for `goLive` to bring on air. The
 *  row is the producer's output; the producer is proved in vitest (see above). */
export async function seedSeaznSession(orgId: string, fixtureId: string): Promise<SeaznSession> {
  const sessionId = await withDb(async (sql) => {
    const [target] = await sql<{ id: string }[]>`select id from org_stream_targets where org_id = ${orgId} and kind = 'seazn'`;
    expect(target, "premise: the org has its Seazn destination (V541)").toBeTruthy();
    const [owner] = await sql<{ user_id: string }[]>`select user_id from org_members where org_id = ${orgId} and role = 'owner' limit 1`;
    expect(owner, "premise: the org has an owner").toBeTruthy();
    const [s] = await sql<{ id: string }[]>`
      insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, sport_key, competition_id, division_id, entitlement_via_override, destination_kind)
      select f.id, ${orgId}, 'composed', 'warming', ${target!.id}, ${owner!.user_id}, d.sport_key, d.competition_id, f.division_id, true, 'seazn'
        from fixtures f join divisions d on d.id = f.division_id where f.id = ${fixtureId}
      returning id`;
    expect(s, "premise: the session row was written").toBeTruthy();
    return s!.id;
  });
  return { sessionId, programmeUid: `e2e-programme-${randomBytes(6).toString("hex")}` };
}

/** The Machine's playing beat: the session is live and its programme input has the uid the route signs. */
export async function goLive(m: SeaznSession): Promise<void> {
  await withDb(async (sql) => {
    await sql`insert into fixture_stream_inputs (session_id, slot, role, ingest_input_id) values (${m.sessionId}, 0, 'programme', ${m.programmeUid})`;
    await sql`update fixture_stream_sessions set state = 'live', started_at = now() where id = ${m.sessionId}`;
  });
}

/** The session ends (a shared org must not keep a live Seazn session). Safe to call twice. */
export async function finishSeaznMatch(m: SeaznSession): Promise<void> {
  await withDb((sql) => sql`
    update fixture_stream_sessions set state = 'completed', end_reason = 'stopped', ended_at = now()
     where id = ${m.sessionId} and state not in ('completed', 'failed')`);
}

/** `n` recordings locked under the session's programme input, the row the stream tick's Seazn pass writes (V540: uid, input, lock time),
 *  in lock order, the first the oldest. The pass itself is proved in vitest (seazn-recordings.test.ts) and by the walkthrough's own tick
 *  (walkthrough/seazn-hosted.spec.ts step 7); what the specs that use this prove is what the PAGE does once a recording exists. The route
 *  lists only a TERMINAL session's recordings, so `finishSeaznMatch` first. Each is READY (`ready_at` set, Task 39): Cloudflare can play
 *  it, which is the only kind the route offers. Returns the video ids. */
export async function lockRecordings(m: SeaznSession, n: number): Promise<string[]> {
  return withDb(async (sql) => {
    const [input] = await sql<{ id: string }[]>`select id from fixture_stream_inputs where session_id = ${m.sessionId} and role = 'programme'`;
    expect(input, "premise: the session has its programme input (`goLive` writes it)").toBeTruthy();
    const ids = Array.from({ length: n }, (_, i) => `e2e-recording-${randomBytes(6).toString("hex")}-${i + 1}`);
    for (const [i, videoId] of ids.entries()) {
      await sql`insert into seazn_locked_videos (cf_video_id, input_row_id, locked_at, ready_at) values (${videoId}, ${input!.id}, now() - ${(n - i) * 60_000} * interval '1 millisecond', now() - ${(n - i) * 60_000} * interval '1 millisecond')`;
    }
    return ids;
  });
}

/** A manifest the player will accept: one 10 s VOD segment, so hls.js parses it and, with loading held until the viewer presses play,
 *  asks for nothing more. Served in place of the fake host (`playback.fake.invalid` never resolves). */
export const STUB_MANIFEST = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\nseg0.ts\n#EXT-X-ENDLIST\n";

const FAKE_HOST_URL = /^https:\/\/playback\.fake\.invalid\//;
const CORS = { "access-control-allow-origin": "*" };

/** Answers the fake playback host (it never resolves) the way a Stream customer host answers a manifest, and records every request
 *  made to it. `healthy()` turns it from refusing (503) to serving; it starts healthy. This is the browser's stand-in for Cloudflare
 *  ONLY: the signed ADDRESS under test is the real server's, and the request URL is what the specs assert. */
export async function stubFakePlaybackHost(page: Page, o: { healthy?: boolean } = {}): Promise<{ requests: string[]; healthy: (on: boolean) => void }> {
  const requests: string[] = [];
  let up = o.healthy ?? true;
  await page.route(FAKE_HOST_URL, async (route) => {
    requests.push(route.request().url());
    if (!up) return route.fulfill({ status: 503, headers: CORS, body: "unavailable" });
    return route.fulfill({ status: 200, contentType: "application/vnd.apple.mpegurl", headers: CORS, body: STUB_MANIFEST });
  });
  return { requests, healthy: (on) => void (up = on) };
}

/** Does THIS browser play HLS itself (so the page gives it the address through `video.src` and loads no hls.js)? Chromium's answer
 *  depends on its build, so the specs assert both paths rather than assume one. */
export const playsHlsNatively = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.createElement("video").canPlayType("application/vnd.apple.mpegurl") !== "");

/** Task 25: the replay move's PLAYABLE copy of each locked recording (`lockRecordings`), as the move leaves it (V542's
 *  `fixture_video_replays` row: the recording's uid, a Bunny video, verified, the fake's length), parts 1..n in the order given (the
 *  recording order). The move itself is proved in vitest (seazn-replays.test.ts and seazn-video-replays.test.ts drive discovery and
 *  the move onto the replay fake, across a stop and a restart); what the specs that use this prove is what the PAGE does with a
 *  playable copy. The session must have ended (`finishSeaznMatch`). Returns the Bunny video ids, part 1 first. */
export async function seedPlayableReplays(m: SeaznMatch, recordingIds: readonly string[]): Promise<string[]> {
  return withDb(async (sql) => {
    const [ended] = await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${m.sessionId}`;
    expect(ended?.state, "premise: the session has ended (`finishSeaznMatch`)").toBe("completed");
    const ids: string[] = [];
    for (const [i, cfVideoId] of recordingIds.entries()) {
      const bunnyId = `e2e-bunny-${randomBytes(6).toString("hex")}-${i + 1}`;
      const [row] = await sql<{ id: string }[]>`
        insert into fixture_video_replays (org_id, session_id, fixture_id, cf_video_id, recorded_at, part_no, state, bunny_video_id, verified_at, length_seconds)
        select ${m.orgId}, ${m.sessionId}, ${m.fixtureId}, v.cf_video_id, v.locked_at, ${i + 1}, 'playable', ${bunnyId}, now(), ${FAKE_REPLAY_LENGTH_SECONDS}
          from seazn_locked_videos v where v.cf_video_id = ${cfVideoId}
        returning id`;
      expect(row, `premise: recording ${i + 1} is locked (\`lockRecordings\`)`).toBeTruthy();
      ids.push(bunnyId);
    }
    return ids;
  });
}

/** The address the fake replay host signs for a Bunny video: `https://embed.fake.invalid/embed/<library>/<video>?token=<64 hex>&expires=<s>`
 *  (replay-fake.ts `signedEmbed`, from its own declarations). */
export const signedEmbedPattern = (bunnyId: string): RegExp =>
  new RegExp(`^https://${FAKE_REPLAY_EMBED_HOST.replace(/\./g, "\\.")}/embed/${FAKE_REPLAY_LIBRARY_ID}/${bunnyId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?token=[0-9a-f]{64}&expires=\\d+$`);

/** Answers the fake replay host's embed page (`embed.fake.invalid` never resolves) with a blank page, and records every request made
 *  to it. The browser's stand-in for the host ONLY: the signed address under test is the real server's. */
export async function stubFakeEmbedHost(page: Page): Promise<{ requests: string[] }> {
  const requests: string[] = [];
  await page.route(new RegExp(`^https://${FAKE_REPLAY_EMBED_HOST.replace(/\./g, "\\.")}/`), async (route) => {
    requests.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>replay</title><body style=\"margin:0;background:#000\"></body>" });
  });
  return { requests };
}
