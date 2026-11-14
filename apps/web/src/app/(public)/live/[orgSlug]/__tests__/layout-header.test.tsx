// Registration redesign B2 T8 (spec §7.2) — on a phone the org header scrolls away on the register form's steps only. The mechanism is
// CSS, `:has()` on a named group: the layout root is the `site` group, the register stepper's root carries `data-register-flow`, and the
// header drops to `static` below `md` when the group contains that marker. The `:has()` match itself only happens in a browser (this
// workspace has no CSS engine), so what is pinned here is the CLASS contract on the layout side — the three tokens that must agree —
// and that the header stays sticky everywhere else (md and up, and every page without the marker: the status page, the hub).
// The marker's other side is register-page-live.test.tsx (the stepper carries it) and status-page.test.tsx (the status page does not).
// Sport: not applicable (a public org layout).
import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/font/google", () => ({
  Barlow_Condensed: () => ({ variable: "--ps-font-display", className: "" }),
}));
const getPublicOrg = vi.fn();
vi.mock("@/server/public-site/data", () => ({
  getPublicOrg: (...a: unknown[]) => getPublicOrg(...a),
}));
vi.mock("@/server/slug-resolve", () => ({ sharedRenameTarget: async () => null }));

import PublicOrgLayout from "../layout";

async function layoutHtml(): Promise<string> {
  getPublicOrg.mockResolvedValue({
    org: {
      id: "o1",
      name: "Test Org",
      slug: "test-org",
      branded: false,
      branding: {},
      logo: null,
      about: null,
      default_locale: "en",
    },
    competitions: [],
  });
  const tree = (await PublicOrgLayout({
    children: createElement("p", null, "(page)"),
    params: Promise.resolve({ orgSlug: "test-org" }),
  })) as ReactElement;
  return renderToStaticMarkup(tree);
}

/** The class tokens of the first element matching `tag` (a regex source for the opening tag's name). */
function classTokens(html: string, tag: string): string[] {
  const open = html.match(new RegExp(`<${tag}\\b[^>]*>`));
  expect(open, `no <${tag}> in the layout's markup`).not.toBeNull();
  const cls = open![0].match(/\sclass="([^"]*)"/);
  expect(cls, `<${tag}> has no class attribute`).not.toBeNull();
  return cls![1]!.split(/\s+/).filter(Boolean);
}

const SCROLL_AWAY = "max-md:group-has-[[data-register-flow]]/site:static";

describe("B2 T8 — the org header scrolls away on a phone register flow (layout side of the :has() contract)", () => {
  it("the layout root is the `site` group the header's variant names", async () => {
    const root = classTokens(await layoutHtml(), "div");
    expect(root, "the root carries group/site").toContain("group/site");
    expect(root, "still the page's own full-height column").toContain("min-h-screen");
  });

  it("the header carries the phone-only scroll-away variant, keyed on the register marker and the SAME group name", async () => {
    const header = classTokens(await layoutHtml(), "header");
    expect(header, "the scroll-away variant").toContain(SCROLL_AWAY);
    // The group the variant names is the group the root declares: a rename on one side only would match nothing, silently.
    const named = SCROLL_AWAY.match(/\/(\w+):static$/)![1];
    expect(classTokens(await layoutHtml(), "div")).toContain(`group/${named}`);
  });

  it("the header is still sticky at the top everywhere else: the base utilities are untouched, so md and up and any page without the marker keep it", async () => {
    const header = classTokens(await layoutHtml(), "header");
    expect(header).toContain("sticky");
    expect(header).toContain("top-0");
    expect(header).toContain("z-40");
    // `static` appears only behind the phone + marker variant: a bare `static` (or an md: one) would unstick it for everyone.
    const statics = header.filter((c) => /(^|:)static$/.test(c));
    expect(statics, "anti-vacuity: the one static is the scroll-away variant").toEqual([SCROLL_AWAY]);
  });
});
