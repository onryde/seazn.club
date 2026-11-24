// Seazn-hosted video Task 25: the organiser's list of a fixture's Seazn replays (the fixture stream panel's ended state). Each part
// the replay move made, by its stored number, as the organiser reads it: `processing` while the move is on its way (found,
// downloading, fetching, encoding), `playable` once verified, `failed` when the copy failed its check; a removed part (the
// organiser's delete, Task 26, or `deleted`) is not listed. Org-scoped: another organisation's read of the fixture is 404, never an
// empty list, and the read rides the session view (`currentSession().seaznReplays`) the panel already polls.
//
// The rows come from the REAL producers (Go live, Stop, the lock, discovery and the move onto the replay fake), as
// seazn-video-replays.test.ts makes them, and the organiser's delete is the real one (Task 26). The state words are the brief's,
// typed here. ONE SPORT, on purpose (TEST-STRATEGY rule 6): neither the read, the delete nor the download reads a sport rule; every
// rig rides `generic`.
//
// Task 26: the organiser deletes a part (`deleteSeaznReplay`) and downloads one (`seaznReplayDownload`), below the list's cases.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { StreamSessionCurrent } from "@/server/api-v1/schemas";
import { FakeIngest } from "@/server/relay/fakes";
import { lockSeaznRecordings } from "@/server/usecases/seazn-recordings";
import { type SeaznReplayDeps, discoverSeaznRecordings, moveSeaznRecordings } from "@/server/usecases/seazn-replays";
import { currentSession } from "@/server/usecases/stream-sessions";
import { createPlaybackTokenCache } from "../cf-playback";
import { REPLAY_ROW_STATES } from "../domain/replay-move";
import { posterFileName } from "@/lib/poster-file-name";
import { SEAZN_CF_DELETE_DELAY_MINUTES, SEAZN_CLAIM_LEASE_SECONDS, SEAZN_REPLAY_RETRY_DAYS } from "@/server/relay/config";
import { log } from "@/server/logger";
import { REPLAY_PARKED_AT } from "../domain/replay-move";
import { UnknownOrganiserReplayState, deleteSeaznReplay, fixtureSeaznReplays, organiserReplayState, seaznReplayDownload } from "../organiser-replays";
import { FAKE_REPLAY_FILE, FAKE_REPLAY_LENGTH_SECONDS, FakeReplayHost } from "../replay-fake";
import { ReplayHostRefused, ReplayHostUnavailable, ReplayNotDownloadable } from "../replay-ports";
import { seaznFixtureVideo } from "../seazn-video";
import { discoveredReplays, movedReplays, replayRowsOf } from "./_seazn-replay-rig";
import { installSeaznEnv, live, seaznRig, stopAndSettle } from "./_seazn-session-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const MIN = 60_000;
const BUDGET = 8_000;

describe("organiserReplayState — the brief's three words, for every state the move writes", () => {
  it("the move's working states read processing; playable and failed read as themselves; deleted is never listed; anything else is refused by name", () => {
    const expected: Record<string, string | null> = {
      found: "processing", downloading: "processing", fetching: "processing", encoding: "processing",
      playable: "playable", failed: "failed", deleted: null,
    };
    let checked = 0;
    for (const state of REPLAY_ROW_STATES) {
      expect(state in expected, `the brief has a word for ${state}`).toBe(true);
      if (expected[state] === null) expect(() => organiserReplayState(state), state).toThrow(UnknownOrganiserReplayState);
      else expect(organiserReplayState(state), state).toBe(expected[state]);
      checked++;
    }
    expect(checked, "anti-vacuity: every state the move writes").toBe(Object.keys(expected).length);
    expect(() => organiserReplayState("archived")).toThrow(UnknownOrganiserReplayState);
    expect(() => organiserReplayState("toString")).toThrow(UnknownOrganiserReplayState);
  });
});

installSeaznEnv("t25-organiser-replays");

