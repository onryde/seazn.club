import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// prerender, not renderToStaticMarkup: the page nests async server components (MarketingNav awaits getCurrentUser), which
// the synchronous renderer cannot await (home-signed-in.test.tsx, same folder, same harness).
import { prerender } from "react-dom/static";

// The marketing home's quick match door (plan 2 Task 9; spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5
// steps 1 and 5; pre-flight A9, A10, B9, D11): the hero's quick match start, its one primary since owner 2026-11-13
// (Option A: a Sport select and "Start a quick match", the organiser's setup a quiet link below), and, for a guest who
// has made quick matches on this browser, the strip of their recent ones.
//
// The strip's read is tested HERE, through the real page (B9: the src/app job, ci.yml "Service-layer integration tests
// outside src/server", runs this folder against a real Postgres; src/components has no DB job). Every quick match is made
// by the real `createQuickMatch`, keyed by a visitor hash the test mints; the page reads the visitor cookie through
// `next/headers` (mocked per case: outside a request the real one throws), and the strip's links are read out of the
// prerendered HTML.
//
// Expected values come from the spec and the rows the real producer returned, never from the read under test: a home is
// `/q/<token>` (§7.4), the setup page is `/<lang>/play` (§5 step 2; the create route spells the same path), the strip
// shows at most 5 rows, newest first (D11), an alive row is one with no expiry or a future one (resolveQuickMatchToken's
// predicate, A10: a SAVED row has none), and the copy is the dictionaries'.
//
// Sport: badminton, the spec's own example. The strip reads no sport (D11: name and date only), so one sport is enough.
// Real Postgres required for the strip's rows; the CTA cases, the cookie guards and the fail-soft cases run without one.

const { getCurrentUser, jar } = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  /** The request's cookies, per case: the visitor cookie's value (or none), or a throw from `cookies()` itself. */
  jar: {
    visitor: undefined as string | undefined,
    throws: undefined as unknown,
    set: vi.fn(),
    reads: 0,
  },
}));

vi.mock("next/font/google", () => ({
  Barlow_Condensed: () => ({ variable: "--mk-font-display", className: "" }),
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser }));
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    usePathname: () => "/en",
    useSearchParams: () => new URLSearchParams(),
  };
});
vi.mock("next/headers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/headers")>();
  return {
    ...actual,
    cookies: vi.fn(async () => {
      if (jar.throws !== undefined) throw jar.throws;
      return {
        get: (name: string) => {
          if (name !== "seazn_qm_visitor") return undefined;
          jar.reads++;
          return jar.visitor !== undefined ? { name, value: jar.visitor } : undefined;
        },
        has: (name: string) => name === "seazn_qm_visitor" && jar.visitor !== undefined,
        getAll: () => (jar.visitor === undefined ? [] : [{ name: "seazn_qm_visitor", value: jar.visitor }]),
        set: jar.set,
        delete: jar.set,
      };
    }),
  };
});
// Review m5: the queries the quick-match system org's `withTenant` handles run while `systemQueries.texts` is set, as
// their SQL text (the tx is wrapped in a recording Proxy, player-stats-refresh.test.ts's pattern). Every other call, and
// every call while it is null, is the real one untouched.
const systemQueries = vi.hoisted(() => ({ texts: null as string[] | null }));
vi.mock("@/lib/db", async (orig) => {
  const real = await orig<typeof import("@/lib/db")>();
  const { QUICK_MATCH_SYSTEM_ORG_ID: QM_ORG } = await import("@/lib/quick-match-constants");
  const withTenant: typeof real.withTenant = (orgId, fn, opts) =>
    real.withTenant(
      orgId,
      (tx) => {
        const texts = systemQueries.texts;
        if (texts === null || orgId !== QM_ORG) return fn(tx);
        const spy = new Proxy(tx, {
          apply(target, thisArg, args: unknown[]) {
            const strings = args[0] as { raw?: readonly string[] } | undefined;
            if (strings !== undefined && Array.isArray(strings.raw)) texts.push(strings.raw.join("?").replace(/\s+/g, " "));
            return Reflect.apply(target as never, thisArg, args);
          },
        });
        return fn(spy);
      },
      opts,
    );
  return { ...real, withTenant };
});
// The read itself is the real one; a case can make it throw once (A9's whole-read failure).
vi.mock("@/server/usecases/quick-match-home", async (orig) => {
  const real = await orig<typeof import("@/server/usecases/quick-match-home")>();
  return { ...real, listRecentQuickMatches: vi.fn(real.listRecentQuickMatches) };
});
// The hero's Sport select lists the setup screen's own offer (owner 2026-11-13): stubbed per case below, the REAL one
// otherwise (the DB-gated sweep drives the live catalog), play-page.test.tsx's pattern.
vi.mock("@/server/usecases/quick-match-sports", async (orig) => {
  const real = await orig<typeof import("@/server/usecases/quick-match-sports")>();
  return { ...real, listQuickMatchSports: vi.fn(real.listQuickMatchSports) };
});
// The create's one analytics event reaches a mock, never PostHog.
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));

