# Release 2 (scheduling) — session index

**One session per row.** Read `_RULES.md`, then this file, then the session's
prompt file. This file is the compaction anchor: every ruling, false premise,
and status change gets written here **as it happens**.

> **Naming collision warning:** `C#` here numbers *release-2* sessions. It is
> NOT the #21 contract programme's C-task numbering (C1/C4/C6) that
> `services/placement/src/placement/model.py` docstrings and
> `proto/scheduler.proto` comments cite. When a code comment says "task C2/C4/C6",
> it means the #21 programme, never this index.

Specs of record (all in `docs/superpowers/specs/`):

| Spec | File |
|---|---|
| division_rules retirement | `2026-08-12-division-rules-retirement-design.md` |
| round ordering (lexicographic) | `2026-08-12-round-order-hard-lexicographic-design.md` |
| T1 `day_start` rung | `2026-08-12-t1-day-start-rung-design.md` |
| z3 retirement (stages A–E) | `2026-08-12-z3-retirement-design.md` |
| conflict details (names, not UUIDs) | `2026-08-12-conflict-detail-names-design.md` |

## Order

Main chain sequential (shared files: `proto/scheduler.proto`, `build.ts`,
`model.py`, `schedule.ts`). C3 is a near-disjoint lane but overlaps
`schedule.ts` with C1 — run it strictly before or after C1, never alongside.
C6 (prose) is safe whenever.

| Session | Prompt file | Spec | Depends on | Status |
|---|---|---|---|---|
| C0 | `C0-division-rules-retirement.md` | division_rules | — | **MERGED** #537 → `f0f83939` |
| C1 | `C1-round-ordering.md` | round ordering | C0 (same proto/build.ts region) | **MERGED** #546 → `78db2f1f` |
| C2 | `C2-day-start-rung.md` | day_start | C1 (model.py overlap; rebase either way) | **MERGED** #555 → `40331cc2`, follow-up #557 → `4dc38a0e`. Shipped #512's two rungs too. **Leaves 3 open defects — see the C2 entries below before starting C3.** |
| C3 | `C3-conflict-detail-names.md` | conflict details | not concurrent with C1 (schedule.ts) | **MERGED** #567 → `ccab1356`. Family was 25 kinds, not 4; `conflictKey` and the AI repair round were both in the blast radius |
| C4 | `C4-z3-reflow-cpsat.md` | z3 stage A | C1 (reflow inherits round rule) | **PR open** (this session) — see status log. Found two real, out-of-scope `buildSchedule` gaps shared with BUILD/POLISH (a frozen-feeder dependency gap, a bracket/TBD-fixture wall) — neither fixed here. |
| C5 | `C5-z3-ai-repair-cpsat.md` | z3 stage B | C4 | **PARKED, PR #576 draft** — owner ruling 2026-08-16: land C9 first. CI found a real bracket/frozen-feeder repair-capability regression the session's own (vacuous — see status log) local smoke run could not see. See status log. |
| C6 | `C6-z3-prose-identifiers.md` | z3 stage C | ~~anytime~~ → **after C4+C5** | ~~NO-OP today~~ → **PR #588 open**, real work once A+B landed — 15 false claims, one of them an actionable instruction naming a deleted script. Ships the ledger C8's acceptance asks for as a test. See status log. |
| C7 | `C7-z3-public-contract.md` | z3 stage D | C4+**C9** (not C5) deployed to **stg** — prod does not exist | **PR open** — see status log. NO migration was owed: the values are response-only telemetry. Also retired `z3_unavailable`, which the brief never assigned to a stage and without which its own "zero z3 in openapi" acceptance is unreachable. |
| C8 | `C8-z3-delete-solver.md` | z3 stage E | C7 (merged `298da0af`, stg green) | **PR open** — see status log. The brief's file set was an UNDERCOUNT: it listed what mentions z3, not what stops compiling once that is gone. Three coverage losses recorded rather than papered over. |
| C9 | `C9-decomposed-repair-cpsat.md` | z3 retirement gap closure | branches off `origin/main` directly, includes C5's commits (C5 targets a different base — see status log) | **PR #583 open**, targets `main` — see status log. Density regression CLOSED, general frozen-feeder dependency gap CLOSED. Bracket/TBD-sibling gap (what parked C5) NOT closed — new finding, contradicts this brief's own "REFUTED" note. #576 (C5) should close as superseded once #583 merges. |

### C1 — round ordering (2026-08-12/13, DONE)

Branch `feat/c1-round-ordering`, 30 commits, rebased onto `03c3c2d0`.

**Prompt/spec drift found by scout re-pin (7 of 11 citations exact, 4 wrong):**
the prompt's "C0 already reserved field 10" reads as if on `Fixture`, but the
`reserved 10` is on `SolveBuildRequest`; `build.ts`'s emission is 1627-1633,
not 1649-1653; `model.py`'s `on_day` is 863-871 and its day derivation
824-837, not 875/842-870; `roundrobin.ts`'s `roundNo` is computed at :103,
not :41. The spec never named the TS verifier — it is `validateAssignments`
(`calendar.ts`), with `Assignment` at :79-88.

**Ruling — the spec's "same-division pair" was UNDERSTATED.** The comparable
unit is one round SEQUENCE, keyed `(division, stage, pool)`. A `group` stage
calls `generateRoundRobin` once per POOL, and entitlements permit several
league/group STAGES per division; each restarts at round 1. Both cases were
hit by real boards, not hypothesised. Spec amended in this PR.

**Six enforcement seams, five of them found only because someone swept.** The
prompt named one. Round order is now enforced at: `autoSchedule` preview,
`applySchedule` write gate, `validateScheduleIn` (publish / `startDivision` /
live conflict report), `moveFixture` + `applySchedule`'s partial path (the
delta gate compared ONE fixture against `existing`, so a one-element set could
never contain a pair — structural, not a missing parameter), the AI planning
path (`SchedulePack`/`CompetitionPack` now carry stage identity), and joint
multi-division apply.

**Ruling — joint apply gets `tz` WITHOUT the `rules` bundle.** `verifyConfigFor`
withholds typed-rule inputs from the apply path deliberately (#399: apply-time
blocking is W4). `tz` is merely bundled with them. It now takes an independent
`tz?: string` 4th param, mirroring `window`. `AI_VERIFY_POLICY.hard = false`
structurally keeps `effectiveHard` at `[]` for any caller omitting `rules`, so
#399 cannot leak through the new seam.

**Accepted, unchanged:** z3 REFLOW/AI-repair can still emit round-violating
boards — the verifier catches them and REFLOW degrades gracefully instead of
500ing (`RepairVerificationError` is caught). Closing it is C4/C5's job.
Owner ruled 2026-08-13 that C1 ships without waiting (greenfield, no prod
users). z3 benchmarks ruled out of scope entirely.

**Lesson for C2–C8:** two of the six seams were missed by trusting an
inherited call-site list (a doc comment, then a report). Sweep with
`git grep -n "toAssignment("` — never inherit an enumeration.

### C6 — z3 prose (2026-08-13): NO-OP today, ordering was wrong

Classified every z3 reference (~1554 hits, ~140 files): ~70 are C7's
persisted/public values, ~835 are C8's solver/tests/WASM/env, ~649 are
history. **Zero are C6's.** Stage C renames prose that says z3 "where the code
no longer means z3", but REFLOW and AI repair still genuinely call z3, so every
surviving identifier is accurate; `build.ts:300-306` already carries an earlier
session's comment pre-empting this rename. C6 must run AFTER C4+C5.
`content/help/**` has zero z3 hits and never owed an edit. Finding recorded on
branch `feat/c6-z3-prose` (`b5ade286`), parked.

### C6 — z3 prose, RUN FOR REAL (2026-08-16/17)

Branch `feat/c6-z3-prose-identifiers`, worktree `.claude/worktrees/c6-z3-prose`,
off `8b85ab39`. The 2026-08-13 entry above was right about its own day and is
now spent: C4 (`edd358af`) and C9 (`8b85ab39`, carrying C5) moved the last
production caller off z3, so the prose that says otherwise became false the
moment they merged. **The diff is comment-only** — `git diff main HEAD` outside
the new test file has ZERO changed lines that are not comments, which is the
whole behavioural argument and is worth re-running rather than re-deriving.

**Fifteen false claims, and the count is the finding.** The earlier sweep read
the hits as accurate because it asked "does z3 still exist" (yes) rather than
"does THIS sentence describe what runs" (no). Six of the fifteen were one
sentence copy-pasted across AI test files — a shared-source defect, so a
per-file judgement call would have caught one and left five.

**Two were actionable, not merely wrong.** `build.ts`'s R18 gate told a future
engineer to re-measure by running `scripts/bench-build.ts` and reading the row
that "still reports `engine: \"z3\"`". Neither half is reachable: BUILD reports
`optimized`, and that script was DELETED with the z3 tier encoder in
`82553ec3`. `schedule.ts:1504` cites the same dead script. Both now say so
rather than sending someone hunting. Whoever moves `MAX_SOLVE_ENCODING` or
`AUTO_SOLVER_WALL_MS` next has to rebuild the sweep against CP-SAT first
(**issue #589**, which also records that the gate's PREMISE inverted — z3 never
searched past the budget, CP-SAT is anytime and returns an incumbent, so the
gate can now refuse a board the service would have improved) —
that is a real gap this task found and did not close.

**A vacuous assertion, found by sweeping rather than by reading.**
`schedule-capacity-guard.test.ts` asserts `z3LoadCount()` is unchanged as proof
that a refused REFLOW never reached the solver. Since C4 that counter cannot
move on this path whatever happens, so the assertion cannot fail. Left in place
(it dies with `z3LoadCount` in C8) but the comment now says the 422 above it is
what carries the proof, and names the placement-client spy that would restore
the real fact.

**`z3-auto-schedule.spec.ts` is now `auto-schedule.spec.ts`**, with its fourteen
cross-references in sibling specs. Config-inert, verified rather than assumed:
it is selected by the catch-all `parallel` project (`testIgnore`, not
`testMatch`), appears in no `SERIAL_SPECS` entry and in no workflow file, and
`playwright test --list --project=parallel` still collects its 5 tests under the
new name, 0 under the old.

**The proto and its generated stubs were changed by REGENERATING.**
`proto/scheduler.proto`'s comments propagate verbatim into
`generated/scheduler.ts`, so a hand-edit of one silently forks the pair.
`npm run gen:proto --workspace packages/engine` produced a one-line diff and
nothing else — which is also the evidence that the pinned `protoc`
devDependency is deterministic, the property `gen-proto.ts`'s own header argues
for at length.

**What C7 and C8 inherit is now a TEST, not a PR comment.**
`scripts/__tests__/z3-retirement-drift.test.ts` (runs in CI at `ci.yml:429`,
the repo-root scripts step) pins two things: each retired claim, anchored to
the file it lived in, and the exact literal list of files in the live trees
that still mention z3, grouped `OWNED_BY_C7` / `OWNED_BY_C8` / `ACCURATE_TODAY`.
Both directions fail — an unlisted file that gains a z3 mention, and a listed
file that loses its last one — so C7/C8 cannot shrink the code and leave the
ledger overstating what it covers. Measured against `main`'s content: **16 of
19 assertions red**, the 3 green ones being the non-vacuity scan, the positive
control and the disjointness check, none of which depend on the fix.

**Anchoring the claims to files was not tidiness.** The first draft matched the
phrases repo-wide and flagged four LEGITIMATE uses — `build.ts:2112` and
`smoke.ts:8391` contrast the z3 path in the past tense, `repair-cpsat-harness`
really does bridge the z3 repair solver, and `test_model.py:1150` cites the
same "a board z3 proves INFEASIBLE" sentence as its own case's rationale. A
prose gate that cannot tell "z3 did this" from "z3 does this" is a nuisance.

**Not C6's, decided and recorded rather than left ambiguous:** the seeded
competition/player names prefixed `Z3 ` in `auto-schedule.spec.ts` and
`smoke.ts` are test DATA, not prose or identifiers, so they stay (the ledger
lists both files); `services/placement/bench/placement_repair_bench.py`'s
"repair.ts encodes in z3" is TRUE — `repair.ts` still does — and goes when C8
deletes it; everything under `docs/**`, `.claude/**` and the 60 `design/**`
PNGs (where `git grep -a` finds "z3" inside compressed bytes) is history or
noise.

## Decisions already made (do not re-open)

- Round order: **lexicographic** (day ≤, then same-day start ≤); pin–pin
  exempt; pin–movable enforced (honest INFEASIBLE accepted vs C4 clamp
  precedent); **round-robin fixtures only** carry rounds — brackets rely on
  dependency edges.
- `day_start` = Σ(day_lo − day_open) over used days, chain position after
  `day_span`; TIER_COUNT → 6.
- z3: all four jobs approved; stored rows **rewrite** `z3|z3+lns → optimized`
  (UI copy already identical); repair enum end state `none|optimized|llm`.
- Conflict details: **structured** (`{kind, ids…}`), localized client-side in
  all 4 dicts; legacy `detail` string derived at API layer, deprecated.
- division_rules: one PR, full kill; both deploy orders proven safe; prod
  placement already on the rule_groups contract (owner-confirmed 2026-08-12).

## Status log

(append here as sessions run)

### C0 — division_rules retirement (started 2026-08-12)

Branch `feat/c0-division-rules-retirement`, worktree
`.claude/worktrees/c0-division-rules`. Re-pinned every `file:line` in the C0
prompt against `989e0ba8` before dispatch; two of them had drifted and one
premise was wrong:

- **False premise (prompt + spec):** "`build.ts` — remove emission". `build.ts`
  never names field 10. The emission is
  `placement-client.ts:254 toDivisionRules()`, fed from
  `SolveBuildInput.constraints.restByDivision` / `dayCapByDivision`. `build.ts`
  only *populates those two constraint fields* (1707-1714) and carries stale
  doc prose.
- **Drift:** `build.ts` doc-comment block is **1134-1150** (prompt said
  1131-1144) and the emission-site comment is **1703-1705** (prompt said 1700).
  A third stale note lives at **1625**. Proto `DivisionRule` is **165-176**
  with its lead comment from **159** (prompt said 159-174), and stale
  `division_rules` prose also sits at **127-129** and **162**, which neither
  the prompt nor the spec listed.

**Ruling (orchestrator, in scope):** `restByDivision` / `dayCapByDivision` on
`SolveBuildInput["constraints"]` exist *only* to feed field 10, so they die
with it — along with their division-index registration
(`placement-client.ts:547-553`) and the `dayCapByDivision > 0` validation
(`637-641`). The prompt's "do not touch `BuildConstraints`" reads as the
**proto** message (`match_minutes` / `gap_minutes`), not this TS shape; the
prompt separately authorises "the wire type/encoding in `placement-client.ts`
if it names the field", and it does. `restByDivisionForWire` and
`dayCapsByDivision()` stay as *internal* values — `restByDivisionForWire` still
feeds `buildRuleGroups`.

Open question carried into review: dropping the index registration can shrink
`division_count` on a board where a division is named by a rest/cap rule but by
no fixture. `division_count` is a declared bound only, so that is a wire change
without a behavior change — but it must be stated, not hidden.

