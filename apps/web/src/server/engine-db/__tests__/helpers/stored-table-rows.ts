// W2d T17 fix 1 (I3) — snapshot rows as the engine stores them, for the tests of the OTHER surfaces that print a stored
// table (the kiosk slideshow, the division share card, the news posts). Every row comes from the engine's own producers —
// the sport's table rule through `payout`, ranked by `completeTableStage` — and the stage's rules from the one loader's
// pure mapping (`unpinnedRulesDoc`), so a surface test reads exactly the rows and the rules production hands it.
import { MatchOutcome, type StandingsDelta } from "@seazn/engine/core";
import { completeTableStage, payout, type FixtureResult, type StandingsRow, type TableFixture } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { tableRulesOf } from "@seazn/engine/testkit";
import type { StageTableRulesDoc } from "@/server/engine-db/table-rules";
import { unpinnedRulesDoc } from "./table-rules-doc";

export const sportOf = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`premise: ${key} is a built-in sport`);
  return m;
};

const side = (entrantId: string, won: number, drawn: number, lost: number): StandingsDelta => ({
  entrantId, played: 1, won, drawn, lost, points: 0, metrics: { gf: won, ga: lost, gd: won - lost },
});

/** `home` beat `away`, or drew (`winner` null), paid by the stage's own rule. */
function result(id: string, home: string, away: string, winner: string | null, doc: StageTableRulesDoc): TableFixture {
  const pair: FixtureResult = winner === null
    ? [side(home, 0, 1, 0), side(away, 0, 1, 0)]
    : [side(home, winner === home ? 1 : 0, 0, winner === home ? 0 : 1), side(away, winner === away ? 1 : 0, 0, winner === away ? 0 : 1)];
  const outcome = winner === null
    ? MatchOutcome.parse({ kind: "draw" })
    : MatchOutcome.parse({ kind: "win", winner, loser: winner === home ? away : home });
  return { id, status: "decided", result: payout(outcome, winner === null ? null : "regulation", pair, true, doc.points, undefined, undefined) };
}

export interface StoredTable {
  readonly doc: StageTableRulesDoc;
  /** The ranked rows, as `standings_snapshots.rows` stores them (`rank`, `level`, `tieBreak` and all). */
  readonly rows: StandingsRow[];
}

const tableOf = (doc: StageTableRulesDoc, ids: readonly string[], fixtures: readonly TableFixture[]): StandingsRow[] => [
  ...completeTableStage({ id: "s", kind: "league", entrants: ids, rules: tableRulesOf(doc.tiebreakers, doc.points) } as never, fixtures)
    .tables.overall!,
];

/** A chess round robin (FIDE 1 / ½ / 0, stored in half-points): ids[0] beats ids[1], draws ids[2] and loses to ids[3] —
 *  1 + ½ + 0 = 1½ (stored 3); ids[1] 0, ids[2] ½ (stored 1), ids[3] 1 (stored 2). */
export function chessRoundRobin(ids: readonly [string, string, string, string]): StoredTable {
  const doc = unpinnedRulesDoc({ module: sportOf("boardgame"), divisionConfig: {} });
  const [a, b, c, d] = ids;
  return { doc, rows: tableOf(doc, ids, [result("g1", a, b, a, doc), result("g2", a, c, null, doc), result("g3", d, a, d, doc)]) };
}

/** A started football league with nothing counted yet: every row level (X-TB-6). */
export function levelLeague(ids: readonly string[]): StoredTable {
  const fb = sportOf("football");
  const doc = unpinnedRulesDoc({ module: fb, divisionConfig: fb.variants["11-a-side"] });
  return { doc, rows: tableOf(doc, ids, [{ id: "g1", status: "scheduled" }]) };
}
