// Pure display helpers for the wizard gallery card + detail sheet. NOT
// server-only — same client-safe reasoning as schema.ts/catalog.ts.
import type { CompetitionTemplate } from "./schema";

export function templateEntrantTotal(template: CompetitionTemplate): number {
  return template.divisions.reduce((sum, division) => sum + division.entrantCount, 0);
}

/** Every stage kind across every division, in catalog order. No production
 *  caller as of P7/D1b T7: the gallery card's structure line (its last
 *  consumer) now composes template-gallery.tsx's templateStructureChain
 *  directly instead, so the card shares ONE kind-vs-own-name disambiguation
 *  implementation with the detail sheet's Structure line rather than a
 *  second, independently-drifting one. Kept for its own direct unit test
 *  below (a repo-wide grep found no other caller, production or test). */
export function templateStageKinds(template: CompetitionTemplate): string[] {
  return template.divisions.flatMap((division) => division.stages.map((stage) => stage.kind));
}
