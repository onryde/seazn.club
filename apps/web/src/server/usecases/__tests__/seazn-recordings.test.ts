// Seazn-hosted video, Phase 1 Task 13 (G5, C3, C6, C7): the stream tick's `seazn` pass, `lockSeaznRecordings`. Cloudflare
// records a signed input's recording UNSIGNED (C3), so every recording of a Seazn session's programme input is made to need a
// token (`requireSignedVideo`) the first time a pass lists it, and a `seazn_locked_videos` row marks it done. C7 is only partly
// measured — nothing showed a lock survives to `ready` — so a recording already locked is locked AGAIN when its listing reads
// unsigned, and an input is marked finished (`recordings_locked_at`) only once every recording has been seen in a finished
// state, signed, after its session has ended and the finalisation grace has run.
//
// Every session comes from a REAL producer: the organiser's Go live (`createSession`), the Machine's playing beat, and Stop.
// The recordings are the fake's (`addVideo` under the programme input's own uid, the shape Cloudflare's listing has). Each pass
// is scoped to this file's orgs (`orgIds`, test-only), so no other suite's rows are listed with this file's fake. Recording
// uids are random: `seazn_locked_videos.cf_video_id` is a primary key in a shared database.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the pass never reads a sport rule; every rig rides `generic`.
// Secrets: no token is minted here; ids only.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

import { sql } from "@/lib/db";
import { FINALISATION_GRACE_SECONDS } from "@/server/relay/config";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { FakeIngest, FakeRecorder, FakeRunner } from "@/server/relay/fakes";
import { pairPresentPhone, rigUser } from "@/server/relay/__tests__/_session-rig";
import { grantCredits } from "../stream-credits";
import { type SessionDeps, createSession, currentSession, heartbeat, stopSession } from "../stream-sessions";
import { createStreamTarget } from "../stream-targets";
import { lockSeaznRecordings } from "../seazn-recordings";
import { override } from "./_capture-rig";
import { seedOrg, startedDivisionWithFixture } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;
const SEC = 1000;
const ROOMY_STORAGE_MINUTES = 100_000_000;
/** The tick's slice for this pass (plan: SEAZN_PASS_BUDGET_MS = 8 000), typed here. */
const BUDGET = 8_000;

const ENV_KEYS = ["RELAY_KEK", "YOUTUBE_TOKEN_KEK", "RELAY_IMAGE", "AUTH_SECRET"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeAll(() => {
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex");
  process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:seazn-lock-test";
  process.env.AUTH_SECRET ??= "seazn-lock-test-secret";
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
});
afterEach(() => {
  vi.unstubAllEnvs();
  setRelayDriversForTest(null);
});

type Clock = { now: number };
/** An org with two started fixtures, the relay entitlements, credits, a phone on each fixture, a pasted YouTube key and its
 *  Seazn row (V540's trigger). `shared` puts a second org on the FIRST org's fake and clock, so one listing can answer both. */
async function rig(shared?: { ingest: FakeIngest; clock: Clock; runner: FakeRunner }) {
  const seeded = await seedOrg();
  const auth = { ...seeded.auth, userId: await rigUser() };
  const { fixtureIds } = await startedDivisionWithFixture(auth, { fixtures: 2 });
  await override(auth.orgId, "streaming.overlay", true);
  await override(auth.orgId, "streaming.relay", true);
  for (const f of fixtureIds) await pairPresentPhone(f);
  await grantCredits({ orgId: auth.orgId, delta: 5, createdBy: await rigUser(), note: "seazn lock", idempotencyKey: randomUUID() });
  const pasted = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "Club", streamKey: `yt-${randomUUID()}` });
  const [seazn] = await sql<{ id: string }[]>`select id from org_stream_targets where org_id = ${auth.orgId} and kind = 'seazn'`;
  expect(seazn, "PREMISE: V540 gave the org its Seazn destination").toBeDefined();
  const clock: Clock = shared?.clock ?? { now: Date.now() };
  const recorder = new FakeRecorder();
  const ingest = shared?.ingest ?? new FakeIngest({ clock: () => clock.now, connectAfterMs: 3000, recorder });
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
  const runner = shared?.runner ?? new FakeRunner();
  const deps: SessionDeps = { drivers: { ingest, runner }, now: () => new Date(clock.now), appUrl: "http://app.test" };
  return { auth, fixtureIds: fixtureIds as [string, string], pasted: pasted.id, seazn: seazn!.id, ingest, runner, clock, deps, recorder };
}
type Rig = Awaited<ReturnType<typeof rig>>;

