import "server-only";
// Card-grid aggregates (v3/03 §1–2): the EntityCard's meta / "Next:" /
// progress lines in one query per list — no N+1 across a 3-column grid.
// Read-only; RLS scopes everything through withTenant.
import { withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
// #14: `courtNamesById` is the venue-qualified label map (via
// `buildCourtDirectory`) — a bare joined `courts.name` can't tell apart two
// venues that legally share one court name.
import { courtNamesById } from "./schedule";

export interface NextFixture {
  home: string | null;
  away: string | null;
  court_label: string | null;
  scheduled_at: string | null;
  in_play: boolean;
}

/** The lateral subquery's raw shape — `court_id`, not the resolved label;
 *  `resolveNextCourtLabel` below turns this into the public `NextFixture`
 *  once a `courtNames` map is in hand. */
type NextFixtureRaw = Omit<NextFixture, "court_label"> & { court_id: string | null };

/** #14: same fallback convention as FixtureRow's own doc comment (stages.ts)
 *  — fall back to the id itself on a miss (should not happen; FK-restricted
 *  from `fixtures.court_id`). Shared by both card queries below. */
function resolveNextCourtLabel(
  next: NextFixtureRaw | null,
  courtNames: ReadonlyMap<string, string>,
): NextFixture | null {
  if (!next) return null;
  const { court_id, ...rest } = next;
  return { ...rest, court_label: court_id !== null ? (courtNames.get(court_id) ?? court_id) : null };
}

export interface CompetitionCardStats {
  competition_id: string;
  divisions: number;
  entrants: number;
  played: number;
  total: number;
  /** Most common division sport — drives the card banner tint (v8). */
  top_sport: string | null;
  next: NextFixture | null;
}

export interface DivisionCardStats {
  division_id: string;
  entrants: number;
  /** RS004 W2b review finding 1: non-terminal `registrations` count for
   *  this division — pending, paid, confirmed, waitlisted. Rejected,
   *  withdrawn and expired are excluded (terminal, can never re-open).
   *  Deliberately distinct from `entrants` above: an `entrants` row exists
   *  only once an entry is MATERIALISED (registrations.ts's materialise(),
   *  which runs at submit for a free/auto/non-waitlisted entry, or at
   *  organiser approval otherwise) — so `entrants` alone reads zero for a
   *  paid entry still awaiting manual approval, or any waitlisted entry.
   *  This is the field the competition overview's Registration pill sums
   *  for its "total registered" badge. */
  registered: number;
  /** Subset of `registered` not yet confirmed: pending, paid, waitlisted.
   *  The pill's distinct "needs your attention" signal, kept separate from
   *  `registered` so the headline number never reads as "all done" when
   *  some of it is still pending review or a free capacity slot. */
  awaiting_confirmation: number;
  capacity: number | null;
  stage_kinds: string[];
  registration_open: boolean;
  played: number;
  total: number;
  next: NextFixture | null;
}

// "Played" = a result exists (decided/finalized); denominator excludes
// cancelled fixtures. Matches how organisers count a matchday.
const PLAYED = ["decided", "finalized"] as const;

// RS004 W2b review finding 1 — declared locally, NOT imported from
// registrations.ts (which has its own, slightly different-purposed
// SPOT_HOLDERS: "holds a capacity spot", pending|paid|confirmed, no
// waitlisted) or registration-approval.ts: those modules pull in
// Stripe/email clients this read-only, RLS-scoped file has no business
// loading — same precedent as registration/page.tsx's own local
// SPOT_HOLDERS copy, and this file's own PLAYED just above.
//
// Every status except the three terminal ones — a registration that is
// still, in some sense, "in the system".
const REGISTERED_STATUSES = ["pending", "paid", "confirmed", "waitlisted"] as const;
// Not yet confirmed — no entrant has been materialised for these. 'paid'
// belongs here deliberately: RULING B (registrations.ts's
// confirmPaidRegistration) leaves a Stripe-paid manual-approval entry
// sitting at exactly 'paid' — money has moved, but a human still has to
// approve it, the same "needs the organiser's attention" bucket
// pending/waitlisted already sit in. It is money-real but not yet
// roster-real, so it counts in `registered` (the entry undeniably exists)
// AND in `awaiting_confirmation` (nothing has been materialised for it
// yet) — never treated as "done", never as zero.
const AWAITING_CONFIRMATION_STATUSES = ["pending", "paid", "waitlisted"] as const;

export async function listCompetitionCardStats(
  auth: AuthCtx,
): Promise<Map<string, CompetitionCardStats>> {
  const rows = await withTenant(auth.orgId, async (tx) => {
    const raw = await tx<(Omit<CompetitionCardStats, "next"> & { next: NextFixtureRaw | null })[]>`
      select c.id as competition_id,
        (select count(*)::int from divisions d
          where d.competition_id = c.id and d.archived_at is null) as divisions,
        (select count(*)::int from entrants e
          join divisions d on d.id = e.division_id
          where d.competition_id = c.id and d.archived_at is null
            and e.status in ('registered','confirmed')) as entrants,
        (select count(*)::int from fixtures f
          join divisions d on d.id = f.division_id
          where d.competition_id = c.id and d.archived_at is null
            and f.status in ${tx([...PLAYED])}) as played,
        (select count(*)::int from fixtures f
          join divisions d on d.id = f.division_id
          where d.competition_id = c.id and d.archived_at is null
            and f.status <> 'cancelled') as total,
        (select d.sport_key from divisions d
          where d.competition_id = c.id and d.archived_at is null
          group by d.sport_key order by count(*) desc, d.sport_key limit 1) as top_sport,
        nf.next
      from competitions c
      left join lateral (
        -- #14: the JSON carries court_id, not a bare joined courts.name
        -- (two venues may legally share one court name) — resolved to the
        -- venue-qualified court_label by resolveNextCourtLabel below,
        -- which is what nextLine() (same file) actually reads.
        select jsonb_build_object(
            'home', he.display_name, 'away', ae.display_name,
            'court_id', f.court_id, 'scheduled_at', f.scheduled_at,
            'in_play', f.status = 'in_play') as next
        from fixtures f
        join divisions d on d.id = f.division_id
        left join entrants he on he.id = f.home_entrant_id
        left join entrants ae on ae.id = f.away_entrant_id
        where d.competition_id = c.id and d.archived_at is null
          and f.status in ('scheduled','in_play')
          -- D4a (P5): a TBD/seeded fixture (either slot still unfilled) is
          -- not a real "what's next" answer — it can't be played yet, and
          -- LEFT JOINing entrant names alone let it silently surface with a
          -- blank home/away when its scheduled_at happened to sort first
          -- (e.g. a final pinned on day one). Same precondition scoring
          -- already enforces (append-event.ts's WRONG_PHASE guard).
          and f.home_entrant_id is not null and f.away_entrant_id is not null
        order by (f.status = 'in_play') desc,
                 f.scheduled_at asc nulls last, f.round_no, f.seq_in_round
        limit 1
      ) nf on true`;
    const courtNames = await courtNamesById(tx);
    return raw.map((r) => ({ ...r, next: resolveNextCourtLabel(r.next, courtNames) }));
  });
  return new Map(rows.map((r) => [r.competition_id, r]));
}

export async function listDivisionCardStats(
  auth: AuthCtx,
  competitionId: string,
): Promise<Map<string, DivisionCardStats>> {
  const rows = await withTenant(auth.orgId, async (tx) => {
    const raw = await tx<(Omit<DivisionCardStats, "next"> & { next: NextFixtureRaw | null })[]>`
      select d.id as division_id,
        (select count(*)::int from entrants e
          where e.division_id = d.id
            and e.status in ('registered','confirmed')) as entrants,
        (select count(*)::int from registrations r
          where r.division_id = d.id
            and r.status in ${tx([...REGISTERED_STATUSES])}) as registered,
        (select count(*)::int from registrations r
          where r.division_id = d.id
            and r.status in ${tx([...AWAITING_CONFIRMATION_STATUSES])}) as awaiting_confirmation,
        rs.capacity,
        coalesce(rs.enabled, false)
          and (rs.opens_at is null or rs.opens_at <= now())
          and (rs.closes_at is null or rs.closes_at > now()) as registration_open,
        coalesce((select array_agg(distinct s.kind order by s.kind)
          from stages s where s.division_id = d.id), '{}') as stage_kinds,
        (select count(*)::int from fixtures f
          where f.division_id = d.id and f.status in ${tx([...PLAYED])}) as played,
        (select count(*)::int from fixtures f
          where f.division_id = d.id and f.status <> 'cancelled') as total,
        nf.next
      from divisions d
      left join registration_settings rs on rs.division_id = d.id
      left join lateral (
        -- #14: same court_id -> resolveNextCourtLabel swap as
        -- listCompetitionCardStats above.
        select jsonb_build_object(
            'home', he.display_name, 'away', ae.display_name,
            'court_id', f.court_id, 'scheduled_at', f.scheduled_at,
            'in_play', f.status = 'in_play') as next
        from fixtures f
        left join entrants he on he.id = f.home_entrant_id
        left join entrants ae on ae.id = f.away_entrant_id
        where f.division_id = d.id and f.status in ('scheduled','in_play')
          -- D4a (P5): see listCompetitionCardStats above — a TBD/seeded slot
          -- is never a real "next" answer.
          and f.home_entrant_id is not null and f.away_entrant_id is not null
        order by (f.status = 'in_play') desc,
                 f.scheduled_at asc nulls last, f.round_no, f.seq_in_round
        limit 1
      ) nf on true
      where d.competition_id = ${competitionId} and d.archived_at is null`;
    const courtNames = await courtNamesById(tx);
    return raw.map((r) => ({ ...r, next: resolveNextCourtLabel(r.next, courtNames) }));
  });
  return new Map(rows.map((r) => [r.division_id, r]));
}

export interface NextLine {
  /** "Arun vs Dev · Court 2 · 14:30" — no "Next:"/"Now:" label baked in; the
   *  caller (EntityCard) renders that from the `ui` catalog so it localizes
   *  and so the live vs upcoming label is chosen exactly once, not stacked
   *  (design/fix-ui/02-console-org.md: "both Next: and Now: labels render
   *  together when only one should show"). */
  text: string;
  /** True when this fixture is in play right now — the caller shows "Now:"
   *  instead of "Next:". */
  live: boolean;
}

/** The card's one-line answer to "what's next?". Null-safe on every field
 *  (TBD entrants, unscheduled fixtures). `locale` drives the date/weekday
 *  formatting so it matches the rest of a localized card instead of always
 *  rendering English weekday/month names. */
export function nextLine(next: NextFixture | null, locale: string): NextLine | null {
  if (!next) return null;
  const pair = `${next.home ?? "TBD"} vs ${next.away ?? "TBD"}`;
  const parts = [pair];
  if (next.court_label) parts.push(next.court_label);
  if (next.scheduled_at) {
    const at = new Date(next.scheduled_at);
    const sameDay = at.toDateString() === new Date().toDateString();
    parts.push(
      new Intl.DateTimeFormat(locale, {
        ...(sameDay ? {} : { weekday: "short", day: "numeric", month: "short" }),
        hour: "2-digit",
        minute: "2-digit",
      }).format(at),
    );
  }
  return { text: parts.join(" · "), live: next.in_play };
}

/** "Knockout", "Group + Knockout", "League" — format from real structure. */
export function formatLabel(kinds: string[]): string | null {
  if (kinds.length === 0) return null;
  const label: Record<string, string> = {
    league: "League",
    group: "Groups",
    knockout: "Knockout",
    swiss: "Swiss",
    ladder: "Ladder",
    americano: "Americano",
  };
  return kinds.map((k) => label[k] ?? k).join(" + ");
}
