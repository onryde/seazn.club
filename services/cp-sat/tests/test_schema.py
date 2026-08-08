"""The wire boundary, both directions: proto in via `request_to_model_input`,
proto out via `outcome_to_response` / `error_response`.

This is the anti-corruption layer. Domain code (`cp_sat.model` /
`cp_sat.objective`) never sees a proto type in either direction, and — the
point of most of the tests below — never sees a request that would make it
produce a confidently wrong board. `build_model` and `run_tier_chain` keep
their own guards on the same three fields; those are defence in depth, not the
first line. Rejecting here is what turns the failure into a clean
`SOLVE_STATUS_ERROR` response instead of an exception escaping the handler.

Every one of the three is a proto3 non-optional scalar, so UNSET arrives as
`0` and is indistinguishable from a deliberate zero.
"""

import pytest

from cp_sat.generated import scheduler_pb2
from cp_sat.model import SolveOutcome
from cp_sat.objective import TIER_ORDER
from cp_sat.schema import (
    InvalidRequestError,
    error_response,
    outcome_to_response,
    request_to_model_input,
)


def _valid_request(**overrides) -> scheduler_pb2.SolveBuildRequest:
    """A minimal request that maps cleanly, so each test below can break
    exactly one field and know that field is why it was rejected."""
    kwargs = dict(
        request_id="r1",
        courts=["Court 1"],
        fixtures=[scheduler_pb2.Fixture(fixture_id="f1", entrant_ids=["e1", "e2"], division_id="d1")],
        grid=scheduler_pb2.Grid(
            slots=[scheduler_pb2.Slot(court="Court 1", start_at_ms=0)],
            step_minutes=10,
        ),
        constraints=scheduler_pb2.BuildConstraints(match_minutes=30, gap_minutes=10),
        wall_seconds=8.0,
    )
    kwargs.update(overrides)
    return scheduler_pb2.SolveBuildRequest(**kwargs)


def test_rejects_empty_fixtures():
    req = scheduler_pb2.SolveBuildRequest(request_id="r1", courts=["Court 1"])
    with pytest.raises(InvalidRequestError, match="fixtures"):
        request_to_model_input(req)


def test_rejects_empty_courts():
    req = scheduler_pb2.SolveBuildRequest(
        request_id="r1",
        fixtures=[scheduler_pb2.Fixture(fixture_id="f1", entrant_ids=["e1"], division_id="d1")],
    )
    with pytest.raises(InvalidRequestError, match="courts"):
        request_to_model_input(req)


def test_maps_valid_request():
    req = _valid_request()
    parsed = request_to_model_input(req)
    assert parsed.courts == ["Court 1"]
    assert len(parsed.fixtures) == 1
    assert parsed.wall_seconds == 8.0


def test_maps_every_field_through():
    """The whole translation, not just the three fields the guards read — a
    dropped `existing` or `dependencies` list silently relaxes the board."""
    req = _valid_request(
        existing=[scheduler_pb2.Assignment(fixture_id="x1", court="Court 1", start_at_ms=1000)],
        dependencies=[scheduler_pb2.OrderPair(before_fixture_id="f1", after_fixture_id="x1")],
        constraints=scheduler_pb2.BuildConstraints(
            match_minutes=30,
            gap_minutes=10,
            rest_by_division=[scheduler_pb2.DivisionRestRule(division_id="d1", min_rest_minutes=45)],
            day_cap_by_division=[
                scheduler_pb2.DivisionDayCapRule(division_id="d1", max_fixtures_per_day=3)
            ],
        ),
    )
    parsed = request_to_model_input(req)
    assert parsed.fixtures == [("f1", ["e1", "e2"], "d1")]
    assert parsed.grid_slots == [("Court 1", 0)]
    assert parsed.step_minutes == 10
    assert parsed.constraints == {
        "match_minutes": 30,
        "gap_minutes": 10,
        "rest_by_division": {"d1": 45},
        "day_cap_by_division": {"d1": 3},
    }
    assert parsed.existing == [("x1", "Court 1", 1000)]
    assert parsed.dependencies == [("f1", "x1")]


# --- degenerate scalars ----------------------------------------------------
# Each of these three is separately guarded downstream. They are rejected HERE
# so the caller gets SOLVE_STATUS_ERROR with a reason, and so the domain never
# has to be the thing that notices.


@pytest.mark.parametrize("match_minutes", [0, -1])
def test_rejects_non_positive_match_minutes(match_minutes):
    """A zero-length match makes every court and rest interval zero-width, so
    NoOverlap constrains nothing and the solve returns OPTIMAL with the whole
    board stacked on one tick. `match_minutes=0` is also what an UNSET
    `BuildConstraints.match_minutes` looks like on the wire."""
    req = _valid_request(
        constraints=scheduler_pb2.BuildConstraints(match_minutes=match_minutes, gap_minutes=10)
    )
    with pytest.raises(InvalidRequestError, match="match_minutes"):
        request_to_model_input(req)


@pytest.mark.parametrize("cap", [0, -1])
def test_rejects_non_positive_day_cap(cap):
    """A cap of 0 forbids placing that division at all; the solve then reports
    OPTIMAL having silently dropped every one of its fixtures. Uncapped is
    expressed by omitting the division, never by sending 0."""
    req = _valid_request(
        constraints=scheduler_pb2.BuildConstraints(
            match_minutes=30,
            gap_minutes=10,
            day_cap_by_division=[
                scheduler_pb2.DivisionDayCapRule(division_id="d1", max_fixtures_per_day=cap)
            ],
        )
    )
    with pytest.raises(InvalidRequestError, match="d1"):
        request_to_model_input(req)


