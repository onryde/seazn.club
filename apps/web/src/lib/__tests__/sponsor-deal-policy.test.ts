// Sponsor deals, Task 3: the ONE placement rule (plan 2026-11-07-sponsor-deals D17, preflight F14; spec §10 Q1,
// owner-confirmed 2026-11-07 "Ok"). Sponsors, packages and deals all read `placementNeedsTiers`; a later change of the
// owner's answer changes that function and this test, and nothing else.
//
// The expected answers are typed from spec §10 Q1 and §8 ("on the community plan every deal is Partner"; "tiers stay
// gated by `sponsors.tiers` as today", and today's gate also gates competition scoping, §2 premise 2), never read back
// from lib/sponsor-deal-policy.ts: the ONLY placement that needs no `sponsors.tiers` is a partner placement on the whole
// org. The tier axis is swept from the tier authority (SPONSOR_TIERS), so a fifth tier is judged here the moment it
// exists. Every sweep counts what it checked, and zero checked is a failure.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SPONSOR_TIERS } from "@/lib/sponsor-tiers";
import { placementNeedsTiers } from "@/lib/sponsor-deal-policy";

/** Spec §10 Q1: the placements a club places with no `sponsors.tiers`. One pair: partner, whole org (scope null). */
const FREE_PLACEMENTS: ReadonlyArray<readonly [string, string | null]> = [["partner", null]];
const COMPETITION = "6f1c2d4e-8a9b-4c3d-9e2f-1a2b3c4d5e6f";

describe("placementNeedsTiers — spec §10 Q1 (one predicate for sponsors, packages and deals)", () => {
  it("answers false ONLY for a partner placement on the whole org (SPONSOR_TIERS × {null, a competition}: 8 checked)", () => {
    let checked = 0;
    let free = 0;
    for (const tier of SPONSOR_TIERS) {
      for (const scope of [null, COMPETITION] as const) {
        const expected = !FREE_PLACEMENTS.some(([t, s]) => t === tier && s === scope);
        expect(placementNeedsTiers(tier, scope), `${tier} on ${scope ?? "the whole org"}`).toBe(expected);
        if (!expected) free++;
        checked++;
      }
    }
    expect(checked, "placements checked").toBe(8);
    // The spec's one free placement was actually met in the sweep (a sweep that never reached it proves nothing).
    expect(free, "free placements met").toBe(1);
  });

  it("a competition scope alone needs tiers, even for partner (community deals are org-wide, §2 premise 2)", () => {
    expect(placementNeedsTiers("partner", COMPETITION)).toBe(true);
    expect(placementNeedsTiers("partner", null)).toBe(false);
  });

  it("is client-safe: it imports only the tier authority (imports checked reported, 0 ⇒ fail)", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "sponsor-deal-policy.ts"), "utf8");
    expect(src.length, "read the module").toBeGreaterThan(0);
    const specifiers = [...src.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
    expect(specifiers.length, "imports checked").toBeGreaterThan(0);
    for (const s of specifiers) expect(["./sponsor-tiers", "@/lib/sponsor-tiers"], s).toContain(s);
    expect(src).not.toMatch(/^\s*import\s+["']/m);
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).not.toMatch(/\bimport\(/);
    expect(src).not.toMatch(/["']server-only["']/);
  });
});
