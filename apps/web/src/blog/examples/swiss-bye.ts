// Post #14, "What happens when a player gets a bye in a Swiss chess tournament?". Two examples.
//
// `swiss-bye` sweeps the registry: for every sport, under the variant a new division starts on (and each other variant
// whose bye is worth something different), what a Swiss bye pays, through the app's own bye credit (`awardByeDelta`, the
// row the standings fold books for a bye) under the rules the web's one loader reads (`tableRulesOf`), beside the most one
// played win can pay under the same rules (`maxRoundPoints`, the app's own reading of it). The claims recompute both from
// the sport's points DECLARATION, never from the loader `build()` reads.
//
// `swiss-bye-rounds` plays five chess players over four Swiss rounds, paired the way the app pairs one (swiss-run.ts), and
// shows who sits out each round and who plays whom. The fixture lists them in sign-up order with seeds that are neither that
// order nor the alphabet's (swiss-claims.ts seedsIndistinguishable). Chess only: the post's question is the chess bye; the
// sweep above covers every sport.
import { pointsText, setsToWinOf, swissDrawFactsOf, swissDrawPoints } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { declaredCfgs, forEachSport } from "@seazn/engine/testkit";
import { sportLabel, variantLabel } from "@/blog/labels";
import { liveCfg } from "@/server/engine-db/fixture-cfg";
import { maxRoundPoints } from "@/server/engine-db/swiss-max-round-points";
import { capitalised, captionClaim, col, floatRuleProblem, guarded, numberWord, offeredInEverySportClaim, parseSeededLabel, scoreOf, seededLabel, seedReader, type PairedRound, type Seeded } from "./swiss-claims";
import { byeDelta, roundDiagram, runSwiss, swissRules } from "./swiss-run";
import { startingVariantKey } from "./starting-variant";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const SWISS_BYE_ID = "swiss-bye";
export const SWISS_BYE_ROUNDS_ID = "swiss-bye-rounds";

const BYE_COLUMNS = ["Sport", "A bye earns", "The most one played win earns"];

/** The variants a module declares by name (declaredCfgs also lists the bare schema default, which is no variant). */
function variantsOf(module: AnySportModule): { key: string; cfg: unknown }[] {
  return declaredCfgs(module)
    .filter((c) => Object.hasOwn(module.variants, c.name))
    .map((c) => ({ key: c.name, cfg: c.cfg }));
}

function byeCells(module: AnySportModule, cfg: unknown): string[] {
  const stageId = `blog-example:swiss-bye:${module.key}`;
  const rules = swissRules(module, cfg, stageId);
  const unit = rules.points.unit;
  const credit = byeDelta(module, cfg, rules, "blog-bye-holder");
  const most = maxRoundPoints(rules.points, module, liveCfg(cfg, { kind: "swiss", config: { rounds: 5 } }, module));
  return [pointsText(credit.points, unit), pointsText(most, unit)];
}

function buildBye(): ExampleResult {
  const rows: (string | number)[][] = [];
  const facts: ExampleResult["facts"] = {};
  const visited = forEachSport(({ module }) => {
    const startKey = startingVariantKey(module);
    const variants = variantsOf(module);
    const start = variants.find((v) => v.key === startKey);
    if (start === undefined) throw new Error(`swiss-bye: ${module.key}: the starting variant '${startKey}' is not declared`);
    const first = byeCells(module, start.cfg);
    const extra = variants.filter((v) => v.key !== startKey).map((v) => ({ v, cells: byeCells(module, v.cfg) })).filter((x) => x.cells.join("|") !== first.join("|"));
    const shown = [{ v: start, cells: first }, ...extra];
    for (const s of shown) {
      const label = shown.length > 1 ? `${sportLabel(module.key)} (${variantLabel(module.key, s.v.key)})` : sportLabel(module.key);
      rows.push([label, ...s.cells]);
    }
    if (module.key === "boardgame") facts.chessBye = first[0]!;
    if (module.key === "volleyball") {
      const indoor = extra.find((x) => x.v.key === "indoor");
      if (indoor !== undefined) {
        facts.volleyballIndoorBye = indoor.cells[0]!;
      }
    }
  });
  facts.sportCount = visited;
  return {
    facts,
    table: { caption: "What a Swiss bye is worth in each sport, beside the most one played win can earn.", columns: BYE_COLUMNS, rows },
    text: ["Each row books a bye the way a division books one, under the points a new division of that sport starts on."],
  };
}

