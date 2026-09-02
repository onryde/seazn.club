// R8/WS-H — the pin that keeps the accessibility sweep TOTAL.
//
// `e2e/scorepad-v3-a11y-sweep.spec.ts` runs the WCAG AA contrast scan and the
// 44px hit-target sweep over every v3 skin, driven by `e2e/v3-skin-catalog.ts`.
// Nothing about a Playwright spec can notice that a twelfth sport was added to
// `V3_SKINS` and never added to that catalog: the sweep would simply keep
// passing over eleven sports and the new one would ship with ZERO a11y
// coverage — which is precisely how badminton, table tennis, boardgame, carrom
// and hockey went uncovered until R8, each one added to the registry by a wave
// that had no reason to think about a hand-written list in a different file.
//
// This file is that reason. It is the same shape as `registry-totality.test.ts`
// beside it (pure, no DB, no browser, so it runs in every job and cannot
// self-skip), and it fails in BOTH directions: a registry key with no catalog
// entry, and a catalog entry naming a sport the registry does not own (a typo,
// or a sport that was later removed).
//
// It deliberately imports the catalog MODULE rather than scanning the spec's
// source text. A regex over TypeScript source is the other way this could have
// been written and it is a worse one: comment prose in this repo has already
// poisoned a naive code-literal scan once, and a scan that silently matches
// nothing reports the same green as a scan that matched everything.
import { describe, expect, it } from "vitest";
import { V3_SKINS } from "../registry";
import { V3_SKIN_CASES, V3_SKIN_CASE_KEYS } from "../../../../../../e2e/v3-skin-catalog";

describe("R8/WS-H — the a11y sweep covers every v3 skin", () => {
  it("names exactly the sports V3_SKINS owns, no more and no fewer", () => {
    // Sorted on both sides: the catalog and the registry are each maintained
    // alphabetically, but this assertion is about the SET, not the order — a
    // future re-order of either must not red this test.
    expect([...V3_SKIN_CASE_KEYS].sort()).toEqual(Object.keys(V3_SKINS).sort());
  });

  it("gives every case a real variant, an entrant kind and a non-empty roster on both sides", () => {
    for (const c of V3_SKIN_CASES) {
      expect(c.variantKey, `${c.key}: variantKey`).toMatch(/^[a-z0-9-]+$/);
      expect(["individual", "team", "pair"], `${c.key}: entrantKind`).toContain(c.entrantKind);
      // Both sides always get a lineup, never just the one under test:
      // football's `applyGoal` rejects a scorer who is not on the pitch, so a
      // one-sided roster fails at the SETUP and reads as a pad bug.
      expect(c.home.length, `${c.key}: home roster`).toBeGreaterThan(0);
      expect(c.away.length, `${c.key}: away roster`).toBeGreaterThan(0);
      expect(c.note.length, `${c.key}: note`).toBeGreaterThan(0);
    }
  });

  it("declares each sport exactly once", () => {
    expect(new Set(V3_SKIN_CASE_KEYS).size).toBe(V3_SKIN_CASE_KEYS.length);
  });
});
