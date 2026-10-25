// W2d Task 11 (spec §13.1, §5.10; D5, D10, B2, B4, OC1; rule rows FB-TB-1..4, HK-TB-1/2, HK-PT-2, IH-TB-1, BG-TB-1/2,
// CK-TB-1, CK-PT-1, VB-TB-1, VB-PT-2, BD-TB-1, TT-TB-1, TT-PT-1, TN-TB-1/2, CA-TB-1, GN-TB-1) — the rulebook scenarios.
//
// One describe per registry sport. Every case is a table typed from the federation text its title cites: the matches,
// the table points each one pays (typed from the rule, then checked against what the sport's own points rule pays through
// the real `payout` — the seam), the order the rule gives, and the key that settles each row. The sport's DEFAULT order
// is what ranks it, through the one resolver (`resolveTableRules`) and `completeTableStage`, exactly as a stage with no
// order of its own ranks. Nothing is read back from the ranker to make an expected value.
//
// Coverage is part of the book, not a habit: each sport's describe ends with a test that every position of its default
// order is DECIDED by some case (the row's recorded key, or for a repeated key and a modifier, the case that removes that
// position and gets the typed other answer), and that at least one case orders differently under the sport's PRE-W2d
// order — the "wrong one's constant", typed below from the plan's Anchors row (main@e97823e4d8 `defaultTiebreakers`).
// Where the pre-W2d order IS the signed one (football with fair play on, carrom, generic) the test says so, by name.
import { describe, expect, it } from "vitest";
import { foldMatch } from "../core/events.ts";
import type { EntrantId, MatchOutcome, StandingsDelta } from "../core/types.ts";
import type { AnySportModule, TiebreakerKey } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/helpers.ts";
import { decidedInFor } from "./decided-in.ts";
import { legacyPointsRule, payout, PointsRule, setsToWinOf } from "./points.ts";
import { completeTableStage, type TableFixture } from "./stage.ts";
import type { FixtureResult, StandingsRow } from "./standings.ts";
import { resolveTableRules, type TableRules } from "./table-rules.ts";
import { membersKeyOf, type StoredLotsDraw } from "./tiebreakers.ts";

type Order = readonly TiebreakerKey[];

// ---------------------------------------------------------------------------
// The orders: SPEC §5.10 (signed, D5) and the pre-W2d constant each sport ranked by (the plan's Anchors row).
// ---------------------------------------------------------------------------

const FIFA2026: Order = ["points", "h2h_points", "h2h_diff", "h2h_for", "diff", "for", "fair_play", "lots"];
const UEFA: Order = ["points", "h2h_points", "h2h_diff", "h2h_for", "h2h_reapply", "diff", "for", "fair_play", "lots"];
const CLASSIC: Order = ["points", "diff", "for", "h2h_points", "h2h_diff", "h2h_for", "fair_play", "lots"];

// ---------------------------------------------------------------------------
// Matches: the ledger each side records, who won, and what the rule text says the table pays.
// ---------------------------------------------------------------------------

/** h = home won, a = away won, d = a draw, t = a tie (cricket). */
type Result = "h" | "a" | "d" | "t";
type Ledger = Readonly<Record<string, number>>;

interface Match {
  readonly home: EntrantId;
  readonly away: EntrantId;
  readonly r: Result;
  /** A win's method, in the sport's own vocabulary (`outcomeMethods`): "extra_time", "shootout". Absent = regulation. */
  readonly method?: string;
  /** An unplayed forfeit (ITTF 2.3.7 walkover): the loser did not play. */
  readonly walkover?: true;
  readonly ledger: readonly [Ledger, Ledger];
  /** Typed from the rule text: the table points [home, away]. */
  readonly pays: readonly [number, number];
}

const mirror = (l: Ledger, pairs: readonly (readonly [string, string])[]): Ledger => {
  const out: Record<string, number> = {};
  for (const [a, b] of pairs) {
    if (l[a] !== undefined) out[b] = l[a];
    if (l[b] !== undefined) out[a] = l[b];
  }
  return out;
};

// Goals ledgers (football, hockey, ice hockey): gf / ga / gd, plus per-side extras (cards, goal kinds).
function goals(hg: number, ag: number, extra: readonly [Ledger, Ledger] = [{}, {}]): readonly [Ledger, Ledger] {
  return [
    { gf: hg, ga: ag, gd: hg - ag, ...extra[0] },
    { gf: ag, ga: hg, gd: ag - hg, ...extra[1] },
  ];
}
const genericScore = (hs: number, as: number): readonly [Ledger, Ledger] => [
  { for: hs, against: as, diff: hs - as },
  { for: as, against: hs, diff: as - hs },
];
const SET_PAIRS = [["sets_won", "sets_lost"], ["points_won", "points_lost"], ["games_won", "games_lost"], ["boards_won", "boards_lost"]] as const;
/** A set sport: sets (games, in BWF's word) and rally points. */
function sets(hs: number, as: number, hp: number, ap: number): readonly [Ledger, Ledger] {
  const home = { sets_won: hs, sets_lost: as, points_won: hp, points_lost: ap };
  return [home, mirror(home, SET_PAIRS)];
}
/** Tennis: sets and games. */
function tennisSets(hs: number, as: number, hg: number, ag: number): readonly [Ledger, Ledger] {
  const home = { sets_won: hs, sets_lost: as, games_won: hg, games_lost: ag };
  return [home, mirror(home, SET_PAIRS)];
}
/** Carrom: sets, boards, points. */
function carromSets(s: readonly [number, number], b: readonly [number, number], p: readonly [number, number]): readonly [Ledger, Ledger] {
  const home = { sets_won: s[0], sets_lost: s[1], boards_won: b[0], boards_lost: b[1], points_won: p[0], points_lost: p[1] };
  return [home, mirror(home, SET_PAIRS)];
}
/** Cricket: runs off legal balls each way (ICC 16.10.7: NRR = runs per over scored − conceded). */
function innings(hr: number, hb: number, ar: number, ab: number): readonly [Ledger, Ledger] {
  return [
    { runs_for: hr, balls_faced_eff: hb, runs_against: ar, balls_bowled_eff: ab, run_diff: hr - ar },
    { runs_for: ar, balls_faced_eff: ab, runs_against: hr, balls_bowled_eff: hb, run_diff: ar - hr },
  ];
}

const match = (home: EntrantId, away: EntrantId, r: Result, ledger: readonly [Ledger, Ledger], pays: readonly [number, number], more: Partial<Pick<Match, "method" | "walkover">> = {}): Match => ({
  home, away, r, ledger, pays, ...more,
});

// The rule texts' payouts.
/** FIFA / FIH / generic: W 3, D 1, L 0. */
const w3 = (r: Result): readonly [number, number] => (r === "h" ? [3, 0] : r === "a" ? [0, 3] : [1, 1]);
/** BWF (no table points in the text, RBS:150 — the product's flat 2/0); ATP 2/0 (`tennis.ts:25`); carrom 2 / house draw 1 / 0. */
const w2 = (r: Result): readonly [number, number] => (r === "h" ? [2, 0] : r === "a" ? [0, 2] : [1, 1]);
/** FIDE 1 / ½ / 0, in the engine's half-points (2 / 1 / 0). */
const fide = w2;
/** ICC: W 2, tie 1, L 0. */
const icc = w2;
/** IIHF: regulation W 3, OT/GWS W 2, OT/GWS L 1, regulation L 0. */
const iihf = (r: "h" | "a", ot = false): readonly [number, number] => (ot ? (r === "h" ? [2, 1] : [1, 2]) : r === "h" ? [3, 0] : [0, 3]);
/** FIVB V3: 3-0 / 3-1 pay 3:0, 3-2 pays 2:1. */
const fivb = (hs: number, as: number): readonly [number, number] => {
  const split = Math.min(hs, as) === 2;
  const [w, l]: [number, number] = split ? [2, 1] : [3, 0];
  return hs > as ? [w, l] : [l, w];
};
/** ITTF 3.7.5.1: W 2, a played loss 1, an unplayed loss 0. */
const ittf = (r: "h" | "a", walkover = false): readonly [number, number] => (r === "h" ? [2, walkover ? 0 : 1] : [walkover ? 0 : 1, 2]);

const fb = (h: EntrantId, a: EntrantId, hg: number, ag: number, extra?: readonly [Ledger, Ledger]): Match => {
  const r: Result = hg > ag ? "h" : hg < ag ? "a" : "d";
  return match(h, a, r, goals(hg, ag, extra), w3(r));
};
const vb = (h: EntrantId, a: EntrantId, hs: number, as: number, hp: number, ap: number): Match =>
  match(h, a, hs > as ? "h" : "a", sets(hs, as, hp, ap), fivb(hs, as));
const bd = (h: EntrantId, a: EntrantId, hs: number, as: number, hp: number, ap: number): Match => {
  const r: Result = hs > as ? "h" : "a";
  return match(h, a, r, sets(hs, as, hp, ap), w2(r));
};
const tt = (h: EntrantId, a: EntrantId, hs: number, as: number, hp: number, ap: number): Match => {
  const r = hs > as ? "h" : "a";
  return match(h, a, r, sets(hs, as, hp, ap), ittf(r));
};
const tn = (h: EntrantId, a: EntrantId, hs: number, as: number, hg: number, ag: number): Match => {
  const r: Result = hs > as ? "h" : "a";
  return match(h, a, r, tennisSets(hs, as, hg, ag), w2(r));
};
const chess = (h: EntrantId, a: EntrantId, r: "1-0" | "½-½" | "0-1"): Match => {
  const res: Result = r === "1-0" ? "h" : r === "0-1" ? "a" : "d";
  return match(h, a, res, [{}, {}], fide(res));
};

