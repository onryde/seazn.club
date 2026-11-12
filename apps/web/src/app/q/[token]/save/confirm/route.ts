// POST /q/<token>/save/confirm: the Save button's post, the ONE write of the save flow (quick match plan 3, Task 5; spec
// docs/superpowers/specs/2026-11-03-quick-match-design.md §7.7 as amended 2026-11-08, C3, C19; plan 3 Amend T5 [D2, B22],
// ledger carry m5). The home's Save and the save page's button are the same plain `<form method="post">`, so it works with
// no script. POST only: a GET of this path is Next's 405, and the save page's GET never writes.
//
// In this order, every answer a 303 with a relative Location (plan 2's pattern, D3), never JSON:
//   1. a post from another site is refused 403 before anything is read. The proxy's Origin check covers `/api/**` only, and
//      this is a page path, so the route asks itself: a `Sec-Fetch-Site` other than `same-origin` (a sibling subdomain is
//      `same-site`, an address-bar post `none`: neither is our page), or an `Origin` whose host is not ours (or no host at
//      all: `Origin: null`).
//   2. a post with no proof it came from our page (neither header, or an empty `Origin`: lib/same-origin.ts's rule, review
//      m1) lands on the home's generic line, nothing read or written. Every browser sends at least one on a form post.
//   3. the token (trimmed, as the home trims it): unknown, malformed, expired or deleted lands on its own `/q/<token>`, the
//      dead screen, never on a sign-in.
//   4. signed out: the sign-in, `next=/q/<token>/save` (C19 amended: the hand-off is the one place the token rides a query;
//      the scrubber covers it, scrub-quick-match-next.test.ts). The save page is where the person lands after signing in.
//   5. a session staff impersonation started (`getCurrentSession().impersonated`, the session's signed `imp` claim, read in
//      the same verify as the user; ledger carry m5): `?e=QUICK_MATCH_SAVE_IMPERSONATED`, nothing written. Staff never save
//      a guest's match into the account they look through.
//   6. `saveQuickMatchForUser` (plan 3 Task 4): saved or already yours lands on the bare home (which then says "Saved");
//      taken lands on the home with `?e=QUICK_MATCH_TAKEN` (`quickMatch.flash.taken`); gone (expired since the read) lands on
//      the bare home, the dead screen.
// A fault (a database error) is reported to Sentry and logged, then shown as the generic line.
//
// Bot check: none. Only a holder of the home link can post here (the token is the credential, §7.4), and only a signed-in
// person writes anything; the route-tree Turnstile sweep covers `app/api/**` only.
import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/auth";
import { handler, redirectLocal } from "@/lib/http";
import { QUICK_MATCH_ERRORS } from "@/lib/quick-match-constants";
import { routes } from "@/lib/routes";
import { isSameOriginRequest } from "@/lib/same-origin";
import { log } from "@/server/logger";
import { resolveQuickMatchToken } from "@/server/usecases/quick-match-home";
import { saveQuickMatchForUser } from "@/server/usecases/quick-match-save";

/** This request's own host: the forwarded one behind the edge (Fly sets it; proxy.ts `requestHostname` reads it the same
 *  way), then Host, then the URL's. Port stripped. */
function ownHostname(req: Request): string {
  const raw = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host") || new URL(req.url).host;
  try {
    return new URL(`http://${raw}`).hostname;
  } catch {
    return raw.split(":")[0] ?? raw;
  }
}

/** Did a browser say this post came from another site? */
function crossSite(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return true;
  const origin = req.headers.get("origin");
  if (origin === null || origin === "") return false;
  try {
    return new URL(origin).hostname !== ownHostname(req);
  } catch {
    return true; // `Origin: null` (a sandboxed frame, a data: page) and anything unparseable name no host of ours
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  return handler(async () => {
    if (crossSite(req)) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    // Until the token is read, a failure has no home to land on: the site's root.
    let home = "/";
    try {
      const { token: raw } = await params;
      // Encoded for the Location only: a token-shaped one is unchanged, and whatever else the path held stays one segment
      // under /q/, never a way out of it.
      const token = raw.trim();
      home = routes.quickMatch(encodeURIComponent(token));
      // No proof of our page (cross-site posts were refused above, so this is a post with neither header).
      if (!isSameOriginRequest(req.headers)) return redirectLocal(`${home}?e=${QUICK_MATCH_ERRORS.ACTION_FAILED}`, 303);
      const qm = await resolveQuickMatchToken(token);
      if (!qm) return redirectLocal(home, 303);

      const session = await getCurrentSession();
      if (!session) {
        return redirectLocal(`/login?next=${encodeURIComponent(routes.quickMatchSave(token))}`, 303);
      }
      if (session.impersonated) {
        return redirectLocal(`${home}?e=${QUICK_MATCH_ERRORS.SAVE_IMPERSONATED}`, 303);
      }

      const outcome = await saveQuickMatchForUser(session.user.id, qm.id);
      switch (outcome) {
        case "saved":
        case "already_yours":
        case "gone":
          return redirectLocal(home, 303);
        case "taken":
          return redirectLocal(`${home}?e=${QUICK_MATCH_ERRORS.TAKEN}`, 303);
        default: {
          const unhandled: never = outcome;
          throw new Error(`quick match save: unhandled outcome ${String(unhandled)}`);
        }
      }
    } catch (err) {
      Sentry.captureException(err);
      log.error({ err }, "quick match save: failed");
      return redirectLocal(`${home}?e=${QUICK_MATCH_ERRORS.ACTION_FAILED}`, 303);
    }
  });
}
