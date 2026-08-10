"""The solver knobs are READ FROM THE ENVIRONMENT, and a solve says what it did.

THIS FILE IS THE REGRESSION TEST FOR A REAL PRODUCTION INCIDENT, 2026-08-10.

`NUM_SEARCH_WORKERS` was set in `fly.toml`'s `[env]` and had **no effect
whatsoever**: it was a hardcoded module constant, and `config.py` read only
PLACEMENT_SERVICE_SECRET / _MAX_WORKERS / _WALL_SECONDS_MAX / _PORT. Four
production deploys were then spent varying the wall (10s -> 30s) and the
machine (shared-cpu-2x -> performance-8x/16gb) while the one variable everybody
believed was being tuned never moved off 8. Every run returned a byte-identical
board.

A knob that silently does nothing is worse than no knob: it makes an experiment
look conclusive when it never ran. So each knob is asserted to (a) have the
documented default and (b) actually change when the environment changes — the
second half is what fails against the old hardcoded constants.

The constants are read at IMPORT, deliberately (process-level solver settings
should not differ between two solves on one machine), so these tests reload the
module rather than monkeypatching an attribute — patching the attribute would
pass even if nothing ever read the environment, which is exactly the vacuous
shape this file exists to prevent.
"""

from __future__ import annotations

import importlib
import logging
import time

import pytest

import placement.model
import placement.objective


def _reload_model(monkeypatch, **env: str):
    """Re-import `placement.model` under a given environment."""
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    return importlib.reload(placement.model)


@pytest.fixture(autouse=True)
def _restore_model_constants():
    """Leave the module as we found it — later tests in this worker read these."""
    yield
    importlib.reload(placement.model)


def test_the_knobs_have_their_documented_defaults(monkeypatch):
    """Unset environment must reproduce the shipped behaviour exactly.

    These three defaults are what every measurement in this service's docs was
    taken against, so a change here silently invalidates the record.
    """
    for key in (
        "PLACEMENT_NUM_SEARCH_WORKERS",
        "PLACEMENT_SYMMETRY_LEVEL",
        "PLACEMENT_PROBING_LEVEL",
    ):
        monkeypatch.delenv(key, raising=False)
    model = importlib.reload(placement.model)

    assert model.NUM_SEARCH_WORKERS == 8
    assert model.SYMMETRY_LEVEL == 0
    assert model.CP_MODEL_PROBING_LEVEL == 0


def test_num_search_workers_is_actually_read_from_the_environment(monkeypatch):
    """THE regression test. This fails against a hardcoded constant.

    Not asserting "the attribute can be set" — that is true of any module
    attribute and proves nothing. Asserting that a value in the ENVIRONMENT
    reaches the constant, which is the thing that was false in production.
    """
    model = _reload_model(monkeypatch, PLACEMENT_NUM_SEARCH_WORKERS="3")
    assert model.NUM_SEARCH_WORKERS == 3


def test_symmetry_and_probing_are_actually_read_from_the_environment(monkeypatch):
    """Both presolve knobs, for the same reason.

    They are pinned to 0 to stop presolve eating the whole wall on a symmetric
    board — a failure that returns UNKNOWN with nothing placed and says nothing.
    That tradeoff was measured on the BENCH board, so re-measuring it on a real
    one must not require a code deploy.
    """
    model = _reload_model(
        monkeypatch,
        PLACEMENT_SYMMETRY_LEVEL="2",
        PLACEMENT_PROBING_LEVEL="1",
    )
    assert model.SYMMETRY_LEVEL == 2
    assert model.CP_MODEL_PROBING_LEVEL == 1


def test_the_tier_solver_applies_the_env_values_not_the_defaults(monkeypatch):
    """The constants reaching the SOLVER, not merely the module.

    A knob read into a variable nothing passes to CP-SAT is the same defect in
    a different place, so this asserts against `solver.parameters` — the object
    the search actually uses.
    """
    monkeypatch.setenv("PLACEMENT_NUM_SEARCH_WORKERS", "2")
    monkeypatch.setenv("PLACEMENT_SYMMETRY_LEVEL", "1")
    monkeypatch.setenv("PLACEMENT_PROBING_LEVEL", "2")
    importlib.reload(placement.model)
    # `objective` imports the constants BY VALUE at its own import time, so it
    # has to be reloaded after `model` — reloading only `model` would leave the
    # solver reading the old numbers, which is the same class of bug this file
    # exists to catch, one module further along.
    objective = importlib.reload(placement.objective)

    # A deadline far enough out that `max_time_in_seconds` is not the floor.
    solver = objective._tier_solver(deadline=time.perf_counter() + 30.0)

    assert solver.parameters.num_search_workers == 2
    assert solver.parameters.symmetry_level == 1
    assert solver.parameters.cp_model_probing_level == 2

    importlib.reload(placement.objective)


def test_a_solve_logs_one_line_saying_what_it_did(caplog, monkeypatch):
    """The absence of this line cost four production deploys.

    The service logged only refusals, so the only visible timing was TS-side
    `elapsed_ms` — which covers greedy seed, grid, encode, RPC and verification,
    and cannot separate "the solver used its whole budget" from "the solver
    finished in 3s and something else took the rest".

    Asserted on the FIELDS, not the prose: `granted` is the wall after clamping
    (so a clamp is visible rather than inferred), `solver_elapsed_ms` is the
    solver's own time, and the three knobs are echoed because a knob you cannot
    see is a knob you cannot trust.
    """
    from placement.config import Settings  # noqa: PLC0415
    from placement.generated import scheduler_pb2  # noqa: PLC0415
    from placement.main import SchedulerServicer  # noqa: PLC0415

    # Same shape and same constant as `test_server.py`'s `_solvable_request`:
    # one fixture, one court, one slot, and a real epoch-ms timestamp rather
    # than 0 — the boundary rejects a slot at epoch 0, and a zero-based corpus
    # is what made "unset" and "a test value" the same number for four review
    # rounds. Small enough that nothing here is timing-sensitive.
    slot_ms = 1_767_225_600_000 + 8 * 3_600_000
    request = scheduler_pb2.SolveBuildRequest(
        request_id="knobs-1",
        court_names=["Court 1"],
        entrant_count=2,
        division_count=1,
        fixtures=[scheduler_pb2.Fixture(entrant_indices=[0, 1], division_index=0)],
        slots=[scheduler_pb2.Slot(court_index=0, start_at_ms=slot_ms, day_index=0)],
        step_minutes=10,
        constraints=scheduler_pb2.BuildConstraints(match_minutes=30, gap_minutes=10),
        wall_seconds=2.0,
    )

    settings = Settings(
        port=50051,
        max_workers=1,
        shared_secret="test-secret",
        wall_seconds_max=5.0,
    )
    servicer = SchedulerServicer(settings)

    with caplog.at_level(logging.INFO):
        servicer._solve_build(request)

    lines = [r.getMessage() for r in caplog.records if "solve request=" in r.getMessage()]
    assert len(lines) == 1, f"expected exactly one per-solve line, got {lines}"
    line = lines[0]
    for field in (
        "status=",
        "placed=",
        "tiers=",
        "granted=",
        "solver_elapsed_ms=",
        "workers=",
        "symmetry=",
        "probing=",
    ):
        assert field in line, f"{field!r} missing from the per-solve line: {line}"
