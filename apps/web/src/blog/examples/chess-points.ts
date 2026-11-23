// Post #4, "Why does a chess win count as 1 and a draw as half a point?". Chess only (the reason is on the export below).
// A chess league pays by the sport's own points rule, which the stage's Points section can swap for the other preset the
// sport offers. The two players here have the same seven games to show for themselves, one with three wins and four
// losses and the other with seven draws, and the table puts a different one first under each preset.
//
// WHICH MATCHES: a real chess win and a real chess draw, each played to the end through the engine's own event stream
// (kit.ts) and paid under each preset the sport offers a league stage: the points come from `payout` under the stage's
// own rule, read through the web's one table-rules loader. A loss is the loser of the win.
//
// WHAT CHECKS IT. The claims recompute every cell and fact from the module's own declarations (`tablePresets` for the
// league and the Swiss stage, and the points each preset declares), in code that shares no formatter with `build()`.
import { pointsText } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { declaredCfgs, forEachSport } from "@seazn/engine/testkit";
import { sportLabel } from "@/blog/labels";
import { NAMES, moduleOf, play, sentenceList, type Cfg, type Played, declaredLeaguePoints, startingCfg } from "./kit";
import { startingVariantKey } from "./starting-variant";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const CHESS_POINTS_ID = "chess-points";

const COLUMNS = ["Player", "Their seven games", "Points under 1 / ½ / 0", "Points under 3 / 1 / 0"];
const C = { player: 0, games: 1, half: 2, three: 3 } as const;

/** The records the two players bring: Ana wins three and loses four, Ben draws all seven. */
const ANA = { wins: 3, losses: 4 };
const BEN = { draws: 7 };
const PLAYERS = [
  { name: NAMES.ana!, games: `${ANA.wins} wins, ${ANA.losses} losses` },
  { name: NAMES.ben!, games: `${BEN.draws} draws` },
];

const chess = (): AnySportModule => moduleOf("boardgame");

/** The two presets a chess league stage offers, by the engine's own ids, in the order it lists them. */
const HALF_ID = "fide_1_half_0";
const THREE_ID = "three_one_zero";

function presetRule(m: AnySportModule, stageKind: "league" | "swiss", id: string): unknown {
  const hit = m.tablePresets?.(stageKind)?.points.find((p) => p.id === id);
  if (hit === undefined) throw new Error(`chess-points: the ${stageKind} stage offers no '${id}' preset`);
  return hit.rule;
}

interface PerResult {
  win: number;
  draw: number;
  loss: number;
  unit: "half" | "whole";
}

/** What a played win, draw and loss are paid under one preset (the stage's own points rule), by real matches. */
function paidUnder(m: AnySportModule, cfg: Cfg, variantKey: string, points: unknown): PerResult {
  const opts = { points, variantKey };
  const win = play(m, cfg, `${variantKey} win`, ["ana", "ben"], (o) => o.kind === "win" && o.winner === "ana", opts);
  const draw = play(m, cfg, `${variantKey} draw`, ["cy", "dev"], (o) => o.kind === "draw", opts);
  const [w, l] = splitWin(win);
  const [a, b] = draw.paid;
  if (a.points !== b.points) throw new Error(`chess-points: a draw paid ${a.points} and ${b.points}`);
  return { win: w, draw: a.points, loss: l, unit: (points as { unit: "half" | "whole" }).unit };
}
const splitWin = (p: Played): [number, number] => {
  const o = p.outcome;
  if (o.kind !== "win") throw new Error("chess-points: a win is needed");
  const w = p.paid.find((x) => x.entrantId === o.winner)!;
  const l = p.paid.find((x) => x.entrantId === o.loser)!;
  return [w.points, l.points];
};

const total = (r: { win: number; draw: number; loss: number }, rec: { wins?: number; losses?: number; draws?: number }): number =>
  (rec.wins ?? 0) * r.win + (rec.losses ?? 0) * r.loss + (rec.draws ?? 0) * r.draw;

const leader = (ana: number, ben: number): string => (ana === ben ? "Level" : ana > ben ? NAMES.ana! : NAMES.ben!);

