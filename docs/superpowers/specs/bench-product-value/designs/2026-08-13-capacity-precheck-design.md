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
2. `POST /stages/{id}/schedule/auto` and the competition-scope plan
   entry point: server re-runs `assessCapacity` and refuses with a typed
   422 (`code: "CAPACITY_IMPOSSIBLE"`, report attached) — client hint,
   server authority.
   **Corrected 2026-08-13 (wave-1 scout):** there is no competition-scope
   `/schedule/auto` route. The competition solve entry points are
   `/competitions/{id}/schedule/ai-plan` (→ `aiPlanForCompetition`) and
   `.../schedule/apply`. Guard `ai-plan`, assessing per division and
   returning the impossible set; leave `apply` alone — it lands an
   already-solved board.
3. Future bench independent checker consumes the same lib (contract:
   pure, no DB, no solver imports, no Date.now).

**UI**: card in schedule setup (stage + competition-scope variants):
verdict chip, supply/demand bar, per-day mini-bars, suggestion rows with
one-click apply where the knob is local (e.g. extend endAt). `/admin` not
involved; full polish bar. Mobile 320/768/1280, no horizontal scroll.

## Arithmetic (normative)

Let m = `matchMinutes`, g = `gapMinutes`, slot = m + g. (Both are the
real `ScheduleConfig` field names, confirmed at `schemas.ts:743-793`;
`perEntrantMinRest` is r.)

- **Supply**: per court c, per day d: usable windows W_{c,d} (config
  sessionWindows − blackouts today; D5 court calendars later).
  `supply_{c,d} = Σ_w ⌊(len(w) + g) / slot⌋` (the +g credits the last
  match of a window needing no trailing gap). `slotSupply = Σ supply`.
- **Demand**: `slotDemand = |fixtures|`. Per-day demand ceiling:
  `capBound_d = Σ_div min(dayCap_div,d, remaining_div)` — day caps from
  `hard[]`/rule groups bound how much demand CAN land on d.
- **Rest lower bound** per entrant e with k_e fixtures and rest r:
  `need_e = k_e·m + (k_e−1)·max(r, g)`; e's available horizon = span of
  days e may play (weekday/earliest-latest hard rules applied) × daily
  window length. Violated ⇒ impossible.
- **Verdicts**: `impossible` iff any of: slotDemand > slotSupply;
  ∃d prefix where cumulative demand under caps cannot fit cumulative
  supply (Hall-style prefix check over ordered days); ∃e rest-bound
  violated. `tight` iff not impossible and slotSupply <
  TIGHT_RATIO(=1.15) · slotDemand or any entrant's slack < 1 slot.
  Else `ok`.
- **Suggestions**: candidate deltas = {+1 day (extend endAt), +1 court,
  m′ = m−5 (floor 2×min sport duration guard — suggest only if m′
  sane), g′ = max(0, g−5), raise the binding day cap by 1}. Each is
  re-assessed; emit `{kind, amount, flipsVerdict}` sorted:
  verdict-flippers first, then by smallest amount. Never emit a
  suggestion that violates a hard rule (e.g. +1 day past a weekday-only
  constraint).

## Error/API shape

Server refusal on the guarded routes: 422
`{code: "CAPACITY_IMPOSSIBLE", report: CapacityReport}`.

**Corrected 2026-08-13 (wave-1 scout).** This spec originally wrote the
code as dotted-lowercase `capacity.impossible`, which matches nothing in
the tree: typed codes here are ALL_CAPS_SNAKE with no dots
(`EngineErrorCode`: `STAGE_NOT_READY`, `SCHEDULE_CONFLICT`; `HttpError`
codes: `AI_PLAN_FAILED`), and dotted `capacity.*` exists in source only
as i18n keys (`register.capacity.taken`). The throw is
`new HttpError(422, msg, "CAPACITY_IMPOSSIBLE", { report })`, following
the `AI_PLAN_FAILED` precedent. `EngineErrorCode` and the `ENGINE_HTTP`
map are deliberately NOT widened — the engine lib stays pure and throws
nothing; the web layer owns the refusal.
`CapacityReport = {verdict, slotSupply, slotDemand, perDay:
Array<{date, supply, demandCeiling}>, restBound: Array<{entrantId,
need, available, violated}>, suggestions: Array<{kind, amount,
flipsVerdict}>}`. The card consumes the identical type client-side
(engine lib import — no fetch).

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
