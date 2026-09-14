// The embeddable widgets render the SAME components as the /shared public
// tree, and those components ask for the display face through
// `font-display` -> `var(--ps-font-display, var(--font-geist-sans))`
// (globals.css, `@theme inline`, so the var is resolved on the element, not at
// :root). Only the /shared org layout used to set `--ps-font-display`, so an
// embedded widget fell back to the body sans — which is how the schedule
// widget's fixed 52px rail ended up painting "Finalizado" / "Afgelopen" /
// "déterminer" over the entrant name (spectator N1f f1, review-n1e I1).
//
// The two layouts must therefore mount the SAME face: the widths
// `components/public-site/__tests__/schedule-rail-fits.test.ts` proves are
// safe are Barlow Condensed SemiBold's, and they only hold if both surfaces
// really load it. This test reads the options each layout passes, so it
// witnesses the real arguments rather than a name repeated here.
import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// next/font/google needs the Next build pipeline; both layouts use only the
// CSS-variable name it returns. The mock echoes the options back so the
// assertions below are about what the layout ASKED for.
const { fontCalls } = vi.hoisted(() => ({ fontCalls: [] as Record<string, unknown>[] }));
vi.mock("next/font/google", () => ({
  Barlow_Condensed: (opts: Record<string, unknown>) => {
    fontCalls.push(opts);
    return { variable: String(opts.variable), className: "" };
  },
}));
vi.mock("@/server/public-site/data", () => ({ getPublicOrg: vi.fn() }));
vi.mock("@/server/slug-resolve", () => ({ sharedRenameTarget: async () => null }));

import EmbedLayout from "../layout";
// Imported for its module-scope font call only — the /shared org layout is the
// surface the embed has to match.
import "../../(public)/shared/[orgSlug]/layout";

const embedHtml = (): string =>
  renderToStaticMarkup(
    EmbedLayout({ children: createElement("p", null, "(widget)") }) as ReactElement,
  );

describe("/embed mounts the public tree's display face (N1f f1)", () => {
  it("puts --ps-font-display on the wrapper the widgets render inside", () => {
    const html = embedHtml();
    expect(html).toContain("--ps-font-display");
    // Anti-vacuity: the variable is on the element that WRAPS the widget, so
    // the cascade reaches the scorebug rail inside it.
    const wrapper = /<div class="([^"]*)">/.exec(html);
    expect(wrapper?.[1]).toContain("--ps-font-display");
    expect(html.indexOf("--ps-font-display")).toBeLessThan(html.indexOf("(widget)"));
  });

  it("asks for the same face as the /shared org layout, weight 600 included", () => {
    expect(fontCalls.length).toBe(2);
    // The rail's status line is `font-semibold`; a layout that mounted only
    // 500/700 would paint it in a synthesised or substituted weight, and the
    // measured widths would not be the ones that shipped.
    for (const call of fontCalls) {
      expect(call.variable).toBe("--ps-font-display");
      expect(call.weight).toContain("600");
    }
    expect(fontCalls[0]).toEqual(fontCalls[1]);
  });
});
