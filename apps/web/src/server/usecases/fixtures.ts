import "server-only";
// Fixture use-cases (doc 08 §3): schedule/venue/officials PATCH, lineups PUT,
// ledger reads (events since_seq), live state (summary + last_seq for ETag).
import type postgres from "postgres";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { PatchFixture, PutLineup, ScheduleConflict } from "@/server/api-v1/schemas";
import { BOARD_FIXTURE_COLS, type BoardFixtureRow, type FixtureRow } from "./stages";
// #14: `courtNamesById` is the venue-qualified label map (via
// `buildCourtDirectory`) — a bare joined `courts.name` can't tell apart two
// venues that legally share one court name.
import { moveFixture, courtNamesById } from "./schedule";
import { scoresViaAssignment } from "./scorers";

/** Doc 13 §7: a device link reads fixture state/events ONLY — every other
 *  fixture surface (detail, lineups, schedule) is 403 for dl_ tokens. */
function rejectDeviceLink(auth: AuthCtx): void {
  if (auth.via === "device_link") {
    throw new HttpError(403, "Device links can only access their fixture's scoring surface");
  }
}

/** The fixture shape GET/PATCH /fixtures/{id} actually serve (P9 pass
 *  3c-2): court_id/venue_id + derived court_name/venue_name, WITHOUT the
 *  frozen venue/court_label text columns. This is the one fixture read
 *  path that makes a clean break rather than adding alongside — it's the
 *  highest-visibility surface (the published v1 API contract), and #461's
 *  own PatchedFixtureOut precedent already documents this endpoint's result
 *  IS the wire, unmapped. Every other FixtureRow reader (listDivisionFixtures
 *  below, generateStageFixtures, ...) keeps venue/court_label for callers
 *  not yet migrated off them. */
export type FixtureOut = Omit<FixtureRow, "venue" | "court_label">;

export async function getFixture(auth: AuthCtx, id: string): Promise<FixtureOut> {
  rejectDeviceLink(auth);
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<Omit<FixtureOut, "court_name">[]>`
      select f.id, f.stage_id, f.division_id, f.pool_id, f.round_no, f.seq_in_round, f.fixture_no,
             f.home_entrant_id, f.away_entrant_id, f.home_slot_label, f.away_slot_label,
             f.scheduled_at, f.court_id, f.venue_id, ven.name as venue_name,
             f.officials, f.status, f.outcome, f.schedule_source, f.schedule_locked, f.created_at,
             f.ext_key, f.lane, f.is_final, f.third_place, f.conditional
      from fixtures f
      left join venues ven on ven.id = f.venue_id
      where f.id = ${id}`;
    if (!row) throw new HttpError(404, "fixture not found");
    // #14: venue-qualified label (a bare joined `courts.name` can't tell two
    // same-named courts in different venues apart) — see FixtureRow's own
    // doc comment: fall back to the id itself if a lookup somehow misses
    // (should not happen; courts.id is FK-restricted from fixtures.court_id).
    const courtNames = await courtNamesById(tx);
    return {
      ...row,
      court_name: row.court_id !== null ? (courtNames.get(row.court_id) ?? row.court_id) : null,
    };
  });
}

/** All fixtures of a division in play order — the organiser console read. */
export async function listDivisionFixtures(auth: AuthCtx, divisionId: string): Promise<FixtureRow[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const rows = await tx<Omit<FixtureRow, "court_name">[]>`
      select f.id, f.stage_id, f.division_id, f.pool_id, f.round_no, f.seq_in_round, f.fixture_no,
             f.home_entrant_id, f.away_entrant_id, f.home_slot_label, f.away_slot_label,
             f.scheduled_at, f.venue, f.court_label, f.court_id,
             f.venue_id, ven.name as venue_name,
             f.officials, f.status, f.outcome, f.schedule_source, f.schedule_locked, f.created_at,
             f.ext_key, f.lane, f.is_final, f.third_place, f.conditional
      from fixtures f
      left join venues ven on ven.id = f.venue_id
      where f.division_id = ${divisionId}
      order by f.stage_id, f.round_no, f.seq_in_round`;
    // #14: venue-qualified label, same fallback convention as getFixture above.
    const courtNames = await courtNamesById(tx);
    return rows.map((r) => ({
      ...r,
      court_name: r.court_id !== null ? (courtNames.get(r.court_id) ?? r.court_id) : null,
    }));
  });
}

