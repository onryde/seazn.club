// Post #12, "When is a tie settled by drawing lots?".
//
// THE TABLE, a generic division (the score variant a new one starts on): three teams play a real round robin (seeded
// walks, refolded by the app's read fold) in which Larks and Owls draw with each other and both beat Wrens by the same
// score. Larks and Owls are then level on everything the sport's order checks, so the last step, a drawing of lots,
// decides. Ranked through the app's ranking path three times:
//   1. as a first ranking does: no draw stored, so the lots are drawn with the stage's own fixed seed number;
//   2. again, with that draw STORED and the stage's seed number changed: the stored draw stands (a draw is made once);
//   3. with a seeding step placed before the lots (as tennis, ice hockey and cricket have): the better seed goes higher.
//   4. with the same seeding step, but only Owls seeded: a seeded team goes ahead of an unseeded one, and with nobody seeded
//      the step splits nothing and the lots decide as before;
//   5. a different table, where all three teams draw all three matches: the stored draw was for Larks and Owls alone, so it is
//      not used for the three of them: the new group is drawn on its own.
// The fixed seed number is part of the fixture, chosen so the draw and the seeding disagree (a claim pins that they do).
//
// THE FACTS, every sport: whether its declared league order checks seeding before it draws lots.
//
// WHAT CHECKS IT. The two level teams are read off the table's cells; the drawn order is checked against the engine's
// declared draw (`lotSeed` of the stage's seed number and the tied set, then its `shuffle`) recomputed here, not read from
// the ranking; the seeding place against the seed column; the per-sport facts against each DECLARED order.
import { shuffle } from "@seazn/engine/core";
import { FOR_KEYS, lotSeed, membersKeyOf, metricOf, type MembersKey, type StoredLotsDraw } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule, TiebreakerKey } from "@seazn/engine/sport";
import { defaultOrderOf, forEachSport } from "@seazn/engine/testkit";
import { sportLabel } from "@/blog/labels";
import { standingsLabel } from "@/blog/labels-screens";
import { placeOf, placeText, playAndRank, scoreOf, rowOf, signed, stageRules, type MatchView, type Meeting } from "./tie-break-play";
import type { BlogExample, Claim, ExampleResult } from "./types";
import { startingCfg } from "./kit";

export const DRAWING_LOTS_ID = "drawing-lots";

export const COLUMNS = ["Team", "Seed", "Points", "Difference", "Scored", "Points in their own match", "Place, by drawing lots", "Place, seeding before lots"];
export const C = { team: 0, seed: 1, points: 2, diff: 3, scored: 4, h2h: 5, lots: 6, seeding: 7 } as const;

const TEAMS = [
  { id: "larks", name: "Larks", seed: 2 },
  { id: "owls", name: "Owls", seed: 1 },
  { id: "wrens", name: "Wrens", seed: 3 },
];
const nameOf = (id: string) => TEAMS.find((t) => t.id === id)!.name;
/** The stage's stored seed number, which every drawing of lots in it folds in. A fixture value: see the header. */
export const RNG_SEED = 1;
/** Another seed number, to show a stored draw does not move when the stage's number does. */
const OTHER_RNG_SEED = RNG_SEED + 1000;

const scored = (h: number, a: number) => (v: MatchView) => metricOf(v.home, FOR_KEYS) === h && metricOf(v.away, FOR_KEYS) === a;

const MEETINGS: Meeting[] = [
  { home: "larks", away: "owls", what: "Larks 1-1 Owls", seed: 14, want: scored(1, 1) },
  { home: "larks", away: "wrens", what: "Larks 2-0 Wrens", seed: 21, want: scored(2, 0) },
  { home: "owls", away: "wrens", what: "Owls 2-0 Wrens", seed: 21, want: scored(2, 0) },
];

/** The second table's matches: every team draws every match, so all three are level on everything and the lots are for the three. */
const ALL_DRAWN: Meeting[] = [
  { home: "larks", away: "owls", what: "Larks 1-1 Owls", seed: 14, want: scored(1, 1) },
  { home: "larks", away: "wrens", what: "Larks 1-1 Wrens", seed: 14, want: scored(1, 1) },
  { home: "owls", away: "wrens", what: "Owls 1-1 Wrens", seed: 14, want: scored(1, 1) },
];

const generic = () => builtinModules.find((m) => m.key === "generic")!;

