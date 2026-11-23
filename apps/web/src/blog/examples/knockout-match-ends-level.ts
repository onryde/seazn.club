// Post #18, "What happens when a knockout match ends level?". For every sport in the registry and every variant whose answer
// differs from the variant a new division starts on, a NEW knockout stage is configured the way the app creates one
// (`withStageDefaults`, the one door every stage create goes through: the sport's preset deciders written into the stage's
// rules), and a match of that stage resolves its rules the way every fixture does (`resolveFixtureCfg`: division, then the
// stage's rules, then the sport's forced bracket deciders), both through the app's own `quickMatchKnockoutCfg`. The words are the public format line's (`describeDeciders`, read
// through the public dictionary with `rulesLineText`), so the table says what a spectator's match page says.
//
// WHAT CHECKS IT: per sport, the claims recompute from the module's own declarations (`stageDefaultsFor`, `bracketDeciders`,
// `deciderKeysFor`, `canEndLevel`, `reachableResultKinds`) whether a decider is on, the numbers it carries and whether a match
// can still end level, and compare the committed cells to them. None reads `build()`.
import { forbidsLevelResult, type StageKind } from "@seazn/engine/core";
import { bracketMayEndLevel, deciderKeysFor, stageDefaultsFor, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveRungs, type TiebreakRung } from "@seazn/engine/sports/boardgame";
import { declaredCfgs, forEachSport } from "@seazn/engine/testkit";
import publicDict from "@/dictionaries/en/public.json";
import { sportLabel, variantLabel } from "@/blog/labels";
import { rulesLineText } from "@/lib/rules-line";
import { quickMatchKnockoutCfg } from "@/server/usecases/quick-match-sports";
import { describeDeciders } from "@/server/public-site/describe-rules";
import { withStageDefaults } from "@/server/usecases/stage-defaults";
import { startingVariantKey } from "./starting-variant";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const KNOCKOUT_LEVEL_ID = "knockout-match-ends-level";

const COLUMNS = ["Sport", "What a level knockout match goes to", "Can it still be level after that?"];
const C = { sport: 0, decider: 1, still: 2 } as const;
/** The sport cannot finish a match level at all, so it needs no decider. */
export const NEVER_LEVEL = "Nothing: a match always has a winner";
/** The sport declares no decider, and a match can be level: the organiser enters the winner. */
export const NO_DECIDER = "No decider: you enter who goes through";
export const STILL_YES = "Yes: the organiser decides who goes through";
export const STILL_NO = "No";

type Cfg = Record<string, unknown>;

function variantsOf(module: AnySportModule): { key: string; cfg: Cfg }[] {
  return declaredCfgs(module)
    .filter((c) => Object.hasOwn(module.variants, c.name))
    .map((c) => ({ key: c.name, cfg: c.cfg as Cfg }));
}

/** A match's rules in a NEW knockout stage of this variant, as the app resolves them: `quickMatchKnockoutCfg` is the app's
 *  one reading of a plain Knockout's match cfg before a fixture exists (the stage as `createStages` stores it, through
 *  `withStageDefaults`, then `resolveFixtureCfg`), so the example adds no new resolver call site. */
export function knockoutMatchCfg(module: AnySportModule, variant: string, variantCfg: Cfg): Cfg {
  return quickMatchKnockoutCfg(module, variant, variantCfg) as Cfg;
}

/** Can a match of this variant ever finish level (before any decider)? The sport's own declaration of its level results. */
function canBeLevel(module: AnySportModule, cfg: Cfg): boolean {
  return module.reachableResultKinds(cfg as never, "league").size > 0;
}

function cells(module: AnySportModule, variant: string, variantCfg: Cfg): [string, string] {
  const cfg = knockoutMatchCfg(module, variant, variantCfg);
  const clauses = describeDeciders(module, "knockout", cfg).filter((c) => c.key !== "format.rules.decider.thenOrganiser");
  const decider =
    clauses.length > 0 ? rulesLineText(publicDict as Record<string, unknown>, clauses) : canBeLevel(module, variantCfg) ? NO_DECIDER : NEVER_LEVEL;
  const still = canBeLevel(module, variantCfg) && bracketMayEndLevel(module, "knockout", cfg) ? STILL_YES : STILL_NO;
  return [decider, still];
}

