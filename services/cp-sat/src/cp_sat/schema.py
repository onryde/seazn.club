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
seven field guards, in dependency order: courts first, then fixtures (they
declare the fixture ids and the divisions), then the grid, the pinned rows,
the dependencies and the division rules against them. The domain's tolerance is
NOT changed — `model.py`'s `id_to_idx.get(...) or continue` and its
`if existing_court in court_lists` are what let the bench feed it partial
boards, and moving the check there would break that. The wire is where the
mistake is made, so the wire is where it is caught.

The rule the pass enforces, stated once: **an id names exactly one thing, that
thing is declared by the same request, and it is declared COMPLETELY.** Four
members of that family were found only after the first version of this pass
shipped, all by review, in two rounds:

  * an `existing` row could reuse a movable fixture's id, which does not pin
    that fixture — the row lays a blocking interval and the fixture is placed
    a SECOND time, elsewhere.
  * `courts` accepted `""`, and then `" "`. Rejected because a court nobody
    can name cannot be rendered and an assignment on it maps back to nothing.
    **Read the next bullet before assuming this is what stops phantom
    placements — it is not.**
  * a court can be DECLARED WITHOUT SLOTS, and is then placed on. This is the
    real mechanism, and no malformed name is needed for it: `courts` is what
    the model builds per-court interval lists from, while `admissible_starts`
    is the union of every slot's start across ALL courts. Round 2 guarded the
    member it had measured benign (duplicate courts) and left this one, which
    it had not measured at all, open.
  * and the same defect one step in from its extreme: courts offering
    DIFFERENT tick sets. A fixture lands on a court at a tick that court does
    not offer. Owned by `_validate_court_grids`, which requires every court to
    offer identical starts — that closes the whole family, slotless included.

The lesson each time was the same, and it is worth more than the four fixes:
**a guard's docstring must name the mechanism it actually blocks.** Twice now
a correct-sounding rule has been written over a narrower guard, and the next
reader stopped checking. When editing this pass, enumerate every id-shaped
field in `SolveBuildRequest` — `courts` and `existing[].fixture_id` are
id-shaped and live outside `fixtures` — and ask of each not only "does it
resolve" but "is what it names fully specified".

Note also what is deliberately NOT rejected: a self-dependency
(`before == after`). It makes that fixture unplaceable, which shows up as a
lower `placed` count — visible, not silent. Its one invisible consequence, a
negative `makespan` on a board where nothing is placed, is fixed in
`cp_sat.model` at the term rather than here.

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
    grid_slots: list[tuple[str, int, int]]  # (court, start_at_ms, day_index)
    step_minutes: int
    constraints: dict
    existing: list[tuple[str, str, int]]  # (fixture_id, court, start_at_ms)
    dependencies: list[tuple[str, str]]  # (before_fixture_id, after_fixture_id)
    wall_seconds: float


def _require_id(value: str, where: str) -> str:
    """THE chokepoint. Every id-like string in a request passes through here.

    One policy, one place: an id must be non-blank and already CANONICAL —
    equal to its own `.strip()`. `tests/test_schema.py` enumerates the string
    fields straight out of the descriptor and asserts that each one either
    reaches this function or is on a named exemption list, so a field added to
    `scheduler.proto` cannot quietly skip it.

    **Rejected, never normalised**, and that is the load-bearing choice.
    Stripping on the way in looks friendlier and introduces a new silent
    failure in place of the old one: `Assignment.fixture_id` round-trips, so a
    caller that sent `"f1 "` would get `"f1"` back in `assignments` and fail to
    match it against its own records. Refusing tells the caller which field is
    wrong while its data is still in front of it.

    Why whitespace at all — measured, each against its own control, all
    OPTIMAL with `error` unset:

        courts=["C0","C0 "]   two courts to a dict, one court in the world:
                              2 fixtures placed at ONE instant on ONE court
        division_id="d1 "     matches no rest rule and no day-cap key, so both
                              families evaporate for that fixture
        entrant "e1 "         joins a different participant group, so the rest
                              window between two of one player's matches is
                              never stated

    Each is the pass's own rule failing on its own terms: *an id names exactly
    one thing.* `"C0"` and `"C0 "` are one thing to a human and two to a dict
    key, which is precisely what that rule exists to forbid.
    """
    if not value.strip():
        raise InvalidRequestError(
            f"{where} must not be blank, got {value!r}. An id nobody can name resolves to nothing "
            "and cannot be mapped back to anything the caller holds."
        )
    if value != value.strip():
        raise InvalidRequestError(
            f"{where} has leading or trailing whitespace, got {value!r}. Ids are compared as dict "
            "keys, so {stripped!r} and {value!r} are two different things to this service and one "
            "thing to everybody else — the constraint keyed on the other spelling silently does "
            "not apply. Send the id exactly as it is stored; it is not normalised here, because "
            "`Assignment.fixture_id` travels back in the response and a silently altered id would "
            "not match the caller's own records.".format(stripped=value.strip(), value=value)
        )
    return value