function build(): ExampleResult {
  const m = chess();
  const variantKey = startingVariantKey(m);
  const cfg = startingCfg(m) as Cfg;
  const half = paidUnder(m, cfg, variantKey, presetRule(m, "league", HALF_ID));
  const three = paidUnder(m, cfg, variantKey, presetRule(m, "league", THREE_ID));
  const anaHalf = total(half, ANA);
  const benHalf = total(half, BEN);
  const anaThree = total(three, ANA);
  const benThree = total(three, BEN);
  const f = (n: number, unit: "half" | "whole") => pointsText(n, unit);
  const rows: (string | number)[][] = [
    [PLAYERS[0]!.name, PLAYERS[0]!.games, f(anaHalf, half.unit), f(anaThree, three.unit)],
    [PLAYERS[1]!.name, PLAYERS[1]!.games, f(benHalf, half.unit), f(benThree, three.unit)],
  ];
  const halfUnit: string[] = [];
  const wholeUnit: string[] = [];
  const visited = forEachSport(({ module }) => {
    if (declaredCfgs(module).some((c) => declaredLeaguePoints(module, c.cfg).unit === "half")) halfUnit.push(sportLabel(module.key));
    else wholeUnit.push(sportLabel(module.key));
  });
  const facts: ExampleResult["facts"] = {
    halfWin: f(half.win, half.unit),
    halfDraw: f(half.draw, half.unit),
    halfLoss: f(half.loss, half.unit),
    threeWin: f(three.win, three.unit),
    threeDraw: f(three.draw, three.unit),
    threeLoss: f(three.loss, three.unit),
    anaHalf: f(anaHalf, half.unit),
    benHalf: f(benHalf, half.unit),
    anaThree: f(anaThree, three.unit),
    benThree: f(benThree, three.unit),
    halfLeader: leader(anaHalf, benHalf),
    threeLeader: leader(anaThree, benThree),
    leaguePresets: m.tablePresets?.("league").points.length ?? 0,
    swissPresets: m.tablePresets?.("swiss").points.length ?? 0,
    sportCount: visited,
    halfPointSports: halfUnit.length,
    wholePointSports: wholeUnit.length,
    wholePointSportsList: sentenceList(wholeUnit),
  };
  return {
    facts,
    table: { caption: "The same seven games each, counted two ways: one player with three wins and four losses, one with seven draws.", columns: COLUMNS, rows },
    text: [
      "Two players have seven games each: Ana won three and lost four, Ben drew all seven. Each result is a real chess game, played to the end and paid under each of the two points rules a chess league offers.",
      `Under the first rule a win is ${facts.halfWin}, a draw is ${facts.halfDraw} and a loss is ${facts.halfLoss}; under the second a win is ${facts.threeWin}, a draw is ${facts.threeDraw} and a loss is ${facts.threeLoss}.`,
      `${NAMES.ana} has ${facts.anaHalf} and ${NAMES.ben} has ${facts.benHalf} under the first rule, ${facts.anaThree} and ${facts.benThree} under the second.`,
    ],
  };
}

// ---- claims: every expected value below is recomputed from the sport module's own declarations ----

const DECLARED = "the presets the chess module declares for a league stage (tablePresets('league'))";

interface DeclaredRule {
  win: { regulation: number };
  loss: { regulation: number };
  draw: number;
  unit: "half" | "whole";
}
const declared = (m: AnySportModule, id: string): DeclaredRule => presetRule(m, "league", id) as DeclaredRule;

