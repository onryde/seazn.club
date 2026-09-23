import "server-only";
// Fixture use-cases (doc 08 §3): schedule/venue/officials PATCH, lineups PUT,
// ledger reads (events since_seq), live state (summary + last_seq for ETag).
import type postgres from "postgres";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { PatchFixture, PutLineup, ScheduleConflict } from "@/server/api-v1/schemas";
import { type BoardFixtureRow, type FixtureRow } from "./stages";
import { streamUrlSchema } from "@/lib/stream-url";
import { fireDivisionRevalidate } from "../public-site/revalidate";
// #14: `courtNamesById` is the venue-qualified label map (via
// `buildCourtDirectory`) — a bare joined `courts.name` can't tell apart two
// venues that legally share one court name.
import { moveFixture, courtNamesById } from "./schedule";
import { subjectToScorerCapabilityGates } from "./scorers";
import { gateRosterEligibility } from "./registration-eligibility";
import { disciplineEnforcedForFixture, gateLineupSuspensions } from "./discipline";
import { resolveFixtureCfg, resolveModule } from "@/server/engine-db";
import { lineupCatalogFor } from "./lineup-catalog";
import { validateLineup, type LineupIssue } from "@seazn/engine/sport";
import type { Lineup } from "@seazn/engine/core";
import { log } from "@/server/logger";

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

/**
 * The config a fixture's SCORING SURFACES must render against (design
 * 2026-09-17 §T4) — the fixture console page and the device-link pad.
 *
 * Both of them used to hand the pad raw `division.config`, which is wrong in
 * two directions. A scored fixture folds against the cfg frozen onto
 * `fixtures.config_snapshot`, so a division edited afterwards made the pad
 * render a format the fold had never used. And a stage's overlay — the
 * `shootout`/`extraTime` deciders, and now a per-stage `rules` fragment — never
 * reached the pad at all, which would have left a per-stage override invisible
 * on the very screen the organiser scores from.
 *
 * This is a LOADER, deliberately separate from `getFixture`: that function's
 * result IS the published `GET /fixtures/{id}` wire, unmapped (see FixtureOut
 * above) and declared as `S.Fixture`, so widening its select would have put two
 * undeclared fields — one of them a whole frozen config — into the public API
 * response. The pages need the cfg, not a wider fixture row.
 *
 * `f.config_snapshot` is selected HERE and nowhere else on this path, and that
 * is the column the whole thing turns on: `hasFrozenCfg` reads `undefined` as
 * absence exactly like `null` (fixture-cfg.ts:53-64), so a caller that joined
 * the stage but dropped the snapshot would serve live config for every scored
 * fixture and raise nothing. One select, one place to get it wrong.
 *
 * No `rejectDeviceLink` guard: this has no route of its own, and the
 * device-link pad is one of the two surfaces that legitimately needs it.
 */
export async function loadFixturePadCfg(auth: AuthCtx, fixtureId: string): Promise<unknown> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<
      {
        config_snapshot: unknown;
        division_config: unknown;
        stage_config: Record<string, unknown> | null;
      }[]
    >`
      select f.config_snapshot, d.config as division_config, s.config as stage_config
        from fixtures f
        join divisions d on d.id = f.division_id
        left join stages s on s.id = f.stage_id
       where f.id = ${fixtureId}`;
    // `withTenant` scopes the read to this org, so another tenant's fixture is
    // indistinguishable from a missing one — 404, never 403.
    if (!row) throw new HttpError(404, "fixture not found");
    return resolveFixtureCfg(row.config_snapshot, row.division_config, row.stage_config);
  });
}

