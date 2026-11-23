// V545 (Seazn-hosted video, Task 27b): two schema facts.
//  1. `fixture_stream_samples.source` admits `notification`: a Cloudflare live-input notification (live_input.connected,
//     .disconnected, .errored) is recorded as a sample beside the poll's, so a drop and a reconnect inside one poll gap leave a
//     trace (usecases/stream-sessions/live-notification.ts). The two old sources stay; anything else is still refused.
//  2. A Bunny copy is named by at most ONE replay row: a partial UNIQUE index on `fixture_video_replays (bunny_video_id) where
//     bunny_video_id is not null` (the Task 27 review's m4 carry). The webhook looks a copy up by its id on every acted event, so
//     the index serves that read, and the "two rows name one copy" invariant becomes a constraint instead of a code guard. Built
//     PLAIN, never CONCURRENTLY: Flyway runs each delta in a transaction, where CONCURRENTLY is refused.
//  3. (Task 27b review m3) A plain partial index on `fixture_stream_inputs (ingest_input_id)`: every notification delivery, from
//     both environments and for every input on the shared account, looks its input up by uid, as relay-sweep does. Not UNIQUE:
//     the uid mapping's one-row rule is a named code guard (live-notification.ts `ambiguous_input`), never a constraint a
//     prod row could fail.
//
// Each refusal has its accepted twin in the same `it`, so an empty schema cannot pass: the twin fails first. Real Postgres
// required; skipped without DATABASE_URL like every DB suite here. Every probe runs in a transaction that is always rolled back.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sql, type Tx } from "@/lib/db";
import { divisionRig, seedOrg } from "@/server/usecases/__tests__/_rig";
import { stripSqlComments } from "./_stream-migration";

const HAS_DB = !!process.env.DATABASE_URL;
const DELTAS = resolve(import.meta.dirname, "../../../../../../db/migration/deltas");
const V545 = readdirSync(DELTAS).find((f) => /^V545__.+\.sql$/.test(f));
const V545_SQL = V545 ? stripSqlComments(readFileSync(join(DELTAS, V545), "utf8")) : "";
/** The index's name, typed here (the migration names it; this test pins that name). */
const GUID_INDEX = "fixture_video_replays_bunny_video_id_key";
const INPUT_UID_INDEX = "fixture_stream_inputs_ingest_input_id_idx";

const failure = async (p: PromiseLike<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; constraint_name?: string };
    return `${err.code ?? "thrown"}:${err.constraint_name ?? ""}`;
  }
  return "landed";
};
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
const probe = (tx: Tx, q: (sp: Tx) => PromiseLike<unknown>): Promise<string> => failure(tx.savepoint((sp) => q(sp as Tx)));

/** An org, a started fixture and one raw ended session on it (the samples and replay rows hang off a session). */
async function sessionRow(tx: Tx): Promise<{ orgId: string; fixtureId: string; sessionId: string }> {
  const { auth } = await seedOrg();
  const { fixtureIds } = await divisionRig(auth, { entrants: 2 });
  const fixtureId = fixtureIds[0]!;
  const [u] = await tx<{ id: string }[]>`insert into users (email, display_name, email_verified) values (${`v545-${randomUUID()}@test.local`}, 'V545', true) returning id`;
  const [t] = await tx<{ id: string }[]>`
    insert into org_stream_targets (org_id, kind, label, rtmp_enc) values (${auth.orgId}, 'youtube', 'V545', ${Buffer.from("not-a-real-envelope")}) returning id`;
  const [s] = await tx<{ id: string }[]>`
    insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, sport_key, competition_id, division_id, entitlement_via_override, ended_at)
    select f.id, ${auth.orgId}, 'passthrough', 'completed', ${t!.id}, ${u!.id}, d.sport_key, d.competition_id, f.division_id, true, now()
      from fixtures f join divisions d on d.id = f.division_id where f.id = ${fixtureId}
    returning id`;
  return { orgId: auth.orgId, fixtureId, sessionId: s!.id };
}

