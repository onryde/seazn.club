// Settings → Account: the "Link Lichess account" card is shown to EVERY signed-in player (owner 2026-11-18). Linking is
// the player's own — they can do it before any club offers online chess, so a club's PostHog flag `online-chess` no
// longer decides whether the card renders (it used to: T20, flag OFF or PostHog throwing rendered none, unless the
// player was already linked). The page asks the flag nothing, and hands the card no club, so its link starts none.
//
// Drives the REAL page (an async server component, so `prerender`) with PostHog doubled at its boundary — a call to it is
// a defect now, so the double counts them. Same page harness as preferences-tab.test.tsx: islands stubbed to markers, `sql`
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
  LichessLinkCard: (p: { linkedUsername: string | null; configured: boolean; needsReconsent?: boolean }) => (
    <div
      data-testid="lichess-card"
      data-props={Object.keys(p).sort().join(",")}
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
// Settings C8: rename, brand colour and About are one Organisation card (a router island, with its own suite). Stubbed
// to render what the page hands it: the name, the logo slot and the defaults slot.
vi.mock("@/components/org-profile-card", () => ({
  OrgProfileCard: (p: { initialName: string; logo?: import("react").ReactNode; defaults?: import("react").ReactNode }) => (
    <div data-testid="org-profile-card">
      <span>{p.initialName}</span>
      {p.logo}
      {p.defaults}
    </div>
  ),
}));
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

describe("Settings → Account: the Lichess card is shown to every signed-in player, whatever the club's flag says", () => {
  /** The override the suite runs under, plus every state of the flag: none of them may decide the card. */
  const WORLDS: readonly { label: string; arm: () => void }[] = [
    { label: "override ON", arm: () => undefined },
    ...FLAG_STATES.map((s) => ({ label: s.label, arm: () => flagIs(s) })),
  ];

  it("not linked: the card renders in every flag world, handed no club, and the flag is never asked", async () => {
    let checked = 0;
    for (const w of WORLDS) {
      w.arm();
      const html = await render("account");
      // Anti-vacuity: the account tab really rendered, so the card's presence is the rule's doing.
      expect(html, w.label).toContain("owner@example.com");
      expect(html, w.label).toContain('data-testid="lichess-card"');
      expect(html, `${w.label}: configured, linked-name and re-consent are the card's props`).toContain(
        'data-props="configured,linkedUsername,needsReconsent"',
      );
      expect(html, `${w.label}: the card is handed no club to start at`).not.toContain("orgSlug");
      expect(isServerFeatureEnabled, `${w.label}: online chess is none of this page's business`).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(WORLDS.length);
  });

  it("already linked, flag OFF: the card stays, so the player can still unlink", async () => {
    linkedAs("Magnus");
    flagIs(FLAG_STATES[1]!);
    const html = await render("account");
    expect(html).toContain('data-testid="lichess-card"');
    expect(html).toContain('data-linked="Magnus"');
  });

  it("T16: linked with a grant short of the play scopes asks for re-consent, in every flag world; a full grant does not", async () => {
    let checked = 0;
    for (const w of WORLDS) {
      w.arm();
      linkedAs("Magnus", PLAY_SCOPES.slice(1));
      const html = await render("account");
      expect(html, w.label).toContain('data-reconsent="true"');
      expect(html, w.label).toContain('data-linked="Magnus"');
      checked++;
    }
    expect(checked).toBe(WORLDS.length);
    linkedAs("Magnus");
    flagIs(FLAG_STATES[0]!);
    expect(await render("account"), "a full grant: nothing to re-consent").toContain('data-reconsent="false"');
  });

  it("another tab does not show the card (it is the account tab's), and asks the flag nothing", async () => {
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
