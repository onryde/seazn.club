// W2d Task 2 fix round 1 (review I2, ruling: FIVB 6.4.3) — a volleyball league match abandoned part-way and settled by
// the organiser (W2c X-AB-5, `settled_<method>`) is paid under a stage set-score map as a team declared incomplete: the
// winner given the sets it needed, the other side keeping its own. The web fold hands `payout` the sets a match of the
// FIXTURE's own format is won on (`setsToWinOf(sportModule, fixtureCfg)`, engine-db/competition.ts) — a seam no engine
// test can see (AGENTS.md class 1), driven here through the REAL write path (`scoreEvent`) and the REAL standings read
// (`getStandings`). Each expected pair is the stage map's own entry at the rulebook's key (⌈bestOf/2⌉ - the sets the
// other side won), with every entry distinct, so the played score's key (1-1, 1-2, 1-0: no entry) and any other entry
// read differently.
import { afterAll, describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { getStandings } from "@/server/usecases/stages";
import { seedBracket } from "./helpers/seed-bracket";
import { fixtureRow, post } from "./helpers/w2b-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const volleyball = builtinModules.find((m) => m.key === "volleyball")!;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface StandingRow {
  entrantId: string;
  won: number;
  lost: number;
  points: number;
}
const standings = async (auth: AuthCtx, stageId: string) => (await getStandings(auth, stageId)).rows as StandingRow[];

/** An explicit map (no "*"), every pair its own: the win and loss it overrides pay -9, which no entry does. */
const rule = (bySetScore: Record<string, [number, number]>) => ({
  win: { regulation: -9 },
  loss: { regulation: -9 },
  bySetScore,
  shootoutAs: "result",
  unit: "whole",
  bonuses: [],
});
const MAPS: Record<string, Record<string, [number, number]>> = {
  indoor: { "3-0": [5, 0], "3-1": [4, 1], "3-2": [3, 2] },
  beach: { "2-0": [6, 0], "2-1": [5, 1] },
};

/** Each case: the variant, the sets each side took before the abandon (H first), and the settle naming home. */
const CASES = [
  { variant: "indoor", sets: ["H", "A"] },
  { variant: "indoor", sets: ["H", "A", "A"] },
  { variant: "beach", sets: ["H"] },
] as const;

describe.skipIf(!HAS_DB)("W2d I2 a settled abandon of a set match pays the stage map's FIVB 6.4.3 score through the web fold", () => {
  it("volleyball indoor 1-1 and 1-2, beach 1-0, settled for home by lot: the map's pair at ⌈bestOf/2⌉ - the other side's sets", async () => {
    let checked = 0;
    for (const c of CASES) {
      const s = await seedBracket({ sport: "volleyball", variant: c.variant, stageKind: "league", entrants: 2 });
      const map = MAPS[c.variant]!;
      // Raw SQL: the stage door is Task 10's; the fold reads whatever the stage stores.
      const n = await sql`update stages set config = config || ${sql.json({ points: rule(map) } as never)} where id = ${s.stageId}`;
      expect(n.count, "rig: the stage rule was written").toBe(1);
      const id = s.fixtureIds[0]!;
      const f = await fixtureRow(id);
      // The variant's own declarations: its set target and its best-of (indoor 25 / 5, beach 21 / 3).
      const cfg = volleyball.configSchema.parse(volleyball.variants[c.variant]) as { bestOf: number; setTo: number };
      await post(s.auth, id, "core.start");
      for (const w of c.sets) {
        const [won, lost] = [cfg.setTo, cfg.setTo - 5];
        await post(s.auth, id, "volleyball.set.summary", w === "H" ? { home: won, away: lost } : { home: lost, away: won });
      }
      await post(s.auth, id, "core.abandon", { reason: "weather" });
      expect((await fixtureRow(id)).status, `${c.variant} ${c.sets.join("")}: rig, the abandon decided nobody`).toBe("abandoned");
      await post(s.auth, id, "core.settle", { winner: f.home_entrant_id, method: "lot" });
      const row = await fixtureRow(id);
      expect([row.status, row.outcome], `${c.variant} ${c.sets.join("")}: rig, settled for home`).toEqual([
        "decided",
        expect.objectContaining({ kind: "win", winner: f.home_entrant_id, method: "settled_lot" }),
      ]);
      // The rulebook: a best-of-N match is won on ⌈N/2⌉ sets; home is completed to it, away keeps what it won.
      const bestOf = cfg.bestOf;
      const awaySets = c.sets.filter((x) => x === "A").length;
      const homeSets = c.sets.length - awaySets;
      expect(homeSets, "premise: the settle came before home had won").toBeLessThan(Math.ceil(bestOf / 2));
      const key = `${Math.ceil(bestOf / 2)}-${awaySets}`;
      const want = map[key];
      expect(want, `${c.variant}: the map names ${key}`).toBeDefined();
      expect(map[`${homeSets}-${awaySets}`], "premise: the played score has no entry of its own").toBeUndefined();
      const rows = await standings(s.auth, s.stageId);
      const home = rows.find((r) => r.entrantId === f.home_entrant_id)!;
      const away = rows.find((r) => r.entrantId === f.away_entrant_id)!;
      expect([home.points, away.points], `${c.variant} ${c.sets.join("")} → ${key}`).toEqual(want);
      expect([home.won, home.lost, away.won, away.lost], "a win and a loss on the table").toEqual([1, 0, 0, 1]);
      checked++;
    }
    expect(checked).toBe(CASES.length);
  });
});
