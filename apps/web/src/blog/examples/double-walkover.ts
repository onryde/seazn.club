// Post #27, "What happens when neither side turns up?". For every sport in the registry, under the variant a new division
// starts on, one double walkover is recorded the way the console records it (`core.forfeit{by: "both", reason:
// "walkover"}`) and folded by the app's own read fold (`foldFrom`). The table's booking is the sport's `standingsDelta`
// over that outcome, paid by the web's one table-rules loader (`tableRulesOf`) and `payout`, the path every standings
// read takes. For comparison, the same sport's single walkover (forfeit-scores.ts's fold) is paid the same way.
//
// WHAT CHECKS IT. The claims hold the result to the engine's declaration of a double walkover (its `forfeitCredit` with `by: "both"`:
// nothing credited, every metric out of every ratio, X-DW-4) and to `advancesNobody` (a double walkover sends nobody on in
// a bracket), and witness that a double walkover is not "a loss each": where a played loss pays a point (table tennis),
// the double walkover still pays none.
import { advancesNobody, type MatchOutcome } from "@seazn/engine/core";
import { decidedInFor, payout, setsToWinOf } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { forEachSport } from "@seazn/engine/testkit";
import { sportLabel } from "@/blog/labels";
import { tableRulesOf } from "@/server/engine-db/table-rules";
import { forfeitFold, lineupsFor, scoreShown, startingCfg } from "./forfeit-scores";
import type { Claim, EngineExample, ExampleResult } from "./types";

export const DOUBLE_WALKOVER_ID = "double-walkover";

const C = { sport: 0, score: 1, points: 2, played: 3, lost: 4 } as const;

function leagueRules(module: AnySportModule, cfg: unknown) {
  return tableRulesOf(
    { stageId: `blog-example:${module.key}`, kind: "league", status: "pending", stageConfig: null, pin: null, pinnedAt: null, divisionConfig: cfg, divisionTiebreakers: null },
    module,
  );
}

function paid(module: AnySportModule, by: string) {
  const { cfg, outcome, headline, delta } = forfeitFold(module, by, "walkover");
  const pay = payout(outcome, decidedInFor(module, outcome), [delta[0]!, delta[1]!], true, leagueRules(module, cfg).points, module.awardScoreKeys, setsToWinOf(module, cfg));
  return { outcome, headline, delta, pay };
}

function build(): ExampleResult {
  const rows: (string | number)[][] = [];
  const facts: Record<string, string | number> = {};
  let nobodyAdvances = 0;
  const visited = forEachSport(({ module }) => {
    const both = paid(module, "both");
    if (advancesNobody(both.outcome)) nobodyAdvances++;
    const [h] = both.pay;
    rows.push([sportLabel(module.key), scoreShown(both.headline), h!.points, h!.played === 1 ? "Yes" : "No", h!.lost === 1 ? "Yes" : "No"]);
    facts[`${module.key}Points`] = h!.points;
  });
  // The comparison the post draws: a table tennis loss that was played earns a point; a double walkover earns none.
  const tt = builtinModules.find((m) => m.key === "tabletennis")!;
  const single = paid(tt, "ben");
  facts.tabletennisWalkoverLoss = single.pay.find((d) => d.lost === 1)?.points ?? -1;
  facts.sportCount = visited;
  facts.nobodyAdvancesIn = nobodyAdvances;
  return {
    facts,
    table: {
      caption: "A double walkover in each sport, on the settings a new division starts with: what each of the two sides gets in the table.",
      columns: ["Sport", "Score shown", "Points each side gets", "Counts as played", "Counts as a loss"],
      rows,
    },
    text: [],
  };
}

// ---- claims: the engine's declaration of a double walkover, and its bracket rule ----

function claimsFor(module: AnySportModule): Claim[] {
  const key = module.key;
  return [
    {
      says: `${key}: a double walkover credits each side nothing, so it scores no points and is out of every ratio`,
      source: `${key} forfeitCredit with by "both" (X-DW-4: nothing credited, every metric excluded)`,
      sport: key,
      check(r) {
        const row = r.table?.rows.find((x) => x[C.sport] === sportLabel(key));
        if (row === undefined) return "no row";
        // The sport's own declaration of a double walkover: forfeitCredit with `by: "both"`.
        const cfg = startingCfg(module);
        const credit = module.forfeitCredit(cfg as never, module.init(cfg as never, lineupsFor(module, cfg) as never), "walkover", "both");
        if (credit.perSide.some((side) => Object.values(side).some((v) => v !== 0))) return "the declaration now credits something";
        if (credit.excluded.length === 0) return "the declaration no longer keeps the match out of the ratios";
        if (row[C.points] !== 0 || r.facts[`${key}Points`] !== 0) return `pays ${String(row[C.points])}`;
        return (row[C.played] === "Yes" && row[C.lost] === "Yes") || `played ${String(row[C.played])}, lost ${String(row[C.lost])}`;
      },
    },
  ];
}

const claims: Claim[] = [
  {
    says: "the table holds every sport of the registry, in order, and a double walkover sends nobody on in every one of them",
    source: "the sport registry (forEachSport) and the engine's advancesNobody (a double walkover advances nobody)",
    check(r) {
      const labels: string[] = [];
      const visited = forEachSport(({ module }) => labels.push(sportLabel(module.key)));
      if (r.facts.sportCount !== visited || r.facts.nobodyAdvancesIn !== visited) return "counts differ from the registry";
      if (!advancesNobody({ kind: "double_walkover" } as MatchOutcome)) return "the engine now advances someone";
      return JSON.stringify((r.table?.rows ?? []).map((x) => x[C.sport])) === JSON.stringify(labels) || "rows differ from the registry";
    },
  },
  {
    says: "a double walkover is not a loss each: in table tennis a single walkover's loser still scores nothing, and a played loss scores a point, yet a double walkover scores none",
    source: "class 19 witness: table tennis pays a played loss (ITTF) more than nothing; the double walkover pays 0 (forfeitCredit by both)",
    check(r) {
      const tt = builtinModules.find((m) => m.key === "tabletennis")!;
      const playedLoss = leagueRules(tt, startingCfg(tt)).points.loss.regulation;
      if (!(playedLoss > 0)) return "anti-vacuity: a table tennis played loss must pay something for this witness";
      return (r.facts.tabletennisPoints === 0 && r.facts.tabletennisWalkoverLoss === 0) || "table tennis pays a double walkover or a walkover loss";
    },
  },
];
forEachSport(({ module }) => {
  claims.push(...claimsFor(module));
});

export const doubleWalkover: EngineExample = {
  id: DOUBLE_WALKOVER_ID,
  kind: "engine",
  sports: "all",
  build,
  claims,
};
