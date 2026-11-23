// Post #2, "What does a shoot-out or overtime win earn in a league?". For every sport in the registry, in a LEAGUE stage whose
// organiser has switched the deciders on (the Deciders section of the stage's rules: the engine's own preset for a stage
// that needs a winner, `stageDefaults`), a match is played to the end and settled beyond regulation, wherever the sport
// can. It is paid by the rules the standings read (the web's one table-rules loader, then `payout`), through the same real
// matches the pilot plays (kit.ts). A sport that cannot settle a league match beyond regulation gets no row, and is
// counted: the sweep reports how many sports settle beyond regulation and how many never do.
//
// WHICH MATCHES, per row: Ana beats Ben in regulation (the baseline each total is compared with), and Ana beats Ben in each
// way the league can settle beyond regulation (extra time, overtime, a shoot-out, a super over).
//
// WHAT CHECKS IT. The claims below recompute every expected cell and fact from the sport module's own declarations
// (`reachableDecidedIn`, the sport's points rule, `shootoutAs`, `soBonus`), with the cfg composed straight from the schema,
// in code that shares no formatter with `build()`, and compare the committed result to it. None reads `build()`.
import { decidedInFor, pointsText } from "@seazn/engine/competition";
import { stageDefaultsFor } from "@seazn/engine/sport";
import type { AnySportModule } from "@seazn/engine/sport";
import { forEachSport } from "@seazn/engine/testkit";
import { sportLabel, variantLabel } from "@/blog/labels";
import { NAMES, compact, leagueCfg, play, sentenceList, upperFirst, variantsOf, winnerLoserPoints, type Cfg, type StageRules, declaredLeaguePoints, joinAnd } from "./kit";
import { startingVariantKey } from "./starting-variant";
import { declaredLeagueStages, leagueStages, lowerFirst } from "./knockout-match-ends-level";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const SHOOTOUT_POINTS_ID = "shootout-points";

type Beyond = "ot" | "so";
const BEYOND: readonly Beyond[] = ["ot", "so"];

const COLUMNS = ["Sport", "Settled by", "Winner gets", "Loser gets", "The table books it as", "Both sides together"];
const C = { sport: 0, settled: 1, winner: 2, loser: 3, booked: 4, together: 5 } as const;

/**
 * The plain words for each way a league match can be settled beyond regulation. A decider with no word throws (a new
 * sport or decider must be named here before it can be printed), and the sweep counts the sports that have one.
 */
const SETTLED_WORDS: Readonly<Record<string, Partial<Record<Beyond, string>>>> = {
  football: { ot: "extra time", so: "penalty shoot-out" },
  cricket: { so: "super over" },
  icehockey: { ot: "overtime", so: "shoot-out" },
  hockey: { so: "shoot-out" },
};
const wordOf = (sportKey: string, d: Beyond): string => {
  const w = SETTLED_WORDS[sportKey]?.[d];
  if (w === undefined) throw new Error(`shootout-points: no word for ${sportKey}/${d}; name it in SETTLED_WORDS`);
  return w;
};
const bookedText = (kind: "result" | "draw", bonus: number): string =>
  kind === "draw" ? `a draw for each side, with ${bonus} bonus point${bonus === 1 ? "" : "s"} for the winner` : "a win and a loss";

/** The stage rules that switch a sport's deciders on in a league stage: the engine's preset for a stage that needs a winner. */
function deciderRules(module: AnySportModule, variantKey: string): StageRules | null {
  const preset = stageDefaultsFor(module, "knockout", variantKey) as StageRules;
  return Object.keys(preset).length === 0 ? null : preset;
}

interface Entry {
  d: Beyond;
  winner: number;
  loser: number;
  kind: "result" | "draw";
  line: string;
}
interface Run {
  rowId: string;
  variantKey: string;
  regTotal: number;
  entries: Entry[];
}

/** One variant, deciders on: the regulation baseline and a win in each decider the league can reach. Null: none reachable. */
function runVariant(module: AnySportModule, variantKey: string, cfg: Cfg, rowId: string): Run | null {
  const rules = deciderRules(module, variantKey);
  const merged = leagueCfg(module, variantKey, cfg, rules);
  const decided = module.reachableDecidedIn(merged as never, "league");
  const reachable = BEYOND.filter((d) => decided.has(d));
  if (reachable.length === 0) return null;
  const opts = { rules, variantKey };
  const reg = play(module, cfg, `${variantKey} win in regulation`, ["ana", "ben"], (o) => o.kind === "win" && o.winner === "ana" && decidedInFor(module, o) === "regulation", opts);
  const [regW, regL] = winnerLoserPoints(reg);
  const entries = reachable.map((d): Entry => {
    const p = play(module, cfg, `${variantKey} win in ${d}`, ["ana", "ben"], (o) => o.kind === "win" && o.winner === "ana" && decidedInFor(module, o) === d, opts);
    const [winner, loser] = winnerLoserPoints(p);
    // A shoot-out booked as a draw: BOTH sides are paid as drawn, whoever won it.
    const kind = p.paid.every((x) => x.drawn === 1) ? "draw" : "result";
    return { d, winner, loser, kind, line: `${NAMES.ana} beat ${NAMES.ben} after ${wordOf(module.key, d)}, ${p.headline}` };
  });
  return { rowId, variantKey, regTotal: regW + regL, entries };
}

