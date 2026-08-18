// Settings → Preferences: the tab that collects everything which changes how
// the product READS rather than what it contains.
//
// Four of its five controls used to live somewhere else, and each move is a
// thing that can silently half-happen — the control appears in its new home
// while the old copy is still rendered on the old tab, so nothing looks broken
// and the org now has two timezone pickers. Every "moved" case below therefore
// asserts BOTH ends: present here, gone there.
//
// The currency picker carries a trap of its own. `preferredCurrency(orgId)`
// puts an existing subscription's currency ABOVE the cookie the picker writes
// (renewals must never switch currency), so passing the org id would render a
// control whose displayed value ignores the choice just made — it would look
// like a working picker and behave like a label. The call must pass null, and
// there is a case for that.
//
// prerender, not renderToStaticMarkup: the page is an async server component.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prerender } from "react-dom/static";

const {
  hasFeature, hasFeatureOnAnyPass, requireOrgPage, getUserOrgs, resolveLocale, preferredCurrency,
} = vi.hoisted(() => ({
  hasFeature: vi.fn(),
  hasFeatureOnAnyPass: vi.fn(),
  requireOrgPage: vi.fn(),
  getUserOrgs: vi.fn(),
  resolveLocale: vi.fn(),
  preferredCurrency: vi.fn(),
}));

// One tagged-template mock serves both callers: the organisation tab's
// `select about …` and the preferences tab's `select s.currency …`. Each
// destructures `[row]` and reads its own field, so a single row carrying both
// is not a fudge — it is the union of what the two queries return.
const sqlRow = { about: null as string | null, currency: null as string | null };
vi.mock("@/lib/db", () => ({ sql: vi.fn(async () => [sqlRow]) }));
vi.mock("@/lib/entitlements", () => ({ hasFeature, hasFeatureOnAnyPass }));
vi.mock("@/server/page-auth", () => ({ requireOrgPage }));
vi.mock("@/lib/auth", () => ({ getUserOrgs }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale }));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency }));

// Client islands stubbed to identifiable markers, so "did this widget mount?"
// is an exact string check rather than a guess at a rendered input's classes.
vi.mock("@/components/timezone-preference", () => ({
  TimezonePreference: () => <div data-testid="my-timezone" />,
}));
vi.mock("@/components/locale-preference", () => ({
  LocalePreference: () => <div data-testid="my-language" />,
}));
vi.mock("@/components/currency-switcher", () => ({
  CurrencySwitcher: ({ current }: { current: string }) => (
    <div data-testid="my-currency" data-current={current} />
  ),
}));
vi.mock("@/components/cookie-settings-button", () => ({
  CookieSettingsButton: () => <div data-testid="cookie-settings" />,
}));
vi.mock("@/components/org-timezone", () => ({
  OrgTimezone: () => <div data-testid="org-timezone" />,
}));
vi.mock("@/components/org-logo", () => ({ OrgLogo: () => <div /> }));
vi.mock("@/components/org-brand-color", () => ({ OrgBrandColor: () => <div /> }));
vi.mock("@/components/org-switcher", () => ({ OrgSwitcher: () => <div /> }));
vi.mock("@/components/org-rename", () => ({ OrgRename: () => <div /> }));
vi.mock("@/components/org-about", () => ({ OrgAbout: () => <div /> }));
vi.mock("@/components/tour-replay", () => ({ TourReplayButton: () => <div /> }));
vi.mock("@/components/api-keys", () => ({ ApiKeysPanel: () => <div /> }));
vi.mock("@/components/org-team", () => ({ OrgTeam: () => <div /> }));
// Account-tab islands: every one calls useRouter, which throws outside a
// mounted app router. The account cases here assert what is ABSENT, and an
// exception is not an absence.
vi.mock("@/components/account-actions", () => ({
  DisplayNameForm: () => <div />,
  ChangeEmailForm: () => <div />,
  LeaveOrgButton: () => <div />,
  TransferOwnerForm: () => <div />,
  DeleteAccountButton: () => <div />,
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

beforeEach(() => {
  vi.clearAllMocks();
  sqlRow.about = null;
  sqlRow.currency = null;
  requireOrgPage.mockResolvedValue({
    user: {
      id: "u1", email: "owner@example.com", display_name: "Owner",
      timezone: "Europe/London", locale: "en",
    },
    org: ORG,
    canEdit: true,
    auth: { orgId: ORG.id, via: "session", userId: "u1", role: "owner", keyId: null },
  });
  getUserOrgs.mockResolvedValue([ORG]);
  resolveLocale.mockResolvedValue("en");
  hasFeature.mockResolvedValue(false);
  hasFeatureOnAnyPass.mockResolvedValue(false);
  preferredCurrency.mockResolvedValue("gbp");
});

describe("settings → preferences", () => {
  it("mounts all five controls", async () => {
    const html = await render("preferences");

    expect(html).toContain("my-timezone");
    expect(html).toContain("my-language");
    expect(html).toContain("my-currency");
    expect(html).toContain("org-timezone");
    expect(html).toContain("cookie-settings");
  });

  it("resolves the display currency with a NULL org id, not the org's", async () => {
    await render("preferences");

    // Passing ORG.id here would subordinate the picker to the subscription's
    // currency and render a control that ignores its own cookie.
    expect(preferredCurrency).toHaveBeenCalledWith(null);
    expect(preferredCurrency).not.toHaveBeenCalledWith(ORG.id);
  });

  it("shows the picked currency, not a hardcoded default", async () => {
    preferredCurrency.mockResolvedValue("inr");
    expect(await render("preferences")).toContain('data-current="inr"');
  });

  it("says in words that a live subscription's currency outranks the picker", async () => {
    sqlRow.currency = "eur";
    const html = await render("preferences");
    // Without this sentence the control is not a preference, it is a lie.
    expect(html).toContain("billed in EUR");
  });

  it("stays quiet about billing currency when there is no subscription", async () => {
    sqlRow.currency = null;
    expect(await render("preferences")).not.toContain("billed in");
  });

  // ── the other half of every move ─────────────────────────────────────────
  it("the account tab no longer carries the personal timezone, language or cookie consent", async () => {
    const html = await render("account");

    expect(html).not.toContain("my-timezone");
    expect(html).not.toContain("my-language");
    expect(html).not.toContain("cookie-settings");
    // …and is still the account tab, so this is not a blank-render false pass.
    expect(html).toContain("owner@example.com");
  });

  it("the organisation tab no longer carries the scheduling timezone", async () => {
    const html = await render("organization");

    expect(html).not.toContain("org-timezone");
    expect(html).toContain("Riverside Community Club");
  });

  it("hides the org scheduling timezone from a member who cannot edit", async () => {
    requireOrgPage.mockResolvedValue({
      user: { id: "u2", email: "viewer@example.com", display_name: "V", timezone: null, locale: null },
      org: { ...ORG, role: "viewer" },
      canEdit: false,
      auth: { orgId: ORG.id, via: "session", userId: "u2", role: "viewer", keyId: null },
    });
    const html = await render("preferences");

    expect(html).not.toContain("org-timezone");
    // Their own preferences are still theirs to set.
    expect(html).toContain("my-timezone");
  });

  it("is reachable from the sidebar and marks itself current", async () => {
    const html = await render("preferences");

    expect(html).toContain("/o/riverside/settings?tab=preferences");
    expect(html).toContain('aria-current="page"');
  });

  it("falls back to the organisation tab for an unknown ?tab", async () => {
    const html = await render("preferencez");
    expect(html).toContain("Riverside Community Club");
    expect(html).not.toContain("my-currency");
  });
});
