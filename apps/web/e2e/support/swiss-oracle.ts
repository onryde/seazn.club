// W3 Swiss app-B Task 10 (SW-L10) - the e2e's OWN rulebook oracle for a Swiss table: table points, Buchholz and Buchholz Cut-1
// with the unplayed-round rules, and the order a tie-break chain gives. Written from the rulebook, never from the product:
//   - rulebook-W3-swiss.md §4 (byes, late entries, withdrawals; "Non-chess scaling") and FIDE C.07 (1 March 2026) art. 16
//     (16.2 categories, 16.3 adjusted scores, 16.4 the dummy and its cap, 16.5 Cut-1 cuts a voluntarily unplayed round first);
//   - rulebook-W3-swiss.md §5 (the chains) and §6 (the cut: the chain without `lots`, then flagged).
// This file imports NOTHING - not the product, not the engine. Its inputs are what the test itself recorded (who sat where, who
// won, the games' scores) and the values the engine DECLARES, read by the spec through the API (`GET /api/v1/stages/{id}`
// serves the stage's points rule and its tie-break order): the oracle checks the product against the rulebook, so a value
// computed by the code under test would make it circular. Its own unit test (`src/lib/__tests__/swiss-oracle.test.ts`) pins
// it to the engine plan's hand-derived S1-S5 numbers.
//
// Units: everything here is in the stage's TABLE points as stored (a chess win is 2 half-points). `display` turns a stored
// value into the number the table prints (half-points halved; whole points as they are).

/** One board (or bye) of a Swiss stage, as the test recorded it. */
export interface OracleFixture {
  readonly round: number;
  readonly home: string;
  /** null: a pairing-allocated bye held by `home` (rulebook §4, C.07 16.2.1). */
  readonly away: string | null;
  /** The winner's id, or null for a draw. A bye needs none (it is `home`'s win). */
  readonly winner: string | null;
  /** Games (sets) won by home and away - a set sport's result. */
  readonly sets?: readonly [number, number];
  /** Rally points won by home and away over the whole match. */
  readonly points?: readonly [number, number];
  /** Goals scored by home and away - a goals sport's result (rulebook §5, the goals family). */
  readonly goals?: readonly [number, number];
}

/** The part of the engine's declared points rule (`PointsRule`) the oracle reads - typed here, structurally, not imported. */
export interface DeclaredPointsRule {
  readonly win: { readonly regulation: number };
  readonly loss: { readonly regulation: number };
  readonly draw?: number;
  readonly bySetScore?: Readonly<Record<string, readonly [number, number]>>;
  readonly unit: "whole" | "half";
}

/** Opponents of a Swiss stage and how its unplayed rounds score (rulebook §4). */
export interface LedgerOpts {
  readonly rule: DeclaredPointsRule;
  /** The stage's rounds as declared (rulebook §4: never the length of an entrant's own card). */
  readonly rounds: number;
  /** A draw's table points: the rule's draw where a draw can stand, else half a (clean-sweep) win - see `drawPointsOf`. */
  readonly drawPoints: number;
  /** Per entrant, the rounds it was in the stage but held no seat (a late entrant's missed rounds). */
  readonly absent?: ReadonlyMap<string, readonly number[]>;
}

/** A refusal: the oracle does not guess at a shape it does not model. */
export class OracleRefusal extends Error {}

const refuse = (why: string): never => {
  throw new OracleRefusal(`swiss-oracle: ${why}`);
};

/** The payout tuple a set-score rule names for a W-L result (`"W-L"`, else `"*"`), as [winner's points, loser's points]. */
function bySetScore(rule: DeclaredPointsRule, won: number, lost: number): readonly [number, number] {
  const table = rule.bySetScore!;
  return table[`${won}-${lost}`] ?? table["*"] ?? refuse(`the set-score rule names no payout for ${won}-${lost} and no "*"`);
}