// ---- claims for `swiss-bye`: recomputed from the sport's points declaration ----

/** The sport's DECLARED Swiss points: the one read of the declaration the claims make (exempted by name in
 *  table-rules-single-resolver.test.ts; `build()` reads the loader instead). */
const declaredSwiss = (module: AnySportModule, cfg: unknown) => module.tablePointsRule(cfg as never, "swiss");

/** The most one played win pays under the sport's DECLARED Swiss points: the clean sweep where points go by set score. */
export function declaredBestWin(module: AnySportModule, cfg: unknown): number {
  const declared = declaredSwiss(module, cfg);
  const setsToWin = setsToWinOf(module, cfg);
  if (declared.bySetScore !== undefined && setsToWin !== undefined) {
    const hit = declared.bySetScore[`${setsToWin}-0`] ?? declared.bySetScore["*"];
    if (hit === undefined) throw new Error(`${module.key}: the declared rule pays no ${setsToWin}-0`);
    return hit[0];
  }
  return declared.win.regulation;
}

function byeClaimsFor(module: AnySportModule): Claim[] {
  const sport = sportLabel(module.key);
  const rowsOf = (r: ExampleResult) => (r.table?.rows ?? []).filter((row) => row[0] === sport || String(row[0]).startsWith(`${sport} (`));
  const expected = variantsOf(module).map((v) => ({ key: v.key, best: declaredBestWin(module, v.cfg), unit: declaredSwiss(module, v.cfg).unit }));
  const rowFor = (r: ExampleResult, variantKey: string) => {
    const rows = rowsOf(r);
    if (rows.length === 1) return variantKey === startingVariantKey(module) ? rows[0] : undefined;
    return rows.find((row) => row[0] === `${sport} (${variantLabel(module.key, variantKey)})`);
  };
  const mine = (says: string, source: string, check: Claim["check"]): Claim => ({ says: `${sport}: ${says}`, source, sport: module.key, check });
  return [
    mine("a bye earns what a win earns: the best a played win can pay, the clean sweep where points go by set score", "FIDE Handbook C.04.1 (2026) rule 3: a pairing-allocated bye scores as many points as a win; the sport's declared Swiss points (tablePointsRule of the Swiss stage)", guarded((r) => {
      const c = col(r, "A bye earns");
      let n = 0;
      for (const e of expected) {
        const row = rowFor(r, e.key);
        if (row === undefined) continue;
        const want = pointsText(e.best, e.unit);
        if (row[c] !== want) return `${String(row[0])}: a bye earns ${String(row[c])}, the declaration's best win is ${want}`;
        n++;
      }
      return n > 0 || "no row checked";
    })),
    mine("the most one played win earns is the declared clean-sweep win", "the sport's declared Swiss points (tablePointsRule of the Swiss stage), win at the clean-sweep set score", guarded((r) => {
      const c = col(r, "The most one played win earns");
      let n = 0;
      for (const e of expected) {
        const row = rowFor(r, e.key);
        if (row === undefined) continue;
        const want = pointsText(e.best, e.unit);
        if (row[c] !== want) return `${String(row[0])}: ${String(row[c])}, the declaration gives ${want}`;
        n++;
      }
      return n > 0 || "no row checked";
    })),
    mine("a variant gets its own row exactly when its bye is worth something else than the starting variant's", "the sport's declared Swiss points of every variant", guarded((r) => {
      const start = expected.find((e) => e.key === startingVariantKey(module));
      if (start === undefined) return "no starting variant";
      const want = 1 + expected.filter((e) => e.key !== start.key && pointsText(e.best, e.unit) !== pointsText(start.best, start.unit)).length;
      return rowsOf(r).length === want || `${rowsOf(r).length} rows, the declarations give ${want}`;
    })),
  ];
}

