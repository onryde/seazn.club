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
| R2 | `R2-cricket.md` + plan `docs/superpowers/plans/2026-08-16-scorepad-v3-r2-cricket.md` | R1 | **MERGED #599 `5885952f`** (2026-08-17) — visual sign-off given (see the sign-off section below, incl. the caveat that the reviewed captures predate `072656b4`'s three restored capabilities). Pre-merge state, kept for the record: worktree `.claude/worktrees/r2-cricket`, branch `feat/scorepad-v3-r2-cricket`, HEAD `b45f77a0`, rebased onto main `252a073d`. Gate: unit 8155/8227 (the 4 failures are `schedule-build-honours-locks`, REPRODUCED IDENTICALLY on `origin/main 252a073d` in a throwaway worktree with its own `pnpm install` — pre-existing, not this wave), `turbo run typecheck --force` 2/2 tasks 0 errors, `turbo run lint --force` 0 errors / 77 warnings (was 78; no v3 path warns), v3 suites 300/300 across 15 files, cricket e2e + converted specs green, seven-width matrix 9/9, gallery 12/12 sports with 0px overflow at 320. Sign-off sheet published (15 cricket captures, 5 states × 3 widths). **NOT MERGEABLE until the owner rules the three decisions below and the verdicts are recorded here.** |
| R2b | `R2b-cricket-over-by-over.md` + plan `docs/superpowers/plans/2026-08-17-scorepad-v3-r2b-cricket-over.md` | R2 (MERGED, so unblocked) | **MERGED #610 `78191611a`** (tip `896c8e608`, 2026-08-18) — approval-on-merge, see the sign-off section below. Pre-merge state, kept for the record: **IN FLIGHT** 2026-08-17 — worktree `.claude/worktrees/r2b-cricket-over`, branch `feat/scorepad-v3-r2b-cricket-over` off `5885952f`. Both of the brief's open questions are RULED (see the R2b section below); the first turned out to be answered by the engine rather than by preference. Original row text, still accurate on the premise: cricket needs THREE granularities: innings totals, **over-by-over (runs + wickets)**, ball-by-ball. **Over-by-over ALREADY EXISTS in the engine** and v1 exposed it: it is `cricket.innings.summary` with **`partial: true`** (`cricket.ts:225,230-237`) posted once per over, NOT a separate event type. An earlier draft of this row claimed it never existed, off one negative grep for a `cricket.over` event that never needed to exist — wrong, and corrected. So: **no new event, no schema change, no golden re-baseline, no band decision** (already band 0/free; the ladder stays closed 0–3). The real gap is a PAD one — the v3 skin declares no tile for it, so a scorer must open "More" and scroll a generic form once per over. A pad wave, not an engine wave |
| R2c | `R2c-candidate-narrowing.md` + design `R2c-task1-design.md` | R2b (MERGED, so unblocked) | **MERGED #614 `ca3a4357a`** (tip `3eda8a0ff`, 2026-08-18) — approval-on-merge, see the R2c sign-off section below; three screens (`08-bowlerpicker`, `09-retiresheet`, `10-reviewblocked`) carry NO individual verdict and are owed to R8's closing walkthrough. Pre-merge state, kept for the record: worktree `.claude/worktrees/r2c-candidates`, branch `feat/scorepad-v3-r2c-candidate-narrowing` off `main` `7023502a3`. Task 1 (the chassis capability) is DESIGNED and owner-approved before code — see the R2c section below. Closes C1/C2/C3 from `R2b-remaining.md` §C, the three surviving instances of "the pad offers what the engine will refuse" |
| R3 | `R3-football.md` | R1 | **IN FLIGHT** 2026-08-24 — worktree `.claude/worktrees/r3-football`, branch `feat/scorepad-v3-r3-football` off `main` `94922743f`. Scoping in progress; no code yet |
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

### R2 — owner's visual sign-off GIVEN 2026-08-17 (with a scope caveat)

The owner signed off visually ("Visually is signed off as well"). Recorded as
given. Two things a later session must not misread:

**1. The captures the owner reviewed PREDATE the three restored capabilities**
(`072656b4`). The pad now renders two visible elements absent from every one of
those 15 screenshots: the fold's result headline (`data-role="v3-headline"`,
a dark bar above the scorebug) and the activity panel
(`data-role="v3-activity-slot"`, a bordered scrollable list below the sheets).
The sign-off was given against the pre-fix pad and the artifact was re-captured
afterwards so the record matches what ships. The owner was told this
explicitly at the time rather than after the fact.

**2. The sign-off is a VISUAL verdict.** It settles D1 and D2, which are
questions about how the pad looks. It does not settle anything non-visual.

| # | Decision | Verdict |
|---|---|---|
| D1 | Do the primary action tiles stay `violet-600`? | **APPROVED as built** — violet stays. The `violet-*`-means-AI collision was flagged with screenshots present, as the scoping ruling required. A later recolour remains a token change. |
| D2 | Are dot ball and single the right two primary-weight tiles? | **APPROVED as built.** Note this decision was smaller than first framed: `PRIMARY_RUNS = {0,1}` (`v3/skins/cricket.tsx:530`) controls EMPHASIS only — every run value keeps its own one-tap tile (`:549` gives the rest `kind:"standard"`), and only the extras are `minor`. Nothing was hidden behind a sheet. |
| D3 | Should the pad capture cricket BELOW fidelity tier 3? | **SUPERSEDED — no longer a decision.** The premise was wrong: low-band cricket is not missing. It is `cricket.innings.summary` with `partial: true` (`cricket.ts:225`), which v1 exposed and the engine still folds. The real gap is that the v3 skin gives it no tile, so a scorer must open "More" once per over. Moved to **R2b**, which is a pad wave, not an engine one. |

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

### R2b (2026-08-17) — owner rulings, taken before any code

Both of the brief's "two open questions for the owner" are answered. Question 1
was not a preference in the end — the engine had already decided it, and the
scout's re-pin is what surfaced that.

| # | Question | Ruling |
|---|---|---|
| Q1 | Which bands show the over-by-over tile? | **Mutually exclusive tiles, band-independent.** Innings unopened → over tile AND run tiles both shown; innings coarse → over tile only; innings fine → run tiles only. Not a band gate: fidelity is a per-INNINGS fact, and the brief's recommended "show it at every band" is refused by the fold (see the false premise below). Every visible tap is legal at the moment it is visible. |
| Q2 | Prefill or increment? | **Prefilled running total.** The sheet opens with the fold's current `runs`/`wickets` and the scorer edits upward. The payload IS the innings total (`cricket.ts:1445-1451`), so an increment form would have to add in pad code with a stale view as its failure mode; prefilling keeps the arithmetic out of the pad entirely and the monotone guard (`:1416-1426`) can never fire on a correct entry. |

### R2b — false premises found (verified on main `5885952f`, before any code)

