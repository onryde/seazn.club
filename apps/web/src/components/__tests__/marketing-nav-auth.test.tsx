// The marketing nav's two ways to know who is looking (components/marketing-nav.tsx `auth`):
//  - "server" (the default) asks the session and draws that visitor's actions;
//  - "client" never reads the session, so the page can be cached for everyone; the server draws the signed-out set and
//    a client island swaps in "Dashboard" when the browser carries the hint cookie.
// Node vitest has no DOM, so the swap is driven the way the browser drives it: the real component and the real hint
// reader, with React's `useSyncExternalStore` told to take the CLIENT snapshot (document.cookie) instead of the server
// one. The hydration contract itself (server snapshot = signed out) is the unmocked test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({ calls: 0, user: null as null | { id: string }, clientSnapshot: false }));
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => {
    h.calls++;
    return h.user;
  },
}));
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return {
    ...real,
    useSyncExternalStore: ((subscribe: never, getSnapshot: () => unknown, getServerSnapshot: () => unknown) =>
      h.clientSnapshot ? getSnapshot() : real.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)) as typeof real.useSyncExternalStore,
  };
});

import { MarketingNav } from "../marketing-nav";
import { NavSessionSwap } from "../marketing/nav-session-swap";
import { HELP_LINK, TOP_LINKS } from "@/lib/marketing/product-nav";
import { SESSION_HINT_COOKIE } from "@/lib/session-hint";
import { LOCALES } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/marketing.json";
import es from "@/dictionaries/es/marketing.json";
import fr from "@/dictionaries/fr/marketing.json";
import nl from "@/dictionaries/nl/marketing.json";

const DICTS: Record<string, Record<string, string>> = { en, es, fr, nl };
const render = async (props: Parameters<typeof MarketingNav>[0] = {}) => renderToStaticMarkup(await MarketingNav(props));
const withCookie = (cookie: string) => {
  h.clientSnapshot = true;
  vi.stubGlobal("document", { cookie });
};

beforeEach(() => {
  h.calls = 0;
  h.user = null;
  h.clientSnapshot = false;
});
afterEach(() => vi.unstubAllGlobals());

describe("MarketingNav: who is looking", () => {
  it('auth="client" reads no session at all, and draws the signed-out actions', async () => {
    const html = await render({ auth: "client" });
    expect(h.calls).toBe(0);
    expect(html).toContain('href="/login"');
    expect(html).toContain('href="/login?tab=signup"');
    expect(html).not.toContain("Dashboard");
  });

  it('auth="client" draws the same page for a visitor who IS signed in: the server cannot know', async () => {
    h.user = { id: "u1" };
    const html = await render({ auth: "client" });
    expect(h.calls).toBe(0);
    expect(html).not.toContain("Dashboard");
    expect(html).toBe(await render({ auth: "client" }));
  });

  it("the default asks the session exactly once, and draws that visitor's own actions", async () => {
    expect(await render()).toContain('href="/login"');
    expect(h.calls).toBe(1);
    h.calls = 0;
    h.user = { id: "u1" };
    const html = await render({ variant: "light" });
    expect(h.calls).toBe(1);
    expect(html).toContain('href="/dashboard"');
    expect(html).not.toContain('href="/login"');
    expect(await render({ auth: "server" })).toContain('href="/dashboard"');
  });
});

