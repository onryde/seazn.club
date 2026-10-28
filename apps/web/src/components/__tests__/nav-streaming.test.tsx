// The console nav's Streaming item (owner, 2026-10-27: Streaming is its own top-nav page, between Directory and Settings).
//
// It is shown to exactly the orgs the page exists for — `streamingPageOffered`, the ONE predicate the page, the nav and the connect
// start ask — evaluated for the org the chrome is showing. Run through the REAL predicate (real `relayOffer`, real relay drivers),
// so a nav that read a different question would disagree with the page and be caught here. What a unit test cannot see — whether
// five items FIT the gantry at 640-1023 and on a 320 phone — is measured in a browser, not here (see the report / mobile.spec).
//
// prerender, not renderToStaticMarkup: Nav is an async server component.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prerender } from "react-dom/static";

const m = vi.hoisted(() => ({
  hasFeature: vi.fn<(orgId: string, key: string, competitionId?: string) => Promise<boolean>>(),
  getCurrentUser: vi.fn(),
  getUserOrgs: vi.fn(),
  getActiveOrgId: vi.fn(),
  hasClaimedProfile: vi.fn(async () => false),
  captureError: vi.fn(),
  locale: { value: "en" as string },
}));

vi.mock("@/lib/entitlements", () => ({ hasFeature: m.hasFeature, orgPlanKey: async () => "pro" }));
vi.mock("@/lib/sentry", () => ({ captureError: m.captureError }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: m.getCurrentUser, getUserOrgs: m.getUserOrgs, getActiveOrgId: m.getActiveOrgId }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => m.locale.value }));
vi.mock("@/server/usecases/me", () => ({ hasClaimedProfile: m.hasClaimedProfile }));
vi.mock("@/lib/activation", () => ({ needsTourAfterOnboarding: async () => false }));
vi.mock("@/server/usecases/competitions", () => ({ hasAnyCompetitions: async () => false }));
// Client islands → nothing (they are not what this file is about) — except the REAL Sign-out button, which the gantry-budget tests
// below read in the nav's own markup (its router hook is the only thing it needs).
vi.mock("@/components/help-menu", () => ({ HelpMenu: () => null }));
vi.mock("@/components/product-tour", () => ({ ProductTour: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/streaming" }));

import { Nav } from "../nav";
import { LOCALES } from "@/lib/i18n-constants";
import { disabledRelayDrivers, setRelayDriversForTest } from "@/server/relay/drivers";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import dictEn from "@/dictionaries/en/console.json";
import dictEs from "@/dictionaries/es/console.json";
import dictFr from "@/dictionaries/fr/console.json";
import dictNl from "@/dictionaries/nl/console.json";

const ORG = { id: "org-active", name: "Riverside BC", slug: "riverside", role: "owner", logo_storage_path: null, logo_url: null };
const render = async (): Promise<string> => new Response((await prerender(await Nav())).prelude).text();
/** The nav item's anchor, or null. Anchored on `data-testid="nav-streaming"` and its `="` so an omitted prop cannot satisfy it. */
const streamingLink = (html: string): string | null => html.match(/<a[^>]*data-testid="nav-streaming"[^>]*>/)?.[0] ?? null;

beforeEach(() => {
  m.locale.value = "en";
  m.hasFeature.mockReset().mockResolvedValue(true);
  m.getCurrentUser.mockReset().mockResolvedValue({ id: "u-1", display_name: "Alex" });
  m.getUserOrgs.mockReset().mockResolvedValue([ORG]);
  m.getActiveOrgId.mockReset().mockResolvedValue(ORG.id);
  m.hasClaimedProfile.mockReset().mockResolvedValue(false);
  m.captureError.mockClear();
  setRelayDriversForTest({ ingest: new FakeIngest(), runner: new FakeRunner() });   // a deployment that can start a stream
});
afterEach(() => setRelayDriversForTest(null));

describe("Nav › Streaming item", () => {
  it("OFFERED: a link to /streaming, labelled, between Directory and Settings — the label hidden under md like its siblings, the aria-label always there", async () => {
    const html = await render();
    const a = streamingLink(html);
    expect(a, "the Streaming link is in the nav").not.toBeNull();
    expect(a).toContain('href="/streaming"');
    expect(a).toContain('aria-label="Streaming"');
    const at = (needle: string) => html.indexOf(needle);
    expect(at('href="/directory"')).toBeGreaterThan(-1);
    expect(at('href="/directory"'), "after Directory").toBeLessThan(at('data-testid="nav-streaming"'));
    expect(at('data-testid="nav-streaming"'), "before Settings").toBeLessThan(at('href="/o/riverside/settings"'));
    // The label collapses to the icon below `md`, exactly like Dashboard / Directory / Settings (the 4-link dual-role case uses `lg`).
    const label = html.slice(at('data-testid="nav-streaming"')).match(/<span class="([^"]*)">Streaming<\/span>/);
    expect(label?.[1]).toBe("hidden md:inline");
  });

  it("the label follows the dual-role rule too: a claimed player keeps `lg`, as every other label does", async () => {
    m.hasClaimedProfile.mockResolvedValue(true);
    const html = await render();
    const label = html.slice(html.indexOf('data-testid="nav-streaming"')).match(/<span class="([^"]*)">Streaming<\/span>/);
    expect(label?.[1]).toBe("hidden lg:inline");
  });

  it("asks the predicate for the org the chrome is SHOWING (both streaming keys, org-wide), not some other org", async () => {
    await render();
    expect(m.hasFeature.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      [ORG.id, "streaming.overlay", undefined], [ORG.id, "streaming.relay", undefined],
    ]);
  });

  it("NOT offered, for each of the three reasons the page would 404: no link — and the rest of the nav stays (a link that vanished with the whole nav would pass otherwise)", async () => {
    const reasons: [string, () => void][] = [
      ["streaming.overlay switched off", () => m.hasFeature.mockImplementation(async (_o, key) => key !== "streaming.overlay")],
      ["streaming.relay switched off", () => m.hasFeature.mockImplementation(async (_o, key) => key !== "streaming.relay")],
      ["the deployment cannot start a stream", () => setRelayDriversForTest(disabledRelayDrivers())],
    ];
    let checked = 0;
    for (const [why, apply] of reasons) {
      m.hasFeature.mockReset().mockResolvedValue(true);
      setRelayDriversForTest({ ingest: new FakeIngest(), runner: new FakeRunner() });
      apply();
      const html = await render();
      expect(streamingLink(html), why).toBeNull();
      expect(html, `${why}: Directory stays`).toContain('href="/directory"');
      expect(html, `${why}: Settings stays`).toContain('href="/o/riverside/settings"');
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("a failed entitlement read hides the item, reports once, and does NOT take the chrome down", async () => {
    const boom = new Error("db down");
    m.hasFeature.mockRejectedValue(boom);
    const html = await render();
    expect(streamingLink(html)).toBeNull();
    expect(html, "the rest of the nav rendered").toContain('href="/directory"');
    expect(m.captureError).toHaveBeenCalledTimes(1);
    expect(m.captureError).toHaveBeenCalledWith(boom, expect.objectContaining({ orgId: ORG.id, route: "nav.streaming_offered" }));
    // The next render, with the read healthy again, offers it: nothing was cached from the failure.
    m.hasFeature.mockReset().mockResolvedValue(true);
    expect(streamingLink(await render())).not.toBeNull();
  });

  it("signed out: no link, and nothing about streaming is read", async () => {
    m.getCurrentUser.mockResolvedValue(null);
    const html = await render();
    expect(streamingLink(html)).toBeNull();
    expect(m.hasFeature).not.toHaveBeenCalled();
  });

  it("signed in with no organisation yet: no link, and nothing is read for an org that does not exist", async () => {
    m.getUserOrgs.mockResolvedValue([]);
    const html = await render();
    expect(streamingLink(html)).toBeNull();
    expect(m.hasFeature).not.toHaveBeenCalled();
  });

  it("every locale has its own label (no English fallback leaking into es/fr/nl), and the rendered link carries it", async () => {
    const dicts = { en: dictEn, es: dictEs, fr: dictFr, nl: dictNl } as Record<string, Record<string, string>>;
    let checked = 0;
    for (const locale of LOCALES) {
      m.locale.value = locale;
      const label = dicts[locale]!["nav.streaming"];
      expect(typeof label, locale).toBe("string");
      expect(label!.length, locale).toBeGreaterThan(0);
      const a = streamingLink(await render());
      expect(a, locale).toContain(`aria-label="${label}"`);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });
});

// The gantry's width budget (T9 fix round 2, owner chose "tighten", 2026-10-28). Five items did not fit: Sign-out was pushed past the
// viewport at 320-335 (every locale), at fr 768-836 and nl 768, and with a claimed player at 350-389. What a unit test CAN pin is the
// markup that makes the measured budget true; that the budget really fits is measured in a browser at every width x locale x both
// navs (the report's table) and by the shots spec's gantry-fit test.
describe("Nav › the width budget", () => {
  const tokens = (cls: string | undefined): string[] => (cls ?? "").split(/\s+/).filter(Boolean);
  /** The class TOKENS of every nav link's own class attribute, in order (the <a>s inside <nav>). */
  const linkClasses = (html: string): string[][] => {
    const nav = html.match(/<nav class="[^"]*">([\s\S]*?)<\/nav>/)?.[1] ?? "";
    return [...nav.matchAll(/<a\b[^>]*\bclass="([^"]*)"/g)].map((x) => tokens(x[1]));
  };
  const labelClasses = (html: string): string[][] => {
    const nav = html.match(/<nav class="[^"]*">([\s\S]*?)<\/nav>/)?.[1] ?? "";
    return [...nav.matchAll(/<a\b[^>]*>[\s\S]*?<span class="([^"]*)">/g)].map((x) => tokens(x[1]));
  };
  /** The Sign-out button as the NAV renders it: its attributes and its label span's classes. */
  const signOut = (html: string) => {
    const b = html.match(/<button\b([^>]*)>([\s\S]*?)<\/button>/);
    return {
      aria: b?.[1]?.match(/\baria-label="([^"]*)"/)?.[1],
      title: b?.[1]?.match(/\btitle="([^"]*)"/)?.[1],
      labelClass: tokens(b?.[2]?.match(/<span class="([^"]*)">/)?.[1]),
      labelText: b?.[2]?.match(/<span class="[^"]*">([^<]*)<\/span>/)?.[1],
    };
  };
  const dicts = { en: dictEn, es: dictEs, fr: dictFr, nl: dictNl } as Record<string, Record<string, string>>;

  it("Sign-out shows its ICON only below lg: the label span is `hidden` and appears at `lg:` — and the accessible name is the translated Sign out in all four locales", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      m.locale.value = locale;
      const expected = dicts[locale]!["nav.signOut"];
      expect(typeof expected, locale).toBe("string");
      const so = signOut(await render());
      expect(so.labelClass, `${locale}: hidden until lg`).toContain("hidden");
      expect(so.labelClass, `${locale}: the label returns at lg`).toContain("lg:inline");
      // Token checks: `sm:inline` would show the label from 640, `max-lg:`/`md:` variants would be a different rule altogether.
      expect(so.labelClass, `${locale}: not from sm (that is the 640-1023 band that overflowed)`).not.toContain("sm:inline");
      expect(so.labelClass, `${locale}: exactly the two tokens`).toEqual(["hidden", "lg:inline"]);
      expect(so.aria, `${locale}: the icon-only button is still named`).toBe(expected);
      expect(so.title, `${locale}: and still has its tooltip`).toBe(expected);
      expect(so.labelText, `${locale}: the visible label is the same words`).toBe(expected);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("the ACCESSIBLE NAME of Sign-out is a translation, not English: es/fr/nl differ from en", async () => {
    const names = new Set<string>();
    for (const locale of LOCALES) {
      m.locale.value = locale;
      names.add(signOut(await render()).aria ?? "");
    }
    expect(names.size, "four distinct names").toBe(4);
    expect(names.has(""), "none missing").toBe(false);
  });

  it("phones: every nav link takes 6px of side padding (px-1.5) until sm, and the links touch (gap-0) until sm — the 4-link org nav and the 5-link dual-role nav (nine links checked)", async () => {
    let checked = 0;
    for (const claimed of [false, true]) {
      m.hasClaimedProfile.mockResolvedValue(claimed);
      const html = await render();
      const links = linkClasses(html);
      expect(links.length, `claimed=${claimed}: 4 links, or 5 with Player home`).toBe(claimed ? 5 : 4);
      for (const l of links) {
        expect(l, "tightened on phones").toContain("px-1.5");
        expect(l, "not the old 8px").not.toContain("px-2");
        expect(l, "sm and up is untouched").toContain("sm:px-3");
        checked++;
      }
      const navTokens = tokens(html.match(/<nav class="([^"]*)">/)?.[1]);
      expect(navTokens, "no gap on phones").toContain("gap-0");
      expect(navTokens, "the old 2px gap returns at sm").toContain("sm:gap-0.5");
      expect(navTokens, "the bare old gap is gone").not.toContain("gap-0.5");
    }
    expect(checked, "anti-vacuity: nine links looked at").toBe(9);
  });

  it("tablets KEEP their labels: md..lg shows every label in the org nav (4), and the dual-role nav's five wait for lg (owner: no label dropped)", async () => {
    m.hasClaimedProfile.mockResolvedValue(false);
    const org = labelClasses(await render());
    expect(org.length).toBe(4);
    for (const l of org) expect(l).toEqual(["hidden", "md:inline"]);
    m.hasClaimedProfile.mockResolvedValue(true);
    const dual = labelClasses(await render());
    expect(dual.length).toBe(5);
    for (const l of dual) expect(l).toEqual(["hidden", "lg:inline"]);
  });
});
