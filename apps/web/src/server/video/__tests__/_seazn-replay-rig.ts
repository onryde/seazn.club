// Seazn-hosted video, Task 26: replay rows made by the REAL producers, for the tests of what an organiser does with them (the delete,
// the download, and their routes). A Seazn session goes live on the fixture, records `parts` recordings, stops; the stream tick's lock
// pass, discovery and the replay move then carry each recording onto the replay fake, and the host finishes the parts asked for — the
// path seazn-video-replays.test.ts and organiser-replays.test.ts drive by hand. Its own file, so only the tests that need the producers
// load them (the session rig is imported by files that mock replay modules).
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { sql } from "@/lib/db";
import type { FakeIngest } from "@/server/relay/fakes";
import { lockSeaznRecordings } from "@/server/usecases/seazn-recordings";
import { type SeaznReplayDeps, discoverSeaznRecordings, moveSeaznRecordings } from "@/server/usecases/seazn-replays";
import { createPlaybackTokenCache } from "../cf-playback";
import { FAKE_REPLAY_LENGTH_SECONDS, type FakeReplayHost } from "../replay-fake";
import { type SeaznRig, live, stopAndSettle } from "./_seazn-session-rig";

const MIN = 60_000;
const BUDGET = 8_000;

export interface ReplayRigRow {
  id: string;
  cf_video_id: string;
  part_no: number;
  state: string;
  bunny_video_id: string | null;
  recorded_at: Date;
}
export const replayRowsOf = (fixtureId: string) =>
  sql<ReplayRigRow[]>`
    select id, cf_video_id, part_no, state, bunny_video_id, recorded_at from fixture_video_replays where fixture_id = ${fixtureId} order by part_no`;

/** `parts` recordings of one Seazn session on `fixtureId`, locked and DISCOVERED (rows `found`), the move not yet run: `move(at)` runs it
 *  onto `host`. `t0` is the session's end + 15 min, when discovery ran. */
export async function discoveredReplays(r: SeaznRig, fixtureId: string, host: FakeReplayHost, parts = 1) {
  const ingest = r.deps.drivers.ingest as FakeIngest;
  const sid = await live(r, fixtureId, r.seazn);
  const [prog] = await sql<{ uid: string }[]>`select ingest_input_id as uid from fixture_stream_inputs where session_id = ${sid} and role = 'programme'`;
  expect(prog?.uid, "PREMISE: the programme input has a uid").toBeTruthy();
  const base = r.deps.now().getTime();
  for (let k = 0; k < parts; k++) {
    ingest.addVideo({ videoId: `v-${k}-${randomUUID()}`, inputId: prog!.uid, createdAt: new Date(base + k * MIN).toISOString(), inProgress: false,
      durationSeconds: FAKE_REPLAY_LENGTH_SECONDS, height: 1080 });
  }
  await stopAndSettle(r, fixtureId, sid);
  const [{ ended_at }] = await sql<{ ended_at: Date }[]>`select ended_at from fixture_stream_sessions where id = ${sid}`;
  const endedAt = new Date(ended_at).getTime();
  const t0 = endedAt + 15 * MIN;
  const replayDeps: SeaznReplayDeps = { ingest, replay: host, tokenCache: createPlaybackTokenCache() };
  const opts = (at: number) => ({ now: new Date(at), budgetMs: BUDGET, orgIds: [r.auth.orgId] });
  expect(await lockSeaznRecordings(r.deps, opts(endedAt + MIN)), "PREMISE: the lock pass locked every recording").toMatchObject({ locked: parts });
  await sql`update fixtures set finished_at = ${new Date(endedAt)} where id = ${fixtureId}`;
  expect(await discoverSeaznRecordings(replayDeps, opts(t0)), "PREMISE: discovery listed every recording").toMatchObject({ discovered: parts });
  return { sid, replayDeps, endedAt, t0, opts, move: (at: number) => moveSeaznRecordings(replayDeps, opts(at)) };
}

/** `parts` recordings moved onto `host` by the real producers; the host finishes the parts numbered in `playable` (default: every
 *  part) and the move's poll verifies them, so those rows read `playable` and the rest `encoding`. The move first ran at `t0`, its
 *  poll at `t0 + 15 min`. */
export async function movedReplays(r: SeaznRig, fixtureId: string, host: FakeReplayHost, o: { parts?: number; playable?: readonly number[] } = {}) {
  const parts = o.parts ?? 1;
  const d = await discoveredReplays(r, fixtureId, host, parts);
  await d.move(d.t0);
  const moved = await replayRowsOf(fixtureId);
  expect(moved.map((row) => row.state), "PREMISE: every copy is on the host, encoding").toEqual(Array.from({ length: parts }, () => "encoding"));
  const finish = o.playable ?? moved.map((row) => row.part_no);
  for (const row of moved) if (finish.includes(row.part_no)) host.advance(row.bunny_video_id!);
  await d.move(d.t0 + 15 * MIN);
  const rows = await replayRowsOf(fixtureId);
  expect(rows.map((row) => row.state), "PREMISE: the finished parts are playable, the rest still encoding")
    .toEqual(rows.map((row) => (finish.includes(row.part_no) ? "playable" : "encoding")));
  return { ...d, rows: [...rows] as ReplayRigRow[] };
}