/** The schedule board's fixture read (F1 follow-up, payload budget "gap
 *  15" — board-v3.spec.ts). Same query as listDivisionFixtures above, but
 *  projected onto BOARD_FIXTURE_COLS: the board never reads
 *  ext_key/lane/is_final/third_place/conditional, so this drops them
 *  instead of shipping them across the RSC flight unread. Callers that DO
 *  need those five fields (the division page's bracket/stages panel) keep
 *  using listDivisionFixtures. */
export async function listDivisionFixturesForBoard(
  auth: AuthCtx,
  divisionId: string,
): Promise<BoardFixtureRow[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    // P9: IDENTITY ONLY. The board resolves a court's display name client-side
    // from the venues prop (`resolveCourtNames`, which covers every org court
    // including archived), so shipping `court_name`/`venue_name` on every row
    // duplicated data the client already holds — and `court_label`/`venue` are
    // the frozen legacy columns nothing writes. Six court/venue fields per row
    // across ~330 fixtures is what put this page 33KB over its RSC payload
    // budget (board-v3.spec.ts:287); the calendar trim before it was the wrong
    // suspect and saved 583 bytes.
    //
    // `venue_id` is not sent either: a court BELONGS to a venue, so court_id
    // already determines it, and measured across this database every one of
    // 10,681 fixtures has it null — it was pure weight on every row.
    return tx<BoardFixtureRow[]>`
      select f.id, f.stage_id, f.division_id, f.pool_id, f.round_no, f.seq_in_round, f.fixture_no,
             f.home_entrant_id, f.away_entrant_id, f.home_slot_label, f.away_slot_label,
             f.scheduled_at, f.court_id,
             f.officials, f.status, f.outcome, f.schedule_source, f.schedule_locked, f.created_at
      from fixtures f
      where f.division_id = ${divisionId}
      order by f.stage_id, f.round_no, f.seq_in_round`;
  });
}

/** The PATCH response (#461): the fixture, plus the conflicts the move was
 *  judged against. Declared as its own type because this endpoint's result IS
 *  the wire — the route returns it unmapped — so widening `FixtureRow` here
 *  would have widened GET too, where there is no move and nothing to report.
 *  Mirrored by `PatchedFixture` in `api-v1/schemas.ts`, which is what the
 *  published spec is generated from. */
export type PatchedFixtureOut = FixtureOut & { conflicts: ScheduleConflict[] };

export async function patchFixture(
  auth: AuthCtx,
  id: string,
  patch: PatchFixture,
): Promise<PatchedFixtureOut> {
  // Schedule-touching fields go through the scheduling console's move path
  // (doc 12 §4): conflict validation (court clashes / direct-feed order
  // violations block), schedule_edited ledger event, board realtime refresh.
  const { officials, ...move } = patch;
  // ALWAYS an array, never undefined (#461): an officials-only patch evaluates
  // no slot, and "nothing wrong" is the honest answer for it — a client should
  // not have to tell "no conflicts" from "not evaluated" by key absence.
  let conflicts: ScheduleConflict[] = [];
  if (Object.keys(move).length > 0) {
    conflicts = await moveFixture(auth, id, move);
  }
  return withTenant(auth.orgId, async (tx) => {
    if (officials) {
      await tx`
        update fixtures set officials = ${tx.json(officials as never)} where id = ${id}`;
    }
    const [row] = await tx<Omit<FixtureOut, "court_name">[]>`
      select f.id, f.stage_id, f.division_id, f.pool_id, f.round_no, f.seq_in_round, f.fixture_no,
             f.home_entrant_id, f.away_entrant_id, f.home_slot_label, f.away_slot_label,
             f.scheduled_at, f.court_id, f.venue_id, ven.name as venue_name,
             f.officials, f.status, f.outcome, f.schedule_source, f.schedule_locked, f.created_at,
             f.ext_key, f.lane, f.is_final, f.third_place, f.conditional
      from fixtures f
      left join venues ven on ven.id = f.venue_id
      where f.id = ${id}`;
    if (!row) throw new HttpError(404, "fixture not found");
    // #14: venue-qualified label, same fallback convention as getFixture above.
    const courtNames = await courtNamesById(tx);
    return {
      ...row,
      court_name: row.court_id !== null ? (courtNames.get(row.court_id) ?? row.court_id) : null,
      conflicts,
    };
  });
}

