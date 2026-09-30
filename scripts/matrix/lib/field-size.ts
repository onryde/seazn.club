// Folded in beneath ruling 49: the field a scripted scenario seeds is the
// FORMAT's, not a fixed 8. A page playoff takes exactly 4
// (packages/engine/src/scheduling/bracket.ts generatePagePlayoff:
// "page playoffs need exactly 4 entrants"), so an odd field (F1) is unfit
// there — dropped in applicability, and refused here if ever asked.
import type { RowKey } from "./catalogue.ts";
import type { ScenarioKey } from "./scenarios/types.ts";

export const PAGE_PLAYOFF_FIELD = 4;
export const DEFAULT_FIELD = 8;
export const ODD_FIELD = 7;
const FIXED: Readonly<Partial<Record<RowKey, number>>> = Object.freeze({ page_playoff_only: PAGE_PLAYOFF_FIELD });

export class NoFieldSize extends Error {
  readonly row: string;
  readonly scenario: string;
  constructor(row: string, scenario: string, why: string) {
    super(`field-size: no field for ${row} × ${scenario} — ${why}`);
    this.name = "NoFieldSize";
    this.row = row;
    this.scenario = scenario;
  }
}

export function fieldSizeFor(row: RowKey, scenario: ScenarioKey): number {
  const fixed = Object.prototype.hasOwnProperty.call(FIXED, row) ? FIXED[row]! : null;
  switch (scenario) {
    case "LIFECYCLE": case "M1": case "R4": return fixed ?? DEFAULT_FIELD;
    case "F1":
      if (fixed !== null) throw new NoFieldSize(row, scenario, `an odd field is impossible on a fixed ${fixed}-seat format (unfit; drop-list F1)`);
      return ODD_FIELD;
    default: throw new NoFieldSize(row, scenario, "this scenario seeds its own field");
  }
}
