// Switching the active organisation, in ONE place: the settings header's OrgSwitcher and the gantry's account menu both switch
// an org, and both must flip the same cookie and land on the same page. Client-safe (no server imports).
import { api } from "@/lib/client";
import { routes } from "@/lib/routes";

/**
 * Where to land after switching from `oldSlug` to `newSlug`, given the current
 * path. Org-level paths — the org home (`/o/<slug>`) and any `/settings…`
 * sub-path — transfer to the SAME page under the new org, so switching from
 * Settings → Billing stays on Settings → Billing. A competition/entity path
 * (`/o/<slug>/c/…`, `/d/…`) belongs to the OLD org and can't exist under the
 * new one, so it falls back to the new org's home. Pure + exported for tests.
 */
export function orgSwitchTarget(
  pathname: string,
  oldSlug: string | undefined,
  newSlug: string,
): string {
  if (oldSlug) {
    const prefix = `/o/${oldSlug}`;
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      const rest = pathname.slice(prefix.length); // "" | "/settings…" | "/c/…"
      if (rest === "" || rest === "/settings" || rest.startsWith("/settings/")) {
        return `/o/${newSlug}${rest}`;
      }
    }
  }
  return routes.orgHome(newSlug);
}

export interface OrgSwitchDeps {
  /** Flip the active-org cookie. Default: `POST /api/orgs/active { org_id }`. */
  post?: (orgId: string) => Promise<unknown>;
  /** Default: a HARD navigation (`window.location.assign`) - see below. */
  navigate?: (url: string) => void;
}

/**
 * Make `toId` the active org and land on the same page under it. "same" when it already is (nothing is posted), "unknown" when
 * it is none of `orgs` (nothing is posted - there would be no page to land on), "navigated" otherwise. A failed POST rejects
 * and does not navigate.
 */
export async function switchActiveOrg(
  args: { orgs: readonly { id: string; slug: string }[]; fromId: string | null; toId: string; pathname: string },
  deps: OrgSwitchDeps = {},
): Promise<"same" | "unknown" | "navigated"> {
  if (args.toId === args.fromId) return "same";
  const target = args.orgs.find((o) => o.id === args.toId);
  if (!target) return "unknown";
  const post = deps.post ?? ((orgId: string) => api("/api/orgs/active", { method: "POST", json: { org_id: orgId } }));
  await post(target.id);
  // PROMPT-30: the URL owns which org a page shows — a cookie flip alone changes nothing, so navigate. Stay on the SAME page
  // under the new org (orgSwitchTarget swaps the /o/<slug> segment). HARD navigation, not router.push + router.refresh: the
  // active-org cookie was just flipped, and a client push while refresh() re-renders the OLD path against the NEW cookie can
  // bounce the user to the org home ("redirects to dashboard"). A full load applies the new org server-side and lands cleanly.
  const oldSlug = args.orgs.find((o) => o.id === args.fromId)?.slug;
  const navigate = deps.navigate ?? ((url: string) => window.location.assign(url));
  navigate(orgSwitchTarget(args.pathname, oldSlug, target.slug));
  return "navigated";
}
