// Applicability (design §4, W1b Task 6). State transitions and empty cases
// first (TEST-STRATEGY rule 1): a rule set where nothing applies, a missing
// rule, an unknown scenario filter, a second plan, a variant that enables a
// rule but cannot be scored, another sport (every sweep walks the registry).
// Expected values come from the product and the engine — the row's real stage
// bodies, supportsDraws, entrantModel, eventSchemas, the schema.json files,
// withdrawTableEntrant, a real fold of core.abandon, the product's table-kind
// literal — never from applicability.ts itself.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EngineError, StageKind } from "@seazn/engine/core";
import { BRACKET_STAGE_KINDS, withdrawTableEntrant } from "@seazn/engine/competition";
import { describe, expect, it } from "vitest";
import { configKeysFor } from "../../../apps/web/src/lib/match-rules.ts";
import { ROW_KEYS, SPORT_KEYS, stagesForRow, type RowKey } from "../lib/catalogue.ts";
import {
  ABANDON_RESULTS, DECIDERS, LEVEL_PROBES, MissingRule, RULES, TABLE_KINDS, UnknownScenario, UnresolvedFeeder, cellFacts, decide, planL3, rowCounts, scenarioCounts, stageFactsOf,
  type CellFacts, type PlannedCase, type Rule, type WitnessCell,
} from "../lib/applicability.ts";
import { foldStream } from "../lib/fold.ts";
import { ATOMIC, LIFECYCLE_ID, l3Atomic } from "../lib/scenario-catalogue.ts";
import { entrantKindsFor, resolveSportCfg, sportModule } from "../lib/sport-cfg.ts";
import { generateStream } from "../lib/streams/index.ts";
import { ALL_OUTCOMES, GeneratorUnsupported, START, type StreamEvent } from "../lib/streams/types.ts";
import { buildSportVariants, offlineBuilderDefault, type SportVariants } from "../lib/variants.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const variants = SPORT_KEYS.map((s) => buildSportVariants(s));
const variantsOf = (s: string): SportVariants => variants.find((v) => v.sport === s)!;
const base = planL3({ variants });
const L3_IDS = [LIFECYCLE_ID, ...l3Atomic().map((a) => a.id)];
const factsAt = (w: WitnessCell): CellFacts => {
  const [row, sport] = w.cell.split("|") as [RowKey, string];
  return cellFacts(row, sport, w.preset, undefined, w.values);
};
const schemaProps = (sport: string): string[] =>
  Object.keys((JSON.parse(readFileSync(resolve(REPO, "packages/engine/src/sports", sport, `${sport}.schema.json`), "utf8")) as { configSchema: { properties: Record<string, unknown> } }).configSchema.properties);

/** Engine sport directories with a non-test source that emits a `kind: "tie"`
 *  outcome (MatchOutcome's tie). Read from the engine's source text, so a new
 *  tie-capable sport reds the LEVEL_PROBES guard instead of hiding from M5. */
const SPORTS_SRC = resolve(REPO, "packages/engine/src/sports");
const TIE_SOURCE_DIRS = new Set((readdirSync(SPORTS_SRC, { recursive: true }) as string[])
  .filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.split(sep).includes("__tests__"))
  .filter((p) => /kind:\s*"tie"/.test(readFileSync(resolve(SPORTS_SRC, p), "utf8")))
  .map((p) => p.split(sep)[0]!));
/** The pinned text of M5's harness-gap reason (applicability.ts). */
const TIE_GAP_REASON = "the L3 generator has no tie outcome (streams/types.ts RequestedOutcome), and here a tie is reachable (fold-proven: level scores fold to {kind:\"tie\"} through the engine) with a bracket stage that has no tied result to place — routed W1-driving";
/** A level-scores stream built WITHOUT LEVEL_PROBES: the generator's own
 *  home-win stream with the chase's runs set to the first innings' (cricket's
 *  shape, START + one summary per innings — streams/cricket.ts), folded by the
 *  real engine. A sport whose engine emits no tie (TIE_SOURCE_DIRS) is null
 *  without a fold; a stream the generator or engine refuses is "refused". */
function independentLevelFold(sport: string, cfg: Readonly<Record<string, unknown>>): string | null {
  if (!TIE_SOURCE_DIRS.has(sport)) return null;
  let win: StreamEvent[];
  try {
    win = generateStream({ sportKey: sport, cfg, stageKind: "knockout", home: "H", away: "A", outcome: { kind: "win", winner: "home" } });
  } catch (e) {
    if (e instanceof GeneratorUnsupported) return "refused";
    throw e;
  }
  const [start, first, chase, ...rest] = win;
  if (start?.type !== "core.start" || first?.type !== "cricket.innings.summary" || chase?.type !== "cricket.innings.summary" || rest.length > 0) {
    throw new Error(`independentLevelFold: ${sport}'s win stream is not START + two innings summaries — build its level stream here`);
  }
  const level = [start, first, { ...chase, payload: { ...(chase.payload as object), runs: (first.payload as { runs: number }).runs } }];
  try {
    return foldStream(sportModule(sport), cfg, "H", "A", level).outcome?.kind ?? null;
  } catch (e) {
    if (EngineError.is(e)) return "refused";
    throw e;
  }
}

// --- the guards, as functions: the real tests run them on RULES and expect
// nothing; the trap-1 sweep runs them on mutants and expects a catch. -------
function witnessFailures(id: string, r: Rule): string[] {
  if (r.witness === null) return r.reason === "" ? [] : [`${id}: a rule that never drops carries a drop reason`];
  const out: string[] = [];
  if (r.reason.length <= 10) out.push(`${id}: no written drop reason`);
  for (const k of [r.witness.keep, ...r.witness.alsoKeep]) if (!r.when(factsAt(k))) out.push(`${id}: keep witness ${k.cell} answers false`);
  if (r.when(factsAt(r.witness.drop))) out.push(`${id}: drop witness ${r.witness.drop.cell} answers true`);
  return out;
}
function alwaysFailures(id: string, r: Rule): string[] {
  if (r.witness !== null) return [];
  const out: string[] = [];
  for (const row of ROW_KEYS) for (const s of SPORT_KEYS) if (!r.when(cellFacts(row, s))) out.push(`${id} ${row}|${s}`);
  return out;
}
/** Models the committed floors (Task 8's floors.json is generated from this
 *  same unmutated plan): a count below its floor is a red. */
