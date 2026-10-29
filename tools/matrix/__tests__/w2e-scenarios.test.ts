// W2e Tasks 19–24 (spec §10, D16): the opt-in deciding-path scenarios the local truth run plays with `--scenario`, one key
// per stream (W2E_ET and W2E_SO from Task 19, W2E_OT from Task 20, W2E_SUPER_OVER and W2E_DLS from Task 21, W2E_DECIDER and
// W2E_CAP from Task 22, W2E_TB_SET and W2E_SHORT_SETS from Task 23, W2E_SANCTION_END from Task 24). Each forces EVERY bracket match of a bracket-root row down its key's path,
// so a green run cannot have got there by the policy's rotation. Expected values come from the engine's own declarations
// (`decidedInFor` over the module's win-method table; the decider presets a bracket stage is created with), never from
// the scenario's text.
import { decidedInFor, type DecidedIn } from "@seazn/engine/competition";
import { forbidsLevelResult, type StageKind } from "@seazn/engine/core";
import { deciderKeysFor, stageKeysFor } from "@seazn/engine/sport";
import { football } from "@seazn/engine/sports/football";
import { cricket } from "@seazn/engine/sports/cricket";
import { badminton, tabletennis, volleyball } from "@seazn/engine/sports/setbased";
import { tennis } from "@seazn/engine/sports/tennis";
import { hockey } from "@seazn/engine/sports/hockey";
import { icehockey } from "@seazn/engine/sports/icehockey";
import { describe, expect, it } from "vitest";
import { ROW_KEYS, SPORT_KEYS, stagesForRow, type RowKey } from "../lib/catalogue.ts";
import { DEFAULT_FIELD, PAGE_PLAYOFF_FIELD, fieldSizeFor } from "../lib/field-size.ts";
import { foldStream } from "../lib/fold.ts";
import { evaluateInvariants } from "../lib/invariants.ts";
import type { BracketDrive } from "../lib/reference-bracket.ts";
import { decideState } from "../lib/results.ts";
import { Recorder } from "../lib/scenarios/common.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { W2E_SCENARIO_KEYS, type CaseSpec, type W2eScenarioKey } from "../lib/scenarios/types.ts";
import { W2E_SCENARIO_PATHS, W2eMisplanned, everyMatchEndedBySanction, everyMatchTookTheDecidingPath, sanctionPick } from "../lib/scenarios/w2e-deciding-paths.ts";
import { SCENARIO_KEYS } from "../lib/slice.ts";
import { resolveSportCfg, sportModule, stageCfg, variantKeys } from "../lib/sport-cfg.ts";
import { generateStream } from "../lib/streams/index.ts";
import { endingLevelOf, endingReasonOf } from "../lib/streams/sanction.ts";
import { PROBE_LINEUPS, type ProductFold, type StreamEvent, type StreamLineups } from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { W1_DRIVING_SCENARIOS, planW1Driving } from "../lib/w1-driving-set.ts";
import { bracketRootRows } from "../lib/w2a-cells.ts";
import { W2eOverridesNameNoVariant, w2eApplies, w2eBracketCfgOf, w2eCells, w2eNameVariant, w2eOverridesFor, w2eOverridesSetsFor } from "../lib/w2e-cells.ts";
import type { FixtureStateOut } from "../lib/driver/types.ts";
import { FakeKnockoutDriver } from "./fake-driver.ts";
import { capBinds, decidingSetReachable, setSportsOf, type SetCfg, type SetFoldState } from "./set-oracles.ts";
import { tbIsClosestFinish, type TennisCfg, type TennisFoldState } from "./tennis-oracles.ts";

const variantFor = offlineBuilderDefault;
/** Task 24: W2E_SANCTION_END forces no deciding path (its matches end in an AWARD), so the path-shaped tables and sweeps below
 *  take the other keys; the sanction key has its own describes. */
const SANCTION_KEY = "W2E_SANCTION_END" as const;
type PathKey = Exclude<W2eScenarioKey, typeof SANCTION_KEY>;
const PATH_KEYS: readonly PathKey[] = W2E_SCENARIO_KEYS.filter((k): k is PathKey => k !== SANCTION_KEY);
/** The sports whose module declares a sanction that ends a match (SportModule.sanctionEnding), from the engine. */
const sanctionSports = (): string[] => SPORT_KEYS.filter((s) => sportModule(s).sanctionEnding !== undefined);
/** What the product serves at /state for a fixture folded to `stream`: the engine's own summary of the fold and the fold's
 *  state, through JSON as the match_states jsonb columns hold them (apps/web usecases/fixtures.ts getFixtureState). A
 *  HAND-BUILT drive's product — the integrated runs below read it from the fake driver's /state instead. */
function productOf(module: ReturnType<typeof sportModule>, cfg: unknown, home: string, away: string, stream: readonly StreamEvent[], lineups?: StreamLineups): ProductFold {
  const { state } = foldStream(module, cfg, home, away, stream, lineups);
  return JSON.parse(JSON.stringify({ summary: module.summary(state as never), state })) as ProductFold;
}
/** What decides each key's matches, in the engine's own vocabulary (sport/module.ts DecidedIn): extra time and overtime are
 *  decided "in overtime", the shoot-out (and the GWS) "by a shoot-out". */
const DECIDED_IN: Readonly<Record<PathKey, DecidedIn>> = { W2E_ET: "ot", W2E_SO: "so", W2E_OT: "ot", W2E_SUPER_OVER: "so", W2E_DLS: "regulation", W2E_DECIDER: "regulation", W2E_CAP: "regulation", W2E_TB_SET: "regulation", W2E_SHORT_SETS: "regulation" };
/** Task 22: the set sports' two keys. Neither path is a stage decider or a decidedIn the outcome can name (a set sport's win is
 *  'regulation' whichever way its sets went), so the engine's declarations that make them reachable are the set kernel's own:
 *  `reachableSetScores` (a deciding set is played) and the rally fold that closes a set at the cap (set-oracles.ts). */
const SET_KEYS = ["W2E_DECIDER", "W2E_CAP"] as const;
type SetKey = (typeof SET_KEYS)[number];
const isSetKey = (k: W2eScenarioKey): k is SetKey => (SET_KEYS as readonly string[]).includes(k);
/** Task 23: tennis's two keys. A tennis win is a 'regulation' win however its sets ended (nothing in the outcome names either path),
 *  so the engine's declarations that make them reachable are the nested kernel's cfg: `set.tiebreakAt` (a set can end in a tie-break)
 *  and `set.tiebreakWinBy` (the field the engine declares for the SHORT-SET tie-break, TN-SS-2 - Fast4 and the short-sets variant). */
const TB_KEYS = ["W2E_TB_SET", "W2E_SHORT_SETS"] as const;
type TbKey = (typeof TB_KEYS)[number];
const isTbKey = (k: W2eScenarioKey): k is TbKey => (TB_KEYS as readonly string[]).includes(k);
/** A cfg's nested-kernel tie-break declarations (the engine's cfg, not the generator's reading of it). */
const nestedSet = (cfg: unknown): { tiebreakAt?: number | null; tiebreakWinBy?: number } | null => {
  const set = (cfg as { set?: unknown } | null)?.set;
  return typeof set === "object" && set !== null ? (set as { tiebreakAt?: number | null; tiebreakWinBy?: number }) : null;
};
/** Whether `sport` is a nested-kernel sport (its module declares `<sport>.set_summary`) and the key applies: W2E_TB_SET where the
 *  builder default's sets end in a tie-break; W2E_SHORT_SETS where SOME variant's do at the set's own margin. */
const tbKeyApplies = (k: TbKey, s: string): boolean => {
  if (!Object.keys(sportModule(s).eventSchemas ?? {}).includes(`${s}.set_summary`)) return false;
  if (k === "W2E_TB_SET") return nestedSet(resolveSportCfg(s, variantFor(s)))?.tiebreakAt != null;
  return variantKeys(s).some((v) => { const set = nestedSet(resolveSportCfg(s, v)); return set?.tiebreakAt != null && set.tiebreakWinBy !== undefined; });
};
/** Task 23 M1/M7 - the variants a tie-break key is PLAYED under on tennis, from the engine's cfg declarations (not the cells'): every
 *  variant whose sets end in a tie-break, at the MATCH margin for W2E_TB_SET (tour's set tie-break, the slam's final-set tie-break to
 *  10, the doubles norm's match tie-break) and at the SET's own margin for W2E_SHORT_SETS (Fast4's 4-3, the short-sets variant's 5-4). */
const tennisPlayed = (k: TbKey): string[] => variantKeys("tennis").filter((v) => {
  const set = nestedSet(resolveSportCfg("tennis", v));
  return set?.tiebreakAt != null && (k === "W2E_TB_SET" ? set.tiebreakWinBy === undefined : set.tiebreakWinBy !== undefined);
});
/** How many override sets (cases per row) a key has on a sport that applies: tennis's tie-break keys play every such variant, the
 *  rest the one. */
const playedCount = (k: W2eScenarioKey, s: string): number => (isTbKey(k) && s === "tennis" ? tennisPlayed(k).length : 1);
/** The method a product result carries when the key's path decided it, where the engine's win-method table cannot say so on
 *  its own: a DLS win is decidedIn 'regulation' (a revised target is no extra play), so only its method names it. */
const METHOD_OF: Readonly<Partial<Record<W2eScenarioKey, string>>> = { W2E_DLS: "dls" };
/** Which of the engine's decider rule keys each scenario plays (`deciderKeysFor`: football's extraTime and shootout, the
 *  period kernel's overtime and shootout — the IIHF's is its GWS). With DECIDED_IN it names the sports the key is FOR. */
const ENGINE_DECIDER: Readonly<Record<Exclude<PathKey, SetKey | TbKey>, string>> = { W2E_ET: "extraTime", W2E_SO: "shootout", W2E_OT: "overtime", W2E_SUPER_OVER: "superOver", W2E_DLS: "dls" };
/** The rule keys the engine lets a knockout stage set: the deciders (`decider: true`) for the first four keys; cricket's `dls`
 *  is a stage rule but no decider (a revised target is no extra play), so it is read off the stage's settable keys. */
const keysOf = (k: Exclude<PathKey, SetKey | TbKey>, s: string): readonly string[] => (k === "W2E_DLS" ? stageKeysFor : deciderKeysFor)(sportModule(s), "knockout", variantFor(s));
/** The sports the ENGINE declares the key's decider for on a knockout, and whose bracket preset reaches the decidedIn it
 *  produces — derived from the modules, not from any generator or scenario. The set keys (Task 22) read the set kernel's own
 *  declarations on the builder default's knockout cfg: a deciding set where `reachableSetScores` has a split-then-decided
 *  score, a cap where the engine's rally fold closes a set at cap : cap-1. */
const engineSports = (k: W2eScenarioKey): string[] => SPORT_KEYS.filter((s) => {
  if (k === SANCTION_KEY) return sportModule(s).sanctionEnding !== undefined;
  if (isTbKey(k)) return tbKeyApplies(k, s);
  if (isSetKey(k)) {
    if (!setSportsOf([s]).length) return false;
    const cfg = w2eBracketCfgOf(s) as SetCfg;
    return k === "W2E_DECIDER" ? decidingSetReachable(s, cfg) : capBinds(s, cfg);
  }
  return keysOf(k, s).includes(ENGINE_DECIDER[k])
    && sportModule(s).reachableDecidedIn(w2eBracketCfgOf(s) as never, "knockout").has(DECIDED_IN[k]);
});

