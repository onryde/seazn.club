"""CP-SAT model for BUILD/POLISH fixture placement.

This is the benchmark-validated model from `services/cp-sat/bench/cpsat_bench.py`
(`build_model`, the "REWRITE v2" interval/`NoOverlap` encoding), promoted into
the service package. The MODELING is a faithful port — same variables, same
constraint families, same presolve knobs. What changed is only the boundary:

  * inputs are plain Python mirroring `proto/scheduler.proto`'s
    `SolveBuildRequest`, not the bench's `Board` dataclass;
  * `match_minutes`, `gap_minutes`, per-division rest and per-division day cap
    come from the request instead of module constants;
  * the solve loop is wrapped in `solve()` returning a `SolveOutcome`;
  * the sweep's JSON instrumentation is gone;
  * the bench's greedy warm-start hint is NOT ported — see below.

--- round 6: identity is POSITIONAL, not string-based ------------------------

Every id-shaped string this module used to key on — `fixture_id`, `court`,
`division_id`, `entrant_id` — is gone. A fixture's identity is its position in
`fixtures`; a court's is its position in the caller's `court_names`, carried
here only as a COUNT (`num_courts`); a division's or entrant's identity is a
caller-assigned index. `cp_sat.schema` is the ACL that enforces every index is
in range before this module ever sees it — this module's OWN tolerance of an
out-of-range dependency index (skip rather than crash) is unchanged from the
string contract's `id_to_idx.get(...) or continue`, just re-expressed as a
bounds check instead of a dict miss.

Two concrete consequences, both mechanical, neither a modelling change:

  * `presence_court`, `court_lists` and `by_entrant` are keyed on `int` now.
    `presence_court` and `court_lists` are DENSE (`num_courts` is available
    directly, so they are plain lists indexed 0..num_courts-1); `by_entrant`
    stays a dict (`dict[int, list[int]]`) because nothing here carries a
    declared entrant count to size a dense list against — only the indices
    that actually appear in `fixtures` are ever grouped, exactly as the
    string contract only ever grouped the entrant ids that appeared.
  * `FixtureVars.fixture_ids` is gone. It used to carry each fixture's own id
    string for `extract_assignments` to read back; a fixture's identity is
    now simply its position, always recoverable from `enumerate(...)`, so a
    parallel list that always equalled `range(n)` would have been dead
    weight.

--- DROPPED: the greedy warm start (`AddHint`) -------------------------------

In the bench this is a two-part mechanism, both parts in `cpsat_bench.py`:
`greedy_seed()` computes a first-fit placement once, and `run_full_chain()`
threads it into every tier as `build_model(..., hint=...)`, whose `if hint:`
block is what actually calls `model.add_hint` on `start[i]`, `placed[i]` and
`presence_court[i][slot.court]`. It mirrors z3's "greedy seeds the incumbent"
design, and **it is how the bench's published ~2.5 s full-chain number on the
production board was produced.**

(Cited by symbol deliberately. An earlier version of this note gave line
numbers; the Step 2b extraction moved every line in that file and the range
silently came to point at the middle of `build_model` instead — precisely the
misdirection this note exists to prevent.)

It is not ported here. It needs `board.slots` INDICES, which the service's
plain `(court, start_at_ms)` grid does not carry in the same shape, so it is a
real rewrite rather than a copy — and at T0 there is nothing to justify it
with: this model solves the production board in 80-145 ms unhinted, leaving no
headroom worth chasing. A hint cannot change correctness — CP-SAT repairs or
discards an invalid one — so nothing is at risk today.

**Note what has NOT been measured**: no hinted run of THIS model exists. The
80-145 ms figures are all unhinted. So the honest claim is "T0 is fast enough
unhinted", not "the hint makes no difference here" — the A/B was never run.

**SETTLED IN PROMPT 03: still not needed, and now for a measured reason.**
The full chain does cost far more than T0 alone — 4 940 ms against T0's 88 ms
on an idle box — and the tier that nearly sank it was T3, which sat at
FEASIBLE after 20 000 ms. A warm start would not have moved it by a
millisecond: T3 had ALREADY found the optimal board (2 400 000 ms, the
pigeonhole minimum) in well under a second and could not close its DUAL bound
from zero. Its incumbent was never the problem, and a hint supplies nothing
but an incumbent. The fix was the term's encoding (see T3 below).

The general lesson, which is why this note stays: when a tier here is slow,
read `BestObjectiveBound()` against `ObjectiveValue()` before reaching for a
warm start. If they are far apart the tier cannot PROVE what it has already
FOUND, and a hint is the wrong tool — every tier of this chain is solved to
proof, so proof time is what the budget buys. T0, T1 and T2 each reach
`bound == value` unhinted, so none of them is waiting on an incumbent either.

This module is domain logic and deliberately imports NOTHING from
`cp_sat.generated` — no proto types cross this boundary in either direction.
`cp_sat.schema` (Prompt 04) owns the proto->plain-Python translation.

--- THE BENCH HAS ITS OWN COPY OF THIS MODEL, AND IT HAS DRIFTED ------------

`bench/cpsat_bench.py` defines its own `build_model` (:378, called at :658)
and imports nothing from `cp_sat` at all. Prompt 02 extracted the board
GENERATOR into `bench/cpsat_bench_boards.py` precisely so the bench and the
service could not disagree about the board — but the MODEL was left
duplicated, so they can still disagree about everything else. The bench's copy
is STILL string-keyed; round 6 only touched this module and `cp_sat.schema`,
so `tests/` carries a small adapter that converts the bench's string-shaped
boards into this module's positional shape (see `tests/_board_positional.py`).

They already do. The `mk_hi >= mk_lo` clamp below (Task 05c) is in this copy
and not in the bench's (:542-547), so on a board where nothing is placed the
two report different makespans.

The consequence to hold on to: **a bench measurement is evidence about the
bench's model, not about this one.** Any timing or quality number quoted from
`bench/` has to be re-taken here before it can be said about the service.
Recorded rather than fixed: de-duplicating the model is Prompt 10's call, not
a side-effect of a contract-hardening task.

--- the two presolve knobs: keep them, but know what is and isn't proven -----

`symmetry_level = 0` and `cp_model_probing_level = 0` in `solve()` are carried
over from the bench unchanged. Be precise about the evidence for them, because
the obvious experiment does NOT support the strong version of the claim:

  * The trap is real and on record — CP-SAT's default symmetry detection and
    probing presolve consuming the entire wall on a symmetric board and
    failing SILENTLY (`UNKNOWN`, zero placed, no error). But that was observed
    under the bench's **v1 boolean fixture x slot grid** encoding, on the
    larger sweep boards. It has NOT been shown to reproduce on this
    interval/`NoOverlap` model.
  * Measured here, production board, T0, identical model both ways:
        knobs set     -> OPTIMAL, 37 placed, 145 ms
        knobs default -> OPTIMAL, 37 placed, 424 ms
    So on THIS board they are a ~3x speedup, not the difference between an
    answer and no answer.

They stay because the failure they guard against is silent and catastrophic
while the cost of keeping them is nil, and because the larger boards that
originally exhibited it are exactly the ones this service is being built to
accept. But **nothing currently tests their necessity** — no test fails if you
delete them. A mutation pass over this module will therefore report them as a
surviving mutant. That is expected; it means "not covered", not "not needed".
Do not delete them on the strength of a green suite. If their necessity has to
be settled properly, the experiment is a board large enough to reproduce the
v1 observation, not this one.

--- what the wire contract cannot carry (and this model therefore cannot state)

Three constraint families the bench models are NOT expressible from
`SolveBuildRequest` as it stands. They are listed here rather than silently
omitted, because each one makes this solver's answer strictly more permissive
than z3's, and TS re-runs its own verifier on the result:

  * build-encode.ts section 5, per-fixture start windows (`notAfter`).
    `Fixture` carries (entrant_indices, division_index) only.
  * build-encode.ts section 7's PARTICIPANT-REST half. `existing` rows arrive
    as `PinnedRow (court_index, start_at_ms)` — no entrant list, and as of
    round 6 no fixture identity of any kind — so only the court-turnaround
    half of section 7 survives; a pinned row still blocks its own court but
    no longer blocks a participant it shares.
  * per-court grids. `admissible_starts` is the union of every slot's start
    across all courts (exactly as the bench does, where every court offers the
    identical tick set), so a court with a DIFFERENT slot set — a per-court
    blackout — can receive a fixture at a tick it does not offer. Measured:
    with C0 offering {T, T+40} and C1 only {T+40}, a fixture was placed on C1
    at T, OPTIMAL; and with C1 declared but slotless, on C1 at any tick at all.

    **This is NOT unclosable, and an earlier version of this note said it was.**
    `cp_sat.schema._validate_court_slot_coverage` now REFUSES any request
    whose courts do not all offer the same start times, so the wrong board is
    unreachable — at the cost of the capability: a per-court blackout is
    rejected rather than mis-scheduled, and the caller falls back to its own
    placer.

    Closing it here INSTEAD, and getting the capability back, is a bounded
    change and is the right one if callers turn out to need it: give each
    fixture an enforced per-court start domain,
    `AddLinearExpressionInDomain(start[i], Domain.FromValues(starts_of(c)))
    .OnlyEnforceIf(presence_court[i][c])`, emitted only for courts whose tick
    set is a strict subset of the union, so a homogeneous board pays nothing.
    Not done here because it is a solver-hot-path change that no task has
    asked for and that needs its own timing evidence.

A fourth is CLOSED, and is recorded because the fix shows where the seam
sits. Day-cap buckets used to be `start_ms // DAY_MS`, a UTC day, so any org
not on UTC had its caps applied against the wrong boundary — at UTC+10 a
09:00 and a 19:00 local match on one day fall in two UTC buckets and a cap of
one admits two. The contract now carries a pre-computed `Slot.day_index`: the
caller resolves each slot to the org's local calendar day and sends the
integer, and this module groups by it. Timezones-as-policy stay outside this
bounded context; the solver never reasons about a zone. Computing that index
is the caller's obligation and getting it wrong reintroduces the same bug one
layer up, which is Prompt 06's problem and needs its own test there.

A FIFTH is open and is a real permissiveness gap, listed here with the three
above rather than left to be rediscovered: **`existing` rows are not counted
against day caps.** `on_day` is built for movable fixtures only, so a pinned
row on a capped day does not consume that day's allowance and the solver may
add another. It cannot be fixed by adding `day_index` to `PinnedRow` alone —
caps are PER DIVISION and `PinnedRow` carries no division at all (round 6
removed even its fixture identity) — so a pinned row cannot be attributed to
any cap. Closing it needs a `division_index` on `PinnedRow`, which is a
contract addition nothing has asked for yet.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ortools.sat.python import cp_model

MIN_MS = 60_000
DAY_MS = 86_400_000

# Tier names are fixed protocol constants shared with the TS side (see the
# design spec, "Tier/objective semantics are a fixed protocol constant") and
# they live in `cp_sat.objective`, with the chain that uses them — all four in
# one place, since the ORDER is as much of the constant as the names are.

# Same as the bench. CP-SAT's own default is the machine's core count; pinning
# it keeps solve behaviour reproducible across the dev box and the deploy box.
NUM_SEARCH_WORKERS = 8


@dataclass(frozen=True)
class SolveOutcome:
    """What one solve produced. `status` is CP-SAT's own status vocabulary
    (`OPTIMAL`/`FEASIBLE`/`INFEASIBLE`/`UNKNOWN`/`MODEL_INVALID`), passed
    through verbatim — `cp_sat.main` maps it onto the proto enum."""

    assignments: list[tuple[int, int, int]]  # (fixture_index, court_index, start_at_ms)
    status: str
    tiers_completed: int
    objective_values: list[tuple[str, int]]  # (tier_name, achieved value)
    elapsed_ms: int


@dataclass
class FixtureVars:
    """The decision variables and objective terms a tier solve needs to read
    back. Rides on the model itself (`model.fixture_vars`) so `solve()` — and
    Prompt 03's `run_tier_chain(model, fixture_vars, wall_seconds)` — can
    recover them from the single model argument the interface passes around.

    No `fixture_ids` field: a fixture's identity is its position, always
    `range(len(placed))`, so a parallel list carrying it would only ever
    equal that range — see the module docstring's round-6 note.
    """

    placed: list[Any]
    start: list[Any]
    presence_court: list[list[Any]]  # presence_court[fixture_i][court_index]
    placed_sum: Any
    makespan: Any
    worst_gap: Any
    imbalance: Any


class ScheduleModel(cp_model.CpModel):
    """A `CpModel` that carries its own decision variables.

    Subclassed rather than wrapped so the model stays a real `cp_model.CpModel`
    for every OR-Tools call site (`CpSolver.Solve`, `Add*`, `Maximize`), which
    is what `build_model`'s declared return type promises.
    """

    fixture_vars: FixtureVars


def build_model(
    fixtures: list[tuple[list[int], int]],
    num_courts: int,
    grid_slots: list[tuple[int, int, int]],
    step_minutes: int,
    constraints: dict,
    existing: list[tuple[int, int]],
    dependencies: list[tuple[int, int]],
) -> cp_model.CpModel:
    """Build the full constraint model. No objective is set — `solve()` owns
    that, so the tier chain (Prompt 03) can drive one model through several
    objectives without rebuilding the constraints each time.

    Args:
        fixtures: (entrant_indices, division_index) per movable fixture. A
            fixture's identity is its POSITION in this list.
        num_courts: how many courts a fixture may be placed on. A court's
            identity is its position in `range(num_courts)`; this module never
            sees a court name.
        grid_slots: (court_index, start_at_ms, day_index) legal lattice
            points, treated as an opaque legal-start set — no calendar or
            timezone math happens here. `day_index` is the CALLER's calendar
            day for that slot, resolved in the org's own zone; it is the only
            thing the per-division day cap groups by. Slots sharing a
            `start_at_ms` must agree on it, and each day's ticks must occupy a
            stretch of the timeline no other day's fall inside.
        step_minutes: the lattice's tick size. Accepted because it is part of
            the contract but unread here — see the module docstring. Nothing
            reads it: `grid_slots` already enumerates every admissible tick.
        constraints: `match_minutes`, `gap_minutes`, `rest_by_division`,
            `day_cap_by_division` — the latter two now `dict[int, int]`,
            keyed by `division_index` rather than by division id string.
        existing: (court_index, start_at_ms) immovable rows. No fixture
            identity at all — round 6 confirmed by tracing every read that
            the old `fixture_id` on a pinned row reached nothing but a debug
            variable-name label.
        dependencies: (before_index, after_index) — fixture POSITIONS, not
            ids. `after` may not start until `before` has finished and rested.
    """
    del step_minutes  # see the docstring: contractual, not load-bearing.

    rest_by_division: dict[int, int] = constraints.get("rest_by_division") or {}
    day_cap_by_division: dict[int, int] = constraints.get("day_cap_by_division") or {}

    # --- degenerate values that would otherwise produce a confidently WRONG
    # --- board reported as OPTIMAL. See "proto3 scalars are non-optional".
    match_minutes = int(constraints.get("match_minutes", 0))
    if match_minutes <= 0:
        raise ValueError(
            f"match_minutes must be > 0, got {match_minutes!r}. A zero-length match makes "
            "every court and rest interval zero-width, so NoOverlap constrains nothing and "
            "the solver returns OPTIMAL with every fixture stacked on one tick."
        )
    for division, cap in day_cap_by_division.items():
        if int(cap) <= 0:
            raise ValueError(
                f"max_fixtures_per_day for division_index {division!r} must be > 0, got {cap!r}. "
                "A cap of 0 forbids placing that division at all, and the solver reports "
                "OPTIMAL having silently dropped every one of its fixtures. To leave a "
                "division uncapped, omit it from day_cap_by_division rather than passing 0."
            )
    # `gap_minutes` and rest of 0 are both LEGITIMATE (no turnaround required,
    # no minimum rest), which is why neither is guarded as `<= 0` the way
    # `match_minutes` is. Negative is the degenerate case, and it is worse than
    # zero: it does not merely fail to constrain, it CANCELS the match length
    # out of the interval width and reopens a family that was closed.
    gap_minutes = int(constraints.get("gap_minutes", 0))
    if gap_minutes < 0:
        raise ValueError(
            f"gap_minutes must be >= 0, got {gap_minutes!r}. The court interval is "
            "match_minutes + gap_minutes wide, so a negative gap shrinks it — at "
            "gap_minutes == -match_minutes the width is 0, NoOverlap over zero-width "
            "intervals constrains nothing, and the solver returns OPTIMAL with two matches "
            "physically overlapping on one court (measured: 37 placed, 4 tiers, 1 overlap)."
        )
    for division, rest in rest_by_division.items():
        if int(rest) < 0:
            raise ValueError(
                f"min_rest_minutes for division_index {division!r} must be >= 0, got {rest!r}. The "
                "participant-rest interval is match_minutes + rest wide, so a negative rest "
                "shrinks it — at rest == -match_minutes the width is 0 and the solver returns "
                "OPTIMAL with one entrant in two simultaneous matches (measured: 37 placed, "
                "4 tiers, 1 collision). Rest of 0 is legitimate and is deliberately allowed."
            )
    if not grid_slots:
        raise ValueError(
            "grid_slots must be non-empty. With no admissible ticks the start domain falls "
            "back to [0] and the day-bucket list to [0], so fixtures are placed at "
            "start_at_ms=0 — a grid that offers zero legal slots yields a board, reported "
            "OPTIMAL (measured: 2 fixtures placed at epoch 0). `cp_sat.schema` rejects an "
            "empty slot list at the wire too; this is the domain refusing to be constructed "
            "invalid, which is defence in depth rather than duplication."
        )

    model = ScheduleModel()
    n = len(fixtures)
    dur_ms = match_minutes * MIN_MS
    gap_ms = gap_minutes * MIN_MS

    divisions = [division_index for _entrants, division_index in fixtures]
    # Per-fixture rest, resolved off the fixture's OWN division. The bench had
    # one `hard_rest_min` for the whole board; this is that generalised, and
    # reduces to it exactly when every division shares a value.
    rest_ms = [int(rest_by_division.get(division, 0)) * MIN_MS for division in divisions]

    admissible_starts = sorted({start_ms for _court, start_ms, _day in grid_slots})
    full_domain = cp_model.Domain.FromValues(admissible_starts or [0])

    # One IntVar per fixture (its actual chosen start, domain-restricted to
    # admissible ticks) instead of a Bool per (fixture, slot).
    placed = [model.NewBoolVar(f"p_{i}") for i in range(n)]
    start: list[Any] = []
    presence_court: list[list[Any]] = []
    for i in range(n):
        start.append(model.NewIntVarFromDomain(full_domain, f"start_{i}"))
        pcs = [model.NewBoolVar(f"onc_{i}_{c}") for c in range(num_courts)]
        presence_court.append(pcs)
        # section 1: at most one court, and `placed[i]` tracks it exactly.
        model.Add(sum(pcs) == placed[i])

    # sections 2+3 fused: one optional interval per (fixture, court), sized
    # matchMinutes+gapMinutes, all sharing that fixture's single `start[i]`.
    # AddNoOverlap per court is a strict superset of exact-slot exclusivity
    # (section 2) at this width, so section 2 needs no separate statement.
    width_court = dur_ms + gap_ms
    court_lists: list[list[Any]] = [[] for _ in range(num_courts)]
    for i in range(n):
        for c in range(num_courts):
            court_lists[c].append(
                model.NewOptionalFixedSizeIntervalVar(
                    start[i], width_court, presence_court[i][c], f"ivc_{i}_{c}"
                )
            )

    # section 7 (court-gap half): existing rows are plain fixed intervals,
    # same width, folded into their own court's list — one-directional by
    # construction (a fixed interval cannot move to accommodate a movable
    # one; only the movable side is ever constrained by NoOverlap here).
    # `k` (the row's own position) labels the interval var; existing rows
    # carry no identity of their own to label it with (round 6).
    for k, (existing_court, existing_start) in enumerate(existing):
        if 0 <= existing_court < num_courts:
            court_lists[existing_court].append(
                model.NewFixedSizeIntervalVar(existing_start, width_court, f"ivc_existing_{k}")
            )

    for lst in court_lists:
        if len(lst) >= 2:
            model.AddNoOverlap(lst)

    # section 6: participant rest window, entrant-keyed groups. One optional
    # interval per fixture, sized matchMinutes+its division's rest, presence =
    # placed[i]; AddNoOverlap per entrant group (cross-court).
    by_entrant: dict[int, list[int]] = {}
    for i, (entrant_indices, _division) in enumerate(fixtures):
        for entrant in entrant_indices:
            by_entrant.setdefault(entrant, []).append(i)

    interval_rest = [
        model.NewOptionalFixedSizeIntervalVar(start[i], dur_ms + rest_ms[i], placed[i], f"ivr_{i}")
        for i in range(n)
    ]

    for group in by_entrant.values():
        if len(group) >= 2:
            model.AddNoOverlap([interval_rest[i] for i in group])

    # section 8: order dependencies. The dependent may not START until the
    # feeder's END plus the DEPENDENT's own rest (resolved off the dependent's
    # own row, placement-free) — same rule the bench states, with the pair
    # given in the proto's (before, after) order rather than the bench's
    # (dependent, feeder).
    #
    # DIRECT indexing now — no `id_to_idx` lookup. `before_idx`/`after_idx`
    # are already fixture POSITIONS; `cp_sat.schema` guarantees them in range
    # for a real request. The bounds check below is the same tolerance the
    # string contract had (`id_to_idx.get(...) or continue`), preserved for
    # a direct domain caller (bench, tests) that hands this a partial board.
    for before_idx, after_idx in dependencies:
        if not (0 <= before_idx < n and 0 <= after_idx < n):
            continue
        model.Add(start[after_idx] >= start[before_idx] + dur_ms + rest_ms[after_idx]).OnlyEnforceIf(
            [placed[after_idx], placed[before_idx]]
        )

    # section 9: max fixtures per day, per division.
    #
    # Day membership comes from the CALLER's `day_index`, not from
    # `start_ms // DAY_MS`. That quotient is a UTC day, and production day caps
    # are governed by the org's own timezone: for an org at UTC+10 a 09:00 and
    # a 19:00 local match on one day land in two different UTC buckets, so a
    # cap of one per day admits two, silently, reported OPTIMAL. Sending a
    # timezone instead would put timezones-as-policy inside this bounded
    # context, which the design rules out — the caller already knows the zone,
    # resolves each slot to its local calendar day, and sends the integer. This
    # module never reasons about time zones at all.
    day_of_start: dict[int, int] = {}
    for _court, start_ms, day_index in grid_slots:
        previous = day_of_start.setdefault(start_ms, day_index)
        if previous != day_index:
            raise ValueError(
                f"grid slots disagree about which day start_at_ms={start_ms} belongs to: "
                f"day_index {previous} and {day_index}. One instant is on one day; two courts "
                "offering the same tick must label it identically."
            )

    day_bounds: dict[int, tuple[int, int]] = {}
    for start_ms, day_index in day_of_start.items():
        lo, hi = day_bounds.get(day_index, (start_ms, start_ms))
        day_bounds[day_index] = (min(lo, start_ms), max(hi, start_ms))

    # Days must occupy DISJOINT stretches of the timeline, because membership
    # below is a range-reified indicator — two linear constraints per
    # (fixture, day) rather than a per-day value domain, which on the
    # production board is 1 924 constraints instead of 962 domains of 64
    # singletons each. The range form is exact only while no other day's ticks
    # fall inside `[lo_d, hi_d]`. A real calendar always satisfies this; a
    # caller that does not gets a refusal rather than a cap that binds on the
    # wrong fixtures.
    ordered_days = sorted(day_bounds.items(), key=lambda item: item[1][0])
    for (prev_day, (_prev_lo, prev_hi)), (next_day, (next_lo, _next_hi)) in zip(
        ordered_days, ordered_days[1:]
    ):
        if next_lo <= prev_hi:
            raise ValueError(
                f"day_index {prev_day} and {next_day} interleave on the timeline: day {prev_day} "
                f"runs to {prev_hi} and day {next_day} starts at {next_lo}. Calendar days must "
                "partition the admissible starts, or the per-day cap binds on the wrong fixtures."
            )

    # `on_day[i][d]==1 => lo_d <= start[i] <= hi_d`, plus
    # `sum_d on_day[i][d] == placed[i]`, pins down the true day
    # one-directionally: the solver cannot "cheat" by setting the wrong day's
    # bool, because turning it on binds the range constraint for real.
    day_ids = sorted(day_bounds)
    on_day: list[dict[int, Any]] = [dict() for _ in range(n)]
    for i in range(n):
        for d in day_ids:
            lo, hi = day_bounds[d]
            b = model.NewBoolVar(f"day_{i}_{d}")
            model.Add(start[i] >= lo).OnlyEnforceIf(b)
            model.Add(start[i] <= hi).OnlyEnforceIf(b)
            on_day[i][d] = b
        model.Add(sum(on_day[i].values()) == placed[i])
    for division, cap in day_cap_by_division.items():
        fx_idx = [i for i in range(n) if divisions[i] == division]
        for d in day_ids:
            lits = [on_day[i][d] for i in fx_idx]
            if lits:
                model.Add(sum(lits) <= int(cap))

    placed_sum = sum(placed)
    max_end = (max(admissible_starts) + dur_ms) if admissible_starts else dur_ms

    # T1: makespan, exact native term (mk_hi - mk_lo), squeezed onto the true
    # extremes exactly as build.ts:2075-2082 does.
    mk_lo = model.NewIntVar(0, max_end, "mk_lo")
    mk_hi = model.NewIntVar(0, max_end, "mk_hi")
    for i in range(n):
        model.Add(mk_lo <= start[i]).OnlyEnforceIf(placed[i])
        model.Add(mk_hi >= start[i] + dur_ms).OnlyEnforceIf(placed[i])
    # A duration cannot be negative — and without this it can be, spectacularly.
    # Both squeeze constraints above are `OnlyEnforceIf(placed[i])`, so on a
    # board where NOTHING is placed `mk_lo` and `mk_hi` float freely over
    # [0, max_end] and T1, which MINIMISES the difference, drives `mk_hi` to 0
    # and `mk_lo` to `max_end`. The chain proves that optimal and publishes it:
    # measured, one fixture made unplaceable by a self-dependency,
    # `objective_values=[('placed', 0), ('makespan', -1767258600000), ...]` —
    # a negative epoch-shaped number presented to the caller as a proved
    # optimum, on a response with `error` unset.
    #
    # Stated here rather than clamped at the wire for two reasons that are
    # about this module: the freeze `Add(makespan <= achieved)` that T2 and T3
    # inherit has to be a real bound, and `schema.py` should not need a special
    # case for a value the term should never have produced. It costs nothing on
    # a non-empty board: `mk_lo <= min start` and `mk_hi >= max start + dur_ms`
    # already force `mk_hi > mk_lo` there.
    #
    # An earlier version of this comment also claimed it kept "the bench" in
    # agreement. It does NOT, and the correction matters more than the
    # sentence: `bench/cpsat_bench.py` has its own `build_model` (:378, called
    # at :658) with its own unclamped `mk_lo`/`mk_hi` (:542-547) and imports
    # nothing from `cp_sat`. See this module's docstring.
    model.Add(mk_hi >= mk_lo)
    makespan = mk_hi - mk_lo

    # T3: court imbalance — busiest configured-or-used court minus the
    # quietest, in ms, exactly `boardMetrics.courtImbalanceMinutes`.
    #
    # STATED AS AN EQUALITY, WHERE build.ts:2115-2135 STATES A SQUEEZE
    # (`cb_hi >= load`, `cb_lo <= load` for every court). The two have the same
    # optimum — minimising `cb_hi - cb_lo` drives the squeeze onto the true
    # extremes — so this is a propagation change, not a semantic one. It is
    # here because the squeeze makes T3 UNPROVABLE inside any realistic wall,
    # measured on the production board (Prompt 03):
    #
    #     squeeze        T3 FEASIBLE after 20 000 ms, best bound 0
    #     max/min on ms  T3 OPTIMAL  in       934 ms
    #     max/min on counts (this)   OPTIMAL  in  411 ms
    #
    # all three agreeing on the same value, 2 400 000 ms. The squeeze's dual
    # bound is the problem, not its search: the LP relaxation spreads 37
    # fixtures over 5 courts as 7.4 each and reports imbalance 0, and nothing
    # in the one-sided form carries the counting argument that closes it. As
    # equalities, `sum(load) == placed` propagates `max >= ceil(37/5)` and
    # `min <= floor(37/5)` immediately — which IS the pigeonhole argument, and
    # it lands on the true optimum of one match's worth of load.
    #
    # Counted in matches and scaled to ms once, rather than summing ms per
    # court: same value, measured 2x faster to prove, and the variables' domain
    # is 0..n instead of 0..n*dur_ms.
    #
    # z3 needs none of this: its tier walk only ever asks "is this metric <= B",
    # a question the squeeze answers exactly. Native optimisation is what wants
    # a dual bound. Deliberately NOT propagated back to build.ts (Prompt 06's
    # file, and the squeeze is correct there).
    court_counts = []
    for c in range(num_courts):
        count = model.NewIntVar(0, n, f"load_{c}")
        model.Add(count == sum(presence_court[i][c] for i in range(n)))
        court_counts.append(count)
    cb_lo = model.NewIntVar(0, n, "cb_lo")
    cb_hi = model.NewIntVar(0, n, "cb_hi")
    if court_counts:
        model.AddMaxEquality(cb_hi, court_counts)
        model.AddMinEquality(cb_lo, court_counts)
    else:
        model.Add(cb_hi == 0)
        model.Add(cb_lo == 0)
    imbalance = (cb_hi - cb_lo) * dur_ms

    # T2: worst idle gap — APPROXIMATE native term. Exact for any participant
    # with <=2 fixtures; a safe over-approximation for 3+ (max over ALL pairs,
    # not just consecutive ones), which errs toward a WORSE reported gap, never
    # a better one. See the bench module docstring for why z3's exact
    # bound-parameterized clause family is not ported verbatim.
    diff_vars: list[Any] = []
    for group in by_entrant.values():
        if len(group) < 2:
            continue
        for x in range(len(group)):
            for y in range(x + 1, len(group)):
                i, j = group[x], group[y]
                d = model.NewIntVar(0, max_end, f"gap_{i}_{j}")
                model.Add(d >= start[i] - start[j] - dur_ms).OnlyEnforceIf([placed[i], placed[j]])
                model.Add(d >= start[j] - start[i] - dur_ms).OnlyEnforceIf([placed[i], placed[j]])
                diff_vars.append(d)
    worst_gap = model.NewIntVar(0, max_end, "worst_gap")
    if diff_vars:
        model.AddMaxEquality(worst_gap, diff_vars)
    else:
        model.Add(worst_gap == 0)

    model.fixture_vars = FixtureVars(
        placed=placed,
        start=start,
        presence_court=presence_court,
        placed_sum=placed_sum,
        makespan=makespan,
        worst_gap=worst_gap,
        imbalance=imbalance,
    )
    return model


def solve(model: cp_model.CpModel, wall_seconds: float) -> SolveOutcome:
    """Solve `model` through the full lexicographic T0->T3 tier chain within
    `wall_seconds`.

    A thin wrapper over `cp_sat.objective.run_tier_chain`, which owns the
    objectives and the frozen bounds between them. Everything a solve needs to
    know about tiers lives there, including why a tier cut short by the clock
    does not count and why its board is discarded.
    """
    # Imported HERE, not at module scope: `cp_sat.objective` imports this
    # module for `SolveOutcome`/`FixtureVars`/`extract_assignments`, so a
    # top-level import in this direction would be a cycle. The dependency is
    # genuinely one-way — the model layer knows nothing about tiers — and this
    # single call site is the seam.
    from cp_sat.objective import run_tier_chain

    return run_tier_chain(model, model.fixture_vars, wall_seconds)


def extract_assignments(solver: cp_model.CpSolver, fixture_vars: FixtureVars) -> list[tuple[int, int, int]]:
    """Read placed fixtures back out. `start[i]` free-floats for an unplaced
    fixture (its intervals are absent, so nothing constrains it), which is why
    this filters on `placed[i]` rather than reading every start.

    A fixture's identity in the returned triples is its POSITION `i` —
    `enumerate(fixture_vars.placed)` rather than a stored `fixture_ids` list,
    since the two would always have agreed (see `FixtureVars`'s docstring).
    """
    out: list[tuple[int, int, int]] = []
    for i, is_placed in enumerate(fixture_vars.placed):
        if not solver.Value(is_placed):
            continue
        for court_index, presence in enumerate(fixture_vars.presence_court[i]):
            if solver.Value(presence):
                out.append((i, court_index, int(solver.Value(fixture_vars.start[i]))))
                break
    return out
