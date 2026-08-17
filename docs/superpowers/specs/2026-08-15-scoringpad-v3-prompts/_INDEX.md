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
| R1 | `R1-chassis.md` + plan `docs/superpowers/plans/2026-08-15-scorepad-v3-r1-chassis.md` | — | **MERGED #577 `86ce08b3`** (2026-08-16) — chassis behind an EMPTY `V3_SKINS`. Gate: unit 7709/7774 (4 pre-existing, in a file this branch never touched), tsc 0, lint 0 errors, legacy pad e2e 32/32 unedited vs a prod build, gallery 12/12 with 0px overflow at 320. Visual sign-off was the ABSENCE of change — owner acked by merging |
| R2 | `R2-cricket.md` + plan `docs/superpowers/plans/2026-08-16-scorepad-v3-r2-cricket.md` | R1 | **CODE COMPLETE, AWAITING VISUAL SIGN-OFF** (2026-08-17) — worktree `.claude/worktrees/r2-cricket`, branch `feat/scorepad-v3-r2-cricket`, HEAD `b45f77a0`, rebased onto main `252a073d`. Gate: unit 8155/8227 (the 4 failures are `schedule-build-honours-locks`, REPRODUCED IDENTICALLY on `origin/main 252a073d` in a throwaway worktree with its own `pnpm install` — pre-existing, not this wave), `turbo run typecheck --force` 2/2 tasks 0 errors, `turbo run lint --force` 0 errors / 77 warnings (was 78; no v3 path warns), v3 suites 300/300 across 15 files, cricket e2e + converted specs green, seven-width matrix 9/9, gallery 12/12 sports with 0px overflow at 320. Sign-off sheet published (15 cricket captures, 5 states × 3 widths). **NOT MERGEABLE until the owner rules the three decisions below and the verdicts are recorded here.** |
| R2b | `R2b-cricket-over-by-over.md` | R2 | **TODO** (owner requirement 2026-08-17) — cricket needs THREE granularities: innings totals, **over-by-over (runs + wickets)**, ball-by-ball. **Over-by-over ALREADY EXISTS in the engine** and v1 exposed it: it is `cricket.innings.summary` with **`partial: true`** (`cricket.ts:225,230-237`) posted once per over, NOT a separate event type. An earlier draft of this row claimed it never existed, off one negative grep for a `cricket.over` event that never needed to exist — wrong, and corrected. So: **no new event, no schema change, no golden re-baseline, no band decision** (already band 0/free; the ladder stays closed 0–3). The real gap is a PAD one — the v3 skin declares no tile for it, so a scorer must open "More" and scroll a generic form once per over. A pad wave, not an engine wave |
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
- **`SkinDefV3.sheets` HAS NO CHASSIS RENDERER.** `GuidedSheetSpec`,
  `SheetChoiceStep`, `SheetPersonStep` and `TileSpec.action = {sheet: string}`
  are declared in `v3/types.ts` with **zero** consumers: `tile-grid.tsx`
  forwards `tile.action` to `onAction` untouched, and nothing anywhere renders
  a guided step wizard. Task 8 built `swap-sheet.tsx` against its own
  `SwapSheetSpec`, so `{swap: true}` has a real component while
  `{sheet: string}` does not. **R2 hits this first** — cricket's wicket flow
  (kind → who) is exactly this shape. Build the renderer as part of R2 rather
  than assuming the chassis provides it.
- `ContextSlot.required` drives only the "unset" dot today — honoured but
  cosmetic until a skin gates on it.
- `v3/tokens.ts`'s `NIGHT_TILE_PAIRS` / `SCORE_TEXT_PX` are imported ONLY by
  `contrast.test.ts`; `scorebug.tsx` hand-matches the same colours and size in
  literal Tailwind classes. A class edit can silently desync what is tested
  from what renders — link them when a skin first consumes the scorebug.
- Tile hierarchy: "Forfeit/Abandon are not representable in the tile grid" is a
  CONVENTION stated in a comment, with no type or runtime block. Skin-level
  validation owes the enforcement.
- The tile grid's 44px floor on 40px minor tiles rides on a 2px `::before`
  bleed, which any ancestor with `overflow: hidden` silently clips back to 40.
