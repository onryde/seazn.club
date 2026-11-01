// R4 sponsors-on-stream S11 - Settings dropped its Sponsors tab; `settings?tab=sponsors` redirects to the hub.
//
// WHY THIS IS ITS OWN FILE: the redirect has an ORDER that nothing else pins. Dropping "sponsors" from SETTINGS_TABS
// means the page's `SETTINGS_TABS.includes(rawTab) ? rawTab : "organization"` fallback now answers "organization" for
// it - so a redirect written AFTER that fallback never fires and a bookmarked Settings -> Sponsors link silently lands
// on the Organisation panel. The redirect must read the RAW tab, before the fallback; and after `requireOrgPage`, so a
// non-member still gets Settings' own refusal rather than being bounced to a hub that will refuse them again.
//
// redirect() throws a NEXT_REDIRECT error whose `digest` is `NEXT_REDIRECT;<type>;<url>;<status>;` - read from there.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prerender } from "react-dom/static";

const { hasFeature, hasFeatureOnAnyPass, requireOrgPage, getUserOrgs, resolveLocale } = vi.hoisted(() => ({
  hasFeature: vi.fn(),
  hasFeatureOnAnyPass: vi.fn(),
  requireOrgPage: vi.fn(),
  getUserOrgs: vi.fn(),
  resolveLocale: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ sql: vi.fn(async () => [{ about: null }]) }));
vi.mock("@/lib/entitlements", () => ({ hasFeature, hasFeatureOnAnyPass }));
vi.mock("@/server/page-auth", () => ({ requireOrgPage }));
vi.mock("@/lib/auth", () => ({ getUserOrgs }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale }));
vi.mock("@/components/org-logo", () => ({ OrgLogo: () => <div data-testid="org-logo-uploader" /> }));
vi.mock("@/components/org-brand-color", () => ({ OrgBrandColor: () => <div /> }));
vi.mock("@/components/org-switcher", () => ({ OrgSwitcher: () => <div /> }));
vi.mock("@/components/org-rename", () => ({ OrgRename: () => <div /> }));
vi.mock("@/components/org-about", () => ({ OrgAbout: () => <div /> }));
vi.mock("@/components/org-timezone", () => ({ OrgTimezone: () => <div /> }));
vi.mock("@/components/tour-replay", () => ({ TourReplayButton: () => <div /> }));
// The moved bodies. If the page still mounted either, this would show it.
vi.mock("@/components/org-sponsors", () => ({ OrgSponsors: () => <div data-testid="org-sponsors" /> }));
vi.mock("@/components/sponsor-packages", () => ({ SponsorPackages: () => <div data-testid="sponsor-packages-island" /> }));

import SettingsPage from "../page";
import { SETTINGS_TABS } from "../_components/settings-nav";

const ORG = {
  id: "org-1", name: "Riverside Community Club", slug: "riverside", role: "owner",
  logo_url: null, logo_storage_path: null, branding: {}, timezone: "Europe/London",
};

type SP = Record<string, string | string[] | undefined>;
async function renderSettings(searchParams: SP): Promise<string> {
  const element = await SettingsPage({
    params: Promise.resolve({ orgSlug: "riverside" }),
    searchParams: Promise.resolve(searchParams),
  });
  const { prelude } = await prerender(element);
  const reader = (prelude as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

/** What the page redirected to, or null if it rendered. The status is 307 (`redirect`, not `permanentRedirect`). */
async function redirectedTo(searchParams: SP): Promise<{ url: string; status: string } | null> {
  try {
    await renderSettings(searchParams);
    return null;
  } catch (err) {
    const digest = (err as { digest?: unknown }).digest;
    if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT;")) throw err;
    const [, , url, status] = digest.split(";");
    return { url: url!, status: status! };
  }
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
  hasFeature.mockResolvedValue(true);
  hasFeatureOnAnyPass.mockResolvedValue(false);
});

describe("Settings no longer has a Sponsors tab", () => {
  it("SETTINGS_TABS does not list it (and still lists the other six - the empty/over-removed cases)", () => {
    expect(SETTINGS_TABS).not.toContain("sponsors");
    expect(SETTINGS_TABS).toEqual(["organization", "news", "team", "api", "preferences", "account"]);
  });
});

describe("settings?tab=sponsors redirects to sponsors?tab=sponsors", () => {
  it("answers a 307 to the hub's Sponsors tab", async () => {
    expect(await redirectedTo({ tab: "sponsors" })).toEqual({ url: "/o/riverside/sponsors?tab=sponsors", status: "307" });
  });

  it("KEEPS the extra params (stated choice): settings?tab=sponsors&x=1 -> sponsors?tab=sponsors&x=1", async () => {
    expect(await redirectedTo({ tab: "sponsors", x: "1" })).toEqual({
      url: "/o/riverside/sponsors?tab=sponsors&x=1",
      status: "307",
    });
  });

  it("runs BEFORE the tab fallback: the redirect fires instead of the Organisation panel rendering", async () => {
    // Were it written after `SETTINGS_TABS.includes(rawTab) ? rawTab : "organization"`, this would render the
    // Organisation panel (a 200 with the logo uploader) and `redirectedTo` would be null.
    const r = await redirectedTo({ tab: "sponsors" });
    expect(r).not.toBeNull();
    expect(hasFeature, "the organisation panel's data was never read").not.toHaveBeenCalled();
  });

  it("runs AFTER the membership check: a non-member is refused exactly as before and is not bounced", async () => {
    const refusal = new Error("NEXT_NOT_FOUND");
    requireOrgPage.mockRejectedValue(refusal);
    await expect(renderSettings({ tab: "sponsors" })).rejects.toBe(refusal);
  });

  it("is the ONLY tab that redirects: every other tab, an unknown tab and no tab all still render Settings (sequence, counted)", async () => {
    // team/api/preferences/account/news each need their own data stubs; the ones that need none render here, and the
    // rest are asserted by their own suites. What this pins is that the redirect did not widen.
    let rendered = 0;
    for (const sp of [{}, { tab: "organization" }, { tab: "bogus" }, { tab: "Sponsors" }, { tab: ["sponsors", "team"] as string[] }]) {
      expect(await redirectedTo(sp), JSON.stringify(sp)).toBeNull();
      rendered++;
    }
    expect(rendered).toBe(5);
    // ...and the redirect is still there afterwards: no state was carried between calls.
    expect(await redirectedTo({ tab: "sponsors" })).not.toBeNull();
  });

  it("the Organisation panel is what an old unknown tab lands on - the moved bodies are not rendered by Settings any more", async () => {
    const html = await renderSettings({ tab: "bogus" });
    expect(html).toContain("org-logo-uploader");
    expect(html).not.toContain('data-testid="org-sponsors"');
    expect(html).not.toContain('data-testid="sponsor-packages-island"');
  });

  it("the Settings sidebar has no Sponsors entry", async () => {
    const html = await renderSettings({});
    expect(html).not.toContain("tab=sponsors");
  });
});