import { DynamicServerError } from "next/dist/client/components/hooks-server-context";
import { sql } from "@/lib/db";
import { QUICK_MATCH_SYSTEM_USER_ID } from "@/lib/quick-match-constants";
import { log } from "@/server/logger";
import type { CreateQuickMatch } from "@/server/api-v1/schemas";
import { createQuickMatch, type CreatedQuickMatch } from "@/server/usecases/quick-match-create";
import { hardDeleteQuickMatchCompetition } from "@/server/usecases/quick-match-delete";
import { listRecentQuickMatches } from "@/server/usecases/quick-match-home";
import { listQuickMatchSports, type QuickMatchSport } from "@/server/usecases/quick-match-sports";
import { hashVisitorKey, mintVisitorKey, QUICK_MATCH_VISITOR_COOKIE } from "@/server/usecases/quick-match-tokens";
import { systemAuth } from "@/lib/quick-match-auth";
import { playToDecided } from "@/server/usecases/__tests__/_quick-match-probe";
import { scoreEvent } from "@/server/usecases/scoring";
import enMarketing from "@/dictionaries/en/marketing.json";
import frMarketing from "@/dictionaries/fr/marketing.json";
import { getDictionary } from "@/lib/i18n";
import { heroSceneKey, heroSceneLabelKey } from "@/components/marketing/hero-scenes";
import { HeroEventLink } from "@/components/marketing/hero-event-link";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import HomePage from "../page";
import PlayPage from "../play/page";
import { setupSports } from "../play/setup-props";

/** A throwaway key of this file's own: every create seals a home token, and CI's src/app job has no DEVICE_LINK_KEK. */
const KEK = kekBytes(32).toString("hex");
vi.stubEnv("DEVICE_LINK_KEK", KEK);

const HAS_DB = !!process.env.DATABASE_URL;
/** D11: the strip lists this many rows at most. The ruling's number, typed. */
const STRIP_CAP = 5;

async function render(
  lang = "en",
  page: "home" | "play" = "home",
  search: Record<string, string> = {},
): Promise<string> {
  const params = Promise.resolve({ lang });
  const element = page === "home" ? await HomePage({ params }) : await PlayPage({ params, searchParams: Promise.resolve(search) });
  const { prelude } = await prerender(element);
  const reader = (prelude as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let html = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }
  return html;
}

/** The strip's markup, or null when the page rendered none. */
function stripOf(html: string): string | null {
  const start = html.search(/<section\b[^>]*\bdata-testid="qm-recent"/);
  if (start < 0) return null;
  return html.slice(start, html.indexOf("</section>", start) + "</section>".length);
}
/** The homes the strip links to, in document order. */
const stripHrefs = (html: string): string[] =>
  [...(stripOf(html) ?? "").matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((m) => m[1]!);

/** The setup page's Continue card (owner 2026-11-12), or null when the page rendered none. */
function cardOf(html: string): string | null {
  const start = html.search(/<section\b[^>]*\bdata-testid="qm-continue"/);
  if (start < 0) return null;
  return html.slice(start, html.indexOf("</section>", start) + "</section>".length);
}
/** Where each part of the setup page starts in the HTML (-1 when absent), to read the order a guest meets them in. */
const at = (html: string, testid: string) => html.search(new RegExp(`\\bdata-testid="${testid}"`));

/** The CTA's Start: the submit button whose text is the CTA label (owner 2026-11-13: a GET form's button, no longer a
 *  link). The full tag and its text. */
function ctaButton(html: string, label: string): string | undefined {
  return [...html.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)].find((m) => m[1] === label)?.[0];
}
/** The hero: from the page's <main> to The Draw, the next section a visitor meets. */
function heroOf(html: string): string {
  const start = html.indexOf("<main");
  const end = html.indexOf('id="the-draw"');
  expect(start, "the page's <main>").toBeGreaterThan(-1);
  expect(end, "The Draw").toBeGreaterThan(start);
  return html.slice(start, end);
}
/** The hero's quick match form: its opening tag and its whole markup, or null when there is none. */
function ctaFormOf(html: string): { tag: string; body: string } | null {
  const hero = heroOf(html);
  const start = hero.search(/<form\b[^>]*\bdata-testid="qm-cta-form"/);
  if (start < 0) return null;
  const body = hero.slice(start, hero.indexOf("</form>", start) + "</form>".length);
  return { tag: body.match(/^<form\b[^>]*>/)![0], body };
}
/** The Sport select's options, in document order: value, label, and whether the server wrote it selected. */
const optionsOf = (form: string) =>
  [...form.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].map((m) => ({
    value: m[1]!.match(/\bvalue="([^"]*)"/)?.[1] ?? "?",
    label: m[2]!,
    selected: /\sselected=""/.test(m[1]!),
  }));
/** The hero's organiser door: the link to `/<lang>/start`, its tag and its text (tags stripped). */
function eventLinkOf(html: string, lang: string): { tag: string; text: string } | null {
  const m = heroOf(html).match(new RegExp(`(<a\\b[^>]*\\bhref="/${lang}/start"[^>]*>)([\\s\\S]*?)</a>`));
  return m ? { tag: m[1]!, text: m[2]!.replace(/<[^>]*>/g, "").replace(/<!-- -->/g, "") } : null;
}

/** The hero's organiser doors as the page mounts them (its element tree, before any render): each one's props. The HTML
 *  is the no-script page, which a plain link and the select follower write alike; the tree tells them apart. */
async function heroDoors(lang: string): Promise<Record<string, unknown>[]> {
  const root = await HomePage({ params: Promise.resolve({ lang }) });
  const found: Record<string, unknown>[] = [];
  const visit = (node: ReactNode) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isValidElement(node)) return;
    const el = node as ReactElement<{ children?: ReactNode }>;
    if (el.type === HeroEventLink) found.push(el.props as Record<string, unknown>);
    visit(el.props.children);
  };
  visit(root);
  return found;
}

/** The sport the hero's art draws (hero-vignette.tsx `data-sport`): exactly one in the hero, or a red. */
function artSportOf(html: string): string {
  const all = [...heroOf(html).matchAll(/<div\b[^>]*\bdata-sport="([^"]*)"/g)].map((m) => m[1]!);
  expect(all, "one illustration in the hero").toHaveLength(1);
  return all[0]!;
}
/** The hero art's accessible name: the `role="img"` svg's label. */
const artLabelOf = (html: string) => heroOf(html).match(/<svg\b[^>]*\brole="img"[^>]*\baria-label="([^"]*)"/)?.[1];

