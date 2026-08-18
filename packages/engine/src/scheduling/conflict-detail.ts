// Structured, id-only conflict details (C3, 2026-08-13 design amendment,
// `docs/superpowers/specs/2026-08-12-conflict-detail-names-design.md`). The
// engine stops building English prose for a conflict's detail and emits this
// instead: a `kind` naming which of the 25 family templates produced the row
// (calendar.ts builds 23, build.ts 2 more — the design doc's "AMENDED
// 2026-08-13" table has the exact `file:line` and field list for each), plus
// whichever of the scalar/id fields that template needs. The engine stays
// id-only — it has no display names, and gains none; resolving an id to a
// name is a client concern, out of scope here.
//
// `courtName` (P9 pass 3a, venues/courts cutover) is the one deliberate
// exception to "id-only", and it does not contradict the ruling above: no
// engine call site (calendar.ts/build.ts) ever sets it — `court` became a
// real `courts.id` the moment apps/web started feeding `Assignment.court`
// with `fixtures.court_id` instead of the legacy free-text `court_label`
// (see candidate-courts.ts's own header, and the court-id-lattice-
// equivalence test: the lattice has always treated `court` as an opaque
// string, so that swap is a pure representation change, invisible here).
// `court_double_booking` and `locked_slot_clash` are now the two kinds whose
// `court` is a bare uuid, and `legacyConflictDetail`
// (apps/web/conflict-detail-legacy.ts) builds ENGLISH PROSE from a
// `ConflictDetail` alone — no db, no second argument — so a caller with db
// access (apps/web) has nowhere else to attach a resolved name for that pure
// function to read. `courtName` is that attachment point: optional, never
// populated by the engine, populated only by a caller that already resolved
// `court` to a `courts.name` before handing the (still otherwise
// engine-built) detail to `legacyConflictDetail` or the wire mapper.
//
// `court_tag_mismatch` (P9 pass 2c, venues/courts cutover, owner ruling) is a
// 26th kind added post-doc — the design doc's table enumerates 25 and this
// one postdates it, the same way `courtName` above postdates the doc's
// original field list. It closes the placer/verifier fork P9 introduced:
// the placer restricts NEW placements to courts whose tags satisfy a
// division's/stage's `required_court_tags` (candidate-courts.ts), but
// nothing on the verify side read that constraint, so a fixture landed on a
// tag-mismatched court by any other path (a hand-drag, an AI draft) validated
// clean. `court` is its uuid, same convention as `court_double_booking`.

/** One member per family template. The design doc's own table enumerates 25;
 *  a 26th (`court_tag_mismatch`, above) has since been added by owner ruling
 *  — closed at exactly these 26, and a 27th needs the same, not a cast. */
export type ConflictDetailKind =
  | "person_double_booking"
  | "locked_slot_clash"
  | "no_slot_start_window"
  | "no_slot_person_bound"
  | "no_slot_horizon"
  | "instruction_feeder_gap"
  | "instruction_day_cap"
  | "instruction_weekday"
  | "instruction_date"
  | "instruction_time"
  | "outside_competition_window"
  | "outside_start_window"
  | "court_double_booking"
  | "court_tag_mismatch"
  | "inside_blackout"
  | "outside_session_windows"
  | "entrant_overlap"
  | "entrant_below_rest"
  | "person_overlap"
  | "person_below_rest"
  | "order_before_feeder"
  | "order_inside_feeder_rest"
  | "round_order_day"
  | "round_order_same_day"
  | "no_slot_lattice"
  | "no_slot_budget";

/** Id-only, never a display name. `entrantIds`/`personIds` carry MEANINGFUL
 *  ORDER — `person_below_rest` joins its `personIds` in board order today
 *  (calendar.ts:1451), and the legacy prose has to stay reproducible from the
 *  structure, so nothing here may silently sort an id array.
 *
 *  No `fixtureIds`: no template ever needed a list of counterparties: every
 *  one names at most a single other fixture, carried in `otherFixtureId`. */
export interface ConflictDetail {
  kind: ConflictDetailKind;
  entrantIds?: string[];
  personIds?: string[];
  otherFixtureId?: string;
  court?: string;
  /** Caller-attached only — see the module header. Never set by the engine. */
  courtName?: string;
  day?: string;
  otherDay?: string;
  weekday?: string;
  requiredWeekday?: string;
  requiredDate?: string;
  time?: string;
  requiredTime?: string;
  ruleType?: string;
  roundNo?: number;
  otherRoundNo?: number;
  minutes?: number;
  requiredMinutes?: number;
  count?: number;
  requiredCount?: number;
}

// Exhaustive by construction, the same reasoning `RULE_BY_REASON` uses in
// calendar.ts for `ConflictReason`: the `Record<..., true>` key type means a
// field added to `ConflictDetail` and forgotten here is a TYPE ERROR, not a
// silently dropped byte of conflict identity. `Object.keys` on an object
// literal is insertion order (spec-guaranteed for string keys), so this is
// the one and only field order `canonConflictDetail` reads — deliberately
// NOT `Object.keys(d)` on the detail being serialized, which would make the
// canon depend on whatever property order the CALL SITE happened to write
// its object literal in.
const FIELD_ORDER_WITNESS: Record<Exclude<keyof ConflictDetail, "kind">, true> = {
  entrantIds: true,
  personIds: true,
  otherFixtureId: true,
  court: true,
  courtName: true,
  day: true,
  otherDay: true,
  weekday: true,
  requiredWeekday: true,
  requiredDate: true,
  time: true,
  requiredTime: true,
  ruleType: true,
  roundNo: true,
  otherRoundNo: true,
  minutes: true,
  requiredMinutes: true,
  count: true,
  requiredCount: true,
};
const FIELD_ORDER = Object.keys(FIELD_ORDER_WITNESS) as (keyof typeof FIELD_ORDER_WITNESS)[];

/** Deterministic canonical serialization — the identity `conflictKey`
 *  (calendar.ts:218) folds in, so `deltaConflicts`, `repair-minimality.ts`
 *  and the joint apply gate all key on this, indirectly.
 *
 *  Two `ConflictDetail`s with the same fields canon identically regardless of
 *  the literal order they were built in: `FIELD_ORDER` above is fixed and
 *  never reads the input's own key order. Every populated field participates
 *  — `conflict-detail.test.ts`'s per-kind sweep proves it field by field, so
 *  a template that stops setting one is caught rather than silently
 *  collapsing two different breaches onto one key.
 *
 *  Each value goes through `JSON.stringify` INDIVIDUALLY, never the whole
 *  object at once — that would both depend on the input's own property
 *  order (exactly the trap this function exists to avoid) and let a value
 *  containing the `|` or `=` separators collide two different details onto
 *  one string, since a JSON-escaped value can never itself produce an
 *  unescaped `|` or a bare leading `"`. */
export function canonConflictDetail(d: ConflictDetail): string {
  const parts = [`kind=${d.kind}`];
  for (const field of FIELD_ORDER) {
    const v = d[field];
    if (v === undefined) continue;
    parts.push(`${field}=${JSON.stringify(v)}`);
  }
  return parts.join("|");
}