/** Go live on `targetId` (composed), and the Machine's playing beat that takes it live. */
async function live(r: Rig, fixtureId: string, targetId: string): Promise<string> {
  await pairPresentPhone(fixtureId, { at: r.deps.now() });
  const { sessionId } = await createSession(r.auth, fixtureId, { mode: "composed", targetId }, r.deps);
  const spec = r.runner.created.find((c) => c.sessionId === sessionId);
  expect(spec, `PREMISE: a Machine was created for ${sessionId}`).toBeDefined();
  await heartbeat(sessionId, spec!.jobToken, { state: "playing" }, r.deps);
  expect(await stateOf(sessionId), "PREMISE: the session is live").toBe("live");
  return sessionId;
}
/** Stop, then read until the composed session has completed; answers its `ended_at`. */
async function stopAndSettle(r: Rig, fixtureId: string, sid: string): Promise<number> {
  await stopSession(r.auth, fixtureId, sid, r.deps);
  for (let i = 0; i < 3 && (await stateOf(sid)) !== "completed"; i++) await currentSession(r.auth, fixtureId, r.deps);
  expect(await stateOf(sid), "PREMISE: the stopped session completed").toBe("completed");
  const [{ ended_at }] = await sql<{ ended_at: Date }[]>`select ended_at from fixture_stream_sessions where id = ${sid}`;
  return ended_at.getTime();
}
const stateOf = async (sid: string) => (await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${sid}`)[0]!.state;
/** A session's input of `role`: its row id, its Cloudflare uid and its finished mark. */
async function inputOf(sid: string, role: "programme" | "camera") {
  const [row] = await sql<{ id: string; uid: string; locked_at: Date | null }[]>`
    select id, ingest_input_id as uid, recordings_locked_at as locked_at from fixture_stream_inputs where session_id = ${sid} and role = ${role}`;
  expect(row?.uid, `PREMISE: the ${role} input of ${sid} has a uid`).toBeTruthy();
  return row!;
}
const lockRows = async (inputRowId: string) =>
  (await sql<{ cf_video_id: string }[]>`select cf_video_id from seazn_locked_videos where input_row_id = ${inputRowId} order by cf_video_id`).map((r) => r.cf_video_id);
const vid = (tag: string) => `v-${tag}-${randomUUID()}`;
/** One pass, as the tick runs it, scoped to these orgs. */
const pass = (r: Rig, orgIds: string[], o: { now?: number; budgetMs?: number; wallClock?: () => number } = {}) =>
  lockSeaznRecordings(r.deps, { now: new Date(o.now ?? r.clock.now), budgetMs: o.budgetMs ?? BUDGET, orgIds, ...(o.wallClock ? { wallClock: o.wallClock } : {}) });
const ZERO = { locked: 0, relocked: 0, refused: 0, failed: 0, deferred: 0 };

describe.skipIf(!HAS_DB)("lockSeaznRecordings — the stream tick's Seazn pass", () => {
  it("a LIVE Seazn session's in-progress recording is locked in ONE pass (videoAccess true, one row naming its programme input); a second pass makes no second lock call", async () => {
    const r = await rig();
    const sid = await live(r, r.fixtureIds[0], r.seazn);
    const prog = await inputOf(sid, "programme");
    const v = vid("live");
    r.ingest.addVideo({ videoId: v, inputId: prog.uid, createdAt: new Date(r.clock.now).toISOString(), inProgress: true });
    expect(r.ingest.videoAccess(v), "PREMISE: Cloudflare recorded it unsigned (C3)").toBe(false);

    expect(await pass(r, [r.auth.orgId])).toEqual({ ...ZERO, locked: 1 });
    expect(r.ingest.videoAccess(v)).toBe(true);
    expect(await lockRows(prog.id)).toEqual([v]);
    expect(r.ingest.signedVideoCalls).toEqual([v]);

    r.clock.now += 60 * SEC;
    expect(await pass(r, [r.auth.orgId]), "the second pass: listed, already locked, reads signed").toEqual(ZERO);
    expect(r.ingest.signedVideoCalls, "no second lock call").toEqual([v]);
    expect((await inputOf(sid, "programme")).locked_at, "still live: never marked finished").toBeNull();
  });

  it("C6: a listing that also answers two recordings of OTHER inputs — one of them another org's Seazn programme input — locks only its own; refused is 2 and no call names the others", async () => {
    const a = await rig();
    const b = await rig({ ingest: a.ingest, clock: a.clock, runner: a.runner });
    const sidA = await live(a, a.fixtureIds[0], a.seazn);
    const sidB = await live(b, b.fixtureIds[0], b.seazn);
    const progA = await inputOf(sidA, "programme");
    const progB = await inputOf(sidB, "programme");
    const camA = await inputOf(sidA, "camera");
    const at = new Date(a.clock.now).toISOString();
    const [mine, theirs, camera] = [vid("mine"), vid("other-org"), vid("camera")];
    a.ingest.addVideo({ videoId: mine, inputId: progA.uid, createdAt: at, inProgress: true });
    a.ingest.addVideo({ videoId: theirs, inputId: progB.uid, createdAt: at, inProgress: true });
    a.ingest.addVideo({ videoId: camera, inputId: camA.uid, createdAt: at, inProgress: true });
    a.ingest.seedInputListing(progA.uid, [theirs, camera]);
    expect((await a.ingest.listInputVideos(progA.uid)).map((v) => v.videoId), "PREMISE: A's listing answers all three").toEqual([mine, theirs, camera]);

    expect(await pass(a, [a.auth.orgId])).toEqual({ ...ZERO, locked: 1, refused: 2 });
    expect([a.ingest.videoAccess(mine), a.ingest.videoAccess(theirs), a.ingest.videoAccess(camera)]).toEqual([true, false, false]);
    expect(a.ingest.signedVideoCalls).toEqual([mine]);
    await new Promise((res) => setImmediate(res));
    const named = a.recorder.calls.filter((c) => c.subjectId === theirs || c.subjectId === camera || c.ids.includes(theirs) || c.ids.includes(camera));
    expect(named, "no provider call names a foreign recording").toEqual([]);
    expect(a.recorder.calls.filter((c) => c.operation === "listInputVideos").length, "anti-vacuity: the recorder saw the listing").toBeGreaterThan(0);
    expect(await lockRows(progA.id)).toEqual([mine]);
    expect(await lockRows(progB.id)).toEqual([]);
    // The sequence: B's own pass, through B's own listing, locks B's recording — the refusal was the listing's, not the video's.
    expect(await pass(b, [b.auth.orgId])).toEqual({ ...ZERO, locked: 1 });
    expect(a.ingest.videoAccess(theirs)).toBe(true);
    expect(await lockRows(progB.id)).toEqual([theirs]);
  });

  it("a YouTube session's programme input, and a Seazn session's camera input, are never listed", async () => {
    const r = await rig();
    const seazn = await live(r, r.fixtureIds[0], r.seazn);
    const youtube = await live(r, r.fixtureIds[1], r.pasted);
    const [{ destination_kind }] = await sql<{ destination_kind: string }[]>`select destination_kind from fixture_stream_sessions where id = ${youtube}`;
    expect(destination_kind, "PREMISE: the pasted key's session is a YouTube one").toBe("youtube");
    const listed = vi.spyOn(r.ingest, "listInputVideos");
    await pass(r, [r.auth.orgId]);
    const uids = listed.mock.calls.map(([uid]) => uid);
    expect(uids).toEqual([(await inputOf(seazn, "programme")).uid]);
    expect(uids).not.toContain((await inputOf(youtube, "programme")).uid);
    expect(uids).not.toContain((await inputOf(seazn, "camera")).uid);
  });

  it("recordings_locked_at: null while live; null after the end while the recording is still finalising; null within the grace; set past it once every recording is finished and signed — then never listed again", async () => {
    const r = await rig();
    const sid = await live(r, r.fixtureIds[0], r.seazn);
    const prog = await inputOf(sid, "programme");
    const v = vid("mark");
    r.ingest.addVideo({ videoId: v, inputId: prog.uid, createdAt: new Date(r.clock.now).toISOString(), inProgress: true });
    await pass(r, [r.auth.orgId]);
    expect((await inputOf(sid, "programme")).locked_at, "live").toBeNull();

    const ended = await stopAndSettle(r, r.fixtureIds[0], sid);
    const grace = FINALISATION_GRACE_SECONDS * SEC;
    expect(await pass(r, [r.auth.orgId], { now: ended + grace + SEC }), "past the grace, but still live-inprogress at Cloudflare").toEqual(ZERO);
    expect((await inputOf(sid, "programme")).locked_at).toBeNull();

    r.ingest.updateVideo(v, { inProgress: false, state: "ready" });   // finished, and still reading signed
    expect(await pass(r, [r.auth.orgId], { now: ended + grace - SEC }), "within the grace").toEqual(ZERO);
    expect((await inputOf(sid, "programme")).locked_at).toBeNull();

    const markAt = ended + grace + SEC;
    expect(await pass(r, [r.auth.orgId], { now: markAt })).toEqual(ZERO);
    expect((await inputOf(sid, "programme")).locked_at?.getTime()).toBe(markAt);
    expect(r.ingest.signedVideoCalls, "it read signed at ready: one lock, ever").toEqual([v]);

    const listed = vi.spyOn(r.ingest, "listInputVideos");
    await pass(r, [r.auth.orgId], { now: markAt + 60 * SEC });
    expect(listed.mock.calls.map(([uid]) => uid), "a marked input is never listed again").not.toContain(prog.uid);
  });

  it("a LIVE session is never marked, however late, even when every recording so far has finished (between two connections)", async () => {
    const r = await rig();
    const sid = await live(r, r.fixtureIds[0], r.seazn);
    const prog = await inputOf(sid, "programme");
    const v = vid("between");
    r.ingest.addVideo({ videoId: v, inputId: prog.uid, createdAt: new Date(r.clock.now).toISOString(), inProgress: false, state: "ready" });
    const late = r.clock.now + 24 * 3600 * SEC;   // a day on: past any grace measured from the session's creation
    expect(await pass(r, [r.auth.orgId], { now: late })).toEqual({ ...ZERO, locked: 1 });
    expect(await pass(r, [r.auth.orgId], { now: late + 60 * SEC })).toEqual(ZERO);
    expect(await stateOf(sid), "PREMISE: still live").toBe("live");
    expect((await inputOf(sid, "programme")).locked_at, "a live input can still record again").toBeNull();
  });

  it("C7 partial: a recording locked while live that reads UNSIGNED once ready is locked again, and only then is its input marked", async () => {
    const r = await rig();
    const sid = await live(r, r.fixtureIds[0], r.seazn);
    const prog = await inputOf(sid, "programme");
    const v = vid("ready");
    r.ingest.addVideo({ videoId: v, inputId: prog.uid, createdAt: new Date(r.clock.now).toISOString(), inProgress: true });
    expect(await pass(r, [r.auth.orgId])).toEqual({ ...ZERO, locked: 1 });
    const ended = await stopAndSettle(r, r.fixtureIds[0], sid);
    r.ingest.updateVideo(v, { inProgress: false, state: "ready", signed: false });   // C3: Cloudflare finished it unsigned
    expect(r.ingest.videoAccess(v), "PREMISE: publicly playable again").toBe(false);

    const markAt = ended + FINALISATION_GRACE_SECONDS * SEC + SEC;
    expect(await pass(r, [r.auth.orgId], { now: markAt })).toEqual({ ...ZERO, relocked: 1 });
    expect(r.ingest.videoAccess(v)).toBe(true);
    expect(r.ingest.signedVideoCalls).toEqual([v, v]);
    expect(await lockRows(prog.id), "still one row").toEqual([v]);
    expect((await inputOf(sid, "programme")).locked_at?.getTime(), "the re-lock's echo confirms it").toBe(markAt);
  });

  it("a listing that does not SAY whether a locked recording is signed (`requireSignedURLs` absent: null) costs no call while it records, and one re-lock once it is ready — the mark rests on that echo", async () => {
    const r = await rig();
    const sid = await live(r, r.fixtureIds[0], r.seazn);
    const prog = await inputOf(sid, "programme");
    const v = vid("unsaid");
    r.ingest.addVideo({ videoId: v, inputId: prog.uid, createdAt: new Date(r.clock.now).toISOString(), inProgress: true });
    expect(await pass(r, [r.auth.orgId])).toEqual({ ...ZERO, locked: 1 });
    r.ingest.updateVideo(v, { signed: null });
    expect(await pass(r, [r.auth.orgId]), "recording, unsaid: nothing asked").toEqual(ZERO);
    expect(r.ingest.signedVideoCalls).toEqual([v]);
    const ended = await stopAndSettle(r, r.fixtureIds[0], sid);
    r.ingest.updateVideo(v, { inProgress: false, state: "ready", signed: null });
    const markAt = ended + FINALISATION_GRACE_SECONDS * SEC + SEC;
    expect(await pass(r, [r.auth.orgId], { now: markAt })).toEqual({ ...ZERO, relocked: 1 });
    expect(r.ingest.signedVideoCalls).toEqual([v, v]);
    expect((await inputOf(sid, "programme")).locked_at?.getTime()).toBe(markAt);
  });

  it("a lock that fails is counted, does not stop the next recording, and keeps the input unmarked; the next pass retries it", async () => {
    const r = await rig();
    const sid = await live(r, r.fixtureIds[0], r.seazn);
    const prog = await inputOf(sid, "programme");
    const at = new Date(r.clock.now).toISOString();
    const [bad, good] = [vid("bad"), vid("good")];
    r.ingest.addVideo({ videoId: bad, inputId: prog.uid, createdAt: at, inProgress: false });
    r.ingest.addVideo({ videoId: good, inputId: prog.uid, createdAt: at, inProgress: false });
    const ended = await stopAndSettle(r, r.fixtureIds[0], sid);
    const lock = vi.spyOn(r.ingest, "requireSignedVideo");
    lock.mockRejectedValueOnce(new Error("cloudflare require signed video: HTTP 500"));
    const markAt = ended + FINALISATION_GRACE_SECONDS * SEC + SEC;
    expect(await pass(r, [r.auth.orgId], { now: markAt })).toEqual({ ...ZERO, locked: 1, failed: 1 });
    expect([r.ingest.videoAccess(bad), r.ingest.videoAccess(good)]).toEqual([false, true]);
    expect((await inputOf(sid, "programme")).locked_at, "one recording is still open").toBeNull();
    expect(await pass(r, [r.auth.orgId], { now: markAt + 60 * SEC })).toEqual({ ...ZERO, locked: 1 });
    expect(r.ingest.videoAccess(bad)).toBe(true);
    expect((await inputOf(sid, "programme")).locked_at?.getTime()).toBe(markAt + 60 * SEC);
  });

  it("LIVE and REPLAY both off: a Seazn recording is still locked (the pass reads no flag)", async () => {
    const r = await rig();
    const sid = await live(r, r.fixtureIds[0], r.seazn);
    const prog = await inputOf(sid, "programme");
    const v = vid("flags-off");
    r.ingest.addVideo({ videoId: v, inputId: prog.uid, createdAt: new Date(r.clock.now).toISOString(), inProgress: true });
    vi.stubEnv("SEAZN_HOSTED_LIVE", "false");
    vi.stubEnv("SEAZN_HOSTED_REPLAY", "false");
    expect(await pass(r, [r.auth.orgId])).toEqual({ ...ZERO, locked: 1 });
    expect(r.ingest.videoAccess(v)).toBe(true);
  });

  it("the empty cases: an org with no Seazn input answers zeros and calls nothing; a Seazn input that never recorded is marked once its session has ended past the grace", async () => {
    const r = await rig();
    const listed = vi.spyOn(r.ingest, "listInputVideos");
    expect(await pass(r, [r.auth.orgId])).toEqual(ZERO);
    expect(listed).not.toHaveBeenCalled();

    const sid = await live(r, r.fixtureIds[0], r.seazn);
    const ended = await stopAndSettle(r, r.fixtureIds[0], sid);
    expect(await pass(r, [r.auth.orgId], { now: ended + FINALISATION_GRACE_SECONDS * SEC - SEC })).toEqual(ZERO);
    expect((await inputOf(sid, "programme")).locked_at, "within the grace a recording may still appear").toBeNull();
    const markAt = ended + FINALISATION_GRACE_SECONDS * SEC + SEC;
    expect(await pass(r, [r.auth.orgId], { now: markAt })).toEqual(ZERO);
    expect((await inputOf(sid, "programme")).locked_at?.getTime()).toBe(markAt);
  });

  it("the budget: with under 2 s of it left no provider call starts and the input is deferred; 2 s left is enough", async () => {
    const r = await rig();
    const sid = await live(r, r.fixtureIds[0], r.seazn);
    const prog = await inputOf(sid, "programme");
    const v = vid("budget");
    r.ingest.addVideo({ videoId: v, inputId: prog.uid, createdAt: new Date(r.clock.now).toISOString(), inProgress: true });
    const listed = vi.spyOn(r.ingest, "listInputVideos");
    const still = () => 1_000_000;   // a wall clock that never moves: the budget is exactly what is passed
    expect(await pass(r, [r.auth.orgId], { budgetMs: 1_999, wallClock: still })).toEqual({ ...ZERO, deferred: 1 });
    expect(listed).not.toHaveBeenCalled();
    expect(r.ingest.videoAccess(v)).toBe(false);
    expect(await pass(r, [r.auth.orgId], { budgetMs: 2_000, wallClock: still })).toEqual({ ...ZERO, locked: 1 });
    expect(r.ingest.videoAccess(v)).toBe(true);
  });

  it("refuses an empty orgIds (an `in ()` read as no filter would list every org) and a budget that is not a finite number of ms, by name, before any call", async () => {
    const r = await rig();
    const listed = vi.spyOn(r.ingest, "listInputVideos");
    await expect(pass(r, [])).rejects.toThrow(/orgIds is empty/);
    await expect(pass(r, [r.auth.orgId], { budgetMs: Number.NaN })).rejects.toThrow(/budgetMs must be a finite number/);
    expect(listed).not.toHaveBeenCalled();
  });
});