const byeClaims: Claim[] = [
  offeredInEverySportClaim("swiss", "Swiss", "sportCount"),
  {
    says: "the table holds every sport of the registry, in registry order",
    source: "the sport registry (forEachSport)",
    check: guarded((r) => {
      const labels: string[] = [];
      forEachSport(({ module }) => labels.push(sportLabel(module.key)));
      const seen: string[] = [];
      const sportCol = col(r, "Sport");
      for (const row of r.table?.rows ?? []) {
        const name = String(row[sportCol]).replace(/ \(.*\)$/, "");
        if (seen[seen.length - 1] !== name) seen.push(name);
      }
      return JSON.stringify(seen) === JSON.stringify(labels) || `sports are ${seen.join(", ")}`;
    }),
  },
  {
    says: "the post's chess bye is what the table's chess row says a bye earns, which is the declared clean-sweep win",
    source: "the committed chess row, and the chess declaration's best win (tablePointsRule of the Swiss stage, read through declaredBestWin)",
    check: guarded((r) => {
      let m: AnySportModule | undefined;
      forEachSport(({ module }) => {
        if (module.key === "boardgame") m = module;
      });
      if (m === undefined) return "no chess in the registry";
      const start = variantsOf(m).find((v) => v.key === startingVariantKey(m!));
      if (start === undefined) return "no starting variant for chess";
      const row = (r.table?.rows ?? []).find((x) => x[0] === sportLabel("boardgame"));
      if (row === undefined) return "no chess row";
      const earns = row[col(r, "A bye earns")];
      const declared = pointsText(declaredBestWin(m, start.cfg), declaredSwiss(m, start.cfg).unit);
      return (String(r.facts.chessBye) === String(earns) && String(earns) === declared) || `the post says ${String(r.facts.chessBye)}, the table's chess row says ${String(earns)}, the declaration gives ${declared}`;
    }),
  },
  {
    says: "indoor volleyball's bye earns the 3-0 win's points, more than a 3-2 win pays (a bye is a clean win, not any win)",
    source: "volleyball's declared indoor Swiss points by set score (tablePointsRule of the Swiss stage, bySetScore)",
    check: guarded((r) => {
      let v: AnySportModule | undefined;
      forEachSport(({ module }) => {
        if (module.key === "volleyball") v = module;
      });
      if (v === undefined) return "no volleyball in the registry";
      const indoor = variantsOf(v).find((x) => x.key === "indoor");
      if (indoor === undefined) return "volleyball declares no indoor variant";
      const map = declaredSwiss(v, indoor.cfg).bySetScore;
      if (map?.["3-0"] === undefined || map["3-2"] === undefined) return "indoor volleyball declares no 3-0 and 3-2 points";
      if (map["3-0"][0] === map["3-2"][0]) return "the declaration pays 3-0 and 3-2 alike, so this case cannot tell them apart";
      return String(r.facts.volleyballIndoorBye) === String(map["3-0"][0]) || `the indoor bye is ${String(r.facts.volleyballIndoorBye)}, a 3-0 win pays ${map["3-0"][0]}`;
    }),
  },
];
const sportsClaimed = forEachSport(({ module }) => {
  byeClaims.push(...byeClaimsFor(module));
});
if (sportsClaimed === 0) throw new Error("swiss-bye: the sport registry is empty");

export const swissBye: BlogExample = { id: SWISS_BYE_ID, kind: "engine", sports: "all", build: buildBye, claims: byeClaims };

// ---- `swiss-bye-rounds`: who sits out, round by round ----

