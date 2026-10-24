// W2d Task 2 — the web fold hands `payout` how each match was decided (`decidedInFor(sportModule, outcome)`,
// engine-db/competition.ts). Driven through the REAL write path (`scoreEvent`) and the REAL standings read
// (`getStandings`): a seam a unit test cannot see (AGENTS.md class 1). The expected points are the stage rule's own
// declaration, and each one differs from the regulation pair, so a fold that dropped `decidedIn` (paying every win
// as regulation) and the rule-less twin (the module's own IIHF 3-2-1-0) both read differently.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { getStandings } from "@/server/usecases/stages";
import { seedBracket } from "./helpers/seed-bracket";
import { fixtureRow, post } from "./helpers/w2b-rig";

const HAS_DB = !!process.env.DATABASE_URL;

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
  metrics?: Record<string, number>;
}
const standings = async (auth: AuthCtx, stageId: string) => (await getStandings(auth, stageId)).rows as StandingRow[];

/** Every decided-in value its own amount, none equal to the regulation pair or to the IIHF table's 2/1. */
const RULE = {
  win: { regulation: 3, ot: 6, so: 9 },
  loss: { regulation: 0, ot: 4, so: 7 },
  draw: 1,
  shootoutAs: "result",
  unit: "whole",
  bonuses: [],
} as const;

type Ev = { type: string; payload?: Record<string, unknown> };
/** Ice hockey under the iihf variant (overtime then a shoot-out). `H` is the home side, `A` the away side. The shoot-out
 *  stream is the golden corpus's recorded `default` seed 80 (H wins on the 11th round), its misconduct dropped. */
const SCRIPTS: { name: string; method: string; decidedIn: "ot" | "so"; events: Ev[] }[] = [
  {
    name: "an overtime goal",
    method: "extra_time",
    decidedIn: "ot",
    events: [
      { type: "core.start" },
      { type: "icehockey.period.advance", payload: { to: "P2" } },
      { type: "icehockey.period.advance", payload: { to: "P3" } },
      { type: "icehockey.period.advance", payload: { to: "FT" } },
      { type: "icehockey.goal", payload: { by: "H" } },
    ],
  },
  {
    name: "a shoot-out",
    method: "shootout",
    decidedIn: "so",
    events: [
      { type: "core.start" },
      { type: "icehockey.period.advance", payload: { to: "P2" } },
      { type: "icehockey.period.advance", payload: { to: "P3" } },
      { type: "icehockey.period.advance", payload: { to: "FT" } },
      { type: "icehockey.period.advance", payload: { to: "FT" } },
      ...Array.from({ length: 10 }, (_, i): Ev => ({ type: "icehockey.shootout.attempt", payload: { by: i % 2 === 0 ? "H" : "A", scored: true } })),
      { type: "icehockey.shootout.attempt", payload: { by: "H", scored: true } },
      { type: "icehockey.shootout.attempt", payload: { by: "A", scored: false } },
    ],
  },
];

describe.skipIf(!HAS_DB)("W2d payout through the web fold: how a match was decided reaches the stage rule", () => {
  it("an ice hockey OT win and a shoot-out win pay the rule's win.ot/loss.ot and win.so/loss.so, with won_<d>/lost_<d> on the rows", async () => {
    // single-sport: ice hockey is the sport whose rule splits all three of regulation/ot/so (IIHF 3-2-1-0) and whose
    // corpus holds a roster-free shoot-out stream; payout's own decided-in sweep over every sport's corpus lives in the
    // engine (points-w2d.test.ts). This test proves only the web fold's wiring of `decidedIn`.
    let checked = 0;
    for (const script of SCRIPTS) {
      const play = async (rule: boolean) => {
        const s = await seedBracket({ sport: "icehockey", variant: "iihf", stageKind: "league", entrants: 2 });
        if (rule) {
          // Raw SQL: the W2c door still refuses a split rule on a division that scores overtime apart
          // (`pointsRuleExpressible`, lifted later in W2d); the fold reads whatever the stage stores.
          const n = await sql`update stages set config = config || ${sql.json({ points: RULE } as never)} where id = ${s.stageId}`;
          expect(n.count, "rig: the stage rule was written").toBe(1);
        }
        const id = s.fixtureIds[0]!;
        const f = await fixtureRow(id);
        const side = (v: unknown) => (v === "H" ? f.home_entrant_id : v === "A" ? f.away_entrant_id : v);
        for (const e of script.events) {
          const payload = Object.fromEntries(Object.entries(e.payload ?? {}).map(([k, v]) => [k, k === "by" ? side(v) : v]));
          await post(s.auth, id, e.type, payload);
        }
        const row = await fixtureRow(id);
        expect([row.status, row.outcome], `${script.name}: rig, the stream decided the fixture for home`).toEqual([
          "decided",
          expect.objectContaining({ kind: "win", winner: f.home_entrant_id, method: script.method }),
        ]);
        const rows = await standings(s.auth, s.stageId);
        return { home: rows.find((r) => r.entrantId === f.home_entrant_id)!, away: rows.find((r) => r.entrantId === f.away_entrant_id)! };
      };
      const t = await play(true);
      const d = script.decidedIn;
      expect([t.home.points, t.away.points], `${script.name}: the rule's ${d} pair`).toEqual([RULE.win[d], RULE.loss[d]]);
      expect([t.home.points, t.away.points], `${script.name}: not the regulation pair`).not.toEqual([RULE.win.regulation, RULE.loss.regulation]);
      expect([t.home.won, t.home.lost, t.away.won, t.away.lost], `${script.name}: a win and a loss on the table`).toEqual([1, 0, 0, 1]);
      expect([t.home.metrics?.[`won_${d}`], t.away.metrics?.[`lost_${d}`]], `${script.name}: the display fold`).toEqual([1, 1]);
      const twin = await play(false);
      expect([twin.home.points, twin.away.points], `${script.name}: premise, the rule-less table pays differently`).not.toEqual([
        RULE.win[d],
        RULE.loss[d],
      ]);
      checked++;
    }
    expect(checked).toBe(SCRIPTS.length);
  });
});