/** A two-sport offer the hero lists in this order (the stubbed listQuickMatchSports): badminton, then chess. */
const OFFER: QuickMatchSport[] = [
  {
    sport_key: "badminton",
    labelKey: "sport.badminton",
    kinds: ["individual", "pair"],
    variants: [{ variant_key: "bwf", labelKey: "variant.badminton.bwf", knockoutAllowed: true }],
  },
  {
    sport_key: "boardgame",
    labelKey: "sport.boardgame",
    kinds: ["individual"],
    variants: [{ variant_key: "rapid", labelKey: "variant.boardgame.rapid", knockoutAllowed: true }],
  },
];

// The visitor cookie's name is the create route's: the test's jar answers to the literal, so a renamed cookie reds here.
it("the jar answers to the visitor cookie's real name", () => {
  expect(QUICK_MATCH_VISITOR_COOKIE).toBe("seazn_qm_visitor");
});

beforeEach(() => {
  getCurrentUser.mockResolvedValue(null);
  jar.visitor = undefined;
  jar.throws = undefined;
  jar.set.mockClear();
  jar.reads = 0;
  vi.mocked(listRecentQuickMatches).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.stubEnv("DEVICE_LINK_KEK", KEK);
  // Drops an unspent stub and goes back to the real read.
  vi.mocked(listQuickMatchSports).mockReset();
});

