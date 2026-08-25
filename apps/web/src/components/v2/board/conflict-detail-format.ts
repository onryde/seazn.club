// One shared, localized formatter for a structured conflict `details` entry
// (C3, 2026-08-13 design amendment,
// docs/superpowers/specs/2026-08-12-conflict-detail-names-design.md). Every
// surface that used to print the engine's raw (English, sometimes
// UUID-bearing) `detail` string now calls this instead. Pure: no JSX, no
// hooks, no dict loading — `msg` is handed in by the caller's useMsg()
// (client) or msgFor() (server), the same pattern ai-instruction-describe.ts
// and ai-trace-compose.ts already use.
//
// Type-only import from the scheduling barrel. The barrel's own header warns
// client code away from it because a VALUE import (`export * from "./build.ts"`)
// reaches gRPC — but `import type` erases completely at build and never pulls
// runtime code into the bundle. This is the established pattern for exactly
// this situation: `ai-instruction-describe.ts` (`HardConstraint`,
// `FixtureSelector`) and `lib/schedule-board.ts` (`Conflict`, for its
// isomorphic REASON_CODE table) both already do it.
import type { ConflictDetail, ConflictDetailKind } from "@seazn/engine/scheduling";
import type { MessageKey } from "@/lib/messages";
import type { BoardConflictDetail } from "./types";

export type FormatMsg = (key: MessageKey, vars?: Record<string, string | number>) => string;

export interface ConflictDetailCtx {
  msg: FormatMsg;
  /** Entrant id -> display name. Every board surface already builds this for
   *  card titles (`cardTitle`, types.ts). */
  entrantNames: Readonly<Record<string, string>>;
  /** Fixture id -> a title for it (`cardTitle` output on the board; `matchup`
   *  on the AI console surfaces, which never had a `cardTitle` map). */
  fixtureTitles: Readonly<Record<string, string>>;
  /** Person id -> display name. Optional — and, as of C3 (2026-08-13), NOT
   *  currently supplied by any caller: no board or joint-schedule surface
   *  (`schedule-board.tsx`, `conflicts-panel.tsx`, `schedule-gate-dialog.tsx`,
   *  `fixture-block.tsx`, the AI console tree) builds a person-id ->
   *  display-name map today, unlike `entrantNames`/`fixtureTitles` above,
   *  which every caller already has on hand. The only `personNames` maps
   *  that exist in this codebase belong to unrelated flows scoped narrower
   *  than the board: the officials incident-report drawer builds one from a
   *  single fixture's `squad` roster (`components/officials/report-form.tsx`),
   *  and the scorepad builds one from a live match's `SideInfo`
   *  (`v2/scorepad/registry.tsx`'s `personNamesFrom`). Neither is reachable
   *  from where a conflict renders.
   *
   *  The `personIds` this formatter resolves name `entrant_members` rows
   *  (roster/squad members — see `peopleByEntrant`/`peopleOf` in
   *  `server/usecases/schedule.ts`, which is what feeds the engine's
   *  `Assignment.people`), not officials. Populating this for real would
   *  need a NEW query joining `entrant_members` to `persons` on the
   *  board/joint-schedule pages (none load one today) and threading the
   *  result through every layer `entrantNames` already reaches — out of
   *  scope for a review-response pass; left here as an honest, currently-
   *  unfed optional field. Absent (or a miss) falls back to `personLabel`'s
   *  id handling below — never a raw UUID. */
  personNames?: Readonly<Record<string, string>>;
}

/** A synthetic collapsed-person key minted by `personKeyResolver`
 *  (`apps/web/src/server/usecases/schedule-ai.ts:202`) when a joint AI pack
 *  finds two person rows sharing a display name: `name:${normalizedName}`.
 *  It already CARRIES its name — slicing it to 8 chars the way a genuine
 *  opaque id is shortened would print `name:ali`, worse than the raw id. */
const SYNTHETIC_PERSON_PREFIX = "name:";

/** Never a full UUID: the last-resort fallback for any id this formatter
 *  cannot resolve through a name map. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

function firstOf(ids: readonly string[] | undefined): string | undefined {
  return ids && ids.length > 0 ? ids[0] : undefined;
}

/** One person id -> display text. A `personNames` hit wins; otherwise a
 *  synthetic `name:` id renders the name it already carries; otherwise the
 *  id is shortened. Never a full UUID. */
