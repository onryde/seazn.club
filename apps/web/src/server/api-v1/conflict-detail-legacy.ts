// Deprecated legacy English for a structured `ConflictDetail` (C3, 2026-08-13
// design amendment,
// `docs/superpowers/specs/2026-08-12-conflict-detail-names-design.md`).
//
// Before C3 the engine built this prose inline (`calendar.ts`/`build.ts` as
// of commit d0cd9a25 and earlier). This module reproduces every one of the
// 25 family templates BYTE FOR BYTE from that commit, driven off the
// structured `ConflictDetail` the engine emits instead — taken from
// `git show d0cd9a25:packages/engine/src/scheduling/calendar.ts` and
// `git show d0cd9a25:packages/engine/src/scheduling/build.ts`, not
// reconstructed from memory or from the design doc's summary table.
//
// Two consumers still need this exact English, and neither may drift from
// the old text:
//
//   1. `ScheduleConflict.detail` / `AiPlanConflict.detail` — the wire's
//      back-compat field, kept for existing clients until it is removed.
//   2. `verifier_conflicts` on the AI repair-round conversation
//      (schedule-ai.ts, competition-schedule-ai.ts) — the C3 design doc
//      rules the model's input stays byte-identical to pre-C3: nothing in
//      that task measured repair quality, and the request's token weight
//      feeds AI-credit accounting.
//
// Lives under api-v1 (not the engine) because the design doc rules the
// deriver cannot be a client-side formatter: it must run server-side where
// both the API mappers and the two AI usecases can import it. Never add a
// third call site — new code should read `ConflictDetail`'s `kind`/fields
// directly and localize at render time, client-side.
import type { Conflict, ConflictDetail, ConflictDetailKind } from "@seazn/engine/scheduling";

/**
 * @deprecated Byte-for-byte pre-C3 English, kept only for the two back-compat
 * consumers named in this module's header. Do not call this from new code —
 * read `ConflictDetail`'s structured `kind`/fields instead and localize at
 * render time.
 */
export function legacyConflictDetail(d: ConflictDetail): string {
  return LEGACY_PROSE[d.kind](d);
}

/**
 * The AI repair round's own copy of a conflict (`verifier_conflicts` on the
 * conversation, schedule-ai.ts/competition-schedule-ai.ts) — byte-identical
 * to what the model read pre-C3 (C3 design doc ruling: "the prose reaches
 * the model, not just the screen"). Strips the new `details` entirely
 * (JSON.stringify must never see it here — a structured field the model
 * never saw before would widen the request's token weight, which AI-credit
 * accounting depends on staying put) and derives `detail` from it instead,
 * so every other field (`fixtureId`, `reason`, `direct`, `rule`,
 * `shortfallMinutes`) rides through completely unchanged — same set AND
 * same byte order as pre-C3 (review finding 4): a plain `{ ...rest, detail
 * }` puts `detail` wherever `rest`'s own insertion order left it (the very
 * END, after `rule`), not where every pre-C3 push site wrote it (3rd,
 * right after `reason`) — same field set, different bytes, which is what
 * the "byte-identical model payload" claim behind the AI-credit token-
 * weight argument actually needs to be true.
 */
export function legacyVerifierConflict(c: Conflict): Omit<Conflict, "details"> & { detail?: string } {
  const { fixtureId, reason, details, direct, shortfallMinutes, rule } = c;
  return {
    fixtureId,
    reason,
    ...(details !== undefined ? { detail: legacyConflictDetail(details) } : {}),
    ...(direct !== undefined ? { direct } : {}),
    ...(shortfallMinutes !== undefined ? { shortfallMinutes } : {}),
    ...(rule !== undefined ? { rule } : {}),
  };
}

/**
 * Restores the deprecated `detail` string onto a wire response that carries
 * an engine `Conflict` verbatim (the camelCase `AiPlanConflict` shape —
 * see its comment in schemas.ts: the orchestrator returns `Conflict[]`
 * unchanged, by design, so a client reading `warnings`/`blocking` off an
 * AI-plan response keeps working). Unlike `legacyVerifierConflict`, `details`
 * stays — it is additive on THIS path, not the model's.
 */
export function withLegacyDetail<C extends { details?: ConflictDetail }>(c: C): C & { detail?: string } {
  return c.details !== undefined ? { ...c, detail: legacyConflictDetail(c.details) } : c;
}

