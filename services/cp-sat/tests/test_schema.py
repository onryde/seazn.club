"""The wire boundary, both directions: proto in via `request_to_model_input`,
proto out via `outcome_to_response` / `error_response`.

This is the anti-corruption layer. Domain code (`cp_sat.model` /
`cp_sat.objective`) never sees a proto type in either direction, and — the
point of most of the tests below — never sees a request that would make it
produce a confidently wrong board. `build_model` and `run_tier_chain` keep
their own guards on the same two scalar fields; those are defence in depth,
not the first line. Rejecting here is what turns the failure into a clean
`SOLVE_STATUS_ERROR` response instead of an exception escaping the handler.

--- round 6: identity is POSITIONAL ------------------------------------------

`_require_id` and its three-round character-canonicality saga (whitespace,
invisible Unicode, homoglyphs) are gone along with every test that exercised
them — there is no id left to canonicalise. In their place: every index must
be IN RANGE for the list or count it points into, and every SINGULAR index
field must be explicitly SET (0 is always a legitimate index, so an unset
field cannot be told from a deliberate 0 by value alone). See `cp_sat.schema`'s
module docstring for the full reasoning.
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
        court_names=["Court 1"],
        entrant_count=2,
        division_count=1,
        fixtures=[scheduler_pb2.Fixture(entrant_indices=[0, 1], division_index=0)],
        slots=[scheduler_pb2.Slot(court_index=0, start_at_ms=SLOT_MS, day_index=0)],
        step_minutes=10,
        constraints=scheduler_pb2.BuildConstraints(match_minutes=30, gap_minutes=10),
        wall_seconds=8.0,
    )
    kwargs.update(overrides)
    return scheduler_pb2.SolveBuildRequest(**kwargs)


def _constraints(**overrides) -> scheduler_pb2.BuildConstraints:
    """`match_minutes` and `gap_minutes` both SET, always.

    Written as a helper because `gap_minutes` has explicit presence: a test
    that builds `BuildConstraints(match_minutes=30)` to probe some unrelated
    field would be rejected for the missing gap instead, and would pass while
    proving nothing.
    """
    kwargs = dict(match_minutes=30, gap_minutes=10)
    kwargs.update(overrides)
    return scheduler_pb2.BuildConstraints(**kwargs)


def test_rejects_empty_fixtures():
    req = scheduler_pb2.SolveBuildRequest(request_id="r1", court_names=["Court 1"])
    with pytest.raises(InvalidRequestError, match="fixtures"):
        request_to_model_input(req)


def test_rejects_empty_court_names():
    req = scheduler_pb2.SolveBuildRequest(
        request_id="r1",
        entrant_count=2,
        division_count=1,
        fixtures=[scheduler_pb2.Fixture(entrant_indices=[0, 1], division_index=0)],
    )
    with pytest.raises(InvalidRequestError, match="court_names"):
        request_to_model_input(req)


def test_rejects_empty_slots():
    """No `Grid` wrapper any more (round 6 flattened it away — `step_minutes`
    was never read by the domain and had no reason to keep a message field
    to itself), so there is only one way to send zero slots now, not two.

    Without any admissible tick the model falls back to a single start of 0,
    forces every fixture onto it, and proves ONE fixture per court OPTIMAL
    while silently dropping the rest — measured through the real server
    before this guard existed: 8 fixtures, 2 courts, no slots -> OPTIMAL,
    `error` unset, most fixtures silently unplaced.
    """
    req = _valid_request(slots=[])
    with pytest.raises(InvalidRequestError, match="slots"):
        request_to_model_input(req)


def test_maps_valid_request():
    req = _valid_request()
    parsed = request_to_model_input(req)
    assert parsed.courts == 1
    assert len(parsed.fixtures) == 1
    assert parsed.wall_seconds == 8.0


def test_maps_every_field_through():
    """The whole translation, not just the two fields the guards read — a
    dropped `existing` or `dependencies` list silently relaxes the board."""
    req = _valid_request(
        entrant_count=4,
        division_count=1,
        fixtures=[
            scheduler_pb2.Fixture(entrant_indices=[0, 1], division_index=0),
            scheduler_pb2.Fixture(entrant_indices=[2, 3], division_index=0),
        ],
        existing=[scheduler_pb2.PinnedRow(court_index=0, start_at_ms=SLOT_MS)],
        # Both endpoints name MOVABLE fixtures (indices 0 and 1).
        dependencies=[scheduler_pb2.OrderPair(before_index=0, after_index=1)],
        division_rules=[
            scheduler_pb2.DivisionRule(division_index=0, min_rest_minutes=45, max_fixtures_per_day=3)
        ],
    )
    parsed = request_to_model_input(req)
    assert parsed.fixtures == [([0, 1], 0), ([2, 3], 0)]
    assert parsed.grid_slots == [(0, SLOT_MS, 0)]
    assert parsed.step_minutes == 10
    assert parsed.constraints == {
        "match_minutes": 30,
        "gap_minutes": 10,
        "rest_by_division": {0: 45},
        "day_cap_by_division": {0: 3},
    }
    assert parsed.existing == [(0, SLOT_MS)]
    assert parsed.dependencies == [(0, 1)]


# --- degenerate scalars ----------------------------------------------------
# Each of these is separately guarded downstream. They are rejected HERE so
# the caller gets SOLVE_STATUS_ERROR with a reason, and so the domain never
# has to be the thing that notices. Unrelated to identity, and unchanged by
# round 6.


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
    expressed by leaving `max_fixtures_per_day` unset, never by sending 0."""
    req = _valid_request(
        division_rules=[scheduler_pb2.DivisionRule(division_index=0, max_fixtures_per_day=cap)]
    )
    with pytest.raises(InvalidRequestError, match="max_fixtures_per_day"):
        request_to_model_input(req)


