// T20 — Settings → Account: the "Link Lichess account" card is how a player STARTS online chess, so it is shown only
// while the club is offered online chess (the PostHog flag `online-chess`, fallback off). Not rendered — never
// rendered-and-disabled — when off. One exception, and it is not a start: a player who already linked keeps the card,
// so they can still UNLINK.
//
// Drives the REAL page (an async server component, so `prerender`) with the flag asked through the REAL helper and
// PostHog doubled at its boundary. Same page harness as preferences-tab.test.tsx: islands stubbed to markers, `sql`
// to one row. The card itself is a marker carrying the props the page handed it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prerender } from "react-dom/static";

const {
  hasFeature, hasFeatureOnAnyPass, orgPlanKey, requireOrgPage, getUserOrgs,
  resolveLocale, preferredCurrency, walletIdFor, balance, getLichessLink, isServerFeatureEnabled,
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
  getLichessLink: vi.fn(),
  isServerFeatureEnabled: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ sql: vi.fn(async () => [{}]) }));
vi.mock("@/lib/entitlements", () => ({ hasFeature, hasFeatureOnAnyPass, orgPlanKey }));
vi.mock("@/lib/credits", () => ({ walletIdFor, balance }));
vi.mock("@/server/page-auth", () => ({ requireOrgPage }));
vi.mock("@/lib/auth", () => ({ getUserOrgs }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale }));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency }));
vi.mock("@/server/usecases/external-accounts", () => ({ getLichessLink }));
vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled };
});

vi.mock("@/components/lichess-link-card", () => ({
  LichessLinkCard: (p: { orgSlug: string; linkedUsername: string | null; configured: boolean }) => (
    <div data-testid="lichess-card" data-org={p.orgSlug} data-linked={p.linkedUsername ?? ""} />
  ),
}));
vi.mock("@/components/timezone-preference", () => ({ TimezonePreference: () => <div /> }));
vi.mock("@/components/locale-preference", () => ({ LocalePreference: () => <div /> }));
vi.mock("@/components/currency-switcher", () => ({ CurrencySwitcher: () => <div /> }));
vi.mock("@/components/cookie-settings-button", () => ({ CookieSettingsButton: () => <div /> }));
vi.mock("@/components/org-timezone", () => ({ OrgTimezone: () => <div /> }));
vi.mock("@/components/org-public-language", () => ({ OrgPublicLanguage: () => <div /> }));
vi.mock("@/components/org-registration-currency", () => ({ OrgRegistrationCurrency: () => <div /> }));
vi.mock("@/components/org-logo", () => ({ OrgLogo: () => <div /> }));
vi.mock("@/components/org-brand-color", () => ({ OrgBrandColor: () => <div /> }));
vi.mock("@/components/org-switcher", () => ({ OrgSwitcher: () => <div /> }));
vi.mock("@/components/org-rename", () => ({ OrgRename: () => <div /> }));
vi.mock("@/components/org-about", () => ({ OrgAbout: () => <div /> }));
vi.mock("@/components/tour-replay", () => ({ TourReplayButton: () => <div /> }));
vi.mock("@/components/api-keys", () => ({ ApiKeysPanel: () => <div /> }));
vi.mock("@/components/org-team", () => ({ OrgTeam: () => <div /> }));
vi.mock("@/components/account-actions", () => ({
  DisplayNameForm: () => <div />,
  ChangeEmailForm: () => <div />,
  LeaveOrgButton: () => <div />,
  TransferOwnerForm: () => <div />,
  DeleteAccountButton: () => <div />,
}));

import SettingsPage from "../page";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";

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

async function render(tab: string): Promise<string> {
  const element = await SettingsPage({
    params: Promise.resolve({ orgSlug: ORG.slug }),
    searchParams: Promise.resolve({ tab }),
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

type FlagState = { label: string; offered: boolean; arm: () => void };
const FLAG_STATES: readonly FlagState[] = [
  { label: "flag ON", offered: true, arm: () => isServerFeatureEnabled.mockResolvedValue(true) },
  { label: "flag OFF", offered: false, arm: () => isServerFeatureEnabled.mockResolvedValue(false) },
  { label: "PostHog throws", offered: false, arm: () => isServerFeatureEnabled.mockRejectedValue(new Error("down")) },
];
function flagIs(s: FlagState): void {
  vi.stubEnv("ONLINE_CHESS_ALWAYS", undefined);
  forgetOnlineChessFlagCache();
  isServerFeatureEnabled.mockReset();
  s.arm();
}
const linkedAs = (username: string | null) =>
  getLichessLink.mockResolvedValue(
    username ? { externalUserId: username.toLowerCase(), username, scopes: [], consentedAt: new Date() } : null,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("LICHESS_CLIENT_ID", "seazn-test");
  orgPlanKey.mockResolvedValue("pro");
  walletIdFor.mockResolvedValue("w1");
  balance.mockResolvedValue(0);
  requireOrgPage.mockResolvedValue({
    user: { id: "u1", email: "owner@example.com", display_name: "Owner", timezone: "Europe/London", locale: "en" },
    org: ORG,
    canEdit: true,
    auth: { orgId: ORG.id, via: "session", userId: "u1", role: "owner", keyId: null },
  });
  getUserOrgs.mockResolvedValue([ORG]);
  resolveLocale.mockResolvedValue("en");
  hasFeature.mockResolvedValue(false);
  hasFeatureOnAnyPass.mockResolvedValue(false);
  preferredCurrency.mockResolvedValue("gbp");
  linkedAs(null);
  forgetOnlineChessFlagCache();
  isServerFeatureEnabled.mockReset().mockRejectedValue(new Error("flag asked while the override was on"));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Settings → Account: the Lichess card follows the club's online-chess flag", () => {
  it("not linked: flag ON shows the card, for THIS club; flag OFF or PostHog throwing renders none", async () => {
    let checked = 0;
    for (const s of FLAG_STATES) {
      flagIs(s);
      const html = await render("account");
      // Anti-vacuity: the account tab really rendered, so an absent card is the gate's doing.
      expect(html, s.label).toContain("owner@example.com");
      if (s.offered) {
        expect(html, s.label).toContain('data-testid="lichess-card"');
        expect(html, `${s.label}: the link names the club whose page this is`).toContain(`data-org="${ORG.slug}"`);
      } else {
        expect(html, s.label).not.toContain('data-testid="lichess-card"');
      }
      expect(isServerFeatureEnabled, s.label).toHaveBeenCalledWith("online-chess", "u1", { orgId: ORG.id, fallback: false });
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length);
  });

  it("already linked with the flag OFF: the card stays, so the player can still unlink — unlinking starts nothing", async () => {
    linkedAs("Magnus");
    flagIs(FLAG_STATES[1]!);
    const html = await render("account");
    expect(html).toContain('data-testid="lichess-card"');
    expect(html).toContain('data-linked="Magnus"');
  });

  it("another tab neither shows the card nor asks the flag", async () => {
    flagIs(FLAG_STATES[0]!);
    const html = await render("organization");
    expect(html).toContain(ORG.name);
    expect(html).not.toContain('data-testid="lichess-card"');
    expect(isServerFeatureEnabled).not.toHaveBeenCalled();
  });
});