/** All fixtures of a division in play order — the organiser console read.
 *
 *  The four `*_to_fixture`/`*_to_slot` columns are FOUR EXTRA COLUMNS on this
 *  one existing select, never a second round trip. They are the bracket feed
 *  edges, and the division page's draw sheet needs them to name an unfilled
 *  knockout seat by its feeder ("Winner of R1·3") instead of "TBD" —
 *  `feedLabels()` (lib/schedule-board.ts) turns them into the same
 *  `{key, params}` the schedule board already renders these very fixtures
 *  with. The stored `*_slot_label` cannot answer for them: the SETUP
 *  progression path leaves a sibling-fed seat's label NULL on purpose,
 *  because `stageOwesDraw`/`awaitsSeedDraw` read "no label ⇒ sibling-fed"
 *  for `timing: "setup"` stages.
 *
 *  They are NOT part of the published v1 `Fixture` contract — GET
 *  /divisions/{id}/fixtures strips them alongside `venue`/`court_label`, the
 *  same projection that route already documents. */
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
             f.ext_key, f.lane, f.is_final, f.third_place, f.conditional,
             f.winner_to_fixture, f.winner_to_slot, f.loser_to_fixture, f.loser_to_slot
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
 *  projected onto BOARD_FIXTURE_COLS: the board never reads `ext_key` or
 *  `is_final`, so those are not selected at all. Callers that need them (the
 *  division page's bracket/stages panel) keep using listDivisionFixtures.
 *
 *  `lane`/`third_place`/`conditional` ARE read now — they are what the card's
 *  knockout round code is computed from (board/round-codes.ts, 2026-09-23) —
 *  but each is put on a row only when it differs from its column default
 *  (lane null, flag false). Every round-robin row, i.e. nearly every row on
 *  the 5x66 budget board, carries none of the three keys and costs exactly
 *  what it did before; a single-elimination bracket pays for its one bronze
 *  match's flag, a double elimination for its lane. Absent means default —
 *  `BoardFixture` declares all three optional for exactly that reading. */
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
    const rows = await tx<
      (BoardFixtureRow & { lane: "WB" | "LB" | "GF" | null; third_place: boolean; conditional: boolean })[]
    >`
      select f.id, f.stage_id, f.division_id, f.pool_id, f.round_no, f.seq_in_round, f.fixture_no,
             f.home_entrant_id, f.away_entrant_id, f.home_slot_label, f.away_slot_label,
             f.scheduled_at, f.court_id,
             f.officials, f.status, f.outcome, f.schedule_source, f.schedule_locked, f.created_at,
             f.lane, f.third_place, f.conditional
      from fixtures f
      where f.division_id = ${divisionId}
      order by f.stage_id, f.round_no, f.seq_in_round`;
    // Omitted, not nulled: the RSC flight serialises an undefined value as
    // "$undefined" and a null/false as the key plus its value — only a key
    // that is not there costs nothing.
    return rows.map(({ lane, third_place, conditional, ...row }) => ({
      ...row,
      ...(lane !== null ? { lane } : {}),
      ...(third_place ? { third_place } : {}),
      ...(conditional ? { conditional } : {}),
    }));
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

/** The row `PUT /fixtures/{id}/stream` returns and the panel reads back. */
export interface FixtureStreamOut {
  id: string;
  stream_url: string | null;
}

/**
 * Set or clear a fixture's public broadcast link (stream overlay W1).
 *
 * Validated HERE as well as at the route, against the SAME schema the panel
 * uses (`@/lib/stream-url`, R16) — a usecase that trusts its caller is one
 * `parseBody` refactor away from writing an unvalidated host into a public
 * anchor. `withTenant` scopes the write; a fixture belonging to another org is
 * simply not found, which is also the answer for an id that does not exist.
 *
 * The revalidation is `fireDivisionRevalidate` (revalidate.ts:14), NOT
 * `broadcastRevalidate` — the latter is the peer primitive that helper calls
 * internally. It is what busts the `["pub-fixture-v3", fixtureId]` cache entry
 * tagged `divisionTag(division.id)` (`getPublicFixture`, data.ts), which is the
 * entry the public match page reads the link from.
 */
export async function setFixtureStreamUrl(
  auth: AuthCtx,
  id: string,
  streamUrl: string | null,
): Promise<FixtureStreamOut> {
  rejectDeviceLink(auth);
  const parsed = streamUrlSchema.safeParse(streamUrl);
  if (!parsed.success) throw new HttpError(422, "invalid stream link");
  const value = parsed.data;
  const out = await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ id: string; stream_url: string | null; division_id: string; competition_id: string }[]>`
      update fixtures f
         set stream_url = ${value}
        from divisions d
       where f.id = ${id} and d.id = f.division_id
      returning f.id, f.stream_url, f.division_id, d.competition_id`;
    if (!row) throw new HttpError(404, "fixture not found");
    return row;
  });
  fireDivisionRevalidate(out.division_id, out.competition_id);
  return { id: out.id, stream_url: out.stream_url };
}

export interface LineupOut {
  fixture_id: string;
  entrant_id: string;
  slots: unknown[];
}

/** R8 branch review, finding 2 — the lineup check's own outcome, DISCRIMINATED
 *  on `checked`. Before this the check was fail-OPEN and silent about it: the
 *  `catch` in `checkStoredLineup` returns no warnings, so `warnings: []` meant
 *  EITHER "validated, nothing wrong" OR "validation threw and we swallowed
 *  it", and the two were indistinguishable on the wire. A caller that wanted
 *  to fail closed — refuse to start a fixture on an unvalidated lineup, say —
 *  had nothing to branch on. `checked: false` says so explicitly; `warnings`
 *  stays present on both branches so every existing reader keeps working. */
export type LineupCheck =
  | { checked: true; warnings: string[] }
  | { checked: false; warnings: string[]; reason: string };

