"""Adapter: bench's STRING-shaped board tuples -> the service's POSITIONAL
(int-indexed) shape, after round 6's identity redesign.

`bench/cpsat_bench_boards.py` is out of scope for round 6 (see
`services/cp-sat/src/cp_sat/model.py`'s module docstring, "THE BENCH HAS ITS
OWN COPY OF THIS MODEL") and still returns `cp_sat.model.build_model`'s
PRE-round-6 parameter shape: string fixture ids, string court names, string
division/entrant ids -- exactly what `proto/scheduler.proto`'s
`SolveBuildRequest` could carry before this round. This module is the one
place that bridges the two, so every acceptance test that drives a bench
board keeps using the bench's ONE generator (the whole reason Prompt 02
extracted it into `cpsat_bench_boards.py`) without every test re-deriving its
own id -> index mapping by hand.

Identity is assigned by FIRST APPEARANCE, in traversal order: a fixture's new
identity is its position in `fixtures` (the OLD `fixture_id` string is simply
discarded, exactly as a real caller's would be under the new contract); a
court's is its position in the OLD `courts` list; division/entrant identity
is assigned by first appearance while walking `fixtures` in order. This is
stable across calls because the bench's board generators build their lists
deterministically (no set iteration anywhere in the traversal), so the
adapter itself introduces no nondeterminism on top of the solver's own.
"""

from __future__ import annotations

from cp_sat.generated import scheduler_pb2


def _index_maps(fixtures, courts):
    """The four id->index maps every conversion below needs, built once so
    `to_positional` and `to_proto_request` cannot silently disagree about
    which index a given string was assigned."""
    court_index_of = {name: i for i, name in enumerate(courts)}

    division_index_of: dict[str, int] = {}
    entrant_index_of: dict[str, int] = {}
    for _fid, entrants, division in fixtures:
        if division not in division_index_of:
            division_index_of[division] = len(division_index_of)
        for entrant in entrants:
            if entrant not in entrant_index_of:
                entrant_index_of[entrant] = len(entrant_index_of)

    fixture_index_of = {fid: i for i, (fid, _entrants, _division) in enumerate(fixtures)}

    return court_index_of, division_index_of, entrant_index_of, fixture_index_of


def to_positional(board):
    """Convert one `cp_sat.model.build_model`-shaped (PRE-round-6) 7-tuple --
    (fixtures, courts, grid_slots, step_minutes, constraints, existing,
    dependencies), all string-keyed -- into the POST-round-6 positional
    7-tuple `cp_sat.model.build_model` now takes: (fixtures, num_courts,
    grid_slots, step_minutes, constraints, existing, dependencies), all
    int-keyed. `num_courts` replaces the old `courts: list[str]` -- names
    never reach the domain, see `cp_sat.schema.ModelInput.courts`.
    """
    fixtures, courts, grid_slots, step_minutes, constraints, existing, dependencies = board
    court_index_of, division_index_of, entrant_index_of, fixture_index_of = _index_maps(
        fixtures, courts
    )

    new_fixtures = [
        ([entrant_index_of[e] for e in entrants], division_index_of[division])
        for _fid, entrants, division in fixtures
    ]
    new_grid_slots = [(court_index_of[court], start, day) for court, start, day in grid_slots]
    new_existing = [(court_index_of[court], start) for _fid, court, start in existing]
    new_dependencies = [
        (fixture_index_of[before], fixture_index_of[after]) for before, after in dependencies
    ]
    new_constraints = {
        "match_minutes": constraints["match_minutes"],
        "gap_minutes": constraints["gap_minutes"],
        "rest_by_division": {
            division_index_of[d]: v
            for d, v in constraints["rest_by_division"].items()
            if d in division_index_of
        },
        "day_cap_by_division": {
            division_index_of[d]: v
            for d, v in constraints["day_cap_by_division"].items()
            if d in division_index_of
        },
    }

    return (
        new_fixtures,
        len(courts),
        new_grid_slots,
        step_minutes,
        new_constraints,
        new_existing,
        new_dependencies,
    )


def to_proto_request(board, *, request_id: str, wall_seconds: float) -> scheduler_pb2.SolveBuildRequest:
    """The same conversion, all the way onto the wire -- a real
    `SolveBuildRequest` built from a bench board, for `test_server.py`'s
    through-the-servicer acceptance test."""
    fixtures, courts, grid_slots, step_minutes, constraints, existing, dependencies = board
    court_index_of, division_index_of, entrant_index_of, fixture_index_of = _index_maps(
        fixtures, courts
    )

    return scheduler_pb2.SolveBuildRequest(
        request_id=request_id,
        court_names=courts,
        entrant_count=len(entrant_index_of),
        division_count=len(division_index_of),
        fixtures=[
            scheduler_pb2.Fixture(
                entrant_indices=[entrant_index_of[e] for e in entrants],
                division_index=division_index_of[division],
            )
            for _fid, entrants, division in fixtures
        ],
        slots=[
            scheduler_pb2.Slot(court_index=court_index_of[court], start_at_ms=start, day_index=day)
            for court, start, day in grid_slots
        ],
        step_minutes=step_minutes,
        existing=[
            scheduler_pb2.PinnedRow(court_index=court_index_of[court], start_at_ms=start)
            for _fid, court, start in existing
        ],
        dependencies=[
            scheduler_pb2.OrderPair(
                before_index=fixture_index_of[before], after_index=fixture_index_of[after]
            )
            for before, after in dependencies
        ],
        division_rules=[
            scheduler_pb2.DivisionRule(
                division_index=division_index_of[d],
                **(
                    {"min_rest_minutes": constraints["rest_by_division"][d]}
                    if d in constraints["rest_by_division"]
                    else {}
                ),
                **(
                    {"max_fixtures_per_day": constraints["day_cap_by_division"][d]}
                    if d in constraints["day_cap_by_division"]
                    else {}
                ),
            )
            for d in division_index_of
            if d in constraints["rest_by_division"] or d in constraints["day_cap_by_division"]
        ],
        constraints=scheduler_pb2.BuildConstraints(
            match_minutes=constraints["match_minutes"], gap_minutes=constraints["gap_minutes"]
        ),
        wall_seconds=wall_seconds,
    )
