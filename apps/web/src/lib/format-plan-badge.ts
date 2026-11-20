import type { FormatFamily } from "@/config/format-gallery";
import type { MatrixData } from "@/lib/pricing-matrix";
import { stageNeedsAdvancedFormatsGate, stageNeedsDoubleElimGate } from "@/server/usecases/format-gates";

// The "paid plan" badge on the help format pages, read from the LIVE plan table (the same rows the pricing page reads)
// instead of the gallery's static `pro` flag. The static flag marks double elimination, page playoffs and swiss
// playoff as Pro, but `formats.double_elim` is on for Community; only the americano and ladder kinds
// (`formats.advanced`) are held back. The feature each family needs is derived from the SAME stage-kind gates the
// server enforces (usecases/format-gates.ts), so the badge cannot disagree with the 402 the builder gives.

/** The plan features the family's stage kinds need. */
export function familyFeatureKeys(family: Pick<FormatFamily, "kinds">): string[] {
  const keys = new Set<string>();
  for (const kind of family.kinds) {
    if (stageNeedsDoubleElimGate(kind)) keys.add("formats.double_elim");
    else if (stageNeedsAdvancedFormatsGate({ kind })) keys.add("formats.advanced");
  }
  return [...keys];
}

/**
 * True only when the plan table says Community does NOT have a feature the family needs. A missing row (the table could
 * not be read) shows no badge: an unknown is never presented as a paid-plan requirement.
 */
export function familyNeedsPaidPlan(family: Pick<FormatFamily, "kinds">, matrix: MatrixData): boolean {
  return familyFeatureKeys(family).some((key) => matrix[key]?.community?.bool_value === false);
}
