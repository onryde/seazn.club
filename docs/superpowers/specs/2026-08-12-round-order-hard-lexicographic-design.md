# Round ordering — hard, lexicographic (day, then start)

**Date:** 2026-08-12 · **Status:** approved design, not implemented ·
**Symptom:** a round-robin league board places R4–R8 on day 1, and within one
day R6 at 12:30 sits before R4 at 13:50. Nothing enforces round order today:
the wire has no round field, and `feedDependencies`
(`apps/web/src/server/usecases/schedule.ts:500-511`) builds edges only from
`winner_to_fixture` / `loser_to_fixture`, so a round-robin league generates
zero dependencies.

## Semantics (approved)

> **Amendment, 2026-08-12 (during C1 implementation).** "Same-division" below
> is **understated** and was corrected in implementation: the comparable unit
> is one **round sequence**, scoped `(division, stage, pool)`, not a division.
> `generateRoundRobin` restarts `roundNo` at 1 for every invocation, and one
> division can hold several independent sequences: a `kind: "group"` stage
> calls it once **per pool**, and the product's own entitlements
> (`stages.per_division.max`, with no kind-uniqueness check) permit **several
> league/group stages** in one division. Comparing pool A's round 3 against
> pool B's round 1 — or stage 1's against stage 3's — is exactly as wrong as
> comparing two divisions, and both were hit by real boards during C1, not
> hypothesised. Read every "same-division pair" below as "same-sequence pair",
> keyed `(divisionId, stageId, poolId)`. This is a correction consistent with
> the ruling already stated further down ("rounds are NOT comparable across
> stages"), not a new decision.

For every same-division pair (i, j) with `round_i < round_j` and **at least one
movable side**:

1. **Day order, unconditional:** `day_i ≤ day_j`. Linear — a per-fixture day
   index channeled from the existing `on_day[i][d]` booleans
   (`services/placement/src/placement/model.py:875`); no new reification.
   This is what fixes R8-on-day-1 — within-day-only ordering would leave it
   legal (no same-day pair exists across days).
2. **Start order, same-day conditional:** `same_day(i,j) ⇒ start_i ≤ start_j`.
   Reified; ~700 pair literals at 37 fixtures. Ties are legal — R1 and R2
   simultaneously on two courts is fine; participant-rest already prevents a
   real entrant overlap.

- **Pin–pin pairs exempt.** Two pins out of order are immovable; constraining
  them turns caller data into INFEASIBLE. The verifier mirrors the exemption.
- **Pin–movable enforced.** The solver can act on the movable side. Blast
  radius accepted: a late-round pin on an early day squeezes all earlier
  rounds of that division to ≤ that day — honest INFEASIBLE when the board
  cannot take it, surfaced rather than silent. Escape hatch for deliberate
  disorder (e.g. a showcase match placed early): pin both sides.
- **Absent round ⇒ no constraint.** Knockouts keep dependency edges; a fixture
  carrying both round and dependencies is redundant, not conflicting.
- **Full pair set** (all r < r', not adjacent-only): the conditional start
  half does not chain through a round that has no fixture on that day.
- **Round namespace = round-robin stage only.** Rounds are NOT comparable
  across stages (2026-08-11 ruling — the symptom board mixes League and
  Stepladder finals, each with its own 1-based round sequence).
  `build.ts` attaches `round` **only to round-robin-generated fixtures**
  (`RoundRobinFixture.roundNo`); bracket/stepladder fixtures send no round —
  they are already ordered by `winner_to`/`loser_to` dependency edges. A
  cross-stage pair therefore has a round-less side and is unconstrained by
  construction. Guard: if a request ever carries round-bearing fixtures from
  more than one round sequence in one division, build.ts must strip rounds
  for that division rather than emit a false ordering (assert + test).

### Precedent tension, accepted knowingly

C4 ruled that immovable input must not be able to make a board INFEASIBLE
(clamp instead). Pin–movable enforcement here can — a late-round pin on an
early day can squeeze a division into an unsolvable window. Owner accepted
the honest INFEASIBLE on 2026-08-12 (surfaced beats silent disorder); the
escape hatch for deliberate disorder is pinning both sides. The 2026-08-11
rejection of "round N entirely before N+1" stands — this design's day-level
half still allows adjacent rounds to share a day and fill idle courts
within it, which is what that rejection protected.

## Wire

- `Fixture`: `optional uint32 round = 3` (`proto/scheduler.proto:30-42`;
  fields 1–2 used today, 3 free — confirmed).
- `PinnedRow`: `optional uint32 round` at its next free field number —
  pin–movable pairs need the pin's round.
- `packages/engine/src/scheduling/build.ts:1649-1653` forwards `f.roundNo`
  (already in scope on `SchedulableFixture`, `calendar.ts:70`);
  `placement-client.ts:50` input type and `:283-286` encoding gain the field.
- Round data already exists end to end off the wire: DB `round_no`
  (V263 orders by it), `FixtureLite.round_no` (`schedule.ts:392`),
  `RoundRobinFixture.roundNo` set at generation (`roundrobin.ts:41`).

## Solver (Python)

Reuse `on_day` (model.py:875). Build one day-index IntVar per constrained
fixture (channelled `sum(d · on_day[i][d])`), then per pair: the linear day
inequality, a reified same-day equality, and the conditional start inequality.
Pins contribute constants (their day and start are fixed), not variables.

## Verifier parity (the recurring placer/verifier fork)

(Per the amendment above, the verifier's grouping key is
`${divisionId}|${stageId}|${poolId}`, and the wire-side contamination guards in
`build.ts` strip rounds for a division whose round-bearing free fixtures span
more than one `(stage, pool)`. `build.ts`'s own encoder-vs-verifier self-check
must carry `stageId` too — it reads `roundNo` off the unstripped fixture map,
so omitting it re-collapses the sequences after the wire correctly separated
them.)

The TS verifier operates on `Assignment` objects, which carry no round today.
`toAssignment` (`schedule.ts:484-495`) gains `roundNo` and a movable flag from
`FixtureLite` (round_no already queried at :392/:438/:448). The verifier
enforces the **same pair set and the same two `≤` comparisons** — including the
pin–pin exemption. "Day" is the org-tz calendar date of the start, matching
how the model derives day ids from slots (model.py:842-870); this
day-definition is the one place the two sides could silently fork, so the
implementation must assert one shared derivation, and a test must hold the
same board against both sides.

## Superseded ruling

`packages/engine/src/scheduling/constraints.ts:39-43` rules that round numbers
are display labels and must never appear in rule config. That ruling is
narrowed, not reversed: round stays **out** of `FixtureSelector` (not a
user-facing rule target), but round **is** now a scheduling ordering input on
the wire. The comment must be rewritten in the same PR, or a future session
will re-derive "display only" and rip the field back out.

## Performance gate

Bench the prod-shaped board (37 fixtures, OPTIMAL ~2.5 s baseline) with N ≥ 6
runs per side (nondeterministic solver — single runs are coin flips). Solve
wall and `tiers_completed` unchanged. No new env flag; add one only if the
bench regresses.

## Tests (each fails without its change)

- Solver: two-round division forced onto one day → order enforced; cross-day
  disorder (R2 on an earlier day than R1) rejected; pin–movable pair enforced;
  pin–pin disorder tolerated; round-less fixtures unconstrained.
- Stage scoping: a league + stepladder board in one division emits rounds for
  the round-robin fixtures only; a hand-built mixed-sequence request strips
  rounds for that division (the guard fires).
- Verifier: hand-built out-of-order board flagged; pin–pin disorder not
  flagged; same board green/red identically on solver and verifier sides.
- Greedy: regression test that the greedy/calendar path emits ascending
  `roundNo` per division-day (claimed by `calendar.ts:70`; the screenshot
  board came from the placement path, so the claim is untested — test it,
  don't trust it).
- Wire: request round-trip carries `round`; absent field decodes as
  undefined, not 0 (0 vs unset matters — use presence, `optional`).

## Out of scope

- Round as a user-facing rule target (`FixtureSelector`) — explicitly not.
- z3 reflow / AI repair awareness of round order: those paths do not receive
  the constraint and can emit violating boards; the verifier now catches them.
  Closing that gap is the z3-retirement programme's concern (separate spec).
- Cross-division ordering — none.
