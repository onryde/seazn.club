# T1 `day_start` rung — anchoring each day to its first slot (#512 follow-up)

**Date:** 2026-08-12 · **Status:** **IMPLEMENTED 2026-08-13** (release-2 C2,
branch `feat/c2-day-start-rung`) · **Amends:**
`2026-08-11-t1-day-aware-objective-design.md` — that doc gets a one-line
addendum pointing here; its approved rungs are unchanged.

> **"Merged, #531" meant the DOC, not the code.** #512's two rungs had never
> been implemented when this rung was picked up, so C2 shipped all three
> together (`TIER_COUNT` 4 → 6, `makespan` retired) rather than the 5 → 6 this
> document assumed. The "if this lands with it" in §Decision is what actually
> happened. Full account, including the bench numbers and the wall regression:
> `2026-08-12-release2-prompts/_INDEX.md`, the C2 entry.
>
> **One thing this design did not anticipate, and it decided whether the rung
> was shippable at all:** `day_span` cannot be proved on the production board
> without a REDUNDANT per-day floor (`span[d] >= dur_ms` when the day is used).
> Measured: FEASIBLE at 180 s without it, OPTIMAL in 1.0 s with it, same value.
> `day_used[d]` is implied by `on_day` one-directionally and never implies an
> occupant back, so the LP may hold a day "used" with a span of nothing and the
> dual bound starts at 0. See `placement.model`'s T1 section.

## Why a third term

Symptom: a board's first day starts at 12:30 with the whole morning empty.
Neither approved #512 rung can see it:

- `days` counts distinct calendar days — 6 either way.
- `day_span` minimises `Σ(day_hi[d] − day_lo[d])` — invariant under sliding a
  day's whole block later within the day.

The symptom needs an anchor, not a tighter span.

## Decision

New rung **`day_start`**: minimise `Σ over used days of (day_lo[d] − day_open[d])`.

- `day_open[d]` — the day's first slot tick, from the same slot-derived day ids
  the model already builds (`services/placement/src/placement/model.py:842-870`).
  A constant per day, not a variable.
- `day_lo[d]` — already exists; introduced by #512's `day_span` rung.
- Linear, no new reification. Pure reuse of #512 machinery.

**Chain:** `placed → days → day_span → day_start → idle_gap → imbalance`
(TIER_COUNT 5 → 6, i.e. #512's 4→5 becomes 4→6 if this lands with it).

Position is deliberate: below `day_span` so the anchor acts on an
already-tight block; above `idle_gap`/`imbalance` so they arrange the day's
interior freely after the block is anchored. The rejected alternative
(global `Σ start_i`) fixes the same symptom but its near-unique optimum
starves every rung below it.

## Wire / vocabulary

`"day_start"` joins the shared tier-name protocol: the proto `Tier` comment's
name list (`proto/scheduler.proto:192-198`) and the TypeScript caller's tier
vocabulary. Same-name-both-sides rule applies (ubiquitous language).

## Scope boundary

Anchors **within** each used day only. Which day-window the solver picks stays
free — `days` counts days, nothing places the window. If a
"solver skipped day 1 entirely" symptom ever shows up, that is a separate
future rung (e.g. preferring earlier day indices), explicitly out of scope
here.

## Tests

- A fixture board whose 5-rung optimum legally starts a day late: with
  `day_start`, the day's first match lands on the day-open slot; without the
  rung, the test fails (failing-without-the-change).
- Wire: `objective_values` carries a `day_start` tier in position 4;
  `tiers_completed` reflects the 6-rung chain.
- Bench: prod-shaped board, N ≥ 6 runs per side, solve wall respected and
  tier progression not regressed (same protocol as the round-ordering spec).

## Interaction notes

- Round-ordering spec (same date): hard constraints prune the feasible set
  before any objective rung — no coupling beyond feasibility.
- `day_start` never conflicts with `day_span`: for a fixed set of used days,
  anchoring `day_lo` to a constant floor is orthogonal to minimising
  `hi − lo`.