const floors = { perRow: rowCounts(base.cases), perScenario: scenarioCounts(base.cases) };
function floorBreaches(cases: readonly PlannedCase[]): string[] {
  const r = rowCounts(cases);
  const s = scenarioCounts(cases);
  return [
    ...ROW_KEYS.filter((k) => (r[k] ?? 0) < (floors.perRow[k] ?? 0)).map((k) => `row ${k}`),
    ...Object.keys(floors.perScenario).filter((k) => (s[k] ?? 0) < (floors.perScenario[k] ?? 0)).map((k) => `scenario ${k}`),
  ];
}

describe("entrantKindsFor — the engine's declared entrant model, per division cfg", () => {
  it("registry sweep: a declared model gives its own kinds; an undeclared one gives every kind any module declares", () => {
    const declared = new Set(SPORT_KEYS.flatMap((s) => sportModule(s).entrantModel?.kinds ?? []));
    let withModel = 0;
    let without = 0;
    for (const s of SPORT_KEYS) {
      const kinds = sportModule(s).entrantModel?.kinds;
      const got = entrantKindsFor(s, cellFacts("league", s).cfg);
      if (kinds !== undefined && kinds.length > 0) { expect(got, s).toEqual([...kinds]); withModel++; }
      else { expect(new Set(got), s).toEqual(declared); without++; }
    }
    expect(withModel).toBeGreaterThan(0);
    expect(without).toBeGreaterThan(0); // generic: the "every kind" branch is judged, not assumed
  });
  it("a division's `entrants.kinds` override narrows it; an empty or unknown override falls back to the module", () => {
    // single-sport: badminton declares two kinds, so narrowing to one is observable.
    const own = [...(sportModule("badminton").entrantModel?.kinds ?? [])];
    expect(own.length).toBeGreaterThan(1);
    expect(entrantKindsFor("badminton", { entrants: { kinds: ["pair"] } })).toEqual(["pair"]);
    expect(entrantKindsFor("badminton", { entrants: { kinds: [] } })).toEqual(own);
    expect(entrantKindsFor("badminton", { entrants: { kinds: ["robot"] } })).toEqual(own);
    expect(entrantKindsFor("badminton", {})).toEqual(own);
  });
});

