# Prompt 05b: corpus + coverage hardening (Python tests only)

**Why this task exists.** A four-way re-audit of Tasks 01-04 (2026-08-09,
one Opus reviewer per task, mutation-first) found 7 Critical and 22
Important issues. Most were not bad code — they were **tests that could
not fail**. This prompt fixes the measuring instruments. Prompt 05c then
fixes the contract, and it depends on this one landing first: guards
written against the current corpus inherit the blindness that hid these
bugs through four rounds of review.

**Read before writing anything**: the four audit reports in
`.superpowers/sdd/2026-08-07-cpsat-service-build-cutover/`:
`recheck-task1.md`, `recheck-task2.md`, `recheck-task3.md`,
`recheck-task4.md`. They contain the measured evidence for every claim
below. If a claim here looks surprising, the report has the probe.

**Do not touch**: `proto/scheduler.proto`, `src/cp_sat/schema.py`,
`src/cp_sat/main.py`, `src/cp_sat/config.py`, anything under
`packages/engine`. Contract changes are Prompt 05c's job — if you find
yourself editing the wire, stop. `src/cp_sat/model.py` and
`src/cp_sat/objective.py` are **read-mostly**: you may add the missing
day-bucket/None guards named in Step 5, nothing else.

**Files:**
- Modify: `services/cp-sat/bench/cpsat_bench_boards.py`
- Modify: `services/cp-sat/tests/test_model.py`, `services/cp-sat/tests/test_objective.py`
- Create: `services/cp-sat/tests/test_bench_contract.py`

**Verify command** (the ONLY green that counts):
`cd services/cp-sat && venv/bin/python3 -m pytest tests/ -q`
Record the count. Baseline before you start is **86 passed, 0 failed**.
Never judge green from a text summary alone — confirm the collected count
moved the way you expect.

---

- [ ] **Step 1: Move the corpus off epoch zero. Do this FIRST.**

`bench/cpsat_bench_boards.py:42` is `EPOCH_MS = 0`. No test anywhere uses
a timestamp above 1e12. Two measured consequences:

1. **"Unset proto3 field" and "legitimate test timestamp" are the same
   value.** This is why a Critical survived four review rounds: an
   `existing` row with unset `start_at_ms` builds its blocking interval
   at epoch 0, overlaps nothing real, so the pin is silently ignored and
   a movable fixture is placed into the pinned slot — returned OPTIMAL,
   `error` unset.
2. **Three proto mutants survive all 57 proto-aware tests** —
   `Assignment.start_at_ms` and `Tier.value_ms` narrowed int64→int32, and
   a package rename. An epoch-ms narrowing is invisible when every
   timestamp is zero.

Change `EPOCH_MS` to a real epoch millisecond value —
**`1767261600000`** (2026-01-01T10:00:00Z), the value the audits probed
with. Use that exact number so future runs are comparable.

Expect fallout and treat each one as information, not noise: anything
that breaks was asserting on a zero-based accident. The production board
must still solve; if placement counts shift, say so in your report with
before/after numbers rather than adjusting the assertion to match.

Then confirm the narrowing is now visible: an `int64` → `int32` change to
`start_at_ms` in `proto/scheduler.proto` must make a test fail. Verify it,
then **revert the proto** — you are not allowed to leave it changed.

- [ ] **Step 2: Assert Task 02's actual acceptance criterion**

The criterion was "production board OPTIMAL, 35-37 assignments, under
8 s". Nothing asserts it. `test_model.py:48,50` demands only
`tiers_completed >= 1` and **accepts FEASIBLE**; OPTIMAL is asserted only
at a 30 s wall (`test_objective.py:83,118`). Measured at 8 s under load
11: `FEASIBLE, 37 placed, tiers=2, elapsed_ms=8044` — criterion not met,
suite green.

Add a test that asserts the real criterion at the 8 s wall: status
OPTIMAL, 35-37 assignments.

**This test is load-sensitive and that is a known hazard here**, not a
reason to weaken it. Same board measured ~4940 ms/OPTIMAL idle vs
8044 ms/FEASIBLE at load 11. Mark it so a loaded machine cannot silently
turn it green *or* produce a phantom red: capture `os.getloadavg()[0]` in
the failure message, so a red says whether the box was busy. Do not add a
`skipif` on load — a test that skips itself under load is a test that
never runs in CI.

- [ ] **Step 3: Make the tier tests direction-sensitive**

