"""The anti-corruption layer between the wire and the domain.

This module is the ONLY place a proto message is read, and the ONLY place a
plain-Python solve result is turned back into one — both directions, one file.
`cp_sat.model` and `cp_sat.objective` are written against tuples, dicts and
floats and must never import `scheduler_pb2`; `cp_sat.main` orchestrates
(authenticate, translate in, compute, translate out) but holds no domain logic
and constructs no proto message of its own. That boundary is the design's, not
a style preference — it is what lets the solver be tested, benched and reasoned
about without a gRPC runtime.

It is also where degenerate requests are rejected. Proto3 has no way to say
"absent" for a non-optional scalar or for a message field, so a field the
caller simply failed to set arrives as `0` / empty and is indistinguishable
from a deliberate zero — and each of the four below makes the solver return a
confidently WRONG board with a healthy-looking status rather than an error:

  * `constraints.match_minutes == 0` — zero-width intervals, so NoOverlap
    constrains nothing and every fixture stacks on one tick. OPTIMAL.
  * a `day_cap_by_division` value of `0` — that division may not be placed at
    all, and the solve reports OPTIMAL having dropped all of its fixtures.
  * `wall_seconds == 0` — the tier chain stops before T0, returning UNKNOWN
    with no assignments, which is exactly what an impossible board returns.
  * `grid.slots` empty — the same trap one level up, in a MESSAGE field rather
    than a scalar: an omitted `grid` and a `grid` carrying no slots are the
    same bytes. `build_model` then falls back to `Domain.FromValues([0])`,
    every fixture is forced onto tick 0, and one fixture per court is placed
    and proved OPTIMAL while the rest are silently dropped. Measured through
    the real server: 8 fixtures, 2 courts, no grid -> OPTIMAL, `error` unset,
    2 of 8 placed, both at `start_at_ms=0`, `tiers_completed=4`.

`build_model` and `run_tier_chain` guard the first THREE themselves and raise
`ValueError`. Those guards stay: they protect the bench and any future caller.
But the wire is where the mistake is actually made, so it is caught here first
and as an `InvalidRequestError`, which `cp_sat.main` turns into a
`SOLVE_STATUS_ERROR` response carrying the reason — a well-formed answer the
caller can act on, rather than an exception crossing the RPC boundary.

The FOURTH — the empty grid — has no downstream guard at all. `build_model`
treats an empty `grid_slots` as a legal board with one admissible start rather
than as an error, so there is no `ValueError` for `main.py`'s backstop to
catch. This layer is the only thing standing between an omitted `Grid` and an
OPTIMAL response for a board that was never really scheduled. Do not remove it
on the assumption that the domain will catch it.
"""

from __future__ import annotations

from dataclasses import dataclass

from cp_sat.generated import scheduler_pb2
from cp_sat.model import SolveOutcome
from cp_sat.objective import MIN_TIER_SECONDS

# `SolveOutcome.status` is CP-SAT's own vocabulary, passed through verbatim by
# the domain. Anything not listed — MODEL_INVALID, or a future OR-Tools status
# — maps to ERROR rather than being guessed at. It must NOT fall through to the
# proto default, which is SOLVE_STATUS_UNSPECIFIED (0) and would read as fine.
STATUS_MAP = {
    "OPTIMAL": scheduler_pb2.SOLVE_STATUS_OPTIMAL,
    "FEASIBLE": scheduler_pb2.SOLVE_STATUS_FEASIBLE,
    "INFEASIBLE": scheduler_pb2.SOLVE_STATUS_INFEASIBLE,
    "UNKNOWN": scheduler_pb2.SOLVE_STATUS_UNKNOWN,
}


class InvalidRequestError(ValueError):
    """The request cannot be turned into a solvable model.

    A `ValueError` subclass on purpose: `build_model`/`solve` raise plain
    `ValueError` for the same conditions, and `cp_sat.main` maps both onto one
    response shape. Anything that catches `ValueError` therefore cannot miss
    this, whichever layer noticed first.
    """