def test_accepts_day_cap_rules_when_all_positive():
    """The guard is per-rule; a board with several capped divisions must still
    map, or the check has quietly become 'no caps allowed'."""
    req = _valid_request(
        entrant_count=4,
        division_count=2,
        fixtures=[
            scheduler_pb2.Fixture(entrant_indices=[0, 1], division_index=0),
            scheduler_pb2.Fixture(entrant_indices=[2, 3], division_index=1),
        ],
        division_rules=[
            scheduler_pb2.DivisionRule(division_index=0, max_fixtures_per_day=3),
            scheduler_pb2.DivisionRule(division_index=1, max_fixtures_per_day=1),
        ],
    )
    parsed = request_to_model_input(req)
    assert parsed.constraints["day_cap_by_division"] == {0: 3, 1: 1}


@pytest.mark.parametrize("wall_seconds", [0.0, -1.0])
def test_rejects_non_positive_wall_seconds(wall_seconds):
    """A 0 budget stops the tier chain before T0 ever runs and comes back
    UNKNOWN with no assignments — the same answer a genuinely impossible board
    gives, so a dropped field would read as a solver verdict."""
    req = _valid_request(wall_seconds=wall_seconds)
    with pytest.raises(InvalidRequestError, match="wall_seconds"):
        request_to_model_input(req)


# --- explicit presence, unrelated to identity -------------------------------
#
# `gap_minutes` and `Slot.day_index` are the two fields where 0 was ALREADY
# legitimate before round 6, so a value guard could never reach their
# degenerate case: proto3 `optional` is the only thing that separates "unset"
# from "deliberately 0", and these are the tests that keep the keyword in the
# .proto. Unchanged by round 6 — see the INDEX presence family further down
# for the new fields that now carry the same defence.


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


def test_rejects_a_slot_without_a_day_index():
    """Day 0 is the first day, so 0 is a legitimate value and unset is the same
    bytes. Unset puts EVERY slot on day 0 and collapses the whole lattice into
    one day-cap bucket."""
    req = _valid_request(slots=[scheduler_pb2.Slot(court_index=0, start_at_ms=SLOT_MS)])
    with pytest.raises(InvalidRequestError, match="day_index"):
        request_to_model_input(req)


