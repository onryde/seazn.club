import "server-only";
// Court stream, the phone's side (spec seazn.club.capture docs/specs/2026-11-14-court-stream-design.md §5.3–§5.4; plan Task 6):
// what a resolved COURT code is, and the facts of its court's matches that `courtFocus` (relay/domain/court-stream.ts) turns
// into "which match is this phone's video". The resolve itself is `resolveAnyStreamCode` (stream-codes.ts), beside the
// fixture code's, so both kinds share one constant-time tok compare and one set of C1 rules.
//
// Every read here is on the non-tenant `sql` (or the caller's transaction): the phone carries no org session, and
// fixture_stream_codes / court_stream_links are FORCE RLS with no policy (V430, V525). The org is a WHERE, read from the link.
import { sql, type Tx } from "@/lib/db";
import { getDictionary, t, toLocale } from "@/lib/i18n";
import { codeEnded } from "@/server/api-v1/capture-http";
import { kickoffsOf } from "@/server/engine-db/kickoff";
import { courtFocus, type CourtFocus, type CourtMatchFacts } from "@/server/relay/domain/court-stream";
import { ACTIVE_STATES } from "@/server/relay/domain/session";
import { fitText, LABEL_MAX } from "./capture-phone";
import { IN_PLAY, liveCallSql } from "./match-day-call";
import type { ResolvedCode } from "./stream-codes";

/** A court link as a resolved court code carries it (V525's court_stream_links, the court's name joined). */
export type CourtLinkRef = {
  id: string;
  competitionId: string;
  courtId: string;
  courtName: string;
  opensAt: Date;
  expiresAt: Date;
  targetId: string;
  withdrawnAt: Date | null;
};

/** Is `now` inside the link's day (`opens_at <= now < expires_at`, the window `liveCourtLinkFor` reads in SQL)? A code minted for a
 *  later day is served, but starts nothing before its day opens (final review m-1). */
export const linkOpenAt = (link: Pick<CourtLinkRef, "opensAt" | "expiresAt">, now: Date): boolean =>
  link.opensAt.getTime() <= now.getTime() && now.getTime() < link.expiresAt.getTime();

/** A court's code, resolved: `ResolvedCode` without a fixture, with its link. `status` is C1's (C2 at the day's end). */
export type ResolvedCourtCode = {
  kind: "court";
  codeId: string;
  orgId: string;
  status: "active" | "finishing" | "ended";
  issuedBy: string;
  link: CourtLinkRef;
};

type FactRow = {
  id: string;
  status: string;
  scheduled_at: Date | null;
  round_no: number | null;
  seq_in_round: number | null;
  streamed: boolean;
  latched: boolean;
  ready: boolean;
  called_at: Date | null;
  sid: string | null;
  session_created_at: Date | null;
  start_cause: string | null;
};

/**
 * The facts of every match the court's phone may be asked about (spec §5.3), in Match Day's queue order (`queueOrder`):
 * the link's org's matches on the link's court that are planned inside the link's day, in play (whenever planned) or called
 * there by a call that still holds (`liveCallSql`) — match-day.ts's admission rule — and, on whatever court it now is, any
 * match under an open session of this link (controller ruling R8: the camera belongs to the court). `streamed` is the match's Stream switch, read as false while the match has its own ACTIVE code
 * (Task 4's guard, again here: a court never streams a match that has a phone of its own). `ready` is Match Day's rule:
 * both entrants known (match-day.ts `qualifies`, its entrant half). `kickoffAt` is read for the in-play ones only.
 */
