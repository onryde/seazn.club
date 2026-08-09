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

--- and the same defect wearing an ID instead of a number -------------------

A re-audit of Tasks 1-4 found seven more instances, and they turned out to be
ONE defect: nothing checked that an id the request MENTIONS resolves to
something the request DECLARES. A dependency naming a fixture that is not in
`fixtures`, a pinned row on a court that is not in `courts`, a rest rule keyed
on a division no fixture is in — each is dropped by the domain deliberately
and wordlessly, and the caller receives OPTIMAL with `error` unset for a board
missing the constraint they asked for.

So `request_to_model_input` runs ONE referential-integrity pass rather than
seven field guards, in dependency order: fixtures first (they declare the
fixture ids and the divisions), then the grid, the pinned rows, the
dependencies and the division rules against them. The domain's tolerance is
NOT changed — `model.py`'s `id_to_idx.get(...) or continue` and its
`if existing_court in court_lists` are what let the bench feed it partial
boards, and moving the check there would break that. The wire is where the
mistake is made, so the wire is where it is caught.

Two fields carry proto3 `optional` and are checked for PRESENCE rather than
for range, because 0 is a legitimate answer for both and no value guard can
reach them: `constraints.gap_minutes` (no court turnaround) and
`DivisionRestRule.min_rest_minutes` (no minimum rest). Nothing else does, and
that restraint is deliberate — `ts-proto` renders a proto3-`optional` field as
`field?: T | undefined`, so marking a field the caller must ALWAYS send
`optional` trades a run-time guard here for the loss of a compile-time one in
`build.ts`. Presence is spent only where the value cannot carry the
information.
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


def _validated_fixtures(proto_fixtures) -> list[tuple[str, list[str], str]]:
    """The movable fixtures, with every id they carry checked for substance.

    Runs first because everything after it resolves against what it returns:
    the dependency endpoints must name one of these fixtures and the division
    rules must name one of these divisions.
    """
    fixtures: list[tuple[str, list[str], str]] = []
    seen: set[str] = set()
    for i, f in enumerate(proto_fixtures):
        if not f.fixture_id:
            raise InvalidRequestError(
                f"fixtures[{i}].fixture_id must not be empty. `assignments` come back keyed by "
                "fixture_id, so an unset one hands the caller rows it cannot map to anything "
                "(verified: two rows, both fixture_id='')."
            )
        if f.fixture_id in seen:
            raise InvalidRequestError(
                f"fixtures[{i}].fixture_id {f.fixture_id!r} is a duplicate. The model's id index is "
                "last-wins, so every dependency naming it resolves to the second fixture."
            )
        seen.add(f.fixture_id)

        if len(f.entrant_ids) == 0:
            raise InvalidRequestError(
                f"fixtures[{i}].entrant_ids must not be empty (fixture {f.fixture_id!r}). A fixture "
                "with no entrants joins no participant group, so the participant-rest NoOverlap and "
                "every T2 idle-gap term skip it. Measured: two fixtures sharing one player placed "
                "CONCURRENTLY, reported OPTIMAL."
            )
        if any(not entrant for entrant in f.entrant_ids):
            raise InvalidRequestError(
                f"fixtures[{i}].entrant_ids contains an empty id (fixture {f.fixture_id!r}). Every "
                "empty entrant collides into ONE participant group, so unrelated fixtures acquire a "
                "shared-player rest constraint they do not have."
            )
        if not f.division_id:
            raise InvalidRequestError(
                f"fixtures[{i}].division_id must not be empty (fixture {f.fixture_id!r}). An unset "
                "division matches no rest rule and no day cap, so both families evaporate. Measured "
                "on one board with min_rest_minutes=240 and a cap of 1: division 'd1' places 1, "
                "unset places 4, both OPTIMAL with `error` unset."
            )
        fixtures.append((f.fixture_id, list(f.entrant_ids), f.division_id))
    return fixtures


def _validated_grid_slots(slots, known_courts: set[str]) -> list[tuple[str, int]]:
    for i, s in enumerate(slots):
        if s.court not in known_courts:
            raise InvalidRequestError(
                f"grid.slots[{i}].court {s.court!r} is not one of `courts`. The model unions every "
                "slot's start across all courts, so a slot naming a court the request never declared "
                "still contributes its tick and is otherwise ignored."
            )
        if s.start_at_ms <= 0:
            raise InvalidRequestError(
                f"grid.slots[{i}].start_at_ms must be > 0, got {s.start_at_ms!r}. Epoch 0 is 1970 and "
                "is never a legitimate court time; an unset start is a legal tick that fixtures are "
                "then placed on and proved OPTIMAL."
            )
    return [(s.court, s.start_at_ms) for s in slots]