/** A bye's points: the win (rulebook §4 "Pairing-allocated bye: win points"); under a set-score rule, the clean sweep's. */
function byePoints(rule: DeclaredPointsRule): number {
  if (rule.bySetScore === undefined) return rule.win.regulation;
  const keys = Object.keys(rule.bySetScore);
  if (keys.length !== 1 || keys[0] !== "*") refuse(`a bye under a set-score rule with keys ${JSON.stringify(keys)} needs the sport's sets to win`);
  return rule.bySetScore["*"]![0];
}

/** A draw's table points for the dummy cap (rulebook §4 "Non-chess scaling"; C.07 7.7): the declared draw where the stage can
 *  draw, otherwise half a win. */
export function drawPointsOf(rule: DeclaredPointsRule, drawReachable: boolean): number {
  if (drawReachable) return rule.draw ?? refuse("a draw is reachable but the rule declares no draw points");
  return byePoints(rule) / 2;
}

/** What one side of `f` scores on the table. */
function sidePoints(f: OracleFixture, side: string, rule: DeclaredPointsRule): number {
  if (f.away === null) return byePoints(rule);
  if (f.winner === null) {
    if (rule.bySetScore !== undefined) refuse(`round ${f.round}: a draw under a set-score rule`);
    return rule.draw ?? refuse(`round ${f.round}: a draw under a rule that declares none`);
  }
  if (f.winner !== f.home && f.winner !== f.away) refuse(`round ${f.round}: the winner ${f.winner} is not on the board`);
  const won = f.winner === side;
  if (rule.bySetScore !== undefined) {
    const sets = f.sets ?? refuse(`round ${f.round}: a set-score rule needs the board's sets`);
    const [w, l] = f.winner === f.home ? sets : [sets[1], sets[0]];
    const pay = bySetScore(rule, w, l);
    return won ? pay[0] : pay[1];
  }
  return won ? rule.win.regulation : rule.loss.regulation;
}

/** Every entrant's table points: the sum over its boards and byes (rulebook §4; a missed round scores 0 and is not on it). */
export function tablePoints(fixtures: readonly OracleFixture[], rule: DeclaredPointsRule): Map<string, number> {
  const out = new Map<string, number>();
  const add = (id: string, n: number) => out.set(id, (out.get(id) ?? 0) + n);
  for (const f of fixtures) {
    add(f.home, sidePoints(f, f.home, rule));
    if (f.away !== null) add(f.away, sidePoints(f, f.away, rule));
  }
  return out;
}

/** The number the table prints for a stored value (`unit: "half"`: half-points shown halved). */
export function display(value: number, unit: DeclaredPointsRule["unit"]): number {
  return unit === "half" ? value / 2 : value;
}

type CardKind = "played" | "bye" | "absent" | "absent_last";
interface Card {
  readonly round: number;
  readonly kind: CardKind;
  readonly opponent?: string;
}

/** The entrant's tie-break card in round order (C.07 16.2): played rounds, byes, and missed rounds - a missed round followed
 *  by a played or bye round is 16.2.3 (`absent`), one followed by nothing but missed rounds is 16.2.5 (`absent_last`). */
function cardOf(fixtures: readonly OracleFixture[], entrant: string, opts: LedgerOpts): Card[] {
  const cards: { round: number; kind: CardKind | "missed"; opponent?: string }[] = [];
  for (const f of fixtures) {
    if (f.home !== entrant && f.away !== entrant) continue;
    if (f.away === null) cards.push({ round: f.round, kind: "bye" });
    else cards.push({ round: f.round, kind: "played", opponent: f.home === entrant ? f.away : f.home });
  }
  for (const r of opts.absent?.get(entrant) ?? []) {
    if (!Number.isInteger(r) || r < 1 || r > opts.rounds) refuse(`${entrant}: absent round ${r} is outside 1..${opts.rounds}`);
    if (cards.some((c) => c.round === r)) refuse(`${entrant}: absent in round ${r}, where it holds a card`);
    cards.push({ round: r, kind: "missed" });
  }
  cards.sort((a, b) => a.round - b.round);
  return cards.map((c, i) => {
    if (c.kind !== "missed") return c as Card;
    const playedLater = cards.slice(i + 1).some((later) => later.kind !== "missed");
    return { round: c.round, kind: playedLater ? "absent" : "absent_last" };
  });
}