/** React's escapes of dictionary copy, undone, so a NEGATIVE copy probe cannot pass on an escaped `'` or `&`. */
const unescape = (s: string) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// The hero's one primary (owner 2026-11-13, "A, apply rec": mockup 2026-11-13_marketing-hero-quick-match-first_hqm13a01,
// Option A): a Sport select and the lime Start, a plain GET to the setup page, which opens on that sport (?sport=,
// play-page.test.tsx). The organiser's setup is one quiet link below it. Expected values: the offer the page reads (OFFER,
// the stubbed listQuickMatchSports; the live catalog in the DB-gated sweep) named by the setup screen's own
// `setupSports`, the dictionaries' copy, and the two paths, `/<lang>/play` (spec §5 step 2) and `/<lang>/start`.
describe("the hero's quick match start (spec §5 step 1, Option A)", () => {
  it("the empty offer first: still a GET to `/en/play` with its Start (the setup page then says why), and no Sport select", async () => {
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce([]);
    const html = await render("en");
    const form = ctaFormOf(html);
    expect(form, "the quick match form").not.toBeNull();
    expect(form!.tag).toContain('method="get"');
    expect(form!.tag).toContain('action="/en/play"');
    expect(ctaButton(form!.body, enMarketing["quickMatch.cta"]), "the Start").toBeDefined();
    expect(form!.body).not.toContain("<select");
    expect(optionsOf(form!.body)).toEqual([]);
  });

  it("an empty offer is no failure: nothing logged (the positive pair of the read that throws)", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce([]);
    await render("en");
    expect(listQuickMatchSports).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("the offer cannot be read: the same Start alone, the page still renders (fail-soft), and the failure is logged once, at error, as /play logs it", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const cause = new Error("db down");
    vi.mocked(listQuickMatchSports).mockRejectedValueOnce(cause);
    const html = await render("en");
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toEqual({ err: cause });
    expect(String(error.mock.calls[0]![1])).toMatch(/offer could not be read/);
    expect(warn).not.toHaveBeenCalled();
    const form = ctaFormOf(html);
    expect(form?.tag).toContain('action="/en/play"');
    expect(form!.body).not.toContain("<select");
    expect(ctaButton(form!.body, enMarketing["quickMatch.cta"])).toBeDefined();
    expect(html).toContain('id="the-draw"');
  });

  it("an offer: a Sport select over it, in its order and with the setup screen's names, the first selected, then the Start (the positive pair of both above)", async () => {
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
    const [html, ui] = await Promise.all([render("en"), getDictionary("en", "ui")]);
    const form = ctaFormOf(html)!;
    expect(form.tag).toContain('method="get"');
    expect(form.tag).toContain('action="/en/play"');
    // On the night stage, the night panel (globals.css `.mk-funnel-night`: dark fields, lime submit), never a light one.
    expect(form.tag).toMatch(/\bclass="[^"]*\bmk-funnel-night\b/);
    expect(form.tag).not.toMatch(/\bbg-white\b/);
    // The field the setup page reads: `?sport=` (play/setup-props.ts `prefillSport`).
    const select = form.body.match(/<select\b[^>]*>/)?.[0];
    expect(select, "the Sport select").toBeDefined();
    expect(select).toContain('name="sport"');
    expect(select).toMatch(/\bclass="[^"]*\bmin-h-11\b/);
    const expected = setupSports(OFFER, ui);
    expect(expected).toHaveLength(OFFER.length);
    expect(optionsOf(form.body)).toEqual(expected.map((s, i) => ({ value: s.sport_key, label: s.name, selected: i === 0 })));
    // Labelled with the setup screen's own word for the same choice.
    expect(form.body).toContain(`>${enMarketing["quickMatch.setup.sport"]}<`);
    // The Start: a submit button after the select, a 44px tap target, described by the line beneath the form.
    const start = ctaButton(form.body, enMarketing["quickMatch.cta"]);
    expect(start, "the Start").toBeDefined();
    expect(start).toContain('type="submit"');
    expect(start).toMatch(/\bclass="[^"]*\bmin-h-11\b/);
    expect(start).toContain('aria-describedby="qm-cta-hint"');
    expect(form.body.indexOf(start!)).toBeGreaterThan(form.body.indexOf(select!));
    expect(heroOf(html)).toMatch(new RegExp(`<p\\b[^>]*\\bid="qm-cta-hint"[^>]*>${enMarketing["quickMatch.ctaHint"]}</p>`));
    // Review m6: the art beside the select draws the sport the select opens on, never one it cannot give, and names that
    // sport's scene (owner 2026-11-13: the art follows the select; hero-vignette.test.tsx drives the change itself).
    const selected = optionsOf(form.body).filter((o) => o.selected);
    expect(selected).toHaveLength(1);
    expect(artSportOf(html)).toBe(selected[0]!.value);
    expect(heroSceneKey(selected[0]!.value), "the opening sport has its own scene").toBe(selected[0]!.value);
    expect(unescape(artLabelOf(html) ?? "")).toBe(
      (enMarketing as Record<string, string>)[heroSceneLabelKey(heroSceneKey(selected[0]!.value))],
    );
  });

  it("the organiser's setup is a quiet link to `/en/start` under the Start, mounted to follow the Sport select; the funnel's fields and Setup button are gone", async () => {
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
    const html = await render("en");
    const hero = heroOf(html);
    const plain = unescape(hero);
    // Positive: the link, its words, its tap target, and where a visitor meets it: form, line, this link, then pricing.
    const link = eventLinkOf(html, "en");
    expect(link, "a link to /en/start").not.toBeNull();
    expect(link!.text).toBe(`${enMarketing["home.hero.eventPrompt"]} ${enMarketing["home.hero.eventLink"]}`);
    expect(link!.tag).toMatch(/\bclass="[^"]*\bmin-h-11\b/);
    const order = [
      hero.search(/<form\b[^>]*\bdata-testid="qm-cta-form"/),
      hero.indexOf('id="qm-cta-hint"'),
      hero.indexOf(link!.tag),
      plain.indexOf(enMarketing["home.hero.upgradeLink"]),
    ];
    for (const i of order) expect(i, `order ${JSON.stringify(order)}`).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Negative, each beside a positive: the hero's one form is the quick match's, with the Sport select, and nothing of
    // the funnel's (its form, entrants and date fields, their labels, its Setup button).
    expect(hero.match(/<form\b/g), "one form in the hero").toHaveLength(1);
    expect(hero).toMatch(/<select\b[^>]*\bname="sport"/);
    expect(hero).not.toContain("data-start-funnel");
    expect(hero).not.toMatch(/\bname="entrants"/);
    expect(hero).not.toMatch(/\bname="date"/);
    expect(hero).not.toMatch(/\btype="date"/);
    let removed = 0;
    // The removed form's English copy as origin/main shipped it (its `funnel.*` keys are deleted with it).
    for (const copy of ["Players / teams", "Start date", "Setup →"]) {
      expect(plain, copy).not.toContain(copy);
      removed++;
    }
    expect(removed).toBe(3);
    // Changed on purpose (start wizard plan 2026-11-13 Task 5): once the script runs, the door carries the Sport select's
    // sport, `/en/start?sport=<key>` (hero-event-link.test.tsx drives the select and /start's parser). The server's HTML
    // is the page without the script, where the select's choice is unknown, so it writes the plain `/en/start`: no query
    // at all, so a sport the visitor then changes is never sent wrong.
    expect(plain).not.toContain("/start?");
    // ...and the link is the one that follows the select (the positive the plain HTML cannot show on its own).
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
    const doors = await heroDoors("en");
    expect(doors, "one follower in the hero").toHaveLength(1);
    expect(doors[0]).toMatchObject({ lang: "en", "data-testid": "hero-event-link" });
    // The Start that stays (the positive of the Setup button's absence).
    expect(ctaButton(hero, enMarketing["quickMatch.cta"])).toBeDefined();
  });

  it("speaks the page's language and keeps it: `/fr/play`, the French Start and names, the door to `/fr/start`", async () => {
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
    const [html, ui] = await Promise.all([render("fr"), getDictionary("fr", "ui")]);
    const form = ctaFormOf(html)!;
    expect(form.tag).toContain('action="/fr/play"');
    expect(ctaButton(form.body, frMarketing["quickMatch.cta"]), "the French Start").toBeDefined();
    expect(ctaButton(form.body, enMarketing["quickMatch.cta"]), "never the English one").toBeUndefined();
    const names = setupSports(OFFER, ui).map((s) => s.name);
    expect(optionsOf(form.body).map((o) => unescape(o.label))).toEqual(names);
    expect(html).toContain(frMarketing["quickMatch.ctaHint"]);
    expect(unescape(artLabelOf(html) ?? ""), "the art's French name").toBe(frMarketing["home.hero.scene.badminton"]);
    expect(eventLinkOf(html, "fr")?.text).toBe(`${frMarketing["home.hero.eventPrompt"]} ${frMarketing["home.hero.eventLink"]}`);
    expect(eventLinkOf(html, "en"), "never the English path").toBeNull();
    expect(html).not.toContain('action="/en/play"');
    // The follower is handed the page's language, so the sport it adds rides `/fr/start`.
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
    expect((await heroDoors("fr")).map((p) => p.lang)).toEqual(["fr"]);
  });
});

