"""The servicer, driven in-process — no socket, no port, no real channel.

`grpc_testing.server_from_dictionary` runs the real `SchedulerServicer` behind
the real service descriptor, so metadata, status codes and response
serialisation are exercised exactly as a live server would exercise them,
while the test stays deterministic and instant.

Three things here are guarding known ways this handler can go wrong rather
than just describing what it does:

  * auth is checked BEFORE any work happens, so an unauthenticated caller can
    never make the box solve anything (`test_rejects_*` + the spy);
  * a `ValueError` raised inside the domain becomes a SOLVE_STATUS_ERROR
    response, never an unhandled exception crossing the RPC boundary;
  * only PROVED tiers are published in `objective_values` — the outcome can
    carry one more entry than `tiers_completed` when the clock cuts a tier
    short, and that unproven value must not go out on the wire.
"""

import dataclasses

import grpc
import grpc_testing
import pytest
from grpc_health.v1 import health_pb2, health_pb2_grpc

from cp_sat.config import Settings
from cp_sat.generated import scheduler_pb2, scheduler_pb2_grpc
from cp_sat.main import SchedulerServicer, build_health_servicer, build_server
from cp_sat.model import SolveOutcome
from cp_sat.objective import TIER_ORDER

SERVICE = scheduler_pb2.DESCRIPTOR.services_by_name["SchedulerService"]
SOLVE_BUILD = SERVICE.methods_by_name["SolveBuild"]
GOOD_AUTH = (("x-internal-secret", "test-secret"),)


@pytest.fixture
def settings(monkeypatch) -> Settings:
    monkeypatch.setenv("CPSAT_SERVICE_SECRET", "test-secret")
    monkeypatch.setenv("CPSAT_WALL_SECONDS_MAX", "10")
    return Settings.from_env()


@pytest.fixture
def test_server(settings):
    return grpc_testing.server_from_dictionary(
        {SERVICE: SchedulerServicer(settings)},
        grpc_testing.strict_real_time(),
    )


def _solvable_request(**overrides) -> scheduler_pb2.SolveBuildRequest:
    """One fixture, one court, one slot — small enough to prove OPTIMAL well
    inside the budget, so nothing here is timing-sensitive."""
    kwargs = dict(
        request_id="r1",
        courts=["Court 1"],
        fixtures=[scheduler_pb2.Fixture(fixture_id="f1", entrant_ids=["e1", "e2"], division_id="d1")],
        grid=scheduler_pb2.Grid(
            slots=[scheduler_pb2.Slot(court="Court 1", start_at_ms=0)], step_minutes=10
        ),
        constraints=scheduler_pb2.BuildConstraints(match_minutes=30, gap_minutes=10),
        wall_seconds=2.0,
    )
    kwargs.update(overrides)
    return scheduler_pb2.SolveBuildRequest(**kwargs)


def _invoke(server, request, metadata=GOOD_AUTH):
    return server.invoke_unary_unary(SOLVE_BUILD, metadata, request, None).termination()


# --- auth ------------------------------------------------------------------


def test_rejects_missing_auth_metadata(test_server):
    req = scheduler_pb2.SolveBuildRequest(request_id="r1")
    _, _, code, _ = _invoke(test_server, req, metadata=())
    assert code == grpc.StatusCode.UNAUTHENTICATED


def test_rejects_wrong_secret(test_server):
    """The missing-metadata case alone would still pass if the comparison were
    `secret in (None, shared_secret)` or similar; this pins that a present but
    wrong value is rejected too."""
    _, _, code, _ = _invoke(
        test_server, _solvable_request(), metadata=(("x-internal-secret", "wrong-secret"),)
    )
    assert code == grpc.StatusCode.UNAUTHENTICATED


def test_rejects_before_the_solve_ever_runs(test_server, monkeypatch):
    """The acceptance criterion is 'rejected BEFORE the solve ever runs', which
    a status-code assertion cannot see. An unauthenticated caller must not be
    able to spend a single CPU-second of the box's budget."""
    calls: list[str] = []

    def _spy_build_model(*args, **kwargs):
        calls.append("build_model")
        raise AssertionError("build_model must not run for an unauthenticated request")

    monkeypatch.setattr("cp_sat.main.build_model", _spy_build_model)

    _, _, code, _ = _invoke(test_server, _solvable_request(), metadata=())
    assert code == grpc.StatusCode.UNAUTHENTICATED
    assert calls == []


