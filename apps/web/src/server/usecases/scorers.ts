import "server-only";
// Fixture scoring authority: requireScorable gate and accepted-official
// coverage. Org-member scorers and assignment-table auth were retired (#707).
import type postgres from "postgres";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";

export interface FixtureScope {
  id: string;
  org_id: string;
  division_id: string;
  competition_id: string;
  status: string;
  scorer_can_finalize: boolean;
  scorer_can_enter_lineups: boolean;
}

/** Fixture + the scope ids and scorer capability flags in one superuser read
 *  (auth-path helper; RLS-bounded reads happen in the use-cases proper). */
export async function fixtureScope(fixtureId: string): Promise<FixtureScope | null> {
  const [row] = await sql<FixtureScope[]>`
    select f.id, f.org_id, f.division_id, d.competition_id, f.status,
           d.scorer_can_finalize, d.scorer_can_enter_lineups
    from fixtures f join divisions d on d.id = f.division_id
    where f.id = ${fixtureId} limit 1`;
  return row ?? null;
}

/** Does the user hold an ACCEPTED official assignment covering this fixture?
 *  Officials are usually NOT org members, so this is a superuser read pinned
 *  through persons.user_id = the user and officials.person_id (the tenant door
 *  never opens for them). Only 'accepted' passes — a pending or declined
 *  assignment grants no scoring rights (design v2 §A5). */
export async function acceptedOfficialCovers(userId: string, fixtureId: string): Promise<boolean> {
  return acceptedOfficialOn(userId, sql`fo.fixture_id = ${fixtureId}`);
}

/** The same question over every fixture of a competition: does the user hold an ACCEPTED assignment on ANY of them? The
 *  competition realtime door's official path (realtime push nudges, plan Task 12, pin 17). One predicate with
 *  `acceptedOfficialCovers` (`acceptedOfficialOn`), so a pending or declined assignment, or a withdrawn one (its row gone),
 *  grants nothing here either. */
export async function acceptedOfficialInCompetition(userId: string, competitionId: string): Promise<boolean> {
  return acceptedOfficialOn(
    userId,
    sql`fo.fixture_id in (select f.id from fixtures f join divisions d on d.id = f.division_id where d.competition_id = ${competitionId})`,
  );
}

/** The accepted-official predicate, spelt ONCE: an assignment row in `fixtures` whose official is the user's person and
 *  whose response is 'accepted'. */
async function acceptedOfficialOn(userId: string, fixtures: postgres.Fragment): Promise<boolean> {
  const rows = await sql`
    select 1 from fixture_officials fo
    join officials o on o.id = fo.official_id
    join persons p on p.id = o.person_id
    where ${fixtures} and p.user_id = ${userId}
      and fo.response = 'accepted'
    limit 1`;
  return rows.length > 0;
}

/** Per-division scorer capability flags bind non-editors (accepted officials). */
export function subjectToScorerCapabilityGates(auth: AuthCtx): boolean {
  if (auth.via === "api_key") return false;
  if (auth.role === "owner" || auth.role === "admin") return false;
  return true;
}

/**
 * THE scorer gate: editor roles and write-scoped API keys pass; everyone else
 * passes iff they hold an accepted fixture_officials assignment. Returns the
 * fixture scope so callers can apply the capability config without a second lookup.
 */
export async function requireScorable(auth: AuthCtx, fixtureId: string): Promise<FixtureScope> {
  const scope = await fixtureScope(fixtureId);
  if (!scope || scope.org_id !== auth.orgId) throw new HttpError(404, "fixture not found");
  if (auth.via === "api_key") return scope;
  if (auth.role === "owner" || auth.role === "admin") return scope;
  if (auth.userId && (await acceptedOfficialCovers(auth.userId, fixtureId))) return scope;
  throw new HttpError(403, "Your role cannot record scores");
}