@dataclass(frozen=True)
class ModelInput:
    """Exactly `build_model`'s arguments plus the wall budget, in domain types.

    Field order and shapes mirror `cp_sat.model.build_model`'s signature so the
    call site in `main.py` is a straight unpack with nothing to get wrong.
    """

    courts: list[str]
    fixtures: list[tuple[str, list[str], str]]  # (fixture_id, entrant_ids, division_id)
    grid_slots: list[tuple[str, int]]  # (court, start_at_ms)
    step_minutes: int
    constraints: dict
    existing: list[tuple[str, str, int]]  # (fixture_id, court, start_at_ms)
    dependencies: list[tuple[str, str]]  # (before_fixture_id, after_fixture_id)
    wall_seconds: float


def request_to_model_input(req) -> ModelInput:
    """Translate a `SolveBuildRequest` into domain types, or reject it.

    Args:
        req: a `scheduler_pb2.SolveBuildRequest`. Untyped in the signature so
            this module's *callers* need the proto import and its *consumers*
            do not — the boundary runs through here in one direction only.

    Raises:
        InvalidRequestError: on an empty board, or on any of the four
            degenerate fields enumerated in the module docstring.
    """
    if len(req.fixtures) == 0:
        raise InvalidRequestError("fixtures must not be empty")
    if len(req.courts) == 0:
        raise InvalidRequestError("courts must not be empty")
    if len(req.grid.slots) == 0:
        raise InvalidRequestError(
            "grid.slots must not be empty. `Grid` is a proto3 message field, so an omitted grid "
            "and a grid with no slots arrive identically — and neither is an error downstream: "
            "the model falls back to a single admissible start of 0, places one fixture per "
            "court there, and proves that OPTIMAL with every other fixture silently unplaced."
        )

    # Built before it is validated, and validated off the built dict rather
    # than off the repeated proto field: `build_model` guards the dict, so
    # checking the same object it will check is what keeps the two from ever
    # disagreeing about which values are admissible.
    constraints = {
        "match_minutes": req.constraints.match_minutes,
        "gap_minutes": req.constraints.gap_minutes,
        "rest_by_division": {r.division_id: r.min_rest_minutes for r in req.constraints.rest_by_division},
        "day_cap_by_division": {
            r.division_id: r.max_fixtures_per_day for r in req.constraints.day_cap_by_division
        },
    }

    if constraints["match_minutes"] <= 0:
        raise InvalidRequestError(
            f"constraints.match_minutes must be > 0, got {constraints['match_minutes']!r}. "
            "A zero-length match makes every court and rest interval zero-width, so the board "
            "comes back OPTIMAL with every fixture stacked on one tick."
        )

    for division, cap in constraints["day_cap_by_division"].items():
        if cap <= 0:
            raise InvalidRequestError(
                f"constraints.day_cap_by_division[{division!r}].max_fixtures_per_day must be > 0, "
                f"got {cap!r}. A cap of 0 forbids placing that division at all and the board comes "
                "back OPTIMAL with all of its fixtures dropped. To leave a division uncapped, omit "
                "it rather than sending 0."
            )

    if req.wall_seconds <= 0:
        raise InvalidRequestError(
            f"wall_seconds must be > 0, got {req.wall_seconds!r}. A 0 budget stops the tier chain "
            "before T0 runs and returns UNKNOWN with no assignments — the same answer an impossible "
            "board gives, so an unset field would read as a solver verdict about the request."
        )

    return ModelInput(
        courts=list(req.courts),
        fixtures=[(f.fixture_id, list(f.entrant_ids), f.division_id) for f in req.fixtures],
        grid_slots=[(s.court, s.start_at_ms) for s in req.grid.slots],
        step_minutes=req.grid.step_minutes,
        constraints=constraints,
        existing=[(a.fixture_id, a.court, a.start_at_ms) for a in req.existing],
        dependencies=[(d.before_fixture_id, d.after_fixture_id) for d in req.dependencies],
        wall_seconds=req.wall_seconds,
    )


