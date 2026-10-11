// W2b Task 13 (spec §5.4/§5.5, X-AB-2) — `activeAbandonReasonSql`, the stored projection of the ledger fact the public
// abandon tag reads: the reason of the row's ACTIVE `core.abandon`, for an outcome an abandon can leave. It is NOT
// status-gated (a DLS abandon is `decided`, ST-G1), it ignores a voided abandon, and it answers the latest of two.
// Each row is a real fixture with its own ledger rows; the outcome column is set as the fold would store it.
//
// Real Postgres required; skipped without DATABASE_URL.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { ABANDON_RESULT_KINDS } from "@/lib/forfeit-tag";
import { seedOrg, startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import type { AuthCtx } from "@/server/api-v1/auth";
import { listDivisionFixtures } from "@/server/usecases/fixtures";
import { activeAbandonReasonSql } from "../recorded-abandon";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** Write a ledger by hand (ids returned, so a void can target one), then set the stored row. */
async function scene(fixtureId: string, status: string, outcome: unknown, events: { type: string; payload: unknown; voids?: number }[]) {
  await sql`delete from score_events where fixture_id = ${fixtureId}`;
  const ids: string[] = [];
  for (const [i, e] of events.entries()) {
    const id = randomUUID();
    ids.push(id);
    await sql`insert into score_events (id, fixture_id, seq, type, payload, recorded_at, voids_event_id)
              values (${id}, ${fixtureId}, ${i + 1}, ${e.type}, ${sql.json(e.payload as never)}, now(),
                      ${e.voids === undefined ? null : ids[e.voids]!})`;
  }
  await sql`update fixtures set status = ${status}, outcome = ${outcome === null ? null : sql.json(outcome as never)} where id = ${fixtureId}`;
  const [row] = await sql<{ reason: string | null }[]>`
    select ${activeAbandonReasonSql(sql, "f")} as reason from fixtures f where f.id = ${fixtureId}`;
  return row!.reason;
}

describe.skipIf(!HAS_DB)("activeAbandonReasonSql — the ledger's abandon reason, never the status", () => {
  let fixtureId = "";
  let divisionId = "";
  let auth: AuthCtx;
  beforeAll(async () => {
    ({ auth } = await seedOrg());
    ({ fixtureId, divisionId } = await startedDivisionWithFixture(auth));
  });
  const dls = { kind: "win", winner: "h", loser: "a", method: "dls" };
  const start = { type: "core.start", payload: {} };
  const abandon = (reason: string) => ({ type: "core.abandon", payload: { reason } });

  it("empty case first: no ledger, and a ledger with no abandon, are no reason", async () => {
    expect(await scene(fixtureId, "decided", dls, [])).toBeNull();
    expect(await scene(fixtureId, "decided", dls, [start])).toBeNull();
  });

  it("a DLS abandon is stored decided — the reason reads all the same (not status-gated)", async () => {
    expect(await scene(fixtureId, "decided", dls, [start, abandon("rain")])).toBe("rain");
    // …and the organiser's run sheet reads it off its own division read (the row `outcomeText` is handed).
    const rows = await listDivisionFixtures(auth, divisionId);
    expect(rows.find((r) => r.id === fixtureId)?.abandon_reason).toBe("rain");
  });

  it("every outcome kind an abandon can leave reads it; a forfeit's and none do not (the reader's own list)", async () => {
    const outcomes: Record<string, unknown> = { win: dls, draw: { kind: "draw" }, tie: { kind: "tie" }, no_result: { kind: "no_result" } };
    let read = 0;
    for (const kind of ABANDON_RESULT_KINDS) {
      expect(await scene(fixtureId, "decided", outcomes[kind], [start, abandon("floodlights")]), kind).toBe("floodlights");
      read++;
    }
    expect(read).toBe(ABANDON_RESULT_KINDS.length);
    expect(await scene(fixtureId, "abandoned", null, [start, abandon("rain")]), "no outcome").toBeNull();
    expect(await scene(fixtureId, "forfeited", { kind: "double_walkover" }, [start, abandon("rain")]), "a double walkover").toBeNull();
  });

  it("after a void: a voided abandon is no abandon; the latest active one wins", async () => {
    expect(await scene(fixtureId, "decided", dls, [start, abandon("rain"), { type: "core.void", payload: {}, voids: 1 }])).toBeNull();
    expect(
      await scene(fixtureId, "decided", dls, [start, abandon("rain"), { type: "core.void", payload: {}, voids: 1 }, abandon("bad light")]),
    ).toBe("bad light");
  });
});
