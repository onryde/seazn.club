import "server-only";
import { getCurrentUser, getUserOrgs } from "@/lib/auth";
import { hasFeature } from "@/lib/entitlements";

/**
 * The developer docs (`/developers/**`) are OFF for everyone by default (owner, 2026-11-16) and are switched on per
 * organisation by staff, with an entitlement override on this key in `/admin` (the organisation's overrides editor).
 *
 * No plan carries the key and none should: with no `plan_entitlements` row the resolver's base is empty, so only an
 * unexpired override row can answer true. That is what makes "off by default" a property of the data rather than of a
 * flag someone has to remember to set.
 */
export const DEVELOPER_DOCS_FEATURE = "developers.docs";

/** Whether ANY of these organisations has the docs switched on. An empty list is off. */
export async function developerDocsEnabledFor(orgIds: readonly string[]): Promise<boolean> {
  for (const orgId of orgIds) {
    if (await hasFeature(orgId, DEVELOPER_DOCS_FEATURE)) return true;
  }
  return false;
}

/**
 * Whether the person making this request may see the developer docs: signed in, and a member of at least one
 * organisation that has them switched on. Membership of any, not the active one — the docs are not an organisation
 * page, and a link to them must not stop working because the reader last looked at a different club.
 */
export async function canSeeDeveloperDocs(): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false;
  const orgs = await getUserOrgs(user.id);
  return developerDocsEnabledFor(orgs.map((o) => o.id));
}
