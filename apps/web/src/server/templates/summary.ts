// Pure display helpers for the wizard gallery card + detail sheet. NOT
// server-only — same client-safe reasoning as schema.ts/catalog.ts.
import type { CompetitionTemplate } from "./schema";

export function templateEntrantTotal(template: CompetitionTemplate): number {
  return template.divisions.reduce((sum, division) => sum + division.entrantCount, 0);
}

/** Every stage kind across every division, in catalog order — the gallery
 *  card's structure line and the detail sheet's FormatDiagram lookup
 *  (config/format-gallery.tsx's familyForKind) both read this. */
export function templateStageKinds(template: CompetitionTemplate): string[] {
  return template.divisions.flatMap((division) => division.stages.map((stage) => stage.kind));
}