def _validated_fixtures(proto_fixtures) -> list[tuple[str, list[str], str]]:
    """The movable fixtures, with every id they carry checked for substance.

    Runs first because everything after it resolves against what it returns:
    the dependency endpoints must name one of these fixtures and the division
    rules must name one of these divisions.
    """
    fixtures: list[tuple[str, list[str], str]] = []
    seen: set[str] = set()
    for i, f in enumerate(proto_fixtures):
        _require_id(f.fixture_id, f"fixtures[{i}].fixture_id")
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
        for j, entrant in enumerate(f.entrant_ids):
            # A blank entrant collides every such fixture into ONE participant
            # group; a mis-spaced one lands in a group of its own, so the rest
            # window between two of one player's matches is never stated.
            _require_id(entrant, f"fixtures[{i}].entrant_ids[{j}]")
        if len(set(f.entrant_ids)) != len(f.entrant_ids):
            # Not cosmetic: a repeated entrant puts this fixture's index in its
            # own `by_entrant` group TWICE, and the per-entrant AddNoOverlap
            # then requires its rest interval not to overlap ITSELF — which is
            # unsatisfiable, so `placed[i]` is forced to 0. Measured 6/6:
            # ["e1","e1"] gives OPTIMAL / placed=0 / error unset where
            # ["e1","e2"] places the fixture.
            raise InvalidRequestError(
                f"fixtures[{i}].entrant_ids repeats an entrant (fixture {f.fixture_id!r}, got "
                f"{list(f.entrant_ids)!r}). The duplicate makes the fixture overlap itself in its "
                "own participant-rest group, so it becomes silently UNPLACEABLE and the board comes "
                "back OPTIMAL without it."
            )
        # Unset OR mis-spaced matches no rest rule and no day-cap key, so both
        # families evaporate for this fixture. Measured with min_rest=240 and a
        # cap of 1: 'd1' places 1, '' places 4, 'd1 ' escapes the cap — all
        # OPTIMAL with `error` unset.
        _require_id(f.division_id, f"fixtures[{i}].division_id")
        fixtures.append((f.fixture_id, list(f.entrant_ids), f.division_id))
    return fixtures


def _validated_grid_slots(slots, known_courts: set[str]) -> list[tuple[str, int, int]]:
    for i, s in enumerate(slots):
        _require_id(s.court, f"grid.slots[{i}].court")
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
        if not s.HasField("day_index"):
            raise InvalidRequestError(
                f"grid.slots[{i}].day_index must be set. Day 0 is a legitimate value, so an unset "
                "field cannot be told from a real one by its value — and unset puts EVERY slot on "
                "day 0, collapsing the whole lattice into one day-cap bucket. Resolve each slot to "
                "the org's local calendar day; the solver never reasons about time zones."
            )
        if s.day_index < 0:
            raise InvalidRequestError(
                f"grid.slots[{i}].day_index must be >= 0, got {s.day_index!r}."
            )
    return [(s.court, s.start_at_ms, s.day_index) for s in slots]


def _validated_courts(proto_courts) -> list[str]:
    """The courts, which every other id in the request resolves against.

    NAMES only: blank and duplicate. Same argument as the `fixture_id`,
    `division_id` and `entrant_ids` guards — an assignment on a court nobody
    can name maps back to nothing, and a court named twice names one place.

    **This is not the guard that stops phantom placements.** The first version
    of this function claimed it was, on the strength of a probe that used
    `courts=["C0", ""]`; the empty string turned out to be incidental and
    slotlessness was the real mechanism. `_validate_court_grids` owns that,
    and blank-vs-slotless are now two guards with two reasons because they
    are two defects. Do not merge them back.
    """
    courts = list(proto_courts)
    seen: set[str] = set()
    for i, court in enumerate(courts):
        # `.strip()`, not falsiness: `" "` is the same unnameable court as `""`
        # and slipped the first version of this guard. Note this is about the
        # name being unusable to the CALLER — the reason a blank court gets
        # PLACED on is slotlessness, which `_validate_court_grids` owns.
        _require_id(court, f"courts[{i}]")
        if court in seen:
            raise InvalidRequestError(
                f"courts[{i}] {court!r} is a duplicate. A court names exactly one place to play."
            )
        seen.add(court)
    return courts


