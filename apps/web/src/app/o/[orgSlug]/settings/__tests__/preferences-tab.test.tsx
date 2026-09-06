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
  hasFeature, hasFeatureOnAnyPass, orgPlanKey, requireOrgPage, getUserOrgs,
  resolveLocale, preferredCurrency, walletIdFor, balance,
} = vi.hoisted(() => ({
  hasFeature: vi.fn(),
  hasFeatureOnAnyPass: vi.fn(),
  orgPlanKey: vi.fn(),
  requireOrgPage: vi.fn(),
  getUserOrgs: vi.fn(),
  resolveLocale: vi.fn(),
  preferredCurrency: vi.fn(),
  walletIdFor: vi.fn(),
  balance: vi.fn(),
}));

// One tagged-template mock serves both callers: the organisation tab's
// `select about …` and the preferences tab's `select s.currency …`. Each
// destructures `[row]` and reads its own field, so a single row carrying both
// is not a fudge — it is the union of what the two queries return.
const sqlRow = {
  about: null as string | null,
  // The subscription probe.
  currency: null as string | null,
  // The org-defaults probe (`select default_locale, currency, …`) reads
  // `currency` too — the same field, and deliberately: the subscription's
  // billing currency and the org's entry-fee currency are DIFFERENT facts that
  // happen to share a column name, and a test row that conflates them would
  // pass while the page read the wrong one. Cases that care set them apart via
  // `orgRow`.
  default_locale: null as string | null,
  stripe_account_id: null as string | null,
  stripe_unsupported_currency: null as string | null,
};
/** Overrides applied to the org-defaults SELECT only (matched on its text). */
const orgRow: Record<string, unknown> = {};
vi.mock("@/lib/db", () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join("") : "";
    if (text.includes("default_locale")) return [{ ...sqlRow, ...orgRow }];
    return [sqlRow];
  }),
}));
vi.mock("@/lib/entitlements", () => ({ hasFeature, hasFeatureOnAnyPass, orgPlanKey }));
vi.mock("@/lib/credits", () => ({ walletIdFor, balance }));
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
vi.mock("@/components/org-public-language", () => ({
  OrgPublicLanguage: ({ initialLocale }: { initialLocale: string }) => (
    <div data-testid="org-language" data-locale={initialLocale} />
  ),
}));
vi.mock("@/components/org-registration-currency", () => ({
  OrgRegistrationCurrency: ({
    initialCurrency,
    lockedTo,
  }: {
    initialCurrency: string;
    lockedTo: string | null;
  }) => (
    <div
      data-testid="org-reg-currency"
      data-current={initialCurrency}
      data-locked={lockedTo ?? "no"}
    />
  ),
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
  sqlRow.default_locale = null;
  sqlRow.stripe_account_id = null;
  sqlRow.stripe_unsupported_currency = null;
  for (const k of Object.keys(orgRow)) delete orgRow[k];
  orgPlanKey.mockResolvedValue("pro");
  walletIdFor.mockResolvedValue("w1");
  balance.mockResolvedValue(42);
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
  it("mounts all seven controls", async () => {
    const html = await render("preferences");

    expect(html).toContain("my-timezone");
    expect(html).toContain("my-language");
    expect(html).toContain("my-currency");
    expect(html).toContain("org-timezone");
    expect(html).toContain("org-language");
    expect(html).toContain("org-reg-currency");
    expect(html).toContain("cookie-settings");
  });

  it("seeds the org language from the column, not from the viewer's locale", async () => {
    // The bug this pins: reading resolveLocale() (the CONSOLE language, "en"
    // here) instead of organizations.default_locale would render a picker
    // showing English for a club whose public pages are already French, and
    // saving it would silently rewrite them.
    orgRow.default_locale = "fr";
    expect(await render("preferences")).toContain('data-locale="fr"');
  });

  it("falls back to English when the org has never set one", async () => {
    orgRow.default_locale = null;
    expect(await render("preferences")).toContain('data-locale="en"');
  });

  it("seeds the entry-fee currency from the ORG column, not the subscription's", async () => {
    // Different facts, same column name. The subscription bills in EUR; the
    // club charges entrants in INR.
    sqlRow.currency = "eur";
    orgRow.currency = "inr";
    const html = await render("preferences");

    expect(html).toContain('data-current="inr"');
    expect(html).toContain("billed in EUR");
  });

  it("leaves the entry-fee currency unlocked while no Stripe account is attached", async () => {
    orgRow.stripe_account_id = null;
    expect(await render("preferences")).toContain('data-locked="no"');
  });

  it("locks the entry-fee currency to the settlement currency once connected", async () => {
    // V365's same-currency rule: syncConnectAccount re-mirrors this column on
    // every sync, so an editable control here would save and then revert.
    orgRow.stripe_account_id = "acct_123";
    orgRow.currency = "inr";
    expect(await render("preferences")).toContain('data-locked="inr"');
  });

  it("names the UNSUPPORTED settlement code when the account settles outside the allowlist", async () => {
    // Then `currency` was left alone, so echoing it would name the wrong code.
    orgRow.stripe_account_id = "acct_123";
    orgRow.currency = "gbp";
    orgRow.stripe_unsupported_currency = "sek";
    const html = await render("preferences");

    expect(html).toContain('data-locked="sek"');
    expect(html).not.toContain('data-locked="gbp"');
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
