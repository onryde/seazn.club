// Who is still IN the field?
//
// Until V412 this question was answered inside `public_entrants_v`, which
// simply refused to publish anything but `registered`/`confirmed`. That made a
// withdrawn entrant unnameable on the public board: the standings snapshot is
// keyed by entrant id and built from RESULTS, so their row survived a
// withdrawal while their name did not, and the public table printed a raw UUID
// (F10, found by driving the product 2026-09-21).
//
// The view now publishes every entrant of a public competition, and the two
// questions are separate where they always belonged:
//
//   - "what is this entrant called" — every caller resolving a name, a badge or
//     a fixture side wants the whole set, including the people who left.
//   - "who is competing" — the entrants tab, the entrant count, the hub's team
//     cards and squads, the public API's entrant list. THOSE filter, here.
//
// SQL-side callers write the same predicate inline
// (`status in ('registered','confirmed')`), which is this repo's existing idiom
// in a dozen usecases; this is for the callers holding rows in TypeScript.
//
// `status` is deliberately REQUIRED, not optional: a caller whose rows do not
// carry a status cannot answer this question, and should fail to compile rather
// than silently classify everyone as departed.
export const FIELD_ENTRANT_STATUSES: readonly string[] = ["registered", "confirmed"];

/** Is this entrant still part of the competing field? */
export function inTheField(entrant: { status: string }): boolean {
  return FIELD_ENTRANT_STATUSES.includes(entrant.status);
}