describe("the W2e keys: frozen names, registered, opt-in", () => {
  it("the keys are W2E_ET and W2E_SO (Task 19), W2E_OT (Task 20), W2E_SUPER_OVER and W2E_DLS (Task 21), W2E_DECIDER and W2E_CAP (Task 22) and W2E_TB_SET and W2E_SHORT_SETS (Task 23) and W2E_SANCTION_END (Task 24, no path), each naming its deciding paths — the shoot-out key lists the IIHF's GWS after hockey's shoot-out; each is registered under its own key with no canary, outside the slice and the w1-driving scripts", () => {
    expect([...W2E_SCENARIO_KEYS]).toEqual(["W2E_ET", "W2E_SO", "W2E_OT", "W2E_SUPER_OVER", "W2E_DLS", "W2E_DECIDER", "W2E_CAP", "W2E_TB_SET", "W2E_SHORT_SETS", "W2E_SANCTION_END"]);
    expect(W2E_SCENARIO_PATHS).toEqual({ W2E_ET: ["extraTime"], W2E_SO: ["shootout", "gws"], W2E_OT: ["overtime"], W2E_SUPER_OVER: ["superOver"], W2E_DLS: ["dls"], W2E_DECIDER: ["decidingSet"], W2E_CAP: ["cap"], W2E_TB_SET: ["tiebreakSet"], W2E_SHORT_SETS: ["shortSetTb"], W2E_SANCTION_END: [] });
    let checked = 0;
    for (const k of W2E_SCENARIO_KEYS) {
      expect(SCENARIOS[k].key, k).toBe(k);
      expect(SCENARIOS[k].canaryCheck, k).toBeNull();
      expect((SCENARIO_KEYS as readonly string[]).includes(k), `${k} is in the slice's keys`).toBe(false);
      expect((W1_DRIVING_SCENARIOS as readonly string[]).includes(k), `${k} is one of the w1-driving scripts`).toBe(false);
      checked++;
    }
    expect(checked).toBe(10);
  });

  it("no filter plans none of them; a named key plans only its own cells, with the w1-driving case-id shape", () => {
    const all = planW1Driving(variantFor, {});
    expect(all.filter((c) => (W2E_SCENARIO_KEYS as readonly string[]).includes(c.scenario))).toEqual([]);
    let planned = 0;
    let overridden = 0;
    for (const k of W2E_SCENARIO_KEYS) {
      const cases = planW1Driving(variantFor, { scenario: k });
      expect(cases.length, k).toBe(w2eCells(k).length);
      expect(cases.length, k).toBeGreaterThan(0);
      expect(new Set(cases.map((c) => c.scenario)), k).toEqual(new Set([k]));
      // A case plays the builder default's variant; where the default builds none of the key's paths (tennis's short-set tie-break) it
      // carries the division-config overrides that turn it into the first variant that does (w2e-cells.ts) - and only then.
      // Task 23 M2: a case that plays the default AS another variant (its overrides) says which, in a trailing `as-<variant>` segment
      // (`row|sport|variant|scenario[|…]`, the shape parity.ts reads); a case that plays the default as it is has none. The variant is
      // the one declared variant whose resolved cfg IS the default under the overrides (the engine's variants, not the cell's word).
      const asOf = (c: CaseSpec): string => {
        if (c.overrides === undefined) return "";
        const played = JSON.stringify(Object.entries(resolveSportCfg(c.sport, c.variant, { ...c.overrides }) as object).sort());
        const same = variantKeys(c.sport).filter((v) => JSON.stringify(Object.entries(resolveSportCfg(c.sport, v) as object).sort()) === played);
        expect(same, `${c.caseId}: exactly one declared variant is what the overrides play`).toHaveLength(1);
        return `|as-${same[0]!}`;
      };
      expect(cases.every((c) => c.caseId === `${c.row}|${c.sport}|${c.variant}|${k}${asOf(c)}` && !c.canary && c.variant === variantFor(c.sport)), k).toBe(true);
      for (const c of cases) {
        // Each case's overrides are one of its sport's sets (none for the default as it is) - and every set of every applicable
        // sport is planned on every bracket-root row, once.
        expect(w2eOverridesSetsFor(k, c.sport).map((o) => (Object.keys(o).length === 0 ? undefined : o)), `${k} ${c.row}|${c.sport}`).toContainEqual(c.overrides);
        if (c.overrides !== undefined) overridden++;
      }
      for (const sport of SPORT_KEYS) {
        const per = cases.filter((c) => c.sport === sport);
        expect(per.length, `${k}/${sport}`).toBe(w2eApplies(k, sport) ? bracketRootRows().length * playedCount(k, sport) : 0);
      }
      expect(new Set(cases.map((c) => c.caseId)).size, `${k}: case ids are unique`).toBe(cases.length);
      planned += cases.length;
    }
    expect(planned).toBeGreaterThan(0);
    // Exactly tennis's tie-break cells that play a variant other than the default carry overrides: the slam's and the doubles norm's
    // for W2E_TB_SET, Fast4's and the short-sets variant's for W2E_SHORT_SETS (the engine's declarations: tennisPlayed), on each of the
    // eight bracket rows - and each of those ids names the variant it plays, where no other id has a fifth segment.
    const otherVariants = TB_KEYS.flatMap((k) => tennisPlayed(k).filter((v) => v !== variantFor("tennis")));
    expect(otherVariants, "the engine's non-default tie-break variants").toEqual(["grand-slam", "doubles-noad-mtb10", "fast4", "short-sets"]);
    expect(overridden).toBe(bracketRootRows().length * otherVariants.length);
    // The guard is reached: overrides that play no declared variant are refused by name, and the real ones name theirs.
    expect(() => w2eNameVariant("tennis", { bestOf: 99 })).toThrow(W2eOverridesNameNoVariant);
    expect(w2eNameVariant("tennis", w2eOverridesFor("W2E_SHORT_SETS", "tennis")!), "the first declared variant with a short-set margin").toBe(variantKeys("tennis").find((v) => v !== variantFor("tennis") && nestedSet(resolveSportCfg("tennis", v))?.tiebreakWinBy !== undefined));
    const shortIds = planW1Driving(variantFor, { scenario: "W2E_SHORT_SETS" }).map((c) => c.caseId);
    expect(shortIds.length).toBe(bracketRootRows().length * tennisPlayed("W2E_SHORT_SETS").length);
    expect(shortIds.every((id) => id.split("|").length === 5 && id.split("|")[4]!.startsWith("as-")), "an overrides case id has its trailing segment").toBe(true);
    expect(new Set(shortIds.map((id) => id.split("|")[4])), "...and names each short-set variant").toEqual(new Set(tennisPlayed("W2E_SHORT_SETS").map((v) => `as-${v}`)));
    const tbIds = planW1Driving(variantFor, { scenario: "W2E_TB_SET" }).map((c) => c.caseId);
    expect(tbIds.filter((id) => id.split("|").length === 4).length, "the default as it is has four segments, on each row").toBe(bracketRootRows().length);
    expect(new Set(tbIds.filter((id) => id.split("|").length === 5).map((id) => id.split("|")[4])), "the other tie-break variants are named").toEqual(new Set(["as-grand-slam", "as-doubles-noad-mtb10"]));
  });

  it("W2E_SHORT_SETS plans tennis's default (tour has no short-set tie-break) as the first variant that has one: the overrides resolve back to that variant's cfg exactly, the variant is not the default, and its sets close at the set's own margin; W2E_TB_SET needs none", () => {
    const def = variantFor("tennis");
    const overrides = w2eOverridesFor("W2E_SHORT_SETS", "tennis")!;
    expect(Object.keys(overrides).length, "the default is not already a short-set variant").toBeGreaterThan(0);
    expect(w2eOverridesFor("W2E_TB_SET", "tennis"), "tour plays tie-break sets as it is").toEqual({});
    const cfg = resolveSportCfg("tennis", def, { ...overrides });
    const same = variantKeys("tennis").filter((v) => JSON.stringify(Object.entries(resolveSportCfg("tennis", v) as object).sort()) === JSON.stringify(Object.entries(cfg as object).sort()));
    expect(same, "exactly one declared variant is what the overrides make the default").toHaveLength(1);
    expect(same[0], "...and it is not the default").not.toBe(def);
    expect(nestedSet(cfg)!.tiebreakWinBy, "...and it declares the short set's own margin").toBeDefined();
    expect(variantKeys("tennis").find((v) => v !== def && nestedSet(resolveSportCfg("tennis", v))?.tiebreakWinBy !== undefined), "the FIRST such variant, in the engine's order").toBe(same[0]);
    // Overrides are not invented for a sport whose default already builds the key's path, or that has no variant that does.
    for (const k of W2E_SCENARIO_KEYS) for (const sport of SPORT_KEYS) {
      const o = w2eOverridesFor(k, sport);
      if (o !== null && Object.keys(o).length > 0) expect([k, sport], "only tennis's short-set cells carry overrides").toEqual(["W2E_SHORT_SETS", "tennis"]);
    }
  });

  it("a filter that plans nothing is refused by name: a sport whose generator builds no such path, a table row, an unknown key", () => {
    expect(() => planW1Driving(variantFor, { scenario: "W2E_ET", only: "knockout|football" })).not.toThrow();
    expect(() => planW1Driving(variantFor, { scenario: "W2E_ET", only: "knockout|generic" })).toThrow(/plans no case/);
    expect(() => planW1Driving(variantFor, { scenario: "W2E_SO", only: "league|football" })).toThrow(/plans no case/);
    // Task 20: the shoot-out key plans both period sports (hockey's shoot-out, the IIHF's GWS); the overtime key plans ice hockey alone.
    for (const only of ["knockout|hockey", "knockout|icehockey", "knockout|football"]) expect(() => planW1Driving(variantFor, { scenario: "W2E_SO", only }), only).not.toThrow();
    expect(() => planW1Driving(variantFor, { scenario: "W2E_OT", only: "knockout|icehockey" })).not.toThrow();
    for (const only of ["knockout|hockey", "knockout|football"]) expect(() => planW1Driving(variantFor, { scenario: "W2E_OT", only }), only).toThrow(/plans no case/);
    expect(() => planW1Driving(variantFor, { scenario: "W2E_ET", only: "knockout|icehockey" })).toThrow(/plans no case/);
    // Task 21: the super over and DLS keys plan cricket alone (a limited-overs bracket); no other sport has either.
    for (const scenario of ["W2E_SUPER_OVER", "W2E_DLS"] as const) {
      expect(() => planW1Driving(variantFor, { scenario, only: "knockout|cricket" }), scenario).not.toThrow();
      for (const only of ["knockout|football", "knockout|hockey", "knockout|icehockey", "knockout|generic"]) expect(() => planW1Driving(variantFor, { scenario, only }), `${scenario} ${only}`).toThrow(/plans no case/);
      expect(() => planW1Driving(variantFor, { scenario, only: "league|cricket" }), scenario).toThrow(/plans no case/);
    }
    // Task 22: the deciding-set key plans all three set sports, the cap key badminton alone (the others' builder defaults declare no cap);
    // neither plans a sport of another kernel, or a table row.
    for (const only of ["knockout|badminton", "knockout|volleyball", "knockout|tabletennis"]) expect(() => planW1Driving(variantFor, { scenario: "W2E_DECIDER", only }), only).not.toThrow();
    expect(() => planW1Driving(variantFor, { scenario: "W2E_CAP", only: "knockout|badminton" })).not.toThrow();
    for (const only of ["knockout|volleyball", "knockout|tabletennis", "knockout|tennis", "knockout|football", "league|badminton"]) expect(() => planW1Driving(variantFor, { scenario: "W2E_CAP", only }), only).toThrow(/plans no case/);
    for (const only of ["knockout|tennis", "knockout|cricket", "knockout|generic", "league|volleyball"]) expect(() => planW1Driving(variantFor, { scenario: "W2E_DECIDER", only }), only).toThrow(/plans no case/);
    // Task 23: tennis alone plays a tie-break set and a short-set tie-break (the nested kernel's tie-break sets); no other sport, no table row.
    for (const scenario of ["W2E_TB_SET", "W2E_SHORT_SETS"] as const) {
      expect(() => planW1Driving(variantFor, { scenario, only: "knockout|tennis" }), scenario).not.toThrow();
      for (const only of ["knockout|badminton", "knockout|volleyball", "knockout|football", "knockout|cricket", "knockout|generic", "league|tennis"]) expect(() => planW1Driving(variantFor, { scenario, only }), `${scenario} ${only}`).toThrow(/plans no case/);
    }
    // Task 24: the sanction key plans exactly the sports whose module declares a sanction that ends a match (on a knockout), no other
    // sport, no table row.
    let sanctionPlanned = 0;
    for (const sport of SPORT_KEYS) {
      const only = `knockout|${sport}`;
      if (sanctionSports().includes(sport)) { expect(() => planW1Driving(variantFor, { scenario: SANCTION_KEY, only }), only).not.toThrow(); sanctionPlanned++; }
      else expect(() => planW1Driving(variantFor, { scenario: SANCTION_KEY, only }), only).toThrow(/plans no case/);
    }
    expect(sanctionPlanned).toBe(sanctionSports().length);
    expect(sanctionPlanned).toBeGreaterThan(0);
    expect(() => planW1Driving(variantFor, { scenario: SANCTION_KEY, only: "league|badminton" })).toThrow(/plans no case/);
    expect(() => planW1Driving(variantFor, { scenario: "W2E_NOPE" })).toThrow(/--scenario.*W2E_NOPE/);
  });

  it("the field: the format's own, as LIFECYCLE seeds it (8, or a page playoff's 4)", () => {
    let checked = 0;
    for (const k of W2E_SCENARIO_KEYS) for (const row of bracketRootRows()) {
      expect(fieldSizeFor(row, k), `${row} ${k}`).toBe(stagesForRow(row).length === 1 && stagesForRow(row)[0]!.kind === "page_playoff" ? PAGE_PLAYOFF_FIELD : DEFAULT_FIELD);
      checked++;
    }
    expect(checked).toBe(W2E_SCENARIO_KEYS.length * bracketRootRows().length);
  });
});

