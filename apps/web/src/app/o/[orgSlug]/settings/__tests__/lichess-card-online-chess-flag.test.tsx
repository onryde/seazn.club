// T20 — Settings → Account: the "Link Lichess account" card is how a player STARTS online chess, so it is shown only
// while the club is offered online chess (the PostHog flag `online-chess`, fallback off). Not rendered — never
// rendered-and-disabled — when off. One exception, and it is not a start: a player who already linked keeps the card,
// so they can still UNLINK.
//
// Drives the REAL page (an async server component, so `prerender`) with the flag asked through the REAL helper and
// PostHog doubled at its boundary. Same page harness as preferences-tab.test.tsx: islands stubbed to markers, `sql`
// to one row. The card itself is a marker carrying the props the page handed it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
// The link read is doubled; the grant predicate (`lichessGrantPlays`, the play gate's own) stays REAL.
vi.mock("@/server/usecases/external-accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/external-accounts")>();
  return { ...actual, getLichessLink };
});
vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled };
});

vi.mock("@/components/lichess-link-card", () => ({
  LichessLinkCard: (p: { orgSlug: string | null; linkedUsername: string | null; configured: boolean; needsReconsent?: boolean }) => (
    <div
      data-testid="lichess-card"
      data-org={p.orgSlug ?? "none"}
      data-linked={p.linkedUsername ?? ""}
      data-reconsent={String(p.needsReconsent ?? false)}
    />
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
import { PLAY_SCOPES } from "@/server/usecases/external-accounts";
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

async function render(tab: string, lichess?: string): Promise<string> {
  const element = await SettingsPage({
    params: Promise.resolve({ orgSlug: ORG.slug }),
    searchParams: Promise.resolve(lichess === undefined ? { tab } : { tab, lichess }),
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
const linkedAs = (username: string | null, scopes: string[] = [...PLAY_SCOPES]) =>
  getLichessLink.mockResolvedValue(
    username ? { externalUserId: username.toLowerCase(), username, scopes, consentedAt: new Date() } : null,
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

  it("T16: linked with a grant short of the play scopes asks for re-consent; the re-link names the club only while it is offered", async () => {
    let checked = 0;
    for (const s of FLAG_STATES) {
      flagIs(s);
      linkedAs("Magnus", PLAY_SCOPES.slice(1));
      const html = await render("account");
      expect(html, s.label).toContain('data-reconsent="true"');
      expect(html, s.label).toContain(`data-org="${s.offered ? ORG.slug : "none"}"`);
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length);
    linkedAs("Magnus");
    flagIs(FLAG_STATES[0]!);
    expect(await render("account"), "a full grant: nothing to re-consent").toContain('data-reconsent="false"');
  });

  it("another tab neither shows the card nor asks the flag", async () => {
    flagIs(FLAG_STATES[0]!);
    const html = await render("organization");
    expect(html).toContain(ORG.name);
    expect(html).not.toContain('data-testid="lichess-card"');
    expect(isServerFeatureEnabled).not.toHaveBeenCalled();
  });
});

// Fix round 1, m5: a refused start lands back here (the card's `next`) with `?lichess=unavailable`. The page says so in
// the reader's language — the sentence read from each locale's own dictionary, never typed here.
describe("Settings → Account: a refused Lichess start is explained, in every locale", () => {
  const LOCALES = ["en", "es", "fr", "nl"] as const;
  const DICTS = Object.fromEntries(
    LOCALES.map((l) => [
      l,
      JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Record<string, string>,
    ]),
  ) as Record<(typeof LOCALES)[number], Record<string, string>>;
  /** React's text escaping, so a sentence with an apostrophe is compared as the markup carries it. */
  const escaped = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

  it("?lichess=unavailable renders that locale's sentence in the flash", async () => {
    let checked = 0;
    for (const loc of LOCALES) {
      resolveLocale.mockResolvedValue(loc);
      flagIs(FLAG_STATES[1]!);
      const sentence = DICTS[loc]["settings.account.lichess.flash.unavailable"];
      expect(typeof sentence === "string" && sentence.length > 0, `${loc}: the key exists`).toBe(true);
      const html = await render("account", "unavailable");
      expect(html, loc).toContain('data-testid="lichess-flash"');
      expect(html, loc).toContain(escaped(sentence!));
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
    // The locales really differ, so a page stuck on English could not pass the loop above.
    expect(new Set(LOCALES.map((l) => DICTS[l]["settings.account.lichess.flash.unavailable"])).size).toBe(LOCALES.length);
  });

  it("a value that is not one of the flow's outcomes renders no flash", async () => {
    flagIs(FLAG_STATES[1]!);
    const html = await render("account", "pwned<script>");
    expect(html).toContain("owner@example.com");
    expect(html).not.toContain('data-testid="lichess-flash"');
  });
});