`test_objective.py:213/218` assert `recomputed <= reported` — one-sided,
so a **worse** value satisfies them more easily. `:199` is a consistency
check and direction-blind. Measured: inverting T2 to *maximise* worst
idle gap moves it 132.6M → 2229M ms (16.8× worse) with the suite 14/14
green.

Make T1 (makespan), T2 (idle_gap) and T3 (court_imbalance) each fail when
its optimisation direction is inverted. Two-sided assertions — pin the
value in a band, or assert strict improvement against a known-worse
baseline. Do not add more one-sided `<=` checks.

Prove each one: invert that tier's direction in `objective.py`, confirm
red, revert. Report which test caught which inversion.

**Four runs per tier at most — do not explore.** An earlier attempt at
this step was killed by the 600-second agent watchdog while measuring
what every inversion does across the full board. That exploration is not
required: write the assertion, invert, confirm red, revert. Use a short
wall (2-3 s) while iterating — a 16.8× objective regression is just as
visible at 3 s as at 30 s — and confirm once at the real budget at the
end. The two numbers you would otherwise go measuring are already known
and reliable: inverting T2 moves worst idle gap 132.6M → 2229M ms with
the suite 14/14 green, and T3's current mutants die by wall-clock alone
(green at 22 s, red at 44 s, same mutation).

Two traps, both hit during the audit:
- **A mutation that collides with an existing fixture value
  under-reports.** A mutant hardcoding `8` killed only 2 tests because an
  older test already used `wallSeconds: 8`. Choose values that no other
  test uses.
- **T3's mutants currently die by wall-clock only** — green at 22 s, red
  at 44 s, same mutation. If your new T3 test passes only because
  maximising is slower, it is not a real assertion. It must fail fast and
  for the right reason.

- [ ] **Step 4: Build a pin-contended board**

`model.py:271-275` (the `existing`/pinned-rows constraint) survives
mutation 2/2 — and the probe shows why: **0 pin-contended placements with
or without the constraint**, on zero-epoch and real-epoch boards alike.
Three pins against 8320 slots never collide. This is a blind corpus, not
a missing assertion: adding an assert to the current board cannot help.

Add a board generator whose pins genuinely contend — few enough free
slots that a fixture *wants* the pinned slot — and a test that fails when
the constraint at `model.py:271-275` is deleted. Prove it by deleting the
constraint, confirming red, and reverting.

- [ ] **Step 5: Guard the values that currently produce confident wrong answers**

All three measured, all returning `OPTIMAL` with `error` unset:
- negative `gap_minutes` zeroes court width → **two matches overlapping
  on one court**;
- negative `min_rest_minutes` zeroes the rest interval → **one entrant in
  two simultaneous matches**;
- `grid_slots=[]` places fixtures at `start_at_ms=0` — guarded in
  `schema.py:111` but NOT in the model, so the domain object can still be
  constructed invalid.

Existing guards only test `<= 0` or missing, never negative-after-
arithmetic. Add domain-layer guards in `model.py` (raise `ValueError`) and
a test per case. A domain object must refuse to exist in an invalid state
— guarding at the ACL too is defence in depth, not duplication, and 05c
adds that side.

- [ ] **Step 6: Guard the bench extraction**

`pytest bench/` exits **5** — "no tests ran" — and always would: there is
no `test_*.py` in `bench/` and no `testpaths`. Prompt 02 Step 2b told the
implementer to run exactly that to confirm the extraction survived, so
that verification was vacuous. Nothing in `tests/` imports `cpsat_bench`
at all.

Create `tests/test_bench_contract.py` asserting that `cpsat_bench`
imports, that `production_board()` returns its 7-tuple, and — the point
of the extraction — that the board the service tests against has the
shape it claims: **37 fixtures, 5 courts**, 30/10 min match/gap. Today
`test_model.py`'s docstring claims that and no assertion enforces it, so
a bench experiment silently changes what the service is tested against.

---

**Report** (write to the report path in your dispatch): the count before
and after, every assertion whose value changed because of Step 1 with
before/after numbers, which mutation each new test kills, and anything
you believe is wrong in this brief. Several briefs in this programme have
contained real errors that implementers correctly refused — if you find
one, say so rather than implementing it.

**Output cap**: final message under 15 lines — counts, which mutants each
new test kills, deviations, blockers. No file contents, no diffs.
