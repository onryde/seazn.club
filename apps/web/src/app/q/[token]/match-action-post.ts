// The quick match home's two per-match posts, "Not played" (`skip/[fixtureId]/route.ts`) and "Put back"
// (`put-back/[fixtureId]/route.ts`): quick match plan 4, Task 3 (plan docs/superpowers/plans/2026-11-13-quick-match-4-skip-
// match.md; spec docs/superpowers/specs/2026-11-12-quick-match-cancel-and-skip-design.md §3, §6). One handler, so the two
// routes can never answer one refusal two ways; each route names its usecase.
//
// Shaped exactly as the Score and Add a match posts are. The controls are plain `<form method="post">`s with no body, so they
// work with no script; the home token and the match ride the PATH only (O3), under `/q/`, a scrubbed secret path
// (lib/scrub-score-url.ts). Every answer is a 303 with a relative Location (D3), never JSON:
//   - a post that works lands on the bare home, `routes.quickMatch(token)`, which then shows the match Not played or back in
//     the list; so does a second tap that changed nothing (plan D3);
//   - a refusal lands on the home with `?e=<code>` (QUICK_MATCH_ERRORS), printed as the viewer's `quickMatch.flash.*` line
//     (home.tsx `homeFlash`);
//   - an unknown, changed or expired token lands on its own `/q/<token>` with nothing done: the home's one dead screen (D16).
//
// In this order: the token (`resolveQuickMatchToken`; an expired row is null), then the usecase, whose own checks run in its
// order (quick-match-skip.ts: the post limit, the id's shape, then under the fixture lock the per-match check, a league only,
// no bye, then the status), then the post is activity (plan D5, C1): `touchQuickMatchActivity`, best-effort as Score's and
// Add a match's are. The write already stands, so a failed touch is logged and the guest still lands on the home.
//
// Authorisation: the home token IS the credential (§7.4 of the quick match spec). Anyone holding the link may skip a match
// or put it back (skip spec §3, call 3), exactly as anyone holding it may Score or Edit result. Bot check: none, as for
// Score: the route-tree Turnstile sweep covers `app/api/**` only. Cross-site posts: the proxy's Origin check covers `/api/**`
// only, and this is a page path; a cross-site form can post here only with the home token, which gains it nothing a link
// holder does not already have.
//
// A refusal is a closed list (`REFUSALS`): the guest's own, answered with its flash and never reported. Everything else (a
// database error, an assertion in the usecase, any other code) is a fault: reported to Sentry and logged as `handler`
// reports one, then shown as the generic line.
import * as Sentry from "@sentry/nextjs";
import { handler, HttpError, redirectLocal } from "@/lib/http";
import { QUICK_MATCH_ERRORS } from "@/lib/quick-match-constants";
import { routes } from "@/lib/routes";
import { log } from "@/server/logger";
import { touchQuickMatchActivity } from "@/server/usecases/quick-match-activity";
import { resolveQuickMatchToken, type QuickMatchRow } from "@/server/usecases/quick-match-home";

/** The guest's refusals, by the status and code they are thrown with, and the code `?e=` names for each. `code: undefined`
 *  matches a code-less throw only. */
const REFUSALS: readonly { status: number; code: string | undefined; e: string }[] = [
  // The post limit (`qm-skip:<quick match id>`, MUTATION_LIMIT): its 429 carries no code (lib/rate-limit.ts). The generic
  // line ("try again") is true of it.
  { status: 429, code: undefined, e: QUICK_MATCH_ERRORS.ACTION_FAILED },
  // A fixture id that is no uuid, or a match outside this quick match, or a bye line.
  { status: 404, code: QUICK_MATCH_ERRORS.NOT_FOUND, e: QUICK_MATCH_ERRORS.NOT_FOUND },
  // Not played: a match with a result, or a knockout's (a bracket needs a winner).
  { status: 422, code: QUICK_MATCH_ERRORS.NOT_SKIPPABLE, e: QUICK_MATCH_ERRORS.NOT_SKIPPABLE },
  // Put back: the league has finished (a stale tap: the home hides Put back then).
  { status: 422, code: QUICK_MATCH_ERRORS.LEAGUE_FINISHED, e: QUICK_MATCH_ERRORS.LEAGUE_FINISHED },
];

/** The refusal an error is, or null for a fault. */
function refusalOf(err: unknown): string | null {
  if (!(err instanceof HttpError)) return null;
  return REFUSALS.find((r) => r.status === err.status && r.code === err.code)?.e ?? null;
}

/** The POST handler for one of the two posts: `label` names it in the logs, `act` is its usecase. */
export function matchActionPost(label: string, act: (row: QuickMatchRow, fixtureId: string) => Promise<unknown>) {
  return async function POST(_req: Request, { params }: { params: Promise<{ token: string; fixtureId: string }> }) {
    return handler(async () => {
      // Until the token is read, a failure has no home to land on: the site's root.
      let home = "/";
      try {
        const { token: raw, fixtureId } = await params;
        // Trimmed as the home page trims it. Encoded for the Location only: a token-shaped one is unchanged, and whatever
        // else the path held stays one segment under /q/, never a way out of it.
        const token = raw.trim();
        home = routes.quickMatch(encodeURIComponent(token));
        const qm = await resolveQuickMatchToken(token);
        if (!qm) return redirectLocal(home, 303);
        await act(qm, fixtureId);
        await touchQuickMatchActivity(qm.id).catch((err: unknown) => {
          log.error({ err, quickMatch: qm.id }, `quick match ${label}: activity touch failed (the write stands)`);
        });
        return redirectLocal(home, 303);
      } catch (err) {
        const refused = refusalOf(err);
        if (refused === null) {
          Sentry.captureException(err);
          log.error({ err }, `quick match ${label}: failed`);
        }
        return redirectLocal(`${home}?e=${refused ?? QUICK_MATCH_ERRORS.ACTION_FAILED}`, 303);
      }
    });
  };
}
