// W2a fix round 1, controller ruling D-F3 — a HELD fixture (needs_decision) is a recorded result for
// `division_has_results`, the one predicate behind the `divisions.per_competition.max` quota slot, restoreDivision
// and deleteDivision's guard (V354, V355).
//
// A held fixture is a bracket match PLAYED to a level result (a chess draw, a level football knockout), waiting for
// the organiser's settle. Read as "no results", a division whose only play is held would refund its quota slot on
// archive (create → play to a draw → archive → create again: the evasion V354 closes) and lose deleteDivision's
// guard. V355's own rule still applies inside the held arm: a `no_result` outcome is not a verdict (a held chess
// DOUBLE forfeit — nobody played), so it charges nothing, exactly as a rained-off abandon does.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateDivision } from "@/server/api-v1/schemas";
import { createCompetition } from "@/server/usecases/competitions";
import { archiveDivision, createDivision } from "@/server/usecases/divisions";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
/** Pinned by override (V355's suite does the same): the live community value moves with pricing. */
const DIVISION_QUOTA = 2;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

async function seedCommunityCompetition(): Promise<{ auth: AuthCtx; competitionId: string }> {
  const { auth } = await seedOrg("community");
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${auth.orgId}, 'divisions.per_competition.max', ${DIVISION_QUOTA}, 'held-fixture probe')`;
  await invalidateOrgEntitlements(auth.orgId);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Held ${randomUUID().slice(0, 6)}`,
    visibility: "private",
    branding: {},
  });
  return { auth, competitionId: comp.id };
}

const divisionInput = (name: string): CreateDivision =>
  ({
    name,
    slug: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}`,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  }) as CreateDivision;

/** One fixture in its own KNOCKOUT stage (needs_decision only arises in a bracket), written directly: the point is
 *  the stored (status, outcome) pair, not the fold that produces it. */
async function recordFixture(divisionId: string, status: string, outcome: unknown): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from stages where division_id = ${divisionId}`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name)
    values (${divisionId}, ${n + 1}, 'knockout', ${`Knockout ${n + 1}`}) returning id`;
  await sql`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, status, outcome)
    values (${stageId}, ${divisionId}, 1, 1, ${status}, ${outcome === null ? null : sql.json(outcome as never)})`;
}

const hasResults = async (divisionId: string) =>
  (await sql<{ v: boolean }[]>`select division_has_results(${divisionId}) as v`)[0]!.v;

const DRAW = { kind: "draw" };
const TIE = { kind: "tie" };
const NO_RESULT = { kind: "no_result", method: "double_forfeit" };

describe.skipIf(!HAS_DB)("D-F3: a held fixture is a recorded result for division_has_results", () => {
  it("D-F3: a division whose only played fixture is HELD has results; the same division with it still scheduled has none", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const d = await createDivision(auth, competitionId, divisionInput("H"));
    await recordFixture(d.id, "scheduled", null);
    expect(await hasResults(d.id), "the positive pair: nothing played yet").toBe(false);
    let checked = 0;
    for (const outcome of [DRAW, TIE]) {
      await sql`delete from stages where division_id = ${d.id}`;
      await recordFixture(d.id, "needs_decision", outcome);
      expect(await hasResults(d.id), `needs_decision/${outcome.kind}`).toBe(true);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("D-F3 (V355's rule inside the held arm): a held NO_RESULT (a chess double forfeit: nobody played) is not a result", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const d = await createDivision(auth, competitionId, divisionInput("N"));
    await recordFixture(d.id, "needs_decision", NO_RESULT);
    expect(await hasResults(d.id)).toBe(false);
  });

  it("D-F3: V432's OWN text of the function (applied in a rolled-back transaction) counts a held draw and not a held no_result", async () => {
    // The live cases above prove the applied DB; this one ties the proof to the migration's text, read from the
    // file, so an edit to V432 that drops the held arm reds here even on a DB that already ran the old text.
    const v432 = readFileSync(resolve(__dirname, "../../../../../../db/migration/deltas/V432__fixture_status_needs_decision.sql"), "utf8");
    const fn = /create or replace function division_has_results[\s\S]*?\$\$;/.exec(v432.replace(/--.*$/gm, ""))?.[0];
    expect(fn, "V432 redefines division_has_results").toBeDefined();
    const { auth, competitionId } = await seedCommunityCompetition();
    const held = await createDivision(auth, competitionId, divisionInput("T"));
    const none = await createDivision(auth, competitionId, divisionInput("U"));
    await recordFixture(held.id, "needs_decision", DRAW);
    await recordFixture(none.id, "needs_decision", NO_RESULT);
    const ROLLBACK = new Error("rollback");
    let seen: Record<string, boolean> = {};
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe(fn!);
        const rows = await tx<{ id: string; v: boolean }[]>`
          select id, division_has_results(id) as v from divisions where id in (${held.id}, ${none.id})`;
        seen = Object.fromEntries(rows.map((r) => [r.id, r.v]));
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
    expect(Object.keys(seen)).toHaveLength(2);
    expect(seen[held.id], "held draw").toBe(true);
    expect(seen[none.id], "held no_result").toBe(false);
  });

  it("D-F3: archiving a division whose only play is held keeps its quota slot spent (no archive-and-recreate)", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    await createDivision(auth, competitionId, divisionInput("A"));
    const b = await createDivision(auth, competitionId, divisionInput("B"));
    await recordFixture(b.id, "needs_decision", DRAW);
    await sql`
      insert into registration_settings (division_id, enabled) values (${b.id}, false)
      on conflict (division_id) do update set enabled = false, closes_at = null`;
    await archiveDivision(auth, b.id);
    await expect(createDivision(auth, competitionId, divisionInput("C"))).rejects.toMatchObject({
      status: 402,
      featureKey: "divisions.per_competition.max",
    });
  });
});