export interface LineupOut {
  fixture_id: string;
  entrant_id: string;
  slots: unknown[];
}

/** Replace an entrant's lineup for a fixture (idempotent PUT, doc 08 §3). */
export async function putLineup(
  auth: AuthCtx,
  fixtureId: string,
  entrantId: string,
  input: PutLineup,
): Promise<LineupOut> {
  rejectDeviceLink(auth); // doc 13 §7: no lineups via device link
  return withTenant(auth.orgId, async (tx) => {
    const [fixture] = await tx<
      {
        home_entrant_id: string | null;
        away_entrant_id: string | null;
        status: string;
        scorer_can_enter_lineups: boolean;
      }[]
    >`
      select f.home_entrant_id, f.away_entrant_id, f.status, d.scorer_can_enter_lineups
      from fixtures f join divisions d on d.id = f.division_id
      where f.id = ${fixtureId}`;
    if (!fixture) throw new HttpError(404, "fixture not found");
    // Doc 13 §2: lineup entry is config-gated for anyone scoring via
    // assignment (courtside reality default: allowed). Coverage was proven
    // at the door.
    if (scoresViaAssignment(auth.role) && !fixture.scorer_can_enter_lineups) {
      throw new HttpError(403, "Lineup entry is restricted to organisers in this division");
    }
    if (fixture.home_entrant_id !== entrantId && fixture.away_entrant_id !== entrantId) {
      throw new HttpError(422, "entrant is not a side of this fixture");
    }
    if (fixture.status !== "scheduled") {
      throw new HttpError(422, `lineup is locked once a fixture is ${fixture.status}`);
    }
    const ids = [...new Set(input.slots.map((s) => s.person_id))];
    if (ids.length !== input.slots.length) {
      throw new HttpError(422, "duplicate person in lineup");
    }
    if (ids.length > 0) {
      const members = await tx<{ person_id: string }[]>`
        select person_id from entrant_members
        where entrant_id = ${entrantId} and person_id in ${tx(ids)}`;
      if (members.length !== ids.length) {
        throw new HttpError(422, "lineup contains a person who is not a member of the entrant");
      }
    }
    await tx`delete from lineups where fixture_id = ${fixtureId} and entrant_id = ${entrantId}`;
    for (const [i, s] of input.slots.entries()) {
      await tx`
        insert into lineups (fixture_id, entrant_id, person_id, slot, position_key, order_no, roles, role, pair_order)
        values (${fixtureId}, ${entrantId}, ${s.person_id}, ${s.slot},
                ${s.position_key ?? null}, ${s.order_no ?? i + 1}, ${tx.json(s.roles as never)},
                ${s.role ?? "player"}, ${s.pair_order ?? null})`;
    }
    return readLineup(tx, fixtureId, entrantId);
  });
}

/** Read an entrant's lineup for a fixture. */
export async function getLineup(auth: AuthCtx, fixtureId: string, entrantId: string): Promise<LineupOut> {
  rejectDeviceLink(auth); // doc 13 §7: no reads beyond fixture state/events
  return withTenant(auth.orgId, async (tx) => {
    const [fixture] = await tx`select 1 from fixtures where id = ${fixtureId}`;
    if (!fixture) throw new HttpError(404, "fixture not found");
    return readLineup(tx, fixtureId, entrantId);
  });
}

