// Post #6, "Why does a table tennis loss still score a point?". Table tennis (the reason is on the export below), with a
// sweep of the registry for the sports whose league pays something for a loss played in regulation.
//
// WHICH MATCHES: Ana beats Ben at each set score the starting format can end on (real matches, played to the end through
// the engine's own event stream: kit.ts), and Ana beats Ben because Ben forfeits before a point is played (a real ledger
// with a start and a forfeit and no play). Each is paid by the rules the standings read (the web's one table-rules loader,
// then `payout`), the forfeit with the "was anything played" fact read from its own ledger, as the standings read it.
//
// WHAT CHECKS IT. The claims recompute every cell and fact from the module's own declarations (its league points rule: the
// win, the loss, the loss with nothing played) in code that shares no formatter with `build()`.
import { forfeitShaped, pointsText } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { forEachSport } from "@seazn/engine/testkit";
import { sportLabel, variantLabel } from "@/blog/labels";
import { NAMES, joinOr, moduleOf, play, sentenceList, variantsOf, winnerLoserPoints, winnerSetScore, type Cfg, declaredLeaguePoints, joinAnd } from "./kit";
import { startingVariantKey } from "./starting-variant";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const TABLE_TENNIS_LOSS_ID = "table-tennis-loss";

const COLUMNS = ["How the match ended", "Winner gets", "Loser gets"];
const C = { how: 0, winner: 1, loser: 2 } as const;
const FORFEIT_ROW = "A forfeit before a point is played";

const tableTennis = (): AnySportModule => moduleOf("tabletennis");
const howPlayed = (score: string): string => `Played, won ${score}`;

/** What the loser of a played match, and of a forfeit with nothing played, are paid under a rule: the declared numbers. */
interface Declared {
  win: number;
  playedLoss: number;
  unplayedLoss: number;
}
function declaredFor(m: AnySportModule, cfg: Cfg): Declared {
  const rule = declaredLeaguePoints(m, cfg);
  const unplayed = rule.loss.unplayed;
  if (unplayed === undefined) throw new Error("table-tennis-loss: the rule declares no loss with nothing played");
  return { win: rule.win.regulation, playedLoss: rule.loss.regulation, unplayedLoss: unplayed };
}

function build(): ExampleResult {
  const m = tableTennis();
  const variantKey = startingVariantKey(m);
  const variant = variantsOf(m).find((v) => v.key === variantKey);
  if (variant === undefined) throw new Error(`table-tennis-loss: '${variantKey}' is not a declared variant`);
  const cfg = variant.cfg;
  const scores = m.reachableSetScores?.(cfg as never);
  if (scores === undefined || scores.length === 0) throw new Error("table-tennis-loss: the format declares no set scores");
  const f = (n: number) => pointsText(n, "whole");
  const rows: (string | number)[][] = [];
  const text: string[] = ["Ana beats Ben at each set score the format can end on, and again when Ben forfeits before a point is played. Each is a real match, paid by the table's rule."];
  const facts: ExampleResult["facts"] = {};
  for (const score of scores) {
    const p = play(m, cfg, `${variantKey} win ${score}`, ["ana", "ben"], (o, pair) => o.kind === "win" && o.winner === "ana" && winnerSetScore(pair) === score, { variantKey });
    const [w, l] = winnerLoserPoints(p);
    rows.push([howPlayed(score), f(w), f(l)]);
    facts[`won${score.replace("-", "")}Score`] = score;
    facts[`won${score.replace("-", "")}Winner`] = f(w);
    facts[`won${score.replace("-", "")}Loser`] = f(l);
    text.push(`${howPlayed(score)}: ${NAMES.ana} beat ${NAMES.ben} ${p.headline}.`);
  }
  facts.winScores = joinOr([...scores]);
  const forfeit = play(
    m,
    cfg,
    `${variantKey} forfeit with nothing played`,
    ["ana", "ben"],
    (o, _pair, played) => o.kind === "award" && o.winner === "ana" && forfeitShaped(o) && !played,
    { variantKey, allowForfeit: true },
  );
  const [fw, fl] = winnerLoserPoints(forfeit);
  rows.push([FORFEIT_ROW, f(fw), f(fl)]);
  facts.forfeitWinner = f(fw);
  facts.forfeitLoser = f(fl);
  text.push(`${FORFEIT_ROW}: ${NAMES.ben} forfeited, ${forfeit.headline}.`);

  const everyLoss: string[] = [];
  const someLossPaysNothing: string[] = [];
  const declaresUnplayed: string[] = [];
  const visited = forEachSport(({ module }) => {
    let every = true;
    let unplayed = false;
    for (const v of variantsOf(module)) {
      const rule = declaredLeaguePoints(module, v.cfg);
      const scores: readonly (string | null)[] = module.reachableSetScores?.(v.cfg as never) ?? [null];
      for (const score of scores) {
        const hit = rule.bySetScore !== undefined && score !== null ? (rule.bySetScore[score] ?? rule.bySetScore["*"]) : undefined;
        if ((hit === undefined ? rule.loss.regulation : hit[1]) <= 0) every = false;
      }
      if (rule.loss.unplayed !== undefined) unplayed = true;
    }
    if (every) everyLoss.push(sportLabel(module.key));
    else someLossPaysNothing.push(sportLabel(module.key));
    if (unplayed) declaresUnplayed.push(sportLabel(module.key));
  });
  facts.sportCount = visited;
  facts.sportsEveryLossPays = everyLoss.length;
  facts.everyLossPaysList = joinAnd(everyLoss);
  facts.sportsSomeLossPaysNothing = someLossPaysNothing.length;
  facts.someLossPaysNothingList = sentenceList(someLossPaysNothing);
  facts.sportsDecidingUnplayed = declaresUnplayed.length;
  facts.variantCount = variantsOf(m).length;
  facts.variantsList = joinAnd(variantsOf(m).map((v) => variantLabel(m.key, v.key)));
  return {
    facts,
    table: { caption: "What each side gets for a table tennis match: played at any score, or forfeited before a point is played.", columns: COLUMNS, rows },
    text,
  };
}

