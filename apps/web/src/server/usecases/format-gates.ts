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
  config?: { byes?: unknown; cross_feeds?: unknown; placements?: unknown } | undefined;
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