// ---------------------------------------------------------------------------
// The engine path a stage takes: pay each match through the sport's rule, rank by the resolved order.
// ---------------------------------------------------------------------------

function outcomeFor(m: Match): MatchOutcome {
  if (m.r === "d") return { kind: "draw" };
  if (m.r === "t") return { kind: "tie" };
  const [winner, loser] = m.r === "h" ? [m.home, m.away] : [m.away, m.home];
  if (m.walkover === true) return { kind: "award", winner, loser, reason: "walkover" };
  return { kind: "win", winner, loser, ...(m.method === undefined ? {} : { method: m.method }) };
}

function rawPair(m: Match): FixtureResult {
  const side = (id: EntrantId, won: boolean, lost: boolean, metrics: Ledger): StandingsDelta => ({
    entrantId: id, played: 1, won: won ? 1 : 0, drawn: !won && !lost ? 1 : 0, lost: lost ? 1 : 0, points: 0, metrics: { ...metrics },
  });
  return [side(m.home, m.r === "h", m.r === "a", m.ledger[0]), side(m.away, m.r === "a", m.r === "h", m.ledger[1])];
}

/** What the table books for `m` under `rule`: the real `payout`, with the sport's own decidedIn and score keys. */
function paid(module: AnySportModule, cfg: unknown, rule: PointsRule, m: Match): FixtureResult {
  const outcome = outcomeFor(m);
  return payout(outcome, decidedInFor(module, outcome), rawPair(m), m.walkover !== true, rule, module.awardScoreKeys, setsToWinOf(module, cfg));
}

const DRAWN_AT = "2026-10-24T09:00:00.000Z";

interface Table {
  readonly rules: TableRules;
  readonly results: readonly FixtureResult[];
  readonly seeds?: Readonly<Record<EntrantId, number>>;
  readonly lots?: readonly (readonly EntrantId[])[];
  readonly winsCount?: AnySportModule["winsCount"];
}

function rank(t: Table): { rows: readonly StandingsRow[]; newDraws: number } {
  const entrants = [...new Set(t.results.flatMap(([h, a]) => [h.entrantId, a.entrantId]))].sort();
  const fixtures: TableFixture[] = t.results.map((result, i) => ({ id: `f${i}`, status: "decided", result }));
  const draws = new Map<string, StoredLotsDraw>((t.lots ?? []).map((order) => [membersKeyOf(order), { order, drawnAt: DRAWN_AT }]));
  const done = completeTableStage(
    {
      id: "s",
      kind: "league",
      entrants,
      rules: t.rules,
      rngSeed: 7,
      lotsDraws: new Map([["", draws]]),
      ...(t.winsCount === undefined ? {} : { winsCount: t.winsCount }),
      ...(t.seeds === undefined ? {} : { seeds: new Map(Object.entries(t.seeds)) }),
    },
    fixtures,
  );
  const rows = done.tables.overall;
  if (rows === undefined) throw new Error("a one-pool stage has an overall table");
  return { rows, newDraws: done.newLotsDraws.length };
}
const ids = (rows: readonly StandingsRow[]): EntrantId[] => rows.map((row) => row.entrantId);

function cfgOf(module: AnySportModule, name: string | undefined): unknown {
  const all = declaredCfgs(module);
  const found = name === undefined ? all[0] : all.find((c) => c.name === name);
  if (found === undefined) throw new Error(`${module.key} declares no cfg ${String(name)}`);
  return found.cfg;
}

function resolved(module: AnySportModule, cfg: unknown, own: { points?: PointsRule } = {}): TableRules {
  return resolveTableRules({
    module,
    stageKind: "league",
    mergedCfg: cfg,
    stageOwn: { points: own.points ?? null, tiebreakers: null, crossGroup: null },
    divisionTiebreakers: null,
    pinned: null,
  });
}

/** Pays every match through `rule` and checks each against the rule text's typed payout; returns the booked pairs. */
function payAll(module: AnySportModule, cfg: unknown, rule: PointsRule, matches: readonly Match[]): FixtureResult[] {
  return matches.map((m) => {
    const pair = paid(module, cfg, rule, m);
    expect([pair[0].points, pair[1].points], `${m.home} v ${m.away} pays`).toEqual([...m.pays]);
    return pair;
  });
}

// ---------------------------------------------------------------------------
// The book.
// ---------------------------------------------------------------------------

interface Case {
  readonly title: string;
  /** A declared cfg's name; absent = the sport's first declared cfg. */
  readonly cfg?: string;
  readonly matches: readonly Match[];
  readonly seeds?: Readonly<Record<EntrantId, number>>;
  /** Stored drawings of lots: each the drawn order of one tied set. */
  readonly lots?: readonly (readonly EntrantId[])[];
  readonly expect: readonly EntrantId[];
  /** The key that settled each row (its `tieBreak.key`); null = the primary measure alone placed it. */
  readonly splits: Readonly<Record<EntrantId, TiebreakerKey | null>>;
  /** The default with the step at `at` removed gives this other order: that position decides. */
  readonly without?: { readonly at: number; readonly expect: readonly EntrantId[] };
  /** The order the pre-W2d constant gives the same table. */
  readonly old?: readonly EntrantId[];
}

interface Extra {
  readonly title: string;
  readonly run: (module: AnySportModule) => void;
}

interface Book {
  /** SPEC §5.10's default for league / group / americano. */
  readonly signed: Order;
  /** The pre-W2d order (plan Anchors row). */
  readonly old: Order;
  readonly cases: readonly Case[];
  /** Positions of `signed` no table of this sport can make decide, each with the reason. */
  readonly cannotDecide?: Readonly<Record<number, string>>;
  readonly extras?: readonly Extra[];
}

// FIH 2.4: a field goal, and a goal from a penalty corner.
const PC: Ledger = { goals_pc: 1 };

