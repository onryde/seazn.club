# R2b — cricket over-by-over: code-level plan

Brief: `../specs/2026-08-15-scoringpad-v3-prompts/R2b-cricket-over-by-over.md`.
Rules: `../specs/2026-08-15-scoringpad-v3-prompts/_RULES.md`. Index (rulings
live there, not here): `../specs/2026-08-15-scoringpad-v3-prompts/_INDEX.md`.

Branch `feat/scorepad-v3-r2b-cricket-over`, worktree
`.claude/worktrees/r2b-cricket-over`, off main `5885952f` (R2 = #599).

## What the scout re-pinned (every line below verified on main `5885952f`)

The brief's premise held, and three facts it did not have change the design:

1. **Fidelity is per-innings and FIRST-EVENT-WINS.** `createInnings(state,
   fidelity)` (`cricket.ts:661-678`) sets `fine = null` unless
   `fidelity === "fine"`. `applyDelivery` calls it with `"fine"`
   (`cricket.ts:2940`); `applySummary` with `"coarse"` (`cricket.ts:1406`).
   No cfg field, no org band, no picker — whichever event type arrives first
   for that innings locks it.
2. **The refusal is BIDIRECTIONAL.** Ball on a coarse innings is refused at
   `cricket.ts:1128-1131`; summary on a fine innings is
   refused at `cricket.ts:1402-1404` ("this innings is recorded ball-by-ball —
   summaries are not allowed for it"). So over-level and ball-level are
   mutually exclusive **within one innings**. The brief's own open question 1
   ("show it at every band") is answered by the engine, not by preference.
   Correction, found by review while proving R2b's tests non-vacuous: the
   SECOND ball-on-coarse guard at `cricket.ts:2936-2938` is **masked** by
   `applyDelivery`'s own guard at `:1128-1131`, which fires first. `:1128` is
   the load-bearing line; an earlier draft of this plan implied `:2936` was.
3. **The payload REPLACES.** `runs`/`wickets`/`legalBalls` overwrite the
   innings totals (`cricket.ts:1445-1451`) behind a monotone "summary totals
   may not decrease" guard (`:1416-1426`). `partial: true` routes to
   `autoClose(next)`; absent/false closes the innings (`:1453`).

Fourth fact, load-bearing for the whole gate — **undo re-derives fidelity**:
`handleUndo` (`pad-host.tsx:583-585`) dispatches `core.void`;
`append-event.ts:233,266,271` rebuilds the stream and `foldMatch`
(`core/events.ts:445-468`) runs `resolveVoids` (`events.ts:165`) then replays
from `module.init` on every call. Void the innings' only ball and
`createInnings(...,"fine")` never runs — the innings is not "reset to coarse",
it is **never opened**, so both lanes are available again. Per-event void
(R2's restored capability) takes the identical path; `assertUndoTarget`
(`server/usecases/scoring.ts:154-174`) never restricts to the tail.
**Nothing tests this** — `cricket.test.ts` contains zero `core.void`, and
apps/web's v3 void tests (`activity.test.ts:46-86`, `pad-host.test.ts:282`,
`ribbon.test.ts:82-84`) are generic plumbing. Task 5 closes that.

## Owner rulings taken 2026-08-17 (recorded in `_INDEX.md` as made)

- **Q1 → mutually exclusive tiles.** Innings unopened: over tile AND run tiles
  both shown. Innings coarse: over tile only. Innings fine: run tiles only.
  Every visible tap is legal at the moment it is visible; no dead-end refusal.
- **Q2 → prefilled running total.** The sheet opens with the fold's current
  `runs`/`wickets` and the scorer edits them up. Matches the payload exactly;
  the monotone guard cannot fire on a correct entry. No arithmetic in pad code.

## Design (per `frontend-design`, inside the locked v3 theme)

Copy is scorer language, not payload language: the tile says **"End of over"**,
never "innings summary". Its sublabel carries the over number the entry will
produce. The sheet's signature element is a **before → after ledger line** —
`24/1 → 31/2`, live as the numbers change — which is the one place the REPLACE
semantics become visible instead of implied. That line is the only ornament;
everything else is the existing sheet chrome. Steppers, not a bare keypad:
a scorer's thumb is on the phone, and `−`/`+` at the 44px floor beats a number
keyboard for the +1/+2 case, with the field itself editable for a big over.

## Tasks (sequential — 2 and 3 share no files but 3 needs 2's type)

### Task 1 — `types.ts`: a number step for guided sheets
`apps/web/src/components/v2/scorepad/v3/types.ts`. Add:

```ts
export interface SheetNumberStep {
  id: string; kind: "number"; title: string;
  initial: number; min?: number; max?: number;
  /** Pre-localised, skin-supplied (same rule as WhoLine.servingLabel):
   *  the chassis never resolves a sport-namespaced key. */
  hint?: string;
  when?: StepPredicate;
}
```
Union it into `GuidedSheetStep`. **Do not widen `buildPayload`'s
`answers: Record<string, string>`** — a number step's answer is the decimal
string, the skin parses it. Widening the map is a contract change every R3–R7
skin would inherit for one sport's convenience.

### Task 2 — `guided-sheet.tsx`: render it
Same directory. Stepper `−` / value / `+` at 44px, editable numeric field,
`hint` rendered above the control when present, `min`/`max` clamped in the
chassis (a clamp in the skin is a clamp the renderer can bypass). Keep
`stepVisible()`/`when` behaviour identical for the new kind.

### Task 3 — `skins/cricket.tsx`: the tile, the gate, the sheet
- Fidelity read: `currentInnings(asState(view.state))` (`cricket.tsx:205-209`)
  → `null` = unopened, `?.fine === null` = coarse, else fine. Reuse the
  existing `bowlerIsReadOnly` (`:201-203`) pattern; do not invent a second
  accessor.
- `tiles(view)` (`:582-661`): push the over tile before the `more` push
  (`:651`). `{ id: "overSummary", label: "pad.cricket.action.endOfOver",
  sublabel: <over number key>, kind: "primary", span: 2, phases: ["live"],
  action: { sheet: "overSummary" } }`. Gate per the ruling above; filter the
  ball-derived tiles (runs/extras/wicket) out when the innings is coarse.
- `sheets(view)` — three number steps, prefilled from
  `currentInnings(...)?.runs ?? 0`, `?.wickets ?? 0`, and
  `(?.legalBalls ?? 0) + ballsPerOverOf(cfg)` (the R2-carried helper — `hundred`
  sets `ballsPerOver: 5`, `cricket.ts:2811`; never hardcode 6). `buildPayload`
  parses the three answers and returns
  `{ runs, wickets, legalBalls, partial: true }`.
- Balls is prefilled and editable, not hidden: an innings can end mid-over.

### Task 4 — i18n, all 4 locales + the vocab list
`apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, flat dotted keys. New
`pad.cricket.*` keys AND the ribbon key `pad.cricket.ribbon.innings.summary`
(`ribbon.ts:45-55` derives `pad.<sport>.ribbon.<suffix>`). **Every new key must
also reach `PAD_LABEL_KEYS`** (`lib/scoring-vocab.ts:646`) or the copy stays on
the generic fallback with nothing failing (R1's standing item). `npm run
i18n:gen-keys` + `i18n:check`.

### Task 5 — tests (all four types; smoke deferred to R8 BY NAME)
- **Engine regression, test-only** (`cricket.test.ts`): void an innings' only
  ball → the innings is unopened → a `partial` summary is then ACCEPTED; and
  the mirror, that a summary on a fine innings is refused. This is the one
  place the wave touches `packages/engine`, and it adds no `src/` line — the
  brief's "no engine" is a src rule, and the gate in Task 3 is unsafe to ship
  on behaviour with zero coverage. Record as a deviation in the PR body.
- **Unit** (`v3/skins/__tests__/cricket.test.ts`): tile absent when fine, present
  when unopened/coarse; ball tiles absent when coarse; sheet prefill reads the
  fold; `buildPayload` emits `partial: true` and a total, not an increment.
- **Fold coverage** the brief asks for: a sequence of partial summaries folds to
  the totals a scorer expects (and never trips the monotone guard).
- **Legacy parity** (`v3/__tests__/legacy-parity.test.ts:1-104`): a fourth
  assertion for over-by-over — extend, do not start a second file.
- **e2e**: cricket over-by-over recorded from the pad against a prod build.
- **Seven-width**: the sheet is a new surface → `mobile.spec.ts` projects.
- **Smoke**: deferred to **R8**, which already owes cricket's smoke coverage.

### Task 6 — help + index
`content/help/scoring/cricket.md` (English only) gains an over-by-over section
stating the one thing a scorer must know: an innings is over-level or
ball-level, decided by the first entry, and undo is the way back.
`_INDEX.md`: R2 row → MERGED #599; R2b row → status + rulings + premises.

## Gate (rerun in the worktree, JSON counts pasted, nothing trusted from rtk)
Root `turbo run typecheck --force` and `turbo run lint --force` (CI's gates),
apps/web + engine vitest via `--reporter=json --outputFile`, cricket e2e and
the seven-width matrix against a prod build with `E2E_PROD_TARGET=1` on
`localhost`. Visual sign-off (gallery + walkthrough offer) is a MERGE GATE.