def test_auth_metadata_key_is_matched_case_insensitively(test_server):
    """HTTP/2 header names are case-insensitive and a real gRPC transport
    lower-cases them before the servicer sees them; the in-process harness does
    not. Normalising in the handler keeps the two behaving the same."""
    _, _, code, _ = _invoke(
        test_server, _solvable_request(), metadata=(("X-Internal-Secret", "test-secret"),)
    )
    assert code == grpc.StatusCode.OK


# --- happy path ------------------------------------------------------------


def test_accepts_valid_request_with_correct_secret(test_server):
    response, _, code, _ = _invoke(test_server, _solvable_request())
    assert code == grpc.StatusCode.OK
    assert response.status in (scheduler_pb2.SOLVE_STATUS_OPTIMAL, scheduler_pb2.SOLVE_STATUS_FEASIBLE)
    # Status alone is not evidence of a board: the chain reports OPTIMAL for an
    # EMPTY schedule just as readily, so assert the fixture actually landed.
    assert [(a.fixture_id, a.court, a.start_at_ms) for a in response.assignments] == [
        ("f1", "Court 1", 0)
    ]
    assert response.tiers_completed > 0
    assert response.elapsed_ms >= 0


def test_clamps_wall_seconds_to_the_server_ceiling(test_server, monkeypatch):
    """`wall_seconds` is caller-supplied. Without the clamp one request can pin
    a worker thread for as long as it likes."""
    seen: list[float] = []

    def _spy_solve(model, wall_seconds):
        seen.append(wall_seconds)
        return SolveOutcome(
            assignments=[], status="OPTIMAL", tiers_completed=4, objective_values=[], elapsed_ms=1
        )

    monkeypatch.setattr("cp_sat.main.solve", _spy_solve)

    _, _, code, _ = _invoke(test_server, _solvable_request(wall_seconds=999.0))
    assert code == grpc.StatusCode.OK
    assert seen == [10.0]  # CPSAT_WALL_SECONDS_MAX, not the 999 that was asked for


# --- invalid requests ------------------------------------------------------


def test_maps_invalid_request_to_error_response(test_server):
    """Rejected at the wire boundary by `schema.request_to_model_input`. The
    RPC still succeeds — the caller gets a well-formed answer saying why."""
    response, _, code, _ = _invoke(test_server, scheduler_pb2.SolveBuildRequest(request_id="r1"))
    assert code == grpc.StatusCode.OK
    assert response.status == scheduler_pb2.SOLVE_STATUS_ERROR
    assert response.error.code == "INVALID_REQUEST"
    assert "fixtures" in response.error.message


@pytest.mark.parametrize(
    "field,value",
    [
        ("match_minutes", 0),
        ("day_cap", 0),
        ("wall_seconds", 0.0),
    ],
)
def test_degenerate_scalars_come_back_as_error_not_a_wrong_board(test_server, field, value):
    """Each of these is an UNSET proto3 scalar arriving as 0, and each would
    otherwise produce a confidently wrong board reported as OPTIMAL. The wire
    boundary rejects all three, so none of them reaches the solver."""
    if field == "match_minutes":
        req = _solvable_request(
            constraints=scheduler_pb2.BuildConstraints(match_minutes=value, gap_minutes=10)
        )
    elif field == "day_cap":
        req = _solvable_request(
            constraints=scheduler_pb2.BuildConstraints(
                match_minutes=30,
                gap_minutes=10,
                day_cap_by_division=[
                    scheduler_pb2.DivisionDayCapRule(division_id="d1", max_fixtures_per_day=value)
                ],
            )
        )
    else:
        req = _solvable_request(wall_seconds=value)

    response, _, code, _ = _invoke(test_server, req)
    assert code == grpc.StatusCode.OK
    assert response.status == scheduler_pb2.SOLVE_STATUS_ERROR
    assert response.error.code == "INVALID_REQUEST"
    assert len(response.assignments) == 0


@pytest.mark.parametrize("target", ["build_model", "solve"])
def test_domain_value_error_becomes_an_error_response(test_server, monkeypatch, target):
    """Defence in depth, and deliberately not dead code. `build_model` and
    `run_tier_chain` keep their own guards; if one of them ever fires for a
    request the wire boundary let through, the handler must still answer rather
    than let a raw exception escape as an UNKNOWN gRPC error."""

    def _raise(*args, **kwargs):
        raise ValueError("boom from the domain")

    monkeypatch.setattr(f"cp_sat.main.{target}", _raise)

    response, _, code, _ = _invoke(test_server, _solvable_request())
    assert code == grpc.StatusCode.OK
    assert response.status == scheduler_pb2.SOLVE_STATUS_ERROR
    assert response.error.code == "INVALID_REQUEST"
    assert "boom from the domain" in response.error.message