def _validated_existing(rows, known_courts: set[str]) -> list[tuple[str, str, int]]:
    for i, a in enumerate(rows):
        if a.court not in known_courts:
            raise InvalidRequestError(
                f"existing[{i}].court {a.court!r} is not one of `courts`. A pinned row is folded into "
                "its court's interval list only if that court exists, and is skipped without a word "
                "otherwise — so the pin reserves nothing and a movable fixture is placed on top of a "
                "match already being played (measured, 5/5: board [] with the real court, the pinned "
                "slot taken with '' or a trailing space, OPTIMAL both times)."
            )
        if a.start_at_ms <= 0:
            raise InvalidRequestError(
                f"existing[{i}].start_at_ms must be > 0, got {a.start_at_ms!r}. An unset start builds "
                "the blocking interval at epoch 0, which overlaps nothing real, so the pin is "
                "silently ignored and a movable fixture takes the pinned slot."
            )
    return [(a.fixture_id, a.court, a.start_at_ms) for a in rows]


def _validated_dependencies(pairs, fixture_ids: set[str]) -> list[tuple[str, str]]:
    for i, d in enumerate(pairs):
        for role, fixture_id in (("before", d.before_fixture_id), ("after", d.after_fixture_id)):
            if fixture_id not in fixture_ids:
                raise InvalidRequestError(
                    f"dependencies[{i}].{role}_fixture_id {fixture_id!r} names no fixture in "
                    "`fixtures`. The model's id index is built from MOVABLE fixtures only, so an "
                    "unset id, a typo, and a real `existing` row are all dropped identically. "
                    "Measured, 5/5: a real pair separates two fixtures by 1 800 000 ms; every "
                    "unresolvable one separates them by 0, OPTIMAL, `error` unset."
                )
    return [(d.before_fixture_id, d.after_fixture_id) for d in pairs]


def _rule_map(rules, field: str, value_of, declared_divisions: set[str]) -> dict[str, int]:
    """One repeated division-keyed rule list, as a dict, with its keys checked.

    Repeated messages, not a proto `map`, so the wire permits two rules for one
    division and a dict comprehension keeps the LAST — the caller sent two
    numbers and one was chosen silently. And a key no fixture carries is inert:
    rest resolves as `rest_by_division.get(division, 0)` and the cap selects on
    `divisions[i] == division`, so neither ever matches. That second check is
    also the only thing in the request that can catch a typo.
    """
    out: dict[str, int] = {}
    for i, rule in enumerate(rules):
        if rule.division_id in out:
            raise InvalidRequestError(
                f"constraints.{field}[{i}] is a second rule for division {rule.division_id!r}. "
                "These are repeated messages rather than a map, so the duplicate is legal on the "
                "wire and the last one silently wins."
            )
        if rule.division_id not in declared_divisions:
            raise InvalidRequestError(
                f"constraints.{field}[{i}].division_id {rule.division_id!r} matches no fixture's "
                f"division (declared: {sorted(declared_divisions)}). The rule would be inert and the "
                "caller would be told nothing."
            )
        out[rule.division_id] = value_of(rule)
    return out


