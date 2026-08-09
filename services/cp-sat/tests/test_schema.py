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
from cp_sat.objective import MIN_TIER_SECONDS, TIER_ORDER
from cp_sat.schema import (
    InvalidRequestError,
    error_response,
    outcome_to_response,
    request_to_model_input,
)


#: A real epoch-ms timestamp (2026-01-01T08:00:00Z), never 0.
#:
#: The corpus in `bench/` moved off epoch zero in Prompt 05b for a reason that
#: applies just as hard to these hand-built requests: at `start_at_ms = 0`,
#: proto3's UNSET and a deliberate test value are the same number, so a guard
#: written against "unset" cannot be shown to reject unset rather than to
#: reject the fixture data. Every timestamp in this file is above `INT32_MAX`
#: for the same reason `MIN_REAL_EPOCH_MS` is (see `test_bench_contract.py`).
SLOT_MS = 1_767_225_600_000 + 8 * 3_600_000


def _valid_request(**overrides) -> scheduler_pb2.SolveBuildRequest:
    """A minimal request that maps cleanly, so each test below can break
    exactly one field and know that field is why it was rejected."""
    kwargs = dict(
        request_id="r1",
        courts=["Court 1"],
        fixtures=[scheduler_pb2.Fixture(fixture_id="f1", entrant_ids=["e1", "e2"], division_id="d1")],
        grid=scheduler_pb2.Grid(
            slots=[scheduler_pb2.Slot(court="Court 1", start_at_ms=SLOT_MS, day_index=0)],
            step_minutes=10,
        ),
        constraints=scheduler_pb2.BuildConstraints(match_minutes=30, gap_minutes=10),
        wall_seconds=8.0,
    )
    kwargs.update(overrides)
    return scheduler_pb2.SolveBuildRequest(**kwargs)


def _constraints(**overrides) -> scheduler_pb2.BuildConstraints:
    """`match_minutes` and `gap_minutes` both SET, always.

    Written as a helper because `gap_minutes` now has explicit presence: a test
    that builds `BuildConstraints(match_minutes=30)` to probe some unrelated
    field would be rejected for the missing gap instead, and would pass while
    proving nothing.
    """
    kwargs = dict(match_minutes=30, gap_minutes=10)
    kwargs.update(overrides)
    return scheduler_pb2.BuildConstraints(**kwargs)


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


