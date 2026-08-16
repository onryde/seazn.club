# ScoringPad v3 — wave index

**One wave per session.** Read `_RULES.md`, then this file, then the wave's
prompt. This file is the compaction anchor: every ruling, false premise and
status change is written here **as it happens**.

Design of record: `../2026-08-15-scoringpad-v3-redesign-design.md` (committed
`8480e725`). Evidence: baseline gallery
<https://claude.ai/code/artifact/afdf2a1a-33d5-41d6-9b94-a485ced418b6>, tap-model
comps <https://claude.ai/code/artifact/c96496b9-4231-482a-85a0-d913cc25788b>.

## Order

Main chain is sequential R1→R8 (each conversion consumes R1's primitives;
R4 owes R5 nothing, but keeping one wave in flight at a time is the rule —
one PR per wave, visual sign-off gate on each).

| Wave | Prompt file | Depends on | Status |
|---|---|---|---|
| R1 | `R1-chassis.md` + plan `docs/superpowers/plans/2026-08-15-scorepad-v3-r1-chassis.md` | — | BUILT 2026-08-16 — chassis landed behind an EMPTY `V3_SKINS`; awaiting owner sign-off (gallery + walkthrough) before merge |
| R2 | `R2-cricket.md` | R1 | TODO |
| R3 | `R3-football.md` | R1 | TODO |
| R4 | `R4-tennis.md` | R1 | TODO |
| R5 | `R5-racquet-split.md` | R1 | TODO |
| R6 | `R6-period-pair.md` | R1 | TODO |
| R7 | `R7-universal-console.md` | R1 (chrome parts benefit from R2–R6 but do not block) | TODO |
| R8 | `R8-sweep.md` | R2–R7 | TODO |

## Rulings carried in (do not re-litigate — full text in spec §0)

- v3 regardless; v1 tap feel is the foundation; 11 per-sport skins on the
  shared chassis; HYBRID tap model (S: tennis/badminton/tabletennis/
  volleyball/boardgame/generic · T: cricket/football/hockey/icehockey/carrom).
- Daylight shell + stadium-night LCD scorebug; ribbon + ~6s soft-commit dock.
- One pad both surfaces; console = authority chrome; device link bare,
  day-scoped, cannot finalize.
