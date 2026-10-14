// W2c Task 12 fix round 2 (review M-4). `seedBracket({ stageRules: {} })` is the held rig's shorthand: no stage rules,
// so the stage plays its division's config. That is every decider off only where the division plays none of its own.
// Ice hockey iihf and hockey fih-shootout DO play theirs, so a held rig written that way would quietly play overtime or
// a shoot-out. The helper refuses that by name before writing anything; "division" keeps the division's deciders on
// purpose; `decidersOffRules` is the held rig for those variants.
import { afterAll, describe, expect, it } from "vitest";
import { forbidsLevelResult, StageKind } from "@seazn/engine/core";
import { type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { decidersOffRules } from "@/lib/stage-decider-off";
import { divisionPlayedDeciders, seedBracket } from "./helpers/seed-bracket";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** The variants the review names, each with the deciders its own division plays. */
const PLAYS_ITS_OWN: Readonly<Record<string, readonly string[]>> = { "icehockey/iihf": ["overtime", "shootout"], "hockey/fih-shootout": ["shootout"] };

describe("M-4 seedBracket's `stageRules: {}` is refused where the division plays a decider", () => {
  it("swept over every sport x variant x bracket kind: only the named variants' divisions play a decider of their own (counted)", () => {
    let checked = 0;
    const playing = new Map<string, string[]>();
    for (const m of builtinModules as readonly AnySportModule[]) {
      for (const variant of Object.keys(m.variants)) {
        for (const kind of StageKind.options.filter((k) => forbidsLevelResult(k))) {
          const played = divisionPlayedDeciders(m.key, variant, kind);
          if (played.length > 0) {
            const where = `${m.key}/${variant}`;
            expect(playing.get(where) ?? played, `${where}: the same deciders whatever the bracket kind`).toEqual(played);
            playing.set(where, played);
          }
          checked++;
        }
      }
    }
    expect(checked, "anti-vacuity").toBeGreaterThan(0);
    expect(Object.fromEntries(playing)).toEqual(PLAYS_ITS_OWN);
  });

  it("refuses `{}` for the named variants by name, before any I/O; their held rig is decidersOffRules", async () => {
    let refused = 0;
    for (const where of Object.keys(PLAYS_ITS_OWN)) {
      const [sport, variant] = where.split("/") as [string, string];
      const m = builtinModules.find((x) => x.key === sport) as AnySportModule;
      // Before any write: the call has already settled when the event loop first reaches I/O, so not one query ran (a
      // global row count races the other suites' parallel writes).
      const seeded = seedBracket({ sport, variant, stageKind: "knockout", entrants: 2, stageRules: {} });
      const settled = await Promise.race([
        seeded.then(() => "seeded", (e: unknown) => e),
        new Promise((r) => setImmediate(() => r("still running when I/O was reached"))),
      ]);
      expect(settled, `${where}: refused before any I/O`).toBeInstanceOf(Error);
      expect((settled as Error).message).toMatch(
        new RegExp(`stageRules \\{\\} is not every decider off for ${sport}/${variant} — its division plays ${PLAYS_ITS_OWN[where]!.join(", ")}`),
      );
      // The held rig for these variants switches every decider off explicitly: nothing left for the division to play.
      expect(Object.keys(decidersOffRules(m, variant, "knockout")).length, `${where}: a held rig exists`).toBeGreaterThan(0);
      refused++;
    }
    expect(refused).toBe(2);
  });

  it.skipIf(!HAS_DB)("the positive pair: `{}` on football 11-a-side still seeds a held rig (no rules stored); \"division\" on iihf keeps the division's deciders", async () => {
    const football = await seedBracket({ sport: "football", variant: "11-a-side", stageKind: "knockout", entrants: 2, stageRules: {} });
    const iihf = await seedBracket({ sport: "icehockey", variant: "iihf", stageKind: "knockout", entrants: 2, stageRules: "division" });
    const rules = async (stageId: string) =>
      (await sql<{ config: Record<string, unknown> }[]>`select config from stages where id = ${stageId}`)[0]!.config.rules;
    expect(await rules(football.stageId)).toBeUndefined();
    expect(await rules(iihf.stageId)).toBeUndefined();
  });
});