// ---- claims: every expected value below is recomputed from the sport module's own declarations ----

const DECLARED = "the table tennis league points rule (win.regulation, loss.regulation, loss.unplayed)";

function claimsFor(m: AnySportModule): Claim[] {
  const mine = (says: string, source: string, check: Claim["check"]): Claim => ({ says: `Table tennis: ${says}`, source, sport: "tabletennis", check });
  const variantKey = startingVariantKey(m);
  const cfg = variantsOf(m).find((v) => v.key === variantKey)!.cfg;
  const d = declaredFor(m, cfg);
  const f = (n: number) => pointsText(n, "whole");
  const rowOf = (r: ExampleResult, how: string) => (r.table?.rows ?? []).find((x) => x[C.how] === how);
  return [
    mine("every set score the format can end on has a row, in order, then the forfeit row", "reachableSetScores(cfg) of the starting format", (r) => {
      const scores = m.reachableSetScores?.(cfg as never) ?? [];
      const want = [...scores.map(howPlayed), FORFEIT_ROW];
      const got = (r.table?.rows ?? []).map((x) => String(x[C.how]));
      if (scores.length < 2 || JSON.stringify(got) !== JSON.stringify(want)) return `rows are [${got.join("; ")}], expected [${want.join("; ")}]`;
      // The post names the scores the format can end on, by fact: each score, and the list of them.
      for (const s of scores) if (r.facts[`won${s.replace("-", "")}Score`] !== s) return `the fact for ${s} is '${String(r.facts[`won${s.replace("-", "")}Score`])}'`;
      return r.facts.winScores === joinOr([...scores]) || `winScores is '${String(r.facts.winScores)}', the format ends on ${joinOr([...scores])}`;
    }),
    mine("a played match pays the winner the win and the loser the declared loss, at every score", DECLARED, (r) => {
      const scores = m.reachableSetScores?.(cfg as never) ?? [];
      let checked = 0;
      for (const s of scores) {
        const row = rowOf(r, howPlayed(s));
        if (row === undefined) return `no row for ${s}`;
        if (row[C.winner] !== f(d.win) || row[C.loser] !== f(d.playedLoss)) return `${s}: ${String(row[C.winner])} and ${String(row[C.loser])}, the declaration gives ${f(d.win)} and ${f(d.playedLoss)}`;
        const k = `won${s.replace("-", "")}`;
        if (r.facts[`${k}Winner`] !== f(d.win) || r.facts[`${k}Loser`] !== f(d.playedLoss)) return `facts for ${s} disagree with the declaration`;
        checked++;
      }
      return checked >= 2 || `only ${checked} score rows were checked`;
    }),
    mine("a forfeit with nothing played pays the loser the declared unplayed loss, which DIFFERS from a played loss", DECLARED, (r) => {
      if (d.unplayedLoss === d.playedLoss) return "the declaration pays a played and an unplayed loss the same: the example no longer shows a difference";
      const row = rowOf(r, FORFEIT_ROW);
      if (row === undefined) return "no forfeit row";
      if (row[C.winner] !== f(d.win) || row[C.loser] !== f(d.unplayedLoss)) return `the forfeit row pays ${String(row[C.winner])} and ${String(row[C.loser])}, the declaration gives ${f(d.win)} and ${f(d.unplayedLoss)}`;
      return r.facts.forfeitWinner === f(d.win) && r.facts.forfeitLoser === f(d.unplayedLoss) || "the forfeit facts disagree with the declaration";
    }),
    mine("every declared format pays the same, so the starting format stands for all of them, and the post names exactly those formats", "the points rule of every declared variant", (r) => {
      const vs = variantsOf(m);
      const base = JSON.stringify(declaredFor(m, cfg));
      for (const v of vs) if (JSON.stringify(declaredFor(m, v.cfg)) !== base) return `${v.key} pays differently from ${variantKey}`;
      if (vs.length < 2) return `only ${vs.length} variants`;
      return (r.facts.variantCount === vs.length && r.facts.variantsList === joinAnd(vs.map((v) => variantLabel(m.key, v.key)))) || "the variant facts disagree with the declarations";
    }),
  ];
}