describe("the cells: bracket-root rows × the sports whose generator builds the key's path under the bracket preset", () => {
  it("each key's sports are EXACTLY the ones the engine declares its decider for (deciderKeysFor, and the decidedIn the bracket preset reaches): extra time is football's alone, overtime ice hockey's alone, the shoot-out football's, hockey's and ice hockey's (its GWS); the cells are rows × applicable sports, less LIFECYCLE's drops", () => {
    const by = (k: W2eScenarioKey) => SPORT_KEYS.filter((s) => w2eApplies(k, s));
    let derived = 0;
    for (const k of W2E_SCENARIO_KEYS) {
      expect(engineSports(k).length, `${k}: the engine declares its decider for some sport`).toBeGreaterThan(0);
      expect(by(k), k).toEqual(engineSports(k));
      derived += engineSports(k).length;
    }
    console.info(`w2e-scenarios: engine-derived sports ${JSON.stringify(Object.fromEntries(W2E_SCENARIO_KEYS.map((k) => [k, engineSports(k)])))}`);
    expect(derived).toBeGreaterThan(W2E_SCENARIO_KEYS.length);
    expect(engineSports("W2E_SO"), "the period sports are in the shoot-out key (Task 20)").toEqual(expect.arrayContaining(["football", "hockey", "icehockey"]));
    // Task 21: cricket alone plays a super over (a decider of its limited-overs knockouts) and a DLS-revised target.
    expect(engineSports("W2E_SUPER_OVER")).toEqual(["cricket"]);
    expect(engineSports("W2E_DLS")).toEqual(["cricket"]);
    // Task 22: every set sport can be taken to a deciding set; of the builder defaults only badminton's (bwf: cap 30) declares a cap
    // that decides a set - volleyball's and table tennis's cap is null.
    expect(engineSports("W2E_DECIDER")).toEqual(SPORT_KEYS.filter((s) => setSportsOf([s]).length > 0));
    expect(engineSports("W2E_CAP")).toEqual(["badminton"]);
    // Task 23: tennis alone ends sets in a tie-break (a nested-kernel sport whose cfg declares tiebreakAt); the short-set tie-break
    // belongs to its variants that declare the set's own margin (tiebreakWinBy), not to the builder default.
    expect(engineSports("W2E_TB_SET")).toEqual(["tennis"]);
    expect(engineSports("W2E_SHORT_SETS")).toEqual(["tennis"]);
    // Task 24: the sports whose module declares a sanction that ends a match - badminton's black card (BD-SE-1), tennis's default
    // (TN-SE-1), volleyball's incomplete-team question (VB-SE-1); table tennis's, football's and hockey's sanctions end nothing.
    expect([...engineSports(SANCTION_KEY)].sort(), "(registry order is wave order, not alphabetical)").toEqual(["badminton", "tennis", "volleyball"]);
    let total = 0;
    for (const k of W2E_SCENARIO_KEYS) {
      const cells = w2eCells(k);
      expect(cells.length, k).toBe(bracketRootRows().length * by(k).reduce((n, s) => n + playedCount(k, s), 0));
      expect(cells.every((c) => forbidsLevelResult(stagesForRow(c.row)[0]!.kind as StageKind)), k).toBe(true);
      const dropped = w2eCells(k, (row, sport) => row === cells[0]!.row && sport === cells[0]!.sport);
      expect(dropped.length, `${k}: one drop (a row x sport cell, every variant it is played under)`).toBe(cells.length - playedCount(k, cells[0]!.sport));
      total += cells.length;
    }
    expect(total).toBeGreaterThan(0);
  });

  it("a sport applies only where the bracket PRESET switches the path on: football with its deciders off builds neither", () => {
    const variant = variantFor("football");
    const off = stageCfg("football", resolveSportCfg("football", variant), "knockout", variant, { extraTime: { enabled: false, halfMinutes: 15 }, shootout: false });
    for (const path of ["extraTime", "shootout"] as const) {
      expect(() => generateStream({ sportKey: "football", cfg: off, stageKind: "knockout", home: "h", away: "a", outcome: { kind: "win", winner: "home", path } }), path).toThrow(/the cfg does not switch/);
    }
  });
});

/** One scenario run on the knockout fake, as the planner builds the case (w1-driving-set.ts), with every check the run reports. */
async function runScenario(key: W2eScenarioKey, row: RowKey = "knockout", sport = "football", overrides: Readonly<Record<string, unknown>> | null = w2eOverridesFor(key, sport)) {
  const variant = variantFor(sport);
  // The case as the planner builds it (w1-driving-set.ts): the builder default's variant, under the overrides the cell carries.
  const spec: CaseSpec = { caseId: `${row}|${sport}|${variant}|${key}`, row, sport, variant, scenario: key, canary: false, ...(overrides === null || Object.keys(overrides).length === 0 ? {} : { overrides }) };
  const out = await SCENARIOS[key].run({ driver: new FakeKnockoutDriver(), spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant, { ...(spec.overrides ?? {}) }), tag: "t", denied: [] });
  const checks = [...evaluateInvariants(out.observed), ...out.assertions];
  return { out, checks, state: decideState({ checks, deferred: null, error: null }).state };
}

describe("each key, run on the knockout fake for every sport it is for", () => {

  it("works: its own check passes on a counted item per bracket match, the shared bracket checks pass, and every product result was decided down the key's path (decidedIn from the engine) — for every sport the key is for", async () => {
    let ran = 0;
    const perKey = new Map<string, number>();
    for (const key of PATH_KEYS) for (const sport of engineSports(key)) for (const overrides of w2eOverridesSetsFor(key, sport)) {
      const at = `${key}/${sport}${Object.keys(overrides).length === 0 ? "" : ` as ${w2eNameVariant(sport, overrides)}`}`;
      const { out, checks, state } = await runScenario(key, "knockout", sport, overrides);
      expect(checks.filter((c) => c.verdict === "fail").map((c) => `${c.id}: ${c.reason}`).join(" | "), at).toBe("");
      expect(state, at).toBe("works");
      const own = checks.find((c) => c.id === "w2e-every-match-took-the-path")!;
      expect(own, at).toBeDefined();
      expect(own.verdict, at).toBe("pass");
      const wins = out.observed.stages[0]!.fixtures.filter((f) => f.outcome?.kind === "win");
      expect(wins.length, `${at}: more than one bracket match was decided`).toBeGreaterThan(1);
      expect(own.checked, at).toBe(wins.length);
      for (const f of wins) {
        const o = f.outcome as { kind: "win"; winner: string; method?: string };
        expect(decidedInFor(sportModule(sport), { kind: "win", winner: o.winner, loser: "x", ...(o.method === undefined ? {} : { method: o.method }) }), `${at} ${f.id}`).toBe(DECIDED_IN[key]);
        // Where decidedIn cannot name the path (a DLS win is decided in regulation), the method does.
        if (METHOD_OF[key] !== undefined) expect(o.method, `${at} ${f.id}`).toBe(METHOD_OF[key]);
      }
      for (const id of ["life-reference-bracket-finish", "life-fold-parity"]) {
        const c = checks.find((x) => x.id === id)!;
        expect(c.verdict, `${at} ${id}`).toBe("pass");
        expect(c.checked, `${at} ${id}`).toBeGreaterThan(0);
      }
      // The sport's own rule decides every match: no organiser decider is owed, so that counter is not in the scenario.
      expect(checks.some((c) => c.id === "life-bracket-decider-exercised"), at).toBe(false);
      ran++;
      perKey.set(key, (perKey.get(key) ?? 0) + 1);
    }
    console.info(`w2e-scenarios: ${ran} run(s) on the fake, per key ${JSON.stringify(Object.fromEntries(perKey))}`);
    expect(ran).toBe(PATH_KEYS.reduce((n, k) => n + engineSports(k).reduce((m, s) => m + playedCount(k, s), 0), 0));
    for (const key of PATH_KEYS) expect(perKey.get(key) ?? 0, `${key}: no sport was run`).toBeGreaterThan(0);
  });

  it("a key planned on a cell it is not for is refused by name before any driver call: a table row, or EVERY sport the engine declares no such decider for (including the other period and football sports)", async () => {
    const tableRow = ROW_KEYS.find((r) => !bracketRootRows().includes(r))!;
    expect(tableRow, "a catalogue row whose root stage is not a bracket").toBeDefined();
    let refused = 0;
    let expected = 0;
    for (const key of W2E_SCENARIO_KEYS) {
      const cells: (readonly [RowKey, string, RegExp])[] = [
        [tableRow, engineSports(key)[0]!, /root stage is not a bracket kind/],
        ...SPORT_KEYS.filter((sport) => !engineSports(key).includes(sport)).map((sport) => ["knockout", sport, key === SANCTION_KEY ? /builds no sanction that ends a match/ : /builds no such path/] as const),
      ];
      expected += cells.length;
      for (const [row, sport, why] of cells) {
        const variant = variantFor(sport);
        const spec: CaseSpec = { caseId: `${row}|${sport}|${variant}|${key}`, row, sport, variant, scenario: key, canary: false };
        const calls: string[] = [];
        const driver = new Proxy(new FakeKnockoutDriver(), { get: (t, k, r) => { calls.push(String(k)); return Reflect.get(t, k, r) as unknown; } });
        const err = await SCENARIOS[key].run({ driver, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] }).then(() => null, (e: unknown) => e as Error);
        expect(err, `${key} on ${row}|${sport}`).toBeInstanceOf(W2eMisplanned);
        expect(err!.message, `${key} on ${row}|${sport}`).toMatch(why);
        expect(err!.message).toContain(key);
        expect(calls, `${key}: nothing was asked of the driver`).toEqual([]);
        refused++;
      }
    }
    expect(refused).toBe(expected);
    expect(refused).toBeGreaterThan(2 * W2E_SCENARIO_KEYS.length);
  });
});

