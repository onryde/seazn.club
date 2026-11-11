// D23 — the settings page must gate the LOGO and the BRAND COLOUR on two
// different keys, because the resolver already does.
//
//   branding         org logo upload + display   → free for everyone (V310)
//   dashboard.theme  org THEME COLOUR            → Pro and above (V397)
//
// One flag drove both gates. V310 made `branding` free, so a Community org was
// handed a working colour picker whose value is stripped on the way out:
// server/public-site/data.ts wraps o.branding in
// `case when org_has_feature(o.id, '…') then … else '{}' end`.
// The org picks a colour, saves it, and nothing anywhere changes — the worst
// kind of gate, one that takes the input and silently discards it.
//
// The colour key CHANGED in W2 (entitlements v18 T17, owner ruling 2026-09-03).
// It was `dashboard.branding` until V397, which is the same key that removes the
// "Powered by seazn.club" badge — and V396 had just made badge removal
// enterprise-only. So a Pro org lost the picker AND the rendered colour in one
// step, for a perk it never asked to stop buying. `dashboard.branding` now
// means the badge and nothing else; the colour rides `dashboard.theme`.
//
// These render the real page with the resolver stubbed per key, so the test
// fails if the gates are ever collapsed back onto one flag.
//
// prerender, not renderToStaticMarkup: the page is an async server component
// (it awaits requireOrgPage, getDictionary, …) and the synchronous renderer
// cannot await those.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prerender } from "react-dom/static";

const { hasFeature, hasFeatureOnAnyPass, requireOrgPage, getUserOrgs, resolveLocale } = vi.hoisted(
  () => ({
    hasFeature: vi.fn(),
    hasFeatureOnAnyPass: vi.fn(),
    requireOrgPage: vi.fn(),
    getUserOrgs: vi.fn(),
    resolveLocale: vi.fn(),
  }),
);

// The organisation tab issues one `select about from organizations` — the
// tagged-template call has to return an awaitable array, not a query builder.
vi.mock("@/lib/db", () => ({
  sql: vi.fn(async () => [{ about: null }]),
}));
// The whole module is replaced, so every binding page.tsx imports has to be
// listed. `hasFeatureOnAnyPass` (the news tab's org-level `news.auto`
// affordance; the Sponsors tab that used to share it moved to the hub, R4 S11)
// is only reached with `?tab=news`, which these cases never pass — but an
// unmocked export is `undefined`, so the day someone adds a news case it
// would fail as "hasFeatureOnAnyPass is not a function" instead of on the
// assertion. Default it to a deny so the omission is never load-bearing.
vi.mock("@/lib/entitlements", () => ({ hasFeature, hasFeatureOnAnyPass }));
vi.mock("@/server/page-auth", () => ({ requireOrgPage }));
vi.mock("@/lib/auth", () => ({ getUserOrgs }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale }));

// Client islands: each is a router/state component in real life. Stub them to
// identifiable markers so "did this widget mount?" is an exact string check
// rather than a guess at some rendered input's class name.
vi.mock("@/components/org-logo", () => ({
  OrgLogo: () => <div data-testid="org-logo-uploader" />,
}));
// Settings C8 (owner 2026-11-11): the brand colour lives in the Organisation card (`OrgProfileCard`), which is
// rendered FOR REAL here — the page decides the gate, the card draws the picker (`data-testid="org-brand-color-picker"`)
// or the page's refusal, and stubbing the card would prove only the stub. It calls `useRouter`, which throws outside a
// mounted app router, so the router is stubbed (and `redirect`, which the page itself imports); the TipTap editor is
// stubbed because it needs a DOM.
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/o/riverside/settings",
}));
vi.mock("@/components/prose-editor", () => ({ ProseEditor: () => <div data-testid="about-editor" /> }));
vi.mock("@/components/org-timezone", () => ({ OrgTimezone: () => <div /> }));
vi.mock("@/components/org-public-language", () => ({ OrgPublicLanguage: () => <div /> }));
vi.mock("@/components/org-registration-currency", () => ({ OrgRegistrationCurrency: () => <div /> }));
vi.mock("@/components/tour-replay", () => ({
  TourReplayButton: () => <div data-testid="tour-replay" />,
}));
// The switcher left this page (switching is the account menu's and the breadcrumb's). A marker, so a re-mount reds.
vi.mock("@/components/org-switcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/org-switcher")>()),
  OrgSwitcher: () => <div data-testid="org-switcher-marker" />,
}));

import SettingsPage from "../page";

