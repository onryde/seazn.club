// The W1a slice: 3 template rows × 2 sports × 4 scenarios = 24
// cases, plus one league|generic canary per pilot scenario. A filter that
// names nothing in the slice is REFUSED (UnknownFilter) rather than read as
// "run zero cases" — and because the keys are static, run.ts checks a filter
// with checkSliceFilter / checkCanary before it touches the DB or the server
// (PF13).
import type { TemplateRowKey } from "./catalogue.ts";
import { SCENARIOS } from "./scenarios/index.ts";
import type { CaseSpec, ScenarioKey } from "./scenarios/types.ts";

export const SLICE_ROWS = ["league", "knockout", "swiss"] as const satisfies readonly TemplateRowKey[];
export const SLICE_SPORTS = ["generic", "badminton"] as const;
/** Every registered scenario but DENIED (⛔, Task 9), which runs only on a
 *  gated row whose org carries a deny, and PADPROOF (W1c Task 7), which runs
 *  only in --set pad-proof under --driver browser — typed out so the slice
 *  plan cannot grow either by accident. */
export type SliceScenarioKey = Exclude<ScenarioKey, "DENIED" | "PADPROOF">;
export const SCENARIO_KEYS: readonly SliceScenarioKey[] = ["LIFECYCLE", "M1", "R4", "F1"];

/** Each scenario's canary check, read from the registry: a view of Task 8's
 *  `Scenario.canaryCheck`, never a second table. null = no canary. */
export const CANARY_CHECK: Readonly<Record<SliceScenarioKey, string | null>> = Object.freeze(
  Object.fromEntries(SCENARIO_KEYS.map((k) => [k, SCENARIOS[k].canaryCheck])) as Record<SliceScenarioKey, string | null>,
);

/** A slice key, found — no cast: the key returned is the declared one. */
const sliceKey = (s: string): SliceScenarioKey | undefined => SCENARIO_KEYS.find((k) => k === s);

export class UnknownFilter extends Error {
  constructor(what: string, value: string, allowed: readonly string[]) {
    super(`slice: unknown ${what} '${value}' (allowed: ${allowed.join(", ")})`);
    this.name = "UnknownFilter";
  }
}

export interface SliceFilter { only?: string; scenario?: string }

const caseId = (row: string, sport: string, variant: string, scenario: string) => `${row}|${sport}|${variant}|${scenario}`;

const sliceCells = (): string[] => SLICE_ROWS.flatMap((row) => SLICE_SPORTS.map((sport) => `${row}|${sport}`));

/** Throws UnknownFilter for a value the slice does not hold. An empty string
 *  is a value, not "no filter". */
export function checkSliceFilter(filter: SliceFilter): void {
  const cells = sliceCells();
  if (filter.only !== undefined && !cells.includes(filter.only)) throw new UnknownFilter("--only cell", filter.only, cells);
  if (filter.scenario !== undefined && sliceKey(filter.scenario) === undefined) throw new UnknownFilter("--scenario", filter.scenario, SCENARIO_KEYS);
}

/** The scenario key a --canary value names, or UnknownFilter when that
 *  scenario has no canary check (LIFECYCLE) or does not exist. */
export function checkCanary(scenario: string): SliceScenarioKey {
  const withCanary = SCENARIO_KEYS.filter((k) => CANARY_CHECK[k] !== null);
  const key = sliceKey(scenario);
  if (key === undefined || !withCanary.includes(key)) throw new UnknownFilter("--canary", scenario, withCanary);
  return key;
}

export function planSliceCases(variantFor: (sport: string) => string, filter: SliceFilter = {}): CaseSpec[] {
  checkSliceFilter(filter);
  const out: CaseSpec[] = [];
  for (const row of SLICE_ROWS) for (const sport of SLICE_SPORTS) {
    if (filter.only !== undefined && filter.only !== `${row}|${sport}`) continue;
    const variant = variantFor(sport);
    for (const scenario of SCENARIO_KEYS) {
      if (filter.scenario !== undefined && filter.scenario !== scenario) continue;
      out.push({ caseId: caseId(row, sport, variant, scenario), row, sport, variant, scenario, canary: false });
    }
  }
  return out;
}

export function planCanaryCase(variantFor: (sport: string) => string, scenario: string): CaseSpec {
  const key = checkCanary(scenario);
  const variant = variantFor("generic");
  return { caseId: `${caseId("league", "generic", variant, key)}|canary`, row: "league", sport: "generic", variant, scenario: key, canary: true };
}