async function readLineup(
  tx: postgres.TransactionSql,
  fixtureId: string,
  entrantId: string,
): Promise<LineupOut> {
  // Jul3/07 §5 (9 Sep ×4): shirt numbers ride the lineup read model so every
  // scorer picker can render "#7 — Name".
  const slots = await tx<Record<string, unknown>[]>`
    select l.person_id, p.full_name, em.squad_number, l.slot, l.position_key, l.order_no, l.roles, l.role, l.pair_order
    from lineups l
    join persons p on p.id = l.person_id
    left join entrant_members em on em.entrant_id = l.entrant_id and em.person_id = l.person_id
    where l.fixture_id = ${fixtureId} and l.entrant_id = ${entrantId}
    order by l.order_no nulls last, p.full_name`;
  return { fixture_id: fixtureId, entrant_id: entrantId, slots };
}

export interface EventOut {
  id: string;
  seq: number;
  type: string;
  payload: unknown;
  recorded_at: string;
  recorded_by: string | null;
  voids_event_id: string | null;
  /** Doc 13 §7 attribution rider — lets the pad offer undo-own only. */
  device_link_id: string | null;
}

/** Ledger read: events after `sinceSeq` (the 409-recovery resync, doc 08 §4). */
export async function listEvents(auth: AuthCtx, fixtureId: string, sinceSeq: number): Promise<EventOut[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [fixture] = await tx`select 1 from fixtures where id = ${fixtureId}`;
    if (!fixture) throw new HttpError(404, "fixture not found");
    return tx<EventOut[]>`
      select id, seq, type, payload, recorded_at, recorded_by, voids_event_id, device_link_id
      from score_events
      where fixture_id = ${fixtureId} and seq > ${sinceSeq}
      order by seq`;
  });
}

/** Activity attribution: recorded_by → display name for a fixture's ledger.
 *  The ids come from the tenant-scoped ledger read; `users` has no org RLS,
 *  so the name lookup runs on the root client (same pattern as the org
 *  members list). */
export async function eventRecorderNames(
  auth: AuthCtx,
  fixtureId: string,
): Promise<Record<string, string>> {
  const ids = await withTenant(
    auth.orgId,
    (tx) => tx<{ recorded_by: string }[]>`
      select distinct recorded_by from score_events
      where fixture_id = ${fixtureId} and recorded_by is not null`,
  );
  if (ids.length === 0) return {};
  const users = await sql<{ id: string; display_name: string | null; email: string }[]>`
    select id, display_name, email from users
    where id in ${sql(ids.map((r) => r.recorded_by))}`;
  return Object.fromEntries(users.map((u) => [u.id, u.display_name ?? u.email]));
}

export interface FixtureStateOut {
  fixture_id: string;
  status: string;
  last_seq: number;
  summary: unknown;
  state: unknown;
  outcome: unknown;
}

/** Live state: fold cache summary + status + outcome (ETag on last_seq). */
export async function getFixtureState(auth: AuthCtx, fixtureId: string): Promise<FixtureStateOut> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<
      { status: string; outcome: unknown; last_seq: number | null; state: unknown; summary: unknown }[]
    >`
      select f.status, f.outcome, m.last_seq, m.state, m.summary
      from fixtures f left join match_states m on m.fixture_id = f.id
      where f.id = ${fixtureId}`;
    if (!row) throw new HttpError(404, "fixture not found");
    return {
      fixture_id: fixtureId,
      status: row.status,
      last_seq: row.last_seq ?? 0,
      summary: row.summary ?? null,
      state: row.state ?? null,
      outcome: row.outcome,
    };
  });
}

/** PROMPT-62 — ScoreSummary.headline per fixture (from match_states) for the
 *  bracket panel's node scores. One query per division render. */