const BOOK: Readonly<Record<string, Book>> = {
  football: {
    signed: FIFA2026,
    old: FIFA2026,
    cases: [
      {
        title: "FB-TB-1 two level on points: their match (h2h points); two level after a drawn meeting: overall goal difference (RBG:104-106)",
        // A beat B; B beat C 2-0; C and D drew. Points A 3, B 3, D 1, C 1. A–B: A won. D–C: level on every h2h key,
        // so overall GD: D 0, C −2.
        matches: [fb("A", "B", 1, 0), fb("B", "C", 2, 0), fb("D", "C", 0, 0)],
        expect: ["A", "B", "D", "C"],
        splits: { A: "h2h_points", B: "h2h_points", D: "diff", C: "diff" },
        old: ["A", "B", "D", "C"],
      },
      {
        title: "FB-TB-1 three level on points in a cycle: head-to-head goal difference (RBG:104)",
        // A 2-0 B, B 1-0 C, C 1-0 A: 3 points each. h2h GD A +1, C 0, B −1.
        matches: [fb("A", "B", 2, 0), fb("B", "C", 1, 0), fb("C", "A", 1, 0)],
        expect: ["A", "C", "B"],
        splits: { A: "h2h_diff", C: "h2h_diff", B: "h2h_diff" },
      },
      {
        title: "FB-TB-1 three level on points and h2h goal difference: head-to-head goals (RBG:104)",
        // C 3-2 A, A 1-0 B, B 2-1 C: 3 points each, h2h GD 0 each; h2h goals C 4, A 3, B 2.
        matches: [fb("C", "A", 3, 2), fb("A", "B", 1, 0), fb("B", "C", 2, 1)],
        expect: ["C", "A", "B"],
        splits: { C: "h2h_for", A: "h2h_for", B: "h2h_for" },
      },
      {
        title: "FB-TB-1 level after a drawn meeting and on goal difference: overall goals scored (RBG:105)",
        // A 2-2 B; B 3-1 C; A 2-0 D. A, B 4 points, GD +2 each; goals B 5, A 4. C, D never met: GD −2 each; goals C 1, D 0.
        matches: [fb("A", "B", 2, 2), fb("B", "C", 3, 1), fb("A", "D", 2, 0)],
        expect: ["B", "A", "C", "D"],
        splits: { B: "for", A: "for", C: "for", D: "for" },
      },
      {
        title: "FB-TB-1 fair play (−1 yellow, −4 direct red), then a drawing of lots (deviation: FIFA's world ranking, RB2B-4)",
        // A 1-1 B (A a yellow, −1; B a direct red, −4); A 1-0 C; B 1-0 D. A, B 4 points, GD +1, goals 2 → fair play: A.
        // C, D: 0 points, GD −1, goals 0, no cards, never met → the stored draw D, C.
        matches: [fb("A", "B", 1, 1, [{ yellow: 1, fair_play: -1 }, { red: 1, fair_play: -4 }]), fb("A", "C", 1, 0), fb("B", "D", 1, 0)],
        lots: [["D", "C"]],
        expect: ["A", "B", "D", "C"],
        splits: { A: "fair_play", B: "fair_play", D: "lots", C: "lots" },
        old: ["A", "B", "D", "C"],
      },
      {
        title: "FB-TB-1 three level on points: fifa2026 applies the mini-league once, then overall goal difference (RBG:108-109)",
        // X 1-0 Y, Y 2-1 Z, Z 2-1 X, and each beat D (X 1-0, Y 3-0, Z 1-0): X, Y, Z 6 points. Mini-league: 3 points
        // each, GD 0 each, goals Z 3, X 2, Y 2 → Z; X, Y still level → fifa2026 falls through: overall GD Y +3, X +1.
        matches: [fb("X", "Y", 1, 0), fb("Y", "Z", 2, 1), fb("Z", "X", 2, 1), fb("X", "D", 1, 0), fb("Y", "D", 3, 0), fb("Z", "D", 1, 0)],
        expect: ["Z", "Y", "X", "D"],
        splits: { Z: "h2h_for", Y: "diff", X: "diff", D: null },
      },
    ],
    extras: [
      {
        title: "FB-TB-2 the uefa preset re-applies head-to-head to the two left level, where fifa2026 falls through; classic is GD first (RBG:108-112)",
        run: (module) => {
          const presets = module.tablePresets?.("league");
          const order = (id: string): Order => {
            const found = presets?.tiebreakers.find((p) => p.id === id);
            if (found === undefined) throw new Error(`no ${id} preset`);
            return found.keys;
          };
          expect([order("fifa2026"), order("uefa"), order("classic")]).toEqual([FIFA2026, UEFA, CLASSIC]);
          const cfg = cfgOf(module, undefined);
          const rules = resolved(module, cfg);
          const table = [fb("X", "Y", 1, 0), fb("Y", "Z", 2, 1), fb("Z", "X", 2, 1), fb("X", "D", 1, 0), fb("Y", "D", 3, 0), fb("Z", "D", 1, 0)];
          const results = payAll(module, cfg, rules.points, table);
          // UEFA 20.01(d): the mini-league among X, Y alone — X beat Y.
          const uefa = rank({ rules: { ...rules, tiebreakers: order("uefa") }, results });
          expect(ids(uefa.rows)).toEqual(["Z", "X", "Y", "D"]);
          expect(uefa.rows.map((r) => r.tieBreak?.key ?? null)).toEqual(["h2h_for", "h2h_points", "h2h_points", null]);
          // classic: overall GD Y +3, then X, Z +1 → goals Z 4, X 3.
          expect(ids(rank({ rules: { ...rules, tiebreakers: order("classic") }, results }).rows)).toEqual(["Y", "Z", "X", "D"]);
          // The default is fifa2026, which does not re-apply.
          expect(ids(rank({ rules, results }).rows)).toEqual(["Z", "Y", "X", "D"]);
        },
      },
      {
        title: "FB-TB-4 a division that does not track fair play ranks by the default with no fair-play step: the pair goes to the draw",
        run: (module) => {
          const cfg = module.configSchema.parse({ ...(cfgOf(module, undefined) as object), fairPlay: false });
          const rules = resolved(module, cfg);
          expect(rules.tiebreakers).toEqual(FIFA2026.filter((k) => k !== "fair_play"));
          // The fair-play case above, with cards recording nothing (fair play off): A, B level to the end → stored draw B, A.
          const results = payAll(module, cfg, rules.points, [fb("A", "B", 1, 1), fb("A", "C", 1, 0), fb("B", "D", 1, 0)]);
          const ranked = rank({ rules, results, lots: [["B", "A"], ["D", "C"]] });
          expect(ids(ranked.rows)).toEqual(["B", "A", "D", "C"]);
          expect(ranked.rows.map((r) => r.tieBreak?.key)).toEqual(["lots", "lots", "lots", "lots"]);
        },
      },
    ],
  },

  hockey: {
    signed: ["points", "wins", "diff", "for", "h2h_points", "h2h_wins", "h2h_diff", "h2h_for", "field_goals", "lots"],
    old: ["points", "diff", "for", "h2h_points", "seed"],
    cannotDecide: {
      5: "h2h_wins follows h2h_points: under W 3 / D 1 / L 0 a mini-league of fewer than five cannot level two teams on points while their wins differ (1W 2L = 3 draws needs a common opponent both drew); the key itself is proved in tiebreak-keys-w2d.test.ts",
    },
    cases: [
      {
        title: "HK-TB-1 FIH matches won before goal difference: two wins above one win and three draws (RBG:236)",
        // A 1-0 C, A 1-0 D, E 5-0 A → A 6 points (2W), GD −3. B 3-0 C, B 0-0 D, B 0-0 E, B 0-0 F → B 6 points (1W), GD +3.
        // E 4, D 1 (GD −1), F 1 (GD 0), C 0.
        matches: [fb("A", "C", 1, 0), fb("A", "D", 1, 0), fb("E", "A", 5, 0), fb("B", "C", 3, 0), fb("B", "D", 0, 0), fb("B", "E", 0, 0), fb("B", "F", 0, 0)],
        expect: ["A", "B", "E", "F", "D", "C"],
        splits: { A: "wins", B: "wins", E: null, F: "diff", D: "diff", C: null },
        old: ["B", "A", "E", "F", "D", "C"],
      },
      {
        title: "HK-TB-1 level on points, wins and goal difference: goals scored (RBG:236)",
        // B 2-1 C, A 1-0 D: B and A 3 points, 1 win, GD +1; goals B 2, A 1. C and D GD −1; goals C 1, D 0.
        matches: [fb("B", "C", 2, 1), fb("A", "D", 1, 0)],
        expect: ["B", "A", "C", "D"],
        splits: { B: "for", A: "for", C: "for", D: "for" },
      },
      {
        title: "HK-TB-1 level on points, wins, GD and goals: the match between the two (RBG:236)",
        // A 2-1 B, B 2-1 C, D 2-1 A: A, B, D 3 points, 1 win. GD D +1, A 0, B 0; goals A 3, B 3 → their match: A.
        matches: [fb("A", "B", 2, 1), fb("B", "C", 2, 1), fb("D", "A", 2, 1)],
        expect: ["D", "A", "B", "C"],
        splits: { D: "diff", A: "h2h_points", B: "h2h_points", C: null },
      },
      {
        title: "HK-TB-1 three level on every overall key: the mini-league's goal difference (RBG:236)",
        // A 3-0 B, B 1-0 C, C 1-0 A; O beat all three: 5-0 A, 3-2 B, 5-2 C. A, B, C: 3 points, 1 win, GD −3, goals 3.
        // Among them: 3 points and 1 win each; GD A +2, C 0, B −2.
        matches: [fb("A", "B", 3, 0), fb("B", "C", 1, 0), fb("C", "A", 1, 0), fb("O", "A", 5, 0), fb("O", "B", 3, 2), fb("O", "C", 5, 2)],
        expect: ["O", "A", "C", "B"],
        splits: { O: null, A: "h2h_diff", C: "h2h_diff", B: "h2h_diff" },
        old: ["O", "A", "B", "C"],
      },
      {
        title: "HK-TB-1 three level on every overall key and on mini-league GD: the mini-league's goals (RBG:236)",
        // C 3-2 A, A 1-0 B, B 2-1 C; O 1-0 C, 2-1 A, 3-2 B. A, B, C: 3 points, 1 win, GD −1, goals 4. Among them GD 0
        // each; goals C 4, A 3, B 2.
        matches: [fb("C", "A", 3, 2), fb("A", "B", 1, 0), fb("B", "C", 2, 1), fb("O", "C", 1, 0), fb("O", "A", 2, 1), fb("O", "B", 3, 2)],
        expect: ["O", "C", "A", "B"],
        splits: { O: null, C: "h2h_for", A: "h2h_for", B: "h2h_for" },
        old: ["O", "A", "B", "C"],
      },
      {
        title: "HK-TB-2 field goals decide (an own goal counts, a corner does not), then lots (RBG:237; deviation: the FIH ranking shoot-out, RB2B-11)",
        // A 1-1 B: A's goal is B's own goal (no goal kind, so a field goal for A); B's from a penalty corner. A 2-0 C,
        // B 2-0 D. A, B: 4 points, 1 win, GD +2, goals 3, drew each other; field goals A 3, B 2. C, D never met, level
        // through field goals (0) → the stored draw D, C.
        matches: [fb("A", "B", 1, 1, [{}, PC]), fb("A", "C", 2, 0), fb("B", "D", 2, 0)],
        lots: [["D", "C"]],
        expect: ["A", "B", "D", "C"],
        splits: { A: "field_goals", B: "field_goals", D: "lots", C: "lots" },
        old: ["A", "B", "C", "D"],
      },
    ],
    extras: [
      {
        title: "HK-PT-1 HK-PT-2 SC-P4 the FIH default pays a draw 1/1; the Pro League preset books a shoot-out D for both, the winner +1 (2/1), and wins separates toward the regulation winner (D10(f), B2)",
        run: (module) => {
          const cfg = cfgOf(module, undefined);
          const rules = resolved(module, cfg);
          // The default: 3/1/0 with draws (GTR App. 3).
          const def = payAll(module, cfg, rules.points, [fb("A", "B", 1, 1), fb("C", "D", 2, 0)]);
          expect(def.map(([h, a]) => [h.drawn, a.drawn])).toEqual([[1, 1], [0, 0]]);
          // The Pro League preset (`fih-shootout`, re-expressed per B2), typed from SPEC §5.10.
          const preset = module.tablePresets?.("league").points.find((p) => p.id === "pro_league")?.rule;
          expect(preset).toEqual(PointsRule.parse({ win: { regulation: 3 }, loss: { regulation: 0 }, draw: 1, soBonus: 1, shootoutAs: "draw_plus_bonus", unit: "whole" }));
          if (preset === undefined) throw new Error("no pro_league preset");
          // X 2-0 P; X v Q 1-1, Q wins the shoot-out; Y v R 0-0 and Y v S 2-2, Y wins both shoot-outs.
          // X: W 3 + D 1 = 4 (1 win). Y: D+1 twice = 4 (0 wins). Q 2, R 1, S 1, P 0.
          const so = (h: EntrantId, a: EntrantId, g: number, r: "h" | "a"): Match =>
            match(h, a, r, goals(g, g), r === "h" ? [2, 1] : [1, 2], { method: "shootout" });
          const table = [fb("X", "P", 2, 0), so("X", "Q", 1, "a"), so("Y", "R", 0, "h"), so("Y", "S", 2, "h")];
          const results = payAll(module, cfg, preset, table);
          // B2: a shoot-out is a draw for both in the W/D/L columns.
          expect(results.slice(1).map(([h, a]) => [h.won, h.drawn, a.won, a.drawn])).toEqual([[0, 1, 0, 1], [0, 1, 0, 1], [0, 1, 0, 1]]);
          const ranked = rank({ rules: { ...rules, points: preset }, results, winsCount: module.winsCount });
          expect(ids(ranked.rows)).toEqual(["X", "Y", "Q", "S", "R", "P"]);
          expect(ranked.rows.map((r) => r.tieBreak?.key ?? null)).toEqual(["wins", "wins", null, "for", "for", null]);
          // The differential: before B2 a shoot-out win booked a WIN paid as one (the W2c shape) — Y 2 wins, 6 points.
          const before = legacyPointsRule({ base: { win: 3, draw: 1, loss: 0 } });
          const wrong = table.map((m) => paid(module, cfg, before, m));
          expect(ids(rank({ rules, results: wrong, winsCount: module.winsCount }).rows).slice(0, 2)).toEqual(["Y", "X"]);
        },
      },
    ],
  },

  icehockey: {
    signed: ["points", "h2h_points", "h2h_diff", "h2h_for", "h2h_reapply", "diff", "for", "seed", "lots"],
    old: ["points", "h2h_points", "h2h_diff", "h2h_for", "diff", "for", "seed"],
    cases: [
      {
        title: "IH-TB-1 IH-PT-1 a four-way tie re-applied down to two (RBG:345-346)",
        // W, X, Y, Z all 6 points (IIHF 3 / OT 2 / OT loss 1 / 0). Among the four: W 6 (beat X and Y, lost to Z), X 4
        // (OT wins over Y and Z), Y 4 (OT loss to X, 3-0 over Z), Z 4 → W first; GD X 0, Y 0, Z −3 → Z last; X, Y level
        // on h2h goals (4 each). IIHF re-applies to the two: X beat Y in overtime → X. Without re-application overall GD
        // (+1 each, from their overtime wins over O2 and O3) then goals: Y 8, X 5. O1 3 points; O2, O3, O4 1 point
        // each (overtime losses), GD −1 each, goals O3 3, O4 1, O2 0.
        matches: [
          match("W", "X", "h", goals(2, 0), iihf("h")),
          match("W", "Y", "h", goals(2, 0), iihf("h")),
          match("Z", "W", "h", goals(1, 0), iihf("h")),
          match("X", "Y", "h", goals(2, 1), iihf("h", true), { method: "extra_time" }),
          match("X", "Z", "h", goals(2, 1), iihf("h", true), { method: "extra_time" }),
          match("Y", "Z", "h", goals(3, 0), iihf("h")),
          match("O1", "W", "h", goals(1, 0), iihf("h")),
          match("X", "O2", "h", goals(1, 0), iihf("h", true), { method: "extra_time" }),
          match("Y", "O3", "h", goals(4, 3), iihf("h", true), { method: "extra_time" }),
          match("Z", "O4", "h", goals(2, 1), iihf("h", true), { method: "extra_time" }),
        ],
        expect: ["W", "X", "Y", "Z", "O1", "O3", "O4", "O2"],
        splits: { W: "h2h_points", X: "h2h_points", Y: "h2h_points", Z: "h2h_diff", O1: null, O3: "for", O4: "for", O2: "for" },
        without: { at: 4, expect: ["W", "Y", "X", "Z", "O1", "O3", "O4", "O2"] },
        old: ["W", "Y", "X", "Z", "O1", "O3", "O4", "O2"],
      },
      {
        title: "IH-TB-1 three level on points and h2h GD: head-to-head goals (RBG:345)",
        // B 3-2 C, C 1-0 A, A 2-1 B (regulation): 3 points each, h2h GD 0 each; goals B 4, C 3, A 2.
        matches: [match("B", "C", "h", goals(3, 2), iihf("h")), match("C", "A", "h", goals(1, 0), iihf("h")), match("A", "B", "h", goals(2, 1), iihf("h"))],
        expect: ["B", "C", "A"],
        splits: { B: "h2h_for", C: "h2h_for", A: "h2h_for" },
      },
      {
        title: "IH-TB-1 never met: overall goal difference, then goals (RBG:346)",
        // A 3-1 C, B 2-1 D, E 3-2 F. A, B, E 3 points: GD A +2, B +1, E +1 → goals E 3, B 2. C, D, F 0: GD C −2,
        // D −1, F −1 → goals F 2, D 1.
        matches: [match("A", "C", "h", goals(3, 1), iihf("h")), match("B", "D", "h", goals(2, 1), iihf("h")), match("E", "F", "h", goals(3, 2), iihf("h"))],
        expect: ["A", "E", "B", "F", "D", "C"],
        splits: { A: "diff", E: "for", B: "for", F: "for", D: "for", C: "diff" },
      },
      {
        title: "IH-TB-1 level through goals: the seed, then lots (RBG:346; deviation: lots after seed)",
        // A 2-1 C, B 2-1 D, E 2-1 G, F 2-1 H. Seeds B 1, A 2, C 3, D 4; E, F, G, H unseeded → the stored draws F, E
        // and H, G.
        matches: [
          match("A", "C", "h", goals(2, 1), iihf("h")), match("B", "D", "h", goals(2, 1), iihf("h")),
          match("E", "G", "h", goals(2, 1), iihf("h")), match("F", "H", "h", goals(2, 1), iihf("h")),
        ],
        seeds: { B: 1, A: 2, C: 3, D: 4 },
        lots: [["F", "E"], ["H", "G"]],
        expect: ["B", "A", "F", "E", "C", "D", "H", "G"],
        splits: { B: "seed", A: "seed", F: "lots", E: "lots", C: "seed", D: "seed", H: "lots", G: "lots" },
        old: ["B", "A", "E", "F", "C", "D", "G", "H"],
      },
    ],
  },

  boardgame: {
    signed: ["points", "direct", "wins", "sberger", "lots"],
    old: ["points", "buchholz_cut1", "buchholz", "sberger", "direct", "wins", "lots"],
    cases: [
      {
        title: "BG-TB-1 Sonneborn-Berger decides once direct encounter and wins are level (RBG:459-461)",
        // A ½-½ B, A 1-0 C, D 1-0 A, B 1-0 D, C 1-0 B, C 1-0 D. Half-points: C 4, A 3, B 3, D 2. A–B drawn, 1 win each.
        // SB (half-points): A = C 4 + ½·B 3 = 5½; B = D 2 + ½·A 3 = 3½.
        matches: [chess("A", "B", "½-½"), chess("A", "C", "1-0"), chess("D", "A", "1-0"), chess("B", "D", "1-0"), chess("C", "B", "1-0"), chess("C", "D", "1-0")],
        expect: ["C", "A", "B", "D"],
        splits: { C: null, A: "sberger", B: "sberger", D: null },
      },
      {
        title: "BG-TB-1 direct encounter decides where Sonneborn-Berger would say the other; level throughout → lots (RBG:460)",
        // A 1-0 B, C 1-0 A, D 1-0 A, B ½-½ C, B ½-½ D, C ½-½ D. C 4, D 4, A 2, B 2. A beat B → A. SB A 2, B ½·4 + ½·4 =
        // 4 (pre-W2d, SB before direct: B). C, D: drawn, 1 win each, SB 5 each → the stored draw D, C.
        matches: [chess("A", "B", "1-0"), chess("C", "A", "1-0"), chess("D", "A", "1-0"), chess("B", "C", "½-½"), chess("B", "D", "½-½"), chess("C", "D", "½-½")],
        lots: [["D", "C"]],
        expect: ["D", "C", "A", "B"],
        splits: { D: "lots", C: "lots", A: "direct", B: "direct" },
        old: ["D", "C", "B", "A"],
      },
      {
        title: "BG-TB-1 number of wins decides after a drawn direct encounter (RBG:460)",
        // A ½-½ B, A 1-0 C, D 1-0 A, B ½-½ C, B ½-½ D, C ½-½ D. D 4, A 3 (1 win), B 3 (0 wins), C 2. SB A 2 + 1½ = 3½,
        // B 1½ + 1 + 2 = 4½ (pre-W2d: B).
        matches: [chess("A", "B", "½-½"), chess("A", "C", "1-0"), chess("D", "A", "1-0"), chess("B", "C", "½-½"), chess("B", "D", "½-½"), chess("C", "D", "½-½")],
        expect: ["D", "A", "B", "C"],
        splits: { D: null, A: "wins", B: "wins", C: null },
        old: ["D", "B", "A", "C"],
      },
    ],
    extras: [
      {
        title: "BG-TB-2 no Buchholz outside Swiss: the round-robin default holds neither, the Swiss one keeps both (C.07 Art. 8 note; OC1)",
        run: (module) => {
          const cfg = cfgOf(module, undefined);
          const buchholz: readonly TiebreakerKey[] = ["buchholz", "buchholz_cut1"];
          const nonSwiss = (["league", "group", "americano"] as const).map((kind) => module.defaultTiebreakers(kind, cfg as never));
          expect(nonSwiss.length).toBe(3);
          for (const order of nonSwiss) expect(order.filter((k) => buchholz.includes(k))).toEqual([]);
          expect(module.defaultTiebreakers("swiss", cfg as never).filter((k) => buchholz.includes(k))).toEqual(["buchholz_cut1", "buchholz"]);
        },
      },
    ],
  },

  cricket: {
    signed: ["points", "wins", "nrr", "h2h_points", "seed", "lots"],
    old: ["points", "wins", "nrr", "h2h_points", "seed"],
    cases: [
      {
        title: "CK-TB-1 level on points: matches won (ICC 16.10.4, RBS:454)",
        // E beat G, H beat E, F tied G and H. E 2 (1 win), F 2 (two ties, 0 wins), G 1, H 3.
        matches: [
          match("E", "G", "h", innings(160, 120, 150, 120), icc("h")),
          match("H", "E", "h", innings(170, 120, 160, 120), icc("h")),
          match("F", "G", "t", innings(150, 120, 150, 120), icc("t")),
          match("F", "H", "t", innings(140, 120, 140, 120), icc("t")),
        ],
        expect: ["H", "E", "F", "G"],
        splits: { H: null, E: "wins", F: "wins", G: null },
      },
      {
        title: "CK-TB-1 level on points and wins: net run rate (RBS:454)",
        // A 160/20 ov beat C 140/20; B 150/20 beat D 145/20. NRR A +1.00, B +0.25, D −0.25, C −1.00.
        matches: [match("A", "C", "h", innings(160, 120, 140, 120), icc("h")), match("B", "D", "h", innings(150, 120, 145, 120), icc("h"))],
        expect: ["A", "B", "D", "C"],
        splits: { A: "nrr", B: "nrr", D: "nrr", C: "nrr" },
      },
      {
        title: "CK-TB-1 level on points, wins and NRR: head-to-head (RBS:454)",
        // A beat B, B beat C, D beat A, every match 160 v 150 off 20 overs. A, B: NRR 0; D +0.5 → D; A beat B.
        matches: [
          match("A", "B", "h", innings(160, 120, 150, 120), icc("h")),
          match("B", "C", "h", innings(160, 120, 150, 120), icc("h")),
          match("D", "A", "h", innings(160, 120, 150, 120), icc("h")),
        ],
        expect: ["D", "A", "B", "C"],
        splits: { D: "nrr", A: "h2h_points", B: "h2h_points", C: null },
      },
      {
        title: "CK-TB-1 the pre-event seed, then lots (RBS:454; deviation: the ICC stops at the seed)",
        // E beat G, F beat H, both 160 v 150. E, F level through h2h (never met), unseeded → the stored draw F, E.
        // G (seed 1), H (seed 2).
        matches: [match("E", "G", "h", innings(160, 120, 150, 120), icc("h")), match("F", "H", "h", innings(160, 120, 150, 120), icc("h"))],
        seeds: { G: 1, H: 2 },
        lots: [["F", "E"]],
        expect: ["F", "E", "G", "H"],
        splits: { F: "lots", E: "lots", G: "seed", H: "seed" },
        old: ["E", "F", "G", "H"],
      },
    ],
    extras: [
      {
        title: "CK-PT-1 under a stage's own rule a tie pays 1, not the 0 the W2c conversion paid (ST-G9)",
        run: (module) => {
          const cfg = cfgOf(module, undefined);
          // The ICC table points (16.10.x), as an organiser saves them on the stage: W 2, tie 1, NR 1, L 0.
          const own = PointsRule.parse({ win: { regulation: 2 }, loss: { regulation: 0 }, draw: 1, tie: 1, noResult: 1, shootoutAs: "result", unit: "whole" });
          const rules = resolved(module, cfg, { points: own });
          expect(rules.points).toEqual(own);
          // A tied B (150 v 150); D beat A heavily (101 off 60 balls v 100); E beat C narrowly (160 off 119 v 159).
          const table = [
            match("A", "B", "t", innings(150, 120, 150, 120), [1, 1]),
            match("D", "A", "h", innings(101, 60, 100, 120), [2, 0]),
            match("E", "C", "h", innings(160, 119, 159, 120), [2, 0]),
          ];
          const results = payAll(module, cfg, own, table);
          // D, E 2 points (NRR D above E); B, A 1 point (NRR B 0 above A); C 0.
          expect(ids(rank({ rules, results }).rows)).toEqual(["D", "E", "B", "A", "C"]);
          // The differential: the W2c shape converted (`legacyPointsRule`) paid a tie 0, so C's better NRR put it above A.
          const legacy = legacyPointsRule({ base: { win: 2, draw: 1, loss: 0 } });
          const wrong = table.map((m) => paid(module, cfg, legacy, m));
          expect(wrong[0]?.map((d) => d.points)).toEqual([0, 0]);
          expect(ids(rank({ rules, results: wrong }).rows)).toEqual(["D", "E", "B", "C", "A"]);
        },
      },
    ],
  },

  volleyball: {
    signed: ["wins", "points", "set_ratio", "point_ratio", "h2h_points", "lots"],
    old: ["points", "wins", "set_ratio", "point_ratio", "h2h_points"],
    cases: [
      {
        title: "VB-TB-1 VB-PT-1 matches won first: five 3-2 wins (10 points) above four 3-0 wins (RBS:318 VB-9); the rest drawn by lot",
        // A beat B and C1-C4, every one 3-2 (2:1) → 5 wins, 10 points. B beat C1-C4 3-0 (3:0) and lost 2-3 to A → 4 wins,
        // 13 points. Each C: lost 2-3 to A (1) and 0-3 to B → 1 point, sets 2-6, rally points 160-180: level to the end →
        // the stored draw C3, C1, C4, C2.
        matches: [
          vb("A", "B", 3, 2, 105, 100),
          ...["C1", "C2", "C3", "C4"].flatMap((c) => [vb("A", c, 3, 2, 105, 100), vb("B", c, 3, 0, 75, 60)]),
        ],
        lots: [["C3", "C1", "C4", "C2"]],
        expect: ["A", "B", "C3", "C1", "C4", "C2"],
        splits: { A: null, B: null, C3: "lots", C1: "lots", C4: "lots", C2: "lots" },
        old: ["B", "A", "C1", "C2", "C3", "C4"],
      },
      {
        title: "VB-TB-1 level on wins: match points (RBS:293)",
        // R beat P 3-1 (3:0), P beat Q 3-0 (3:0), Q beat R 3-2 (2:1). 1 win each; points R 4, P 3, Q 2.
        matches: [vb("P", "Q", 3, 0, 75, 60), vb("Q", "R", 3, 2, 105, 100), vb("R", "P", 3, 1, 95, 85)],
        expect: ["R", "P", "Q"],
        splits: { R: "points", P: "points", Q: "points" },
      },
      {
        title: "VB-TB-1 level on wins and points: set ratio (RBS:294)",
        // B 3-0 D, A 3-1 C: 1 win, 3 points each; sets B 3/0, A 3/1. C 1/3 above D 0/3.
        matches: [vb("B", "D", 3, 0, 75, 60), vb("A", "C", 3, 1, 95, 85)],
        expect: ["B", "A", "C", "D"],
        splits: { B: "set_ratio", A: "set_ratio", C: "set_ratio", D: "set_ratio" },
      },
      {
        title: "VB-TB-1 level on wins, points and set ratio: point ratio (RBS:295)",
        // B 3-0 D 75-50, A 3-0 C 75-60: rally ratio B 1.50, A 1.25; C 0.80, D 0.67.
        matches: [vb("B", "D", 3, 0, 75, 50), vb("A", "C", 3, 0, 75, 60)],
        expect: ["B", "A", "C", "D"],
        splits: { B: "point_ratio", A: "point_ratio", C: "point_ratio", D: "point_ratio" },
      },
      {
        title: "VB-TB-1 level on wins, points and both ratios: head-to-head (RBS:296)",
        // A 3-1 B, B 3-1 D, C 3-1 A, every match 95-85. A, B, C: 1 win, 3 points; sets C 3/1 → C; A, B 4/4 and 180/180
        // → A beat B.
        matches: [vb("A", "B", 3, 1, 95, 85), vb("B", "D", 3, 1, 95, 85), vb("C", "A", 3, 1, 95, 85)],
        expect: ["C", "A", "B", "D"],
        splits: { C: "set_ratio", A: "h2h_points", B: "h2h_points", D: null },
      },
    ],
    extras: [
      {
        title: "VB-PT-2 best of 3 on the FIVB map: a 2-1 win pays 2:1, not the 3:0 the shipped map's \"*\" paid (SC-S9, RB2A-10)",
        run: (module) => {
          // An indoor division moved to best of three (the shipped FIVB map), as a stage's merged cfg.
          const cfg = module.configSchema.parse({ ...(cfgOf(module, undefined) as object), bestOf: 3 });
          const rules = resolved(module, cfg);
          // RB2A-10: 2-0 ⇒ 3:0, 2-1 ⇒ 2:1.
          const bo3 = (h: EntrantId, a: EntrantId, hs: number, as: number, hp: number, ap: number): Match =>
            match(h, a, hs > as ? "h" : "a", sets(hs, as, hp, ap), Math.min(hs, as) === 1 ? (hs > as ? [2, 1] : [1, 2]) : hs > as ? [3, 0] : [0, 3]);
          const table = [bo3("P", "X", 2, 1, 60, 55), bo3("R", "Y", 2, 0, 50, 20), bo3("Z", "R", 2, 1, 60, 58)];
          const results = payAll(module, cfg, rules.points, table);
          // Wins 1 each for P, R, Z: points R 4, P 2, Z 2 → R; P, Z level on sets 2/1 → rally ratio P 60/55 > Z 60/58.
          // X (1) above Y (0).
          const ranked = rank({ rules, results });
          expect(ids(ranked.rows)).toEqual(["R", "P", "Z", "X", "Y"]);
          expect(ranked.rows.map((r) => r.tieBreak?.key ?? null)).toEqual(["points", "point_ratio", "point_ratio", "points", "points"]);
          // The wrong one's constant: "*" paid every win 3:0, so P, R, Z level on 3 and R's 1-2 loss sank it on sets.
          const star: FixtureResult[] = table.map((m) => {
            const raw = rawPair(m);
            return [{ ...raw[0], points: raw[0].won * 3 }, { ...raw[1], points: raw[1].won * 3 }];
          });
          expect(ids(rank({ rules, results: star }).rows)).toEqual(["P", "Z", "R", "X", "Y"]);
        },
      },
    ],
  },

  badminton: {
    signed: ["wins", "h2h_two", "set_diff", "h2h_two", "point_diff", "h2h_two", "lots"],
    old: ["points", "wins", "set_ratio", "point_ratio", "h2h_points"],
    cases: [
      {
        title: "BD-TB-1 two level on matches won: the winner of their match (BWF 16.2.2, RBS:152)",
        // A 2-1 B, C 2-0 A, B 2-0 D, C 2-0 D. C 2 wins; A, B 1 win; A beat B. Games A 2-3, B 3-2 (a games reading: B).
        matches: [bd("A", "B", 2, 1, 60, 55), bd("C", "A", 2, 0, 42, 20), bd("B", "D", 2, 0, 42, 20), bd("C", "D", 2, 0, 42, 20)],
        expect: ["C", "A", "B", "D"],
        splits: { C: null, A: "h2h_two", B: "h2h_two", D: null },
        without: { at: 1, expect: ["C", "B", "A", "D"] },
        old: ["C", "B", "A", "D"],
      },
      {
        title: "BD-TB-1 three level on wins: games DIFFERENCE, where points difference would order them otherwise (BWF 16.2.3, RBS:153)",
        // A 2-0 B, B 2-1 C, C 2-1 A, and each beat D (A 2-0, B 2-1, C 2-0). 2 wins each. Games A 5-2 (+3), C 5-3 (+2),
        // B 4-4 (0). Rally points B +56, A +6, C −24.
        matches: [
          bd("A", "B", 2, 0, 42, 38), bd("B", "C", 2, 1, 61, 31), bd("C", "A", 2, 1, 61, 59),
          bd("A", "D", 2, 0, 42, 38), bd("B", "D", 2, 1, 61, 31), bd("C", "D", 2, 0, 42, 38),
        ],
        expect: ["A", "C", "B", "D"],
        splits: { A: "set_diff", C: "set_diff", B: "set_diff", D: null },
      },
      {
        title: "BD-TB-1 games difference leaves two equal: their match (BWF 16.2.3.1, RBS:154)",
        // A 2-1 B, B 2-0 C, C 2-0 A, A 2-0 D, B 2-0 D, C 2-1 D. 2 wins each; games B +3, A +1, C +1 → C beat A. Points
        // difference would say A (+44) above C (−16).
        matches: [
          bd("A", "B", 2, 1, 47, 31), bd("B", "C", 2, 0, 42, 20), bd("C", "A", 2, 0, 42, 38),
          bd("A", "D", 2, 0, 42, 10), bd("B", "D", 2, 0, 42, 20), bd("C", "D", 2, 1, 61, 59),
        ],
        expect: ["B", "C", "A", "D"],
        splits: { B: "set_diff", C: "h2h_two", A: "h2h_two", D: null },
        without: { at: 3, expect: ["B", "A", "C", "D"] },
        old: ["B", "A", "C", "D"],
      },
      {
        title: "BD-TB-1 three level on games difference: points difference, and two left equal: their match (BWF 16.2.4, 16.2.4.1, RBS:155)",
        // A 2-1 B, B 2-1 C, C 2-1 A (each 61-59), each beat D 2-0 (A 42-20, B 42-10, C 42-20). Games +2 each. Points B +32,
        // A +22, C +22 → C beat A.
        matches: [
          bd("A", "B", 2, 1, 61, 59), bd("B", "C", 2, 1, 61, 59), bd("C", "A", 2, 1, 61, 59),
          bd("A", "D", 2, 0, 42, 20), bd("B", "D", 2, 0, 42, 10), bd("C", "D", 2, 0, 42, 20),
        ],
        lots: [["A", "C"]],
        expect: ["B", "C", "A", "D"],
        splits: { B: "point_diff", C: "h2h_two", A: "h2h_two", D: null },
        without: { at: 5, expect: ["B", "A", "C", "D"] },
      },
      {
        title: "BD-TB-1 three still equal: lots (BWF 16.2.4.2, RBS:156)",
        // A 2-1 B, B 2-1 C, C 2-1 A (each 61-59), each beat D 42-20: level on every key → the stored draw C, A, B.
        matches: [
          bd("A", "B", 2, 1, 61, 59), bd("B", "C", 2, 1, 61, 59), bd("C", "A", 2, 1, 61, 59),
          bd("A", "D", 2, 0, 42, 20), bd("B", "D", 2, 0, 42, 20), bd("C", "D", 2, 0, 42, 20),
        ],
        lots: [["C", "A", "B"]],
        expect: ["C", "A", "B", "D"],
        splits: { C: "lots", A: "lots", B: "lots", D: null },
        old: ["A", "B", "C", "D"],
      },
    ],
  },

  tabletennis: {
    signed: ["points", "h2h_points", "h2h_set_ratio", "h2h_point_ratio", "h2h_exclusion", "lots"],
    old: ["points", "wins", "set_ratio", "point_ratio", "h2h_points"],
    cases: [
      {
        title: "TT-TB-1 TT-PT-1 a walkover loser scores 0, a played loser 1; exclusion restarts on the last two and reverses the games-ratio order (RBS:227-230)",
        // X 3-0 Y; Y 3-2 Z; Z beat X by walkover (credited 3-0, 11-0 a game, ITTF 2.3.7) → X 0; X 3-1 W; W 3-1 Y;
        // W 3-1 Z. Points W 5, X 4, Y 4, Z 4. Among X, Y, Z: X 2, Y 3, Z 3 → X last; exclusion: Y–Z alone, Y won → Y.
        // Without exclusion, the three-way games ratio: Z 5/3 above Y 3/5.
        matches: [
          tt("X", "Y", 3, 0, 33, 24),
          tt("Y", "Z", 3, 2, 52, 50),
          match("Z", "X", "h", sets(3, 0, 33, 0), ittf("h", true), { walkover: true }),
          tt("X", "W", 3, 1, 44, 38),
          tt("W", "Y", 3, 1, 44, 40),
          tt("W", "Z", 3, 1, 44, 41),
        ],
        expect: ["W", "Y", "Z", "X"],
        splits: { W: null, Y: "h2h_points", Z: "h2h_points", X: "h2h_points" },
        without: { at: 4, expect: ["W", "Z", "Y", "X"] },
        old: ["W", "X", "Z", "Y"],
      },
      {
        title: "TT-TB-1 three level on match points among them: their games ratio (ITTF 3.7.5.2, RBS:228)",
        // X 3-0 Y, Y 3-1 Z, Z 3-2 X: 3 points each. Games among them X 5/3, Z 4/5, Y 3/4.
        matches: [tt("X", "Y", 3, 0, 33, 20), tt("Y", "Z", 3, 1, 44, 38), tt("Z", "X", 3, 2, 52, 50)],
        expect: ["X", "Z", "Y"],
        splits: { X: "h2h_set_ratio", Z: "h2h_set_ratio", Y: "h2h_set_ratio" },
      },
      {
        title: "TT-TB-1 level on match points and games among them: their points ratio (ITTF 3.7.5.2, RBS:228)",
        // P 3-1 Q 46-40, Q 3-1 R 42-40, R 3-1 P 44-40. Games 4-4 each. Points R 84/82, P 86/84, Q 82/86.
        matches: [tt("P", "Q", 3, 1, 46, 40), tt("Q", "R", 3, 1, 42, 40), tt("R", "P", 3, 1, 44, 40)],
        expect: ["R", "P", "Q"],
        splits: { R: "h2h_point_ratio", P: "h2h_point_ratio", Q: "h2h_point_ratio" },
      },
      {
        title: "TT-TB-1 level on every head-to-head ratio: lots (ITTF 3.7.5.4, RBS:229)",
        // A 3-1 B, B 3-1 C, C 3-1 A, each 44-40 → the stored draw B, C, A.
        matches: [tt("A", "B", 3, 1, 44, 40), tt("B", "C", 3, 1, 44, 40), tt("C", "A", 3, 1, 44, 40)],
        lots: [["B", "C", "A"]],
        expect: ["B", "C", "A"],
        splits: { B: "lots", C: "lots", A: "lots" },
        old: ["A", "B", "C"],
      },
    ],
  },

  tennis: {
    signed: ["wins", "matches_played", "h2h_two", "set_ratio", "h2h_two", "game_ratio", "h2h_two", "seed", "lots"],
    old: ["points", "set_ratio", "game_ratio", "h2h_points", "seed"],
    cases: [
      {
        title: "TN-TB-1 ATP C.3-2 most matches played: a 2-1 record above 2-0 (RBS:368)",
        // A beat B 2-1 and C 2-0, then withdrew; B beat C and D. B 2-1 (3 played), A 2-0 (2 played).
        matches: [tn("A", "B", 2, 1, 16, 14), tn("A", "C", 2, 0, 12, 5), tn("B", "C", 2, 0, 12, 6), tn("B", "D", 2, 1, 15, 14), tn("C", "D", 2, 0, 12, 8)],
        expect: ["B", "A", "C", "D"],
        splits: { B: "matches_played", A: "matches_played", C: null, D: null },
        without: { at: 1, expect: ["A", "B", "C", "D"] },
        old: ["A", "B", "C", "D"],
      },
      {
        title: "TN-TB-1 ATP C.3-3 two tied: head-to-head (RBS:369)",
        // B beat A 2-1, C beat B 2-0, A beat D 2-0. A, B: 1 win, 2 played → B beat A. C: 1 win, 1 played.
        matches: [tn("B", "A", 2, 1, 16, 14), tn("C", "B", 2, 0, 12, 6), tn("A", "D", 2, 0, 12, 4)],
        expect: ["B", "A", "C", "D"],
        splits: { B: "h2h_two", A: "h2h_two", C: "matches_played", D: null },
        without: { at: 2, expect: ["A", "B", "C", "D"] },
        old: ["C", "A", "B", "D"],
      },
      {
        title: "TN-TB-1 ATP C.3-4 three tied: % sets, and the two left: head-to-head (RBS:370-371)",
        // A 2-1 B, B 2-1 C, C 2-0 A; each beat D (A 2-0, B 2-0, C 2-1). Sets B 5/3, C 5/3, A 4/3 → A third; B beat C.
        // Games would say C (43/31) above B (43/39).
        matches: [
          tn("A", "B", 2, 1, 16, 14), tn("B", "C", 2, 1, 17, 15), tn("C", "A", 2, 0, 12, 0),
          tn("A", "D", 2, 0, 12, 6), tn("B", "D", 2, 0, 12, 8), tn("C", "D", 2, 1, 16, 14),
        ],
        expect: ["B", "C", "A", "D"],
        splits: { B: "h2h_two", C: "h2h_two", A: "set_ratio", D: null },
        without: { at: 4, expect: ["C", "B", "A", "D"] },
        old: ["C", "B", "A", "D"],
      },
      {
        title: "TN-TB-1 ATP C.3-4 three tied on sets: % games, and the two left: head-to-head (RBS:370-371)",
        // A 2-1 B, B 2-1 C, C 2-1 A (16-14 each); each beat D 2-0 (A 12-4, B 12-0, C 12-4). Games B 42/30, A 42/34,
        // C 42/34 → C beat A. Seeds A 1, C 2 (the next step would put A above C).
        matches: [
          tn("A", "B", 2, 1, 16, 14), tn("B", "C", 2, 1, 16, 14), tn("C", "A", 2, 1, 16, 14),
          tn("A", "D", 2, 0, 12, 4), tn("B", "D", 2, 0, 12, 0), tn("C", "D", 2, 0, 12, 4),
        ],
        seeds: { A: 1, C: 2 },
        expect: ["B", "C", "A", "D"],
        splits: { B: "game_ratio", C: "h2h_two", A: "h2h_two", D: null },
        without: { at: 6, expect: ["B", "A", "C", "D"] },
      },
      {
        title: "TN-TB-1 three tied throughout: the seed, then lots (RBS:371; deviation: ATP stops at the ranking)",
        // A 2-1 B, B 2-1 C, C 2-1 A (16-14 each); each beat D 2-0 12-4. A seeded 1; B, C unseeded → the stored draw C, B.
        matches: [
          tn("A", "B", 2, 1, 16, 14), tn("B", "C", 2, 1, 16, 14), tn("C", "A", 2, 1, 16, 14),
          tn("A", "D", 2, 0, 12, 4), tn("B", "D", 2, 0, 12, 4), tn("C", "D", 2, 0, 12, 4),
        ],
        seeds: { A: 1 },
        lots: [["C", "B"]],
        expect: ["A", "C", "B", "D"],
        splits: { A: "seed", C: "lots", B: "lots", D: null },
        old: ["A", "B", "C", "D"],
      },
    ],
    extras: [
      {
        title: "TN-TB-2 a won match tie-break counts as one set and one game (ATP 4.02, RB2A-11)",
        run: (module) => {
          // The doubles norm: no-ad games and a 10-point match tie-break as the deciding set (ITF App VI).
          const cfg = cfgOf(module, "doubles-noad-mtb10");
          const lineups = defaultLineupPair(module.positions);
          const [H, A] = [lineups.home.entrantId, lineups.away.entrantId];
          const summary = (home: number, away: number) => ({ type: "tennis.set_summary", payload: { home, away } });
          // 6-4, 4-6, then the match tie-break 10-8 to the home pair.
          const events = [{ type: "core.start", payload: {} }, summary(6, 4), summary(4, 6), summary(10, 8)].map((e, i) => makeEnvelope(i, e));
          const state = foldMatch(module, cfg, lineups, events, { strictFromSeq: 0 });
          const outcome = module.outcome(state);
          expect(outcome?.kind).toBe("win");
          if (outcome === null) throw new Error("the match decided nothing");
          const [home, away] = module.standingsDelta(outcome, cfg, { kind: "league" }, state);
          // Sets 2-1; games 6 + 4 + 1 = 11 against 4 + 6 = 10 (the tie-break's points are no games).
          expect([home.metrics["sets_won"], home.metrics["sets_lost"], home.metrics["games_won"], home.metrics["games_lost"]]).toEqual([2, 1, 11, 10]);
          expect([away.metrics["sets_won"], away.metrics["sets_lost"], away.metrics["games_won"], away.metrics["games_lost"]]).toEqual([1, 2, 10, 11]);
          expect([home.entrantId, away.entrantId]).toEqual([H, A]);
        },
      },
      {
        // The mirror: a side-blind credit (the game always to home, or to whichever side is asked first) passes the case above.
        title: "TN-TB-2 an away pair's won match tie-break is its one game, never the home pair's (ATP 4.02, RB2A-11)",
        run: (module) => {
          const cfg = cfgOf(module, "doubles-noad-mtb10");
          const lineups = defaultLineupPair(module.positions);
          const [H, A] = [lineups.home.entrantId, lineups.away.entrantId];
          const summary = (home: number, away: number) => ({ type: "tennis.set_summary", payload: { home, away } });
          // 3-6, 6-4, then the match tie-break 6-10 to the away pair.
          const events = [{ type: "core.start", payload: {} }, summary(3, 6), summary(6, 4), summary(6, 10)].map((e, i) => makeEnvelope(i, e));
          const state = foldMatch(module, cfg, lineups, events, { strictFromSeq: 0 });
          const outcome = module.outcome(state);
          expect(outcome).toMatchObject({ kind: "win", winner: A });
          if (outcome === null) throw new Error("the match decided nothing");
          const [home, away] = module.standingsDelta(outcome, cfg, { kind: "league" }, state);
          // Sets 1-2; games 3 + 6 = 9 against 6 + 4 + 1 = 11 (the tie-break's points are no games).
          expect([home.metrics["sets_won"], home.metrics["sets_lost"], home.metrics["games_won"], home.metrics["games_lost"]]).toEqual([1, 2, 9, 11]);
          expect([away.metrics["sets_won"], away.metrics["sets_lost"], away.metrics["games_won"], away.metrics["games_lost"]]).toEqual([2, 1, 11, 9]);
          expect([home.entrantId, away.entrantId]).toEqual([H, A]);
        },
      },
      {
        // A read path folds tolerant (core/events.ts: "every READ path passes nothing"), so a stored summary no strict write
        // admits — a level 10-10 — still replays, and the kernel banks it to away (applySetSummary: the higher score, else
        // away). The rule ties the game to the set, so the game goes where the set went, never to neither side.
        title: "TN-TB-2 a level match tie-break replayed from a tolerant read: its one game goes to the side its set went to (ATP 4.02, RB2A-11)",
        run: (module) => {
          const cfg = cfgOf(module, "doubles-noad-mtb10");
          const lineups = defaultLineupPair(module.positions);
          const [H, A] = [lineups.home.entrantId, lineups.away.entrantId];
          const summary = (home: number, away: number) => ({ type: "tennis.set_summary", payload: { home, away } });
          const events = [{ type: "core.start", payload: {} }, summary(6, 4), summary(4, 6), summary(10, 10)].map((e, i) => makeEnvelope(i, e));
          // premise: a strict write refuses the level summary; the tolerant read admits it.
          expect(() => foldMatch(module, cfg, lineups, events, { strictFromSeq: 0 })).toThrow(/not a reachable final score/);
          const state = foldMatch(module, cfg, lineups, events);
          const outcome = module.outcome(state);
          expect(outcome).toMatchObject({ kind: "win", winner: A });
          if (outcome === null) throw new Error("the match decided nothing");
          const [home, away] = module.standingsDelta(outcome, cfg, { kind: "league" }, state);
          // Sets 1-2 (the kernel's bank); games 6 + 4 = 10 against 4 + 6 + 1 = 11.
          expect([home.metrics["sets_won"], home.metrics["sets_lost"], home.metrics["games_won"], home.metrics["games_lost"]]).toEqual([1, 2, 10, 11]);
          expect([away.metrics["sets_won"], away.metrics["sets_lost"], away.metrics["games_won"], away.metrics["games_lost"]]).toEqual([2, 1, 11, 10]);
          expect([home.entrantId, away.entrantId]).toEqual([H, A]);
        },
      },
    ],
  },

  carrom: {
    signed: ["points", "wins", "set_ratio", "board_ratio", "point_ratio", "h2h_points", "lots"],
    old: ["points", "wins", "set_ratio", "board_ratio", "point_ratio", "h2h_points", "lots"],
    cases: [
      {
        title: "CA-TB-1 level on points: matches won, then board ratio (RB2B-27, the product order)",
        // A beat C (2 points, 1 win); B drew D and E (2 points, 0 wins). D, E 1 point, sets 1-1: boards E 6/6, D 5/7.
        matches: [
          match("A", "C", "h", carromSets([2, 0], [8, 4], [60, 40]), w2("h")),
          match("B", "D", "d", carromSets([1, 1], [7, 5], [55, 45]), w2("d")),
          match("B", "E", "d", carromSets([1, 1], [6, 6], [50, 50]), w2("d")),
        ],
        expect: ["A", "B", "E", "D", "C"],
        splits: { A: "wins", B: "wins", E: "board_ratio", D: "board_ratio", C: null },
      },
      {
        title: "CA-TB-1 level on points and wins: set ratio (RB2B-27)",
        // A beat C 2-0, B beat D 2-1: sets A 2/0, B 2/1; D 1/2 above C 0/2.
        matches: [match("A", "C", "h", carromSets([2, 0], [8, 2], [60, 30]), w2("h")), match("B", "D", "h", carromSets([2, 1], [8, 6], [60, 50]), w2("h"))],
        expect: ["A", "B", "D", "C"],
        splits: { A: "set_ratio", B: "set_ratio", D: "set_ratio", C: "set_ratio" },
      },
      {
        title: "CA-TB-1 level on sets and boards: point ratio (RB2B-27)",
        // A beat C 2-0 (boards 8-2, points 60-30), B beat D 2-0 (8-2, 60-40): points A 2.0, B 1.5; D 0.67, C 0.5.
        matches: [match("A", "C", "h", carromSets([2, 0], [8, 2], [60, 30]), w2("h")), match("B", "D", "h", carromSets([2, 0], [8, 2], [60, 40]), w2("h"))],
        expect: ["A", "B", "D", "C"],
        splits: { A: "point_ratio", B: "point_ratio", D: "point_ratio", C: "point_ratio" },
      },
      {
        title: "CA-TB-1 level on every ratio: head-to-head; level throughout: lots (RB2B-27)",
        // A beat B, B beat D, C beat A (each 2-1, boards 7-5, points 60-50); E drew F (1-1, 6-6, 50-50). C 2/1 sets → C;
        // A, B level on every ratio → A beat B. E, F → the stored draw F, E.
        matches: [
          match("A", "B", "h", carromSets([2, 1], [7, 5], [60, 50]), w2("h")),
          match("B", "D", "h", carromSets([2, 1], [7, 5], [60, 50]), w2("h")),
          match("C", "A", "h", carromSets([2, 1], [7, 5], [60, 50]), w2("h")),
          match("E", "F", "d", carromSets([1, 1], [6, 6], [50, 50]), w2("d")),
        ],
        lots: [["F", "E"]],
        expect: ["C", "A", "B", "F", "E", "D"],
        splits: { C: "set_ratio", A: "h2h_points", B: "h2h_points", F: "lots", E: "lots", D: null },
      },
    ],
  },

  generic: {
    signed: ["points", "diff", "for", "h2h_points", "lots"],
    old: ["points", "diff", "for", "h2h_points", "lots"],
    cases: [
      {
        title: "GN-TB-1 level on points: score difference (RBG:650, the product order)",
        cfg: "score",
        // A 3-0 C, B 2-1 D: A +3, B +1; D −1, C −3.
        matches: [match("A", "C", "h", genericScore(3, 0), w3("h")), match("B", "D", "h", genericScore(2, 1), w3("h"))],
        expect: ["A", "B", "D", "C"],
        splits: { A: "diff", B: "diff", D: "diff", C: "diff" },
      },
      {
        title: "GN-TB-1 level on points and difference: score for (RBG:650)",
        cfg: "score",
        // B 3-1 C, A 2-0 D: +2 each; for B 3, A 2. C, D −2; for C 1, D 0.
        matches: [match("B", "C", "h", genericScore(3, 1), w3("h")), match("A", "D", "h", genericScore(2, 0), w3("h"))],
        expect: ["B", "A", "C", "D"],
        splits: { B: "for", A: "for", C: "for", D: "for" },
      },
      {
        title: "GN-TB-1 level on points, difference and for: head-to-head; level throughout: lots (RBG:650)",
        cfg: "score",
        // A 1-0 B, B 1-0 C, D 1-0 A, E 1-1 F. D 3 (+1); A, B 3 (0, for 1) → A beat B. E, F → the stored draw F, E.
        matches: [
          match("A", "B", "h", genericScore(1, 0), w3("h")),
          match("B", "C", "h", genericScore(1, 0), w3("h")),
          match("D", "A", "h", genericScore(1, 0), w3("h")),
          match("E", "F", "d", genericScore(1, 1), w3("d")),
        ],
        lots: [["F", "E"]],
        expect: ["D", "A", "B", "F", "E", "C"],
        splits: { D: "diff", A: "h2h_points", B: "h2h_points", F: "lots", E: "lots", C: null },
      },
    ],
  },
};

