# B06b — suite 11 live-run evidence

Two legs of the same suite, per `_RULES.md` §2: once with the placement
service reachable and once with it stopped. Reports are committed verbatim as
the runner wrote them.

## What the two legs prove, and what they do not

**They prove the oracles read the PRODUCT, not the solver.** All 25 oracles
return identical verdicts across both legs — 23 with a subject, 23 PASS, 0
FAIL, 2 NO SUBJECT. An oracle that passed only with the solver live would be
reading the solver.

**They do NOT prove the solver ran.** Read this before quoting these reports:

| leg | pre-flight placement | `solverStatus` | engine used | tiers |
|---|---|---|---|---|
| A | **live** | `solver_unavailable` | greedy | 0/6, `budgetExpired: true` |
| B | **absent** | `solver_unavailable` | greedy | 0/6, `budgetExpired: true` |

The optimized path never reached the solver in EITHER leg, so the two legs are
indistinguishable at the scheduling layer for this suite. The directories are
named `placement-live` / `placement-absent` rather than `solver-live` for
exactly that reason.

This is not a broken environment: B06a's `_tiny` run reached the solver on
this same machine and recipe (`solverStatus: ok`, two divisions solved). It is
specific to THIS board — 95 fixtures, one court, 16 playing days, the hardest
packing case in the roster by design — where the budget expires before a
single tier of six completes. **Recorded as an open product finding for the
owner, not diagnosed here.**

Note also that the bench's placement pre-flight probes from the BENCH process,
while the PRODUCT SERVER is what actually calls the solver. A green pre-flight
says the bench can reach it, not that the server can.

## The one red

`d-womens` certifies `PACK_AUTHORING_BUG` with exactly ONE finding: a genuine
same-board overlap in the published timetable (board 2, R3-2 against R4-2),
which three independent DartConnect feeds agree on and the pack declares in
`meta.adaptations`. The certificate is working — it found the real clash and
nothing else. What is wrong is the BRANCH: "the pack encoded constraints
stricter than reality" is false here, because the pack matches reality exactly
and reality self-conflicts. Under the checker's fixed-width occupancy
(`checker.ts:42`, ruling R12) any `matchMinutes` above 9 reports the clash and
anything at or below 9 is shorter than every real match, so no encoding makes
it clean without making the check vacuous.

`d-worlds` certifies **FEASIBLE**: the real timetable satisfies our encoding
and the product placed all 95 fixtures.

## Headline numbers (identical on both legs)

- Oracles: 25 total, 23 with a subject — 23 PASS, 0 FAIL, 2 NO SUBJECT
  (darts has no disciplinary suspensions, and there are no surplus claim
  invites to leave unclaimed — both deliberate)
- Blocking conflicts: 0 · Provenance: 100% real, 205/205 streams
- Claims: 3/3 accepted through the real magic-link flow
- News: 205 drafted, 95 published, the rest proven still draft
- Throughput FLOOR: ~29.5 events/s single-POST, ~24.3 events/s batch import.
  A floor, not a measurement — `_RULES.md` §3 assigns the real volume
  measurement to B08, and these numbers are whatever this pack's stream volume
  happened to exercise on one machine under load.