def _validated_constraints(proto_constraints, declared_divisions: set[str]) -> dict:
    """The `build_model` constraints dict, validated.

    Built before it is validated, and validated off the built dict rather than
    off the repeated proto field wherever the domain also guards the value:
    `build_model` guards the dict, so checking the same object it will check is
    what keeps the two from ever disagreeing about which values are admissible.
    Field PRESENCE is the exception — only the proto message can answer it, and
    only for the two fields that carry proto3 `optional`.
    """
    if not proto_constraints.HasField("gap_minutes"):
        raise InvalidRequestError(
            "constraints.gap_minutes must be set. 0 is a legitimate value ('no court turnaround'), "
            "so an unset field cannot be told from a deliberate one by its value — which is why the "
            "field carries proto3 `optional` and is checked for presence rather than for range. "
            "Unset silently books matches back-to-back and reports OPTIMAL."
        )

    rest_by_division = _rule_map(
        proto_constraints.rest_by_division,
        "rest_by_division",
        lambda r: r.min_rest_minutes,
        declared_divisions,
    )
    for i, rule in enumerate(proto_constraints.rest_by_division):
        if not rule.HasField("min_rest_minutes"):
            raise InvalidRequestError(
                f"constraints.rest_by_division[{i}].min_rest_minutes must be set (division "
                f"{rule.division_id!r}). 0 is legitimate ('no minimum rest'), so presence is the only "
                "thing separating it from an unset field — and an unset one makes a rule the caller "
                "explicitly sent behave exactly like omitting the division."
            )

    constraints = {
        "match_minutes": proto_constraints.match_minutes,
        "gap_minutes": proto_constraints.gap_minutes,
        "rest_by_division": rest_by_division,
        "day_cap_by_division": _rule_map(
            proto_constraints.day_cap_by_division,
            "day_cap_by_division",
            lambda r: r.max_fixtures_per_day,
            declared_divisions,
        ),
    }

    if constraints["match_minutes"] <= 0:
        raise InvalidRequestError(
            f"constraints.match_minutes must be > 0, got {constraints['match_minutes']!r}. "
            "A zero-length match makes every court and rest interval zero-width, so the board "
            "comes back OPTIMAL with every fixture stacked on one tick."
        )

    # Negative is worse than zero for both of the fields where zero is allowed:
    # it does not merely fail to constrain, it CANCELS the match length out of
    # the interval width and reopens a family that was closed. `build_model`
    # raises on both too; this is the wire half of that pair.
    if constraints["gap_minutes"] < 0:
        raise InvalidRequestError(
            f"constraints.gap_minutes must be >= 0, got {constraints['gap_minutes']!r}. The court "
            "interval is match_minutes + gap_minutes wide, so at gap == -match_minutes it is "
            "zero-width and two matches overlap on one court (measured: 37 placed, 4 tiers, 1 "
            "overlap, OPTIMAL)."
        )
    for division, rest in constraints["rest_by_division"].items():
        if rest < 0:
            raise InvalidRequestError(
                f"constraints.rest_by_division[{division!r}].min_rest_minutes must be >= 0, got "
                f"{rest!r}. The participant-rest interval is match_minutes + rest wide, so at "
                "rest == -match_minutes one entrant plays two simultaneous matches (measured: 37 "
                "placed, 4 tiers, 1 collision, OPTIMAL)."
            )

    for division, cap in constraints["day_cap_by_division"].items():
        if cap <= 0:
            raise InvalidRequestError(
                f"constraints.day_cap_by_division[{division!r}].max_fixtures_per_day must be > 0, "
                f"got {cap!r}. A cap of 0 forbids placing that division at all and the board comes "
                "back OPTIMAL with all of its fixtures dropped. To leave a division uncapped, omit "
                "it rather than sending 0."
            )

    return constraints


def request_to_model_input(req) -> ModelInput:
    """Translate a `SolveBuildRequest` into domain types, or reject it.

    ONE referential-integrity pass, before any domain object exists: every id
    the request mentions must resolve to something the same request declares.
    Order matters — the fixtures are validated first because the dependency
    endpoints and the division rule keys both resolve against them.

    Args:
        req: a `scheduler_pb2.SolveBuildRequest`. Untyped in the signature so
            this module's *callers* need the proto import and its *consumers*
            do not — the boundary runs through here in one direction only.

    Raises:
        InvalidRequestError: on an empty board, on any degenerate scalar
            enumerated in the module docstring, or on any id that resolves to
            nothing.
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
    if not req.HasField("constraints"):
        raise InvalidRequestError(
            "the BuildConstraints message must be set. It is a proto3 message field, so an omitted "
            "one arrives fully default-valued and every constraint family it carries disappears at "
            "once."
        )

    courts = list(req.courts)
    known_courts = set(courts)

    fixtures = _validated_fixtures(req.fixtures)
    fixture_ids = {fixture_id for fixture_id, _entrants, _division in fixtures}
    declared_divisions = {division for _fid, _entrants, division in fixtures}

    grid_slots = _validated_grid_slots(req.grid.slots, known_courts)
    existing = _validated_existing(req.existing, known_courts)
    dependencies = _validated_dependencies(req.dependencies, fixture_ids)
    constraints = _validated_constraints(req.constraints, declared_divisions)

    if req.wall_seconds <= 0:
        raise InvalidRequestError(
            f"wall_seconds must be > 0, got {req.wall_seconds!r}. A 0 budget stops the tier chain "
            "before T0 runs and returns UNKNOWN with no assignments — the same answer an impossible "
            "board gives, so an unset field would read as a solver verdict about the request."
        )

    return ModelInput(
        courts=courts,
        fixtures=fixtures,
        grid_slots=grid_slots,
        step_minutes=req.grid.step_minutes,
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
