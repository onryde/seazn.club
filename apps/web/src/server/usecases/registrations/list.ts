import "server-only";
// Organiser list read and the solo-pool capacity helpers it shares (see ./index.ts).
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { mayHoldBearerCredential } from "@/lib/types";
import { SPOT_HOLDERS } from "@/lib/registration-status";
import type { AuthCtx } from "@/server/api-v1/auth";
import { omit } from "@/lib/omit";
import type { Tx, RegistrationSettingsRow, RegistrationWithGroupRow, AnySql } from "./types";
import { regGroupCols } from "./lookups";

// ---------------------------------------------------------------------------
// Organiser: list / confirm / waitlist / withdraw / refund / export
// ---------------------------------------------------------------------------

export interface ListRegistrationsFilters {
  /** Required when `divisionId` is null (cross-division hub mode). When BOTH
   *  are given they must AGREE — a division belonging to another competition
   *  is a 404, not a silently-honoured override. This used to read "ignored
   *  otherwise", and the code matched: it was the cross-competition read that
   *  the RS005 W1b review caught (see the guard in `listRegistrations`). */
  competition_id?: string;
  kind?: RegistrationSettingsRow["entrant_kind"];
  free_agent?: boolean;
  /** At least one player on the entry still has `consent_status = 'pending'`. */
  consent_pending?: boolean;
  /** Matches the entry's display name or the cart's contact name/email. */
  text?: string;
  /** RS005 W1a. Default `"oldest"` is `order by r.created_at, r.id` —
   *  UNCHANGED from pre-W1a, so the live `/api/v1/divisions/[id]/registrations`
   *  route (which never sets this) keeps its existing response order.
   *  `"newest"` reverses both keys. */
  sort?: "newest" | "oldest";
}

/** The sport's roster-cap expression: `sports.position_catalog.lineup.size +
 *  .benchMax`, NULL when the sport declares no `lineup` key at all
 *  (unlimited) — the same rule `registration-submit.ts`'s `joinTeamEntry`
 *  (registration-submit.ts:742-748) already enforces at join time. Assumes
 *  the surrounding query joins the sports row as `sp` (a hardcoded alias,
 *  same convention as `regGroupCols`'s `r`/`g`).
 *
 *  This is the ONLY copy: RS005 W1b repointed `joinTeamEntry` at this export
 *  (`008b3da27`), so the join-time cap and the displayed roster fill can no
 *  longer drift. Do not re-inline it. */
export function rosterCapExpr(db: AnySql) {
  return db`(
    (sp.position_catalog -> 'lineup' ->> 'size')::int +
    coalesce((sp.position_catalog -> 'lineup' ->> 'benchMax')::int, 0)
  )`;
}

/** RS012 rulings 1/2 — the pool's effective place-by date: the organiser's
 *  explicit place_by_at, else the division's own registration close. The
 *  ONE copy — Stage 2's sweep, buildGroupStatusView, and fetchPoolSummary
 *  (data.ts) all read this, never re-derive the fallback themselves, so the
 *  status page, the Registrants banner, and the sweep that actually acts on
 *  it can never disagree about the deadline. */
export function effectivePoolDeadline(
  placeByAt: Date | string | null,
  closesAt: Date | string | null,
): Date | string | null {
  return placeByAt ?? closesAt;
}