export async function listFixtureHeadlines(
  auth: AuthCtx,
  divisionId: string,
): Promise<Record<string, string>> {
  const rows = await withTenant(auth.orgId, (tx) =>
    tx<{ fixture_id: string; headline: string | null }[]>`
      select ms.fixture_id, ms.summary->>'headline' as headline
      from match_states ms
      join fixtures f on f.id = ms.fixture_id
      where f.division_id = ${divisionId}`,
  );
  return Object.fromEntries(
    rows.filter((r) => r.headline !== null).map((r) => [r.fixture_id, r.headline as string]),
  );
}

// ---------------------------------------------------------------------------
// Signed per-match audit ledger (PROMPT-63). score_events is append-only and
// hash-chained per fixture (V226: trg_zhash BEFORE INSERT sets prev_hash /
// row_hash; verify_score_events_chain(fixture) returns the first tampered row
// id or NULL). This read surfaces the WHOLE stream with the chain columns +
// the verifier verdict; the route signs head_hash (audit-sign.ts).
// ---------------------------------------------------------------------------

/** The exact V226 canonical recipe, documented so an independent verifier can
 *  re-walk the chain (payload::text must be the stored Postgres serialisation;
 *  the Ed25519 signature is the primary cross-system proof). */
export const AUDIT_CANONICAL_SPEC =
  "row_hash = sha256(coalesce(prev_hash,'') || '|' || concat_ws('|', id, fixture_id, seq, type, payload::text, coalesce(voids_event_id::text,''), coalesce(recorded_by::text,''), recorded_at))";

export interface AuditLedgerEvent {
  seq: number;
  type: string;
  payload: unknown;
  recorded_by: string | null;
  recorded_at: string;
  voids_event_id: string | null;
  prev_hash: string | null;
  row_hash: string;
}

export interface AuditLedger {
  fixture: {
    id: string;
    division_id: string;
    fixture_no: number | null;
    home: string | null;
    away: string | null;
    status: string;
  };
  canonical_spec: string;
  events: AuditLedgerEvent[];
  head_hash: string | null;
  verified: boolean;
  first_tampered_seq: number | null;
}

export async function readAuditLedger(auth: AuthCtx, fixtureId: string): Promise<AuditLedger> {
  return withTenant(auth.orgId, async (tx) => {
    const [fixture] = await tx<
      {
        id: string; division_id: string; fixture_no: number | null; status: string;
        home_entrant_id: string | null; away_entrant_id: string | null;
      }[]
    >`
      select id, division_id, fixture_no, status, home_entrant_id, away_entrant_id
      from fixtures where id = ${fixtureId}`;
    if (!fixture) throw new HttpError(404, "fixture not found");
    const names = await tx<{ id: string; display_name: string }[]>`
      select id, display_name from entrants
      where id in (${fixture.home_entrant_id ?? null}, ${fixture.away_entrant_id ?? null})`;
    const nameById = new Map(names.map((n) => [n.id, n.display_name]));
    const events = await tx<AuditLedgerEvent[]>`
      select seq, type, payload, recorded_by, recorded_at, voids_event_id, prev_hash, row_hash
      from score_events where fixture_id = ${fixtureId} order by seq`;
    const [{ bad }] = await tx<{ bad: string | null }[]>`
      select verify_score_events_chain(${fixtureId})::text as bad`;
    let firstTamperedSeq: number | null = null;
    if (bad !== null) {
      const [row] = await tx<{ seq: number }[]>`
        select seq from score_events where id = ${bad}`;
      firstTamperedSeq = row?.seq ?? null;
    }
    return {
      fixture: {
        id: fixture.id,
        division_id: fixture.division_id,
        fixture_no: fixture.fixture_no,
        home: fixture.home_entrant_id ? (nameById.get(fixture.home_entrant_id) ?? null) : null,
        away: fixture.away_entrant_id ? (nameById.get(fixture.away_entrant_id) ?? null) : null,
        status: fixture.status,
      },
      canonical_spec: AUDIT_CANONICAL_SPEC,
      events,
      head_hash: events.length > 0 ? events[events.length - 1]!.row_hash : null,
      verified: bad === null,
      first_tampered_seq: firstTamperedSeq,
    };
  });
}