/** R7-15/R8 WS-F: the PUT response, `LineupOut` plus the outcome of checking
 *  the lineup just saved. A separate type from `LineupOut` rather than
 *  widening it — same reasoning as `PatchedFixtureOut` above: GET never
 *  validates, so these fields would be a lie on every read. */
export type PutLineupOut = LineupOut & LineupCheck;

/** One row of `readLineup`'s SQL, named so the validation below can be driven
 *  from what was actually STORED rather than from the request that asked for
 *  it (finding 3). `slot` is `text` in the DDL but carries
 *  `check (slot in ('starting','bench'))` (V215), so the narrowing where it is
 *  read is the database's guarantee, not an assumption. */
interface StoredLineupSlot {
  person_id: string;
  full_name: string;
  squad_number: number | null;
  slot: string;
  position_key: string | null;
  order_no: number | null;
  roles: string[];
  role: string | null;
  pair_order: number | null;
}

/** Human-readable rendering of one `validateLineup` issue (catalog.ts) for the
 *  PUT response + logs. Server-side only, English (no server i18n — AGENTS.md)
 *  — these are machine strings riding a warning list, not rendered copy; a
 *  future component that surfaces them to a user owes its own i18n work. */
function formatLineupIssue(issue: LineupIssue): string {
  switch (issue.kind) {
    case "starting_size":
      return `Starting lineup has ${issue.actual} player(s), expected ${issue.expected}`;
    case "bench_size":
      return `Bench has ${issue.actual} player(s), maximum is ${issue.max}`;
    case "duplicate_person":
      return `Person ${issue.personId} appears more than once in the lineup`;
    case "unknown_position":
      return `Person ${issue.personId} is assigned an unknown position "${issue.positionKey}"`;
    case "role_unknown":
      return `Person ${issue.personId} is assigned an unknown role "${issue.roleKey}"`;
    case "role_duplicate":
      return `Role "${issue.roleKey}" is held by more than one person (${issue.personIds.join(", ")})`;
    case "role_missing":
      return `Required role "${issue.roleKey}" is not filled by a starting player`;
    case "group_min":
      return `Position group "${issue.groupKey}" has ${issue.actual} starting player(s), minimum is ${issue.min}`;
    case "group_max":
      return `Position group "${issue.groupKey}" has ${issue.actual} starting player(s), maximum is ${issue.max}`;
  }
}

/** R7-15/R8 WS-F — `validateLineup`'s first production caller. WARNING ONLY:
 *  a lineup that fails validation still saves; the issues ride the PUT
 *  response as strings and are logged. Never throws: a registry/config
 *  problem resolving the catalog must not turn a working lineup save into a
 *  500 — the same "best effort, never blocks the write" posture
 *  `lineupCatalogFor` already documents for its own config-parse fallback.
 *
 *  R8 branch review, finding 3 — takes the rows `readLineup` gives back, NOT
 *  the request that asked for them. Validating `input.slots` described what
 *  the caller ASKED FOR: any normalisation, reordering or dropping the write
 *  applied was invisible to the warnings, which is the wrong answer to
 *  "is the lineup I now have valid?". Observable today in issue ORDER —
 *  `validateLineup` emits issues in slot-walk order and the read-back is
 *  ordered by `order_no nulls last, full_name`, so a request sent in some
 *  other order produced a list in the request's order, about rows stored in
 *  a different one.
 *
 *  Finding 2 — returns a DISCRIMINATED `LineupCheck` rather than a bare
 *  string[], so the `catch` below is no longer indistinguishable from a
 *  clean run. */
function checkStoredLineup(
  fixtureId: string,
  entrantId: string,
  sport: { sport_key: string; module_version: string; config: unknown },
  stored: readonly StoredLineupSlot[],
): LineupCheck {
  try {
    const sportModule = resolveModule(sport.sport_key, sport.module_version);
    const catalog = lineupCatalogFor(sportModule, sport.config);
    const lineup: Lineup = {
      entrantId,
      slots: stored.map((s, i) => ({
        personId: s.person_id,
        // V215's own check constraint is what makes this narrowing safe.
        slot: s.slot === "bench" ? "bench" : "starting",
        orderNo: s.order_no ?? i + 1,
        ...(s.position_key ? { positionKey: s.position_key } : {}),
        ...(Array.isArray(s.roles) && s.roles.length > 0 ? { roles: s.roles } : {}),
      })),
    };
    const issues = validateLineup(catalog, lineup);
    if (issues.length === 0) return { checked: true, warnings: [] };
    // IDs, kinds and keys only — never a payload/free-text value (case K5,
    // engine-db/append-event.ts's own logging convention).
    log.warn(
      { fixtureId, entrantId, sportKey: sport.sport_key, issues },
      "lineup saved with validateLineup warnings",
    );
    return { checked: true, warnings: issues.map(formatLineupIssue) };
  } catch (err) {
    log.error(
      { fixtureId, entrantId, sportKey: sport.sport_key, err },
      "lineup validation crashed — save proceeded UNCHECKED",
    );
    // The error's KIND, never its message: a message can carry config or
    // payload text, and this string rides the HTTP response (same convention
    // as the log fields above).
    return { checked: false, warnings: [], reason: err instanceof Error ? err.name : "unknown" };
  }
}

