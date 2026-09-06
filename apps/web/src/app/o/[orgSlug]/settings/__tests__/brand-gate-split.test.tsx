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
// listed. `hasFeatureOnAnyPass` (the sponsors tab's org-level affordance) is
// only reached with `?tab=sponsors`, which these cases never pass — but an
// unmocked export is `undefined`, so the day someone adds a sponsors case it
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
vi.mock("@/components/org-brand-color", () => ({
  OrgBrandColor: () => <div data-testid="org-brand-color-picker" />,
}));
vi.mock("@/components/org-switcher", () => ({ OrgSwitcher: () => <div /> }));
vi.mock("@/components/org-rename", () => ({ OrgRename: () => <div /> }));
vi.mock("@/components/org-about", () => ({ OrgAbout: () => <div /> }));
vi.mock("@/components/org-timezone", () => ({ OrgTimezone: () => <div /> }));
vi.mock("@/components/tour-replay", () => ({ TourReplayButton: () => <div /> }));

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

async function render(): Promise<string> {
  const element = await SettingsPage({
    params: Promise.resolve({ orgSlug: "riverside" }),
    searchParams: Promise.resolve({}),
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

    expect(html).toContain("org-logo-uploader");
    expect(html).not.toContain("org-brand-color-picker");
    // settings.upgrade.brandColor (dictionaries/en/ui.json:480) was dead code
    // the moment both gates read `branding`. This is it becoming reachable.
    expect(html).toContain("Brand color requires");
    // …and the logo upsell must NOT appear — logos are free now.
    expect(html).not.toContain("Org logo requires");
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
  // twice: colour on, logo off must render colour and upsell the logo.
  it("honours the keys independently when only dashboard.theme is granted", async () => {
    grant({ branding: false, "dashboard.theme": true });
    const html = await render();

    expect(html).not.toContain("org-logo-uploader");
    expect(html).toContain("Org logo requires");
    expect(html).toContain("org-brand-color-picker");
  });
});
