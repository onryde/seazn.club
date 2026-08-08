"""The T0->T3 lexicographic objective chain.

T0 max-placed -> T1 makespan -> T2 worst idle gap -> T3 court imbalance, in
that fixed order. The order is a protocol constant shared with the TS side,
not wire data (design spec, "Tier/objective semantics are a fixed protocol
constant"), and it encodes a product ruling: `placed` dominates absolutely.
A shorter day, a tighter idle gap or a flatter court load must NEVER be
bought by dropping a match an organiser asked to fit. `build.ts:1577-1585`
records that the trade was re-affirmed against measurement, not chosen in
ignorance of it — the sweep showed the lower three metrics getting WORSE when
one more match fits, and that is the tiers working, not a defect.

This is a port of `bench/cpsat_bench.py`'s `run_full_chain`, which is itself
the sequential-solve port of z3's bound walk in `build.ts:1602-1672`.

--- the mechanism, and how it differs from both of its ancestors ------------

z3 (build.ts) walks each tier DOWNWARD: `push()`, assert `metric <= best-1`,
`check()`, `pop()`, repeat until UNSAT proves `best` optimal, then assert
`metric <= best` at the top level so every later tier inherits it. CP-SAT has
native optimisation, so one `Minimize` + one `Solve` replaces the whole walk
and returns the proved optimum directly.

That collapses the push/pop question rather than answering it. `push`/`pop`
exist in the z3 version because the walk asserts bounds it intends to RETRACT
(`best-1` is a question, and an UNSAT answer must not stay in the solver).
Nothing here is ever retracted: the only assertion this module adds is a
tier's ACHIEVED value, which build.ts adds at the top level too, outside every
push. So the accumulated bounds are monotone and one `CpModel` carries them
all — `model.Add(...)` here is exactly `build.ts:1670`'s
`tier.atMost(tier.of(incumbentMetrics))`, and it has no `pop` for the same
reason that line does not.

Differing from the BENCH: `run_full_chain` REBUILDS the model per tier and
passes the previous tiers' bounds into `build_model` as `placed_floor` /
`makespan_ceiling` / `idlegap_ceiling` constructor arguments. That is a
benchmark measuring build cost per tier; there is no reason to pay it four
times in the service. One model is built once (`cp_sat.model.build_model`,
which deliberately sets NO objective for this reason) and this module drives
it through four objectives. `model.Maximize`/`Minimize` REPLACES the objective
rather than adding to it, so the tiers do not blend — verified, not assumed:
`test_full_chain_places_exactly_what_t0_alone_places` fails if they do.

--- what `tiers_completed` means, and why FEASIBLE does not count -----------

`SolveBuildResponse.tiers_completed` is specified as "same semantics as
`BuildResult.tiersCompleted`" (design spec). On the TS side that counter is
incremented ONLY for a tier that settled — one that ran to a verdict rather
than to the budget (`build.ts:1669-1671`: `if (!settled) break;`). An
`unknown` verdict explicitly does not count; the header is emphatic that the
absence of a proof must never be read as one.

CP-SAT's equivalent of "settled" is `OPTIMAL`. `FEASIBLE` means the time limit
fired before the solver could prove optimality — it is the `unknown` case
wearing a friendlier name, because CP-SAT hands back its incumbent instead of
nothing. So:

  * a tier counts only when it returns OPTIMAL, and
  * the first non-OPTIMAL tier ENDS the chain, exactly as `!settled` does.

Under-reporting is safe (TS runs LNS it did not strictly need); over-reporting
is not — `tiersCompleted === TIER_COUNT` is the sole gate on TS's
`already_optimal` claim (`build.ts:1863`) and on skipping LNS entirely.

--- why a cut-short tier's board is DISCARDED rather than adopted -----------

When a tier returns FEASIBLE, its board satisfies every frozen bound, so it is
no worse on any EARLIER tier's metric — but its own tier's metric may be worse
than the board already in hand, and under D3's ordering that makes it a worse
board. build.ts guards the same case explicitly (`isStrictlyBetter` at
`build.ts:1663`, "keep the incumbent and stop counting tiers"), and it can do
so because `boardMetrics` re-derives every metric honestly in TS.

There is no honest equivalent to read here, which is the part worth knowing.
`makespan` and `worst_gap` are ONE-SIDED terms — `mk_lo <= start[i]` and
`mk_hi >= start[i] + dur` squeeze the makespan onto the true extremes only
because something is minimising the difference; `worst_gap`'s per-pair
variables are likewise only bounded from below. Each reads true ONLY for the
tier that is optimising it. At any other tier the solver has no reason to
tighten it and `solver.Value()` returns an arbitrary slack value. (The bench
records all four numbers on every tier row; some of them are meaningless on
any given row, for exactly this reason. `placed` and — since the T3 encoding
became a max/min EQUALITY, see `cp_sat.model` — `imbalance` are the two that
do read true everywhere.)

Re-deriving the missing two from the assignments in Python instead would be a
second implementation of what the model already states — the placer/verifier
fork this repo keeps getting bitten by — so the conservative move is taken:
keep the last board that was PROVED, and stop.

The residual, stated rather than hidden: a discarded FEASIBLE board could in
principle have placed MORE fixtures than the incumbent (the floor is a lower
bound, not an equality), which D3 would rank higher. That board is given up.
It requires a tier to time out AND to have found a strictly better placement
while optimising something else, and the exchange rate is the right one —
never returning a board D3 ranks BELOW the one in hand.

T0 is the exception: its board is adopted whatever the status, because there
is no incumbent to fall back on. That mirrors TS returning its greedy board
with `tiersCompleted: 0`.

This module is domain logic and imports NOTHING from `cp_sat.generated`.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from ortools.sat.python import cp_model

from cp_sat.model import (
    NUM_SEARCH_WORKERS,
    FixtureVars,
    SolveOutcome,
    extract_assignments,
)

# --- the protocol constant --------------------------------------------------
#
# Names are snake_case service-side; `build.ts`'s own `Tier.name` values are
# `makespan` / `idleGap` / `imbalance` (and T0 is unnamed there, being handled
# before the tier loop). They travel as `Tier.name` strings on the wire, so
# whichever side reads them has to agree — Prompt 06 owns that comparison.
TIER_PLACED = "placed"
TIER_MAKESPAN = "makespan"
TIER_IDLE_GAP = "idle_gap"
TIER_COURT_IMBALANCE = "court_imbalance"

TIER_ORDER: tuple[str, ...] = (TIER_PLACED, TIER_MAKESPAN, TIER_IDLE_GAP, TIER_COURT_IMBALANCE)
#: `build.ts`'s `TIER_COUNT`. Reaching it means every tier was PROVED optimal.
TIER_COUNT = len(TIER_ORDER)

# A tier gets at least this much wall, and the chain stops rather than start a
# tier with less left. Same floor the bench uses, and the same one
# `CpSolver.max_time_in_seconds` is clamped to: a solve given ~0 s returns
# UNKNOWN after paying the model-copy cost, which is worse than not starting.
MIN_TIER_SECONDS = 0.05


@dataclass(frozen=True)
class _TierSpec:
    """One rung of the ladder. `term` is pulled off `FixtureVars` at solve time
    rather than stored, so the spec table stays a module-level constant."""

    name: str
    maximize: bool
    term: Callable[[FixtureVars], Any]


_TIER_SPECS: dict[str, _TierSpec] = {
    # T0. The only tier that maximises, and the only one whose frozen bound is
    # a FLOOR (`>=`). Also the only exact term of the four: a sum of literals
    # reads true whether or not it is the current objective.
    TIER_PLACED: _TierSpec(TIER_PLACED, maximize=True, term=lambda fv: fv.placed_sum),
    # T1-T3 minimise, and freeze CEILINGS (`<=`) — `Tier.atMost` in build.ts.
    TIER_MAKESPAN: _TierSpec(TIER_MAKESPAN, maximize=False, term=lambda fv: fv.makespan),
    TIER_IDLE_GAP: _TierSpec(TIER_IDLE_GAP, maximize=False, term=lambda fv: fv.worst_gap),
    TIER_COURT_IMBALANCE: _TierSpec(TIER_COURT_IMBALANCE, maximize=False, term=lambda fv: fv.imbalance),
}


def run_tier_chain(
    model: cp_model.CpModel,
    fixture_vars: FixtureVars,
    wall_seconds: float,
    tiers: Sequence[str] = TIER_ORDER,
) -> SolveOutcome:
    """Drive `model` through the lexicographic tier chain under ONE wall clock.

    Args:
        model: a model from `cp_sat.model.build_model`, with no objective set.
            It is MUTATED — each tier sets an objective on it and adds its
            achieved bound as a constraint. A model that has been through this
            function cannot be re-used for a different chain.
        fixture_vars: the model's decision variables and objective terms.
            Also reachable as `model.fixture_vars`; passed explicitly because
            that is the interface the design fixes, and because it keeps this
            module honest about what it reads.
        wall_seconds: the budget for the WHOLE chain, not per tier. Deliberately
            not sliced per tier — `build.ts:1587-1597` rules that out, because a
            slice makes "which tier ran" a property of the machine, and the same
            request would come back differently optimised on a faster box.
        tiers: the rungs to attempt, in order. Defaults to all four; the bench's
            `tiers=("placed",)` isolation run is the reason this is a parameter.

    Returns:
        `SolveOutcome`. `tiers_completed` counts tiers PROVED optimal (see the
        module docstring); `objective_values` carries one `(name, value)` per
        tier whose board was adopted, in tier order; `status` describes the
        board that came back, per `_chain_status`.
    """
    started = time.perf_counter()
    deadline = started + float(wall_seconds)

    unknown = [name for name in tiers if name not in _TIER_SPECS]
    if unknown:
        raise ValueError(f"unknown tier(s) {unknown!r}; expected some ordering of {list(TIER_ORDER)}")

    assignments: list[tuple[str, str, int]] = []
    objective_values: list[tuple[str, int]] = []
    tiers_completed = 0
    # Only used when the chain produced NO board at all — see `_chain_status`.
    last_barren_status = "UNKNOWN"

    for spec in (_TIER_SPECS[name] for name in tiers):
        if deadline - time.perf_counter() <= MIN_TIER_SECONDS:
            # Out of budget. Whatever earlier tiers proved still stands.
            break

        term = spec.term(fixture_vars)
        # Replaces the previous tier's objective; it does not add to it. This
        # is what makes the chain lexicographic rather than a blended score.
        if spec.maximize:
            model.Maximize(term)
        else:
            model.Minimize(term)

        solver = _tier_solver(deadline)
        status = solver.Solve(model)
        last_barren_status = solver.StatusName(status)

        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            # INFEASIBLE cannot legitimately reach here after T0 — every frozen
            # bound is a value some board actually achieved, so the previous
            # tier's solution is still feasible — but if it ever does, the
            # honest move is the same one: keep what was proved, stop.
            break

        achieved = int(solver.Value(term))

        if status != cp_model.OPTIMAL:
            # Cut short by the clock. Adopt the board only if there is nothing
            # to fall back on (T0); otherwise keep the incumbent. Either way
            # the tier is NOT counted and the chain is over.
            if not objective_values:
                assignments = extract_assignments(solver, fixture_vars)
                objective_values.append((spec.name, achieved))
            break

        assignments = extract_assignments(solver, fixture_vars)
        objective_values.append((spec.name, achieved))
        tiers_completed += 1

        # Freeze it. Every later tier optimises subject to this, which is the
        # whole content of "lexicographic": the tiers below cannot spend what
        # the tiers above have already won.
        if spec.maximize:
            model.Add(term >= achieved)
        else:
            model.Add(term <= achieved)

    return SolveOutcome(
        assignments=assignments,
        status=_chain_status(assignments, tiers_completed, len(tiers), last_barren_status),
        tiers_completed=tiers_completed,
        objective_values=objective_values,
        elapsed_ms=int(round((time.perf_counter() - started) * 1000)),
    )


def _chain_status(
    assignments: list[tuple[str, str, int]],
    tiers_completed: int,
    tiers_requested: int,
    last_barren_status: str,
) -> str:
    """CP-SAT's status vocabulary, describing the BOARD BEING RETURNED.

    A chain is not one solve, so "the" status has to be defined rather than
    passed through, and the obvious definition — the verdict of the last solve
    that ran — is wrong in a way that only shows up under load. Observed here:
    T0, T1 and T2 all proved, T3 got the few milliseconds left and returned
    UNKNOWN having found nothing of its own, and the chain reported

        status='UNKNOWN', tiers_completed=3, 37 assignments

    which reads as "no answer" while holding a complete, three-times-proved
    board. `SolveStatus` is the field a caller checks before trusting
    `assignments` at all, so it must describe what came back:

        OPTIMAL      every requested tier PROVED optimal
        FEASIBLE     a board, but the chain did not finish proving it
        otherwise    no board — the last solver verdict passed through verbatim
                     (INFEASIBLE is a real answer about the request and must
                     never be flattened into UNKNOWN)

    `tiers_completed` remains the finer-grained signal; this is the coarse gate.
    """
    if not assignments:
        return last_barren_status
    return "OPTIMAL" if tiers_completed == tiers_requested else "FEASIBLE"


def _tier_solver(deadline: float) -> cp_model.CpSolver:
    """A solver for one tier, given the CHAIN's shared deadline."""
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(MIN_TIER_SECONDS, deadline - time.perf_counter())
    solver.parameters.num_search_workers = NUM_SEARCH_WORKERS
    # Keep these two. Read `cp_sat.model`'s docstring before concluding they
    # are dead weight: no test fails without them (measured, ~3x slower on this
    # board), but the failure they guard against — presolve eating the entire
    # wall and returning UNKNOWN with nothing placed — is silent.
    solver.parameters.symmetry_level = 0
    solver.parameters.cp_model_probing_level = 0
    return solver