def error_response(code: str, message: str) -> scheduler_pb2.SolveBuildResponse:
    """A rejected request is a SUCCESSFUL RPC carrying a reason, not a gRPC
    error. The caller (`build.ts`) can fall back on its own heuristic placer
    given a reason; it can do nothing useful with a transport-level failure.

    One constructor for every rejection path — the wire-boundary one and the
    domain's own `ValueError` backstop — so whichever layer noticed first, the
    caller sees exactly one shape.
    """
    return scheduler_pb2.SolveBuildResponse(
        status=scheduler_pb2.SOLVE_STATUS_ERROR,
        error=scheduler_pb2.SolveError(code=code, message=message),
    )


def outcome_to_response(
    outcome: SolveOutcome, wall_seconds: float
) -> scheduler_pb2.SolveBuildResponse:
    """Translate a solve result back onto the wire.

    Args:
        outcome: the domain's `SolveOutcome`, in plain Python.
        wall_seconds: the budget the solve was actually GIVEN — the clamped
            value, not whatever the request asked for. `wall_exhausted` is
            meaningless against a budget that was never applied.
    """
    # An unmapped status is the one SOLVE_STATUS_ERROR path reached WITHOUT an
    # exception having been raised — the domain returned a status vocabulary
    # this layer has no entry for (`MODEL_INVALID`, or a future OR-Tools
    # status), so there is no `str(exc)` to hand on. It has to build its own
    # `SolveError`, or it becomes the only error response in the service that
    # tells the caller nothing about why. `error=None` leaves the field unset,
    # which is what every mapped status wants.
    #
    # This branch still maps `assignments` through, which is safe only because
    # of a guarantee that lives in another module: `objective._chain_status`
    # returns a raw solver status name (the only way to get a name that is not
    # in STATUS_MAP) exclusively on its `if not assignments` path — a mapped
    # status is returned whenever there IS a board. So an unmapped status
    # cannot arrive carrying assignments, and this response cannot ship a board
    # alongside an ERROR. Stated here because it is not visible from this file,
    # and a future change to `_chain_status` would break it silently.
    status = STATUS_MAP.get(outcome.status)
    error = None
    if status is None:
        status = scheduler_pb2.SOLVE_STATUS_ERROR
        error = scheduler_pb2.SolveError(
            code="INTERNAL_ERROR",
            message=(
                f"solver returned unmapped status {outcome.status!r}; expected one of "
                f"{sorted(STATUS_MAP)}. Treat this response as an error, not as a board."
            ),
        )

    return scheduler_pb2.SolveBuildResponse(
        assignments=[
            scheduler_pb2.Assignment(fixture_id=fid, court=court, start_at_ms=start)
            for fid, court, start in outcome.assignments
        ],
        status=status,
        error=error,
        tiers_completed=outcome.tiers_completed,
        # Sliced to the PROVED tiers. `objective_values` can carry one more
        # entry than `tiers_completed`: when the clock cuts a tier short
        # mid-solve the outcome still records that tier's last-known value,
        # deliberately, without counting it as completed. Publishing that entry
        # would tell the caller a value had been proved optimal when it is only
        # the best thing seen before the budget ran out.
        objective_values=[
            scheduler_pb2.Tier(name=name, value_ms=value)
            for name, value in outcome.objective_values[: outcome.tiers_completed]
        ],
        elapsed_ms=outcome.elapsed_ms,
        # Against the wall MINUS the tier loop's own proactive-break margin,
        # not against the raw wall. `run_tier_chain` stops when
        # `deadline - now <= MIN_TIER_SECONDS` rather than starting a tier it
        # cannot finish, so a chain genuinely cut short by the budget reports
        # an `elapsed_ms` up to 50ms UNDER the wall. Comparing against the raw
        # wall calls that `False` and tells the caller the budget was not the
        # limiting factor — the one thing this flag exists to say. Derived from
        # `MIN_TIER_SECONDS` rather than a literal so the two move together.
        wall_exhausted=outcome.elapsed_ms >= int((wall_seconds - MIN_TIER_SECONDS) * 1000),
    )