describe("everyMatchTookTheDecidingPath, on hand-built drives (a wrong product is named, an empty run fails)", () => {
  const variant = variantFor("football");
  const cfg = stageCfg("football", resolveSportCfg("football", variant), "knockout", variant);
  const streamOf = (path: "extraTime" | "shootout"): StreamEvent[] => generateStream({ sportKey: "football", cfg, stageKind: "knockout", home: "a", away: "b", outcome: { kind: "win", winner: "home", path } });
  /** A drive as decideFixture records it, with the stream the harness posted. The product's method is the local fold's. */
  const drive = (path: "extraTime" | "shootout", over: Partial<BracketDrive> = {}) => {
    const stream = streamOf(path);
    const method = (foldStream(football, cfg, "a", "b", stream).outcome as { method?: string }).method;
    const d: BracketDrive = {
      fixtureId: "f1", stageKind: "knockout", sport: "football", home: "a", away: "b", asked: { kind: "win", winner: "home", path },
      levelAs: null, status: "decided", outcome: { kind: "win", winner: "a", ...(method === undefined ? {} : { method }) }, loser: { line: "none" }, next: { line: "none" }, forfeitPlay: null, refusal: null,
      product: productOf(football, cfg, "a", "b", stream), ...over,
    };
    return { d, stream };
  };
  const recOf = (...drives: { d: BracketDrive; stream: StreamEvent[] }[]) => {
    const r = new Recorder();
    for (const { d, stream } of drives) { r.bracketDrives.push(d); r.streams.set(d.fixtureId, stream); }
    return r;
  };
  const cfgOf = () => cfg;

  it("the right path passes per key; a plain win, the other path, the other winner, a held match, no outcome, a product method of the other path, a missing stream each red alone; an empty run fails (R25)", () => {
    expect(everyMatchTookTheDecidingPath(recOf(drive("extraTime")), "W2E_ET", cfgOf)).toMatchObject({ verdict: "pass", checked: 1 });
    expect(everyMatchTookTheDecidingPath(recOf(drive("shootout")), "W2E_SO", cfgOf)).toMatchObject({ verdict: "pass", checked: 1 });
    const et = drive("extraTime");
    const so = drive("shootout");
    const wrong: readonly [string, { d: BracketDrive; stream: StreamEvent[] }, W2eScenarioKey][] = [
      ["a plain win", { ...et, d: { ...et.d, asked: { kind: "win", winner: "home" } } }, "W2E_ET"],
      ["the shoot-out in the ET scenario", so, "W2E_ET"],
      ["extra time in the SO scenario", et, "W2E_SO"],
      ["the product shows the other winner", { ...et, d: { ...et.d, outcome: { kind: "win", winner: "b", method: "extra_time" } } }, "W2E_ET"],
      ["held, not decided", { ...et, d: { ...et.d, status: "needs_decision" } }, "W2E_ET"],
      ["the product shows no outcome", { ...et, d: { ...et.d, outcome: null } }, "W2E_ET"],
      ["the product shows the shoot-out's method for an ET request", { ...et, d: { ...et.d, outcome: { kind: "win", winner: "a", method: "shootout" } } }, "W2E_ET"],
      ["the product shows a regulation win", { ...so, d: { ...so.d, outcome: { kind: "win", winner: "a", method: "regulation" } } }, "W2E_SO"],
      ["no stream was recorded", { d: et.d, stream: [] }, "W2E_ET"],
      ["the product's own /state was not recorded (Task 21: product evidence is owed on every drive)", { ...et, d: { ...et.d, product: null } }, "W2E_ET"],
      ["a drive recorded before Task 21 carried no product at all", { ...et, d: (({ product: _p, ...rest }) => rest)(et.d) }, "W2E_ET"],
    ];
    let reds = 0;
    for (const [label, x, key] of wrong) {
      const r = new Recorder();
      r.bracketDrives.push(x.d);
      if (x.stream.length > 0) r.streams.set(x.d.fixtureId, x.stream);
      expect(everyMatchTookTheDecidingPath(r, key, cfgOf), label).toMatchObject({ verdict: "fail", checked: 1 });
      reds++;
    }
    expect(reds).toBe(wrong.length);
    expect(everyMatchTookTheDecidingPath(new Recorder(), "W2E_ET", cfgOf)).toMatchObject({ verdict: "fail", checked: 0 });
    // One wrong match among right ones is named.
    expect(everyMatchTookTheDecidingPath(recOf(et, { ...so, d: { ...so.d, fixtureId: "f2" } }), "W2E_ET", cfgOf)).toMatchObject({ verdict: "fail", checked: 2 });
  });
});

describe("everyMatchTookTheDecidingPath on ice hockey's drives (overtime, the GWS): the product's method is read through the engine, a wrong path or method is named", () => {
  const variant = variantFor("icehockey");
  const cfg = stageCfg("icehockey", resolveSportCfg("icehockey", variant), "knockout", variant);
  const streamOf = (path: "overtime" | "gws"): StreamEvent[] => generateStream({ sportKey: "icehockey", cfg, stageKind: "knockout", home: "a", away: "b", outcome: { kind: "win", winner: "home", path } });
  const drive = (path: "overtime" | "gws", over: Partial<BracketDrive> = {}) => {
    const stream = streamOf(path);
    const method = (foldStream(icehockey, cfg, "a", "b", stream).outcome as { method?: string }).method;
    const d: BracketDrive = {
      fixtureId: "f1", stageKind: "knockout", sport: "icehockey", home: "a", away: "b", asked: { kind: "win", winner: "home", path },
      levelAs: null, status: "decided", outcome: { kind: "win", winner: "a", ...(method === undefined ? {} : { method }) }, loser: { line: "none" }, next: { line: "none" }, forfeitPlay: null, refusal: null,
      product: productOf(icehockey, cfg, "a", "b", stream), ...over,
    };
    return { d, stream };
  };
  const one = (x: { d: BracketDrive; stream: StreamEvent[] }) => {
    const r = new Recorder();
    r.bracketDrives.push(x.d);
    if (x.stream.length > 0) r.streams.set(x.d.fixtureId, x.stream);
    return r;
  };
  const cfgOf = () => cfg;

  it("the right path passes per key (the product's methods are the engine's: extra_time, shootout); the other key's path, the other method, a regulation method, the other winner and a missing stream each red alone", () => {
    const ot = drive("overtime");
    const gws = drive("gws");
    expect((ot.d.outcome as { method?: string }).method).toBe("extra_time");
    expect((gws.d.outcome as { method?: string }).method).toBe("shootout");
    expect(everyMatchTookTheDecidingPath(one(ot), "W2E_OT", cfgOf)).toMatchObject({ verdict: "pass", checked: 1 });
    expect(everyMatchTookTheDecidingPath(one(gws), "W2E_SO", cfgOf)).toMatchObject({ verdict: "pass", checked: 1 });
    const wrong: readonly [string, { d: BracketDrive; stream: StreamEvent[] }, W2eScenarioKey][] = [
      ["the GWS under the overtime key", gws, "W2E_OT"],
      ["the overtime under the shoot-out key", ot, "W2E_SO"],
      ["the product shows the shoot-out's method for an overtime request", { ...ot, d: { ...ot.d, outcome: { kind: "win", winner: "a", method: "shootout" } } }, "W2E_OT"],
      ["the product shows overtime's method for a GWS request", { ...gws, d: { ...gws.d, outcome: { kind: "win", winner: "a", method: "extra_time" } } }, "W2E_SO"],
      ["the product shows a regulation win for an overtime request", { ...ot, d: { ...ot.d, outcome: { kind: "win", winner: "a", method: "regulation" } } }, "W2E_OT"],
      ["the product shows the other winner", { ...gws, d: { ...gws.d, outcome: { kind: "win", winner: "b", method: "shootout" } } }, "W2E_SO"],
      ["no stream was recorded", { d: gws.d, stream: [] }, "W2E_SO"],
    ];
    let reds = 0;
    for (const [label, x, key] of wrong) {
      expect(everyMatchTookTheDecidingPath(one(x), key, cfgOf), label).toMatchObject({ verdict: "fail", checked: 1 });
      reds++;
    }
    expect(reds).toBe(wrong.length);
  });
});

// ---------------------------------------------------------------------------
// Task 21 Part 1 — the witness reads the PRODUCT's /state, not only the local fold (Task 19 Important carry, Task 20 I-1).

describe("Task 21: the period sports' shoot-out name is witnessed on the product's summary headline", () => {
  /** The engine's own name for a cfg's shoot-out (kernel.ts: the `preset.shootoutLabel` the pad panel and the headline both
   *  print) - read off the pad panel that carries the sport's attempt event, never typed. */
  const labelOf = (sport: "hockey" | "icehockey", cfg: unknown): string =>
    sportModule(sport).padSpec!(cfg as never).panels.find((p) => p.actions.some((a) => a.type === `${sport}.shootout.attempt`))!.labelKey.label;
  const cases = [["hockey", hockey, "shootout"], ["icehockey", icehockey, "gws"]] as const;
  const build = (sport: "hockey" | "icehockey", module: typeof hockey | typeof icehockey, path: "shootout" | "gws") => {
    const variant = variantFor(sport);
    const cfg = stageCfg(sport, resolveSportCfg(sport, variant), "knockout", variant);
    const stream = generateStream({ sportKey: sport, cfg, stageKind: "knockout", home: "a", away: "b", outcome: { kind: "win", winner: "home", path } });
    const method = (foldStream(module, cfg, "a", "b", stream).outcome as { method?: string }).method;
    const d: BracketDrive = {
      fixtureId: "f1", stageKind: "knockout", sport, home: "a", away: "b", asked: { kind: "win", winner: "home", path },
      levelAs: null, status: "decided", outcome: { kind: "win", winner: "a", ...(method === undefined ? {} : { method }) }, loser: { line: "none" }, next: { line: "none" }, forfeitPlay: null, refusal: null,
      product: productOf(module, cfg, "a", "b", stream),
    };
    const rec = new Recorder();
    rec.bracketDrives.push(d);
    rec.streams.set("f1", stream);
    return { cfg, d, rec };
  };
  /** The same drive, its product's headline naming `label` where the engine's own label stood. */
  const relabelled = (x: ReturnType<typeof build>, from: string, to: string): Recorder => {
    const product = JSON.parse(JSON.stringify(x.d.product)) as { summary: { headline: string } };
    product.summary.headline = product.summary.headline.replace(`(${from} `, `(${to} `);
    const rec = new Recorder();
    rec.bracketDrives.push({ ...x.d, product: product as ProductFold });
    rec.streams.set("f1", x.rec.streams.get("f1")!);
    return rec;
  };

  it("the product's headline carries the engine's label, and that label differs between the two sports (right answer differs from the wrong one)", () => {
    const labels = new Set<string>();
    for (const [sport, module, path] of cases) {
      const x = build(sport, module, path);
      const label = labelOf(sport, x.cfg);
      const headline = (x.d.product as { summary: { headline: string } }).summary.headline;
      expect(headline, sport).toContain(`(${label} `);
      labels.add(label);
    }
    expect([...labels].sort()).toEqual(["GWS", "SO"]);
  });

  it("passes on the product's own label; a headline that names the OTHER sport's label, or no shoot-out, or no summary at all, each reds the match alone — whatever the local fold says", () => {
    let reds = 0;
    for (const [sport, module, path] of cases) {
      const x = build(sport, module, path);
      const key: W2eScenarioKey = "W2E_SO";
      const cfgOf = () => x.cfg;
      expect(everyMatchTookTheDecidingPath(x.rec, key, cfgOf), `${sport} right`).toMatchObject({ verdict: "pass", checked: 1 });
      const mine = labelOf(sport, x.cfg);
      const other = mine === "SO" ? "GWS" : "SO";
      expect(everyMatchTookTheDecidingPath(relabelled(x, mine, other), key, cfgOf), `${sport} other label`).toMatchObject({ verdict: "fail", checked: 1 });
      const noTally = new Recorder();
      noTally.bracketDrives.push({ ...x.d, product: { summary: { headline: "0 — 0" }, state: (x.d.product as ProductFold).state } });
      noTally.streams.set("f1", x.rec.streams.get("f1")!);
      expect(everyMatchTookTheDecidingPath(noTally, key, cfgOf), `${sport} no tally`).toMatchObject({ verdict: "fail", checked: 1 });
      const noSummary = new Recorder();
      noSummary.bracketDrives.push({ ...x.d, product: { summary: null, state: (x.d.product as ProductFold).state } });
      noSummary.streams.set("f1", x.rec.streams.get("f1")!);
      expect(everyMatchTookTheDecidingPath(noSummary, key, cfgOf), `${sport} no summary`).toMatchObject({ verdict: "fail", checked: 1 });
      reds += 3;
    }
    expect(reds).toBe(6);
  });
});

