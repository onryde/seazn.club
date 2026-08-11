# C4 — z3 stage A: reflow on CP-SAT

Spec of record: `../2026-08-12-z3-retirement-design.md` (stage A).
Depends on C1 merged — reflow inherits the round rule through the wire.

## Goal

"Re-flow unlocked" routes through the placement service: locked rows →
`existing` pins, unlocked → movable `fixtures`. Boards record
`engine: "optimized"`. z3 reflow path unused (deleted in C8, not here).

## File set

Locate the reflow entry point (the z3 call site behind the Re-flow buttons)
and swap its solve call for the placement client. The build request assembly
already exists — this is wiring. Keep the z3 code path compiling and tested
until C8; flip the default/route only.

## Do NOT touch

AI generate/refine/repair rounds (C5), public enums/schemas (C7), z3 package
or its WASM config (C8), POLISH/BUILD paths (already off z3).

## Acceptance

- A reflow invocation asserts the placement client was called and no z3
  module loads (spy at the import boundary) — fails before the switch.
- Bench parity vs z3 reflow on the prod-shaped board: N ≥ 6 per side,
  verifier conflict count never worse, wall respected. Raw runs in PR body.
- Reflow e2e specs green; round-order verifier check green on reflow output
  (the gap named in the round spec closes here — assert it with a test).

## Verify

Suites as usual + bench. Remember the solve wall's TWO env ceilings when
timing.
