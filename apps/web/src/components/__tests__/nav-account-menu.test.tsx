// The seam between the gantry (Nav, a server component) and its account menu (owner picked Option A, 2026-11-11).
//
// The menu's own suite (account-menu.test.tsx) proves the island draws and wires what it is GIVEN. This one proves Nav gives it
// the right things - the user, every org with its logo resolved, the org the chrome is SHOWING (path before cookie), whether the
// user is a claimed player, and each locale's copy - and then folds exactly what Nav handed over through the REAL model and panel,
// so a prop Nav forgot to pass (the inert-seam class) cannot hide behind a fixture on either side.
//
// prerender, not renderToStaticMarkup: Nav is an async server component.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prerender } from "react-dom/static";
import { renderToStaticMarkup } from "react-dom/server";

const m = vi.hoisted(() => ({
  hasFeature: vi.fn(async () => false),
  getCurrentUser: vi.fn(),
  getUserOrgs: vi.fn(),
  getActiveOrgId: vi.fn(),
  hasClaimedProfile: vi.fn(async () => false),
  locale: { value: "en" as string },
  seen: [] as unknown[],
}));

vi.mock("@/lib/entitlements", () => ({ hasFeature: m.hasFeature, orgPlanKey: async () => "free" }));
vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
vi.mock("@/server/youtube/connections", () => ({ hasLiveConnection: async () => false }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: m.getCurrentUser, getUserOrgs: m.getUserOrgs, getActiveOrgId: m.getActiveOrgId }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => m.locale.value }));
vi.mock("@/server/usecases/me", () => ({ hasClaimedProfile: m.hasClaimedProfile }));
vi.mock("@/lib/activation", () => ({ needsTourAfterOnboarding: async () => false }));
vi.mock("@/server/usecases/competitions", () => ({ hasAnyCompetitions: async () => false }));
vi.mock("@/components/help-menu", () => ({ HelpMenu: () => <button type="button" aria-label="help-stub" /> }));
vi.mock("@/components/product-tour", () => ({ ProductTour: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/o/riverside" }));
// The island is replaced by a recorder that keeps every prop Nav passes and paints one marker - the real island is driven in
// account-menu.test.tsx, and its real trigger markup inside Nav is read by nav-streaming.test.tsx.
vi.mock("@/components/account-menu", async (importOriginal) => {
  const real = await importOriginal<typeof import("../account-menu")>();
  return {
    ...real,
    AccountMenu: (props: unknown) => {
      m.seen.push(props);
      return <span data-testid="account-menu-marker" />;
    },
  };
});

import { Nav } from "../nav";
import { AccountMenuPanel, type AccountMenuProps } from "../account-menu";
import { accountMenuModel } from "@/lib/account-menu";
import { LOCALES } from "@/lib/i18n-constants";
import { EDITOR_ROLES, ORG_ROLES } from "@/lib/types";
import consoleEn from "@/dictionaries/en/console.json";
import consoleEs from "@/dictionaries/es/console.json";
import consoleFr from "@/dictionaries/fr/console.json";
import consoleNl from "@/dictionaries/nl/console.json";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

type D = Record<string, string>;
const CONSOLE: Record<string, D> = { en: consoleEn, es: consoleEs, fr: consoleFr, nl: consoleNl };
const UI: Record<string, D> = { en: uiEn as D, es: uiEs as D, fr: uiFr as D, nl: uiNl as D };

const membership = (id: string, name: string, slug: string, role: string, logo_url: string | null = null) => ({
  id, name, slug, role, logo_url, logo_storage_path: null, created_by: null, created_at: "2026-01-01T00:00:00Z", branding: null, timezone: null,
});
const RIVERSIDE = membership("o-1", "Riverside Badminton Club", "riverside", "owner");
const KETTERING = membership("o-2", "Kettering Chess Club", "kettering", "viewer", "https://cdn.example.test/kcc.png");

const render = async (orgSlug?: string): Promise<string> =>
  new Response((await prerender(await Nav(orgSlug ? { orgSlug } : {}))).prelude).text();
const lastProps = (): AccountMenuProps => {
  expect(m.seen.length, "Nav mounted the account menu").toBeGreaterThan(0);
  return m.seen.at(-1) as AccountMenuProps;
};

beforeEach(() => {
  m.locale.value = "en";
  m.seen.length = 0;
  m.getCurrentUser.mockReset().mockResolvedValue({ id: "u-1", display_name: "Ashok Kumar", email: "ashok@example.com" });
  m.getUserOrgs.mockReset().mockResolvedValue([RIVERSIDE, KETTERING]);
  m.getActiveOrgId.mockReset().mockResolvedValue(RIVERSIDE.id);
  m.hasClaimedProfile.mockReset().mockResolvedValue(false);
});

describe("Nav -> AccountMenu: what the bar hands the menu", () => {
  it("the user, and EVERY org in membership order with its role and its logo resolved (https passes through, none -> null)", async () => {
    await render();
    const p = lastProps();
    expect(p.user).toEqual({ displayName: "Ashok Kumar", email: "ashok@example.com" });
    expect(p.orgs).toEqual([
      { id: "o-1", name: "Riverside Badminton Club", slug: "riverside", role: "owner", logoUrl: null },
      { id: "o-2", name: "Kettering Chess Club", slug: "kettering", role: "viewer", logoUrl: "https://cdn.example.test/kcc.png" },
    ]);
  });

  it("the active org is the one the chrome SHOWS: the path's org beats the cookie's (a link-driven switch lags the cookie by a render)", async () => {
    m.getActiveOrgId.mockResolvedValue(RIVERSIDE.id);
    await render("kettering");
    expect(lastProps().activeOrgId).toBe(KETTERING.id);
    // ...and without a path the cookie decides (the second call, other branch).
    await render();
    expect(lastProps().activeOrgId).toBe(RIVERSIDE.id);
  });

  it("isPlayer follows the claimed profile, both ways", async () => {
    m.hasClaimedProfile.mockResolvedValue(true);
    await render();
    expect(lastProps().isPlayer).toBe(true);
    m.hasClaimedProfile.mockResolvedValue(false);
    await render();
    expect(lastProps().isPlayer).toBe(false);
  });

  it("an account with no email hands null, never an empty string the panel would paint", async () => {
    m.getCurrentUser.mockResolvedValue({ id: "u-1", display_name: "Ashok Kumar", email: "" });
    await render();
    expect(lastProps().user.email).toBeNull();
  });

  it("each locale's copy, from that locale's OWN dictionaries (console for the menu's words; ui for the settings rail's) - 4 locales", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      m.locale.value = locale;
      await render();
      const l = lastProps().labels;
      const c = CONSOLE[locale]!;
      const u = UI[locale]!;
      expect(l.menu, locale).toBe(c["nav.account.menu"]);
      expect(l.newOrg, locale).toBe(c["nav.account.newOrg"]);
      expect(l.orgSettings, locale).toBe(c["nav.account.orgSettings"]);
      expect(l.playerHome, locale).toBe(c["nav.playerHome"]);
      expect(l.signOut, locale).toBe(c["nav.signOut"]);
      expect(l.organisation, locale).toBe(u["settings.nav.group.organisation"]);
      expect(l.profile, `${locale}: the Account item is named as the Settings tab it opens`).toBe(u["settings.nav.account"]);
      expect(l.switching, locale).toBe(u["settings.org.switch.busy"]);
      expect(l.error, locale).toBe(c["nav.account.error"]);
      for (const v of Object.values(l).filter((x) => typeof x === "string")) expect(v, `${locale}: a real string`).toMatch(/\S/);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
    // Translated, not English pasted four times.
    expect(new Set(LOCALES.map((loc) => CONSOLE[loc]!["nav.account.orgSettings"])).size).toBe(LOCALES.length);
  });

  it("role hints are named for exactly the roles that cannot edit (EDITOR_ROLES is the authority), in the locale's words", async () => {
    m.locale.value = "fr";
    await render();
    const roles = lastProps().labels.roles;
    const nonEditors = ORG_ROLES.filter((r) => !(EDITOR_ROLES as readonly string[]).includes(r));
    expect(nonEditors.length, "anti-vacuity: some role is not an editor").toBeGreaterThan(0);
    expect(Object.keys(roles).sort()).toEqual([...nonEditors].sort());
    for (const r of nonEditors) expect(roles[r], r).toBe(UI.fr![`role.${r}`]);
  });
});

describe("Nav -> AccountMenu -> the real panel (the props Nav passed, folded through the real model)", () => {
  const panelFrom = (p: AccountMenuProps): string =>
    renderToStaticMarkup(
      <AccountMenuPanel
        id="am"
        user={p.user}
        model={accountMenuModel({ orgs: p.orgs, activeOrgId: p.activeOrgId, isPlayer: p.isPlayer })}
        labels={p.labels}
        busyOrgId={null}
        position={null}
        onSwitch={() => {}}
        onSignOut={() => {}}
        onClose={() => {}}
        onKeyDown={() => {}}
      />,
    );

  it("a claimed player on Kettering's page: Kettering ticked, the viewer hint painted, Settings -> Kettering, Player home offered", async () => {
    m.hasClaimedProfile.mockResolvedValue(true);
    await render("kettering");
    const html = panelFrom(lastProps());
    expect(html).toMatch(/aria-checked="true"[^>]*data-testid="account-menu-org-kettering"|data-testid="account-menu-org-kettering"[^>]*aria-checked="true"/);
    expect(html).toContain(`>${UI.en!["role.viewer"]}<`);
    expect(html).toContain('href="/o/kettering/settings"');
    expect(html).toContain('data-testid="account-menu-player-home"');
    expect(html).toContain('src="https://cdn.example.test/kcc.png"');
  });

  it("not a player: no Player home (the positive pair above proves the item can appear)", async () => {
    await render();
    expect(panelFrom(lastProps())).not.toContain('data-testid="account-menu-player-home"');
  });

  it("no organisation yet: no org rows, no Organisation settings, no Account item - and the menu is still mounted (Sign out stays reachable)", async () => {
    m.getUserOrgs.mockResolvedValue([]);
    await render();
    const html = panelFrom(lastProps());
    expect(html).not.toContain("account-menu-org-");
    expect(html).not.toContain('data-testid="account-menu-settings"');
    expect(html).toContain('data-testid="account-menu-new-org"');
    expect(html).not.toContain('data-testid="account-menu-profile"');
    expect(html).toContain('data-testid="account-menu-signout"');
  });
});

describe("Nav: the bar itself", () => {
  it("holds no Settings icon, no Player home link, no display name and no Sign-out button - the menu is the bar's last control, after help", async () => {
    m.hasClaimedProfile.mockResolvedValue(true);
    const html = await render();
    expect(html).not.toContain('data-testid="nav-settings"');
    expect(html).not.toContain('href="/me"');
    expect(html, "the name is only ever inside the account trigger (replaced by the recorder here)").not.toContain("Ashok Kumar");
    expect(html).not.toContain(`aria-label="${CONSOLE.en!["nav.signOut"]}"`);
    const help = html.indexOf('aria-label="help-stub"');
    const menu = html.indexOf('data-testid="account-menu-marker"');
    expect(help, "help is in the bar").toBeGreaterThan(-1);
    expect(menu, "the account menu comes after help").toBeGreaterThan(help);
    expect(m.seen).toHaveLength(1);
  });

  it("signed out: no account menu at all, and the Sign in button instead", async () => {
    m.getCurrentUser.mockResolvedValue(null);
    const html = await render();
    expect(m.seen).toHaveLength(0);
    expect(html).not.toContain('data-testid="account-menu-marker"');
    expect(html).toContain('href="/login"');
    expect(html).toContain(`>${CONSOLE.en!["nav.signIn"]}<`);
  });
});