describe("Task 21: the fake knockout driver serves a product-shaped /state, and the scenarios record it", () => {
  /** A fake that keeps every /state answer it gave, in order. */
  class Spy extends FakeKnockoutDriver {
    readonly reads: { id: string; st: FixtureStateOut }[] = [];
    override async fixtureState(id: string): Promise<FixtureStateOut> { const st = await super.fixtureState(id); this.reads.push({ id, st }); return st; }
  }

  it("a fixture nothing was posted to serves null summary and state (the product has no match_states row); a decided one serves the engine's summary of its fold and that fold's state — the playing is the scenario's own, so this is the integrated path", async () => {
    const sport = "icehockey";
    const variant = variantFor(sport);
    const driver = new Spy();
    const spec: CaseSpec = { caseId: `knockout|${sport}|${variant}|W2E_SO`, row: "knockout", sport, variant, scenario: "W2E_SO", canary: false };
    await SCENARIOS.W2E_SO.run({ driver, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] });
    const first = new Map<string, FixtureStateOut>();
    for (const r of driver.reads) if (!first.has(r.id)) first.set(r.id, r.st);
    let untouched = 0;
    for (const [id, st] of first) {
      if (st.last_seq !== 0) continue;
      expect(st.summary, `${id} before any event`).toBeNull();
      expect(st.state, `${id} before any event`).toBeNull();
      untouched++;
    }
    expect(untouched, "some fixture was read before it was played").toBeGreaterThan(1);
    let played = 0;
    for (const f of driver.rows()) {
      const st = await driver.fixtureState(f.id);
      if (f.status !== "decided") continue;
      expect(st.state, f.id).not.toBeNull();
      expect(st.summary, f.id).not.toBeNull();
      expect((st.summary as { headline: string }).headline, f.id).toBe(sportModule(sport).summary(st.state as never).headline);
      expect(st.outcome, f.id).toMatchObject({ kind: "win" });
      played++;
    }
    expect(played, "more than one decided fixture was read").toBeGreaterThan(1);
  });
});

