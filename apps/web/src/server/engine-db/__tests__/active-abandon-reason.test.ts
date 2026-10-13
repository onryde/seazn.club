// W2b Task 13 (spec §5.4/§5.5, X-AB-2) — `activeAbandonReasonSql`, the stored projection of the ledger fact the public
// abandon tag reads: the reason of the row's ACTIVE `core.abandon`, for an outcome an abandon can leave. It is NOT
// status-gated for a result (a DLS abandon is `decided`, ST-G1), it ignores a voided abandon, and it answers the latest
// of two. NO outcome is read at status `abandoned` only (T16 review m3, X-AB-1: an abandon that decided nobody), never
// for a withdrawal's expunge.
// Each row is a real fixture with its own ledger rows; the outcome column is set as the fold would store it.
//
// Real Postgres required; skipped without DATABASE_URL.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { ABANDON_RESULT_KINDS, forfeitTag } from "@/lib/forfeit-tag";
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

  it("every outcome kind an abandon can leave reads it, and so does no outcome at abandoned (X-AB-1); a forfeit's and an expunge do not", async () => {
    const outcomes: Record<string, unknown> = { win: dls, draw: { kind: "draw" }, tie: { kind: "tie" }, no_result: { kind: "no_result" } };
    let read = 0;
    for (const kind of ABANDON_RESULT_KINDS) {
      expect(await scene(fixtureId, "decided", outcomes[kind], [start, abandon("floodlights")]), kind).toBe("floodlights");
      read++;
    }
    expect(read).toBe(ABANDON_RESULT_KINDS.length);
    // T16 review m3: an abandon that decided nobody (the replay policy; R16-3's level abandon where draws are refused)
    // reads its reason, as the public tag now does; a withdrawal's expunge took the match out altogether and does not.
    expect(await scene(fixtureId, "abandoned", null, [start, abandon("rain")]), "no outcome, abandoned").toBe("rain");
    expect(await scene(fixtureId, "abandoned", null, [start, { type: "core.abandon", payload: { reason: "withdrew", expunge: true } }]), "an expunge").toBeNull();
    expect(await scene(fixtureId, "forfeited", { kind: "double_walkover" }, [start, abandon("rain")]), "a double walkover").toBeNull();
  });

  it("review M-3: the probe runs for EXACTLY the outcomes the reader tags — a played win (the commonest row) is never probed", async () => {
    // The expected answer is the READER's (`forfeitTag` beside an active abandon), not this SQL's: the gate exists so
    // the probe runs only where the reader could use it. Every outcome shape a stored row can hold, beside an abandon.
    const shapes: Record<string, unknown> = {
      "win, no method (a played result)": { kind: "win", winner: "h", loser: "a" },
      "win by DLS": dls,
      "win by the award policy's leader": { kind: "win", winner: "h", loser: "a", method: "abandoned" },
      "win by a settle": { kind: "win", winner: "h", loser: "a", method: "settled_toss" },
      "win on penalties": { kind: "win", winner: "h", loser: "a", method: "shootout" },
      draw: { kind: "draw" },
      tie: { kind: "tie" },
      no_result: { kind: "no_result" },
      "a walkover": { kind: "award", winner: "h", loser: "a", reason: "walkover" },
      "a bye": { kind: "award", winner: "h", loser: null, reason: "bye" },
      "a double walkover": { kind: "double_walkover" },
      "no outcome": null,
    };
    let probed = 0;
    let skipped = 0;
    for (const [name, outcome] of Object.entries(shapes)) {
      // an ABANDON tag (a forfeit or a double walkover is tagged by its own kind, ledger or not)
      const readerTags = forfeitTag(outcome, { abandon: { reason: "rain" } })?.kind.startsWith("abandoned") === true;
      // No outcome beside an active abandon lives at `abandoned` (the abandon's own status); a result at `decided`.
      const got = await scene(fixtureId, outcome === null ? "abandoned" : "decided", outcome, [start, abandon("rain")]);
      expect(got, name).toBe(readerTags ? "rain" : null);
      if (readerTags) probed++;
      else skipped++;
    }
    expect([probed, skipped], "both halves reached").toEqual([6, 6]);
    // …and the gate: the commonest null-outcome row, a scheduled one, is never probed (T16 review m3). Its ledger here is
    // one no scheduled row holds, so a probe would read it and show.
    expect(await scene(fixtureId, "scheduled", null, [start, abandon("rain")]), "a scheduled row is never probed").toBeNull();
  });

  it("after a void: a voided abandon is no abandon; the latest active one wins", async () => {
    expect(await scene(fixtureId, "decided", dls, [start, abandon("rain"), { type: "core.void", payload: {}, voids: 1 }])).toBeNull();
    expect(
      await scene(fixtureId, "decided", dls, [start, abandon("rain"), { type: "core.void", payload: {}, voids: 1 }, abandon("bad light")]),
    ).toBe("bad light");
  });
});