/** Replace an entrant's lineup for a fixture (idempotent PUT, doc 08 §3). */
export async function putLineup(
  auth: AuthCtx,
  fixtureId: string,
  entrantId: string,
  input: PutLineup,
): Promise<PutLineupOut> {
  rejectDeviceLink(auth); // doc 13 §7: no lineups via device link
  // B05: resolved HERE, not inside the transaction. `hasFeature` queries the
  // pooled `sql` proxy and `withTenant` pins a pooled connection for its whole
  // callback — asking inside is the self-deadlock `lib/db.ts`'s nesting guard
  // exists to catch. The boolean rides in instead.
  const disciplineEnforced = await disciplineEnforcedForFixture(auth.orgId, fixtureId);
  return withTenant(auth.orgId, async (tx) => {
    const [fixture] = await tx<
      {
        division_id: string;
        competition_id: string;
        home_entrant_id: string | null;
        away_entrant_id: string | null;
        status: string;
        scorer_can_enter_lineups: boolean;
        sport_key: string;
        module_version: string;
        config: unknown;
      }[]
    >`
      select f.division_id, f.home_entrant_id, f.away_entrant_id, f.status, d.scorer_can_enter_lineups,
             d.sport_key, d.module_version, d.config, d.competition_id
      from fixtures f join divisions d on d.id = f.division_id
      where f.id = ${fixtureId}`;
    if (!fixture) throw new HttpError(404, "fixture not found");
    // Lineup entry is config-gated for non-editors (accepted officials).
    // Coverage was proven at the door.
    if (subjectToScorerCapabilityGates(auth) && !fixture.scorer_can_enter_lineups) {
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
    // RS011: catches a pre-feature roster — a person entered before this
    // gate existed (or added on a still-ungated path) can reach a lineup
    // without ever having been checked. Same evaluator, same 422 code, as
    // every other organiser roster-write gate.
    await gateRosterEligibility(tx, {
      divisionId: fixture.division_id,
      personIds: ids,
      context: "put_lineup",
      override: input.eligibility_override,
      actorId: auth.userId,
    });
    // B05: and the discipline gate, on the same override field. A confirmed
    // ban ('active') was recorded, shown on the pad banner and on the public
    // strip, and then accepted onto the sheet anyway — this is the one place
    // that read was owed. `eligibility_override.reason` lets an organiser
    // proceed on the record, against a ledger row.
    await gateLineupSuspensions(tx, {
      divisionId: fixture.division_id,
      competitionId: fixture.competition_id,
      orgId: auth.orgId,
      fixtureId,
      personIds: ids,
      enforced: disciplineEnforced,
      override: input.eligibility_override,
      actorId: auth.userId,
    });
    await tx`delete from lineups where fixture_id = ${fixtureId} and entrant_id = ${entrantId}`;
    for (const [i, s] of input.slots.entries()) {
      await tx`
        insert into lineups (fixture_id, entrant_id, person_id, slot, position_key, order_no, roles, role, pair_order)
        values (${fixtureId}, ${entrantId}, ${s.person_id}, ${s.slot},
                ${s.position_key ?? null}, ${s.order_no ?? i + 1}, ${tx.json(s.roles as never)},
                ${s.role ?? "player"}, ${s.pair_order ?? null})`;
    }
    // Finding 3: read back FIRST, then validate what was actually stored.
    const lineup = await readLineup(tx, fixtureId, entrantId);
    const check = checkStoredLineup(
      fixtureId,
      entrantId,
      { sport_key: fixture.sport_key, module_version: fixture.module_version, config: fixture.config },
      lineup.slots,
    );
    return { ...lineup, ...check };
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
): Promise<{ fixture_id: string; entrant_id: string; slots: StoredLineupSlot[] }> {
  // Jul3/07 §5 (9 Sep ×4): shirt numbers ride the lineup read model so every
  // scorer picker can render "#7 — Name".
  const slots = await tx<StoredLineupSlot[]>`
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

/** The `/state` ETag: the ledger seq. The `-m2` suffix is kept as it is (the
 *  representation's name since the cricket margin became `{ kind, value? }`). */
export function fixtureStateEtag(lastSeq: number): string {
  return `"seq-${lastSeq}-m2"`;
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
    // `CricketState.margin` is `{ kind, value? }` in every stored fold (greenfield:
    // no legacy English margins are stored), so the rows are served as they are.
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