const ORG = {
  id: "org-1",
  name: "Riverside Community Club",
  slug: "riverside",
  role: "owner",
  logo_url: null,
  logo_storage_path: null,
  branding: {},
  timezone: "Europe/London",
};

async function render(tab?: string): Promise<string> {
  const element = await SettingsPage({
    params: Promise.resolve({ orgSlug: "riverside" }),
    searchParams: Promise.resolve(tab ? { tab } : {}),
  });
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

/** Resolve each feature key independently — the whole point of the split. */
function grant(features: Record<string, boolean>): void {
  hasFeature.mockImplementation(async (_orgId: string, key: string) => features[key] ?? false);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOrgPage.mockResolvedValue({
    user: { id: "u1", email: "owner@example.com", display_name: "Owner", timezone: null, locale: null },
    org: ORG,
    canEdit: true,
    auth: { orgId: ORG.id, via: "session", userId: "u1", role: "owner", keyId: null },
  });
  getUserOrgs.mockResolvedValue([ORG]);
  resolveLocale.mockResolvedValue("en");
  // Deny by default. These cases render the branding tab, which never asks;
  // stating it keeps the sponsors tab from inheriting an `undefined` answer.
  hasFeatureOnAnyPass.mockResolvedValue(false);
});

describe("settings → organisation: logo and brand colour are gated separately (D23)", () => {
  it("a Community org gets the logo uploader but NOT the colour picker", async () => {
    // V310's shipped matrix exactly: logos free, theme colour still paid.
    grant({ branding: true, "dashboard.theme": false });
    const html = await render();

    // Premise: the real Organisation card rendered (not an empty page that would pass every "absent" below).
    expect(html).toContain('data-testid="org-profile-card"');
    expect(html).toContain("org-logo-uploader");
    expect(html).not.toContain("org-brand-color-picker");
    // settings.upgrade.brandColor (dictionaries/en/ui.json:480) was dead code
    // the moment both gates read `branding`. This is it becoming reachable.
    expect(html).toContain("Brand color requires");
    // …and the logo refusal must NOT appear — logos are free now.
    expect(html).not.toContain("Your own logo is switched off for this organisation.");
  });

  it("a Pro org gets both — with the badge key OFF, as V396 leaves it", async () => {
    // The pairing that regressed: a Pro org has `dashboard.branding` FALSE
    // (the badge is shown on every self-serve plan) and must still get the
    // colour picker. Re-weld the two keys and this case fails — which is the
    // whole point of stating the badge key here rather than omitting it.
    grant({ branding: true, "dashboard.theme": true, "dashboard.branding": false });
    const html = await render();

    expect(html).toContain("org-logo-uploader");
    expect(html).toContain("org-brand-color-picker");
    expect(html).not.toContain("Brand color requires");
  });

  it("asks the resolver for dashboard.theme, not just branding", async () => {
    grant({ branding: true, "dashboard.theme": false });
    await render();

    const keys = hasFeature.mock.calls.map((c: unknown[]) => c[1]);
    expect(keys).toContain("branding");
    expect(keys).toContain("dashboard.theme");
    // …and it must NOT reach for the badge key here. Asking it would be
    // harmless today only because the stub answers false; in production it is
    // enterprise-only, so a page that consulted it would deny every Pro org.
    expect(keys).not.toContain("dashboard.branding");
  });

  // The inverse pairing can't happen from a plan row today, but it is what
  // proves the two gates are genuinely independent rather than one flag read
  // twice: colour on, logo off must render colour and say the logo is switched
  // off (a staff override — no plan sells it back).
  it("honours the keys independently when only dashboard.theme is granted", async () => {
    grant({ branding: false, "dashboard.theme": true });
    const html = await render();

    expect(html).not.toContain("org-logo-uploader");
    expect(html).toContain("Your own logo is switched off for this organisation.");
    expect(html).toContain("org-brand-color-picker");
  });
});

