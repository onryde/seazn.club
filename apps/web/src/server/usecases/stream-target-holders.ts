import "server-only";
// server/usecases/stream-target-holders.ts — ONE answer to "which session holds this destination", read by the
// Directory list (`inUse`), Go live's refusal (`target_in_use`), and Replace key / Remove (`TARGET_IN_USE`). Spec
// §5.3 + §5.5. Held = an ACTIVE session references the target; this org's only (the target join is the tenancy floor).
import { sql, type Tx } from "@/lib/db";
import { routes } from "@/lib/routes";
import type { StreamTargetHolder } from "@/server/api-v1/schemas";
import { ACTIVE_STATES, holdStateOf, type HoldState, type SessionState } from "@/server/relay/domain/session";

type Executor = Tx | typeof sql;

export interface HolderRow {
  session_id: string; target_id: string; state: SessionState; fixture_id: string | null; fixture_no: number | null;
  court_name: string | null; label: string; org_slug: string | null; comp_slug: string | null; div_slug: string | null;
}

export interface TargetHolder {
  sessionId: string; targetId: string; fixtureId: string | null; href: string | null; matchNo: number | null;
  courtName: string | null; label: string; state: HoldState;
}

export function toTargetHolder(r: HolderRow): TargetHolder {
  const state = holdStateOf(r.state);
  if (state === null) throw new Error(`holderRows returned a terminal session ${r.session_id}`);
  const href = r.org_slug && r.comp_slug && r.div_slug && r.fixture_no !== null
    ? routes.fixture(r.org_slug, r.comp_slug, r.div_slug, r.fixture_no)
    : null;
  return {
    sessionId: r.session_id, targetId: r.target_id, fixtureId: r.fixture_id, href, matchNo: r.fixture_no,
    courtName: r.court_name, label: r.label, state,
  };
}

/** Oldest session first, so "the" holder of a target is stable across reads. `notFixtureId` leaves THIS fixture's own
 *  session out (`is distinct from`, so a deleted fixture's session still counts) — Go live's own-fixture case is
 *  `active_session`, answered elsewhere. */
export async function holderRows(
  exec: Executor, q: { orgId: string; targetId?: string; notFixtureId?: string },
): Promise<TargetHolder[]> {
  const targetId = q.targetId ?? null;
  const notFixtureId = q.notFixtureId ?? null;
  const rows = await exec<HolderRow[]>`
    select s.id as session_id, s.target_id, s.state, s.fixture_id, f.fixture_no, c.name as court_name, t.label,
           o.slug as org_slug, comp.slug as comp_slug, d.slug as div_slug
      from fixture_stream_sessions s
      join org_stream_targets t on t.id = s.target_id
      left join fixtures f on f.id = s.fixture_id
      left join courts c on c.id = f.court_id
      left join divisions d on d.id = f.division_id
      left join competitions comp on comp.id = d.competition_id
      left join organizations o on o.id = comp.org_id
     where t.org_id = ${q.orgId}
       and s.state in ${exec([...ACTIVE_STATES])}
       and (${targetId}::uuid is null or s.target_id = ${targetId}::uuid)
       and (${notFixtureId}::uuid is null or s.fixture_id is distinct from ${notFixtureId}::uuid)
     order by s.created_at asc, s.id asc`;
  return rows.map(toTargetHolder);
}

/** The 409 extra (Go live's `target_in_use`, PATCH/DELETE's `TARGET_IN_USE`). No session id: nothing a client does with it. */
export const wireHolder = (h: TargetHolder) => ({
  fixtureId: h.fixtureId, href: h.href, matchNo: h.matchNo, courtName: h.courtName, label: h.label, state: h.state,
});

/** The list's `inUse`. */
export const listHolder = (h: TargetHolder): StreamTargetHolder => ({
  sessionId: h.sessionId, fixtureId: h.fixtureId, href: h.href, matchNo: h.matchNo, courtName: h.courtName, state: h.state,
});