function personLabel(id: string | undefined, personNames: Readonly<Record<string, string>> | undefined): string {
  if (!id) return "";
  const known = personNames?.[id];
  if (known !== undefined) return known;
  if (id.startsWith(SYNTHETIC_PERSON_PREFIX)) return id.slice(SYNTHETIC_PERSON_PREFIX.length);
  return shortId(id);
}

/** Every person id, joined for the ONE kind (`person_below_rest`) whose
 *  message names more than one person at once — every other kind that
 *  carries `personIds` reads only the first (see the field-order comment on
 *  `ConflictDetail` in the engine: the legacy prose reads exactly this way,
 *  `personIds![0]` everywhere except the join at calendar.ts:1451). */
function personsJoined(ids: readonly string[] | undefined, personNames: Readonly<Record<string, string>> | undefined): string {
  return (ids ?? []).map((id) => personLabel(id, personNames)).join(", ");
}

function entrantLabel(id: string | undefined, entrantNames: Readonly<Record<string, string>>): string {
  if (!id) return "";
  return entrantNames[id] ?? shortId(id);
}

function fixtureLabel(id: string | undefined, fixtureTitles: Readonly<Record<string, string>>): string {
  if (!id) return "";
  return fixtureTitles[id] ?? shortId(id);
}

/** P9 review wave 3, finding #3: `d.court` is a real courts.id uuid for
 *  every kind that carries it (court_double_booking, locked_slot_clash,
 *  court_tag_mismatch — see the engine's own ConflictDetail doc) and must
 *  never render directly. `d.courtName` is the server-resolved, venue-
 *  qualified display name for it (schemas.ts's ScheduleConflictDetail.
 *  court_name, via courtNamesById -> buildCourtDirectory — the SAME
 *  directory rule every other court-facing surface uses, not a second
 *  implementation of it). A miss degrades to the shared "Unknown court"
 *  string (court-multi-picker.tsx's own convention), never the raw id. */
function courtLabel(courtName: string | undefined, msg: FormatMsg): string {
  return courtName ?? msg("courtPicker.unknownCourt");
}

/**
 * Localized, name-resolved text for one structured conflict detail.
 *
 * Exhaustive by construction: the `switch` covers every member of
 * `ConflictDetailKind` and the `default` branch assigns `d.kind` to a
 * `never` — add a 26th kind to the engine and this is a COMPILE error here,
 * never a silently blank string.
 */
