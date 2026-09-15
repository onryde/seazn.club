// K-1 (2026-09-15): the kiosk's org layout is BARE. The /present board must span
// a TV, so this layout carries none of the chrome layout's header, <main
// max-w-5xl> or footer, while keeping what the board needs from the org tree:
// the org door (404 / renamed redirect), the display face and the org palette.
//
// Called with its data door mocked and rendered to static markup, the same way
// `[orgSlug]/__tests__/layout-copy.test.tsx` renders the chrome layout; the two
// are rendered side by side so "the same palette" is a comparison, not a typed
// expectation.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/font/google", () => ({
  Barlow_Condensed: () => ({ variable: "(display-font-variable)", className: "" }),
}));
const getPublicOrg = vi.fn();
vi.mock("@/server/public-site/data", () => ({
  getPublicOrg: (...a: unknown[]) => getPublicOrg(...a),
}));
const sharedRenameTarget = vi.fn();
vi.mock("@/server/slug-resolve", () => ({
  sharedRenameTarget: (...a: unknown[]) => sharedRenameTarget(...a),
}));

import KioskOrgLayout from "../layout";
import ChromeOrgLayout from "../../../[orgSlug]/layout";

const ORG = {
  id: "o1",
  name: "Test Org",
  slug: "test-org",
  branded: false,
  // `{ colors: { primary } }` is the shape publicBrandColor reads; teal holds white ink.
  branding: { colors: { primary: "#0f766e" } },
  logo: null,
  about: null,
  default_locale: "en",
};
const CHILD = createElement("p", { "data-probe": "board" }, "(the board)");
const params = (orgSlug = "test-org") => Promise.resolve({ orgSlug });

async function render(layout: typeof KioskOrgLayout, orgSlug?: string): Promise<string> {
  return renderToStaticMarkup((await layout({ children: CHILD, params: params(orgSlug) })) as ReactElement);
}
const rootTag = (html: string) => /^<div\b[^>]*>/.exec(html)?.[0] ?? "";
const classesOf = (tag: string) => new Set((/\bclass="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/).filter(Boolean));
const styleOf = (tag: string) => /\bstyle="([^"]*)"/.exec(tag)?.[1] ?? null;

beforeEach(() => {
  getPublicOrg.mockReset();
  sharedRenameTarget.mockReset();
  getPublicOrg.mockResolvedValue({ org: ORG, competitions: [] });
  sharedRenameTarget.mockResolvedValue(null);
});

describe("(kiosk)/[orgSlug]/layout — the /present board's bare org layout", () => {
  it("renders the board and none of the org chrome: no header, no main, no footer, no max-w-5xl box", async () => {
    const html = await render(KioskOrgLayout);
    expect(html).toContain('data-probe="board"');
    for (const tag of ["<header", "<main", "<footer"]) expect(html, tag).not.toContain(tag);
    expect(html).not.toContain("max-w-5xl");
    // The positive pair: the chrome layout, handed the same child, has all of it.
    const chrome = await render(ChromeOrgLayout);
    for (const tag of ["<header", "<main", "<footer"]) expect(chrome, tag).toContain(tag);
    expect(chrome).toContain("max-w-5xl");
  });

  it("mounts the display face and the canvas on a full-height root, with the same org palette as the chrome layout", async () => {
    const root = rootTag(await render(KioskOrgLayout));
    const classes = classesOf(root);
    expect(classes.has("(display-font-variable)"), "the display face variable").toBe(true);
    expect(classes.has("min-h-screen")).toBe(true);
    expect(classes.has("bg-canvas")).toBe(true);
    const chromeStyle = styleOf(rootTag(await render(ChromeOrgLayout)));
    expect(chromeStyle, "the chrome layout themes its root").toBeTruthy();
    expect(styleOf(root)).toBe(chromeStyle);
  });

  it("is the same org door as the chrome layout: a missing org 404s, and neither layout renders", async () => {
    getPublicOrg.mockResolvedValue(null);
    await expect(render(KioskOrgLayout, "no-such-org")).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    await expect(render(ChromeOrgLayout, "no-such-org")).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    expect(getPublicOrg).toHaveBeenCalledWith("no-such-org");
  });

  it("a renamed org's old slug redirects permanently from the kiosk too", async () => {
    getPublicOrg.mockResolvedValue(null);
    sharedRenameTarget.mockResolvedValue("/shared/new-slug");
    await expect(render(KioskOrgLayout, "old-slug")).rejects.toThrow(/NEXT_REDIRECT/);
    expect(sharedRenameTarget).toHaveBeenCalledWith("old-slug");
  });
});