@pytest.mark.parametrize(
    "grid",
    [
        pytest.param(None, id="grid-omitted-entirely"),
        pytest.param(scheduler_pb2.Grid(step_minutes=10), id="grid-present-slots-empty"),
    ],
)
def test_rejects_empty_grid_slots(grid):
    """`Grid` is a proto3 MESSAGE field, so an omitted `grid` and a `grid` with
    an empty `slots` list are indistinguishable on the wire — both arrive as an
    empty `Grid`. Neither is absent, and neither is an error downstream:
    `build_model` falls back to `Domain.FromValues([0])`, every fixture is
    forced onto tick 0, and the solve proves that OPTIMAL with one fixture per
    court and the rest silently unplaced.

    Measured through the real server before this guard existed: 8 fixtures, 2
    courts, no grid -> SOLVE_STATUS_OPTIMAL, `error` unset, 2 of 8 placed, both
    at start_at_ms=0, tiers_completed=4.
    """
    overrides = {} if grid is None else {"grid": grid}
    req = _valid_request(**overrides)
    if grid is None:
        req.ClearField("grid")
    with pytest.raises(InvalidRequestError, match="grid"):
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
        fixtures=[
            scheduler_pb2.Fixture(fixture_id="f1", entrant_ids=["e1", "e2"], division_id="d1"),
            scheduler_pb2.Fixture(fixture_id="f2", entrant_ids=["e3", "e4"], division_id="d1"),
        ],
        existing=[scheduler_pb2.Assignment(fixture_id="x1", court="Court 1", start_at_ms=SLOT_MS)],
        # Both endpoints name MOVABLE fixtures. A pair naming the pinned row
        # `x1` used to map cleanly here and was then dropped without a word by
        # `model.py`, because `id_to_idx` is built from `fixtures` alone.
        dependencies=[scheduler_pb2.OrderPair(before_fixture_id="f1", after_fixture_id="f2")],
        constraints=_constraints(
            rest_by_division=[scheduler_pb2.DivisionRestRule(division_id="d1", min_rest_minutes=45)],
            day_cap_by_division=[
                scheduler_pb2.DivisionDayCapRule(division_id="d1", max_fixtures_per_day=3)
            ],
        ),
    )
    parsed = request_to_model_input(req)
    assert parsed.fixtures == [("f1", ["e1", "e2"], "d1"), ("f2", ["e3", "e4"], "d1")]
    assert parsed.grid_slots == [("Court 1", SLOT_MS, 0)]
    assert parsed.step_minutes == 10
    assert parsed.constraints == {
        "match_minutes": 30,
        "gap_minutes": 10,
        "rest_by_division": {"d1": 45},
        "day_cap_by_division": {"d1": 3},
    }
    assert parsed.existing == [("x1", "Court 1", SLOT_MS)]
    assert parsed.dependencies == [("f1", "f2")]


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
    map, or the check has quietly become 'no caps allowed'.

    Both divisions have to be DECLARED by a fixture now: a rule keyed on a
    division nobody is in is inert, and this test used to cap a `d2` that the
    board did not contain."""
    req = _valid_request(
        fixtures=[
            scheduler_pb2.Fixture(fixture_id="f1", entrant_ids=["e1", "e2"], division_id="d1"),
            scheduler_pb2.Fixture(fixture_id="f2", entrant_ids=["e3", "e4"], division_id="d2"),
        ],
        constraints=_constraints(
            day_cap_by_division=[
                scheduler_pb2.DivisionDayCapRule(division_id="d1", max_fixtures_per_day=3),
                scheduler_pb2.DivisionDayCapRule(division_id="d2", max_fixtures_per_day=1),
            ],
        ),
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


# --- explicit presence ------------------------------------------------------
#
# The two scalars below are the ONLY ones where 0 is a legitimate value, so a
# value guard cannot reach their degenerate case: "no court turnaround" and "no
# minimum rest" are real answers, and an unset field is the same bytes. proto3
# `optional` is the only thing that separates them, and these are the tests
# that keep the keyword in the .proto.


def test_rejects_unset_gap_minutes():
    """Unset -> 0 -> the court interval loses its turnaround and matches are
    booked back-to-back, OPTIMAL, `error` unset. Distinguishable from a
    deliberate `gap_minutes = 0` only by field presence."""
    req = _valid_request(constraints=scheduler_pb2.BuildConstraints(match_minutes=30))
    with pytest.raises(InvalidRequestError, match="gap_minutes"):
        request_to_model_input(req)


def test_accepts_an_explicit_zero_gap():
    """The other half, and the reason this is presence and not `> 0`: some
    sports genuinely have no turnaround, and that board must still solve."""
    req = _valid_request(constraints=_constraints(gap_minutes=0))
    assert request_to_model_input(req).constraints["gap_minutes"] == 0


def test_rejects_unset_min_rest_minutes():
    """A rest rule that is PRESENT but carries an unset value is silently
    equivalent to omitting the division — the caller asked for rest and got
    none. Sits beside the day-cap guard, which has always rejected its own
    degenerate value; the asymmetry was an oversight, not a decision."""
    req = _valid_request(
        constraints=_constraints(
            rest_by_division=[scheduler_pb2.DivisionRestRule(division_id="d1")]
        )
    )
    with pytest.raises(InvalidRequestError, match="min_rest_minutes"):
        request_to_model_input(req)


def test_accepts_an_explicit_zero_rest():
    req = _valid_request(
        constraints=_constraints(
            rest_by_division=[
                scheduler_pb2.DivisionRestRule(division_id="d1", min_rest_minutes=0)
            ]
        )
    )
    assert request_to_model_input(req).constraints["rest_by_division"] == {"d1": 0}


def test_rejects_a_slot_without_a_day_index():
    """Day 0 is the first day, so 0 is a legitimate value and unset is the same
    bytes. Unset puts EVERY slot on day 0 and collapses the whole lattice into
    one day-cap bucket — a board that comes back with one fixture per division
    where the caller asked for one per DAY, reported OPTIMAL.

    Found by mutation, not by design: removing this guard left all 60 other
    ACL tests green, 6/6."""
    req = _valid_request(
        grid=scheduler_pb2.Grid(
            slots=[scheduler_pb2.Slot(court="Court 1", start_at_ms=SLOT_MS)], step_minutes=10
        )
    )
    with pytest.raises(InvalidRequestError, match="day_index"):
        request_to_model_input(req)


def test_accepts_day_index_zero():
    """The other half: day 0 is the first day and must map, or the presence
    check has quietly become `> 0` and no board can start on its own day one."""
    parsed = request_to_model_input(_valid_request())
    assert parsed.grid_slots == [("Court 1", SLOT_MS, 0)]


def test_rejects_a_negative_day_index():
    req = _valid_request(
        grid=scheduler_pb2.Grid(
            slots=[scheduler_pb2.Slot(court="Court 1", start_at_ms=SLOT_MS, day_index=-1)],
            step_minutes=10,
        )
    )
    with pytest.raises(InvalidRequestError, match="day_index"):
        request_to_model_input(req)


def test_rejects_an_omitted_constraints_message():
    """`BuildConstraints` is a message field, so omitting it entirely arrives
    as a default-valued one. Named separately from the field guards so the
    caller is told the message is missing rather than being told about
    whichever field the checks happen to reach first."""
    req = _valid_request()
    req.ClearField("constraints")
    # Matched on the MESSAGE name, not on "constraints": every field guard's
    # text contains the word, so a looser pattern passes on the
    # `constraints.match_minutes` rejection and proves nothing.
    with pytest.raises(InvalidRequestError, match="BuildConstraints"):
        request_to_model_input(req)


# --- negative values --------------------------------------------------------
#
# The `<= 0` guards fire on zero and on missing; these two fields are guarded
# `>= 0` because zero is legitimate, and NEGATIVE is worse than either. It does
# not merely fail to constrain: it cancels the match length out of the interval
# width and reopens a family that was closed.


def test_rejects_negative_gap_minutes():
    """At `gap_minutes == -match_minutes` the court interval is zero-width,
    NoOverlap over zero-width intervals constrains nothing, and two matches
    overlap on one court. Measured: 37 placed, 4 tiers, 1 overlap, OPTIMAL."""
    req = _valid_request(constraints=_constraints(gap_minutes=-1))
    with pytest.raises(InvalidRequestError, match="gap_minutes"):
        request_to_model_input(req)


def test_rejects_negative_min_rest_minutes():
    """Same arithmetic on the participant-rest interval: at
    `rest == -match_minutes` one entrant plays two simultaneous matches.
    Measured: 37 placed, 4 tiers, 1 collision, OPTIMAL."""
    req = _valid_request(
        constraints=_constraints(
            rest_by_division=[
                scheduler_pb2.DivisionRestRule(division_id="d1", min_rest_minutes=-1)
            ]
        )
    )
    with pytest.raises(InvalidRequestError, match="min_rest_minutes"):
        request_to_model_input(req)


# --- referential integrity --------------------------------------------------
#
# ONE pass, before any domain object exists: every id a request mentions must
# resolve to something the same request declares. Each case below is a measured
# defect in which the constraint the caller asked for evaporated and the
# service answered OPTIMAL with `error` unset — never a crash, never a warning.
#
# The domain's tolerance of these is DELIBERATE and is not what changes here:
# `model.py`'s `id_to_idx.get(...) or continue` and `if existing_court in
# court_lists` are what let the bench feed it partial boards. The wire is where
# the mistake is actually made, so the wire is where it is caught.


def test_rejects_an_empty_court_name():
    """An empty court is not an omitted court — it is a PLACEABLE phantom one.

    `courts` is the set the model builds its per-court interval lists from, so
    `""` gets a real column on the board that no grid slot ever offers and no
    caller can render. Measured through the ACL and the model, 5/5
    deterministic, two fixtures and ONE grid point on `C0`:

        courts=["C0", ""]  OPTIMAL, 2 placed, error unset
                           [('f1', '', T), ('f2', 'C0', T)]
        courts=["C0"]      OPTIMAL, 1 placed          <- the control

    The phantom doubles the board and puts a match on a court that does not
    exist, at the same instant as a real one. This is the same argument the
    guards on `fixture_id`, `division_id` and `entrant_ids` already make —
    the caller cannot map the answer back to anything — and `courts` was
    missed when they were written.
    """
    req = _valid_request(courts=["Court 1", ""])
    with pytest.raises(InvalidRequestError, match="courts"):
        request_to_model_input(req)


def test_rejects_duplicate_court_names():
    """Two entries for one court is a caller error with no meaning to assign.

    Benign in the model as it stands — `court_lists` and `presence_court` are
    dicts keyed by court, so the duplicate collapses, and the extra entry in
    `court_counts` is an identical expression that moves neither the max nor
    the min of the T3 imbalance term. Rejected anyway: it is the same
    "an id names exactly one thing" rule as everywhere else in this pass, and
    the analysis that makes it benign is a property of today's model rather
    than of the contract.
    """
    req = _valid_request(courts=["Court 1", "Court 1"])
    with pytest.raises(InvalidRequestError, match="courts"):
        request_to_model_input(req)


def test_rejects_a_pinned_row_reusing_a_movable_fixtures_id():
    """A fixture id names exactly ONE match in a request — movable or pinned.

    An `existing` row reusing a movable id does not pin that fixture: the row
    lays a fixed blocking interval, the movable fixture is still free, and it
    is placed somewhere else. The caller gets an assignment for a fixture it
    just told the service was already fixed. Measured, 5/5 deterministic, one
    fixture and three ticks 40 min apart:

        existing f1 @ T           -> OPTIMAL, error unset,
                                     board = [('f1', 'C0', T+40min)]

    i.e. `f1` is now in two places. The rule chosen is DISJOINT IDS rather
    than "an existing row pins the movable fixture": the second would be a new
    modelling feature (drop it from the movable set, or fix its start and
    court), and the boundary's job is to refuse a request that means two
    things, not to guess which one.
    """
    req = _valid_request(
        existing=[scheduler_pb2.Assignment(fixture_id="f1", court="Court 1", start_at_ms=SLOT_MS)]
    )
    with pytest.raises(InvalidRequestError, match="existing"):
        request_to_model_input(req)


def test_rejects_an_empty_pinned_row_fixture_id():
    """Same rule, the degenerate end of it: a pin nobody can name. It appears
    in the diagnostic for every constraint that row participates in."""
    req = _valid_request(
        existing=[scheduler_pb2.Assignment(court="Court 1", start_at_ms=SLOT_MS)]
    )
    with pytest.raises(InvalidRequestError, match="existing"):
        request_to_model_input(req)


def test_rejects_duplicate_pinned_row_fixture_ids():
    """One match cannot be pinned to two places at once. The model would
    happily lay both blocking intervals and report OPTIMAL around them."""
    req = _valid_request(
        existing=[
            scheduler_pb2.Assignment(fixture_id="x1", court="Court 1", start_at_ms=SLOT_MS),
            scheduler_pb2.Assignment(
                fixture_id="x1", court="Court 1", start_at_ms=SLOT_MS + 3_600_000
            ),
        ]
    )
    with pytest.raises(InvalidRequestError, match="existing"):
        request_to_model_input(req)


def test_accepts_pinned_rows_with_ids_of_their_own():
    """The rule must not have become "no pinned rows". Distinct, non-empty
    ids that no movable fixture uses map straight through."""
    req = _valid_request(
        existing=[
            scheduler_pb2.Assignment(fixture_id="x1", court="Court 1", start_at_ms=SLOT_MS),
            scheduler_pb2.Assignment(
                fixture_id="x2", court="Court 1", start_at_ms=SLOT_MS + 3_600_000
            ),
        ]
    )
    parsed = request_to_model_input(req)
    assert [row[0] for row in parsed.existing] == ["x1", "x2"]


def test_rejects_a_dependency_naming_an_unknown_fixture():
    """Measured, 2 fixtures, separation `start(f1) - start(f0)`, 5/5
    deterministic: a real pair separates them by 1_800_000 ms; a pair naming
    `""` or `"f1 "` separates them by 0, OPTIMAL, `error` unset."""
    req = _valid_request(
        dependencies=[scheduler_pb2.OrderPair(before_fixture_id="f1", after_fixture_id="nope")]
    )
    with pytest.raises(InvalidRequestError, match="dependencies"):
        request_to_model_input(req)


def test_rejects_a_dependency_naming_a_pinned_row():
    """`id_to_idx` is built from MOVABLE fixtures only, so a dependency naming
    an `existing` row is ALWAYS dropped — the one case where the caller's id is
    real, exists in the request, and still resolves to nothing."""
    req = _valid_request(
        existing=[scheduler_pb2.Assignment(fixture_id="x1", court="Court 1", start_at_ms=SLOT_MS)],
        dependencies=[scheduler_pb2.OrderPair(before_fixture_id="f1", after_fixture_id="x1")],
    )
    with pytest.raises(InvalidRequestError, match="dependencies"):
        request_to_model_input(req)


@pytest.mark.parametrize("court", ["", "Court 1 ", "Court 9"])
def test_rejects_a_pinned_row_on_an_unknown_court(court):
    """`model.py:309` folds a pinned row into a court's interval list only `if
    existing_court in court_lists`, and skips it wordlessly otherwise — so the
    pin reserves nothing and a movable fixture is placed on top of a match that
    is already being played.

    Measured on a board whose only grid point is `Court 1 @ T`, 5/5
    deterministic: the real court blocks it (board `[]`); `""` and `"Court 1 "`
    both put the movable fixture straight into the pinned slot, OPTIMAL."""
    req = _valid_request(
        existing=[scheduler_pb2.Assignment(fixture_id="x1", court=court, start_at_ms=SLOT_MS)]
    )
    with pytest.raises(InvalidRequestError, match="existing"):
        request_to_model_input(req)


@pytest.mark.parametrize("start_at_ms", [0, -1])
def test_rejects_a_pinned_row_without_a_real_start(start_at_ms):
    """An unset `start_at_ms` builds the blocking interval at epoch 0, which
    overlaps nothing real, so the pin is silently ignored and a movable fixture
    takes the pinned slot.

    Guarded by VALUE rather than by proto3 presence on purpose: epoch 0 is
    1970 and is never a legitimate match time, and `Assignment` is also the
    RESPONSE type — marking it `optional` would make `startAtMs` nullable in
    the TypeScript outcome for a value the service always sets."""
    req = _valid_request(
        existing=[
            scheduler_pb2.Assignment(fixture_id="x1", court="Court 1", start_at_ms=start_at_ms)
        ]
    )
    with pytest.raises(InvalidRequestError, match="existing"):
        request_to_model_input(req)


@pytest.mark.parametrize("start_at_ms", [0, -1])
def test_rejects_a_grid_slot_without_a_real_start(start_at_ms):
    """Same argument one field over, and the asymmetry is the point: a slot at
    epoch 0 is a legal tick in 1970 that fixtures are then placed on and proved
    OPTIMAL. Guarding the pinned row and not the slot would be exactly the
    `min_rest` / `day_cap` oversight repeated."""
    req = _valid_request(
        grid=scheduler_pb2.Grid(
            slots=[scheduler_pb2.Slot(court="Court 1", start_at_ms=start_at_ms, day_index=0)], step_minutes=10
        )
    )
    with pytest.raises(InvalidRequestError, match="grid.slots"):
        request_to_model_input(req)


def test_rejects_a_grid_slot_on_an_unknown_court():
    """`Slot.court` is decorative in the model — `admissible_starts` unions
    every slot's start across all courts — so a grid naming only courts that do
    not exist still places fixtures on the real ones. The union is a documented
    limitation; a slot naming a court the request never declared is a caller
    error, and the only layer that can see it is this one."""
    req = _valid_request(
        grid=scheduler_pb2.Grid(
            slots=[scheduler_pb2.Slot(court="Court 9", start_at_ms=SLOT_MS, day_index=0)], step_minutes=10
        )
    )
    with pytest.raises(InvalidRequestError, match="grid.slots"):
        request_to_model_input(req)


@pytest.mark.parametrize(
    "rule_kwargs,field",
    [
        pytest.param({"rest_by_division": [scheduler_pb2.DivisionRestRule(division_id="typo", min_rest_minutes=45)]}, "rest_by_division", id="rest"),
        pytest.param({"day_cap_by_division": [scheduler_pb2.DivisionDayCapRule(division_id="typo", max_fixtures_per_day=1)]}, "day_cap_by_division", id="day-cap"),
    ],
)
def test_rejects_a_rule_for_a_division_no_fixture_is_in(rule_kwargs, field):
    """A rule keyed on a division nobody is in is inert: `model.py` resolves
    rest as `rest_by_division.get(division, 0)` and selects capped fixtures by
    `divisions[i] == division`, so neither ever matches. The caller asked for a
    constraint and silently received none — and this is also what catches a
    typo, which no per-fixture check can."""
    req = _valid_request(constraints=_constraints(**rule_kwargs))
    with pytest.raises(InvalidRequestError, match=field):
        request_to_model_input(req)


@pytest.mark.parametrize(
    "rule_kwargs,field",
    [
        pytest.param({"rest_by_division": [scheduler_pb2.DivisionRestRule(division_id="d1", min_rest_minutes=45), scheduler_pb2.DivisionRestRule(division_id="d1", min_rest_minutes=5)]}, "rest_by_division", id="rest"),
        pytest.param({"day_cap_by_division": [scheduler_pb2.DivisionDayCapRule(division_id="d1", max_fixtures_per_day=3), scheduler_pb2.DivisionDayCapRule(division_id="d1", max_fixtures_per_day=1)]}, "day_cap_by_division", id="day-cap"),
    ],
)
def test_rejects_duplicate_division_rules(rule_kwargs, field):
    """These are repeated messages, not a proto `map`, so two rules for one
    division are legal on the wire and the dict comprehension keeps the LAST.
    The caller sent two numbers and one of them was chosen without a word."""
    req = _valid_request(constraints=_constraints(**rule_kwargs))
    with pytest.raises(InvalidRequestError, match=field):
        request_to_model_input(req)


def test_rejects_a_fixture_with_no_division():
    """The headline probe. Same board, same constraints (`min_rest_minutes=240`,
    `max_fixtures_per_day=1` on `d1`), 4 fixtures, 5/5 deterministic:

        division_id  status                placed  error set
        "d1"         SOLVE_STATUS_OPTIMAL       1  no
        "" (unset)   SOLVE_STATUS_OPTIMAL       4  no

    An unset division matches no rest rule and no cap, so both families
    evaporate and the board quadruples while reporting OPTIMAL."""
    req = _valid_request(
        fixtures=[scheduler_pb2.Fixture(fixture_id="f1", entrant_ids=["e1", "e2"])]
    )
    with pytest.raises(InvalidRequestError, match="division_id"):
        request_to_model_input(req)


def test_rejects_a_fixture_with_no_entrants():
    """An entrant-less fixture joins no `by_entrant` group, so the participant-
    rest NoOverlap and every T2 idle-gap term skip it entirely. Measured: two
    fixtures sharing player `e1` placed CONCURRENTLY, OPTIMAL."""
    req = _valid_request(
        fixtures=[scheduler_pb2.Fixture(fixture_id="f1", division_id="d1")]
    )
    with pytest.raises(InvalidRequestError, match="entrant_ids"):
        request_to_model_input(req)


def test_rejects_an_empty_entrant_id():
    """Every `""` entrant collides into ONE participant group, so unrelated
    fixtures acquire a shared-player rest constraint they do not have. Wrong in
    the over-constraining direction, which is why it never surfaced as a bad
    board — it surfaces as fixtures that mysteriously will not fit."""
    req = _valid_request(
        fixtures=[scheduler_pb2.Fixture(fixture_id="f1", entrant_ids=["e1", ""], division_id="d1")]
    )
    with pytest.raises(InvalidRequestError, match="entrant_ids"):
        request_to_model_input(req)


def test_rejects_an_empty_fixture_id():
    """`assignments` come back keyed by `fixture_id`, so an unset one gives the
    caller rows it cannot map back to anything. Verified: two rows, both
    `fixture_id=""`."""
    req = _valid_request(
        fixtures=[scheduler_pb2.Fixture(entrant_ids=["e1", "e2"], division_id="d1")]
    )
    with pytest.raises(InvalidRequestError, match="fixture_id"):
        request_to_model_input(req)


def test_rejects_duplicate_fixture_ids():
    """`id_to_idx` is last-wins, so two fixtures sharing an id make every
    dependency naming it resolve to the second one — and it is what makes
    "a dependency names a fixture in `fixtures`" a meaningful check at all."""
    req = _valid_request(
        fixtures=[
            scheduler_pb2.Fixture(fixture_id="f1", entrant_ids=["e1", "e2"], division_id="d1"),
            scheduler_pb2.Fixture(fixture_id="f1", entrant_ids=["e3", "e4"], division_id="d1"),
        ]
    )
    with pytest.raises(InvalidRequestError, match="fixture_id"):
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


def test_outcome_to_response_populates_error_for_an_unmapped_status():
    """Every other SOLVE_STATUS_ERROR path carries a populated `SolveError`.
    This one is reached without an exception ever being raised — the domain
    returned a status this layer has no mapping for — so it has to build its
    own, or the caller gets ERROR with no reason at all."""
    resp = outcome_to_response(_outcome(status="MODEL_INVALID"), wall_seconds=10.0)
    assert resp.status == scheduler_pb2.SOLVE_STATUS_ERROR
    assert resp.HasField("error")
    assert resp.error.code == "INTERNAL_ERROR"
    # The unexpected status string itself, or the message says nothing useful.
    assert "MODEL_INVALID" in resp.error.message


@pytest.mark.parametrize("status", ["OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"])
def test_outcome_to_response_leaves_error_unset_for_a_mapped_status(status):
    """The other side: a known status must NOT carry an error. `error` is how
    the caller tells a rejected request from a solved one, so populating it
    unconditionally would be worse than leaving it empty."""
    resp = outcome_to_response(_outcome(status=status), wall_seconds=10.0)
    assert not resp.HasField("error")


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
    assert [(t.name, t.value) for t in resp.objective_values] == [(TIER_ORDER[0], 1)]


@pytest.mark.parametrize(
    "elapsed_ms,wall_seconds,exhausted",
    [
        (0, 10.0, False),
        (5000, 10.0, False),
        # The tier loop stops one MIN_TIER_SECONDS BEFORE the deadline, so this
        # is the last elapsed value that can mean "there was still time".
        (9949, 10.0, False),
        # From here up, the chain cannot have started another tier — it was cut
        # short by the wall even though it never reached the wall.
        (9950, 10.0, True),
        (9999, 10.0, True),
        (10000, 10.0, True),
        (10500, 10.0, True),
    ],
)
def test_outcome_to_response_reports_wall_exhausted(elapsed_ms, wall_seconds, exhausted):
    """`wall_exhausted` compares elapsed against the wall MINUS the tier loop's
    proactive-break margin, not against the raw wall.

    `run_tier_chain` breaks out when `deadline - now <= MIN_TIER_SECONDS`
    rather than running a tier it has no time to finish, so a chain genuinely
    stopped by the budget reports an `elapsed_ms` up to 50ms UNDER the wall. A
    raw `elapsed_ms >= wall * 1000` comparison calls that `wall_exhausted=False`
    and tells the caller the budget was not the limiting factor when it was —
    which is the one thing this flag exists to say.
    """
    resp = outcome_to_response(_outcome(elapsed_ms=elapsed_ms), wall_seconds=wall_seconds)
    assert resp.wall_exhausted is exhausted


def test_wall_exhausted_threshold_tracks_the_tier_loops_own_margin():
    """Pins the threshold to `objective.MIN_TIER_SECONDS` rather than to a
    hardcoded 50ms. If the tier loop's margin changes, this flag's boundary has
    to move with it — a literal here would silently stop matching."""
    wall = 8.0
    boundary_ms = int((wall - MIN_TIER_SECONDS) * 1000)
    assert outcome_to_response(_outcome(elapsed_ms=boundary_ms - 1), wall).wall_exhausted is False
    assert outcome_to_response(_outcome(elapsed_ms=boundary_ms), wall).wall_exhausted is True