describe("V545: the migration text", () => {
  it("exists, builds the guid index PLAIN (Flyway's transaction refuses CONCURRENTLY), and names it", () => {
    expect(V545, "V545's delta file").toBeDefined();
    expect(V545_SQL).not.toMatch(/\bconcurrently\b/i);
    expect(V545_SQL).toMatch(new RegExp(`create\\s+unique\\s+index\\s+${GUID_INDEX}\\b`, "i"));
    expect(V545_SQL, "the input-uid index is plain, never unique").toMatch(new RegExp(`create\\s+index\\s+${INPUT_UID_INDEX}\\b`, "i"));
  });
});

describe.skipIf(!HAS_DB)("V545: the schema", () => {
  it("fixture_stream_samples.source admits `notification` beside `heartbeat` and `poll`, and still refuses any other word (counts reported)", async () => {
    await rolledBack(async (tx) => {
      const { sessionId } = await sessionRow(tx);
      let landed = 0;
      for (const source of ["heartbeat", "poll", "notification"]) {
        expect(await probe(tx, (sp) => sp`insert into fixture_stream_samples (session_id, source, ingest_state) values (${sessionId}, ${source}, 'disconnected')`), source).toBe("landed");
        landed++;
      }
      expect(landed).toBe(3);
      let refused = 0;
      for (const source of ["guess", "webhook", "Notification", ""]) {
        expect(await probe(tx, (sp) => sp`insert into fixture_stream_samples (session_id, source) values (${sessionId}, ${source})`), JSON.stringify(source))
          .toBe("23514:fixture_stream_samples_source_check");
        refused++;
      }
      expect(refused).toBe(4);
    });
  });

  it("a Bunny copy is named by at most one replay row: a second row naming it is refused by the unique index (23505); rows with no copy, and rows with different copies, all land", async () => {
    await rolledBack(async (tx) => {
      const { orgId, fixtureId, sessionId } = await sessionRow(tx);
      let part = 0;
      const row = (sp: Tx, state: string, guid: string | null) => sp`
        insert into fixture_video_replays (org_id, session_id, fixture_id, cf_video_id, recorded_at, part_no, state, bunny_video_id, verified_at)
        values (${orgId}, ${sessionId}, ${fixtureId}, ${`v-${randomUUID()}`}, now(), ${++part}, ${state}, ${guid}, ${state === "playable" ? new Date() : null})`;
      const guid = `g-${randomUUID()}`;
      // The accepted twins first: no copy (twice), and two different copies.
      expect(await probe(tx, (sp) => row(sp, "found", null)), "a row with no copy").toBe("landed");
      expect(await probe(tx, (sp) => row(sp, "found", null)), "a second row with no copy: nulls never collide").toBe("landed");
      expect(await probe(tx, (sp) => row(sp, "encoding", guid)), "a row naming a copy").toBe("landed");
      expect(await probe(tx, (sp) => row(sp, "encoding", `g-${randomUUID()}`)), "a row naming another copy").toBe("landed");
      // The refusals: the same copy named again, whatever the second row's state.
      let refused = 0;
      for (const state of ["encoding", "playable", "failed", "deleted"]) {
        expect(await probe(tx, (sp) => row(sp, state, guid)), state).toBe(`23505:${GUID_INDEX}`);
        refused++;
      }
      expect(refused).toBe(4);
    });
  });

  it("Task 27b review m3: the input-uid index is plain (not unique), partial on a set uid, and on ingest_input_id alone (pg_indexes)", async () => {
    const [ix] = await sql<{ indexdef: string }[]>`select indexdef from pg_indexes where indexname = ${INPUT_UID_INDEX}`;
    expect(ix, "the index exists").toBeDefined();
    expect(ix!.indexdef).toMatch(/^CREATE INDEX \S+ ON \S*fixture_stream_inputs USING btree \(ingest_input_id\) WHERE \(ingest_input_id IS NOT NULL\)$/);
  });

  it("the index is unique, partial on a named copy, and on bunny_video_id alone (pg_indexes)", async () => {
    const [ix] = await sql<{ indexdef: string }[]>`select indexdef from pg_indexes where indexname = ${GUID_INDEX}`;
    expect(ix, "the index exists").toBeDefined();
    expect(ix!.indexdef).toMatch(/^CREATE UNIQUE INDEX \S+ ON \S*fixture_video_replays USING btree \(bunny_video_id\) WHERE \(bunny_video_id IS NOT NULL\)$/);
  });
});
