// Seazn-hosted video, Phase 1 Task 14 (spec G5, §5.1; recommendation 2026-11-21 G-B): a fixture's Seazn video, as the
// player reads it. `live` is the fixture's LATEST session when it is a Seazn session in state `live`: its programme input's
// signed HLS. `replay` (the interim, until Task 25's Bunny embed) is every recording Task 13 has LOCKED (`seazn_locked_videos`)
// of the fixture's ENDED Seazn sessions, in `locked_at` order, numbered 1..n, each its signed HLS. The public read answers
// nothing for a fixture the public cannot see (public_fixtures_v plus a division past setup: `replayParts`' redaction); the
// organiser's read is org-scoped and covers private competitions. The flags are not read (controller ruling 2026-11-20).
//
// Every session comes from a REAL producer: the organiser's Go live (`createSession`), the Machine's playing beat, and Stop.
// Every locked row comes from the REAL Seazn pass (`lockSeaznRecordings`) over the fake's recordings, except one row seeded
// by hand under a YouTube session's input, to prove the read refuses it even if a row ever existed. The fake mints
// `fake.<uid>.<exp s>` (fakes.test.ts), so a token read back says which uid was signed. The URL shape is Cloudflare's (C1),
// typed here from the plan, never read off the module.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the read never reads a sport rule; every rig rides `generic`.
// Secrets: the fake's tokens are not secret, and nothing here logs one.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