- Fidelity ladder CLOSED 0–3, no second vocabulary (v2 S2/#430 ruling).
- Visual sign-off gate per wave (gallery + walkthrough) — merge-blocking.
- Spec §8 defect register D-1…D-19: rows close with their named wave or the
  skip reason is recorded HERE.

## Decision log

Append one line per ruling: date, wave, decision, reason. Never delete.

- 2026-08-15 — programme — created from the approved spec; R1 plan written
  at code level, R2–R8 as briefs whose sessions re-pin (v2's proven
  mechanism; pre-written line numbers go stale, see v2 `_INDEX.md` §"State
  of the world").
- 2026-08-15 — programme — capture recipe traps recorded in `_RULES.md` §2
  (page.request cookie jar, no networkidle, cookie banner, animations
  disabled) — paid for during the baseline capture, do not re-derive.

### R1 (2026-08-16) — contract rulings R2–R8 build on

- **ScorebugSpec is pure data**, not the spec §2.1 sketch: `context: string`,
  `phase`, `halves`, `strip: StripItem[]`. No `ReactNode` anywhere in a spec.
  Reason: apps/web vitest is `environment:"node"`; §2.8's "pure data + render
  mappings" is unachievable with a ReactNode strip.
- **`DockSpec { title, chips }`** supersedes spec §2.3/§2.8's bare `DockChip[]`,
  and the dock renders **exactly ONE title**: `DockSpec.title` is the title,
  `pad.dock.title` is the default a skin may point at, never a second line.
- **`WhoLine.servingLabel?: string`** (added mid-wave, changes Task 1's
  contract): the chassis renders a pre-localised serving label the SKIN
  supplies. The chassis must never resolve a sport-namespaced key itself —
  `scorepad.skin.tennis.header.serving` was briefly hardcoded in the shared
  scorebug, and this repo already keeps a separate `…skin.racquet.header.serving`
  sibling precisely because one sport's key must not serve another. When
  `serving` is true and no label is given the SR cue is silently absent, so
  **R4/R5 must supply the label wherever they set `serving`**.
- **Soft-commit is opt-in.** `enqueue` without a hold keeps today's exact
  behaviour; the held path is entered only via `enqueueHeld`. `HOLD_MS = 6000`
  is a chassis constant. The pipeline now exposes **`retryDrain`** on
  `UsePadPipelineResult` — the dock's `onDue` must use it; `runDrain` is private.
- **Pools come from the engine**: `resolvePool`'s "onfield" is `onFieldPersons()`,
  "bench" is `playingSquad()` minus on-field. `attribution-picker.tsx`'s
  `candidatesForPerson` uses bench-INCLUSIVE `playingSquad()` and cannot make
  the split — do not reuse it for a swap sheet.
- Second tap on a selected dock chip is a **no-op** (never re-applies, never
  auto-reverts): `DockChip` has no inverse of `mutate`.

### R1 — false premises found (all verified 2026-08-16)

- `registry.tsx` imports NO engine key list; `RESOLUTION_KIND` is hand-written.
  The v3 totality gate is the first production tie to `builtinModules`.
- TWO vocab paths exist. Skins call `padLabel()` (`lib/scoring-vocab.ts:907`),
  which wraps `useMsg()`. Reuse `padLabel`; never mint a second lookup.
- **`reduceLineupEvent`'s refusal is `{reason: LineupRejectionReason, message}`**
  — `.reason` is a MACHINE SLUG ("sub-cap-reached"), the sport-worded prose is
  `.message`. The v3 swap sheet's own docs said otherwise; a wiring wave that
  followed them would have shipped raw slugs as user-facing copy. The field is
  now branded so passing a slug is a tsc error.
- Fidelity entitlement is PROPS on `FidelitySwitcherProps`, not a hook.
- `apps/web/e2e/helpers/` is not a directory — `seedRosteredFixture` and
  `loginUi` live in the flat `apps/web/e2e/helpers.ts`.

### R1 — owed by later waves (do not let these die here)

- **R2+ must add per-sport ribbon keys to `PAD_LABEL_KEYS` in
  `scoring-vocab.ts`**, not only to the dictionaries, or ribbon copy stays on
  the generic fallback forever with nothing failing.
- **Recording chip's plan name is hardcoded `planLabel("pro")`.** No module
  declares a real `fidelityEntitlements` yet and the chip has no import sites,
  so it is inert — but `plan-label.ts` already lists a second paid tier
  (`pro_plus`). Parameterise it BEFORE the first wave that both populates a
  real entitlement and wires the chip, or an org already on Pro gets told the
  band is "available on Pro".
- **Boardgame gallery coverage is partial** (01-pre and 02-live confirmed; its
  scored/dock/device-link recipe was iterated three times and its final form
  was never independently re-verified). Do not trust a boardgame screen you
  did not capture yourself.
- `ContextSlot.required` drives only the "unset" dot today — honoured but
  cosmetic until a skin gates on it.
- Tile hierarchy: "Forfeit/Abandon are not representable in the tile grid" is a
  CONVENTION stated in a comment, with no type or runtime block. Skin-level
  validation owes the enforcement.
- The tile grid's 44px floor on 40px minor tiles rides on a 2px `::before`
  bleed, which any ancestor with `overflow: hidden` silently clips back to 40.
- **`violet-*` is used everywhere else in this app for AI surfaces**, yet spec
  §2.5 mandates a violet fill for primary tiles. Flag at the first gallery
  sign-off so the owner rules rather than discovering it mid-conversion.