- **`violet-*` is used everywhere else in this app for AI surfaces**, yet spec
  §2.5 mandates a violet fill for primary tiles. Flag at the first gallery
  sign-off so the owner rules rather than discovering it mid-conversion.

### R2 — owed by later waves (each also written into that wave's own prompt)

Every item here is deferred with a NAMED owner, never dropped. A wave that
reads `_RULES.md` → `_INDEX.md` → its own prompt meets each of these twice.

- **R3–R7, every conversion: implement `phase?(view)`.** R2 added it (G3) so
  tiles gate on the MATCH, not a user-clicked tab, and made it OPT-IN so this
  wave did not migrate sports it never tested. A skin that omits it silently
  keeps the tab-shaped behaviour D-16 describes. Map a richer engine phase
  DOWN to the three `PadPhase` values inside your own `phase()` body; never
  widen the type.
- **R3–R7: two chassis capabilities exist now — use them instead of
  re-deriving.** `GuidedSheetStep.when(answers)` skips a step without a tap
  (so one tile can open a flow that asks only what varies), and
  `SheetPersonStep.candidates` supersedes the pool when the skin knows the
  exact legal people. Both were built for cricket's wicket and are generic.
- **R3–R7: `WhoLine.servingLabel` must be supplied wherever `serving` is
  set** (R1's standing item, still open — R4/R5 are where it bites). The
  chassis renders a pre-localised label the SKIN provides; when `serving` is
  true and no label is given the screen-reader cue is silently absent.
- **R3–R7: the recording chip needs a real `fidelityEntitlements`.** R2
  parameterised the plan name and cricket declares real entries
  (`{2: "stats.player", 3: "scoring.ball_by_ball"}`). A converting sport whose
  module declares none renders an upsell for a band nothing gates.
- **R7: D-4 is yours, and R2 did NOT close it.** The R2 brief listed D-4 as
  owed, but the duplicate Activity ledger is console-level and R2 is barred
  from console chrome — spec §8 already assigns the row R1/R7. R2 closes D-5
  (the pad's ribbon renders words, not payload dumps) and leaves D-4 whole.
- **R7: enforce the tile-hierarchy convention.** "Forfeit/Abandon are not
  representable in the tile grid" is still only a COMMENT, with no type or
  runtime block (R1's item, unchanged by R2 — cricket simply declares no such
  tile). Console chrome is where the enforcement belongs.
- **R8: attribution has no required/optional flag, so nothing can validate
  it.** `checkActionValidity` (`view-model.ts:208`) deliberately skips
  attribution, and its own docstring gives the reason: `PadAttributionItem`
  (`packages/engine/src/sport/module.ts:264`) carries only `kind`, `path`,
  `role?` and `labelKey?` — there is no way to tell a required item from an
  optional one. Consequence today: an action can be confirmed with a required
  person unfilled, the engine's `strictObject` then rejects it, and the
  scorer's tap DEAD-ENDS on a refusal (`cricket.toss.wonBy`,
  `cricket.review.by`). Genuinely optional items (a wicket with no named
  fielder) are correct as they stand. Not data loss — a dead-end tap. The fix
  is an ENGINE contract change plus a sweep of all 11 sports' `padSpec`
  declarations plus conformance and golden replay, which is why R2 (permitted
  no engine work, §9) could not take it. See §9 item 2.
- **R8: cricket's dock has no shot-type chip.** Spec §3 promises shot-type
  enrichment, but `CricketBall` is a `z.strictObject` with no field to carry
  it, so the dock ships with Free hit alone. Adding the field is a payload
  change with golden-corpus consequences. See §9 item 3.
- **R8: delete `skins/cricket-skin.tsx`.** Dead for cricket from R2's flip
  onward, but deliberately left on disk — the v2 path must keep working until
  the last sport converts. Cricket also keeps its `RESOLUTION_KIND` row, now
  unreached, so the legacy drift guard does not rot before then.
- **R8: R2 deferred SMOKE by name**, per the brief. `scripts/smoke.ts` never
  drove the v3 cricket pad.
- **R8: finish `content/help/scoring/fidelity.md`.** R2 reworded it to be true
  of BOTH lanes (worded recording chip for cricket, raw picker for the other
  ten). When the last sport converts, the dual wording becomes wrong.

### R2 (2026-08-16) — owner rulings taken at scoping

- **Cricket's 13 non-ball event types stay in the PAD, HYBRID surfacing.**
  Toss, Review, Retire, Innings close and Declare become real phase-aware
  tiles; the remaining 8 sit behind one `minor` "More" tile opening a sheet
  that hosts the existing `padSpec(cfg)`-driven generic form. Reason: a
  fully-declared tile set makes every FUTURE engine action silently
  unreachable, while an all-generic surface is the monster-form grammar GF-7
  exists to kill. Console authority chrome (Finalize/Forfeit/Abandon, D-12)
  remains R7's; `/admin` is not in this programme.
- **Recording chip is wired in R2 with the plan name parameterised** — the
  `planLabel("pro")` literal dies before the chip first renders, so a
  `pro_plus` org is never told the band is "available on Pro". Closes D-7 for
  cricket rather than leaving §2.6 contradicted on a converted sport.
- **Violet primary tiles are built exactly as §2.5 specs**, with the
  `violet-*`-means-AI collision flagged in R2's gallery for the owner's
  ruling with screenshots present. A recolour after that is a token change.

### R2 — decisions AWAITING the owner's verdict (merge-blocking, 2026-08-17)

Published sign-off sheet: 15 cricket captures, 5 states × 3 widths, gate
results. **No verdict has been given on any of the three.** An empty verdict
below means UNRULED, never "approved by silence" — do not merge R2, and do
not let R3–R6 copy cricket's answer, until each line carries a real verdict.

| # | Decision | My recommendation | Owner verdict |
|---|---|---|---|
| D1 | Do the primary action tiles stay `violet-600`? Built to §2.5 as ruled at scoping, with the `violet-*`-means-AI collision flagged here as promised. | **Keep violet this wave.** It is the product's existing primary and a recolour is a token change either way — changing it now forks cricket from the ten skins still to come. | _(unruled)_ |
| D2 | Are dot ball and single the right two primary-weight tiles? | **Keep them.** Frequency is the right basis for a thumb-reach hierarchy in T20, and boundaries stay one tap away in the same grid rather than behind a sheet. | _(unruled)_ |
| D3 | Should the pad capture cricket BELOW fidelity tier 3? | **Leave it to R8.** Ball-by-ball is gated at tier 3; defining a low-band pad is a question across all eleven skins, not a cricket one. | _(unruled)_ |

### R2 — false premises found (verified 2026-08-16, before any code)

- **R1 shipped NO v3 render host.** All six chassis components
  (`scorebug`, `tile-grid`, `detail-dock`, `context-strip`, `swap-sheet`,
  `recording-chip`) have **zero** production import sites — their only
  consumers are their own `__tests__/` siblings. `registry.tsx:280` throws
  `"resolved to the v3 lane but no v3 renderer is wired yet"` on purpose.
  So R2 builds the **pad host** as well as the guided-sheet renderer and the
  cricket skin — three chassis-sized items, not one conversion.
- `SkinDefV3`'s methods take **`(view)` only**, not the spec §2.8 sketch's
  `(view, ctx)`. Briefs written against the sketch mis-scope the skin.
- The brief's "the over-dots strip must not assume 6" is **already half
  closed**: `cricket-skin.tsx:98` `ballsPerOverOf()` reads cfg with 6 only as
  an absent/invalid fallback, and `hundred` sets `ballsPerOver: 5` at
  `cricket.ts:2811`. The v3 strip must carry that helper across, not invent it.
- Cricket already has **20 `pad.cricket.*` keys** in `PAD_LABEL_KEYS` and 76
  cricket keys per locale — but **no ribbon keys anywhere**, exactly as R1
  predicted. `scorepad.skin.cricket.*` (11 keys per locale) exists in the
  dictionaries while `scoring-vocab.ts` lists none of them.
- **Four e2e specs drive the cricket pad today** (`scorepad-skins`,
  `scorepad-v2`, `scoring`, `scoring-vocab-labels`). Flipping the lane breaks
  all four; updating them is R2 scope, not R8's.
