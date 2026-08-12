# Schedule health score — design (D3)

Date: 2026-08-13. Status: **approved design, creative-only** — build not
scheduled; owner green-light required. Origin: bench spec §14 item 3.
Build order: after D2.

## Purpose

After a schedule is proposed/applied, show organizers how GOOD it is —
per-metric bars with named offenders, so "the schedule is lawful but ugly"
becomes visible and fixable. Owner ruling (2026-08-13): per-metric bars
0–100, NO composite grade (composites hide which metric is bad and bake a
fairness opinion into one number).

## Design

**Lib**: `packages/engine/src/scheduling/health.ts` — pure function.

- `assessHealth(fixtures, config): HealthReport`
- fixtures: the applied/proposed assignments (start, court, entrants, round).
- Five metrics, each `{key, score: 0-100, explanation, offenders[]}`:
  1. `restSpread` — dispersion of inter-match rest per entrant vs the
     achievable ideal (not vs perfection: normalized to what the board's
     supply permits, so a dense weekend isn't scored 20 for existing).
  2. `courtBalance` — per-entrant court-usage entropy vs uniform.
  3. `gapDispersion` — idle-gap variance per court-day (dead air).
  4. `homeAwayAlternation` — longest same-side run + alternation rate
     (round-robin divisions only; skipped for brackets).
  5. `primeSlotFairness` — share of "prime" slots (last N per day, or
     inside a declared window) per entrant vs uniform.
- `offenders[]`: worst entrant/court ids + the numbers that made them worst.
- Contract (bench-shared): pure, deterministic, no DB, no solver imports,
  no clock reads. The future bench consumes this exact function for its
  believability report — API changes here are bench-plan changes.

**Surfacing**:
- `GET /api/v1/stages/{id}/schedule/health` — server loads stored fixtures,
  runs lib, returns report (ACL as schedule read).
- UI: panel on the stage schedule page after auto/apply — five bars,
  expandable offender lists, explanation lines. Report-only; blocks
  nothing, gates nothing. Also rendered for the joint competition plan
  result (aggregated per division + overall).

## Testing (all four)

- Unit: each metric on hand-built boards with KNOWN scores (perfect board
  = 100s; adversarial boards constructed per metric; symmetric-fixture trap
  avoided — boards use unequal division/entrant sizes so first-row-wins
  bugs can surface).
- Regression: pin the full report for one fixed board (golden-ish JSON in
  the test, not a corpus file); any metric drift reds with a diff.
- E2E: panel renders post-auto-schedule with 5 bars; offender expansion.
- Smoke: health route returns a well-formed report on the smoke org's
  schedule.

## i18n

Metric names + explanation templates ×4 locales, flat dotted keys.

## Dependencies & sequencing

D2 ships first (shared "assess" UI pattern, sibling engine lib). D5 later
adds court metadata to offender display (names instead of labels) — display
delta only. No release-2 file overlap (new lib + new route + panel).
Structured logging: pino `schedule_health_assessed` (scores only) in the
route.

## Risks / re-pin

Fixture-row field names (V214) re-pinned at plan time. "Prime slot"
definition is declared config (default: last 2 slots per day) — recorded
so nobody re-derives intent.

## Non-goals

No composite grade, no auto-fix actions, no persistence/history of
reports, no cross-org comparison.