describe("applicability — rules cover the catalogue", () => {
  it("one rule per atomic id plus LIFECYCLE, and nothing else", () => {
    expect(new Set(Object.keys(RULES))).toEqual(new Set([LIFECYCLE_ID, ...ATOMIC.map((a) => a.id)]));
  });
  it("every narrowing rule states a drop reason and carries a keep/drop witness (kills `return true`)", () => {
    let narrowing = 0;
    let arms = 0;
    const failures: string[] = [];
    for (const [id, r] of Object.entries(RULES)) {
      if (r.witness !== null) { narrowing++; arms += r.witness.alsoKeep.length; }
      failures.push(...witnessFailures(id, r));
    }
    expect(failures).toEqual([]);
    expect(narrowing).toBeGreaterThan(0);
    // Disjunctive predicates carry one keep witness per further arm; zero here
    // means the helper dropped them and each arm's deletion would stay green.
    expect(arms).toBeGreaterThan(0);
  });
  it("every non-narrowing rule applies to every cell at the builder default (it is `always`, not a hidden narrowing)", () => {
    let judged = 0;
    const failures: string[] = [];
    for (const [id, r] of Object.entries(RULES)) if (r.witness === null) { judged++; failures.push(...alwaysFailures(id, r)); }
    expect(failures).toEqual([]);
    expect(judged).toBeGreaterThan(0);
  });
  it("a rule NOT marked variantDependent answers the same under every committed variant as at the default (so binding could never change it)", () => {
    const fixed = Object.entries(RULES).filter(([, r]) => !r.variantDependent && r.witness !== null);
    expect(fixed.length).toBeGreaterThan(0);
    let judged = 0;
    const failures: string[] = [];
    for (const v of variants) for (const row of ROW_KEYS) {
      const at = fixed.map(([, r]) => r.when(cellFacts(row, v.sport)));
      for (const vc of v.cases) {
        const f = cellFacts(row, v.sport, vc.preset, vc.overrides as Record<string, unknown>);
        fixed.forEach(([id, r], i) => { if (r.when(f) !== at[i]) failures.push(`${id} ${row}|${v.sport} under ${vc.id}`); judged++; });
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
    expect(judged).toBe(fixed.length * ROW_KEYS.length * variants.reduce((n, v) => n + v.cases.length, 0));
    expect(judged).toBeGreaterThan(0);
  });
  it("cellFacts refuses witness values the editor cannot send (a named refusal, not a silent default)", () => {
    // single-sport: the refusal is buildVariant's (a field the editor does not show), the same for every sport.
    expect(() => cellFacts("league", "badminton", undefined, undefined, { notAField: "1" })).toThrow(/witness values invalid/);
    expect(() => cellFacts("league", "badminton", undefined, undefined, {})).not.toThrow();
  });
});

describe("applicability — predicates against the product's own declarations", () => {
  it("TABLE_KINDS is a text-pinned copy of the product's points-table kinds (engine-db/competition.ts)", () => {
    const src = readFileSync(resolve(REPO, "apps/web/src/server/engine-db/competition.ts"), "utf8");
    const m = /const TABLE_KINDS = new Set\(\[([^\]]*)\]\)/.exec(src);
    expect(m, "TABLE_KINDS literal not found").not.toBeNull();
    const kinds = [...m![1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).toEqual([...TABLE_KINDS]);
  });
  it("a points-table scenario (ties F5a/F5b/F6/F7, deduction C5) applies exactly where a row has a points-table stage; ladder is not one (its order is ladder_order)", () => {
    let judged = 0;
    for (const id of ["F5a", "F5b", "F6", "F7", "C5"]) for (const row of ROW_KEYS) for (const s of SPORT_KEYS) {
      const expected = stagesForRow(row).some((st) => TABLE_KINDS.includes(st.kind));
      expect(RULES[id]!.when(cellFacts(row, s)), `${id} ${row}|${s}`).toBe(expected);
      judged++;
    }
    expect(judged).toBe(5 * ROW_KEYS.length * SPORT_KEYS.length);
    expect(RULES.F5a!.when(cellFacts("ladder", "generic"))).toBe(false);
  });
  it("Q4a (final not played) applies exactly where a row has a stage the ENGINE declares bracket-shaped (BRACKET_STAGE_KINDS)", () => {
    let judged = 0;
    for (const row of ROW_KEYS) for (const s of SPORT_KEYS) {
      expect(RULES.Q4a!.when(cellFacts(row, s)), `${row}|${s}`).toBe(stagesForRow(row).some((st) => BRACKET_STAGE_KINDS.has(st.kind)));
      judged++;
    }
    expect(judged).toBe(ROW_KEYS.length * SPORT_KEYS.length);
  });
  it("R4b (half or more played) applies exactly where a row has a stage whose early withdrawal the ENGINE expunges (withdrawTableEntrant)", () => {
    // Ask the engine: 0 of 1 played is under half; which table kinds expunge it?
    const expunges = (["league", "group", "swiss"] as const).filter((kind) =>
      withdrawTableEntrant({ id: "s", kind, entrants: [], cascade: [] }, "w", { played: [], pending: [{ id: "p", opponent: "o" }] })
        .events.some((e) => (e as { mode?: string }).mode === "expunge"));
    expect(expunges.length).toBeGreaterThan(0);
    let judged = 0;
    for (const row of ROW_KEYS) for (const s of SPORT_KEYS) {
      expect(RULES.R4b!.when(cellFacts(row, s)), `${row}|${s}`).toBe(stagesForRow(row).some((st) => (expunges as readonly string[]).includes(st.kind)));
      judged++;
    }
    expect(judged).toBe(ROW_KEYS.length * SPORT_KEYS.length);
  });
  it("M5 applies exactly where a DRAW the sport allows somewhere is refused by some stage (supportsDraws), or a TIE the engine folds reaches a bracket stage (registry sweep)", () => {
    let judged = 0;
    let draw = 0;
    let tieOnly = 0;
    for (const row of ROW_KEYS) for (const s of SPORT_KEYS) {
      const f = cellFacts(row, s);
      const m = sportModule(s);
      const draws = (k: string) => m.supportsDraws(f.cfg as never, k as never);
      const drawArm = stagesForRow(row).some((st) => !draws(st.kind)) && StageKind.options.some(draws);
      const tieArm = stagesForRow(row).some((st) => BRACKET_STAGE_KINDS.has(st.kind)) && independentLevelFold(s, f.cfg) === "tie";
      expect(RULES.M5!.when(f), `${row}|${s}`).toBe(drawArm || tieArm);
      judged++;
      if (drawArm) draw++;
      else if (tieArm) tieOnly++;
    }
    expect(judged).toBe(ROW_KEYS.length * SPORT_KEYS.length);
    expect(draw).toBeGreaterThan(0);
    expect(tieOnly).toBeGreaterThan(0); // the arm supportsDraws cannot see is judged, not assumed
  });
});

describe("M5's tie arm — a level result supportsDraws does not declare (I-1)", () => {
  it("every engine source that emits a `kind: \"tie\"` outcome lives under a sport LEVEL_PROBES probes, and every probe has one", () => {
    expect([...TIE_SOURCE_DIRS].length).toBeGreaterThan(0);
    expect(new Set(Object.keys(LEVEL_PROBES))).toEqual(TIE_SOURCE_DIRS);
  });
  it("levelFold is the engine's answer: parity with an independently built level stream over every cricket preset and committed variant — and both answers occur", () => {
    // single-sport: cricket is the only sport whose engine emits a tie (guard above).
    let judged = 0;
    let refused = 0;
    const answers = new Set<string | null>();
    const cfgs = [
      ...Object.keys(sportModule("cricket").variants as Record<string, unknown>).map((p) => ({ preset: p, overrides: {} as Record<string, unknown> })),
      ...variantsOf("cricket").cases.map((c) => ({ preset: c.preset, overrides: c.overrides as Record<string, unknown> })),
    ];
    for (const c of cfgs) {
      const f = cellFacts("knockout", "cricket", c.preset, c.overrides);
      const expected = independentLevelFold("cricket", f.cfg);
      if (expected === "refused") { refused++; continue; }
      expect(f.levelFold, `${c.preset} ${JSON.stringify(c.overrides)}`).toBe(expected);
      answers.add(expected);
      judged++;
    }
    expect(judged).toBeGreaterThan(0);
    expect(answers).toEqual(new Set(["tie", null]));
    expect(judged + refused).toBe(cfgs.length);
  });
  it("witness: a cricket knockout at the builder default can end TIED (fold-proven, no draw declared) and M5 SEES it; super over on, or no bracket, it does not", () => {
    // single-sport: cricket is the only sport whose engine emits a tie.
    const f = cellFacts("knockout", "cricket");
    expect(f.preset).toBe(offlineBuilderDefault("cricket"));
    expect(independentLevelFold("cricket", f.cfg)).toBe("tie");
    expect(StageKind.options.some((k) => sportModule("cricket").supportsDraws(f.cfg as never, k))).toBe(false);
    expect(RULES.M5!.when(f)).toBe(true);
    const superOver = cellFacts("knockout", "cricket", undefined, { superOver: true });
    expect(independentLevelFold("cricket", superOver.cfg)).toBe(null);
    expect(RULES.M5!.when(superOver)).toBe(false);
    const league = cellFacts("league", "cricket");
    expect(league.levelFold).toBe("tie");
    expect(RULES.M5!.when(league)).toBe(false); // a points table pays points.tie
  });
  it("M5's drop reason is true in every non-bracket stage kind the engine declares: a points table pays a tie, and a ladder is not a points table (T8 carry)", () => {
    // Every stage kind that is not bracket-shaped (engine StageKind minus
    // BRACKET_STAGE_KINDS) is where "meets no bracket stage" lands a tie, so
    // the reason must say why each one takes it.
    const nonBracket = StageKind.options.filter((k) => !BRACKET_STAGE_KINDS.has(k));
    let checked = 0;
    for (const k of nonBracket) {
      if (TABLE_KINDS.includes(k)) expect(RULES.M5!.reason, k).toContain("a points table pays a tie");
      else expect(RULES.M5!.reason, k).toContain(`a ${k}'s order moves only on a winner`);
      checked++;
    }
    expect(checked).toBe(nonBracket.length);
    expect(nonBracket.filter((k) => !TABLE_KINDS.includes(k))).toContain("ladder");
    // The ladder premise, text-pinned: the product reorders a ladder only when the match has a winner.
    const scoring = readFileSync(resolve(REPO, "apps/web/src/server/usecases/scoring.ts"), "utf8");
    expect(scoring).toContain('if (fixture.kind === "ladder" && winner !== undefined && loser !== undefined) {');
    // And it reaches the drops: the ladder row's M5 drops carry it.
    const ladder = base.drops.filter((d) => d.row === "ladder" && d.scenario === "M5");
    expect(ladder.length).toBeGreaterThan(0);
    for (const d of ladder) expect(d.reason, d.cell).toContain("a ladder's order moves only on a winner");
  });
  it("the harness cannot drive a tie yet, so every cricket bracket cell DROPS M5 with the TRUE reason; no cricket cell says it never ends level", () => {
    // single-sport: cricket is the only sport whose engine emits a tie.
    expect(ALL_OUTCOMES.map((o) => o.kind as string)).not.toContain("tie"); // the gap's premise
    let bracketRows = 0;
    for (const row of ROW_KEYS) {
      const d = base.drops.find((x) => x.cell === `${row}|cricket` && x.scenario === "M5");
      expect(d, `${row}|cricket plans M5 with no tie outcome to request`).toBeDefined();
      expect(d!.reason, row).not.toMatch(/never ends level/);
      if (stagesForRow(row).some((st) => BRACKET_STAGE_KINDS.has(st.kind))) {
        expect(d!.reason.startsWith(TIE_GAP_REASON), `${row}: ${d!.reason}`).toBe(true);
        expect(d!.reason, row).toContain(`; it applies at `);
        expect(d!.reason, row).toContain(`${offlineBuilderDefault("cricket")} (builder default)`);
        bracketRows++;
      } else {
        expect(d!.reason, row).not.toContain(TIE_GAP_REASON);
      }
    }
    expect(bracketRows).toBeGreaterThan(0);
    expect(bracketRows).toBeLessThan(ROW_KEYS.length);
    // The drop records the gap apart from a real inapplicability (T8: the
    // committed drop list). M5 is the only rule with a harness gap today, so
    // the gap drops are exactly the cricket bracket rows.
    expect(Object.entries(RULES).filter(([, r]) => r.gap !== undefined).map(([id]) => id)).toEqual(["M5"]);
    let flagged = 0;
    for (const row of ROW_KEYS) {
      const d = base.drops.find((x) => x.cell === `${row}|cricket` && x.scenario === "M5")!;
      expect(d.harnessGap, row).toBe(stagesForRow(row).some((st) => BRACKET_STAGE_KINDS.has(st.kind)));
      flagged++;
    }
    expect(flagged).toBe(ROW_KEYS.length);
    expect(base.drops.filter((x) => x.harnessGap).length).toBe(bracketRows);
    // The gap is the tie arm ALONE: where a refused draw also holds, the
    // generator's draw request drives M5, so there is no gap. No committed cfg
    // has both (a two-innings level stream is undecided), so the facts are
    // synthetic: the two-innings preset's draw facts with a tie grafted on.
    const both: CellFacts = { ...cellFacts("knockout", "cricket", "test"), levelFold: "tie" };
    expect(RULES.M5!.when(both)).toBe(true);
    expect(RULES.M5!.gap!.when(both)).toBe(false);
    expect(RULES.M5!.gap!.when(cellFacts("knockout", "cricket"))).toBe(true);
    const ko = base.drops.find((x) => x.cell === "knockout|cricket" && x.scenario === "M5")!;
    expect(ko.reason).toMatch(/; the other committed variants that enable it \(\d+: cricket#\d+/);
  });
});

describe("M-1/M-2 — which stage feeds which", () => {
  const table = cellFacts("league", "generic");
  const synthetic = (stages: CellFacts["stages"]): CellFacts => ({ ...table, stages });
  const fact = (kind: string, sources: { from: number; take: string[] }[] = []) => ({ kind, config: {}, takes: sources.flatMap((s) => s.take), sources });
  it("Q4b's bracket conjunct is live: a table stage fed by a table (no bracket anywhere) has no final to fall back from", () => {
    const f = synthetic([fact("league"), fact("group", [{ from: 0, take: ["topNPerGroup"] }])]);
    expect(RULES.P2!.when(f)).toBe(true); // it IS table-fed
    expect(RULES.Q4b!.when(f)).toBe(false);
    expect(RULES.Q4b!.when(synthetic([fact("league"), fact("knockout", [{ from: 0, take: ["rankRange"] }])]))).toBe(true);
  });
  it("a table feed is judged from the stage each source NAMES, not the stage before it", () => {
    const feederFirst = synthetic([fact("league"), fact("knockout"), fact("knockout", [{ from: 0, take: ["rankRange"] }])]);
    expect(RULES.P2!.when(feederFirst)).toBe(true);
    const tableBefore = synthetic([fact("knockout"), fact("league"), fact("knockout", [{ from: 0, take: ["rankRange"] }])]);
    expect(RULES.P2!.when(tableBefore)).toBe(false);
  });
  it("stageFactsOf refuses a feeder it cannot resolve offline (a { stageId }, or \"previous\" on the first stage), naming row and stage", () => {
    const take = [{ kind: "rankRange" }];
    const byId = () => stageFactsOf("synthetic", [{ kind: "league", config: {} }, { kind: "knockout", config: {}, progression: { sources: [{ stage: { stageId: "00000000-0000-4000-8000-000000000001" }, take }] } }]);
    expect(byId).toThrow(UnresolvedFeeder);
    expect(byId).toThrow(/row 'synthetic' stage 2/);
    expect(() => stageFactsOf("synthetic", [{ kind: "knockout", config: {}, progression: { sources: [{ stage: "previous", take }] } }])).toThrow(/row 'synthetic' stage 1/);
  });
  it("registry sweep: every catalogue row's sources resolve to the stage before them (\"previous\")", () => {
    let judged = 0;
    for (const row of ROW_KEYS) {
      const bodies = stagesForRow(row);
      stageFactsOf(row, bodies).forEach((s, i) => {
        expect(s.sources.length, `${row} stage ${i + 1}`).toBe(bodies[i]!.progression?.sources.length ?? 0);
        for (const src of s.sources) { expect(src.from, `${row} stage ${i + 1}`).toBe(i - 1); judged++; }
      });
    }
    expect(judged).toBeGreaterThan(0);
  });
});

describe("applicability — the L3 plan", () => {
  it("empty case first: a rule set where nothing applies plans LIFECYCLE only, and drops name their reason", () => {
    const none: Record<string, Rule> = Object.fromEntries(Object.keys(RULES).map((k) => [k, k === LIFECYCLE_ID ? RULES[k]! : { when: () => false, reason: "test: nothing applies", variantDependent: false, witness: null }]));
    const p = planL3({ rules: none, variants });
    expect(p.cases.length).toBe(ROW_KEYS.length * SPORT_KEYS.length);
    expect(p.cases.every((c) => c.scenario === LIFECYCLE_ID)).toBe(true);
    expect(p.drops.length).toBe(ROW_KEYS.length * SPORT_KEYS.length * (L3_IDS.length - 1));
    expect(p.drops.every((d) => d.reason === "test: nothing applies")).toBe(true);
  });
  it("a rule set missing an L3 id is refused, naming the id (not silently skipped)", () => {
    const { M1: _m1, ...rest } = RULES;
    expect(() => planL3({ rules: rest, variants })).toThrow(MissingRule);
    expect(() => planL3({ rules: rest, variants })).toThrow(/'M1'/);
  });
  it("an `only` filter naming a non-L3 or unknown id is refused (a typo would plan nothing and read green)", () => {
    expect(() => planL3({ variants, only: ["E3"] })).toThrow(UnknownScenario);
    expect(() => planL3({ variants, only: ["M99"] })).toThrow(UnknownScenario);
    expect(planL3({ variants, only: ["M1"] }).cases.length).toBeGreaterThan(0);
  });
  it("an EMPTY `only` filter is refused, naming the empty set (it would plan nothing and read green)", () => {
    expect(() => planL3({ variants, only: [] })).toThrow(UnknownScenario);
    expect(() => planL3({ variants, only: [] })).toThrow(/'only' is empty/);
  });
  it("every (cell, L3 id) is decided exactly once: planned or dropped, never both, never neither", () => {
    const seen = new Map<string, number>();
    for (const x of [...base.cases, ...base.drops]) seen.set(`${x.cell}#${x.scenario}`, (seen.get(`${x.cell}#${x.scenario}`) ?? 0) + 1);
    expect(seen.size).toBe(ROW_KEYS.length * SPORT_KEYS.length * L3_IDS.length);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
  });
  it("LIFECYCLE runs in every one of the 231 cells; every drop has a non-empty reason", () => {
    expect(base.cases.filter((c) => c.scenario === LIFECYCLE_ID).length).toBe(ROW_KEYS.length * SPORT_KEYS.length);
    expect(base.drops.length).toBeGreaterThan(0);
    expect(base.drops.every((d) => d.reason.length > 0)).toBe(true);
  });
  it("per-scenario floor: every L3 scenario applies to at least one cell (else its predicate is untestable)", () => {
    const c = scenarioCounts(base.cases);
    let judged = 0;
    for (const id of L3_IDS) { expect(c[id] ?? 0, id).toBeGreaterThan(0); judged++; }
    expect(judged).toBe(l3Atomic().length + 1);
  });
  it("per-row floor: every row plans more than LIFECYCLE in every sport", () => {
    const perCell = new Map<string, number>();
    for (const c of base.cases) perCell.set(c.cell, (perCell.get(c.cell) ?? 0) + 1);
    expect(perCell.size).toBe(ROW_KEYS.length * SPORT_KEYS.length);
    for (const [cell, n] of perCell) expect(n, cell).toBeGreaterThan(1);
    for (const r of ROW_KEYS) expect(floors.perRow[r] ?? 0, r).toBeGreaterThan(SPORT_KEYS.length);
  });
  it("trap 1 — every rule forced to `return false` is caught: every rule by its witness or always guard, every L3 rule by BOTH floors", () => {
    let all = 0;
    let l3 = 0;
    for (const [id, r] of Object.entries(RULES)) {
      const mutant: Rule = { ...r, when: () => false, variantDependent: false };
      expect([...witnessFailures(id, mutant), ...alwaysFailures(id, mutant)].length, `${id}: witness/always guard`).toBeGreaterThan(0);
      all++;
      if (!L3_IDS.includes(id)) continue;
      // planL3 decides each id on its own, so the mutated full plan is the
      // unmutated plan with this id's cases re-planned under the mutant.
      const cases = [...base.cases.filter((c) => c.scenario !== id), ...planL3({ rules: { ...RULES, [id]: mutant }, variants, only: [id] }).cases];
      const breaches = floorBreaches(cases);
      expect(breaches.some((b) => b.startsWith("row ")), `${id}: per-row floor`).toBe(true);
      expect(breaches, `${id}: per-scenario floor`).toContain(`scenario ${id}`);
      l3++;
    }
    expect(all).toBe(ATOMIC.length + 1);
    expect(l3).toBe(l3Atomic().length + 1);
    expect(floorBreaches(base.cases)).toEqual([]); // and the unmutated plan breaches nothing
  });
  it("trap 1, other half — every narrowing rule forced to `return true` is caught by its drop witness (the guard's drop half is live)", () => {
    let judged = 0;
    for (const [id, r] of Object.entries(RULES)) {
      if (r.witness === null) continue;
      expect(witnessFailures(id, { ...r, when: () => true }), id).toContain(`${id}: drop witness ${r.witness.drop.cell} answers true`);
      judged++;
    }
    expect(judged).toBe(Object.values(RULES).filter((r) => r.witness !== null).length);
    expect(judged).toBeGreaterThan(0);
  });
  it("variant binding: M6 on football binds to a committed, scorable variant with a decider on, never drops", () => {
    // single-sport: football's builder default has extraTime/shootout off — the pinned example of a bound case.
    const m6 = base.cases.filter((c) => c.scenario === "M6" && c.sport === "football");
    expect(m6.length).toBe(ROW_KEYS.length);
    const vc = variantsOf("football").cases;
    for (const c of m6) {
      expect(c.bound).not.toBeNull();
      const bound = vc.find((x) => x.id === c.bound)!;
      expect(bound.scorable).toBeNull();
      expect(c.preset).toBe(bound.preset);
      expect(DECIDERS.football!(cellFacts(c.row, "football", bound.preset, bound.overrides as Record<string, unknown>).cfg)).toBe(true);
    }
  });
  it("every bound case names a committed, scorable variant of its own sport under which its rule holds (registry sweep)", () => {
    const bound = base.cases.filter((c) => c.bound !== null);
    expect(bound.length).toBeGreaterThan(0);
    for (const c of bound) {
      const vc = variantsOf(c.sport).cases.find((x) => x.id === c.bound);
      expect(vc, `${c.cell} ${c.scenario}`).toBeDefined();
      expect(vc!.scorable, `${c.cell} ${c.scenario}`).toBeNull();
      expect(RULES[c.scenario]!.variantDependent, c.scenario).toBe(true);
      const r = RULES[c.scenario]!;
      const at = cellFacts(c.row, c.sport);
      expect(r.when(at) && r.gap?.when(at) !== true, `${c.cell} ${c.scenario}: applies at the default with no harness gap, so must not bind`).toBe(false);
      const under = cellFacts(c.row, c.sport, vc!.preset, vc!.overrides as Record<string, unknown>);
      expect(r.when(under), `${c.cell} ${c.scenario}`).toBe(true);
      expect(r.gap?.when(under) ?? false, `${c.cell} ${c.scenario}: bound under a harness gap`).toBe(false);
    }
  });
  it("a variant that enables a rule but cannot be scored is skipped; if only such variants exist the drop says so", () => {
    // single-sport: cricket's M4b is reachable only through committed variants (DLS on).
    const real = variantsOf("cricket");
    const first = decide(RULES.M4b!, "league", "cricket", variants);
    expect(first.applies).toBe(true);
    expect(first.bound).not.toBeNull();
    const poisoned: SportVariants = { ...real, cases: real.cases.map((c) => (c.id === first.bound ? { ...c, scorable: "test: unscorable" } : c)) };
    const second = decide(RULES.M4b!, "league", "cricket", [poisoned]);
    expect(second.bound).not.toBe(first.bound);
    expect(second.unscorable).toContain(first.bound);
    const allBad: SportVariants = { ...real, cases: real.cases.map((c) => ({ ...c, scorable: "test: unscorable" })) };
    const p = planL3({ variants: [...variants.filter((v) => v.sport !== "cricket"), allBad], only: ["M4b"] });
    const drops = p.drops.filter((d) => d.sport === "cricket");
    expect(drops.length).toBe(ROW_KEYS.length);
    for (const d of drops) expect(d.reason).toMatch(/cannot be scored by the harness/);
    // …and with no variants at all it says no variant enables it.
    const bare = planL3({ variants: [], only: ["M4b"] });
    expect(bare.drops.filter((d) => d.sport === "cricket").every((d) => /no committed variant enables it/.test(d.reason))).toBe(true);
  });
  it("the planner is deterministic and walks the registry in order", () => {
    expect(planL3({ variants })).toEqual(base);
    const cells = [...new Set(base.cases.map((c) => c.cell))];
    expect(cells.slice(0, SPORT_KEYS.length)).toEqual(SPORT_KEYS.map((s) => `${ROW_KEYS[0]}|${s}`));
    expect(cells).toEqual(ROW_KEYS.flatMap((r) => SPORT_KEYS.map((s) => `${r}|${s}`)));
  });
});

/** The top-level cfg keys a cfg predicate reads, recorded by a Proxy: over an
 *  empty cfg (every `||` term is then evaluated) and over every preset's cfg. */
function readsOf(sport: string, fn: (c: Readonly<Record<string, unknown>>) => boolean): string[] {
  const reads = new Set<string>();
  const spy = (target: Record<string, unknown>) => new Proxy(target, { get(t, k) { if (typeof k === "string") reads.add(k); return t[k as string]; } });
  fn(spy({}));
  for (const v of Object.keys(sportModule(sport).variants as Record<string, unknown>)) fn(spy(resolveSportCfg(sport, v) as Record<string, unknown>));
  return [...reads].sort();
}

describe("DECIDERS — every key read is declared by the sport's configSchema", () => {
  it("each decider reads only keys in <sport>.schema.json's configSchema.properties (reads recorded, not typed)", () => {
    const expected: Record<string, string[]> = { football: ["extraTime", "shootout"], cricket: ["superOver"], icehockey: ["overtime", "shootout"], hockey: ["overtime", "shootout"], carrom: ["tieBoard"] };
    expect(Object.keys(DECIDERS)).toEqual(Object.keys(expected));
    let judged = 0;
    for (const [sport, fn] of Object.entries(DECIDERS)) {
      const reads = readsOf(sport, fn);
      expect(reads.length, sport).toBeGreaterThan(0);
      const props = schemaProps(sport);
      for (const k of reads) expect(props, `${sport}.${k}`).toContain(k);
      expect(reads, sport).toEqual([...expected[sport]!].sort());
      judged++;
    }
    expect(judged).toBe(Object.keys(expected).length);
  });
  it("where the engine's supportsDraws reads the decider, DECIDERS answers `a league level score does not stand`, over every preset and committed variant", () => {
    // icehockey/hockey DOMAIN.md: "Draws stand where no decider is configured";
    // carrom's tieBoard "extra" plays a tie board. Football's supportsDraws is
    // stage-only (football.ts:2666) and cricket's league draw is the two-innings
    // preset's, so neither reads its decider and neither is judged here.
    let judged = 0;
    const answers = new Set<boolean>();
    for (const sport of ["icehockey", "hockey", "carrom"]) {
      const cfgs = [
        ...Object.keys(sportModule(sport).variants as Record<string, unknown>).map((v) => resolveSportCfg(sport, v)),
        ...variantsOf(sport).cases.map((c) => resolveSportCfg(sport, c.preset, c.overrides as Record<string, unknown>)),
      ] as Record<string, unknown>[];
      for (const cfg of cfgs) {
        const on = DECIDERS[sport]!(cfg);
        expect(on, `${sport} ${JSON.stringify(cfg).slice(0, 120)}`).toBe(!sportModule(sport).supportsDraws(cfg as never, "league"));
        answers.add(on);
        judged++;
      }
    }
    expect(judged).toBeGreaterThan(0);
    expect(answers).toEqual(new Set([true, false]));
  });
  it("each decider answers true under some preset or committed variant of its sport (no inert decider)", () => {
    let judged = 0;
    for (const [sport, fn] of Object.entries(DECIDERS)) {
      const presets = Object.keys(sportModule(sport).variants as Record<string, unknown>).map((v) => resolveSportCfg(sport, v) as Record<string, unknown>);
      const committed = variantsOf(sport).cases.map((c) => resolveSportCfg(sport, c.preset, c.overrides as Record<string, unknown>) as Record<string, unknown>);
      expect([...presets, ...committed].some(fn), sport).toBe(true);
      judged++;
    }
    expect(judged).toBe(Object.keys(DECIDERS).length);
  });
});

describe("ruling 30 — M4a/M4b: ABANDON_RESULTS agrees with the real engine's abandon", () => {
  const ABANDON = { type: "core.abandon", payload: { reason: "matrix: witness" } };
  type Ev = { type: string; payload: unknown };
  /** Streams an abandon may follow: every prefix of a decided home-win stream,
   *  plus one cricket-only candidate. Cricket's generator is coarse, one
   *  closed summary per innings, so no prefix is a chase in progress; the
   *  extra candidate is a partial chase at exactly the cfg's own minimum for
   *  a result (minOversForResult × ballsPerOver, cricket.ts:1152). */
  const candidates = (sport: string, cfg: Readonly<Record<string, unknown>>): Ev[][] => {
    let stream: Ev[];
    try {
      stream = generateStream({ sportKey: sport, cfg, stageKind: "league", home: "H", away: "A", outcome: { kind: "win", winner: "home" } });
    } catch (e) {
      if (!(e instanceof GeneratorUnsupported)) throw e;
      stream = [START]; // cricket two-innings has no generator (KNOWN_UNSUPPORTED); START alone opens the match
    }
    const out = stream.map((_, i) => stream.slice(0, i + 1));
    if (sport === "cricket" && stream.length > 1) {
      const c = cfg as { minOversForResult: number; ballsPerOver: number };
      out.push([...stream.slice(0, 2), { type: "cricket.innings.summary", payload: { runs: 1, wickets: 0, legalBalls: c.minOversForResult * c.ballsPerOver, partial: true } }]);
    }
    return out;
  };
  /** What an abandon folds to after each UNDECIDED candidate, through the real
   *  engine (fold.ts). An engine refusal (e.g. WRONG_PHASE) is recorded, never
   *  swallowed as "no result"; anything else is a harness fault and throws. */
  const abandonOutcomes = (sport: string, cfg: Readonly<Record<string, unknown>>): string[] => {
    const m = sportModule(sport);
    const out: string[] = [];
    for (const prefix of candidates(sport, cfg)) {
      if (foldStream(m, cfg, "H", "A", prefix).outcome !== null) continue; // decided: an abandon now is refused
      try {
        const o = foldStream(m, cfg, "H", "A", [...prefix, ABANDON]).outcome;
        out.push(o === null ? "null" : o.kind);
      } catch (e) {
        if (!EngineError.is(e)) throw e;
        out.push(`refused:${e.code}`);
      }
    }
    return out;
  };
  const resultOnAbandon = (sport: string, cfg: Readonly<Record<string, unknown>>): boolean =>
    abandonOutcomes(sport, cfg).some((o) => o !== "null" && o !== "no_result" && !o.startsWith("refused:"));

  it("each key ABANDON_RESULTS reads is declared by the sport's configSchema (reads recorded, not typed)", () => {
    const expected: Record<string, string[]> = { football: ["abandonPolicy"], hockey: ["abandonPolicy"], icehockey: ["abandonPolicy"], cricket: ["dls", "inningsPerSide"] };
    expect(Object.keys(ABANDON_RESULTS)).toEqual(Object.keys(expected));
    let judged = 0;
    for (const [sport, fn] of Object.entries(ABANDON_RESULTS)) {
      const reads = readsOf(sport, fn);
      const props = schemaProps(sport);
      for (const k of reads) expect(props, `${sport}.${k}`).toContain(k);
      expect(reads, sport).toEqual([...expected[sport]!].sort());
      judged++;
    }
    expect(judged).toBe(Object.keys(expected).length);
  });
  it("M4a's premise, as a guard: at every sport's builder default some undecided match accepts an abandon and it yields NO result", () => {
    let judged = 0;
    for (const s of SPORT_KEYS) {
      const outs = abandonOutcomes(s, cellFacts("league", s).cfg);
      expect(outs.some((o) => o === "null" || o === "no_result"), `${s}: ${JSON.stringify(outs)}`).toBe(true);
      judged++;
    }
    expect(judged).toBe(SPORT_KEYS.length);
  });
  it("registry sweep: at the builder default, ABANDON_RESULTS answers what the engine folds (anti-vacuity: every sport judged)", () => {
    let judged = 0;
    for (const s of SPORT_KEYS) {
      const cfg = cellFacts("league", s).cfg;
      expect(ABANDON_RESULTS[s]?.(cfg) ?? false, s).toBe(resultOnAbandon(s, cfg));
      judged++;
    }
    expect(judged).toBe(SPORT_KEYS.length);
  });
  it("parity sweep: over every scorable committed variant of the four sports, ABANDON_RESULTS answers what the engine folds — and both answers occur", () => {
    let judged = 0;
    let yes = 0;
    for (const s of Object.keys(ABANDON_RESULTS)) for (const vc of variantsOf(s).cases) {
      if (vc.scorable !== null) continue;
      const cfg = cellFacts(vc.row, s, vc.preset, vc.overrides as Record<string, unknown>).cfg;
      const folded = resultOnAbandon(s, cfg);
      expect(ABANDON_RESULTS[s]!(cfg), `${vc.id} ${JSON.stringify(vc.values)}`).toBe(folded);
      judged++;
      if (folded) yes++;
    }
    expect(judged).toBeGreaterThan(0);
    expect(yes).toBeGreaterThan(0);
    expect(yes).toBeLessThan(judged);
  });
  it("every ABANDON_RESULTS arm has a config under which the engine really yields a result (no inert arm)", () => {
    // Engine-declared switches, not organiser reachability: abandonPolicy is an
    // API-only key (false premise 10), so it is passed as a raw override here.
    const on: Record<string, { preset?: string; overrides?: Record<string, unknown>; values?: Record<string, string> }[]> = {
      football: [{ overrides: { abandonPolicy: "award" } }],
      hockey: [{ overrides: { abandonPolicy: "award" } }],
      icehockey: [{ overrides: { abandonPolicy: "award" } }],
      cricket: [{ values: { dls: "on" } }, { preset: "test" }],
    };
    let judged = 0;
    for (const [s, cfgs] of Object.entries(on)) for (const c of cfgs) {
      const cfg = cellFacts("league", s, c.preset, c.overrides ?? {}, c.values).cfg;
      expect(ABANDON_RESULTS[s]!(cfg), `${s} ${JSON.stringify(c)}`).toBe(true);
      expect(resultOnAbandon(s, cfg), `${s} ${JSON.stringify(c)}`).toBe(true);
      judged++;
    }
    expect(judged).toBe(5);
  });
  it("M4b binds only through a committed variant, and drops every sport the organiser cannot reach (configKeysFor, the editor's own key set)", () => {
    let judged = 0;
    let planned = 0;
    for (const s of Object.keys(ABANDON_RESULTS)) {
      const cases = base.cases.filter((c) => c.scenario === "M4b" && c.sport === s);
      const editorKeys = configKeysFor(s);
      if (!editorKeys.has("abandonPolicy") && !editorKeys.has("dls") && !variantsOf(s).cases.some((x) => x.preset === "test")) {
        expect(cases, `${s}: no organiser path to an abandon with a result`).toEqual([]);
        expect(base.drops.some((d) => d.scenario === "M4b" && d.sport === s), s).toBe(true);
      } else {
        expect(cases.length, s).toBeGreaterThan(0);
        for (const c of cases) expect(c.bound, `${s} ${c.cell}: never applies at the builder default`).not.toBeNull();
        planned += cases.length;
      }
      judged++;
    }
    expect(judged).toBe(Object.keys(ABANDON_RESULTS).length);
    expect(planned).toBeGreaterThan(0);
    // No sport outside ABANDON_RESULTS plans M4b.
    expect(base.cases.filter((c) => c.scenario === "M4b" && !Object.hasOwn(ABANDON_RESULTS, c.sport))).toEqual([]);
  });
});

describe("ruling 30 — M12", () => {
  it("M12a/M12b apply exactly where R16 does (team entrants), and M12c exactly where the module declares cricket.retire", () => {
    let judged = 0;
    let retire = 0;
    for (const row of ROW_KEYS) for (const s of SPORT_KEYS) {
      const f = cellFacts(row, s);
      const declares = Object.hasOwn(sportModule(s).eventSchemas ?? {}, "cricket.retire");
      expect(RULES.M12a!.when(f), `M12a ${row}|${s}`).toBe(RULES.R16!.when(f));
      expect(RULES.M12b!.when(f), `M12b ${row}|${s}`).toBe(RULES.R16!.when(f));
      expect(RULES.R16!.when(f), `R16 ${row}|${s}`).toBe(f.entrantKinds.includes("team"));
      expect(RULES.M12c!.when(f), `M12c ${row}|${s}`).toBe(declares);
      judged++;
      if (declares) retire++;
    }
    expect(judged).toBe(ROW_KEYS.length * SPORT_KEYS.length);
    expect(retire).toBe(ROW_KEYS.length); // ruling 30: cricket only — one sport declares it
    expect(SPORT_KEYS.filter((s) => Object.hasOwn(sportModule(s).eventSchemas ?? {}, "cricket.retire"))).toEqual(["cricket"]);
  });
});

describe("cellFacts", () => {
  it("defaults to the builder's offline default variant and carries the row's real stages and gate", () => {
    let judged = 0;
    for (const s of SPORT_KEYS) {
      const f = cellFacts("group_playoffs", s);
      expect(f.preset, s).toBe(offlineBuilderDefault(s));
      expect(f.stages.map((x) => x.kind)).toEqual(stagesForRow("group_playoffs").map((x) => x.kind));
      expect(f.gate).toBe("formats.double_elim");
      judged++;
    }
    expect(judged).toBe(SPORT_KEYS.length);
    expect(cellFacts("ko_plate", "generic").stages[1]!.takes).toEqual(["roundLosers"]);
  });
});
