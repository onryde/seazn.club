# C2 — T1 `day_start` objective rung

Spec of record: `../2026-08-12-t1-day-start-rung-design.md`, amending the
merged `../2026-08-11-t1-day-aware-objective-design.md` (read both; the #512
doc's addendum already points here).

## Goal

New rung `day_start` = Σ over used days of `(day_lo[d] − day_open[d])`.
Chain: `placed → days → day_span → day_start → idle_gap → imbalance`.
TIER_COUNT → 6. Anchors each day's block to the day's first slot; the empty
first morning dies.

## File set

- `services/placement/src/placement/model.py` — the rung, reusing #512's
  `day_lo` and the slot-derived day ids (~:842-870). `day_open` is a
  constant per day. Linear only — if you find yourself reifying, stop and
  re-read the spec.
- Tier-name vocabulary both sides: proto `Tier` comment (~:192-198) + the TS
  caller's tier list. Same string, `"day_start"`, both sides.
- `bench/` copy of the model if the #512 work duplicated the chain there.

## Do NOT touch

The two approved #512 rungs' definitions, day-window selection (which days
the solver uses stays free — explicitly out of scope), wire messages beyond
the `Tier` name comment.

## Acceptance

- Failing-without test: a board whose 5-rung optimum legally starts a day
  late lands on the day-open slot with the rung, fails without it.
- Wire: `objective_values` carries `day_start` at position 4;
  `tiers_completed` reflects 6.
- Bench: N ≥ 6 per side, wall respected, tier progression not regressed —
  the reified-day encoding is the lead suspect for T1 never proving, so
  paste per-tier proof times, not just totals.

## Verify

Placement suite + TS tier-name tests; bench numbers raw in PR body.
