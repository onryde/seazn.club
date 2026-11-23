// Post #14, "What happens when a player gets a bye in a Swiss chess tournament?". Two examples.
//
// `swiss-bye` sweeps the registry: for every sport, under the variant a new division starts on (and each other variant
// whose bye is worth something different), what a Swiss bye pays, through the app's own bye credit (`awardByeDelta`, the
// row the standings fold books for a bye) under the rules the web's one loader reads (`tableRulesOf`), beside the most one
// played win can pay under the same rules (`maxRoundPoints`, the app's own reading of it). The claims recompute both from
// the sport's points DECLARATION, never from the loader `build()` reads.
//
// `swiss-bye-rounds` plays five chess players over four Swiss rounds, paired the way the app pairs one (swiss-run.ts), and
// shows who sits out each round. Chess only: the post's question is the chess bye; the sweep above covers every sport.
import { pointsText, setsToWinOf } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { declaredCfgs, forEachSport } from "@seazn/engine/testkit";
import { sportLabel, variantLabel } from "@/blog/labels";
import { liveCfg } from "@/server/engine-db/fixture-cfg";
import { maxRoundPoints } from "@/server/engine-db/swiss-max-round-points";
import { col, guarded, offeredInEverySportClaim, scoreOf } from "./swiss-claims";
import { byeDelta, runSwiss, swissRules } from "./swiss-run";
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
function declaredBestWin(module: AnySportModule, cfg: unknown): number {
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
      for (const row of r.table?.rows ?? []) {
        const name = String(row[0]).replace(/ \(.*\)$/, "");
        if (seen[seen.length - 1] !== name) seen.push(name);
      }
      return JSON.stringify(seen) === JSON.stringify(labels) || `sports are ${seen.join(", ")}`;
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

const PLAYERS = ["Ana", "Ben", "Cy", "Dev", "Eve"] as const;
const ROUNDS = 4;
const ROUNDS_COLUMNS = ["Round", "Bye goes to", "Points before the round", "The bye earns"];

/** "Ana, Ben and Cy": names in the order given, the last joined by "and". */
const nameList = (names: readonly string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

function buildRounds(): ExampleResult {
  const run = runSwiss({
    stageId: "blog-example:swiss-bye-rounds",
    sportKey: "boardgame",
    rounds: ROUNDS,
    entrants: PLAYERS.map((n, i) => ({ id: n.toLowerCase(), name: n, seed: i + 1 })),
    // The fixture: the player listed first on each board wins.
    result: () => "home",
  });
  const rows: (string | number)[][] = [];
  const text: string[] = [];
  let prev = new Map<string, number>();
  for (const round of run.rounds) {
    if (round.bye === null) throw new Error(`swiss-bye-rounds: round ${round.round} has no bye`);
    const before = PLAYERS.map((n) => `${n} ${run.points(prev.get(n.toLowerCase()) ?? 0)}`).join(", ");
    rows.push([round.round, run.name(round.bye.entrant), before, run.points(round.bye.paid)]);
    text.push(`Round ${round.round}: ${run.name(round.bye.entrant)} sits out and is credited ${run.points(round.bye.paid)}.`);
    prev = round.after;
  }
  const first = run.rounds[0]!.bye!;
  // The players on a round's lowest score going in (the post names them), in seeding order, read off the run's own scores.
  const lowestIn = (round: number): string => {
    const before = run.rounds[round - 2]!.after;
    const low = Math.min(...PLAYERS.map((n) => before.get(n.toLowerCase()) ?? 0));
    return nameList(PLAYERS.filter((n) => (before.get(n.toLowerCase()) ?? 0) === low));
  };
  return {
    facts: {
      playerCount: PLAYERS.length,
      roundCount: run.rounds.length,
      r1Bye: run.name(first.entrant),
      r1ByeSeed: PLAYERS.length,
      byeWorth: run.points(first.paid),
      r2Bye: run.name(run.rounds[1]!.bye!.entrant),
      r2Lowest: lowestIn(2),
      r3Lowest: lowestIn(3),
      r3Bye: run.name(run.rounds[2]!.bye!.entrant),
    },
    table: { caption: "Five chess players, four Swiss rounds: one player sits out each round, and nobody sits out twice.", columns: ROUNDS_COLUMNS, rows },
    text,
  };
}

interface ByeRow {
  round: number;
  holder: string;
  before: Map<string, number>;
  earns: number;
}
function byeRowsOf(r: ExampleResult): ByeRow[] {
  const [ro, ho, be, ea] = ROUNDS_COLUMNS.map((c) => col(r, c));
  return (r.table?.rows ?? []).map((row) => ({
    round: Number(row[ro!]),
    holder: String(row[ho!]),
    before: new Map(
      String(row[be!])
        .split(", ")
        .map((x) => {
          const i = x.lastIndexOf(" ");
          return [x.slice(0, i), scoreOf(x.slice(i + 1))] as [string, number];
        }),
    ),
    earns: scoreOf(row[ea!]!),
  }));
}
const seedOf = (name: string) => PLAYERS.indexOf(name as (typeof PLAYERS)[number]) + 1;

const roundsClaims: Claim[] = [
  {
    says: "every round of an odd field has exactly one bye, and round 1's goes to the lowest seed",
    source: "FIDE Handbook C.04.1 (2026) rule 3 and C.04.3 (Dutch system): with an odd number of players one is unpaired; before any result, the lowest-ranked receives the bye",
    check: guarded((r) => {
      const rows = byeRowsOf(r);
      if (rows.length !== ROUNDS) return `${rows.length} rounds with a bye, the fixture plays ${ROUNDS}`;
      return seedOf(rows[0]!.holder) === PLAYERS.length || `round 1's bye went to seed ${seedOf(rows[0]!.holder)}`;
    }),
  },
  {
    says: "nobody gets the bye twice",
    source: "FIDE Handbook C.04.1 (2026) rule 4 and C.04.3 [C2]: a player who has already received a pairing-allocated bye is not eligible for another",
    check: guarded((r) => {
      const holders = byeRowsOf(r).map((x) => x.holder);
      return new Set(holders).size === holders.length || `byes: ${holders.join(", ")}`;
    }),
  },
  {
    says: "each round's bye goes to the lowest-scoring player who has not had one, the lowest seed among those level",
    source: "FIDE Handbook C.04.3 (2026) quality criterion [C5]: the bye receiver has the lowest score of the eligible players; ties go to the lowest-ranked, the engine's own bottom-up candidate order",
    check: guarded((r) => {
      const had = new Set<string>();
      for (const row of byeRowsOf(r)) {
        if (row.before.size !== PLAYERS.length) return `round ${row.round}: ${row.before.size} scores listed`;
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
        }
      }
      return rows.length > 1 || "one round only";
    }),
  },
];


// The two claims the post's prose leans on: which players it names as level on the lowest score, and that round 3 is a case
// where "has not had one" and "lowest" part ways (an earlier holder is level on the lowest score and a lower seed).
roundsClaims.push(
  {
    says: "the players the post names as level on the lowest score in rounds 2 and 3 are exactly the players on the table's lowest score in those rounds",
    source: "the committed scores going into each round (FIDE Laws of Chess art. 10.1 points)",
    check: guarded((r) => {
      const rows = byeRowsOf(r);
      const seedOrder = [...PLAYERS];
      let checked = 0;
      for (const [round, key] of [[2, "r2Lowest"], [3, "r3Lowest"]] as const) {
        const row = rows.find((x) => x.round === round);
        if (row === undefined) return `no round ${round}`;
        const low = Math.min(...row.before.values());
        const level = seedOrder.filter((p) => row.before.get(p) === low);
        if (level.length < 2) return `round ${round}: only ${level.join(", ")} is on the lowest score, so the post's "level" sentence would be false`;
        const want = `${level.slice(0, -1).join(", ")} and ${level[level.length - 1]}`;
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
);

export const swissByeRounds: BlogExample = {
  id: SWISS_BYE_ROUNDS_ID,
  kind: "engine",
  sports: ["boardgame"],
  singleSportReason: "chess only: the post's worked example is the chess bye; the example beside it sweeps what a bye earns in every sport",
  build: buildRounds,
  claims: roundsClaims,
};
