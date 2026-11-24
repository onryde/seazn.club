// Seazn-hosted video, Phase 2 Task 24: moving a Seazn match's recordings to the replay host — discovery
// (`discoverSeaznRecordings`), the move (`moveSeaznRecordings`) and the flag gate (`runSeaznReplays`), on the fakes.
//
// Every session comes from the REAL producer (the organiser's Go live, the Machine's playing beat, Stop: _seazn-session-rig.ts);
// the recordings are the Cloudflare fake's, under the programme input's own uid. The clock is the test's: every pass is handed
// its `now`, and the times below are offsets from the session's own end. Each pass is scoped to the test's org (`orgIds`), so
// another suite's rows in the shared database are never claimed here. The expected values are the rulings' literals, typed here:
// 15 min after the result (G-A), 6 h for an undecided fixture (G-F), 60 min after verification for the Cloudflare delete (G-D),
// 15 min between polls, 30 min for a lost fetch, min(2^attempts, 60) min of backoff.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the move never reads a sport rule; every rig rides `generic`.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { FakeIngest } from "@/server/relay/fakes";
import { FINALISATION_GRACE_SECONDS } from "@/server/relay/config";
import { createPlaybackTokenCache } from "@/server/video/cf-playback";
import { FAKE_REPLAY_LENGTH_SECONDS, FakeReplayHost } from "@/server/video/replay-fake";
import { installSeaznEnv, live, seaznRig, stopAndSettle } from "@/server/video/__tests__/_seazn-session-rig";
import { type SeaznReplayDeps, discoverSeaznRecordings, moveSeaznRecordings, runSeaznReplays } from "../seazn-replays";

const HAS_DB = !!process.env.DATABASE_URL;
const MIN = 60_000;
const BUDGET = 8_000;

installSeaznEnv("t24-replays");
beforeEach(() => { vi.stubEnv("SEAZN_HOSTED_REPLAY", "true"); });

async function world() {
  const r = await seaznRig();
  const ingest = r.deps.drivers.ingest as FakeIngest;
  const host = new FakeReplayHost();
  const deps: SeaznReplayDeps = { ingest, replay: host, tokenCache: createPlaybackTokenCache() };
  return { ...r, ingest, host, replayDeps: deps };
}
type World = Awaited<ReturnType<typeof world>>;
interface Rec { at?: number; duration?: number; height?: number; inProgress?: boolean }

/** A session on `target` that recorded `recs` on its programme input and then ended. The recordings default to the replay fake's
 *  own length and a 1080p source, so the copy passes the check unless a case says otherwise. */
async function endedWith(w: World, fixtureId: string, recs: Rec[], target: string = w.seazn) {
  const sid = await live(w, fixtureId, target);
  const [prog] = await sql<{ id: string; uid: string }[]>`
    select id, ingest_input_id as uid from fixture_stream_inputs where session_id = ${sid} and role = 'programme'`;
  expect(prog?.uid, "PREMISE: the programme input has a uid").toBeTruthy();
  const base = w.deps.now().getTime();
  const ids = recs.map((rec, k) => {
    const videoId = `v-${k}-${randomUUID()}`;
    w.ingest.addVideo({ videoId, inputId: prog!.uid, createdAt: new Date(rec.at ?? base + k * MIN).toISOString(), inProgress: rec.inProgress ?? false,
      durationSeconds: rec.duration ?? FAKE_REPLAY_LENGTH_SECONDS, height: rec.height ?? 1080 });
    return videoId;
  });
  await stopAndSettle(w, fixtureId, sid);
  const [{ ended_at }] = await sql<{ ended_at: Date }[]>`select ended_at from fixture_stream_sessions where id = ${sid}`;
  return { sid, prog: prog!, ids, endedAt: new Date(ended_at).getTime() };
}
const decide = (fixtureId: string, at: number | null) => sql`update fixtures set finished_at = ${at === null ? null : new Date(at)} where id = ${fixtureId}`;
const discover = (w: World, now: number) => discoverSeaznRecordings(w.replayDeps, { now: new Date(now), budgetMs: BUDGET, orgIds: [w.auth.orgId] });
const move = (w: World, now: number) => moveSeaznRecordings(w.replayDeps, { now: new Date(now), budgetMs: BUDGET, orgIds: [w.auth.orgId] });
interface Row {
  id: string; cf_video_id: string; part_no: number; state: string; bunny_video_id: string | null; attempts: number; next_attempt_at: Date;
  verified_at: Date | null; cf_deleted_at: Date | null; bunny_cleaned_at: Date | null; recorded_at: Date; session_id: string;
  cf_duration_seconds: number | null; cf_height: number | null; length_seconds: number | null;
}
const rowsOf = (fixtureId: string) => sql<Row[]>`select * from fixture_video_replays where fixture_id = ${fixtureId} order by part_no`;
const rowOf = async (cf: string) => (await sql<Row[]>`select * from fixture_video_replays where cf_video_id = ${cf}`)[0]!;
const ms = (d: Date | null) => (d === null ? null : new Date(d).getTime());
/** Spies on the calls the move makes; each is counted. */
function spies(w: World) {
  return {
    list: vi.spyOn(w.ingest, "listInputVideos"),
    del: vi.spyOn(w.ingest, "deleteVideo"),
    fetch: vi.spyOn(w.host, "fetchFromUrl"),
    poll: vi.spyOn(w.host, "video"),
    collection: vi.spyOn(w.host, "createCollection"),
  };
}
/** Discovered and moved to `encoding` (the fetch made): the rows of `fixtureId`, each holding its host copy. */
async function toEncoding(w: World, fixtureId: string, recs: Rec[]) {
  const s = await endedWith(w, fixtureId, recs);
  await decide(fixtureId, s.endedAt);
  const t0 = s.endedAt + 15 * MIN;
  await discover(w, t0);
  await move(w, t0);
  const rows = await rowsOf(fixtureId);
  expect(rows.map((r) => r.state), "PREMISE: every row reached encoding in one run").toEqual(recs.map(() => "encoding"));
  return { ...s, t0, rows };
}

