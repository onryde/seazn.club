// W2c Task 19 (S4) - `listDivisionFixtures` flags the matches whose format was changed (`rules_override is not null as
// format_changed`), the run sheet's "Format changed" chip reading it. Both directions, the reset, a second change, and a
// sibling that was never touched - against the real writer, never a row written around it. Real Postgres.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { listDivisionFixtures } from "../fixtures";
import { writeFixtureRulesOverride } from "../fixture-rules";
import { builtinModules } from "@seazn/engine/sports";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("listDivisionFixtures: format_changed", () => {
  it("false on every untouched row; true exactly on the changed one; false again after a reset; true on a second change", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 4 });
    const flags = async (): Promise<Record<string, boolean | undefined>> =>
      Object.fromEntries((await listDivisionFixtures(b.auth, b.divisionId)).map((r) => [r.id, r.format_changed]));
    const [a, ...others] = b.fixtureIds;
    expect(others.length, "a sibling that stays untouched exists").toBeGreaterThan(0);

    let seen = await flags();
    expect(Object.keys(seen).length, "the list returned the rows").toBe(b.fixtureIds.length);
    for (const id of b.fixtureIds) expect(seen[id], "untouched").toBe(false);

    // A best-of the stage does not play, taken from the sport's own declared variant (never a typed literal).
    const m = builtinModules.find((x) => x.key === "badminton")!;
    const stageBestOf = (m.configSchema.parse(m.variants.short) as { bestOf: number }).bestOf;
    const other = stageBestOf === 1 ? 3 : 1;
    await writeFixtureRulesOverride(b.auth, [a!], { bestOf: other });
    seen = await flags();
    expect(seen[a!], "changed").toBe(true);
    for (const id of others) expect(seen[id], "a sibling is not tagged by its neighbour's change").toBe(false);

    await writeFixtureRulesOverride(b.auth, [a!], null);
    seen = await flags();
    expect(seen[a!], "after reset").toBe(false);

    await writeFixtureRulesOverride(b.auth, [a!], { bestOf: other });
    expect((await flags())[a!], "changed again").toBe(true);
    // A change that writes the stage's own value back is no change (the writer stores only the differing leaves).
    await writeFixtureRulesOverride(b.auth, [a!], { bestOf: stageBestOf });
    expect((await flags())[a!], "set to the stage's own value = no override = not tagged").toBe(false);
    // And the column is the single source: the flag agrees with the row.
    const [row] = await sql<{ n: boolean }[]>`select (rules_override is not null) as n from fixtures where id = ${a!}`;
    expect(row!.n).toBe(false);
  });
});
