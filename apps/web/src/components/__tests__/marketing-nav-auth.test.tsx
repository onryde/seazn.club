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
import { compileCss } from "@/components/v2/__tests__/_compiled-css";
import { HELP_LINK, TOP_LINKS } from "@/lib/marketing/product-nav";
import { SESSION_HINT_COOKIE, SESSION_HINT_PREPAINT, hasSessionHint } from "@/lib/session-hint";
import { LOCALES } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/marketing.json";
import es from "@/dictionaries/es/marketing.json";
import fr from "@/dictionaries/fr/marketing.json";
import nl from "@/dictionaries/nl/marketing.json";

const DICTS: Record<string, Record<string, string>> = { en, es, fr, nl };
const render = async (props: Parameters<typeof MarketingNav>[0] = {}) => renderToStaticMarkup(await MarketingNav(props));
/** What a reader of the markup's TEXT sees: scripts and tags gone. */
const textOf = (markup: string) => markup.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ");
/** The bar's session slot: its own opening tag, and its contents up to the phone menu that follows it. */
const slotOf = (markup: string) => {
  const m = /<div ([^>]*data-testid="nav-session-slot"[^>]*)>([\s\S]*?)<div class="relative md:hidden">/.exec(markup);
  expect(m, "the bar has a session slot").not.toBeNull();
  return { tag: m![1]!, inner: m![2]! };
};
/** The whole bar: its own opening tag and everything inside it. */
const barOf = (markup: string) => {
  const m = /<header ([^>]*)>([\s\S]*?)<\/header>/.exec(markup);
  expect(m, "the page has the bar").not.toBeNull();
  return { tag: m![1]!, inner: m![2]! };
};
const SIZER = /<span aria-hidden="true" data-label="Dashboard →" class="([^"]*)"><\/span>/;
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
    expect(html).not.toContain('href="/dashboard"');
    expect(textOf(html)).not.toContain("Dashboard");
  });

  it('auth="client", signed out: the slot shows Log in and Start free, and nothing else', async () => {
    const html = await render({ auth: "client" });
    const slot = slotOf(html);
    expect(barOf(html).tag, "the server marks nobody signed in").not.toContain("data-signed-in");
    const links = [...slot.inner.matchAll(/<a [^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);
    expect(links).toEqual(["Log in", "Start free"]);
    // The only other thing there is the sizer, which is not displayed unless the slot is marked.
    expect(SIZER.exec(slot.inner)?.[1]?.split(" ")).toContain("hidden");
  });

  it('auth="client" draws the same page for a visitor who IS signed in: the server cannot know', async () => {
    h.user = { id: "u1" };
    const html = await render({ auth: "client" });
    expect(h.calls).toBe(0);
    expect(textOf(html)).not.toContain("Dashboard");
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
  it("with the hint cookie, the bar AND the phone panel show Dashboard, and nothing of the signed-out pair is left", async () => {
    withCookie(`theme=dark; ${SESSION_HINT_COOKIE}=1; other=2`);
    const html = await render({ auth: "client" });
    expect(h.calls).toBe(0);
    // Two places: the bar (max-sm:hidden) and the phone panel's auth block.
    expect(html.split('href="/dashboard"')).toHaveLength(3);
    expect(html).not.toContain('href="/login"');
    // The slot holds the link alone: a hidden or invisible signed-out pair would still take its width, and "Dashboard"
    // is narrower, so the difference showed as a gap after the Help icon.
    const slot = slotOf(html);
    expect([...slot.inner.matchAll(/<a /g)]).toHaveLength(1);
    expect(slot.inner).not.toContain("invisible");
    expect(slot.inner).not.toMatch(SIZER);
  });

  it("without it (no cookie, another cookie, the hint set to 0) the signed-out actions stay", async () => {
    let checked = 0;
    for (const cookie of ["", "theme=dark", `${SESSION_HINT_COOKIE}=0`, `x${SESSION_HINT_COOKIE}=1`, "seazn_session=abc"]) {
      withCookie(cookie);
      const html = await render({ auth: "client" });
      expect(html, cookie).toContain('href="/login"');
      expect(html, cookie).not.toContain('href="/dashboard"');
      expect(slotOf(html).inner, cookie).toContain('href="/login"');
      checked++;
    }
    expect(checked).toBe(5);
  });

  const swap = () => renderToStaticMarkup(<NavSessionSwap signedOut={<b>out</b>} signedIn={<i>in</i>} signedInLabel="Dashboard →" />);

  it("the server's first render says signed out even for a browser that has the hint (hydration agrees)", () => {
    h.clientSnapshot = false;
    vi.stubGlobal("document", { cookie: `${SESSION_HINT_COOKIE}=1` });
    const html = swap();
    expect(html).toContain("<b>out</b>");
    expect(html).not.toContain("<i>in</i>");
  });

  it("NavSessionSwap draws signedIn exactly when the hint is set", () => {
    withCookie(`${SESSION_HINT_COOKIE}=1`);
    const hinted = swap();
    expect(hinted).toContain("<i>in</i>");
    expect(hinted).not.toContain("<b>out</b>");
    withCookie("a=1");
    const plain = swap();
    expect(plain).toContain("<b>out</b>");
    expect(plain).not.toContain("<i>in</i>");
  });
});

// Before the page's own code runs, the markup is the signed-out one. So that nothing moves when "Dashboard" arrives, a
// small inline script marks the bar while the page is still being parsed (Next's "preventing flash" guide), and CSS
// then gives the slot the button's width instead of the pair's. The pages that use it are /help and /blog, whose fixed
// CSP allows an inline script (proxy.ts isStaticContentPath).
describe("the mark made before the first paint", () => {
  /** Runs the script as a browser would: parsed as the bar's first child, reading document.cookie. */
  const run = (cookie: string) => {
    const set: [string, string][] = [];
    const doc = { cookie, currentScript: { parentElement: { setAttribute: (k: string, v: string) => void set.push([k, v]) } } };
    new Function("document", SESSION_HINT_PREPAINT)(doc);
    return set;
  };

  it("marks the bar for exactly the cookie strings the hint reader accepts", () => {
    const cases: [string, boolean][] = [
      [`${SESSION_HINT_COOKIE}=1`, true],
      [`${SESSION_HINT_COOKIE}=1; seazn_locale=fr`, true],
      [`seazn_locale=fr; ${SESSION_HINT_COOKIE}=1; seazn_tz=Europe%2FLondon`, true],
      [`seazn_locale=fr;${SESSION_HINT_COOKIE}=1`, true],
      ["", false],
      [`${SESSION_HINT_COOKIE}=0`, false],
      [`${SESSION_HINT_COOKIE}=`, false],
      [`${SESSION_HINT_COOKIE}=11`, false],
      [`x${SESSION_HINT_COOKIE}=1`, false],
      ["seazn_session=abc", false],
    ];
    let yes = 0;
    for (const [cookie, expected] of cases) {
      expect(run(cookie), cookie).toEqual(expected ? [["data-signed-in", ""]] : []);
      expect(hasSessionHint(cookie), `the reader agrees: ${cookie}`).toBe(expected);
      yes += expected ? 1 : 0;
    }
    expect([yes, cases.length - yes]).toEqual([4, 6]);
  });

  // WHERE the script sits matters as much as what it says. Chrome paints a frame around an inline script: with the script
  // inside the slot, that frame held a bar whose right end was not parsed yet, and the links stood 117px off for one frame
  // (23 of 25 signed-in loads, 8 of 25 signed-out ones). As the bar's FIRST child there is nothing drawn yet to move.
  it("is the bar's first child, ahead of everything the bar draws; it runs only from the server's HTML", async () => {
    const html = await render({ auth: "client" });
    const bar = barOf(html);
    const first = /^<script type="([^"]+)">([\s\S]*?)<\/script>/.exec(bar.inner);
    expect(first, "the script comes first").not.toBeNull();
    expect(first![1]).toBe("text/javascript");
    expect(first![2]).toBe(SESSION_HINT_PREPAINT);
    expect(bar.inner.match(/<script/g), "and no other script inside the bar").toHaveLength(1);
    // Rendered by React in a browser (a soft navigation) it is inert: React warns about a live script, and the
    // component's own state already says who is looking.
    vi.stubGlobal("window", {});
    expect(barOf(await render({ auth: "client" })).inner).toMatch(/^<script type="text\/plain">/);
  });

  it("is only on a cached page: a server-drawn bar has no script and no group", async () => {
    let checked = 0;
    for (const user of [null, { id: "u1" }]) {
      h.user = user;
      const bar = barOf(await render({ auth: "server" }));
      expect(bar.inner).not.toContain("<script");
      expect(bar.tag).not.toContain("group/nav-session");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("with the mark, CSS drops the signed-out pair and sizes the slot with the button's own classes and label", async () => {
    const html = await render({ auth: "client" });
    const slot = slotOf(html);
    const pair = /^<div class="([^"]*)">/.exec(slot.inner)?.[1]?.split(" ") ?? [];
    const sizer = SIZER.exec(slot.inner)?.[1]?.split(" ") ?? [];
    expect(pair).toContain("group-data-[signed-in]/nav-session:hidden");
    // The sizer holds the width without being seen: invisible, displayed only under the mark, its text drawn by CSS so
    // the signed-out page's text never says "Dashboard".
    for (const c of ["invisible", "hidden", "group-data-[signed-in]/nav-session:inline-flex", "before:content-[attr(data-label)]"]) expect(sizer, c).toContain(c);
    withCookie(`${SESSION_HINT_COOKIE}=1`);
    const link = /<a class="([^"]*)" href="\/dashboard">/.exec(slotOf(await render({ auth: "client" })).inner)?.[1]?.split(" ") ?? [];
    for (const c of ["btn", "btn-primary", "text-sm", "whitespace-nowrap"]) {
      expect(link, `premise: the link has ${c}`).toContain(c);
      expect(sizer, `the sizer has ${c}`).toContain(c);
    }
    expect(barOf(html).tag, "the bar, which the script marks, is the named group the variants ask").toMatch(/class="[^"]*\bgroup\/nav-session\b/);
    const css = (await compileCss(["group-data-[signed-in]/nav-session:hidden", "group-data-[signed-in]/nav-session:inline-flex", "before:content-[attr(data-label)]"])).replace(/\s+/g, " ");
    // The rules as Tailwind writes them: only inside the named group, only when it carries the mark.
    const marked = "&:is(:where(.group\\/nav-session)[data-signed-in] *)";
    expect(css).toContain(`.group-data-\\[signed-in\\]\\/nav-session\\:hidden { ${marked} { display: none; } }`);
    expect(css).toContain(`.group-data-\\[signed-in\\]\\/nav-session\\:inline-flex { ${marked} { display: inline-flex; } }`);
    expect(css).toContain("&::before { --tw-content: attr(data-label); content: var(--tw-content); }");
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