# --- objective_values: only what was PROVED --------------------------------


def test_publishes_only_confirmed_objective_values(test_server, monkeypatch):
    """`SolveOutcome.objective_values` can be ONE longer than
    `tiers_completed`: when the wall budget cuts a tier short mid-solve the
    outcome still records that tier's last-known value without counting it as
    completed. Publishing it would tell the caller a value was proved when it
    was not."""

    def _cut_short_solve(model, wall_seconds):
        return SolveOutcome(
            assignments=[("f1", "Court 1", 0)],
            status="FEASIBLE",
            tiers_completed=1,
            # T1 (makespan) was cut short: recorded, but NOT proved.
            objective_values=[(TIER_ORDER[0], 1), (TIER_ORDER[1], 999)],
            elapsed_ms=2000,
        )

    monkeypatch.setattr("cp_sat.main.solve", _cut_short_solve)

    response, _, code, _ = _invoke(test_server, _solvable_request())
    assert code == grpc.StatusCode.OK
    assert response.tiers_completed == 1
    assert [(t.name, t.value) for t in response.objective_values] == [(TIER_ORDER[0], 1)]


def test_publishes_every_objective_value_when_all_tiers_proved(test_server, monkeypatch):
    """The other side of the slice: a completed chain must not lose a tier to
    an off-by-one."""

    def _full_chain_solve(model, wall_seconds):
        return SolveOutcome(
            assignments=[("f1", "Court 1", 0)],
            status="OPTIMAL",
            tiers_completed=len(TIER_ORDER),
            objective_values=[(name, i) for i, name in enumerate(TIER_ORDER)],
            elapsed_ms=1000,
        )

    monkeypatch.setattr("cp_sat.main.solve", _full_chain_solve)

    response, _, _, _ = _invoke(test_server, _solvable_request())
    assert response.tiers_completed == len(TIER_ORDER)
    assert [t.name for t in response.objective_values] == list(TIER_ORDER)


# --- health ----------------------------------------------------------------


def test_health_check_reports_serving():
    """The deploy's readiness probe. Built by the same function `serve()` calls,
    so a wiring change that stops setting SERVING fails here."""
    health_service = health_pb2.DESCRIPTOR.services_by_name["Health"]
    server = grpc_testing.server_from_dictionary(
        {health_service: build_health_servicer()},
        grpc_testing.strict_real_time(),
    )
    response, _, code, _ = server.invoke_unary_unary(
        health_service.methods_by_name["Check"], (), health_pb2.HealthCheckRequest(service=""), None
    ).termination()
    assert code == grpc.StatusCode.OK
    assert response.status == health_pb2.HealthCheckResponse.SERVING


# --- the real registration path --------------------------------------------


def test_build_server_registers_both_services_on_a_real_port(settings):
    """`grpc_testing` never binds a port and never calls
    `add_*Servicer_to_server`, so everything `serve()` actually does to stand
    the service up was untested — all three of its registration lines could be
    deleted with the suite still green.

    This drives `build_server` (the same function `serve()` calls) over a REAL
    channel: health must answer SERVING, the scheduler must be reachable, and
    auth must hold across a real transport — which, unlike the in-process
    harness, lower-cases metadata keys for us.

    Port 0 asks the OS for a free port and `add_insecure_port` returns the one
    it got, so this cannot collide with a squatted fixed port or with a
    concurrent agent's server.
    """
    server, port = build_server(dataclasses.replace(settings, port=0))
    assert port != 0, "add_insecure_port returned 0 — nothing is listening"
    server.start()
    channel = grpc.insecure_channel(f"localhost:{port}")
    try:
        grpc.channel_ready_future(channel).result(timeout=10)

        health = health_pb2_grpc.HealthStub(channel).Check(
            health_pb2.HealthCheckRequest(service=""), timeout=10
        )
        assert health.status == health_pb2.HealthCheckResponse.SERVING

        stub = scheduler_pb2_grpc.SchedulerServiceStub(channel)

        # Registered AND authenticated: without the servicer registration this
        # would be UNIMPLEMENTED, not UNAUTHENTICATED.
        with pytest.raises(grpc.RpcError) as excinfo:
            stub.SolveBuild(_solvable_request(), timeout=10)
        assert excinfo.value.code() == grpc.StatusCode.UNAUTHENTICATED

        response = stub.SolveBuild(_solvable_request(), metadata=GOOD_AUTH, timeout=10)
        assert response.status == scheduler_pb2.SOLVE_STATUS_OPTIMAL
        assert [(a.fixture_id, a.court, a.start_at_ms) for a in response.assignments] == [
            ("f1", "Court 1", 0)
        ]
    finally:
        channel.close()
        server.stop(None)


