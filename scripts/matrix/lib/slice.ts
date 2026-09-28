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
export const SCENARIO_KEYS: readonly ScenarioKey[] = ["LIFECYCLE", "M1", "R4", "F1"];

/** Each scenario's canary check, read from the registry: a view of Task 8's
 *  `Scenario.canaryCheck`, never a second table. null = no canary. */
export const CANARY_CHECK: Readonly<Record<ScenarioKey, string | null>> = Object.freeze(
  Object.fromEntries(SCENARIO_KEYS.map((k) => [k, SCENARIOS[k].canaryCheck])) as Record<ScenarioKey, string | null>,
);

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
  if (filter.scenario !== undefined && !SCENARIO_KEYS.includes(filter.scenario as ScenarioKey)) throw new UnknownFilter("--scenario", filter.scenario, SCENARIO_KEYS);
}

/** The scenario key a --canary value names, or UnknownFilter when that
 *  scenario has no canary check (LIFECYCLE) or does not exist. */
export function checkCanary(scenario: string): ScenarioKey {
  const withCanary = SCENARIO_KEYS.filter((k) => CANARY_CHECK[k] !== null);
  if (!withCanary.includes(scenario as ScenarioKey)) throw new UnknownFilter("--canary", scenario, withCanary);
  return scenario as ScenarioKey;
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
