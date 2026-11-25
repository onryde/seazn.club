// Seazn-hosted video, Phase 2 Task 27: `applyBunnyEvent`, the Bunny Stream webhook's use case, on the fakes.
//
// Every row comes from the REAL producers (the organiser's Go live, Stop, the lock pass, discovery and the move: _seazn-replay-rig.ts),
// so each copy on the replay fake is the one the move fetched, under the title the move gave it. The webhook is a TRIGGER, never
// trust (the binding rule): a "playable" event runs the mover's own check (`verifyReplayCopy`) on the host's own read of the copy.
// The expected values are the rulings' literals, typed here: the Cloudflare delete 60 min after verification (G-D), a first
// failure's backoff of 1 min (min(2^0, 60)), the fake's 120 s copy against a 1080p source (the source's own 1080 rung required, ±2 s).
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the webhook reads no sport rule; every rig rides `generic`.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

import { sql } from "@/lib/db";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import type { FakeIngest } from "@/server/relay/fakes";
import type { BunnyEvent } from "@/server/video/bunny-webhook";
import { FAKE_REPLAY_LENGTH_SECONDS, FakeReplayHost } from "@/server/video/replay-fake";
import { deleteSeaznReplay } from "@/server/video/organiser-replays";
import { discoveredReplays, replayRowsOf } from "@/server/video/__tests__/_seazn-replay-rig";
import { installSeaznEnv, seaznRig } from "@/server/video/__tests__/_seazn-session-rig";
import { type BunnyWebhookDeps, applyBunnyEvent, purgeBunnyWebhookEvents } from "../seazn-replay-webhook";

const HAS_DB = !!process.env.DATABASE_URL;
/** A replay fake whose copy ids are this test's own: the webhook looks a copy up by its id across the whole table (Bunny's guids are
 *  unique in the library, and one row per copy since V545), so a readable prefix of this test's own keeps its ids apart. */
const freshHost = () => new FakeReplayHost({ idPrefix: `t27-${randomUUID()}` });
const MIN = 60_000;
/** BUNNY_STREAM_LIBRARY_ID as the route hands it over. */
const LIBRARY = "424242";

installSeaznEnv("t27-webhook");

/** `parts` recordings of one Seazn match, moved by the real producers onto a fresh replay fake: every row `encoding`, holding the
 *  copy the move fetched. `now` is five minutes after the move ran. */
async function world(parts = 1) {
  const r = await seaznRig();
  const host = freshHost();
  const f = r.fixtureIds[0];
  const d = await discoveredReplays(r, f, host, parts);
  await d.move(d.t0);
  const rows = [...(await replayRowsOf(f))];
  expect(rows.map((x) => x.state), "PREMISE: every copy is on the host, encoding").toEqual(Array.from({ length: parts }, () => "encoding"));
  const hook: BunnyWebhookDeps = { libraryId: LIBRARY, replay: host };
  return { ...r, host, f, d, rows, hook, ingest: r.deps.drivers.ingest as FakeIngest, now: new Date(d.t0 + 5 * MIN) };
}
const event = (videoId: string, status: number, o: { eventId?: string; libraryId?: string } = {}): BunnyEvent => ({
  libraryId: o.libraryId ?? LIBRARY, videoId, status, eventId: o.eventId ?? `evt-${randomUUID()}`, at: new Date("2026-11-23T10:00:00.000Z"),
});
const marksOf = async (eventId: string) => (await sql<{ n: number }[]>`select count(*)::int as n from bunny_webhook_events where event_id = ${eventId}`)[0]!.n;
/** The whole row, every column: "nothing written" is this, unchanged. */
const rowOf = async (id: string) => (await sql<Record<string, unknown>[]>`select * from fixture_video_replays where id = ${id}`)[0]!;
const at = (d: unknown) => new Date(d as Date).getTime();