/** The same teams with seeds only where `keep` says so (a team with no seed is not seeded at all). */
const withSeedsFor = (keep: (id: string) => boolean) => TEAMS.map((t) => (keep(t.id) ? t : { id: t.id, name: t.name }));

/** The sport's own order with a seeding step put in just before the drawing of lots. */
function withSeedingBeforeLots(order: readonly TiebreakerKey[]): TiebreakerKey[] {
  const i = order.indexOf("lots");
  if (i === -1) throw new Error("the order has no drawing of lots");
  return [...order.slice(0, i), "seed", ...order.slice(i)];
}

/** Whether an order checks seeding before its drawing of lots, in a reader's words. */
export function seedingWords(order: readonly TiebreakerKey[]): string {
  const seed = order.indexOf("seed");
  const lots = order.indexOf("lots");
  if (lots === -1) return "no drawing of lots";
  return seed !== -1 && seed < lots ? "seeding first, then lots" : "lots";
}

function build(): ExampleResult {
  const sport = generic();
  const cfg = startingCfg(sport);
  const first = playAndRank({ module: sport, cfg, kind: "league", entrants: TEAMS, meetings: MEETINGS, rngSeed: RNG_SEED });
  if (first.newLotsDraws.length !== 1) throw new Error(`drawing-lots: ${first.newLotsDraws.length} draws, one expected`);
  const drawn = first.newLotsDraws[0]!;
  // The draw as the app stores it (stage_lots_draws: the tied set's key, the drawn order, the date the database stamps).
  const stored = new Map<string, ReadonlyMap<MembersKey, StoredLotsDraw>>([["", new Map([[drawn.membersKey, { order: drawn.drawnOrder, drawnAt: "2026-11-20T10:00:00.000Z" }]])]]);
  const again = playAndRank({ module: sport, cfg, kind: "league", entrants: TEAMS, meetings: MEETINGS, rngSeed: OTHER_RNG_SEED, lotsDraws: stored });
  const seeded = playAndRank({ module: sport, cfg, kind: "league", entrants: TEAMS, meetings: MEETINGS, rngSeed: RNG_SEED, stageOrder: withSeedingBeforeLots(first.rules.tiebreakers) });
  const seedStep = withSeedingBeforeLots(first.rules.tiebreakers);
  const onlyOwls = playAndRank({ module: sport, cfg, kind: "league", entrants: withSeedsFor((id) => id === "owls"), meetings: MEETINGS, rngSeed: RNG_SEED, stageOrder: seedStep });
  const noSeeds = playAndRank({ module: sport, cfg, kind: "league", entrants: withSeedsFor(() => false), meetings: MEETINGS, rngSeed: RNG_SEED, stageOrder: seedStep });
  // The three-way table, ranked with the pair's draw stored: that draw belongs to the pair, not to the three.
  const three = playAndRank({ module: sport, cfg, kind: "league", entrants: TEAMS, meetings: ALL_DRAWN, rngSeed: RNG_SEED, lotsDraws: stored });
  const firstOf = (r: typeof first) => nameOf([...r.rows].sort((a, b) => a.rank! - b.rank!)[0]!.entrantId);

  const mini = (id: string) => {
    const p = first.played.find((x) => x.meeting.home === "larks" && x.meeting.away === "owls")!;
    const d = p.result.find((x) => x.entrantId === id);
    return d === undefined ? "Not in it" : d.points;
  };
  const rows = [...first.rows]
    .sort((a, b) => a.rank! - b.rank!)
    .map((r) => {
      const t = TEAMS.find((x) => x.id === r.entrantId)!;
      return [t.name, t.seed, r.points, signed(r.metrics.diff ?? metricOf(r, ["diff"]) ?? 0), metricOf(r, FOR_KEYS) ?? 0, r.entrantId === "wrens" ? "Not in it" : mini(r.entrantId), placeText(r.rank!), placeText(rowOf(seeded.rows, r.entrantId).rank!)];
    });

  const facts: ExampleResult["facts"] = {};
  const byLots = [...first.rows].sort((a, b) => a.rank! - b.rank!).map((r) => r.entrantId);
  facts.lotsFirst = nameOf(byLots[0]!);
  facts.lotsSecond = nameOf(byLots[1]!);
  facts.lastPlace = nameOf(byLots[2]!);
  facts.lastPlaceNumber = placeText(rowOf(first.rows, byLots[2]!).rank!);
  facts.onlyOwlsSeededFirst = firstOf(onlyOwls);
  facts.onlyOwlsSeededSplitBy = standingsLabel(rowOf(onlyOwls.rows, "owls").tieBreak?.key ?? "points", "generic");
  facts.noSeedsFirst = firstOf(noSeeds);
  facts.noSeedsSplitBy = standingsLabel(rowOf(noSeeds.rows, byLots[0]!).tieBreak?.key ?? "points", "generic");
  facts.threeWayDrawsMade = three.newLotsDraws.length;
  facts.threeWayGroupSize = three.newLotsDraws[0]?.drawnOrder.length ?? 0;
  facts.threeWayFirst = firstOf(three);
  facts.threeWayLast = nameOf([...three.rows].sort((a, b) => a.rank! - b.rank!)[2]!.entrantId);
  facts.seedingFirst = nameOf([...seeded.rows].sort((a, b) => a.rank! - b.rank!)[0]!.entrantId);
  facts.storedFirst = nameOf([...again.rows].sort((a, b) => a.rank! - b.rank!)[0]!.entrantId);
  facts.storedDrawsMade = again.newLotsDraws.length;
  facts.lotsSplitBy = standingsLabel(rowOf(first.rows, byLots[0]!).tieBreak?.key ?? "points", "generic");
  facts.seedingSplitBy = standingsLabel(rowOf(seeded.rows, "owls").tieBreak?.key ?? "points", "generic");
  facts.levelPoints = rowOf(first.rows, "larks").points;
  facts.larksOwlsDraw = first.played.find((x) => x.meeting.home === "larks" && x.meeting.away === "owls")!.view.headline;
  facts.genericOrder = first.rules.tiebreakers.slice(1).map((k) => standingsLabel(k, "generic")).join(", ");
  const seedSports: string[] = [];
  const visited = forEachSport(({ module: m }) => {
    const order = stageRules(m, startingCfg(m), "league").tiebreakers;
    facts[`${m.key}LastSteps`] = seedingWords(order);
    if (seedingWords(order) === "seeding first, then lots") seedSports.push(sportLabel(m.key));
  });
  facts.sportCount = visited;
  facts.seedSports = seedSports.length < 2 ? (seedSports[0] ?? "none") : `${seedSports.slice(0, -1).join(", ")} and ${seedSports[seedSports.length - 1]}`;
  facts.seedSportCount = seedSports.length;
  const result: ExampleResult = {
    facts,
    table: { caption: "", columns: COLUMNS, rows },
    text: [
      ...first.played.map((p) => `${nameOf(p.meeting.home)} ${p.view.headline} ${nameOf(p.meeting.away)}.`),
      ...three.played.map((p) => `Second table: ${nameOf(p.meeting.home)} ${p.view.headline} ${nameOf(p.meeting.away)}.`),
    ],
  };
  result.table!.caption = captionOf(result);
  return result;
}