describe.skipIf(!HAS_DB)("the hero's Sport select over the live offer, through to /play (both real ends of the seam)", () => {
  it("lists exactly the setup screen's sports, and each option, sent as the form names it, opens /play on that sport", async () => {
    const [live, ui] = await Promise.all([listQuickMatchSports(), getDictionary("en", "ui")]);
    const expected = setupSports(live, ui);
    const home = await render("en");
    const form = ctaFormOf(home)!;
    const field = form.body.match(/<select\b[^>]*\bname="([^"]*)"/)?.[1];
    expect(field, "the select's field name").toBeDefined();
    const options = optionsOf(form.body);
    expect(options.map((o) => o.value)).toEqual(expected.map((s) => s.sport_key));
    // Review m6: the hero's art draws the sport the live select opens on (the offer's first).
    expect(options.filter((o) => o.selected).map((o) => o.value)).toEqual([expected[0]!.sport_key]);
    expect(artSportOf(home)).toBe(expected[0]!.sport_key);
    let checked = 0;
    for (const o of options) {
      const play = await render("en", "play", { [field!]: o.value });
      const opened = (play.match(/<input[^>]*\bname="sport_key"[^>]*>/g) ?? [])
        .filter((tag) => /\schecked=""/.test(tag))
        .map((tag) => tag.match(/\bvalue="([^"]*)"/)?.[1]);
      expect(opened, o.value).toEqual([o.value]);
      checked++;
    }
    // Anti-vacuity: a DB without `sync:sports` offers nothing; and with one sport, preselecting cannot differ from the default.
    expect(checked, "options swept").toBe(expected.length);
    expect(checked).toBeGreaterThanOrEqual(2);
  });
});

describe("the recent strip's cookie: read only, trusted only when it is a visitor key", () => {
  it("no cookie: no strip, and no read of the database", async () => {
    const html = await render();
    expect(stripOf(html)).toBeNull();
    expect(jar.reads, "the page asked for the visitor cookie").toBeGreaterThan(0);
    expect(listRecentQuickMatches).not.toHaveBeenCalled();
    expect(jar.set, "reading never mints a cookie").not.toHaveBeenCalled();
  });

  it("a malformed cookie: no strip, never hashed into a read", async () => {
    for (const value of ["", "qv_short", `qm_${"A".repeat(43)}`, `qv_${"A".repeat(42)}!`]) {
      jar.visitor = value;
      const html = await render();
      expect(stripOf(html), `cookie ${JSON.stringify(value)}`).toBeNull();
    }
    expect(listRecentQuickMatches).not.toHaveBeenCalled();
    expect(jar.set).not.toHaveBeenCalled();
  });

  it("`cookies()` throwing outside a request reads as no cookie (the page still renders)", async () => {
    jar.throws = new Error("`cookies` was called outside a request scope");
    const html = await render();
    expect(stripOf(html)).toBeNull();
    expect(ctaButton(html, enMarketing["quickMatch.cta"])).toBeDefined();
  });

  it("Next's own render signal from `cookies()` is never swallowed: it reaches the framework (unstable_rethrow)", async () => {
    const signal = new DynamicServerError("Route /en couldn't be rendered statically because it used `cookies`");
    jar.throws = signal;
    await expect(HomePage({ params: Promise.resolve({ lang: "en" }) })).rejects.toBe(signal);
  });
});

describe("the recent strip fails soft (A9): the busiest page never 500s on a guest feature", () => {
  it("a read that throws: the CTA renders, no strip, one warning logged (a warning: an outage hits every visitor)", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    jar.visitor = mintVisitorKey();
    // The hero's offer reads (stubbed), so the one log line counted here is the strip's, with or without a database.
    vi.mocked(listQuickMatchSports).mockResolvedValueOnce(OFFER);
    vi.mocked(listRecentQuickMatches).mockRejectedValueOnce(new Error("connection terminated"));
    const html = await render();
    expect(listRecentQuickMatches).toHaveBeenCalledTimes(1);
    expect(stripOf(html)).toBeNull();
    expect(ctaButton(html, enMarketing["quickMatch.cta"])).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });
});

