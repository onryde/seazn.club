// Folded in beneath ruling 49: the field a scripted scenario seeds is the
// FORMAT's, not a fixed 8. A page playoff takes exactly 4
// (packages/engine/src/scheduling/bracket.ts generatePagePlayoff:
// "page playoffs need exactly 4 entrants"), so an odd field (F1) is unfit
// there — dropped in applicability, and refused here if ever asked.
//
// Carry m2-1 (W1-driving Task 13): "a lone page playoff" has ONE authority,
// isLonePagePlayoff over the row's catalogue bodies (stagesForRow) —
// applicability's F1 drop reads the same predicate — never a row name.
//
// D11 (W1-driving Task 13): a case on a catalog template seeds the template's
// own entrantCount, read from its JSON (lib/templates.ts) — never a typed 16.
import { stagesForRow, type RowKey } from "./catalogue.ts";
import type { ScenarioKey } from "./scenarios/types.ts";
import { templateField, templateRow } from "./templates.ts";

export const PAGE_PLAYOFF_FIELD = 4;
export const DEFAULT_FIELD = 8;
export const ODD_FIELD = 7;

/** One page-playoff stage: the engine's fixed 4-seat shape. */
export function isLonePagePlayoff(stages: readonly { readonly kind: string }[]): boolean {
  return stages.length === 1 && stages[0].kind === "page_playoff";
}

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

/** The field `scenario` seeds on `row`; with `template`, the template's own (D11). */
export function fieldSizeFor(row: RowKey, scenario: ScenarioKey, template?: string): number {
  if (template !== undefined) return templateFieldSize(row, scenario, template);
  const fixed = isLonePagePlayoff(stagesForRow(row)) ? PAGE_PLAYOFF_FIELD : null;
  switch (scenario) {
    case "LIFECYCLE": case "M1": case "R4": return fixed ?? DEFAULT_FIELD;
    case "F1":
      if (fixed !== null) throw new NoFieldSize(row, scenario, `an odd field is impossible on a fixed ${fixed}-seat format (unfit; drop-list F1)`);
      return ODD_FIELD;
    default: throw new NoFieldSize(row, scenario, "this scenario seeds its own field");
  }
}

function templateFieldSize(row: RowKey, scenario: ScenarioKey, template: string): number {
  // templateRow refuses an unknown key and a drifted template by name.
  const builds = templateRow(template);
  if (builds !== row) throw new NoFieldSize(row, scenario, `catalog template ${template} builds ${builds}, not ${row}`);
  const { entrantCount } = templateField(template);
  switch (scenario) {
    case "LIFECYCLE": case "M1": case "R4": return entrantCount;
    case "F1": throw new NoFieldSize(row, scenario, `catalog template ${template} seeds its own ${entrantCount}; an odd field is not the template's`);
    default: throw new NoFieldSize(row, scenario, "this scenario seeds its own field");
  }
}