function acrossSports(): Claim[] {
  return [
    {
      says: "table tennis is the only sport where EVERY played loss pays the loser something, whatever the score, and the only one that pays a lesser loss when nothing was played",
      source: "the loser's points of every reachable set score (bySetScore, else loss.regulation) and loss.unplayed, in every declared variant of every sport",
      check(result) {
        const every: string[] = [];
        const unplayed: string[] = [];
        let scoresChecked = 0;
        const visited = forEachSport(({ module }) => {
          let all = true;
          let u = false;
          for (const v of variantsOf(module)) {
            const rule = declaredLeaguePoints(module, v.cfg);
            for (const score of module.reachableSetScores?.(v.cfg as never) ?? [null]) {
              scoresChecked++;
              const pair = rule.bySetScore !== undefined && score !== null ? (rule.bySetScore[score] ?? rule.bySetScore["*"]) : undefined;
              const loser = pair === undefined ? rule.loss.regulation : pair[1];
              if (loser <= 0) all = false;
            }
            if (rule.loss.unplayed !== undefined) u = true;
          }
          if (all) every.push(sportLabel(module.key));
          if (u) unplayed.push(sportLabel(module.key));
        });
        const f = result.facts;
        if (scoresChecked < visited) return `only ${scoresChecked} scores were checked over ${visited} sports`;
        if (f.sportCount !== visited) return `sportCount is ${String(f.sportCount)}, the registry has ${visited}`;
        if (f.sportsEveryLossPays !== every.length || f.everyLossPaysList !== joinAnd(every)) return `everyLossPays: ${String(f.sportsEveryLossPays)} '${String(f.everyLossPaysList)}', the declarations give ${every.length} '${joinAnd(every)}'`;
        const others = builtinModules.filter((x) => !every.includes(sportLabel(x.key))).map((x) => sportLabel(x.key));
        if (others.length === 0) return "no sport was left with a loss that earns nothing";
        if (f.sportsSomeLossPaysNothing !== others.length || f.someLossPaysNothingList !== sentenceList(others)) return `someLossPaysNothingList is '${String(f.someLossPaysNothingList)}' (${String(f.sportsSomeLossPaysNothing)}), the declarations leave ${others.length}: '${sentenceList(others)}'`;
        if (f.sportsDecidingUnplayed !== unplayed.length) return `sportsDecidingUnplayed is ${String(f.sportsDecidingUnplayed)}, the declarations give ${unplayed.length}`;
        if (JSON.stringify(every) !== JSON.stringify([sportLabel("tabletennis")])) return `sports where every played loss pays: [${every.join(", ")}]`;
        return JSON.stringify(unplayed) === JSON.stringify([sportLabel("tabletennis")]) || `sports that pay a lesser loss for nothing played: [${unplayed.join(", ")}]`;
      },
    },
  ];
}

const claims: Claim[] = [...acrossSports(), ...claimsFor(tableTennis())];

export const tableTennisLoss: BlogExample = {
  id: TABLE_TENNIS_LOSS_ID,
  kind: "engine",
  sports: ["tabletennis"],
  singleSportReason: "table tennis only: it is the one sport whose league pays a loss in regulation and pays a lesser loss when nothing was played (the sweep in the claims counts the registry)",
  build,
  claims,
};
