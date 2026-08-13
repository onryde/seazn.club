import "server-only";
// Shared stage-format entitlement gates (doc 10 §1, Jul3/08 §8) — the single
// definition of "does this stage kind/config need formats.double_elim /
// formats.advanced". Split out of usecases/stages.ts because `withTenant`
// does not nest (lib/db.ts's pool-nesting guard forbids it): createFromTemplate
// (usecases/templates.ts, D1a) opens its OWN transaction and cannot call
// createStages to reuse its gate, so the gate condition itself has to be the
// shared unit instead of the usecase that used to own it exclusively.
//
// A P4 portfolio review (2026-08-13) found the template path had silently
// forked its own byte-copy of this exact condition (templates.ts's
// `stageNeedsAdvancedFormatsGate`, hand-typed against stages.ts's inline
// `.some()` check) — "byte-identical today, locked by no test," the review
// called it: the same placer/verifier fork this repo keeps paying for
// elsewhere. If either condition ever needs to change, there is now exactly
// one place to change it, and both createStages and createFromTemplate stay
// in sync by construction.

export interface StageFormatGateInput {
  kind: string;
  // Real `stages.config` (and TemplateStage.config) is jsonb and carries far
  // more than the three keys this gate reads — points, groups,
  // scheduleDefaults, thirdPlace, sport-specific extras, … — so it is typed
  // as the open record it actually is, not narrowed to only the keys this
  // function happens to read. A narrower object type here (previously
  // `{byes?; cross_feeds?; placements?}`) compiled fine at both real call
  // sites, which pass a pre-typed VARIABLE (plain assignability, no excess-
  // property check) — but failed tsc the moment a test passed an object
  // LITERAL carrying any other real config key (knockout's `thirdPlace`):
  // TS's excess-property check only fires on literals, so the narrowness
  // was invisible until a test exercised it. `apps/web` typecheck must be
  // run for real after touching this file — vitest strips types and cannot
  // catch this class of error.
  config?: Record<string, unknown> | undefined;
}

/** Doc 10 §1: `formats.double_elim` is Pro. */
export function stageNeedsDoubleElimGate(kind: string): boolean {
  return kind === "double_elim" || kind === "page_playoff";
}

/** Jul3/08 §8: new kinds + custom byes + cross-stage feeds + placements are
 *  the advanced-formats Pro layer; basic RR/KO/group+KO stays Community. */
export function stageNeedsAdvancedFormatsGate(stage: StageFormatGateInput): boolean {
  return (
    stage.kind === "americano" ||
    stage.kind === "ladder" ||
    stage.config?.byes !== undefined ||
    stage.config?.cross_feeds !== undefined ||
    stage.config?.placements !== undefined
  );
}
