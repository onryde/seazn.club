// Plan display names. The billing page rendered the raw `plan_key` under a CSS
// `capitalize`, so a Pro Plus org's Current plan card read "Pro_plus"; the
// cancel dialog and the resume button said "Pro" to that same subscriber, and
// "Keep Pro" actually restored Pro Plus.
import { describe, expect, it } from "vitest";
import { planLabel } from "@/lib/plan-label";

describe("planLabel", () => {
  it("spells the paid plans the way the product does", () => {
    expect(planLabel("pro")).toBe("Pro");
    expect(planLabel("community")).toBe("Community");
    // Entitlements v18 (V392): the above-Pro, Contact-us-only plan.
    expect(planLabel("enterprise")).toBe("Enterprise");
  });

  it("never leaks a raw key: an unmapped plan is title-cased, not shown as-is", () => {
    expect(planLabel("pro_ultra")).toBe("Pro Ultra");
    // pro_plus is retired (V392) and no longer a `LABELS` entry, but a stale
    // client or historical row naming it must still read as a plan name,
    // never raw snake_case — this is the total-over-PlanKey fallback doing
    // its job for a key that used to be mapped and no longer is.
    expect(planLabel("pro_plus")).toBe("Pro Plus");
  });

  it("treats a missing plan as Community — a row with no subscription is free", () => {
    expect(planLabel(null)).toBe("Community");
    expect(planLabel(undefined)).toBe("Community");
    expect(planLabel("")).toBe("Community");
  });

  // CSS `capitalize` is what produced "Pro_plus"; it also cannot fix it, since
  // it only touches the first letter of a whitespace-delimited word.
  it("produces a label that needs no CSS capitalize to read correctly", () => {
    expect(planLabel("pro_plus")).not.toContain("_");
  });
});
