// Seazn-hosted video Task 25: the organiser's list of a fixture's Seazn replays (the fixture stream panel's ended state). Each part
// the replay move made, by its stored number, as the organiser reads it: `processing` while the move is on its way (found,
// downloading, fetching, encoding), `playable` once verified, `failed` when the copy failed its check; a removed part (the
// organiser's delete, Task 26, or `deleted`) is not listed. Org-scoped: another organisation's read of the fixture is 404, never an
// empty list, and the read rides the session view (`currentSession().seaznReplays`) the panel already polls.
//
// The rows come from the REAL producers (Go live, Stop, the lock, discovery and the move onto the replay fake), as
// seazn-video-replays.test.ts makes them; only the organiser's delete is written by hand (Task 26 owns it). The state words are the
// brief's, typed here. ONE SPORT, on purpose (TEST-STRATEGY rule 6): the read never reads a sport rule; every rig rides `generic`.
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
import { UnknownOrganiserReplayState, fixtureSeaznReplays, organiserReplayState } from "../organiser-replays";
import { FAKE_REPLAY_LENGTH_SECONDS, FakeReplayHost } from "../replay-fake";
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
    await sql`update fixture_video_replays set deleted_at = now(), deleted_reason = 'organiser', state = 'deleted' where id = ${rows[3]!.id}`;
    const after = await sql<{ part_no: number; state: string; length_seconds: number | null }[]>`
      select part_no, state, length_seconds from fixture_video_replays where fixture_id = ${f} order by part_no`;
    expect(after.map((r) => r.state), "PREMISE: playable, encoding, failed, deleted").toEqual(["playable", "encoding", "failed", "deleted"]);

    const list = await fixtureSeaznReplays(w.auth.orgId, f);
    expect(list).toEqual([
      { id: rows[0]!.id, partNo: 1, state: "playable", lengthSeconds: FAKE_REPLAY_LENGTH_SECONDS },
      { id: rows[1]!.id, partNo: 2, state: "processing", lengthSeconds: after[1]!.length_seconds },
      { id: rows[2]!.id, partNo: 3, state: "failed", lengthSeconds: after[2]!.length_seconds },
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
