// The gantry's account menu (owner picked Option A, 2026-11-11): which items it holds in each state, which organisation is
// ticked and where every item goes. Pure, so the item set is pinned by unit tests; the client island
// (components/account-menu.tsx) only draws it.
import { routes } from "@/lib/routes";
import { EDITOR_ROLES, type OrgRole } from "@/lib/types";

/** Where "+ New organisation" goes. */
export const NEW_ORG_HREF = "/orgs/new";

export interface AccountMenuOrgInput {
  id: string;
  name: string;
  slug: string;
  role: OrgRole;
  /** The org's logo, already resolved to a URL the browser can load, or null for the initials tile. */
  logoUrl: string | null;
}

export interface AccountMenuOrgItem extends AccountMenuOrgInput {
  /** The org the chrome is showing: exactly one row is current whenever the user has any org. */
  current: boolean;
  /** The role, for a role that cannot edit (a viewer); null for an editor, whose row needs no caveat. */
  roleHint: OrgRole | null;
  initials: string;
}

export interface AccountMenuModel {
  orgs: AccountMenuOrgItem[];
  current: AccountMenuOrgItem | null;
  newOrgHref: string;
  /** Organisation settings: the current org's Settings; null without an org (the "+ New organisation" row already goes to
   *  /orgs/new, a second row to the same place would be a duplicate). */
  settingsHref: string | null;
  /** The personal Account tab (a Settings tab, so it needs an org to live under); null without one. */
  profileHref: string | null;
  /** Player home, for a claimed player only. */
  playerHomeHref: string | null;
}

/** First letter of the first two words, upper-cased - whole characters, so an accented or astral letter survives. A blank
 *  name falls back to the fallback's first letter (an email), then to "?". */
export function initialsOf(name: string, fallback = ""): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => Array.from(w)[0]!.toUpperCase());
  if (letters.length > 0) return letters.join("");
  const f = Array.from(fallback.trim())[0];
  return f ? f.toUpperCase() : "?";
}

const isEditor = (role: OrgRole): boolean => (EDITOR_ROLES as readonly string[]).includes(role);

export function accountMenuModel(input: {
  orgs: readonly AccountMenuOrgInput[];
  activeOrgId: string | null;
  isPlayer: boolean;
}): AccountMenuModel {
  // The current org is the one the chrome shows (Nav resolves it with pickActiveOrg, path before cookie). An id that is none of
  // the user's orgs falls back to the first, exactly as pickActiveOrg does - so whenever there is an org, ONE is ticked and
  // Organisation settings has somewhere real to go; never zero ticks and an /orgs/new link for a user who has three clubs.
  const currentId = input.orgs.find((o) => o.id === input.activeOrgId)?.id ?? input.orgs[0]?.id ?? null;
  const orgs = input.orgs.map((o) => ({
    ...o,
    current: o.id === currentId,
    roleHint: isEditor(o.role) ? null : o.role,
    initials: initialsOf(o.name),
  }));
  const current = orgs.find((o) => o.current) ?? null;
  return {
    orgs,
    current,
    newOrgHref: NEW_ORG_HREF,
    settingsHref: current ? routes.orgSettings(current.slug) : null,
    profileHref: current ? routes.orgSettings(current.slug, "account") : null,
    playerHomeHref: input.isPlayer ? routes.me() : null,
  };
}

/** A page restored from the back/forward cache keeps its React state, so a menu that was busy (switching org, signing out) when
 *  the user left would stay disabled. On a persisted `pageshow` the caller resets; a normal load (persisted false) changes nothing. */
export function resetOnBfcacheRestore(event: { persisted: boolean }, reset: () => void): boolean {
  if (!event.persisted) return false;
  reset();
  return true;
}
