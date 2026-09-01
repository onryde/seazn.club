// RS011 review round 3, finding 5: `EligibilityOverrideDialog` now composes
// `ConfirmDialog` instead of re-implementing its shell — the one behaviour
// that composition had to preserve EXACTLY is the reason-LENGTH gate
// (`ConfirmDialog`'s own `typedName`/`isConfirmArmed` armed-check is an
// exact-string type-to-confirm rule and cannot express "3-500 characters",
// which is why `ConfirmDialog` gained the new `confirmDisabled` override
// prop). This proves EligibilityOverrideDialog computes ITS OWN armed state
// from the typed reason and hands it to `ConfirmDialog` correctly — below
// 3 chars stays disabled, 3-500 arms, and Confirm/Cancel still resolve to
// the right callbacks with the right argument. The real DOM-level
// `disabled` attribute (ConfirmDialog's own responsibility, unchanged by
// this fix) is covered end to end by `e2e/walkthrough/
// rs011-eligibility-gates.spec.ts`'s `getByTestId("eligibility-override-
// confirm")` assertions.
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { EligibilityOverrideDialog } from "@/components/v2/eligibility-override-dialog";
import { ConfirmDialog } from "@/components/v2/confirm-dialog";
import type { EligibilityIssue } from "@/lib/registration-rules";

const VIOLATIONS: EligibilityIssue[] = [
  { code: "AGE_TOO_OLD", message: "Too old for this division.", playerIndex: 1, playerName: "Vet Player" },
];

function findConfirmDialog(tree: ReturnType<ReturnType<typeof renderIsland>["tree"]>) {
  const el = tree.find((e) => e.type === ConfirmDialog);
  if (!el) throw new Error("composed ConfirmDialog element not found");
  return el;
}

function findReasonTextarea(tree: ReturnType<ReturnType<typeof renderIsland>["tree"]>) {
  const el = tree.find((e) => propsOf(e)["data-testid"] === "eligibility-override-reason");
  if (!el) throw new Error("reason textarea not found");
  return el;
}

describe("EligibilityOverrideDialog — the composed ConfirmDialog stays gated by the reason-LENGTH rule, not ConfirmDialog's own typedName check (RS011 review round 3, finding 5)", () => {
  it("confirmDisabled starts true with no reason, stays true below 3 chars, and flips false at 3+", () => {
    const onConfirm = vi.fn();
    const island = renderIsland(EligibilityOverrideDialog, {
      open: true,
      violations: VIOLATIONS,
      onCancel: () => {},
      onConfirm,
    });

    expect(propsOf(findConfirmDialog(island.tree())).confirmDisabled).toBe(true);
    // ConfirmDialog's OWN typedName check must stay unused here — this
    // dialog has no type-to-confirm field, only the reason textarea.
    expect(propsOf(findConfirmDialog(island.tree())).typedName).toBeUndefined();

    (propsOf(findReasonTextarea(island.tree())).onChange as (e: unknown) => void)({
      target: { value: "ab" },
    });
    expect(propsOf(findConfirmDialog(island.tree())).confirmDisabled).toBe(true); // 2 chars

    (propsOf(findReasonTextarea(island.tree())).onChange as (e: unknown) => void)({
      target: { value: "Wildcard entry, organiser approved" },
    });
    expect(propsOf(findConfirmDialog(island.tree())).confirmDisabled).toBe(false);

    (propsOf(findConfirmDialog(island.tree())).onConfirm as () => void)();
    expect(onConfirm).toHaveBeenCalledWith("Wildcard entry, organiser approved");
  });

  it("passes onCancel straight through, unaffected by the reason's length", () => {
    const onCancel = vi.fn();
    const island = renderIsland(EligibilityOverrideDialog, {
      open: true,
      violations: VIOLATIONS,
      onCancel,
      onConfirm: vi.fn(),
    });
    (propsOf(findConfirmDialog(island.tree())).onCancel as () => void)();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("busy passes straight through to ConfirmDialog", () => {
    const island = renderIsland(EligibilityOverrideDialog, {
      open: true,
      violations: VIOLATIONS,
      busy: true,
      onCancel: () => {},
      onConfirm: () => {},
    });
    expect(propsOf(findConfirmDialog(island.tree())).busy).toBe(true);
  });
});