/** The caption, said from the table's own cells and the facts: the level teams, then the two ways to order them. */
export function captionOf(r: Pick<ExampleResult, "facts" | "table">): string {
  const rows = r.table?.rows ?? [];
  const level = rows.filter((x) => rows.some((y) => y !== x && [C.points, C.diff, C.scored].every((c) => x[c] === y[c]))).map((x) => String(x[C.team]));
  return `${level.join(" and ")} are level on points, difference and total scored, so a drawing of lots puts ${String(r.facts.lotsFirst)} first. With a seeding step before the lots, the seeding puts ${String(r.facts.seedingFirst)} first instead.`;
}

// ---- claims ----

const placeNum = placeOf;
const rowNamed = (r: ExampleResult, name: string) => (r.table?.rows ?? []).find((x) => x[C.team] === name);

const caseClaims: Claim[] = [
  {
    says: "Larks and Owls are level on points, difference and goals scored, and drew their own match",
    source: "the case's premise, read off the table (the generic order's every step before lots)",
    check(r) {
      const a = rowNamed(r, "Larks");
      const b = rowNamed(r, "Owls");
      if (a === undefined || b === undefined) return "Larks or Owls missing";
      for (const c of [C.points, C.diff, C.scored, C.h2h]) if (a[c] !== b[c]) return `they differ on ${COLUMNS[c]}`;
      const order = defaultOrderOf(generic(), "league");
      return order.join() === "points,diff,for,h2h_points,lots" || `the generic order is now [${order.join(", ")}]: the premise needs re-checking`;
    },
  },
  {
    says: "the drawing of lots is the declared draw for that tied pair and the stage's seed number",
    source: "lotSeed(rngSeed, sorted ids) and the core shuffle: the engine's declared draw, recomputed independently of the ranking",
    check(r) {
      const ids = ["larks", "owls"].sort();
      const order = shuffle(lotSeed(RNG_SEED, ids), ids);
      if (nameOf(order[0]!) !== r.facts.lotsFirst) return `the draw puts ${nameOf(order[0]!)} first, the fact says ${String(r.facts.lotsFirst)}`;
      const a = rowNamed(r, nameOf(order[0]!));
      const b = rowNamed(r, nameOf(order[1]!));
      if (a === undefined || b === undefined) return "rows missing";
      if (placeNum(a[C.lots]) >= placeNum(b[C.lots])) return "the lots column does not follow the draw";
      return r.facts.lotsSplitBy === standingsLabel("lots", "generic") || `split by ${String(r.facts.lotsSplitBy)}`;
    },
  },
  {
    says: "a stored draw stands: ranked again under another seed number, the same team is first and nothing new is drawn",
    source: "membersKeyOf / stored lots draws (stage_lots_draws), read before any new draw",
    check(r) {
      if (r.facts.storedFirst !== r.facts.lotsFirst) return `stored ${String(r.facts.storedFirst)}, drawn ${String(r.facts.lotsFirst)}`;
      if (membersKeyOf(["owls", "larks"]) !== membersKeyOf(["larks", "owls"])) return "the tied set's key depends on order";
      return r.facts.storedDrawsMade === 0 || `${String(r.facts.storedDrawsMade)} new draws`;
    },
  },
  {
    says: "with seeding before lots, the lower seed number goes higher, and that is not the team the lots chose (class 19)",
    source: "the seed column (seeding: a lower number ranks higher)",
    check(r) {
      const a = rowNamed(r, "Larks");
      const b = rowNamed(r, "Owls");
      if (a === undefined || b === undefined) return "rows missing";
      const seeds = (r.table?.rows ?? []).map((x) => x[C.seed]);
      if (seeds.some((v) => typeof v !== "number") || new Set(seeds).size !== seeds.length) return `the seeds are [${seeds.join(", ")}]: one number each`;
      if (JSON.stringify(seeds) !== JSON.stringify((r.table?.rows ?? []).map((x) => TEAMS.find((t) => t.name === x[C.team])?.seed))) return "the seed column is not the fixture's seeding";
      const better = Number(a[C.seed]) < Number(b[C.seed]) ? a : b;
      const worse = better === a ? b : a;
      if (placeNum(better[C.seeding]) >= placeNum(worse[C.seeding])) return "the seeding column does not follow the seeds";
      if (r.facts.seedingFirst !== better[C.team]) return `seedingFirst is ${String(r.facts.seedingFirst)}`;
      if (r.facts.seedingSplitBy !== standingsLabel("seed", "generic")) return `split by ${String(r.facts.seedingSplitBy)}`;
      return r.facts.seedingFirst !== r.facts.lotsFirst || "the draw and the seeding agree: pick another fixture seed number";
    },
  },
];

