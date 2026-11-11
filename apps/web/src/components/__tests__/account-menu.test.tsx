// The gantry's account menu (owner picked Option A, 2026-11-11; mock of record nav-account-menu-mocks section A). One trigger
// at the right end of the bar replaces the Settings icon, the display name, Sign out and the Player home link; the menu holds
// who you are, every organisation (current one ticked, tap to switch, + New organisation), Organisation settings / Account /
// Player home, and Sign out last.
//
// Three layers, each pinned where it can be seen:
//   1. the pure item model (lib/account-menu.ts) - which items exist in each state, which org is ticked, where each one goes;
//   2. the shared switch (lib/org-switch.ts) - the SAME POST + hard navigation the settings OrgSwitcher uses, never a copy;
//   3. the island itself, driven through `_hook-harness` (vitest is `environment: "node"`, no DOM): open the menu, choose an org,
//      sign out - so the seam between a click and what is POSTed is witnessed through the real component, not a fixture.
// Whether the bar FITS at every width is measured in a browser (nav-org-chip-overflow / mobile / youtube-streaming specs).
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland, textOf } from "./_hook-harness";
import { ORG_ROLES, EDITOR_ROLES, type OrgRole } from "@/lib/types";

const h = vi.hoisted(() => ({
  api: vi.fn<(url: string, init?: unknown) => Promise<unknown>>(),
  signOutClient: vi.fn<() => Promise<void>>(),
  push: vi.fn(),
  refresh: vi.fn(),
  pathname: { value: "/o/riverside/settings/billing" },
}));
vi.mock("@/lib/client", () => ({ api: h.api }));
vi.mock("@/lib/sign-out-client", () => ({ signOutClient: h.signOutClient }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push, refresh: h.refresh }),
  usePathname: () => h.pathname.value,
}));

import { accountMenuModel, initialsOf, resetOnBfcacheRestore, type AccountMenuOrgInput } from "@/lib/account-menu";
import { orgSwitchTarget, switchActiveOrg } from "@/lib/org-switch";
import { AccountMenu, AccountMenuPanel, type AccountMenuLabels, type AccountMenuProps } from "../account-menu";

const org = (id: string, name: string, slug: string, role: OrgRole, logoUrl: string | null = null): AccountMenuOrgInput => ({ id, name, slug, role, logoUrl });
const RIVERSIDE = org("o-1", "Riverside Badminton Club", "riverside", "owner");
const KETTERING = org("o-2", "Kettering Chess Club", "kettering", "viewer");
const NORTHANTS = org("o-3", "Northamptonshire Badminton Association", "northants", "admin", "https://cdn.example.test/nba.png");

const LABELS: AccountMenuLabels = {
  menu: "Account menu",
  organisation: "Organisation",
  newOrg: "New organisation",
  orgSettings: "Organisation settings",
  profile: "Account",
  playerHome: "Player home",
  signOut: "Sign out",
  switching: "Switching…",
  error: "Could not complete that.",
  roles: { viewer: "Viewer" },
};