function build(): ExampleResult {
  const rows: (string | number)[][] = [];
  const facts: Record<string, string | number> = {};
  const visited = forEachSport(({ key }) => {
    const sport = builtinModules.find((m) => m.key === key)!;
    const start = startingVariantKey(sport);
    const variants = variantsOf(sport);
    const first = variants.find((v) => v.key === start)!;
    const [d0, s0] = cells(sport, first.key, first.cfg);
    rows.push([sportLabel(key), d0, s0]);
    facts[`${key}Decider`] = d0;
    facts[`${key}StillLevel`] = s0;
    for (const v of variants) {
      if (v.key === start) continue;
      const [d, s] = cells(sport, v.key, v.cfg);
      if (d === d0 && s === s0) continue;
      rows.push([`${sportLabel(key)} (${variantLabel(key, v.key)})`, d, s]);
      const tag = `${key}${v.key.replace(/[^a-z0-9]/gi, "").replace(/^./, (c) => c.toUpperCase())}`;
      facts[`${tag}Decider`] = d;
      facts[`${tag}StillLevel`] = s;
    }
  });
  facts.sportCount = visited;
  // The numbers football's knockout plays, read off a match's resolved rules (the table's cells say the same).
  const footballModule = builtinModules.find((m) => m.key === "football")!;
  const fcfg = (variant: string) => knockoutMatchCfg(footballModule, variant, variantsOf(footballModule).find((v) => v.key === variant)!.cfg);
  const adult = fcfg(startingVariantKey(footballModule));
  facts.footballExtraTimeHalf = Number((adult.extraTime as Cfg).halfMinutes);
  facts.footballKicks = Number(adult.shootoutAttempts);
  facts.footballYouthKicks = Number(fcfg("youth").shootoutAttempts);
  // The same football variant in a LEAGUE stage: no preset decider, so a level match is a draw there.
  const football = builtinModules.find((m) => m.key === "football")!;
  const fv = startingVariantKey(football);
  const leagueStage = withStageDefaults(football, "league", fv, {});
  facts.footballLeagueRulesPreset = Object.keys((leagueStage.rules as Cfg | undefined) ?? {}).length;
  return {
    facts,
    table: {
      caption: `What a level match goes to in a new knockout stage, in all ${visited} sports. A variant gets its own row when its answer differs.`,
      columns: COLUMNS,
      rows,
    },
    text: [`A new football league stage starts with ${facts.footballLeagueRulesPreset} preset deciders.`],
  };
}

// ---- claims: recomputed from the declarations ----

const NUMERIC_LEAVES = new Set(["halfMinutes", "minutes", "attempts", "shootoutAttempts"]);

/** The decider keys a new knockout stage of this variant turns on, read off the declarations: the stage preset, plus the
 *  sport's forced bracket deciders. */
function declaredOn(module: AnySportModule, variant: string, variantCfg: Cfg): { keys: string[]; numbers: number[]; rungs: string[]; shootoutIsKicks: boolean } {
  const declared = new Set(deciderKeysFor(module, null, null));
  const preset = { ...stageDefaultsFor(module, "knockout" as StageKind, variant), ...(module.bracketDeciders(variantCfg as never) as Cfg) };
  const keys = Object.entries(preset)
    .filter(([k, v]) => declared.has(k) && v !== null && v !== false && !(typeof v === "object" && (v as Cfg).enabled === false))
    .map(([k]) => k);
  // Chess declares its decider as a list of tie-break rungs; a stage that stores none plays every rung (`effectiveRungs`).
  const rungs: string[] = [];
  if (declared.has("tiebreakRungs") && !keys.includes("tiebreakRungs")) {
    const stored = (variantCfg as { tiebreakRungs?: TiebreakRung[] }).tiebreakRungs;
    rungs.push(...effectiveRungs({ tiebreakRungs: Array.isArray(stored) ? stored : undefined }));
    if (rungs.length > 0) keys.push("tiebreakRungs");
  }
  const numbers: number[] = [];
  for (const k of keys) {
    const v = preset[k];
    if (typeof v === "object" && v !== null) for (const [leaf, n] of Object.entries(v as Cfg)) if (NUMERIC_LEAVES.has(leaf) && typeof n === "number") numbers.push(n);
  }
  for (const [k, n] of Object.entries(preset)) if (NUMERIC_LEAVES.has(k) && typeof n === "number" && keys.length > 0) numbers.push(n);
  return { keys, numbers, rungs, shootoutIsKicks: preset.shootout === true };
}