describe.skipIf(!HAS_DB)("fixtureSeaznReplays — the organiser's list (Task 25)", () => {
  async function world() {
    const r = await seaznRig();
    const ingest = r.deps.drivers.ingest as FakeIngest;
    const host = new FakeReplayHost();
    const replayDeps: SeaznReplayDeps = { ingest, replay: host, tokenCache: createPlaybackTokenCache() };
    return { ...r, ingest, host, replayDeps };
  }

  it("EMPTY CASE FIRST: a fixture with no replay is an empty list, and so is one whose session recorded nothing", async () => {
    const w = await world();
    expect(await fixtureSeaznReplays(w.auth.orgId, w.fixtureIds[0])).toEqual([]);
    const sid = await live(w, w.fixtureIds[0], w.seazn);
    await stopAndSettle(w, w.fixtureIds[0], sid);
    expect(await fixtureSeaznReplays(w.auth.orgId, w.fixtureIds[0])).toEqual([]);
  });

  it("four recordings through the real move: playable, processing, failed by number; a removed one is gone; the session view carries the same list", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const sid = await live(w, f, w.seazn);
    const [prog] = await sql<{ uid: string }[]>`select ingest_input_id as uid from fixture_stream_inputs where session_id = ${sid} and role = 'programme'`;
    const base = w.deps.now().getTime();
    // Part 3's Cloudflare length is off by a minute, so its copy fails the host's length check.
    const durations = [FAKE_REPLAY_LENGTH_SECONDS, FAKE_REPLAY_LENGTH_SECONDS, FAKE_REPLAY_LENGTH_SECONDS + 60, FAKE_REPLAY_LENGTH_SECONDS];
    const ids = durations.map((durationSeconds, k) => {
      const videoId = `v-${k}-${randomUUID()}`;
      w.ingest.addVideo({ videoId, inputId: prog!.uid, createdAt: new Date(base + k * MIN).toISOString(), inProgress: false, durationSeconds, height: 1080 });
      return videoId;
    });
    await stopAndSettle(w, f, sid);
    const [{ ended_at }] = await sql<{ ended_at: Date }[]>`select ended_at from fixture_stream_sessions where id = ${sid}`;
    const endedAt = new Date(ended_at).getTime();
    const t0 = endedAt + 15 * MIN;
    const opts = (at: number) => ({ now: new Date(at), budgetMs: BUDGET, orgIds: [w.auth.orgId] });
    expect(await lockSeaznRecordings(w.deps, opts(endedAt + MIN))).toMatchObject({ locked: 4 });
    await sql`update fixtures set finished_at = ${new Date(endedAt)} where id = ${f}`;
    expect(await discoverSeaznRecordings(w.replayDeps, opts(t0))).toMatchObject({ discovered: 4 });
    await moveSeaznRecordings(w.replayDeps, opts(t0));
    const rows = await sql<{ id: string; cf_video_id: string; part_no: number; state: string; bunny_video_id: string | null }[]>`
      select id, cf_video_id, part_no, state, bunny_video_id from fixture_video_replays where fixture_id = ${f} order by part_no`;
    expect(rows.map((r) => [r.part_no, r.cf_video_id, r.state]), "PREMISE: four rows, numbered in recording order, all encoding")
      .toEqual(ids.map((id, k) => [k + 1, id, "encoding"]));
    // The host finishes parts 1 and 3; part 2 is still encoding; part 4 the organiser removes.
    w.host.advance(rows[0]!.bunny_video_id!);
    w.host.advance(rows[2]!.bunny_video_id!);
    await moveSeaznRecordings(w.replayDeps, opts(t0 + 15 * MIN));
    expect(await deleteSeaznReplay(w.auth, f, rows[3]!.id, { now: new Date(t0 + 16 * MIN), replay: w.host })).toEqual({ deleted: true });
    const after = await sql<{ part_no: number; state: string; length_seconds: number | null }[]>`
      select part_no, state, length_seconds from fixture_video_replays where fixture_id = ${f} order by part_no`;
    expect(after.map((r) => r.state), "PREMISE: playable, encoding, failed, deleted").toEqual(["playable", "encoding", "failed", "deleted"]);

    const list = await fixtureSeaznReplays(w.auth.orgId, f);
    expect(list).toEqual([
      { id: rows[0]!.id, partNo: 1, state: "playable", lengthSeconds: FAKE_REPLAY_LENGTH_SECONDS, onMatchPage: true },
      { id: rows[1]!.id, partNo: 2, state: "processing", lengthSeconds: after[1]!.length_seconds, onMatchPage: true },
      { id: rows[2]!.id, partNo: 3, state: "failed", lengthSeconds: after[2]!.length_seconds, onMatchPage: true },
    ]);

    // A part the organiser removed while it read `failed` (deleted_at set, the state not yet moved) is gone too.
    await sql`update fixture_video_replays set deleted_at = now(), deleted_reason = 'organiser' where id = ${rows[2]!.id}`;
    expect((await fixtureSeaznReplays(w.auth.orgId, f)).map((r) => r.partNo)).toEqual([1, 2]);

    // The session view the panel polls carries the same list, under the published contract.
    const view = await currentSession(w.auth, f, w.deps);
    expect(view, "PREMISE: the fixture has a session").not.toBeNull();
    expect(view!.seaznReplays).toEqual(await fixtureSeaznReplays(w.auth.orgId, f));
    expect(StreamSessionCurrent.parse(view)).toEqual(view);
  });

  it("org-scoped: another organisation's read of the fixture is 404 (never an empty list), and so is an id that is not one", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    let checked = 0;
    for (const [orgId, fixtureId] of [[randomUUID(), f], [w.auth.orgId, randomUUID()], [w.auth.orgId, "not-a-uuid"]] as const) {
      const err = await fixtureSeaznReplays(orgId, fixtureId).then(() => null, (e: unknown) => e);
      expect(err, `${orgId === w.auth.orgId ? "own org" : "other org"} / ${fixtureId}`).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(404);
      checked++;
    }
    expect(checked).toBe(3);
    expect(await fixtureSeaznReplays(w.auth.orgId, f), "the owner's own read answers").toEqual([]);
  });
});

// ─── Task 25 review m3: the panel says what is TRUE of a part — on the public match page only when the public can see it ────────
describe.skipIf(!HAS_DB)("fixtureSeaznReplays — onMatchPage (Task 25 review m3)", () => {
  it("a part is on the match page while the competition is public or unlisted and its division past setup; private, it is not — the public read agrees each time", async () => {
    const r = await seaznRig();
    const host = new FakeReplayHost();
    const f = r.fixtureIds[0];
    const m = await movedReplays(r, f, host);
    const at = m.t0 + 16 * MIN;
    const publicParts = async () =>
      (await seaznFixtureVideo(f, new Date(at), { ingest: m.replayDeps.ingest, tokenCache: createPlaybackTokenCache(), replay: host })).replay.map((p) => p.partNo);
    const comp = sql`(select d.competition_id from fixtures f join divisions d on d.id = f.division_id where f.id = ${f})`;
    let checked = 0;
    for (const [visibility, expected] of [["public", true], ["unlisted", true], ["private", false]] as const) {
      await sql`update competitions set visibility = ${visibility} where id = ${comp}`;
      expect((await fixtureSeaznReplays(r.auth.orgId, f)).map((p) => p.onMatchPage), visibility).toEqual([expected]);
      expect(await publicParts(), `the public read agrees (${visibility})`).toEqual(expected ? [1] : []);
      checked++;
    }
    expect(checked).toBe(3);
  });
});

