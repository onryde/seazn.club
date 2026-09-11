# B06b — suite 11 live-run evidence

Two legs of the same suite at the same commit, per `_RULES.md` §2: once with
the placement service reachable and once with it stopped. Reports are committed
verbatim as the runner wrote them.

**Both legs: GATE GREEN, 0 errors, 25 oracles with identical verdicts** — 23
with a subject, 23 PASS, 0 FAIL, 2 NO SUBJECT. An oracle that passed only with
the solver live would be reading the solver rather than the product; none does.

| | leg A | leg B |
|---|---|---|
| pre-flight placement | live | absent |
| gate | **green** | **green** |
| `d-worlds` certificate | `FEASIBLE` | `FEASIBLE` |
| `d-womens` certificate | `HISTORY_SELF_CONFLICT` | `HISTORY_SELF_CONFLICT` |

## The certificate branches

`d-worlds` certifies **FEASIBLE**: the real timetable satisfies our encoding
and the product placed all 95 fixtures.

`d-womens` certifies **`HISTORY_SELF_CONFLICT`** on one finding — the genuine
same-board overlap in the published Women's Series timetable, which three
independent DartConnect feeds agree on. The pack declares both rows with
`knownConflict`, so the certificate reports the breach without gating. It is
declared **per row**: one undeclared fixture anywhere in a finding and this is
a `PACK_AUTHORING_BUG` exactly as before. Div A declares none and may not —
its timetable is DERIVED from a session-level schedule, so a breach there is
our own arithmetic, which is what the red branch is for and what it caught
earlier in this wave.

## The open finding: the solver does not survive a real fixture count

Read this before quoting these reports. The optimized path never ran in
EITHER leg:

| suite | division | fixtures | courts | `solverStatus` | tiers |
|---|---|---|---|---|---|
| `_tiny` | d-tiny | 3 | 2 | **ok**, optimized | 6/6 |
| `_tiny` | d-tiebreak | 3 | 2 | **ok**, optimized | 6/6 |
| suite 11 | d-worlds | 95 | 1 | `solver_unavailable` | 0/6, budget expired |
| suite 11 | d-womens | 110 | 16 | `solver_unavailable` | 0/6, budget expired |

`_tiny` was run in THIS environment, at this label, with this server and this
placement service, and reached the solver. So this is **not** connectivity and
**not** a broken environment. It is also not "one court is hard": Div B has
sixteen boards and a single day and fails identically.

What distinguishes the failing cases is **fixture count**, and 95 is not an
extreme tournament. The whole bench exists to measure the scheduler, so a
scheduler that falls back to greedy at realistic volumes is the most valuable
thing this programme has produced so far. **Recorded for the owner, not
diagnosed here** — it needs solver knowledge and its own wave.

Two consequences for anyone reading these reports:

- The directories are named `placement-live` / `placement-absent`, never
  `solver-live`. The two legs are indistinguishable at the scheduling layer
  for this suite, so they prove the oracles read the product without proving
  anything about the solver.
- The bench's placement pre-flight probes from the BENCH process, while the
  product SERVER is what actually calls the solver. A green pre-flight says
  the bench can reach it, not that the server can.

## Headline numbers (identical on both legs)

- Oracles: 25 total, 23 with a subject — 23 PASS, 0 FAIL, 2 NO SUBJECT
  (darts has no disciplinary suspensions, and there are no surplus claim
  invites to leave unclaimed — both deliberate)
- Blocking conflicts: 0 · Provenance: 100% real, 205/205 streams
- Claims: 3/3 accepted through the real magic-link flow
- News: 205 drafted, 95 published, the rest proven still draft
- Throughput FLOOR: ~30 events/s single-POST, ~24 events/s batch import.
  A floor, not a measurement — `_RULES.md` §3 assigns the real volume
  measurement to B08, and these are whatever this pack's stream volume
  happened to exercise on one machine under load.
