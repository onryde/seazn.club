// V557 (Seazn-hosted video, Phase 4, Task 39): `seazn_locked_videos.ready_at`, when the Seazn pass last saw Cloudflare able to PLAY
// the recording (state `ready`). Null means not yet, or not any more (queued, in progress, errored): the replay read offers a
// Cloudflare part only when it is set. Nullable, no default: a default would be a claim nobody measured, so the only writers are the
// pass (and the backfill below). The backfill sets it, to the lock's own time, for a lock that already has a replay row, because
// discovery stores a row only for a recording Cloudflare reported `ready`; a lock with no row is left null for the pass to decide.
//
// The delta is found by NAME, never by number (a rebase renumbers it), and RUN as a whole against the live schema inside a rolled
// back transaction, twice: that is the idempotence proof (a second run changes nothing) and the backfill's own test, with the
// accepted twin for each refusal in the same `it`. Real Postgres required for the schema half; the text half runs everywhere.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sql, type Tx } from "@/lib/db";
import { divisionRig, seedOrg } from "@/server/usecases/__tests__/_rig";

const HAS_DB = !!process.env.DATABASE_URL;
const DELTAS = resolve(import.meta.dirname, "../../../../../../db/migration/deltas");
const FILES = readdirSync(DELTAS).filter((f) => /^V\d+__seazn_recording_ready\.sql$/.test(f));
const FILE = FILES.length === 1 ? FILES[0] : undefined;
const TEXT = FILE ? readFileSync(join(DELTAS, FILE), "utf8") : "";
const code = (t: string): string => t.replace(/--.*$/gm, "");

const ROLLBACK = new Error("rollback: probes leave nothing behind");
async function rolledBack(fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}

describe("V557 seazn_recording_ready — the delta's text", () => {
  it("exactly one delta of that name, adding ready_at as a nullable timestamptz with NO default, guarded for a re-run", () => {
    expect(FILES, "PREMISE: exactly one delta carries the name").toHaveLength(1);
    const body = code(TEXT);
    expect(body).toMatch(/if not exists \(\s*select 1 from information_schema\.columns[^;]*column_name = 'ready_at'\s*\) then\s+alter table seazn_locked_videos add column ready_at timestamptz null;/);
    expect(body, "no default: nothing but the pass claims a recording is playable").not.toMatch(/ready_at[^;]*default/i);
  });
});

describe.skipIf(!HAS_DB)("V557 seazn_recording_ready — against the schema", () => {
  it("the column is a nullable timestamptz with no default, and a lock written without it reads null", async () => {
    const [col] = await sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name = 'seazn_locked_videos' and column_name = 'ready_at'`;
    expect(col).toEqual({ data_type: "timestamp with time zone", is_nullable: "YES", column_default: null });
  });

  it("the backfill marks a lock that has a replay row ready (at its lock time) and leaves one without a row null; a second run changes nothing", async () => {
    expect(FILE, "PREMISE: the delta exists").toBeDefined();
    const { auth } = await seedOrg();
    const { fixtureIds } = await divisionRig(auth, { entrants: 2 });
    const fixtureId = fixtureIds[0]!;
    const [src] = await sql<{ division_id: string; competition_id: string; sport_key: string }[]>`
      select f.division_id, d.competition_id, d.sport_key from fixtures f join divisions d on d.id = f.division_id where f.id = ${fixtureId}`;
    const [seazn] = await sql<{ id: string }[]>`select id from org_stream_targets where org_id = ${auth.orgId} and kind = 'seazn'`;
    let checked = 0;
    await rolledBack(async (tx) => {
      const [session] = await tx<{ id: string }[]>`
        insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, destination_kind,
                                             sport_key, competition_id, division_id, entitlement_via_override)
        values (${fixtureId}, ${auth.orgId}, 'composed', 'completed', ${seazn!.id}, ${randomUUID()}, 'seazn',
                ${src!.sport_key}, ${src!.competition_id}, ${src!.division_id}, true)
        returning id`;
      // The column is there already (the schema is migrated): drop it in this rolled-back transaction, so the delta adds it for real.
      await tx`alter table seazn_locked_videos drop column ready_at`;
      const [input] = await tx<{ id: string }[]>`insert into fixture_stream_inputs (session_id, slot) values (${session!.id}, 0) returning id`;
      const withRow = `v-row-${randomUUID()}`;
      const without = `v-none-${randomUUID()}`;
      await tx`insert into seazn_locked_videos (cf_video_id, input_row_id, locked_at) values (${withRow}, ${input!.id}, '2026-11-01T10:00:00Z'), (${without}, ${input!.id}, '2026-11-01T11:00:00Z')`;
      await tx`insert into fixture_video_replays (org_id, session_id, fixture_id, cf_video_id, recorded_at, part_no, state)
               values (${auth.orgId}, ${session!.id}, ${fixtureId}, ${withRow}, now(), 1, 'found')`;
      const readyAt = async () => Object.fromEntries((await tx<{ cf_video_id: string; ready_at: Date | null }[]>`
        select cf_video_id, ready_at from seazn_locked_videos where input_row_id = ${input!.id}`).map((r) => [r.cf_video_id, r.ready_at?.toISOString() ?? null]));
      await tx.unsafe(TEXT);
      const after = await readyAt();
      expect(after, "backfilled: the one with a row, at its lock time; the other left to the pass").toEqual({ [withRow]: "2026-11-01T10:00:00.000Z", [without]: null });
      checked += 2;
      // The pass later clears the one with a row (Cloudflare errored it): a re-run of the delta must not bring it back, nor move another.
      await tx`update seazn_locked_videos set ready_at = null where cf_video_id = ${withRow}`;
      await tx`update seazn_locked_videos set ready_at = '2026-11-02T00:00:00Z' where cf_video_id = ${without}`;
      await tx.unsafe(TEXT);
      expect(await readyAt(), "the delta run again resurrects nothing the pass cleared and moves nothing it set")
        .toEqual({ [withRow]: null, [without]: "2026-11-02T00:00:00.000Z" });
      checked += 2;
    });
    expect(checked, "anti-vacuity: rows checked").toBe(4);
  });
});
