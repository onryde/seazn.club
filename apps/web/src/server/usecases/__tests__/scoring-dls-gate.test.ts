// Final review C-2. `assertEntitledToScore` carries a SECOND entitlement gate
// that is not part of the fidelity map: a `cricket.revise` with no manual
// umpire target, under a division whose config enables DLS, makes the fold
// compute a Duckworth-Lewis-Stern target — a Pro feature. `cricket.revise` is
// fidelity tier 1, so `requiredFeatureForEvent` returns null for it and the
// fidelity map can never express this rule; it has to be its own predicate.
//
// Extracted from scoring.ts's inline block rather than copied into the batch
// importer, so the live path and the import path cannot drift: one predicate,
// two callers. Pure (no DB) — that is the whole point of splitting it out.
import { describe, expect, it } from "vitest";
import { requiresDlsEntitlement } from "../scoring";

const DLS_ON = { dls: { enabled: true } };
const DLS_OFF = { dls: { enabled: false } };

describe("requiresDlsEntitlement (C-2)", () => {
  it("DLS enabled + NO manual target ⇒ the entitlement is required", () => {
    expect(requiresDlsEntitlement("cricket.revise", DLS_ON, {})).toBe(true);
  });

  it("DLS enabled + a manual umpire target ⇒ NOT required (an umpire's own number always works)", () => {
    expect(requiresDlsEntitlement("cricket.revise", DLS_ON, { target: 148 })).toBe(false);
    // `null` is a VALUE, not an omission — scoring.ts tests `!== undefined`, and
    // this pins that exact semantics rather than a truthiness reading of it.
    expect(requiresDlsEntitlement("cricket.revise", DLS_ON, { target: null })).toBe(false);
  });

  it("DLS disabled ⇒ NOT required, with or without a manual target", () => {
    expect(requiresDlsEntitlement("cricket.revise", DLS_OFF, {})).toBe(false);
    expect(requiresDlsEntitlement("cricket.revise", DLS_OFF, { target: 148 })).toBe(false);
  });

  it("a config that says nothing about DLS ⇒ NOT required", () => {
    expect(requiresDlsEntitlement("cricket.revise", {}, {})).toBe(false);
    expect(requiresDlsEntitlement("cricket.revise", null, {})).toBe(false);
  });

  it("any other event type ⇒ NOT required, even under a DLS-enabled config", () => {
    expect(requiresDlsEntitlement("cricket.ball", DLS_ON, {})).toBe(false);
    expect(requiresDlsEntitlement("core.start", DLS_ON, {})).toBe(false);
  });

  it("a null payload ⇒ no manual target, so a DLS-enabled revise still requires it", () => {
    expect(requiresDlsEntitlement("cricket.revise", DLS_ON, null)).toBe(true);
  });
});
