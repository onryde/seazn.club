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

## RE-RUN 2026-09-11 — the walkover is a forfeit now, not a fabricated 1-0

The reports in both leg directories are from a re-run at
`fix/forfeit-carries-its-reason`, NOT from the original B06b run. The pack
changed shape, so the earlier reports described a pack that no longer exists
and were replaced rather than kept beside these.

What changed. Div A match 35 — Ian White w/o Sandro Eric Sosing — used to be
encoded as a single administrative 1-0 set, because this wave recorded (wrongly)
that the product had no route to forfeit an existing fixture. It does:
`core.forfeit` is postable on any fixture through the ordinary scoring door
(`usecases/scoring.ts` applies no event-type allowlist — the sport module's
reducer is the only validator), `append-event.ts:127` derives the `forfeited`
status from it, and it folds to an award carrying NO score.

Proven at the database rather than from the gate, after leg A:

| division | ext_key | status | outcome kind | method | score_events |
|---|---|---|---|---|---|
| `pdc-world-championship-2025` | `se-r0-i19` | **forfeited** | **award** | **walkover** | **2** |
| `pdc-women-s-series-2024-event-1` | `se-r0-i19` | decided | win | regulation | 7 |

Two events on the walkover, `core.start` and `core.forfeit`, neither of them a
score. Pack events fell 1,426 -> 1,425, and that one event is a set nobody threw
leaving a real named player's statistics — leaderboard and career expectations
derive from the streams, so the fiction was flowing into player stats as real.
The second row is Div B's same-keyed fixture: `se-r{round}-i{index}` is unique
per DIVISION, not globally, which is worth knowing before writing that query.

Both legs at this commit: **GATE GREEN, 0 errors, provenance 100% (205/205),
25 oracles all passed with identical verdicts across the legs** (23 with a
subject, 2 NO SUBJECT).

### A trap in the two-leg protocol itself, found here

`reportDir` is keyed by the COMMIT SHA, so running leg B at the same commit
OVERWRITES leg A's `report.json` in place. Nothing warns. The overwrite is
invisible unless you notice the preflight status disagreeing with the leg you
believe you ran — which is exactly how leg A nearly got published here as
`placement: absent`. Copy each leg's report into its evidence directory in the
SAME command that runs it, and check `preflight.placement.status` in the saved
file rather than trusting the directory name.

## The open finding: the solver does not survive a real fixture count

## The open findings: TWO, and only one of them is a defect

Read this before quoting these reports. The optimized path never ran in either
leg — but NOT for one reason, and an earlier revision of this file said it was
one. The corrected reading, with a 30 s control run added 2026-09-11:

| suite | division | fixtures | courts | wall 10 s (the legs below) | wall 30 s (control) | build elapsed @30 s |
|---|---|---|---|---|---|---|
| `_tiny` | d-tiny | 3 | 2 | **ok**, optimized, 6/6 tiers | — | — |
| `_tiny` | d-tiebreak | 3 | 2 | **ok**, optimized, 6/6 tiers | — | — |
| suite 11 | d-worlds | 95 | 1 | `solver_unavailable`, 0/6 | `solver_unavailable`, 0/6 | **849 ms** |
| suite 11 | d-womens | 110 | 16 | `not_searched` — **`too_big`** | `solver_unavailable`, 0/6 | **496 ms** |

### Finding 1 — the admission gate refuses `d-womens`. Tunable, working as designed.

`d-womens` never reached the solver at all at the default wall: it was refused
up front by `canSolveWithin` (`packages/engine/src/scheduling/build.ts:318-340`),
which admits a board only when

    fixtures x grid.slots <= MAX_SOLVE_ENCODING * (wallMs / AUTO_SOLVER_WALL_MS_AT_MEASUREMENT)

`MAX_SOLVE_ENCODING` is 20_000 and the measurement wall is 8_000 ms, so a 10 s
wall buys a 25_000 budget against this division's ~44_000 (110 fixtures on a
~400-slot lattice). At 30 s the budget is 75_000 and the division walks
through — confirmed by the control run, which moved it off `too_big` exactly
as the arithmetic predicts. This is a size guard behaving correctly; the
DEFAULT is simply low for a 110-fixture, 16-board single day.

Anyone re-running this must move **two** walls, not one. They are independent
settings on opposite sides of the wire, and moving only the first silently
buys nothing:

- `PLACEMENT_WALL_SECONDS` (web, `usecases/schedule.ts:2015-2033`, default 10)
  is what feeds `canSolveWithin` — it controls the ADMISSION GATE.
- `PLACEMENT_WALL_SECONDS_MAX` (service, `services/placement/config.py:70`,
  default 10) controls the ACTUAL SOLVE TIME, and `main.py:167` applies it as
  `wall = min(parsed.wall_seconds, self._settings.wall_seconds_max)` — a
  silent CLAMP, not a refusal. Raise only the web side and the service quietly
  holds the solve at 10 s while the gate believes it bought 30.

### Finding 2 — `solver_unavailable` is NOT a timeout. Open, and a defect.

Both divisions still report `solver_unavailable` with the budget expired at
0 of 6 tiers under a wall THREE TIMES larger. The tell is the elapsed column:
the build hands back a board in **849 ms and 496 ms against a 30_000 ms wall**.
It never spends the budget, so the wall is not the constraint and no amount of
raising it will be.

That falsifies the framing an earlier revision of this file published — "the
optimized path does not survive a real fixture count". Volume is Finding 1's
story, not this one. This is an ERROR RESPONSE, returned fast.

Narrowed, not diagnosed: `solver_unavailable` has exactly two sources in
`build.ts` — the catch arm at `:2154`, which writes a `log.warn`, and the
resolved-`ERROR` arm at `:2176`, which writes nothing. The server log for the
control run carries two `buildSchedule: start` lines and NO placement warning,
so the path taken is `:2176` — `solveBuild` RESOLVED, carrying a status that
`STATUS_BY_WIRE_VALUE` could not map (`placement-client.ts:405` falls back to
`"ERROR"`). **Recorded for the owner, not diagnosed here** — it needs solver
knowledge and its own wave, and it now has an entry point rather than a
hypothesis.

### Two consequences for anyone reading these reports

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