// ── the rows (real Postgres) ───────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("the recent strip's rows (real createQuickMatch, real read)", () => {
  let BADMINTON: { variant: string; kind: CreateQuickMatch["kind"] };
  const made: CreatedQuickMatch[] = [];

  beforeAll(async () => {
    const badminton = (await listQuickMatchSports()).find((s) => s.sport_key === "badminton");
    if (!badminton) throw new Error("badminton is not offered on this database: run `npm run sync:sports`");
    BADMINTON = { variant: badminton.variants[0]!.variant_key, kind: badminton.kinds[0]! };
  });
  afterAll(async () => {
    for (const out of made) await hardDeleteQuickMatchCompetition(out.competitionId);
    vi.unstubAllEnvs();
    const g = globalThis as { _sql?: { end(): Promise<void> } };
    const client = g._sql;
    g._sql = undefined;
    await client?.end();
  });

  /** One quick match for this visitor hash: two sides, one league match (the cheapest real create), unless sides are given. */
  async function make(
    visitorHash: string,
    name = `QM strip ${randomUUID().slice(0, 8)}`,
    sides: string[] = ["Ravi", "Sam"],
  ): Promise<CreatedQuickMatch> {
    const out = await createQuickMatch(
      {
        name,
        sport_key: "badminton",
        variant_key: BADMINTON.variant,
        kind: BADMINTON.kind,
        format: "league",
        sides,
        plays: 1,
        email: null,
        locale: "en",
      },
      { visitorHash, baseUrl: "https://seazn.example", mailAllowed: async () => true },
    );
    made.push(out);
    return out;
  }
  /** Dates the row, so "newest first" is decided by the column the read sorts on, not by insert order. */
  const dateRow = (id: string, createdAt: string) => sql`update quick_matches set created_at = ${createdAt} where id = ${id}`;
  const nameOf = async (id: string) => (await sql<{ name: string }[]>`select name from quick_matches where id = ${id}`)[0]!.name;
  /** The match's fixtures with both sides seated, in play order: the real generator's rows. */
  const seated = async (out: CreatedQuickMatch) =>
    sql<{ id: string }[]>`
      select f.id from fixtures f join divisions d on d.id = f.division_id
       where d.competition_id = ${out.competitionId} and f.home_entrant_id is not null and f.away_entrant_id is not null
       order by f.round_no, f.fixture_no`;
  /** Decide `n` of its matches (all by default) through the real write path, as a guest's taps do. */
  async function finish(out: CreatedQuickMatch, n = Infinity) {
    const fixtures = (await seated(out)).slice(0, n);
    expect(fixtures.length, "anti-vacuity: a match to decide").toBeGreaterThan(0);
    for (const f of fixtures) expect(await playToDecided(systemAuth(), f.id)).toMatchObject({ kind: "decided" });
  }

  it("lists this visitor's alive matches newest first, at most 5; a saved match (no expiry) is alive; the oldest drops off", async () => {
    const key = mintVisitorKey();
    const hash = hashVisitorKey(key);
    const rows: CreatedQuickMatch[] = [];
    // The create caps a visitor at 5 alive UNSAVED matches, so the first is saved (as plan 3's save leaves it: a user,
    // no expiry) before the sixth is made.
    rows.push(await make(hash));
    await sql`update quick_matches set saved_by_user_id = ${QUICK_MATCH_SYSTEM_USER_ID}, expires_at = null where id = ${rows[0]!.id}`;
    for (let i = 0; i < 5; i++) rows.push(await make(hash));
    // Created-at order differs from insert order: the saved one is the NEWEST, and the second insert the oldest.
    const dated: [CreatedQuickMatch, string][] = [
      [rows[0]!, "2026-11-08T12:00:00.000Z"],
      [rows[1]!, "2026-11-01T09:00:00.000Z"],
      [rows[2]!, "2026-11-07T09:00:00.000Z"],
      [rows[3]!, "2026-11-03T09:00:00.000Z"],
      [rows[4]!, "2026-11-06T09:00:00.000Z"],
      [rows[5]!, "2026-11-05T09:00:00.000Z"],
    ];
    for (const [out, at] of dated) await dateRow(out.id, at);
    const expected = [...dated].sort((a, b) => b[1].localeCompare(a[1])).slice(0, STRIP_CAP);

    jar.visitor = key;
    const html = await render();
    expect(stripHrefs(html)).toEqual(expected.map(([out]) => `/q/${out.token}`));
    expect(stripHrefs(html)).toHaveLength(STRIP_CAP);
    expect(stripHrefs(html)).not.toContain(`/q/${rows[1]!.token}`);
    // Each row reads its own name and its created date (D11).
    const strip = stripOf(html)!;
    for (const [out, at] of expected) {
      expect(strip).toContain(`>${await nameOf(out.id)}<`);
      expect(strip).toContain(`<time dateTime="${at}"`);
    }
    expect(strip).toContain(enMarketing["quickMatch.recent.title"]);
    expect(jar.set, "reading never mints a cookie").not.toHaveBeenCalled();
  });

  it("the setup page `/<lang>/play` shows the same strip from the same cookie (its second mount, Task 4's stub wired)", async () => {
    // A FINISHED match: an unfinished one is the setup page's Continue card instead (owner 2026-11-12, cases below).
    const key = mintVisitorKey();
    const out = await make(hashVisitorKey(key));
    await finish(out);
    jar.visitor = key;
    const html = await render("en", "play");
    expect(stripHrefs(html)).toEqual([`/q/${out.token}`]);
    expect(stripOf(html)).toContain(`>${await nameOf(out.id)}<`);
    expect(cardOf(html), "a finished match is never the Continue card").toBeNull();
    jar.visitor = undefined;
    expect(stripOf(await render("en", "play")), "no cookie, no strip").toBeNull();
  });

  it("a damaged NEWEST row does not cost a place: six live rows, the newest skipped, the other five shown (m1)", async () => {
    const key = mintVisitorKey();
    const hash = hashVisitorKey(key);
    const rows: CreatedQuickMatch[] = [];
    // Past the create's cap of 5 alive unsaved rows: the first is saved (no expiry) before the sixth is made.
    rows.push(await make(hash));
    await sql`update quick_matches set saved_by_user_id = ${QUICK_MATCH_SYSTEM_USER_ID}, expires_at = null where id = ${rows[0]!.id}`;
    for (let i = 0; i < 5; i++) rows.push(await make(hash));
    const dated: [CreatedQuickMatch, string][] = rows.map((out, i) => [out, `2026-11-0${i + 1}T09:00:00.000Z`]);
    for (const [out, at] of dated) await dateRow(out.id, at);
    const newest = rows[5]!;
    await sql`update quick_matches set token_enc = '\\x0102'::bytea where id = ${newest.id}`;
    jar.visitor = key;
    const hrefs = stripHrefs(await render());
    const expected = [...dated].sort((a, b) => b[1].localeCompare(a[1])).filter(([out]) => out !== newest).map(([out]) => `/q/${out.token}`);
    expect(expected).toHaveLength(STRIP_CAP);
    expect(hrefs).toEqual(expected);
    expect(hrefs).not.toContain(`/q/${newest.token}`);
  });

  it("an expired match is not listed; the alive one beside it is", async () => {
    const key = mintVisitorKey();
    const alive = await make(hashVisitorKey(key));
    const expired = await make(hashVisitorKey(key));
    await sql`update quick_matches set expires_at = now() - interval '1 minute' where id = ${expired.id}`;
    jar.visitor = key;
    const hrefs = stripHrefs(await render());
    expect(hrefs).toEqual([`/q/${alive.token}`]);
    expect(hrefs).not.toContain(`/q/${expired.token}`);
  });

  it("another visitor's matches are never listed", async () => {
    const mine = mintVisitorKey();
    const theirs = mintVisitorKey();
    const own = await make(hashVisitorKey(mine));
    const other = await make(hashVisitorKey(theirs));
    jar.visitor = mine;
    const html = await render();
    expect(stripHrefs(html)).toEqual([`/q/${own.token}`]);
    expect(html).not.toContain(other.token);
    jar.visitor = theirs;
    expect(stripHrefs(await render())).toEqual([`/q/${other.token}`]);
  });

  it("a malformed cookie is never trusted, even when its hash names rows", async () => {
    // A row keyed by the hash of a value that is NOT a visitor key: a guard that hashed whatever arrived would list it.
    const forged = `qv_${"z".repeat(10)}`;
    const planted = await make(hashVisitorKey(forged));
    jar.visitor = forged;
    const html = await render();
    expect(stripOf(html)).toBeNull();
    expect(html).not.toContain(planted.token);
  });

  it("a visitor with no alive match sees no strip (all expired)", async () => {
    const key = mintVisitorKey();
    const gone = await make(hashVisitorKey(key));
    await sql`update quick_matches set expires_at = now() - interval '1 day' where id = ${gone.id}`;
    jar.visitor = key;
    const html = await render();
    expect(stripOf(html)).toBeNull();
    expect(ctaButton(html, enMarketing["quickMatch.cta"])).toBeDefined();
  });

  it("DEVICE_LINK_KEK unset: the CTA renders, the strip does not, no 500, and one warning names why", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const key = mintVisitorKey();
    const out = await make(hashVisitorKey(key));
    jar.visitor = key;
    vi.stubEnv("DEVICE_LINK_KEK", "");
    const html = await render();
    expect(stripOf(html)).toBeNull();
    expect(html).not.toContain(out.token);
    expect(ctaButton(html, enMarketing["quickMatch.cta"])).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0]![0])).toContain("kek_missing");
    // The positive pair: the same visitor under the key sees the row.
    vi.stubEnv("DEVICE_LINK_KEK", KEK);
    expect(stripHrefs(await render())).toEqual([`/q/${out.token}`]);
  });

  it("damaged rows are skipped, the others shown: a too-short envelope and one that does not authenticate", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const key = mintVisitorKey();
    const hash = hashVisitorKey(key);
    const first = await make(hash);
    const malformed = await make(hash);
    const rejected = await make(hash);
    const last = await make(hash);
    await dateRow(first.id, "2026-11-01T09:00:00.000Z");
    await dateRow(malformed.id, "2026-11-02T09:00:00.000Z");
    await dateRow(rejected.id, "2026-11-03T09:00:00.000Z");
    await dateRow(last.id, "2026-11-04T09:00:00.000Z");
    await sql`update quick_matches set token_enc = '\\x0102'::bytea where id = ${malformed.id}`;
    // Flip the envelope's last byte (inside the GCM tag): still an envelope's shape, but it no longer authenticates.
    await sql`update quick_matches set token_enc = set_byte(token_enc, length(token_enc) - 1, get_byte(token_enc, length(token_enc) - 1) # 255)
              where id = ${rejected.id}`;
    jar.visitor = key;
    const html = await render();
    expect(stripHrefs(html)).toEqual([`/q/${last.token}`, `/q/${first.token}`]);
    expect(html).not.toContain(malformed.token);
    expect(html).not.toContain(rejected.token);
    // One warning for the read, naming both reasons; never a token.
    expect(warn).toHaveBeenCalledTimes(1);
    const said = JSON.stringify(warn.mock.calls[0]);
    expect(said).toContain("malformed");
    expect(said).toContain("rejected");
    for (const out of [first, malformed, rejected, last]) expect(said).not.toContain(out.token);
  });

  // ── the setup page's Continue card (owner 2026-11-12: "if same browser tries to create one more, show the first one") ──

  it("an unfinished match is met FIRST: the card (its name, its count, Continue to its home), then 'Or start a new quick match', then the form; it leaves the strip", async () => {
    const key = mintVisitorKey();
    // Three sides, once: the rulebook's 3·2/2 = 3 matches; one decided, so the count is the real fixtures', not a default.
    const out = await make(hashVisitorKey(key), `QM continue ${randomUUID().slice(0, 8)}`, ["Ravi", "Sam", "Lee"]);
    await finish(out, 1);
    jar.visitor = key;
    const html = await render("en", "play");
    const card = cardOf(html);
    expect(card, "the card is on the page").not.toBeNull();
    expect(card).toMatch(new RegExp(`<h2\\b[^>]*>${await nameOf(out.id)}</h2>`));
    expect(card).toContain(">1 of 3 matches played<");
    expect([...card!.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1], m[2]])).toEqual([
      [`/q/${out.token}`, "Continue"],
    ]);
    // The order a guest meets them in: the card, the heading, the form; the form is never withheld.
    const order = ["qm-continue", "qm-start-new", "qm-setup-form"].map((id) => at(html, id));
    expect(order.every((i) => i >= 0), `all three are on the page: ${order}`).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain(`>${enMarketing["quickMatch.continue.startNew"]}<`);
    // Its one row is the card now, so there is no strip; the marketing home still lists it (the card is the setup page's).
    expect(stripOf(html)).toBeNull();
    expect(stripHrefs(await render("en", "home"))).toEqual([`/q/${out.token}`]);
    expect(cardOf(await render("en", "home")), "the marketing home has no card").toBeNull();
  });

  it("several: the NEWEST unfinished match is the card; a newer finished one and an older unfinished one stay in the strip, newest first", async () => {
    const key = mintVisitorKey();
    const hash = hashVisitorKey(key);
    const olderOpen = await make(hash);
    const newerOpen = await make(hash);
    const newestDone = await make(hash);
    await finish(newestDone);
    await dateRow(olderOpen.id, "2026-11-01T09:00:00.000Z");
    await dateRow(newerOpen.id, "2026-11-03T09:00:00.000Z");
    await dateRow(newestDone.id, "2026-11-05T09:00:00.000Z");
    jar.visitor = key;
    const html = await render("en", "play");
    expect(cardOf(html)).toContain(`href="/q/${newerOpen.token}"`);
    expect(cardOf(html)).toContain(">0 of 1 match played<");
    expect(stripHrefs(html)).toEqual([`/q/${newestDone.token}`, `/q/${olderOpen.token}`]);
  });

  it("no card: only finished matches (they stay in the strip), and no cookie at all; neither has the 'start a new one' heading", async () => {
    const key = mintVisitorKey();
    const done = await make(hashVisitorKey(key));
    await finish(done);
    jar.visitor = key;
    const finishedOnly = await render("en", "play");
    expect(cardOf(finishedOnly)).toBeNull();
    expect(at(finishedOnly, "qm-start-new")).toBe(-1);
    expect(stripHrefs(finishedOnly)).toEqual([`/q/${done.token}`]);
    jar.visitor = undefined;
    const none = await render("en", "play");
    expect(cardOf(none)).toBeNull();
    expect(at(none, "qm-start-new")).toBe(-1);
    expect(at(none, "qm-setup-form"), "the form is there either way").toBeGreaterThan(-1);
  });

  // Review m3 (controller ruling 2026-11-13): the card is the NEWEST match that is unfinished and not expired, saved or not.
  it("the sequence: a finished match is no card; a void of its deciding event makes it unfinished, and it comes back as the card", async () => {
    const key = mintVisitorKey();
    const out = await make(hashVisitorKey(key));
    const [only] = await seated(out);
    expect(only, "premise: two sides, once: one match").toBeDefined();
    const r = await playToDecided(systemAuth(), only!.id);
    if (r.kind !== "decided") throw new Error(`premise: the match decides, got ${JSON.stringify(r)}`);
    jar.visitor = key;
    const done = await render("en", "play");
    expect(cardOf(done), "decided: no card").toBeNull();
    expect(stripHrefs(done)).toEqual([`/q/${out.token}`]);
    // The real write path's void of the deciding event (quick-match-home.test.ts's sequence): the match is open again.
    await scoreEvent(systemAuth(), only!.id, { expected_seq: r.lastSeq, type: "core.void", payload: { event_id: r.lastEventId } });
    const reopened = await render("en", "play");
    expect(cardOf(reopened), "voided: the card again").toContain(`href="/q/${out.token}"`);
    expect(cardOf(reopened)).toContain(">0 of 1 match played<");
    expect(stripOf(reopened), "its one row is the card").toBeNull();
  });

  it("saved or not: a SAVED unfinished match (no expiry) is the card; a newer unfinished one that has EXPIRED never is", async () => {
    const key = mintVisitorKey();
    const hash = hashVisitorKey(key);
    const saved = await make(hash);
    const expired = await make(hash);
    // Saved as plan 3's save leaves it (a user, no expiry); the newer one is past its expiry (the sweep has not run yet).
    await sql`update quick_matches set saved_by_user_id = ${QUICK_MATCH_SYSTEM_USER_ID}, expires_at = null where id = ${saved.id}`;
    await sql`update quick_matches set expires_at = now() - interval '1 minute' where id = ${expired.id}`;
    await dateRow(saved.id, "2026-11-03T09:00:00.000Z");
    await dateRow(expired.id, "2026-11-05T09:00:00.000Z");
    jar.visitor = key;
    const html = await render("en", "play");
    expect(cardOf(html)).toContain(`href="/q/${saved.token}"`);
    expect(html, "the expired match is nowhere on the page").not.toContain(`/q/${expired.token}`);
    expect(stripOf(html)).toBeNull();
  });

  // Review m5 (controller ruling 2026-11-13): only the setup page shows a match's played count (the Continue card), so only
  // it pays the fixture read; the marketing home's strip (name and date) reads the matches and nothing else.
  it("the marketing home's strip runs no fixture read; the setup page's does (its Continue card's count)", async () => {
    const key = mintVisitorKey();
    const out = await make(hashVisitorKey(key));
    jar.visitor = key;
    const fixtureReads = (texts: string[]) => texts.filter((q) => /\bfrom fixtures\b/i.test(q));
    /** The page's HTML and the system org's queries its render ran. */
    async function recorded(page: "home" | "play"): Promise<{ html: string; texts: string[] }> {
      const texts: string[] = [];
      systemQueries.texts = texts;
      try {
        return { html: await render("en", page), texts };
      } finally {
        systemQueries.texts = null;
      }
    }

    const home = await recorded("home");
    expect(stripHrefs(home.html), "the home's strip still lists the match").toEqual([`/q/${out.token}`]);
    expect(home.texts.some((q) => /\bfrom quick_matches\b/i.test(q)), "anti-vacuity: the recorder saw the strip's read").toBe(true);
    expect(fixtureReads(home.texts), "the home reads no fixture").toEqual([]);

    const play = await recorded("play");
    expect(cardOf(play.html), "the setup page's card has its count").toContain(">0 of 1 match played<");
    expect(fixtureReads(play.texts), "the setup page reads the fixtures, once").toHaveLength(1);
  });

  it("speaks the page's language: French Continue and heading", async () => {
    const key = mintVisitorKey();
    const out = await make(hashVisitorKey(key));
    jar.visitor = key;
    const html = await render("fr", "play");
    expect(cardOf(html)).toMatch(new RegExp(`href="/q/${out.token}"[^>]*>${frMarketing["quickMatch.continue.action"]}</a>`));
    expect(html).toContain(`>${frMarketing["quickMatch.continue.startNew"]}<`);
    expect(frMarketing["quickMatch.continue.action"]).not.toBe(enMarketing["quickMatch.continue.action"]);
  });
});