export async function courtFactsOf(exec: Tx | typeof sql, link: CourtLinkRef): Promise<CourtMatchFacts[]> {
  const rows = await exec<FactRow[]>`
    select x.* from (
      select f.id, f.status, f.scheduled_at, f.round_no, f.seq_in_round,
             (coalesce(st.court_stream, false)
                and not exists (select 1 from fixture_stream_codes oc where oc.fixture_id = f.id and oc.ended_at is null)) as streamed,
             st.auto_start_blocked_at is not null as latched,
             (he.id is not null and ae.id is not null) as ready,
             lc.called_at,
             os.id as sid, os.created_at as session_created_at, os.start_cause
        from fixtures f
        left join entrants he on he.id = f.home_entrant_id
        left join entrants ae on ae.id = f.away_entrant_id
        left join fixture_stream_settings st on st.fixture_id = f.id
        left join lateral (
          select fc.called_at from fixture_calls fc join fixtures g on g.id = fc.fixture_id
           where fc.fixture_id = f.id and ${liveCallSql(exec)}) lc on true
        left join lateral (
          select s.id, s.created_at, s.start_cause from fixture_stream_sessions s
           where s.fixture_id = f.id and s.court_link_id = ${link.id} and s.state in ${sql([...ACTIVE_STATES])}
           order by s.created_at desc, s.id desc limit 1) os on true
       where f.org_id = (select l.org_id from court_stream_links l where l.id = ${link.id})
         -- Index-friendly prefilter (fixtures_court_idx OR the pkey): the court's matches, and the link's open ones.
         and (f.court_id = ${link.courtId}
              or f.id = any(array(select s.fixture_id from fixture_stream_sessions s
                                   where s.court_link_id = ${link.id} and s.state in ${sql([...ACTIVE_STATES])})))
         and ((f.court_id = ${link.courtId}
               and ((f.scheduled_at >= ${link.opensAt} and f.scheduled_at < ${link.expiresAt})
                    or f.status = ${IN_PLAY}
                    or lc.called_at is not null))
              -- R8: the camera is the court's. A match moved off the court mid-video stays until its session ends.
              or os.id is not null)
    ) x
    order by x.ready desc, x.called_at is null, x.called_at, x.scheduled_at nulls last, x.round_no nulls last,
             x.seq_in_round nulls last, x.id`;
  const kickoffs = await kickoffsOf(exec, rows.filter((r) => r.status === IN_PLAY).map((r) => r.id));
  return rows.map((r) => ({
    fixtureId: r.id,
    status: r.status,
    streamed: r.streamed,
    latched: r.latched,
    kickoffAt: kickoffs.get(r.id)?.at ?? null,
    calledAt: r.called_at,
    ready: r.ready,
    scheduledAt: r.scheduled_at,
    roundNo: r.round_no === null ? null : Number(r.round_no),
    seqInRound: r.seq_in_round === null ? null : Number(r.seq_in_round),
    openSession:
      r.sid === null || r.session_created_at === null
        ? null
        : { sid: r.sid, createdAt: r.session_created_at, byOrganiser: r.start_cause === "organiser" },
  }));
}

/** The court's facts and what they mean for its phone right now (`courtFocus`). */
export async function courtFocusOf(link: CourtLinkRef): Promise<{ facts: CourtMatchFacts[]; focus: CourtFocus }> {
  const facts = await courtFactsOf(sql, link);
  return { facts, focus: courtFocus(facts) };
}

/** The same court code, pointed at one match, for the per-fixture internals (sessions, pairings, the descriptor). */
export function asFixtureCode(court: ResolvedCourtCode, fixtureId: string): ResolvedCode {
  return { kind: "fixture", codeId: court.codeId, orgId: court.orgId, fixtureId, status: court.status, issuedBy: court.issuedBy };
}

/** A match's label for the phone (§6.4): "Home v Away" once both sides are known, else the org's locale's "Match N", fitted
 *  to the contract's maximum. The one rule, for a fixture code's waiting fields (`captureCommon`) and a court's. A match
 *  that is not the org's reads as an ended code, never a 500. */
export async function matchLabelOf(orgId: string, fixtureId: string): Promise<string> {
  const [ctx] = await sql<{ fixture_no: number; default_locale: string | null; home_name: string | null; away_name: string | null }[]>`
    select f.fixture_no, o.default_locale, h.display_name as home_name, a.display_name as away_name
      from fixtures f
      join divisions d on d.id = f.division_id
      join organizations o on o.id = d.org_id
      left join entrants h on h.id = f.home_entrant_id
      left join entrants a on a.id = f.away_entrant_id
     where f.id = ${fixtureId} and d.org_id = ${orgId}`;
  if (!ctx) throw codeEnded();
  const label = ctx.home_name !== null && ctx.away_name !== null
    ? `${ctx.home_name} v ${ctx.away_name}`
    : t(await getDictionary(toLocale(ctx.default_locale), "ui"), "breadcrumb.match", { no: ctx.fixture_no });
  return fitText(label, LABEL_MAX);
}
