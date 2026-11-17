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
import { placementNeedsTiers, SPONSOR_PLATFORM_FEE_PERCENT } from "@/lib/sponsor-deal-policy";

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

// Owner ruling 2026-11-16: a sponsorship paid by card carries a FIXED cut, on every plan. The number is typed in two
// places a person reads (the package list's note, in four languages, and the help article), so each is read back
// against the constant the checkout charges.
describe("the fixed sponsorship fee is the one the copy states", () => {
  it("is 5%, and is not the entry-fee rate of any self-serve paid plan", () => {
    expect(SPONSOR_PLATFORM_FEE_PERCENT).toBe(5);
  });

  it("every locale's package note and the help article quote it", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const quoted = new RegExp(`(?<![\\d.])${SPONSOR_PLATFORM_FEE_PERCENT}\\s?%`);
    let checked = 0;
    for (const locale of ["en", "fr", "es", "nl"]) {
      const ui = JSON.parse(readFileSync(join(process.cwd(), "src/dictionaries", locale, "ui.json"), "utf8")) as Record<string, string>;
      expect(ui["sponsors.pkg.onlineNote"], locale).toMatch(quoted);
      checked++;
    }
    expect(readFileSync(join(process.cwd(), "content/help/sharing/sponsors.md"), "utf8")).toMatch(quoted);
    expect(checked + 1).toBe(5);
  });

  // Owner, 2026-11-17 ("not in pricing page"): the Pricing table ticked sponsor monetization and never said what it costs.
  it("the Pricing page's sponsor-monetization note quotes it in every locale, and the row carries that note", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { buildPricingSections } = await import("@/lib/pricing-matrix");
    const quoted = new RegExp(`(?<![\\d.])${SPONSOR_PLATFORM_FEE_PERCENT}\\s?%`);
    let checked = 0;
    for (const locale of ["en", "fr", "es", "nl"]) {
      const m = JSON.parse(readFileSync(join(process.cwd(), "src/dictionaries", locale, "marketing.json"), "utf8")) as Record<string, string>;
      expect(m["pricing.matrix.sponsors.monetize.note"], locale).toMatch(quoted);
      checked++;
    }
    expect(checked).toBe(4);
    const rows = buildPricingSections({}).flatMap((sec) => sec.rows);
    const row = rows.find((r) => r.labelKey === "pricing.matrix.sponsors.monetize");
    expect(row?.noteKey).toBe("pricing.matrix.sponsors.monetize.note");
    // Only that row: the tiers row beside it makes no money claim.
    expect(rows.find((r) => r.labelKey === "pricing.matrix.sponsors.tiers")?.noteKey).toBeUndefined();
  });
});