function sportClaim(module: AnySportModule): Claim {
  return {
    says: `${sportLabel(module.key)}: the last-steps fact says whether the declared league order checks seeding before lots`,
    source: "defaultOrderOf(module, \"league\")",
    sport: module.key,
    check(r) {
      const want = seedingWords(defaultOrderOf(module, "league"));
      return r.facts[`${module.key}LastSteps`] === want || `fact '${String(r.facts[`${module.key}LastSteps`])}', declared '${want}'`;
    },
  };
}

const factClaims: Claim[] = [
  {
    says: "the case's facts are the table's cells: the level points, the drawn match, and the two the lots ordered",
    source: "the example's table and result lines",
    check(r) {
      const a = rowNamed(r, "Larks");
      const b = rowNamed(r, "Owls");
      if (a === undefined || b === undefined) return "rows missing";
      if (r.facts.levelPoints !== a[C.points]) return `levelPoints ${String(r.facts.levelPoints)}`;
      const s = scoreOf(r.facts.larksOwlsDraw);
      if (s === null || s[0] !== s[1]) return `larksOwlsDraw reads '${String(r.facts.larksOwlsDraw)}'`;
      if (!r.text.includes(`Larks ${String(r.facts.larksOwlsDraw)} Owls.`)) return "larksOwlsDraw is not the played result";
      const byLots = [a, b].sort((x, y) => placeNum(x[C.lots]) - placeNum(y[C.lots])).map((x) => x[C.team]);
      return (r.facts.lotsFirst === byLots[0] && r.facts.lotsSecond === byLots[1]) || `lots facts ${String(r.facts.lotsFirst)}, ${String(r.facts.lotsSecond)}`;
    },
  },
  {
    says: "the generic order fact is the declared order after points, and the seeding sports are those whose declared order checks seeding before lots",
    source: "defaultOrderOf(module, \"league\") over the registry",
    check(r) {
      const want = defaultOrderOf(generic(), "league").slice(1).map((k) => standingsLabel(k, "generic")).join(", ");
      if (r.facts.genericOrder !== want) return `genericOrder '${String(r.facts.genericOrder)}', declared '${want}'`;
      const seeded: string[] = [];
      forEachSport(({ module }) => {
        const o = defaultOrderOf(module, "league");
        if (o.includes("seed") && o.indexOf("seed") < o.indexOf("lots")) seeded.push(sportLabel(module.key));
      });
      if (r.facts.seedSportCount !== seeded.length) return `seedSportCount ${String(r.facts.seedSportCount)}, declared ${seeded.length}`;
      const named = String(r.facts.seedSports).split(/, | and /);
      return JSON.stringify(named) === JSON.stringify(seeded) || `seedSports '${String(r.facts.seedSports)}', declared ${seeded.join(", ")}`;
    },
  },
];