/** RS012 ruling 1 — the solo sign-up pool's own bound: `capacity × roster_cap`
 *  minus players already seated, the number of roster places that could
 *  conceivably exist. `hardCap` is the caller's already-resolved
 *  min(division capacity, plan limit) — Infinity means unbounded. Null
 *  `roster_cap` (a sport with no `lineup` key, e.g. `rosterCapExpr`'s own
 *  doc comment) also means unbounded: there is no ceiling to derive a bound
 *  from, so a solo sign-up is never refused for a sport with no roster
 *  concept at all.
 *
 *  `seated` = every `registration_players` row that sits on a NON-free-agent
 *  (`free_agent = false`), non-terminal (`status not in ('withdrawn',
 *  'rejected', 'expired', 'waitlisted')`) registration in the division —
 *  real team members, AND already-assigned solo sign-ups alike, since
 *  `assignSoloSignUp` inserts their roster row under the TEAM's
 *  registration, not their own (registration-assign.ts's `placementOf`/
 *  roster insert). The status exclusion (`/code-review high` finding 1,
 *  CRITICAL) mirrors `fetchPoolSummary`'s roster-room query and
 *  `listAssignTargets` — without it, a withdrawn team's own roster rows
 *  (never deleted by `withdrawCore`, which only flips `status`) counted as
 *  `seated` forever, shrinking the bound permanently and, once it went
 *  negative, 422-refusing every solo sign-up in an otherwise-empty
 *  division. Deliberately excludes a still-pooled solo sign-up's OWN player
 *  row (it lives under THEIR OWN free_agent=true registration, holding
 *  their name/gender for display — RegistrationListRow's `player_gender`
 *  reads it the same way) — that row is sitting in the pool, not seated on
 *  a roster, and counting it here as well as in `pooled` below
 *  double-charged the very first solo sign-up against the bound (caught by
 *  this ticket's own regression test: a 2nd solo sign-up under a 2-place
 *  bound was wrongly refused). `pooled` = free-agent registrations in
 *  `SPOT_HOLDERS` status that are NOT YET assigned (no
 *  `registration_players` row points back at them via
 *  `assigned_from_registration_id`) — an assigned one is already counted
 *  inside `seated` and must not be double-counted here. */
export async function soloPoolIsFull(
  tx: Tx,
  divisionId: string,
  hardCap: number,
): Promise<boolean> {
  if (!Number.isFinite(hardCap)) return false;
  const [row] = await tx<{ roster_cap: number | null; seated: number; pooled: number }[]>`
    select
      ${rosterCapExpr(tx)} as roster_cap,
      (select count(*)::int from registration_players rp
         join registrations r2 on r2.id = rp.registration_id
         where r2.division_id = d.id and r2.free_agent = false
           and r2.status not in ('withdrawn', 'rejected', 'expired', 'waitlisted')) as seated,
      (select count(*)::int from registrations r3
         where r3.division_id = d.id and r3.free_agent = true
           and r3.status in ${tx([...SPOT_HOLDERS])}
           and not exists (
             select 1 from registration_players rp2
             where rp2.assigned_from_registration_id = r3.id
           )) as pooled
    from divisions d join sports sp on sp.key = d.sport_key
    where d.id = ${divisionId}`;
  if (!row || row.roster_cap === null) return false;
  return row.pooled >= hardCap * row.roster_cap - row.seated;
}

/** `listRegistrations`' row (RS005 W1a), widened for the Registrants tab:
 *  the division's own name/slug, its resolved `entrant_kind`, and three
 *  values no consumer should recompute itself — `roster_count`/`roster_cap`/
 *  `consent_pending_count` (per-entry correlated subqueries in the one query
 *  below, same no-N+1 convention `card-stats.ts`'s `listDivisionCardStats`
 *  already uses) and `waitlist_position` (tuple-comparison note on the query
 *  below). Deliberately DROPS `access_token_hash` — the list/export surface
 *  must never ship the cart's access-token hash to an organiser session; see
 *  the strip at the bottom of `listRegistrations`. */