// One entry per `ConflictDetailKind`, cross-checked field by field against
// the design doc's "AMENDED 2026-08-13" table AND the d0cd9a25 sources (see
// this file's header) — never one without the other.
//
// `Record<ConflictDetailKind, ...>` rather than a switch: the object literal
// is checked against every key of the union, so a kind added to the engine's
// type and forgotten here is a TYPE ERROR (a missing property), and a typo'd
// key is an excess-property TYPE ERROR — neither falls through to a runtime
// default the way a switch's missing `case` silently would.
//
// The non-null assertions below assert an invariant `conflict-detail.ts`
// already established: each engine call site sets exactly the fields its own
// `kind` needs (design doc table, "fields beyond `kind`" column). A kind
// reached here without its field populated is an engine bug this function
// cannot repair — better a loud `TypeError` than a silently wrong sentence.
const LEGACY_PROSE: Record<ConflictDetailKind, (d: ConflictDetail) => string> = {
  person_double_booking: (d) => `person ${d.personIds![0]} also in ${d.otherFixtureId}`,
  // P9 pass 3a: `court` is now a real `courts.id` (the venues/courts
  // cutover — see conflict-detail.ts's own header). `courtName` is the
  // caller-attached resolution (never set by the engine); `?? d.court`
  // is the one fallback that keeps this pure function total when a caller
  // could not resolve one (should not happen — `courts.id` is FK-restricted
  // from every `fixtures.court_id` that points at it — but a bare id beats
  // throwing on a miss).
  locked_slot_clash: (d) => `locked slot clashes on ${d.courtName ?? d.court}`,
  no_slot_start_window: () => "no feasible slot before the start window's notAfter bound",
  no_slot_person_bound: (d) =>
    `no court/time within horizon free of person ${d.personIds![0]} (also in ${d.otherFixtureId})`,
  no_slot_horizon: () => "no court/time within horizon",
  instruction_feeder_gap: (d) =>
    `starts ${d.minutes} min after its feeder, instruction requires ${d.requiredMinutes}`,
  instruction_day_cap: (d) => `${d.count} fixtures on ${d.day} exceed the ${d.requiredCount}/day cap`,
  instruction_weekday: (d) => `is on ${d.weekday} ${d.day}, instruction requires ${d.requiredWeekday}`,
  instruction_date: (d) => `is on ${d.day}, instruction requires ${d.requiredDate}`,
  instruction_time: (d) => `starts ${d.time}, violating ${d.ruleType} ${d.requiredTime}`,
  outside_competition_window: () => "outside the competition window",
  outside_start_window: () => "outside the target's start window",
  // `otherFixtureId` is optional here alone (calendar.ts:1384's fallback: a
  // reportability guard, not a real counterparty — see the design doc's
  // "court_double_booking alone" paragraph). The `?? "another fixture"`
  // reproduces that literal fallback exactly. `courtName ?? court` is the
  // same P9 pass 3a id-to-name fallback `locked_slot_clash` uses above.
  court_double_booking: (d) =>
    `court ${d.courtName ?? d.court} double-booked with ${d.otherFixtureId ?? "another fixture"}`,
  inside_blackout: () => "inside a blackout window",
  outside_session_windows: () => "outside session windows",
  entrant_overlap: (d) => `entrant ${d.entrantIds![0]} overlap with ${d.otherFixtureId}`,
  entrant_below_rest: (d) => `entrant ${d.entrantIds![0]} below rest`,
  person_overlap: (d) => `person ${d.personIds![0]} overlap with ${d.otherFixtureId}`,
  person_below_rest: (d) => `person ${d.personIds!.join("/")} below rest`,
  order_before_feeder: (d) => `starts before feeder ${d.otherFixtureId} ends`,
  order_inside_feeder_rest: (d) => `starts inside feeder ${d.otherFixtureId}'s ${d.requiredMinutes} min rest`,
  round_order_day: (d) =>
    `round ${d.roundNo} (day ${d.day}) starts before round ${d.otherRoundNo} (day ${d.otherDay})`,
  round_order_same_day: (d) =>
    `round ${d.roundNo} starts before round ${d.otherRoundNo} on the same day (${d.day})`,
  no_slot_lattice: () => "no legal slot in the lattice",
  no_slot_budget: () => "left unplaced when the solver's budget expired",
};