# --- the brief's acceptance criterion, on the production board --------------


def test_production_board_solves_through_the_server(test_server):
    """The brief's acceptance criterion: "a well-formed, correctly-authenticated
    request against the production board shape returns OPTIMAL or FEASIBLE".

    Every other test here uses a one-fixture toy board, which never exercises
    `existing`, `dependencies`, `rest_by_division` or `day_cap_by_division`
    through the wire mapping at all — a dropped field in `schema.py` would
    relax the board and go unnoticed. This drives the bench's own
    `production_board()` (37 fixtures, 5 courts, ~2081 slots) end to end.

    Deliberately does NOT assert `tiers_completed == 4`: the T0-T3 chain is
    ~4.9s idle but 9-11s under load, so that assertion is a flake generator
    under parallel agents. What is asserted instead is that the BOARD is real —
    status alone is not evidence, since the chain reports OPTIMAL just as
    readily for an empty schedule.
    """
    from cpsat_bench_boards import production_board

    fixtures, courts, grid_slots, step_minutes, constraints, existing, dependencies = (
        production_board()
    )

    req = scheduler_pb2.SolveBuildRequest(
        request_id="prod-37x77k",
        courts=courts,
        fixtures=[
            scheduler_pb2.Fixture(fixture_id=fid, entrant_ids=entrants, division_id=division)
            for fid, entrants, division in fixtures
        ],
        grid=scheduler_pb2.Grid(
            slots=[scheduler_pb2.Slot(court=court, start_at_ms=start) for court, start in grid_slots],
            step_minutes=step_minutes,
        ),
        existing=[
            scheduler_pb2.Assignment(fixture_id=fid, court=court, start_at_ms=start)
            for fid, court, start in existing
        ],
        dependencies=[
            scheduler_pb2.OrderPair(before_fixture_id=before, after_fixture_id=after)
            for before, after in dependencies
        ],
        constraints=scheduler_pb2.BuildConstraints(
            match_minutes=constraints["match_minutes"],
            gap_minutes=constraints["gap_minutes"],
            rest_by_division=[
                scheduler_pb2.DivisionRestRule(division_id=d, min_rest_minutes=v)
                for d, v in constraints["rest_by_division"].items()
            ],
            day_cap_by_division=[
                scheduler_pb2.DivisionDayCapRule(division_id=d, max_fixtures_per_day=v)
                for d, v in constraints["day_cap_by_division"].items()
            ],
        ),
        wall_seconds=8.0,
    )

    response, _, code, _ = _invoke(test_server, req)

    assert code == grpc.StatusCode.OK
    assert response.status in (
        scheduler_pb2.SOLVE_STATUS_OPTIMAL,
        scheduler_pb2.SOLVE_STATUS_FEASIBLE,
    )
    assert not response.HasField("error")
    assert response.tiers_completed >= 1

    placed = [(a.fixture_id, a.court, a.start_at_ms) for a in response.assignments]
    assert len(placed) > 0

    # A board, not just a status. Each of these is a way the wire mapping could
    # be wrong while the solve still reports success.
    fixture_ids = {fid for fid, _entrants, _division in fixtures}
    assert {fid for fid, _c, _s in placed} <= fixture_ids
    assert len({fid for fid, _c, _s in placed}) == len(placed), "a fixture was placed twice"
    assert {court for _f, court, _s in placed} <= set(courts)
    # The lattice actually reached the model: every (court, start) has to be a
    # real grid point. An empty or ignored grid collapses every start onto tick
    # 0 instead — precisely the empty-Grid failure this round also fixed.
    assert {(court, start) for _f, court, start in placed} <= set(grid_slots)
    assert len({start for _f, _c, start in placed}) > 1, "every fixture landed on one tick"