export function formatConflictDetail(d: ConflictDetail, ctx: ConflictDetailCtx): string {
  const { msg, entrantNames, fixtureTitles, personNames } = ctx;
  switch (d.kind) {
    case "person_double_booking":
      return msg("board.conflict.detail.person_double_booking", {
        person: personLabel(firstOf(d.personIds), personNames),
        other: fixtureLabel(d.otherFixtureId, fixtureTitles),
      });
    case "locked_slot_clash":
      return msg("board.conflict.detail.locked_slot_clash", { court: courtLabel(d.courtName, msg) });
    case "no_slot_start_window":
      return msg("board.conflict.detail.no_slot_start_window");
    case "no_slot_person_bound":
      return msg("board.conflict.detail.no_slot_person_bound", {
        person: personLabel(firstOf(d.personIds), personNames),
        other: fixtureLabel(d.otherFixtureId, fixtureTitles),
      });
    case "no_slot_horizon":
      return msg("board.conflict.detail.no_slot_horizon");
    case "instruction_feeder_gap":
      return msg("board.conflict.detail.instruction_feeder_gap", {
        minutes: d.minutes ?? 0,
        required: d.requiredMinutes ?? 0,
      });
    case "instruction_day_cap":
      return msg("board.conflict.detail.instruction_day_cap", {
        count: d.count ?? 0,
        day: d.day ?? "",
        required: d.requiredCount ?? 0,
      });
    case "instruction_weekday":
      return msg("board.conflict.detail.instruction_weekday", {
        weekday: d.weekday ?? "",
        day: d.day ?? "",
        required: d.requiredWeekday ?? "",
      });
    case "instruction_date":
      return msg("board.conflict.detail.instruction_date", {
        day: d.day ?? "",
        required: d.requiredDate ?? "",
      });
    case "instruction_time":
      // Two rule types share this one kind (calendar.ts: `h.type === "not_before"
      // ? ... : ...`, the ONLY two values `ruleType` ever carries here) — each
      // gets its own sentence rather than a shared "violates {ruleType}", which
      // would either leak the engine's raw rule token or need its own
      // ruleType -> localized-noun table for no benefit over two keys.
      return d.ruleType === "not_after"
        ? msg("board.conflict.detail.instruction_time.not_after", {
            time: d.time ?? "",
            required: d.requiredTime ?? "",
          })
        : msg("board.conflict.detail.instruction_time.not_before", {
            time: d.time ?? "",
            required: d.requiredTime ?? "",
          });
    case "outside_competition_window":
      return msg("board.conflict.detail.outside_competition_window");
    case "outside_start_window":
      return msg("board.conflict.detail.outside_start_window");
    case "court_double_booking":
      // `otherFixtureId` is the one field the design doc's table marks
      // optional for this kind alone — calendar.ts's reportability fallback
      // (`courtBlocked`/`hits` disagreeing) rather than a real counterparty.
      return d.otherFixtureId
        ? msg("board.conflict.detail.court_double_booking", {
            court: courtLabel(d.courtName, msg),
            other: fixtureLabel(d.otherFixtureId, fixtureTitles),
          })
        : msg("board.conflict.detail.court_double_booking.unknown", { court: courtLabel(d.courtName, msg) });
    case "court_tag_mismatch":
      // P9 pass 2c. No counterparty fixture — this is a property of the
      // court itself, not a clash with another card — so unlike
      // court_double_booking there is no otherFixtureId branch.
      return msg("board.conflict.detail.court_tag_mismatch", { court: courtLabel(d.courtName, msg) });
    case "outside_court_hours":
      // P9.5, D5b.5. Same shape as court_tag_mismatch just above: a property
      // of the court itself (its declared opening hours), not a clash with
      // another card, so no otherFixtureId branch.
      return msg("board.conflict.detail.outside_court_hours", { court: courtLabel(d.courtName, msg) });
    case "stranded_fixture":
      // P10. Same shape again: a property of the court itself (it was
      // archived or deleted out from under an already-placed fixture), not a
      // clash with another card, so no otherFixtureId branch. `courtLabel`
      // resolves through the same server-enriched `courtName` every other
      // court-carrying kind uses (`withCourtNames`, schedule.ts — keyed on
      // `details.court` presence, not a kind list, so it already covers this
      // kind with no changes there) and degrades to the shared "Unknown
      // court" string on a miss, same as its siblings — never the raw uuid.
      return msg("board.conflict.detail.stranded_fixture", { court: courtLabel(d.courtName, msg) });
    case "inside_blackout":
      return msg("board.conflict.detail.inside_blackout");
    case "outside_session_windows":
      return msg("board.conflict.detail.outside_session_windows");
    case "entrant_overlap":
      return msg("board.conflict.detail.entrant_overlap", {
        entrant: entrantLabel(firstOf(d.entrantIds), entrantNames),
        other: fixtureLabel(d.otherFixtureId, fixtureTitles),
      });
    case "entrant_below_rest":
      return msg("board.conflict.detail.entrant_below_rest", {
        entrant: entrantLabel(firstOf(d.entrantIds), entrantNames),
      });
    case "person_overlap":
      return msg("board.conflict.detail.person_overlap", {
        person: personLabel(firstOf(d.personIds), personNames),
        other: fixtureLabel(d.otherFixtureId, fixtureTitles),
      });
    case "person_below_rest":
      // The one kind that names more than one person — see `personsJoined`.
      return msg("board.conflict.detail.person_below_rest", {
        people: personsJoined(d.personIds, personNames),
      });
    case "order_before_feeder":
      return msg("board.conflict.detail.order_before_feeder", {
        other: fixtureLabel(d.otherFixtureId, fixtureTitles),
      });
    case "order_inside_feeder_rest":
      return msg("board.conflict.detail.order_inside_feeder_rest", {
        other: fixtureLabel(d.otherFixtureId, fixtureTitles),
        required: d.requiredMinutes ?? 0,
      });
    case "round_order_day":
      return msg("board.conflict.detail.round_order_day", {
        round: d.roundNo ?? 0,
        day: d.day ?? "",
        otherRound: d.otherRoundNo ?? 0,
        otherDay: d.otherDay ?? "",
      });
    case "round_order_same_day":
      return msg("board.conflict.detail.round_order_same_day", {
        round: d.roundNo ?? 0,
        otherRound: d.otherRoundNo ?? 0,
        day: d.day ?? "",
      });
    case "no_slot_lattice":
      return msg("board.conflict.detail.no_slot_lattice");
    case "no_slot_budget":
      return msg("board.conflict.detail.no_slot_budget");
    default: {
      // Compile-time exhaustiveness only: this proves the switch covers
      // every `ConflictDetailKind` THIS BUILD knows about. It cannot prove
      // anything about a value that reaches here at runtime — and one can:
      // `fromBoardConflictDetail` casts the wire's plain-`string` `kind`
      // (`as ConflictDetailKind`), so an older client bundle or a cached
      // conflict carrying a kind this build predates lands here for real, on
      // version skew (review finding 5). `d.kind` is then a genuine unknown
      // string, not the `never` its type claims — returning it would print
      // raw engine vocabulary (e.g. "no_slot_budget") straight at an
      // organiser. Never surface that: an empty string degrades silently,
      // same as any other id this formatter cannot resolve.
      const _exhaustive: never = d.kind;
      void _exhaustive;
      return "";
    }
  }
}