// ---------------------------------------------------------------------------------------------------------------------------
// 1. The item model
// ---------------------------------------------------------------------------------------------------------------------------
describe("accountMenuModel", () => {
  it("EMPTY CASE FIRST - signed in with no organisation: no org rows, nothing ticked, no Settings item (it would duplicate + New organisation), no Account item", () => {
    const m = accountMenuModel({ orgs: [], activeOrgId: null, isPlayer: false });
    expect(m.orgs).toEqual([]);
    expect(m.current).toBeNull();
    expect(m.orgs.filter((o) => o.current), "zero ticked").toHaveLength(0);
    expect(m.settingsHref, "no org, no Organisation settings").toBeNull();
    expect(m.newOrgHref).toBe("/orgs/new");
    expect(m.profileHref, "the Account tab lives under an org's Settings - none to open").toBeNull();
    expect(m.playerHomeHref).toBeNull();
  });

  it("no organisation but a claimed player: Player home is still offered (the player's own door does not need a club)", () => {
    const m = accountMenuModel({ orgs: [], activeOrgId: null, isPlayer: true });
    expect(m.playerHomeHref).toBe("/me");
    expect(m.profileHref).toBeNull();
  });

  it("one org, an editor: one row, ticked, no role hint; Settings and Account open that org's Settings", () => {
    const m = accountMenuModel({ orgs: [RIVERSIDE], activeOrgId: RIVERSIDE.id, isPlayer: false });
    expect(m.orgs.map((o) => [o.slug, o.current, o.roleHint])).toEqual([["riverside", true, null]]);
    expect(m.settingsHref).toBe("/o/riverside/settings");
    expect(m.profileHref).toBe("/o/riverside/settings?tab=account");
    expect(m.playerHomeHref).toBeNull();
  });

  it("a viewer carries its role as a hint; Settings still opens its org's Settings (the page itself decides what a viewer sees)", () => {
    const m = accountMenuModel({ orgs: [KETTERING], activeOrgId: KETTERING.id, isPlayer: false });
    expect(m.orgs[0]!.roleHint).toBe("viewer");
    expect(m.settingsHref).toBe("/o/kettering/settings");
  });

  it("role hints, swept over every role: a hint exactly for the roles that are NOT editors (EDITOR_ROLES is the authority)", () => {
    let checked = 0;
    let hinted = 0;
    for (const role of ORG_ROLES) {
      const m = accountMenuModel({ orgs: [{ ...RIVERSIDE, role }], activeOrgId: RIVERSIDE.id, isPlayer: false });
      const isEditor = (EDITOR_ROLES as readonly string[]).includes(role);
      expect(m.orgs[0]!.roleHint, role).toBe(isEditor ? null : role);
      if (!isEditor) hinted++;
      checked++;
    }
    expect(checked, "anti-vacuity: every role looked at").toBe(ORG_ROLES.length);
    expect(hinted, "anti-vacuity: at least one role is hinted, or the sweep could not see a hint go missing").toBeGreaterThan(0);
  });

  it("several orgs: listed in the order given, EXACTLY one ticked - the active one, even when it is not the first - and Settings follows it", () => {
    const m = accountMenuModel({ orgs: [RIVERSIDE, KETTERING, NORTHANTS], activeOrgId: NORTHANTS.id, isPlayer: false });
    expect(m.orgs.map((o) => o.slug)).toEqual(["riverside", "kettering", "northants"]);
    expect(m.orgs.filter((o) => o.current).map((o) => o.slug)).toEqual(["northants"]);
    expect(m.current?.slug).toBe("northants");
    expect(m.settingsHref).toBe("/o/northants/settings");
    expect(m.profileHref).toBe("/o/northants/settings?tab=account");
    expect(m.orgs.map((o) => o.roleHint)).toEqual([null, "viewer", null]);
  });

  it("the sequence: moving the active org moves the tick and the Settings target with it (second call, different active)", () => {
    const a = accountMenuModel({ orgs: [RIVERSIDE, KETTERING], activeOrgId: RIVERSIDE.id, isPlayer: false });
    const b = accountMenuModel({ orgs: [RIVERSIDE, KETTERING], activeOrgId: KETTERING.id, isPlayer: false });
    expect(a.orgs.map((o) => o.current)).toEqual([true, false]);
    expect(b.orgs.map((o) => o.current)).toEqual([false, true]);
    expect([a.settingsHref, b.settingsHref]).toEqual(["/o/riverside/settings", "/o/kettering/settings"]);
  });

  it("GUARD: an active id that is none of the user's orgs (stale cookie, a membership just removed) ticks the FIRST org - pickActiveOrg's own fallback - never zero and never two", () => {
    for (const stale of [null, "o-gone"]) {
      const m = accountMenuModel({ orgs: [KETTERING, RIVERSIDE], activeOrgId: stale, isPlayer: false });
      expect(m.orgs.filter((o) => o.current).map((o) => o.slug), String(stale)).toEqual(["kettering"]);
      expect(m.settingsHref, String(stale)).toBe("/o/kettering/settings");
    }
  });

  it("Player home is offered exactly when the user is a claimed player, with or without an org", () => {
    const shapes = [
      { orgs: [], isPlayer: false, want: null },
      { orgs: [], isPlayer: true, want: "/me" },
      { orgs: [RIVERSIDE], isPlayer: false, want: null },
      { orgs: [RIVERSIDE], isPlayer: true, want: "/me" },
    ];
    for (const s of shapes) expect(accountMenuModel({ orgs: s.orgs, activeOrgId: null, isPlayer: s.isPlayer }).playerHomeHref, JSON.stringify(s)).toBe(s.want);
    expect(shapes.length).toBe(4);
  });

  it("each org row carries its initials (the avatar tile when the org has no logo) and keeps its logo when it has one", () => {
    const m = accountMenuModel({ orgs: [RIVERSIDE, NORTHANTS], activeOrgId: RIVERSIDE.id, isPlayer: false });
    expect(m.orgs.map((o) => [o.initials, o.logoUrl])).toEqual([["RB", null], ["NB", "https://cdn.example.test/nba.png"]]);
  });
});

