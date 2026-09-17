// `<html lang>` on a /shared page is the ORG's locale.
//
// The static root layout (`app/layout.tsx`) renders `lang="en"` for every
// route, and it is the only layout that renders `<html>` at all, so no nested
// layout can change the SERVER-rendered attribute; the root's own `<HtmlLang />`
// corrects it after hydration from the visitor's `seazn_locale` cookie, which
// a spectator reading a Spanish club's page has no reason to hold. A Spanish
// org's page therefore read `lang="en"` to a screen reader and a translator
// extension alike. Every /shared page is in the org's language (ISR: never the
// visitor's), and both /shared layouts already know that language, so each
// hands it to `<HtmlLang lang>` — the authoritative form of the same client
// correction `[lang]/(marketing)` and the organiser shell (`<DictProvider>`)
// already use.
//
// What this cannot change, stated rather than implied: the attribute in the
// SERVER HTML stays "en" until hydration. Closing that means a root layout
// that is not static for every route (the root owns `<html>`), which is a
// design decision for the whole app, not for this tree.
//
// Two halves: each layout MOUNTS `HtmlLang` with the org's locale (the prop at
// the tree boundary, en and es both, so a layout that hard-coded either one
// reds), and that element, driven through its effect, WRITES the attribute.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { HtmlLang } from "@/components/i18n/html-lang";

vi.mock("next/font/google", () => ({
  Barlow_Condensed: () => ({ variable: "--ps-font-display", className: "" }),
}));
const getPublicOrg = vi.fn();
vi.mock("@/server/public-site/data", () => ({
  getPublicOrg: (...a: unknown[]) => getPublicOrg(...a),
}));
vi.mock("@/server/slug-resolve", () => ({ sharedRenameTarget: async () => null }));
// The client-side route the element reads; a test moves it to navigate.
const nav = vi.hoisted(() => ({ pathname: "/shared/test-org" }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => nav.pathname,
}));

import PublicOrgLayout from "../layout";
import KioskOrgLayout from "../../(kiosk)/[orgSlug]/layout";

const org = (locale: string) => ({
  id: "o1",
  name: "Test Org",
  slug: "test-org",
  branded: false,
  branding: {},
  logo: null,
  about: null,
  default_locale: locale,
  card_payments: false,
});

const LAYOUTS = {
  "chrome layout ([orgSlug]/layout.tsx)": PublicOrgLayout,
  "kiosk layout ((kiosk)/[orgSlug]/layout.tsx)": KioskOrgLayout,
} as const;

async function tree(Layout: (typeof LAYOUTS)[keyof typeof LAYOUTS], locale: string) {
  getPublicOrg.mockResolvedValue({ org: org(locale), competitions: [] });
  return walk(
    (await Layout({
      children: createElement("p", null, "(page)"),
      params: Promise.resolve({ orgSlug: "test-org" }),
    })) as ReactElement,
  );
}

const htmlLangs = (els: ReactElement[]) => els.filter((el) => el.type === HtmlLang);

afterEach(() => {
  vi.unstubAllGlobals();
});

for (const [name, Layout] of Object.entries(LAYOUTS)) {
  describe(`${name} — <html lang> is the org's locale`, () => {
    it.each([
      ["es", "es"],
      ["en", "en"],
      ["nl", "nl"],
    ])("an org whose default_locale is %s mounts HtmlLang lang=%s, once", async (locale, expected) => {
      const found = htmlLangs(await tree(Layout, locale));
      expect(found).toHaveLength(1);
      expect((found[0]!.props as { lang?: string }).lang).toBe(expected);
    });

    it("an org with a locale this app does not ship is written as the default, never passed through", async () => {
      const [el] = htmlLangs(await tree(Layout, "xx"));
      expect((el!.props as { lang?: string }).lang).toBe("en");
    });

    it.each([
      ["es", "en"],
      ["en", "fr"],
    ])("mounted, the %s org's element rewrites a document that read %s", async (locale, before) => {
      const [el] = htmlLangs(await tree(Layout, locale));
      const documentElement = { lang: before };
      // No DOM under vitest here: the effect's one read and one write, stubbed.
      vi.stubGlobal("document", { documentElement, cookie: `seazn_locale=${before}` });
      const island = renderIsland(HtmlLang, el!.props as { lang?: string });
      expect(documentElement.lang).toBe(locale);
      island.unmount();
    });
  });
}

describe("the kiosk layout for an org nothing answers to", () => {
  it("mounts no HtmlLang (the board page 404s or redirects; there is no locale to claim)", async () => {
    getPublicOrg.mockResolvedValue(null);
    const els = walk(
      (await KioskOrgLayout({
        children: createElement("p", null, "(page)"),
        params: Promise.resolve({ orgSlug: "gone" }),
      })) as ReactElement,
    );
    expect(htmlLangs(els)).toHaveLength(0);
  });
});

// Client-side navigation keeps the layout mounted, so a write made once goes
// stale (Task 16 review, M6): a register page's provider writes the VISITOR's
// locale and a move back to the hub left it there; leaving /shared for a tree
// that claims no locale kept the org's. No DOM under vitest: the element is
// driven through its effect against a stubbed `document`, re-rendered across a
// pathname change, and unmounted.
describe("client-side navigation — the attribute follows the page, not the first write", () => {
  const stubDocument = (lang: string, cookie: string) => {
    const documentElement = { lang };
    vi.stubGlobal("document", { documentElement, cookie });
    return documentElement;
  };

  it("a move inside the org layout re-asserts the org's locale over the page it left", () => {
    const doc = stubDocument("en", "seazn_locale=fr");
    nav.pathname = "/shared/test-org/cup/register";
    const island = renderIsland(HtmlLang, { lang: "es" });
    expect(doc.lang).toBe("es");
    // The register page's own provider writes the visitor's locale after it.
    doc.lang = "fr";
    island.rerender({ lang: "es" });
    expect(doc.lang, "premise: a re-render on the SAME page leaves that page's write alone").toBe("fr");
    nav.pathname = "/shared/test-org";
    island.rerender({ lang: "es" });
    expect(doc.lang).toBe("es");
    island.unmount();
  });

  it.each([
    ["seazn_locale=fr", "fr"],
    ["", "en"],
  ])("leaving the tree (cookie %j) puts back what the root serves: %s", (cookie, root) => {
    const doc = stubDocument("en", cookie);
    nav.pathname = "/shared/test-org";
    const island = renderIsland(HtmlLang, { lang: "nl" });
    expect(doc.lang).toBe("nl");
    island.unmount();
    expect(doc.lang).toBe(root);
  });

  it("the root's cookie instance never re-writes on navigation, and its unmount writes nothing", () => {
    const doc = stubDocument("en", "seazn_locale=fr");
    nav.pathname = "/o/test-org";
    const island = renderIsland(HtmlLang, {});
    expect(doc.lang).toBe("fr");
    // The organiser shell's provider, authoritative (users.locale), whose own
    // effect does not re-run on a move inside the shell.
    doc.lang = "nl";
    nav.pathname = "/o/test-org/c/cup";
    island.rerender({});
    expect(doc.lang).toBe("nl");
    island.unmount();
    expect(doc.lang).toBe("nl");
  });
});
