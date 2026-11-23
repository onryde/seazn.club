// Seazn-hosted video, Phase 1 Task 13 (G5, C3, C6, C7): the stream tick's `seazn` pass, `lockSeaznRecordings`. Cloudflare
// records a signed input's recording UNSIGNED (C3), so every recording of a Seazn session's programme input is made to need a
// token (`requireSignedVideo`) and a `seazn_locked_videos` row marks it done. Controller ruling (review m1): a recording is
// NEVER edited while it is still recording (`live-inprogress`), whatever it reads — nobody has measured whether live HLS
// survives the edit (C7) — so the lock comes the first pass after it stops. C7 also never showed a lock surviving to `ready`,
// so a locked recording is locked AGAIN when its listing reads unsigned, and an input is marked finished
// (`recordings_locked_at`) only once every recording has been seen finished and signed, after its session has ended past the
// finalisation grace, on a listing that was not a full page (review m2).
//
// Every session comes from a REAL producer: the organiser's Go live (`createSession`), the Machine's playing beat, and Stop.
// The recordings are the fake's (`addVideo` under the programme input's own uid, the shape Cloudflare's listing has). Each pass
// is scoped to this file's orgs (`orgIds`, test-only), so no other suite's rows are listed with this file's fake. Recording
// uids are random: `seazn_locked_videos.cf_video_id` is a primary key in a shared database.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the pass never reads a sport rule; every rig rides `generic`.
// Secrets: no token is minted here; ids only.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

import { sql } from "@/lib/db";
import { DELETE_RECORDING_AFTER_DAYS, FINALISATION_GRACE_SECONDS, MAX_DURATION_MINUTES } from "@/server/relay/config";
import type { FakeIngest } from "@/server/relay/fakes";
import type { SessionDeps } from "../stream-sessions";
import { SEAZN_PASS_LOGGED_IDS_MAX } from "../seazn-recordings";
import { log } from "@/server/logger";
import {
  HAS_DB, SEC, ZERO, inputOf, installSeaznLockEnv, live, lockRows, pass, rig, stateOf, stopAndSettle, vid,
} from "./_seazn-lock-rig";

installSeaznLockEnv();