const reachClaims: Claim[] = [
  {
    says: "the caption is the one said from the table's own cells and the facts",
    source: "the table's cells and the example's facts (nothing in it is typed)",
    check(r) {
      const want = captionOf(r);
      return r.table?.caption === want || `caption is '${String(r.table?.caption)}', the cells give '${want}'`;
    },
  },
  {
    says: "Wrens lose both matches 0-2, so they are paid nothing, finish behind the level pair under every ordering, and are in no draw",
    source: "the result lines (Larks 2-0 Wrens, Owls 2-0 Wrens) and the generic points rule's declared win, draw and loss points, recomputed here",
    check(r) {
      const cfg = startingCfg(generic());
      const points = stageRules(generic(), cfg, "league").points;
      const win = points.win.regulation;
      const loss = points.loss.regulation;
      const draw = points.draw;
      if (win === undefined || loss === undefined || draw === undefined) return `the generic rule has no regulation win/loss or draw points: ${JSON.stringify(points)}`;
      const wrensLines = r.text.filter((l) => !l.startsWith("Second table") && /\bWrens\.$/.test(l));
      if (wrensLines.length !== 2) return `${wrensLines.length} Wrens match lines`;
      let conceded = 0;
      for (const l of wrensLines) {
        const m = /(\d+) — (\d+)/.exec(l);
        if (m === null) return `a line reads '${l}'`;
        if (Number(m[2]) !== 0 || Number(m[1]) <= 0) return `Wrens did not lose 0-n in '${l}'`;
        conceded += Number(m[1]);
      }
      const wrens = rowNamed(r, "Wrens");
      if (wrens === undefined) return "no Wrens row";
      if (wrens[C.points] !== 2 * loss) return `Wrens points ${String(wrens[C.points])}, two losses pay ${2 * loss}`;
      if (wrens[C.scored] !== 0) return `Wrens scored ${String(wrens[C.scored])}`;
      if (Number(String(wrens[C.diff]).replace("−", "-")) !== -conceded) return `Wrens difference ${String(wrens[C.diff])}, the lines give ${-conceded}`;
      const level = rowNamed(r, "Larks");
      if (level === undefined) return "no Larks row";
      // The level pair: one win over Wrens and a draw between them.
      if (level[C.points] !== win + draw) return `the level pair's points ${String(level[C.points])}, a win and a draw pay ${win + draw}`;
      if (win + draw <= 2 * loss) return "the declared points do not put Wrens behind the level pair";
      for (const c of [C.lots, C.seeding]) if (placeNum(wrens[c]) !== 3) return `Wrens are ${String(wrens[c])} in ${COLUMNS[c]}`;
      // The match between the level pair is the head-to-head column's figure: a draw's point; Wrens were not in it.
      if (wrens[C.h2h] !== "Not in it") return `Wrens' own-match cell reads '${String(wrens[C.h2h])}', not 'Not in it'`;
      if (level[C.h2h] !== draw) return `the level pair's own-match points ${String(level[C.h2h])}, a draw pays ${draw}`;
      return r.facts.lastPlace === "Wrens" && r.facts.lastPlaceNumber === wrens[C.lots] || `lastPlace '${String(r.facts.lastPlace)}' / '${String(r.facts.lastPlaceNumber)}'`;
    },
  },
  {
    says: "a seeded team goes ahead of an unseeded one: with only Owls seeded, Owls are first even though the lots put Larks there, and the step that decided is seeding",
    source: "the seed comparator's declaration (a team with no seed ranks after every seeded team) read through a ranking with only one seed given",
    check(r) {
      if (r.facts.onlyOwlsSeededFirst !== "Owls") return `with only Owls seeded, ${String(r.facts.onlyOwlsSeededFirst)} is first`;
      // Class 19: the lots chose the other team, or a ranking that ignored the seed would pass.
      if (r.facts.lotsFirst === r.facts.onlyOwlsSeededFirst) return "the draw also puts Owls first: the case does not tell seeding from the draw";
      return r.facts.onlyOwlsSeededSplitBy === standingsLabel("seed", "generic") || `split by ${String(r.facts.onlyOwlsSeededSplitBy)}`;
    },
  },
  {
    says: "with nobody seeded the seeding step splits nothing and the lots decide as before",
    source: "the same ranking with no seeds given: equal on seeding, so the next step, the drawing of lots, with the same draw",
    check(r) {
      if (r.facts.noSeedsFirst !== r.facts.lotsFirst) return `with no seeds, ${String(r.facts.noSeedsFirst)} is first, the draw gave ${String(r.facts.lotsFirst)}`;
      return r.facts.noSeedsSplitBy === standingsLabel("lots", "generic") || `split by ${String(r.facts.noSeedsSplitBy)}`;
    },
  },
  {
    says: "a draw belongs to its exact group: a stored draw for Larks and Owls does not stand for the three of them, so the three are drawn on their own, as the engine's declared draw says",
    source: "membersKeyOf (the stored draw's key) and lotSeed + shuffle (the declared draw) recomputed for the group of three",
    check(r) {
      if (membersKeyOf(["larks", "owls"]) === membersKeyOf(["larks", "owls", "wrens"])) return "the pair and the three share a group key";
      if (r.facts.threeWayDrawsMade !== 1) return `${String(r.facts.threeWayDrawsMade)} new draws for the three (the pair's stored draw was used?)`;
      if (r.facts.threeWayGroupSize !== TEAMS.length) return `the new draw has ${String(r.facts.threeWayGroupSize)} teams`;
      const ids = ["larks", "owls", "wrens"].sort();
      const order = shuffle(lotSeed(RNG_SEED, ids), ids);
      if (nameOf(order[0]!) !== r.facts.threeWayFirst || nameOf(order[2]!) !== r.facts.threeWayLast) return `the draw puts ${order.map(nameOf).join(", ")}, the facts say ${String(r.facts.threeWayFirst)} first and ${String(r.facts.threeWayLast)} last`;
      // The three matches are all draws, so nothing but the lots could have ordered the three.
      const lines = r.text.filter((l) => l.startsWith("Second table"));
      if (lines.length !== 3) return `${lines.length} second-table lines`;
      for (const l of lines) {
        const m = /(\d+) — (\d+)/.exec(l);
        if (m === null || m[1] !== m[2]) return `a second-table line is not a draw: '${l}'`;
      }
      return true;
    },
  },
];

const claims: Claim[] = [
  ...caseClaims,
  ...reachClaims,
  ...factClaims,
  {
    says: "every sport's declared league order ends in a drawing of lots, and the per-sport facts cover the registry",
    source: "defaultOrderOf(module, \"league\") over the registry",
    check(r) {
      let withoutLots = 0;
      const visited = forEachSport(({ module }) => {
        const o = defaultOrderOf(module, "league");
        if (o[o.length - 1] !== "lots") withoutLots++;
      });
      if (withoutLots > 0) return `${withoutLots} sports do not end in lots`;
      return r.facts.sportCount === visited || `sportCount ${String(r.facts.sportCount)}, registry ${visited}`;
    },
  },
];
if (forEachSport(({ module }) => claims.push(sportClaim(module))) === 0) throw new Error("drawing-lots: the sport registry is empty");

export const drawingLots: BlogExample = {
  id: DRAWING_LOTS_ID,
  kind: "engine",
  sports: "all",
  build,
  claims,
};