const rowIdOf = (key: string, variantKey: string, isStart: boolean) => (isStart ? key : `${key}${compact(variantKey)}`);

function cellsOf(label: string, sportKey: string, e: Entry): (string | number)[] {
  return [label, upperFirst(wordOf(sportKey, e.d)), pointsText(e.winner, "whole"), pointsText(e.loser, "whole"), bookedText(e.kind, e.winner - e.loser), pointsText(e.winner + e.loser, "whole")];
}

function build(): ExampleResult {
  const facts: ExampleResult["facts"] = {};
  const rows: (string | number)[][] = [];
  const text: string[] = [
    "Each row comes from real matches in a league whose organiser switched the deciders on: Ana beats Ben in regulation and again after each way the league can settle a match beyond regulation.",
  ];
  const beyondSports: string[] = [];
  const regulationOnly: string[] = [];
  const visited = forEachSport(({ module }) => {
    const key = module.key;
    const startKey = startingVariantKey(module);
    const variants = variantsOf(module);
    const runs = variants.flatMap((v): Run[] => {
      const r = runVariant(module, v.key, v.cfg, rowIdOf(key, v.key, false));
      return r === null ? [] : [r];
    });
    if (runs.length === 0) {
      regulationOnly.push(sportLabel(key));
      return;
    }
    beyondSports.push(sportLabel(key));
    // The row set: the starting variant's when it has one (else the first that does), then each variant whose cells differ.
    const first = runs.find((r) => r.variantKey === startKey) ?? runs[0]!;
    const cellsKey = (r: Run) => JSON.stringify(r.entries.map((e) => cellsOf("", key, e)));
    const shown = [first, ...runs.filter((r) => r !== first && cellsKey(r) !== cellsKey(first))];
    for (const run of shown) {
      const label = shown.length > 1 ? `${sportLabel(key)} (${variantLabel(key, run.variantKey)})` : sportLabel(key);
      const id = run === first ? key : run.rowId;
      facts[`${id}RegTotal`] = pointsText(run.regTotal, "whole");
      for (const e of run.entries) {
        facts[`${id}${upperFirst(e.d)}Win`] = pointsText(e.winner, "whole");
        facts[`${id}${upperFirst(e.d)}Loss`] = pointsText(e.loser, "whole");
        facts[`${id}${upperFirst(e.d)}Total`] = pointsText(e.winner + e.loser, "whole");
        text.push(`${label}: ${e.line}.`);
        rows.push(cellsOf(label, key, e));
      }
    }
  });
  facts.sportCount = visited;
  facts.sportsBeyond = beyondSports.length;
  facts.sportsRegulationOnly = regulationOnly.length;
  facts.regulationOnlyList = sentenceList(regulationOnly);
  facts.beyondList = joinAnd(beyondSports);
  // Which of those sports play their deciders in a NEW league stage from the first match (the division variant's own, since a league
  // stage presets none): through the app's door, as post #18 reads it.
  const league = leagueStages();
  const among = (labels: string[]) => labels.filter((l) => beyondSports.includes(l.replace(/ \(.*$/, "")));
  facts.leagueOffFromStart = lowerFirst(sentenceList(among(league.level)));
  facts.leagueOnFromStart = sentenceList(among(league.decides));
  facts.leagueOnVariants = sentenceList(among(league.decidesVariants));
  return {
    facts,
    table: { caption: "What a win settled beyond regulation earns each side in a league, by sport and by way of settling it.", columns: COLUMNS, rows },
    text,
  };
}

// ---- claims: every expected value below is recomputed from the sport module's own declarations ----

/** How a claim's `source` names the declaration it recomputes from. */
const DECLARED = "the sport's league points rule (win, loss, draw, soBonus, shootoutAs) and reachableDecidedIn";

interface ExpectedEntry {
  d: Beyond;
  word: string;
  w: number;
  l: number;
  cells: string[];
  facts: { Win: string; Loss: string; Total: string };
}
interface Expected {
  rowId: string;
  variantKey: string;
  label: string;
  /** What a regulation win pays both sides together. */
  reg: number;
  entries: ExpectedEntry[];
}

/** The rows the declarations say the table must hold for a sport. Empty: the sport cannot settle a league match beyond regulation. */
function expectedFor(module: AnySportModule): Expected[] {
  const key = module.key;
  const startKey = startingVariantKey(module);
  const per = variantsOf(module).flatMap(({ key: variantKey }): Expected[] => {
    const rules = deciderRules(module, variantKey);
    // The cfg composed straight from the schema: the variant's own config, then the stage's rules over it.
    const cfg = module.configSchema.parse({ ...(module.variants[variantKey] ?? {}), ...(rules ?? {}) });
    const rule = declaredLeaguePoints(module, cfg);
    const decided = module.reachableDecidedIn(cfg, "league");
    const f = (n: number) => pointsText(n, "whole");
    const entries = BEYOND.filter((d) => decided.has(d)).map((d): ExpectedEntry => {
      const bonus = rule.shootoutAs === "draw_plus_bonus" && d === "so";
      const w = bonus ? rule.draw! + (rule.soBonus ?? 1) : d === "so" ? (rule.win.so ?? rule.win.ot ?? rule.win.regulation) : (rule.win.ot ?? rule.win.regulation);
      const l = bonus ? rule.draw! : d === "so" ? (rule.loss.so ?? rule.loss.ot ?? rule.loss.regulation) : (rule.loss.ot ?? rule.loss.regulation);
      return {
        d,
        word: upperFirst(wordOf(key, d)),
        w,
        l,
        cells: [f(w), f(l), bookedText(bonus ? "draw" : "result", w - l), f(w + l)],
        facts: { Win: f(w), Loss: f(l), Total: f(w + l) },
      };
    });
    if (entries.length === 0) return [];
    return [{ rowId: `${key}${compact(variantKey)}`, variantKey, label: "", reg: rule.win.regulation + rule.loss.regulation, entries }];
  });
  if (per.length === 0) return [];
  const first = per.find((p) => p.variantKey === startKey) ?? per[0]!;
  const same = (a: Expected, b: Expected) => JSON.stringify(a.entries.map((e) => e.cells)) === JSON.stringify(b.entries.map((e) => e.cells));
  const shown = [first, ...per.filter((p) => p !== first && !same(p, first))];
  return shown.map((p) => ({ ...p, rowId: p === first ? key : p.rowId, label: shown.length > 1 ? `${sportLabel(key)} (${variantLabel(key, p.variantKey)})` : sportLabel(key) }));
}

const rowsOfSport = (result: ExampleResult, sport: string) =>
  (result.table?.rows ?? []).filter((r) => r[C.sport] === sport || String(r[C.sport]).startsWith(`${sport} (`));

function claimsFor(module: AnySportModule): Claim[] {
  const sport = sportLabel(module.key);
  const expected = expectedFor(module);
  const mine = (says: string, source: string, check: Claim["check"]): Claim => ({ says: `${sport}: ${says}`, source, sport: module.key, check });
  /** Every expected row, found by sport and settled-by word, compared on the given columns. */
  const perEntry =
    (columns: number[]): Claim["check"] =>
    (result) => {
      for (const e of expected)
        for (const en of e.entries) {
          const row = (result.table?.rows ?? []).find((r) => r[C.sport] === e.label && r[C.settled] === en.word);
          if (row === undefined) return `no row '${e.label}' settled by ${en.word}`;
          for (const c of columns) if (row[c] !== en.cells[c - C.winner]) return `${e.label} / ${en.word}: '${COLUMNS[c]}' is ${String(row[c])}, the declaration gives ${en.cells[c - C.winner]}`;
        }
      return true;
    };
  const perFact =
    (suffixes: readonly ("Win" | "Loss" | "Total")[]): Claim["check"] =>
    (result) => {
      for (const e of expected)
        for (const en of e.entries)
          for (const s of suffixes) {
            const k = `${e.rowId}${upperFirst(en.d)}${s}`;
            if (result.facts[k] !== en.facts[s]) return `fact ${k} is ${String(result.facts[k])}, the declaration gives ${en.facts[s]}`;
          }
      return true;
    };
  return [
    mine("the rows are exactly the ways the league can settle a match beyond regulation, in order, and a sport that cannot has none", `reachableDecidedIn(cfg, "league") with the stage's deciders switched on`, (r) => {
      const got = rowsOfSport(r, sport).map((x) => `${String(x[C.sport])} / ${String(x[C.settled])}`);
      const want = expected.flatMap((e) => e.entries.map((en) => `${e.label} / ${en.word}`));
      return JSON.stringify(got) === JSON.stringify(want) || `rows are [${got.join("; ")}], the declarations give [${want.join("; ")}]`;
    }),
    mine("the winner's and the loser's points are what the rule pays by the chain so, then overtime, then regulation, or a draw plus the bonus", DECLARED, (r) => {
      const v = perEntry([C.winner, C.loser])(r);
      return v !== true ? v : perFact(["Win", "Loss"])(r);
    }),
    mine("the table books a shoot-out as a draw plus a bonus exactly where the sport's shootoutAs says so, and everything else as a win and a loss", "shootoutAs", perEntry([C.booked])),
    mine("the two sides together earn what a regulation win earns together", `${DECLARED} (win.regulation + loss.regulation)`, (r) => {
      const v = perEntry([C.together])(r);
      if (v !== true) return v;
      const w = perFact(["Total"])(r);
      if (w !== true) return w;
      for (const e of expected) {
        const reg = e.reg;
        if (r.facts[`${e.rowId}RegTotal`] !== pointsText(reg, "whole")) return `fact ${e.rowId}RegTotal is ${String(r.facts[`${e.rowId}RegTotal`])}, the declaration gives ${pointsText(reg, "whole")}`;
        for (const en of e.entries) if (en.w + en.l !== reg) return `${e.label} / ${en.word}: the sides earn ${en.w + en.l} together, a regulation win earns ${reg}`;
      }
      return true;
    }),
  ];
}

function acrossSports(): Claim[] {
  return [
    {
      says: "the sports that settle a league match beyond regulation, and the sports that never do, are counted and named from the registry, and add up to every sport",
      source: "reachableDecidedIn of every sport module, with the deciders switched on",
      check(result) {
        const beyond: string[] = [];
        const never: string[] = [];
        const visited = forEachSport(({ module }) => {
          (expectedFor(module).length > 0 ? beyond : never).push(sportLabel(module.key));
        });
        const f = result.facts;
        if (f.sportCount !== visited) return `sportCount is ${String(f.sportCount)}, the registry has ${visited}`;
        if (f.sportsBeyond !== beyond.length) return `sportsBeyond is ${String(f.sportsBeyond)}, the declarations give ${beyond.length}`;
        if (f.sportsRegulationOnly !== never.length) return `sportsRegulationOnly is ${String(f.sportsRegulationOnly)}, the declarations give ${never.length}`;
        if (beyond.length + never.length !== visited) return "the two groups do not add up to the registry";
        if (f.beyondList !== joinAnd(beyond)) return `beyondList is '${String(f.beyondList)}', the declarations give '${joinAnd(beyond)}'`;
        return f.regulationOnlyList === sentenceList(never) || `regulationOnlyList is '${String(f.regulationOnlyList)}', the declarations give '${sentenceList(never)}'`;
      },
    },
    {
      says: "of the sports that settle a league match beyond regulation, the post names the ones whose starting variant already plays its deciders in a new league stage, the ones that need them switched on, and the other variant that plays them from the start",
      source: "the variant's own config with the league stage preset (empty) laid over it, canEndLevel and deciderKeysFor of every sport (ENG/sport/module.d.ts), swept with forEachSport",
      check(result) {
        const beyond: string[] = [];
        forEachSport(({ module }) => {
          if (expectedFor(module).length > 0) beyond.push(sportLabel(module.key));
        });
        const d = declaredLeagueStages();
        if (d.swept === 0 || beyond.length === 0) return `anti-vacuity: ${d.swept} sports swept, ${beyond.length} settle beyond regulation`;
        const among = (labels: string[]) => labels.filter((l) => beyond.includes(l.replace(/ \(.*$/, "")));
        const [off, on, variants] = [among(d.level), among(d.decides), among(d.decidesVariants)];
        // Each list has something to say, and no sport is in two of them: the answer differs from a list that names everyone.
        if (off.length === 0 || on.length === 0 || variants.length === 0) return `anti-vacuity: ${off.length} sports start with deciders off, ${on.length} on, ${variants.length} variants on`;
        const want: [string, string][] = [
          ["leagueOffFromStart", lowerFirst(sentenceList(off))],
          ["leagueOnFromStart", sentenceList(on)],
          ["leagueOnVariants", sentenceList(variants)],
        ];
        for (const [k, v] of want) if (result.facts[k] !== v) return `${k} is '${String(result.facts[k])}', the declarations give '${v}'`;
        return true;
      },
    },
  ];
}

const claims: Claim[] = [...acrossSports()];
const sportsClaimed = forEachSport(({ module }) => {
  claims.push(...claimsFor(module));
});
if (sportsClaimed === 0) throw new Error("shootout-points: the sport registry is empty");

export const shootoutPoints: BlogExample = {
  id: SHOOTOUT_POINTS_ID,
  kind: "engine",
  sports: "all",
  build,
  claims,
};