/** The fixture: the players in sign-up order, each with the seed the organiser gave. */
export const SWISS_BYE_ROUNDS_FIXTURE: readonly Seeded[] = [
  { name: "Cy", seed: 4 },
  { name: "Eve", seed: 1 },
  { name: "Ana", seed: 5 },
  { name: "Dev", seed: 2 },
  { name: "Ben", seed: 3 },
];
const seedOf = seedReader(SWISS_BYE_ROUNDS_FIXTURE);
/** The names, best seed first: the order the table lists everyone's points in. */
const inSeedOrder = (fixture: readonly Seeded[]) => [...fixture].sort((a, b) => a.seed - b.seed).map((p) => p.name);
const ROUNDS = 4;
/** The round the diagram draws: the round where "lowest" and "has not had one" choose different players. */
const DIAGRAM_ROUND = 3;
const ROUNDS_COLUMNS = ["Round", "Bye goes to", "Boards", "Points before the round", "The bye earns"];

/** "Ana, Ben and Cy": names in the order given, the last joined by "and". */
const nameList = (names: readonly string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** `fixture` is a parameter so a test can build the same example on other seeds and see the table move. */
export function buildSwissByeRounds(fixture: readonly Seeded[] = SWISS_BYE_ROUNDS_FIXTURE): ExampleResult {
  const seed = seedReader(fixture);
  const order = inSeedOrder(fixture);
  const run = runSwiss({
    stageId: "blog-example:swiss-bye-rounds",
    sportKey: "boardgame",
    rounds: ROUNDS,
    entrants: fixture.map((p) => ({ id: p.name.toLowerCase(), name: p.name, seed: p.seed })),
    // The fixture: the player listed first on each board wins.
    result: () => "home",
  });
  const label = (id: string) => seededLabel(run.name(id), seed(run.name(id)));
  const rows: (string | number)[][] = [];
  const text: string[] = [];
  let prev = new Map<string, number>();
  for (const round of run.rounds) {
    if (round.bye === null) throw new Error(`swiss-bye-rounds: round ${round.round} has no bye`);
    const before = order.map((n) => `${n} ${run.points(prev.get(n.toLowerCase()) ?? 0)}`).join(", ");
    const boards = round.boards.map((b) => `${run.name(b.home)} v ${run.name(b.away)}`).join(", ");
    rows.push([round.round, label(round.bye.entrant), boards, before, run.points(round.bye.paid)]);
    text.push(`Round ${round.round}: ${run.name(round.bye.entrant)} sits out and is credited ${run.points(round.bye.paid)}.`);
    prev = round.after;
  }
  const first = run.rounds[0]!.bye!;
  // The players on a round's lowest score going in (the post names them), best seed first, read off the run's own scores.
  const levelOnLowest = (round: number): string[] => {
    const before = run.rounds[round - 2]!.after;
    const low = Math.min(...order.map((n) => before.get(n.toLowerCase()) ?? 0));
    return order.filter((n) => (before.get(n.toLowerCase()) ?? 0) === low);
  };
  const earlierHolders = (round: number) => run.rounds.slice(0, round - 1).map((r) => run.name(r.bye!.entrant));
  const diagramLevel = levelOnLowest(DIAGRAM_ROUND);
  const diagramHolder = run.name(run.rounds[DIAGRAM_ROUND - 1]!.bye!.entrant);
  const hadOne = diagramLevel.filter((n) => earlierHolders(DIAGRAM_ROUND).includes(n));
  const facts: ExampleResult["facts"] = {
    playerCount: fixture.length,
    roundCount: run.rounds.length,
    r1Bye: run.name(first.entrant),
    r1ByeSeed: seed(run.name(first.entrant)),
    byeWorth: run.points(first.paid),
    // The most a bye's stand-in opponent can score in the Buchholz: what drawing every round would give (FIDE C.07 (2026) 16.4.2),
    // from the engine's own draw points under this stage's rule.
    byeBuchholzCap: run.points(swissDrawPoints(run.rules.points, swissDrawFactsOf(run.module, liveCfg(run.cfg, { kind: "swiss", config: { rounds: ROUNDS } }, run.module))) * ROUNDS),
    r2Bye: run.name(run.rounds[1]!.bye!.entrant),
    r2Lowest: nameList(levelOnLowest(2)),
    r3Lowest: nameList(diagramLevel),
    r3Bye: diagramHolder,
  };
  return {
    facts,
    table: {
      caption: `${capitalised(numberWord(fixture.length))} chess players, ${numberWord(run.rounds.length)} Swiss rounds: one player sits out each round, and nobody sits out twice. Points are listed best seed first, and the number in brackets is the seed.`,
      columns: ROUNDS_COLUMNS,
      rows,
    },
    diagram: roundDiagram(
      run,
      DIAGRAM_ROUND,
      `Round ${DIAGRAM_ROUND}: ${nameList(diagramLevel)} are level on the lowest score, but ${nameList(hadOne)} already had a bye, so ${diagramHolder} sits out.`,
      label,
    ),
    text,
  };
}

interface ByeRow {
  round: number;
  holder: string;
  /** The seed printed beside the holder. */
  printed: number;
  boards: [string, string][];
  /** The points going in, in the order the table lists them. */
  before: Map<string, number>;
  earns: number;
}
function byeRowsOf(r: ExampleResult): ByeRow[] {
  const [ro, ho, bo, be, ea] = ROUNDS_COLUMNS.map((c) => col(r, c));
  return (r.table?.rows ?? []).map((row) => {
    const holder = parseSeededLabel(row[ho!]!);
    return {
      round: Number(row[ro!]),
      holder: holder.name,
      printed: holder.seed,
      boards: String(row[bo!])
        .split(", ")
        .map((x) => x.split(" v ") as [string, string]),
      before: new Map(
        String(row[be!])
          .split(", ")
          .map((x) => {
            const i = x.lastIndexOf(" ");
            return [x.slice(0, i), scoreOf(x.slice(i + 1))] as [string, number];
          }),
      ),
      earns: scoreOf(row[ea!]!),
    };
  });
}
function pairedRoundsOf(r: ExampleResult): PairedRound[] {
  return byeRowsOf(r).map((x) => ({ round: x.round, score: x.before, pairs: x.boards, bye: x.holder }));
}

const roundsClaims: Claim[] = [
  {
    says: "every round of an odd field has exactly one bye, and round 1's goes to the lowest seed",
    source: "FIDE Handbook C.04.1 (2026) rule 3 and C.04.3 (Dutch system): with an odd number of players one is unpaired; before any result, the lowest-ranked receives the bye",
    check: guarded((r) => {
      const rows = byeRowsOf(r);
      if (rows.length !== ROUNDS) return `${rows.length} rounds with a bye, the fixture plays ${ROUNDS}`;
      const numbered = rows.map((x) => x.round);
      if (numbered.some((n, i) => n !== i + 1)) return `the rounds are numbered ${numbered.join(", ")}`;
      return seedOf(rows[0]!.holder) === SWISS_BYE_ROUNDS_FIXTURE.length || `round 1's bye went to seed ${seedOf(rows[0]!.holder)}`;
    }),
  },
  {
    says: "the seed printed beside each bye holder is that player's seed in the fixture, and the points are listed best seed first",
    source: "the example's fixture (the seeds the organiser gave), read back from the table",
    check: guarded((r) => {
      const want = inSeedOrder(SWISS_BYE_ROUNDS_FIXTURE);
      let n = 0;
      for (const row of byeRowsOf(r)) {
        if (row.printed !== seedOf(row.holder)) return `round ${row.round}: printed seed ${row.printed}, the fixture has ${seedOf(row.holder)}`;
        const listed = [...row.before.keys()];
        if (listed.join(", ") !== want.join(", ")) return `round ${row.round}: points listed ${listed.join(", ")}, best seed first is ${want.join(", ")}`;
        n++;
      }
      return n > 0 || "no rows";
    }),
  },
  {
    says: "nobody gets the bye twice",
    source: "FIDE Handbook C.04.1 (2026) rule 4 and C.04.3 [C2]: a player who has already received a pairing-allocated bye is not eligible for another",
    check: guarded((r) => {
      const holders = byeRowsOf(r).map((x) => x.holder);
      if (holders.length === 0) return "no bye";
      return new Set(holders).size === holders.length || `byes: ${holders.join(", ")}`;
    }),
  },
  {
    says: "each round's bye goes to the lowest-scoring player who has not had one, the lowest seed among those level",
    source: "FIDE Handbook C.04.3 (2026) quality criterion [C5]: the bye receiver has the lowest score of the eligible players; ties go to the lowest-ranked, the engine's own bottom-up candidate order",
    check: guarded((r) => {
      const had = new Set<string>();
      for (const row of byeRowsOf(r)) {
        if (row.before.size !== SWISS_BYE_ROUNDS_FIXTURE.length) return `round ${row.round}: ${row.before.size} scores listed`;
        const eligible = [...row.before].filter(([p]) => !had.has(p));
        const low = Math.min(...eligible.map(([, s]) => s));
        const want = eligible.filter(([, s]) => s === low).sort((a, b) => seedOf(b[0]) - seedOf(a[0]))[0]![0];
        if (row.holder !== want) return `round ${row.round}: the bye went to ${row.holder}, the rule gives ${want}`;
        had.add(row.holder);
      }
      return had.size > 0 || "no bye";
    }),
  },
  {
    says: "a bye earns a full point, what a win earns, not the half point of a draw",
    source: "FIDE Handbook C.04.1 (2026) rule 3: a pairing-allocated bye scores as many points as a win; FIDE Laws of Chess art. 10.1: a win scores 1",
    check: guarded((r) => {
      const rows = byeRowsOf(r);
      if (rows.length === 0) return "no bye";
      for (const row of rows) if (row.earns !== 1) return `round ${row.round}: the bye earns ${row.earns}`;
      return scoreOf(r.facts.byeWorth!) === 1 || `the post's bye is worth ${String(r.facts.byeWorth)}`;
    }),
  },
  {
    says: "the scores before each round are the earlier rounds' points: a bye and a win add 1, a loss 0",
    source: "FIDE Laws of Chess art. 10.1 and FIDE Handbook C.04.1 (2026) rule 3",
    check: guarded((r) => {
      const rows = byeRowsOf(r);
      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1]!;
        const cur = rows[i]!;
        for (const [p, s] of cur.before) {
          const gained = s - (prev.before.get(p) ?? Number.NaN);
          if (!(gained === 0 || gained === 1)) return `round ${cur.round}: ${p} moved by ${gained}`;
          if (p === prev.holder && gained !== 1) return `round ${cur.round}: ${p} had the bye and gained ${gained}`;
          // The first player named on a board is White and wins it in this example's fixture: the winner gains the point.
          const won = prev.boards.some(([w]) => w === p);
          if (p !== prev.holder && won !== (gained === 1)) return `round ${cur.round}: ${p} ${won ? "won" : "lost"} round ${prev.round} but moved by ${gained}`;
        }
      }
      return rows.length > 1 || "one round only";
    }),
  },
  {
    says: "each round seats every player exactly once, on a board or on the bye, and nobody meets the same opponent twice",
    source: "FIDE Handbook C.04.1 (2026) rules 2 and 3 (no rematch; with an odd number of players one is unpaired)",
    check: guarded((r) => {
      const met = new Set<string>();
      let n = 0;
      for (const x of pairedRoundsOf(r)) {
        const seated = [...x.pairs.flat(), ...(x.bye === null ? [] : [x.bye])].sort();
        if (seated.join(",") !== [...x.score.keys()].sort().join(",")) return `round ${x.round}: seats ${seated.join(", ")}`;
        for (const [a, b] of x.pairs) {
          const k = [a, b].sort().join("|");
          if (met.has(k)) return `${a} and ${b} meet twice`;
          met.add(k);
        }
        n++;
      }
      return n > 0 || "no rounds";
    }),
  },
  {
    says: "each round from round 2 floats as few players out of each score group as any rematch-free pairing can, taking the groups from the top",
    source: "the engine's own statement of the rule (scheduling/swiss.js header: each score group is paired in turn from the top and moves the fewest players to the next) under FIDE Handbook C.04.3 [C1] no rematch, with the round's bye already given; brute force over every rematch-free pairing, never the engine",
    check: guarded((r) => {
      const { problem, checked } = floatRuleProblem(pairedRoundsOf(r));
      return problem ?? (checked > 0 || "no round after the first");
    }),
  },
  {
    says: "a bye's stand-in opponent in the Buchholz scores the holder's own final score, but never more than drawing every round would give, and for at least one holder here the cap changes it",
    source: "FIDE Handbook C.07 (2026) art. 16.4.2 (the dummy opponent has the player's own score, capped at the draw points times the rounds) with a draw worth ½ (FIDE Laws of Chess art. 10.1)",
    check: guarded((r) => {
      const rows = byeRowsOf(r);
      if (rows.length !== ROUNDS) return `${rows.length} rounds, the fixture plays ${ROUNDS}`;
      const last = rows[rows.length - 1]!;
      // Each player's final score: the last round's points going in, plus a point for the bye or for winning the board
      // (the player named first on a board wins it in this example's fixture).
      const final = new Map<string, number>();
      for (const [p, s] of last.before) final.set(p, s + (p === last.holder || last.boards.some(([w]) => w === p) ? 1 : 0));
      const cap = 0.5 * rows.length;
      if (scoreOf(r.facts.byeBuchholzCap!) !== cap) return `the post says the cap is ${String(r.facts.byeBuchholzCap)}, ${rows.length} rounds of draws give ${cap}`;
      const standIns = rows.map((x) => ({ holder: x.holder, own: final.get(x.holder)!, stand: Math.min(final.get(x.holder)!, cap) }));
      if (standIns.some((x) => x.own === undefined || Number.isNaN(x.own))) return "a bye holder has no final score";
      const bitten = standIns.filter((x) => x.stand !== x.own);
      return bitten.length > 0 || `no holder's final score exceeds the cap ${cap} (${standIns.map((x) => `${x.holder} ${x.own}`).join(", ")}), so the cap would not change any Buchholz`;
    }),
  },
  {
    says: "the post's named holders and counts are the table's: round 1's and round 2's bye holder, round 1's holder's seed, the field and the round count",
    source: "the committed table and the example's fixture",
    check: guarded((r) => {
      const rows = byeRowsOf(r);
      const [one, two] = [rows.find((x) => x.round === 1), rows.find((x) => x.round === 2)];
      if (one === undefined || two === undefined) return "no round 1 or round 2";
      if (String(r.facts.r1Bye) !== one.holder) return `r1Bye is '${String(r.facts.r1Bye)}', the table gives '${one.holder}'`;
      if (String(r.facts.r2Bye) !== two.holder) return `r2Bye is '${String(r.facts.r2Bye)}', the table gives '${two.holder}'`;
      if (Number(r.facts.r1ByeSeed) !== seedOf(one.holder)) return `r1ByeSeed is ${String(r.facts.r1ByeSeed)}, ${one.holder}'s seed is ${seedOf(one.holder)}`;
      if (Number(r.facts.playerCount) !== SWISS_BYE_ROUNDS_FIXTURE.length || Number(r.facts.roundCount) !== rows.length) return `the post says ${String(r.facts.playerCount)} players and ${String(r.facts.roundCount)} rounds, the table has ${SWISS_BYE_ROUNDS_FIXTURE.length} and ${rows.length}`;
      return true;
    }),
  },
  captionClaim("the caption's counts are the post's: the players and the rounds", (f) => [`${capitalised(numberWord(Number(f.playerCount)))} chess players`, `${numberWord(Number(f.roundCount))} Swiss rounds`]),
  {
    says: "the players the post names as level on the lowest score in rounds 2 and 3 are exactly the players on the table's lowest score in those rounds",
    source: "the committed scores going into each round (FIDE Laws of Chess art. 10.1 points)",
    check: guarded((r) => {
      const rows = byeRowsOf(r);
      const seedOrder = inSeedOrder(SWISS_BYE_ROUNDS_FIXTURE);
      let checked = 0;
      for (const [round, key] of [[2, "r2Lowest"], [3, "r3Lowest"]] as const) {
        const row = rows.find((x) => x.round === round);
        if (row === undefined) return `no round ${round}`;
        const low = Math.min(...row.before.values());
        const level = seedOrder.filter((p) => row.before.get(p) === low);
        if (level.length < 2) return `round ${round}: only ${level.join(", ")} is on the lowest score, so the post's "level" sentence would be false`;
        const want = nameList(level);
        if (r.facts[key] !== want) return `${key} is '${String(r.facts[key])}', the table gives '${want}'`;
        checked++;
      }
      return checked === 2 || "a round was not checked";
    }),
  },
  {
    says: "in round 3 an earlier bye holder is level on the lowest score and a lower seed than this round's holder, so 'lowest' and 'has not had one' choose different players",
    source: "FIDE Handbook C.04.1 (2026) rule 4 and C.04.3 [C2]: a player who has had a bye is not eligible again, however low they are placed",
    check: guarded((r) => {
      const rows = byeRowsOf(r);
      const row = rows.find((x) => x.round === 3);
      if (row === undefined) return "no round 3";
      const low = Math.min(...row.before.values());
      const earlier = rows.filter((x) => x.round < 3).map((x) => x.holder);
      const lowerSeedAndLevel = earlier.filter((p) => row.before.get(p) === low && seedOf(p) > seedOf(row.holder));
      if (lowerSeedAndLevel.length === 0) return "no earlier holder was lower and level, so round 3 cannot tell a repeat bye from a first one";
      return String(r.facts.r3Bye) === row.holder || `r3Bye is '${String(r.facts.r3Bye)}', the table gives '${row.holder}'`;
    }),
  },
  {
    says: "the diagram draws the table's own round: the same boards, colours, points going in and bye, and its caption names the holder and the level players",
    source: "the committed table (the diagram is drawn from the same run)",
    check: guarded((r) => {
      const d = r.diagram;
      if (d === undefined || d.kind !== "swissRound") return "no Swiss round diagram";
      const row = byeRowsOf(r).find((x) => x.round === d.round);
      if (row === undefined) return `the table has no round ${d.round}`;
      if (d.pairings.length !== row.boards.length) return `${d.pairings.length} boards drawn, the table has ${row.boards.length}`;
      const label = (n: string) => seededLabel(n, seedOf(n));
      for (const [i, [w, b]] of row.boards.entries()) {
        const p = d.pairings[i]!;
        if (p.board !== i + 1) return `the ${i + 1}th board is drawn as board ${p.board}`;
        // The player named first wins every board in this example's fixture: 1 to 0.
        if (p.result !== "1 — 0") return `board ${i + 1}: drawn result '${String(p.result)}', the first player wins it`;
        if (p.first !== label(w) || p.second !== label(b)) return `board ${i + 1}: drawn ${p.first} v ${String(p.second)}, the table has ${label(w)} v ${label(b)}`;
        if (p.firstWhite !== true) return `board ${i + 1}: the first player is White in the table`;
        if (scoreOf(p.firstScore!) !== row.before.get(w) || scoreOf(p.secondScore!) !== row.before.get(b)) return `board ${i + 1}: points drawn ${String(p.firstScore)} and ${String(p.secondScore)}, the table has ${row.before.get(w)} and ${row.before.get(b)}`;
        if (p.float !== (row.before.get(w) !== row.before.get(b))) return `board ${i + 1}: float drawn ${String(p.float)}`;
      }
      if (d.byes.join("|") !== label(row.holder)) return `the diagram's bye is '${d.byes.join(", ")}', the table's is '${label(row.holder)}'`;
      return (String(d.title).includes(row.holder) && String(d.title).includes(String(r.facts.r3Lowest))) || "the diagram's caption does not name the bye holder and the level players";
    }),
  },
];

export const swissByeRounds: BlogExample = {
  id: SWISS_BYE_ROUNDS_ID,
  kind: "engine",
  sports: ["boardgame"],
  singleSportReason: "chess only: the post's worked example is the chess bye; the example beside it sweeps what a bye earns in every sport",
  build: () => buildSwissByeRounds(),
  claims: roundsClaims,
};