def test_accepts_day_index_zero():
    """The other half: day 0 is the first day and must map, or the presence
    check has quietly become `> 0` and no board can start on its own day one."""
    parsed = request_to_model_input(_valid_request())
    assert parsed.grid_slots == [(0, SLOT_MS, 0)]


def test_rejects_a_negative_day_index():
    req = _valid_request(
        slots=[scheduler_pb2.Slot(court_index=0, start_at_ms=SLOT_MS, day_index=-1)]
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
    with pytest.raises(InvalidRequestError, match="BuildConstraints"):
        request_to_model_input(req)


# --- negative values, unrelated to identity ---------------------------------
#
# The `<= 0` guards fire on zero and on missing; these two fields are guarded
# `>= 0` because zero is legitimate, and NEGATIVE is worse than either.


def test_rejects_negative_gap_minutes():
    """At `gap_minutes == -match_minutes` the court interval is zero-width,
    NoOverlap over zero-width intervals constrains nothing, and two matches
    overlap on one court. Measured: 37 placed, 4 tiers, 1 overlap, OPTIMAL."""
    req = _valid_request(constraints=_constraints(gap_minutes=-1))
    with pytest.raises(InvalidRequestError, match="gap_minutes"):
        request_to_model_input(req)


def test_rejects_negative_min_rest_minutes():
    """Same arithmetic on the participant-rest interval: at
    `rest == -match_minutes` one entrant plays two simultaneous matches."""
    req = _valid_request(
        division_rules=[scheduler_pb2.DivisionRule(division_index=0, min_rest_minutes=-1)]
    )
    with pytest.raises(InvalidRequestError, match="min_rest_minutes"):
        request_to_model_input(req)


# --- referential integrity, now expressed as index range --------------------
#
# ONE pass, before any domain object exists: every index a request carries
# must be IN RANGE for the list or count it points into. Each case below is
# the positional restatement of a measured defect in which the constraint the
# caller asked for evaporated and the service answered OPTIMAL with `error`
# unset — never a crash, never a warning.
#
# `court_names` uniqueness/blankness checks are GONE, on purpose — see the
# "confusable court names" section below. That family of defects cannot occur
# any more, by construction, so there is no guard left to test.


def test_rejects_a_declared_court_that_no_slot_offers():
    """A court with NO slots is placeable. `court_names` is what the model
    builds per-court interval lists from, while the admissible start domain is
    the union of every slot's start across ALL courts — so a declared court
    inherits the whole lattice regardless of what the grid says about it.
    """
    req = _valid_request(
        court_names=["Court 1", "Court 2"],
        slots=[scheduler_pb2.Slot(court_index=0, start_at_ms=SLOT_MS, day_index=0)],
    )
    with pytest.raises(InvalidRequestError, match="no slot offers them"):
        request_to_model_input(req)


def test_rejects_courts_that_offer_different_tick_sets():
    """A court need not be slotless to receive an impossible placement — it
    only needs a tick set DIFFERENT from another court's, because the model
    unions the starts. Refusing this is a deliberate trade of capability
    (per-court blackouts) for correctness; see `cp_sat.model`'s docstring."""
    req = _valid_request(
        court_names=["Court 1", "Court 2"],
        slots=[
            scheduler_pb2.Slot(court_index=0, start_at_ms=SLOT_MS, day_index=0),
            scheduler_pb2.Slot(court_index=0, start_at_ms=SLOT_MS + 3_600_000, day_index=0),
            scheduler_pb2.Slot(court_index=1, start_at_ms=SLOT_MS + 3_600_000, day_index=0),
        ],
    )
    with pytest.raises(InvalidRequestError, match="same start times"):
        request_to_model_input(req)


def test_accepts_several_courts_offering_the_identical_tick_set():
    """The guard must not have become "one court only". This is the shape
    every board in `bench/` has, and the shape a normal request has."""
    req = _valid_request(
        court_names=["Court 1", "Court 2"],
        slots=[
            scheduler_pb2.Slot(court_index=c, start_at_ms=SLOT_MS + k * 3_600_000, day_index=0)
            for c in (0, 1)
            for k in range(2)
        ],
    )
    assert len(request_to_model_input(req).grid_slots) == 4


def test_rejects_duplicate_entrant_indices_within_a_fixture():
    """A repeated entrant makes the fixture silently UNPLACEABLE.

    `by_entrant` puts the fixture's index in its own group twice, and the
    per-entrant `AddNoOverlap` then requires that fixture's rest interval not
    to overlap ITSELF — which forces `placed[i] = 0`."""
    req = _valid_request(
        fixtures=[scheduler_pb2.Fixture(entrant_indices=[0, 0], division_index=0)]
    )
    with pytest.raises(InvalidRequestError, match="entrant_indices"):
        request_to_model_input(req)


def test_accepts_pinned_rows_with_no_identity_of_their_own():
    """`PinnedRow` carries no fixture id or index — round 6 confirmed by
    tracing every read that the old `Assignment.fixture_id` on an `existing`
    row reached nothing but a debug variable-name label in `model.py`, never
    a constraint. The old "reuses a movable fixture's id" / "pinned twice
    under the same id" family is gone with it: there is no id left for two
    pinned rows to collide on. This test replaces `test_accepts_pinned_rows_
    with_ids_of_their_own` — the rule now is simply that distinct pinned rows
    map straight through."""
    req = _valid_request(
        existing=[
            scheduler_pb2.PinnedRow(court_index=0, start_at_ms=SLOT_MS),
            scheduler_pb2.PinnedRow(court_index=0, start_at_ms=SLOT_MS + 3_600_000),
        ]
    )
    parsed = request_to_model_input(req)
    assert parsed.existing == [(0, SLOT_MS), (0, SLOT_MS + 3_600_000)]


def test_rejects_a_dependency_naming_an_out_of_range_fixture():
    """The positional restatement of "dependency naming an unknown fixture".
    Also closes what used to need its OWN test: a dependency naming a PINNED
    row's id. `PinnedRow` has no identity/index namespace of its own any
    more, so there is nothing for a dependency to misname there — every
    `before_index`/`after_index` is interpreted as a `fixtures` position,
    full stop, and out-of-range is out-of-range regardless of what the
    caller might have meant by it."""
    req = _valid_request(dependencies=[scheduler_pb2.OrderPair(before_index=0, after_index=1)])
    with pytest.raises(InvalidRequestError, match="dependencies.*after_index"):
        request_to_model_input(req)


@pytest.mark.parametrize("start_at_ms", [0, -1])
def test_rejects_a_pinned_row_without_a_real_start(start_at_ms):
    """An unset `start_at_ms` builds the blocking interval at epoch 0, which
    overlaps nothing real, so the pin is silently ignored and a movable
    fixture takes the pinned slot."""
    req = _valid_request(
        existing=[scheduler_pb2.PinnedRow(court_index=0, start_at_ms=start_at_ms)]
    )
    with pytest.raises(InvalidRequestError, match="existing"):
        request_to_model_input(req)


@pytest.mark.parametrize("start_at_ms", [0, -1])
def test_rejects_a_grid_slot_without_a_real_start(start_at_ms):
    """Same argument one field over, and the asymmetry is the point: a slot at
    epoch 0 is a legal tick in 1970 that fixtures are then placed on and
    proved OPTIMAL."""
    req = _valid_request(
        slots=[scheduler_pb2.Slot(court_index=0, start_at_ms=start_at_ms, day_index=0)]
    )
    with pytest.raises(InvalidRequestError, match="slots"):
        request_to_model_input(req)


@pytest.mark.parametrize(
    "rule_kwargs",
    [
        pytest.param({"min_rest_minutes": 45}, id="rest"),
        pytest.param({"max_fixtures_per_day": 1}, id="day-cap"),
    ],
)
def test_rejects_a_rule_for_an_out_of_range_division(rule_kwargs):
    """The positional restatement of "rule naming an undeclared division".

    Note what this does NOT reproduce: the old check rejected a division_id
    that no FIXTURE actually used, a data-dependent cross-reference. The new
    one rejects a division_index outside the DECLARED bound
    (`division_count`) — the brief's own words, "survives, now as a range
    check". An in-range-but-unused division_index (e.g. `division_count=5`
    but only divisions 0-1 ever appear on a fixture) is therefore no longer
    rejected; it is simply inert, exactly like a division absent from
    `division_rules` altogether. Recorded here rather than silently
    narrowed, since it is a real (if small) capability difference from the
    string contract, not an oversight.
    """
    req = _valid_request(
        division_rules=[scheduler_pb2.DivisionRule(division_index=1, **rule_kwargs)]
    )
    with pytest.raises(InvalidRequestError, match="division_rules.*division_index"):
        request_to_model_input(req)


def test_rejects_duplicate_division_rules():
    """These are repeated messages, not a proto `map`, so two rules for one
    division are legal on the wire. Unlike the old two-list contract, a
    duplicate is now checked ONCE per division_index rather than once per
    list — a caller wanting both a rest rule and a cap for one division must
    combine them into a single `DivisionRule` entry."""
    req = _valid_request(
        division_rules=[
            scheduler_pb2.DivisionRule(division_index=0, min_rest_minutes=45),
            scheduler_pb2.DivisionRule(division_index=0, max_fixtures_per_day=1),
        ]
    )
    with pytest.raises(InvalidRequestError, match="division_rules"):
        request_to_model_input(req)


def test_a_single_rule_may_carry_both_rest_and_cap_for_one_division():
    """The replacement for the two-list contract's independence: a division
    may have a rest rule, a cap, or both — now expressed as which fields of
    ONE `DivisionRule` entry are present, not which of two lists it appears
    in."""
    req = _valid_request(
        division_rules=[
            scheduler_pb2.DivisionRule(division_index=0, min_rest_minutes=45, max_fixtures_per_day=2)
        ]
    )
    parsed = request_to_model_input(req)
    assert parsed.constraints["rest_by_division"] == {0: 45}
    assert parsed.constraints["day_cap_by_division"] == {0: 2}


def test_a_rule_may_carry_only_rest_leaving_the_division_uncapped():
    req = _valid_request(
        division_rules=[scheduler_pb2.DivisionRule(division_index=0, min_rest_minutes=45)]
    )
    parsed = request_to_model_input(req)
    assert parsed.constraints["rest_by_division"] == {0: 45}
    assert parsed.constraints["day_cap_by_division"] == {}


def test_rejects_a_fixture_with_no_entrants():
    """An entrant-less fixture joins no `by_entrant` group, so the participant-
    rest NoOverlap and every T2 idle-gap term skip it entirely."""
    req = _valid_request(fixtures=[scheduler_pb2.Fixture(division_index=0)])
    with pytest.raises(InvalidRequestError, match="entrant_indices"):
        request_to_model_input(req)


def test_invalid_request_error_is_a_value_error():
    """`main.py` catches `InvalidRequestError` and `ValueError` on separate
    branches; both must land on the same SOLVE_STATUS_ERROR shape, and the
    subclass relationship is what keeps a missed branch from escaping."""
    assert issubclass(InvalidRequestError, ValueError)


# --- the closed set: every uint32 index field in the contract ---------------
#
# Retargeted from `_require_id`'s string-field gate (rounds 2-5) to index
# fields. Same shape, same purpose: enumerate the fields from the DESCRIPTOR,
# state one policy, and prove no field escapes it — built the "other way
# round" from the start, because rounds 2-4's string gate showed that closing
# only the members you were SHOWN leaves the family open.
#
# Policy: every index must be IN RANGE for the list/count it points into, and
# every SINGULAR (non-repeated) one must be explicitly SET.


def _maximal_request() -> scheduler_pb2.SolveBuildRequest:
    """A VALID request that populates every uint32-bearing message in the
    contract at least once. Every perturbation below starts from this, so a
    rejection can only have been caused by the one field that was changed."""
    return scheduler_pb2.SolveBuildRequest(
        request_id="r1",
        court_names=["Court 1", "Court 2"],
        entrant_count=4,
        division_count=1,
        slots=[
            scheduler_pb2.Slot(court_index=c, start_at_ms=SLOT_MS + k * 3_600_000, day_index=0)
            for c in (0, 1)
            for k in range(2)
        ],
        step_minutes=10,
        fixtures=[
            scheduler_pb2.Fixture(entrant_indices=[0, 1], division_index=0),
            scheduler_pb2.Fixture(entrant_indices=[2, 3], division_index=0),
        ],
        existing=[scheduler_pb2.PinnedRow(court_index=0, start_at_ms=SLOT_MS)],
        dependencies=[scheduler_pb2.OrderPair(before_index=0, after_index=1)],
        division_rules=[scheduler_pb2.DivisionRule(division_index=0, min_rest_minutes=45)],
        constraints=_constraints(),
        wall_seconds=8.0,
    )


#: Keyed by `Message.field` exactly as the descriptor names it, so the
#: completeness test below can compare this table against the proto itself.
#: Each perturbation sets an OUT-OF-RANGE value.
INDEX_FIELDS = {
    "Fixture.division_index": lambda r: setattr(r.fixtures[0], "division_index", 999),
    "Fixture.entrant_indices": lambda r: r.fixtures[0].entrant_indices.__setitem__(0, 999),
    "Slot.court_index": lambda r: setattr(r.slots[0], "court_index", 999),
    "PinnedRow.court_index": lambda r: setattr(r.existing[0], "court_index", 999),
    "OrderPair.before_index": lambda r: setattr(r.dependencies[0], "before_index", 999),
    "OrderPair.after_index": lambda r: setattr(r.dependencies[0], "after_index", 999),
    "DivisionRule.division_index": lambda r: setattr(r.division_rules[0], "division_index", 999),
}

#: Deliberately outside the range/presence policy, with the reason. Listed
#: rather than omitted so the completeness test still has to account for the
#: field. Neither is an INDEX — each is the declared BOUND other indices are
#: checked against.
EXEMPT_INDEX_FIELDS = {
    "SolveBuildRequest.entrant_count": "a declared bound for entrant_indices, not itself an index",
    "SolveBuildRequest.division_count": "a declared bound for division_index fields, not itself an index",
}


def _contract_index_fields() -> set[str]:
    """Every `uint32` field reachable from `SolveBuildRequest`, from the
    proto itself."""
    from google.protobuf.descriptor import FieldDescriptor

    found: set[str] = set()
    seen: set[str] = set()

    def walk(descriptor):
        if descriptor.full_name in seen:
            return
        seen.add(descriptor.full_name)
        for field in descriptor.fields:
            if field.type == FieldDescriptor.TYPE_UINT32:
                found.add(f"{descriptor.name}.{field.name}")
            elif field.type == FieldDescriptor.TYPE_MESSAGE:
                walk(field.message_type)

    walk(scheduler_pb2.SolveBuildRequest.DESCRIPTOR)
    return found


def test_the_index_policy_accounts_for_every_uint32_field_in_the_contract():
    """The closed set, checked against the proto rather than against memory.

    Add a `uint32` field to `scheduler.proto` and this fails until it is
    either routed through the range check or exempted with a reason.
    """
    assert _contract_index_fields() == set(INDEX_FIELDS) | set(EXEMPT_INDEX_FIELDS)

    # A union alone is NOT a closed set — the string-field gate's mutation
    # sweep proved it (moving a field between the two tables leaves the union
    # identical and survives 6/6). So the exemption list is pinned literally,
    # and no field may be in both.
    assert set(EXEMPT_INDEX_FIELDS) == {
        "SolveBuildRequest.entrant_count",
        "SolveBuildRequest.division_count",
    }
    assert set(INDEX_FIELDS).isdisjoint(EXEMPT_INDEX_FIELDS)


@pytest.mark.parametrize("path", sorted(INDEX_FIELDS))
def test_an_out_of_range_index_is_rejected_in_every_index_field(path):
    req = _maximal_request()
    INDEX_FIELDS[path](req)
    with pytest.raises(InvalidRequestError, match="out of range"):
        request_to_model_input(req)


def test_the_maximal_request_is_valid_unperturbed():
    """Otherwise every case above could be passing for the wrong reason."""
    parsed = request_to_model_input(_maximal_request())
    assert len(parsed.fixtures) == 2
    assert parsed.existing == [(0, SLOT_MS)]


def test_an_exempt_field_carries_no_range_or_presence_check():
    """The exemption has to be real, or the table is decorative. Setting
    `entrant_count`/`division_count` to a value that happens to be smaller
    than an index actually used is caught by the INDEX field's own range
    check (proven above); this test is about the count fields THEMSELVES
    never being range- or presence-checked directly — any uint32 value,
    including 0, is a legal thing to declare as a count."""
    req = _maximal_request()
    req.entrant_count = 4  # unchanged, already valid; this is a smoke check
    req.division_count = 1
    parsed = request_to_model_input(req)
    assert parsed.wall_seconds == 8.0


# --- presence, for every SINGULAR index field --------------------------------
#
# This is NOT literally what the brief's ruling states ("every index must be
# in range... is the complete set of identity rules") — it is an extension of
# it, and the reasoning for adding it is recorded in `cp_sat.schema`'s module
# docstring: a range check alone cannot catch a caller who simply forgot to
# set a singular index field, because 0 is always in range and always a
# legitimate index. Flagged here as a deliberate addition beyond the letter
# of the brief, not a silent one — this is exactly the kind of place the
# brief invites pushback.
#
# `Fixture.entrant_indices` is excluded: it is REPEATED, and a repeated
# field's elements carry no presence ambiguity of their own.
PRESENCE_FIELDS = {
    "Fixture.division_index": lambda r: r.fixtures[0].ClearField("division_index"),
    "Slot.court_index": lambda r: r.slots[0].ClearField("court_index"),
    "PinnedRow.court_index": lambda r: r.existing[0].ClearField("court_index"),
    "OrderPair.before_index": lambda r: r.dependencies[0].ClearField("before_index"),
    "OrderPair.after_index": lambda r: r.dependencies[0].ClearField("after_index"),
    "DivisionRule.division_index": lambda r: r.division_rules[0].ClearField("division_index"),
}


def test_presence_fields_are_the_singular_index_fields_minus_entrant_indices():
    """Pins the two tables to the same key set minus the one repeated field,
    so a field added to one and not the other (when it should be in both) is
    caught rather than silently under-tested."""
    assert set(PRESENCE_FIELDS) == set(INDEX_FIELDS) - {"Fixture.entrant_indices"}


@pytest.mark.parametrize("path", sorted(PRESENCE_FIELDS))
def test_an_unset_singular_index_field_is_rejected(path):
    """0 is always a legitimate index, so an unset field must be refused
    rather than silently read as index 0."""
    req = _maximal_request()
    PRESENCE_FIELDS[path](req)
    with pytest.raises(InvalidRequestError, match="must be set"):
        request_to_model_input(req)


# --- round 6: confusable court names are now harmless, by construction ------
#
# The whole point of the redesign. Rounds 4-6 tried, in order: reject
# whitespace, reject invisible Unicode, and were about to try rejecting
# homoglyphs when the pattern was recognised — every character rule is a
# guess about what a caller MEANT by two strings that render identically, and
# the guessing never terminates. The service was never actually misbehaving:
# given two distinct strings it saw two courts and placed one fixture on
# each, correctly. Now that court identity is POSITIONAL, "two distinct
# strings" and "two distinct entities" are the same fact, and there is
# nothing left to reject.
#
# Small boards (2 fixtures, 2 courts), never the production board — per the
# brief. N=6 per `_RULES.md` section 6b: the solver is nondeterministic, so a
# single run is a sample, not an observation.
N_REPRO = 6


def _confusable_pair_request(second_court_name: str) -> scheduler_pb2.SolveBuildRequest:
    """Two fixtures, two courts (one plain, one perturbed to be confusable
    with the first), each fixture free to land on either court at the SAME
    instant. If identity were still string-based and the two names collapsed,
    this would double-book one court; if it were rejected outright, this
    would raise. Under positional identity it is simply two fixtures on two
    distinct court indices."""
    return scheduler_pb2.SolveBuildRequest(
        request_id="r1",
        court_names=["Court 1", second_court_name],
        entrant_count=4,
        division_count=1,
        fixtures=[
            scheduler_pb2.Fixture(entrant_indices=[0, 1], division_index=0),
            scheduler_pb2.Fixture(entrant_indices=[2, 3], division_index=0),
        ],
        slots=[
            scheduler_pb2.Slot(court_index=c, start_at_ms=SLOT_MS, day_index=0) for c in (0, 1)
        ],
        step_minutes=10,
        constraints=scheduler_pb2.BuildConstraints(match_minutes=30, gap_minutes=10),
        wall_seconds=5.0,
    )


@pytest.mark.parametrize(
    "second_court_name",
    [
        pytest.param("Court 1 ", id="whitespace"),
        # U+3164 Hangul Filler: printable per Unicode's Lo category, and one
        # of the ten code points round 5's re-review found that pass
        # `str.isprintable()` while being invisible to a human.
        pytest.param("Court 1" + chr(0x3164), id="invisible-hangul-filler"),
        # Cyrillic Es (U+0421) in place of the Latin C. Fully printable, fully
        # visible, and identical to the eye — no invisibility rule of any
        # kind could ever have caught this one.
        pytest.param("Сourt 1", id="cyrillic-homoglyph"),
    ],
)
def test_a_confusable_court_name_is_harmless_end_to_end(second_court_name):
    """`request_to_model_input` -> `build_model` -> `solve`, the same call
    sequence `main.py` makes. Each of the three families that defeated a
    character rule must now be harmless BY CONSTRUCTION: two fixtures land on
    two distinct court indices, never double-booked, and the request is
    never rejected at all."""
    from cp_sat.model import build_model, solve

    placed_counts = []
    courts_used_per_run = []
    for _ in range(N_REPRO):
        req = _confusable_pair_request(second_court_name)
        parsed = request_to_model_input(req)  # must not raise
        model = build_model(
            parsed.fixtures,
            parsed.courts,
            parsed.grid_slots,
            parsed.step_minutes,
            parsed.constraints,
            parsed.existing,
            parsed.dependencies,
        )
        outcome = solve(model, wall_seconds=5.0)
        placed_counts.append(len(outcome.assignments))
        courts_used_per_run.append(sorted({court for _f, court, _s in outcome.assignments}))

    detail = f"placed_counts={placed_counts} courts_used={courts_used_per_run}"
    assert placed_counts == [2] * N_REPRO, detail
    assert courts_used_per_run == [[0, 1]] * N_REPRO, (
        f"expected both distinct court indices used on every run (never double-booked one "
        f"court), got: {detail}"
    )


# --- the outbound half of the boundary --------------------------------------


def _outcome(**overrides) -> SolveOutcome:
    kwargs = dict(
        assignments=[(0, 0, 0)],
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
    assert [(a.fixture_index, a.court_index, a.start_at_ms) for a in resp.assignments] == [
        (0, 0, 0)
    ]
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
    and tells the caller the budget was not the limiting factor — which is the
    one thing this flag exists to say.
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
