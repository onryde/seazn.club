// Owner ruling (2026-09-21, from a screenshot of the live gallery): "Start from
// blank" moves to the FIRST cell of the grid and carries the theme's lime
// border instead of the slate dashed outline. It was last — below nine template
// cards — so the organiser whose event is not one of the named formats had to
// read the whole catalog before finding the path that fits them.
//
// Position is the assertion, so this compares INDICES in the rendered markup
// rather than checking both cards exist: source order is what the grid lays out,
// and "it is present" was already true of the shipped defect.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TemplateGallery } from "../template-gallery";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { TEMPLATE_CATALOG } from "@/server/templates/catalog";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// Real catalog entries, not lookalikes: the ordering under test is the
// production grid's, and a fixture could drift from it.
const TEMPLATES = TEMPLATE_CATALOG.slice(0, 2);

function gallery() {
  return renderToStaticMarkup(
    <DictProvider locale="en" dict={enUi as unknown as Dict}>
      <TemplateGallery
        orgSlug="org"
        templates={TEMPLATES}
        publicDashboardUpgrade={null}
        viewerPlan="community"
      />
    </DictProvider>,
  );
}

describe("TemplateGallery — Start from blank leads the grid", () => {
  it("premise: the catalog entries this test orders against actually loaded", () => {
    expect(TEMPLATE_CATALOG.length).toBeGreaterThan(1);
    expect(TEMPLATES).toHaveLength(2);
  });

  it("renders the blank card BEFORE the first template card", () => {
    const html = gallery();
    const blank = html.indexOf('data-testid="template-start-blank"');
    expect(blank, "the blank card is not rendered at all").toBeGreaterThan(-1);
    const firstTemplate = Math.min(
      ...TEMPLATES.map((t) => {
        const at = html.indexOf(`data-testid="template-card-${t.key}"`);
        expect(at, `template card ${t.key} is not rendered`).toBeGreaterThan(-1);
        return at;
      }),
    );
    expect(blank).toBeLessThan(firstTemplate);
  });

  it("carries the theme's lime treatment, not the retired slate dashed outline", () => {
    const html = gallery();
    const tag = /<button[^>]*data-testid="template-start-blank"[^>]*>/.exec(html)?.[0] ?? "";
    expect(tag).toContain("card-blank-start");
    // The old treatment, pinned as absent: a class-swap that left the dashed
    // slate border behind would look unchanged on screen.
    expect(tag).not.toContain("border-dashed");
    expect(tag).not.toContain("border-slate-300");
    expect(tag).not.toContain("hover:border-purple-300");
  });

  it("the lime comes from --mk-lime, the token the rest of the theme uses", () => {
    // Tailwind's `lime-400` is NOT this colour: globals.css's own note records
    // that v4 moved it to oklch #9ae600 while the brand token is #a3e635. A
    // utility class here would have shipped a near-miss green.
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    const rule = /\.card-blank-start\s*\{([^}]*)\}/.exec(css);
    expect(rule, ".card-blank-start has no rule in globals.css").not.toBeNull();
    expect(rule![1]).toContain("var(--mk-lime)");
  });
});