def test_accepts_day_cap_rules_when_all_positive():
    """The guard is per-rule; a board with several capped divisions must still
    map, or the check has quietly become 'no caps allowed'."""
    req = _valid_request(
        constraints=scheduler_pb2.BuildConstraints(
            match_minutes=30,
            gap_minutes=10,
            day_cap_by_division=[
                scheduler_pb2.DivisionDayCapRule(division_id="d1", max_fixtures_per_day=3),
                scheduler_pb2.DivisionDayCapRule(division_id="d2", max_fixtures_per_day=1),
            ],
        )
    )
    parsed = request_to_model_input(req)
    assert parsed.constraints["day_cap_by_division"] == {"d1": 3, "d2": 1}


@pytest.mark.parametrize("wall_seconds", [0.0, -1.0])
def test_rejects_non_positive_wall_seconds(wall_seconds):
    """A 0 budget stops the tier chain before T0 ever runs and comes back
    UNKNOWN with no assignments — the same answer a genuinely impossible board
    gives, so a dropped field would read as a solver verdict."""
    req = _valid_request(wall_seconds=wall_seconds)
    with pytest.raises(InvalidRequestError, match="wall_seconds"):
        request_to_model_input(req)


def test_invalid_request_error_is_a_value_error():
    """`main.py` catches `InvalidRequestError` and `ValueError` on separate
    branches; both must land on the same SOLVE_STATUS_ERROR shape, and the
    subclass relationship is what keeps a missed branch from escaping."""
    assert issubclass(InvalidRequestError, ValueError)


# --- the outbound half of the boundary --------------------------------------


def _outcome(**overrides) -> SolveOutcome:
    kwargs = dict(
        assignments=[("f1", "Court 1", 0)],
        status="OPTIMAL",
        tiers_completed=len(TIER_ORDER),
        objective_values=[(name, i) for i, name in enumerate(TIER_ORDER)],
        elapsed_ms=1000,
    )
    kwargs.update(overrides)
    return SolveOutcome(**kwargs)


def test_error_response_shape():
    resp = error_response("INVALID_REQUEST", "fixtures must not be empty")
    assert resp.status == scheduler_pb2.SOLVE_STATUS_ERROR
    assert resp.error.code == "INVALID_REQUEST"
    assert resp.error.message == "fixtures must not be empty"
    assert len(resp.assignments) == 0


def test_outcome_to_response_maps_every_field():
    resp = outcome_to_response(_outcome(), wall_seconds=10.0)
    assert [(a.fixture_id, a.court, a.start_at_ms) for a in resp.assignments] == [("f1", "Court 1", 0)]
    assert resp.status == scheduler_pb2.SOLVE_STATUS_OPTIMAL
    assert resp.tiers_completed == len(TIER_ORDER)
    assert resp.elapsed_ms == 1000
    assert resp.wall_exhausted is False
    assert [t.name for t in resp.objective_values] == list(TIER_ORDER)


@pytest.mark.parametrize(
    "status,expected",
    [
        ("OPTIMAL", scheduler_pb2.SOLVE_STATUS_OPTIMAL),
        ("FEASIBLE", scheduler_pb2.SOLVE_STATUS_FEASIBLE),
        ("INFEASIBLE", scheduler_pb2.SOLVE_STATUS_INFEASIBLE),
        ("UNKNOWN", scheduler_pb2.SOLVE_STATUS_UNKNOWN),
        # CP-SAT's vocabulary is passed through verbatim by the domain, so a
        # status this layer does not know about must become ERROR rather than
        # be guessed at — an unmapped name defaulting to 0 would serialise as
        # SOLVE_STATUS_UNSPECIFIED and read as "fine".
        ("MODEL_INVALID", scheduler_pb2.SOLVE_STATUS_ERROR),
    ],
)
def test_outcome_to_response_maps_status(status, expected):
    assert outcome_to_response(_outcome(status=status), wall_seconds=10.0).status == expected


def test_outcome_to_response_publishes_only_proved_tiers():
    """`objective_values` can be ONE longer than `tiers_completed`: a tier cut
    short by the clock records its last-known value without being counted. That
    value was never proved optimal and must not go out on the wire as if it
    had been."""
    outcome = _outcome(
        status="FEASIBLE",
        tiers_completed=1,
        objective_values=[(TIER_ORDER[0], 1), (TIER_ORDER[1], 999)],
    )
    resp = outcome_to_response(outcome, wall_seconds=10.0)
    assert resp.tiers_completed == 1
    assert [(t.name, t.value_ms) for t in resp.objective_values] == [(TIER_ORDER[0], 1)]


@pytest.mark.parametrize(
    "elapsed_ms,wall_seconds,exhausted",
    [(9999, 10.0, False), (10000, 10.0, True), (10500, 10.0, True)],
)
def test_outcome_to_response_reports_wall_exhausted(elapsed_ms, wall_seconds, exhausted):
    resp = outcome_to_response(_outcome(elapsed_ms=elapsed_ms), wall_seconds=wall_seconds)
    assert resp.wall_exhausted is exhausted
