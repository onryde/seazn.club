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

## Metric formulas (normative — the lib implements exactly these)

Notation: fixtures F with `start`, `end = start+matchMinutes`, `court`,
`entrants {a,b}`, `roundNo?`; per entrant e, its ordered fixture list
F_e; D = set of used days (org tz).

1. **restSpread** — per entrant, gaps g_i = start_{i+1} − end_i over
   F_e. Board's achievable mean rest ḡ* = (span_e − Σ durations) /
   (|F_e|−1) per entrant. Penalty = normalized deviation below target:
   `p_e = Σ max(0, (ḡ*_e − g_i) / ḡ*_e) / (|F_e|−1)`. Score =
   `100 · (1 − mean_e(p_e))`, clamped [0,100]. Entrants with |F_e|<2
   excluded. Offenders: bottom-3 entrants by p_e with their worst gap.
2. **courtBalance** — per entrant with |F_e|≥C_min(=3): Shannon entropy
   H_e of its court distribution ÷ H_max = log(min(|courts|,|F_e|)).
   Score = `100 · mean_e(H_e/H_max)`. Offenders: entrants pinned to one
   court despite ≥3 fixtures.
3. **gapDispersion** — per court-day: idle = window_len − Σ busy; frag
   f = idle_inside / (idle_inside + idle_edges) where idle_inside =
   idle between matches, idle_edges = before first/after last. Score =
   `100 · (1 − mean(f))` over court-days with ≥2 fixtures. Offenders:
   worst-3 court-days with their largest internal hole.
4. **homeAwayAlternation** — round-robin divisions only, else the
   metric is ABSENT (not 0). Per entrant: r = longest same-side run,
   a = alternation rate (side flips / (|F_e|−1)). Score =
   `100 · mean_e(a) − 10 · max(0, max_e(r) − 3)`, clamped. Offenders:
   entrants with r ≥ 4.
5. **primeSlotFairness** — prime = last `PRIME_N=2` slots per court-day
   (declared config). Expected share per entrant = |F_e| · P/|F| where
   P = total prime fixtures. Deviation d_e = |actual_e − expected_e| /
   max(expected_e, 1). Score = `100 · (1 − mean_e(min(d_e,1)))`.
   Offenders: top-3 |d_e| (both hogging and starvation).

Rounding: scores to integers, half-up, AFTER clamping. Determinism:
ties in offender ordering break by entrant id lexicographic.

## API shape

`GET /api/v1/stages/{id}/schedule/health` → 200
`{ stageId, computedAt, metrics: HealthMetric[5] }` where
`HealthMetric = {key, score, explanation, offenders: Array<{kind:
"entrant"|"court"|"courtDay", id, label, value}>}`; 404 unknown stage,
403 non-member, 409 `schedule.not_applied` when no schedule exists.
Joint variant: `GET /api/v1/competitions/{id}/schedule/health` returns
per-division arrays + a combined block (same metric keys, computed over
the union where meaningful: gapDispersion and primeSlot only).

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