// The sports whose pre-W2d order is the signed one (SPEC §5.10 "unchanged"; football's fifa2026 is the old default).
// Derived from the two typed orders above, so the list cannot rot: a differential against the old order is impossible
// for these, and the test says so by name rather than skipping it.
const UNCHANGED = Object.entries(BOOK)
  .filter(([, book]) => JSON.stringify(book.old) === JSON.stringify(book.signed))
  .map(([key]) => key)
  .sort();

/** Every position of `signed` some case decides: a primary split, a recorded key that occurs once, or a `without`. */
function decidedPositions(book: Book): Set<number> {
  const covered = new Set<number>();
  for (const c of book.cases) {
    const recorded = new Set(Object.values(c.splits));
    if (recorded.has(null)) covered.add(0);
    book.signed.forEach((key, i) => {
      const once = book.signed.indexOf(key) === book.signed.lastIndexOf(key);
      const modifier = key === "h2h_reapply" || key === "h2h_exclusion";
      if (i > 0 && once && !modifier && recorded.has(key)) covered.add(i);
    });
    if (c.without !== undefined) covered.add(c.without.at);
  }
  return covered;
}

describe("W2d T11 — rulebook scenarios per sport (spec §13.1)", () => {
  it("states the book's scope first: one book per registry sport, no book for a sport the registry lacks", () => {
    const registry = builtinModules.map((m) => m.key).sort();
    expect(registry.length).toBeGreaterThan(0);
    expect(Object.keys(BOOK).sort()).toEqual(registry);
    // §5.10 "unchanged": carrom and generic; football's default fifa2026 was already the pre-W2d order.
    expect(UNCHANGED).toEqual(["carrom", "football", "generic"]);
  });

  for (const module of builtinModules) {
    const book = BOOK[module.key];
    describe(module.key, () => {
      if (book === undefined) {
        it("has a book", () => expect.unreachable(`no rulebook scenarios for ${module.key}`));
        return;
      }

      it("ranks by SPEC §5.10's signed default for a round robin", () => {
        const cfg = cfgOf(module, undefined);
        expect(resolved(module, cfg).tiebreakers).toEqual(book.signed);
      });

      for (const c of book.cases) {
        it(c.title, () => {
          const cfg = cfgOf(module, c.cfg);
          const rules = resolved(module, cfg);
          const results = payAll(module, cfg, rules.points, c.matches);
          const table = (tiebreakers: Order) =>
            rank({
              rules: { ...rules, tiebreakers },
              results,
              winsCount: module.winsCount,
              ...(c.seeds === undefined ? {} : { seeds: c.seeds }),
              ...(c.lots === undefined ? {} : { lots: c.lots }),
            });

          const ranked = table(rules.tiebreakers);
          expect(ids(ranked.rows)).toEqual([...c.expect]);
          // The key that settled each row, as the rule text names it.
          expect(Object.fromEntries(ranked.rows.map((r) => [r.entrantId, r.tieBreak?.key ?? null]))).toEqual({ ...c.splits });
          // Every drawing of lots the rule reached is a stored one, and the rows say when it was drawn.
          expect(ranked.newDraws).toBe(0);
          for (const r of ranked.rows.filter((row) => row.tieBreak?.key === "lots")) expect(r.tieBreak?.drawnAt, r.entrantId).toBe(DRAWN_AT);

          if (c.without !== undefined) {
            const at = c.without.at;
            expect(at, "a primary measure is never removed").toBeGreaterThan(0);
            expect(ids(table(rules.tiebreakers.filter((_, i) => i !== at)).rows)).toEqual([...c.without.expect]);
          }
          if (c.old !== undefined) expect(ids(table(book.old).rows)).toEqual([...c.old]);
        });
      }

      for (const extra of book.extras ?? []) it(extra.title, () => extra.run(module));

      it(`decides every position of its default, and orders differently from its pre-W2d order at least once`, () => {
        const covered = decidedPositions(book);
        const exempt = Object.keys(book.cannotDecide ?? {}).map(Number);
        // An exemption is a guard, not a comment: it names a real position nothing else covers.
        for (const i of exempt) {
          expect(i, "an exempt position is a position").toBeLessThan(book.signed.length);
          expect(covered.has(i), `position ${i} is exempt and also covered`).toBe(false);
        }
        const missing = book.signed.map((_, i) => i).filter((i) => !covered.has(i) && !exempt.includes(i));
        expect(missing, `positions of ${book.signed.join(", ")} no case decides`).toEqual([]);
        expect(covered.size + exempt.length).toBe(book.signed.length);

        const differentials = book.cases.filter((c) => c.old !== undefined && JSON.stringify(c.old) !== JSON.stringify(c.expect)).length;
        if (UNCHANGED.includes(module.key)) {
          expect(book.old).toEqual(book.signed);
          expect(differentials).toBe(0);
        } else {
          expect(differentials).toBeGreaterThan(0);
        }
      });
    });
  }
});
