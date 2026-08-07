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

`cpsat_bench.py`'s `greedy_seed()` computes a first-fit placement and
`run_full_chain` feeds it to every tier's solve via `model.add_hint(...)`,
mirroring z3's "greedy seeds the incumbent" design. **That is how the bench's
published ~2.5 s full-chain number on the production board was produced.**

It is not ported here. Two reasons: it needs `board.slots` INDICES, which the
service's plain `(court, start_at_ms)` grid does not carry in the same shape;
and at T0 it makes no measurable difference on this board (80-145 ms with or
without). A hint cannot change correctness — CP-SAT repairs or discards an
invalid one — so nothing is at risk today.

**This matters for Prompt 03.** The full T0->T3 chain is far heavier than T0
alone (the bench spends ~1.2 s of its ~2 s in the idlegap tier), and every
published chain timing was measured WITH the hint. If the tier chain comes in
slower than the bench's numbers, suspect this omission before suspecting the
tier code. Restoring it means porting `greedy_seed` (cpsat_bench.py:475-567)
against `grid_slots` and calling `model.add_hint` on `start[i]`, `placed[i]`
and `presence_court[i][court]`.

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

import time
from dataclasses import dataclass
from typing import Any

from ortools.sat.python import cp_model

MIN_MS = 60_000
DAY_MS = 86_400_000

# Tier names, fixed protocol constants shared with the TS side (see the design
# spec, "Tier/objective semantics are a fixed protocol constant"). Only T0 is
# solved here; Prompt 03 (`cp_sat.objective`) adds the remaining three.
TIER_PLACED = "placed"

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

    # T3: court imbalance, exact native term (cb_hi - cb_lo), same squeeze
    # technique as build.ts:2115-2135.
    cb_lo = model.NewIntVar(0, max(1, n * dur_ms), "cb_lo")
    cb_hi = model.NewIntVar(0, max(1, n * dur_ms), "cb_hi")
    for c in courts:
        load = sum(presence_court[i][c] for i in range(n)) * dur_ms
        model.Add(cb_hi >= load)
        model.Add(cb_lo <= load)
    imbalance = cb_hi - cb_lo

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
    """Solve T0 (maximise placed fixtures) within `wall_seconds`.

    T0 ONLY. The lexicographic T0->T3 chain is Prompt 03's job
    (`cp_sat.objective.run_tier_chain`); this function becomes a thin wrapper
    around it then. `tiers_completed`/`objective_values` already carry the
    chain's shape so that swap changes no caller.
    """
    started = time.perf_counter()
    fixture_vars: FixtureVars = model.fixture_vars

    model.Maximize(fixture_vars.placed_sum)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(0.05, float(wall_seconds))
    solver.parameters.num_search_workers = NUM_SEARCH_WORKERS
    # Keep these. No test fails without them (measured: this board solves
    # OPTIMAL/37 either way, 145 ms vs 424 ms), so a mutation pass will flag
    # them as a survivor — read the module docstring before concluding they
    # are dead weight. The silent-UNKNOWN presolve trap they guard against was
    # observed under the bench's v1 encoding on larger boards.
    solver.parameters.symmetry_level = 0
    solver.parameters.cp_model_probing_level = 0

    status = solver.Solve(model)
    status_name = solver.StatusName(status)

    assignments: list[tuple[str, str, int]] = []
    objective_values: list[tuple[str, int]] = []
    tiers_completed = 0
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        assignments = _extract_assignments(solver, fixture_vars)
        objective_values = [(TIER_PLACED, int(solver.Value(fixture_vars.placed_sum)))]
        tiers_completed = 1

    return SolveOutcome(
        assignments=assignments,
        status=status_name,
        tiers_completed=tiers_completed,
        objective_values=objective_values,
        elapsed_ms=int(round((time.perf_counter() - started) * 1000)),
    )


def _extract_assignments(solver: cp_model.CpSolver, fixture_vars: FixtureVars) -> list[tuple[str, str, int]]:
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