- **The brief's recommendation for Q1 was wrong, and the caveat it flagged is
  real.** It suggested showing the tile at every band so a band-3 org could
  fall back to over-level mid-match. The fold refuses that: the ball-on-summary
  refusal (`cricket.ts:1128-1131` — the duplicate at `:2936-2938` is MASKED by
  it and never fires first, proven by inversion during R2b's review) has a
  **mirror** at
  `cricket.ts:1402-1404` — "this innings is recorded ball-by-ball — summaries
  are not allowed for it". Over-level and ball-level are mutually exclusive
  WITHIN one innings. The brief told this session to confirm the caveat before
  promising a mixed workflow; it does not hold.
- **Fidelity is FIRST-EVENT-WINS, not configured.** `createInnings(state,
  fidelity)` (`cricket.ts:661-678`) is called with `"fine"` from `applyDelivery`
  (`:2940`) and `"coarse"` from `applySummary` (`:1406`). No cfg field, no org
  band, no payload flag, no picker — whichever event type arrives first for that
  innings locks it. Consequence for R3–R8: any sport-fidelity UI must read the
  fold's own state, never assume a declared setting exists.
- **Undo DOES recover a mis-tap, because the fold replays.** `handleUndo`
  (`pad-host.tsx:583-585`) dispatches `core.void`; `append-event.ts:233,266,271`
  rebuilds the stream and `foldMatch` (`core/events.ts:445-468`) runs
  `resolveVoids` (`events.ts:165`) then folds from `module.init` every call. Void
  an innings' only ball and `createInnings(...,"fine")` never runs — the innings
  is not "reset to coarse", it is never opened. R2's per-event void takes the
  identical path (`assertUndoTarget`, `server/usecases/scoring.ts:154-174`, never
  restricts to the tail). **This was untested** — `cricket.test.ts` has zero
  `core.void` and apps/web's v3 void tests are generic plumbing — so the Q1 gate
  rested entirely on unverified behaviour. R2b ships that regression test.
- **"THREE granularities" is wrong — cricket has TWO scoring modes.** The R2b
  row above (and the brief) say cricket needs innings totals, over-by-over and
  ball-by-ball. The engine models only two: `createInnings(state, fidelity)`
  (`cricket.ts:661`) takes `"fine"` (ball-by-ball, driven by `cricket.ball`) or
  `"coarse"` (driven by `cricket.innings.summary`, via `applySummary`,
  `:1394-1454`). **"Innings totals" is not a third mode** — it is the SAME
  coarse path with `partial` omitted and the event posted ONCE with the final
  numbers, which closes the innings immediately; over-by-over is the same event
  with `partial: true` posted repeatedly, leaving the innings open to
  auto-close. So R2b's one tile delivers both: tap it once at the end, or once
  per over. Nothing was ever missing for "innings totals", and there is nothing
  separate to build or retire for it.
- **Nothing on screen tells a scorer which mode an innings is in.** It is
  inferred purely from which tiles are present (over tile vs ball tiles). The
  fold locks it on the first event and only an undo/void reverses it, so a
  scorer who does not know the rule cannot discover it from the pad. Not fixed
  in R2b — no owner ruling exists for what the indicator should say, and
  inventing one unasked would ship copy on eleven skins' worth of chassis. Open
  question for the owner, carried to R8's sweep unless ruled sooner.
  (Unrelated to the 0–3 **fidelity band**, which gates plan entitlements and is
  a different concept wearing a similar word — do not conflate them.)
- **The guided-sheet renderer has no numeric step.** `GuidedSheetStep` is
  `choice | person` only (`v3/types.ts:122,152-154`); the generic More-sheet
  `action-form.tsx:141-172` is the only thing in v3 that renders
  `kind: "number"`. R2b adds `SheetNumberStep` to the chassis — a capability
  R3–R7 inherit, so take it from there rather than re-deriving it per sport.
  `buildPayload`'s `answers: Record<string, string>` stays as it is; a number
  step's answer is the decimal string and the SKIN parses it.
- **A defaulted `t` parameter is a tsc-invisible silent-fallback trap.**
  `buildTiles(view, t: TFn = (key) => key)` (`v3/skins/cricket.tsx:642`) defaults
  its translator so ~17 call sites in the skin's own test file compile
  unchanged. Cost: dropping the second argument at the FACTORY wiring
  (`cricketSkinV3`'s `tiles: (view) => buildTiles(view, t)`, `:1198`) type-checks,
  lints, and ships the raw i18n key as the tile's visible label. Review proved
  it by mutating that line — the whole v3 suite stayed **425/425 green**, because
  every `labelText` test called `buildTiles` DIRECTLY with an explicit `t`.
  Closed by a factory-level test (`290f169a8`) mirroring the two-`t` scorebug
  proof; re-mutating now reds exactly one test with `expected
  'pad.cricket.action.endOfOver' to be 'A:pad.cricket.action.endOfOver:6'`.
  `buildScorebug`/`buildDock` (`:531`,`:781`) REQUIRE `t` and have no such gap —
  the asymmetry is convenience only. **R3–R7 skin authors: require `t`.** A
  defaulted translator anywhere else reproduces this exact blind spot.

### R2b — Q2 REVERSED by the owner, same day (2026-08-17)

**Supersedes the Q2 ruling recorded above.** The sheet asks **this over's** runs
and wickets (and balls, defaulting to `bpo`), and the PAD appends them to the
fold's totals before emitting. It no longer asks the scorer to re-key the
innings total every over.

- **Owner's reason:** re-keying `113` every over to add `8` is the worse trade,
  and the scorer thinks in per-over terms, not running totals.
- **The objection that was raised and overruled:** `cricket.innings.summary`
  REPLACES totals (`cricket.ts:1445-1451`) behind a "may not decrease" guard
  (`:1416-1426`), so the pad must compute `base + delta` itself, and an
  arithmetic bug there produces a total that is still HIGHER than before —
  it passes the monotone guard and drifts wrong permanently with nothing to
  catch it. Mitigation shipped instead of the refusal: the `hint` "before"
  anchor (`24/1`) stays on every step and is now load-bearing rather than
  decorative — it is the only place the scorer sees what the delta is added
  to — plus an explicit `buildPayload` test asserting the ABSOLUTE emitted
  totals, mutation-proved.
- **Staleness is NOT a new risk introduced by this.** `pad-host.tsx:548` freezes
  the resolved sheet at tap time, so `buildPayload` closes over the fold as of
  the tap either way; the old design's `initial: runs` prefill came from the
  same snapshot. Checked before the change, not assumed.
- **Extras cannot push the balls field past `bpo`** — owner asked, and the
  answer is no action needed. The field is `legalBalls`, and wides/no-balls are
  not legal deliveries by cricket's own definition, so a completed over is
  always exactly `bpo` legal balls (6 for T20, **5 for the Hundred** —
  `cricket.ts:2811`) however many extras were bowled alongside. Their runs fold
  into the single runs number; there is no separate extras field at this
  fidelity. `max: bpo` on the balls step; below `bpo` stays legal because an
  innings can end mid-over.

### R2b — live tile audit, 2026-08-17: 4 defects in R2-era cricket tiles

Owner asked "have you tried all these options?" of the No-ball / Bye / Leg bye /
Penalty / Review / Retire / Close innings / More row. Answer was no — and the
audit that followed found that **none of those eight tiles had ANY e2e
coverage**, and their unit tests are spec-builder assertions in
`environment: "node"`, so nothing had ever rendered or tapped one. Penalty had
no test of any kind. A live browser pass against the prod build found four
defects; all eight tiles DO open, all have a Cancel that provably does not
dispatch (checked against the ledger, not the UI closing), and no raw i18n key
leaks.

1. **HIGH — the bowler default blocks the first tap of EVERY over.** Covered in
   its own section below; broader than the bowler chip, since any instant-fire
   tile 422s at a boundary.
2. **HIGH — Close innings leaves a dead but fully tappable grid.**
   `currentInnings()` (`cricket.tsx:207-210`) falls back to the JUST-CLOSED
   innings when none is open, and `buildTiles`/`buildContext`/`buildSwap` never
   check `.closed`. Every tile stays visible; every tap 422s with "over/
   ballInOver do not match the ledger", which never mentions the closure. No
   tile opens the next innings, so the scorer is stuck. Reversible by
   `core.void` on the close event (verified live).
3. **MEDIUM — Penalty always fires exactly 1 run.** `extraPayload` hardcodes
   `runs = 1` (`cricket.tsx:316-318`) for every member of `MINOR_EXTRA_KINDS`
   (`:688-696`), with nothing to adjust it. **A penalty is 5 runs under Law 41**,
   so that tile cannot record a correct penalty at all. The same hardcoding
   makes 2/3/4-run byes and leg byes unrecordable from their tiles.
4. **MEDIUM — Retire has two divergent entry points.** The dedicated tile's
   SwapSheet scopes "off" to the whole batting side rather than the crease
   (engine backstops it at `cricket.ts:1676`) and hardcodes `reason: "other"`.
   The generic More-sheet `cricket.retire` is ALSO reachable — `{swap:true}`
   tiles contribute no type to `dedicatedEventTypes` (`pad-host.tsx:141-151`) —
   and offers all 22 players from BOTH sides with a real reason enum. Two
   flows, and the accidental one has the worse candidate safety.

**Owner rulings, 2026-08-17:**
- **Defect 3 → Penalty defaults to 5; Bye/Leg bye/No-ball gain a runs path for
  the 2/3/4 cases** while the common 1-run tap stays fast.
- **Defect 4 → DROP the dedicated Retire tile, keep the generic More-sheet
  flow** (it already carries the real reason enum). Note the consequence:
  cricket then has no SwapSheet surface at all, so today's swap-sheet Cancel fix
  (`966c7ad4c`) stops being reachable from cricket — it stays because SwapSheet
  is CHASSIS and R3-R7 inherit it, not because cricket still uses it.
- Defect 2 needs no ruling; it is a plain bug.

### R2b — owner ruling 2026-08-17: an ineligible bowler must block the TAP, not the event

Owner: "we shouldn't allow to choose run if bowler already played 4 overs in
t20?" — correct, and it widens defect 1's fix. Today the pad offers the
delivery tiles regardless of bowler eligibility and the ENGINE refuses the
result (`cricket.ts:1161` consecutive overs, `:1170` quota), surfacing as a
generic 422 after the tap. The refusal moves in FRONT of the tap.

- **Visible, blocked, and REASONED — not removed.** The over tile's Q1
  precedent is "gone, not disabled", but that gate is a permanent property of
  the innings; this one is transient and clears the moment a legal bowler is
  picked. Removing every run tile at each over boundary would read as the pad
  breaking. A tile that swallows taps without naming the cause is worse than
  the 422 it replaces.
- **Never hardcode 4.** `maxOversPerBowler` is cfg (`cricket.ts:2804-2811`):
  t20 4, hundred 4, and the field is optional — ABSENT means no quota at all,
  which must not be read as zero. Same for `ballsPerOver` in the
  overs-bowled arithmetic (hundred is 5).
- **Mirror the STRICT path only.** Both engine checks are gated on
  `ctx.strictFold`; replay/import deliberately skip them, because re-cutting a
  recorded innings at a different `ballsPerOver` turns a legal spell into a
  false "consecutive overs" violation. The pad is a live-scoring surface and
  mirrors the strict behaviour; it must not start enforcing quotas on replay.
- Eligibility here means all three engine conditions, not just the quota:
  not `prevOverBowler`, in `bowlingOrder`, and under quota.

### R2b — owner ruling 2026-08-17: never show a generic error where the exact reason is known

Owner: "are you making sure that error msg isn't generic when we have option to
tell exactly why it is wrong". Binding, and it merges with the tap-blocking
ruling above — they are one piece of work, not two.

**Why it is generic today.** All three bowler violations return the SAME engine
code, `INVALID_EVENT` (`cricket.ts:1161`/`:1164`/`:1170`). `ENGINE_ERROR_KEY`
(`lib/scoring-vocab.ts:565`) maps by CODE, not by reason, so consecutive-overs,
quota-exhausted and not-in-lineup all collapse to `engineError.INVALID_EVENT`
— "That entry isn't valid for this match".

**Why the engine's own message must NOT simply be surfaced.** Two blockers, both
deliberate policy rather than oversight:
- It is **English only** — there is no server-side i18n, so a raw engine string
  reaches every locale untranslated. That is the documented reason for the
  `scorepad.rejection.fallback` posture at `use-pad-pipeline.ts:1121-1123`.
- It names a **personId**, not a person: `bowler "091e215a-a9e8-…" cannot bowl
  consecutive overs` is WORSE for a scorer than the generic copy, not better.

**The ruling.** The pad already knows all three conditions, holds `personNames`,
and has 4 locales — so it states the reason BEFORE the tap, naming the bowler:
"James Whitfield has bowled his 4 overs" / "James Whitfield bowled the last
over". A blocked tile that does not say why is no better than the 422 it
replaces. The generic fallback survives ONLY where the client genuinely cannot
know the cause (true server-side races) — that is honest, not lazy.

**Related, and worse than generic — defect 2's message is actively MISLEADING.**
A tap on a closed innings surfaces "over/ballInOver do not match the ledger",
which points at ball sequencing when the real cause is that the innings is
closed. Fixing defect 2 must fix its copy too, not just the tile gating.

**Not chosen (recorded so it is not re-litigated):** adding a structured
reason enum to the engine so the code carries the cause. It is the "proper"
fix and stays available, but it is a cross-cutting engine change touching
every sport's error surface, for a case the pad can already answer locally and
in 4 locales. Revisit only if a second surface needs the same reasons.

### R2b — owner ruling 2026-08-17: extras carry runs via the DOCK, not a sheet

Owner asked how "no-ball and 3 runs" should be entered. Answer: the No-ball
TILE fires instantly as it does today (no-ball, 1 run), and the DOCK that
follows offers bat-run chips (+1/+2/+3/+4/+6). Ignoring the dock leaves the
plain no-ball, so the common case costs exactly what it costs now. Same shape
gives Bye/Leg bye their 2/3/4 runs; Penalty simply defaults to 5.

- **This supersedes the "others get a guided sheet" half of the earlier
  defect-3 ruling.** A sheet would have cost an extra tap on every plain
  no-ball, which is the frequent case. The dock already exists for exactly
  this (`detail-dock.tsx`: a tap commits immediately, then ~6s of OPTIONAL
  chips mutate the still-unsent payload; dismissing early and letting it
  expire produce the identical send). `freeHit` is already a dock chip today.
- **Chips go on the EXTRA's dock, never "tap 3 runs then convert to no-ball".**
  The dock's own contract is enrichment — "never anything the payload
  REQUIRES". Adding bat runs to an already-recorded no-ball is enrichment.
  Converting a LEGAL delivery into an illegal one is not: it changes the over
  count, and that is a semantic change the dock is not meant to carry.
- **Scope correction found by the owner's question.** Defect 3 was recorded as
  "Penalty fires 1 run". It is wider: `extraPayload` (`cricket.tsx:391-393`)
  hardcodes BOTH `bat: 0` and `runs: 1`, so a no-ball with runs off the bat —
  an ordinary delivery worth 4 to the batting side — has NO representation on
  the pad at all. Not refused; unenterable. The engine has always allowed it
  (only WIDES forbid bat runs, `cricket.ts:1229`). The fix needs both numbers,
  not just the extra's own runs.

### R2b — free-hit chip: REMOVE, do not gate (2026-08-17)

Owner hit "3 runs + free hit -> generic error". Cause: the dock's `freeHit`
chip is UNCONDITIONAL (`cricket.tsx:905-921`, a documented R2 scope cut) and
the engine refuses the flag when nothing is pending (`cricket.ts:1224`),
surfacing as the same generic `INVALID_EVENT` copy.

`payload.freeHit` is **not load-bearing** — verified, not assumed. The engine
derives `freeHitPending` purely from the preceding no-ball (`:1363-1368`), and
the free-hit dismissal restriction reads `fine.freeHitPending`, NOT the payload
flag (`:1234`). So the flag is validated but never consumed: the chip's only
possible effect is an error. Replace it with a READ-ONLY "Free hit" indicator
driven by `freeHitPending` — deleting the error class instead of explaining it,
and matching the chassis rule against re-asking what the fold already knows.

Engine facts worth not re-deriving:
- "White ball" is **`cfg.ballsPerInnings !== null`** (`cricket.ts:2950`), not a
  format flag — any innings with a ball limit arms free hits. The hardcoded
  `whiteBall: true` at `:1515` is the SUPER-OVER path, which is correct.
- A free hit is consumed only by a LEGAL delivery. Consecutive no-balls re-arm
  it; a wide in between does not spend it.

### R2b — free hit in the activity log: DERIVE, never send the flag (2026-08-17)

Owner asked for free hits to appear in the activity panel. Approved as a
DERIVED label, not a recorded one.

- **Rejected: auto-sending `freeHit: true` when pending.** It would make the
  activity row trivial and the record durable, but the flag is the ONE part of
  the payload that can disagree with the server, and the client fold is
  non-strict — so any drift reintroduces exactly the rejection class the chip's
  removal deletes. Omitting the flag is always safe; the engine has never
  needed it (`freeHitPending` is derived server-side, and the dismissal rule
  reads `fine.freeHitPending`, `cricket.ts:1234`).
- **`prev` ALONE IS WRONG for this.** A free hit is consumed only by a LEGAL
  delivery, so `no-ball -> wide -> legal ball` leaves that third ball a genuine
  free hit while its immediate predecessor is a wide. Any rule shaped as "was
  the previous row a no-ball?" gets that case silently wrong. It must walk back
  to the last LEGAL delivery. The panel holds every row, so the walk-back is
  available; the skin hook's single `prev` (added for bowler-change notes) is
  not sufficient and must not be stretched to cover this.
- **One implementation, shared with the indicator.** The read-only "Free hit"
  indicator and the activity label answer the SAME question ("was/is this
  delivery a free hit?") and must not be computed twice — a second derivation
  is the placer/verifier fork this repo keeps paying for.
- Payoff worth keeping: because nothing new is recorded, the label appears
  RETROACTIVELY on matches already scored, including the walkthrough fixtures.

### R2b — unplanned fixes (in scope per the fix-inline rule, recorded for the PR)

- **SwapSheet had no way out** (`966c7ad4c`). Found while preparing the live
  walkthrough, not by a test: `SwapSheetProps` (`v3/swap-sheet.tsx:136`) declared
  no `onCancel`, and `pad-host.tsx:683-698` mounted `<SwapSheet>` without one
  while the sibling `<GuidedSheet>` at `:712` got
  `onCancel={() => setOpenSheet(null)}`. A scorer who opened cricket's Retire
  flow by mistake was stuck in it. Fixed on both the off- and on-steps, reusing
  the existing `pad.sheet.cancel` key (already in all 4 locales — no dictionary
  edit owed). **No e2e drives SwapSheet at all** — `git grep -a "Retire"
  apps/web/e2e/` returns 2 hits, both `journey-community.spec.ts` retiring a
  TOURNAMENT, unrelated. That coverage gap is real and belongs to R8.

### R2b — SIGN-OFF: approval-on-merge, 2026-08-18

**What actually happened, recorded plainly because the gate cannot be
reconstructed later.** `_RULES.md` §1 asks for the owner's per-screen verdicts
before merge. The owner did not give per-screen verdicts; they instructed
"merge if CI green", CI went green on `896c8e608`, and R2b merged as
`78191611a` (PR #610). That instruction is the approval of record for this
wave. **No per-screen verdict text exists — none is invented here.**

What the owner DID review, in the session that produced this wave: the live
pad, by hand, across two fixtures (one ball-by-ball part-played, one fresh for
over-by-over). That walkthrough is what found six of the seven defects R2b
fixed — none of which had a failing test. The published sign-off sheet
(https://claude.ai/code/artifact/2afe5c99-e189-4c4e-a07c-0b7bb038761a, rev 2,
seven states × 768/1280, captured after the final rebuild) carries empty
verdict slots and stays that way.

Two screens were flagged in the sheet as wanting a specific look and did NOT
get an individually recorded answer — carry them into R8's closing walkthrough:

- **06-overtile** — every ball tile disappears on a coarse innings. Engine
  constraint, not a design preference, but it has never been confirmed to read
  as intended rather than as missing buttons.
- **07-oversheet** — the field opens at 0 and means THIS over, with the fold's
  own 7/1 above it as the before-anchor. That anchor is the only thing on
  screen telling the scorer what their delta is being added to.

**A merge-gate precedent, stated so it is not silently reused:** a wave may
merge on an explicit owner instruction in place of per-screen verdicts, and
when it does, the decision log says so in these terms. It does not make the
sheet optional, and it does not convert "CI green" into visual sign-off.

### R2c (2026-08-18) — Task 1 design rulings, taken before any code

Full design: `R2c-task1-design.md` (this directory). Three consumers, two
surfaces, and one owner ruling amended. Line pins in that document are against
`main` `7023502a3`.

| # | Ruling | Reason |
|---|---|---|
| 1 | **The narrowing capability is chassis-only. Nothing is added to `PadSpec`.** | `PadSpec` is DATA ONLY — no functions anywhere in the tree (`sport/module.ts:84-95`), enforced by a conformance property that `JSON.stringify`s `padSpec(cfg)` and demands byte-identity. A predicate on `PadAttributionItem` is not additive; it breaks a shipped invariant. |
| 2 | **Scope REMOVES, eligibility DISABLES-with-reason.** Two operations, not one. | Wrong-side candidates (11 batters in a bowler picker) are noise nobody expects — remove. In-scope-but-blocked candidates are exactly R2b's binding "visible, blocked, and REASONED — not removed" ruling, applied to a candidate list instead of a tile. Collapsing them forces a bad answer either way: remove-all loses the reason, disable-all renders 22 chips of which 20 are dead at 320px. |
| 3 | **Defect 4's ruling is AMENDED.** A Retire TILE comes back, opening a `GuidedSheetSpec`. | R2b ruled "drop the dedicated Retire tile, keep the generic More-sheet flow" because the tile hardcoded `reason: "other"` and scoped "off" to the whole batting side, while the generic form at least had a real reason enum. Neither fault survives here: the new flow has the reason enum AND crease-narrowed candidates, and stays ONE entry point because `dedicatedEventTypes` (`pad-host.tsx:141-151`) drops the generic one automatically. The audit compared two flawed flows and kept the less-bad one; this is the option neither was. Owner amended explicitly. |
| 4 | **Two engine exports, not two more forks.** | Authorised by the R2c brief itself, not a new grant. `eligibleBowlers` (`cricket.ts:1825-1836`) is private and is exactly `order.filter(<the skin's isEligibleOverBowler mirror>)`; R2b declined the export and paid for it with a byte-for-byte review verification. `reviewsRemaining` is new — the quota rule is ALREADY forked twice inside the engine (`applyReview` `:1805-1807`, generator `:3484-3486`), and a pad copy would be the third. |

### R2c — false premise found (verified on `main` `7023502a3`, before any code)

- **Task 4 is NOT a step-ordering problem.** The brief says the reviewing side
  "is not known until a LATER step of the sheet, so the quota cannot be checked
  when the first step is built […] If the answer is to reorder the sheet's
  steps, say so and get it ruled before building." Three counts against it:
  both sides' quotas are readable from `view` at `sheets(view)` time
  (`innings.reviews[side].lost` vs `cfg.reviews.perInnings`); the only
  late-bound fact is `kind`, which is already step 1 while `by` is step 3
  (`skins/cricket.tsx:1749-1780`); and `StepPredicate` (`when`) is the shipped
  precedent for an answers-dependent step decision. **No reorder, no ruling
  owed** — and a reorder would have been WORSE, since it would ask the side
  even for umpire reviews, which are never capped (`cricket.ts:1806` gates the
  quota on `kind === "player"`).
- Corollary worth not re-deriving: only an UNSUCCESSFUL player review spends
  one (`outcome === "struck_down"`, `cricket.ts:1810`), so the counter the pad
  must read is `lost`, never `taken`.

### R2c — the gallery is BLIND to a narrowing wave unless it adds states

Found while preparing R2c's sign-off, and it generalises to R3-R7.

The five shared `STATES` in `gallery.capture.ts` (`01-pre`, `02-live`,
`03-scored`, `04-dock`, `05-devicelink`) never open a candidate picker and
never open a guided sheet. R2c's ENTIRE change is what a picker OFFERS — and
a closed picker is pixel-identical before and after. So the wave would have
published a sign-off sheet on which literally nothing it changed was visible,
and the owner would have been asked to rule on screenshots that could not
show the thing being ruled on.

This is the same failure shape as R2's "the captures the owner reviewed
PREDATE the three restored capabilities" caveat, one step earlier: there, the
right screens were captured too soon; here, the right screens are not in the
list at all. A rebuild does not fix the second one.

R2b already built the escape hatch — `EXTRA_STATES` + a sport's own
`captureExtra` hook, added for `06-overtile`/`07-oversheet`. R2c uses the same
hook for `08-bowlerpicker` (the picker OPEN, showing the fielding side only
with the previous over's bowler blocked and reasoned), `09-retiresheet` (the
reinstated tile's sheet) and `10-reviewblocked` (the exhausted side, refused
in the pad).

**Standing instruction for R3-R7:** before publishing a sign-off sheet, ask
which of your wave's changes is visible in the five shared states. Anything
that lives behind a tap — a picker, a sheet, a dock, a disabled control and
its reason — is not, and needs its own `EXTRA_STATES` entry or the gate is
theatre.

### R2c — sign-off sheet published 2026-08-18, verdicts OWED

<https://claude.ai/code/artifact/52bb1534-20fb-40da-a9b7-e19e38a8e5c6> — a NEW
artifact, not a republish of R2b's: this is a different wave's sheet, and
overwriting R2b's URL would orphan the record of what that wave was signed off
on. (R2b's own "republish to the SAME URL" rule was about its own re-captures.)

Ten states x 768/1280, captured after the final rebuild, with each state's
320px overflow measured — **0px on all ten**, including the three new ones,
where a long reason string beside a long name was the real risk.

**Verdict slots are EMPTY and stay that way until the owner fills them.** Merge
is blocked until they are recorded here (`_RULES.md` §1). The reinstated Retire
tile is new surface in this sheet, so it needs a verdict of its own rather than
inheriting R2's.

**One defect this sheet caught that thirteen mutation tests did not.** Every
test asserted the blocked-candidate reason string matched, and it did — but the
reason renders directly beside the name it names, so the chip read
"G R2c BowlerA … G R2c BowlerA bowled the last over and cannot bowl this one
too", and the review option read "Home | Home has no reviews left in this
innings". Correct string, wrong in place. Fixed with name-free variants for the
in-list case (the name-bearing wording stays on the slot-level message, which
stands alone); both are still driven by the same `BowlerBlockReason`, so they
cannot drift on the FACT, only on how much of the sentence the surrounding UI
already supplies. **Recapture after the fix, not before** — the corrected copy
is what the published sheet shows.

Worth generalising for R3-R7: a rendered-page check catches a whole class —
copy that is right in isolation and wrong in context — that no assertion on the
string can reach.

### R3 (2026-08-24) — owner rulings, taken before any code

Scoping session. All four taken against RE-PINNED facts, not the brief's
pre-R1 line numbers.

| # | Decision | Ruling |
|---|---|---|
| R3-1 | How far does the card flow go? | **Three colours inline + reason at band ≥2.** `[Yellow] [Red] [2nd Yellow]` on the tile, person via the dock, and a guided-sheet `Offence?` step that appears ONLY at band ≥2. Rejected the brief's yellow/red, which would leave `second_yellow` and all 13 `CardReason` values unreachable |
| R3-2 | One sub per sheet, or a batched window? | **One pair per SwapSheet, `at` STAMPED from the view clock.** Three subs at one stoppage share a stamp and the engine folds them into one window itself. Rejected batching (needs a new chassis primitive all of R4-R7 inherit) and rejected omitting `at` (the `subWindows` cap would silently never fire) |
| R3-3 | Football's band-2/band-3 entitlement collapse | **Band 3 reuses `scoring.ball_by_ball`.** See the finding below — a NEW key would not have created an upsell |
| R3-4 | Where do the five non-tile event types live? | **The generic More sheet**, cricket's precedent. Tiles: Goal / Card / Sub / Period per side, Pen minor. `football.shot`, `football.sinbin.start`, `football.sinbin.end`, `football.shootout.kick` ride More |

### R3 — false premises found (verified on `main` `94922743f`, before any code)

- **The brief's register claim is WRONG.** `R3-football.md` says "Register rows
  owed: D-4/D-5 on this surface". The register itself
  (`2026-08-15-scoringpad-v3-redesign-design.md:271-272`) routes **D-4 → R7**
  ("console chrome is barred to it") and **D-5 → R2, CLOSED for cricket, R8
  audits the rest**. Neither row is R3's to close. R3 owes nothing to the
  register; do not let a later session re-derive this from the brief.
- **`FootballSub.off` and `.on` are both REQUIRED `PersonId`**
  (`football.ts:254-255`). The brief's "commits instantly, engine fields are
  optional — honest" is true of `FootballGoal` (`scorer`/`assist` both
  `.optional()`, `:213-214`) and FALSE of `football.sub`. A substitution cannot
  be recorded without both people, which is precisely why it is a two-step
  sheet and not a tile.
- **SwapSheet is NOT rejected surface.** A recon pass claimed cricket's dropping
  of it meant R3 could not reuse it. Read the code: cricket dropped it for
  cricket-specific reasons (two divergent entry points into `cricket.retire`,
  an off-picker scoped to the whole side rather than the crease) and its own
  comment says it "stays available for R3-R7"
  (`v3/skins/cricket.tsx:2078-2093`). `SwapSheetSpec`'s docstring names
  `"scorepad.skin.football.swap.off"` and `football.sub` — it was built FOR
  this wave. R3 uses it.
- **Substitutions have TWO independent caps, not one.** `maxSubs` (players,
  `lineupPolicy`, `:1756`) AND `subWindows` (stoppages, `:1211`). A sub consumes
  a window ONLY when `at` is stamped; an unstamped sub consumes none. The
  brief's single refusal example ("3 of 3 subs used") covers `maxSubs` alone —
  the window refusal ("`Home` has used all 3 substitution windows", `:1214`) is
  a second string R3 owes.
- **Bands 2 and 3 gate on the SAME paid boundary.** Every scoring-depth key —
  `scoring.match_timeline`, `scoring.ball_by_ball`, `scoring.rally_by_rally` —
  is granted `community:false / pro:true / business:true` (`V112:48-56`) and
  `pro_plus:true` (`V290:29-31`). So minting a NEW `FeatureKey` for band 3 would
  have produced four identical plan rows and changed nobody's access: the
  paywall sits between band 1 and band 2, and band 2 → band 3 is free on every
  plan. The collapse the owner asked to fix is a LABELLING problem, not an
  upsell one. This was found only after the first ruling was taken on the
  opposite premise, and the ruling was re-taken against it (R3-3).
- **Football bands 2 and 3 differ by exactly ONE event**, `football.shot`
  (`fidelityTiers`, `:2637-2673`). Band 2 already carries the attributed
  timeline, so `stats.player` — floated during scoping — is the WRONG key: it
  describes what band 2 already gives.
- The `fidelityTiers` comment at `:2637` cites **"doc 14 §2"**, a document that
  does not exist — the standing v2-era finding, unchanged.

### R3 — owner ruling 2026-08-24: FIX SwapSheet in the chassis, then use it

R3-5. The brief says "Sub via the Swap-sheet primitive" and the scoping design
was approved on that basis. First real use of `SwapSheet` — cricket dropped it,
so R3 is the first skin ever to reach this path — surfaced five defects, all
verified in the chassis before the ruling was taken:

1. **ONE `SwapSlot` per view.** `pad-host.tsx:564` is
   `props.skin.swap?.(view) ?? null` and `:597` sets a single `swapOpen`
   boolean, so EVERY `{swap:true}` tile opens the SAME sheet and the side comes
   only from `slot.side`. Per-side Sub tiles were unreachable.
2. **A swap tile is NEVER band-filtered.** `tileEventType` (`:233`) returns
   `null` for `{swap:true}`. `football.sub` is absent from `fidelityTiers`
   tiers 0/1, so a band-0 scorer would tap Sub, pick two people, and be refused
   — a dead-end tap, the defect class this programme keeps hitting.
3. **No `candidates`/`blocked` on the swap path.** The ON list is hardcoded
   `pool:"bench"` and OFF `pool:"onfield"`. R2c built per-candidate refusal
   reasons for `ContextSlot` and `SheetChoiceStep`; the swap path never got
   them, so it cannot say WHY a player is ineligible.
4. **`policyOk:false` with no `policyMessage`** falls through to the generic
   `scorepad.attribution.noRoster` copy — a silent refusal.
5. **The picked OFF person is never excluded from the ON list**
   (`swapCandidates`, `swap-sheet.tsx:123`).

The recommendation put to the owner was to sidestep all five by using two
guided sheets (`subHome`/`subAway`) and leaving `SwapSheet` unused. **The owner
ruled the other way: fix the chassis.** Reason it is the better call despite
being the larger one — R4-R7 all inherit the primitive, and a defect left in
place for football is a defect five more skins build on. R3 therefore carries a
CHASSIS sub-wave ahead of the skin itself, and its sign-off surface grows to
include the swap sheet.

Contract changes owed, in this order, before football.tsx is written:
- `swap?(view): SwapSlot[]` — plural. A slot needs its own id.
- `TileSpec.action` `{swap:true}` becomes slot-addressed so per-side tiles reach
  different slots; `swapOpen` becomes the open slot's id, not a boolean.
- `tileEventType` resolves a swap tile's event type so the band filter sees it.
  **Do NOT change the MORE sheet's `null`** — that null is deliberate and
  documented (`:222-232`): MORE is where a LOW-band org reaches its only
  recording action, and band-filtering it would remove that.
- `SwapSlot` gains `candidates`/`blocked`, matching `ContextSlot`'s shape so the
  two narrowing idioms do not fork.
- `swapCandidates` excludes the picked OFF person.

### R3 — the swap contract AFTER the chassis fix (2026-08-24)

Six commits, `37bd18559`..`4eb48f7f1`, one per defect, each red-first. The
shape every later skin builds against:

```ts
SkinDefV3.swap?(view): SwapSlot[]      // PLURAL; [] means "nothing offerable now"; still optional
TileSpec.action = { swap: string }     // names a SwapSlot.id  (was {swap:true})
SwapSlot { id, offLabel, onLabel, side, eventType, policyOk,
           policyMessage?, candidates?, blocked?, buildEvent(off, on) }
```

Four properties that are NOT obvious from the types:

- **`eventType` is declared STATICALLY and nothing checks it against what
  `buildEvent` actually returns.** It has to be static because the band filter
  runs before any person is picked, and `buildEvent(off,on)` cannot answer
  until both are. A skin that declares one type and builds another gets a
  correctly band-filtered tile that dispatches the WRONG event, with no gate.
  **Every skin owes a test pinning the two together.**
- **`candidates`/`blocked` narrow the ON list only** — same semantics and the
  same renderer as `ContextSlot`, deliberately, so the two narrowing idioms
  cannot fork.
- **An unknown slot id fails CLOSED on opening but OPEN on the tile**: nothing
  opens, the tile stays. Deliberate and documented.
- **A refused verdict is still only visible AFTER an off pick.** The reason now
  always renders rather than falling through to the generic `noRoster` copy,
  but the off step itself does not carry it. Narrowing further redesigns the
  flow; recorded, not done.

Defect 5 (the picked OFF player offered as their own replacement) was
**unreachable before defect 4** — onfield and bench are exact complements, so
OFF could not appear in the ON list until `candidates` superseded the pool.
Its regression test is written against a `candidates` list. Both facts are in
the code so nobody deletes the guard as dead.

New chassis-generic key, all four locales, `gen-keys` regenerated:
`pad.swap.refused` — en "That change isn't allowed right now."

**Routed to the football skin task:** `dedicatedEventTypes` now under-reports,
so a swap's event ALSO stays listed in the MORE sheet as a duplicate generic
form. Widening it is a MORE-sheet behaviour change; football is the first wave
that can actually observe the duplicate, so it rules on it.

**Left alone:** `tile-grid.tsx:188,233` carry stale `{swap: true}` comments.
Code correct, comments only.

### R3 — the ribbon takes NO vars; the skin supplies `detail` (2026-08-24)

Found while authoring `pad.football.ribbon.*` (task C, commit `6d5d31079`).
`buildRibbon` calls `padLabel(perSportKey, t, eventType)` with **no vars**, so
an interpolation placeholder written into a ribbon key renders LITERALLY. The
nine football ribbon keys are therefore var-free bases ("Goal recorded", "Card
shown", "Penalty awarded", "Sent to the sin bin"). A line like
"Goal — Rivera, assist Okafor" is the RENDERED result of
`pad.ribbon.withDetail` = `"{base} — {detail}"`, with the **skin** supplying
`detail`. Cricket ships exactly this split.

**Nothing asserts a ribbon string is placeholder-free**, so a skin author who
writes `"Goal — {scorer}"` into a dictionary gets a literal `{scorer}` on
screen and no failing test. `skins/football.tsx` owns `detail`.

Also settled by that task, so the skin does not re-derive them:
- **Refusal copy is NOT a `PAD_LABEL_KEYS` concern.** Cricket's precedent puts
  it at `pad.<sport>.context.<thing>.blocked.<reason>` (plus `.short` variants
  sized to the layout), dictionary-only, authored WITH the skin that consumes
  it. Football's two substitution refusals — `maxSubs` and `subWindows` — are
  therefore owed by the SKIN task, not by i18n.
- **`second_yellow` needs no new copy.** `cardColor.second_yellow` already
  exists in all four locales and is registered at `scoring-vocab.ts:417-418` as
  its own colour beside yellow and red. The skin builds it into `detail`.

### R3 — the verify command in this wave's first three briefs was WRONG

`npx vitest run --root apps/web` was written into three dispatch briefs. On
`src/lib/__tests__` it reports **1743 total / 21 failed**; the correct form,
`cd apps/web && ./node_modules/.bin/vitest run`, reports **1951 / 0**. So the
flag loses 208 tests AND invents 21 ENOENT failures in the copy-truth family
(`src/dictionaries/...`, `content/help/...`). `npx vitest` from the worktree
ROOT does not run at all — the binary lives only at
`apps/web/node_modules/.bin/vitest`.

This is a KNOWN trap (it is failure mode #2 in the standing vitest-masking
note) and it still went into three briefs in one session. Counts reported by
task A and task B1 were taken with it and are re-run at the wave boundary by
the main thread rather than trusted.

### R3-6 — owner ruling 2026-08-24: PER-SPORT VISUAL IDENTITY (reverses the theme lock)

**This reverses a standing ruling. Do not "restore" the lock — read this first.**

On 2026-08-15 (rulings round 3) the owner locked the theme: "daylight shell +
stadium-night LCD scorebug tile", explicitly so eleven skins would share ONE
family identity. R3 asked how ambitious football's visual design should be,
with the theme lock named as the thing the largest option would break. The
owner chose **full per-sport visual identity**.

What that means, stated plainly so it is not softened later:
- A per-sport TOKEN LAYER (`--sport-*`) lands in the chassis. Skins stop being
  purely structural and gain a bounded visual voice.
- Football gets its own palette, type treatment and board furniture.
- **R4-R7 each now owe a visual identity too.** This is a permanent widening of
  every remaining wave, not a one-off for football.
- The programme's "one family identity" rationale is retired. `_RULES.md` and
  the design of record (`2026-08-15-scoringpad-v3-redesign-design.md` §2) both
  still assert it and are now STALE on this point.

**Cricket does NOT have to be re-signed-off, and must not be re-themed as a
side effect.** The option as put to the owner said cricket would need
re-signing-off. That is avoidable and the cheaper design is also the safer one:
build the token layer so that **cricket's current values ARE the default token
set**. Cricket then renders byte-identical, its R2/R2b/R2c sign-offs stand, and
only football overrides. Any implementation that changes a cricket pixel is
wrong. A gallery diff of cricket before/after is the gate on that claim.

### R3 — football's visual direction (design plan, before code)

Calibration first, because the trap here is real: current AI-generated design
clusters on (1) cream + high-contrast serif + terracotta, (2) near-black + one
acid accent, (3) broadsheet hairlines. The locked product theme — night
`#150b36` with lime `#a3e635` — already sits close to (2). Leaning football
FURTHER into lime-on-night would be picking the default and calling it a
decision.

So football moves deliberately away from the family's lime, into its OWN
vernacular:

| token | value | why this, from football's own world |
|---|---|---|
| `--sport-board` | `#0b1f16` | floodlit turf at night: near-black with a green cast, NOT "pitch green" (the generic sports-app answer) |
| `--sport-board-2` | `#122e21` | the band under the scores |
| `--sport-led` | `#ffb703` | the FOURTH OFFICIAL'S BOARD amber — the signature |
| `--sport-caution` | `#ffd60a` | a yellow card is yellow |
| `--sport-dismissal` | `#d00000` | a red card is red |
| `--sport-ink` | `#f2f7f4` | cool off-white, legible on the board in daylight |

**Type:** condensed uppercase for the board, which is matchday-programme and
scoreboard vernacular; tabular/monospaced figures for the scores so a 0->1
change does not jitter the layout. Body face unchanged — the shell stays the
product's.

**Signature:** the strip becomes the **fourth official's added-time board** —
an amber LED panel reading the period and added time. One memorable element,
unmistakably football, and it replaces the dead `Clock —` field rather than
adding furniture. Everything around it stays quiet.

**The aesthetic risk, stated and justified:** football rejects the family's
lime accent. Lime is the PRODUCT's brand colour; amber is the SPORT's. On a
surface used pitch-side under floodlights, the sport's signal should win. If
that reads as fragmentation rather than identity at sign-off, the token layer
makes it a one-line revert per sport.

**Cards carry their own colour, and this is the load-bearing argument.** Yellow
and red are the only colours in football's visual language that CARRY MEANING —
a referee does not raise a "destructive action". Today a red card renders in the
chassis's generic `destructive` red, identical to every other destructive
action, and a yellow renders as neutral `standard`. That is the one place in
this pad where colour is INFORMATION rather than decoration, and the current
build discards it.

### R3 — the gallery's per-width captures can RACE the fold (2026-08-24)

Found on R3's first football capture, and it undermines the sign-off gate
itself, so it is not a football fact.

`02-live` for football came back showing **three different boards at three
widths from one state**: at 320 the pad rendered `Period pre` with ZERO tiles
and "Nothing recorded yet"; at 768 and 1280 the same state rendered `Period H1`
with the full tile set. Same fixture, same capture run, same declared state.

The 320 shot was taken before `core.start` had folded through. Nothing in the
harness failed, and nothing in `manifest.json` records that the widths disagree.

Why this matters more than one bad PNG:

- **320 is the width the horizontal-overflow measurement runs on**, always, even
  when `GALLERY_WIDTHS` narrows the PNG set (the runbook is explicit that the
  measurement must never be excluded). A 320 capture of a pad with NO TILES
  measures the overflow of an empty board and records `0` — a clean number that
  means nothing. That is a false green in the merge gate.
- A reviewer looking only at 768/1280 sees a correct board and signs off; the
  320 evidence in the same sheet contradicts it and reads as a real defect.
  R2c's lesson in a new place: right in isolation, wrong in context.

**Do not treat a `pre`-looking 320 capture as a pad defect without checking the
other two widths first.** The real fix is a settle/assert on the expected phase
before the first screenshot, not a sleep — routed to the e2e/gallery task (D),
which is already re-pointing the football path.

### R3 — debt routed OUT of this wave (found by the entitlement task)

`packages/engine/src/sports/period/kernel.ts:2172-2178` justifies hockey's and
icehockey's OWN band-2 = band-3 entitlement reuse by citing football's shape
verbatim ("football's own `fidelityTiers` already carries
`scoring.match_timeline` on both tier 2 AND tier 3"). R3 made that citation
false. The code is still CORRECT — hockey and icehockey genuinely do share one
key — only the justification is stale. Not fixed here: R3's engine exception is
scoped to football alone. **R6 (period pair) or R8 owns the comment.**

### R3 — where the `at` stamp comes from (found during scoping, 2026-08-24)

R3-2 rules that a substitution is stamped. The source is the FOLD, not a UI
clock: football's state carries `asOf: {period, elapsed}`, which is exactly a
`GameTime` (`packages/engine/src/core/time.ts:51`). v2's own `readClock`
(`skins/football-skin.tsx:115`) already reads it.

Two things a later session must not re-derive:

- **v2 football sends NO `at` on any event** — `git grep -an "at:"` over
  `football-skin.tsx` returns nothing. Every substitution ever recorded through
  the v2 pad is therefore UNSTAMPED, consumes no window, and the `subWindows`
  cap (`football.ts:1211`) **has never fired in production**. R3 is the wave
  that turns it on. Expect the refusal to be new behaviour to the owner in the
  walkthrough, not a regression.
- **`asOf` can be STALE.** `readClock` returns a placeholder when
  `asOf.period !== ` the current phase, precisely so a stamp left over from a
  phase the match has left never reads as "now". R3 applies the same guard: if
  `asOf` is missing or its period is not the current one, **omit `at`** rather
  than stamp a wrong value. `at` is `.optional()` on every football event, so
  omitting is legal; the cost is that the sub consumes no window, which is the
  honest failure — a WRONG window silently mis-attributes a stoppage. Do not
  "fix" this later by stamping unconditionally.

`pad-host.tsx:817` already carries chassis support for window elapsed, restored
so R3-R6 inherit it.

### R3 — the entitlement change, scoped

`fidelityEntitlements` (`:2390`) and `fidelityTiers` tier 3 (`:2672`) are TWO
hand-kept literals that must move in lockstep; neither is derived from the
other. Band 3 flips to `scoring.ball_by_ball`, band 2 keeps
`scoring.match_timeline`. No Flyway migration, no `entitlement-domains` entry,
no `i18n:gen-keys` regen, no 4-locale marketing copy — the key already exists
and is already granted on the identical boundary. `padSpec` is NOT in
`schema-snapshot.test.ts`, so no module version bump and no golden re-baseline
(`schema-snapshot.test.ts:64-68` covers `configSchema`/`eventSchema`/state
only). This is a deliberate exception to R3's own "do NOT touch: engine" line
and must be stated as such in the PR body, the way R2b recorded
`nextBattingSide`.

Accepted cost, recorded so nobody re-opens it: the `/pricing` matrix now shows
ONE "ball by ball" bullet covering both cricket deliveries and football shots.

### R3/B2 — the skin task's own rulings (2026-08-24)

The football skin landed (`v3/skins/football.tsx`, registry flipped, football
and cricket now both v3 and the other nine legacy). Two rulings the chassis
wave routed here, and three defects the skin was the first surface able to
observe. All five are fixed IN this wave — the standing "don't raise new
issues" rule — and each is small, additive and separately committed.

**Ruled: `dedicatedEventTypes` DOES resolve a swap tile (the routed defect).**
`football.sub` used to appear both on its Sub tile and again as a generic
More-sheet form. Fixed rather than lived with, because that generic form
bypasses everything the swap sheet exists to give — the `lineupPolicy`
verdict, the narrowed on/off lists, the already-substituted reason, and the
skin's stale-`asOf` guard on `at`. It is the same two-divergent-entry-points
defect R2c closed for `cricket.retire`. The old justification ("a swap's event
cannot be known statically") died with defect 3's `SwapSlot.eventType`; only
the slot table was missing, and it is now a REQUIRED third parameter (a
default would silently reinstate the duplicate for a forgetful caller).
Cricket declares no swap and passes `[]`.

**Ruled: the `eventType` ↔ `buildEvent` pin is the SKIN's, and it now exists.**
`skins/__tests__/football.test.ts` asserts, per slot, that
`buildEvent(off, on).type === slot.eventType` and that the type is one the
engine's own `eventSchemas` declares. Mutation-proved (declaring
`core.lineup.substitution` while building `football.sub` reds it).

**Three defects football was the first sport able to observe:**

1. **`squadStateOf` read `state.squads` blind.** That field name is NOT
   reserved for the kernel's adopted `SquadState`: football keeps its own
   `{onPitch,bench,offUsed,sentOff}` projection there, with no `.members`
   anywhere. Every consumer reads `.members`, so this THREW (not "returned a
   wrong list") on football's first swap/person tap. Fixed by reusing
   `isSquadState` — the identical structural guard the LEGACY lane has carried
   for this exact sport since S10 (attribution-picker.tsx), never a second
   check that could disagree with it.
2. **The swap sheet's OFF list had no scope.** With the fix above, football's
   `view.squads` is `initSquads(lineups)` — the KICKOFF sheet, which never
   moves. One substitution later the off picker offers the player who came off
   and hides the one who came on. `SwapSlot.offCandidates` (the additive field
   the R3 chassis wave already priced in) closes it; `offBlocked` was NOT
   minted — no caller, no test that could fail.
3. **A dock chip could not carry a person's name.** `DockChip.label` is an
   i18n key resolved through `t()`; football's goal dock is the first whose
   chips name people. `DockChip.labelText` is the same key-plus-text pair
   `TileSpec.labelText`/`ContextSlot.message`/`WhoLine.servingLabel` already
   establish. Proved through a real render, not a pure helper.

**Two skin-side decisions worth not re-deriving:**

- **A tile is withheld above the ACTIVE band, not just the entitled one.**
  `filterTilesByBand` (chassis) filters on ENTITLED bands while `buildPadView`
  drops any action whose band exceeds the ACTIVE band — so an entitled org
  scoring at band 0 would see card/sub/pen tiles and every tap would throw
  through `createSkinDispatch`. The skin mirrors `padSpec(cfg).fidelity` as
  `EVENT_BAND` (pinned against the engine in its test) and withholds them.
  This is a CHASSIS-shaped gap that also affects cricket; not fixed here.
- **Below band 2 the card tile dispatches nothing because it is withheld
  entirely.** `GuidedSheet` renders `null` when no step is visible, so a tile
  opening a fully `when`-gated-off sheet is a tap with no visible response at
  all. Any later skin gating a single-step sheet must gate the TILE too.

**Engine asymmetry found, NOT worked around (R6/R8 or a later engine wave):**
`applyCard` accepts a card in phase `"pre"` (a pre-kickoff red is explicitly
legal, football.md §9) but `padSpec(cfg)` declares no pre-phase panel — every
football panel is `phase: "live"` — and `buildPadView` drops a panel whose
phase is not current, so `createSkinDispatch` refuses ANY dispatch at pre/post.
A pre-kickoff card is therefore unreachable from any declared pad surface, v2
and v3 alike. The skin declares every tile `phases: ["live"]` rather than
shipping a tile that throws on tap.

**Copy:** 22 new keys × 4 locales, `i18n:gen-keys` regenerated. The nine
ribbon bases stay var-free; the skin supplies `detail`, and
`cardColor.second_yellow` was reused rather than re-minted, exactly as task C
recorded.

### R2c — SIGN-OFF: approval-on-merge, 2026-08-18

**What actually happened, recorded plainly because the gate cannot be
reconstructed later.** `_RULES.md` §1 asks for the owner's per-screen verdicts
before merge. The owner did not give per-screen verdicts; the sheet was
published (link above) and the owner instructed "merge". **That instruction is
the approval of record for this wave. No per-screen verdict text exists — none
is invented here.** The sheet's verdict slots stay empty.

This is the SECOND use of the precedent R2b set one day earlier, and the second
use is worth noting as such: a precedent used once is an exception, used twice
it is drifting into the default. The rule it was written with still stands — it
does not make the sheet optional, and it does not convert "CI green" into
visual sign-off.

Not covered by that approval, and therefore still owed by a later wave:
- **The reinstated Retire tile is new surface** (state `09-retiresheet`) and has
  no individual verdict. R2's own sign-off record carries two screens in the
  same position; add this to R8's closing walkthrough.
- **`08-bowlerpicker` / `10-reviewblocked`** likewise — the blocked-candidate
  treatment (visible, disabled, reason beside the name) is a new visual idiom
  eleven skins will inherit, and it has never had an individual ruling.

Unlike R2b, this wave was NOT merged on "CI green" — see the PR for what CI
actually reported, since neither smoke (PR-only) nor the seven-width e2e had
ever run against this branch at the point the instruction was given.
