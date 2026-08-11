"""The anti-corruption layer between the wire and the domain.

This module is the ONLY place a proto message is read, and the ONLY place a
plain-Python solve result is turned back into one — both directions, one file.
`placement.model` and `placement.objective` are written against tuples, dicts and
floats and must never import `scheduler_pb2`; `placement.main` orchestrates
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
  * a division's `max_fixtures_per_day` of `0` — that division may not be
    placed at all, and the solve reports OPTIMAL having dropped all of its
    fixtures.
  * `wall_seconds == 0` — the tier chain stops before T0, returning UNKNOWN
    with no assignments, which is exactly what an impossible board returns.
  * `slots` empty — every fixture is forced onto tick 0, and one fixture per
    court is placed and proved OPTIMAL while the rest are silently dropped.
    Measured through the real server: 8 fixtures, 2 courts, no slots -> a
    board proved OPTIMAL, `error` unset, most fixtures silently unplaced.

`build_model` and `run_tier_chain` guard the first two themselves and raise
`ValueError`. Those guards stay: they protect the bench and any future caller.
But the wire is where the mistake is actually made, so it is caught here first
and as an `InvalidRequestError`, which `placement.main` turns into a
`SOLVE_STATUS_ERROR` response carrying the reason — a well-formed answer the
caller can act on, rather than an exception crossing the RPC boundary.

--- round 6: identity is POSITIONAL, and `_require_id` is gone -------------

`_require_id` went through three rounds of character rules — whitespace,
then invisible Unicode, then homoglyphs — and never terminated, because every
rule was a guess about what a caller MEANT by two strings that render
identically. The service never actually misbehaved: given two distinct
strings it saw two courts and placed one fixture on each, correctly. The
wrongness only ever appeared when a human rendered the board — and this
context never renders (`docs/superpowers/plans/2026-08-07-placement-service-
prompts/_RULES.md` section 1: this is a PLACER only). So the fix is not a
fourth character rule; it is to stop comparing strings at all.

A fixture's identity is its position in `fixtures`. A court's is its position
in `court_names`. A division's or entrant's identity is a caller-assigned
index, bounded by a declared count (`division_count` / `entrant_count`)
rather than inferred from the largest index actually used — an inferred
bound cannot distinguish "entrant 7" from a typo, a declared one can.

In `_require_id`'s place, ONE rule, in two parts:

  * every index must be IN RANGE for the list or count it points into.
    Out-of-range is a hard reject naming the field, the value, and the bound.
  * every SINGULAR (non-repeated) index field must be explicitly SET. Proto3
    has no way to say "absent" for a non-optional scalar, and 0 is always a
    legitimate index — so without presence tracking, a caller who forgot to
    set (say) `Fixture.division_index` would silently join division 0's
    rest/cap rules rather than being refused. That is the SAME "unset vs.
    legitimately zero" trap `gap_minutes` and `Slot.day_index` already close
    with proto3 `optional`, applied to every field whose entire job is naming
    one specific entity. `entrant_indices` is exempt from this second part —
    it is REPEATED, and a repeated field's elements carry no presence
    ambiguity of their own: every element that exists was explicitly
    appended, so only its range is checked.

`tests/test_schema.py`'s completeness gate enumerates every `uint32` field
straight out of `SolveBuildRequest.DESCRIPTOR` and asserts each one either
reaches `_require_index_range` (and, where singular, `_require_index_present`)
or sits on a named exemption list — the same shape `_require_id`'s gate had,
retargeted from string fields to index fields.

Two things this rule does NOT need to reproduce from the string contract,
because the defect they closed cannot occur positionally any more:

  * canonicality ("is this the same id as that one, once whitespace/invisible
    characters/homoglyphs are accounted for") — there is no id to canonicalise.
  * `courts` uniqueness/blankness — `court_names` is now display-only, never
    compared, never required unique. Two entries that render identically are
    simply two distinct, correctly-disambiguated indices.

Most of what the old referential-integrity pass enforced — a pinned row on a
court nobody declared, a dependency naming an unresolvable fixture, a rule
naming an undeclared division — survives, now as a range check instead of a
dict-membership check. `model.py`'s own tolerance of an out-of-range index
(skip rather than crash) is UNCHANGED, for the same reason it was unchanged
in the string contract: the wire is where the mistake is caught, not the
domain, and moving the check there would take away the domain's own ability
to be fed a partial board directly (by tests, or any future caller).

--- task C2: the per-court coverage refusal is GONE, not renamed --------------

Two shapes used to be refused here by `_validate_court_slot_coverage`, which
no longer exists: a court declared without slots, and courts offering
different tick sets from one another. Both were a REFUSAL standing in for a
missing capability — `model.py` unioned every court's admissible starts into
one shared domain, so a per-court blackout could not be expressed and the
whole request was bounced back to the caller's own greedy fallback instead of
risking a fixture placed on a tick its court never actually offered.

`model.py` now enforces each court's own tick set directly (see its
docstring, "per-court grids"), so neither shape needs a refusal any more —
one is simply modelled correctly (a per-fixture domain restriction, court by
court), and the other (a court no slot mentions at all — a legitimate way to
configure a court blacked out for the whole horizon) is handled by forcing
that court's `presence_court[i][c]` to 0 for every fixture, in the domain,
rather than by rejecting the request at the ACL. The RULE survives; only the
REFUSAL does not.
"""