describe("everyMatchTookTheDecidingPath, cricket's super over and DLS on hand-built drives (Task 21: paths the outcome cannot name are read from the PRODUCT's state)", () => {
  const variant = variantFor("cricket");
  const cfg = stageCfg("cricket", resolveSportCfg("cricket", variant), "knockout", variant);
  const cfgOf = () => cfg;
  const stream = (path: "superOver" | "dls", winner: "home" | "away" = "home"): StreamEvent[] =>
    generateStream({ sportKey: "cricket", cfg, stageKind: "knockout", home: "a", away: "b", outcome: { kind: "win", winner, path }, lineups: PROBE_LINEUPS });
  /** A drive as decideFixture records it: the stream the harness posted, the outcome the product answered, and the product's
   *  own /state - here the fold of `shown` (what the product held), which a wrong-product test replaces. */
  const drive = (path: "superOver" | "dls", over: Partial<BracketDrive> = {}) => {
    const events = stream(path);
    const method = (foldStream(cricket, cfg, "a", "b", events, PROBE_LINEUPS).outcome as { method?: string }).method;
    const d: BracketDrive = {
      fixtureId: "f1", stageKind: "knockout", sport: "cricket", home: "a", away: "b", asked: { kind: "win", winner: "home", path },
      levelAs: null, status: "decided", outcome: { kind: "win", winner: "a", ...(method === undefined ? {} : { method }) }, loser: { line: "none" }, next: { line: "none" }, forfeitPlay: null, refusal: null,
      product: productOf(cricket, cfg, "a", "b", events, PROBE_LINEUPS), lineups: PROBE_LINEUPS, ...over,
    };
    return { d, stream: events };
  };
  const one = (x: { d: BracketDrive; stream: StreamEvent[] }, key: W2eScenarioKey) => {
    const r = new Recorder();
    r.bracketDrives.push(x.d);
    if (x.stream.length > 0) r.streams.set(x.d.fixtureId, x.stream);
    return everyMatchTookTheDecidingPath(r, key, cfgOf);
  };
  /** The product's state of a plain regulation win: no super over was played and no target revised. */
  const regulation = productOf(cricket, cfg, "a", "b", generateStream({ sportKey: "cricket", cfg, stageKind: "knockout", home: "a", away: "b", outcome: { kind: "win", winner: "home" } }));

  it("the right path passes per key, counted; a super over or a revision the PRODUCT's state does not show reds even when the stream the harness posted was one (the local fold would pass)", () => {
    const so = drive("superOver");
    const dls = drive("dls");
    expect(one(so, "W2E_SUPER_OVER")).toMatchObject({ verdict: "pass", checked: 1 });
    expect(one(dls, "W2E_DLS")).toMatchObject({ verdict: "pass", checked: 1 });
    const wrong: readonly [string, { d: BracketDrive; stream: StreamEvent[] }, W2eScenarioKey][] = [
      ["a super over the product's state never played (its outcome claims one)", { ...so, d: { ...so.d, product: regulation } }, "W2E_SUPER_OVER"],
      ["the product's state is the super over's with an unfinished pair", { ...so, d: { ...so.d, product: { ...(so.d.product as ProductFold), state: { ...(so.d.product!.state as object), superOver: { innings: [], dismissed: { home: [], away: [] } } } } } }, "W2E_SUPER_OVER"],
      ["a regulation outcome with the super over's state", { ...so, d: { ...so.d, outcome: { kind: "win", winner: "a", method: "regulation" } } }, "W2E_SUPER_OVER"],
      ["no product state was recorded", { ...so, d: { ...so.d, product: null } }, "W2E_SUPER_OVER"],
      ["the lineups the stream was built against were not recorded (it cannot be refolded)", { ...so, d: { ...so.d, lineups: undefined } }, "W2E_SUPER_OVER"],
      ["a revised target the product's state never held (its outcome claims DLS)", { ...dls, d: { ...dls.d, product: regulation } }, "W2E_DLS"],
      ["a regulation outcome with a revised target's state", { ...dls, d: { ...dls.d, outcome: { kind: "win", winner: "a", method: "regulation" } } }, "W2E_DLS"],
      ["the super over's drive under the DLS key", so, "W2E_DLS"],
      ["the DLS drive under the super over key", dls, "W2E_SUPER_OVER"],
      ["the other winner", { ...so, d: { ...so.d, outcome: { kind: "win", winner: "b", method: "super_over" } } }, "W2E_SUPER_OVER"],
    ];
    for (const [label, x, key] of wrong) expect(one(x, key), label).toMatchObject({ verdict: "fail", checked: 1 });
    expect(wrong.length).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Task 22 - the set sports' deciding set and cap are STATE ONLY (the outcome is a 'regulation' win however the sets went), so
// the scenario check reads them from the PRODUCT's state: the Task 19 Important carry.

describe("everyMatchTookTheDecidingPath, the set sports' deciding set and cap on hand-built drives (Task 22: a state-only path is read from the PRODUCT's state)", () => {
  type SetPath = "decidingSet" | "cap";
  const KEY_OF: Readonly<Record<SetPath, W2eScenarioKey>> = { decidingSet: "W2E_DECIDER", cap: "W2E_CAP" };
  const modules = { badminton, volleyball, tabletennis } as const;
  const cfgOfCase = (sport: keyof typeof modules, variant: string) => stageCfg(sport, resolveSportCfg(sport, variant), "knockout", variant) as SetCfg;
  const streamOf = (sport: string, cfg: unknown, path?: SetPath): StreamEvent[] =>
    generateStream({ sportKey: sport, cfg, stageKind: "knockout", home: "a", away: "b", outcome: path === undefined ? { kind: "win", winner: "home" } : { kind: "win", winner: "home", path } });
  const productFor = (sport: keyof typeof modules, cfg: unknown, events: readonly StreamEvent[]): ProductFold => productOf(modules[sport], cfg, "a", "b", events);
  /** A drive as decideFixture records it: the stream the harness posted, the outcome the product answered and the product's own
   *  /state (here the fold of what the product held), which a wrong-product row replaces. */
  const build = (sport: keyof typeof modules, variant: string, path: SetPath) => {
    const cfg = cfgOfCase(sport, variant);
    const events = streamOf(sport, cfg, path);
    const d: BracketDrive = {
      fixtureId: "f1", stageKind: "knockout", sport, home: "a", away: "b", asked: { kind: "win", winner: "home", path },
      levelAs: null, status: "decided", outcome: { kind: "win", winner: "a", method: "regulation" }, loser: { line: "none" }, next: { line: "none" }, forfeitPlay: null, refusal: null,
      product: productFor(sport, cfg, events),
    };
    return { sport, variant, path, cfg, d, stream: events, plain: productFor(sport, cfg, streamOf(sport, cfg)) };
  };
  const check = (x: { d: BracketDrive; stream: StreamEvent[] }, key: W2eScenarioKey, cfg: unknown) => {
    const r = new Recorder();
    r.bracketDrives.push(x.d);
    if (x.stream.length > 0) r.streams.set(x.d.fixtureId, x.stream);
    return everyMatchTookTheDecidingPath(r, key, () => cfg);
  };
  const CASES: readonly (readonly [keyof typeof modules, string, SetPath])[] = [
    ["badminton", "bwf-3x15", "decidingSet"], ["badminton", "bwf-3x15", "cap"], ["badminton", "bwf", "cap"], ["badminton", "bwf", "decidingSet"], ["badminton", "short", "cap"],
    ["volleyball", "indoor", "decidingSet"], ["volleyball", "beach", "decidingSet"], ["tabletennis", "bo5", "decidingSet"], ["tabletennis", "bo7", "decidingSet"],
  ];

  it("the right path passes under its own key, counted; the same drive under the OTHER set key, the path asked as a path the sport lacks, a plain win and a held match each red alone", () => {
    let passes = 0;
    let reds = 0;
    for (const [sport, variant, path] of CASES) {
      const x = build(sport, variant, path);
      const at = `${sport}/${variant} ${path}`;
      expect(check(x, KEY_OF[path], x.cfg), at).toMatchObject({ verdict: "pass", checked: 1 });
      passes++;
      // Right path under the wrong key.
      const wrongKey = KEY_OF[path === "cap" ? "decidingSet" : "cap"];
      expect(check(x, wrongKey, x.cfg), `${at} under ${wrongKey}`).toMatchObject({ verdict: "fail", checked: 1 });
      expect(check(x, "W2E_SO", x.cfg), `${at} under the shoot-out key`).toMatchObject({ verdict: "fail", checked: 1 });
      // The harness asked for a plain win / another path than the stream and product show.
      expect(check({ ...x, d: { ...x.d, asked: { kind: "win", winner: "home" } } }, KEY_OF[path], x.cfg), `${at}: a plain win`).toMatchObject({ verdict: "fail", checked: 1 });
      expect(check({ ...x, d: { ...x.d, status: "needs_decision" } }, KEY_OF[path], x.cfg), `${at}: held`).toMatchObject({ verdict: "fail", checked: 1 });
      expect(check({ ...x, d: { ...x.d, outcome: { kind: "win", winner: "b", method: "regulation" } } }, KEY_OF[path], x.cfg), `${at}: the other winner`).toMatchObject({ verdict: "fail", checked: 1 });
      expect(check({ d: x.d, stream: [] }, KEY_OF[path], x.cfg), `${at}: no stream`).toMatchObject({ verdict: "fail", checked: 1 });
      reds += 5;
    }
    expect(passes).toBe(CASES.length);
    expect(reds).toBe(CASES.length * 5);
    expect(check({ d: build("badminton", "bwf", "cap").d, stream: [] }, "W2E_CAP", cfgOfCase("badminton", "bwf")), "an empty stream").toMatchObject({ verdict: "fail" });
    expect(everyMatchTookTheDecidingPath(new Recorder(), "W2E_DECIDER", () => ({}))).toMatchObject({ verdict: "fail", checked: 0 });
    expect(everyMatchTookTheDecidingPath(new Recorder(), "W2E_CAP", () => ({}))).toMatchObject({ verdict: "fail", checked: 0 });
  });

  it("a WRONG PRODUCT reds even when the stream the harness posted is the path (the local fold would pass): a product that never reached the deciding set or the cap, one that reached the other path, no product at all, a half one, and one folded under another cfg - and the product, not the stream, is believed", () => {
    let rows = 0;
    const fail = (label: string, x: { d: BracketDrive; stream: StreamEvent[] }, key: W2eScenarioKey, cfg: unknown) => {
      expect(check(x, key, cfg), label).toMatchObject({ verdict: "fail", checked: 1 });
      rows++;
    };
    for (const [sport, variant, path] of CASES) {
      const x = build(sport, variant, path);
      const key = KEY_OF[path];
      const at = `${sport}/${variant} ${path}`;
      const product = x.d.product as ProductFold;
      // The product never reached the path: its state is a straight-sets win (the local fold, on the stream posted, did).
      fail(`${at}: the product's state is a straight-sets win`, { ...x, d: { ...x.d, product: x.plain } }, key, x.cfg);
      // The product reached the OTHER path (where the cfg has one).
      const otherPath: SetPath = path === "cap" ? "decidingSet" : "cap";
      const otherEvents = (() => { try { return streamOf(sport, x.cfg, otherPath); } catch { return null; } })();
      if (otherEvents !== null) fail(`${at}: the product's state is the ${otherPath} win's`, { ...x, d: { ...x.d, product: productFor(sport, x.cfg, otherEvents) } }, key, x.cfg);
      // No product at all, and a drive recorded before Task 21 that carried none.
      fail(`${at}: product null`, { ...x, d: { ...x.d, product: null } }, key, x.cfg);
      fail(`${at}: a drive that carried no product field`, { ...x, d: (({ product: _p, ...rest }) => rest)(x.d) }, key, x.cfg);
      // A half product, and an inconsistent one.
      fail(`${at}: no summary`, { ...x, d: { ...x.d, product: { summary: null, state: product.state } } }, key, x.cfg);
      fail(`${at}: no state`, { ...x, d: { ...x.d, product: { summary: product.summary, state: null } } }, key, x.cfg);
      const strip = JSON.parse(JSON.stringify(product)) as { summary: { detail: { sets: { away: number }[] } } };
      strip.summary.detail.sets[0]!.away += 1;
      fail(`${at}: the summary's set strip is not the state's`, { ...x, d: { ...x.d, product: strip as unknown as ProductFold } }, key, x.cfg);
      const cfgMoved = JSON.parse(JSON.stringify(product)) as { state: { cfg: SetCfg } };
      cfgMoved.state.cfg.winBy += 1;
      fail(`${at}: the product folded under another winBy`, { ...x, d: { ...x.d, product: cfgMoved as unknown as ProductFold } }, key, x.cfg);
      const outcomeMoved = JSON.parse(JSON.stringify(product)) as { state: { outcome: { winner: string } } };
      outcomeMoved.state.outcome.winner = "b";
      fail(`${at}: the product's own outcome names the other winner`, { ...x, d: { ...x.d, product: outcomeMoved as unknown as ProductFold } }, key, x.cfg);
      const live = JSON.parse(JSON.stringify(product)) as { state: { phase: string } };
      live.state.phase = "live";
      fail(`${at}: the product's match is not done`, { ...x, d: { ...x.d, product: live as unknown as ProductFold } }, key, x.cfg);
      // The product claims a win the set kernel does not declare (a shoot-out): named, never thrown.
      fail(`${at}: the product's outcome claims a shoot-out`, { ...x, d: { ...x.d, outcome: { kind: "win", winner: "a", method: "shootout" } } }, key, x.cfg);
      // The stream the harness posted is a plain win although the product shows the path: the local parity gate still reds.
      fail(`${at}: the posted stream was a plain win`, { d: x.d, stream: streamOf(sport, x.cfg) }, key, x.cfg);
    }
    console.info(`w2e-scenarios: ${rows} wrong-product row(s) over ${CASES.length} case(s)`);
    expect(rows).toBeGreaterThan(CASES.length * 10);
  });
});

describe("Task 22: what the fake knockout product holds for each W2E_DECIDER / W2E_CAP match IS the path - read from its /state by the engine's declarations, not by the witness", () => {
  /** Runs `key` on the fake for `sport` at `variant`; returns the decided fixtures' product states, in order. */
  async function playedStates(key: "W2E_DECIDER" | "W2E_CAP", sport: string, variant: string) {
    const driver = new FakeKnockoutDriver();
    const spec: CaseSpec = { caseId: `knockout|${sport}|${variant}|${key}`, row: "knockout", sport, variant, scenario: key, canary: false };
    const out = await SCENARIOS[key].run({ driver, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] });
    const states: SetFoldState[] = [];
    for (const f of driver.rows()) {
      if (f.status !== "decided") continue;
      const st = await driver.fixtureState(f.id);
      expect(st.state, f.id).not.toBeNull();
      states.push(st.state as SetFoldState);
    }
    return { out, states, cfg: stageCfg(sport, resolveSportCfg(sport, variant), "knockout", variant) as SetCfg };
  }
  const winnerSide = (st: SetFoldState): "home" | "away" => (st.entrants.home === st.outcome!.winner ? "home" : "away");
  const wonBy = (st: SetFoldState, side: "home" | "away") => st.sets.filter((s) => s.closed && s[side] > s[side === "home" ? "away" : "home"]).length;

  it("W2E_DECIDER: every decided match, for every sport the engine says reaches a deciding set, went the distance - level before the last set, the last played to the cfg's finalSetTo", async () => {
    let matches = 0;
    const sports = engineSports("W2E_DECIDER");
    expect(sports.length).toBeGreaterThan(1);
    for (const sport of sports) {
      const { out, states, cfg } = await playedStates("W2E_DECIDER", sport, variantFor(sport));
      expect(out.assertions.find((a) => a.id === "w2e-every-match-took-the-path")!.verdict, sport).toBe("pass");
      expect(states.length, `${sport}: more than one match decided`).toBeGreaterThan(1);
      for (const st of states) {
        const side = winnerSide(st);
        const other = side === "home" ? "away" : "home";
        expect(st.sets.length, `${sport}`).toBe(cfg.bestOf);
        expect(wonBy(st, side), sport).toBe(Math.ceil(cfg.bestOf / 2));
        expect(wonBy(st, other), sport).toBe(Math.ceil(cfg.bestOf / 2) - 1);
        expect(Math.max(st.sets.at(-1)!.home, st.sets.at(-1)!.away), `${sport}: the deciding set's own target`).toBe(cfg.finalSetTo);
        matches++;
      }
    }
    console.info(`w2e-scenarios: ${matches} W2E_DECIDER match(es) read off the product's state across ${sports.join(", ")}`);
    expect(matches).toBeGreaterThan(sports.length);
  });

  it("W2E_CAP: every decided match ended on the cap - 30-29 under bwf (3x21) and 21-20 under bwf-3x15, the variant on the case, which a typed constant could not do for both", async () => {
    const seen = new Map<string, [number, number]>();
    let matches = 0;
    for (const variant of ["bwf", "bwf-3x15", "short"]) {
      const { out, states, cfg } = await playedStates("W2E_CAP", "badminton", variant);
      expect(out.assertions.find((a) => a.id === "w2e-every-match-took-the-path")!.verdict, variant).toBe("pass");
      expect(states.length, `${variant}: more than one match decided`).toBeGreaterThan(1);
      for (const st of states) {
        const side = winnerSide(st);
        const other = side === "home" ? "away" : "home";
        for (const s of st.sets) {
          expect([s[side], s[other]], variant).toEqual([cfg.cap, cfg.cap! - 1]);
          seen.set(variant, [s[side], s[other]]);
        }
        matches++;
      }
    }
    // The rulebook's: BWF 7.4 (29-all, the 30th point), the 3x15 format (20-all, the 21st), the junior short game's cap 15.
    expect(Object.fromEntries(seen)).toEqual({ bwf: [30, 29], "bwf-3x15": [21, 20], short: [15, 14] });
    expect(matches).toBeGreaterThan(3);
  });
});

// ---------------------------------------------------------------------------
// Task 23 - tennis's tie-break set and short-set tie-break are STATE ONLY (a tennis win is 'regulation' however its sets went), so
// the scenario check reads them from the PRODUCT's state, as the set sports' (Task 22).

describe("everyMatchTookTheDecidingPath, tennis's tie-break set and short-set tie-break on hand-built drives (Task 23: a state-only path is read from the PRODUCT's state)", () => {
  type TnPath = "tiebreakSet" | "shortSetTb";
  const KEY_OF: Readonly<Record<TnPath, W2eScenarioKey>> = { tiebreakSet: "W2E_TB_SET", shortSetTb: "W2E_SHORT_SETS" };
  const OTHER_OF: Readonly<Record<TnPath, TnPath>> = { tiebreakSet: "shortSetTb", shortSetTb: "tiebreakSet" };
  const cfgOfCase = (variant: string) => stageCfg("tennis", resolveSportCfg("tennis", variant), "knockout", variant) as TennisCfg;
  const streamOf = (cfg: unknown, path?: TnPath): StreamEvent[] =>
    generateStream({ sportKey: "tennis", cfg, stageKind: "knockout", home: "a", away: "b", outcome: path === undefined ? { kind: "win", winner: "home" } : { kind: "win", winner: "home", path } });
  const productFor = (cfg: unknown, events: readonly StreamEvent[]): ProductFold => productOf(tennis, cfg, "a", "b", events);
  /** A drive as decideFixture records it: the stream the harness posted, the outcome the product answered and its own /state. */
  const build = (variant: string, path: TnPath) => {
    const cfg = cfgOfCase(variant);
    const events = streamOf(cfg, path);
    const d: BracketDrive = {
      fixtureId: "f1", stageKind: "knockout", sport: "tennis", home: "a", away: "b", asked: { kind: "win", winner: "home", path },
      levelAs: null, status: "decided", outcome: { kind: "win", winner: "a", method: "regulation" }, loser: { line: "none" }, next: { line: "none" }, forfeitPlay: null, refusal: null,
      product: productFor(cfg, events),
    };
    return { variant, path, cfg, d, stream: events, plain: productFor(cfg, streamOf(cfg)) };
  };
  const check = (x: { d: BracketDrive; stream: StreamEvent[] }, key: W2eScenarioKey, cfg: unknown) => {
    const r = new Recorder();
    r.bracketDrives.push(x.d);
    if (x.stream.length > 0) r.streams.set(x.d.fixtureId, x.stream);
    return everyMatchTookTheDecidingPath(r, key, () => cfg);
  };
  /** Every shipped tennis variant x the paths it builds (the engine's cfg decides which: a path the cfg lacks is refused by name). */
  const CASES = variantKeys("tennis").flatMap((variant) => (["tiebreakSet", "shortSetTb"] as const).flatMap((path) => {
    try { streamOf(cfgOfCase(variant), path); } catch { return []; }
    return [[variant, path] as const];
  }));

  it("the right path passes under its own key, counted; the same drive under the OTHER tennis key, a path asked of a sport that lacks it, a plain win, a held match and the other winner each red alone", () => {
    expect(CASES.length, "some variant builds each path").toBeGreaterThan(2);
    expect(new Set(CASES.map(([, p]) => p))).toEqual(new Set(["tiebreakSet", "shortSetTb"]));
    let passes = 0;
    let reds = 0;
    for (const [variant, path] of CASES) {
      const x = build(variant, path);
      const at = `${variant} ${path}`;
      expect(check(x, KEY_OF[path], x.cfg), at).toMatchObject({ verdict: "pass", checked: 1 });
      passes++;
      expect(check(x, KEY_OF[OTHER_OF[path]], x.cfg), `${at} under ${KEY_OF[OTHER_OF[path]]}`).toMatchObject({ verdict: "fail", checked: 1 });
      for (const foreign of ["W2E_SO", "W2E_DECIDER", "W2E_CAP"] as const) expect(check(x, foreign, x.cfg), `${at} under ${foreign}`).toMatchObject({ verdict: "fail", checked: 1 });
      expect(check({ ...x, d: { ...x.d, asked: { kind: "win", winner: "home" } } }, KEY_OF[path], x.cfg), `${at}: a plain win`).toMatchObject({ verdict: "fail", checked: 1 });
      expect(check({ ...x, d: { ...x.d, status: "needs_decision" } }, KEY_OF[path], x.cfg), `${at}: held`).toMatchObject({ verdict: "fail", checked: 1 });
      expect(check({ ...x, d: { ...x.d, outcome: { kind: "win", winner: "b", method: "regulation" } } }, KEY_OF[path], x.cfg), `${at}: the other winner`).toMatchObject({ verdict: "fail", checked: 1 });
      expect(check({ d: x.d, stream: [] }, KEY_OF[path], x.cfg), `${at}: no stream`).toMatchObject({ verdict: "fail", checked: 1 });
      reds += 7;
    }
    expect(passes).toBe(CASES.length);
    expect(reds).toBe(CASES.length * 7);
    expect(everyMatchTookTheDecidingPath(new Recorder(), "W2E_TB_SET", () => ({}))).toMatchObject({ verdict: "fail", checked: 0 });
    expect(everyMatchTookTheDecidingPath(new Recorder(), "W2E_SHORT_SETS", () => ({}))).toMatchObject({ verdict: "fail", checked: 0 });
  });

  it("a WRONG PRODUCT reds even when the stream the harness posted is the path (the local fold would pass): a product that never reached the path (a plain win), one that reached the other path, no product at all, a half one, and one folded under another cfg", () => {
    let rows = 0;
    const fail = (label: string, x: { d: BracketDrive; stream: StreamEvent[] }, key: W2eScenarioKey, cfg: unknown) => {
      expect(check(x, key, cfg), label).toMatchObject({ verdict: "fail", checked: 1 });
      rows++;
    };
    let otherReached = 0;
    for (const [variant, path] of CASES) {
      const x = build(variant, path);
      const key = KEY_OF[path];
      const at = `${variant} ${path}`;
      const product = x.d.product as ProductFold;
      fail(`${at}: the product's state is a straight-sets plain win`, { ...x, d: { ...x.d, product: x.plain } }, key, x.cfg);
      // The product reached the OTHER path (only a cfg that builds both has one; the short-set cfg with a final-set tie-break is built in the stream tests).
      const otherEvents = (() => { try { return streamOf(x.cfg, OTHER_OF[path]); } catch { return null; } })();
      if (otherEvents !== null) { fail(`${at}: the product's state is the ${OTHER_OF[path]} win's`, { ...x, d: { ...x.d, product: productFor(x.cfg, otherEvents) } }, key, x.cfg); otherReached++; }
      fail(`${at}: product null`, { ...x, d: { ...x.d, product: null } }, key, x.cfg);
      fail(`${at}: a drive that carried no product field`, { ...x, d: (({ product: _p, ...rest }) => rest)(x.d) }, key, x.cfg);
      fail(`${at}: no summary`, { ...x, d: { ...x.d, product: { summary: null, state: product.state } } }, key, x.cfg);
      fail(`${at}: no state`, { ...x, d: { ...x.d, product: { summary: product.summary, state: null } } }, key, x.cfg);
      const strip = JSON.parse(JSON.stringify(product)) as { summary: { detail: { sets: { away: number }[] } } };
      strip.summary.detail.sets[0]!.away += 1;
      fail(`${at}: the summary's set strip is not the state's`, { ...x, d: { ...x.d, product: strip as unknown as ProductFold } }, key, x.cfg);
      const cfgMoved = JSON.parse(JSON.stringify(product)) as { state: { cfg: TennisCfg } };
      cfgMoved.state.cfg.set.tiebreakTo += 1;
      fail(`${at}: the product folded under another tie-break target`, { ...x, d: { ...x.d, product: cfgMoved as unknown as ProductFold } }, key, x.cfg);
      const outcomeMoved = JSON.parse(JSON.stringify(product)) as { state: { outcome: { winner: string } } };
      outcomeMoved.state.outcome.winner = "b";
      fail(`${at}: the product's own outcome names the other winner`, { ...x, d: { ...x.d, product: outcomeMoved as unknown as ProductFold } }, key, x.cfg);
      const live = JSON.parse(JSON.stringify(product)) as { state: { phase: string } };
      live.state.phase = "live";
      fail(`${at}: the product's match is not done`, { ...x, d: { ...x.d, product: live as unknown as ProductFold } }, key, x.cfg);
      const tbGone = JSON.parse(JSON.stringify(product)) as { state: { sets: { tb?: unknown; mtb?: boolean }[] }; summary: { detail: { sets: { tb?: unknown; mtb?: boolean }[] } } };
      for (const sets of [tbGone.state.sets, tbGone.summary.detail.sets]) { delete sets.at(-1)!.tb; delete sets.at(-1)!.mtb; }
      fail(`${at}: the product's last set shows no tie-break`, { ...x, d: { ...x.d, product: tbGone as unknown as ProductFold } }, key, x.cfg);
      fail(`${at}: the product's outcome claims a shoot-out`, { ...x, d: { ...x.d, outcome: { kind: "win", winner: "a", method: "shootout" } } }, key, x.cfg);
      fail(`${at}: the posted stream was a plain win`, { d: x.d, stream: streamOf(x.cfg) }, key, x.cfg);
    }
    console.info(`w2e-scenarios: ${rows} wrong-product row(s) over ${CASES.length} tennis case(s)`);
    expect(rows).toBeGreaterThan(CASES.length * 10);
    // No shipped variant builds both paths (the paths are told apart by the margin a variant plays its sets under), so the other-path
    // product row has nothing to build here; the stream tests (w2e-streams.test.ts) build a cfg with both.
    expect(otherReached).toBe(0);
  });

  it("a case whose OWN cfg builds no such path is refused by name before any driver call: W2E_SHORT_SETS on tennis's default with no overrides (tour has no short-set tie-break), and W2E_TB_SET under the short-set overrides (Fast4 ends its sets at the set's own margin)", async () => {
    const def = variantFor("tennis");
    const shortOverrides = w2eOverridesFor("W2E_SHORT_SETS", "tennis")!;
    const cells: readonly (readonly [W2eScenarioKey, Record<string, unknown> | undefined])[] = [["W2E_SHORT_SETS", undefined], ["W2E_TB_SET", { ...shortOverrides }]];
    for (const [key, overrides] of cells) {
      const spec: CaseSpec = { caseId: `knockout|tennis|${def}|${key}`, row: "knockout", sport: "tennis", variant: def, scenario: key, canary: false, ...(overrides === undefined ? {} : { overrides }) };
      const calls: string[] = [];
      const driver = new Proxy(new FakeKnockoutDriver(), { get: (t, k, r) => { calls.push(String(k)); return Reflect.get(t, k, r) as unknown; } });
      const err = await SCENARIOS[key].run({ driver, spec, orgSlug: "o", cfg: resolveSportCfg("tennis", def, { ...(overrides ?? {}) }), tag: "t", denied: [] }).then(() => null, (e: unknown) => e as Error);
      expect(err, key).toBeInstanceOf(W2eMisplanned);
      expect(err!.message, key).toMatch(/builds no such path/);
      expect(calls, `${key}: nothing was asked of the driver`).toEqual([]);
    }
  });
});

describe("Task 23: what the fake knockout product holds for each W2E_TB_SET / W2E_SHORT_SETS match IS the path - read from its /state by the engine's cfg declarations, not by the witness", () => {
  async function playedStates(key: "W2E_TB_SET" | "W2E_SHORT_SETS", overrides: Readonly<Record<string, unknown>> = w2eOverridesFor(key, "tennis")!) {
    const driver = new FakeKnockoutDriver();
    const variant = variantFor("tennis");
    const spec: CaseSpec = { caseId: `knockout|tennis|${variant}|${key}`, row: "knockout", sport: "tennis", variant, scenario: key, canary: false, ...(Object.keys(overrides).length === 0 ? {} : { overrides }) };
    const cfg = resolveSportCfg("tennis", variant, { ...overrides });
    const out = await SCENARIOS[key].run({ driver, spec, orgSlug: "o", cfg, tag: "t", denied: [] });
    const states: TennisFoldState[] = [];
    for (const f of driver.rows()) {
      if (f.status !== "decided") continue;
      const st = await driver.fixtureState(f.id);
      expect(st.state, f.id).not.toBeNull();
      states.push(st.state as TennisFoldState);
    }
    return { out, states, cfg: stageCfg("tennis", cfg, "knockout", variant) as TennisCfg };
  }

  it("every decided match's last set was closed by a tie-break at the margin the key names - the match's (tiebreak.winBy) for W2E_TB_SET, the set's own (set.tiebreakWinBy) for W2E_SHORT_SETS - each at its closest finish, asked of the engine's strict fold", async () => {
    const margins = new Set<number>();
    let matches = 0;
    for (const key of TB_KEYS) {
      const { out, states, cfg } = await playedStates(key);
      expect(out.assertions.find((a) => a.id === "w2e-every-match-took-the-path")!.verdict, key).toBe("pass");
      expect(states.length, `${key}: more than one match decided`).toBeGreaterThan(1);
      const want = key === "W2E_TB_SET" ? cfg.tiebreak.winBy : cfg.set.tiebreakWinBy!;
      const target = cfg.set.tiebreakTo;
      for (const st of states) {
        const side = st.entrants.home === st.outcome!.winner ? "home" : "away";
        const other = side === "home" ? "away" : "home";
        const last = st.sets.at(-1)!;
        expect(last.tb, `${key}: the last set ended in a tie-break`).toBeDefined();
        expect([last.tb![side] - last.tb![other], last.tb![side]], `${key}: margin and target`).toEqual([want, target]);
        margins.add(last.tb![side] - last.tb![other]);
        matches++;
      }
    }
    // The two keys' margins differ (the match's 2 against the short set's 1), so a key that played the other's tie-break would red.
    expect(margins.size, "the keys play tie-breaks at different margins").toBe(2);
    console.info(`w2e-scenarios: ${matches} tennis match(es) read off the product's state`);
    expect(matches).toBeGreaterThan(2);
  });

  it("the stream a tennis scenario posts is the engine's closest finish: tbIsClosestFinish (accepted, one point short refused, one short of the margin refused) for every recorded stream, under EVERY variant the key is played under (Task 23 M1/M7: tour's set tie-break, the slam's final-set tie-break, the doubles norm's match tie-break; Fast4's and the short-sets variant's short-set tie-break)", async () => {
    let streams = 0;
    const perVariant = new Map<string, number>();
    for (const key of TB_KEYS) {
      for (const overrides of w2eOverridesSetsFor(key, "tennis")) {
        const driver = new FakeKnockoutDriver();
        const variant = variantFor("tennis");
        const played = Object.keys(overrides).length === 0 ? variant : w2eNameVariant("tennis", overrides);
        const spec: CaseSpec = { caseId: `knockout|tennis|${variant}|${key}`, row: "knockout", sport: "tennis", variant, scenario: key, canary: false, ...(Object.keys(overrides).length === 0 ? {} : { overrides }) };
        const cfg = resolveSportCfg("tennis", variant, { ...overrides });
        const out = await SCENARIOS[key].run({ driver, spec, orgSlug: "o", cfg, tag: "t", denied: [] });
        expect(out.assertions.find((a) => a.id === "w2e-every-match-took-the-path")!.verdict, `${key} as ${played}`).toBe("pass");
        const stageCfgOf = stageCfg("tennis", cfg, "knockout", variant);
        for (const f of driver.fixtures) {
          if (f.status !== "decided") continue;
          expect(f.events.length, `${key} as ${played} ${f.id}: the fake holds the stream the scenario posted`).toBeGreaterThan(1);
          expect(tbIsClosestFinish(stageCfgOf, f.events), `${key} as ${played} ${f.id}`).toEqual({ accepted: true, targetEdge: true, marginEdge: true });
          streams++;
          perVariant.set(`${key}/${played}`, (perVariant.get(`${key}/${played}`) ?? 0) + 1);
        }
      }
    }
    expect(streams, "some recorded stream was checked").toBeGreaterThan(0);
    console.info(`w2e-scenarios: tennis tie-break streams per key/variant ${JSON.stringify(Object.fromEntries(perVariant))}`);
    // Every variant of both keys played, each on more than one match.
    expect([...perVariant.keys()].sort()).toEqual(TB_KEYS.flatMap((k) => tennisPlayed(k).map((v) => `${k}/${v}`)).sort());
    for (const [k, n] of perVariant) expect(n, k).toBeGreaterThan(1);
  });
});


// ---------------------------------------------------------------------------
// Task 24 (G12): W2E_SANCTION_END. Every bracket match is ended by a sanction against the lower seed. Expected values: the sport list
// is the modules' `sanctionEnding` declarations; the forfeit reason is the rulebook's (BD-SE-1 and TN-SE-1: disqualified; VB-SE-1 /
// VB-RT-1: the incomplete team retires), typed ONCE here and set against the engine's own ending rule.
const SANCTION_REASON: Readonly<Record<string, "disqualified" | "retired">> = { badminton: "disqualified", tennis: "disqualified", volleyball: "retired" };

describe("W2E_SANCTION_END, run on the knockout fake for every sport that declares a sanction ending", () => {
  it("works: its own check passes on a counted item per bracket match, every product result is an award in the rulebook's reason to the side NOT sanctioned, the shared bracket checks pass - for every declaring sport", async () => {
    let ran = 0;
    const sports = sanctionSports();
    expect(sports.length).toBeGreaterThan(0);
    for (const sport of sports) {
      const { out, checks, state } = await runScenario(SANCTION_KEY, "knockout", sport);
      expect(checks.filter((c) => c.verdict === "fail").map((c) => `${c.id}: ${c.reason}`).join(" | "), sport).toBe("");
      expect(state, sport).toBe("works");
      const own = checks.find((c) => c.id === "w2e-every-match-ended-by-sanction")!;
      expect(own, sport).toBeDefined();
      expect(own.verdict, sport).toBe("pass");
      const level = endingLevelOf(sport);
      expect(level, `${sport}: a level that ends a match`).not.toBeNull();
      expect(endingReasonOf(sport, level!), `${sport}: the engine's ending rule agrees with the rulebook`).toBe(SANCTION_REASON[sport]);
      const awards = out.observed.stages[0]!.fixtures.filter((f) => f.outcome?.kind === "award");
      expect(awards.length, `${sport}: more than one bracket match was ended`).toBeGreaterThan(1);
      expect(own.checked, sport).toBe(awards.length);
      for (const f of awards) expect(f.outcome, `${sport} ${f.id}`).toMatchObject({ kind: "award", reason: SANCTION_REASON[sport] });
      expect(out.observed.stages[0]!.fixtures.filter((f) => f.outcome?.kind === "win"), `${sport}: no match was played to a plain win`).toEqual([]);
      for (const id of ["life-reference-bracket-finish", "life-fold-parity"]) {
        const c = checks.find((x) => x.id === id)!;
        expect(c.verdict, `${sport} ${id}`).toBe("pass");
        expect(c.checked, `${sport} ${id}`).toBeGreaterThan(0);
      }
      ran++;
    }
    console.info(`w2e-scenarios: W2E_SANCTION_END ran on ${ran} sport(s) ${JSON.stringify(sports)}`);
    expect(ran).toBe(sports.length);
  });
});

describe("W2E_SANCTION_END owes a scheduled fixture (the guard in decideFixture, reached through a driver)", () => {
  it("a fixture the product already holds under way would drop the sanction (the forfeit is posted bare there): the run is refused by name before any event is posted, never run as a plain forfeit under a sanction's name", async () => {
    class UnderWay extends FakeKnockoutDriver {
      override async fixtureState(id: string): Promise<FixtureStateOut> { return { ...(await super.fixtureState(id)), status: "in_play" }; }
    }
    let posted = 0;
    class Counting extends UnderWay {
      override async postStream(id: string, events: readonly StreamEvent[], prefix = "") { posted++; return super.postStream(id, events, prefix); }
    }
    const sport = sanctionSports()[0]!;
    const variant = variantFor(sport);
    const spec: CaseSpec = { caseId: `knockout|${sport}|${variant}|${SANCTION_KEY}`, row: "knockout", sport, variant, scenario: SANCTION_KEY, canary: false };
    const err = await SCENARIOS[SANCTION_KEY].run({ driver: new Counting(), spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] }).then(() => null, (e: unknown) => e as Error);
    expect(err, "the run is refused").toBeInstanceOf(Error);
    expect(err!.message).toMatch(/a sanction ending is posted on a scheduled fixture.*in_play.*where the sanction would be dropped/);
    expect(posted, "nothing was posted").toBe(0);
  });
});

describe("everyMatchEndedBySanction, on hand-built drives (a wrong product is named, an empty run fails)", () => {
  const A = "a";
  const B = "b";
  interface Built { d: BracketDrive; stream: StreamEvent[]; cfg: unknown }
  const built = (sport: string, by: "home" | "away", level: string): Built => {
    const variant = variantFor(sport);
    const cfg = stageCfg(sport, resolveSportCfg(sport, variant), "knockout", variant);
    const stream = generateStream({ sportKey: sport, cfg, stageKind: "knockout", home: A, away: B, outcome: { kind: "sanctionEnd", by, level } });
    const folded = foldStream(sportModule(sport), cfg, A, B, stream);
    const d: BracketDrive = {
      fixtureId: "f1", stageKind: "knockout", sport, home: A, away: B, asked: { kind: "sanctionEnd", by, level }, levelAs: null, status: "forfeited",
      outcome: JSON.parse(JSON.stringify(folded.outcome)) as BracketDrive["outcome"], loser: { line: "none" }, next: { line: "none" }, forfeitPlay: { kind: "in_progress" }, refusal: null,
      product: productOf(sportModule(sport), cfg, A, B, stream),
    };
    return { d, stream, cfg };
  };
  const levelsOf = (sport: string): string[] => { const decl = sportModule(sport).sanctionEnding!; return [...decl.endLevels, ...decl.promptLevels]; };
  const check = (x: Built, over: Partial<BracketDrive> = {}, stream: StreamEvent[] = x.stream) => {
    const r = new Recorder();
    r.bracketDrives.push({ ...x.d, ...over });
    if (stream.length > 0) r.streams.set(x.d.fixtureId, stream);
    return everyMatchEndedBySanction(r, () => x.cfg);
  };

  it("the right product passes for every sanction sport, level and side; the check names a plain win, a plain forfeit, a product with no sanction on record, the other side's or level's sanction, a state not done, the wrong award, a held match, no stream and no product - each red alone; an empty run fails (R25)", () => {
    let right = 0;
    let reds = 0;
    for (const sport of sanctionSports()) {
      for (const level of levelsOf(sport)) for (const by of ["home", "away"] as const) {
        const x = built(sport, by, level);
        const at = `${sport} ${level} ${by}`;
        expect(check(x), at).toMatchObject({ verdict: "pass", checked: 1 });
        right++;
        const reason = endingReasonOf(sport, level)!;
        const plain = generateStream({ sportKey: sport, cfg: x.cfg, stageKind: "knockout", home: A, away: B, outcome: { kind: "forfeit", by, reason, at: "after_start" } });
        const clone = (): { summary: unknown; state: Record<string, unknown> & { sanctions: { by: string; level: string }[]; phase: string } } => JSON.parse(JSON.stringify(x.d.product)) as never;
        const editState = (edit: (s: ReturnType<typeof clone>["state"]) => void): BracketDrive["product"] => { const p = clone(); edit(p.state); return p as never; };
        const other = by === "home" ? "away" : "home";
        const NOT_SHOWN = /do not show the match ended by that sanction/;
        const wrong: readonly [string, ReturnType<typeof check>, RegExp][] = [
          ["a plain win asked", check(x, { asked: { kind: "win", winner: by === "home" ? "away" : "home" } }), /not a sanction ending/],
          ["a level that ends nothing asked", check(x, { asked: { kind: "sanctionEnd", by, level: "no-such-level" } }), /ends nothing/],
          ["the product forfeited it as a PLAIN forfeit (no sanction on its record)", check(x, { product: productOf(sportModule(sport), x.cfg, A, B, plain) }), NOT_SHOWN],
          ["the stream posted is a plain forfeit (the local fold has no sanction)", check(x, {}, plain), /not the sanction's ending/],
          ["the product's state records the sanction against the OTHER side", check(x, { product: editState((s) => { s.sanctions[s.sanctions.length - 1]!.by = other; }) }), NOT_SHOWN],
          ["the product's state records no sanction at all", check(x, { product: editState((s) => { s.sanctions = []; }) }), NOT_SHOWN],
          ["the product's state is not done", check(x, { product: editState((s) => { s.phase = "live"; }) }), NOT_SHOWN],
          ["the award goes to the sanctioned side", check(x, { outcome: { kind: "award", winner: by === "home" ? A : B, loser: by === "home" ? B : A, reason } }), NOT_SHOWN],
          ["the award carries another reason", check(x, { outcome: { kind: "award", winner: by === "home" ? B : A, loser: by === "home" ? A : B, reason: reason === "retired" ? "disqualified" : "retired" } }), NOT_SHOWN],
          ["the product shows a win", check(x, { outcome: { kind: "win", winner: by === "home" ? B : A } }), NOT_SHOWN],
          ["held, not forfeited", check(x, { status: "needs_decision" }), /did not forfeit/],
          ["the product shows no outcome", check(x, { outcome: null }), /holds no outcome/],
          ["no stream was recorded", check(x, {}, []), /no stream was recorded/],
          ["the product's own /state was not recorded", check(x, { product: null }), /was not recorded/],
          ["a drive recorded with no product at all", check(((): Built => ({ ...x, d: (({ product: _p, ...rest }) => rest)(x.d) }))()), /was not recorded/],
        ];
        for (const [label, got, why] of wrong) {
          expect(got, `${at}: ${label}`).toMatchObject({ verdict: "fail", checked: 1 });
          expect(got.reason, `${at}: ${label}`).toMatch(why);
          reds++;
        }
      }
    }
    expect(right).toBeGreaterThan(0);
    expect(reds).toBe(right * 15);
    const x = built("badminton", "home", "disqualification");
    const r = new Recorder();
    expect(everyMatchEndedBySanction(r, () => x.cfg)).toMatchObject({ verdict: "fail", checked: 0 });
    // One wrong match among right ones is named; and a level that ends nothing is refused by name, not judged.
    const two = new Recorder();
    two.bracketDrives.push(x.d, { ...x.d, fixtureId: "f2", status: "decided" });
    two.streams.set("f1", x.stream);
    two.streams.set("f2", x.stream);
    expect(everyMatchEndedBySanction(two, () => x.cfg)).toMatchObject({ verdict: "fail", checked: 2 });
    expect(check(x, { asked: { kind: "sanctionEnd", by: "home", level: "warning" } })).toMatchObject({ verdict: "fail", checked: 1 });
  });

  it("the pick sanctions the side that is NOT the better seed, so the better seed advances (as every path scenario's pick does), at the level the declaration ends a match with; a sport that declares none is refused by name", () => {
    let picked = 0;
    for (const sport of sanctionSports()) {
      const level = endingLevelOf(sport);
      const pick = sanctionPick("knockout", sport);
      const row = { id: "f1" } as never;
      expect(pick(row, 1, "home", {}), sport).toEqual({ kind: "sanctionEnd", by: "away", level });
      expect(pick(row, 2, "away", {}), sport).toEqual({ kind: "sanctionEnd", by: "home", level });
      picked++;
    }
    expect(picked).toBe(sanctionSports().length);
    expect(picked).toBeGreaterThan(0);
    const none = SPORT_KEYS.find((s) => !sanctionSports().includes(s))!;
    expect(() => sanctionPick("knockout", none)({ id: "f1" } as never, 1, "home", {}), none).toThrow(W2eMisplanned);
  });
});
