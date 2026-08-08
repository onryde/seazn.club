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
    `Fixture` carries (fixture_id, entrant_ids, division_id) only.
  * build-encode.ts section 7's PARTICIPANT-REST half. `existing` rows arrive
    as `Assignment (fixture_id, court, start_at_ms)` with no entrant list, so
    only the court-turnaround half of section 7 survives; a pinned row still
    blocks its own court but no longer blocks a participant it shares.
  * per-court grids. `admissible_starts` is the union of every slot's start
    across all courts (exactly as the bench does, where every court offers the
    identical tick set). If a real request ever sends courts with DIFFERENT
    slot sets — a per-court blackout — a fixture could be placed on a court at
    a tick that court does not offer.

Day-cap day boundaries are a fourth, subtler one: `start_ms // DAY_MS` is a
UTC day, matching the bench's `EPOCH_MS = 0` board exactly, but production
day caps are governed by the org's own timezone and the request carries no
zone. Any org not on UTC gets its caps applied against the wrong boundary.
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

    assignments: list[tuple[str, str, int]]  # (fixture_id, court, start_at_ms)
    status: str
    tiers_completed: int
    objective_values: list[tuple[str, int]]  # (tier_name, achieved value)
    elapsed_ms: int


@dataclass
class FixtureVars:
    """The decision variables and objective terms a tier solve needs to read
    back. Rides on the model itself (`model.fixture_vars`) so `solve()` — and
    Prompt 03's `run_tier_chain(model, fixture_vars, wall_seconds)` — can
    recover them from the single model argument the interface passes around."""

    fixture_ids: list[str]
    placed: list[Any]
    start: list[Any]
    presence_court: list[dict[str, Any]]
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
    fixtures: list[tuple[str, list[str], str]],
    courts: list[str],
    grid_slots: list[tuple[str, int]],
    step_minutes: int,
    constraints: dict,
    existing: list[tuple[str, str, int]],
    dependencies: list[tuple[str, str]],
) -> cp_model.CpModel:
    """Build the full constraint model. No objective is set — `solve()` owns
    that, so the tier chain (Prompt 03) can drive one model through several
    objectives without rebuilding the constraints each time.

    Args:
        fixtures: (fixture_id, entrant_ids, division_id) per movable fixture.
        courts: every court a fixture may be placed on.
        grid_slots: (court, start_at_ms) legal lattice points, treated as an
            opaque legal-start set — no calendar or timezone math happens here.
        step_minutes: the lattice's tick size. Accepted because it is part of
            the contract (`Grid.step_minutes`) and callers have it, but the
            model derives every start it needs from `grid_slots` directly, so
            nothing reads it. It is NOT silently ignored spacing information:
            `grid_slots` already enumerates every admissible tick.
        constraints: `match_minutes`, `gap_minutes`, `rest_by_division`,
            `day_cap_by_division`.
        existing: (fixture_id, court, start_at_ms) immovable rows.
        dependencies: (before_fixture_id, after_fixture_id) — `after` may not
            start until `before` has finished and rested.
    """
    del step_minutes  # see the docstring: contractual, not load-bearing.

    rest_by_division: dict[str, int] = constraints.get("rest_by_division") or {}
    day_cap_by_division: dict[str, int] = constraints.get("day_cap_by_division") or {}

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
                f"max_fixtures_per_day for division {division!r} must be > 0, got {cap!r}. "
                "A cap of 0 forbids placing that division at all, and the solver reports "
                "OPTIMAL having silently dropped every one of its fixtures. To leave a "
                "division uncapped, omit it from day_cap_by_division rather than passing 0."
            )

    model = ScheduleModel()
    n = len(fixtures)
    dur_ms = match_minutes * MIN_MS
    gap_ms = int(constraints.get("gap_minutes", 0)) * MIN_MS

    fixture_ids = [fid for fid, _entrants, _division in fixtures]
    divisions = [division for _fid, _entrants, division in fixtures]
    # Per-fixture rest, resolved off the fixture's OWN division. The bench had
    # one `hard_rest_min` for the whole board; this is that generalised, and
    # reduces to it exactly when every division shares a value.
    rest_ms = [int(rest_by_division.get(division, 0)) * MIN_MS for division in divisions]

    admissible_starts = sorted({start_ms for _court, start_ms in grid_slots})
    full_domain = cp_model.Domain.FromValues(admissible_starts or [0])

    # One IntVar per fixture (its actual chosen start, domain-restricted to
    # admissible ticks) instead of a Bool per (fixture, slot).
    placed = [model.NewBoolVar(f"p_{i}") for i in range(n)]
    start: list[Any] = []
    presence_court: list[dict[str, Any]] = []
    for i in range(n):
        start.append(model.NewIntVarFromDomain(full_domain, f"start_{i}"))
        pcs = {c: model.NewBoolVar(f"onc_{i}_{c}") for c in courts}
        presence_court.append(pcs)
        # section 1: at most one court, and `placed[i]` tracks it exactly.
        model.Add(sum(pcs.values()) == placed[i])

    # sections 2+3 fused: one optional interval per (fixture, court), sized
    # matchMinutes+gapMinutes, all sharing that fixture's single `start[i]`.
    # AddNoOverlap per court is a strict superset of exact-slot exclusivity
    # (section 2) at this width, so section 2 needs no separate statement.
    width_court = dur_ms + gap_ms
    court_lists: dict[str, list[Any]] = {c: [] for c in courts}
    for i in range(n):
        for c in courts:
            court_lists[c].append(
                model.NewOptionalFixedSizeIntervalVar(start[i], width_court, presence_court[i][c], f"ivc_{i}_{c}")
            )

    # section 7 (court-gap half): existing rows are plain fixed intervals,
    # same width, folded into their own court's list — one-directional by
    # construction (a fixed interval cannot move to accommodate a movable
    # one; only the movable side is ever constrained by NoOverlap here).
    for existing_id, existing_court, existing_start in existing:
        if existing_court in court_lists:
            court_lists[existing_court].append(
                model.NewFixedSizeIntervalVar(existing_start, width_court, f"ivc_existing_{existing_id}")
            )

    for lst in court_lists.values():
        if len(lst) >= 2:
            model.AddNoOverlap(lst)

    # section 6: participant rest window, entrant-keyed groups. One optional
    # interval per fixture, sized matchMinutes+its division's rest, presence =
    # placed[i]; AddNoOverlap per entrant group (cross-court).
    by_entrant: dict[str, list[int]] = {}
    for i, (_fid, entrant_ids, _division) in enumerate(fixtures):
        for entrant in entrant_ids:
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
    id_to_idx = {fid: i for i, fid in enumerate(fixture_ids)}
    for before_id, after_id in dependencies:
        after = id_to_idx.get(after_id)
        before = id_to_idx.get(before_id)
        if after is None or before is None:
            continue
        model.Add(start[after] >= start[before] + dur_ms + rest_ms[after]).OnlyEnforceIf(
            [placed[after], placed[before]]
        )

    # section 9: max fixtures per day, per division. Day membership is a
    # range-reified indicator: calendar days partition the admissible-start
    # domain exactly (no two days' ms ranges overlap), so `on_day[i][d]==1 =>
    # start[i] in [d*DAY_MS, (d+1)*DAY_MS)` plus `sum_d on_day[i][d] ==
    # placed[i]` pins down the true day one-directionally — the solver cannot
    # "cheat" by setting the wrong day's bool, since turning it on binds the
    # range constraint for real.
    day_ids = sorted({v // DAY_MS for v in admissible_starts}) if admissible_starts else [0]
    on_day: list[dict[int, Any]] = [dict() for _ in range(n)]
    for i in range(n):
        for d in day_ids:
            lo, hi = d * DAY_MS, (d + 1) * DAY_MS
            b = model.NewBoolVar(f"day_{i}_{d}")
            model.Add(start[i] >= lo).OnlyEnforceIf(b)
            model.Add(start[i] < hi).OnlyEnforceIf(b)
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
    for c in courts:
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
        fixture_ids=fixture_ids,
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


def extract_assignments(solver: cp_model.CpSolver, fixture_vars: FixtureVars) -> list[tuple[str, str, int]]:
    """Read placed fixtures back out. `start[i]` free-floats for an unplaced
    fixture (its intervals are absent, so nothing constrains it), which is why
    this filters on `placed[i]` rather than reading every start."""
    out: list[tuple[str, str, int]] = []
    for i, fixture_id in enumerate(fixture_vars.fixture_ids):
        if not solver.Value(fixture_vars.placed[i]):
            continue
        for court, presence in fixture_vars.presence_court[i].items():
            if solver.Value(presence):
                out.append((fixture_id, court, int(solver.Value(fixture_vars.start[i]))))
                break
    return out