**Implementation complete (2026-08-12).** Resolution of the open question above:
`division_count` CAN shrink for a board where a division was named only by a
rest/cap rule and by no fixture — that source is gone (division_rules is the
only field that ever fed it). No real caller hits this: `build.ts` always
derives `SolveBuildInput.constraints` from the same fixtures it also sends, so
every division a rest/cap rule ever named was already named by a fixture too.
Wire change, not a behavior change, as anticipated.

Additional blast radius beyond the file set the prompt named, all necessary
fallout from the change it authorized (detailed in the implementer's own
report): `services/placement/tests/test_proto_compiles.py` (drift gate — the
generated stubs would not even compile without updating the field contract;
added the required reserved-field test here too), `_board_positional.py`
(`to_proto_request` constructed `scheduler_pb2.DivisionRule`, which no longer
exists — converted its rest/cap translation to `rule_groups`, added a new
`rule_groups_for` helper), `test_schema.py`/`test_server.py` (same — DivisionRule
no longer exists; deleted 10 division_rules-exclusive test IDs, confirmed
equivalent rule_groups-path coverage already existed for each), and
`test_model.py` (deleted 6 more test IDs whose premise was the retired dict
keys; converted 4 tests in the "SEVENTH fold" section from a division-baseline
framing to a pure rule_groups one; **found and fixed two real regressions** —
`test_the_day_cap_groups_by_the_callers_day_index_not_by_utc` and
`test_two_day_indices_over_one_utc_day_give_two_buckets` were still sourcing
their day cap from the now-dead `constraints.day_cap_by_division`, and
`test_production_board_meets_the_stated_acceptance_criterion` silently became
an uncapped, harder-to-optimize board once `_production_board()` stopped
carrying rule_groups — fixed by making `_production_board()` derive and
propagate `rule_groups` via a new `rule_groups_for` helper in
`_board_positional.py`, threaded through every solve-invoking caller). Also
added, per an owner requirement folded in mid-task: structured logging
(`schema.py`'s `_log_legacy_wire_fields`) for a deploy-window request still
carrying field 10, plus its own test pair.

Verified: engine vitest 3516/3538 passed, 0 failed, 22 pre-existing pending
(z3/WASM-gated, unrelated); `test:coverage` green, `src/core/**` at 100%
lines; engine lint and tsc both clean.

**False premise, caught by review, not by the implementer:** the first pass
reported placement pytest as 213/220 with 7 failures in `test_objective.py`
dismissed as "pre-existing load-sensitivity flakes." Wrong — the coordinator
re-ran it twice (once on a quiet box, byte-identical results, ~43s each) and
showed the numbers were a real, deterministic defect: `T1_PROVED_MAKESPAN_MS`
expected `1_557_600_000` (~18 days, the 1/day cap binding), got `26_400_000`
(~7.3 hours) — a 59x compression no slow machine produces, a missing day cap
does exactly. `test_objective.py`'s `_production_board()`/`_model_for()`/
`_model_without_pins()` were the SAME class of bug already found and fixed in
`test_model.py` (see above) but never applied to this sibling file — `grep -c
rule_groups tests/test_objective.py` was 0. The `load1=…` hint those tests
print fires whenever `tiers_completed < 4` for ANY reason, which is what made
a structural defect read as environmental noise. Fixed the same way:
`rule_groups=rule_groups_for(<raw board>)` threaded through all three
helpers and both local `imbalance_probe_board()` construction sites (7-tuple
vs the now-8-tuple `_production_board()` shape had to match). Placement
pytest is 220/220 now, 0 failed (`test_objective.py` alone: 21/21) — and
notably ~3x faster (18.9s vs ~55s), consistent with a correctly-capped board
being an EASIER packing problem, exactly as the coordinator's diagnosis said.
None of the three proved-optimum constants (`T1_PROVED_MAKESPAN_MS` etc.)
needed to move — confirmed by diff, only context lines touch their names.

Golden
corpus: 474/474 `testkit/golden*.test.ts` passed, and `git status --porcelain`
on all 11 `*.golden.json` fixtures is empty — byte-identical (scheduling code
is outside the corpus's scope entirely). `openapi:gen` produced zero diff.

### C2 — T1 `day_start` rung (2026-08-13)

Branch `feat/c2-day-start-rung`, worktree `.claude/worktrees/c2-day-start`,
off `3d64222a`. **PR #555 MERGED** as `40331cc2`; follow-up **#557 MERGED** as
`4dc38a0e` (the safe half only — the gate defect below is still open).

**False premise, and it changed the scope: #512 WAS NEVER IMPLEMENTED.** The
C2 prompt reads as if the two day rungs already exist ("reusing #512's
`day_lo`", "TIER_COUNT → 6"). They do not. `f687c7d5 docs: design for the
day-aware T1 objective (#512) (#531)` is a **docs** commit — the design doc
merged, the code never landed. Ground truth on `main` before this session:
`objective.py:166` had `TIER_ORDER = (placed, makespan, idle_gap, imbalance)`,
`build.ts:194` had `TIER_COUNT = 4`, and `model.py` had no `day_used`/`day_lo`/
`day_hi`/`span` at all. `day_start` is therefore not buildable alone: its input
`day_lo` is `day_span`'s variable and its chain slot is directly below it. The
day_start design anticipated exactly this — "#512's 4→5 becomes 4→6 **if this
lands with it**".

**Owner ruling (asked before exceeding the file set, per §1):** one PR, both
specs, `TIER_COUNT` 4 → 6, `makespan` retired. And on the wall: ship, report
the numbers, the production wall is a separate decision.

**Prompt/spec drift found by re-pin (before writing any code):** `model.py`'s
day derivation is 833-871 and `on_day` 876-889 (prompt said ~842-870); the
proto `Tier` name list is `scheduler.proto:199` inside 197-208 (prompt said
192-198). The prompt's "the TS caller's tier list" does not exist — **TS never
keys on tier names at all**, only on the tier COUNT (`build.ts:194`,
`schedule.ts`'s `TIERS_TOTAL`, and a mirrored comment in
`generated/scheduler.ts`). So the "same string both sides" requirement is
satisfied by the proto comment plus the count, and there is no TS name table to
edit.

**Ruling — the redundant per-day floor is the whole reason T1 proves.**
`model.Add(span >= dur_ms).OnlyEnforceIf(day_used[d])` is redundant about any
real board (`day_hi >= s + dur` and `day_lo <= s` already imply it) and is
load-bearing for the DUAL bound: `day_used[d]` is implied BY `on_day`
one-directionally and never implies an occupant back, so the relaxation may
hold a day "used" with a span of nothing and `sum(span)`'s lower bound starts
at 0. Measured on the production board: **without it `day_span` was still
FEASIBLE at 180 s and never proved; with it, OPTIMAL in 1.0 s at the same
value (69 600 000)** — the incumbent had been optimal all along and could not
be proved. Same lever as T3's max/min equality: fix the dual bound, not the
search. Narrowing each day's variable domains to that day's own window was
tried first and did nothing measurable on its own (kept anyway — exact, and
cheap).

**Ruling — #512 §6b resolved as option (1), accept and document.** An
off-lattice pin belongs to no day, so under a per-day objective it is invisible
to T1 entirely. Consistent with C4, which already exempts it from day caps.
Pinned by `test_day_objective.py::test_an_off_lattice_pin_belongs_to_no_day_at_all`
so a future reader finds a decision rather than an accident.

**Wall: a real regression, reported not hidden.** Production board, N=6 per
side, same box, same board, 30 s wall:

| | before (4 rungs) | after (6 rungs) |
|---|---|---|
| total, min/median/max | 1131 / 1730 / 2073 ms | 7739 / 17657 / 19485 ms |
| `days` | — | 215 / 367 / 469 ms |
| `day_span` | — | 631 / 1237 / 1813 ms |
| `day_start` | — | 208 / 396 / 458 ms |
| `idle_gap` | 741 / **1348** / 1672 ms | 6337 / **14931** / 17665 ms |
| tiers proved | 4/4, 6 runs | 6/6, 6 runs |

**The new rungs are not the cost — they are ~2 s of it.** `idle_gap` is, and
the control run says why: `placed` + `idle_gap` alone, **no day rungs in the
chain at all**, costs 12 439 ms. The retired whole-board `makespan` freeze had
been doing `idle_gap`'s pruning as a side effect, so what the wall pays for is
removing that term, not adding these. Arm B (day rungs but no `day_start`) is
the SLOWEST of all at 30 704 ms, so `day_start` is not the culprit either.

Consequence at the 8 s production wall: the chain returns FEASIBLE with **four
of six** rungs proved — `placed` + all three day rungs, ~2.3 s median, never
above 3.5 s measured — and cuts `idle_gap` short. The day-aware objective
itself fits the wall comfortably; `tiersCompleted === TIER_COUNT` (TS's
`already_optimal` gate) will now rarely fire at 8 s on a board this size.
Follow-up candidate, NOT done here: give `idle_gap` a dual bound the way
`day_span` just got one.

**Re-baselines, all stated:** `T1_PROVED_MAKESPAN_MS` / `_PIN_FREE_MS` retired
with their term; `T2_PROVED_IDLE_GAP_MS` 132 600 000 → 170 400 000 (a
day-anchored board spreads one entrant's matches further apart — the
`day_start`-over-`idle_gap` trade, asserted directly);
`T3_PROVED_IMBALANCE_MS` unchanged. New: `days` 19, `day_span` 69 600 000,
`day_start` 0. `test_bench_contract.py` untouched and green — the BOARD did
not move. `PROBE_OPTIMAL_MAKESPAN_MS` renamed `PROBE_OPTIMAL_DAY_SPAN_MS`,
value unchanged (that board is one day, so the two quantities coincide).

**Unplanned fixes (in scope, recorded per §1):**
- `schedule.ts`'s `TIERS_TOTAL` was still a hand-written `4` whose own comment
  claimed it "MIRRORS `TIER_COUNT` ... which is module-private there" —
  already false when written (`build.ts` exports it precisely so this layer
  needs no copy, ruling R17). It now imports the constant. This is the exact
  drift the export existed to prevent, and it had already happened.
- Nine engine test stubs hardcoded `tiersCompleted: 4` meaning "a fully proved
  ladder", plus ten assertions on the literal `4`. All now `TIER_COUNT`. The
  one exception is `build-teardown.test.ts`, which `vi.doMock`s that very
  module graph — a static import there would load the module before the mock
  registers and silently make it inert — so it keeps a literal with the reason
  written next to it.

**Lesson for C3-C8, and it is the same one C1 recorded.** C1's was "never
inherit an enumeration". C2's is **never inherit a status**: this prompt, the
index row, and the spec header all read as though #512 had shipped, because a
DESIGN doc had merged under a PR number. `git log --oneline --grep` on the
issue number, and one `git grep` for a symbol the work would have created, is
the whole check.

**Bench script untouched, deliberately.** `bench/placement_bench.py` carries a
divergent copy of the model (its own `build_model`, its own tier vocabulary —
`idlegap`, not `idle_gap`) and #512 §9 puts de-duplicating it out of scope. The
C2 prompt's "`bench/` copy of the model **if** the #512 work duplicated the
chain there" is conditional and the condition is false: this change duplicated
nothing into it. The bench numbers above were measured against the SERVICE's
model and chain, which is what ships.

#### C2 follow-up — the acceptance gate ranks on the OLD ladder (OPEN)

`40331cc2` shipped a real defect. PR #557 ships only the part that can be
verified as behaviour-neutral; **the gate itself is still wrong on main** and
needs its own task. Read this before attempting it — four variants were tried
and measured, and all four failed.

**The defect.** `isStrictlyBetter` (`build-objectives.ts`) ranks
`placed → makespanMinutes → idleGap → imbalance` while the solver optimises
`placed → days → day_span → day_start → idle_gap → imbalance`. That comparator
is not advisory: `solveBuild` compares the placement reply against the
legalised greedy seed and returns the SEED when the candidate does not win. So
a PROVED-optimal board can be discarded, and — before #557 — the discarded-board
reply was reported `already_optimal`.

**#557 MERGED as `4dc38a0e`** — behaviour-neutral, verified: `TIER_NAMES` as the shared
vocabulary with `objective.py` and the proto comment, `TIER_COUNT` derived from
it, `already_optimal` gated on the NAMES rather than a bare count, the three day
metrics on `BoardMetrics` as REPORTED fields, and three test-quality fixes. The
DB-backed CI command (`src/server src/lib`, real Postgres, real placement
service) returns **4518 passed / 0 failed on both `origin/main` and the branch**
— identical, which is the evidence that nothing about which board ships moved.

**WHY MIRRORING THE LADDER INTO THE GATE DOES NOT WORK, and this is the part
worth reading.** The two boards being compared are not both products of that
ladder. The seed is GREEDY's, and greedy is **rule-blind**: it packs from the
first admissible tick, which scores beautifully on `days`, `day_span` and
`day_start` precisely BECAUSE it ignores the typed rules that push a lawful
board later. Ranking the day terms therefore makes the gate prefer the board
that breaks the rule. Measured on a division carrying a durable
`not_before noon` rule: six cards proposed before noon on a board whose rule
says none may be.

**The four variants, all measured on the full DB-backed run:**

| variant | result |
|---|---|
| mirror the ladder in `isStrictlyBetter` | 5 failed — `not_before` breach + 3 × `assertNoNewBlocking` in locks + `solver.moved` |
| + conflicts dominate (blocking, then total) | 5 failed, a DIFFERENT five — fixed 2, broke 3 more in `build-honours-locks` |
| + `moved` zero without a caller board (R21 shape) | broke two POLISH specs that measure `moved` from the caller's board |
| narrow: legality → placed → the solver's own PROOF | **7** failed, on a brand-new database |

Each fix traded one failure class for another. **That is the signal: this is a
design problem, not a tuning problem.** The acceptance gate, the delta conflict
gate, `moved`'s baseline and locks are more coupled than any single ranking rule
captures.

**What the next attempt should start from, not re-derive:**

- The gate is a DELTA against the greedy seed, not an absolute legality test
  (standing repo finding). `rejectedBlockingConflicts` closes only the direction
  where the CANDIDATE is worse; nothing refuses a SEED that is worse. Any fix
  has to close the other direction, and blocking-conflict count alone does not
  do it because typed-rule breaches (`warn.instruction`) are not blocking.
- `moved`'s seed fallback is justified as "a self-comparison, so zero" — true
  ONLY while every no-`current` exit returns the seed. Any change that lets
  BUILD return the solver's board breaks that justification, and the R21-shaped
  fix (zero without a caller board) breaks POLISH, which legitimately measures
  against a caller board that is sometimes absent from `greedySeed`'s binding.
- The four `schedule-build-honours-locks` failures survived every variant and
  were never diagnosed individually. Start there, not with the comparator.
- Baseline discipline: run
  `npm test --workspace apps/web -- src/server src/lib` with
  `PLACEMENT_SERVICE_HOST` set and a **brand-new** database, on `origin/main`
  first. Main is 4518/0. Anything else is your change.

**Found by two independent reviewers**, separately, within minutes — neither CI
nor the implementer. All 12 checks were green on #555 and could only ever have
been green: **no test drove a board where the two ladders disagree.** Green is
evidence about the paths that are driven, nothing more. The same shape turned up
three more times the same day in other lanes (a joint report still rendering
uuids because smoke typed the payload and never read `offenders`; a template
gallery with no width coverage because every width project is
`testMatch:/mobile\.spec\.ts/`; a bye seed stranded forever because every test
used power-of-two counts).

**Deploy order for the 4 → 6 change remains web first, then the placement
service.** The name guard cannot help a caller already deployed with the old
list; new web against an old service simply never reaches `TIER_COUNT`, which is
degraded but honest.

#### OPEN, separately: main can throw `assertNoNewBlocking` on apply (intermittent)

Distinct from the gate defect above, and it reproduces WITHOUT any gate change.

`schedule-solver-telemetry.test.ts` → "reflow leaves an already-legal board
untouched, including a card parked late" fails on `origin/main` with a real
placement service and a brand-new database. **Measured 1 red in 3 runs**; a
second session hit the identical failure on a PR touching only
`.github/workflows/e2e.yml`, i.e. with zero source changes.

```
EngineError: schedule change hits a blocking conflict
  assertNoNewBlocking  schedule.ts:930
  applySchedule        schedule.ts:2003   <- the manual park, not the build
```

So main today can propose a board that throws when applied — not merely the
`already_optimal` misreport. Nondeterministic, so a single green run does not
clear it and one red does not prove a regression: **always run it several
times before attributing it to a diff.** That property is what let it sit
unnoticed, and it is why the C2 gate work spent a cycle chasing it as its own.

Likely related to C2 shipping the day-aware ladder into the solver while the TS
side still reasons about boards the old way, but that is a hypothesis — the
failing call is the manual park, so start by asking which conflict
`deltaConflicts` actually returns there rather than assuming round order.

#### CLOSED (2026-08-13): a fixed park instant, in TWO suites — not the product

**Scope correction.** This section was first closed against the LOCKS suite
alone (`schedule-build-honours-locks.test.ts`). That was an overclaim: the suite
named in the report above is `schedule-solver-telemetry.test.ts`, a different
file, and it went red on CI for PR #563 while the locks fix was green. Same
defect CLASS, two separate sites. Both are fixed below; the locks one is
described first because it is where the mechanism was traced.

The question above — "which conflict does `deltaConflicts` actually return at
the manual park" — has an answer, and it is not round order. Instrumenting
`assertNoNewBlocking` to dump `refused`/`before`/`after` plus the proposed and
untouched boards, on a run made to fail deterministically:

```
site: applySchedule   source: manual
refused: court          | C2 double-booked with 3bb183c1
         person_overlap | entrant 2af01252 overlap with 5a2afb35
         person_overlap | entrant 2ef216b8 overlap with 3bb183c1
before:  (none)
proposed:  96e0a3b5  C2  01:00
untouched: 3bb183c1  C2  01:00     <- already there
```

One fixture proposed, onto an occupied slot. The park is a genuine court
double-booking and the gate refused it correctly.

**Why the slot was occupied.** `config.startAt` is NOT the solver's floor. The
apply gate's window comes from `applyWindow`, which floors at START-OF-DAY of
`config.startAt` in the org zone — `2026-08-01T00:00Z`, not the configured
09:00 — and `boundSolverWindow` returns a two-finite-bound window untouched. So
the solver's grid opens at midnight while GREEDY's cursor opens at 09:00
(`calendar.ts:759`, `ready = max(config.startAt, window.notBefore)`). Under C2's
day-aware rungs the solver compacts to that midnight, on the seed day or the
next, run to run — both boards verify clean, so nothing downstream picks a side.
The suite's park slot was the fixed instant `at(-480)` = `01:00Z`, which is free
under greedy's 09:00 board and IS the board under the solver's midnight one.

Traced over 5 auto applies: **3 next-day (pass), 2 seed-day (fail)**. That is
the whole of the "1 in 3". The suite only ever looked stable because
`isStrictlyBetter` kept discarding the solver's midnight board for greedy's.

**A TEST premise broke, not the product.** Every board involved verifies clean.
Fixed by reading the park slot off the board that is actually there, and parking
FORWARD (`parkSlot` + `lastRoundFixtureId`) — backward cannot be made robust,
because on the seed day the earliest card sits exactly ON the window floor, so
no legal slot exists before it and the park fails with `window` instead of
`court`. Result: **10 of 10 green** with the acceptance gate REMOVED, against
2-3 failures in 10 before.

#### The gate: both directions now measured, both fail

With the premise fixed, the fix-vs-remove question was re-opened — including
the option this index had recorded as rejected, since **that rejection's
evidence was contaminated by the premise above**.

Baseline (premise fix only, gate untouched): **61/61** across the six
scheduling suites. Gate reworked to trust `provedOurLadder` instead of ranking:
**58/61**, two reproducing deterministically over two runs.

1. **The proof is not authority over the durable rules.** On a division whose
   durable rule forbids anything before noon, the reworked gate shipped six
   cards at `2026-08-02T00:00:00.000Z`. `provedOurLadder` proves the OBJECTIVE
   LADDER and says nothing about typed rules; instruction conflicts are not in
   `isBlockingConflict` (`court`/`person_overlap`/`window`/`order`+`direct`), so
   step 7's verifier gate will not refuse them either. The greedy seed IS
   legalised, so it respects the rule. Net: `isStrictlyBetter` is currently the
   only thing keeping a rule-breaking proved board off the organiser's screen —
   incidentally, not by design.
2. **Metric equality is not board equality.** A `ladderTied` predicate over the
   six rungs shipped greedy's board where the baseline shipped the solver's
   (`does not anchor a BUILD to the board it was asked to replace`, 6 unchanged
   where 0 is required). Fixable by comparing assignments, but moot given 1.

**Why the solver breaks the rule: it is never told.** `not_before` does not
appear in `build-encode-rules.ts`, and `placement-client.ts` records twice that
`division_rules` — proto field 10 — was RETIRED from the wire. The placement
service receives no typed division rules and structurally cannot honour them.

**So the gate is not fixable at the gate**, and the prerequisite is to make a
durable-rule violation REFUSABLE. `build.ts` step 7 already has the path —
`rejectedBlockingConflicts` -> "verifier rejected the placement solver's board —
falling back to the greedy seed". Add durable-rule conflicts to the set THERE,
at the build gate only, not by widening `isBlockingConflict` globally (which
would also change the apply gate's delta check and every surface sharing the
predicate). With that guard in place the proved board never reaches the
comparator, and trusting the proof becomes safe.

#### CLOSED (2026-08-14): the gate trusts the proof, tie broken on the LADDER

Branch `fix/c2-gate-proof-tie`, off `f364f4ce`. **61/61 on the six suites**
(baseline on `origin/main` measured first, also 61/61, `grep -c
UNAUTHENTICATED` = 0 on both, every `.testResults[].name` inside the worktree).

**The change, in one line:** when the reply proved OUR ladder, the service is
the authority on its own objective and its board ships; `isStrictlyBetter`
survives only for a reply that proved nothing. D6's placed floor is checked
first in every arm.

**Why it is safe NOW and was not before: #564.** `isBlockingForBuild` refuses a
solver board that introduces a durable-rule breach, at step 7, before the
comparator. That was the stated prerequisite and it has landed, so the
`not_before noon` failure that killed the earlier attempt cannot recur. The two
ship together — do not port this gate to a tree without that guard.

**TWO FALSE PREMISES IN THE TASK BRIEF, both measured, both the opposite of
what the brief said. Neither is guessable from the code.**

1. **The polish failure was never a tie.** The brief attributed
   `does not anchor a BUILD to the board it was asked to replace` (expected 6
   to be 0) to `ladderTied` being metric- rather than board-equality.
   Instrumented on that fixture: `dayStartOffset` is **0 against 540** —
   the two boards are not tied on any predicate. The real cause is `moved`'s
   BASELINE. `movedFrom` fell back to greedy's own seed, which read as zero only
   because every no-`current` exit RETURNED that seed; once the gate ships the
   solver's board, a fresh full pass reports "6 matches moved" against a board
   greedy invented mid-run and never showed anyone. Fixed by mirroring
   `lostFrom` exactly: **no caller board ⇒ 0**. This is the R21-shaped fix the
   notes above predicted would break POLISH — it does touch two
   `build-polish.test.ts` arms, and both were rewritten rather than deleted (see
   below).
2. **Comparing ASSIGNMENTS, the brief's prescribed fix, ships churn.** Measured
   on `schedule-solver-telemetry`'s one-fixture board: the proved reply is a
   bare **court swap** (`a@C2` for `a@C1`, same instant) with all six rungs AND
   `makespan` byte-identical. Board identity ships that, reports `ok`, and moves
   every card on a board nothing improved — and `already_optimal` loses its only
   reachable path. The tie is a question about the LADDER, so the tie rule is
   **equality over the six rungs**, re-measured with ONE instrument
   (`seed.metrics` carries no `DayView`, so the seed is re-measured with the
   incumbent's `days` view — comparing the two as-is is the placer/verifier fork
   this file keeps producing).

**This is NOT the rejected mirror**, and the distinction is the whole design: an
equality can decline to churn, an ordering would pick a winner on terms greedy
scores well on precisely because it ignores typed rules. Never let `ladderTied`
become a comparison.

**Status untangled from the ship decision, as required.** `already_optimal` is
now `provedOurLadder && ladderTied` — "a board nothing beat" — rather than
`!improved`, which would also catch the D6 floor case and call a board the seed
BEAT "already optimal". `infeasible` unchanged.

**`moved`'s two suites were pinning opposite things** and coexisted only because
a different board shipped in each fixture. `schedule-polish-current` pins
BUILD ⇒ 0; `build-polish` pinned no-`current` ⇒ counted against the seed.
Resolved toward 0, because the alternative makes `schedule-polish-current`
VACUOUS (its mutant — BUILD passing `current` — would then also answer 6).
`build-polish`'s scoping mutant (`moved: 3` on a two-row board) was preserved by
giving that spec a `current`-carrying arm; verified by re-mutating
(`expected 3 to be 2`).

**Verification.** Both halves independently mutation-checked against
`origin/main`'s `build.ts`: the gate half fails `expected 'greedy' to be
'optimized'`, the `moved` half fails `expected 2 to be +0`. Engine
`test:coverage` 3928 passed / 22 pre-existing pendings; engine + `apps/web` lint
0 errors; engine + `apps/web` tsc 0 errors.

**A THIRD fixed-park-instant site, found by CI on this PR.**
`schedule.test.ts` -> "Community org: constraints/board are open, quick-start
unaffected (#382)" parks round 1 at `at(-60)`. That instant was chosen when the
board was assumed to start at 09:00, so it read as "earlier than everything";
against a board the solver compacts to the day's open it is LATER than every
card, putting round 1 after round 3 — a direct `order` breach, and blocking.
Same premise as the two sites above, same cause, and it only surfaced now
because the gate stopped discarding the compacted board: **2 red in 3 with the
fix, 0 red in 4 on `origin/main`, same DB and box.** So the gate change did not
break it — it removed the accident that was hiding it, exactly as the locks
suite's note predicted.

Fixed by the established technique, not a new one: park FORWARD off the board's
own last card, on the LAST-round fixture. Backward is unfixable here for the
recorded reason (on the seed day the earliest card sits ON the window floor, so
the park fails with `window`). 6 of 6 green after, and the manual SET is now
read back so the spec still proves a write happened. Full DB-backed run
(`src/server src/lib`, real Postgres, real placement service): **4594 passed /
0 failed**, against CI's 4593/1 before the fix.

**SWEPT 2026-08-14: there is no fourth site today.** The recipe below is what
the sweep actually needed — the naive one in the first draft of this entry
produced BOTH false negatives and false leads, so use this and not that.

*The discriminator is DATAFLOW, not the literal.* A fixed instant is only a
hazard when it is parked ONTO a solver-produced board (`autoSchedule` -> park),
because nothing pins which day the solver picks. These are NOT instances:

  * a whole board the test authors at fixed offsets from one `T0` origin — it is
    internally consistent wherever `T0` lands (`schedule-durable-hard-surfaces`
    builds `violating` this way and applies it `source: "manual"`, overwriting
    the proposal it took at :208);
  * a write onto an EMPTY board — nothing to collide with
    (`schedule-solver-telemetry`'s `at(0)`/`at(30)` at :744 and
    `schedule.test.ts`'s `at(0)` at :658/:715 all follow `seedStage` /
    `generateStageFixtures` with no `autoSchedule` between);
  * `schedule-solver-telemetry`'s pinned-anchor spec at :593, which parks the
    LAST round forward onto an empty board — deliberately preserved, twice now.

*The dangerous shape is the INPUT, not an equality assertion.* All three known
sites failed as `scheduled_at: at(N)` handed to `applySchedule`/`moveFixture`,
throwing at the park before any assertion ran; the locks site's own
`expect(...).toBe(at(-480))` lines never executed. A rule that hunts equality
assertions and treats `scheduled_at: at(600)` as safe excludes every instance
found so far — that literal IS the telemetry site's failing line.

*`git grep -E` is POSIX ERE: `\s` matches NOTHING and fails silently.* The
sweep's first pass returned zero hits on a pattern with 40+ real ones. Use
`[[:space:]]`, and always run a positive control before believing an empty set:

    git grep -naE "(scheduled_at|startAt)[[:space:]]*:[[:space:]]*at\(-?[0-9]" -- apps/web/src

Anchor `\bat\(` if you widen it — a bare `at(` also matches CSS like
`repeat(4,4rem)`. And grep by ADDED LINE, not by file: a touched file's
pre-existing hits are not yours.

**Load warning for whoever runs the engine suite next.** On a contended box the
full engine run produced a DIFFERENT red set every time (15, then 2, then 5,
including `swiss` at 40 s and `golden` replay at 7.1 s against 59 ms isolated).
All green in isolation. Raise `--testTimeout` before believing any of them, and
read `uptime` first — this is not limited to `repair-scale`/`repair-decompose`.

#### The second site: `schedule-solver-telemetry.test.ts`

"reflow leaves an already-legal board untouched, including a card parked late"
parked at `at(600)` — a fixed instant ten hours after `T0` — under a comment
asserting "still legal, nothing else is near it". Same false premise, different
failure mode: the parked card is the LAST round, so when the solver compacts to
the NEXT day the whole board sits AFTER the park, and a last-round card placed
before every round that must precede it is a direct `order` breach, which is
blocking.

**Local runs cannot discriminate here, in either direction.** Measured against
the boards produced locally: every August board starts at `08-01 00:00` and ends
between 01:00 and 10:00 — always BEFORE `at(600)` — so the park is safely after
the board and the test passes. 6 of 6 green with the fix; a subagent measured
0 red in 6 WITHOUT it on the same branch. CI is the only arbiter that exercises
the other day choice. The fix is therefore justified by removing the dependency
on which day the solver picks, NOT by a green local run — do not treat a local
pass here as evidence either way.

That same measurement independently re-confirms `config.startAt` is not the
solver's floor: every board starts at midnight, never the configured 09:00.

The pinned-anchor spec lower in that file also uses `at(600)`, and is
deliberately NOT changed: it parks onto an EMPTY board, so there is no board to
read a slot from, and it is not failing.
#### C2 follow-up — `idle_gap`'s dual bound (2026-08-13): PARTLY CLOSED

The wall follow-up C2 deferred ("give `idle_gap` a dual bound the way
`day_span` just got one"). **The premise was wrong and the measurement says
so** — but the rung got materially cheaper anyway, by a different lever.

**`day_span`'s lever does NOT transfer, and the reason is the board.** A
redundant floor of that kind needs a counting relation between the metric and
how many fixtures must fit it. On `production_board()` every entrant plays
exactly TWO fixtures, so the chain argument degenerates to a single rest
period: 4 800 000 ms against a 170 400 000 optimum — 2.8% of the gap. Do not
re-derive this; it was computed off the board, not guessed.

**Root cause, from CP-SAT's own search log rather than inference.** The
optimum is FOUND at 4.2 s and everything after is PROOF, at `conflicts: 0`,
`branches: 265`, `lp_iterations: 0` — there is no tree search to speed up.
Reduced-cost fixing ratchets the lower bound up one unit per LP round from
1 200 000 toward 170 400 000.

**What shipped instead: T2 counts in tick-lattice units.** Two real defects,
both in `model.py`'s T2 block:
- the gap vars were `NewIntVar(0, max_end, ...)` where `max_end` is an
  absolute EPOCH (1.77e12). They hold DURATIONS, reachable max 2.2e9 — 805x
  oversized. `day_hi` shares that bound correctly; a gap does not.
- they counted in 1-ms units when every reachable gap is a multiple of
  600 000 ms (gcd of grid-tick offsets folded with `dur_ms`, derived from the
  data by `_gap_lattice_ms`, never assumed — an unaligned grid collapses the
  gcd to 1, which is byte-for-byte the old encoding).

Same instrument T3 already uses ("counted in matches and scaled to ms once").

**Measured, 6 runs per arm, back to back on one box:**

| | before | after |
|---|---|---|
| 8 s PRODUCTION wall | 4/6 rungs on **all 6** runs | **6/6 rungs on 3 of 6** |
| `idle_gap` wall (load 3-6) | 10 692-16 159 ms | 4 282-6 381 ms |
| whole chain | 12 135 ms | 5 997-8 083 ms |
| `deterministic_time` | 13.1 | 11.1 |
| objective values | `170 400 000` | `170 400 000`, identical |

So the wall now sometimes proves the whole ladder and previously never did.
It is NOT a guarantee at 8 s and nothing asserts one.

**Measure det_time, not wall-clock.** This box ran `load1` between 3 and 213
inside a single 6-run bench, and at load ~50 the BASELINE proved only 2/6 at
the 8 s wall. Every wall number above is paired with its load.

**Dead ends, measured so nobody repeats them.** `optimize_with_core` is 6x
WORSE (det 65.3 vs 10.9) and ships unproved, worse boards (`idle_gap`
256 800 000); `core + use_lb_relax_lns` worse still (83.7); `use_lb_relax_lns`
alone is neutral (10.7). Solver knobs are not the lever.

**What is left, and it is not cheap.** The true bound is graph-shaped: cap
1/day forces a group's 19 fixtures onto 19 distinct days, every entrant plays
2, so the binding argument is that a 2-regular graph is a union of cycles and
laying a cycle's edges on distinct days forces some vertex's two edges >= 2
days apart (170 400 000 ms = 2 days minus 40 min). The LP cannot see that, and
a floor derived only from "different days" reaches one inter-day separation
and stops short.

**Fallout worth knowing about, because it caught a latent defect.** Two
cut-short tests in `test_objective.py` raced a FIXED 8 s wall against
`idle_gap`'s proof time. With the rung 5x faster that wall stopped cutting
anything, and only ONE of the two went red for it — green by lottery. They now
time the four rungs above `idle_gap` and derive the wall as `2 x elapsed +
slice`; doubling widens the four-rung side without narrowing the other,
because `idle_gap`'s cost scales with the same load (it needs ~4x their time).
Verified 6/6 green at loads 9.8-22.4, the exact band that had been failing.

### C3 — structured conflict details (2026-08-13/14, DONE)

Branch `feat/c3-conflict-detail-names`, **MERGED as `ccab1356` (#567)**, 29
commits. Three implementation phases (engine / server+wire / client),
sequential because the file sets overlap, plus a review-response round.

**Rebased TWICE onto a moving `main`, and the second one hid a real defect.**
P6's #568 edits the same board components. Git merged both branches' hunks
cleanly and `tsc` was happy — but P6 had landed a locale test that supplied
the conflict counterparty as English PROSE, relying on the regex scrape C3
deletes. Only RUNNING it showed the test no longer reached `titleOf()` at
all. A clean rebase between two branches editing one render path is not
evidence; re-run the suite.

**Every `file:line` in the prompt had drifted — 0 of 11 exact.** C0 found two
wrong, C1 four of eleven, C2 three. C3 found all of them. Treat the citation
block in any remaining prompt as a hint, never as an address.

**False premise, and it doubled the task: the family is 25 kinds, not 4.**
The design names four (`below_rest` entrant+person, `entrant_overlap`,
`person_overlap`, `person_double_booking`) and they cover five of the 23
templates `calendar.ts` builds; `build.ts` carries two more. NINE templates
leak a raw id, not four — the ones the design never named are
`no_slot_person_bound`, `court_double_booking`, `order_before_feeder`,
`order_inside_feeder_rest`. Owner ruled: convert all 25, because the badge
`title` joins every detail with `"; "`, so a partial conversion renders a
localized fragment beside an English one inside a single string. The design's
own field shape was also insufficient — several templates interpolate scalars
(court label, day key, weekday, minute counts, round numbers) that
`{entrantIds, personIds, fixtureIds, otherFixtureId}` cannot carry. Full
25-row table in the design doc's "AMENDED 2026-08-13" section.

**The prose was in `conflictKey` DELIBERATELY, and that is the apply gate.**
Three separate comments (`calendar.ts:829`, `:1364-1376`, `:1479-1495`) record
that the counterparty id inside the string is what distinguishes a swapped
court, an added collision, and a rest breach hiding behind an ordering
violation. It feeds `deltaConflicts`, `repair-minimality.ts` and the joint
apply gate (`competition-schedule-apply.ts`). So a task framed as "render names
in a tooltip" reaches directly into which edits an organiser's apply REFUSES.
Owner ruled: key on a canonical serialization, and PROVE the partition rather
than assume it.

**The prose also reached the MODEL.** `schedule-ai.ts:2189` and
`competition-schedule-ai.ts:2130` put the raw engine `Conflict[]` on the
repair-round conversation as `verifier_conflicts` — no mapper, no stripping.
Deleting `detail` would have silently changed what a paid model reads. Ruling:
the model's input stays byte-identical via the server-side legacy deriver, and
it carries `detail` but NOT `details` (token weight feeds AI-credit
accounting). Pinned by a field-set assertion on the captured request body.
Sending structured kinds instead is a real follow-up — with a repair-quality
measurement attached, which nothing in C3 had.

**A vacuous falsifier, caught in review of our own work.** The first
partition-parity test guarded non-vacuity with
`groups.length < conflicts.length + 1` — which no partition can ever violate.
Its own comment noticed the impossibility and shipped it anyway. Parity between
two keyings proves nothing unless the corpus exercises what `details`
discriminates: had every conflict owned a unique `(fixtureId, reason)`, both
parity assertions would still pass against a `conflictKey` that had dropped the
detail entirely. Replaced with the real falsifier — the degenerate
`fixtureId|reason` key must be strictly COARSER. Same class as the repo's
standing "union assertion closes nothing" finding: an assertion that cannot
fail reads as protection while providing none.

**Unplanned fix (customer-visible).** `use-board-actions.ts:303` regex-scraped
a UUID out of the prose to title a card, taking the FIRST id — which for
`entrant_overlap`/`person_overlap` is the entrant or person, not the
counterparty fixture. So `board.find` missed and the "clashes with <match>"
enrichment silently degraded to "another match". It now reads
`details.other_fixture_id`; regression test ships with it, verified by
hand-reverting the fix (3 of 4 tests went red).

**The 8-char fallback is WRONG for person ids.** `schedule-ai.ts:202` mints
synthetic collapsed-person keys shaped `name:${normalizedName}`, so the
design's "shorten to 8 chars" prints `name:ali`. The formatter branches on the
prefix — a synthetic id already carries its name.

**Two of the four "surfaces" never rendered the detail at all.**
`conflicts-panel.tsx:125` and `schedule-gate-dialog.tsx` resolve
`board.conflictHelp.<code>` first and fall back to the prose only when that key
is missing — and every live code has one. Five OTHER surfaces the design never
named do render it. Enumerating consumers from a design doc, rather than from
`git grep`, would have missed five and fixed two dead ones.

**Baselines, measured both arms, same box, same solver, fresh DB each:**

| | base `d0cd9a25` | branch |
|---|---|---|
| apps/web `src/server src/lib` | 4594 / 0 / 4643 / 49 pending | 4642 / 0 / 4691 / 49 |
| engine | 3921 / 3 / 3946 / 22 | 3977 / 0 / 3999 / 22 |
| `src/components` | — | 2037 / 0 / 2039 / 2 |

`UNAUTHENTICATED` count 0 in both arms' logs — the solver was genuinely
exercised, not silently falling back to greedy. The engine baseline's 3
failures were 1 stable (`repair-scale`, a wall-clock budget that fails under
full-suite parallelism on the UNCHANGED tree too) and 2 load-induced
(`z3-load` WASM init; `z3-solver` IS installed here).

**§2 is not decoration, and this session proved it the hard way.** A full run
against a database already used for two prior runs produced ONE failure —
`billing-pass-duplicate.test.ts`, `expected 503 to be 200`, a pass-checkout
route with no connection to conflict details. Isolated it was 3/3 green, and
7/7 on the base arm. Rebuilt from `initdb` per §2 and the same full run was
4642/0. A brand-new DB per RUN, not per session.

**Officials conflicts are a different producer and were left alone.**
`packages/engine/src/officials/assign.ts:157` embeds a fixture id in
`OfficialConflict.detail` exactly as the scheduling family did. Out of C3's
scope by the design's own framing; recorded so the next reader finds a decision
rather than a miss. It wants its own task.

### C4 — z3 stage A: reflow on CP-SAT (2026-08-14/15)

Branch `feat/c4-z3-reflow-cpsat`, worktree `.claude/worktrees/c4-z3-reflow`,
off `1b260e1a`. **This session is a continuation** — two prior attempts died
mid-run from environment failures (computer sleep, an account usage-limit
reset), not real blockers. Real work had already landed across three
commits before this session started; this session closed out the remaining
acceptance criteria and found two more real, out-of-scope defects along the
way.

**The wiring (already landed, `61b17510`/`9a7a475d`/`2c5e38e0`).**
`reflowExisting` calls `buildSchedule` (the placement CP-SAT service)
instead of z3's `repairSchedule`. Locked AND already-placed-unlocked cards
are BOTH frozen for the solve (POLISH's own R20 mechanism), because
`buildSchedule` has no "fewest cards moved" term the way the old repair
solver's ascending-k walk did — pinning every already-placed card is what
keeps that property without one.

**Ruling — churn-minimization trade-off, accepted.** REFLOW can no longer
rearrange already-placed UNLOCKED cards to resolve a conflict AMONG them —
only place cards that have no slot yet. `moved`/`lost` simplified as a
direct consequence (`moved == seeded` always, `lost == 0` always, by
construction). Proven non-crashing, not merely assumed, by a dedicated
two-card-collision test.

**Finding — `buildSchedule`'s fallback exits do not anchor a frozen id.**
The SUCCESS/`improved` path anchors a `current`-only frozen id correctly;
every FALLBACK exit (`already_optimal`, a proved tie, `verifier_rejected`,
`not_searched`) reports the plain unpinned greedy seed, which has no idea a
`current`-only id is supposed to stay put — confirmed empirically (a
throwaway two-fixture repro against unmodified `build.ts` swapped both
fixtures' courts). This is the ORDINARY reflow shape (mostly-already-placed
board, solver ties or fails to improve), not a corner. `reflowExisting` now
reconciles every frozen id's slot from the caller's own record
unconditionally, regardless of which exit produced the board. Mutation-
checked: stripping the reconciliation reds all three scenario tests.

**Finding — the placement service's wire refuses zero movable fixtures,
silently.** "fixtures must not be empty" (`schema.py`), no log call on
that branch. A reflow where everything is already frozen — the ORDINARY
"click Re-flow again, nothing changed" case — hit this every time. Added a
fully-frozen fast path that verifies the known board directly and never
calls the placement service, mirroring the old `repairSchedule`
"clean, k=0" verdict.

**Finding (this session) — a dependency-encoding gap on a FROZEN feeder,
shared with POLISH, out of scope.** `buildSchedule`'s CP-SAT encoding does
not enforce a `dependsOn` edge against a FROZEN-but-not-`.locked`
(current-anchored) feeder. Isolated with a throwaway 2-fixture repro
(deleted after use): feeder frozen via `current` at T0, dependent free with
a direct dependency edge, two courts available — `buildSchedule` placed the
dependent AT THE SAME INSTANT as the feeder (not >= the feeder's end),
`status: "ok"`, `engine: "optimized"`; `validateAssignments` correctly
flagged the resulting order conflict on the raw, pre-reconciliation board.
A control repro (the identical bench board, but no frozen/current at all)
showed ZERO order conflicts — confirms the gap is specific to a dependency
resting on a FROZEN feeder, not a general `build.ts` encoding defect.
Shared with POLISH (identical `frozen`/`current` mechanism, R20) — out of
C4's file set to fix (`build-encode.ts` is shared BUILD/POLISH code).
Recorded so C5/a POLISH follow-up finds a decision, not a miss.

**Finding (this session) — a bracket/TBD-fixture wall, shared with
BUILD/POLISH, out of scope, found via a real smoke FAIL.**
`buildSchedule` cannot handle ANY fixture with empty `entrant_indices` (a
knockout bracket's TBD round-2+ slots, unknown until earlier rounds are
played) — the placement service's schema rejects the WHOLE request
(`INVALID_REQUEST`), wholesale, before the solver ever runs, with no log
line on that branch (same undocumented-silent-rejection shape as the
empty-movable-fixtures finding above). Root-caused with temporary
instrumentation directly in `build.ts`'s ERROR-status branch (reverted
after, `cp` backup, verified `git status --porcelain` clean). CONFIRMED
SHARED WITH BUILD, not reflow-specific: replaying the identical bracket
board as `mode: "build"` hits the identical `INVALID_REQUEST`. So this
ceiling has applied to BUILD/POLISH since Task 06b's placement cutover —
ANY bracket/knockout stage beyond round 1 has never been able to reach the
optimiser. What C4 changes: REFLOW is the DEFAULT auto mode, and the OLD
z3 repair solver never sent fixtures over this wire at all, so a fresh
bracket's default Auto-schedule click used to reach z3's repair search and
now always falls back to `buildSchedule`'s own internal greedy — the SAME
ceiling BUILD/POLISH already silently had, newly inherited by reflow. Not
a crash, not a silently-illegal board — every violation is still
accurately reported as a conflict (`warn.instruction`/`warn.order`),
nothing vanishes without an explanatory row — a real optimiser-reach
regression for bracket-shaped reflow specifically, not a safety one. Out
of C4's file set to fix (`build-encode.ts`/`placement-client.ts`/
`schema.py` are shared BUILD/POLISH code, explicitly excluded by the C4
prompt's "Do NOT touch... POLISH/BUILD paths"). `scripts/smoke.ts`'s #452
checks rewritten to branch on `solver.status`: `solver_unavailable` on
this board shape logs the known cause and asserts the safety invariant
only (every fixture placed or explained); otherwise the original,
stronger rest-rule assertions run unchanged, so the check self-upgrades
the day this gap closes rather than needing another edit.

**`engine` tag, confirmed deliberate not accidental.** Wire forward
(`schedule.ts`'s `solver: { engine: out.engine, ... }`) is unconditional —
was a hardcoded `"z3"` pre-change. The fully-frozen fast path reports
`engine: "greedy"` explicitly, matching BUILD's own precedent exactly
(`build.ts`: "`engine: 'greedy'` here matches z3's own exact precedent:
`incumbent === seedAssignments` always reported `'greedy'` there too,
`already_optimal` included — the field names where the BOARD came from,
not which solver was consulted"). A genuine solver win reports
`"optimized"` — confirmed via a new mock-based wire-forwarding regression
test (`schedule-reflow-cpsat-engine-tag.test.ts`, mutation-checked) AND via
the bench's real 6/6 "optimized" runs. No test tries to force a genuine
non-tied win on a real toy board — `schedule-solver-telemetry.test.ts`'s
own history ("THREE assertions have now been tried here and each was a
RACE") already proved that specific shape is machine-load-dependent in this
repo, not a gap.

**Bench (`packages/engine/scripts/bench-reflow.ts`, new).** Hand-
replicates both reflow shapes (pre- and post-cutover) directly against the
engine — `bench-repair.ts`'s "placed board with injected clashes" shape is
the wrong one for REFLOW's ordinary case. N=6/side, n=30 fixtures, 60%
pre-placed, prod-shaped legal board, real placement service:

| | wall ms (min/med/max) | placed | conflicts | engine |
|---|---|---|---|---|
| OLD (repairSchedule/z3), deps ON | 0 / 1 / 3 | 30/30 ×6 | 0 ×6 | greedy ×6 |
| NEW (buildSchedule), deps ON | 276 / 357 / 407 | 30/30 ×6 | 0 ×6 | optimized ×6 |
| NEW (buildSchedule), deps OFF | 295 / 394 / 590 | 30/30 ×6 | 0 ×6 | optimized ×6 |

GATE (blocking conflicts, new vs old): PASS both arms — new never worse.
NEW is slower in absolute ms than OLD's fast "nothing to repair" path
(OLD's repair solver often has nothing to do once greedy has legalised the
seed; NEW always performs a genuine remote solve) — both are trivially
inside the solve wall; "wall respected" is about staying inside budget,
not raw parity with the old fast-path number.

**Two real environment traps hit and resolved this session** (recorded for
the next session, not product bugs — both already had standing findings in
this repo's tooling memory that a careful re-read would have caught up
front):
- e2e on `127.0.0.1` 401s: the session cookie is Secure under a prod build
  and Playwright's `APIRequestContext` will not send a Secure cookie to
  `127.0.0.1`. First attempt: 0/20 spec tests passed (only the 2 setup
  tests), every failure `comp.data!.id` undefined — looked like a total
  product outage. Root-caused via the trace.zip network log
  (`"cookies":[]` on the request). Fix: `PLAYWRIGHT_BASE=http://localhost`.
- The 7-width mobile matrix races over one org: all 7 width projects share
  one process/TAG, so a mutating spec's competition name collides across
  concurrent workers. First `--workers=4` run: 2/7 width projects failed on
  the identical shape. Reran `--workers=1` (removes the concurrency, not
  the coverage): 9/9. Not a C4 regression — `mobile.spec.ts` is untouched
  by this branch and the race is pre-existing.

**Code review round.** Dispatched before opening the PR, per `_RULES.md`
§4. First pass (`ef051d0b`): no Critical issues. One Important finding,
fixed — two doc comments at the mode-dispatch fork point
(`schedule.ts:1135-1138`, `:1267-1272`) still described the OLD
z3-repair-solver-based REFLOW after `61b17510` changed the mechanism
under them, actively misleading at the exact fork point a future reader
needs to trust. Two Minor findings: a `log.warn` likely to fire on a
routine fraction of reflow calls rather than rare anomalies (kept as-is
— the reviewer's own note called it "a judgment call, not a defect," and
the code's justification stands); and a real coverage gap — no test
exercised `buildSchedule` actually being called while a pin-contradiction
is present among the FROZEN cards, because the existing collision test
leaves the whole board placed, so the fully-frozen fast path intercepts
before the solver is ever reached. Fixed: added a variant that also
clears a third, distinct fixture (so a free fixture exists and the fast
path's guard does not fire), confirming `buildSchedule` is genuinely
invoked with the contradiction present. Mutation-checked: forcing the
guard to always fire reds it with "expected 0 to be greater than 0" (the
free fixture never got placed). A second, scoped review pass on this
follow-up commit (`555ca251`) returned **Ready to merge: Yes** — traced
both rewritten comments against current code by hand and confirmed the
new test's guard-condition trace independently, finding no Critical or
Important issues. It flagged two more Minor items: the SAME staleness
class two screens away (`autoSchedule`'s phase-boundary comment and
`autoScheduleCooldown`'s derivation both still cited `z3`/`withZ3Lock`,
predating C4 entirely per `git blame`, 2026-08-06) — fixed in `3a676263`,
and along the way found `PLACEMENT_MAX_WORKERS` is 2 in production
(`fly.toml`), not the 1 the old comment assumed, so that comment's
"one at a time" claim was already imprecise for BUILD/POLISH before C4;
corrected without re-deriving the cooldown's own numbers, which the fix
says explicitly. The other Minor (a structurally-dead OR branch in the
new test's own assertion) was left as-is — the reviewer's own words,
"inert, not wrong."

**Verified (all real, fresh DB per run, real placement service, real prod
build for e2e):**
- apps/web (`src/server src/lib`): 4828 / 4779 / 0 / 49 (total / passed /
  failed / pending), post-review-fixes. 0 `UNAUTHENTICATED`, 0
  `solver_unavailable` outside the known bracket case, every
  `.testResults[].name` inside the worktree.
- engine: 4004 / 3985 / 0 / 19. `repair*.test.ts`/`z3-*.test.ts`/
  `placement-integration.test.ts` all pass — z3 path compiles and passes,
  unreferenced by REFLOW. (Unaffected by the review-response commit —
  packages/engine untouched by it.)
- e2e: `z3-auto-schedule.spec.ts` + `schedule-board.spec.ts`
  (`--project=parallel`, full both files) 22/22 — includes both
  brief-named tests by exact title. `mobile.spec.ts`'s schedule-reflow
  coverage 9/9 across all 7 width projects. (Unaffected by the
  review-response commit.)
- smoke: 836/0, after fixing 3 real FAILs the first full run found — all
  three root-caused (the bracket/TBD finding above, twice, plus a stale
  `tiers_completed === 0` premise directly caused by this session's own
  wiring change). (Unaffected by the review-response commit.)
- Regression: churn-minimization, engine-tag wire forwarding (new,
  mutation-checked), round-order closure, frozen-collision-with-a-free-
  fixture (new, mutation-checked) — all exist, all pass.
- i18n: diff touches only `schedule.ts`, 6 test files, `bench-reflow.ts`,
  `scripts/smoke.ts` — zero user-facing strings, no locale dict update
  owed. `openapi:gen` — zero diff. `packages/engine` + `apps/web`
  typecheck and lint both clean.

PR: see the row above for the link once opened.

### C5 — z3 stage B: AI repair on CP-SAT (2026-08-15/16)

Branch `feat/c5-ai-repair-cpsat`, worktree `.claude/worktrees/c5-ai-repair`,
off `edd358af` (C4 merged). **PR open** — see the row above once linked.

**The wiring.** Both AI runners' repair round (`runAiPlan` in
`schedule-ai.ts`, `runCompetitionAiPlan` in `competition-schedule-ai.ts`)
now call `buildSchedule` (the placement CP-SAT service) instead of z3's
`repairDecomposed`, through a rewritten shared `solveBoard`
(`schedule-ai-solver.ts`). Applies C4's own "pin what stands, re-solve the
violators" ruling directly — the generalization is VIOLATOR-derived rather
than C4's PLACEMENT-derived split: frozen = this pack's own pins ∪ every
movable fixture NOT named by a blocking conflict from this round's own
verifier (both ends of a pairwise conflict, via `fixtureId` +
`details.otherFixtureId`), never `warnings`. `fixtures` handed to
`buildSchedule` stays the FULL movable set, never pre-filtered — same
lesson C4 already learned, `buildSchedule`'s own pin-promotion is what
excludes a frozen id.

**Decomposition-bypass — VERIFIED BY BENCH, and it does NOT hold at every
density.** Built `packages/engine/scripts/bench-ai-repair-cpsat.ts`
(extending `bench-reflow.ts`'s pattern) and measured N=6/side against a
real local placement service:

| board | OLD (z3, decomposed) | NEW (CP-SAT, monolithic) | gate |
|---|---|---|---|
| 30 fixtures, 10 free (~33%), wall 10s | 2167-2557ms, 0 conflicts, moved=5 | 433-817ms, 0 conflicts, moved=10 | PASS |
| 40 fixtures, 24 free (~60%), wall 45s | 7821-8891ms, 0 conflicts | 44643-45636ms (budget exhausted), 24 blocking, engine=greedy | **FAIL** |

At high violator density the non-decomposed CP-SAT solve does not complete
even at a generous 45s wall (server `PLACEMENT_WALL_SECONDS_MAX=60`, ruling
out its own 10s default as the cause) and `buildSchedule` falls back to its
own internal greedy, which does not avoid the injected clashes. z3's
decomposed search handles the identical board in under 9s at zero conflicts
by splitting it into independent, much smaller connected components. **NOT
fixed** — re-adding decomposition for CP-SAT reverses this stage's own
premise and is materially larger than its scope. Assessed and confirmed
(independently, by code review too) as a bounded LATENCY/BUDGET-WASTE risk,
not a safety one: `solveBoard`'s own re-verification (real
`validateAssignments`, regardless of `buildSchedule.status`) plus the
CALLER's pre-existing, unchanged adoption gate
(`afterBlocking.length < blocking.length`) together mean a degraded solve
never gets silently adopted — it wastes solver budget and falls through to
the LLM repair round exactly as if the solver had declined outright.
Flagged as a real follow-up candidate (a density-aware budget/skip
heuristic), not blocking this stage.

**Fallback-exit reconciliation — recurred, exactly as C4 found for
REFLOW.** `buildSchedule`'s non-`ok` exits report the plain unpinned greedy
seed, not the pinned board. `solveBoard` reconciles every frozen id's slot
from the caller's own board unconditionally; mutation-checked. A SECOND,
related bug found while writing the budget-exhaustion test: the original
`unresolvedFixtureIds` computation only checked the reconciled board's
blocking-conflict list, missing a violator `buildSchedule` dropped from its
response entirely (`validateAssignments` cannot report an absence). Fixed;
mutation-checked.

**Code review dispatched before the PR, per `_RULES.md`.** One pass
(large diff, single close pass — concentrated in two mirrored call sites
plus one shared module). Verdict: **Ready to merge, with fixes.** Traced the
reconciliation, the defensive frozen-id narrowing, and — flagged as the
single most important thing to verify — the two-layer independent
re-verification (`solveBoard`'s own, then the caller's adoption gate) that
prevents an organiser from ever seeing a false-clean board; confirmed sound
by hand, not just asserted. Found 1 Critical (a deterministic e2e break,
`data-minimality="proved"` — the review found it independently via static
tracing at almost the same moment this session found it by actually running
the e2e suite; both fixes agree), 2 Important (the joint test file's
missing REGRESSION test; the `data-moved="1"` guarantee question — see bench
above), 2 Minor (a doc comment overstating the lock-wrapper removal; the
"proved minimal" UI copy silently going dark). All addressed except the
UI-copy Minor, left as a noted, deliberately out-of-scope product call.

**e2e finding, found independently before code review flagged it too.**
`ai-architect.spec.ts:1173` ("a clash off the minute boundary...", #452)
asserted `data-minimality="proved"` — a z3-ascending-k-specific claim
`solveBoard` no longer makes. `ai-diff-panel.tsx:334` (untouched) already
falls back to `"unknown"` when `repair.minimality` is unpopulated, so this
was a deterministic break in a live, PR-gating spec, not speculation. Fixed
the assertion and rewrote both doc comments at that test that described the
retired z3 "proved minimal" mechanism — same staleness class C4's own
review caught twice at its own mode-dispatch fork point.

**Verified (all real, fresh DB per run, real placement service, real prod
build for e2e):**
- apps/web (`src/server src/lib`): 4835 / 4786 / 0 / 49 (total/passed/
  failed/pending), `success: true`.
- engine (`test:coverage`): 4004 / 3982 / 0 / 22, coverage gate passed
  (`EXIT=0`). Initial full run hit 40 failures across 17 files — ALL in
  files this diff never touches (sport-module conformance/property tests,
  z3's own timing tests); confirmed 100% environmental (load average
  45/211/184 during the contended run — apps/web's own suite, this engine
  run, a prod build, and a code-review subagent all running at once — vs a
  clean 144 files/3982 tests on a quiet-box re-run, and all 17 originally-
  failed files individually green in isolation too).
- e2e: `ai-architect.spec.ts --project=parallel`, full file, **16/16**, run
  twice (once catching the stale minimality assertion, once clean after the
  fix) against a real local prod build + real placement service. Covers all
  three brief-named specs by title (line numbers drifted: `:1064`→same,
  `:1147`→`:1157`, `:1238`→`:1250`).
- smoke: 833/836 (3 failed), all 3 confirmed environmental by reading
  `smoke.ts`'s own source (`:6252`, `:5835`, `:5843` — each branches on
  real Supabase/Stripe creds OR a genuinely absent key producing a specific
  503-guard message; this session's stub/dummy values read as "configured"
  without being real, satisfying neither branch). Nothing in this diff
  touches logo upload, storage, or revenue reporting.
- Regression: two REGRESSION tests (single-division, joint — the joint one
  added after code review, required extending the joint test pack to 3
  fixtures since its 2-fixture pack makes every scenario all-violators),
  plus the reconciliation and dropped-violator mutation checks. All
  mutation-verified.
- i18n: diff touches only `apps/web/src/server/{usecases,api-v1}/**`, their
  tests, `openapi/*.json`, one engine bench script, and `ai-architect.spec.ts`
  (test code only) — zero user-facing strings, no locale dict update owed.
  `openapi:gen` — the expected 4-spot `engine` enum diff, nothing else.
  `packages/engine` + `apps/web` lint and typecheck all clean.

PR: see the row above for the link once opened.

#### CORRECTION (2026-08-16): the smoke number above was VACUOUS on exactly
#### the code this task changed — read before trusting a smoke count here

The "833/836, 3 failed, all environmental" claim above is accurate about
the three failures it names, and was simultaneously **vacuous as
verification of this diff**. `scripts/smoke.ts:9296`:
`const aiConfigured = !!process.env.SCHEDULING_AI_BASE_URL;` gates the
ENTIRE AI section (`v4AiSuite`) — every AI-repair check in the file,
including the ones that would have caught the regression below — behind
that one env var. The original local run never set it, so the whole
section silently did not execute; `total` stayed at ~836 rather than CI's
own ~891, and only `pending`/skip counts would have shown the gap, which
nothing in that run's own summary surfaced. **Same shape this repo's
`_RULES.md` already names for a worktree missing `.env.local`** ("~1772 DB
tests skip themselves while `total` stays unchanged") — a different cause,
identical failure mode: a real section silently not running, reading as a
clean, smaller-than-expected total rather than as an obvious skip. Next
session: confirm the total lands near ~891 (export
`SCHEDULING_AI_BASE_URL`, point it at wherever `startAiFixtureServer()`
binds — 4319 by default) before trusting ANY smoke number that touches
`schedule-ai.ts`/`competition-schedule-ai.ts`/`schedule-ai-solver.ts`.

#### PARKED (2026-08-16): a real bracket/frozen-feeder repair-capability
#### regression, found via CI, not locally — owner ruling: land C9 first

CI on PR #576 red on `Smoke — build + server + e2e` (889 passed, 2 failed;
9/10 other checks green) — invisible locally for the reason above. Two
failures, both in `scripts/smoke.ts`'s "v4 AI/bracket" checks
(`~:9768`/`~:9780`, #396/#399/#401), on a 4-entrant knockout bracket with a
third-place playoff: two DECIDED semi-finals, and two TBD slots (the final,
the playoff) scheduled at the same instant — legal on named-entrant rules,
unsafe on the people who could still reach either slot (a recursive
`person_overlap`, #396's whole point).

**Root cause, confirmed with evidence
(`scripts/repro-ai-bracket-frozen-feeder.ts`, committed this session as a
verification tool):** `buildSchedule`'s CP-SAT encoding does not enforce an
`OrderDependency` edge against a fixture that is FROZEN via
`frozen`/`current` rather than genuinely `.locked` — C4's own documented,
explicitly out-of-scope finding (`reflowExisting`'s doc comment: "a
dependency-encoding gap on a FROZEN feeder... shared with POLISH...
Recorded so C5/a POLISH follow-up finds a decision, not a miss"), now
actually reached.

**Why REFLOW could never expose this, and why C5's own split is the first
caller that can — the generalizable lesson, not just this task's bug:**
REFLOW freezes EVERY already-placed card uniformly, so a dependency edge in
a REFLOW call is always fully inside the frozen set or fully outside it —
never straddling. C5's violator-derived freeze
(`frozen = pins ∪ non-violators`) can produce an edge with EXACTLY ONE end
frozen: a free violator depending on a frozen non-violator. A bracket's
third-place playoff (a violator — it's IN the clash) depending on two
decided semis (non-violators — nothing names them) is exactly that shape.
**Any future caller that derives its frozen set from something OTHER than
"everything already placed" should expect this same straddle and check for
it up front, not rediscover it via a CI red.**

**A competing, initially plausible hypothesis (the bracket/TBD
empty-`entrant_indices` wire-schema wall C4 also documented) was raised,
investigated, and REFUTED, not assumed** — that would predict
`solver_unavailable`/`INVALID_REQUEST`; what was measured was
`engine: "optimized"` (buildSchedule genuinely reached and answered) with a
concrete `order_before_feeder` conflict naming two fully-DECIDED semis as
the offended feeders. Refuting a plausible-sounding hypothesis with actual
telemetry rather than accepting it is the reason the real cause was found
at all.

**Fix shipped, kept (`a59a9916`):** `solveBoard` declines the solver
attempt entirely — never calls `buildSchedule` — when a dependency edge has
exactly one end in the violator set and the other in the frozen set,
falling through to the LLM repair path cleanly (the same shape the
existing fully-frozen fast path already uses). Correct, defensive code on
its own terms; C9's decomposition (keeping a dependency's two ends in one
connected component whenever one is frozen) is expected to make it
redundant, and whoever lands C9 should evaluate removing it rather than
carrying two overlapping mechanisms indefinitely.

**Why the fix alone was not enough to ship, and why this parked rather than
shipping degraded:** with the guard in place, the solver declines
correctly — but the fallthrough LLM round never resolves the underlying
`person_overlap`, because (per `smoke.ts`'s own pre-#401 comment) this
exact clash shape was ALWAYS structurally unrepairable by the model alone;
z3's direct participation was specifically what made it repairable (#401's
entire point). So declining is not a latency trade — for this shape it is a
genuine capability regression back to the pre-#401 state, and knockout
brackets refined after round-1 results are known are the ORDINARY case for
this shape, not a tail risk. Measured (`repro-ai-bracket-frozen-feeder.ts`,
matches CI):
```
repair: {"engine":"llm","solver_ran":false,"fallback":"unrepaired"}
blocking: 8 person_overlap rows (both TBD fixtures × all 4 shared people)
diff.moved: []   (after 2 full LLM repair rounds)
```

**The safety story held throughout — this is the part that did NOT
regress.** `solveBoard`'s own re-verification (real `validateAssignments`,
independent of `buildSchedule.status`) never once reported an illegal or
unresolved board as `"repaired"` — before the guard, the order-violating
board correctly scored `"partial"`; after it, the declined board correctly
scores `solver_ran:false`/`fallback:"unrepaired"`. No organiser was ever
shown a corrupted or falsely-clean board at any point. What regressed is
repair CAPABILITY on one shape, never the correctness of what gets
reported — the two-layer verification (module-level re-check, then the
caller's unchanged adoption gate) this task built for the DENSITY finding
held equally well for a completely different failure shape it was never
specifically designed for, which is itself worth recording as a design
validation.

**`smoke.ts:9768`/`:9772`/`:9780` are deliberately left failing on
`origin/main`'s branch — do not relax them.** They are the canary that
proves C9 restored the capability: passing again is a genuine C9 acceptance
signal, not a test detail. `C9-decomposed-repair-cpsat.md` has been amended
with this finding as an explicit acceptance criterion, and its own
"Gate: C5 merged" line corrected to reflect the inverted order below — see
PR #581 (`docs/c9-frozen-feeder-finding`, separate branch off `origin/main`,
since this C5 branch is not being rebased while parked).

**Owner ruling (via coordinator, 2026-08-16): land C9 first, then revisit
C5.** PR #576 converted to draft, title prefixed `[PARKED — pending C9]`,
NOT rebased onto `origin/main`'s subsequent commits (rebasing now is
throwaway work while C9 is built on top of unparked C5). Branch
`feat/c5-ai-repair-cpsat` stays as-is; whoever resumes this should rebase
THEN, not before C9 lands.

PR: see the row above for the link.

### C9 — decomposed repair on CP-SAT (2026-08-16)

**UPDATE (2026-08-16, post-C10 verification): CANARY NOW GREEN, PR READY FOR
REVIEW.** Everything below this line, down through the PR link, is the
record of the ORIGINAL session that found the bracket/TBD gap and reported
it — left intact as history. C10 (#586, "put person identity on the
placement wire") merged the fix that gap called for, and this branch was
rebased onto it (`fe44dfb7`, 23 commits, clean). A dedicated verification
pass then re-ran everything fresh and found the wire fix was NECESSARY but
not SUFFICIENT: closing it exposed a second, latent, pre-existing bug this
task's own new code (`nudgeForward`) had carried since it was first
written, invisible until the wire gap stopped shadowing it.

**The second bug.** Two violators sharing one frozen feeder are nudged
ONE AT A TIME (the loop in `repairDecomposedCpsat`). While the first is
being searched, the second still sits in `background` at its own
pre-repair, still-conflicting position. `nudgeForward`'s conflict filter
was unscoped — `validateAssignments(...).filter(isBlockingConflict)`,
with no check that the conflict actually NAMES the candidate — so the
second violator's own not-yet-resolved breach against the frozen feeder
vetoed every candidate tried for the first, forever. The component fell
back to `timeout`/`infeasible` with nothing moved, landing on the same
`{status:"unrepaired", moved:0}` shape the pre-C10 wire refusal used to
produce, for a different reason. Exactly the bracket/TBD scenario hits
this: both TBD siblings depend on the same decided semis. Fixed by scoping
the filter to `c.fixtureId === fixtureId`
(`packages/engine/src/scheduling/repair-decompose-cpsat.ts`, one line),
matching the `own.has(c.fixtureId)` discipline the rest of the function
already applied. Regression test added and mutation-checked
(`repair-decompose-cpsat.test.ts`, "nudges TWO violators forward off the
SAME frozen feeder" — red on the unscoped filter, green on the fix).
Commit `b2d9089b`.

**The canary, unmodified, all three assertions, fresh run:**
`scripts/smoke.ts` (current line numbers ~9852/9859/9871 — C10 shifted the
file by about 97 lines from the `:9755`/`:9768`/`:9780` cited when this was
last red; the assertion TEXT and IDs, `#396`/`#399`/`#401`, are unchanged):

```
PASS  v4 AI/bracket: refine REPAIRS the clashing prior instead of shipping it (#401)
PASS  v4 AI/bracket: ...by moving exactly ONE fixture, proved minimal (#401)
PASS  v4 AI/bracket: the person_overlap that blocked is GONE from the response (#396, #399, #401)
```

`scripts/repro-ai-bracket-frozen-feeder.ts` — the acceptance signal its own
header comment names, reached: `{"engine":"optimized","solver_ran":true,
"status":"repaired","moved":1,"minimality":"proved"}`, `blocking: []`.
Previously (this same script, pre-fix): `{"engine":"llm","solver_ran":true,
"status":"unrepaired","moved":0}`, 8 `person_overlap` rows blocking.

**Full re-verification, fresh DB per run, real placement service
(`PLACEMENT_WALL_SECONDS_MAX=60`), real prod `standalone` build:**
- smoke: **903 passed / 0 failed (903 total)** — up from 900/903 pre-fix.
  Confirmed not vacuous (no `SCHEDULING_AI_BASE_URL unset` line anywhere,
  `placement optimized` suite green).
- apps/web `src/server src/lib`: **4996 total / 4940 passed / 0 failed / 56
  pending**, 0 failed suites, all paths confirmed under this worktree.
- packages/engine `test:coverage`: **4025 total / 4004 passed / 2 failed /
  19 pending.** Both failures are `placement-integration.test.ts`
  (untouched by this session — only C10 appended a new, passing test to
  the end of that file; the two failing ones predate it), and both are
  load-sensitive, not structural: this machine ran ~20 concurrent sessions
  throughout (`uptime` load average 10.78–18.45 during the failing run),
  and the second failure ("falls back to greedy with the service
  unreachable", a 10s-timeout test whose own comment already flags this
  exact risk) PASSED on immediate re-run alone as load dropped to 5.94.
  The first ("32-fixture/5-court board", 20s test timeout vs. the
  service's own allowed wall) is the identically-documented pre-existing
  mismatch the original C9 session already found.
- `ai-architect.spec.ts --project=parallel`, real prod build, real
  placement service: **16/16** (`stats.expected:16, unexpected:0,
  skipped:0, flaky:0`), both minimality specs confirmed by name (#401,
  #452). One local-only detour: the first attempt 401'd on
  `activateFreshProPlusOrgWithSlug` with `PLAYWRIGHT_BASE=http://
  127.0.0.1:3200` — the session's own secure-cookie-on-127.0.0.1 trap
  (`reference_e2e_secure_cookie_needs_localhost`), fixed by using
  `http://localhost:3200` instead; no code change, a run-recipe correction.
- `npx turbo run lint` / `npx turbo run typecheck`: both **0 errors**
  (lint: the same 77 pre-existing warnings, none in a file this session
  touched).

**Fix mandate honoured: narrow.** The only production-code change this
verification session made is the one-line `nudgeForward` scope fix above,
found by following the brief's own instruction to confirm C9's
decomposition and C10's wire actually agree. Nothing else was touched;
nothing pre-existing was engineered around.

PR #583 body updated with these numbers, title's `[BLOCKED — pending wire
fix]` prefix dropped, marked ready for review (`gh pr ready 583`). NOT
merged — owner's call.

---

Branch `feat/c9-decomposed-repair-cpsat`, worktree
`.claude/worktrees/c9-decomposed`, off `origin/main` at `7477e3df` — carries
C5's 11 commits (deliberate, owner-ruled: C9 supersedes C5's solver call
while keeping everything else C5 got right; C5's PR #576 gets closed as
superseded once this merges, targeting `main`, never C5's branch).

**The wiring.** `repairDecomposedCpsat`
(`packages/engine/src/scheduling/repair-decompose-cpsat.ts`, new) replaces
C5's single monolithic `buildSchedule` call in `solveBoard`
(`schedule-ai-solver.ts`) with a decomposed one: `repairComponents` /
`dayCapGuard` (`repair-decompose.ts`) and `disjointConflictBound`
(`repair-minimality.ts`) reused UNCHANGED — verified end to end that they
are genuinely solver-agnostic, not merely asserted (`dayCapGuard` needed one
export added, no behaviour change). Each component gets its own
`buildSchedule` call, sequential, matching `build.ts:1196`'s
`withZ3LockAndReset` mutex (unchanged, out of scope per the brief).

**Density regression: CLOSED, measured.** 24 free / 40 fixtures (~60%
violator density), N=6, real placement service,
`PLACEMENT_WALL_SECONDS_MAX=60` (server-side — MUST be set explicitly; the
service defaults to 10s and silently caps every request below it otherwise,
see "environment trap" below):

| arm | wall ms (min/med/max) | blocking conflicts | moved | engine |
|---|---|---|---|---|
| z3 decomposed (old) | 5306 / 5778 / 5841 | 0 | 12 | z3 |
| CP-SAT monolithic (C5) | 10269 / 10343 / 10347 | **24** | 24 | greedy (fell back) |
| **CP-SAT decomposed (C9)** | **386 / 433 / 703** | **0** | 24 | optimized |

10/30 (moderate density, N=6): 166–317 ms, 0 blocking — faster than C5's own
433–817 ms, not a regression.

**Component-limit / budget constants: MEASURED, not inherited from z3's.**
`CPSAT_COMPONENT_MOVABLE_LIMIT = 40`, `DEFAULT_CPSAT_COMPONENT_BUDGET_MS =
10_000`. Curve (worst-case density — every fixture pairwise-clashing,
deliberately pathological, real components are far cheaper — see the
density table above):

| movable n | wall ms | outcome |
|---|---|---|
| 5 | 1403–1530 | `already_optimal`, instant |
| 10–30 | ~9.7–10.5s | plateaus at the 10s budget, falls back to greedy, 0 blocking every time (safe, not optimal) |
| 60 | 26–28 ms | `buildSchedule`'s own R22 size gate (`canSolveWithin`) declines instantly |

**The frozen-feeder straddle: TWO shapes, only ONE closes.** C4's original
finding (real, named entrants on both ends of the dependency) is CLOSED:
`repairComponents` unions on every `dependencies` edge, so a violator and
its frozen feeder always land in one component; the feeder is folded into
`existing` (see "design pivot" below for why, not left genuinely movable);
`nudgeForward` (a narrow, real-verifier-only forward search, never a
general repair mechanism) closes the resulting dependency-drop. Verified
against the real placement service, both directions:
`repair-decompose-cpsat-integration.test.ts` proves the fix AND proves the
identical board reds through a single monolithic `buildSchedule` call (the
C5 shape) — a genuine fix, not a coincidence of the board.

**The bracket/TBD-sibling case — what actually parked C5's PR #576 — is
NOT closed. This is a finding that CONTRADICTS this brief's own "REFUTED"
note (line ~250-256 of the brief as originally written), found by
re-running `scripts/repro-ai-bracket-frozen-feeder.ts` directly against
this session's implementation, not assumed from the brief's text.**
Measured:

```
repair: {"engine":"llm","solver_ran":true,"status":"unrepaired","moved":0,
         "unresolved":2,"residual":8,"components_solved":0,
         "components_skipped":1,"fallback":"unrepaired"}
blocking: 8 person_overlap rows (unchanged)
```

Root cause, confirmed directly against the real placement service via a
temporary diagnostic (reverted, `git status --porcelain` clean afterward):
both TBD fixtures (the final, the third-place playoff) have `home`/`away`
both null — `toSchedulableFixtures` (`schedule-ai.ts`) correctly omits both
fields for a genuinely undecided bracket slot, per its own established
contract — so their `entrant_indices` are EMPTY on the wire.
`services/placement/src/placement/schema.py` refuses ANY fixture with empty
`entrant_indices` outright (`INVALID_REQUEST`, silently — no log line,
commit `f04a597a`, 2026-08-10, predates C5 entirely): `"fixtures[0].
entrant_indices must not be empty. A fixture with no entrants joins no
participant group, so the participant-rest NoOverlap and every T2 idle-gap
term skip it."` `buildSchedule` is never reached for a component containing
a TBD sibling, REGARDLESS of decomposition — the wall applies with one
component or forty, so no amount of graph restructuring closes it.

Decomposition genuinely closes the ORDER/dependency aspect (see above), but
the recursive `person_overlap` BETWEEN two TBD siblings is a SEPARATE
problem: the wire's `entrantIds` (derived only from `home`/`away`) is the
ONLY participant-overlap channel CP-SAT has, and `people` (where "everyone
who could still reach this slot" actually lives — #396's own mechanism) is
never forwarded to the wire at all. Confirmed with a live placement-service
call: a synthetic 4-fixture board with two movable, entrant-less "TBD"
fixtures sharing `people` is rejected `INVALID_REQUEST` before any solve;
the identical board with synthetic-but-DISTINCT entrant ids on the TBD pair
(masking the wire gap rather than closing it) reaches the solver but then
places both TBD fixtures at the same instant anyway, since CP-SAT has no
information that they must not overlap — confirming this is not a
component-boundary problem decomposition can address, it is a wire
EXPRESSIVENESS gap. Closing it needs the wire to carry a `people`-shaped
NoOverlap concept the Python model does not have today — a proto /
`placement-client.ts` / `services/placement/**` change, well outside this
task's stated file set. **Reported per this task's own explicit
instruction to stop and report a contradicted premise rather than engineer
around it under time pressure — not attempted here.**

**Consequence: `scripts/smoke.ts:9755`/`:9768`/`:9780` (the "v4 AI/bracket"
canary, #396/#399/#401) remain RED, unweakened.** This is this task's
primary, explicit acceptance gate, and it is NOT closed. Confirmed these are
the ONLY 3 failures in a full smoke run (874 passed / 3 failed / 877 total,
`SCHEDULING_AI_BASE_URL` exported — without it the AI section silently
doesn't run at all, the exact vacuous-green shape that let C5 ship two real
reds believing it was green). The safety story holds throughout regardless:
`solveBoard`'s own re-verification never once reports an illegal or
falsely-clean board — the decline is honest and the board falls through to
the LLM round exactly as it did with C5's guard in place, just reached via
a genuine attempt (`solver_ran:true`) rather than a pre-emptive one.

**C5's frozen-feeder guard (`a59a9916`): REMOVED.** It declined
INDISCRIMINATELY on any dependency-touches-frozen-feeder shape, including
the general (non-TBD) case C9 now genuinely fixes. Removing it lets
decomposition repair what it can; for the TBD-sibling shape it cannot
reach, the empty-entrant wall provides the identical safe outcome (decline,
fall to LLM) via a more honest mechanism (a genuine attempt that fails, not
a pre-emptive skip that never tries).

**Design pivot, measured not guessed: why a frozen feeder is folded into
`existing`, not left genuinely movable.** First design tried: pass a
caller-frozen component member as a genuinely movable `buildSchedule`
fixture, so its dependency edges survive `freeFixtureIds`. Measured
directly against the real placement service and REJECTED:
`buildSchedule`'s own objective ladder (`days`/`day_span`/`day_start`/
`idle_gap`/`imbalance`) rewards compactness with nothing anchoring a
fixture to `current`, so a frozen feeder with any window slack ahead of it
gets relocated even with zero other fixtures in play — a lone feeder with
60 minutes of slack was moved a full hour with nothing else to solve.
Reconciling after (discard the whole component if a frozen member came
back moved) would then discard nearly every component with any slack at
all — the opposite of what decomposition exists for. Shipped design: every
caller-frozen component member is folded into `existing` (structurally
incapable of drifting, identical mechanism to C5's own), and
`nudgeForward` closes the resulting dependency-drop instead.

**Minimality: RECOVERED, verified end to end against the real stack, not
assumed from unit coverage alone.** `disjointConflictBound` never touched
z3 — reused unchanged. `ai-architect.spec.ts`'s two single-clash specs
(#401, #452) both now assert `data-minimality="proved"` (previously
`"unknown"` after C5) — confirmed by first running the suite UNMODIFIED and
watching #452 fail exactly as expected (`data-minimality` genuinely
rendered `"proved"` against an assertion still pinned to `"unknown"`)
before updating either assertion. Mutation-checked at the unit level too:
forcing a component to move an unnecessary second fixture drops the
verdict to `upper_bound`.

**Environment trap hit and resolved this session, recorded for the next
one:** `PLACEMENT_WALL_SECONDS_MAX` defaults to **10** seconds
(`services/placement/src/placement/config.py`) when the placement service
is started without it set explicitly — NOT the `wallMs`/budget value a
caller passes per-request, which is silently capped underneath. The very
first density-bench and calibration runs this session were capped at ~10s
regardless of a 30–60s requested wall, producing numbers that could not be
trusted; re-run correctly once caught. C5's own bench avoided this by
setting it — this session initially missed it despite the standing
`AGENTS.md` warning quoting the exact env var, which is worth flagging: the
warning describes WHY (the density bench needs it to rule out the 10s
default as the cause) but the recipe to actually SET it when starting a
LOCAL placement service for ad hoc verification is easy to skip since nothing
enforces it and a capped run still returns a plausible-looking answer.

**Verified (all real, fresh DB per run, real placement service, real prod
build for e2e):**
- engine: `repair-decompose-cpsat.test.ts` (13, mocked driver logic) +
  `repair-decompose-cpsat-integration.test.ts` (3, real placement service)
  — 16/16 alone. Full `test:coverage`, ISOLATED (no concurrent suite):
  **4020 total / 3990 passed / 11 failed / 19 pending, `success: false`**
  on the first isolated pass — traced, not accepted at face value:
  - **8 of the 13 in `repair-decompose-cpsat.test.ts` itself** — this
    task's OWN new file, mocked, deterministic, zero DB/network
    dependency, 13/13 alone. Root cause: it used a hoisted top-level
    `vi.mock("./build.ts", ...)`, but `packages/engine/vitest.config.ts`
    runs `isolate: false` (shares the module cache across every file in a
    worker; its own header names the identical class of bug in
    `build-lns-wiring.test.ts`: "not the machine, not the wall — FILE
    ORDER"). A hoisted mock is not reliably scoped to one file under that
    setting once real siblings importing `./build.ts`
    (`build.test.ts` and others) share the worker. Fixed by matching this
    repo's own proven pattern (`build.test.ts:750-807`): per-test
    `vi.resetModules()` + `vi.doMock()` + a fresh `await import(...)`,
    unmocked again in `afterEach` — cannot leak in or out by construction.
    Proved both directions with a forced `--maxWorkers=1` pairing repro
    (worst-case single-worker sharing): unfixed, alone it was 13/13 but
    failed identically to the full run when paired with `build.test.ts`;
    fixed, paired with `build.test.ts` it is 86/86 (that file's own 73 +
    this file's 13), and paired with `roundrobin.test.ts` +
    `placement-integration.test.ts` + `repair-decompose.test.ts` together
    it introduces no failure in any of them either.
  - **`roundrobin.test.ts` (1) and `placement-integration.test.ts` (2)** —
    confirmed pre-existing and unrelated, not this diff: both files are
    byte-identical to `origin/main` (`git diff origin/main -- <path>`,
    zero output; zero commits on this branch touching either), and
    neither is reachable from `repair-decompose-cpsat.ts`'s own import
    graph. Traced past the wrapper first, since the harness's own
    transparent hook rewrites even a literal `npx vitest` invocation
    through `rtk` (per this machine's global `RTK.md`) and redacted the
    real failures as `STACK_TRACE_ERROR` even inside the `--outputFile`
    JSON's `failureMessages` — `rtk proxy npx vitest run <file>` for the
    unredacted text was necessary to read them at all. Real cause:
    `placement-integration.test.ts`'s 32-fixture/5-court case
    deterministically pegs the full server-granted 30s wall every run
    today (`solver_elapsed_ms` 30015-30020 across four separate
    invocations, `status: FEASIBLE`, only 2/3 tiers — a genuine
    budget-exhaustion case, not noise), against the test's own hardcoded
    20s vitest timeout — a pre-existing mismatch in a file this task
    never opens. `roundrobin.test.ts` dying with a bare
    `STACK_TRACE_ERROR` is the exact memory-pressure signature
    `vitest.config.ts`'s own header already documents by name for that
    file. Left alone — out of this task's scope and already proven
    unrelated, not silently patched over.
  - The other 0 (19 pending are pre-existing skips, unrelated).
  - **Final isolated re-run after the fix: 4020 total / 3998 passed / 3
    failed / 19 pending, `success: false`.** All 3 remaining failures
    are the two pre-existing files above (`repair-scale.test.ts`'s
    "500-movable board returns inside its budget rather than hanging",
    a z3 timing test whose own header says its 3s budget is deliberately
    NOT scaled for a loaded host, plus `placement-integration.test.ts`'s
    same two) — both confirmed byte-identical to `origin/main`, zero
    commits from this branch touching either. This diff's own file
    (`repair-decompose-cpsat.test.ts`, 13 tests) is fully green in the
    full run.
- apps/web: `src/server src/lib` DB-backed run, FRESH DB (`db:apply` +
  `sync:sports` on a brand new scratch Postgres, port confirmed mine via
  `show data_directory`) — **4864 total / 4813 passed / 2 failed / 49
  pending.** The 2 failures (`help-copy-truth.test.ts`,
  `pass-scoping-guard.test.ts`) are byte-identical to `origin/main`, zero
  commits on this branch touching either, `STACK_TRACE_ERROR`-redacted
  (the machine's global `RTK.md` hook rewrites even a literal `npx`
  invocation through `rtk` transparently — `rtk proxy` needed for the
  real text), and reproduce clean 115/115 re-run together in isolation —
  the same transient-under-contention signature as the engine suite's
  two, just in apps/web this time. An EARLIER run this session (before
  this fresh-DB pass) showed 7 failures, ALL in three C5-era test files
  mocking `buildSchedule` directly — `schedule-ai-repair.test.ts`,
  `competition-schedule-ai-repair.test.ts`,
  `schedule-ai-repair-cpsat-wiring.test.ts` — whose mock point went inert
  the same way `schedule-ai-solver.test.ts`'s did; all three repointed at
  `repairDecomposedCpsat`, the REGRESSION tests whose own guarantee moved
  to the driver level adapted to prove what's still true at the runner
  layer. Includes `schedule-ai-solver.test.ts` rewritten for the new seam
  (15/15).
- e2e: `ai-architect.spec.ts --project=parallel`, real prod `standalone`
  build served by `node server.js` (never `next start`), real placement
  service, this same fresh DB — **16/16** (`stats.expected: 16,
  unexpected: 0, flaky: 0, skipped: 0`), both minimality specs confirmed
  present by name (#401, #452). An EARLIER run this session, before
  fixing the minimality regression, correctly went 11 passed/1 failed at
  the #452 check — the expected-and-verified signal before the fix.
- smoke: **881 passed / 3 failed (884 total)**, `SCHEDULING_AI_BASE_URL`
  exported pointing at the script's own fixture server
  (`AI_FIXTURE_PORT` 4319, set identically on the smoke process and the
  server-under-test) — confirmed NOT vacuous: zero `SCHEDULING_AI_BASE_URL
  unset` skip lines anywhere in the run, `placement optimized` suite
  fully green (4/4, real `engine="optimized"` assertions), and the 3
  failures are real named `v4 AI/bracket` assertions. The 3 failures are
  exactly `scripts/smoke.ts:9756`/`:9768`/`:9780` (an earlier note in
  this doc cited `:9755`, one line off the string literal itself — same
  three) — confirmed byte-identical to `origin/main`, **unmodified**,
  exactly the outcome this task's own bracket/TBD finding above requires.
- `npx turbo run typecheck` and `npx turbo run lint` — the actual CI
  gate, not the scoped per-package checks this task ran earlier — both
  **0 errors** (lint: 77 pre-existing warnings in apps/web, none in a
  file this task touches). Caught one real error the scoped checks
  missed: `repair-decompose-cpsat.test.ts`'s untyped `vi.fn()` left
  `mockImplementationOnce`'s expected signature resolving to a
  void-returning function, tripping
  `@typescript-eslint/no-misused-promises` on every async implementation
  supplied — fixed by typing the mock to `buildSchedule`'s real
  signature (separate commit).
- `git rebase origin/main`: confirmed literal no-op — "Current branch
  ... is up to date" (`origin/main` still `7477e3df`, unchanged since
  dispatch).
- `openapi:gen`: zero diff — `minimality`/`components_solved`/
  `components_skipped` were already declared on the wire, unused, since C5;
  no schema change owed.

**C8 narrowed** (`C8-z3-delete-solver.md`): `repairComponents`/
`dayCapGuard` (`repair-decompose.ts`) and `disjointConflictBound`
(`repair-minimality.ts`) are C9's own production dependencies now, not
just z3 leftovers sharing a file — C8's original "z3 reflow/repair code
paths... their tests" wording would have deleted `repair-decompose.ts`
wholesale, taking this task's own driver down with it.

PR: https://github.com/ashokhein/seazn.club/pull/583 (targets `main`;
carries C5's 11 commits too — #576 should close as superseded once this
merges).

### C7 — z3 public contract retirement (2026-08-17)

Branch `feat/c7-z3-public-contract`, worktree `.claude/worktrees/c7-z3-contract`,
off `252a073d`.

**The gate as written could not be evaluated, and the reason matters.** The
brief gates on "C4 + C5 **deployed**". C5 was superseded by C9 (`8b85ab39`), so
the first half names a PR that closed. The second half assumes a production
environment: `prod.yml` fires on a version tag, has **zero runs**, and its own
header records that the `seazn-club-prod` Fly app does not exist yet. There is
no production deploy for a narrowed enum to break. What the gate reduces to is
staging, which is at `252a073d` with a green deploy — so it is satisfied, but
by a different argument than the one written down.

**NO MIGRATION WAS OWED, and this is the finding.** The brief's step 1 ("rewrite
rows `engine z3|z3+lns → optimized`") and the design's premise (`"z3"` is
"**stored** in board rows") are both false. Four independent checks:

- `git grep -a -i -l z3 -- db/` returns nothing. No CHECK constraint, no
  Postgres enum type, no column named engine/solver/repair.
- On a live schema, `information_schema.columns` has zero columns matching
  `engine|solver|repair`; every candidate is a `jsonb` blob, and no write path
  puts a solver engine value into one.
- `ScheduleSolverInfo.parse` / `AiRepairReport.parse` appear **only** in
  `__tests__`, always over a freshly computed response. No production read path.
- `ScheduleConfig` (`schemas.ts:843-894`) — the schema `_RULES.md` warns is the
  READ path — has no engine, solver or repair field at all.

So the "rewrite-then-narrow order is mandatory" instruction, the load-bearing
part of the brief, protects against a hazard this repo does not have. The
ordering was still honoured in spirit: the demo fixture (the one committed
artefact that DID carry a retired value) was rewritten in the same PR.

Recorded here rather than acted on: had the migration been written anyway it
would have needed **V365**, not the "next free" V363 — the in-flight RS001
registration branch holds unmerged V363 and V364.

**`z3_unavailable` belonged to this stage and no brief said so.** The
acceptance criterion is "openapi snapshot has zero `"z3"` occurrences (was 3)".
The real count was **5**, in `v1.public.json` AND in `v1.json` (the brief names
only the public one; the same generator writes both). Two of the five are the
`status` member `z3_unavailable`. Nothing has produced it since C4/C9, and
`solver_unavailable` — added by Task 06b explicitly because "the NAME is
misleading once z3 is gone" — already renders through the identical i18n key.
Owner ruled on 2026-08-17 to retire it here. Without that, the stated
acceptance is unreachable by construction.

**Two live smoke assertions had gone vacuous, found by sweeping for comparisons
rather than for prose.** `scripts/smoke.ts` compared `solver.status` against
`"z3_unavailable"` in two places (`!==`, in the BUILD and POLISH suites). Once
the API cannot emit that value those comparisons are constantly true — checks
that can no longer fail. Both now name `solver_unavailable`. This is the same
defect shape C6 recorded against `schedule-capacity-guard.test.ts`'s
`z3LoadCount`, in a file C6 had classified `ACCURATE_TODAY`.

**The brief's `file:line` citations had all drifted.** `schemas.ts:1016` and
`:2190` are really **`:1229`** (`ScheduleSolverInfo.engine`) and **`:2592`**
(`AiRepairReport.engine`). The brief's five-file set also missed three
load-bearing sites: `apps/web/src/lib/i18n-keys.ts`, `scripts/smoke.ts`, and
the drift test itself.

**Five unions, not two.** Narrowing the two Zod enums alone does not compile:
`schedule.ts` assigns the engine's `BuildResult["engine"]` and `BuildStatus`
into them one-for-one. So `build.ts:574` and its `BuildStatus` moved too, and
`schedule-ai-solver.ts:136`'s `RepairEngine` with them. `tsc` found the 13
consumer sites; **it could not find the runtime ones** — three enum loops in
`schedule.test.ts` iterate plain `string[]`, so they typecheck clean and would
have failed at runtime. Swept with a literal grep afterwards, which is what
caught them.

**Left for C8, deliberately:** `build.test.ts`'s two `it.skip` blocks
(`:818` asserting `z3_unavailable`, `:1262` asserting `engine === "z3"`) now
assert values their unions forbid. They are skipped, so they cannot fail, and
the file's own comment says stage E deletes them with `z3-load.ts`. C8 must
actually delete them rather than inherit them — a skipped test that asserts an
impossible value is exactly the "skip is load-bearing" shape.

**Ledger:** `OWNED_BY_C7` is now empty. Seven of its ten files lost their last
z3 mention; three (`schemas.ts`, `result-strip.tsx`, `result-strip.test.tsx`)
kept accurate past-tense prose explaining why a member is absent and moved to
`ACCURATE_TODAY`. Two files that were in `ACCURATE_TODAY`
(`schedule-board-polish.test.tsx`, `ai-diff-repair-strip.test.tsx`) left the
ledger entirely — their only z3 was a fixture value this task rewrote. The
new `z3-contract-retired.test.ts` joined it. The two-directional assertion
caught every one of those four moves; none was predicted.

**Numbers** (JSON reporter, brand-new database, `PLACEMENT_SERVICE_HOST` unset
in BOTH arms):

- base arm, `origin/main` content: **4938 passed / 4 failed / 5004 total**,
  499 files. All four reds are `schedule-build-honours-locks.test.ts`,
  `expected undefined to be '2026-08-01T19:00:00.000Z'` — the placement service
  being unreachable, not the branch.
- engine base arm: **3999 passed / 0 failed / 4031**.


### C8 — z3 stage E, delete the solver (2026-08-17)

Branch `feat/c8-z3-delete-solver`, worktree `.claude/worktrees/c8-z3-delete`,
rebased onto `298da0af` (C7).

**THE FILE SET IN THE BRIEF IS AN UNDERCOUNT, and the reason generalises.**
The brief — and `OWNED_BY_C8` — listed the files that *mention* z3. What a
deletion actually costs is the files that stop *compiling* once those are gone,
and that is a different, larger set. The brief named 9 files; the diff is 57,
−10 274 lines. Everything extra was found by running `tsc` after each cut, not
by reading the ledger:

- `build-encode.ts` (the boolean model) and `build-lns.ts` (its LNS fallback)
  had **zero production callers** — only their own tests, plus a one-line
  `BuildConfig` type `build.ts` imported. Same shape as `repair.ts`: dead code
  kept compiling for its own tests. `BuildConfig` moved into `build.ts` (it
  never had anything to do with z3) and both modules went.
- Four more engine test files went with them: `build-encode-parity`,
  `build-encode-rules`, `build-lns`, `build-lns-wiring`.
- Five benches, not two. `bench-repair`/`bench-decompose` were named; `bench-reflow`,
  `bench-ai-repair-cpsat`, `probe-lns-gate` and `repair-cpsat-harness` all exist
  to compare a CP-SAT arm against a z3 arm, and cannot run their own baseline
  once z3 is gone. Their gates were passed and merged in C4/C9.
- The pnpm **public-hoist pattern** (`pnpm-workspace.yaml`) and the
  **Dockerfile** note both name the three `serverExternalPackages`. Neither is
  in any ledger; both would have gone stale silently.
- **Eleven `apps/web` tests** spied on z3 to prove it was NOT called. Every one
  of those negative assertions becomes structural when the function stops
  existing — there is nothing left to fail.

**`z3-load.ts` could not be deleted as the brief scoped it.** `build.ts:116`
imported `withZ3LockAndReset` and used it at `:1210`; eleven `build-*.test.ts`
files imported `resetZ3` as a hygiene guard. All were `ACCURATE_TODAY`, i.e.
outside C8's brief. Owner ruled 2026-08-17: delete outright rather than keep a
stub. `build.ts:2404` already called the wrapper vestigial, and after the
deletion there is no z3 to reset, so the guards were inert by construction.

**THREE COVERAGE LOSSES, recorded because they are real and none is repaired
by this PR.** Each existed only because a process-wide z3 lock existed:

1. `build-teardown.test.ts` — DELETED. Every case mocked `z3-solver` or the
   encoder. Nothing now asserts that two concurrent runs queue rather than
   pile up. `MAX_SOLVER_QUEUE` is still applied in `build.ts`; its test is owed.
2. `schedule-auto-solver-busy-latency.test.ts` — DELETED. It staged
   `solver_busy` by *holding the z3 lock* so two solves could not settle. With
   the lock gone there is no way to hold `queued` at its cap from the barrel:
   the real solve completes and decrements. Restoring it means hanging
   `placement-client`, which is a rewrite this task did not attempt rather than
   one it botched.
3. `schedule-capacity-guard.test.ts` — the `z3LoadCount()` assertion is gone
   (C6 had already recorded it as vacuous since C4 and due to die here). The
   422 still proves the guard fired; the "never reached the solver" fact is
   untested. A `placement-client` spy restores it.

`build-wall.test.ts` was TRIMMED, not deleted — its R23 half spied on
`encodeBuild`, its R22 half tests `canSolveWithin`, which is pure and still
live. The last R22 case went too, because its only observable was the encode spy.

**A deletion nearly took a guard's only coverage silently.** `dayCapGuard()`
survives (C9 reuses it), but every test that exercised it did so *through*
`repairDecomposed` — so deleting the driver would have left the function
compiling, exported, called in production, and untested, with the remaining
assertions in its own `describe` all about `repairComponents`. Three direct
unit tests were added, including a no-cap case, because the two positive ones
pass against a guard that refuses unconditionally.

**Two of my own gates were vacuous when first written**, both caught by writing
the failing test first:

- `z3-dependency-retired.test.ts` used a bare `git grep`, which scopes to the
  cwd — vitest runs it from `packages/engine`, so every `apps/web` pathspec
  matched nothing and two of six cases passed against a tree that still
  declared the dependency in both manifests. Fixed with `git -C <root>`.
- Scoping it to the live trees (so historical design docs may keep quoting the
  deleted source) then made every case a "grep found nothing" assertion, which
  is also what a misaimed pathspec returns. A non-vacuity control was added.

**The engine's own control caught the change, as designed.**
`packages/engine/test/runtime-deps.test.ts` lists every expected runtime import
BY NAME, `z3-solver` included. It went red on the removal. Edited deliberately
with the reason in the comment — not loosened to a length check.

**Prod-build proof** (the brief's point: this change ships a silent prod no-op
if either half of the WASM pair is left):

- `npm run build` exit **0**.
- No `z3-built.wasm` anywhere under `.next` (only Next's own `@vercel/og` wasm).
- No `z3-solver` directory in the standalone output.
- `.next/standalone/node_modules/` contains exactly `exceljs` and `pdfkit` —
  the two remaining `serverExternalPackages`.
- The standalone server boots, serves HTML **200** and a real hashed static
  asset **200**, and both scheduling routes reach their handlers (structured
  `NOT_FOUND` / Zod `VALIDATION`), proving the engine module graph loads and
  executes without the deleted package. No `MODULE_NOT_FOUND` in the log.

**Numbers** (JSON reporter, brand-new database, `PLACEMENT_SERVICE_HOST` unset
in both arms):

- `packages/engine`: **3876 passed / 0 failed / 3889**, 138 files.
- `apps/web` (`src/server src/lib src/components src/__tests__`):
  **7311 passed / 4 failed / 7380**, 741 files. The four are
  `schedule-build-honours-locks.test.ts`, identical to C7's base arm —
  the placement service being unreachable locally.
- drift gate: **19 / 0**. Both `OWNED_BY_C7` and `OWNED_BY_C8` are now empty.
- dependency proof: **7 / 0**.
- `npm run typecheck` exit **0**; `rtk proxy npm run lint` exit 0,
  `✖ 77 problems (0 errors, 77 warnings)` — same warning count as C7.

### C8 follow-up — the three coverage losses, CLOSED (2026-08-17)

Branch `test/c8-coverage-gaps`. **No production behaviour changes**: three
tests, one engine `exports` subpath, and the comments that said the coverage
was owed.

**ONE SEAM CLOSES ALL THREE, and it is the one the losses named.** Each fact
above was staged by a process-wide z3 lock, and each is restaged by holding —
or watching — `placement-client.solveBuild`. `build.ts` reaches it through a
DYNAMIC `await import("./placement-client.ts")` (its own comment at the import
says why), so a spy on that module namespace IS the call the engine makes.

**`@seazn/engine/scheduling/placement-client` is now an exports subpath.** The
web lane could not otherwise reach the module the engine imports internally,
and the seven sibling `./scheduling/*` subpaths make it the idiomatic move
rather than a vitest alias private to one config. Nothing in `apps/web` calls
it in production and nothing should — the header comment says so.

1. **Two solves in flight, refused third, boards not crossed** —
   `build.test.ts`, appended to the existing `describe("buildSchedule — the
   solver queue cap")`. The sibling case there judges the cap from the outside
   on statuses alone, and with no `PLACEMENT_SERVICE_HOST` every admitted call
   rejects inside `solveBuild` and returns greedy: a build refused BEFORE the
   client and one that called it and fell back are indistinguishable, and
   nothing is ever concurrent except the counter arithmetic. The new case parks
   two solves inside the client and proves `solveBuild` was called exactly
   **twice** while the third came back `solver_busy` — the refusal never
   reached the service — then releases and proves each caller got ITS OWN
   board. The stub keys its board off the REQUEST, never off arrival order: an
   order-keyed stub answers correctly even when the caller/board pairing is
   crossed, which is the corruption the case exists to catch.
2. **`schedule-auto-solver-busy-latency.test.ts` — restored**, same claim,
   new stage. The client is held open instead of the lock; the third
   `autoSchedule` must settle inside 10 s (structural, not timed — a call that
   reaches the client cannot settle at all until the test releases it), report
   `solver_busy` + `greedy` + a non-empty board, and leave the spy on **2**
   calls while `solver.entered` is 3. The live-cooldown assertion is kept
   verbatim: the original point was that a limiter on this path destroys the
   fast refusal.
3. **`schedule-capacity-guard.test.ts`** — `expect(solveBuild).not
   .toHaveBeenCalled()` replaces the deleted `z3LoadCount()` assertion, and its
   PAIR is the file's existing loosened-window case, which asserts the same spy
   on the same seam IS called. A zero-call assertion alone is satisfied by a
   spy wired to a module nothing imports; the pair is what makes it a fact.

**Every one proved by mutation, on production code, restored after:**

| mutant | result |
| --- | --- |
| `queued >= MAX_SOLVER_QUEUE + 5` (cap unreachable) | engine case RED in 10.2 s (`'pending'` where `'settled'` expected); latency test RED in 10.3 s |
| `solveBuild(input)` without the `.finally` decrement | engine case RED in 274 ms (fourth build refused) |
| `guardCapacity(...)` moved BELOW the solve call | capacity case RED — and the mutant still throws 422, so the 422 assertion passed and ONLY the new line caught it |

The first mutant originally red-ed by burning the whole 120 s test timeout;
the third call is raced against a 10 s window specifically so the failure says
what went wrong instead of what took too long.

**Numbers** (JSON reporter, fresh DB on :54341, `db:apply` + `sync:sports`):

- `packages/engine` full: **3877 passed / 0 failed / 3890**, 962 describes.
  Baseline on the same tree with the diff removed: 3876 / 0 / 3889.
- `apps/web src/server/usecases/__tests__`: **2298 passed / 4 failed / 2339**.
  The four are `schedule-build-honours-locks.test.ts` — reproduced with the
  diff reverted (7/4/11 either way, and with `PLACEMENT_SERVICE_HOST` unset
  too), i.e. C8's own base arm: that suite needs a reachable placement service.
- `npm run typecheck` exit **0**. `rtk proxy npm run lint` exit 0,
  `✖ 76 problems (0 errors, 76 warnings)`; `packages/engine` lint exit 0.

**A flake found on the way, not caused here and not fixed here.**
`swiss.test.ts`'s "chess colour bounds hold (n up to 64)" is an `fc.assert`
property with no seed and no timeout override: it times out at vitest's 5 s
default roughly **1 run in 6** on a loaded machine (measured 1/6 alone, plus
once in a full-suite run; the baseline arm happened to be green). It is a
clock, not a counterexample — the failure message is "Test timed out in
5000ms", never a shrunk case.