describe.skipIf(!HAS_DB)("Task 24 — discovery and the move, on the fakes", () => {
  it("Review Focus 4: a stopped and restarted Seazn match (two sessions) yields two parts in recording order, moved to the host under the plan's title and a 6 h download URL; a second discovery lists nothing", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const first = await endedWith(w, f, [{}]);
    const second = await endedWith(w, f, [{ at: first.endedAt + 2 * MIN }]);
    await decide(f, second.endedAt);
    const s = spies(w);
    const t0 = second.endedAt + 15 * MIN;
    expect(await discover(w, t0)).toMatchObject({ discovered: 2, refused: 0, failed: 0, deferred: 0 });
    expect(s.list, "both programme inputs listed once").toHaveBeenCalledTimes(2);
    const rows = await rowsOf(f);
    expect(rows.map((r) => [r.part_no, r.cf_video_id, r.session_id, r.state])).toEqual([
      [1, first.ids[0], first.sid, "found"], [2, second.ids[0], second.sid, "found"],
    ]);
    expect(ms(rows[0]!.recorded_at)! < ms(rows[1]!.recorded_at)!, "ordered by recorded_at").toBe(true);
    expect(rows.map((r) => [r.cf_duration_seconds, r.cf_height]), "the listing's duration and height, stored").toEqual([[120, 1080], [120, 1080]]);
    expect(await discover(w, t0 + MIN)).toMatchObject({ discovered: 0 });
    expect(s.list, "replays_discovered_at set: never listed again").toHaveBeenCalledTimes(2);

    expect(await move(w, t0)).toMatchObject({ moved: 6, playable: 0, failed: 0 });   // found→downloading→fetching→encoding, twice
    const moved = await rowsOf(f);
    expect(moved.map((r) => r.state)).toEqual(["encoding", "encoding"]);
    expect(w.ingest.downloadCalls.sort(), "one download per recording").toEqual([first.ids[0], second.ids[0]].sort());
    expect(s.collection, "one collection for the org").toHaveBeenCalledTimes(1);
    for (const r of moved) {
      const copy = await w.host.video(r.bunny_video_id!);
      expect(copy.title).toBe(`seazn:${r.session_id}:${r.cf_video_id}`);
      const url = new URL(w.host.sourceOf(r.bunny_video_id!)!);
      expect(url.pathname, "Cloudflare's MP4 download, on a downloadable token for THIS recording").toMatch(new RegExp(`^/fake\\.${r.cf_video_id}\\.(\\d+)\\.dl/downloads/default\\.mp4$`));
      const exp = Number(/\.(\d+)\.dl\//.exec(url.pathname)![1]) * 1000;
      expect(exp - Math.floor(t0 / 1000) * 1000, "the token lives 6 h").toBe(6 * 3600 * 1000);
    }
  });

  it("G-D: the Cloudflare copy is deleted only at verified_at + 60 min — none at 59, exactly one per recording at 60, each AFTER its row went playable; by the row's own id", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const e = await toEncoding(w, f, [{}]);
    const cf = e.ids[0]!;
    const events: string[] = [];
    vi.spyOn(w.ingest, "deleteVideo").mockImplementation(async (id) => { events.push(`delete:${id}`); return "deleted"; });
    w.host.advance(e.rows[0]!.bunny_video_id!);
    const v = e.t0 + 15 * MIN;   // the poll backstop
    expect(await move(w, v)).toMatchObject({ playable: 1, failed: 0 });
    const playable = await rowOf(cf);
    events.push(`state:${playable.state}`);
    expect([playable.state, ms(playable.verified_at), playable.length_seconds]).toEqual(["playable", v, FAKE_REPLAY_LENGTH_SECONDS]);
    expect(ms(playable.next_attempt_at), "due again at verified_at + 60 min").toBe(v + 60 * MIN);
    // Review m5: pulled back, so the 59-min run CLAIMS the row and the gate itself — not the row's own due time — holds the delete.
    await sql`update fixture_video_replays set next_attempt_at = ${new Date(v + 59 * MIN)} where cf_video_id = ${cf}`;
    await move(w, v + 59 * MIN);
    expect(events.filter((x) => x.startsWith("delete:")), "59 min: no delete").toEqual([]);
    expect(ms((await rowOf(cf)).next_attempt_at), "59 min: claimed, and the gate set it due at verified_at + 60 min").toBe(v + 60 * MIN);
    expect((await rowOf(cf)).cf_deleted_at).toBeNull();
    await move(w, v + 60 * MIN);
    expect(events.filter((x) => x.startsWith("delete:")), "60 min: exactly one, of the stored id").toEqual([`delete:${cf}`]);
    expect(events.indexOf(`delete:${cf}`)).toBeGreaterThan(events.indexOf("state:playable"));
    expect(ms((await rowOf(cf)).cf_deleted_at)).toBe(v + 60 * MIN);
    await move(w, v + 2 * 60 * MIN);
    expect(events.filter((x) => x.startsWith("delete:")), "settled: never again").toHaveLength(1);
  });

  it("Review Focus 5: a copy the host fails is removed, the Cloudflare video is NEVER deleted, and attempts grow with the backoff (1 min, then 2 min)", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const e = await toEncoding(w, f, [{}]);
    const s = spies(w);
    const firstCopy = e.rows[0]!.bunny_video_id!;
    w.host.fail(firstCopy);
    const p1 = e.t0 + 15 * MIN;
    expect(await move(w, p1)).toMatchObject({ failed: 1, playable: 0 });
    let row = await rowOf(e.ids[0]!);
    expect([row.state, row.bunny_video_id, row.attempts, ms(row.next_attempt_at)]).toEqual(["failed", null, 1, p1 + 1 * MIN]);
    expect(w.host.videoIds(), "the failed copy is removed").not.toContain(firstCopy);
    // The retry: from found, through a new copy, which fails too.
    await move(w, p1 + 1 * MIN);
    row = await rowOf(e.ids[0]!);
    expect(row.state, "restarted from found and fetched again").toBe("encoding");
    expect(row.bunny_video_id).not.toBe(firstCopy);
    w.host.fail(row.bunny_video_id!);
    const p2 = p1 + 1 * MIN + 15 * MIN;
    await move(w, p2);
    row = await rowOf(e.ids[0]!);
    expect([row.state, row.attempts, ms(row.next_attempt_at)], "2^1 = 2 min").toEqual(["failed", 2, p2 + 2 * MIN]);
    expect(s.del, "a failed copy is never followed by a Cloudflare delete").not.toHaveBeenCalled();
    expect(w.host.videoIds(), "nothing left on the host").toEqual([]);
  });

  it("G-C in the usecase: a copy whose length is off by more than 2 s fails the check (Cloudflare kept, copy removed, failed with backoff, then restarts from found); a clean one is playable with verified_at = now", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    // 3600 s on Cloudflare; the host's copy reads FAKE_REPLAY_LENGTH_SECONDS (120): a length failure. The other matches.
    const e = await toEncoding(w, f, [{ duration: 3600 }, {}]);
    const s = spies(w);
    const [bad, good] = e.ids as [string, string];
    for (const r of e.rows) w.host.advance(r.bunny_video_id!);
    const v = e.t0 + 15 * MIN;
    expect(await move(w, v)).toMatchObject({ playable: 1, failed: 1 });
    const b = await rowOf(bad);
    expect([b.state, b.bunny_video_id, b.attempts, ms(b.next_attempt_at)]).toEqual(["failed", null, 1, v + MIN]);
    expect(w.host.videoIds(), "the failed copy is removed; the clean one stays").toEqual([(await rowOf(good)).bunny_video_id]);
    const g = await rowOf(good);
    expect([g.state, ms(g.verified_at)]).toEqual(["playable", v]);
    await move(w, v + MIN);
    expect((await rowOf(bad)).state, "restarted from found").toBe("encoding");
    expect(s.del, "no Cloudflare delete for the failed copy").not.toHaveBeenCalledWith(bad);
  });

  it("C6 (Review Focus 11): the programme listing also answers another session's programme recording of the same org and one of an unknown input — no row for either, and no download, fetch or delete ever names them", async () => {
    const w = await world();
    const [f, other] = w.fixtureIds;
    // The external session: a YouTube programme input of the same org, with its own recording.
    const ext = await endedWith(w, other, [{}], w.pasted);
    const unknownVideo = `v-unknown-${randomUUID()}`;
    w.ingest.addVideo({ videoId: unknownVideo, inputId: `in-unknown-${randomUUID()}`, createdAt: new Date().toISOString(), inProgress: false, durationSeconds: 120, height: 1080 });
    const own = await endedWith(w, f, [{}]);
    w.ingest.seedInputListing(own.prog.uid, [ext.ids[0]!, unknownVideo]);
    expect((await w.ingest.listInputVideos(own.prog.uid)).length, "PREMISE: the listing answers three").toBe(3);
    const foreign = [ext.ids[0]!, unknownVideo];
    await decide(f, own.endedAt);
    await decide(other, own.endedAt);
    const t0 = own.endedAt + 15 * MIN;
    expect(await discover(w, t0), "anti-vacuity: both foreign recordings were seen and refused").toMatchObject({ discovered: 1, refused: 2 });
    expect((await sql`select 1 from fixture_video_replays where cf_video_id in ${sql(foreign)}`).length).toBe(0);
    const s = spies(w);
    await move(w, t0);
    const [row] = await rowsOf(f);
    w.host.advance(row!.bunny_video_id!);
    await move(w, t0 + 15 * MIN);
    await move(w, t0 + 75 * MIN);
    expect(s.del.mock.calls.map(([id]) => id), "only the programme's own recording is deleted").toEqual([own.ids[0]]);
    const touched = [...w.ingest.downloadCalls, ...s.fetch.mock.calls.map(([a]) => a.url), ...s.del.mock.calls.map(([id]) => id)];
    expect(touched.length, "anti-vacuity: calls were made").toBeGreaterThan(0);
    for (const id of foreign) expect(touched.join(" "), id).not.toContain(id);
  });

  it("REPLAY off: zero discovery and zero move calls, even with a due row; on, the same row moves", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const s0 = await endedWith(w, f, [{}]);
    await decide(f, s0.endedAt);
    const t0 = s0.endedAt + 15 * MIN;
    await discover(w, t0);   // a due row, made directly
    const s = spies(w);
    vi.stubEnv("SEAZN_HOSTED_REPLAY", "false");
    const off = await runSeaznReplays(w.replayDeps, { now: new Date(t0), budgetMs: BUDGET, orgIds: [w.auth.orgId] });
    expect(off).toEqual({ discovered: 0, moved: 0, playable: 0, refused: 0, failed: 0, deferred: 0 });
    expect([s.list.mock.calls.length, w.ingest.downloadCalls.length, s.fetch.mock.calls.length]).toEqual([0, 0, 0]);
    expect((await rowOf(s0.ids[0]!)).state).toBe("found");
    vi.stubEnv("SEAZN_HOSTED_REPLAY", "true");
    const on = await runSeaznReplays(w.replayDeps, { now: new Date(t0), budgetMs: BUDGET, orgIds: [w.auth.orgId] });
    expect(on).toMatchObject({ moved: 3, failed: 0 });
    expect(w.ingest.downloadCalls).toEqual([s0.ids[0]]);
  });

  it("overlap: a run blocked inside createDownload holds its claim — a second run makes no call for that row; exactly one createDownload in all", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const s0 = await endedWith(w, f, [{}]);
    await decide(f, s0.endedAt);
    const t0 = s0.endedAt + 15 * MIN;
    await discover(w, t0);
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    let entered!: () => void;
    const inside = new Promise<void>((res) => { entered = res; });
    const real = w.ingest.createDownload.bind(w.ingest);
    let calls = 0;
    w.ingest.createDownload = async (id: string) => { calls++; entered(); await gate; return real(id); };
    const a = move(w, t0);
    await inside;
    const b = await move(w, t0);
    expect(b, "run B found nothing to claim").toEqual({ discovered: 0, moved: 0, playable: 0, refused: 0, failed: 0, deferred: 0 });
    expect(calls, "run B made no call").toBe(1);
    release();
    await a;
    expect(calls).toBe(1);
    expect((await rowOf(s0.ids[0]!)).state).toBe("encoding");
  });

  it("a Cloudflare delete answered in_progress leaves cf_deleted_at null; the next run deletes the stored id and sets it", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const e = await toEncoding(w, f, [{}]);
    const cf = e.ids[0]!;
    w.host.advance(e.rows[0]!.bunny_video_id!);
    const v = e.t0 + 15 * MIN;
    await move(w, v);
    w.ingest.scriptDeleteVideo(cf, ["in_progress"]);
    await move(w, v + 60 * MIN);
    let row = await rowOf(cf);
    expect([row.cf_deleted_at, ms(row.next_attempt_at)], "kept for the next firing").toEqual([null, v + 60 * MIN]);
    await move(w, v + 61 * MIN);
    row = await rowOf(cf);
    expect(ms(row.cf_deleted_at)).toBe(v + 61 * MIN);
    expect(w.ingest.deletedVideos).toEqual([cf]);
  });

  it("G-A (owner ruling 2026-11-21): decided 14 min ago — not listed; at 15 min — listed. A session still live is never listed", async () => {
    const w = await world();
    const [f, g] = w.fixtureIds;
    const s0 = await endedWith(w, f, [{}]);
    const decidedAt = s0.endedAt + 5 * MIN;
    expect(decidedAt + 14 * MIN - s0.endedAt > FINALISATION_GRACE_SECONDS * 1000, "PREMISE: at 14 min the grace is long past — it is not what holds it").toBe(true);
    await decide(f, decidedAt);
    const stillLive = await live(w, g, w.seazn);
    await decide(g, decidedAt - 60 * MIN);
    const s = spies(w);
    await discover(w, decidedAt + 14 * MIN);
    expect(s.list, "14 min: not listed").toHaveBeenCalledTimes(0);
    await discover(w, decidedAt + 15 * MIN);
    expect(s.list.mock.calls.map(([uid]) => uid), "15 min: listed, the live one never").toEqual([s0.prog.uid]);
    await discover(w, decidedAt + 24 * 60 * MIN);
    expect(s.list, "still not the live session").toHaveBeenCalledTimes(1);
    expect(stillLive).toBeTruthy();
  });

  it("G-F (recommendation 2026-11-21): undecided — not listed 5 h 59 min after its session ended, listed at 6 h; a fixture decided 14 min ago is not rescued by a session ended 7 h ago", async () => {
    const w = await world();
    const [f, g] = w.fixtureIds;
    const undecided = await endedWith(w, f, [{}]);
    await decide(f, null);
    const s = spies(w);
    await discover(w, undecided.endedAt + 5 * 60 * MIN + 59 * MIN);
    expect(s.list, "5 h 59 min: not listed").toHaveBeenCalledTimes(0);
    await discover(w, undecided.endedAt + 6 * 60 * MIN);
    expect(s.list.mock.calls.map(([uid]) => uid)).toEqual([undecided.prog.uid]);
    const decided = await endedWith(w, g, [{}]);
    const now = decided.endedAt + 7 * 60 * MIN;
    await sql`update fixture_stream_sessions set ended_at = ${new Date(now - 7 * 60 * MIN)} where id = ${decided.sid}`;
    await decide(g, now - 14 * MIN);
    s.list.mockClear();
    await discover(w, now);
    expect(s.list, "decided 14 min ago: the fallback does not rescue it").toHaveBeenCalledTimes(0);
    await discover(w, now + MIN);
    expect(s.list.mock.calls.map(([uid]) => uid), "and at 15 min it is listed").toEqual([decided.prog.uid]);
  });

  it("the host no longer holds the copy (`absent`): the row clears its copy id and goes back to found", async () => {
    const w = await world();
    const e = await toEncoding(w, w.fixtureIds[0], [{}]);
    await w.host.remove(e.rows[0]!.bunny_video_id!);
    await move(w, e.t0 + 15 * MIN);
    const row = await rowOf(e.ids[0]!);
    expect([row.state, row.bunny_video_id, ms(row.next_attempt_at)]).toEqual(["found", null, e.t0 + 15 * MIN]);
  });

  it("a fetch whose answer was lost leaves the row fetching with no copy: no second fetch at 29 min, back to downloading and fetched again at 31 min", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const s0 = await endedWith(w, f, [{}]);
    await decide(f, s0.endedAt);
    const t0 = s0.endedAt + 15 * MIN;
    await discover(w, t0);
    const fetch = vi.spyOn(w.host, "fetchFromUrl").mockRejectedValueOnce(new Error("socket hang up"));
    expect(await move(w, t0)).toMatchObject({ failed: 1 });
    let row = await rowOf(s0.ids[0]!);
    expect([row.state, row.bunny_video_id, row.attempts]).toEqual(["fetching", null, 1]);
    await move(w, t0 + 2 * MIN);
    await move(w, t0 + 29 * MIN);
    expect(fetch, "no blind second fetch inside the 30 min").toHaveBeenCalledTimes(1);
    await move(w, t0 + 31 * MIN);
    expect(fetch, "fetched again").toHaveBeenCalledTimes(2);
    row = await rowOf(s0.ids[0]!);
    expect(row.state).toBe("encoding");
    expect(w.ingest.downloadCalls, "through downloading: the download asked again").toEqual([s0.ids[0], s0.ids[0]]);
  });

  it("another actor moves the row mid-step: the organiser deletes it while its fetch is in flight — the move never writes over `deleted`, and the copy that fetch made is removed", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const s0 = await endedWith(w, f, [{}]);
    await decide(f, s0.endedAt);
    const t0 = s0.endedAt + 15 * MIN;
    await discover(w, t0);
    const cf = s0.ids[0]!;
    const real = w.host.fetchFromUrl.bind(w.host);
    let made: string | null = null;
    vi.spyOn(w.host, "fetchFromUrl").mockImplementationOnce(async (a) => {
      await sql`update fixture_video_replays set state = 'deleted', deleted_reason = 'organiser', deleted_at = ${new Date(t0)}, next_attempt_at = ${new Date(t0)} where cf_video_id = ${cf}`;
      made = await real(a);
      return made;
    });
    await move(w, t0);
    const row = await rowOf(cf);
    expect(made, "PREMISE: the fetch made a copy").not.toBeNull();
    expect([row.state, row.bunny_video_id], "the organiser's delete stands").toEqual(["deleted", null]);
    expect(w.host.videoIds(), "nothing stays on the host for the deleted row").not.toContain(made);
  });

  it("poll backstop: a copy still processing is polled again only 15 min later", async () => {
    const w = await world();
    const e = await toEncoding(w, w.fixtureIds[0], [{}]);
    const poll = vi.spyOn(w.host, "video");
    await move(w, e.t0 + 14 * MIN);
    expect(poll, "the first poll waits 15 min after the fetch").toHaveBeenCalledTimes(0);
    await move(w, e.t0 + 15 * MIN);
    expect(poll).toHaveBeenCalledTimes(1);
    await move(w, e.t0 + 29 * MIN);
    expect(poll, "14 min after a processing poll: none").toHaveBeenCalledTimes(1);
    await move(w, e.t0 + 30 * MIN);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("an organiser-deleted row: cleanup removes its copy at once; the Cloudflare copy waits for verified_at + 60 min, then goes, and bunny_cleaned_at is set", async () => {
    const w = await world();
    const e = await toEncoding(w, w.fixtureIds[0], [{}]);
    const cf = e.ids[0]!;
    const guid = e.rows[0]!.bunny_video_id!;
    w.host.advance(guid);
    const v = e.t0 + 15 * MIN;
    await move(w, v);
    await sql`update fixture_video_replays set state = 'deleted', deleted_reason = 'organiser', deleted_at = ${new Date(v + 5 * MIN)}, next_attempt_at = ${new Date(v + 5 * MIN)} where cf_video_id = ${cf}`;
    const del = vi.spyOn(w.ingest, "deleteVideo");
    await move(w, v + 10 * MIN);
    let row = await rowOf(cf);
    expect(w.host.videoIds(), "the copy is removed at once").not.toContain(guid);
    expect([row.bunny_video_id, row.bunny_cleaned_at, ms(row.next_attempt_at)]).toEqual([null, null, v + 60 * MIN]);
    expect(del, "10 min after verification: the Cloudflare copy waits").not.toHaveBeenCalled();
    await move(w, v + 60 * MIN);
    row = await rowOf(cf);
    expect(del.mock.calls.map(([id]) => id)).toEqual([cf]);
    expect([ms(row.cf_deleted_at), ms(row.bunny_cleaned_at)]).toEqual([v + 60 * MIN, v + 60 * MIN]);
  });

  // Phase 3 review I1 (controller ruling 2026-11-24): Cloudflare counts a match's live minutes against its RECORDING uid, and whether
  // its analytics still answer for a deleted video is unmeasured. So with SEAZN_HOSTED_COST on, the mover keeps the Cloudflare copy
  // until the session's Cloudflare minutes are measured through the session's END DAY (`live_measured_through` >= the end's UTC
  // date) — read by the REAL claim, beside G-D's 60 min. Waiting, the row is due again at the later of the end day's close and
  // 60 min on (the ruling's numbers, typed). The delivery row is written by SQL here: its writer is seazn-cost.test.ts's, where
  // the same sequence runs through the real measure.
  const ONE_DAY = 24 * 60 * MIN;
  const endDayOf = (endedAt: number) => Date.parse(`${new Date(endedAt).toISOString().slice(0, 10)}T00:00:00.000Z`);
  const ymdOf = (at: number) => new Date(at).toISOString().slice(0, 10);
  const dueAgain = (endedAt: number, now: number) => Math.max(endDayOf(endedAt) + ONE_DAY, now + 60 * MIN);
  const claimAt = (cf: string, at: number) => sql`update fixture_video_replays set next_attempt_at = ${new Date(at)} where cf_video_id = ${cf}`;

  it("I1: with SEAZN_HOSTED_COST on, the Cloudflare copy is kept past verified + 60 min until the session's Cloudflare minutes are measured through its end day — not with no delivery row, not with only the REPLAY half measured, not through the day before; then deleted by its own id", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const e = await toEncoding(w, f, [{}]);
    const cf = e.ids[0]!;
    vi.stubEnv("SEAZN_HOSTED_COST", "true");
    w.host.advance(e.rows[0]!.bunny_video_id!);
    const v = e.t0 + 15 * MIN;
    expect(await move(w, v)).toMatchObject({ playable: 1, failed: 0 });
    const del = vi.spyOn(w.ingest, "deleteVideo");
    const endDay = endDayOf(e.endedAt);
    const held: string[] = [];
    const heldAt = async (what: string, at: number) => {
      await claimAt(cf, at);
      await move(w, at);
      const row = await rowOf(cf);
      expect(del, `${what}: no Cloudflare delete`).not.toHaveBeenCalled();
      expect([row.state, row.cf_deleted_at, ms(row.next_attempt_at)], `${what}: kept, due again at the later of the end day's close and 60 min on`)
        .toEqual(["playable", null, dueAgain(e.endedAt, at)]);
      held.push(what);
    };
    await heldAt("verified + 60 min, no delivery row", v + 60 * MIN);
    // The REPLAY half measured through the end day says nothing about Cloudflare's: the gate reads the LIVE day (mutant: read the
    // replay column → deleted here).
    await sql`insert into fixture_video_delivery (session_id, org_id, replay_minutes, replay_measured_through) values (${e.sid}, ${w.auth.orgId}, 4, ${ymdOf(endDay)}::date)`;
    await heldAt("only the replay half measured", v + 61 * MIN);
    await sql`update fixture_video_delivery set live_minutes = 13, live_measured_through = ${ymdOf(endDay - ONE_DAY)}::date where session_id = ${e.sid}`;
    await heldAt("live measured through the day BEFORE the end day", v + 62 * MIN);
    expect(held, "anti-vacuity: every holding case ran").toHaveLength(3);

    await sql`update fixture_video_delivery set live_measured_through = ${ymdOf(endDay)}::date where session_id = ${e.sid}`;
    const at = v + 63 * MIN;
    await claimAt(cf, at);
    await move(w, at);
    expect(del.mock.calls.map(([id]) => id), "measured through the end day: deleted, by the row's own id").toEqual([cf]);
    expect(ms((await rowOf(cf)).cf_deleted_at)).toBe(at);
  });

  it("I1: with SEAZN_HOSTED_COST off — unset, false, or malformed (read as off, warned) — nothing measures, so the delete never waits for a measure: deleted at verified + 60 min with no delivery row", async () => {
    let checked = 0;
    for (const flag of [undefined, "false", "yes"]) {
      vi.stubEnv("SEAZN_HOSTED_COST", "");   // read as unset until the case's own value
      const w = await world();
      const e = await toEncoding(w, w.fixtureIds[0], [{}]);
      const cf = e.ids[0]!;
      w.host.advance(e.rows[0]!.bunny_video_id!);
      const v = e.t0 + 15 * MIN;
      await move(w, v);
      vi.stubEnv("SEAZN_HOSTED_COST", flag ?? "");
      const warn = vi.spyOn(log, "warn");
      const del = vi.spyOn(w.ingest, "deleteVideo");
      await move(w, v + 60 * MIN);
      expect(del.mock.calls.map(([id]) => id), `SEAZN_HOSTED_COST=${String(flag)}`).toEqual([cf]);
      expect(await sql`select 1 from fixture_video_delivery where session_id = ${e.sid}`, "PREMISE: nothing was measured").toHaveLength(0);
      const flagWarnings = warn.mock.calls.filter(([, m]) => typeof m === "string" && m.includes("SEAZN_HOSTED_COST is not true/false"));
      expect(flagWarnings.length > 0, `${String(flag)}: warned only when malformed`).toBe(flag === "yes");
      warn.mockRestore();
      del.mockRestore();
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("I1: an organiser-deleted row with SEAZN_HOSTED_COST on — its host copy is removed at once, its Cloudflare copy waits for the measure through the end day, then goes and the row is cleaned", async () => {
    const w = await world();
    const e = await toEncoding(w, w.fixtureIds[0], [{}]);
    const cf = e.ids[0]!;
    const guid = e.rows[0]!.bunny_video_id!;
    vi.stubEnv("SEAZN_HOSTED_COST", "true");
    w.host.advance(guid);
    const v = e.t0 + 15 * MIN;
    await move(w, v);
    await sql`update fixture_video_replays set state = 'deleted', deleted_reason = 'organiser', deleted_at = ${new Date(v + 5 * MIN)}, next_attempt_at = ${new Date(v + 5 * MIN)} where cf_video_id = ${cf}`;
    const del = vi.spyOn(w.ingest, "deleteVideo");
    const at = v + 70 * MIN;
    await claimAt(cf, at);
    await move(w, at);
    let row = await rowOf(cf);
    expect(w.host.videoIds(), "the host copy is removed at once").not.toContain(guid);
    expect(del, "past verified + 60 min, not measured: the Cloudflare copy waits").not.toHaveBeenCalled();
    expect([row.bunny_video_id, row.bunny_cleaned_at, row.cf_deleted_at, ms(row.next_attempt_at)]).toEqual([null, null, null, dueAgain(e.endedAt, at)]);
    await sql`insert into fixture_video_delivery (session_id, org_id, live_minutes, live_measured_through) values (${e.sid}, ${w.auth.orgId}, 13, ${ymdOf(endDayOf(e.endedAt))}::date)`;
    const later = at + MIN;
    await claimAt(cf, later);
    await move(w, later);
    row = await rowOf(cf);
    expect(del.mock.calls.map(([id]) => id)).toEqual([cf]);
    expect([ms(row.cf_deleted_at), ms(row.bunny_cleaned_at)]).toEqual([later, later]);
  });

  it("an organiser-deleted row that was never verified: its copy is removed and it is cleaned, and its Cloudflare copy is NEVER deleted from here", async () => {
    const w = await world();
    const e = await toEncoding(w, w.fixtureIds[0], [{}]);
    const cf = e.ids[0]!;
    await sql`update fixture_video_replays set state = 'deleted', deleted_reason = 'organiser', deleted_at = ${new Date(e.t0)} where cf_video_id = ${cf}`;
    const del = vi.spyOn(w.ingest, "deleteVideo");
    await move(w, e.t0 + 2 * 24 * 60 * MIN);
    const row = await rowOf(cf);
    expect(w.host.videoIds()).toEqual([]);
    expect([row.bunny_cleaned_at === null, row.cf_deleted_at]).toEqual([false, null]);
    expect(del).not.toHaveBeenCalled();
  });

  it("two rows of one new org make ONE createCollection call, and both copies land in it", async () => {
    const w = await world();
    const collection = vi.spyOn(w.host, "createCollection");
    const e = await toEncoding(w, w.fixtureIds[0], [{}, {}]);
    expect(collection).toHaveBeenCalledTimes(1);
    const [a, b] = e.rows.map((r) => w.host.collectionOf(r.bunny_video_id!));
    expect(a).toBe(b);
    expect(w.host.collectionName(a!)).toBe(`org:${w.auth.orgId}`);
    const [stored] = await sql<{ collection_id: string }[]>`select collection_id from org_video_collections where org_id = ${w.auth.orgId}`;
    expect(stored?.collection_id).toBe(a);
  });

  it("G1: a YouTube session's recordings are never discovered", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const yt = await endedWith(w, f, [{}], w.pasted);
    await decide(f, yt.endedAt);
    const s = spies(w);
    expect(await discover(w, yt.endedAt + 24 * 60 * MIN)).toMatchObject({ discovered: 0 });
    expect(s.list).not.toHaveBeenCalled();
    expect(await rowsOf(f)).toEqual([]);
  });

  it("an input whose recording is still in progress is not marked: listed again on the next firing, and its row is made once it finishes", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const s0 = await endedWith(w, f, [{}, { inProgress: true }]);
    await decide(f, s0.endedAt);
    const t0 = s0.endedAt + 15 * MIN;
    expect(await discover(w, t0)).toMatchObject({ discovered: 1 });
    w.ingest.updateVideo(s0.ids[1]!, { inProgress: false, state: "ready", durationSeconds: 120, height: 1080 });
    expect(await discover(w, t0 + MIN)).toMatchObject({ discovered: 1 });
    expect((await rowsOf(f)).map((r) => [r.part_no, r.cf_video_id])).toEqual([[1, s0.ids[0]], [2, s0.ids[1]]]);
    expect(await discover(w, t0 + 2 * MIN)).toMatchObject({ discovered: 0 });
  });

  it("T23 carry: a recording whose listing has no creation time falls back to its session's start, warned by its id only", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const s0 = await endedWith(w, f, [{}]);
    w.ingest.updateVideo(s0.ids[0]!, { createdAt: "not a date" });
    await decide(f, s0.endedAt);
    const warn = vi.spyOn(log, "warn");
    try {
      await discover(w, s0.endedAt + 15 * MIN);
      const [{ created_at }] = await sql<{ created_at: Date }[]>`select created_at from fixture_stream_sessions where id = ${s0.sid}`;
      expect(ms((await rowOf(s0.ids[0]!)).recorded_at)).toBe(ms(created_at));
      const lines = warn.mock.calls.filter(([, m]) => typeof m === "string" && /no creation time/.test(m));
      expect(lines.map(([o]) => o)).toEqual([{ sid: s0.sid, videoId: s0.ids[0] }]);
    } finally {
      warn.mockRestore();
    }
  });

  it("secrets: a fetch refused with the signed download URL in its message — the URL's token reaches no log line and no row", async () => {
    vi.stubEnv("STREAM_PLAYBACK_HOST", "customer-t24test.cloudflarestream.com");
    const w = await world();
    const f = w.fixtureIds[0];
    const s0 = await endedWith(w, f, [{}]);
    await decide(f, s0.endedAt);
    const t0 = s0.endedAt + 15 * MIN;
    await discover(w, t0);
    let sent = "";
    vi.spyOn(w.host, "fetchFromUrl").mockImplementationOnce(async (a) => { sent = a.url; throw new Error(`could not fetch ${a.url}`); });
    const logs = [vi.spyOn(log, "error"), vi.spyOn(log, "warn"), vi.spyOn(log, "info")];
    try {
      expect(await move(w, t0)).toMatchObject({ failed: 1 });
      const token = new URL(sent).pathname.split("/")[1]!;
      expect(token, "PREMISE: a token was sent").toMatch(/^fake\./);
      const logged = JSON.stringify(logs.flatMap((l) => l.mock.calls));
      expect(logged, "PREMISE: the failure was logged").toMatch(/\[token\]/);
      expect(logged).not.toContain(token);
      const [{ row }] = await sql<{ row: string }[]>`select to_jsonb(r)::text as row from fixture_video_replays r where cf_video_id = ${s0.ids[0]!}`;
      expect(row).not.toContain(token);
    } finally {
      for (const l of logs) l.mockRestore();
    }
  });

  // ─── Task 24 review, round 2 (2026-11-22) ──────────────────────────────────────────────────────────────────────────────
  const DAY = 24 * 60 * MIN;
  const PARKED = Date.parse("9999-12-31T00:00:00.000Z");
  const NOTHING = { discovered: 0, moved: 0, playable: 0, refused: 0, failed: 0, deferred: 0 };
  const replayIdOf = (o: unknown) => (o as { replayId?: string } | undefined)?.replayId;

  it("review I1: Cloudflare still making the MP4 — `inprogress` on two firings, then `ready`: no fetch and the row due again at once after each `inprogress`, then one fetch", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const s0 = await endedWith(w, f, [{}]);
    await decide(f, s0.endedAt);
    const t0 = s0.endedAt + 15 * MIN;
    await discover(w, t0);
    const cf = s0.ids[0]!;
    w.ingest.scriptDownload(cf, ["inprogress", "inprogress"]);
    const fetch = vi.spyOn(w.host, "fetchFromUrl");
    let checked = 0;
    for (const [k, now] of [t0, t0 + MIN].entries()) {
      expect(await move(w, now), `firing ${k + 1}`).toMatchObject({ failed: 0, deferred: 0 });
      const row = await rowOf(cf);
      expect([row.state, ms(row.next_attempt_at), row.attempts, row.bunny_video_id], `firing ${k + 1}: asked again on the next firing`).toEqual(["downloading", now, 0, null]);
      expect(w.ingest.downloadCalls, `firing ${k + 1}`).toEqual(Array(k + 1).fill(cf));
      expect(fetch, `firing ${k + 1}: no fetch of an MP4 that is not ready`).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked, "inprogress firings").toBe(2);
    await move(w, t0 + 2 * MIN);
    expect(w.ingest.downloadCalls, "ready on the third ask").toEqual([cf, cf, cf]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await rowOf(cf)).state).toBe("encoding");
  });

  it("review I1: a provider call that throws in each calling step — the download, the poll, the Cloudflare delete, the cleanup's remove — keeps the row's state and copy, counts one attempt, backs off 1 min, and logs the step", async () => {
    const boom = (what: string) => new Error(`${what}: HTTP 500`);
    const CASES: { step: string; arm: (w: World) => Promise<{ cf: string; now: number; state: string; guid: string | null }> }[] = [
      { step: "create_download", arm: async (w) => {
        const s0 = await endedWith(w, w.fixtureIds[0], [{}]);
        await decide(w.fixtureIds[0], s0.endedAt);
        const t0 = s0.endedAt + 15 * MIN;
        await discover(w, t0);
        vi.spyOn(w.ingest, "createDownload").mockRejectedValueOnce(boom("cloudflare create download"));
        return { cf: s0.ids[0]!, now: t0, state: "downloading", guid: null };   // found → downloading is written before the call
      } },
      { step: "poll_state", arm: async (w) => {
        const e = await toEncoding(w, w.fixtureIds[0], [{}]);
        vi.spyOn(w.host, "video").mockRejectedValueOnce(boom("bunny video"));
        return { cf: e.ids[0]!, now: e.t0 + 15 * MIN, state: "encoding", guid: e.rows[0]!.bunny_video_id };
      } },
      { step: "delete_cf", arm: async (w) => {
        const e = await toEncoding(w, w.fixtureIds[0], [{}]);
        w.host.advance(e.rows[0]!.bunny_video_id!);
        await move(w, e.t0 + 15 * MIN);
        vi.spyOn(w.ingest, "deleteVideo").mockRejectedValueOnce(boom("cloudflare delete video"));
        return { cf: e.ids[0]!, now: e.t0 + 75 * MIN, state: "playable", guid: e.rows[0]!.bunny_video_id };
      } },
      { step: "cleanup", arm: async (w) => {
        const e = await toEncoding(w, w.fixtureIds[0], [{}]);
        await sql`update fixture_video_replays set state = 'deleted', deleted_reason = 'organiser', deleted_at = ${new Date(e.t0)}, next_attempt_at = ${new Date(e.t0)} where cf_video_id = ${e.ids[0]!}`;
        vi.spyOn(w.host, "remove").mockRejectedValueOnce(boom("bunny remove"));
        return { cf: e.ids[0]!, now: e.t0 + MIN, state: "deleted", guid: e.rows[0]!.bunny_video_id };
      } },
    ];
    let checked = 0;
    for (const c of CASES) {
      const w = await world();
      const a = await c.arm(w);
      expect((await rowOf(a.cf)).attempts, `PREMISE ${c.step}: no attempt yet, so the backoff is 2^0 = 1 min`).toBe(0);
      const errors = vi.spyOn(log, "error");
      try {
        expect(await move(w, a.now), c.step).toMatchObject({ failed: 1 });
        const row = await rowOf(a.cf);
        expect([row.state, row.attempts, ms(row.next_attempt_at), row.bunny_video_id], c.step).toEqual([a.state, 1, a.now + MIN, a.guid]);
        expect([row.cf_deleted_at, row.bunny_cleaned_at], `${c.step}: nothing recorded as done`).toEqual([null, null]);
        const steps = errors.mock.calls.filter(([o]) => replayIdOf(o) === row.id).map(([o]) => (o as { step?: string }).step);
        expect(steps, c.step).toEqual([c.step]);
      } finally {
        errors.mockRestore();
      }
      checked++;
    }
    expect(checked, "calling steps").toBe(4);
  });

  it("review I2: a downloading row whose download keeps failing backs off inside its 30 days; from 30 days after its recording it is parked as failed — one log line — and never claimed again", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const s0 = await endedWith(w, f, [{}]);
    await decide(f, s0.endedAt);
    await discover(w, s0.endedAt + 15 * MIN);
    const cf = s0.ids[0]!;
    const { id, recorded_at } = await rowOf(cf);
    const dl = vi.spyOn(w.ingest, "createDownload").mockRejectedValue(new Error("cloudflare create download: the download failed (status error)"));
    const logs = [vi.spyOn(log, "error"), vi.spyOn(log, "warn")];
    const linesOf = () => logs.flatMap((l) => l.mock.calls).filter(([o]) => replayIdOf(o) === id);
    try {
      const inside = ms(recorded_at)! + 30 * DAY - MIN;
      expect(await move(w, inside)).toMatchObject({ failed: 1 });
      let row = await rowOf(cf);
      expect([row.state, row.attempts, ms(row.next_attempt_at)], "1 min inside the window: the backoff").toEqual(["downloading", 1, inside + MIN]);
      expect(linesOf()).toHaveLength(1);
      const past = inside + MIN;   // exactly 30 days after the recording, and due
      expect(await move(w, past)).toMatchObject({ failed: 1 });
      row = await rowOf(cf);
      expect([row.state, row.attempts, ms(row.next_attempt_at)], "30 days: parked as failed").toEqual(["failed", 2, PARKED]);
      expect(linesOf(), "one more line: the give-up").toHaveLength(2);
      expect(JSON.stringify(linesOf()[1])).toMatch(/given up/);
      for (const later of [past + DAY, past + 365 * DAY]) expect(await move(w, later)).toEqual(NOTHING);
      expect(dl, "never asked again").toHaveBeenCalledTimes(2);
      expect(linesOf(), "and never logged again").toHaveLength(2);
    } finally {
      for (const l of logs) l.mockRestore();
    }
  });

  it("review I2: ten rows stuck failing cannot starve the claim — a fresh row behind a full batch of them moves on the very next firing, and past their window they are parked and never claimed again", async () => {
    const w = await world();
    const [f, g] = w.fixtureIds;
    const stuck = await endedWith(w, f, Array.from({ length: 10 }, () => ({})));
    const fresh = await endedWith(w, g, [{}]);
    await decide(f, stuck.endedAt);
    await decide(g, fresh.endedAt);
    const T = Math.max(stuck.endedAt, fresh.endedAt) + 15 * MIN;
    expect(await discover(w, T)).toMatchObject({ discovered: 11 });
    // The stuck rows have been due for an hour, the fresh one since this firing: the claim's order puts all ten first.
    await sql`update fixture_video_replays set next_attempt_at = ${new Date(T - 60 * MIN)} where cf_video_id in ${sql(stuck.ids)}`;
    const stuckIds = new Set(stuck.ids);
    const real = w.ingest.createDownload.bind(w.ingest);
    const dl = vi.spyOn(w.ingest, "createDownload").mockImplementation(async (id: string) => {
      if (stuckIds.has(id)) throw new Error("cloudflare create download: HTTP 404 code 10003");
      return real(id);
    });
    const fetch = vi.spyOn(w.host, "fetchFromUrl");
    expect(await move(w, T), "a full batch of stuck rows").toMatchObject({ failed: 10 });
    expect((await rowOf(fresh.ids[0]!)).state, "PREMISE: the batch was full — the fresh row was not reached").toBe("found");
    await move(w, T + MIN);
    expect((await rowOf(fresh.ids[0]!)).state, "the next firing: the stuck rows backed off behind it").toBe("encoding");
    expect(fetch).toHaveBeenCalledTimes(1);
    const end = Math.max(...(await rowsOf(f)).map((r) => ms(r.recorded_at)!)) + 30 * DAY;
    expect(await move(w, end), "each stuck row: one last ask, then parked").toMatchObject({ failed: 10 });
    expect((await rowsOf(f)).map((r) => [r.state, ms(r.next_attempt_at)])).toEqual(Array(10).fill(["failed", PARKED]));
    const asked = dl.mock.calls.filter(([id]) => stuckIds.has(id)).length;
    await move(w, end + DAY);
    await move(w, end + 60 * DAY);
    expect(dl.mock.calls.filter(([id]) => stuckIds.has(id)).length, "never claimed again").toBe(asked);
  });

  it("review I3: every Cloudflare call the move makes names the move's 4 s timeout — the listing, the download, the download token and the delete", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const s0 = await endedWith(w, f, [{}]);
    await decide(f, s0.endedAt);
    const calls = {
      listInputVideos: vi.spyOn(w.ingest, "listInputVideos"),
      createDownload: vi.spyOn(w.ingest, "createDownload"),
      playbackToken: vi.spyOn(w.ingest, "playbackToken"),
      deleteVideo: vi.spyOn(w.ingest, "deleteVideo"),
    };
    const t0 = s0.endedAt + 15 * MIN;
    await discover(w, t0);
    await move(w, t0);
    const [row] = await rowsOf(f);
    w.host.advance(row!.bunny_video_id!);
    await move(w, t0 + 15 * MIN);
    await move(w, t0 + 75 * MIN);
    expect((await rowOf(s0.ids[0]!)).cf_deleted_at, "PREMISE: the move ran to its end").not.toBeNull();
    let checked = 0;
    for (const [name, spy] of Object.entries(calls)) {
      expect(spy.mock.calls.length, `${name}: called`).toBeGreaterThan(0);
      for (const args of spy.mock.calls) {
        expect((args as unknown[])[1], name).toMatchObject({ timeoutMs: 4_000 });
        checked++;
      }
    }
    expect(checked, "calls checked").toBeGreaterThanOrEqual(4);
  });

  it("review I3: the org's first collection is made with no transaction open — no connection sits idle in a transaction on org_video_collections while the host is asked", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const s0 = await endedWith(w, f, [{}]);
    await decide(f, s0.endedAt);
    const t0 = s0.endedAt + 15 * MIN;
    await discover(w, t0);
    const real = w.host.createCollection.bind(w.host);
    let open = -1;
    vi.spyOn(w.host, "createCollection").mockImplementation(async (orgId: string) => {
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
         where datname = current_database() and state like 'idle in transaction%' and query ilike '%select collection_id from org_video_collections%'`;
      open = n;
      return real(orgId);
    });
    await move(w, t0);
    expect(open, "PREMISE: the host was asked").toBeGreaterThanOrEqual(0);
    expect(open, "no transaction held across the host's call").toBe(0);
    expect((await rowOf(s0.ids[0]!)).state).toBe("encoding");
  });

  it("review I3: two runs racing for one org's FIRST collection — both make one, the first STORED wins, the other run's copy lands in it too, and the spare is logged once by its id", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const s0 = await endedWith(w, f, [{}, {}]);
    await decide(f, s0.endedAt);
    const t0 = s0.endedAt + 15 * MIN;
    await discover(w, t0);
    const b = s0.ids[1]!;
    // Only the first row is due; the second waits until the first run is inside the host's call.
    await sql`update fixture_video_replays set next_attempt_at = ${new Date(t0 + 10 * MIN)} where cf_video_id = ${b}`;
    const real = w.host.createCollection.bind(w.host);
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    let entered!: () => void;
    const inside = new Promise<void>((res) => { entered = res; });
    const made: string[] = [];
    vi.spyOn(w.host, "createCollection").mockImplementation(async (orgId: string) => {
      const first = made.length === 0;
      const id = await real(orgId);
      made.push(id);
      if (first) { entered(); await gate; }
      return id;
    });
    const warn = vi.spyOn(log, "warn");
    try {
      const runA = move(w, t0);
      await inside;
      await sql`update fixture_video_replays set next_attempt_at = ${new Date(t0)} where cf_video_id = ${b}`;
      await move(w, t0);   // run B: claims the second row (the first is leased), makes the second collection and stores it
      release();
      await runA;
      expect(made, "each run made one").toHaveLength(2);
      const [{ collection_id: stored }] = await sql<{ collection_id: string }[]>`select collection_id from org_video_collections where org_id = ${w.auth.orgId}`;
      expect(stored, "the first STORED — run B's").toBe(made[1]);
      const rows = await rowsOf(f);
      expect(rows.map((r) => r.state)).toEqual(["encoding", "encoding"]);
      expect(rows.map((r) => w.host.collectionOf(r.bunny_video_id!)), "both copies in the stored collection").toEqual([stored, stored]);
      const spare = warn.mock.calls.filter(([o]) => (o as { collectionId?: string } | undefined)?.collectionId === made[0]);
      expect(spare, "the spare logged once, by its id").toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("review m2: a poll answering `failed` for a row another run verified meanwhile removes nothing — the conditional write comes first, and the verified copy stays", async () => {
    const w = await world();
    const e = await toEncoding(w, w.fixtureIds[0], [{}]);
    const cf = e.ids[0]!;
    const guid = e.rows[0]!.bunny_video_id!;
    const v = e.t0 + 15 * MIN;
    const real = w.host.video.bind(w.host);
    vi.spyOn(w.host, "video").mockImplementationOnce(async (id: string) => {
      // Another run's poll verified the copy while this run's GET was slow; this run's answer is the stale one.
      await sql`update fixture_video_replays set state = 'playable', verified_at = ${new Date(v)}, next_attempt_at = ${new Date(v + 60 * MIN)} where cf_video_id = ${cf}`;
      return { ...(await real(id)), state: "failed" };
    });
    await move(w, v);
    const row = await rowOf(cf);
    expect([row.state, row.bunny_video_id], "the other run's verification stands").toEqual(["playable", guid]);
    expect(w.host.videoIds(), "the verified copy stays on the host").toContain(guid);
  });

  it("review m6: a `fetching` row that holds a copy (a shape nothing writes) is refused by name — no fetch, poll or delete — backed off inside its window and parked as failed past it", async () => {
    const w = await world();
    const e = await toEncoding(w, w.fixtureIds[0], [{}]);
    const cf = e.ids[0]!;
    await sql`update fixture_video_replays set state = 'fetching', state_at = ${new Date(e.t0)}, next_attempt_at = ${new Date(e.t0)} where cf_video_id = ${cf}`;
    const s = spies(w);
    const errors = vi.spyOn(log, "error");
    try {
      expect(await move(w, e.t0 + MIN)).toMatchObject({ failed: 1 });
      let row = await rowOf(cf);
      expect([row.state, row.attempts, ms(row.next_attempt_at), row.bunny_video_id]).toEqual(["fetching", 1, e.t0 + 2 * MIN, e.rows[0]!.bunny_video_id]);
      expect(errors.mock.calls.filter(([o]) => replayIdOf(o) === row.id).map(([o]) => (o as { reason?: string; step?: string }).reason ?? (o as { step?: string }).step))
        .toEqual(["fetching_holds_video", "refuse:fetching_holds_video"]);
      const past = ms(row.recorded_at)! + 30 * DAY;
      await move(w, past);
      row = await rowOf(cf);
      // Task 31b: the row holds a copy, so it is failed but not parked yet — due after the backoff (2^1 min), when give_up removes the
      // copy and only then parks it.
      expect([row.state, ms(row.next_attempt_at), row.bunny_video_id], "past the window: failed, its copy still to remove").toEqual(["failed", past + 2 * MIN, e.rows[0]!.bunny_video_id]);
      await move(w, past + 2 * MIN);
      row = await rowOf(cf);
      expect([row.state, ms(row.next_attempt_at), row.bunny_video_id], "then parked, holding nothing").toEqual(["failed", PARKED, null]);
      expect(w.host.videoIds(), "the copy is gone from the host").not.toContain(e.rows[0]!.bunny_video_id);
      expect([s.fetch.mock.calls.length, s.poll.mock.calls.length, s.del.mock.calls.length]).toEqual([0, 0, 0]);
    } finally {
      errors.mockRestore();
    }
  });

  it("review m6: a failed row past its window is given up — parked with no provider call — and never claimed again", async () => {
    const w = await world();
    const e = await toEncoding(w, w.fixtureIds[0], [{}]);
    w.host.fail(e.rows[0]!.bunny_video_id!);
    await move(w, e.t0 + 15 * MIN);
    let row = await rowOf(e.ids[0]!);
    expect(row.state, "PREMISE: the copy failed its check").toBe("failed");
    const s = spies(w);
    const asked = w.ingest.downloadCalls.length;
    const past = ms(row.recorded_at)! + 30 * DAY;
    expect(await move(w, past)).toMatchObject({ failed: 0, moved: 0 });
    row = await rowOf(e.ids[0]!);
    expect([row.state, ms(row.next_attempt_at)]).toEqual(["failed", PARKED]);
    expect(await move(w, past + DAY)).toEqual(NOTHING);
    expect([w.ingest.downloadCalls.length, s.fetch.mock.calls.length, s.del.mock.calls.length], "no provider call").toEqual([asked, 0, 0]);
  });

  it("review m6: a deleted row whose Cloudflare delete answers in_progress keeps cf_deleted_at and bunny_cleaned_at null and is due again at once; the next run deletes the stored id and cleans the row", async () => {
    const w = await world();
    const e = await toEncoding(w, w.fixtureIds[0], [{}]);
    const cf = e.ids[0]!;
    w.host.advance(e.rows[0]!.bunny_video_id!);
    const v = e.t0 + 15 * MIN;
    await move(w, v);
    await sql`update fixture_video_replays set state = 'deleted', deleted_reason = 'organiser', deleted_at = ${new Date(v + 5 * MIN)}, next_attempt_at = ${new Date(v + 5 * MIN)} where cf_video_id = ${cf}`;
    await move(w, v + 10 * MIN);   // the copy goes at once; the Cloudflare copy waits for v + 60 min
    w.ingest.scriptDeleteVideo(cf, ["in_progress"]);
    const del = vi.spyOn(w.ingest, "deleteVideo");
    await move(w, v + 60 * MIN);
    let row = await rowOf(cf);
    expect([row.cf_deleted_at, row.bunny_cleaned_at, ms(row.next_attempt_at)], "in_progress: kept, due again at once").toEqual([null, null, v + 60 * MIN]);
    await move(w, v + 61 * MIN);
    row = await rowOf(cf);
    expect([ms(row.cf_deleted_at), ms(row.bunny_cleaned_at)]).toEqual([v + 61 * MIN, v + 61 * MIN]);
    expect(w.ingest.deletedVideos).toEqual([cf]);
    expect(del.mock.calls, "review I3: the cleanup's delete names the move's timeout too").toEqual([[cf, { timeoutMs: 4_000 }], [cf, { timeoutMs: 4_000 }]]);
  });

  // ─── Task 24 re-review (2026-11-22) ────────────────────────────────────────────────────────────────────────────────────
  it("re-review N1: an OLD replay deleted today keeps its cleanup retries — a remove that fails backs off (not parked, copy id kept), and the next firing removes the copy and cleans the row; one deleted 30 days ago is parked as deleted", async () => {
    const w = await world();
    const e = await toEncoding(w, w.fixtureIds[0], [{}, {}]);
    const [today, monthAgo] = e.ids as [string, string];
    const [guid, oldGuid] = [e.rows[0]!.bunny_video_id!, e.rows[1]!.bunny_video_id!];
    const T = e.t0 + 60 * DAY;   // the organiser deletes one 60 days after it was recorded; the other was deleted 30 days before that
    const del = (cf: string, at: number) =>
      sql`update fixture_video_replays set state = 'deleted', deleted_reason = 'organiser', deleted_at = ${new Date(at)}, next_attempt_at = ${new Date(T)} where cf_video_id = ${cf}`;
    await del(today, T);
    await del(monthAgo, T + MIN - 30 * DAY);   // exactly 30 days before the run below
    const remove = vi.spyOn(w.host, "remove").mockRejectedValue(new Error("bunny remove: request failed before a response"));
    expect(await move(w, T + MIN)).toMatchObject({ failed: 2 });
    let row = await rowOf(today);
    expect([row.state, row.attempts, ms(row.next_attempt_at), row.bunny_video_id, row.bunny_cleaned_at], "backed off from its delete, not parked").toEqual(["deleted", 1, T + 2 * MIN, guid, null]);
    const old = await rowOf(monthAgo);
    expect([old.state, ms(old.next_attempt_at), old.bunny_video_id], "30 days past its own delete: parked, still deleted, its copy still named").toEqual(["deleted", PARKED, oldGuid]);
    remove.mockRestore();
    await move(w, T + 2 * MIN);
    row = await rowOf(today);
    expect(w.host.videoIds(), "the copy the organiser deleted today is gone").not.toContain(guid);
    expect([row.bunny_video_id, ms(row.bunny_cleaned_at)]).toEqual([null, T + 2 * MIN]);
  });

  it("re-review N2: a copy that failed its check whose remove fails keeps its reference on the failed row — never forgotten — and the retry removes it before the move starts again", async () => {
    const w = await world();
    const e = await toEncoding(w, w.fixtureIds[0], [{}]);
    const cf = e.ids[0]!;
    const firstCopy = e.rows[0]!.bunny_video_id!;
    w.host.fail(firstCopy);
    const remove = vi.spyOn(w.host, "remove").mockRejectedValueOnce(new Error("bunny remove: request failed before a response"));
    const p1 = e.t0 + 15 * MIN;
    expect(await move(w, p1)).toMatchObject({ failed: 1 });
    let row = await rowOf(cf);
    expect([row.state, row.bunny_video_id, row.attempts, ms(row.next_attempt_at)], "failed, still holding the copy it could not remove").toEqual(["failed", firstCopy, 1, p1 + MIN]);
    expect(w.host.videoIds(), "PREMISE: the remove failed, so the copy is still on the host").toContain(firstCopy);
    await move(w, p1 + MIN);   // the retry
    row = await rowOf(cf);
    expect(remove.mock.calls.map(([id]) => id), "the retry asked for the held copy first").toEqual([firstCopy, firstCopy]);
    expect(w.host.videoIds(), "removed by the retry").not.toContain(firstCopy);
    expect(row.state, "then the move started again and fetched a new copy").toBe("encoding");
    expect(row.bunny_video_id).not.toBe(firstCopy);
  });

  it("re-review N5: a PLAYABLE row past its window whose Cloudflare delete keeps failing is parked as playable — its verified copy is never hidden", async () => {
    const w = await world();
    const e = await toEncoding(w, w.fixtureIds[0], [{}]);
    const cf = e.ids[0]!;
    const guid = e.rows[0]!.bunny_video_id!;
    w.host.advance(guid);
    const v = e.t0 + 15 * MIN;
    await move(w, v);
    const before = await rowOf(cf);
    expect(before.state, "PREMISE: verified").toBe("playable");
    vi.spyOn(w.ingest, "deleteVideo").mockRejectedValue(new Error("cloudflare deleteVideo: HTTP 500"));
    const past = ms(before.recorded_at)! + 30 * DAY;
    expect(await move(w, past)).toMatchObject({ failed: 1 });
    const row = await rowOf(cf);
    expect([row.state, ms(row.next_attempt_at), ms(row.verified_at), row.bunny_video_id, row.cf_deleted_at]).toEqual(["playable", PARKED, v, guid, null]);
    expect(await move(w, past + DAY)).toEqual(NOTHING);
  });

  // ─── Task 31b, item 2 (the Task 24 re-review 2 carry) ────────────────────────────────────────────────────────────────────
  it("Task 31b: a failed row still holding its failed copy at day 30 has the copy removed BEFORE it is parked — no final read (never served); a removal failing then backs off, keeps the copy, and the next firing removes it and parks", async () => {
    const w = await world();
    const e = await toEncoding(w, w.fixtureIds[0], [{}]);
    const cf = e.ids[0]!;
    const copy = e.rows[0]!.bunny_video_id!;
    w.host.fail(copy);
    const remove = vi.spyOn(w.host, "remove").mockRejectedValueOnce(new Error("bunny remove: request failed before a response"));
    await move(w, e.t0 + 15 * MIN);   // the check fails it; its removal fails: failed, holding the copy (re-review N2)
    let row = await rowOf(cf);
    expect([row.state, row.bunny_video_id], "PREMISE: failed, holding its copy").toEqual(["failed", copy]);
    const reads = vi.spyOn(w.host, "watchMinutes");
    const past = ms(row.recorded_at)! + 30 * DAY;
    // Day 30, the host still refusing: the copy is kept on the row and the row is due again after its backoff — never parked holding it.
    remove.mockRejectedValueOnce(new Error("bunny remove: HTTP 503"));
    expect(await move(w, past)).toMatchObject({ failed: 1 });
    row = await rowOf(cf);
    expect([row.state, row.bunny_video_id, row.attempts, ms(row.next_attempt_at)], "not parked while it holds the copy").toEqual(["failed", copy, 2, past + 2 * MIN]);
    expect(w.host.videoIds(), "still on the host").toContain(copy);
    // The next firing after the backoff: removed, forgotten, THEN parked.
    expect(await move(w, past + 2 * MIN)).toMatchObject({ failed: 0 });
    row = await rowOf(cf);
    expect([row.state, row.bunny_video_id, ms(row.next_attempt_at)], "removed, then parked").toEqual(["failed", null, PARKED]);
    expect(w.host.videoIds(), "gone from the host").not.toContain(copy);
    expect(remove.mock.calls.map(([id]) => id), "asked three times, for that copy only").toEqual([copy, copy, copy]);
    expect(reads, "a failed copy was never served: no final read").not.toHaveBeenCalled();
    expect(await move(w, past + DAY), "never claimed again").toEqual(NOTHING);
  });

  it("Task 31b: an ENCODING row whose poll still fails at day 30 is not parked holding its copy — failed, then the next firing removes the copy and parks it", async () => {
    const w = await world();
    const e = await toEncoding(w, w.fixtureIds[0], [{}]);
    const cf = e.ids[0]!;
    const copy = e.rows[0]!.bunny_video_id!;
    vi.spyOn(w.host, "video").mockRejectedValue(new Error("bunny video: HTTP 503"));
    const past = ms(e.rows[0]!.recorded_at)! + 30 * DAY;
    expect(await move(w, past)).toMatchObject({ failed: 1 });
    let row = await rowOf(cf);
    expect([row.state, row.bunny_video_id, row.attempts, ms(row.next_attempt_at)], "failed, its copy still to remove").toEqual(["failed", copy, 1, past + MIN]);
    await move(w, past + MIN);
    row = await rowOf(cf);
    expect([row.state, row.bunny_video_id, ms(row.next_attempt_at)]).toEqual(["failed", null, PARKED]);
    expect(w.host.videoIds()).not.toContain(copy);
  });

  it("re-review N4 (review m3): a database error storing the org's first collection is logged by its step and class alone — no detail, so a connection string it echoes never reaches a log — and the row backs off", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const s0 = await endedWith(w, f, [{}]);
    await decide(f, s0.endedAt);
    const t0 = s0.endedAt + 15 * MIN;
    await discover(w, t0);
    const SECRET = "hunter2-t24";
    const fn = `t24_refuse_${randomUUID().replaceAll("-", "")}`;
    // This org's insert alone is refused, with a message that quotes a connection string (as a pooler's error can).
    await sql.unsafe(`create function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'could not reach postgres://seazn:${SECRET}@db.internal:5432/seazn'; end $$`);
    await sql.unsafe(`create trigger ${fn} before insert on org_video_collections for each row when (new.org_id = '${w.auth.orgId}') execute function ${fn}()`);
    const logs = [vi.spyOn(log, "error"), vi.spyOn(log, "warn"), vi.spyOn(log, "info")];
    try {
      expect(await move(w, t0)).toMatchObject({ failed: 1 });
      const row = await rowOf(s0.ids[0]!);
      expect([row.state, row.attempts, ms(row.next_attempt_at)]).toEqual(["downloading", 1, t0 + MIN]);
      const lines = logs[0]!.mock.calls.filter(([o]) => replayIdOf(o) === row.id).map(([o]) => o as Record<string, unknown>);
      expect(lines.map((o) => [o.step, o.errClass, "detail" in o]), "the step, the class, no detail").toEqual([["store_collection", "PostgresError", false]]);
      expect(JSON.stringify(logs.flatMap((l) => l.mock.calls)), "the echoed secret reaches no log line").not.toContain(SECRET);
    } finally {
      for (const l of logs) l.mockRestore();
      await sql.unsafe(`drop trigger ${fn} on org_video_collections`);
      await sql.unsafe(`drop function ${fn}()`);
    }
  });
});
