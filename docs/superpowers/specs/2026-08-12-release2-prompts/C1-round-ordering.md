# C1 — hard lexicographic round ordering

Spec of record: `../2026-08-12-round-order-hard-lexicographic-design.md`.
Every semantic decision is already made there — including the ones you will
be tempted to re-derive (pin handling, stage scoping, ≤ vs <). Do not.

## Goal

Same-division, round-bearing pairs with ≥1 movable side obey
`day_i ≤ day_j` (unconditional) and `same_day ⇒ start_i ≤ start_j`.
Round-robin fixtures ONLY carry rounds; brackets keep dependency edges.

## File set

- `proto/scheduler.proto` — `Fixture`: `optional uint32 round = 3`;
  `PinnedRow`: `optional uint32 round` at its next free number. Additive
  only. (C0 already reserved field 10 — rebase on it.)
- `packages/engine/src/scheduling/build.ts` (~:1649-1653) +
  `placement-client.ts` (~:50, ~:277-286) — forward `roundNo`, round-robin
  fixtures only, with the mixed-sequence guard (strip + assert).
- `services/placement/src/placement/model.py` — day-index channelling from
  `on_day` (~:875), pair constraints. Pins are constants.
- `apps/web/src/server/usecases/schedule.ts` — `toAssignment` (~:484-495)
  gains `roundNo` + movable flag.
- TS verifier — same pair set, same two ≤ checks, same org-tz day
  derivation. One shared day-derivation helper, not two copies.
- `packages/engine/src/scheduling/constraints.ts` (~:39-43) — rewrite the
  "display labels" ruling comment (narrowed, not reversed).

## Do NOT touch

`FixtureSelector` (round stays out of user-facing rule config), cross-division
ordering, objective rungs (C2 owns those), z3 paths.

## Acceptance

- Solver tests: same-day order enforced; cross-day disorder rejected;
  pin–movable enforced; pin–pin tolerated; round-less unconstrained;
  mixed-sequence guard fires.
- Verifier tests: same board red/green identically on both sides
  (placer/verifier parity is THE trap — prove it, don't assert it).
- Greedy regression: calendar path ascending `roundNo` per division-day
  (claim at `calendar.ts:70` is untested — test it).
- Wire: presence semantics (unset ≠ 0).
- Bench: prod-shaped 37-fixture board, N ≥ 6 per side, wall respected,
  `tiers_completed` not regressed. Paste all runs.

## Verify

Suites as C0. Bench numbers raw in PR body.