export interface RegistrationListRow extends Omit<RegistrationWithGroupRow, "access_token_hash"> {
  division_name: string;
  division_slug: string;
  entrant_kind: RegistrationSettingsRow["entrant_kind"];
  roster_count: number;
  /** null = unlimited (the sport declares no lineup config). */
  roster_cap: number | null;
  consent_pending_count: number;
  /** 1-based rank within this row's DIVISION, `waitlisted` rows only; null
   *  for every other status. */
  waitlist_position: number | null;
  /** The DIVISION's approval mode (`registration_settings.approval`), not the
   *  entry's. RS005 W3 renders approve/reject only for a `manual` division —
   *  on an `auto` division `approveRegistration` refuses with a 422, so
   *  showing the control would offer an organiser a button that cannot work.
   *  `coalesce`d to 'auto' because a division with no settings row at all
   *  behaves exactly as auto (registration-approval.ts's own
   *  `loadApprovalSettings` reads it the same way). */
  approval: RegistrationSettingsRow["approval"];
  /** The DIVISION's LIVE entry fee, not this entry's frozen `amount_cents`.
   *
   *  Both server gates read the live value — `approveRegistration` refuses
   *  while a fee is outstanding, `markRegistrationPaidOffline` refuses when
   *  the division has no fee — while the row only carried the amount quoted
   *  at SUBMIT. `putRegistrationSettings` never re-quotes existing entries
   *  (it contains no `update registrations` at all), so the two diverge the
   *  moment an organiser edits a fee, and the UI then offers whichever
   *  control the server refuses: raise 0 -> 20.00 and Approve renders but
   *  422s "mark it paid first" while Mark paid is hidden; drop 20.00 -> 0 and
   *  the mirror image. Either way the organiser is stuck with no working
   *  control.
   *
   *  Carried on the row so the client gates on exactly what the server gates
   *  on, correct on FIRST render. Costs nothing: `registration_settings` is
   *  already LEFT JOINed for `entrant_kind`/`approval`. */
  division_fee_cents: number;
  /**
   * RS009 — where a SOLO SIGN-UP currently sits, or null while they are
   * still in the pool. Null on every non-solo-sign-up row.
   *
   * Derived from the roster row pointing back at this entry
   * (`registration_players.assigned_from_registration_id`, unique where
   * non-null), never from a mirrored column on `registrations` — the pool
   * and the roster must not be able to disagree.
   */
  assigned_team_id: string | null;
  assigned_team_name: string | null;
  /**
   * RS009 — the solo sign-up's OWN gender, when the division collected one.
   * The assign sheet needs it to predict a mixed division's refusal BEFORE
   * the organiser spends a click. Null means unknown, and the sheet must
   * then predict nothing rather than guess.
   */
  player_gender: string | null;
  /**
   * RS009 — has this row's division started, in the sense that its rosters
   * are no longer the organiser's to shuffle? True once the division has any
   * fixture, or once the competition's own `starts_on` has passed. Mirrors
   * `unassignSoloSignUp`'s refusal exactly, so the hub never renders a
   * Remove button the server will refuse — the same rule
   * `division_fee_cents` was added for (a control that cannot work is worse
   * than no control).
   */
  division_started: boolean;
  /** When the organiser last pressed "Send payment reminder" for THIS entry: the newest `registration.payment_reminded` audit row naming
   *  it, null if never. The sweep's own reminders are not audit rows and do not count. */
  last_reminded_at: Date | null;
}

/** Raw wire shape — `RegistrationListRow` plus the hash the query still
 *  selects (via the shared `regGroupCols`) but the function strips before
 *  returning. */
type RawListRow = RegistrationListRow & { access_token_hash: string };

/**
 * Organiser registration list. `divisionId` scopes to ONE division exactly as
 * before — the LIVE `/api/v1/divisions/[id]/registrations` route calls this
 * with 3 positional args and must keep compiling and behaving identically
 * (RS002 W5 owns no route-handler changes). Pass `null` for the
 * competition-wide hub view (design: "competition-level Registration hub",
 * owner ruling 2) and set `filters.competition_id` instead.
 *
 * `filters.kind` needs the join to `registration_settings`: `entrant_kind` is
 * a DIVISION-level setting, not stored per-entry, so it is only a meaningful
 * filter once a call can span more than one division — scoped to a single
 * division every row already shares one kind. LEFT JOIN, not INNER: some
 * rows in this table predate any `registration_settings` row for their
 * division existing at all (direct-SQL test fixtures — see
 * `seedRegistration` in the test file), and an INNER JOIN would silently
 * drop those rows for the EXISTING single-division callers — a regression
 * this extension must not cause.
 *
 * RS005 W1a: widened the row (`RegistrationListRow`) and added `filters.sort`.
 * `sports` is joined INNER, not LEFT, unlike `registration_settings` above —
 * `divisions.sport_key` is `not null references sports(key)` (V209), so
 * every division has exactly one sport row and this join can never drop one.
 * `waitlist_position`'s subquery counts waitlisted SIBLINGS (same division)
 * whose `(created_at, id)` tuple sorts strictly before this row's own, +1 —
 * exactly `promoteOldestWaitlisted`'s (this file) own `order by created_at,
 * id limit 1`, so position 1 is that function's pick on a quiescent table.
 *
 * It is a SNAPSHOT of that order, not a lock on it, and the difference is
 * reachable: `promoteOldestWaitlisted` picks `for update skip locked`, so
 * while another transaction holds the rank-1 row (a concurrent promotion, a
 * withdraw's auto-promote, a refund) it promotes rank 2 instead, while this
 * plain count still reports the locked row as #1. The organiser sees a
 * position that was true when the page was rendered. Do NOT "fix" this by
 * adding `skip locked` to the read — a display query that silently omits
 * locked rows renumbers the whole queue under load, which is worse than a
 * stale number. The ordering rule is what must not fork; the instant it is
 * sampled may differ.
 */