// Settings C8 (owner 2026-11-11, mock set11c01 O1): the Organisation tab is one card. Rendered with the REAL card, so
// what is asserted is what the page and the card produce together.
describe("settings → organisation: the C8 card", () => {
  it("one card, no org switcher, the defaults inside it, and the tour as a quiet link under it", async () => {
    grant({ branding: true, "dashboard.theme": true });
    const html = await render();
    expect(html).toContain('data-testid="org-profile-card"');
    expect(html).not.toContain("org-switcher-marker");
    expect(html).not.toContain('data-testid="org-identity-name"');
    // The defaults moved here from Preferences — into their OWN card, directly after the Organisation card (owner
    // 2026-11-11, option B), not inside its form.
    const profileAt = html.indexOf('data-testid="org-profile-card"');
    const defaultsAt = html.indexOf('data-testid="org-defaults"');
    expect(defaultsAt, "the defaults card is drawn").toBeGreaterThan(profileAt);
    const profileForm = html.slice(profileAt, html.indexOf("</form>", profileAt));
    expect(profileForm, "not inside the profile form").not.toContain('data-testid="org-defaults"');
    expect(html.slice(defaultsAt, html.indexOf("</section>", defaultsAt))).toContain(">Organisation defaults<");
    expect(html.indexOf('data-testid="tour-replay"'), "the tour link follows the defaults card").toBeGreaterThan(defaultsAt);
    expect(html).toContain('data-testid="tour-replay"');
    // The role badge stays beside the heading.
    expect(html).toContain(">Owner<");
  });

  it("the settings content wrapper has no 5xl cap: it is the nav bar's own width (6xl)", async () => {
    grant({ branding: true, "dashboard.theme": true });
    const html = await render();
    const wrappers = [...html.matchAll(/class="([^"]*\bmx-auto\b[^"]*)"/g)].map((m) => m[1]!.split(/\s+/));
    expect(wrappers.length, "anti-vacuity: the page draws a centred wrapper").toBeGreaterThan(0);
    expect(wrappers.some((c) => c.includes("max-w-6xl"))).toBe(true);
    for (const c of wrappers) expect(c, c.join(" ")).not.toContain("max-w-5xl");
  });

  // Owner 2026-11-11, option 1: the Organisation tab drops the left rail (its two cards take the full width) and shows
  // the SAME nav as the phone strip, above the content, at every width. `data-nav-shape` is the component's own
  // declaration of which shape it drew; the class assertions anchor on `="`/whitespace, because `md:hidden` also
  // matches inside `max-md:hidden`.
  it("the Organisation tab has the compact nav above the content and no rail", async () => {
    grant({ branding: true, "dashboard.theme": true });
    const shapeOf = (html: string) => [...html.matchAll(/data-nav-shape="(\w+)"/g)].map((m) => m[1]);
    const classOf = (html: string, needle: string) => {
      const at = html.indexOf(needle);
      expect(at, needle).toBeGreaterThan(-1);
      return html.slice(html.lastIndexOf('class="', at) + 7, html.indexOf('"', html.lastIndexOf('class="', at) + 7)).split(/\s+/);
    };

    const org = await render();
    expect(shapeOf(org), "exactly one nav, the strip").toEqual(["strip"]);
    expect(org).toContain('data-testid="org-profile-card"');
    expect(org, "no rail furniture (plan header, back link)").not.toContain("settings-nav-stream-credits");
    // The flex row that put the rail beside the content is gone on this tab.
    const wrapper = classOf(org, 'data-nav-shape="strip"');
    expect(wrapper.join(" ")).toBe("w-full");
    const row = org.slice(0, org.indexOf('data-nav-shape="strip"'));
    const rowClass = row.slice(row.lastIndexOf('class="flex flex-col gap-4'), row.lastIndexOf('class="flex flex-col gap-4') + 60);
    expect(rowClass).toMatch(/^class="flex flex-col gap-4"/);
    // Every other tab stays one tap away, from the strip: the Preferences link is in it, once.
    expect((org.match(/href="[^"]*settings\?tab=preferences"/g) ?? []).length).toBe(1);
  });

  it("View page points at the org's public page, opening a new tab", async () => {
    grant({ branding: true, "dashboard.theme": false });
    const html = await render();
    const at = html.indexOf('data-testid="org-view-page"');
    expect(at, "the link is drawn").toBeGreaterThan(-1);
    const tag = html.slice(html.lastIndexOf("<a", at), html.indexOf(">", at));
    expect(tag).toContain('href="/live/riverside"');
    expect(tag).toContain('target="_blank"');
  });

  it("a viewer: the card, read-only — no defaults, no tour, no Save", async () => {
    grant({ branding: true, "dashboard.theme": true });
    requireOrgPage.mockResolvedValue({
      user: { id: "u2", email: "viewer@example.com", display_name: "V", timezone: null, locale: null },
      org: { ...ORG, role: "viewer" },
      canEdit: false,
      auth: { orgId: ORG.id, via: "session", userId: "u2", role: "viewer", keyId: null },
    });
    const html = await render();
    expect(html).toContain('data-testid="org-profile-card"');
    expect(html).not.toContain('data-testid="org-defaults"');
    expect(html).not.toContain('data-testid="tour-replay"');
    expect(html).not.toContain('data-testid="settings-save-bar"');
    expect(html).toContain("Riverside Community Club");
  });
});
