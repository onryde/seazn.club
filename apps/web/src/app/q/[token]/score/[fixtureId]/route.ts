// POST /q/<token>/score/<fixtureId>: the guest's Score tap on the quick match home (quick match plan 2, Task 6; spec
// docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 3, §7.4, C1, C4, C18; pre-flight A7, A8, B6, D3).
//
// The home's Score control is a plain `<form method="post">` with no body, so it works with no script: the home token and the
// match ride the PATH only (O3), and this route sits under `/q/`, a scrubbed secret path (lib/scrub-score-url.ts). Every
// answer to that form is a 303 with a relative Location (D3), never JSON:
//   - a tap that works lands in the scoring pad, `/score/<device link>`: plan 1's `ensureGuestDeviceLink` re-opens the
//     match's live link or mints one, so a second tap, or a tap on a live or decided match, lands on the SAME link (Review
//     Focus 1); only a finalized match, or one marked Not played (`cancelled`, plan 4's skip), refuses;
//   - a refusal lands back on the home, `routes.quickMatch(token)?e=<code>`, where the code (QUICK_MATCH_ERRORS) is printed as
//     the viewer's own `quickMatch.flash.*` line (home.tsx `homeFlash`);
//   - an unknown, changed or expired token lands on its own `/q/<token>` with nothing added: the home's one dead screen, which
//     never says which (D16). So does a row that expires between the token's read and the mint (the mint's own 404
//     EXPIRED): the home it lands on reads the row expired too, and a flash there could only ever show on a live home,
//     where it would be false (T6 review m1).
//
// In this order, each step answering before the next runs:
//   1. the token, by plan 1's `resolveQuickMatchToken` (the shape before any lookup; an expired row is null);
//   2. the fixture id's shape, before the mint limit is spent on it (plan-1 T8 review: a malformed id is a refusal, not a
//      Postgres cast error);
//   3. `ensureGuestDeviceLink`: the mint limit per quick match, the per-match check (a fixture of another quick match is a
//      404), Not played (422 NOT_PLAYED: someone skipped it after this page loaded), finalized (422), both sides known
//      (C18), then the link;
//   4. the tap is activity (C1): `touchQuickMatchActivity`, best-effort as the scoring path's touch is: the link already
//      stands, so a failed touch is logged and the guest still lands in the pad.
//
// A refusal is a closed list (`REFUSALS`): the guest's own, answered with its flash and never reported. Everything else (a
// server without DEVICE_LINK_KEK, a database error, any other code) is a fault: reported to Sentry and logged as `handler`
// reports one, then shown as the generic line.
//
// "SCORE IN APP" (owner 2026-11-26; spec docs/superpowers/specs/2026-11-25-open-in-app-web-design.md §5.6). The home's own
// script posts to this SAME path with `QUICK_MATCH_APP_HEADER: 1` and is answered with the SAME tap, read as JSON:
//   - `{secret}`: the device link the 303 would have opened. The island builds `/app/score#<secret>` from it;
//   - `{location}`: every other answer, the exact relative Location the 303 would have carried (the home, with or without
//     `?e=`), so a refusal has one mapping and one set of words.
// Why JSON and not a 303 back to `/q/<token>#<secret>`: that would put the secret in the address bar and the browser's
// history (and the page URL analytics reads) the moment of the first tap. A response body reaches neither, replay does not
// record bodies (`recordBody: false`), and `no-store` keeps it out of every cache. The secret is never in a path or a query
// of this request. With no script there is no control and no such post: the form's contract above is unchanged.
//
// Cross-site posts: the proxy's Origin check covers `/api/**` only, and this is a page path.
//   - The form's 303: a cross-site form can post here only with the home token, which is the credential itself (§7.4): it
//     gains nothing a link holder does not already have, and it cannot read where it was sent.
//   - The JSON answer: a form cannot set a header, so it never gets it. A cross-origin `fetch` that sets it needs a CORS
//     preflight, and this route grants none (no `OPTIONS` export, no `Access-Control-*`). Should a browser say the request
//     is not same-origin anyway (`Sec-Fetch-Site`), it is a 403 before anything is read or minted.
import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { handler, HttpError, redirectLocal } from "@/lib/http";
import { QUICK_MATCH_APP_HEADER, QUICK_MATCH_ERRORS } from "@/lib/quick-match-constants";
import { routes } from "@/lib/routes";
import { assertUuid } from "@/server/api-v1/auth";
import { log } from "@/server/logger";
import { ensureGuestDeviceLink } from "@/server/usecases/device-links";
import { touchQuickMatchActivity } from "@/server/usecases/quick-match-activity";
import { resolveQuickMatchToken } from "@/server/usecases/quick-match-home";