/** Snake_case wire shape (`BoardConflict.details`, types.ts) -> the engine's
 *  own camelCase `ConflictDetail`. A plain rename, nothing derived — the
 *  inverse of `toWireConflictDetail` in usecases/schedule.ts. Conditional
 *  spreads throughout so an absent field stays ABSENT rather than a present
 *  `undefined`, matching that function's own idiom. */
export function fromBoardConflictDetail(d: BoardConflictDetail): ConflictDetail {
  return {
    kind: d.kind as ConflictDetailKind,
    ...(d.entrant_ids !== undefined ? { entrantIds: d.entrant_ids } : {}),
    ...(d.person_ids !== undefined ? { personIds: d.person_ids } : {}),
    ...(d.other_fixture_id !== undefined ? { otherFixtureId: d.other_fixture_id } : {}),
    ...(d.court !== undefined ? { court: d.court } : {}),
    ...(d.court_name !== undefined ? { courtName: d.court_name } : {}),
    ...(d.day !== undefined ? { day: d.day } : {}),
    ...(d.other_day !== undefined ? { otherDay: d.other_day } : {}),
    ...(d.weekday !== undefined ? { weekday: d.weekday } : {}),
    ...(d.required_weekday !== undefined ? { requiredWeekday: d.required_weekday } : {}),
    ...(d.required_date !== undefined ? { requiredDate: d.required_date } : {}),
    ...(d.time !== undefined ? { time: d.time } : {}),
    ...(d.required_time !== undefined ? { requiredTime: d.required_time } : {}),
    ...(d.rule_type !== undefined ? { ruleType: d.rule_type } : {}),
    ...(d.round_no !== undefined ? { roundNo: d.round_no } : {}),
    ...(d.other_round_no !== undefined ? { otherRoundNo: d.other_round_no } : {}),
    ...(d.minutes !== undefined ? { minutes: d.minutes } : {}),
    ...(d.required_minutes !== undefined ? { requiredMinutes: d.required_minutes } : {}),
    ...(d.count !== undefined ? { count: d.count } : {}),
    ...(d.required_count !== undefined ? { requiredCount: d.required_count } : {}),
  };
}

/** Convenience: format straight off the snake_case `BoardConflict.details`
 *  wire shape, for the board surfaces that never see the engine's camelCase
 *  shape directly. */
export function formatBoardConflictDetail(d: BoardConflictDetail, ctx: ConflictDetailCtx): string {
  return formatConflictDetail(fromBoardConflictDetail(d), ctx);
}
