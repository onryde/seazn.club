// The quick match home's per-match posts, "Not played" (`skip/[fixtureId]/route.ts`) and "Put back"
// (`put-back/[fixtureId]/route.ts`): quick match plan 4, Task 3 (plan docs/superpowers/plans/2026-11-13-quick-match-4-skip-
// match.md; spec docs/superpowers/specs/2026-11-12-quick-match-cancel-and-skip-design.md §3, §6); and a League + Knockout's
// answer to a tie at the cut, "Toss a coin" (`cut/toss/route.ts`) and "Pick who goes through" (`cut/pick/route.ts`): plan 5,
// Task 4 (docs/superpowers/plans/2026-11-13-quick-match-5-league-knockout.md D2, D5; spec 2026-11-12 league-knockout §5,
// §11). One handler, so no two of the routes can answer one refusal two ways; each route names its usecase.
//
// After the usecase, a route may name a follow-up (`after`): the skip and both cut routes pass `advanceQuickMatch` (plan 5 D2,
// callers b and c), so a skip that finishes a league, or the guests' answer to its tie, fills the knockout in the same
// request. Best-effort, like the activity touch: the write already stands, so a failed follow-up is logged
// (`quick_match_advance_failed`) and the guest still lands on the home, whose own load retries it (caller d).
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
// no bye, then the status; quick-match-advance.ts `decideQuickMatchCut`: the post limit, the read, then the question), then
// the follow-up when the route names one, then the post is activity (plan D5, C1): `touchQuickMatchActivity`, best-effort as
// Score's and Add a match's are. The write already stands, so a failed touch is logged and the guest still lands on the home.
// A competition gone since the token resolved (the usecase's 404 EXPIRED) lands on the bare home too, its dead screen, as
// Add a match's does.
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
  // The post limit (`qm-skip:<id>` or `qm-cut:<id>`, MUTATION_LIMIT): its 429 carries no code (lib/rate-limit.ts). The generic
  // line ("try again") is true of it.
  { status: 429, code: undefined, e: QUICK_MATCH_ERRORS.ACTION_FAILED },
  // A fixture id that is no uuid, or a match outside this quick match, or a bye line.
  { status: 404, code: QUICK_MATCH_ERRORS.NOT_FOUND, e: QUICK_MATCH_ERRORS.NOT_FOUND },
  // Not played: a match with a result, or a knockout's (a bracket needs a winner).
  { status: 422, code: QUICK_MATCH_ERRORS.NOT_SKIPPABLE, e: QUICK_MATCH_ERRORS.NOT_SKIPPABLE },
  // Put back: the league has finished (a stale tap: the home hides Put back then).
  { status: 422, code: QUICK_MATCH_ERRORS.LEAGUE_FINISHED, e: QUICK_MATCH_ERRORS.LEAGUE_FINISHED },
  // Toss or Pick: someone answered first, or the knockout has filled (plan 5 D5: the first decision wins).
  { status: 422, code: QUICK_MATCH_ERRORS.ALREADY_DECIDED, e: QUICK_MATCH_ERRORS.ALREADY_DECIDED },
  // Toss or Pick: no tie is open (the league is not finished, or a result moved the table since the page loaded, §11).
  { status: 422, code: QUICK_MATCH_ERRORS.TIE_NOT_OPEN, e: QUICK_MATCH_ERRORS.TIE_NOT_OPEN },
  // Pick: not exactly the open places' number of the tied sides (a crafted or no-JS post).
  { status: 422, code: QUICK_MATCH_ERRORS.PICK_INVALID, e: QUICK_MATCH_ERRORS.PICK_INVALID },
];

/** The competition is gone since the token resolved (a usecase's 404 EXPIRED): the dead link, as Add a match answers it. */
const goneMeanwhile = (err: unknown): boolean =>
  err instanceof HttpError && err.status === 404 && err.code === QUICK_MATCH_ERRORS.EXPIRED;

/** The refusal an error is, or null for a fault. */
function refusalOf(err: unknown): string | null {
  if (!(err instanceof HttpError)) return null;
  return REFUSALS.find((r) => r.status === err.status && r.code === err.code)?.e ?? null;
}

/** What a post does once its token resolved: its usecase, reading the request as it needs. */
type Act<P> = (row: QuickMatchRow, req: Request, params: P) => Promise<unknown>;
/** A follow-up after the usecase (the knockout's advance), best-effort. */
type After = (row: QuickMatchRow) => Promise<unknown>;

/** The one handler (the order above): `label` names it in the logs. */
function quickMatchPost<P extends { token: string }>(label: string, act: Act<P>, after: After | undefined) {
  return async function POST(req: Request, { params }: { params: Promise<P> }) {
    return handler(async () => {
      // Until the token is read, a failure has no home to land on: the site's root.
      let home = "/";
      try {
        const p = await params;
        // Trimmed as the home page trims it. Encoded for the Location only: a token-shaped one is unchanged, and whatever
        // else the path held stays one segment under /q/, never a way out of it.
        const token = p.token.trim();
        home = routes.quickMatch(encodeURIComponent(token));
        const qm = await resolveQuickMatchToken(token);
        if (!qm) return redirectLocal(home, 303);
        await act(qm, req, p);
        if (after) {
          // try/await, not `.catch`: a follow-up that throws before it returns a promise is the same best-effort failure.
          try {
            await after(qm);
          } catch (err) {
            log.error(
              { err, event: "quick_match_advance_failed", quickMatch: qm.id },
              `quick match ${label}: the knockout's advance failed (the write stands; the home retries it)`,
            );
          }
        }
        await touchQuickMatchActivity(qm.id).catch((err: unknown) => {
          log.error({ err, quickMatch: qm.id }, `quick match ${label}: activity touch failed (the write stands)`);
        });
        return redirectLocal(home, 303);
      } catch (err) {
        if (goneMeanwhile(err)) return redirectLocal(home, 303);
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

/** The POST handler for a per-match post (`/q/<token>/<action>/<fixtureId>`): `label` names it in the logs, `act` is its
 *  usecase, `after` its follow-up. */
export function matchActionPost(
  label: string,
  act: (row: QuickMatchRow, fixtureId: string) => Promise<unknown>,
  opts: { after?: After } = {},
) {
  return quickMatchPost<{ token: string; fixtureId: string }>(label, (row, _req, p) => act(row, p.fixtureId), opts.after);
}

/** The POST handler for a whole-match post (`/q/<token>/cut/<action>`): `act` reads the request it needs (the Pick's form). */
export function quickMatchActionPost(label: string, act: (row: QuickMatchRow, req: Request) => Promise<unknown>, opts: { after?: After } = {}) {
  return quickMatchPost<{ token: string }>(label, (row, req) => act(row, req), opts.after);
}
