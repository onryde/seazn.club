// POST /q/<token>/add-match: "Add a match" on the quick match home, the decider a league takes (quick match plan 2, Task 8;
// spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 3, C5, C13; pre-flight B8, D3, D4).
//
// The home's control is a plain `<form method="post">` with two selects, `home` and `away` (entrant ids), so it works with
// no script. The home token rides the PATH only (O3), under `/q/`, a scrubbed secret path (lib/scrub-score-url.ts). Every
// answer is a 303 with a relative Location (D3), never JSON:
//   - an add that works lands back on the bare home, `routes.quickMatch(token)`, where the new match is then listed and,
//     when nothing else is left to play, up next;
//   - a refusal lands on the home with `?e=<code>` (QUICK_MATCH_ERRORS), printed as the viewer's `quickMatch.flash.*` line
//     (home.tsx `homeFlash`);
//   - an unknown, changed or expired token, or a quick match gone since its token was read, lands on its own `/q/<token>`
//     with nothing added: the home's one dead screen, which never says which (D16).
//
// In this order (the checks themselves are `addQuickMatchDecider`'s, which lists them): the token (plan 1's
// `resolveQuickMatchToken`; an expired row is null), then the form's two fields, then the add: the post limit, a league
// only, both sides this quick match's own, two different sides, the cap. Then the add is activity (C1):
// `touchQuickMatchActivity`, best-effort as the Score tap's is: the match already stands, so a failed touch is logged and the
// guest still lands on the home.
//
// A refusal is a closed list (`REFUSALS`): the guest's own, answered with its flash and never reported. Everything else (a
// database error, `addFixture` refusing a post the checks passed, any other code) is a fault: reported to Sentry and logged
// as `handler` reports one, then shown as the generic line.
//
// Bot check: none, as for the Score post. Only a holder of the home link can post here (the token is the credential, §7.4),
// and the route-tree Turnstile sweep covers `app/api/**` only. Cross-site posts: the proxy's Origin check covers `/api/**`
// only, and this is a page path; a cross-site form can post here only with the home token, which gains it nothing a link
// holder does not already have.
import * as Sentry from "@sentry/nextjs";
import { handler, HttpError, redirectLocal } from "@/lib/http";
import { QUICK_MATCH_ERRORS } from "@/lib/quick-match-constants";
import { routes } from "@/lib/routes";
import { log } from "@/server/logger";
import { addQuickMatchDecider, type AddMatchPick } from "@/server/usecases/quick-match-add";
import { touchQuickMatchActivity } from "@/server/usecases/quick-match-activity";
import { resolveQuickMatchToken } from "@/server/usecases/quick-match-home";

/** The guest's refusals, by the status and code they are thrown with, and the code `?e=` names for each. `code: undefined`
 *  matches a code-less throw only. */
const REFUSALS: readonly { status: number; code: string | undefined; e: string }[] = [
  // The post limit (`qm-add:<quick match id>`, MUTATION_LIMIT): its 429 carries no code (lib/rate-limit.ts). No guest posts
  // sixty adds a minute; the generic line ("try again") is true of it.
  { status: 429, code: undefined, e: QUICK_MATCH_ERRORS.ACTION_FAILED },
  { status: 422, code: QUICK_MATCH_ERRORS.LEAGUE_ONLY, e: QUICK_MATCH_ERRORS.LEAGUE_ONLY },
  { status: 404, code: QUICK_MATCH_ERRORS.NOT_FOUND, e: QUICK_MATCH_ERRORS.NOT_FOUND },
  { status: 422, code: QUICK_MATCH_ERRORS.SAME_SIDE, e: QUICK_MATCH_ERRORS.SAME_SIDE },
  { status: 422, code: QUICK_MATCH_ERRORS.ADHOC_LIMIT, e: QUICK_MATCH_ERRORS.ADHOC_LIMIT },
];

/** The competition is gone since the token resolved (`addQuickMatchDecider`'s null home read): the dead link. */
const goneMeanwhile = (err: unknown): boolean =>
  err instanceof HttpError && err.status === 404 && err.code === QUICK_MATCH_ERRORS.EXPIRED;

/** The refusal an error is, or null for a fault. */
function refusalOf(err: unknown): string | null {
  if (!(err instanceof HttpError)) return null;
  return REFUSALS.find((r) => r.status === err.status && r.code === err.code)?.e ?? null;
}

/** The two selects as posted. A body that is no form (another content type, a broken body) names no side, which the add
 *  refuses as NOT_FOUND: never the handler's JSON 400. */
async function pickOf(req: Request): Promise<AddMatchPick> {
  const form = await req.formData().catch(() => null);
  const field = (name: string) => {
    const value = form?.get(name);
    return typeof value === "string" ? value : null;
  };
  return { home: field("home"), away: field("away") };
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  return handler(async () => {
    // Until the token is read, a failure has no home to land on: the site's root.
    let home = "/";
    try {
      const { token: raw } = await params;
      // Trimmed as the home page trims it (Review Focus 3). Encoded for the Location only: a token-shaped one is unchanged,
      // and whatever else the path held stays one segment under /q/, never a way out of it.
      const token = raw.trim();
      home = routes.quickMatch(encodeURIComponent(token));
      const qm = await resolveQuickMatchToken(token);
      if (!qm) return redirectLocal(home, 303);
      await addQuickMatchDecider(qm, await pickOf(req));
      await touchQuickMatchActivity(qm.id).catch((err: unknown) => {
        log.error({ err, quickMatch: qm.id }, "quick match add: activity touch failed (the match stands)");
      });
      return redirectLocal(home, 303);
    } catch (err) {
      if (goneMeanwhile(err)) return redirectLocal(home, 303);
      const refused = refusalOf(err);
      if (refused === null) {
        Sentry.captureException(err);
        log.error({ err }, "quick match add: failed");
      }
      return redirectLocal(`${home}?e=${refused ?? QUICK_MATCH_ERRORS.ACTION_FAILED}`, 303);
    }
  });
}