export async function listRegistrations(
  auth: AuthCtx,
  divisionId: string | null,
  status: string | null,
  filters: ListRegistrationsFilters = {},
): Promise<RegistrationListRow[]> {
  return withTenant(auth.orgId, async (tx) => {
    let competitionId: string;
    if (divisionId) {
      const [division] = await tx<{ competition_id: string }[]>`
        select competition_id from divisions where id = ${divisionId}`;
      if (!division) throw new HttpError(404, "division not found");
      // SECURITY (RS005 W1b review, BLOCKER): when the caller named BOTH, the
      // two must agree. This branch used to derive the competition from the
      // division and silently DISCARD `filters.competition_id`, so a request
      // addressed to competition A carrying a `division_id` from competition B
      // returned B's rows under a 200 from A's URL.
      //
      // Same-org only (`withTenant` still scopes the read), so for a session
      // user it leaks nothing they could not reach through B's own URL. The
      // real breach is the API-key competition pin: `apiKeyAuth` resolves the
      // pin from the URL PATH resource (`api-v1/auth.ts:162-172`,
      // `resolvePinCompetition`) and never looks at query parameters, so a key
      // pinned to A satisfied the pin on A's path and then read — and CSV
      // exported — B's contact names, emails, answers and payment state. The
      // pin is the entire boundary that endpoint sells.
      //
      // 404, not 403: the division is same-org (`withTenant`), and a caller
      // who may not scope this division to that competition must not learn
      // it exists. (The path pin itself fails closed with 403 in `apiKeyAuth`.)
      if (filters.competition_id && division.competition_id !== filters.competition_id) {
        throw new HttpError(404, "division not found");
      }
      competitionId = division.competition_id;
    } else {
      if (!filters.competition_id) {
        throw new HttpError(400, "competition_id is required when no division is given");
      }
      const [competition] = await tx`select 1 from competitions where id = ${filters.competition_id}`;
      if (!competition) throw new HttpError(404, "competition not found");
      competitionId = filters.competition_id;
    }
    const text = filters.text?.trim();
    // LIKE metacharacters (`%`/`_`) in the search text must match LITERALLY,
    // not as wildcards (RS005 F1 finding 4) — a registrant's own contact
    // details routinely contain them ("100% Effort", "john_smith@…"), and
    // left unescaped they turned an ordinary-looking search into an
    // accidental wildcard that over-matched unrelated rows. `\` is escaped
    // too: it is Postgres's OWN default LIKE escape character even with no
    // explicit ESCAPE clause, so a literal `\` in the search text would
    // otherwise start escaping whatever follows it instead of matching
    // itself.
    const likePattern = (s: string) => "%" + s.replace(/[\\%_]/g, "\\$&") + "%";
    const rows = await tx<RawListRow[]>`
      select ${regGroupCols(tx)},
        d.name as division_name,
        d.slug as division_slug,
        coalesce(rs.entrant_kind, 'individual') as entrant_kind,
        coalesce(rs.approval, 'auto') as approval,
        coalesce(rs.fee_cents, 0) as division_fee_cents,
        (select count(*)::int from registration_players rp
          where rp.registration_id = r.id) as roster_count,
        ${rosterCapExpr(tx)} as roster_cap,
        (select count(*)::int from registration_players rp
          where rp.registration_id = r.id and rp.consent_status = 'pending') as consent_pending_count,
        (select tgt.id from registration_players rp
          join registrations tgt on tgt.id = rp.registration_id
          where rp.assigned_from_registration_id = r.id) as assigned_team_id,
        (select tgt.display_name from registration_players rp
          join registrations tgt on tgt.id = rp.registration_id
          where rp.assigned_from_registration_id = r.id) as assigned_team_name,
        (select rp.gender from registration_players rp
          where rp.registration_id = r.id
          order by rp.created_at, rp.id limit 1) as player_gender,
        (exists (select 1 from fixtures f where f.division_id = r.division_id)
          or (c.starts_on is not null and c.starts_on <= current_date)) as division_started,
        (select max(ev.created_at) from competition_events ev
          where ev.competition_id = c.id
            and ev.type = 'registration.payment_reminded'
            and ev.payload->>'registration_id' = r.id::text) as last_reminded_at,
        case when r.status = 'waitlisted' then (
          (select count(*)::int from registrations w
            where w.division_id = r.division_id and w.status = 'waitlisted'
              and (w.created_at, w.id) < (r.created_at, r.id)) + 1
        ) else null end as waitlist_position
      from registrations r
      join registration_groups g on g.id = r.group_id
      join divisions d on d.id = r.division_id
      join competitions c on c.id = d.competition_id
      join sports sp on sp.key = d.sport_key
      left join registration_settings rs on rs.division_id = r.division_id
      where d.competition_id = ${competitionId}
        ${divisionId ? tx`and r.division_id = ${divisionId}` : tx``}
        ${status ? tx`and r.status = ${status}` : tx``}
        ${
          // coalesce, matching the SELECT above. A division with no
          // registration_settings row DISPLAYS as 'individual' (that is what
          // the LEFT JOIN is for — those rows are real), but a bare
          // `rs.entrant_kind = 'individual'` is NULL-false for exactly them:
          // the row an organiser can see in the table vanished the moment they
          // filtered for the kind it was showing. Filter and column must read
          // the same expression or the list contradicts itself.
          filters.kind ? tx`and coalesce(rs.entrant_kind, 'individual') = ${filters.kind}` : tx``
        }
        ${filters.free_agent !== undefined ? tx`and r.free_agent = ${filters.free_agent}` : tx``}
        ${
          // `!== undefined`, like free_agent above — not truthiness. Both are
          // documented as 1|0 and the query parser maps "0" to false, so
          // truthiness made `consent_pending=0` mean "no filter" while
          // `free_agent=0` filtered: the same documented input behaving two
          // different ways one line apart. `0` now means what it says —
          // entries with nothing outstanding.
          filters.consent_pending !== undefined
            ? filters.consent_pending
              ? tx`and exists (
                  select 1 from registration_players rp
                  where rp.registration_id = r.id and rp.consent_status = 'pending'
                )`
              : tx`and not exists (
                  select 1 from registration_players rp
                  where rp.registration_id = r.id and rp.consent_status = 'pending'
                )`
            : tx``
        }
        ${
          text
            ? tx`and (r.display_name ilike ${likePattern(text)} escape '\\'
                  or g.contact_name ilike ${likePattern(text)} escape '\\'
                  or g.contact_email ilike ${likePattern(text)} escape '\\')`
            : tx``
        }
      ${filters.sort === "newest" ? tx`order by r.created_at desc, r.id desc` : tx`order by r.created_at, r.id`}`;
    // Never ship the cart's access-token hash to the organiser list/export
    // surface (RS005 W1a). regGroupCols stays the ONE shared column list —
    // other callers legitimately need the hash for token verification — so
    // it is stripped here in JS rather than forked into a second hand-copied
    // SELECT list.
    //
    // `join_code` is stripped for anyone who cannot already write (RS005
    // whole-branch review, BLOCKER). It is a BEARER CREDENTIAL, not a display
    // field: `POST /public/.../register/join` accepts it from anyone and mints
    // a roster row, and RS001 made it globally unique so it needs no other
    // context to resolve. `read` scope is `READ_ROLES` — owner, admin AND
    // viewer — so both list routes were handing a write-capable secret to a
    // read-only role in one GET. The UI had it right (the detail body gates the
    // copy control on canEdit and never puts the code in the RSC payload); the
    // JSON API, which the same viewer session can simply request, did not.
    //
    // Gated on EDITOR_ROLES rather than "not viewer": an API key resolves
    // `role: null` regardless of its scopes, and a key that cannot be shown to
    // be write-capable should not receive a write-capable credential either.
    // If an integration ever needs join codes, that is a deliberate decision
    // with its own scope check — not a default.
    const mayHoldJoinCode = mayHoldBearerCredential(auth.role);
    return rows.map((row) => {
      const rest = omit(row, "access_token_hash");
      return mayHoldJoinCode ? rest : { ...rest, join_code: null };
    });
  });
}