describe.skipIf(!HAS_DB)("lockSeaznRecordings — the stream tick's Seazn pass", () => {
  it("m1: a recording that is STILL RECORDING is never edited — neither one reading signed (C7's measured state) nor one reading unsigned; each is locked in ONE pass once it stops, and a second pass makes no second call", async () => {
    const r = await rig();
    const sid = await live(r, r.fixtureIds[0], r.seazn);
    const prog = await inputOf(sid, "programme");
    const at = new Date(r.clock.now).toISOString();
    const [signedLive, unsignedLive] = [vid("live-signed"), vid("live-unsigned")];
    r.ingest.addVideo({ videoId: signedLive, inputId: prog.uid, createdAt: at, inProgress: true, signed: true });
    r.ingest.addVideo({ videoId: unsignedLive, inputId: prog.uid, createdAt: at, inProgress: true });
    expect([r.ingest.videoAccess(signedLive), r.ingest.videoAccess(unsignedLive)], "PREMISE: one reads signed, one unsigned (C3)").toEqual([true, false]);

    expect(await pass(r, [r.auth.orgId]), "live-inprogress: nothing asked").toEqual(ZERO);
    r.clock.now += 60 * SEC;
    expect(await pass(r, [r.auth.orgId]), "a minute on, still recording: still nothing").toEqual(ZERO);
    expect(r.ingest.signedVideoCalls, "no edit of a recording mid-stream").toEqual([]);
    expect(await lockRows(prog.id)).toEqual([]);

    // Both stop: Cloudflare is still processing them (`inprogress`), but they are no longer live.
    r.ingest.updateVideo(signedLive, { inProgress: false, state: "inprogress" });
    r.ingest.updateVideo(unsignedLive, { inProgress: false, state: "inprogress" });
    expect(await pass(r, [r.auth.orgId])).toEqual({ ...ZERO, locked: 2 });
    expect([r.ingest.videoAccess(signedLive), r.ingest.videoAccess(unsignedLive)]).toEqual([true, true]);
    expect([...r.ingest.signedVideoCalls].sort()).toEqual([signedLive, unsignedLive].sort());
    expect(await lockRows(prog.id)).toEqual([signedLive, unsignedLive].sort());

    r.clock.now += 60 * SEC;
    expect(await pass(r, [r.auth.orgId]), "the second pass: listed, already locked, reads signed").toEqual(ZERO);
    expect(r.ingest.signedVideoCalls, "no second lock call").toHaveLength(2);
    expect((await inputOf(sid, "programme")).locked_at, "still live: never marked finished").toBeNull();
  });

  // Phase 1 review m13 (T13 m8): the refusal is logged every pass (every minute) while the listing keeps answering it, so the
  // logged ids are capped; the count is whole.
  it("m13: a listing answering more foreign recordings than the cap logs the first SEAZN_PASS_LOGGED_IDS_MAX ids and the whole count", async () => {
    const a = await rig();
    const sid = await live(a, a.fixtureIds[0], a.seazn);
    const prog = await inputOf(sid, "programme");
    const other = await inputOf(sid, "camera");
    const at = new Date(a.clock.now).toISOString();
    const foreign = Array.from({ length: SEAZN_PASS_LOGGED_IDS_MAX + 2 }, (_, i) => vid(`foreign-${i}`));
    expect(foreign.length, "PREMISE: more foreign recordings than the cap").toBeGreaterThan(SEAZN_PASS_LOGGED_IDS_MAX);
    for (const v of foreign) a.ingest.addVideo({ videoId: v, inputId: other.uid, createdAt: at, inProgress: false });
    a.ingest.seedInputListing(prog.uid, foreign);
    const warn = vi.spyOn(log, "warn");
    try {
      expect(await pass(a, [a.auth.orgId])).toEqual({ ...ZERO, refused: foreign.length });
      const lines = warn.mock.calls.filter(([, m]) => String(m).includes("(C6)"));
      expect(lines, "one C6 line for the input").toHaveLength(1);
      const fields = lines[0]![0] as { refused: { videoId: string }[]; refusedCount: number };
      expect(fields.refused.map((r) => r.videoId)).toEqual(foreign.slice(0, SEAZN_PASS_LOGGED_IDS_MAX));
      expect(fields.refusedCount).toBe(foreign.length);
    } finally {
      warn.mockRestore();
    }
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
    // Finished recordings (a recording still recording is never edited at all: m1), so only C6 decides which are touched.
    a.ingest.addVideo({ videoId: mine, inputId: progA.uid, createdAt: at, inProgress: false });
    a.ingest.addVideo({ videoId: theirs, inputId: progB.uid, createdAt: at, inProgress: false });
    a.ingest.addVideo({ videoId: camera, inputId: camA.uid, createdAt: at, inProgress: false });
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

    r.ingest.updateVideo(v, { inProgress: false, state: "ready" });   // finished (unsigned, C3): locked now, inside the grace
    expect(await pass(r, [r.auth.orgId], { now: ended + grace - SEC }), "within the grace: locked, not marked").toEqual({ ...ZERO, locked: 1 });
    expect((await inputOf(sid, "programme")).locked_at).toBeNull();

    const markAt = ended + grace + SEC;
    expect(await pass(r, [r.auth.orgId], { now: markAt })).toEqual(ZERO);
    expect((await inputOf(sid, "programme")).locked_at?.getTime()).toBe(markAt);
    expect(r.ingest.signedVideoCalls, "it read signed at the mark: one lock, ever").toEqual([v]);

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

  it("C7 partial: a recording locked while Cloudflare still processed it that reads UNSIGNED once ready is locked again, and only then is its input marked", async () => {
    const r = await rig();
    const sid = await live(r, r.fixtureIds[0], r.seazn);
    const prog = await inputOf(sid, "programme");
    const v = vid("ready");
    r.ingest.addVideo({ videoId: v, inputId: prog.uid, createdAt: new Date(r.clock.now).toISOString(), inProgress: false, state: "inprogress" });
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

  it("a listing that does not SAY whether a locked recording is signed (`requireSignedURLs` absent: null) is never taken as signed: once ready it is locked again, and the mark rests on that echo", async () => {
    const r = await rig();
    const sid = await live(r, r.fixtureIds[0], r.seazn);
    const prog = await inputOf(sid, "programme");
    const v = vid("unsaid");
    r.ingest.addVideo({ videoId: v, inputId: prog.uid, createdAt: new Date(r.clock.now).toISOString(), inProgress: false, state: "inprogress" });
    expect(await pass(r, [r.auth.orgId])).toEqual({ ...ZERO, locked: 1 });
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

  // Phase 1 review I3: whether the lock edit keeps the deletion Cloudflare stamped from the input's `deleteRecordingAfterDays` was
  // never measured, and the sweep holds every Seazn programme recording, so the lock sends the deletion itself. Expected from the
  // relay's own declarations: the input's deletion in days, from the recording's creation, plus the longest a recording can run
  // (MAX_DURATION_MINUTES) and finalise (FINALISATION_GRACE_SECONDS) — so it is never before Cloudflare's own (counted from READY)
  // and never short of its "at least 30 days from upload" floor.
  it("review I3: the lock sends the recording's deletion in the SAME edit — its creation + the input's retention + the longest run and finalisation — and a relock sends the very same instant", async () => {
    const r = await rig();
    const sid = await live(r, r.fixtureIds[0], r.seazn);
    const prog = await inputOf(sid, "programme");
    const created = new Date(r.clock.now - 20 * 60 * SEC);
    const v = vid("delete-at");
    r.ingest.addVideo({ videoId: v, inputId: prog.uid, createdAt: created.toISOString(), inProgress: false, state: "inprogress" });
    expect(await pass(r, [r.auth.orgId])).toEqual({ ...ZERO, locked: 1 });
    const expected = created.getTime() + DELETE_RECORDING_AFTER_DAYS * 86_400 * SEC + MAX_DURATION_MINUTES * 60 * SEC + FINALISATION_GRACE_SECONDS * SEC;
    expect(r.ingest.signedVideoDeleteAts.map((d) => d.getTime())).toEqual([expected]);
    expect(expected - (created.getTime() + MAX_DURATION_MINUTES * 60 * SEC + FINALISATION_GRACE_SECONDS * SEC), "30 days after the latest it can have been uploaded").toBeGreaterThanOrEqual(30 * 86_400 * SEC);
    // The C7 relock, a day later: the same instant, not pushed on by the day (it is the recording's, not the pass's).
    const ended = await stopAndSettle(r, r.fixtureIds[0], sid);
    r.ingest.updateVideo(v, { inProgress: false, state: "ready", signed: false });
    expect(await pass(r, [r.auth.orgId], { now: ended + 86_400 * SEC })).toEqual({ ...ZERO, relocked: 1 });
    expect(r.ingest.signedVideoDeleteAts.map((d) => d.getTime())).toEqual([expected, expected]);
  });

  it("review I3: a recording whose creation is not a date is still locked — its deletion counted from the pass's own clock — never left unsigned by a bad timestamp", async () => {
    const r = await rig();
    const sid = await live(r, r.fixtureIds[0], r.seazn);
    const prog = await inputOf(sid, "programme");
    const v = vid("no-created");
    r.ingest.addVideo({ videoId: v, inputId: prog.uid, createdAt: "not a date", inProgress: false });
    expect(await pass(r, [r.auth.orgId])).toEqual({ ...ZERO, locked: 1 });
    expect(r.ingest.videoAccess(v), "signed").toBe(true);
    const expected = r.clock.now + DELETE_RECORDING_AFTER_DAYS * 86_400 * SEC + MAX_DURATION_MINUTES * 60 * SEC + FINALISATION_GRACE_SECONDS * SEC;
    expect(r.ingest.signedVideoDeleteAts.map((d) => d.getTime())).toEqual([expected]);
  });

  it("V542 (Task 14 carry): the lock stores when the recording began (its listing's creation) as recorded_at — null when that is not a date — and a relock leaves it", async () => {
    const r = await rig();
    const sid = await live(r, r.fixtureIds[0], r.seazn);
    const prog = await inputOf(sid, "programme");
    const began = new Date(r.clock.now - 42 * 60 * SEC);
    const [dated, undated] = [vid("dated"), vid("undated")];
    r.ingest.addVideo({ videoId: dated, inputId: prog.uid, createdAt: began.toISOString(), inProgress: false, state: "inprogress" });
    r.ingest.addVideo({ videoId: undated, inputId: prog.uid, createdAt: "not a date", inProgress: false, state: "inprogress" });
    expect(await pass(r, [r.auth.orgId])).toEqual({ ...ZERO, locked: 2 });
    const recordedAt = async () => Object.fromEntries((await sql<{ cf_video_id: string; recorded_at: Date | null }[]>`
      select cf_video_id, recorded_at from seazn_locked_videos where input_row_id = ${prog.id}`).map((x) => [x.cf_video_id, x.recorded_at?.toISOString() ?? null]));
    const stored = { [dated]: began.toISOString(), [undated]: null };
    expect(await recordedAt()).toEqual(stored);
    // The C7 relock a day later rewrites nothing: the start is the recording's, not the pass's.
    const ended = await stopAndSettle(r, r.fixtureIds[0], sid);
    r.ingest.updateVideo(dated, { inProgress: false, state: "ready", signed: false });
    expect(await pass(r, [r.auth.orgId], { now: ended + 86_400 * SEC })).toMatchObject({ relocked: 1 });
    expect(await recordedAt()).toEqual(stored);
  });

  it("LIVE and REPLAY both off: a Seazn recording is still locked (the pass reads no flag)", async () => {
    const r = await rig();
    const sid = await live(r, r.fixtureIds[0], r.seazn);
    const prog = await inputOf(sid, "programme");
    const v = vid("flags-off");
    r.ingest.addVideo({ videoId: v, inputId: prog.uid, createdAt: new Date(r.clock.now).toISOString(), inProgress: false });
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
    r.ingest.addVideo({ videoId: v, inputId: prog.uid, createdAt: new Date(r.clock.now).toISOString(), inProgress: false });
    const listed = vi.spyOn(r.ingest, "listInputVideos");
    const still = () => 1_000_000;   // a wall clock that never moves: the budget is exactly what is passed
    expect(await pass(r, [r.auth.orgId], { budgetMs: 1_999, wallClock: still })).toEqual({ ...ZERO, deferred: 1 });
    expect(listed).not.toHaveBeenCalled();
    expect(r.ingest.videoAccess(v)).toBe(false);
    expect(await pass(r, [r.auth.orgId], { budgetMs: 2_000, wallClock: still })).toEqual({ ...ZERO, locked: 1 });
    expect(r.ingest.videoAccess(v)).toBe(true);
  });

  it("m4: the floor is checked again before EACH lock — a listing that spends the slice leaves its recording unlocked and the input deferred, unmarked", async () => {
    const r = await rig();
    const sid = await live(r, r.fixtureIds[0], r.seazn);
    const prog = await inputOf(sid, "programme");
    const v = vid("slow-list");
    r.ingest.addVideo({ videoId: v, inputId: prog.uid, createdAt: new Date(r.clock.now).toISOString(), inProgress: false });
    const ended = await stopAndSettle(r, r.fixtureIds[0], sid);
    let wall = 0;
    const list = r.ingest.listInputVideos.bind(r.ingest);
    vi.spyOn(r.ingest, "listInputVideos").mockImplementation(async (...a) => {
      const out = await list(...a);
      wall = 6_001;   // the listing took 6 s of an 8 s slice: 1 999 ms left, under the 2 s floor
      return out;
    });
    const markAt = ended + FINALISATION_GRACE_SECONDS * SEC + SEC;
    expect(await pass(r, [r.auth.orgId], { now: markAt, budgetMs: 8_000, wallClock: () => wall })).toEqual({ ...ZERO, deferred: 1 });
    expect(r.ingest.signedVideoCalls, "no lock started under the floor").toEqual([]);
    expect(r.ingest.videoAccess(v)).toBe(false);
    expect((await inputOf(sid, "programme")).locked_at, "a deferred input is not marked").toBeNull();
    // The pair: 6 s spent leaves exactly the floor, and the lock goes ahead.
    wall = 0;
    vi.mocked(r.ingest.listInputVideos).mockImplementation(async (...a) => { const out = await list(...a); wall = 6_000; return out; });
    expect(await pass(r, [r.auth.orgId], { now: markAt, budgetMs: 8_000, wallClock: () => wall })).toEqual({ ...ZERO, locked: 1 });
    expect((await inputOf(sid, "programme")).locked_at?.getTime()).toBe(markAt);
  });

  it("m2: a listing that comes back a FULL page may be missing recordings — what it listed is locked, but the input is never marked; a short page marks it", async () => {
    const r = await rig();
    const sid = await live(r, r.fixtureIds[0], r.seazn);
    const prog = await inputOf(sid, "programme");
    const at = new Date(r.clock.now).toISOString();
    const [one, two] = [vid("page-1"), vid("page-2")];
    r.ingest.addVideo({ videoId: one, inputId: prog.uid, createdAt: at, inProgress: false });
    r.ingest.addVideo({ videoId: two, inputId: prog.uid, createdAt: at, inProgress: false });
    const ended = await stopAndSettle(r, r.fixtureIds[0], sid);
    // The page limit lowered to 2 (relay-sweep.test's recipe): this listing is exactly a full page.
    const small = Object.assign(Object.create(r.ingest) as FakeIngest, { capabilities: { ...r.ingest.capabilities, listVideosPageLimit: 2 } });
    const smallDeps: SessionDeps = { ...r.deps, drivers: { ...r.deps.drivers, ingest: small } };
    const markAt = ended + FINALISATION_GRACE_SECONDS * SEC + SEC;
    expect(await pass(r, [r.auth.orgId], { now: markAt, deps: smallDeps })).toEqual({ ...ZERO, locked: 2 });
    expect([r.ingest.videoAccess(one), r.ingest.videoAccess(two)]).toEqual([true, true]);
    expect((await inputOf(sid, "programme")).locked_at, "a full page is never the whole set").toBeNull();
    expect(await pass(r, [r.auth.orgId], { now: markAt + 60 * SEC, deps: smallDeps }), "still a full page: still unmarked").toEqual(ZERO);
    expect((await inputOf(sid, "programme")).locked_at).toBeNull();
    // The pair: the same two recordings under the real page limit are a short page, and the input is marked.
    expect(await pass(r, [r.auth.orgId], { now: markAt + 120 * SEC })).toEqual(ZERO);
    expect((await inputOf(sid, "programme")).locked_at?.getTime()).toBe(markAt + 120 * SEC);
  });

  it("m3: a recording whose lock answers 404 (`absent`: Cloudflare no longer holds it) counts toward the mark without a lock or a row", async () => {
    const r = await rig();
    const sid = await live(r, r.fixtureIds[0], r.seazn);
    const prog = await inputOf(sid, "programme");
    const at = new Date(r.clock.now).toISOString();
    const [gone, kept] = [vid("gone"), vid("kept")];
    r.ingest.addVideo({ videoId: gone, inputId: prog.uid, createdAt: at, inProgress: false });
    r.ingest.addVideo({ videoId: kept, inputId: prog.uid, createdAt: at, inProgress: false });
    const ended = await stopAndSettle(r, r.fixtureIds[0], sid);
    const lock = vi.spyOn(r.ingest, "requireSignedVideo");
    lock.mockResolvedValueOnce("absent");   // the first recording listed was deleted between the listing and the edit
    const markAt = ended + FINALISATION_GRACE_SECONDS * SEC + SEC;
    expect(await pass(r, [r.auth.orgId], { now: markAt })).toEqual({ ...ZERO, locked: 1 });
    expect(lock.mock.calls.map(([id]) => id)).toEqual([gone, kept]);
    expect(await lockRows(prog.id), "no row for the absent one").toEqual([kept]);
    expect((await inputOf(sid, "programme")).locked_at?.getTime(), "the absent one did not hold the mark back").toBe(markAt);
  });

  it("refuses an empty orgIds (an `in ()` read as no filter would list every org) and a budget that is not a finite number of ms, by name, before any call", async () => {
    const r = await rig();
    const listed = vi.spyOn(r.ingest, "listInputVideos");
    await expect(pass(r, [])).rejects.toThrow(/orgIds is empty/);
    await expect(pass(r, [r.auth.orgId], { budgetMs: Number.NaN })).rejects.toThrow(/budgetMs must be a finite number/);
    expect(listed).not.toHaveBeenCalled();
  });
});