// ─── Task 26: the organiser deletes a part ────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!HAS_DB)("deleteSeaznReplay — the organiser deletes a part (Task 26)", () => {
  async function world(o: { parts?: number; playable?: readonly number[] } = {}) {
    const r = await seaznRig();
    const host = new FakeReplayHost();
    const f = r.fixtureIds[0];
    const m = await movedReplays(r, f, host, o);
    return { ...r, host, f, ...m };
  }
  type World = Awaited<ReturnType<typeof world>>;
  const publicParts = async (w: World, at: number) =>
    (await seaznFixtureVideo(w.f, new Date(at), { ingest: w.replayDeps.ingest, tokenCache: createPlaybackTokenCache(), replay: w.host })).replay.map((p) => p.partNo);
  interface Cols {
    state: string; state_at: Date; deleted_at: Date | null; deleted_by: string | null; deleted_reason: string | null; next_attempt_at: Date;
    attempts: number; bunny_video_id: string | null; cf_deleted_at: Date | null; bunny_cleaned_at: Date | null;
  }
  const colsOf = async (id: string) => (await sql<Cols[]>`
    select state, state_at, deleted_at, deleted_by, deleted_reason, next_attempt_at, attempts, bunny_video_id, cf_deleted_at, bunny_cleaned_at
      from fixture_video_replays where id = ${id}`)[0]!;
  const statusOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof HttpError ? e.status : e));

  it("EMPTY CASE FIRST: an id that names no part of THIS fixture of THIS org — another fixture's, another org's, a random one, not a uuid — is 404, and nothing changes or is removed", async () => {
    const w = await world();
    const other = await seaznRig();
    const row = w.rows[0]!;
    const remove = vi.spyOn(w.host, "remove");
    const cases: [string, () => Promise<unknown>][] = [
      ["the org's other fixture", () => deleteSeaznReplay(w.auth, w.fixtureIds[1], row.id, { replay: w.host })],
      ["another org, the same fixture", () => deleteSeaznReplay(other.auth, w.f, row.id, { replay: w.host })],
      ["another org, its own fixture", () => deleteSeaznReplay(other.auth, other.fixtureIds[0], row.id, { replay: w.host })],
      ["a random id", () => deleteSeaznReplay(w.auth, w.f, randomUUID(), { replay: w.host })],
      ["not a uuid", () => deleteSeaznReplay(w.auth, w.f, "1' or '1'='1", { replay: w.host })],
      ["a fixture that is not a uuid", () => deleteSeaznReplay(w.auth, "f1", row.id, { replay: w.host })],
    ];
    let checked = 0;
    for (const [what, call] of cases) {
      expect(await statusOf(call()), what).toBe(404);
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(remove).not.toHaveBeenCalled();
    expect((await colsOf(row.id)).state, "the part is untouched").toBe("playable");
    expect(await publicParts(w, w.t0 + 16 * MIN)).toEqual([1]);
  });

  it("the editor deletes a playable part: the row is the organiser's delete, the copy removed once, the part gone from every read; a second delete answers the same and removes nothing; the move then settles the cleanup", async () => {
    const w = await world();
    const row = w.rows[0]!;
    const guid = row.bunny_video_id!;
    const at = w.t0 + 16 * MIN;
    expect(await publicParts(w, at), "PREMISE: the public read lists the part").toEqual([1]);
    expect((await fixtureSeaznReplays(w.auth.orgId, w.f)).map((p) => p.partNo), "PREMISE: so does the organiser's").toEqual([1]);
    const remove = vi.spyOn(w.host, "remove");

    expect(await deleteSeaznReplay(w.auth, w.f, row.id, { now: new Date(at), replay: w.host })).toEqual({ deleted: true });
    const c = await colsOf(row.id);
    expect(c).toMatchObject({ state: "deleted", deleted_reason: "organiser", deleted_by: w.auth.userId, attempts: 0, bunny_video_id: null });
    // The cleanup is due one claim lease after the delete — never ahead of the delete's own last read and removal (T31 review m2).
    expect([c.state_at, c.deleted_at, c.next_attempt_at].map((d) => new Date(d!).getTime()), "state_at and deleted_at are the delete's; the cleanup due one lease later").toEqual([at, at, at + SEAZN_CLAIM_LEASE_SECONDS * 1000]);
    expect(remove.mock.calls, "the copy is removed, once").toEqual([[guid]]);
    expect(w.host.videoIds()).not.toContain(guid);
    expect(await fixtureSeaznReplays(w.auth.orgId, w.f)).toEqual([]);
    expect(await publicParts(w, at)).toEqual([]);
    const view = await currentSession(w.auth, w.f, w.deps);
    expect(view?.seaznReplays, "the session view the panel polls").toEqual([]);

    // A second delete (a double tap, a second tab, by another editor): the same answer, no second remove, and the row exactly as the
    // first one left it — its time, its author, its cleanup's due time and attempts.
    const first = await colsOf(row.id);
    const admin = { ...w.auth, userId: randomUUID(), role: "admin" as const };
    expect(await deleteSeaznReplay(admin, w.f, row.id, { now: new Date(at + MIN), replay: w.host })).toEqual({ deleted: true });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(await colsOf(row.id), "the first delete stands").toEqual(first);

    // The move's cleanup (Task 24) through the REAL delete: the Cloudflare copy waits out its delay after the verification, then goes.
    await w.move(at);
    expect(await colsOf(row.id), "before the delay: waiting, nothing settled").toMatchObject({ cf_deleted_at: null, bunny_cleaned_at: null });
    const verifiedAt = w.t0 + 15 * MIN;
    await w.move(verifiedAt + (SEAZN_CF_DELETE_DELAY_MINUTES + 1) * MIN);
    const settled = await colsOf(row.id);
    expect(settled.cf_deleted_at, "the Cloudflare copy deleted").not.toBeNull();
    expect(settled.bunny_cleaned_at, "the row settled").not.toBeNull();
    expect(remove, "the cleanup had nothing left to remove").toHaveBeenCalledTimes(1);
  });

  it("deletes a part in each state the move leaves: processing (encoding) and failed go too, their copies removed", async () => {
    const w = await world({ parts: 2, playable: [] });
    const [encoding, toFail] = w.rows as [typeof w.rows[0], typeof w.rows[0]];
    w.host.fail(toFail.bunny_video_id!);
    await w.move(w.t0 + 30 * MIN);
    expect((await fixtureSeaznReplays(w.auth.orgId, w.f)).map((p) => p.state), "PREMISE: processing, failed").toEqual(["processing", "failed"]);
    const failedGuid = (await colsOf(toFail.id)).bunny_video_id;
    const remove = vi.spyOn(w.host, "remove");
    for (const r of [encoding, toFail]) expect(await deleteSeaznReplay(w.auth, w.f, r.id, { now: new Date(w.t0 + 31 * MIN), replay: w.host })).toEqual({ deleted: true });
    expect((await replayRowsOf(w.f)).map((r) => r.state)).toEqual(["deleted", "deleted"]);
    expect(remove.mock.calls.flat(), "each copy the rows held").toEqual([encoding.bunny_video_id, failedGuid].filter((g) => g !== null));
    expect(await fixtureSeaznReplays(w.auth.orgId, w.f)).toEqual([]);
  });

  it("the host's remove throwing still deletes (200): the row is deleted and keeps the copy's id, the line names no secret, and the move's cleanup removes it on its next run", async () => {
    const w = await world();
    const row = w.rows[0]!;
    const guid = row.bunny_video_id!;
    const at = w.t0 + 16 * MIN;
    vi.spyOn(w.host, "remove").mockRejectedValueOnce(new Error(`replay host remove: HTTP 503 (video ${guid})`));
    const errors = vi.spyOn(log, "error");
    expect(await deleteSeaznReplay(w.auth, w.f, row.id, { now: new Date(at), replay: w.host })).toEqual({ deleted: true });
    expect(await colsOf(row.id)).toMatchObject({ state: "deleted", bunny_video_id: guid });
    expect(w.host.videoIds(), "PREMISE: the copy is still on the host").toContain(guid);
    expect(await publicParts(w, at), "gone from the match page either way").toEqual([]);
    const line = errors.mock.calls.find((c) => JSON.stringify(c).includes(row.id));
    expect(line, "the failed remove is logged once, by the replay").toBeDefined();
    expect(line![0]).toMatchObject({ replayId: row.id, errClass: "Error" });
    errors.mockRestore();
    await w.move(at);
    expect(w.host.videoIds(), "inside the delete's lease (T31 review m2) the cleanup leaves the row alone").toContain(guid);
    await w.move(at + SEAZN_CLAIM_LEASE_SECONDS * 1000);
    expect(w.host.videoIds(), "the cleanup removed it").not.toContain(guid);
    expect((await colsOf(row.id)).bunny_video_id).toBeNull();
  });

  it("T24 I1: a part deleted long after it was recorded — past the move's own retry window — still has its cleanup retried from the DELETE, never parked", async () => {
    const w = await world();
    const row = w.rows[0]!;
    const guid = row.bunny_video_id!;
    const at = new Date(row.recorded_at).getTime() + (SEAZN_REPLAY_RETRY_DAYS + 10) * 24 * 60 * MIN;
    const remove = vi.spyOn(w.host, "remove");
    remove.mockRejectedValueOnce(new Error("replay host remove: HTTP 503")).mockRejectedValueOnce(new Error("replay host remove: HTTP 503"));
    expect(await deleteSeaznReplay(w.auth, w.f, row.id, { now: new Date(at), replay: w.host })).toEqual({ deleted: true });
    await w.move(at + SEAZN_CLAIM_LEASE_SECONDS * 1000);   // the cleanup's first turn: one lease after the delete (T31 review m2)
    const c = await colsOf(row.id);
    expect(c.state).toBe("deleted");
    expect(new Date(c.next_attempt_at).getTime(), "backed off from the delete, not parked").toBeLessThan(REPLAY_PARKED_AT.getTime());
    expect(c.attempts).toBe(1);
    await w.move(new Date(c.next_attempt_at).getTime());
    expect(w.host.videoIds(), "the retry removed it").not.toContain(guid);
  });

  it("no transaction spans the host call: while the copy is being removed, the row is not locked (a NOWAIT lock from another connection is granted) — and the probe does see a held lock (its positive twin)", async () => {
    const w = await world();
    const row = w.rows[0]!;
    const nowait = () => sql`select id from fixture_video_replays where id = ${row.id} for update nowait`;
    // The positive twin: a lock held by an open transaction is refused to the probe (55P03).
    let refused: unknown = null;
    await sql.begin(async (tx) => {
      await tx`select id from fixture_video_replays where id = ${row.id} for update`;
      refused = await nowait().then(() => null, (e: unknown) => e);
    });
    expect((refused as { code?: string } | null)?.code, "PREMISE: the probe sees a held row lock").toBe("55P03");
    const real = w.host.remove.bind(w.host);
    let granted: unknown = "not reached";
    vi.spyOn(w.host, "remove").mockImplementationOnce(async (id) => {
      granted = await nowait().then((rows) => rows.length, (e: unknown) => e);
      return real(id);
    });
    expect(await deleteSeaznReplay(w.auth, w.f, row.id, { replay: w.host })).toEqual({ deleted: true });
    expect(granted, "the row was free while the host was called").toBe(1);
  });

  it("the delete takes the row FOR UPDATE: it waits for the move's own short write to the row and acts on what that write left (the copy it stored is removed at once)", async () => {
    const r = await seaznRig();
    const host = new FakeReplayHost();
    const f = r.fixtureIds[0];
    const d = await discoveredReplays(r, f, host);
    // The move's fetch fails once: the row is left `fetching`, holding no copy (the backoff writes nothing else).
    vi.spyOn(host, "fetchFromUrl").mockRejectedValueOnce(new Error("replay host fetch: HTTP 503"));
    await d.move(d.t0);
    const [row] = await replayRowsOf(f);
    expect([row?.state, row?.bunny_video_id], "PREMISE: fetching, no copy").toEqual(["fetching", null]);
    // The move's successful fetch write (seazn-replays.ts: `fetching` → `encoding` with the new copy), in a transaction this test
    // holds open until the delete is seen waiting on the row.
    const guid = await host.fetchFromUrl({ collectionId: await host.createCollection(r.auth.orgId), title: "t", url: "https://x.invalid/" });
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let written!: () => void;
    const wrote = new Promise<void>((res) => (written = res));
    const holder = sql.begin(async (tx) => {
      await tx`update fixture_video_replays set state = 'encoding', state_at = ${new Date(d.t0)}, bunny_video_id = ${guid} where id = ${row!.id} and state = 'fetching'`;
      written();
      await gate;
    });
    await wrote;
    const remove = vi.spyOn(host, "remove");
    const deleting = deleteSeaznReplay(r.auth, f, row!.id, { replay: host });
    let waiting = 0;
    for (let i = 0; i < 100 && waiting === 0; i++) {
      [{ n: waiting }] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%fixture_video_replays%'`;
      if (waiting === 0) await new Promise((res) => setTimeout(res, 50));
    }
    expect(waiting, "PREMISE: the delete is waiting on the row").toBeGreaterThan(0);
    release();
    await holder;
    expect(await deleting).toEqual({ deleted: true });
    expect(remove.mock.calls, "the delete read the copy the move's write stored, and removed it").toEqual([[guid]]);
    expect(host.videoIds()).not.toContain(guid);
  });

  it("the organiser deletes it while the move's fetch is in flight: the delete does not wait for the host, the move's write finds the row deleted, and the copy that fetch made is removed", async () => {
    const r = await seaznRig();
    const host = new FakeReplayHost();
    const f = r.fixtureIds[0];
    const d = await discoveredReplays(r, f, host);
    const [found] = await replayRowsOf(f);
    const realFetch = host.fetchFromUrl.bind(host);
    let made: string | null = null;
    let answered: unknown = null;
    vi.spyOn(host, "fetchFromUrl").mockImplementationOnce(async (a) => {
      made = await realFetch(a);
      answered = await deleteSeaznReplay(r.auth, f, found!.id, { replay: host });
      return made;
    });
    await d.move(d.t0);
    expect(answered, "the delete answered while the fetch was still in flight").toEqual({ deleted: true });
    expect(made, "PREMISE: the fetch made a copy").not.toBeNull();
    const [after] = await replayRowsOf(f);
    expect([after?.state, after?.bunny_video_id], "the move never wrote over the delete").toEqual(["deleted", null]);
    expect(host.videoIds(), "the copy the fetch made is gone").not.toContain(made);
  });

  it("editors with a session only: an API key, a device link, a viewer and a session with no user are 403, and the part is untouched", async () => {
    const w = await world();
    const row = w.rows[0]!;
    const remove = vi.spyOn(w.host, "remove");
    const refused = [
      { ...w.auth, via: "api_key" as const, userId: null },
      { ...w.auth, via: "device_link" as const },
      { ...w.auth, role: "viewer" as const },
      { ...w.auth, role: null },
      { ...w.auth, userId: null },
    ];
    let checked = 0;
    for (const auth of refused) {
      expect(await statusOf(deleteSeaznReplay(auth, w.f, row.id, { replay: w.host })), JSON.stringify({ via: auth.via, role: auth.role, userId: auth.userId })).toBe(403);
      checked++;
    }
    expect(checked).toBe(5);
    expect(remove).not.toHaveBeenCalled();
    expect((await colsOf(row.id)).state).toBe("playable");
    expect(await deleteSeaznReplay({ ...w.auth, role: "admin" }, w.f, row.id, { replay: w.host }), "the positive pair: an admin").toEqual({ deleted: true });
  });

  // Task 31 (controller ruling 2b, 2026-11-23): the host forgets a removed copy's watch time with it, so with SEAZN_HOSTED_COST on the
  // delete reads the copy's minutes one last time BEFORE it removes it — from the session's first day (nothing measured yet) up to the
  // delete — and ADDS them to the session's replay minutes without moving `replay_measured_through`. Best-effort: a read that fails
  // never holds the delete back, and with the flag off nothing is read at all.
  const deliveryOf = async (sid: string) => (await sql<{ replay_minutes: string; replay_through: string | null }[]>`
    select replay_minutes::text, replay_measured_through::text as replay_through from fixture_video_delivery where session_id = ${sid}`)[0] ?? null;

  it("SEAZN_HOSTED_COST on: the copy's minutes are read up to the delete, BEFORE the removal, and added to the session's replay minutes", async () => {
    vi.stubEnv("SEAZN_HOSTED_COST", "true");
    const w = await world();
    const row = w.rows[0]!;
    const guid = row.bunny_video_id!;
    const at = new Date(w.t0 + 16 * MIN);
    w.host.setWatchMinutes(guid, 7.5);
    const order: string[] = [];
    const read = vi.spyOn(w.host, "watchMinutes");
    read.mockImplementation(async (id, from, to) => { order.push("read"); return FakeReplayHost.prototype.watchMinutes.call(w.host, id, from, to); });
    const remove = vi.spyOn(w.host, "remove");
    remove.mockImplementation(async (id) => { order.push("remove"); return FakeReplayHost.prototype.remove.call(w.host, id); });

    expect(await deleteSeaznReplay(w.auth, w.f, row.id, { now: at, replay: w.host })).toEqual({ deleted: true });
    expect(order, "read first: a removed copy answers nothing").toEqual(["read", "remove"]);
    const [{ created_at }] = await sql<{ created_at: Date }[]>`select created_at from fixture_stream_sessions where id = ${w.sid}`;
    const firstDay = new Date(`${new Date(created_at).toISOString().slice(0, 10)}T00:00:00.000Z`);
    expect(w.host.watchWindows(guid), "from the session's first UTC day up to the delete").toEqual([{ from: firstDay, to: at }]);
    expect(await deliveryOf(w.sid), "added; the daily pass's day not moved").toEqual({ replay_minutes: "7.5", replay_through: null });
    expect((await colsOf(row.id)).bunny_video_id, "the copy still removed and forgotten").toBeNull();
  });

  it("T31 review m2: the move's cleanup running while the delete takes the copy's last read does not remove the copy first — the delete holds the row for SEAZN_CLAIM_LEASE_SECONDS — so its minutes since the last pass are kept", async () => {
    vi.stubEnv("SEAZN_HOSTED_COST", "true");
    const w = await world();
    const row = w.rows[0]!;
    const guid = row.bunny_video_id!;
    const at = w.t0 + 16 * MIN;
    w.host.setWatchMinutes(guid, 7.5);
    const remove = vi.spyOn(w.host, "remove");
    let moved = 0;
    vi.spyOn(w.host, "watchMinutes").mockImplementationOnce(async (id, from, to) => {
      await w.move(at);   // a mover run between the delete's commit and its read reaching the host
      moved++;
      return FakeReplayHost.prototype.watchMinutes.call(w.host, id, from, to);
    });
    expect(await deleteSeaznReplay(w.auth, w.f, row.id, { now: new Date(at), replay: w.host })).toEqual({ deleted: true });
    expect(moved, "PREMISE: the move ran inside the last read").toBe(1);
    expect(remove.mock.calls, "removed once, by the delete, after its read").toEqual([[guid]]);
    expect(await deliveryOf(w.sid), "the copy's minutes kept").toEqual({ replay_minutes: "7.5", replay_through: null });
  });

  it("SEAZN_HOSTED_COST off — or malformed — reads nothing; a read that THROWS still deletes and removes the copy", async () => {
    let checked = 0;
    for (const flag of ["", "false", "yes"]) {
      vi.stubEnv("SEAZN_HOSTED_COST", flag);
      const w = await world();
      const read = vi.spyOn(w.host, "watchMinutes");
      expect(await deleteSeaznReplay(w.auth, w.f, w.rows[0]!.id, { replay: w.host })).toEqual({ deleted: true });
      expect(read, `SEAZN_HOSTED_COST=${JSON.stringify(flag)}`).not.toHaveBeenCalled();
      expect(await deliveryOf(w.sid)).toBeNull();
      checked++;
    }
    expect(checked).toBe(3);

    vi.stubEnv("SEAZN_HOSTED_COST", "true");
    const w = await world();
    const row = w.rows[0]!;
    vi.spyOn(w.host, "watchMinutes").mockRejectedValueOnce(new Error("bunny watchMinutes: request failed before a response"));
    const remove = vi.spyOn(w.host, "remove");
    expect(await deleteSeaznReplay(w.auth, w.f, row.id, { replay: w.host })).toEqual({ deleted: true });
    expect(remove.mock.calls).toEqual([[row.bunny_video_id]]);
    expect(await colsOf(row.id)).toMatchObject({ state: "deleted", bunny_video_id: null });
    expect(await deliveryOf(w.sid), "nothing written").toBeNull();
  });
});