describe("the client swap", () => {
  it("with the hint cookie, the bar AND the phone panel show Dashboard in place of the signed-out actions", async () => {
    withCookie(`theme=dark; ${SESSION_HINT_COOKIE}=1; other=2`);
    const html = await render({ auth: "client" });
    expect(h.calls).toBe(0);
    // Two places: the bar (max-sm:hidden) and the phone panel's auth block.
    expect(html.split('href="/dashboard"')).toHaveLength(3);
    // The signed-out pair stays only as the slot's sizer: invisible and inert (so not focusable), never in the panel.
    expect(html.split('href="/login"')).toHaveLength(2);
    expect(html).toMatch(/<div class="[^"]*\binvisible\b[^"]*" inert="">\s*<a [^>]*href="\/login"/);
  });

  it("without it (no cookie, another cookie, the hint set to 0) the signed-out actions stay", async () => {
    for (const cookie of ["", "theme=dark", `${SESSION_HINT_COOKIE}=0`, `x${SESSION_HINT_COOKIE}=1`, "seazn_session=abc"]) {
      withCookie(cookie);
      const html = await render({ auth: "client" });
      expect(html, cookie).toContain('href="/login"');
      expect(html, cookie).not.toContain('href="/dashboard"');
    }
  });

  it("the server's first render says signed out even for a browser that has the hint (hydration agrees)", async () => {
    h.clientSnapshot = false;
    vi.stubGlobal("document", { cookie: `${SESSION_HINT_COOKIE}=1` });
    const html = renderToStaticMarkup(<NavSessionSwap signedOut={<b>out</b>} signedIn={<i>in</i>} />);
    expect(html).toContain("<b>out</b>");
    expect(html).not.toContain("<i>in</i>");
    expect(html).not.toContain("invisible");
  });

  it("NavSessionSwap draws signedIn exactly when the hint is set", () => {
    withCookie(`${SESSION_HINT_COOKIE}=1`);
    const hinted = renderToStaticMarkup(<NavSessionSwap signedOut={<b>out</b>} signedIn={<i>in</i>} />);
    expect(hinted).toContain("<i>in</i>");
    // The sizer: the signed-out node is still there (so the slot keeps its width) but cannot be seen or focused.
    expect(hinted).toMatch(/class="[^"]*\binvisible\b[^"]*" inert=""><b>out<\/b>/);
    withCookie("a=1");
    const plain = renderToStaticMarkup(<NavSessionSwap signedOut={<b>out</b>} signedIn={<i>in</i>} />);
    expect(plain).toContain("<b>out</b>");
    expect(plain).not.toContain("<i>in</i>");
    expect(plain).not.toContain("inert");
  });
});

describe("Blog and Help in the bar", () => {
  it("Blog is a top-level link between the Sports menu and Pricing, and the bar has five items before Help", async () => {
    const html = await render({ auth: "client" });
    const at = (needle: string) => html.indexOf(needle);
    expect(TOP_LINKS.map((l) => l.href)).toEqual(["/blog", "/pricing", "/live"]);
    expect(at('id="mk-menu-sports"')).toBeGreaterThan(-1);
    expect(at('href="/blog"')).toBeGreaterThan(at('id="mk-menu-sports"'));
    expect(at('href="/blog"')).toBeLessThan(at('href="/pricing"'));
    // Product, Sports (menus) then the plain links: exactly Blog, Pricing, Live, in that order.
    const plain = [...html.matchAll(/<a [^>]*md:inline-flex[^>]*>/g)].map((m) => /href="([^"]+)"/.exec(m[0])![1]);
    expect(plain).toEqual(["/blog", "/pricing", "/live"]);
    expect(html.match(/id="mk-menu-(?:product|sports)"/g)).toHaveLength(2);
  });

  it("Help is an icon link straight to /help, named and titled in each locale, with a 44px hit area, shown from md", async () => {
    let checked = 0;
    for (const lang of LOCALES) {
      const html = await render({ auth: "client", lang });
      const word = DICTS[lang]![HELP_LINK.key]!;
      expect(word, lang).toBeTruthy();
      const m = /<a ([^>]*href="\/help"[^>]*)>(.*?)<\/a>/.exec(html);
      expect(m, `${lang}: a /help link in the bar`).not.toBeNull();
      expect(m![1], lang).toContain(`aria-label="${word}"`);
      expect(m![1], lang).toContain(`title="${word}"`);
      expect(m![1], lang).toMatch(/\bh-11\b/);
      expect(m![1], lang).toMatch(/\bw-11\b/);
      expect(m![1], lang).toMatch(/\bmax-md:hidden\b/);
      expect(m![2], lang).toContain("<svg");
      // Not a menu: no popup on it.
      expect(m![1], lang).not.toContain("aria-haspopup");
      checked++;
    }
    expect(checked).toBe(4);
    // Different words in different locales: the label is translated, not English everywhere.
    expect(new Set(LOCALES.map((l) => DICTS[l]![HELP_LINK.key])).size).toBeGreaterThan(1);
  });

  it('the phone panel carries Help as a text row ("Help") beside the other links', async () => {
    const html = await render({ auth: "client" });
    const panel = html.slice(html.indexOf('role="menu"'));
    const rows = [...panel.matchAll(/<a ([^>]*)>([^<]*)<\/a>/g)].filter((m) => m[1]!.includes('href="/help"'));
    expect(rows).toHaveLength(1);
    expect(rows[0]![1]).toContain('role="menuitem"');
    expect(rows[0]![2]).toBe("Help");
  });
});