import { sql } from "@/lib/db";
import { PublicFixtureVideo } from "@/server/api-v1/schemas";
import { RelayDriversDisabled, disabledRelayDrivers, setRelayDriversForTest } from "@/server/relay/drivers";
import { FakeIngest, FakeRecorder, FakeRunner } from "@/server/relay/fakes";
import { pairPresentPhone, rigUser } from "@/server/relay/__tests__/_session-rig";
import { lockSeaznRecordings } from "@/server/usecases/seazn-recordings";
import { grantCredits } from "@/server/usecases/stream-credits";
import { type SessionDeps, createSession, currentSession, heartbeat, stopSession } from "@/server/usecases/stream-sessions";
import { createStreamTarget } from "@/server/usecases/stream-targets";
import { override } from "@/server/usecases/__tests__/_capture-rig";
import { seedOrg, startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { createPlaybackTokenCache } from "../cf-playback";
import { seaznFixtureVideo, seaznFixtureVideoForOrg } from "../seazn-video";

const HAS_DB = !!process.env.DATABASE_URL;
const ROOMY_STORAGE_MINUTES = 100_000_000;
/** Cloudflare's signed manifest (C1, plan Task 14): the token is ONE path segment, and there is no query string. */
const PLAY = /^https:\/\/playback\.fake\.invalid\/([^/?]+)\/manifest\/video\.m3u8$/;
/** The plan's live token life (Task 8: 1 h), typed here. */
const TTL_SECONDS = 3600;
const EMPTY = { live: null, replay: [] };

const ENV_KEYS = ["RELAY_KEK", "YOUTUBE_TOKEN_KEK", "RELAY_IMAGE", "AUTH_SECRET"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeAll(() => {
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex");
  process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:seazn-video-test";
  process.env.AUTH_SECRET ??= "seazn-video-test-secret";
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
beforeEach(() => {
  vi.stubEnv("SEAZN_HOSTED_LIVE", "true");
  vi.stubEnv("SEAZN_VIDEO_ORIGINS", "seazn.club");
  // The fake relay with no STREAM_PLAYBACK_HOST: the host is the fake driver's own (config.ts FAKE_PLAYBACK_HOST).
  vi.stubEnv("RELAY_DRIVERS", "");
  vi.stubEnv("STREAM_PLAYBACK_HOST", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  setRelayDriversForTest(null);
});

type Clock = { now: number };
/** An org with two started public fixtures, the relay entitlements, credits, a phone on each fixture, a pasted YouTube key and
 *  its Seazn row (V540's trigger). `playback` signs through the rig's own fake and a cache of its own. */
async function rig() {
  const seeded = await seedOrg();
  const auth = { ...seeded.auth, userId: await rigUser() };
  const { fixtureIds } = await startedDivisionWithFixture(auth, { fixtures: 2 });
  await override(auth.orgId, "streaming.overlay", true);
  await override(auth.orgId, "streaming.relay", true);
  for (const f of fixtureIds) await pairPresentPhone(f);
  await grantCredits({ orgId: auth.orgId, delta: 8, createdBy: await rigUser(), note: "seazn video", idempotencyKey: randomUUID() });
  const pasted = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "Club", streamKey: `yt-${randomUUID()}` });
  const [seazn] = await sql<{ id: string }[]>`select id from org_stream_targets where org_id = ${auth.orgId} and kind = 'seazn'`;
  expect(seazn, "PREMISE: V540 gave the org its Seazn destination").toBeDefined();
  const clock: Clock = { now: Date.now() };
  const ingest = new FakeIngest({ clock: () => clock.now, connectAfterMs: 3000, recorder: new FakeRecorder() });
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
  const runner = new FakeRunner();
  const deps: SessionDeps = { drivers: { ingest, runner }, now: () => new Date(clock.now), appUrl: "http://app.test" };
  const playback = { ingest, tokenCache: createPlaybackTokenCache() };
  const mint = vi.spyOn(ingest, "playbackToken");
  return { auth, fixtureIds: fixtureIds as [string, string], pasted: pasted.id, seazn: seazn!.id, ingest, runner, clock, deps, playback, mint };
}
type Rig = Awaited<ReturnType<typeof rig>>;

const stateOf = async (sid: string) => (await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${sid}`)[0]!.state;
/** Go live on `targetId` (composed) up to the Machine being created: the session waits for its playing beat. */
async function goLive(r: Rig, fixtureId: string, targetId: string): Promise<string> {
  await pairPresentPhone(fixtureId, { at: r.deps.now() });
  const { sessionId } = await createSession(r.auth, fixtureId, { mode: "composed", targetId }, r.deps);
  return sessionId;
}
/** The Machine's playing beat, which takes the session live. */
async function playing(r: Rig, sid: string): Promise<void> {
  const spec = r.runner.created.find((c) => c.sessionId === sid);
  expect(spec, `PREMISE: a Machine was created for ${sid}`).toBeDefined();
  await heartbeat(sid, spec!.jobToken, { state: "playing" }, r.deps);
  expect(await stateOf(sid), "PREMISE: the session is live").toBe("live");
}
const live = async (r: Rig, fixtureId: string, targetId: string): Promise<string> => {
  const sid = await goLive(r, fixtureId, targetId);
  await playing(r, sid);
  return sid;
};
/** Stop, then read until the composed session has completed. */
async function stopAndSettle(r: Rig, fixtureId: string, sid: string): Promise<void> {
  await stopSession(r.auth, fixtureId, sid, r.deps);
  for (let i = 0; i < 3 && (await stateOf(sid)) !== "completed"; i++) await currentSession(r.auth, fixtureId, r.deps);
  expect(await stateOf(sid), "PREMISE: the stopped session completed").toBe("completed");
}
async function programmeOf(sid: string): Promise<{ id: string; uid: string }> {
  const [row] = await sql<{ id: string; uid: string }[]>`
    select id, ingest_input_id as uid from fixture_stream_inputs where session_id = ${sid} and role = 'programme'`;
  expect(row?.uid, `PREMISE: the programme input of ${sid} has a uid`).toBeTruthy();
  return row!;
}
/** A finished recording of `sid`'s programme input, made by the fake, as Cloudflare's listing would answer it. */
async function finishedRecording(r: Rig, sid: string, videoId = `v-${randomUUID()}`): Promise<string> {
  const prog = await programmeOf(sid);
  r.ingest.addVideo({ videoId, inputId: prog.uid, createdAt: new Date(r.clock.now).toISOString(), inProgress: false });
  return videoId;
}
/** The real Seazn pass, scoped to this rig's org. */
const lockPass = (r: Rig) => lockSeaznRecordings(r.deps, { now: new Date(r.clock.now), budgetMs: 8_000, orgIds: [r.auth.orgId] });
const lockedIds = async (sid: string) =>
  (await sql<{ cf_video_id: string }[]>`
    select v.cf_video_id from seazn_locked_videos v join fixture_stream_inputs i on i.id = v.input_row_id
     where i.session_id = ${sid} order by v.cf_video_id`).map((x) => x.cf_video_id);
const competitionOf = async (fixtureId: string) =>
  (await sql<{ competition_id: string; division_id: string }[]>`
    select d.competition_id, f.division_id from fixtures f join divisions d on d.id = f.division_id where f.id = ${fixtureId}`)[0]!;

/** The token in a signed manifest URL; fails unless the URL has Cloudflare's shape. */
function tokenOf(src: string): string {
  const m = PLAY.exec(src);
  expect(m, `a signed manifest URL: ${src}`).not.toBeNull();
  return m![1]!;
}
/** Which uid a fake token was minted for: `fake.<uid>.<exp s>` (no uid here holds a dot). */
const signedUid = (src: string): string => {
  const parts = tokenOf(src).split(".");
  expect(parts, `a fake token: ${src}`).toHaveLength(3);
  return parts[1]!;
};

const read = (r: Rig, fixtureId: string) => seaznFixtureVideo(fixtureId, new Date(r.clock.now), r.playback);
const readOrg = (r: Rig, fixtureId: string) => seaznFixtureVideoForOrg(r.auth.orgId, fixtureId, new Date(r.clock.now), r.playback);

describe.skipIf(!HAS_DB)("seaznFixtureVideo — a fixture's Seazn video for the player", () => {
  it("a Seazn session that is LIVE gives live.src: the PROGRAMME input's signed HLS, expiring 1 h after now; no replay; the org read agrees and both fit the wire schema", async () => {
    const r = await rig();
    const sid = await live(r, r.fixtureIds[0], r.seazn);
    const prog = await programmeOf(sid);
    const answer = await read(r, r.fixtureIds[0]);
    expect(answer.replay).toEqual([]);
    expect(answer.live).not.toBeNull();
    expect(answer.live!.src).toMatch(PLAY);
    expect(signedUid(answer.live!.src), "the programme input is signed, never the camera").toBe(prog.uid);
    expect(answer.live!.expiresAt).toBe(new Date((Math.floor(r.clock.now / 1000) + TTL_SECONDS) * 1000).toISOString());
    expect(PublicFixtureVideo.parse(answer), "the producer's answer is the published contract").toEqual(answer);
    expect(await readOrg(r, r.fixtureIds[0])).toEqual(answer);
    // The OTHER fixture of the same org streams nothing: its answer is empty, and nothing was signed for it.
    const before = r.mint.mock.calls.length;
    expect(await read(r, r.fixtureIds[1])).toEqual(EMPTY);
    expect(r.mint.mock.calls.length, "an empty fixture mints nothing").toBe(before);
  });

  it("live is null for every other state of the latest session, in its real order: warming (before the playing beat), then live, then ending (Stop), then completed", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await goLive(r, f, r.seazn);
    expect(await stateOf(sid), "PREMISE: before the playing beat the session is warming").toBe("warming");
    expect(await read(r, f), "warming").toEqual(EMPTY);
    await playing(r, sid);
    expect((await read(r, f)).live, "live").not.toBeNull();
    await stopSession(r.auth, f, sid, r.deps);
    expect(await stateOf(sid), "PREMISE: Stop leaves the composed session ending").toBe("ending");
    expect(await read(r, f), "ending").toEqual(EMPTY);
    await stopAndSettle(r, f, sid);
    expect(await read(r, f), "completed, with nothing locked").toEqual(EMPTY);
  });

  it("a YouTube (pasted key) session never plays here: live is null while it is live, and its recording is never listed — even under a seazn_locked_videos row", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.pasted);
    const [{ destination_kind }] = await sql<{ destination_kind: string }[]>`select destination_kind from fixture_stream_sessions where id = ${sid}`;
    expect(destination_kind, "PREMISE: a pasted key is an external destination").not.toBe("seazn");
    expect(await read(r, f)).toEqual(EMPTY);
    await stopAndSettle(r, f, sid);
    // Task 13 never locks a non-Seazn recording; a row is put here by hand so the read's own filter is what refuses it.
    const prog = await programmeOf(sid);
    await sql`insert into seazn_locked_videos (cf_video_id, input_row_id) values (${`v-yt-${randomUUID()}`}, ${prog.id})`;
    expect(await read(r, f)).toEqual(EMPTY);
    expect(await readOrg(r, f)).toEqual(EMPTY);
    expect(r.mint, "nothing is signed for a YouTube session").not.toHaveBeenCalled();
  });

  it("interim replay (G-B): a completed Seazn session's recording is listed only once the Seazn pass has LOCKED it — then one part, partNo 1, hls, the RECORDING's signed HLS", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.seazn);
    await stopAndSettle(r, f, sid);
    const rec = await finishedRecording(r, sid);
    expect(r.ingest.videoAccess(rec), "PREMISE: the recording is still unsigned (C3)").toBe(false);
    expect(await read(r, f), "not yet locked: never an unsigned recording").toEqual(EMPTY);
    expect(await lockPass(r)).toMatchObject({ locked: 1 });
    expect(await lockedIds(sid), "PREMISE: the pass wrote the row").toEqual([rec]);
    const answer = await read(r, f);
    expect(answer.live).toBeNull();
    expect(answer.replay).toHaveLength(1);
    expect(answer.replay[0]).toMatchObject({ partNo: 1, player: "hls" });
    expect(answer.replay[0]!.src).toMatch(PLAY);
    expect(signedUid(answer.replay[0]!.src), "the recording is signed, never the input").toBe(rec);
    expect(answer.replay[0]!.expiresAt).toBe(new Date((Math.floor(r.clock.now / 1000) + TTL_SECONDS) * 1000).toISOString());
    expect(PublicFixtureVideo.parse(answer)).toEqual(answer);
    expect(await readOrg(r, f)).toEqual(answer);
    // A CAMERA recording is the raw feed, never the match: Task 13 locks only the programme, so a row is put here by hand and
    // the read's own role filter is what refuses it.
    const [camera] = await sql<{ id: string }[]>`select id from fixture_stream_inputs where session_id = ${sid} and role = 'camera'`;
    expect(camera, "PREMISE: a composed session has a camera input").toBeDefined();
    await sql`insert into seazn_locked_videos (cf_video_id, input_row_id) values (${`v-cam-${randomUUID()}`}, ${camera!.id})`;
    expect(await read(r, f), "a locked camera recording is never a part").toEqual(answer);
    expect(await readOrg(r, f)).toEqual(answer);
  });

  it("a Seazn recording that is locked while its session is still LIVE is not a replay yet: the live plays, and the part appears once the session has ended", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.seazn);
    // A reconnect: Cloudflare finishes one recording mid-session, and the pass locks it while the session is still live.
    const rec = await finishedRecording(r, sid);
    expect(await lockPass(r)).toMatchObject({ locked: 1 });
    const during = await read(r, f);
    expect(during.live).not.toBeNull();
    expect(during.replay, "the session is not over").toEqual([]);
    await stopAndSettle(r, f, sid);
    expect((await read(r, f)).replay.map((p) => signedUid(p.src))).toEqual([rec]);
  });

  it("parts follow locked_at, numbered 1..n — not the uid order and not the order the rows were written", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.seazn);
    await stopAndSettle(r, f, sid);
    // Named so the uid order is the REVERSE of the order the recordings were locked in.
    const early = await finishedRecording(r, sid, `v-z-${randomUUID()}`);
    const late = await finishedRecording(r, sid, `v-a-${randomUUID()}`);
    expect(await lockPass(r)).toMatchObject({ locked: 2 });
    await sql`update seazn_locked_videos set locked_at = now() - interval '2 minutes' where cf_video_id = ${early}`;
    await sql`update seazn_locked_videos set locked_at = now() - interval '1 minute' where cf_video_id = ${late}`;
    const parts = (await read(r, f)).replay;
    expect(parts.map((p) => [p.partNo, signedUid(p.src)])).toEqual([[1, early], [2, late]]);
    // Swap the times: the numbers follow.
    await sql`update seazn_locked_videos set locked_at = now() - interval '3 minutes' where cf_video_id = ${late}`;
    expect((await read(r, f)).replay.map((p) => [p.partNo, signedUid(p.src)])).toEqual([[1, late], [2, early]]);
  });

  it("a stop and restart: the first session completed with a locked recording and the second live gives BOTH the second's live and the first's part", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const first = await live(r, f, r.seazn);
    await stopAndSettle(r, f, first);
    const rec = await finishedRecording(r, first);
    expect(await lockPass(r)).toMatchObject({ locked: 1 });
    const second = await live(r, f, r.seazn);
    const answer = await read(r, f);
    expect(signedUid(answer.live!.src), "the live is the SECOND session's programme input").toBe((await programmeOf(second)).uid);
    expect(answer.replay.map((p) => [p.partNo, p.player, signedUid(p.src)])).toEqual([[1, "hls", rec]]);
  });

  it("a private competition: the public read answers nothing — live or replay — and the org read answers both", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const first = await live(r, f, r.seazn);
    await stopAndSettle(r, f, first);
    const rec = await finishedRecording(r, first);
    expect(await lockPass(r)).toMatchObject({ locked: 1 });
    await live(r, f, r.seazn);
    const { competition_id } = await competitionOf(f);
    expect((await read(r, f)).live, "PREMISE: public, it plays").not.toBeNull();
    await sql`update competitions set visibility = 'private' where id = ${competition_id}`;
    expect(await read(r, f)).toEqual(EMPTY);
    const org = await readOrg(r, f);
    expect(org.live, "the organiser still sees the live").not.toBeNull();
    expect(org.replay.map((p) => signedUid(p.src)), "and the part").toEqual([rec]);
    // Unlisted is public to whoever has the link (public_fixtures_v).
    await sql`update competitions set visibility = 'unlisted' where id = ${competition_id}`;
    expect(await read(r, f)).toEqual(org);
  });

  it("a division back in setup answers nothing publicly (replayParts' redaction), and the org read is unchanged", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    await live(r, f, r.seazn);
    const { division_id } = await competitionOf(f);
    expect((await read(r, f)).live, "PREMISE: an active division plays").not.toBeNull();
    await sql`update divisions set status = 'setup' where id = ${division_id}`;
    expect(await read(r, f)).toEqual(EMPTY);
    expect((await readOrg(r, f)).live).not.toBeNull();
  });

  it("the org read is scoped: another organisation asking about this fixture gets nothing", async () => {
    const r = await rig();
    const other = await rig();
    const f = r.fixtureIds[0];
    await live(r, f, r.seazn);
    expect(await seaznFixtureVideoForOrg(other.auth.orgId, f, new Date(r.clock.now), r.playback)).toEqual(EMPTY);
    expect((await readOrg(r, f)).live).not.toBeNull();
    // Owning the fixture is not owning every row on it: a session that names ANOTHER organisation (no constraint ties the two
    // org ids together; put there by hand) is not this organisation's to read. The public read is not org-scoped and still sees it.
    await sql`update fixture_stream_sessions set org_id = ${other.auth.orgId} where fixture_id = ${f}`;
    expect(await readOrg(r, f), "a session of another organisation").toEqual(EMPTY);
    // And the other way round: a session naming the other organisation does not make the FIXTURE theirs.
    expect(await seaznFixtureVideoForOrg(other.auth.orgId, f, new Date(r.clock.now), r.playback), "not their fixture").toEqual(EMPTY);
    expect((await read(r, f)).live, "PREMISE: the session itself is still live").not.toBeNull();
  });

  it("an unknown fixture and a malformed id answer the empty video (no error, no oracle)", async () => {
    const r = await rig();
    for (const id of [randomUUID(), "not-a-uuid", "", "'; select 1; --"]) {
      expect(await read(r, id), JSON.stringify(id)).toEqual(EMPTY);
      expect(await readOrg(r, id), JSON.stringify(id)).toEqual(EMPTY);
    }
    expect(r.mint).not.toHaveBeenCalled();
  });

  it("LIVE off (controller ruling): a Seazn session that already exists keeps playing — its live, and after it ends its part", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.seazn);
    vi.stubEnv("SEAZN_HOSTED_LIVE", "false");
    expect((await read(r, f)).live?.src).toMatch(PLAY);
    await stopAndSettle(r, f, sid);
    const rec = await finishedRecording(r, sid);
    expect(await lockPass(r)).toMatchObject({ locked: 1 });
    expect((await read(r, f)).replay.map((p) => signedUid(p.src))).toEqual([rec]);
  });

  it("a live Seazn session whose programme input has no uid has no live (nothing to sign), and mints nothing", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.seazn);
    await sql`update fixture_stream_inputs set ingest_input_id = null where session_id = ${sid} and role = 'programme'`;
    expect(await read(r, f)).toEqual(EMPTY);
    expect(r.mint).not.toHaveBeenCalled();
  });

  it("production wiring: with no deps the read signs through the process relay; a relay-disabled process answers an empty fixture without touching it, and refuses BY NAME when there is something to sign", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    await live(r, f, r.seazn);
    setRelayDriversForTest({ ingest: r.ingest, runner: r.runner });
    const now = new Date(r.clock.now);
    expect((await seaznFixtureVideo(f, now)).live?.src, "the process relay signs").toMatch(PLAY);
    expect(r.mint, "through the process relay's ingest").toHaveBeenCalled();
    setRelayDriversForTest(disabledRelayDrivers());
    expect(await seaznFixtureVideo(r.fixtureIds[1], now), "nothing to sign: no relay needed").toEqual(EMPTY);
    // A LIVE deployment short its Cloudflare secrets cannot even BUILD its relay (the CloudflareIngest constructor throws): a
    // fixture with nothing to sign still answers, because the relay is built only when there is something to sign.
    setRelayDriversForTest(null);
    vi.stubEnv("RELAY_DRIVERS", "live");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_STREAM_TOKEN", "");
    expect(await seaznFixtureVideo(r.fixtureIds[1], now), "nothing to sign: the relay is never built").toEqual(EMPTY);
    await expect(seaznFixtureVideo(f, now), "something to sign: the build fails, by name").rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID is not set/);
    vi.stubEnv("RELAY_DRIVERS", "");
    // The other half: the default path really does reach the relay when there IS something to sign. A NEW live (its input is
    // not in the process cache yet), started on the rig's relay, then read on the disabled one.
    setRelayDriversForTest({ ingest: r.ingest, runner: r.runner });
    await live(r, r.fixtureIds[1], r.seazn);
    setRelayDriversForTest(disabledRelayDrivers());
    await expect(seaznFixtureVideo(r.fixtureIds[1], now)).rejects.toBeInstanceOf(RelayDriversDisabled);
  });
});