// ─── Task 26: the organiser downloads a part ──────────────────────────────────────────────────────────────────────────────
describe.skipIf(!HAS_DB)("seaznReplayDownload — the organiser downloads a part (Task 26)", () => {
  async function world(o: { parts?: number; playable?: readonly number[] } = {}) {
    const r = await seaznRig();
    const host = new FakeReplayHost();
    const f = r.fixtureIds[0];
    const m = await movedReplays(r, f, host, o);
    const [names] = await sql<{ home: string | null; away: string | null }[]>`
      select he.display_name as home, ae.display_name as away from fixtures f
        left join entrants he on he.id = f.home_entrant_id left join entrants ae on ae.id = f.away_entrant_id where f.id = ${f}`;
    return { ...r, host, f, ...m, names: names! };
  }
  const bytesOf = async (body: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(body).arrayBuffer());
  const statusOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof HttpError ? e.status : e));
  /** The file's name: the poster's stem for the same two sides (one authority, poster-file-name.ts), then `-part-<n>.mp4` (brief). */
  const nameFor = (home: string | null, away: string | null, n: number) => posterFileName(home ?? "", away ?? "").replace(/\.png$/, `-part-${n}.mp4`);

  it("a playable part streams the host's own file, named for the match and the part, its size when the host says it", async () => {
    const w = await world({ parts: 2 });
    expect(w.names.home && w.names.away, "PREMISE: the fixture has two named sides").toBeTruthy();
    let checked = 0;
    for (const row of w.rows) {
      const file = await seaznReplayDownload(w.auth, w.f, row.id, { replay: w.host });
      expect(await bytesOf(file.body), `part ${row.part_no}`).toEqual(FAKE_REPLAY_FILE);
      expect(file.bytes).toBe(FAKE_REPLAY_FILE.length);
      expect(file.fileName).toBe(nameFor(w.names.home, w.names.away, row.part_no));
      expect(file.fileName).toMatch(/^seazn-[a-z0-9-]+-part-\d+\.mp4$/);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("only a playable part: processing, failed and deleted are 409 and the host is never asked", async () => {
    const w = await world({ parts: 3, playable: [3] });
    const [processing, toFail, playable] = w.rows as [typeof w.rows[0], typeof w.rows[0], typeof w.rows[0]];
    w.host.fail(toFail.bunny_video_id!);
    await w.move(w.t0 + 30 * MIN);
    await deleteSeaznReplay(w.auth, w.f, playable.id, { replay: w.host });
    expect((await replayRowsOf(w.f)).map((r) => r.state), "PREMISE").toEqual(["encoding", "failed", "deleted"]);
    const open = vi.spyOn(w.host, "openDownload");
    let checked = 0;
    for (const row of [processing, toFail, playable]) {
      expect(await statusOf(seaznReplayDownload(w.auth, w.f, row.id, { replay: w.host })), row.state).toBe(409);
      checked++;
    }
    expect(checked).toBe(3);
    expect(open).not.toHaveBeenCalled();
  });

  it("T22 m6: a row that reads playable while the host cannot hand the file over (the host's refusal) is a retryable 409, never a 500; the host not answering (a timeout, a network fault — review m1) is a clean 503 replay_host_unavailable, never dressed up as the refusal and never quoting the host", async () => {
    const w = await world();
    const row = w.rows[0]!;
    await w.host.remove(row.bunny_video_id!);
    const err = await seaznReplayDownload(w.auth, w.f, row.id, { replay: w.host }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
    expect((err as HttpError).message).not.toContain(row.bunny_video_id!);
    const boom = new ReplayHostUnavailable(`bunny openDownload: no response within 4000 ms (video ${row.bunny_video_id})`);
    vi.spyOn(w.host, "openDownload").mockRejectedValueOnce(boom);
    const failed = await seaznReplayDownload(w.auth, w.f, row.id, { replay: w.host }).then(() => null, (e: unknown) => e);
    expect(failed).toBeInstanceOf(HttpError);
    expect([(failed as HttpError).status, (failed as HttpError).code]).toEqual([503, "replay_host_unavailable"]);
    expect((failed as HttpError).message, "the host's own words stay in the log").not.toContain(row.bunny_video_id!);
    expect((failed as HttpError).message).not.toMatch(/bunny|4000/);
    // The refusal itself is the port's typed one (both hosts throw it; replay-bunny.test.ts and replay-fake.test.ts).
    expect(await w.host.openDownload(row.bunny_video_id!).then(() => null, (e: unknown) => e)).toBeInstanceOf(ReplayNotDownloadable);
  });

  it("T26 re-review m1 (a, b, d): each way the host can fail to start the file has its own answer and its own log level — not answering is 503 (warn: try again), refusing our key or Referer 500 replay_host_refused (error: a configuration fault, never 'try again'), anything else 500 replay_download_failed (error), the viewer having left 499 download_cancelled (info only, whatever the host threw) — and every line's detail goes through the file's scrubber", async () => {
    const w = await world();
    const row = w.rows[0]!;
    const guid = row.bunny_video_id!;
    // A host message that quotes a signed CDN address (the shared scrubber's `bcdn_token=` rule) and runs past the 200-character cap.
    const TOKEN = "Zm9vYmFyYmF6cXV4LXNpZ25lZC1jZG4tdG9rZW4tdmFsdWU";
    const quoted = (head: string) => `bunny ${head}: https://vz-x.b-cdn.net/bcdn_token=${TOKEN}&expires=1795255500/${guid}/play_720p.mp4 ${"x".repeat(300)}`;
    const spies = { info: vi.spyOn(log, "info"), warn: vi.spyOn(log, "warn"), error: vi.spyOn(log, "error") };
    const about = (s: { mock: { calls: unknown[][] } }) => s.mock.calls.filter(([f]) => typeof f === "object" && f !== null && (f as { replayId?: string }).replayId === row.id);
    const counts = () => ({ info: about(spies.info).length, warn: about(spies.warn).length, error: about(spies.error).length });
    // EMPTY CASE FIRST: the host starts the file — no line about it at any level.
    const file = await seaznReplayDownload(w.auth, w.f, row.id, { replay: w.host });
    expect(file.fileName).toMatch(/\.mp4$/);
    expect(counts()).toEqual({ info: 0, warn: 0, error: 0 });

    type Level = "info" | "warn" | "error";
    let refusals = 0;
    const cases: [string, Error, boolean, [number, string], Level][] = [
      ["no answer in the 4 s (or a network fault, a 5xx, a 429)", new ReplayHostUnavailable(quoted("openDownload: no response within 4000 ms")), false, [503, "replay_host_unavailable"], "warn"],
      ["the CDN refused our token or Referer (403)", new ReplayHostRefused(403, "delivery_token", quoted("openDownload: HTTP 403")), false, [500, "replay_host_refused"], "error"],
      ["the API refused our key (401)", new ReplayHostRefused(401, "api_key", quoted("video: HTTP 401")), false, [500, "replay_host_refused"], "error"],
      ["anything else (no allowed origin configured)", new Error(quoted("openDownload: SEAZN_VIDEO_ORIGINS is not set")), false, [500, "replay_download_failed"], "error"],
      ["the viewer left, and the host's request was cancelled", new Error(quoted("openDownload: cancelled before a response")), true, [499, "download_cancelled"], "info"],
      ["the viewer left, and the host then failed to answer", new ReplayHostUnavailable(quoted("openDownload: no response within 4000 ms")), true, [499, "download_cancelled"], "info"],
      ["the viewer left, and the host then refused", new ReplayHostRefused(403, "delivery_token", quoted("openDownload: HTTP 403")), true, [499, "download_cancelled"], "info"],
    ];
    let checked = 0;
    for (const [label, thrown, cancelled, want, level] of cases) {
      for (const spy of Object.values(spies)) spy.mockClear();
      const viewer = new AbortController();
      vi.spyOn(w.host, "openDownload").mockImplementationOnce(async () => {
        if (cancelled) viewer.abort(new Error("the viewer left"));
        throw thrown;
      });
      const err = await seaznReplayDownload(w.auth, w.f, row.id, { replay: w.host, signal: viewer.signal }).then(() => null, (e: unknown) => e);
      expect(err, label).toBeInstanceOf(HttpError);
      expect([(err as HttpError).status, (err as HttpError).code], label).toEqual(want);
      const message = (err as HttpError).message;
      expect(message, `${label}: the host's words stay in the log`).not.toMatch(new RegExp(`${guid}|bunny|b-cdn|4000|40[13]`));
      if (want[0] === 500) expect(message, `${label}: a fault on our side never says try again`).not.toMatch(/try|again|moment/i);
      expect(counts(), label).toEqual({ info: 0, warn: 0, error: 0, [level]: 1 });
      const [fields, line] = about(spies[level])[0]! as [{ detail?: unknown; status?: unknown; credential?: unknown }, string];
      expect(typeof fields.detail, `${label}: the host's words are in the line`).toBe("string");
      const detail = fields.detail as string;
      expect(detail.length, `${label}: capped at 200`).toBeLessThanOrEqual(200);
      expect(detail, `${label}: through the shared scrubber`).not.toContain(TOKEN);
      expect(detail).toContain("bcdn_token=[token]");
      if (thrown instanceof ReplayHostRefused && !cancelled) {
        expect([fields.status, fields.credential], `${label}: the line names the refusal's status and credential`).toEqual([thrown.status, thrown.credential]);
        // Task 27 review m3: the line names the setting that was actually refused, never the other one.
        const [named, other] = thrown.credential === "api_key" ? ["BUNNY_STREAM_API_KEY", "BUNNY_TOKEN_KEY"] : ["BUNNY_TOKEN_KEY", "BUNNY_STREAM_API_KEY"];
        expect(line, label).toContain(named);
        expect(line, label).not.toContain(other);
        refusals++;
      }
      checked++;
    }
    expect(checked).toBe(7);
    expect(refusals, "both credentials' lines read").toBe(2);
  });

  it("review m1: the caller's cancel (the route's request.signal) is handed to the host with the video, so an abandoned download stops pulling from it; none given, none passed", async () => {
    const w = await world();
    const row = w.rows[0]!;
    const open = vi.spyOn(w.host, "openDownload");
    await seaznReplayDownload(w.auth, w.f, row.id, { replay: w.host });
    expect(open.mock.calls[0], "EMPTY CASE: no signal").toEqual([row.bunny_video_id, undefined]);
    const viewer = new AbortController();
    await seaznReplayDownload(w.auth, w.f, row.id, { replay: w.host, signal: viewer.signal });
    expect(open.mock.calls[1]![0]).toBe(row.bunny_video_id);
    expect((open.mock.calls[1] as unknown as [string, AbortSignal | undefined])[1], "the caller's own signal").toBe(viewer.signal);
  });

  it("404 for another fixture's, another org's or an unknown part; 403 for anything but an editor's session — and the host is never asked", async () => {
    const w = await world();
    const other = await seaznRig();
    const row = w.rows[0]!;
    const open = vi.spyOn(w.host, "openDownload");
    const cases: [string, () => Promise<unknown>, number][] = [
      ["the org's other fixture", () => seaznReplayDownload(w.auth, w.fixtureIds[1], row.id, { replay: w.host }), 404],
      ["another org", () => seaznReplayDownload(other.auth, w.f, row.id, { replay: w.host }), 404],
      ["a random id", () => seaznReplayDownload(w.auth, w.f, randomUUID(), { replay: w.host }), 404],
      ["not a uuid", () => seaznReplayDownload(w.auth, w.f, "x", { replay: w.host }), 404],
      ["an API key", () => seaznReplayDownload({ ...w.auth, via: "api_key", userId: null }, w.f, row.id, { replay: w.host }), 403],
      ["a viewer", () => seaznReplayDownload({ ...w.auth, role: "viewer" }, w.f, row.id, { replay: w.host }), 403],
    ];
    let checked = 0;
    for (const [what, call, status] of cases) {
      expect(await statusOf(call()), what).toBe(status);
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(open).not.toHaveBeenCalled();
  });
});