/**
 * The guest's refusals, by the status and code they are thrown with, and the code `?e=` names for each. `code: undefined`
 * matches a code-less throw only. The copy for each is T1's table (task-1-report.md); the device link's code-less 422
 * (finalized, device-links.ts `assertLinkableStatus`) is the generic line, not "not yet" (ledger CARRY to T6).
 */
const REFUSALS: readonly { status: number; code: string | undefined; e: string }[] = [
  // The mint limiter (`qm-mint:<quick match id>`, DEVICE_LINK_MINT_LIMIT): its 429 carries no code (lib/rate-limit.ts).
  { status: 429, code: undefined, e: QUICK_MATCH_ERRORS.LINK_LIMITED },
  // A fixture id that is no uuid (`assertUuid`), or a fixture outside this quick match (`linkableStatus`).
  { status: 404, code: undefined, e: QUICK_MATCH_ERRORS.NOT_FOUND },
  // A side not known yet (C18): a waiting knockout seat, a bye.
  { status: 422, code: QUICK_MATCH_ERRORS.SIDES_UNKNOWN, e: QUICK_MATCH_ERRORS.SIDES_UNKNOWN },
  // Marked Not played (plan 4) since this page loaded: the home says to put it back first (T1 review G1), never "try again".
  { status: 422, code: QUICK_MATCH_ERRORS.NOT_PLAYED, e: QUICK_MATCH_ERRORS.NOT_PLAYED },
  // Finalized: nothing left to score.
  { status: 422, code: undefined, e: QUICK_MATCH_ERRORS.ACTION_FAILED },
];

/** The row expired between the token's read and the mint (`ensureGuestDeviceLink`'s own expiry check): the dead link. */
const expiredMeanwhile = (err: unknown): boolean =>
  err instanceof HttpError && err.status === 404 && err.code === QUICK_MATCH_ERRORS.EXPIRED;

/** The refusal an error is, or null for a fault. */
function refusalOf(err: unknown): string | null {
  if (!(err instanceof HttpError)) return null;
  return REFUSALS.find((r) => r.status === err.status && r.code === err.code)?.e ?? null;
}

/** Where one tap ends: the pad, by its device link, or a page on this site (the home, with or without `?e=`). The second
 *  field is `path`, a generic name, on purpose: scrub-secret-painters.test.ts reads a route's object fields that hold a
 *  credential URL as app-wide names, and `home` is a word half the app uses. */
type Outcome = { secret: string } | { path: string };

async function tapOutcome(params: Promise<{ token: string; fixtureId: string }>): Promise<Outcome> {
  // Until the token is read, a failure has no home to land on: the site's root.
  let home = "/";
  try {
    const { token: raw, fixtureId } = await params;
    // Trimmed as the home page trims it (Review Focus 3). Encoded for the Location only: a token-shaped one is unchanged,
    // and whatever else the path held stays one segment under /q/, never a way out of it.
    const token = raw.trim();
    home = routes.quickMatch(encodeURIComponent(token));
    const qm = await resolveQuickMatchToken(token);
    if (!qm) return { path: home };
    assertUuid(fixtureId, "fixture");
    const link = await ensureGuestDeviceLink(qm, fixtureId);
    await touchQuickMatchActivity(qm.id).catch((err: unknown) => {
      log.error({ err, quickMatch: qm.id }, "quick match score: activity touch failed (the link stands)");
    });
    return { secret: link.secret };
  } catch (err) {
    if (expiredMeanwhile(err)) return { path: home };
    const refused = refusalOf(err);
    if (refused === null) {
      Sentry.captureException(err);
      log.error({ err }, "quick match score: failed");
    }
    return { path: `${home}?e=${refused ?? QUICK_MATCH_ERRORS.ACTION_FAILED}` };
  }
}

/** The form's answer (D3). */
const redirectAnswer = (outcome: Outcome) =>
  redirectLocal("secret" in outcome ? `/score/${outcome.secret}` : outcome.path, 303);

/** The home's own fetch. `location` is read off the form's answer, so it is encoded exactly as a browser would be sent it. */
const appAnswer = (outcome: Outcome) =>
  NextResponse.json(
    "secret" in outcome ? { secret: outcome.secret } : { location: redirectAnswer(outcome).headers.get("location") },
    { headers: NO_STORE },
  );

const NO_STORE = { "cache-control": "no-store" } as const;

export async function POST(req: Request, { params }: { params: Promise<{ token: string; fixtureId: string }> }) {
  const fromApp = req.headers.get(QUICK_MATCH_APP_HEADER) === "1";
  if (fromApp) {
    const site = req.headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin") return new NextResponse(null, { status: 403, headers: NO_STORE });
  }
  return handler(async () => (fromApp ? appAnswer : redirectAnswer)(await tapOutcome(params)));
}