from __future__ import annotations

from dataclasses import dataclass

from placement.generated import scheduler_pb2
from placement.model import SolveOutcome
from placement.objective import MIN_TIER_SECONDS

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
    `ValueError` for the same conditions, and `placement.main` maps both onto one
    response shape. Anything that catches `ValueError` therefore cannot miss
    this, whichever layer noticed first.
    """


@dataclass(frozen=True)
class ModelInput:
    """Exactly `build_model`'s arguments plus the wall budget, in domain types.

    Field order and shapes mirror `placement.model.build_model`'s signature so the
    call site in `main.py` is a straight unpack with nothing to get wrong.
    `main.py` is out of scope for this round and reads these fields by NAME
    (`parsed.courts`, `parsed.step_minutes`, ...) — every name below is
    unchanged from the string contract even though several TYPES are not.
    """

    courts: int  # the COUNT of courts (len(court_names)); names never reach the domain
    fixtures: list[tuple[list[int], int]]  # (entrant_indices, division_index)
    grid_slots: list[tuple[int, int, int]]  # (court_index, start_at_ms, day_index)
    step_minutes: int
    constraints: dict
    existing: list[tuple[int, int]]  # (court_index, start_at_ms) -- no fixture identity
    dependencies: list[tuple[int, int]]  # (before_index, after_index) -- fixture positions
    wall_seconds: float


def _require_index_present(has_field: bool, where: str) -> None:
    """Half of the chokepoint every SINGULAR index field passes through.

    0 is always a legitimate index, so an unset singular `uint32` field is
    indistinguishable from a deliberate 0 by value alone — the caller who
    forgot to set `where` gets silently routed to index 0 instead of being
    refused. Same defence proto3 `optional` already gives `gap_minutes` and
    `Slot.day_index`, applied here to every field whose whole job is naming
    one entity. Repeated fields (`entrant_indices`) do not call this — an
    element that exists in a repeated field was explicitly appended, so
    there is no presence ambiguity to close.
    """
    if not has_field:
        raise InvalidRequestError(
            f"{where} must be set. 0 is a legitimate index, so an unset field cannot be told from "
            "a deliberately-chosen 0 by its value alone — and would otherwise silently resolve to "
            "index 0 rather than being refused, joining the wrong group instead of erroring."
        )


def _require_index_range(value: int, bound: int, where: str) -> int:
    """The other half: every index must be IN RANGE for the list or count it
    points into. Out-of-range is a hard reject naming the field, the value,
    and the bound — the complete replacement for `_require_id`'s canonicality
    checks, because there is no id left to canonicalise."""
    if not (0 <= value < bound):
        raise InvalidRequestError(
            f"{where} = {value} is out of range: every index here must satisfy 0 <= {where} < "
            f"{bound}. An inferred bound (the largest index actually used) cannot distinguish a "
            f"real high index from a typo; {bound} is the request's OWN declared bound."
        )
    return value


def _validated_fixtures(
    proto_fixtures, entrant_count: int, division_count: int
) -> list[tuple[list[int], int]]:
    """The movable fixtures, with every index they carry checked for range.

    Runs first because everything after it resolves against what it returns:
    the dependency endpoints resolve against `len(fixtures)`.
    """
    fixtures: list[tuple[list[int], int]] = []
    for i, f in enumerate(proto_fixtures):
        if len(f.entrant_indices) == 0:
            raise InvalidRequestError(
                f"fixtures[{i}].entrant_indices must not be empty. A fixture with no entrants "
                "joins no participant group, so the participant-rest NoOverlap and every T2 "
                "idle-gap term skip it. Measured (string contract, same mechanism): two fixtures "
                "sharing one player placed CONCURRENTLY, reported OPTIMAL."
            )
        entrant_indices = [
            _require_index_range(e, entrant_count, f"fixtures[{i}].entrant_indices[{j}]")
            for j, e in enumerate(f.entrant_indices)
        ]
        if len(set(entrant_indices)) != len(entrant_indices):
            # Not cosmetic: a repeated entrant puts this fixture's index in its
            # own `by_entrant` group TWICE, and the per-entrant AddNoOverlap
            # then requires its rest interval not to overlap ITSELF — which is
            # unsatisfiable, so `placed[i]` is forced to 0. Same mechanism the
            # string contract measured 6/6: entrant_ids=["e1","e1"] gave
            # OPTIMAL/placed=0/error unset where ["e1","e2"] placed it.
            raise InvalidRequestError(
                f"fixtures[{i}].entrant_indices repeats an entrant, got {list(entrant_indices)!r}. "
                "The duplicate makes the fixture overlap itself in its own participant-rest group, "
                "so it becomes silently UNPLACEABLE and the board comes back OPTIMAL without it."
            )

        _require_index_present(f.HasField("division_index"), f"fixtures[{i}].division_index")
        division_index = _require_index_range(
            f.division_index, division_count, f"fixtures[{i}].division_index"
        )
        fixtures.append((entrant_indices, division_index))
    return fixtures


def _validated_slots(proto_slots, num_courts: int) -> list[tuple[int, int, int]]:
    out: list[tuple[int, int, int]] = []
    for i, s in enumerate(proto_slots):
        _require_index_present(s.HasField("court_index"), f"slots[{i}].court_index")
        court_index = _require_index_range(s.court_index, num_courts, f"slots[{i}].court_index")
        if s.start_at_ms <= 0:
            raise InvalidRequestError(
                f"slots[{i}].start_at_ms must be > 0, got {s.start_at_ms!r}. Epoch 0 is 1970 and "
                "is never a legitimate court time; an unset start is a legal tick that fixtures are "
                "then placed on and proved OPTIMAL."
            )
        if not s.HasField("day_index"):
            raise InvalidRequestError(
                f"slots[{i}].day_index must be set. Day 0 is a legitimate value, so an unset "
                "field cannot be told from a real one by its value — and unset puts EVERY slot on "
                "day 0, collapsing the whole lattice into one day-cap bucket. Resolve each slot to "
                "the org's local calendar day; the solver never reasons about time zones."
            )
        if s.day_index < 0:
            raise InvalidRequestError(f"slots[{i}].day_index must be >= 0, got {s.day_index!r}.")
        out.append((court_index, s.start_at_ms, s.day_index))
    return out


def _validated_existing(rows, num_courts: int) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for i, a in enumerate(rows):
        _require_index_present(a.HasField("court_index"), f"existing[{i}].court_index")
        court_index = _require_index_range(a.court_index, num_courts, f"existing[{i}].court_index")
        if a.start_at_ms <= 0:
            raise InvalidRequestError(
                f"existing[{i}].start_at_ms must be > 0, got {a.start_at_ms!r}. An unset start "
                "builds the blocking interval at epoch 0, which overlaps nothing real, so the pin "
                "is silently ignored and a movable fixture takes the pinned slot."
            )
        out.append((court_index, a.start_at_ms))
    return out


def _validated_dependencies(pairs, num_fixtures: int) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for i, d in enumerate(pairs):
        _require_index_present(d.HasField("before_index"), f"dependencies[{i}].before_index")
        before = _require_index_range(d.before_index, num_fixtures, f"dependencies[{i}].before_index")
        _require_index_present(d.HasField("after_index"), f"dependencies[{i}].after_index")
        after = _require_index_range(d.after_index, num_fixtures, f"dependencies[{i}].after_index")
        out.append((before, after))
    return out


def _validated_division_rules(rules, division_count: int) -> tuple[dict[int, int], dict[int, int]]:
    """`division_rules`, split into the two dicts `build_model` expects.

    Replaces `_rule_map` x2 (one call per old list). A `DivisionRule` entry
    may carry a rest rule, a cap, or both — each is presence-checked
    independently — but at most ONE entry may exist per division: two entries
    naming the same `division_index` is the same "second rule for this
    division, and one was silently chosen" defect the old per-list duplicate
    check caught, now unified across both concerns instead of tracked twice.
    """
    rest_by_division: dict[int, int] = {}
    day_cap_by_division: dict[int, int] = {}
    seen: set[int] = set()
    for i, rule in enumerate(rules):
        _require_index_present(rule.HasField("division_index"), f"division_rules[{i}].division_index")
        division_index = _require_index_range(
            rule.division_index, division_count, f"division_rules[{i}].division_index"
        )
        if division_index in seen:
            raise InvalidRequestError(
                f"division_rules[{i}] is a second rule for division_index {division_index}. These "
                "are repeated messages rather than a map, so a duplicate is legal on the wire and "
                "the second one would silently win over the first."
            )
        seen.add(division_index)

        if rule.HasField("min_rest_minutes"):
            rest = rule.min_rest_minutes
            if rest < 0:
                raise InvalidRequestError(
                    f"division_rules[{i}].min_rest_minutes must be >= 0, got {rest!r}. The "
                    "participant-rest interval is match_minutes + rest wide, so a negative rest "
                    "shrinks it below match_minutes and two of one entrant's matches can overlap."
                )
            rest_by_division[division_index] = rest

        if rule.HasField("max_fixtures_per_day"):
            cap = rule.max_fixtures_per_day
            if cap <= 0:
                raise InvalidRequestError(
                    f"division_rules[{i}].max_fixtures_per_day must be > 0, got {cap!r}. A cap of "
                    "0 forbids placing that division at all and the board comes back OPTIMAL with "
                    "all of its fixtures dropped. To leave a division uncapped, do not set this "
                    "field rather than sending 0."
                )
            day_cap_by_division[division_index] = cap

    return rest_by_division, day_cap_by_division


def _validated_constraints(
    proto_constraints, rest_by_division: dict[int, int], day_cap_by_division: dict[int, int]
) -> dict:
    """The `build_model` constraints dict, validated.

    `match_minutes`/`gap_minutes` guards are unchanged from the string
    contract — this round is about identity, and neither field is id-shaped.
    """
    if not proto_constraints.HasField("gap_minutes"):
        raise InvalidRequestError(
            "constraints.gap_minutes must be set. 0 is a legitimate value ('no court turnaround'), "
            "so an unset field cannot be told from a deliberate one by its value — which is why the "
            "field carries proto3 `optional` and is checked for presence rather than for range. "
            "Unset silently books matches back-to-back and reports OPTIMAL."
        )

    constraints = {
        "match_minutes": proto_constraints.match_minutes,
        "gap_minutes": proto_constraints.gap_minutes,
        "rest_by_division": rest_by_division,
        "day_cap_by_division": day_cap_by_division,
    }

    if constraints["match_minutes"] <= 0:
        raise InvalidRequestError(
            f"constraints.match_minutes must be > 0, got {constraints['match_minutes']!r}. "
            "A zero-length match makes every court and rest interval zero-width, so the board "
            "comes back OPTIMAL with every fixture stacked on one tick."
        )
    if constraints["gap_minutes"] < 0:
        raise InvalidRequestError(
            f"constraints.gap_minutes must be >= 0, got {constraints['gap_minutes']!r}. The court "
            "interval is match_minutes + gap_minutes wide, so at gap == -match_minutes it is "
            "zero-width and two matches overlap on one court."
        )

    return constraints


def request_to_model_input(req) -> ModelInput:
    """Translate a `SolveBuildRequest` into domain types, or reject it.

    ONE referential-integrity pass, before any domain object exists: every
    index the request carries must be IN RANGE for the list or count it
    points into. Order matters — `court_names`/`entrant_count`/`division_count`
    are read first because they are the BOUNDS everything else resolves
    against; `fixtures` next because `len(fixtures)` is the bound
    `dependencies` resolves against.

    Args:
        req: a `scheduler_pb2.SolveBuildRequest`. Untyped in the signature so
            this module's *callers* need the proto import and its *consumers*
            do not — the boundary runs through here in one direction only.

    Raises:
        InvalidRequestError: on an empty board, on any degenerate scalar
            enumerated in the module docstring, or on any index that is
            unset or out of range.
    """
    if len(req.fixtures) == 0:
        raise InvalidRequestError("fixtures must not be empty")
    if len(req.court_names) == 0:
        raise InvalidRequestError("court_names must not be empty")
    if len(req.slots) == 0:
        raise InvalidRequestError(
            "slots must not be empty. With no admissible ticks the model falls back to a single "
            "start of 0, forces every fixture onto it, and proves ONE fixture per court OPTIMAL "
            "while silently dropping the rest."
        )
    if not req.HasField("constraints"):
        raise InvalidRequestError(
            "the BuildConstraints message must be set. It is a proto3 message field, so an omitted "
            "one arrives fully default-valued and every constraint family it carries disappears at "
            "once."
        )

    num_courts = len(req.court_names)
    entrant_count = req.entrant_count
    division_count = req.division_count

    fixtures = _validated_fixtures(req.fixtures, entrant_count, division_count)

    grid_slots = _validated_slots(req.slots, num_courts)
    # No per-court coverage refusal here any more (task C2). This used to be
    # `_validate_court_slot_coverage(num_courts, grid_slots)`, rejecting both
    # a declared-but-slotless court and courts whose tick sets merely
    # differed — `placement.model.build_model` now enforces each court's OWN
    # tick set directly (a per-fixture domain restriction, and a forced
    # `presence_court[i][c] == 0` on a court no slot mentions), so a
    # per-court blackout is placed correctly instead of the whole request
    # bouncing the caller back to its own greedy fallback. See that module's
    # docstring, "per-court grids" / "task C2".
    existing = _validated_existing(req.existing, num_courts)
    dependencies = _validated_dependencies(req.dependencies, len(fixtures))
    rest_by_division, day_cap_by_division = _validated_division_rules(
        req.division_rules, division_count
    )
    constraints = _validated_constraints(req.constraints, rest_by_division, day_cap_by_division)

    if req.wall_seconds <= 0:
        raise InvalidRequestError(
            f"wall_seconds must be > 0, got {req.wall_seconds!r}. A 0 budget stops the tier chain "
            "before T0 runs and returns UNKNOWN with no assignments — the same answer an impossible "
            "board gives, so an unset field would read as a solver verdict about the request."
        )

    return ModelInput(
        courts=num_courts,
        fixtures=fixtures,
        grid_slots=grid_slots,
        step_minutes=req.step_minutes,
        constraints=constraints,
        existing=existing,
        dependencies=dependencies,
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
        outcome: the domain's `SolveOutcome`, in plain Python. `outcome.
            assignments` is now `(fixture_index, court_index, start_at_ms)`
            triples of ints, matching `Assignment`'s new shape directly.
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
            scheduler_pb2.Assignment(fixture_index=fi, court_index=ci, start_at_ms=start)
            for fi, ci, start in outcome.assignments
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
            scheduler_pb2.Tier(name=name, value=value)
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
