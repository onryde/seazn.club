# R6 — `/code-review high` on the whole branch, 2026-08-30

Target: `feat/scorepad-v3-r6-period-pair` (27 files, +6493/−89), reviewed
against the real engine. Baseline at review time: the five new/changed v3
suites **361 passed / 0 failed**; dictionary parity exact across en/es/fr/nl
(145 new keys, 0 missing, 0 extra); `i18n-keys.ts` fully regenerated.

**Verification status is the orchestrator's, not the reviewer's.** Rows are the
reviewer's claims until this file says otherwise.

| # | Sev | File | Claim | Status |
|---|---|---|---|---|
| 1 | HIGH | `v3/clock.ts:249` | `−1 min` is a DEAD BUTTON on a running clock that was never paused: `adjustClock` clamps against `clock.base`, but a running clock's live seconds sit in `runningSince`. Start fresh, play 3:00 (`base === 0`), tap `−1 min` → `Math.max(0, 0-60) === 0 === base` → returns the clock by reference, nothing moves, tapping again does nothing. Escape is Pause → −1 → Start, which nothing hints at. The function's own doc asserts the opposite. `clock.test.ts:650` exercises only the **+** direction on a running clock, so the suite is green. | OPEN |
| 2 | HIGH | `v3/pad-host.tsx:1172` + `clock.ts:249` | A SUCCESSFUL backward correction makes the engine refuse every later event until the clock catches up. `core/events.ts:603` throws `NON_MONOTONIC_TIME` below the high-water mark and `server/engine-db/append-event.ts:273` folds with `strictFromSeq`, so the guard is live on exactly the events this pad now sends. Nothing compares the stamp against `state.asOf`. Seeded at 6:00, goal → high-water `{Q1,360}`; `−1 min` → 5:00; next card stamped `{Q1,300}` — the local optimistic fold is NON-strict (`pad-host.tsx:596`) so the pad shows it applied, then the server rejects it with the generic fallback copy. Every event refused for a real minute of play. Invisible to the suite: `_period-fold.ts` passes no `strictFromSeq` and its "accepts" probe calls `module.apply`, which has no monotonic guard. | OPEN |
| 3 | MED | `v3/skins/period-shared.ts:468` | `view.clockAt ?? state.asOf` prefers the pad clock even when PAUSED, and `reseatClock` re-seeds only on a period change. Mount mid-Q2 paused at 300, never start it, let another device advance `state.asOf` to 600 → the strip reports five minutes MORE box time than the kernel will serve and the scorer sends the player back late. The rationale holds only while the clock RUNS. Taking the later of the two within the same period fixes it and also removes finding 2's exposure. | OPEN |
| 4 | MED | `v3/skins/period-shared.ts:869` | **REGRESSION vs v2.** The suspension sheet claims `<sport>.suspension.start`, so `dedicatedEventTypes` drops it from More — but the sheet collects only `class` and `reason`. The engine's `padSpec` declares two more fields (`kernel.ts:1957-1985`): `minutes` bounded by cfg, and a labelled `servedBy` picker — both added by S7/#427, both with copy already shipped in four locales (`pad.hockey.action.suspensionStart.field.minutes`, `.field.servedBy`) and now referenced by NOTHING. Harm: the kernel's own note says an FIH yellow is a MINIMUM of 5 minutes and 10 is common, so every yellow now takes the class default, `expiresAt` derives from the wrong duration, and finding 3's countdown counts to the wrong moment. The same claiming also removes `void` (shoot-out retake, `kernel.ts:2002`) and `goalkeeper` from the attempt, and `goalkeeper` from the set piece. v2's `period-skin` reached all of these through the generic action form. | OPEN |
| 5 | LOW | `v2/scorepad/skins/registry.ts:24` | Provenance block still documents `hockey`/`icehockey -> period-skin` as live, though `V3_SKINS` owns both and `ScorePad` returns on the v3 lane first. R5 left an equivalent note for `racquet-skin`; the R6 pair got none, so the next reader believes `period-skin.tsx` is still reachable. | OPEN |
| 6 | LOW | `v3/pad-host.tsx:809` | `aria-controls="v3-clock-adjust"` is a hardcoded document-unique id pointing at an element that exists only while expanded; two pads on one page (the harness renders side-by-side surfaces) produce duplicate ids and cross-wire the disclosures. `useId()` is unavailable in this repo's node hook harness, so derive the suffix from `fixtureId`. | OPEN |

## Checked and cleared by the reviewer

`og`/`fg` goal kinds are valid regardless of `cfg.goalKinds` (`kernel.ts:1907-1911`),
so the unconditional own-goal chip is right. `SET_PIECE_OUTCOMES =
AttemptOutcome.options` — all four outcomes have `OUTCOME_KEY` entries; all 7
hockey and 19 ice-hockey reasons have `REASON_KEY` entries. Ribbon key
derivation matches all 14 keys added to `PAD_LABEL_KEYS`. `sportThemeStyle`
iterates `SPORT_TOKENS`, so the seventh token is emitted for every sport and
`icehockey` correctly inherits the default `advisory`. The empty tile grid in
`pre` is pre-existing, shared with football and badminton. `football.tsx`'s
`at: stamp` (key always present, value possibly `undefined`) is the documented
deliberate-omission channel and `GameTime.optional()` parses it.

## Orchestrator's note — findings 1, 2 and 4 are ONE story

The wave added a clock, then a control to correct it, and the correction is the
part that is unfinished: it does nothing in the commonest case (1), and where it
DOES work it can brick scoring for a minute (2). Finding 4 is independent and is
the most product-significant of the six — an ice-hockey pad that cannot record
penalty MINUTES cannot score ice hockey, and it silently corrupts the very
countdown this wave exists to deliver.

**None of the six is visible to the ~2150-test suite.** Two are invisible for a
structural reason worth keeping: the fold helper does not pass `strictFromSeq`
and its accept-probe calls `module.apply`, which does not contain the guard the
server actually applies. A test harness that is more permissive than production
cannot see a class of defect at all.