describe("initialsOf", () => {
  it("the first letter of the first two words, upper-cased; one word gives one letter", () => {
    expect(initialsOf("Ashok Kumar")).toBe("AK");
    expect(initialsOf("Harbour Vale Sports Club")).toBe("HV");
    expect(initialsOf("alex")).toBe("A");
    expect(initialsOf("  jean-luc   picard  ")).toBe("JP");
  });

  it("whole characters, not UTF-16 halves: an accented or astral first letter survives", () => {
    expect(initialsOf("émile zola")).toBe("ÉZ");
    expect(initialsOf("𝓩oe Ball")).toBe("𝓩B");
  });

  it("an empty or blank name falls back to the fallback's first letter, then to '?'", () => {
    expect(initialsOf("", "sam@example.com")).toBe("S");
    expect(initialsOf("   ", "")).toBe("?");
    expect(initialsOf("")).toBe("?");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// 2. The shared switch - the settings OrgSwitcher and the account menu both call it
// ---------------------------------------------------------------------------------------------------------------------------
describe("switchActiveOrg", () => {
  const ORGS = [RIVERSIDE, KETTERING];
  const deps = () => ({ post: vi.fn<(orgId: string) => Promise<void>>(async () => {}), navigate: vi.fn<(url: string) => void>() });

  it("to another org: POSTs that org's id, then hard-navigates to the SAME org-level page under it (Settings > Billing stays Billing)", async () => {
    const d = deps();
    const r = await switchActiveOrg({ orgs: ORGS, fromId: RIVERSIDE.id, toId: KETTERING.id, pathname: "/o/riverside/settings/billing" }, d);
    expect(r).toBe("navigated");
    expect(d.post.mock.calls).toEqual([[KETTERING.id]]);
    // Expected from orgSwitchTarget's documented rule (an org-level path transfers), not by calling it.
    expect(d.navigate.mock.calls).toEqual([["/o/kettering/settings/billing"]]);
  });

  it("from a competition page (which belongs to the OLD org): lands on the new org's home", async () => {
    const d = deps();
    await switchActiveOrg({ orgs: ORGS, fromId: RIVERSIDE.id, toId: KETTERING.id, pathname: "/o/riverside/c/spring-open" }, d);
    expect(d.navigate.mock.calls).toEqual([["/o/kettering"]]);
  });

  it("from outside the /o tree (/directory, /streaming): the new org's home", async () => {
    const d = deps();
    await switchActiveOrg({ orgs: ORGS, fromId: RIVERSIDE.id, toId: KETTERING.id, pathname: "/directory" }, d);
    expect(d.navigate.mock.calls).toEqual([["/o/kettering"]]);
  });

  it("GUARD: choosing the org you are already in POSTs nothing and goes nowhere", async () => {
    const d = deps();
    const r = await switchActiveOrg({ orgs: ORGS, fromId: RIVERSIDE.id, toId: RIVERSIDE.id, pathname: "/o/riverside" }, d);
    expect(r).toBe("same");
    expect(d.post).not.toHaveBeenCalled();
    expect(d.navigate).not.toHaveBeenCalled();
  });

  it("GUARD: an id that is none of the user's orgs POSTs nothing (no cookie flipped to an org there is no page for)", async () => {
    const d = deps();
    const r = await switchActiveOrg({ orgs: ORGS, fromId: RIVERSIDE.id, toId: "o-gone", pathname: "/o/riverside" }, d);
    expect(r).toBe("unknown");
    expect(d.post).not.toHaveBeenCalled();
    expect(d.navigate).not.toHaveBeenCalled();
  });

  it("a failed POST rejects and does NOT navigate (the cookie was not flipped, so the page must not pretend it was)", async () => {
    const d = deps();
    d.post.mockRejectedValueOnce(new Error("503"));
    await expect(switchActiveOrg({ orgs: ORGS, fromId: RIVERSIDE.id, toId: KETTERING.id, pathname: "/o/riverside" }, d)).rejects.toThrow("503");
    expect(d.navigate).not.toHaveBeenCalled();
  });

  it("the default POST is the endpoint the settings switcher has always called: POST /api/orgs/active { org_id }", async () => {
    h.api.mockReset().mockResolvedValue({});
    const navigate = vi.fn();
    await switchActiveOrg({ orgs: ORGS, fromId: RIVERSIDE.id, toId: KETTERING.id, pathname: "/o/riverside" }, { navigate });
    expect(h.api.mock.calls).toEqual([["/api/orgs/active", { method: "POST", json: { org_id: KETTERING.id } }]]);
    expect(navigate.mock.calls).toEqual([["/o/kettering"]]);
  });

  it("orgSwitchTarget still answers from its old home (components/org-switcher) - breadcrumbs and its own suite import it there", async () => {
    const legacy = await import("../org-switcher");
    expect(legacy.orgSwitchTarget).toBe(orgSwitchTarget);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// 3a. The panel's markup, per state
// ---------------------------------------------------------------------------------------------------------------------------
const PORTAL = Symbol.for("react.portal");
const panelProps = (over: Partial<Parameters<typeof AccountMenuPanel>[0]> = {}): Parameters<typeof AccountMenuPanel>[0] => ({
  id: "am",
  user: { displayName: "Ashok Kumar", email: "ashok@example.com" },
  model: accountMenuModel({ orgs: [RIVERSIDE], activeOrgId: RIVERSIDE.id, isPlayer: false }),
  labels: LABELS,
  busyOrgId: null,
  position: null,
  onSwitch: () => {},
  onSignOut: () => {},
  onClose: () => {},
  onKeyDown: () => {},
  ...over,
});
/** Every element with a data-testid, in document order, as `testid` or `testid=href`. */
const itemSet = (html: string): string[] =>
  [...html.matchAll(/<(a|button|div)\b([^>]*)\bdata-testid="(account-menu[^"]*)"([^>]*)>/g)]
    .map((x) => {
      const attrs = `${x[2]} ${x[4]}`;
      const href = attrs.match(/\bhref="([^"]*)"/)?.[1];
      return href ? `${x[3]}=${href}` : x[3]!;
    });

describe("AccountMenuPanel - the item set in each state", () => {
  it("no org: who, + New organisation, Sign out. No org rows, no Organisation settings, no Account item", () => {
    const html = renderToStaticMarkup(<AccountMenuPanel {...panelProps({ model: accountMenuModel({ orgs: [], activeOrgId: null, isPlayer: false }) })} />);
    expect(itemSet(html)).toEqual(["account-menu", "account-menu-new-org=/orgs/new", "account-menu-signout"]);
  });

  it("one org, editor: who, the org ticked, + New organisation, Organisation settings, Account, Sign out", () => {
    const html = renderToStaticMarkup(<AccountMenuPanel {...panelProps()} />);
    expect(itemSet(html)).toEqual([
      "account-menu",
      "account-menu-org-riverside",
      "account-menu-new-org=/orgs/new",
      "account-menu-settings=/o/riverside/settings",
      "account-menu-profile=/o/riverside/settings?tab=account",
      "account-menu-signout",
    ]);
    expect(html).toMatch(/data-testid="account-menu-org-riverside"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-testid="account-menu-org-riverside"/);
  });

  it("viewer: the role hint is painted beside the org name, in the label given (not the raw role key)", () => {
    const html = renderToStaticMarkup(
      <AccountMenuPanel {...panelProps({ model: accountMenuModel({ orgs: [KETTERING], activeOrgId: KETTERING.id, isPlayer: false }), labels: { ...LABELS, roles: { viewer: "Observateur" } } })} />,
    );
    expect(html).toContain(">Observateur<");
    expect(html).not.toContain(">viewer<");
  });

  it("an editor's row carries no hint (positive pair of the case above)", () => {
    const html = renderToStaticMarkup(<AccountMenuPanel {...panelProps()} />);
    expect(html).not.toContain(">Viewer<");
  });

  it("claimed player: Player home sits after Account and before Sign out", () => {
    const html = renderToStaticMarkup(<AccountMenuPanel {...panelProps({ model: accountMenuModel({ orgs: [RIVERSIDE], activeOrgId: RIVERSIDE.id, isPlayer: true }) })} />);
    expect(itemSet(html).slice(-3)).toEqual(["account-menu-profile=/o/riverside/settings?tab=account", "account-menu-player-home=/me", "account-menu-signout"]);
  });

  it("multi-org: one row per org in order, exactly one aria-checked=true, the rest false", () => {
    const html = renderToStaticMarkup(
      <AccountMenuPanel {...panelProps({ model: accountMenuModel({ orgs: [RIVERSIDE, KETTERING, NORTHANTS], activeOrgId: KETTERING.id, isPlayer: false }) })} />,
    );
    expect(itemSet(html).filter((t) => t.startsWith("account-menu-org-"))).toEqual(["account-menu-org-riverside", "account-menu-org-kettering", "account-menu-org-northants"]);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html.match(/aria-checked="false"/g)).toHaveLength(2);
    expect(html).toMatch(/aria-checked="true"[^>]*data-testid="account-menu-org-kettering"|data-testid="account-menu-org-kettering"[^>]*aria-checked="true"/);
    // The org with a logo shows its logo; the others their initials.
    expect(html).toContain('src="https://cdn.example.test/nba.png"');
    expect(html).toContain(">RB<");
  });

  it("ARIA: the sheet container is a modal dialog with a name, and the role=menu stays inside it", () => {
    const html = renderToStaticMarkup(<AccountMenuPanel {...panelProps()} />);
    const tag = html.match(/<div\b[^>]*data-testid="account-menu"[^>]*>/)?.[0] ?? "";
    expect(tag).toContain('role="dialog"');
    expect(tag).toContain('aria-modal="true"');
    expect(tag).toContain('aria-label="Account menu"');
    expect(html.indexOf('role="dialog"')).toBeLessThan(html.indexOf('role="menu"'));
  });

  it("the inline error row shows only when given (positive and negative pair), and the whole menu holds while busy", () => {
    expect(renderToStaticMarkup(<AccountMenuPanel {...panelProps()} />)).not.toContain("account-menu-error");
    const html = renderToStaticMarkup(<AccountMenuPanel {...panelProps({ error: "Could not complete that.", busy: true })} />);
    expect(html).toContain('data-testid="account-menu-error"');
    expect(html).toContain(">Could not complete that.<");
    expect(html.match(/<button\b[^>]*disabled=""/g)).toHaveLength(2); // the org row and Sign out
  });

  it("who: the display name and the email; with no email the name stands alone", () => {
    const withEmail = renderToStaticMarkup(<AccountMenuPanel {...panelProps()} />);
    expect(withEmail).toContain(">Ashok Kumar<");
    expect(withEmail).toContain(">ashok@example.com<");
    const without = renderToStaticMarkup(<AccountMenuPanel {...panelProps({ user: { displayName: "Ashok Kumar", email: null } })} />);
    expect(without).toContain(">Ashok Kumar<");
    expect(without).not.toContain("@");
  });

  it("ARIA: one role=menu, every action a menuitem (orgs menuitemradio), Sign out a button; the who block sits OUTSIDE the menu", () => {
    const html = renderToStaticMarkup(<AccountMenuPanel {...panelProps({ model: accountMenuModel({ orgs: [RIVERSIDE, KETTERING], activeOrgId: RIVERSIDE.id, isPlayer: true }) })} />);
    expect(html.match(/role="menu"/g)).toHaveLength(1);
    expect(html.match(/role="menuitemradio"/g)).toHaveLength(2);
    // + New organisation, Organisation settings, Account, Player home, Sign out
    expect(html.match(/role="menuitem"/g)).toHaveLength(5);
    const menuAt = html.indexOf('role="menu"');
    expect(html.indexOf(">ashok@example.com<"), "the who block precedes the menu, outside it").toBeLessThan(menuAt);
    expect(html).toMatch(/<button\b[^>]*data-testid="account-menu-signout"|<button\b[^>]*role="menuitem"[^>]*data-testid="account-menu-signout"/);
  });

  it("while a switch is in flight the chosen row says so and every org row is disabled (no second switch)", () => {
    const html = renderToStaticMarkup(
      <AccountMenuPanel {...panelProps({ model: accountMenuModel({ orgs: [RIVERSIDE, KETTERING], activeOrgId: RIVERSIDE.id, isPlayer: false }), busyOrgId: KETTERING.id })} />,
    );
    expect(html).toContain(">Switching…<");
    expect(html.match(/<button\b[^>]*role="menuitemradio"[^>]*disabled=""/g)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// 3b. The island, driven: open, switch, sign out
// ---------------------------------------------------------------------------------------------------------------------------
/** walk + into the portal and into the hookless panel, so the open menu's handlers can be found the way a person finds them. */
function expand(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (node && typeof node === "object" && (node as { $$typeof?: symbol }).$$typeof === PORTAL) {
    return expand((node as unknown as { children: ReactNode }).children, out);
  }
  if (Array.isArray(node)) {
    for (const c of node) expand(c, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  if (node.type === AccountMenuPanel) return expand(AccountMenuPanel(node.props as Parameters<typeof AccountMenuPanel>[0]), out);
  out.push(node);
  return expand((node.props as { children?: ReactNode }).children, out);
}

const islandProps = (over: Partial<AccountMenuProps> = {}): AccountMenuProps => ({
  user: { displayName: "Ashok Kumar", email: "ashok@example.com" },
  orgs: [RIVERSIDE, KETTERING],
  activeOrgId: RIVERSIDE.id,
  isPlayer: false,
  labels: LABELS,
  ...over,
});

const assign = vi.fn();
beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  if (!("document" in g)) {
    g.document = {
      body: { nodeType: 1 },
      documentElement: { clientWidth: 1280 },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  }
  if (!("window" in g)) g.window = { location: { assign }, addEventListener: () => {}, removeEventListener: () => {}, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} };
});
beforeEach(() => {
  h.api.mockReset().mockResolvedValue({});
  h.signOutClient.mockReset().mockResolvedValue(undefined);
  h.push.mockReset();
  h.refresh.mockReset();
  assign.mockReset();
  h.pathname.value = "/o/riverside/settings/billing";
});

const byTestId = (els: ReactElement[], id: string): ReactElement | undefined => els.find((el) => propsOf(el)["data-testid"] === id);
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("AccountMenu - the island", () => {
  it("closed: only the trigger - named by the translated label, collapsed, and the menu is not in the tree", () => {
    const island = renderIsland(AccountMenu, islandProps(), (n) => expand(n));
    const trigger = byTestId(island.tree(), "account-menu-trigger");
    expect(trigger, "the trigger rendered").toBeDefined();
    expect(propsOf(trigger!)["aria-label"]).toBe("Account menu");
    expect(propsOf(trigger!)["aria-haspopup"]).toBe("menu");
    expect(propsOf(trigger!)["aria-expanded"]).toBe(false);
    expect(byTestId(island.tree(), "account-menu")).toBeUndefined();
  });

  it("the trigger paints the avatar initials always and the display name only from lg (the name span's own class)", () => {
    const island = renderIsland(AccountMenu, islandProps(), (n) => expand(n));
    const trigger = byTestId(island.tree(), "account-menu-trigger")!;
    const html = renderToStaticMarkup(trigger);
    expect(html, "the avatar's initials").toMatch(/>AK<\/span>/);
    const nameCls = html.match(/<span class="([^"]*)">Ashok Kumar<\/span>/)?.[1];
    expect(nameCls, "the display name is in the trigger").toBeDefined();
    const toks = nameCls!.split(/\s+/);
    expect(toks).toContain("hidden");
    expect(toks).toContain("lg:block");
    expect(toks, "truncates rather than pushing the bar").toContain("truncate");
    expect(toks, "and its ancestors let it (min-w-0)").toContain("min-w-0");
    expect(textOf(trigger), "no stray copy").not.toContain("undefined");
  });

  it("open -> choose another org: POST /api/orgs/active with THAT org's id, then a hard navigation to the same page under it", async () => {
    const island = renderIsland(AccountMenu, islandProps(), (n) => expand(n));
    (propsOf(byTestId(island.tree(), "account-menu-trigger")!).onClick as () => void)();
    expect(propsOf(byTestId(island.tree(), "account-menu-trigger")!)["aria-expanded"]).toBe(true);
    expect(byTestId(island.tree(), "account-menu"), "the menu opened").toBeDefined();
    (propsOf(byTestId(island.tree(), "account-menu-org-kettering")!).onClick as () => void)();
    await flush();
    expect(h.api.mock.calls).toEqual([["/api/orgs/active", { method: "POST", json: { org_id: KETTERING.id } }]]);
    expect(assign.mock.calls).toEqual([["/o/kettering/settings/billing"]]);
  });

  it("open -> choose the CURRENT org: nothing is POSTed, nothing navigates, and the menu closes", async () => {
    const island = renderIsland(AccountMenu, islandProps(), (n) => expand(n));
    (propsOf(byTestId(island.tree(), "account-menu-trigger")!).onClick as () => void)();
    (propsOf(byTestId(island.tree(), "account-menu-org-riverside")!).onClick as () => void)();
    await flush();
    expect(h.api).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(byTestId(island.tree(), "account-menu"), "closed after choosing").toBeUndefined();
  });

  it("a failed switch (403/5xx/network): the error row shows, no throw, no navigation, and the rows are enabled again", async () => {
    h.api.mockRejectedValue(new Error("403"));
    const island = renderIsland(AccountMenu, islandProps(), (n) => expand(n));
    (propsOf(byTestId(island.tree(), "account-menu-trigger")!).onClick as () => void)();
    expect(byTestId(island.tree(), "account-menu-error"), "no error before").toBeUndefined();
    (propsOf(byTestId(island.tree(), "account-menu-org-kettering")!).onClick as () => void)();
    await flush();
    expect(h.api).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
    expect(textOf(byTestId(island.tree(), "account-menu-error")!)).toBe("Could not complete that.");
    expect(propsOf(byTestId(island.tree(), "account-menu-org-kettering")!).disabled, "retry possible").toBe(false);
    expect(byTestId(island.tree(), "account-menu"), "menu stays open").toBeDefined();
  });

  it("a second switch while one is in flight is ignored, and after a successful navigation the hold stays (no second POST)", async () => {
    const island = renderIsland(AccountMenu, islandProps({ orgs: [RIVERSIDE, KETTERING, NORTHANTS] }), (n) => expand(n));
    (propsOf(byTestId(island.tree(), "account-menu-trigger")!).onClick as () => void)();
    const tap = (slug: string) => (propsOf(byTestId(island.tree(), `account-menu-org-${slug}`)!).onClick as () => void)();
    tap("kettering");
    tap("northants"); // same tick: in flight
    await flush();
    tap("northants"); // after a successful navigation: still held until unload
    await flush();
    expect(h.api.mock.calls).toEqual([["/api/orgs/active", { method: "POST", json: { org_id: KETTERING.id } }]]);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(propsOf(byTestId(island.tree(), "account-menu-org-northants")!).disabled).toBe(true);
  });

  it("a failed sign-out: the error row shows, no navigation, no throw - and Sign out can be tried again", async () => {
    h.signOutClient.mockRejectedValueOnce(new Error("net"));
    const island = renderIsland(AccountMenu, islandProps(), (n) => expand(n));
    (propsOf(byTestId(island.tree(), "account-menu-trigger")!).onClick as () => void)();
    (propsOf(byTestId(island.tree(), "account-menu-signout")!).onClick as () => void)();
    await flush();
    expect(h.push).not.toHaveBeenCalled();
    expect(textOf(byTestId(island.tree(), "account-menu-error")!)).toBe("Could not complete that.");
    (propsOf(byTestId(island.tree(), "account-menu-signout")!).onClick as () => void)();
    await flush();
    expect(h.signOutClient).toHaveBeenCalledTimes(2);
    expect(h.push.mock.calls).toEqual([["/"]]);
  });

  it("a double tap on Sign out signs out once", async () => {
    const island = renderIsland(AccountMenu, islandProps(), (n) => expand(n));
    (propsOf(byTestId(island.tree(), "account-menu-trigger")!).onClick as () => void)();
    const tap = () => (propsOf(byTestId(island.tree(), "account-menu-signout")!).onClick as () => void)();
    tap();
    tap();
    await flush();
    tap();
    await flush();
    expect(h.signOutClient).toHaveBeenCalledTimes(1);
  });

  it("open -> Sign out: the shared sign-out runs FIRST, then the soft navigation to the marketing home", async () => {
    const order: string[] = [];
    h.signOutClient.mockImplementation(async () => { order.push("signOut"); });
    h.push.mockImplementation(() => order.push("push"));
    const island = renderIsland(AccountMenu, islandProps(), (n) => expand(n));
    (propsOf(byTestId(island.tree(), "account-menu-trigger")!).onClick as () => void)();
    (propsOf(byTestId(island.tree(), "account-menu-signout")!).onClick as () => void)();
    await flush();
    expect(order).toEqual(["signOut", "push"]);
    expect(h.push.mock.calls).toEqual([["/"]]);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("a link item (Organisation settings) closes the menu when chosen", () => {
    const island = renderIsland(AccountMenu, islandProps(), (n) => expand(n));
    (propsOf(byTestId(island.tree(), "account-menu-trigger")!).onClick as () => void)();
    const settings = byTestId(island.tree(), "account-menu-settings")!;
    expect(propsOf(settings).href).toBe("/o/riverside/settings");
    (propsOf(settings).onClick as () => void)();
    expect(byTestId(island.tree(), "account-menu")).toBeUndefined();
  });

  it("the trigger toggles: a second click closes what the first opened", () => {
    const island = renderIsland(AccountMenu, islandProps(), (n) => expand(n));
    const click = () => (propsOf(byTestId(island.tree(), "account-menu-trigger")!).onClick as () => void)();
    click();
    expect(byTestId(island.tree(), "account-menu")).toBeDefined();
    click();
    expect(byTestId(island.tree(), "account-menu")).toBeUndefined();
  });

  it("the phone scrim closes the menu (the sheet's outside)", () => {
    const island = renderIsland(AccountMenu, islandProps(), (n) => expand(n));
    (propsOf(byTestId(island.tree(), "account-menu-trigger")!).onClick as () => void)();
    const scrim = byTestId(island.tree(), "account-menu-scrim");
    expect(scrim, "a scrim is drawn under the sheet").toBeDefined();
    expect(String(propsOf(scrim!).className).split(/\s+/), "phones only").toContain("md:hidden");
    (propsOf(scrim!).onClick as () => void)();
    expect(byTestId(island.tree(), "account-menu")).toBeUndefined();
  });

  it("no org (the empty case): the menu still opens and still signs out", async () => {
    const island = renderIsland(AccountMenu, islandProps({ orgs: [], activeOrgId: null }), (n) => expand(n));
    (propsOf(byTestId(island.tree(), "account-menu-trigger")!).onClick as () => void)();
    expect(island.tree().filter((el) => String(propsOf(el)["data-testid"] ?? "").startsWith("account-menu-org-"))).toHaveLength(0);
    (propsOf(byTestId(island.tree(), "account-menu-signout")!).onClick as () => void)();
    await flush();
    expect(h.signOutClient).toHaveBeenCalledTimes(1);
  });
});

describe("bfcache restore (back/forward after a switch or sign-out)", () => {
  it("a persisted pageshow resets; a normal load does not (both directions)", () => {
    const reset = vi.fn();
    expect(resetOnBfcacheRestore({ persisted: true }, reset)).toBe(true);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(resetOnBfcacheRestore({ persisted: false }, reset)).toBe(false);
    expect(reset, "a fresh load must not touch the hold").toHaveBeenCalledTimes(1);
  });

  it("the island wires it: a pageshow listener that clears the ref AND the state and closes, removed on unmount", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../account-menu.tsx", import.meta.url), "utf8");
    const block = src.slice(src.indexOf('addEventListener("pageshow"') - 700, src.indexOf('removeEventListener("pageshow"') + 80);
    expect(block).toContain("resetOnBfcacheRestore(e");
    for (const reset of ["busyRef.current = false", "setBusy(false)", "setBusyOrgId(null)", "setOpen(false)"]) expect(block, reset).toContain(reset);
    expect(block).toContain('removeEventListener("pageshow"');
  });
});