describe.skipIf(!HAS_DB)("applyBunnyEvent — the Bunny Stream webhook (Task 27)", () => {
  it("EMPTY CASE FIRST: Bunny's early statuses (0-2) and its other events are ignored — no mark, no read of the host, no row touched; so is any event of ANOTHER library, whatever its status", async () => {
    const w = await world();
    const row = w.rows[0]!;
    const before = await rowOf(row.id);
    const video = vi.spyOn(w.host, "video");
    const remove = vi.spyOn(w.host, "remove");
    const cases: [string, BunnyEvent][] = [
      ...[0, 1, 2, 6, 9, 32].map((s): [string, BunnyEvent] => [`status ${s}, a held copy`, event(row.bunny_video_id!, s)]),
      ["status 2, a copy no row holds (it may arrive before the move wrote the guid)", event(`unheld-${randomUUID()}`, 2)],
      ...[3, 4, 5].map((s): [string, BunnyEvent] => [`status ${s}, another library`, event(row.bunny_video_id!, s, { libraryId: "999" })]),
    ];
    let checked = 0;
    for (const [label, ev] of cases) {
      expect(await applyBunnyEvent(w.hook, ev, w.now), label).toBe("ignored");
      expect(await marksOf(ev.eventId), `${label}: no mark`).toBe(0);
      checked++;
    }
    expect(checked).toBe(10);
    expect(video, "the host was never read").not.toHaveBeenCalled();
    expect(remove, "nothing was removed").not.toHaveBeenCalled();
    expect(await rowOf(row.id), "the row is untouched").toEqual(before);
  });

  it("a copy held by a row PAST encoding is the mover's — a verified one, a failed one keeping its copy for the retry's removal, an organiser's delete awaiting cleanup: every event is ignored, the host neither read nor touched, each row untouched", async () => {
    const w = await world(3);
    const [verified, failed, deleted] = w.rows as [typeof w.rows[0], typeof w.rows[0], typeof w.rows[0]];
    for (const row of w.rows) w.host.advance(row.bunny_video_id!);
    await sql`update fixture_video_replays set state = 'playable', verified_at = ${w.now}, length_seconds = ${FAKE_REPLAY_LENGTH_SECONDS} where id = ${verified.id}`;
    await sql`update fixture_video_replays set state = 'failed', attempts = 1 where id = ${failed.id}`;
    await sql`update fixture_video_replays set state = 'deleted', deleted_at = ${w.now}, deleted_reason = 'organiser' where id = ${deleted.id}`;
    const before = await Promise.all(w.rows.map((r) => rowOf(r.id)));
    expect(before.map((r) => [r.state, r.bunny_video_id !== null]), "PREMISE: each row past encoding, each still naming its copy").toEqual([["playable", true], ["failed", true], ["deleted", true]]);
    const video = vi.spyOn(w.host, "video");
    const remove = vi.spyOn(w.host, "remove");
    let checked = 0;
    for (const row of w.rows) {
      for (const status of [3, 4, 5]) {
        expect(await applyBunnyEvent(w.hook, event(row.bunny_video_id!, status), w.now), `${row.part_no}: status ${status}`).toBe("ignored");
        checked++;
      }
    }
    expect(checked).toBe(9);
    expect(video, "the host was never read").not.toHaveBeenCalled();
    expect(remove, "nothing was removed").not.toHaveBeenCalled();
    expect(await Promise.all(w.rows.map((r) => rowOf(r.id))), "every row untouched").toEqual(before);
  });

  it("statuses 3 and 4, each on a copy that passes the check, make the row playable — verified now, the copy's length, the Cloudflare delete due 60 min later — with no Cloudflare call; the mover then deletes at verified + 60 min, by the row's own id", async () => {
    const w = await world(2);
    const del = vi.spyOn(w.ingest, "deleteVideo");
    const list = vi.spyOn(w.ingest, "listInputVideos");
    for (const row of w.rows) w.host.advance(row.bunny_video_id!);
    const [p1, p2] = w.rows as [typeof w.rows[0], typeof w.rows[0]];
    expect(await applyBunnyEvent(w.hook, event(p1.bunny_video_id!, 3), w.now), "status 3, Finished").toBe("applied");
    expect(await applyBunnyEvent(w.hook, event(p2.bunny_video_id!, 4), w.now), "status 4, Resolution finished").toBe("applied");
    let checked = 0;
    for (const row of [p1, p2]) {
      const after = await rowOf(row.id);
      expect([after.state, after.bunny_video_id, after.length_seconds], `part ${row.part_no}`).toEqual(["playable", row.bunny_video_id, FAKE_REPLAY_LENGTH_SECONDS]);
      expect([at(after.verified_at), at(after.state_at)], `part ${row.part_no}: verified now`).toEqual([w.now.getTime(), w.now.getTime()]);
      expect(at(after.next_attempt_at) - w.now.getTime(), `part ${row.part_no}: the delete is due 60 min after verification (G-D)`).toBe(60 * MIN);
      checked++;
    }
    expect(checked).toBe(2);
    expect(del, "the webhook never deletes a Cloudflare copy").not.toHaveBeenCalled();
    expect(list, "the webhook never lists").not.toHaveBeenCalled();
    const move = (t: number) => w.d.move(t);
    await move(w.now.getTime() + 59 * MIN);
    expect(del, "nothing at 59 min").not.toHaveBeenCalled();
    await move(w.now.getTime() + 60 * MIN);
    expect(del.mock.calls.map((c) => c[0]).sort(), "the mover's delete, by each row's own id, at 60 min").toEqual([p1.cf_video_id, p2.cf_video_id].sort());
  });

  it("a copy that FAILS the check is left encoding with nothing written — its length 3 s off the recording's, or (a status 4 before it exists) no 1080 rendition for a 1080p source — and the next poll judges it", async () => {
    const w = await world(2);
    const [short, early] = w.rows as [typeof w.rows[0], typeof w.rows[0]];
    for (const row of w.rows) w.host.advance(row.bunny_video_id!);
    await sql`update fixture_video_replays set cf_duration_seconds = ${FAKE_REPLAY_LENGTH_SECONDS - 3} where id = ${short.id}`;
    const realVideo = w.host.video.bind(w.host);
    const video = vi.spyOn(w.host, "video").mockImplementation(async (id) => {
      const v = await realVideo(id);
      return id === early.bunny_video_id ? { ...v, heights: v.heights.filter((h) => h !== 1080) } : v;
    });
    const before = [await rowOf(short.id), await rowOf(early.id)];
    const e1 = event(short.bunny_video_id!, 4);
    const e2 = event(early.bunny_video_id!, 4);
    expect(await applyBunnyEvent(w.hook, e1, w.now), "3 s short").toBe("ignored");
    expect(await applyBunnyEvent(w.hook, e2, w.now), "no 1080p yet").toBe("ignored");
    expect(video, "PREMISE: the host's own read was checked, once each").toHaveBeenCalledTimes(2);
    expect([await rowOf(short.id), await rowOf(early.id)], "nothing written").toEqual(before);
    expect([await marksOf(e1.eventId), await marksOf(e2.eventId)], "each event is marked as handled").toEqual([1, 1]);
    // The next poll (Task 24) reads the host's finished copy itself: the short one fails its check, the other now lists 1080p.
    video.mockRestore();
    await w.d.move(w.d.t0 + 15 * MIN);
    expect([(await rowOf(short.id)).state, (await rowOf(early.id)).state]).toEqual(["failed", "playable"]);
  });

  it("Review Focus 13: a repeated EventId (Bunny redelivers when our answer is lost) is `duplicate` — no second write, no second read of the host, no second removal", async () => {
    const w = await world(2);
    const [failing, unfinished] = w.rows as [typeof w.rows[0], typeof w.rows[0]];
    const video = vi.spyOn(w.host, "video");
    const remove = vi.spyOn(w.host, "remove");
    const failed = event(failing.bunny_video_id!, 5);
    expect(await applyBunnyEvent(w.hook, failed, w.now)).toBe("applied");
    const early = event(unfinished.bunny_video_id!, 4);   // the copy is still processing: the check fails, nothing written
    expect(await applyBunnyEvent(w.hook, early, w.now)).toBe("ignored");
    const after = [await rowOf(failing.id), await rowOf(unfinished.id)];
    expect([remove.mock.calls.length, video.mock.calls.length], "PREMISE: one removal (status 5), one read (status 4)").toEqual([1, 1]);
    expect(await applyBunnyEvent(w.hook, failed, new Date(w.now.getTime() + MIN))).toBe("duplicate");
    expect(await applyBunnyEvent(w.hook, early, new Date(w.now.getTime() + MIN))).toBe("duplicate");
    expect([remove.mock.calls.length, video.mock.calls.length], "no second removal, no second read").toEqual([1, 1]);
    expect([await rowOf(failing.id), await rowOf(unfinished.id)], "no second write").toEqual(after);
    expect([await marksOf(failed.eventId), await marksOf(early.eventId)]).toEqual([1, 1]);
  });

  it("status 5 removes the copy and sets `failed` with attempts 1 and the 1 min backoff in the future; the next mover run starts again from `found` and fetches a new copy", async () => {
    const w = await world();
    const row = w.rows[0]!;
    const old = row.bunny_video_id!;
    expect(await applyBunnyEvent(w.hook, event(old, 5), w.now)).toBe("applied");
    const after = await rowOf(row.id);
    expect([after.state, after.bunny_video_id, after.attempts]).toEqual(["failed", null, 1]);
    expect([at(after.state_at), at(after.next_attempt_at) - w.now.getTime()], "failed now, retried 1 min later").toEqual([w.now.getTime(), MIN]);
    expect(w.host.videoIds(), "the failed copy is gone from the host").not.toContain(old);
    await w.d.move(w.now.getTime() + MIN);
    const retried = await rowOf(row.id);
    expect(retried.state, "found → downloading → fetching → encoding in one run").toBe("encoding");
    expect(retried.bunny_video_id, "a NEW copy").not.toBe(old);
    expect(w.host.videoIds()).toContain(retried.bunny_video_id);
    expect(w.ingest.downloadCalls.filter((id) => id === row.cf_video_id), "the Cloudflare download asked for again").toHaveLength(2);
  });

  it("status 5 whose removal fails still fails the row (applied) and keeps the copy's id on it, so the mover's retry removes it before fetching again", async () => {
    const w = await world();
    const row = w.rows[0]!;
    const old = row.bunny_video_id!;
    vi.spyOn(w.host, "remove").mockRejectedValueOnce(new Error("bunny remove: request failed before a response (video x)"));
    expect(await applyBunnyEvent(w.hook, event(old, 5), w.now)).toBe("applied");
    const after = await rowOf(row.id);
    expect([after.state, after.bunny_video_id], "failed, still naming the copy").toEqual(["failed", old]);
    expect(w.host.videoIds(), "PREMISE: the copy is still on the host").toContain(old);
    await w.d.move(w.now.getTime() + MIN);
    expect(w.host.videoIds(), "the retry removed it first").not.toContain(old);
    expect((await rowOf(row.id)).state).toBe("encoding");
  });

  it("a copy no row holds: a stray of ours (the move's own title, `seazn:<session>:<recording>`) is removed; a foreign title, our form for a recording this database never made, and a copy the host no longer holds are left alone", async () => {
    const w = await world();
    const row = w.rows[0]!;
    const ours = (await w.host.video(row.bunny_video_id!)).title!;   // the title the REAL move gave its copy
    const fetchAs = async (title: string) => {
      const id = await w.host.fetchFromUrl({ collectionId: "c", title, url: "https://source.invalid/a.mp4" });
      w.host.advance(id);
      return id;
    };
    const stray = await fetchAs(ours);
    const foreign = await fetchAs("Club promo reel");
    const unknown = await fetchAs(`seazn:${randomUUID()}:v-0-${randomUUID()}`);
    const before = await rowOf(row.id);
    const remove = vi.spyOn(w.host, "remove");
    expect(await applyBunnyEvent(w.hook, event(stray, 3), w.now), "ours, stray").toBe("applied");
    expect(await applyBunnyEvent(w.hook, event(foreign, 3), w.now), "a foreign title").toBe("ignored");
    expect(await applyBunnyEvent(w.hook, event(unknown, 4), w.now), "our form, a recording this database never made").toBe("ignored");
    expect(await applyBunnyEvent(w.hook, event(`gone-${randomUUID()}`, 5), w.now), "the host holds no such copy").toBe("ignored");
    expect(remove.mock.calls.map((c) => c[0]), "only the stray was removed").toEqual([stray]);
    expect(w.host.videoIds()).toEqual(expect.arrayContaining([row.bunny_video_id, foreign, unknown]));
    expect(w.host.videoIds()).not.toContain(stray);
    expect(await rowOf(row.id), "the row's own copy and the row untouched").toEqual(before);
  });

  it("a stray whose recording is still `fetching` is the move's own answer about to land: ignored, never removed; once the row holds that copy, its next event takes the held path and verifies it", async () => {
    const r = await seaznRig();
    const host = freshHost();
    const f = r.fixtureIds[0];
    const d = await discoveredReplays(r, f, host);
    const deps: BunnyWebhookDeps = { libraryId: LIBRARY, replay: host };
    const now = new Date(d.t0 + 5 * MIN);
    const realFetch = host.fetchFromUrl.bind(host);
    let made: string | null = null;
    let during: string | null = null;
    let state: string | null = null;
    vi.spyOn(host, "fetchFromUrl").mockImplementationOnce(async (a) => {
      made = await realFetch(a);
      host.advance(made);
      state = (await replayRowsOf(f))[0]!.state;
      during = await applyBunnyEvent(deps, event(made, 3), now);
      return made;
    });
    await d.move(d.t0);
    expect(state, "PREMISE: the row was fetching when the event came").toBe("fetching");
    expect(during).toBe("ignored");
    const [row] = await replayRowsOf(f);
    expect([row!.state, row!.bunny_video_id], "the move's answer landed: the row holds that copy").toEqual(["encoding", made]);
    expect(host.videoIds()).toContain(made);
    expect(await applyBunnyEvent(deps, event(made!, 4), now), "the held path").toBe("applied");
    expect((await replayRowsOf(f))[0]!.state).toBe("playable");
  });

  it("guard: a copy that looked unheld but which the row holds by the time its title is read (the move's write landed meanwhile) is never removed as a stray", async () => {
    const w = await world();
    const row = w.rows[0]!;
    const guid = row.bunny_video_id!;
    w.host.advance(guid);
    // The instant before the move's own write: the row fetching, no copy named yet.
    await sql`update fixture_video_replays set state = 'fetching', bunny_video_id = null where id = ${row.id}`;
    const realVideo = w.host.video.bind(w.host);
    vi.spyOn(w.host, "video").mockImplementationOnce(async (id) => {
      // The move's `fetching → encoding` write lands while the webhook reads the host.
      await sql`update fixture_video_replays set state = 'encoding', bunny_video_id = ${guid} where id = ${row.id} and state = 'fetching'`;
      return realVideo(id);
    });
    const remove = vi.spyOn(w.host, "remove");
    expect(await applyBunnyEvent(w.hook, event(guid, 3), w.now)).toBe("ignored");
    expect(remove).not.toHaveBeenCalled();
    expect(w.host.videoIds()).toContain(guid);
  });

  it("T26 m5: a copy fetched AFTER the organiser deleted its row, whose removal then failed, is removed by the webhook — the row stays deleted (no resurrection); a webhook whose own removal fails throws with its mark released, so Bunny's redelivery of that event removes it", async () => {
    const r = await seaznRig();
    const host = freshHost();
    const f = r.fixtureIds[0];
    const d = await discoveredReplays(r, f, host);
    const [found] = await replayRowsOf(f);
    const deps: BunnyWebhookDeps = { libraryId: LIBRARY, replay: host };
    const realFetch = host.fetchFromUrl.bind(host);
    let made: string | null = null;
    vi.spyOn(host, "fetchFromUrl").mockImplementationOnce(async (a) => {
      made = await realFetch(a);
      await deleteSeaznReplay(r.auth, f, found!.id, { replay: host });
      return made;
    });
    const remove = vi.spyOn(host, "remove").mockRejectedValueOnce(new Error("bunny remove: request failed before a response (video x)"));
    await d.move(d.t0);
    expect(remove, "PREMISE: the move tried to remove the copy it made for a deleted row, and failed").toHaveBeenCalledTimes(1);
    const deleted = await rowOf(found!.id);
    expect([deleted.state, deleted.bunny_video_id, deleted.deleted_reason], "PREMISE: deleted, the stray never stored").toEqual(["deleted", null, "organiser"]);
    expect(host.videoIds(), "PREMISE: the stray is still on the host").toContain(made);
    host.advance(made!);
    const now = new Date(d.t0 + 5 * MIN);

    expect(await applyBunnyEvent(deps, event(made!, 2), now), "Bunny's early status: not yet").toBe("ignored");
    remove.mockRejectedValueOnce(new Error("bunny remove: request failed before a response (video y)"));
    const finished = event(made!, 3);
    await expect(applyBunnyEvent(deps, finished, now), "the webhook's own removal fails: the route answers 500").rejects.toThrow(/bunny remove/);
    expect(await marksOf(finished.eventId), "its mark released, so the redelivery is not a duplicate").toBe(0);
    expect(host.videoIds()).toContain(made);

    expect(await applyBunnyEvent(deps, finished, new Date(now.getTime() + 30_000)), "Bunny's redelivery, 30 s later").toBe("applied");
    expect(host.videoIds(), "the stray is gone").not.toContain(made);
    expect(await marksOf(finished.eventId)).toBe(1);
    expect(await rowOf(found!.id), "no resurrection: the row is exactly as the delete left it").toEqual(deleted);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public_fixture_seazn_replays_v where fixture_id = ${f}`;
    expect(n, "the match page lists nothing").toBe(0);
    expect(await applyBunnyEvent(deps, event(made!, 4), now), "a later event for the removed copy").toBe("ignored");
  });

  it("one row per copy (V545's unique index, the Task 27 review's m4): a second row naming a held copy is refused by the database, so the webhook's lookup can only find one", async () => {
    const w = await world(2);
    const [a, b] = w.rows as [typeof w.rows[0], typeof w.rows[0]];
    const before = [await rowOf(a.id), await rowOf(b.id)];
    const refused = await sql`update fixture_video_replays set bunny_video_id = ${a.bunny_video_id} where id = ${b.id}`.then(
      () => "landed", (e: { code?: string; constraint_name?: string }) => `${e.code}:${e.constraint_name}`);
    expect(refused).toBe("23505:fixture_video_replays_bunny_video_id_key");
    expect([await rowOf(a.id), await rowOf(b.id)], "both rows as they were").toEqual(before);
    // The positive pair: the copy the one row names is acted on.
    w.host.advance(a.bunny_video_id!);
    expect(await applyBunnyEvent(w.hook, event(a.bunny_video_id!, 3), w.now)).toBe("applied");
    expect((await rowOf(a.id)).state).toBe("playable");
  });

  it("C6 (recommendation 2026-11-21): no event of any kind or outcome makes a Cloudflare call — no delete, no listing, no download — and the Cloudflare videos of OTHER inputs are untouched", async () => {
    const w = await world(3);
    // The process's own relay driver is this ingest too, so a path that reached Cloudflare through the driver registry is counted.
    setRelayDriversForTest({ ingest: w.ingest, runner: w.runner });
    w.ingest.addVideo({ videoId: `other-input-${randomUUID()}`, inputId: "fake-in-0-other", createdAt: new Date(w.d.t0).toISOString(), inProgress: false, durationSeconds: 60, height: 720 });
    const cf = (["deleteVideo", "listInputVideos", "listVideos", "createDownload", "playbackToken", "requireSignedVideo"] as const)
      .map((m) => [m, vi.spyOn(w.ingest, m)] as const);
    const [p, q, s] = w.rows as [typeof w.rows[0], typeof w.rows[0], typeof w.rows[0]];
    w.host.advance(p.bunny_video_id!);
    const stray = await w.host.fetchFromUrl({ collectionId: "c", title: (await w.host.video(s.bunny_video_id!)).title!, url: "https://source.invalid/b.mp4" });
    const foreign = await w.host.fetchFromUrl({ collectionId: "c", title: "Club promo reel", url: "https://source.invalid/c.mp4" });
    const repeat = event(p.bunny_video_id!, 4);
    const sweep: [string, BunnyEvent, string][] = [
      ["early status", event(q.bunny_video_id!, 2), "ignored"],
      ["playable, passes", repeat, "applied"],
      ["playable, the copy not finished", event(q.bunny_video_id!, 4), "ignored"],
      ["failed", event(s.bunny_video_id!, 5), "applied"],
      ["stray of ours", event(stray, 3), "applied"],
      ["foreign title", event(foreign, 3), "ignored"],
      ["absent copy", event(`gone-${randomUUID()}`, 4), "ignored"],
      ["another library", event(q.bunny_video_id!, 3, { libraryId: "1" }), "ignored"],
      ["repeat", repeat, "duplicate"],
    ];
    const got: [string, string][] = [];
    for (const [label, ev] of sweep) got.push([label, await applyBunnyEvent(w.hook, ev, w.now)]);
    expect(got, "every branch was taken (anti-vacuity: 9 events, 4 outcomes)").toEqual(sweep.map(([label, , want]) => [label, want]));
    for (const [name, spy] of cf) expect([name, spy.mock.calls.length]).toEqual([name, 0]);
    expect(cf.length).toBe(6);
    expect(w.ingest.deletedVideos, "no Cloudflare video was deleted").toEqual([]);
  });
});

// Task 31b (the T27 follow-up): the dedupe marks are kept 30 days — the brief's number, typed here — then the daily sweep deletes
// them (relay-sweep.ts 7f). Bunny's redeliveries of one event span far less, so a mark that old guards nothing.
describe.skipIf(!HAS_DB)("purgeBunnyWebhookEvents — the dedupe marks' retention (Task 31b)", () => {
  const RETENTION_DAYS = 30;
  const DAY = 86_400_000;
  const mark = async (at: Date) => {
    const id = `evt-t31b-${randomUUID()}`;
    await sql`insert into bunny_webhook_events (event_id, received_at) values (${id}, ${at})`;
    return id;
  };

  it("EMPTY CASE FIRST: no mark in scope older than 30 days — nothing deleted, 0 answered", async () => {
    const now = new Date();
    const young = await mark(new Date(now.getTime() - 60_000));
    expect(await purgeBunnyWebhookEvents(now, { eventIds: [young, `evt-none-${randomUUID()}`] })).toBe(0);
    expect(await marksOf(young)).toBe(1);
  });

  it("a mark a minute past 30 days goes, one a minute inside stays; a second run on the same clock deletes nothing; the next day the kept one goes too", async () => {
    const now = new Date();
    const edge = now.getTime() - RETENTION_DAYS * DAY;
    const past = await mark(new Date(edge - MIN));
    const inside = await mark(new Date(edge + MIN));
    const scope = { eventIds: [past, inside] };
    expect(await purgeBunnyWebhookEvents(now, scope)).toBe(1);
    expect([await marksOf(past), await marksOf(inside)]).toEqual([0, 1]);
    expect(await purgeBunnyWebhookEvents(now, scope), "a second run, the same clock").toBe(0);
    expect(await marksOf(inside)).toBe(1);
    expect(await purgeBunnyWebhookEvents(new Date(now.getTime() + DAY), scope), "a day later").toBe(1);
    expect(await marksOf(inside)).toBe(0);
  });

  it("an EMPTY eventIds scope is refused by name — never read as every mark", async () => {
    await expect(purgeBunnyWebhookEvents(new Date(), { eventIds: [] })).rejects.toThrow(/eventIds is empty/);
  });
});
