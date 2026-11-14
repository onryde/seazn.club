import "server-only";
// "Add a match" on a quick match home (plan 2 Task 8; spec docs/superpowers/specs/2026-11-03-quick-match-design.md C5, C13,
// §7.1 point 3; pre-flight B8, D4): the extra league match a level table asks for, the decider. Anyone holding the home
// link may add one (C13). It is the existing ad-hoc match (`addFixture`): a new round at `max(round) + 1`, named
// `adhoc-<n>`, counted by the standings recompute once played.
//
// The checks, in this order, each refusing with its own QUICK_MATCH_ERRORS code before the next runs:
//   1. the post limit, per quick match (`qm-add:<id>`, MUTATION_LIMIT): its 429 carries no code;
//   2. the match's read, the per-match check of §7.1 point 3 (a League + Knockout's league by `loadLeagueCut`, which reads
//      the two stages; any other format by `readQuickMatchHome`): null when the competition is gone since the token resolved,
//      answered as EXPIRED so the caller lands on the dead link;
//   3. a league only (C5: a knockout has a winner by construction): LEAGUE_ONLY. A League + Knockout takes its decider on
//      its LEAGUE stage (plan 5 P15), and only until every league match is played or Not played (plan 5 D3, spec §6: the
//      knockout fills, or its tie is asked, from that league, and an open extra match would hold it up): LEAGUE_COMPLETE.
//      A plain league keeps taking one when it is finished: that is what a level table asks for (C5);
//   4. both sides are THIS quick match's own sides, compared as the home reads them, BEFORE `addFixture` sees an id, so a
//      missing field, a non-uuid or another quick match's side is a refusal and never a cast error: NOT_FOUND;
//   5. two different sides: SAME_SIDE;
//   6. fewer than QUICK_MATCH_MAX_ADHOC extra matches already (D4, no unbounded anonymous writes): ADHOC_LIMIT.
// `addFixture` refuses a bracket, the same entrant twice and an outsider itself (code-less 422s). Those are its own guards
// for every caller; here they never fire unless the checks above are wrong, so the caller reads them as faults.
//
// Known residual (recorded): the cap is counted before `addFixture`'s own transaction, so posts racing at the cap's edge can
// each pass it and land one extra match apiece. They are bounded by the post limit (step 1); the cap is a bound on abuse,
// not an invariant anything reads.
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { systemAuth } from "@/lib/quick-match-auth";
import { QUICK_MATCH_ERRORS, QUICK_MATCH_MAX_ADHOC, QUICK_MATCH_SYSTEM_ORG_ID } from "@/lib/quick-match-constants";
import { MUTATION_LIMIT, rateLimit } from "@/lib/rate-limit";
import { addFixture } from "@/server/usecases/stages";
import { loadLeagueCut } from "./quick-match-advance";
import { readQuickMatchHome, type QuickMatchRow } from "./quick-match-home";

/** The two sides the form names, as posted: null for a field that is missing or no string. */
export interface AddMatchPick {
  home: string | null;
  away: string | null;
}

/** A refused add hands the guest's two picks back to the home in these query parameters, beside `?e=` (T8 review m4): the
 *  home then opens "Add a match" at them instead of at its own pick, with or without a script. Only the add's refusals carry
 *  them, so their presence beside a flash is what says "a refused add". Spent with `?e=` (ClearFlashParam). */
export const ADD_PICK_PARAMS = ["home", "away"] as const;
/** An entrant id's shape: a pick that is no uuid is never handed back (it is no side, and it would only lengthen the URL). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The query a refused add lands on: the code, then each pick that is shaped like a side's id. */
export function refusedAddSearch(code: string, pick: AddMatchPick): string {
  const query = new URLSearchParams({ e: code });
  for (const name of ADD_PICK_PARAMS) {
    const value = pick[name];
    if (value !== null && UUID.test(value)) query.set(name, value);
  }
  return query.toString();
}

/** The extra matches already on the stage: spec C5 names each `adhoc-<n>`. */
async function adhocCount(stageId: string): Promise<number> {
  const [row] = await withTenant(QUICK_MATCH_SYSTEM_ORG_ID, (tx) => tx<{ n: number }[]>`
    select count(*)::int as n from fixtures where stage_id = ${stageId} and ext_key like 'adhoc-%'`);
  return row!.n;
}

/** Steps 2 and 3: the league an extra match lands on and the match's own sides, or null when the competition is gone. */
async function leagueOf(row: QuickMatchRow): Promise<{ stageId: string; sides: Set<string> } | null> {
  if (row.format === "league_knockout") {
    const cut = await loadLeagueCut(row);
    if (cut === null) return null;
    if (cut.leagueDone) {
      throw new HttpError(422, "the league is complete, so it takes no extra match", QUICK_MATCH_ERRORS.LEAGUE_COMPLETE);
    }
    const entrants = await withTenant(QUICK_MATCH_SYSTEM_ORG_ID, (tx) => tx<{ id: string }[]>`
      select id from entrants where division_id = ${cut.divisionId}`);
    return { stageId: cut.leagueStageId, sides: new Set(entrants.map((e) => e.id)) };
  }
  const home = await readQuickMatchHome(row);
  if (!home) return null;
  if (home.row.format !== "league") {
    throw new HttpError(422, "only a league takes an extra match", QUICK_MATCH_ERRORS.LEAGUE_ONLY);
  }
  return { stageId: home.stageId, sides: new Set(home.sides.map((s) => s.entrantId)) };
}

export async function addQuickMatchDecider(row: QuickMatchRow, pick: AddMatchPick): Promise<{ fixtureId: string }> {
  await rateLimit(`qm-add:${row.id}`, MUTATION_LIMIT);
  const league = await leagueOf(row);
  if (!league) throw new HttpError(404, "quick match not found or expired", QUICK_MATCH_ERRORS.EXPIRED);
  const { sides, stageId } = league;
  if (pick.home === null || pick.away === null || !sides.has(pick.home) || !sides.has(pick.away)) {
    throw new HttpError(404, "both sides must be this quick match's own", QUICK_MATCH_ERRORS.NOT_FOUND);
  }
  if (pick.home === pick.away) throw new HttpError(422, "a side cannot play itself", QUICK_MATCH_ERRORS.SAME_SIDE);
  if ((await adhocCount(stageId)) >= QUICK_MATCH_MAX_ADHOC) {
    throw new HttpError(422, `a quick match takes at most ${QUICK_MATCH_MAX_ADHOC} extra matches`, QUICK_MATCH_ERRORS.ADHOC_LIMIT);
  }
  const added = await addFixture(systemAuth(), stageId, { home_entrant_id: pick.home, away_entrant_id: pick.away });
  return { fixtureId: added.fixture_id };
}
