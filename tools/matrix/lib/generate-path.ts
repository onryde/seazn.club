// How a browser "generate" step ended. Start quick-starts a division and, since the product made it generate stage 1's
// fixtures, a stage the driver is asked to generate may already be drawn. The product then offers no Generate on it
// (stage-card/summaries.ts stageActions: generate only on a not-started stage), so the driver reads the rail and
// names which path the step took instead of clicking a control that is not there.
//
//   live-click          the rail offered Generate and the driver clicked it;
//   generated-by-start  no Generate, the stage offers Complete (active with fixtures) and the sheet lists fixtures;
//   anything else       a StageNotGeneratable fault, never a pass (a pending stage with no Generate is a defect).
import type { CaseResultV2 } from "./results.ts";

export const GENERATE_PATHS = ["live-click", "generated-by-start"] as const;
export type GeneratePath = (typeof GENERATE_PATHS)[number];

/** What the rail showed of one stage before the driver acted. */
export interface GenerateRailSeen {
  readonly stageId: string;
  readonly generateOffered: boolean;
  /** Complete is offered only on a started stage that has fixtures (stageActions). */
  readonly completeOffered: boolean;
  readonly fixtureRows: number;
}

export class StageNotGeneratable extends Error {
  constructor(seen: GenerateRailSeen) {
    super(`browser: stage ${seen.stageId} offers no Generate and is not an active stage with fixtures (Generate offered: ${seen.generateOffered}, Complete offered: ${seen.completeOffered}, run-sheet rows: ${seen.fixtureRows}) — neither a click to make nor a stage Start already generated`);
    this.name = "StageNotGeneratable";
  }
}

/** The path a generate step takes, from what the rail showed. Throws StageNotGeneratable for any other state. */
export function classifyGenerateRail(seen: GenerateRailSeen): GeneratePath {
  if (seen.generateOffered) return "live-click";
  if (seen.completeOffered && seen.fixtureRows > 0) return "generated-by-start";
  throw new StageNotGeneratable(seen);
}

const NOTE = /^generate path: live-click=(\d+) generated-by-start=(\d+)$/;

/** The evidence line a case files its tally under (also the line the run-level check reads back). */
export function generatePathNote(live: number, start: number): string {
  return `generate path: live-click=${live} generated-by-start=${start}`;
}

/** Counts out of one evidence line, or null when the line is not a tally. */
export function parseGeneratePathNote(line: string): { live: number; start: number } | null {
  const m = NOTE.exec(line);
  return m === null ? null : { live: Number(m[1]), start: Number(m[2]) };
}

/** Every case's tally, summed. `cases` counts the cases that filed one. */
export function generatePathTotals(cases: readonly Pick<CaseResultV2, "checks">[]): { live: number; start: number; cases: number } {
  let live = 0, start = 0, filed = 0;
  for (const c of cases) {
    for (const k of c.checks) {
      if (k.id !== "mixed-driver-coverage") continue;
      for (const line of k.evidence) {
        const n = parseGeneratePathNote(line);
        if (n === null) continue;
        live += n.live; start += n.start; filed++;
      }
    }
  }
  return { live, start, cases: filed };
}
