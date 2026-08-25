// The size bounds of the capacity-precheck wire body. Two numbers, and
// DELIBERATELY a module with no imports at all.
//
// Three places need them: `CapacityPrecheckInput` (capacity-guard.ts, what
// the route actually parses with), its wire twin `CapacityPrecheck`
// (api-v1/schemas.ts, what the generated spec publishes), and the CLIENT
// hooks (use-capacity-report.ts), which must not send a body they can
// already prove the server will reject.
//
// The obvious home was `capacity-input.ts` — both sides import it already —
// but `schemas.ts` is imported by fourteen `"use client"` components, and
// capacity-input.ts pulls in real engine runtime code (`usableWindows`,
// `resolveSelector`, the tz helpers). Routing the bounds through it would
// have put that chain in reach of every one of those client bundles and left
// the outcome resting on tree-shaking. capacity-input.ts's own header
// records what that class of accident already cost here once (a `"use
// client"` file reaching the scheduling barrel shipped the whole @grpc stack
// into the browser and broke the production build). A leaf with no imports
// cannot drag anything in, whatever the bundler decides.
//
// Why shared constants rather than three literals: two of the three copies
// had already been duplicated by hand, and second-review finding 5 was the
// third copy — the client's — missing entirely. Both panels fall back to
// `flattenCourts(venues).map(c => c.id)` for an unconstrained court
// selection, which is unbounded, so an org with more than
// CAPACITY_PRECHECK_MAX_COURTS non-archived courts (or a division with more
// than CAPACITY_PRECHECK_MAX_FIXTURES movable fixtures) posted a body that
// could only ever 400 — then retried once and 400ed again — on every
// debounced edit, leaving the capacity card stuck reading "check failed"
// with nothing the organiser could do to clear it.
//
// A bound that drifts between the validator and the caller trying to respect
// it is worse than no caller-side bound at all: the client would either go
// quiet for requests the server would have accepted, or keep sending ones it
// rejects. Hence one definition, imported three times.

export const CAPACITY_PRECHECK_MAX_COURTS = 50;
export const CAPACITY_PRECHECK_MAX_FIXTURES = 2000;
