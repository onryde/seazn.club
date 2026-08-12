"""CP-SAT model for BUILD/POLISH fixture placement.

This is the benchmark-validated model from `services/placement/bench/placement_bench.py`
(`build_model`, the "REWRITE v2" interval/`NoOverlap` encoding), promoted into
the service package. The MODELING is a faithful port — same variables, same
constraint families, same presolve knobs. What changed is only the boundary:

  * inputs are plain Python mirroring `proto/scheduler.proto`'s
    `SolveBuildRequest`, not the bench's `Board` dataclass;
  * `match_minutes`, `gap_minutes`, per-division rest and per-division day cap
    come from the request instead of module constants;
  * the solve loop is wrapped in `solve()` returning a `SolveOutcome`;
  * the sweep's JSON instrumentation is gone;
  * the bench's greedy warm-start hint is NOT ported — see below.

--- round 6: identity is POSITIONAL, not string-based ------------------------

Every id-shaped string this module used to key on — `fixture_id`, `court`,
`division_id`, `entrant_id` — is gone. A fixture's identity is its position in
`fixtures`; a court's is its position in the caller's `court_names`, carried
here only as a COUNT (`num_courts`); a division's or entrant's identity is a
caller-assigned index. `placement.schema` is the ACL that enforces every index is
in range before this module ever sees it — this module's OWN tolerance of an
out-of-range dependency index (skip rather than crash) is unchanged from the
string contract's `id_to_idx.get(...) or continue`, just re-expressed as a
bounds check instead of a dict miss.

Two concrete consequences, both mechanical, neither a modelling change:

  * `presence_court`, `court_lists` and `by_entrant` are keyed on `int` now.
    `presence_court` and `court_lists` are DENSE (`num_courts` is available
    directly, so they are plain lists indexed 0..num_courts-1); `by_entrant`
    stays a dict (`dict[int, list[int]]`) because nothing here carries a
    declared entrant count to size a dense list against — only the indices
    that actually appear in `fixtures` are ever grouped, exactly as the
    string contract only ever grouped the entrant ids that appeared.
  * `FixtureVars.fixture_ids` is gone. It used to carry each fixture's own id
    string for `extract_assignments` to read back; a fixture's identity is
    now simply its position, always recoverable from `enumerate(...)`, so a
    parallel list that always equalled `range(n)` would have been dead
    weight.

--- DROPPED: the greedy warm start (`AddHint`) -------------------------------

In the bench this is a two-part mechanism, both parts in `placement_bench.py`:
`greedy_seed()` computes a first-fit placement once, and `run_full_chain()`
threads it into every tier as `build_model(..., hint=...)`, whose `if hint:`
block is what actually calls `model.add_hint` on `start[i]`, `placed[i]` and
`presence_court[i][slot.court]`. It mirrors z3's "greedy seeds the incumbent"
design, and **it is how the bench's published ~2.5 s full-chain number on the
production board was produced.**

(Cited by symbol deliberately. An earlier version of this note gave line
numbers; the Step 2b extraction moved every line in that file and the range
silently came to point at the middle of `build_model` instead — precisely the
misdirection this note exists to prevent.)

It is not ported here. It needs `board.slots` INDICES, which the service's
plain `(court, start_at_ms)` grid does not carry in the same shape, so it is a
real rewrite rather than a copy — and at T0 there is nothing to justify it
with: this model solves the production board in 80-145 ms unhinted, leaving no
headroom worth chasing. A hint cannot change correctness — CP-SAT repairs or
discards an invalid one — so nothing is at risk today.

**Note what has NOT been measured**: no hinted run of THIS model exists. The
80-145 ms figures are all unhinted. So the honest claim is "T0 is fast enough
unhinted", not "the hint makes no difference here" — the A/B was never run.

**SETTLED IN PROMPT 03: still not needed, and now for a measured reason.**
The full chain does cost far more than T0 alone — 4 940 ms against T0's 88 ms
on an idle box — and the tier that nearly sank it was T3, which sat at
FEASIBLE after 20 000 ms. A warm start would not have moved it by a
millisecond: T3 had ALREADY found the optimal board (2 400 000 ms, the
pigeonhole minimum) in well under a second and could not close its DUAL bound
from zero. Its incumbent was never the problem, and a hint supplies nothing
but an incumbent. The fix was the term's encoding (see T3 below).

The general lesson, which is why this note stays: when a tier here is slow,
read `BestObjectiveBound()` against `ObjectiveValue()` before reaching for a
warm start. If they are far apart the tier cannot PROVE what it has already
FOUND, and a hint is the wrong tool — every tier of this chain is solved to
proof, so proof time is what the budget buys. T0, T1 and T2 each reach
`bound == value` unhinted, so none of them is waiting on an incumbent either.

This module is domain logic and deliberately imports NOTHING from
`placement.generated` — no proto types cross this boundary in either direction.
`placement.schema` (Prompt 04) owns the proto->plain-Python translation.

--- THE BENCH HAS ITS OWN COPY OF THIS MODEL, AND IT HAS DRIFTED ------------

`bench/placement_bench.py` defines its own `build_model` (:378, called at :658)
and imports nothing from `placement` at all. Prompt 02 extracted the board
GENERATOR into `bench/placement_bench_boards.py` precisely so the bench and the
service could not disagree about the board — but the MODEL was left
duplicated, so they can still disagree about everything else. The bench's copy
is STILL string-keyed; round 6 only touched this module and `placement.schema`,
so `tests/` carries a small adapter that converts the bench's string-shaped
boards into this module's positional shape (see `tests/_board_positional.py`).

They already do. The `mk_hi >= mk_lo` clamp below (Task 05c) is in this copy
and not in the bench's (:542-547), so on a board where nothing is placed the
two report different makespans.

The consequence to hold on to: **a bench measurement is evidence about the
bench's model, not about this one.** Any timing or quality number quoted from
`bench/` has to be re-taken here before it can be said about the service.
Recorded rather than fixed: de-duplicating the model is Prompt 10's call, not
a side-effect of a contract-hardening task.

--- the two presolve knobs: keep them, but know what is and isn't proven -----

`symmetry_level = 0` and `cp_model_probing_level = 0` — `SolverKnobs`'s
defaults, applied by `objective._tier_solver` — are carried over from the bench
unchanged. Be precise about the evidence for them, because
the obvious experiment does NOT support the strong version of the claim:

  * The trap is real and on record — CP-SAT's default symmetry detection and
    probing presolve consuming the entire wall on a symmetric board and
    failing SILENTLY (`UNKNOWN`, zero placed, no error). But that was observed
    under the bench's **v1 boolean fixture x slot grid** encoding, on the
    larger sweep boards. It has NOT been shown to reproduce on this
    interval/`NoOverlap` model.
  * Measured here, production board, T0, identical model both ways:
        knobs set     -> OPTIMAL, 37 placed, 145 ms
        knobs default -> OPTIMAL, 37 placed, 424 ms
    So on THIS board they are a ~3x speedup, not the difference between an
    answer and no answer.

They stay because the failure they guard against is silent and catastrophic
while the cost of keeping them is nil, and because the larger boards that
originally exhibited it are exactly the ones this service is being built to
accept. But **nothing currently tests their necessity** — no test fails if you
delete them. A mutation pass over this module will therefore report them as a
surviving mutant. That is expected; it means "not covered", not "not needed".
Do not delete them on the strength of a green suite. If their necessity has to
be settled properly, the experiment is a board large enough to reproduce the
v1 observation, not this one.

--- what the wire contract cannot carry (and this model therefore cannot state)

Two constraint families the bench models are NOT expressible from
`SolveBuildRequest` as it stands. They are listed here rather than silently
omitted, because each one makes this solver's answer strictly more permissive
than z3's, and TS re-runs its own verifier on the result:

  * build-encode.ts section 5, per-fixture start windows (`notAfter`).
    `Fixture` carries (entrant_indices, division_index) only.
  * build-encode.ts section 7's PARTICIPANT-REST half — CLOSED as of task C6,
    on the `rule_groups` path only. See "A SIXTH is CLOSED as of task C6"
    below for the mechanics. A caller still sending only `rest_by_division` /
    `day_cap_by_division` (`rule_groups` empty) keeps today's behaviour: a
    pinned row blocks its own court but not a participant it shares.

A third — per-court grids — is CLOSED as of task C2, and is recorded here
because the earlier state of this note got the capability question wrong
twice and both corrections are worth keeping. `admissible_starts` is still
the union of every slot's start across all courts, but `start[i]` is no
longer free to take any value in that union regardless of which court it
lands on: section 1b now adds, for every court whose tick set is a STRICT
SUBSET of the union, `AddLinearExpressionInDomain(start[i],
Domain.FromValues(starts_of(c))).OnlyEnforceIf(presence_court[i][c])` — and
for a court no slot mentions at all, forces `presence_court[i][c] == 0`
directly rather than building the (invalid) empty-values domain. A
homogeneous board — every court sharing one tick set, the common case — hits
neither branch and pays nothing extra.

Measured before the fix: with C0 offering {T, T+40} and C1 only {T+40}, a
fixture was placed on C1 at T, OPTIMAL; with C1 declared but slotless, on C1
at any tick at all — both now INFEASIBLE if forced, and unreachable by a free
solve (`tests/test_model.py`'s per-court-grid section).

The first correction: an earlier version of this note called the gap
unclosable and said `placement.schema._validate_court_slot_coverage` REFUSED
any request whose courts disagreed, trading the capability away for safety.
The second correction is this task: that refusal is gone, not merely
relaxed — see `placement.schema`'s own docstring, "task C2: the per-court
coverage refusal is GONE, not renamed". A per-court blackout is now placed
correctly instead of bouncing the caller back to its own greedy fallback.

A fourth is also CLOSED, and is recorded because the fix shows where the seam
sits. Day-cap buckets used to be `start_ms // DAY_MS`, a UTC day, so any org
not on UTC had its caps applied against the wrong boundary — at UTC+10 a
09:00 and a 19:00 local match on one day fall in two UTC buckets and a cap of
one admits two. The contract now carries a pre-computed `Slot.day_index`: the
caller resolves each slot to the org's local calendar day and sends the
integer, and this module groups by it. Timezones-as-policy stay outside this
bounded context; the solver never reasons about a zone. Computing that index
is the caller's obligation and getting it wrong reintroduces the same bug one
layer up, which is Prompt 06's problem and needs its own test there.

A FIFTH is CLOSED as of task C4, on the `rule_groups` path only: **`existing`
rows now count against a rule group's day cap.** They used to not: `on_day`
was built for movable fixtures only, so a pinned row on a capped day did not
consume that day's allowance and the solver could add another cap's worth on
top of it — measured on a real staging board: day cap 7, six matches pinned
on one day, the solver placed seven more (thirteen total).

The correction worth recording is in the CLOSING MECHANISM, because the
earlier version of this note got that part wrong: it said closing this needed
a `division_index` added to `PinnedRow`. It did not, and the contract
deliberately did not add one. `PinnedRow.rule_group_indices` (also #21 — see
`placement.schema`'s module docstring) already says which `RuleGroup`s a pin
counts against, directly — no division needed, because `RuleGroup.
max_fixtures_per_day` already generalises past division scope (a division is
simply one group). Each pin is bucketed to the day its `start_at_ms` falls
inside — the SAME disjoint `day_bounds` ranges section 9 below already
validates — and the count is subtracted from that group's cap on that day,
CLAMPED at 0 rather than let go negative. The clamp is this module making the
identical call `apps/web/src/server/usecases/schedule.ts:798`
(`assertNoNewBlocking`) already makes: refuse only what a change introduces
or worsens, never the pre-existing state, so an already-over-cap board stays
solvable instead of returning nothing at all — a negative bound here would
make CP-SAT report the WHOLE model infeasible, because a sum of booleans can
never be less than a negative number, and pins cannot be moved to repair it.

A pin whose `start_at_ms` falls inside NO day's `[lo, hi]` counts against
nothing, deliberately (see `_day_of_pin` below) — an organiser's manual
placement is not required to land on a grid tick, and attributing it to the
nearest day would be a guess this module has no basis for.

This closure applies ONLY when `rule_groups` is non-empty. A caller still
sending just `day_cap_by_division` gets the permissive behaviour above,
unchanged (section 9's `else` branch) — the division path has no
pin-to-group attribution to draw on, and retrofitting one would need the very
`division_index` addition this note originally, and wrongly, asked for.

A SIXTH is CLOSED as of task C6, on the `rule_groups` path only: **a pinned
row now joins its entrants' participant-rest groups.** `PinnedRow.
entrant_indices` (also #21, forwarded as `pinned_entrant_indices`, parallel to
`existing` exactly like `pinned_rule_group_indices`) says who is playing in
it; a pin's own rest is the MAX of `min_rest_minutes` over the rule groups it
counts against (`pinned_rule_group_indices` — C4's field, read a second way
here), 0 if it belongs to none. That resolution has to match the verifier
side exactly — `calendar.ts`'s `effectiveRestMinutes` resolves the identical
"max over applicable rules" for the same pin — because a placer and a
verifier disagreeing about one number is the recurring defect in this
programme, not a hypothetical one.

Modelled as a second FIXED interval per pin (`ivr_existing_{k}`, sized
`dur_ms + pin's own rest`), folded into the SAME per-entrant `AddNoOverlap`
group a movable fixture's own `ivr_{i}` sits in — mirroring section 7's
court-overlap half (`ivc_existing_{k}`) exactly, just against a different
grouping. Two pins alone can now share a group with no movable fixture
present at all: the defect this closes was measured on exactly that shape —
two pinned rows, thirty minutes apart, sharing an entrant, thirty minutes'
rest owed, reported OPTIMAL where z3 proved INFEASIBLE, because `by_entrant`
was built by walking `fixtures` (the movable rows) alone and a pin
contributed nothing to it.

Asymmetric interval widths between the two sides of one `AddNoOverlap` group
are expected: a pin's own resolved rest and a movable fixture's own
`rest_by_division` figure are independent numbers — the same asymmetry the
model already accepts between two movable fixtures in different divisions.

Be precise about what that actually enforces, because the obvious reading is
wrong and this file is where placer/verifier forks get re-derived.
`AddNoOverlap` over two differently-sized intervals does NOT enforce the
stricter of the pair in both directions — it enforces the EARLIER interval's
OWN width. MEASURED 2026-08-11, not reasoned: two fixed-size intervals of 10
and 100, the short one pinned to t=0, minimising the long one's start, gives
10 — not 100.

The consequence is a real one-directional gap against the verifier, which
resolves a pin/movable pair as ONE number for the pair:
`validateAssignments` only ever evaluates a movable-vs-immovable pair in the
order `pairRestMinutes(config, movable, immovable)` (`calendar.ts`'s own note
above `pairRestMinutes`), and that number maxes in any typed rule covering
EITHER side. So a movable owing 0 placed immediately BEFORE a pin owing 30 is
accepted here and rejected there — `calendar.ts:1150`'s "under-constrains …
the verifier then rejects" case. It is the same class of gap the model
already carries between two movable fixtures in different divisions
(the verifier takes `max` of both directions there; the placer does not), so
C6 widens an existing gap rather than opening a new one — but it is a gap,
not the safety this paragraph originally claimed, and closing it needs a
per-PAIR bound the one-interval-per-row encoding cannot express.

Movable-fixture rest was UNCHANGED by C6, still `rest_by_division` only at
the time — a rule group's own `min_rest_minutes` applying to its MOVABLE
fixtures (rather than only to the pins that count against it) was left as a
separate, later task, explicitly recorded here as not folding a max across
the pair the way C6 closes the pin half. That later task is CLOSED below.

A SEVENTH is CLOSED as of release 1 of retiring `division_rules`
(`SolveBuildRequest.division_rules`, proto field 10 — see that field's own
comment for the three-release retirement plan this is the first of; this
module still never reads the proto or names a field number anywhere else):
**a movable fixture's OWN rest now also folds in the rule groups that cover
it**, not `rest_by_division` alone.

Before this, a movable fixture's rest was exactly the `rest_ms` line above.
The verifier was already stricter: `calendar.ts`'s `hardRestMinutesFor`
resolves a fixture's own typed rest as the MAX `min_rest_minutes` over every
rule whose scope covers it (confirmed by reading it for this task rather
than assumed), folded into `pairRestMinutesWith` on both sides of a pair —
so the placer could ignore a typed rule the verifier would enforce, and ship
a board the verifier then rejected. Same class of defect C6 closed for a
pin's own rest, now closed for a movable fixture's, and resolved the
identical way: the MAX over every covering group's `min_rest_minutes`
(`RuleGroup.fixture_indices` containing this fixture's own position), never
a sum and never a first match, matching `hardRestMinutesFor`'s own
`Math.max` fold rule for rule. `None` (a group with no rest rule — C1's
presence tracking) contributes nothing and is skipped rather than folded in
as 0; a negative value floors at 0 — the same clamp idiom section 6 already
applies to a pin's own resolved rest.

A no-op, byte for byte, when `rule_groups` is empty: the fold is a loop over
`rule_groups`, so with none it never executes and `rest_ms` is left exactly
as the expression above computed it — no caller still on the previous
contract shape can observe any difference, structural or numeric.
`tests/test_model.py`'s `test_rule_groups_empty_leaves_the_model_byte_
identical` proves this at the `CpModel` proto level, not merely by argument.

Does NOT close the one-directional `AddNoOverlap` gap recorded above — it
NARROWS it, the same way C6 narrowed rather than closed it: more pairs now
carry the correct rest on the movable side, but the encoding still enforces
only the earlier interval's own width, so a movable fixture placed
immediately before a stricter partner can still under-constrain in one
direction. Closing that needs a per-PAIR bound the one-interval-per-row
encoding still cannot express — unchanged from C6's own note above, and out
of this task's scope for the identical reason.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

import structlog
from ortools.sat.python import cp_model

log = structlog.get_logger(__name__)

MIN_MS = 60_000
DAY_MS = 86_400_000

# Tier names are fixed protocol constants shared with the TS side (see the
# design spec, "Tier/objective semantics are a fixed protocol constant") and
# they live in `placement.objective`, with the chain that uses them — all four in
# one place, since the ORDER is as much of the constant as the names are.

@dataclass(frozen=True)
class SolverKnobs:
    """The CP-SAT search settings one solve runs under.

    A VALUE, passed in — not three module constants read from the environment.
    Both halves of that sentence are load-bearing, and each was learned the
    expensive way.

    --- passed in, because the domain may not read the environment ------------

    `_RULES.md` §2.1 forbids environment reads in `model.py` and
    `objective.py`: dependencies point inward, and reading the process
    environment is infrastructure reaching into the domain. These three lived
    here as module constants resolved at import from 2026-08-10 until this
    commit, recorded openly as a deviation (§7) rather than pretended away.
    `config.py` now does the reading and `main.py` hands the result down, so
    §2.1's grep — which is a literal search, and would match this paragraph if
    it named the function — passes, and the knobs stay settable without a code
    deploy.

    Defaults live HERE and nowhere else. `Settings` carries `None` for "not
    overridden" rather than repeating 8/0/0, so the shipped default cannot
    drift away from the documented one — there is only one copy to change.

    --- settable at all, because a knob that does nothing is worse than none ---

    THE PRODUCTION INCIDENT, 2026-08-10. `NUM_SEARCH_WORKERS` was set in
    `fly.toml`'s `[env]` and had NO EFFECT: it was a hardcoded constant and
    `config.py` read only PLACEMENT_SERVICE_SECRET / _MAX_WORKERS /
    _WALL_SECONDS_MAX / _PORT. Four production runs — wall 10s -> 30s, machine
    shared-cpu-2x -> performance-8x/16gb — returned a BYTE-IDENTICAL board
    every time at `tiers_completed: 1/4`, while the one variable everybody
    believed was being tuned never moved off 8. A knob that silently does
    nothing makes an experiment look conclusive when it never ran.

    --- what each one is for -------------------------------------------------

    `num_search_workers`: CP-SAT's own default is the machine's core count;
    pinning it keeps solve behaviour reproducible across the dev box and the
    deploy box. Owed a re-measurement on the real 2-vCPU target.

    `symmetry_level` / `cp_model_probing_level`: both pinned to 0 to stop
    presolve eating the entire wall on a symmetric board — a failure that
    returns UNKNOWN with nothing placed and says nothing. That tradeoff was
    measured on the BENCH board ("~3x slower without them"), not on a real one,
    and the production board that motivated the override is maximally
    symmetric: three interchangeable courts, uniform 30-minute matches, the
    same slots repeating daily. If raising `symmetry_level` makes a run return
    UNKNOWN with `placed` collapsing, that is the failure the 0 guards against
    — and it is loud in the response, not silent.

    --- one value per PROCESS, not per request -------------------------------

    `main.py` builds this once at startup from `Settings` and reuses it. These
    are process-level search settings; resolving them per request would let two
    solves on one machine behave differently for no reason anybody could see
    from outside.
    """

    num_search_workers: int = 8
    symmetry_level: int = 0
    cp_model_probing_level: int = 0

    def with_overrides(self, **overrides: int | None) -> "SolverKnobs":
        """A copy with each non-`None` override applied.

        `None` means "the environment did not set this", which is not the same
        as "set it to zero" — 0 is a meaningful value for both presolve knobs.
        Built on `dataclasses.replace`, so a misspelled field name raises
        rather than being silently ignored.
        """
        return replace(self, **{name: value for name, value in overrides.items() if value is not None})


#: The shipped defaults, and the single source of them.
DEFAULT_SOLVER_KNOBS = SolverKnobs()


@dataclass(frozen=True)
class SolveOutcome:
    """What one solve produced. `status` is CP-SAT's own status vocabulary
    (`OPTIMAL`/`FEASIBLE`/`INFEASIBLE`/`UNKNOWN`/`MODEL_INVALID`), passed
    through verbatim — `placement.main` maps it onto the proto enum."""

    assignments: list[tuple[int, int, int]]  # (fixture_index, court_index, start_at_ms)
    status: str
    tiers_completed: int
    objective_values: list[tuple[str, int]]  # (tier_name, achieved value)
    elapsed_ms: int


@dataclass
class FixtureVars:
    """The decision variables and objective terms a tier solve needs to read
    back. Rides on the model itself (`model.fixture_vars`) so `solve()` — and
    Prompt 03's `run_tier_chain(model, fixture_vars, wall_seconds)` — can
    recover them from the single model argument the interface passes around.

    No `fixture_ids` field: a fixture's identity is its position, always
    `range(len(placed))`, so a parallel list carrying it would only ever
    equal that range — see the module docstring's round-6 note.
    """

    placed: list[Any]
    start: list[Any]
    presence_court: list[list[Any]]  # presence_court[fixture_i][court_index]
    placed_sum: Any
    makespan: Any
    worst_gap: Any
    imbalance: Any


class ScheduleModel(cp_model.CpModel):
    """A `CpModel` that carries its own decision variables.

    Subclassed rather than wrapped so the model stays a real `cp_model.CpModel`
    for every OR-Tools call site (`CpSolver.Solve`, `Add*`, `Maximize`), which
    is what `build_model`'s declared return type promises.
    """

    fixture_vars: FixtureVars


def _day_of_pin(start_ms: int, day_bounds: dict[int, tuple[int, int]]) -> int | None:
    """Which day a PIN's start falls on, for the day-cap fold in section 9 —
    or `None` if it falls on none.

    `day_bounds` maps a day index to the `[lo, hi]` range of that day's
    ADMISSIBLE STARTS — ticks the grid actually offers. A pin's start is an
    organiser's MANUAL placement, not a grid tick, so nothing requires it to
    land inside any admissible range at all: a pin between the last match of
    one day and the next day's later start is a legitimate board, not a
    defect. That is a DELIBERATE non-membership — the pin counts against no
    rule group's cap on any day, exactly as if it did not exist for capping
    purposes — never a fallthrough to day 0 or to the nearest day by
    guesswork. The day-partition check above (`:591-601` at the time this was
    written) guarantees the bounds are pairwise disjoint, so at most one day
    can ever claim a given start: "which day" is unambiguous whenever it
    exists at all.
    """
    for day_index, (lo, hi) in day_bounds.items():
        if lo <= start_ms <= hi:
            return day_index
    return None


def build_model(
    fixtures: list[tuple[list[int], int]],
    num_courts: int,
    grid_slots: list[tuple[int, int, int]],
    step_minutes: int,
    constraints: dict,
    existing: list[tuple[int, int]],
    dependencies: list[tuple[int, int]],
    rule_groups: list[tuple[list[int], int | None, int | None]] | None = None,
    pinned_rule_group_indices: list[list[int]] | None = None,
    pinned_entrant_indices: list[list[int]] | None = None,
) -> cp_model.CpModel:
    """Build the full constraint model. No objective is set — `solve()` owns
    that, so the tier chain (Prompt 03) can drive one model through several
    objectives without rebuilding the constraints each time.

    Args:
        fixtures: (entrant_indices, division_index) per movable fixture. A
            fixture's identity is its POSITION in this list.
        num_courts: how many courts a fixture may be placed on. A court's
            identity is its position in `range(num_courts)`; this module never
            sees a court name.
        grid_slots: (court_index, start_at_ms, day_index) legal lattice
            points, treated as an opaque legal-start set — no calendar or
            timezone math happens here. `day_index` is the CALLER's calendar
            day for that slot, resolved in the org's own zone; it is the only
            thing the day cap groups by. Slots sharing a `start_at_ms` must
            agree on it, and each day's ticks must occupy a stretch of the
            timeline no other day's fall inside.
        step_minutes: the lattice's tick size. Accepted because it is part of
            the contract but unread here — see the module docstring. Nothing
            reads it: `grid_slots` already enumerates every admissible tick.
        constraints: `match_minutes`, `gap_minutes`, `rest_by_division`,
            `day_cap_by_division` — the latter two now `dict[int, int]`,
            keyed by `division_index` rather than by division id string.
        existing: (court_index, start_at_ms) immovable rows. No fixture
            identity at all — round 6 confirmed by tracing every read that
            the old `fixture_id` on a pinned row reached nothing but a debug
            variable-name label.
        dependencies: (before_index, after_index) — fixture POSITIONS, not
            ids. `after` may not start until `before` has finished and rested.
        rule_groups: (fixture_indices, min_rest_minutes, max_fixtures_per_day)
            per rule group — C1/C4 of the #21 contract revision (see
            `placement.schema`'s module docstring). `fixture_indices` are the
            group's own MOVABLE fixture positions. `min_rest_minutes` is read
            TWICE: here, folded into a movable fixture's own rest as the MAX
            over every covering group (module docstring, "A SEVENTH is
            CLOSED"), and again below via `pinned_rule_group_indices`, for a
            PIN's own rest (C6) — both resolve the same way, 0 if no covering
            group carries a rest rule. `max_fixtures_per_day`, when set, caps
            this group's placements on each day exactly as
            `day_cap_by_division` used to cap a whole division — section 9
            below PREFERS this over `day_cap_by_division` whenever it is
            non-empty, and falls back to the division cap unchanged otherwise,
            so a caller still on the previous contract shape is unaffected.
        pinned_rule_group_indices: parallel to `existing` (same length, same
            order) — `pinned_rule_group_indices[k]` is which rule groups
            `existing[k]` counts against. See `_day_of_pin` for how a pin's
            day is determined.
        pinned_entrant_indices: parallel to `existing` the same way —
            `pinned_entrant_indices[k]` is who is playing in `existing[k]`.
            Section 6 folds each pin into its entrants' participant-rest
            groups, resolving that pin's own rest as the max
            `min_rest_minutes` over the rule groups it counts against
            (`pinned_rule_group_indices[k]`), 0 if none. Read only when
            `rule_groups` is non-empty — see the module docstring, "A SIXTH
            is CLOSED as of task C6".
    """
    del step_minutes  # see the docstring: contractual, not load-bearing.
    rule_groups = rule_groups or []
    pinned_rule_group_indices = pinned_rule_group_indices or []
    pinned_entrant_indices = pinned_entrant_indices or []

    rest_by_division: dict[int, int] = constraints.get("rest_by_division") or {}
    day_cap_by_division: dict[int, int] = constraints.get("day_cap_by_division") or {}

    # --- degenerate values that would otherwise produce a confidently WRONG
    # --- board reported as OPTIMAL. See "proto3 scalars are non-optional".
    match_minutes = int(constraints.get("match_minutes", 0))
    if match_minutes <= 0:
        raise ValueError(
            f"match_minutes must be > 0, got {match_minutes!r}. A zero-length match makes "
            "every court and rest interval zero-width, so NoOverlap constrains nothing and "
            "the solver returns OPTIMAL with every fixture stacked on one tick."
        )
    for division, cap in day_cap_by_division.items():
        if int(cap) <= 0:
            raise ValueError(
                f"max_fixtures_per_day for division_index {division!r} must be > 0, got {cap!r}. "
                "A cap of 0 forbids placing that division at all, and the solver reports "
                "OPTIMAL having silently dropped every one of its fixtures. To leave a "
                "division uncapped, omit it from day_cap_by_division rather than passing 0."
            )
    # `gap_minutes` and rest of 0 are both LEGITIMATE (no turnaround required,
    # no minimum rest), which is why neither is guarded as `<= 0` the way
    # `match_minutes` is. Negative is the degenerate case, and it is worse than
    # zero: it does not merely fail to constrain, it CANCELS the match length
    # out of the interval width and reopens a family that was closed.
    gap_minutes = int(constraints.get("gap_minutes", 0))
    if gap_minutes < 0:
        raise ValueError(
            f"gap_minutes must be >= 0, got {gap_minutes!r}. The court interval is "
            "match_minutes + gap_minutes wide, so a negative gap shrinks it — at "
            "gap_minutes == -match_minutes the width is 0, NoOverlap over zero-width "
            "intervals constrains nothing, and the solver returns OPTIMAL with two matches "
            "physically overlapping on one court (measured: 37 placed, 4 tiers, 1 overlap)."
        )
    for division, rest in rest_by_division.items():
        if int(rest) < 0:
            raise ValueError(
                f"min_rest_minutes for division_index {division!r} must be >= 0, got {rest!r}. The "
                "participant-rest interval is match_minutes + rest wide, so a negative rest "
                "shrinks it — at rest == -match_minutes the width is 0 and the solver returns "
                "OPTIMAL with one entrant in two simultaneous matches (measured: 37 placed, "
                "4 tiers, 1 collision). Rest of 0 is legitimate and is deliberately allowed."
            )
    if not grid_slots:
        raise ValueError(
            "grid_slots must be non-empty. With no admissible ticks the start domain falls "
            "back to [0] and the day-bucket list to [0], so fixtures are placed at "
            "start_at_ms=0 — a grid that offers zero legal slots yields a board, reported "
            "OPTIMAL (measured: 2 fixtures placed at epoch 0). `placement.schema` rejects an "
            "empty slot list at the wire too; this is the domain refusing to be constructed "
            "invalid, which is defence in depth rather than duplication."
        )

    model = ScheduleModel()
    n = len(fixtures)
    dur_ms = match_minutes * MIN_MS
    gap_ms = gap_minutes * MIN_MS

    divisions = [division_index for _entrants, division_index in fixtures]
    # Per-fixture rest, resolved off the fixture's OWN division. The bench had
    # one `hard_rest_min` for the whole board; this is that generalised, and
    # reduces to it exactly when every division shares a value.
    rest_ms = [int(rest_by_division.get(division, 0)) * MIN_MS for division in divisions]
    # Release 1 of retiring `division_rules` (module docstring, "A SEVENTH is
    # CLOSED") -- a movable fixture's OWN rest additionally folds in the rule
    # groups that cover it: the MAX of the line above and the largest
    # `min_rest_minutes` over every group whose `fixture_indices` contains
    # this fixture's own position. Matches `calendar.ts`'s `hardRestMinutesFor`
    # fold, rule for rule (confirmed by reading it for this task, not
    # assumed) -- a placer and a verifier disagreeing about one fixture's own
    # rest is the recurring defect this programme keeps producing, so this
    # must not invent a second resolution.
    #
    # A no-op, byte for byte, when `rule_groups` is empty: the loop below
    # never executes, so `rest_ms` is left exactly as the line above computed
    # it -- no caller still on the previous contract shape can observe any
    # difference, structural or numeric
    # (`test_rule_groups_empty_leaves_the_model_byte_identical`).
    #
    # `None` (this group carries no rest rule at all -- C1's presence-tracked,
    # distinct from a deliberate 0) contributes nothing and is skipped rather
    # than folded in as 0 -- `max(0, None)` raises, so the skip is load-
    # bearing, not merely tidy. A negative value floors at 0 -- the identical
    # clamp idiom section 6 already uses for a pin's own resolved rest,
    # defence for a direct domain caller bypassing `placement.schema`'s own
    # >= 0 guard on this field.
    for fixture_indices, min_rest_minutes, _cap in rule_groups:
        if min_rest_minutes is None:
            continue
        minutes = max(0, min_rest_minutes)
        for i in fixture_indices:
            if 0 <= i < n:
                # MAX, not assignment. A plain `=` here let a group's SMALLER
                # rest silently overwrite the division's larger one, which
                # relaxes a hard rule the verifier still enforces -- the exact
                # placer/verifier fork this release exists to close, reproduced
                # inside the fix for it.
                rest_ms[i] = max(rest_ms[i], minutes * MIN_MS)

    admissible_starts = sorted({start_ms for _court, start_ms, _day in grid_slots})
    full_domain = cp_model.Domain.FromValues(admissible_starts or [0])

    # One IntVar per fixture (its actual chosen start, domain-restricted to
    # admissible ticks) instead of a Bool per (fixture, slot).
    placed = [model.NewBoolVar(f"p_{i}") for i in range(n)]
    start: list[Any] = []
    presence_court: list[list[Any]] = []
    for i in range(n):
        start.append(model.NewIntVarFromDomain(full_domain, f"start_{i}"))
        pcs = [model.NewBoolVar(f"onc_{i}_{c}") for c in range(num_courts)]
        presence_court.append(pcs)
        # section 1: at most one court, and `placed[i]` tracks it exactly.
        model.Add(sum(pcs) == placed[i])

    # section 1b (task C2 — closes the per-court grid gap the module
    # docstring recorded): `start[i]`'s domain above is `full_domain`, the
    # UNION of every court's own admissible starts, so nothing yet stops a
    # fixture presence on court c from landing on a tick c does not actually
    # offer. Restrict each fixture's start to court c's OWN tick set whenever
    # it is placed there — emitted only for a court whose set is a STRICT
    # SUBSET of the union (a subset of EQUAL size to the union must equal it,
    # since every court's tick set is by construction a subset of the union),
    # so a homogeneous board — every court sharing the identical tick set,
    # the common case — pays nothing extra at all.
    #
    # A court that no slot mentions is the degenerate end of the same
    # spectrum: `placement.schema` no longer refuses a declared-but-slotless
    # court (a court blacked out for the whole horizon is a legitimate thing
    # to configure), so this module is the only place left to keep a fixture
    # off it. `Domain.FromValues([])` is deliberately NOT used to say
    # "never" — fixing the boolean directly is the unambiguous statement of
    # the same fact and does not lean on empty-domain propagation behaviour.
    starts_by_court: dict[int, set[int]] = {}
    for court_index, start_ms, _day in grid_slots:
        starts_by_court.setdefault(court_index, set()).add(start_ms)
    for c in range(num_courts):
        court_starts = starts_by_court.get(c, set())
        if not court_starts:
            for i in range(n):
                model.Add(presence_court[i][c] == 0)
        elif len(court_starts) < len(admissible_starts):
            court_domain = cp_model.Domain.FromValues(sorted(court_starts))
            for i in range(n):
                model.AddLinearExpressionInDomain(start[i], court_domain).OnlyEnforceIf(
                    presence_court[i][c]
                )

    # sections 2+3 fused: one optional interval per (fixture, court), sized
    # matchMinutes+gapMinutes, all sharing that fixture's single `start[i]`.
    # AddNoOverlap per court is a strict superset of exact-slot exclusivity
    # (section 2) at this width, so section 2 needs no separate statement.
    width_court = dur_ms + gap_ms
    court_lists: list[list[Any]] = [[] for _ in range(num_courts)]
    for i in range(n):
        for c in range(num_courts):
            court_lists[c].append(
                model.NewOptionalFixedSizeIntervalVar(
                    start[i], width_court, presence_court[i][c], f"ivc_{i}_{c}"
                )
            )

    # section 7 (court-gap half): existing rows are plain fixed intervals,
    # same width, folded into their own court's list — one-directional by
    # construction (a fixed interval cannot move to accommodate a movable
    # one; only the movable side is ever constrained by NoOverlap here).
    # `k` (the row's own position) labels the interval var; existing rows
    # carry no identity of their own to label it with (round 6).
    for k, (existing_court, existing_start) in enumerate(existing):
        if 0 <= existing_court < num_courts:
            court_lists[existing_court].append(
                model.NewFixedSizeIntervalVar(existing_start, width_court, f"ivc_existing_{k}")
            )

    for lst in court_lists:
        if len(lst) >= 2:
            model.AddNoOverlap(lst)

    # section 6: participant rest window, entrant-keyed groups. One optional
    # interval per fixture, sized matchMinutes+its division's rest, presence =
    # placed[i]; AddNoOverlap per entrant group (cross-court).
    by_entrant: dict[int, list[int]] = {}
    for i, (entrant_indices, _division) in enumerate(fixtures):
        for entrant in entrant_indices:
            by_entrant.setdefault(entrant, []).append(i)

    interval_rest = [
        model.NewOptionalFixedSizeIntervalVar(start[i], dur_ms + rest_ms[i], placed[i], f"ivr_{i}")
        for i in range(n)
    ]

    # C6 (task #21) — a pin joins the SAME entrant-keyed rest groups, via
    # `pinned_entrant_indices`. Gated on `rule_groups` being non-empty, the
    # same fallback section 9's day cap uses: a pin's own rest has no OTHER
    # source (unlike a movable fixture, `existing` carries no `division_index`
    # to resolve `rest_by_division` against), so with no rule_groups there is
    # nothing to resolve it from and this is a no-op — a caller still on the
    # previous contract shape keeps its previous behaviour exactly (module
    # docstring, "A SIXTH is CLOSED as of task C6"). One FIXED interval per
    # pin, mirroring section 7's court-overlap half (`ivc_existing_{k}`)
    # exactly, just against a different grouping, because a pin has no
    # presence literal — it is on the board unconditionally.
    pinned_rest_by_entrant: dict[int, list[Any]] = {}
    if rule_groups:
        for k, (_existing_court, existing_start) in enumerate(existing):
            entrant_indices = pinned_entrant_indices[k] if k < len(pinned_entrant_indices) else []
            if not entrant_indices:
                continue
            group_indices = pinned_rule_group_indices[k] if k < len(pinned_rule_group_indices) else []
            # MAX over the groups this pin counts against, 0 if none — the
            # same resolution `calendar.ts`'s `effectiveRestMinutes` applies
            # on the verifier side (module docstring); the placer must not
            # resolve it differently. Floored at 0 with the same clamp idiom
            # section 9 uses for a negative `cap - pinned`: a value this
            # negative can only reach here through a direct domain caller,
            # never through `placement.schema`, which already rejects it.
            pin_rest_minutes = max(
                0,
                max(
                    (rule_groups[g][1] or 0 for g in group_indices if 0 <= g < len(rule_groups)),
                    default=0,
                ),
            )
            interval = model.NewFixedSizeIntervalVar(
                existing_start, dur_ms + pin_rest_minutes * MIN_MS, f"ivr_existing_{k}"
            )
            # Deduplicated: `placement.schema` guards a repeated entrant WITHIN
            # one movable fixture (it would overlap itself, unsatisfiably) but
            # has no equivalent guard for a pin's `entrant_indices` — so this
            # module closes it the same way, rather than relying on the wire.
            for entrant in dict.fromkeys(entrant_indices):
                pinned_rest_by_entrant.setdefault(entrant, []).append(interval)

    # Union of both sides: an entrant two PINS share (no movable fixture at
    # all) must still get a group — that shape is the C6 defect itself,
    # measured as two pinned rows, thirty minutes apart, thirty minutes' rest
    # owed, reported OPTIMAL where z3 proved INFEASIBLE. `sorted()` keeps
    # constraint-construction order reproducible across runs (`set`'s own
    # order is already stable for small ints, but this matches the file's
    # existing `sorted(day_bounds)` convention rather than leaning on that).
    for entrant in sorted(set(by_entrant) | set(pinned_rest_by_entrant)):
        group = [interval_rest[i] for i in by_entrant.get(entrant, [])] + pinned_rest_by_entrant.get(
            entrant, []
        )
        if len(group) >= 2:
            model.AddNoOverlap(group)

    # section 8: order dependencies. The dependent may not START until the
    # feeder's END plus the DEPENDENT's own rest (resolved off the dependent's
    # own row, placement-free) — same rule the bench states, with the pair
    # given in the proto's (before, after) order rather than the bench's
    # (dependent, feeder).
    #
    # DIRECT indexing now — no `id_to_idx` lookup. `before_idx`/`after_idx`
    # are already fixture POSITIONS; `placement.schema` guarantees them in range
    # for a real request. The bounds check below is the same tolerance the
    # string contract had (`id_to_idx.get(...) or continue`), preserved for
    # a direct domain caller (bench, tests) that hands this a partial board.
    for before_idx, after_idx in dependencies:
        if not (0 <= before_idx < n and 0 <= after_idx < n):
            continue
        model.Add(start[after_idx] >= start[before_idx] + dur_ms + rest_ms[after_idx]).OnlyEnforceIf(
            [placed[after_idx], placed[before_idx]]
        )

    # section 9: max fixtures per day, per division.
    #
    # Day membership comes from the CALLER's `day_index`, not from
    # `start_ms // DAY_MS`. That quotient is a UTC day, and production day caps
    # are governed by the org's own timezone: for an org at UTC+10 a 09:00 and
    # a 19:00 local match on one day land in two different UTC buckets, so a
    # cap of one per day admits two, silently, reported OPTIMAL. Sending a
    # timezone instead would put timezones-as-policy inside this bounded
    # context, which the design rules out — the caller already knows the zone,
    # resolves each slot to its local calendar day, and sends the integer. This
    # module never reasons about time zones at all.
    day_of_start: dict[int, int] = {}
    for _court, start_ms, day_index in grid_slots:
        previous = day_of_start.setdefault(start_ms, day_index)
        if previous != day_index:
            raise ValueError(
                f"grid slots disagree about which day start_at_ms={start_ms} belongs to: "
                f"day_index {previous} and {day_index}. One instant is on one day; two courts "
                "offering the same tick must label it identically."
            )

    day_bounds: dict[int, tuple[int, int]] = {}
    for start_ms, day_index in day_of_start.items():
        lo, hi = day_bounds.get(day_index, (start_ms, start_ms))
        day_bounds[day_index] = (min(lo, start_ms), max(hi, start_ms))

    # Days must occupy DISJOINT stretches of the timeline, because membership
    # below is a range-reified indicator — two linear constraints per
    # (fixture, day) rather than a per-day value domain, which on the
    # production board is 1 924 constraints instead of 962 domains of 64
    # singletons each. The range form is exact only while no other day's ticks
    # fall inside `[lo_d, hi_d]`. A real calendar always satisfies this; a
    # caller that does not gets a refusal rather than a cap that binds on the
    # wrong fixtures.
    ordered_days = sorted(day_bounds.items(), key=lambda item: item[1][0])
    for (prev_day, (_prev_lo, prev_hi)), (next_day, (next_lo, _next_hi)) in zip(
        ordered_days, ordered_days[1:]
    ):
        if next_lo <= prev_hi:
            raise ValueError(
                f"day_index {prev_day} and {next_day} interleave on the timeline: day {prev_day} "
                f"runs to {prev_hi} and day {next_day} starts at {next_lo}. Calendar days must "
                "partition the admissible starts, or the per-day cap binds on the wrong fixtures."
            )

    # `on_day[i][d]==1 => lo_d <= start[i] <= hi_d`, plus
    # `sum_d on_day[i][d] == placed[i]`, pins down the true day
    # one-directionally: the solver cannot "cheat" by setting the wrong day's
    # bool, because turning it on binds the range constraint for real.
    day_ids = sorted(day_bounds)
    on_day: list[dict[int, Any]] = [dict() for _ in range(n)]
    for i in range(n):
        for d in day_ids:
            lo, hi = day_bounds[d]
            b = model.NewBoolVar(f"day_{i}_{d}")
            model.Add(start[i] >= lo).OnlyEnforceIf(b)
            model.Add(start[i] <= hi).OnlyEnforceIf(b)
            on_day[i][d] = b
        model.Add(sum(on_day[i].values()) == placed[i])

    if rule_groups:
        # C4 — prefer rule_groups over day_cap_by_division once the caller
        # sends both. The staged rollout has build.ts sending BOTH: the old
        # division_rules shape (so a not-yet-upgraded service still applies
        # caps) and the new rule_groups shape describing the identical caps
        # more generally (a division is one group among pools/entrants/
        # persons — module docstring, "#21"). Applying both would mean
        # capping the same fixtures under two names at once, so
        # day_cap_by_division is read only in the `else` branch below, when
        # rule_groups is empty.
        #
        # Bucket every PIN to the day its start falls on, once, before
        # walking groups — a pin's day does not depend on which group asks.
        pinned_day_by_row = [_day_of_pin(start_ms, day_bounds) for _court, start_ms in existing]
        pinned_on_day_by_group: dict[int, dict[int, int]] = {}
        for k, group_indices in enumerate(pinned_rule_group_indices):
            if k >= len(pinned_day_by_row):
                continue
            day = pinned_day_by_row[k]
            if day is None:
                continue  # off-lattice: counts against nothing (see _day_of_pin)
            for group_index in group_indices:
                by_day = pinned_on_day_by_group.setdefault(group_index, {})
                by_day[day] = by_day.get(day, 0) + 1

        for group_index, (fixture_indices, _min_rest_minutes, cap) in enumerate(rule_groups):
            if cap is None:
                continue  # this group carries no cap (e.g. rest-only)
            fx_idx = [i for i in fixture_indices if 0 <= i < n]
            pinned_by_day = pinned_on_day_by_group.get(group_index, {})
            for d in day_ids:
                lits = [on_day[i][d] for i in fx_idx]
                if lits:
                    # CLAMPED at 0, not `cap - pinned` directly — see the
                    # module docstring's "FIFTH" note (task C4) for the full
                    # reasoning: a negative bound would make the whole model
                    # INFEASIBLE over pins the solver cannot move anyway,
                    # exactly the failure `apps/web/src/server/usecases/
                    # schedule.ts:798`'s `assertNoNewBlocking` already
                    # refuses to introduce — an already-imperfect board stays
                    # solvable instead of returning nothing at all.
                    pinned = pinned_by_day.get(d, 0)
                    model.Add(sum(lits) <= max(0, int(cap) - pinned))
    else:
        # No rule_groups — a caller still on the previous contract shape.
        # Exactly today's behaviour: caps applied per division, pins not
        # counted against them at all. This is the FIFTH gap the module
        # docstring used to record as open; it is closed only on the
        # rule_groups path above, deliberately, so a caller that has not been
        # upgraded to send rule_groups keeps the same permissiveness it
        # always had rather than being silently tightened underneath it.
        for division, cap in day_cap_by_division.items():
            fx_idx = [i for i in range(n) if divisions[i] == division]
            for d in day_ids:
                lits = [on_day[i][d] for i in fx_idx]
                if lits:
                    model.Add(sum(lits) <= int(cap))

    placed_sum = sum(placed)
    # The horizon `mk_lo`/`mk_hi` (and T2's gap vars) live on. It must cover
    # PINS as well as admissible ticks, because #511's `mk_hi >= pin + dur_ms`
    # is a HARD constraint, not a reified one.
    #
    # Derived from `admissible_starts` alone this was a live infeasibility: a
    # pin is deliberately allowed to sit OFF the lattice (module docstring —
    # it counts against no day by design), and an organiser who drags a match
    # past the last admissible tick makes `pin + dur_ms > max_end`, which no
    # value of `mk_hi` can satisfy. The whole solve then returns INFEASIBLE and
    # the organiser gets NO BOARD — not a worse board, none — from a pin the
    # wire accepts as valid (`schema.py`'s `_validated_existing` ties a pin to
    # no grid bound, and should not have to).
    #
    # Confirmed both directions on one board: with the bound narrow, INFEASIBLE
    # and 0 placed; with it widened, OPTIMAL and the movable placed. Widening
    # only loosens a DOMAIN — it adds no solution that the constraints above do
    # not already permit.
    horizon_ends = [start_ms + dur_ms for start_ms in admissible_starts]
    horizon_ends += [existing_start + dur_ms for _court, existing_start in existing]
    max_end = max(horizon_ends) if horizon_ends else dur_ms

    # T1: makespan, exact native term (mk_hi - mk_lo), squeezed onto the true
    # extremes exactly as build.ts:2075-2082 does.
    mk_lo = model.NewIntVar(0, max_end, "mk_lo")
    mk_hi = model.NewIntVar(0, max_end, "mk_hi")
    for i in range(n):
        model.Add(mk_lo <= start[i]).OnlyEnforceIf(placed[i])
        model.Add(mk_hi >= start[i] + dur_ms).OnlyEnforceIf(placed[i])
    # `existing` rows are IN the span (#511). They are matches on the
    # organiser's board, at instants the organiser chose, and a span that
    # excludes them is a span of a board nobody is looking at.
    #
    # Left out until now, and it was never argued for — the docstring's list of
    # `existing` gaps is entirely about day caps. The cost was measured on a
    # real staging board: 37 fixtures Mon-Sun, day cap 7, SIX pinned on Monday
    # afternoon. With the pins outside the span the solver's own interval began
    # Tuesday, so putting anything in Monday's morning would have dragged
    # `mk_lo` back a day and a half — the objective PAID to leave a whole
    # morning empty, and the organiser could find no constraint that explained
    # it, because there was none.
    #
    # No reification and no new variables: a pinned row's start is an integer
    # known at build time, so these are plain bounds. They also strengthen the
    # `mk_hi >= mk_lo` clamp below on any board with a pin — `mk_lo` and
    # `mk_hi` can no longer both float when nothing movable is placed.
    for _court, existing_start in existing:
        model.Add(mk_lo <= existing_start)
        model.Add(mk_hi >= existing_start + dur_ms)
    # A duration cannot be negative — and without this it can be, spectacularly.
    # Both squeeze constraints above are `OnlyEnforceIf(placed[i])`, so on a
    # board where NOTHING is placed `mk_lo` and `mk_hi` float freely over
    # [0, max_end] and T1, which MINIMISES the difference, drives `mk_hi` to 0
    # and `mk_lo` to `max_end`. The chain proves that optimal and publishes it:
    # measured, one fixture made unplaceable by a self-dependency,
    # `objective_values=[('placed', 0), ('makespan', -1767258600000), ...]` —
    # a negative epoch-shaped number presented to the caller as a proved
    # optimum, on a response with `error` unset.
    #
    # Stated here rather than clamped at the wire for two reasons that are
    # about this module: the freeze `Add(makespan <= achieved)` that T2 and T3
    # inherit has to be a real bound, and `schema.py` should not need a special
    # case for a value the term should never have produced. It costs nothing on
    # a non-empty board: `mk_lo <= min start` and `mk_hi >= max start + dur_ms`
    # already force `mk_hi > mk_lo` there.
    #
    # An earlier version of this comment also claimed it kept "the bench" in
    # agreement. It does NOT, and the correction matters more than the
    # sentence: `bench/placement_bench.py` has its own `build_model` (:378, called
    # at :658) with its own unclamped `mk_lo`/`mk_hi` (:542-547) and imports
    # nothing from `placement`. See this module's docstring.
    model.Add(mk_hi >= mk_lo)
    makespan = mk_hi - mk_lo

    # T3: court imbalance — busiest configured-or-used court minus the
    # quietest, in ms, exactly `boardMetrics.courtImbalanceMinutes`.
    #
    # STATED AS AN EQUALITY, WHERE build.ts:2115-2135 STATES A SQUEEZE
    # (`cb_hi >= load`, `cb_lo <= load` for every court). The two have the same
    # optimum — minimising `cb_hi - cb_lo` drives the squeeze onto the true
    # extremes — so this is a propagation change, not a semantic one. It is
    # here because the squeeze makes T3 UNPROVABLE inside any realistic wall,
    # measured on the production board (Prompt 03):
    #
    #     squeeze        T3 FEASIBLE after 20 000 ms, best bound 0
    #     max/min on ms  T3 OPTIMAL  in       934 ms
    #     max/min on counts (this)   OPTIMAL  in  411 ms
    #
    # all three agreeing on the same value, 2 400 000 ms. The squeeze's dual
    # bound is the problem, not its search: the LP relaxation spreads 37
    # fixtures over 5 courts as 7.4 each and reports imbalance 0, and nothing
    # in the one-sided form carries the counting argument that closes it. As
    # equalities, `sum(load) == placed` propagates `max >= ceil(37/5)` and
    # `min <= floor(37/5)` immediately — which IS the pigeonhole argument, and
    # it lands on the true optimum of one match's worth of load.
    #
    # Counted in matches and scaled to ms once, rather than summing ms per
    # court: same value, measured 2x faster to prove, and the variables' domain
    # is 0..n instead of 0..n*dur_ms.
    #
    # z3 needs none of this: its tier walk only ever asks "is this metric <= B",
    # a question the squeeze answers exactly. Native optimisation is what wants
    # a dual bound. Deliberately NOT propagated back to build.ts (Prompt 06's
    # file, and the squeeze is correct there).
    court_counts = []
    for c in range(num_courts):
        count = model.NewIntVar(0, n, f"load_{c}")
        model.Add(count == sum(presence_court[i][c] for i in range(n)))
        court_counts.append(count)
    cb_lo = model.NewIntVar(0, n, "cb_lo")
    cb_hi = model.NewIntVar(0, n, "cb_hi")
    if court_counts:
        model.AddMaxEquality(cb_hi, court_counts)
        model.AddMinEquality(cb_lo, court_counts)
    else:
        model.Add(cb_hi == 0)
        model.Add(cb_lo == 0)
    imbalance = (cb_hi - cb_lo) * dur_ms

    # T2: worst idle gap — APPROXIMATE native term. Exact for any participant
    # with <=2 fixtures; a safe over-approximation for 3+ (max over ALL pairs,
    # not just consecutive ones), which errs toward a WORSE reported gap, never
    # a better one. See the bench module docstring for why z3's exact
    # bound-parameterized clause family is not ported verbatim.
    diff_vars: list[Any] = []
    for group in by_entrant.values():
        if len(group) < 2:
            continue
        for x in range(len(group)):
            for y in range(x + 1, len(group)):
                i, j = group[x], group[y]
                d = model.NewIntVar(0, max_end, f"gap_{i}_{j}")
                model.Add(d >= start[i] - start[j] - dur_ms).OnlyEnforceIf([placed[i], placed[j]])
                model.Add(d >= start[j] - start[i] - dur_ms).OnlyEnforceIf([placed[i], placed[j]])
                diff_vars.append(d)
    worst_gap = model.NewIntVar(0, max_end, "worst_gap")
    if diff_vars:
        model.AddMaxEquality(worst_gap, diff_vars)
    else:
        model.Add(worst_gap == 0)

    model.fixture_vars = FixtureVars(
        placed=placed,
        start=start,
        presence_court=presence_court,
        placed_sum=placed_sum,
        makespan=makespan,
        worst_gap=worst_gap,
        imbalance=imbalance,
    )
    log.debug(
        "model_built",
        fixtures=n,
        courts=num_courts,
        existing=len(existing),
        dependencies=len(dependencies),
        rule_groups=len(rule_groups),
    )
    return model


def solve(
    model: cp_model.CpModel,
    wall_seconds: float,
    knobs: SolverKnobs = DEFAULT_SOLVER_KNOBS,
) -> SolveOutcome:
    """Solve `model` through the full lexicographic T0->T3 tier chain within
    `wall_seconds`.

    A thin wrapper over `placement.objective.run_tier_chain`, which owns the
    objectives and the frozen bounds between them. Everything a solve needs to
    know about tiers lives there, including why a tier cut short by the clock
    is not counted and why its board is adopted anyway.

    `knobs` defaults to the shipped settings so a domain test can call this
    with two arguments. The SERVICE must pass its own, resolved from the
    environment — `test_solver_knobs.py` asserts end to end that it does,
    because a defaulted argument nobody passes is precisely how the 2026-08-10
    incident happened the first time.
    """
    # Imported HERE, not at module scope: `placement.objective` imports this
    # module for `SolveOutcome`/`FixtureVars`/`extract_assignments`, so a
    # top-level import in this direction would be a cycle. The dependency is
    # genuinely one-way — the model layer knows nothing about tiers — and this
    # single call site is the seam.
    from placement.objective import run_tier_chain

    return run_tier_chain(model, model.fixture_vars, wall_seconds, knobs=knobs)


def extract_assignments(solver: cp_model.CpSolver, fixture_vars: FixtureVars) -> list[tuple[int, int, int]]:
    """Read placed fixtures back out. `start[i]` free-floats for an unplaced
    fixture (its intervals are absent, so nothing constrains it), which is why
    this filters on `placed[i]` rather than reading every start.

    A fixture's identity in the returned triples is its POSITION `i` —
    `enumerate(fixture_vars.placed)` rather than a stored `fixture_ids` list,
    since the two would always have agreed (see `FixtureVars`'s docstring).
    """
    out: list[tuple[int, int, int]] = []
    for i, is_placed in enumerate(fixture_vars.placed):
        if not solver.Value(is_placed):
            continue
        for court_index, presence in enumerate(fixture_vars.presence_court[i]):
            if solver.Value(presence):
                out.append((i, court_index, int(solver.Value(fixture_vars.start[i]))))
                break
    return out