/** The ledger: each entrant's score, its adjusted score (16.3.2: + a draw for every 16.2.5 round) and its card. */
function ledger(fixtures: readonly OracleFixture[], opts: LedgerOpts) {
  const scores = tablePoints(fixtures, opts.rule);
  for (const id of opts.absent?.keys() ?? []) if (!scores.has(id)) scores.set(id, 0);
  const cards = new Map([...scores.keys()].map((id) => [id, cardOf(fixtures, id, opts)]));
  const adjusted = new Map(
    [...scores].map(([id, s]) => [id, s + opts.drawPoints * cards.get(id)!.filter((c) => c.kind === "absent_last").length]),
  );
  return { scores, cards, adjusted };
}

/** Each card's contribution to the entrant's Buchholz: a played round reads the opponent's ADJUSTED score (16.3); an own
 *  unplayed round (a bye, a missed round) scores against a dummy at the entrant's own score, capped at draw points x rounds
 *  (16.4.2; rulebook §4 "Non-chess scaling"). */
function contributions(fixtures: readonly OracleFixture[], entrant: string, opts: LedgerOpts) {
  const { scores, cards, adjusted } = ledger(fixtures, opts);
  const own = scores.get(entrant) ?? refuse(`${entrant} is not on the table`);
  const cap = opts.drawPoints * opts.rounds;
  return cards.get(entrant)!.map((c) => ({
    kind: c.kind,
    value: c.kind === "played" ? adjusted.get(c.opponent!)! : Math.min(own, cap),
  }));
}

/** Buchholz in stored table points: the sum of the card's contributions. */
export function buchholz(fixtures: readonly OracleFixture[], entrant: string, opts: LedgerOpts): number {
  return contributions(fixtures, entrant, opts).reduce((s, c) => s + c.value, 0);
}

/** Buchholz Cut-1 (16.5): the lowest contribution of a voluntarily unplayed round is cut first (a missed round is one; a
 *  pairing-allocated bye is not), otherwise the lowest contribution of all. */
export function buchholzCut1(fixtures: readonly OracleFixture[], entrant: string, opts: LedgerOpts): number {
  const parts = contributions(fixtures, entrant, opts);
  if (parts.length === 0) return 0;
  const vurs = parts.filter((p) => p.kind === "absent" || p.kind === "absent_last");
  const cut = Math.min(...(vurs.length > 0 ? vurs : parts).map((p) => p.value));
  return parts.reduce((s, p) => s + p.value, 0) - cut;
}

/** Opponents' collective goal difference (rulebook §5 "New keys": `opp_diff`, the goals family's UEFA criterion): the sum of
 *  every played opponent's own goal difference over the whole stage. The rulebook defines no unplayed-round value for it, so a
 *  bye anywhere on the table is a refusal, not a guess. */
export function oppDiff(fixtures: readonly OracleFixture[], entrant: string): number {
  const gd = new Map<string, number>();
  for (const f of fixtures) {
    if (f.away === null) refuse(`round ${f.round}: opp_diff over a bye is not modelled`);
    const [h, a] = f.goals ?? refuse(`round ${f.round}: opp_diff needs the board's goals`);
    gd.set(f.home, (gd.get(f.home) ?? 0) + h - a);
    gd.set(f.away!, (gd.get(f.away!) ?? 0) + a - h);
  }
  if (!gd.has(entrant)) refuse(`${entrant} is not on the table`);
  return fixtures
    .filter((f) => f.home === entrant || f.away === entrant)
    .reduce((s, f) => s + gd.get(f.home === entrant ? f.away! : f.home)!, 0);
}

/** A row the chain ranks: the entrant's value under each key the test can state. A key the chain reaches for a tied group
 *  and the row does not carry is a refusal, never a guess. */