/** The public dictionary's word for a decider clause, up to its first number: "extra time", "penalties", "super over". */
function clauseWord(dictKey: string): string {
  const raw = String((publicDict as Record<string, unknown>)[`format.rules.decider.${dictKey}`] ?? `?${dictKey}`);
  return raw.split(/[({]/)[0]!.trim().toLowerCase();
}

/** The clause words a preset decider key is said with: football's shoot-out is a boolean (penalties), ice hockey's and
 *  hockey's an object (a shoot-out); chess says each rung it plays. */
function wordsFor(key: string, on: { rungs: string[]; shootoutIsKicks: boolean }): string[] {
  switch (key) {
    case "extraTime": return [clauseWord("extraTime")];
    case "shootout": return [clauseWord(on.shootoutIsKicks ? "penalties" : "shootout")];
    case "overtime": return [clauseWord("overtime")];
    case "superOver": return [clauseWord("superOver")];
    case "tieBoard": return [clauseWord("extraBoard")];
    case "tiebreakRungs": return on.rungs.map(clauseWord);
    default: return [`?${key}`];
  }
}

function rowFor(r: ExampleResult, label: string) {
  return r.table?.rows.find((row) => row[C.sport] === label);
}

function sportClaims(module: AnySportModule): Claim[] {
  const out: Claim[] = [];
  const start = startingVariantKey(module);
  for (const v of variantsOf(module)) {
    const label = v.key === start ? sportLabel(module.key) : `${sportLabel(module.key)} (${variantLabel(module.key, v.key)})`;
    const on = declaredOn(module, v.key, v.cfg);
    const level = canBeLevel(module, v.cfg);
    const declaredKeys = deciderKeysFor(module, null, null);
    // The variant's own row, or the sport's starting row when the variant shares its answer.
    const find = (r: ExampleResult) => rowFor(r, label) ?? rowFor(r, sportLabel(module.key));
    out.push({
      sport: module.key,
      says: `${label}: a level knockout match goes to the deciders the sport presets for a knockout, with their numbers`,
      source: "stageDefaults / bracketDeciders / deciderKeysFor (ENG/sport/module.d.ts:683,705; rule-keys.d.ts:19,37)",
      check: (r) => {
        const row = find(r);
        if (row === undefined) return `no row for ${label}`;
        const cell = String(row[C.decider]);
        if (on.keys.length === 0) {
          // A sport that declares deciders but presets none for this variant: the public line's own "none" words.
          const none = String((publicDict as Record<string, unknown>)["format.rules.decider.none"]);
          const want = declaredKeys.length > 0 ? none.charAt(0).toUpperCase() + none.slice(1) : level ? NO_DECIDER : NEVER_LEVEL;
          return cell === want || `${label}: no decider is preset, cell '${cell}', want '${want}'`;
        }
        if (cell === NO_DECIDER || cell === NEVER_LEVEL) return `${label}: ${on.keys.join(", ")} preset, cell '${cell}'`;
        const missing = on.numbers.filter((n) => !new RegExp(`\\b${n}\\b`).test(cell));
        if (missing.length > 0) return `${label}: cell '${cell}' lacks ${missing.join(", ")}`;
        // Each preset decider is named in the public line's words, one clause each, in no other words.
        const words = on.keys.flatMap((k) => wordsFor(k, on));
        const said = cell.split(", ").map((x) => x.toLowerCase());
        if (said.length !== words.length) return `${label}: ${said.length} clauses said, ${words.length} deciders preset (${words.join(", ")})`;
        const unsaid = words.filter((w) => !said.some((x) => x.startsWith(w)));
        return unsaid.length === 0 || `${label}: cell '${cell}' does not name ${unsaid.join(", ")}`;
      },
    });
    out.push({
      sport: module.key,
      says: `${label}: whether a knockout match can still end level after the deciders is the sport's own answer`,
      source: "canEndLevel (ENG/sport/module.d.ts:698) under the knockout cfg; reachableResultKinds (module.d.ts:655)",
      check: (r) => {
        const row = find(r);
        if (row === undefined) return `no row for ${label}`;
        const cfg = { ...v.cfg, ...stageDefaultsFor(module, "knockout" as StageKind, v.key), ...(module.bracketDeciders(v.cfg as never) as Cfg) };
        // A sport that declares no decider says nothing of its own (`canEndLevel` absent): a knockout refuses a level
        // result outright (`forbidsLevelResult`), so the organiser enters the winner and the match is never left level.
        const declaredLevel = typeof module.canEndLevel === "function" ? module.canEndLevel(cfg as never) : !forbidsLevelResult("knockout");
        const want = level && declaredLevel ? STILL_YES : STILL_NO;
        return row[C.still] === want || `${label}: '${row[C.still]}', declared '${want}'`;
      },
    });
  }
  return out;
}

const claims: Claim[] = [
  ...builtinModules.flatMap(sportClaims),
  {
    says: "football's knockout numbers are the ones its preset declares: extra time halves, and kicks per side for adults and for youth",
    source: "football stageDefaults('knockout', variant) (ENG/sports/football/football.js, stageDefaults)",
    check: (r) => {
      const football = builtinModules.find((m) => m.key === "football")!;
      const adult = stageDefaultsFor(football, "knockout" as StageKind, startingVariantKey(football)) as Cfg;
      const youth = stageDefaultsFor(football, "knockout" as StageKind, "youth") as Cfg;
      const want = [Number((adult.extraTime as Cfg | undefined)?.halfMinutes), Number(adult.shootoutAttempts), Number(youth.shootoutAttempts)];
      const got = [r.facts.footballExtraTimeHalf, r.facts.footballKicks, r.facts.footballYouthKicks];
      if (JSON.stringify(got) !== JSON.stringify(want)) return `facts ${got.join("/")}, declared ${want.join("/")}`;
      // The right answer differs from the wrong one: youth kicks are not the adult count.
      return want[1] !== want[2] || "youth and adult kick counts are equal, so the youth row cannot show the difference";
    },
  },
  {
    says: "every sport in the registry has a row",
    source: "the registry (ENG/sports/index.js), swept with forEachSport",
    check: (r) => {
      const missing = builtinModules.filter((m) => rowFor(r, sportLabel(m.key)) === undefined).map((m) => m.key);
      return (missing.length === 0 && r.facts.sportCount === builtinModules.length) || `missing ${missing.join(", ")}; count ${r.facts.sportCount}`;
    },
  },
  {
    says: "a knockout preset differs from a league's: a new football league stage presets no decider, so a level league match stays a draw",
    source: "stageDefaults('league') is empty for football (ENG/sports/football/football.js stageDefaults); a draw pays tablePointsRule's draw",
    check: (r) => {
      const football = builtinModules.find((m) => m.key === "football")!;
      const league = Object.keys(stageDefaultsFor(football, "league" as StageKind, startingVariantKey(football))).length;
      const knockout = Object.keys(stageDefaultsFor(football, "knockout" as StageKind, startingVariantKey(football))).length;
      if (knockout === 0 || league !== 0) return `football presets: knockout ${knockout}, league ${league}`;
      return r.facts.footballLeagueRulesPreset === league || `the league stage was written with ${r.facts.footballLeagueRulesPreset} deciders`;
    },
  },
];

export const knockoutMatchEndsLevel: BlogExample = {
  id: KNOCKOUT_LEVEL_ID,
  kind: "engine",
  sports: "all",
  build,
  claims,
};
