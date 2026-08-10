# Prompt 05c: contract + boundary hardening

**Depends on 05b landing first.** 05b moves the test corpus off epoch
zero. Until that is in, a guard you add here cannot be proven to fail
correctly — "unset" and "legitimate test value" are the same number, and
that is precisely how these bugs survived four rounds of review.

**Why this task exists.** A four-way re-audit of Tasks 01-04 found 7
Critical issues. All of them are **one defect wearing different field
names**: proto3 cannot express "absent", and nothing validates
referential integrity. An unset field arrives as `0`/`""`/`[]`, the
constraint it should drive silently evaporates, and the service returns
**`OPTIMAL` with `error` unset**. Not a crash — a confident wrong answer.

Measured, same board, `min_rest=240`/`cap=1`: `division_id="d1"` → 1
placed; `division_id=""` → **4 placed, OPTIMAL**. 5/5 deterministic.

Two independent auditors converged on the same fix, and it is the one to
implement: **explicit presence plus ONE referential-integrity pass**, not
seven separate field guards.

**Read before writing anything**: `recheck-task1.md` and `recheck-task4.md`
in `.superpowers/sdd/2026-08-07-cpsat-service-build-cutover/` — they carry
the probes for every claim here. Also `_RULES.md` §2, §3 and §4.

**Do not touch**: `packages/engine/src/scheduling/placement-client.ts` beyond
what regeneration forces, and nothing else under `packages/engine`.
Wiring `build.ts` is Prompt 06.

**Files:**
- Modify: `proto/scheduler.proto`
- Modify: `services/placement/src/placement/schema.py`, `src/placement/model.py`, `src/placement/main.py`
- Modify: `services/placement/tests/test_schema.py`, `tests/test_server.py`, `tests/test_model.py`
- Regenerate: Python stubs AND `packages/engine/src/scheduling/generated/scheduler.ts`

**Verify**: `cd services/placement && venv/bin/python3 -m pytest tests/ -q`
plus `cd packages/engine && npx vitest run src/scheduling/placement-client.test.ts`.
Both must be green, and the proto drift gate must pass in both languages.

---

- [ ] **Step 1: Give the ambiguous fields explicit presence**

Mark as proto3 `optional` (which generates real `HasField` presence) every
scalar where "unset" and "legitimately zero" are today indistinguishable
AND the zero is dangerous. From the audits, at minimum:
`Assignment.start_at_ms`, `Fixture.division_id`,
`BuildConstraints.match_minutes`, `gap_minutes`, the rest and day-cap rule
values, and `wall_seconds`.

`optional` does not exist for `repeated` fields — `Fixture.entrant_ids`
and `tiers` cannot express absence and must be handled by validation in
Step 2 instead. Do not fake it with a wrapper message.

- [ ] **Step 2: One referential-integrity pass at the ACL**

In `schema.py` — the anti-corruption layer, and the only correct home for
this (`_RULES.md` §4). One pass, before any domain object exists. Every
id a request mentions must resolve to something the request declares:

- `dependencies[].before/after` → must name a fixture in `fixtures`.
- `existing[].court` → must name a court in `courts`. Today
  `model.py:272` skips an unknown court **wordlessly** and the pin
  vanishes.
- `existing[].start_at_ms` → must be present and positive. Unset builds a
  blocking interval at epoch 0, which overlaps nothing real, so a movable
  fixture is placed **into the pinned slot**.
- rest / day-cap rules → must name a division that some fixture actually
  has. A rule for a division nobody is in is silently inert today.
- `fixtures[].entrant_ids` → must be non-empty. Empty means the fixture
  joins no participant group, so rest and every T2 gap term skip it.
  Measured: two fixtures sharing a player placed **concurrently**,
  OPTIMAL.
- `fixtures[].division_id` → must be non-empty (see the headline probe).
- `tiers` → an empty sequence currently yields `UNKNOWN`/0/0, **byte-
  identical to an infeasible board**. Decide explicitly: reject it, or
  default it to the full chain. Do not leave the two outcomes
  indistinguishable.

Also reject negatives, which the current `<= 0`-style guards miss because
they only fire on zero or missing: negative `gap_minutes` zeroes court
width → **two matches overlapping on one court**; negative
`min_rest_minutes` zeroes the rest interval → **one entrant in two
simultaneous matches**. Both measured, both returning `OPTIMAL`.

Every rejection raises the existing `InvalidRequestError` and surfaces as
a populated `SolveError`. A rejected request must never return a
success-shaped response.

- [ ] **Step 3: Stop day caps bucketing on UTC**

`model.py:109-112` buckets fixtures into calendar days by UTC. The deploy
region is `lhr`; Europe/London is UTC+1 for roughly seven months a year,
so caps bind against the wrong day most of the year. This is the same
class as this repo's `settings.tz`-vs-`settings.orgTz` bug (#448).

**Design ruling — the solver stays timezone-agnostic.** `_RULES.md` §1
puts "timezones-as-policy" explicitly *outside* this bounded context. So
do NOT send a timezone name and do NOT put `zoneinfo` in the solver. Add
a **pre-computed day index** to the contract: the caller, which already
knows the org's zone, resolves each slot to its local calendar day and
sends that integer. The solver groups by the integer and never reasons
about time zones at all.

Add `day_index` to `Slot`, and to `Assignment` so `existing` rows can be
day-capped too. Make `model.py` group by it rather than deriving days
from `start_at_ms`.

Note for whoever writes Prompt 06: computing `day_index` from the org
zone becomes the caller's obligation, and getting it wrong reintroduces
#448 one layer up. It needs its own test there.

- [ ] **Step 4: Take the health check off the solve thread pool**

`main.py:123-125` registers the health servicer on the same bounded
`ThreadPoolExecutor` that runs solves. Verified over a real port: with
`max_workers` solves in flight, `Health/Check` returns
`DEADLINE_EXCEEDED` — at both 1 worker and the default 4. Defaults allow
a roughly 10 s liveness blackout, so **Fly's health probe kills the
machine mid-solve.**

Worse, `main.py:12-16` currently documents the opposite — it claims this
topology avoids starving the health check. Fix the comment as well as the
code; a comment asserting a bug is absent is how the bug survives the
next review.

Give the health servicer its own executor, or otherwise guarantee it
cannot be starved by in-flight solves. Add a test that fails without the
fix. There is no placement `fly.toml` yet, so this is free now and expensive
after Prompt 08.

- [ ] **Step 5: Fix the ubiquitous-language and unit violations**

Both break `_RULES.md` §3, which requires one concept to keep one word
across the wire:

- Python `court_imbalance` vs TypeScript `imbalance`. A genuine word
  mismatch, not a case convention. Align them.
- `placed` is a **count of fixtures** transported in a field named
  `value_ms`. Nothing is deployed yet, so rename the field to something
  unit-neutral rather than documenting the lie.

- [ ] **Step 6: Regenerate BOTH stub sets and prove they match**

The Python drift gate regenerates into a temp dir and byte-compares
against the tracked stubs; `packages/engine` has `npm run gen:proto`,
which reproduces byte-identically. Run both. A contract change that
updates only one side is the failure this gate exists to catch.

---

**Report**: which fields you gave explicit presence and why each, the
`tiers=()` ruling you chose, before/after probes for the headline
`division_id` case, and the health-check measurement. Flag anything in
this brief you believe is wrong — several briefs in this programme have
contained real errors that implementers correctly refused.

**Output cap**: final message under 15 lines — counts, rulings taken,
deviations, blockers. No file contents, no diffs.
