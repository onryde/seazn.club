# Capacity pre-check & INFEASIBLE explainer — design (D2)

Date: 2026-08-13. Status: **approved design, creative-only** — build not
scheduled; owner green-light required. Origin: scheduler-bench spec §14
item 2 (`2026-08-12-scheduler-bench-design.md`). First in the ratified
build order: D2 → D3 → D7 → D1a → D4 → D1b → D5 → D6.

## Purpose

Instant, pre-solve arithmetic that tells an organizer whether a schedule
request can possibly fit — and if not, the cheapest fixes, quantified
("add 1 court OR 2 days, or shorten slots to 45min"). Kills the
solve-wait-INFEASIBLE loop for provably impossible boards.

Owner rulings (2026-08-13): advisory card; the Solve action is hard-blocked
ONLY on arithmetic impossibility (`verdict: "impossible"`); warnings never
block. Per-metric honesty over composite cleverness.

## Design

**One pure function, every consumer** (this repo's placer/verifier fork is
the recurring bug — one function, both sides):

- `packages/engine/src/scheduling/capacity.ts`
  - `assessCapacity(input): CapacityReport`
  - input: fixture count (per division/stage), `matchMinutes`, `gapMinutes`,
    court count × usable windows per day (from `ScheduleConfig.courts` +
    `sessionWindows`/`blackouts` today; court calendars after D5 — additive
    input change, noted delta), day span (`startAt..endAt`), `perEntrantMinRest`,
    per-day caps from `hard[]`/rule groups, per-entrant fixture counts.
  - output `CapacityReport`:
    - `slotSupply` (total placeable slots), `slotDemand`, `perDay[]` supply
      vs cap-bounded demand,
    - `restLowerBound` per entrant (fixtures_e − 1) × (matchMinutes + rest) vs
      span — the entrant-serialization bound,
    - `verdict: "impossible" | "tight" | "ok"` (`impossible` = any hard
      arithmetic bound violated; `tight` = supply/demand ratio under a
      declared threshold, e.g. <1.15),
    - `suggestions[]`: each `{kind: add_day|add_court|shorten_match|shrink_gap|
      raise_cap, amount, flipsVerdict: boolean}` — computed by re-running the
      arithmetic with the candidate delta, never guessed.

**Consumers**:
1. Schedule setup UI: live card, recomputes on every knob change
   (client-side import of the engine lib — no network).
2. `POST /stages/{id}/schedule/auto` (and joint competition plan): server
   re-runs `assessCapacity` and refuses with a typed 422 (`code:
   "capacity.impossible"`, report attached) — client hint, server authority.
3. Future bench independent checker consumes the same lib (contract:
   pure, no DB, no solver imports, no Date.now).

**UI**: card in schedule setup (stage + joint competition variants):
verdict chip, supply/demand bar, per-day mini-bars, suggestion rows with
one-click apply where the knob is local (e.g. extend endAt). `/admin` not
involved; full polish bar. Mobile 320/768/1280, no horizontal scroll.

## Testing (all four types, per RULES.md)

- Unit: arithmetic cases — supply/demand, rest bound (the case that catches
  "10 fixtures, 1 entrant pair, 1 day"), per-day caps, each suggestion's
  `flipsVerdict` honesty (apply suggestion → re-assess → verdict flips).
- Regression: a known INFEASIBLE board (repair-bench era, #455 family)
  asserts `verdict: "impossible"` BEFORE any solver call; plus a
  mutation-style guard: loosen the binding constraint, verdict leaves
  `impossible`.
- E2E (Playwright): card renders, Solve disabled + reason on an impossible
  config, enabled after applying the suggestion.
- Smoke: one impossible + one ok assessment through the real API route.

## i18n

All card copy, verdict labels, suggestion strings ×4 locales, flat dotted
keys. Suggestion strings are parameterized (`{count}` courts/days/minutes).

## Dependencies & sequencing

None on the other six designs. D5 later swaps the courts×windows input for
court-calendar-derived windows — additive param, no consumer change.
Release-2 overlap: none (new file + one guard call in the auto route).
Structured logging: pino event `capacity_assessed` (verdict, ratios) in the
server consumer only — never in the pure lib, never in `src/core/**`.

## Risks / re-pin

`ScheduleConfig` field names cited from `api-v1/schemas.ts:743` predate
C1/C2 landings — scout re-pin at plan time. OpenAPI regen owed (new 422
code + report schema on the auto route).

## Non-goals

No soft-constraint prediction (that's the solver's job), no composite
score, no persistence of reports, no CSP/solver imports in the lib.