function claimsFor(m: AnySportModule): Claim[] {
  const mine = (says: string, source: string, check: Claim["check"]): Claim => ({ says: `Chess: ${says}`, source, sport: "boardgame", check });
  const h = declared(m, HALF_ID);
  const t = declared(m, THREE_ID);
  const pt = (n: number, u: "half" | "whole") => pointsText(n, u);
  const exp = (r: DeclaredRule, rec: { wins?: number; losses?: number; draws?: number }) =>
    (rec.wins ?? 0) * r.win.regulation + (rec.losses ?? 0) * r.loss.regulation + (rec.draws ?? 0) * r.draw;
  const rowOf = (r: ExampleResult, name: string) => (r.table?.rows ?? []).find((x) => x[C.player] === name);
  return [
    mine("each result pays what the preset declares: a win, a draw and a loss, under both rules, as the post cites them", DECLARED, (r) => {
      const want: Record<string, string> = {
        halfWin: pt(h.win.regulation, h.unit),
        halfDraw: pt(h.draw, h.unit),
        halfLoss: pt(h.loss.regulation, h.unit),
        threeWin: pt(t.win.regulation, t.unit),
        threeDraw: pt(t.draw, t.unit),
        threeLoss: pt(t.loss.regulation, t.unit),
      };
      for (const [k, v] of Object.entries(want)) if (r.facts[k] !== v) return `fact ${k} is ${String(r.facts[k])}, the declaration gives ${v}`;
      return true;
    }),
    mine("the two players' totals, in the table and in the facts, are their records paid by each declared rule, Ana's row first", DECLARED, (r) => {
      const order = (r.table?.rows ?? []).map((x) => String(x[C.player]));
      if (JSON.stringify(order) !== JSON.stringify([NAMES.ana, NAMES.ben])) return `the rows read [${order.join(", ")}], expected [${NAMES.ana}, ${NAMES.ben}]`;
      const rows = [
        { name: NAMES.ana!, games: `${ANA.wins} wins, ${ANA.losses} losses`, h: exp(h, ANA), t: exp(t, ANA), fh: "anaHalf", ft: "anaThree" },
        { name: NAMES.ben!, games: `${BEN.draws} draws`, h: exp(h, BEN), t: exp(t, BEN), fh: "benHalf", ft: "benThree" },
      ];
      for (const e of rows) {
        const row = rowOf(r, e.name);
        if (row === undefined) return `no row for ${e.name}`;
        if (row[C.games] !== e.games) return `${e.name}'s record reads '${String(row[C.games])}', expected '${e.games}'`;
        if (row[C.half] !== pt(e.h, h.unit) || row[C.three] !== pt(e.t, t.unit)) return `${e.name}: ${String(row[C.half])} and ${String(row[C.three])}, the declarations give ${pt(e.h, h.unit)} and ${pt(e.t, t.unit)}`;
        if (r.facts[e.fh] !== pt(e.h, h.unit) || r.facts[e.ft] !== pt(e.t, t.unit)) return `${e.name}'s facts disagree with the declarations`;
      }
      return true;
    }),
    mine("the two rules put DIFFERENT players first: Ben leads under 1 / ½ / 0 and Ana under 3 / 1 / 0, and a draw is worth a different share of a win", `${DECLARED}, ordered by the totals`, (r) => {
      const aH = exp(h, ANA);
      const bH = exp(h, BEN);
      const aT = exp(t, ANA);
      const bT = exp(t, BEN);
      // The case is built to differ: if the declarations ever make both rules agree, this example no longer shows a flip.
      if (!(bH > aH && aT > bT)) return `the declarations no longer flip the order: ${aH}/${bH} and ${aT}/${bT}`;
      if (h.draw * t.win.regulation === t.draw * h.win.regulation) return "a draw is the same share of a win under both rules";
      return r.facts.halfLeader === NAMES.ben && r.facts.threeLeader === NAMES.ana || `leaders are ${String(r.facts.halfLeader)} and ${String(r.facts.threeLeader)}`;
    }),
    mine("the half-point preset is offered in a league and in a Swiss stage; the 3 / 1 / 0 preset in a league only", "tablePresets of each stage kind", (r) => {
      const ids = (k: "league" | "swiss") => (m.tablePresets?.(k)?.points ?? []).map((p) => p.id);
      if (JSON.stringify(ids("league")) !== JSON.stringify([HALF_ID, THREE_ID])) return `league offers [${ids("league").join(", ")}]`;
      if (JSON.stringify(ids("swiss")) !== JSON.stringify([HALF_ID])) return `swiss offers [${ids("swiss").join(", ")}]`;
      return (r.facts.leaguePresets === 2 && r.facts.swissPresets === 1) || `facts say ${String(r.facts.leaguePresets)} and ${String(r.facts.swissPresets)}`;
    }),
  ];
}

function acrossSports(): Claim[] {
  return [
    {
      says: "chess is the only sport whose league counts in half points, counted over the whole registry",
      source: "the unit of every sport's league points rule, in every declared config",
      check(result) {
        const have: string[] = [];
        const visited = forEachSport(({ module }) => {
          if (declaredCfgs(module).some((c) => declaredLeaguePoints(module, c.cfg).unit === "half")) have.push(module.key);
        });
        if (result.facts.sportCount !== visited) return `sportCount is ${String(result.facts.sportCount)}, the registry has ${visited}`;
        if (JSON.stringify(have) !== JSON.stringify(["boardgame"])) return `sports that count in half points: [${have.join(", ")}]`;
        // The post names the OTHER sports from this sweep too: every registry sport that does not count in half points.
        const others = builtinModules.filter((m) => !have.includes(m.key)).map((m) => sportLabel(m.key));
        if (others.length === 0) return "no sport was left that counts whole points";
        if (result.facts.wholePointSports !== others.length || result.facts.wholePointSportsList !== sentenceList(others)) {
          return `wholePointSportsList is '${String(result.facts.wholePointSportsList)}' (${String(result.facts.wholePointSports)}), the registry leaves ${others.length}: '${sentenceList(others)}'`;
        }
        return result.facts.halfPointSports === have.length || `halfPointSports is ${String(result.facts.halfPointSports)}, expected ${have.length}`;
      },
    },
  ];
}

const claims: Claim[] = [...acrossSports(), ...claimsFor(chess())];

export const chessPoints: BlogExample = {
  id: CHESS_POINTS_ID,
  kind: "engine",
  sports: ["boardgame"],
  singleSportReason: "chess only: it is the one sport whose league counts in half points and offers a second points preset on a round robin (the sweep in the claims counts the registry)",
  build,
  claims,
};
