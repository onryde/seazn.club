#!/usr/bin/env python3
"""Board generation for the CP-SAT scheduling bench, extracted so the bench
sweep and the service's own tests drive the SAME generator instead of two
copies that drift.

Everything above `production_board()` is lifted verbatim out of
`cpsat_bench.py` — same constants, same dataclasses, same math. Read that
file's module docstring for WHY each of these shapes is what it is (lattice
re-spacing at `gcd(matchMinutes, gapMinutes)`, the `existing`/dependency
families being modeled at all, the `not_after` pin). `cpsat_bench.py` imports
these names back, so the sweep is unchanged by the move.

`production_board()` is the only new code here: it renders the sweep's
`prod-37x77k` point into the SERVICE's plain-Python argument shape
(`cp_sat.model.build_model`'s parameter list, which mirrors
`proto/scheduler.proto`'s `SolveBuildRequest`). It deliberately does NOT
introduce a second board generator — it calls `build_board` like the sweep
does and only translates the result.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

MIN_MS = 60_000
HOUR_MS = 3_600_000
DAY_MS = 86_400_000

MATCH_MIN = 40
GAP_MIN = 10  # real court-turnaround gap now modeled (was 0 in the first pass)
STEP_MIN = math.gcd(MATCH_MIN, GAP_MIN)  # 10 — the lattice re-spacing, see module docstring.
TICKS_PER_COARSE_SLOT = MATCH_MIN // STEP_MIN  # 4
OPEN_MS = 8 * HOUR_MS
CLOSE_MS = 20 * HOUR_MS
# The SIZING cap (used only by `choose_lattice`, unchanged from the first pass
# so `target_slots` still means what it meant there). The ACTUAL number of
# generated ticks per court-day is `spcd * TICKS_PER_COARSE_SLOT` — see
# `build_board`.
SLOTS_PER_COURT_DAY_CAP = (CLOSE_MS - OPEN_MS) // (MATCH_MIN * MIN_MS)  # 18
DIVISIONS = ["d1", "d2"]
EPOCH_MS = 0  # Monday 00:00 UTC, arbitrary — only relative offsets matter.


# --- lattice sizing -----------------------------------------------------


def choose_lattice(courts: int, target_slots: int) -> tuple[int, int]:
    """(days, slots_per_court_day) whose product * courts is closest to
    target_slots, subject to slots_per_court_day <= SLOTS_PER_COURT_DAY_CAP
    and days >= 2. Unchanged from the first pass — GAP_MIN no longer
    re-spaces the lattice (see module docstring), so this sizing logic still
    applies verbatim."""
    best = None
    for days in range(2, max(3, target_slots // courts + 2) + 1):
        spcd = max(1, min(SLOTS_PER_COURT_DAY_CAP, round(target_slots / (courts * days))))
        actual = courts * days * spcd
        err = abs(actual - target_slots)
        if best is None or err < best[0]:
            best = (err, days, spcd, actual)
    assert best is not None
    _, days, spcd, _actual = best
    return days, spcd


# --- board -----------------------------------------------------------------


@dataclass
class Fixture:
    id: str
    round_no: int
    home: str
    away: str
    division: str


@dataclass
class Slot:
    court: str
    start_ms: int

    @property
    def end_ms(self) -> int:
        return self.start_ms + MATCH_MIN * MIN_MS


@dataclass
class Existing:
    """An immovable row (build-encode.ts section 7 / build.ts's `existing`
    param). NOT part of `board.slots` — production removes an existing row's
    OWN court time from the lattice at `buildGrid` time; this bench does not
    bother re-deriving the lattice around it and instead lets section 7's
    per-slot forbid-list do the same job at the constraint layer, which is
    provably equivalent for every movable fixture's legality (it just leaves
    a lattice slot in `board.slots` that no movable fixture can ever actually
    take — inert, not wrong)."""

    id: str
    court: str
    start_ms: int
    end_ms: int
    entrants: list[str]


@dataclass
class Board:
    fixtures: list[Fixture]
    slots: list[Slot]
    days: int
    slots_per_court_day: int
    courts: list[str]
    per_entrant: int
    pool: int
    hard_rest_min: int
    day_cap: int
    not_after_entrants: int
    calendar_days_spanned: int
    dropped_by_blackout: int


def id_of(f: int) -> str:
    return f"f{f:04d}"


def entrant_of(e: int) -> str:
    return f"e{e:04d}"


def intervals_overlap(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    """Half-open overlap test — the same shape build-grid.ts's `admits()` uses
    for blackouts (calendar.ts's `intervalsOverlap`)."""
    return a_start < b_end and a_end > b_start


LUNCH_BREAK_MIN = (12 * 60, 13 * 60)
COFFEE_BREAK_MIN = (16 * 60, 17 * 60)


def build_board(
    n: int,
    courts_n: int,
    target_slots: int,
    per_entrant: int = 2,
    hard_rest_min: int = 80,
    not_after_entrants: int = 2,
    day_cap_override: int = 0,
    blackouts: bool = False,
    skip_weekends: bool = False,
) -> Board:
    courts = [f"C{i+1}" for i in range(courts_n)]
    days, spcd = choose_lattice(courts_n, target_slots)
    session_ms = spcd * MATCH_MIN * MIN_MS

    pool = max(4, math.ceil((2 * n) / per_entrant))
    per_round = max(1, pool // 2)
    day_cap = day_cap_override if day_cap_override > 0 else max(1, math.ceil(n / len(DIVISIONS) / days))

    fixtures: list[Fixture] = []
    for f in range(n):
        home = entrant_of((2 * f) % pool)
        away = entrant_of((2 * f + 1) % pool)
        division = DIVISIONS[f % len(DIVISIONS)]
        fixtures.append(
            Fixture(id=id_of(f), round_no=f // per_round + 1, home=home, away=away, division=division)
        )

    def day_admits(calendar_day: int) -> bool:
        if not skip_weekends:
            return True
        return (calendar_day % 7) < 5

    def slot_admits(day_open: int, start: int) -> bool:
        if not blackouts:
            return True
        end = start + MATCH_MIN * MIN_MS
        for lo_min, hi_min in (LUNCH_BREAK_MIN, COFFEE_BREAK_MIN):
            b_from = day_open - OPEN_MS + lo_min * MIN_MS
            b_to = day_open - OPEN_MS + hi_min * MIN_MS
            if intervals_overlap(start, end, b_from, b_to):
                return False
        return True

    slots: list[Slot] = []
    dropped_by_blackout = 0
    calendar_day = 0
    session_days_used = 0
    while session_days_used < days:
        if day_admits(calendar_day):
            day_open = EPOCH_MS + calendar_day * DAY_MS + OPEN_MS
            for court in courts:
                # `spcd` sizes the day in matchMinutes-sized chunks (unchanged
                # sizing math from the first pass); each chunk is materialised
                # at the true STEP_MIN tick granularity so the turnaround-gap
                # constraint (section 3) has real 50-minute-multiple starts to
                # choose from instead of being confined to 40-minute ones —
                # see the module docstring's "lattice re-spacing" note.
                for k in range(spcd * TICKS_PER_COARSE_SLOT):
                    start = day_open + k * STEP_MIN * MIN_MS
                    if slot_admits(day_open, start):
                        slots.append(Slot(court=court, start_ms=start))
                    else:
                        dropped_by_blackout += 1
            session_days_used += 1
        calendar_day += 1
    calendar_days_spanned = calendar_day

    slots.sort(key=lambda s: (s.court, s.start_ms))

    return Board(
        fixtures=fixtures,
        slots=slots,
        days=days,
        slots_per_court_day=spcd,
        courts=courts,
        per_entrant=per_entrant,
        pool=pool,
        hard_rest_min=hard_rest_min,
        day_cap=day_cap,
        not_after_entrants=not_after_entrants,
        calendar_days_spanned=calendar_days_spanned,
        dropped_by_blackout=dropped_by_blackout,
    )


def existing_rows_for(board: Board) -> list[Existing]:
    """A handful of pinned/immovable rows (build-encode.ts section 7). Two
    share entrants with the movable pool (exercise the rest-window half of
    section 7); one shares none but sits on a board court (exercises the
    gap-only half in isolation). Entrant ids reused from the low end of the
    pool, which every board hits early and often via the `(2f)%pool` /
    `(2f+1)%pool` round robin, so these actually bind several fixtures."""
    dur_ms = MATCH_MIN * MIN_MS
    day0_open = EPOCH_MS + OPEN_MS
    step_ms = MATCH_MIN * MIN_MS
    court_a = board.courts[0]
    court_b = board.courts[min(1, len(board.courts) - 1)]
    return [
        Existing(
            id="x-rest-a",
            court=court_a,
            start_ms=day0_open,
            end_ms=day0_open + dur_ms,
            entrants=[entrant_of(0), entrant_of(1)],
        ),
        Existing(
            id="x-rest-b",
            court=court_b,
            start_ms=day0_open + 3 * step_ms,
            end_ms=day0_open + 3 * step_ms + dur_ms,
            entrants=[entrant_of(2), entrant_of(3)],
        ),
        Existing(
            id="x-court-only",
            court=court_a,
            start_ms=day0_open + 10 * step_ms,
            end_ms=day0_open + 10 * step_ms + dur_ms,
            entrants=["e-pinned-x", "e-pinned-y"],
        ),
    ]


def dependency_pairs_for(board: Board, k: int = 3) -> list[tuple[str, str]]:
    """A few order-dependency pairs (build-encode.ts section 8): fixture at
    an odd index depends on the fixture immediately before it. Arbitrary but
    deterministic — this is exercising the CONSTRAINT FAMILY's cost, not
    modeling a real group-stage-before-knockout structure.

    Returned as (DEPENDENT, FEEDER) — note this is the reverse of
    `proto/scheduler.proto`'s `OrderPair(before_fixture_id, after_fixture_id)`,
    which is (FEEDER, DEPENDENT). `production_board()` flips them; the bench's
    own `build_model` consumes this order directly."""
    n = len(board.fixtures)
    pairs: list[tuple[str, str]] = []
    for idx in range(k):
        dep_idx = 2 * idx + 1
        feed_idx = 2 * idx
        if dep_idx < n:
            pairs.append((board.fixtures[dep_idx].id, board.fixtures[feed_idx].id))
    return pairs


# --- service-shaped rendering of the sweep's production point ---------------

# The sweep point this mirrors: SweepPoint("prod-37x77k@8s", n=37, courts=5,
# target_slots=2081, wall_s=8.0). Kept as named constants rather than inlined
# so a change to the sweep point and a change here are visibly the same edit.
PROD_FIXTURES = 37
PROD_COURTS = 5
PROD_TARGET_SLOTS = 2081


def production_board():
    """The sweep's `prod-37x77k` board, rendered into `cp_sat.model.build_model`'s
    plain-Python parameter shape:

        (fixtures, courts, grid_slots, step_minutes, constraints, existing, dependencies)

    where
      fixtures     = [(fixture_id, [entrant_id, ...], division_id), ...]
      courts       = [court, ...]
      grid_slots   = [(court, start_at_ms), ...]
      step_minutes = int
      constraints  = {match_minutes, gap_minutes, rest_by_division, day_cap_by_division}
      existing     = [(fixture_id, court, start_at_ms), ...]
      dependencies = [(before_fixture_id, after_fixture_id), ...]

    This is exactly what `proto/scheduler.proto`'s `SolveBuildRequest` can
    carry — no more. Two consequences, both deliberate and both worth knowing
    before reading the numbers this board produces:

    * `not_after_entrants=0`, unlike the sweep's default of 2. The sweep pins
      two entrants' fixtures to the first tick (build-encode.ts section 5's
      start-window family). `SolveBuildRequest.Fixture` carries only
      (fixture_id, entrant_ids, division_id) — there is NO per-fixture start
      window on the wire — so a board WITH the pin could not be sent to the
      real service, and a test using one would be testing a code path
      production can never reach. The pin is therefore dropped rather than
      faked.
    * `existing` rows lose their `entrants` list for the same reason: the wire
      type is `Assignment (fixture_id, court, start_at_ms)`. Only section 7's
      court-turnaround half survives the round trip.
    """
    board = build_board(
        n=PROD_FIXTURES,
        courts_n=PROD_COURTS,
        target_slots=PROD_TARGET_SLOTS,
        not_after_entrants=0,
    )
    existing = existing_rows_for(board)
    dependencies = dependency_pairs_for(board)

    fixtures = [(fx.id, [fx.home, fx.away], fx.division) for fx in board.fixtures]
    courts = list(board.courts)
    grid_slots = [(s.court, s.start_ms) for s in board.slots]
    constraints = {
        "match_minutes": MATCH_MIN,
        "gap_minutes": GAP_MIN,
        # The sweep applies one hard_rest_min and one day_cap to every
        # division; the wire keys both by division, so fan the single value
        # out rather than inventing per-division numbers the bench never
        # measured.
        "rest_by_division": {d: board.hard_rest_min for d in DIVISIONS},
        "day_cap_by_division": {d: board.day_cap for d in DIVISIONS},
    }
    existing_rows = [(e.id, e.court, e.start_ms) for e in existing]
    # (dependent, feeder) -> (before, after), i.e. proto `OrderPair` order.
    order_pairs = [(feeder, dependent) for dependent, feeder in dependencies]

    return fixtures, courts, grid_slots, STEP_MIN, constraints, existing_rows, order_pairs