export interface ChainRow {
  readonly entrant: string;
  readonly values: Readonly<Partial<Record<string, number>>>;
}

/** Ratio keys over a won/lost pair: more won per lost ranks higher; nothing lost ranks above any finite ratio. */
export function ratio(won: number, lost: number): number {
  return lost === 0 ? (won === 0 ? 0 : Number.POSITIVE_INFINITY) : won / lost;
}

/** The order a chain gives (rulebook §5, §6.2): entrants best first, and `cut[i]` = the key that separates `order[i]` from
 *  `order[i + 1]`, or null where the two are level through every key before `lots` (the members of a level group are listed
 *  in no particular order: §6.2 flags such a tie, it never orders it). `direct` splits a level group only when every member
 *  has met every other (the head-to-head points among them); otherwise the group stays level at that key. */
export interface ChainRank {
  readonly order: readonly string[];
  readonly cut: readonly (string | null)[];
}

const KNOWN_KEYS = new Set(["points", "buchholz_cut1", "buchholz", "set_ratio", "point_ratio", "wins", "direct", "lots"]);

export function rankByChain(rows: readonly ChainRow[], chain: readonly string[], fixtures: readonly OracleFixture[]): ChainRank {
  for (const k of chain) if (!KNOWN_KEYS.has(k)) refuse(`the chain key "${k}" is not modelled`);
  const valueOf = (id: string, key: string) => {
    const v = rows.find((r) => r.entrant === id)?.values[key];
    return v ?? refuse(`${id} carries no ${key}, and a tie reaches it`);
  };
  /** Head-to-head points among `group` - null unless every pair of it met (a played board). */
  const direct = (group: readonly string[]): Map<string, number> | null => {
    const pts = new Map(group.map((id) => [id, 0]));
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        const met = fixtures.filter((f) => f.away !== null && [f.home, f.away].includes(a) && [f.home, f.away].includes(b));
        if (met.length === 0) return null;
        for (const f of met) {
          if (f.winner === null) {
            pts.set(a, pts.get(a)! + 1);
            pts.set(b, pts.get(b)! + 1);
          } else pts.set(f.winner, pts.get(f.winner)! + 2);
        }
      }
    }
    return pts;
  };
  // Groups best first; `boundary[g]` = the key that split group g from group g + 1.
  let groups: string[][] = [rows.map((r) => r.entrant)];
  let boundary: string[] = [];
  for (const key of chain) {
    if (key === "lots") break;
    const nextGroups: string[][] = [];
    const nextBoundary: string[] = [];
    groups.forEach((group, g) => {
      let parts: string[][];
      if (group.length < 2) parts = [group];
      else {
        const scoreOf = key === "direct" ? direct(group) : new Map(group.map((id) => [id, valueOf(id, key)]));
        if (scoreOf === null) parts = [group];
        else {
          const values = [...new Set(group.map((id) => scoreOf.get(id)!))].sort((x, y) => y - x);
          parts = values.map((v) => group.filter((id) => scoreOf.get(id) === v));
        }
      }
      parts.forEach((p, i) => {
        nextGroups.push(p);
        if (i < parts.length - 1) nextBoundary.push(key);
      });
      if (g < groups.length - 1) nextBoundary.push(boundary[g]!);
    });
    groups = nextGroups;
    boundary = nextBoundary;
  }
  const order: string[] = [];
  const cut: (string | null)[] = [];
  groups.forEach((group, g) => {
    group.forEach((id, i) => {
      order.push(id);
      if (i < group.length - 1) cut.push(null);
      else if (g < groups.length - 1) cut.push(boundary[g]!);
    });
  });
  return { order, cut };
}

/** The level groups of a chain rank, best first: each a set of positions (0-based) the members may occupy in any order. */
export function levelGroups(rank: ChainRank): string[][] {
  const out: string[][] = [[]];
  rank.order.forEach((id, i) => {
    out[out.length - 1]!.push(id);
    if (i < rank.order.length - 1 && rank.cut[i] !== null) out.push([]);
  });
  return out;
}