def _validate_court_grids(courts: list[str], grid_slots: list[tuple[str, int, int]]) -> None:
    """Every court must offer the SAME start times, and at least one.

    This is the guard that actually stops a fixture being placed on a court at
    a time that court does not offer. `courts` is what the model builds its
    per-court interval lists from, while `admissible_starts` is the union of
    every slot's start across ALL courts — so a court inherits the whole
    lattice no matter what the grid says about it.

    Measured 6/6, two fixtures, and note that NEITHER case needs a malformed
    court name:

        courts ["C0","C1"], slots {C0@T}          -> 2 placed, one on C1
        courts ["C0"],      slots {C0@T}          -> 1 placed   (the control)
        C0 {T, T+40}, C1 {T+40}                   -> a fixture on **C1 at T**

    The last one is why this is stated as "identical tick sets" rather than
    "no slotless courts". A slotless court is only the extreme point of one
    continuous family; the interior is just as reachable and just as silent,
    and it comes from the same real feature (`Blackout.court?` lets a caller
    black out part or all of one court's day).

    So NOTHING in this family is unclosable at the boundary, which is the
    opposite of what `model.py` said before this change. The cost is that
    per-court blackouts are now REFUSED rather than mis-scheduled: a caller
    that needs them gets `INVALID_REQUEST` and falls back to its own placer.
    That is a deliberate trade of capability for correctness, and it is one
    line to revert. Supporting them properly is a MODEL change, not a boundary
    one — an enforced per-court start domain,
    `AddLinearExpressionInDomain(start[i], Domain.FromValues(starts_of(c)))
    .OnlyEnforceIf(presence_court[i][c])`, emitted only for courts whose tick
    set is a strict subset of the union so homogeneous boards pay nothing.
    """
    starts_by_court: dict[str, set[int]] = {court: set() for court in courts}
    for court, start_ms, _day in grid_slots:
        starts_by_court[court].add(start_ms)

    slotless = sorted(court for court, starts in starts_by_court.items() if not starts)
    if slotless:
        raise InvalidRequestError(
            f"courts {slotless} are declared but no grid slot offers them. A court with no slots is "
            "not an unused court — the model gives it a column and the solver places matches on it "
            "at ticks taken from the OTHER courts, then proves that OPTIMAL (measured: two fixtures "
            "and one slot on 'C0' place 2 with a slotless 'C1' declared, 1 without). Either give it "
            "slots or leave it out of `courts`."
        )

    distinct = {frozenset(starts) for starts in starts_by_court.values()}
    if len(distinct) > 1:
        offenders = sorted(
            court for court, starts in starts_by_court.items()
            if frozenset(starts) != frozenset(starts_by_court[courts[0]])
        )
        raise InvalidRequestError(
            f"every court must offer the same start times; {offenders} differ from {courts[0]!r}. "
            "The model unions the starts across courts, so a per-court grid is flattened and a "
            "fixture can be placed on a court at a tick that court does not offer (measured: with "
            "C0 offering {T, T+40} and C1 only {T+40}, a fixture was placed on C1 at T, OPTIMAL). "
            "A per-court blackout has to be refused here rather than silently mis-scheduled."
        )


def _validated_existing(
    rows, known_courts: set[str], movable_fixture_ids: set[str]
) -> list[tuple[str, str, int]]:
    seen: set[str] = set()
    for i, a in enumerate(rows):
        # A fixture id names exactly ONE match in a request — movable or
        # pinned, never both and never twice. An `existing` row reusing a
        # movable id does NOT pin that fixture: the row lays a fixed blocking
        # interval, the movable fixture stays free, and it is placed elsewhere,
        # so the caller receives an assignment for a fixture it just declared
        # already fixed. Measured, 5/5: `f1` pinned at T comes back placed at
        # T+40min, OPTIMAL, `error` unset.
        #
        # Rejected rather than reinterpreted as "this row pins that fixture".
        # That reading is a modelling feature — drop it from the movable set,
        # or fix its start and court — and the boundary's job is to refuse a
        # request that means two things, not to choose one of them.
        _require_id(a.fixture_id, f"existing[{i}].fixture_id")
        if a.fixture_id in movable_fixture_ids:
            raise InvalidRequestError(
                f"existing[{i}].fixture_id {a.fixture_id!r} is also a movable fixture. A pinned row "
                "does not pin the fixture that shares its id — it lays a blocking interval while "
                "the fixture stays free — so the response comes back placing it a second time, "
                "somewhere else. If it is pinned, leave it out of `fixtures`."
            )
        if a.fixture_id in seen:
            raise InvalidRequestError(
                f"existing[{i}].fixture_id {a.fixture_id!r} is pinned twice. One match cannot be in "
                "two places at once, and the model would lay both blocking intervals and report "
                "OPTIMAL around them."
            )
        seen.add(a.fixture_id)

        _require_id(a.court, f"existing[{i}].court")
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
            _require_id(fixture_id, f"dependencies[{i}].{role}_fixture_id")
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
        _require_id(rule.division_id, f"constraints.{field}[{i}].division_id")
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

    courts = _validated_courts(req.courts)
    known_courts = set(courts)

    fixtures = _validated_fixtures(req.fixtures)
    fixture_ids = {fixture_id for fixture_id, _entrants, _division in fixtures}
    declared_divisions = {division for _fid, _entrants, division in fixtures}

    grid_slots = _validated_grid_slots(req.grid.slots, known_courts)
    # After the slots, because it reads both sides: which courts are declared
    # and which the grid actually offers.
    _validate_court_grids(courts, grid_slots)
    existing = _validated_existing(req.existing, known_courts, fixture_ids)
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
