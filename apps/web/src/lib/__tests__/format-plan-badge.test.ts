// The paid-plan badge on /help/formats and /help/formats/<family> is read from the plan table, not from the gallery's
// static `pro` flag. That flag marks double elimination, page playoffs and swiss playoff as Pro while Community has
// `formats.double_elim`; a help page that says "Pro" for a format Community can create is a false claim.
// Half the file needs no database (the decision over a given plan table); the other half reads the real plan_entitlements
// rows and checks every family against them (runs where the table exists: smoke-db in CI, a seazn-env database locally).
// Sport: not applicable (plan table, not a sport rule).
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import FormatGalleryPage from "@/app/help/formats/page";
import FormatExplainerPage from "@/app/help/formats/[family]/page";
import { FORMAT_FAMILIES, formatFamily } from "@/config/format-gallery";
import { familyFeatureKeys, familyNeedsPaidPlan } from "@/lib/format-plan-badge";
import type { MatrixData } from "@/lib/pricing-matrix";
import { sql } from "@/lib/db";
import { loadPricingMatrix } from "@/lib/pricing-matrix-server";
import { stageNeedsAdvancedFormatsGate, stageNeedsDoubleElimGate } from "@/server/usecases/format-gates";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

const cell = (b: boolean) => ({ community: { bool_value: b, int_value: null } });
const slugsWithBadge = (m: MatrixData) => FORMAT_FAMILIES.filter((f) => familyNeedsPaidPlan(f, m)).map((f) => f.slug).sort();

describe("familyNeedsPaidPlan over a given plan table (no database)", () => {
  it("a format whose Community cell is true shows no badge; a false cell shows it", () => {
    const open: MatrixData = { "formats.double_elim": cell(true), "formats.advanced": cell(false) };
    expect(slugsWithBadge(open)).toEqual(["americano", "ladder"]);
    // flipping the double-elimination cell moves exactly the families that contain a double_elim or page_playoff stage
    const closed: MatrixData = { "formats.double_elim": cell(false), "formats.advanced": cell(false) };
    expect(slugsWithBadge(closed)).toEqual(["americano", "double_elim", "ladder", "page_playoff", "swiss_playoff"]);
    const allOpen: MatrixData = { "formats.double_elim": cell(true), "formats.advanced": cell(true) };
    expect(slugsWithBadge(allOpen)).toEqual([]);
  });

  it("an unreadable plan table shows no badge (an unknown is not a requirement)", () => {
    expect(slugsWithBadge({})).toEqual([]);
    expect(slugsWithBadge({ "formats.advanced": { pro: { bool_value: true, int_value: null } } })).toEqual([]);
  });

  it("the features a family needs come from the server's own stage-kind gates", () => {
    let checked = 0;
    for (const f of FORMAT_FAMILIES) {
      const expected = new Set<string>();
      for (const kind of f.kinds) {
        if (stageNeedsDoubleElimGate(kind)) expected.add("formats.double_elim");
        else if (stageNeedsAdvancedFormatsGate({ kind })) expected.add("formats.advanced");
      }
      expect(new Set(familyFeatureKeys(f)), f.slug).toEqual(expected);
      checked += 1;
    }
    expect(checked, "anti-vacuity: families checked").toBe(FORMAT_FAMILIES.length);
    expect(formatFamily("swiss_playoff")!.kinds).toContain("page_playoff");
  });
});

describe.skipIf(!HAS_DB)("the badge agrees with the real plan_entitlements rows", () => {
  it("every family: badge iff a needed feature is OFF for Community in the table", async () => {
    const rows = await sql<{ feature_key: string; bool_value: boolean | null }[]>`
      select feature_key, bool_value from plan_entitlements
      where plan_key = 'community' and feature_key in ('formats.double_elim', 'formats.advanced')`;
    const community = new Map(rows.map((r) => [r.feature_key, r.bool_value]));
    expect(community.size, "both format features have a Community row").toBe(2);
    const matrix = await loadPricingMatrix();
    let badged = 0;
    let unbadged = 0;
    for (const f of FORMAT_FAMILIES) {
      const needs = f.kinds.some((kind) =>
        stageNeedsDoubleElimGate(kind)
          ? community.get("formats.double_elim") === false
          : stageNeedsAdvancedFormatsGate({ kind })
            ? community.get("formats.advanced") === false
            : false,
      );
      expect(familyNeedsPaidPlan(f, matrix), f.slug).toBe(needs);
      if (needs) badged += 1;
      else unbadged += 1;
    }
    expect(badged + unbadged, "anti-vacuity: families checked").toBe(FORMAT_FAMILIES.length);
    // the table today: Community has double elimination, not the advanced layer
    expect(unbadged, "at least one family needs no paid plan").toBeGreaterThan(0);
    expect(badged, "at least one family does").toBeGreaterThan(0);
  });

  // The seam: the badge decision is only worth anything if the two help pages read it. Render the REAL pages against the
  // real table and count what a reader sees.
  it("the rendered pages show the badge exactly where the table says, and nowhere else", async () => {
    const matrix = await loadPricingMatrix();
    const expectedBadged = FORMAT_FAMILIES.filter((f) => familyNeedsPaidPlan(f, matrix)).map((f) => f.slug);
    expect(expectedBadged.length, "anti-vacuity: some family is badged").toBeGreaterThan(0);
    const overview = renderToStaticMarkup((await FormatGalleryPage()) as ReactElement);
    expect(overview.match(/>Paid plan</g)?.length ?? 0).toBe(expectedBadged.length);
    let pages = 0;
    for (const f of FORMAT_FAMILIES) {
      const html = renderToStaticMarkup((await FormatExplainerPage({ params: Promise.resolve({ family: f.slug }) })) as ReactElement);
      expect(html.includes(">Paid plan<"), f.slug).toBe(expectedBadged.includes(f.slug));
      pages += 1;
    }
    expect(pages, "anti-vacuity: family pages rendered").toBe(FORMAT_FAMILIES.length);
  });
});
