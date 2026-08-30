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
| R3 | `R3-football.md` | R1 | **MERGED #643 `bcc726300`** (2026-08-25). Pre-merge state, kept for the record: **SIGNED OFF + PR RAISED** 2026-08-25 — worktree `.claude/worktrees/r3-football`, branch `feat/scorepad-v3-r3-football`, 51 commits rebased onto `origin/main`. All tasks A-F committed; five review rounds run and closed (round 5 CLEAN). Owner visual sign-off **15/15 APPROVE**, recorded below — that record is the merge gate, not the sheet. Do not treat any count in this row as a gate: the main thread re-runs the boundary gate itself. One thing NOT to re-derive: the two-step goal dock shipped INERT past unit tests and the gallery; see the inert-dock section at the end of this file before touching `DetailDock`/`pad-host` docks. |
| R4 | `R4-tennis.md` | R1 | **MERGED #649 `5f2951945`** (2026-08-26) — this row read `IN FLIGHT` on merged main until R3.5 corrected it, while the Order table on `main` still read `TODO`: two rows for one wave, both wrong, found by R3.5's planning scout. Pre-merge state kept for the record: worktree `.claude/worktrees/r4-tennis`, branch `feat/scorepad-v3-r4-tennis` off `origin/main` `9080cb959`. Four owner rulings taken before any code (R4-1..R4-4 below); six false premises found in the brief and the register, one of which (D-2) removes the programme's only engine item as written. |
| R3.5 | `R3.5-deciders.md` | R2, R3, R4 (chassis shape) | **MERGED #667 `177f04976`** (2026-08-26); the tennis match-tie-break walkthrough followed as #670 `74fe088ae` and the walkthrough project + CI leg as #671 `addd126c5`. This row read `IN FLIGHT` until R5 corrected it — the SAME stale-row class R3.5 itself found for R4 two rows up, so the Order table has now gone stale on three consecutive waves; re-read `git log`, never this column. Pre-merge state kept for the record: worktree `.claude/worktrees/r35-deciders`, branch `feat/scorepad-v3-r35-deciders` off `main` `5f2951945`. Remedial: the tie-breakers of the two converted sports. Cricket's super over is **unscoreable on the pad** (15/16 tiles disabled, the More escape hatch suppressed by a chassis bug) and football's shoot-out is recordable but illegible. Five rulings taken before any code (R3.5-1..R3.5-5 below), one of which AMENDS R3-4 for the `SHOOTOUT` phase only. Root cause of the whole class: **the gallery harness has no tie-break state**, so neither R2's nor R3's visual sign-off could ever have caught it — task A closes that first. **Task A DONE `72087a19e`**: four states (`11-superover`, `12-superover-decided`, `11-shootout`, `12-shootout-decided`) plus both live decider consoles in the seven-width matrix. BEFORE-captures published: https://claude.ai/code/artifact/ce2fa1b7-14be-4b06-aad5-b8cf0f878239 — gate re-run in the MAIN THREAD, not taken from the implementer: v3 unit 1028/1028, 0 failed suites; `turbo typecheck --force` EXIT=0, 2/2, **0 cached**; `turbo lint --force` 0 errors / 116 warnings (all pre-existing, none in the touched files). Note for R5+: R4 tennis already captures its own tie-break (`14-serveafterbreaker`/`15-breakerdock`/`16-breakermore`) — the gap was cricket's and football's only. **Task B DONE `ee6e4abe0`** (chassis, after a failed round 1 `82607141f`): a disabled tile no longer claims its event type — AND neither does a sheet whose every opening tile is disabled. Round 1 shipped the tile guard alone and **achieved nothing**, because cricket's `wicket` SHEET declares `cricket.superover.ball` and `dedicatedEventTypes` claimed every sheet's event unconditionally. Caught only by probing a REAL folded super over; the five synthetic-tile unit tests were green. Gate after: v3 1036/1036, `GATE_FILTER= gate` 4/4 **0 cached**, 0 errors. **Task C DONE** `9cbd44dc2` (engine) + `a7804cb6d` (skin) + `ab0cea71e` (e2e) + `2d16cbcbe` (gallery probes): the blocker is gone. `activeInnings<T>()` exported from the cricket module and consumed by BOTH `cricketPosition` and the skin, per ruling R3.5-3 — one definition, no second copy. Verified independently in the main thread against real folds, BOTH lanes: fine lane scorebug `6/0`/`0.2` (was `150/7`/`20.0`), RR 18.0 (was 6.0), bowler H-10 (was H-1), 0 disabled tiles (was 15), 0 closure messages (was 3), no stale target; coarse lane now offers all 18 tiles (was: no delivery tiles at all). Gate: v3 1058/1058, engine 4117/4130 with **no golden re-baseline**, `turbo typecheck lint --force` 4/4 **0 cached** 0 errors, cricket+football gallery green at 0px overflow. Before/after sheet: https://claude.ai/code/artifact/ce2fa1b7-14be-4b06-aad5-b8cf0f878239 **FOOTBALL PASS (D+E+F+H+J) DONE** `f00dedcf9`+`b83145622`+`b63581c4b`+`877fa04b3`, batched because all five touch `skins/football.tsx`, the four dictionaries and one `i18n:gen-keys` regen. Verified visually in the main thread: scorebug reads `HOME 1 (2)` / `AWAY 1 (1)` agreeing with its own headline; two LED panels (`PERIOD SHOOT-OUT`, `NEXT KICKER HOME`); kick tiles present with the wrong-turn side dimmed; activity rows read `Shoot-out kick recorded — Away · Scored`. Gate: v3 1088/1088, engine 4122/4135 **no golden re-baseline**, `turbo typecheck lint --force` 4/4 **0 cached** 0 errors, i18n 4250 x 4 locales. R3-4 is now AMENDED per R3.5-5 — `football.shootout.kick` has dedicated tiles in `SHOOTOUT` only; it rides More in every other phase, unchanged. **Tasks G+I+accessibility DONE** `b7a3d3713`+`524646af7`+`1f65b0f19`: a decided fixture now names the winner and the method on the public fixture page, the organiser console and the WhatsApp share text (one shared `decidedOutcomeText()`, `lib/scoring-vocab.ts` — the v3 pad unmounts on decide, so neither surface could be the pad); group-stage `cfg.points.shootoutWin`/`shootoutLoss` (R3.5-4) reach an organiser via two `match-rules.tsx` fields nested inside `points`, proven against a real decided fixture's standings row, not just the config round-trip; the false-premises "vs" WCAG failure noted below is FIXED (`text-slate-400` → `text-slate-600`, 2.63:1 → 7.58:1) and pinned by a computed-ratio test, owner ruling granted this session. Gate: engine 4123/4136 (+1, F21 regression guard, no golden re-baseline), v3 unit UNCHANGED 1088/1088 (neither task touches `scorepad/v3`), `GATE_FILTER= gate` 4/4 **0 cached** 0 errors 116 warnings (all pre-existing), i18n 5131 x 4 locales, football+cricket v3 e2e 37/37 plus both gallery probes (`gallery: Football`/`gallery: Cricket`) green at 0px overflow, organiser console + public page visually verified desktop/320/768. |
| R5 | `R5-racquet-split.md` | R1 | **IN FLIGHT** 2026-08-27 — worktree `.claude/worktrees/r5-racquet`, branch `feat/scorepad-v3-r5-racquet-split` off `main` `addd126c5`. Four rulings taken before any code (R5-1..R5-4 below); THREE false premises found in the brief, one of which (FP-1) changes what the wave IS — D-17 is an engine gap, not a render bug. |
| R6 | `R6-period-pair.md` | R1 | TODO |
| R7 | `R7-universal-console.md` + plan `docs/superpowers/plans/2026-08-30-scorepad-v3-r7-universal-console.md` | R1 (chrome parts benefit from R2–R6 but do not block); **the totality flip alone is gated on R6 merging** | **SCOPED, rulings taken 2026-08-30** — worktree `.claude/worktrees/r7-console`, branch `feat/scorepad-v3-r7-universal-console` off `e23dcf241`, env label `r7`. Runs CONCURRENTLY with R6 by owner ruling, under the written file contract in the R7 section below. Eight rulings (R7-1…R7-8) and **six false premises** taken before any code — two of which change what the wave IS: there is no universal fallback branch to delete (`pad-renderer.tsx` is sport-agnostic), and `resolvePositions` has zero production callers. Do NOT trust this column on the next wave either — it has now been stale on four consecutive waves (R4, R3.5, R5, and R5 again after merge). |
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

## R3.5 — rulings taken before any code (2026-08-26)

Wave file: `R3.5-deciders.md`. Evidence for every claim below is a real fold or
a real browser, re-verified on merged main `5f2951945`, not carried over from
the review that opened the wave.

| # | Decision | Ruling |
|---|---|---|
| R3.5-1 | One wave, or hotfix the cricket blocker separately? | **One wave, all findings.** The blocker is task C inside it, not a carve-out |
| R3.5-2 | Sequence against R4 | **After R4 merges.** Taken while R4 was 34 commits in flight and actively rewriting `dedicatedEventTypes`; R4 merged during design, so the wave starts unblocked with no rebase owed |
| R3.5-3 | Where does "which innings am I scoring" live? | **The engine exports it; the skin consumes it.** NOT a second copy of the switch `cricketPosition` already performs. The skin already imports `eligibleBowlers` / `nextBattingSide` / `reviewsRemaining` from the cricket module and `dueBattingSide` already calls one to mirror innings sequencing — the super over is simply the case nobody extended. Rejected: widening the skin's own shape alone (a hand-copied derivation, this repo's named recurring defect); rejected: a chassis `decider()` for every sport (cricket's decider is an innings, football's a tally, tennis's a game) |
| R3.5-4 | `cfg.shootoutWin` / `cfg.shootoutLoss` have ZERO references in `apps/web` | **IN SCOPE** (task I). A group stage decided on kicks awards flat points today and nothing surfaces it. Widens blast radius past the pad into standings, so asked per `_RULES.md` §1 and granted |
| R3.5-5 | Does the shoot-out kick get its own tile? | **R3-4 AMENDED, `SHOOTOUT` phase ONLY.** Phase-gated kick tiles in the space the Goal tiles vacate. R3-4 stands everywhere else — it placed four *rare* types in More, and in this phase the rare type is the whole match |
| R3.5-6 | Group-stage shoot-out points (task I): validate the pair, or document it? | **Documented in both fields' `help` text**, not enforced by an interactive validator. `match-rules.tsx`/`MatchRuleFields` has no validation-error channel today — adding one is disproportionate to a UI-reach task — and the asymmetric case (F21) is already safe: the unset side just falls back to a normal win/loss, it does not corrupt anything |

### R3.5 — false premises found (verified in the tree, before any code)

- **REBASED onto `origin/main` 2026-08-26 (12 commits in, 28 ours out), tag
  `r35-prerebase` kept.** One trivial conflict (`mobile.spec.ts`, both sides
  added an import — both kept). The four dictionaries and the GENERATED
  `lib/i18n-keys.ts` auto-merged; regenerating produced a byte-identical file
  and `i18n:check` is clean at 5285 keys x 4, so the auto-merge matched the
  generator. Post-rebase gate: v3 1088/1088 · engine 4123/4136 · `turbo
  typecheck lint --force` 4/4 **0 cached** 0 errors · v3 e2e **37/37** ·
  cricket+football gallery 2/2 at 0px overflow.
- **The first post-rebase gate FAILED, and it was not our code.** `tsc` could
  not resolve `pino` / `@grpc/grpc-js` from `scripts/bench/lib/**` — files main
  introduced in `#658` after this worktree's install. `pnpm install
  --frozen-lockfile` fixed it. **A rebase that pulls in new root-level scripts
  needs a reinstall before the gate means anything.**
- **`rtk` SWALLOWS `git diff` CONTENT** (`git diff A..B -- path` returned EMPTY
  twice for a file that genuinely differed; `--name-only` survived). This
  produced a false "the accessibility fix was lost in the rebase" reading that
  cost a detour. Use `diff <(git show A:path) <(git show B:path)` to compare
  file content in this repo.

- **`assertDisabledTilesExplained` (`tile-grid.tsx:120`) is a chassis validator NO SKIN RUNS.**
  Its only callers are its own unit tests (`__tests__/tiles.test.ts`). So the
  "a disabled tile owes a context-strip message" rule is declared and inert,
  and football's new wrong-turn kick tile relies on the `NEXT KICKER` LED cue
  instead. Not fixed here — wiring it implicates cricket and tennis too, so it
  is chassis scope. **Recorded as the declared-but-inert class this programme
  keeps producing** (cf. the R3 inert dock, the S10 inert picker).
- **A REAL pre-existing WCAG AA failure was found and deliberately left — NOW
  FIXED, `1f65b0f19` (R3.5 tasks G/I session, 2026-08-26).**
  An unscoped axe run during the football pass hit `fixture-console.tsx`'s "vs"
  separator — `text-slate-400` on white, ~2.6:1 against the 4.5:1 floor. Outside
  the pad, deterministic, not introduced by this wave. The scan was scoped to
  `[data-testid="score-pad"]` matching two existing precedents. **Owner ruling
  owed** per `_RULES.md` §1 (fix widens blast radius → ask first) — **granted
  this session.** Fixed to `text-slate-600` (7.58:1 on white, computed from
  Tailwind v4's actual compiled hex, not the classic v3 palette); pinned by a
  new describe block in `components/v2/__tests__/history-panel-contrast.test.tsx`
  that computes both ratios and reads `fixture-console.tsx`'s own source so a
  reintroduction of `slate-400`/`slate-500` reds. A follow-up unscoped axe
  re-run confirms this ONE finding is gone. **Several OTHER pre-existing
  `slate-400`/`slate-300` contrast issues remain on the SAME page** (lineup
  roster "N/11 starting" counts, batting-order numbers, the activity ledger's
  timestamps and recorder names) — outside this session's approval (only the
  "vs" separator was named), not touched, recorded here for a future ruling.
- **Dedicating an event type to a tile can silently DROP its attribution.**
  Giving `football.shootout.kick` its own tiles removed it from the generic More
  form, and with it the form's `attribution` person field — so the taker became
  unrecordable until a `buildDock` case restored it. Anyone moving a type from
  More onto a tile in R5-R7 inherits this trap.

- **A task's own verify can pass while it breaks another task's.** Task C ran
  `scorepad-v3-cricket.spec.ts` and went green; it had silently reddened the
  GALLERY, whose `11-superover` probe Task A had deliberately pointed at the
  defect (`data-tile-disabled="true"` + the closure message). Only the
  main-thread wave-boundary check caught it. **Re-run the harness a previous
  task pinned, not only the spec the current task edits.**
- **A defect probe must be INVERTED when the defect is fixed, never deleted.**
  Deleting it stops the capture failing; it does nothing to stop the defect
  returning. `11-superover` now pins tiles ENABLED, no closure message, and a
  scorebug reading the super over's own score.
- **The dispatch brief's "flip the :1004 test to `superOver:false` and keep
  every assertion" was itself a false premise**, caught by the implementer: a
  plain tie DECIDES the match, and the v3 pad does not mount at all once a
  fixture is `decided` — so "disabled tiles" is unreachable on that path. The
  original test used `superOver: true` precisely because it is the one config
  that keeps the pad mounted, which its own comment said.

- **THE PLAN'S OWN CASE B4 WAS THE BUG.** It asserted "a sheet still claims a
  type whose only tile is disabled" as correct chassis behaviour. It is not:
  `resolveSheet` has exactly ONE call site (`pad-host.tsx:854`) and is reached
  only from a tile tap, so a sheet whose every opening tile is disabled is as
  unreachable as they are. Task B round 1 implemented B4 faithfully, passed all
  five of its unit tests, and left the defect exactly where it was. **A
  synthetic-tile test is a mirror, and a mirror agrees with itself** — the same
  lesson `_football-fold.ts`'s header records for R3, re-learned here at the
  cost of a round. Every chassis assertion in this wave now runs against a real
  `foldMatch` state.
- **Do NOT widen that fix to untiled sheets** (case B4b, pinned by a test).
  Cricket's `overSummary` sheet has no opening tile in the fine lane; un-claiming
  it would surface `cricket.innings.summary` in More during a fine innings, where
  the fold refuses it (`cricket.ts:1402-1404`) — a new dead-end path of exactly
  the class R3 spent a review round killing. Cricket declares no
  `refusedEventTypes`; that question is R3.5 Task C's or later.

- **Task A found a fifth.** The plan's capture probe for the two decided states
  used `[data-role="v3-headline"]`. `fixture-console.tsx` **unmounts the whole
  scoring section once a fixture is `decided`**, so that probe can never fire.
  Captures now gate on the "Finalize (lock ledger)" button. This is not a
  harness detail: **Task G's decided sentence cannot live on the pad**, because
  by the time it would be true the pad is gone. It belongs on the surface that
  survives the transition.
- **The review's "the shoot-out log cannot say which side kicked" is WRONG, and
  the rendered page is what corrected it.** The read-only audit table names the
  side on every row (`Away … missed`); the SCORER's Activity panel — the one
  carrying the Void buttons — does not. The data was never lost. Task E is
  narrower than the review framed it.

- **"The client cannot import the engine"** — S10's note, carried forward in
  v2's index and still cited. STALE for v3: `skins/cricket.tsx:90` imports three
  runtime helpers from `@seazn/engine/sports/cricket` today. Ruling R3.5-3
  depends on this being false, so a later session must not re-derive it.
- **Two Order rows disagreed about R4.** The row in this file read `IN FLIGHT`
  after R4 had merged; the copy on `main` read `TODO` while it was 34 commits
  deep. Corrected above.
- **"Football's shoot-out tally is invisible"** — the review's own first read,
  and wrong. `pad-host.tsx` renders the engine's `summary.headline`, so the band
  above the scorebug reads `1 — 1 (2–1 pens)`. The real defect is narrower: two
  score readouts on one screen, disagreeing. Recorded because the wrong version
  is the intuitive one and will be re-derived otherwise.
- **The gallery was never blind by omission of a sport — it is blind by omission
  of a STATE.** `01-pre` … `10-reviewblocked`, no tie-break anywhere. R2 and R3
  both signed off legitimately against a harness that could not render the
  screen. This is the reusable lesson, not a cricket one.


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

### R3 — TWO CORRECTIONS to claims recorded earlier in this file (2026-08-24)

Both were written here by the main thread before the code existed, both are
FALSE, and both were caught by the wave's first review pass. Corrected in place
rather than left for a later session to build on.

**CORRECTION 1 — "R3 is the wave that turns `subWindows` on" is FALSE.** The
`at`-stamp section above says v2 sends no `at`, so the window cap has never
fired, and that R3 switches it on. The guard R3 built is correct, but it is
**INERT**: `state.asOf` is written only at `football.ts:2528`, and only from an
event that ALREADY carried `at`. No v3 football surface sends `at` except the
swap, which copies an `asOf` that must pre-exist. On a pad-only stream
`stampOf` always returns `undefined`, the window branch of `subPolicy` never
runs, and `pad.football.context.sub.blocked.subWindows` is UNREACHABLE COPY.
The only bootstrap is a More-sheet sinbin/shot form's own `at.*` fields.
So `subWindows` still does not fire from the pad. Whoever wants it must give
the pad a way to originate a stamp — engine-side, and not R3's.

**F5 CLOSED (2026-08-24) — reachable, but only through the More sheet.** The
sentence above ("the only bootstrap is a More-sheet sinbin/shot form's own
`at.*` fields") was asserted, not shown, and a later session was going to have
to re-derive it. It is CORRECT. The chain, end to end:

1. `padSpec` spreads a shared `...stamp` — `{kind:"enum", path:"at.period"}` and
   `{kind:"number", path:"at.elapsed"}` — across the football actions
   (`football.ts`, `shootoutKickAction` / `penaltyAction` and their neighbours).
2. The generic More form renders by `field.path` and never names the field, so
   grepping the pad for a literal `"at"` finds NOTHING and reads as "no bootstrap
   exists". That grep is the wrong instrument — it is how this was mis-called
   once already.
3. `ActionFormList` submits `buildActionPayload(action, values)`
   (`v3/action-form.tsx`), which is `buildPathObject(entries)`
   (`scorepad/view-model.ts:225-233`) — dotted paths NEST, so `at.period` +
   `at.elapsed` arrive as `{ at: { period, elapsed } }`.
4. `dedicatedEventTypes` (`v3/pad-host.tsx:229`) claims only types owning a
   tile/sheet/swap. Football's board claims goal, card, sub, period, penalty —
   so **`football.shot`, `football.sinbin.start`, `football.sinbin.end` and
   `football.shootout.kick` stay in the More sheet, carrying `at.*`.**
5. Any one of them submitted with the stamp filled sets `state.asOf`
   (`football.ts:2528`). From then on `stampOf` (`skins/football.tsx:319`)
   returns a stamp while `asOf.period === state.phase`, `football.sub` carries
   `at` (`:1135`), windows accumulate, and `SUB_WINDOW_EXCEEDED`
   (`football.ts:1211`) fires at the cfg cap.

So the honest statement is NOT "inert". It is: **the dedicated Sub tile can
never bootstrap the ledger by itself — a scorer must first stamp an unrelated
More-sheet event — and until they do, `pad.football.context.sub.blocked.subWindows`
is unreachable copy.** Whether that is acceptable is a DESIGN question for the
wave that gives football a clock input (R6/R8), not a defect R3 can fix: R3 is
engine-frozen apart from the spent `b00c85162` exception, and originating a
stamp is engine-side work.

No test is added for the More-sheet path here. It would pin a route the next
wave is expected to replace, and the sub-side guard it would exercise is
already covered by the skin's own `at` tests.

**CORRECTION 2 — the ribbon does NOT render "Goal — Rivera, assist Okafor".**
The ribbon section above describes that as the rendered result of
`pad.ribbon.withDetail`. It is not: `buildRibbon` is called with four arguments
and never `detail` (`pad-host.tsx:749`), so `withDetail` never fires on the TOP
ribbon at all. `footballDetail` reaches only the Activity panel. `ribbon.ts` is
untouched by this wave, so the gap is PRE-EXISTING and not football's — but the
description written here was wrong about what a user sees.

**The lesson worth keeping, because it is the third time this shape has cost
this programme:** a claim written into `_INDEX.md` ahead of the code is a
PREDICTION, not a record. Both of these were stated with the same confidence as
the facts around them, and neither was true. Mark predictions as such, or write
them after the code proves them.

### R3 — the review pass that should have happened five tasks earlier

R3 ran FIVE implementers back to back with ZERO review passes before the first
reviewer was dispatched. `_RULES.md` §4 mandates Scout -> Implementer ->
Reviewer -> loop until clean. What that first pass found, in one sweep:

- Three **dead-end taps** (the pad offering what the engine refuses), two of
  them reachable at BAND 0 — the exact class R2b and R2c each fixed in cricket,
  reappearing in football because nobody looked between waves.
- A **cricket pixel change** (`globals.css:1062`, focus ring violet -> lime)
  violating R3-6's binding byte-identity ruling. It survived a dedicated
  identity-proof because that proof ran in a NODE environment and the defect
  lives in the CSS CASCADE.
- **Two false-green tests** — the totality sweep that unions `dedicated` across
  phases while production recomputes per phase, and a `sport-theme` assertion
  comparing two hand-typed constants in the same file with no production symbol
  on either side.

Every one of those was in code whose own suite was green, written by an agent
that also wrote the tests for it. **Test count is not review.** The wave was at
3302 passing tests when the reviewer returned "Needs fixes".

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

### R3/D — the e2e + gallery task's own findings (2026-08-24)

**The fold race is FIXED, and the fix is an assertion, never a sleep.**
`captureState` now takes a `StateProbe` and runs it before the 320 measurement
AND before every width's screenshot, so a capture whose board is not the
declared state FAILS instead of writing a misleading PNG. The shared probe
compares the pad's own rendered event rows against the ledger count the harness
just read — one probe honest for both lanes (v3 `[data-role="v3-activity-row"]`
and the legacy `[data-role="timeline"] [data-event-id]`), because the race was
always "the client has not folded yet", never anything sport-specific.
`manifest.json` gained `padRowsByWidth`, so a published sheet can be PROVED to
be three views of one state rather than three states. Runbook updated.

Football's `04-dock` needed one more thing and it generalises: the v3 Detail
Dock is a ~6s window, so football is the FIRST sport whose dock can close on
its own mid-capture. `GallerySport.dockProbe` is the opt-in for that; the eight
legacy docks are persistent expanded forms with nothing to race. Measured: the
three widths capture comfortably inside the window.

**Four defects/false premises found, three fixed here:**

1. **FIXED — a real WCAG AA failure on football's board.** `TileSpec.sublabel`
   renders at `text-[11px] opacity-70` (`tile-grid.tsx`), and football is the
   first skin ever to put a sublabel on a `primary` tile. White at 70% over
   violet-600 composites to `#d9bdff`: **3.55:1**, under the 4.5 floor — on the
   word that says WHICH SIDE a tile belongs to, i.e. the most load-bearing word
   on a two-lane board. Lifted to 90% (5.02:1). Cricket declares no sublabel at
   all, so no cricket pixel moves. `contrast.test.ts` had measured the SCOREBUG
   exhaustively and never the TILE GRID; it now computes both pairs from
   tile-grid.tsx's own source, mutation-proved.
2. **FIXED — `playwright.config.ts` cited a pin that did not exist.** Its
   carve-out comment has said since #597 that
   `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts` pins "rest is a catch-all"
   and "every file named in PARALLEL_HEAVY is real". **There was no such file
   anywhere in the repo.** Written now, to those properties plus "no spec runs
   nowhere" and "heavy + rest partition the unsliced project"; both mutations
   (a typo'd heavy name, an explicit `rest` testMatch) proved red.
3. **RECORDED, NOT FIXED — the v3 pad cannot record a penalty's `offence`.**
   The v2 pad drew `football.penalty` through the generic ActionForm, which
   rendered every `padSpec` field including the IFAB Law 12 `PenaltyOffence`
   taxonomy (S4/#428). The v3 skin gives the penalty a dedicated two-step sheet
   (`by`, `outcome`) and a dedicated sheet REMOVES its event from More
   (`dedicatedEventTypes`), so there is no second route: `offence` is not
   askable anywhere on the v3 pad. Asymmetric with the CARD, whose own offence
   IS asked at band >=2 (R3-1). The converted test asserts `by` + `outcome` and
   does NOT assert the absence — asserting it would enshrine it. Cost of the
   fix is small and known (one `when: view.band >= 2` step mirroring the card's,
   one new sheet-title key x4 locales; the 8 option labels already exist at
   `ENUM_VOCAB.offence`). Routed to the wave to rule on, not taken unilaterally
   in a test task.
4. **RECORDED, NOT FIXED — the LED board's `Added` item can never render.**
   B4's signature element reads
   `state.periods[periods.length - 1]?.addedMinutes`, but `stampAddedMinutes`
   stamps the period a marker CLOSES and `pushPeriod` immediately appends the
   next one — so the current period never carries added time. The one state
   where it would (`done`, after FT) is `decided`, and `fixture-console.tsx`
   unmounts the pad entirely when decided. The PERIOD item does render, in
   football's amber, and that is what the identity e2e asserts.

**Two traps paid for, so nobody pays again:**
- `FootballCfg.extraTime` is a plain `z.object` whose two fields are BOTH
  required, with the default on the whole object. A division config patched to
  `{ enabled: false }` fails the cfg parse — and because `setDivisionConfigSql`
  writes the column by SQL, nothing validates on the way in: it surfaces as the
  console rendering NO PAD, which reads as a pad defect.
- The `Offence?` step's `view.band >= 2` predicate is **structurally
  unobservable as false through the pad**: `football.card` is itself a band-2
  event, so `buildTiles` withholds the card TILE below band 2 and the sheet is
  unreachable. The e2e proves the honest form — at community band there is no
  card, sub or penalty tile at all, while goal and period remain.

**Coverage now in place:** the four football tests in `scorepad-skins.spec.ts`
and the three in `scorepad-v2.spec.ts` drive the v3 DOM (nothing deleted — the
v2 pad's timeline undo keeps its own coverage through `carrom-pad.spec.ts`),
plus `scorepad-v3-football.spec.ts`: dock narrowing + every chip in the
SUBMITTED payload; all three card colours with `second_yellow` gated on a prior
yellow; the band floor; BOTH substitution caps (`maxSubs` and `subWindows`,
independently reached — the window cap's first coverage anywhere, since v2 sent
no `at` and it has never fired in production); the re-entry block rendered
beside the name; the amber LED board and the caution/dismissal card codes as
RESOLVED COLOURS; and all nine `football.*` types reachable, four via More with
`football.shot` submitted for real and `football.shootout.kick` proved at the
kicks.

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

### R3/E — the review round's fixes, and the four rulings taken inside it (2026-08-24)

The reviewer's verdict was "Needs fixes": four dead-end taps (two reachable at
band 0), a cricket pixel change against R3-6, and two tests that should have
caught them and were false-green. All fixed in-session, two commits
(`b0bb1e230`, `74a912ee2`). What a later wave must not re-derive:

**Ruled: a skin declares what its FOLD refuses, and the More sheet honours it.**
New chassis contract `SkinDefV3.refusedEventTypes?(view)`, and `moreActions`
takes it as a REQUIRED fourth argument beside `dedicated`. The two sets are
NOT unioned into one parameter deliberately — `dedicated` means "already
reachable through a narrowed surface", `refused` means "the fold will not
accept this at all right now", and a later reader must be able to tell which
applied. Required rather than defaulted for the same reason `dedicatedEventTypes`
made `swaps` required: a defaulted argument silently restores the defect.

Why the chassis cannot answer this itself, since it will be asked again: a
`PadGate` on a `padSpec` panel is the ONLY phase rule `buildPadView` can see,
and football keeps six of its phase rules inside `apply` (`isPlayPhase`) with
its panels ungated `phase: "live"`. Its own `PadPhase` mapping then puts
SHOOTOUT in "live" — correctly, it IS a phase of the match — so More listed
goal, sub, shot and both sin-bin forms during the kicks, every one WRONG_PHASE
on tap. A sport whose gates already live in `padSpec` never needs the method;
it fails open when omitted.

**Ruled: the penalty's `offence` returns as a band-2 DOCK, not a third sheet
step.** R3/D routed the gap here to be ruled on and priced it as "one
`when: view.band >= 2` step mirroring the card's". Taken the other way, for two
reasons. The field's own shape decides it: `outcome` is REQUIRED and `offence`
is `.optional()`, so a third step holds a required event hostage to an optional
answer — the D-15 "wasted tap" this chassis exists to remove — while the dock
is where this pad already puts optional enrichment of an event that has already
committed (`ownGoal`/`penalty`, the goal's scorer, the card's person). And the
step form is unshippable from a task barred from `apps/web/e2e/**`:
`scorepad-skins.spec.ts:490` taps `saved` and then polls the ledger, so any
third step hangs it. The dock form needs no e2e edit at all. One new key
(`pad.football.dock.penalty.title`) x4 locales; the eight option labels already
existed at `ENUM_VOCAB.offence`.

**FALSE PREMISE in the review's own E7 item, corrected here.** It reads
"`lineupPolicy` grants `exemptions.concussion` on top … the sheet shows
`policyOk:false` for a substitution the engine would ACCEPT". The exemption
does not widen `football.sub` at all: `applySub` always builds a
`core.lineup.substitution`, and `reduceLineupEvent` consumes an exemption only
for `core.lineup.replacement` — so a `football.sub` at the cap is refused
whatever `concussionSubs` says. The REAL defect is one step to the left, in
`liftSide` (`football.ts:2073`): `subsUsed = max(0, offUsed.length - exemptTotal)`,
because an exempt replacement is permanent and therefore in `offUsed` too. The
pad counted `offUsed` raw, so a side that had ALREADY taken a concussion
replacement was refused its last legal ordinary substitution. Fixed as that
subtraction, proved against a real fold carrying `core.lineup.replacement`.

**ROUTED, NOT FIXED — the pad cannot ORIGINATE a concussion replacement.**
`core.lineup.replacement` is the only event carrying `exemption`, and no
football pad surface sends one (`padSpec` declares no such action; `football.sub`
cannot). So a concussion substitution is unrecordable from v3, exactly as it was
from v2. Engine/`padSpec` work, and R3's single engine exception is spent.
**Owner: R6 (period pair) or R8's sweep**, alongside the `kernel.ts:2172-2178`
stale-comment row already routed there.

**ROUTED, NOT FIXED — the More tile can open an EMPTY sheet at bands 0-1.**
In normal play at band 0 the only band-0 types are goal (a tile), period (a
sheet) and the shoot-out kick (refused outside the kicks), so More has nothing
in it and the tile is still drawn. The host CAN see this (`moreActionsList.length`)
and dropping the tile is four lines — it was NOT taken because the tile is
chassis-wide and cricket is signed off under R3-6's byte-identity ruling: if
cricket's More is ever empty in any cfg/phase/band, that tile silently
disappears from a signed-off screen and the sheet needs re-signing. It is also
a wasted tap, not a dead end that errors. **Owner: R7 (universal console)**,
which owns the chrome and can re-capture cricket in the same wave.

**The cricket pixel, and why the guard against it had to change kind.**
`globals.css`'s `.pad-half:focus-visible { outline-color: var(--sport-led) }` was
UNLAYERED at (0,2,0) and beat the platform ring
`:where(a, button, summary, [role="tab"]):focus-visible` at (0,1,0) — `:where()`
scores ZERO, which B4's own comment misread as "the platform rule is
zero-specificity, so this wins without `!important`". It did win, on every skin.
The Tailwind utility it replaced (`focus-visible:outline-lime-400`) never had:
`@layer utilities` loses to every unlayered rule, so cricket's ring had ALWAYS
been the platform violet and nothing but leaving the layer changed it.

Fixed by scoping the rule to `[data-sport-theme]`, a new attribute emitted by
`PadHostV3` from `sportThemeAttr(skin.key)` — the attribute twin of
`sportThemeStyle`, `undefined` for a sport with no palette. A CSS rule can READ
`var(--sport-led)` but cannot ask whether anyone overrode it, and the default
value is a real colour: that is the whole reason a "paint it in the sport's
colour" rule had no way to leave an un-overriding sport alone. With the scope,
`--sport-led` inside that rule can only ever be an overriding sport's OWN value,
and R4-R7 inherit the behaviour by declaring a palette with no edit to
globals.css.

**A node test CAN see the cascade, if it computes one.** `v3/__tests__/_globals-css.ts`
parses globals.css into rules that carry their layer, conditions, specificity
(with `:where()` zeroed) and source order; `cascadeWinner` returns the rule that
actually wins a property on a described element.
`__tests__/focus-ring-cascade.test.ts` uses it. Its stated limits, which a later
wave must respect rather than quietly widen: it sees NOTHING outside
globals.css — sound for this question only because every Tailwind-generated
utility lands in `@layer utilities` and therefore cannot beat any unlayered rule
it does see, and NOT sound for a question about two utilities — and it throws
rather than guesses on layer-vs-layer ordering and on `>`/`+`/`~`.

**Three tests were false-green; all three now red on the defect they name.**
- `football-dispatch-totality.test.ts` unioned `dedicated` across the live and
  SHOOTOUT states while `pad-host.tsx` recomputes it per state, so its
  no-duplicate assertions passed in exactly the phase where the duplicate
  existed. Rewritten per SITUATION (one cfg, one really-folded state, one band),
  with `football.apply` as the oracle via `__tests__/_football-fold.ts`.
- `sport-theme.test.ts:226` compared two hand-typed constants declared ~90 lines
  apart in the SAME new file — no production symbol on either side, so no edit
  to `sport-theme.ts`, `tokens.ts` or `globals.css` could red it. The chain is
  now class -> (globals.css's own parsed rule) -> token -> (`DEFAULT_SPORT_PALETTE`)
  -> hex, compared against the independent pre-B4 table. And `:328` bound `.pad-*`
  rules BY NAME (`css.toContain(".pad-" + base)`), so `.pad-board { background-color:
  var(--sport-led) }` passed and `.pad-board` was satisfied by the substring
  inside `.pad-board-2`; now matched as a whole class token against parsed
  selectors.
- `contrast.test.ts`'s non-text-tone licence (the `describe` named "the tones are
  NON-TEXT colours, and this is where that stops being a comment" — cited by NAME
  because an earlier `:479` here had already rotted to `:546` by the next commit)
  grepped the literal
  `color: var(--sport-<tone>)` and missed the unspaced form, `color-mix`
  wrappers, arbitrary Tailwind values, inline styles and — the one that matters
  — `var(--pad-tone)`, the indirection every tone actually ships through. It now
  resolves the alias graph out of globals.css to a fixpoint and scans the
  chassis and skin sources too.

**The lesson, stated once because it is the third shape of it this programme has
hit:** every one of these was written by an agent that also wrote its own tests,
and every one of those tests was green. A test that asserts a skin against a
MIRROR of the engine proves the mirror. Where an oracle exists — the fold, the
CSS cascade, a production symbol — the test must go through it.


---

## R3/F — cricket impact, established from a gallery DIFF (2026-08-24)

Task G was dispatched twice to answer "which cricket screens moved from F's
chassis fixes" and stalled at the watchdog both times. Answered here directly.

**Baseline:** `scratchpad/gallery-r3-final`, captured 15:17 — before E
(`b0bb1e230` 15:55) and before every F commit (16:33-17:12). A genuine
pre-wave baseline, not a re-capture of the same code.
**New:** `scratchpad/gallery-r3-final2`, captured off the rebuilt bundle at
HEAD. Both runs 2/2 passed, 45 PNGs each (cricket 30, football 15), 320px
overflow measured on all 15 states and 0px everywhere.

### The byte diff is CONTAMINATED — do not report it as the answer

All 30 cricket PNGs differ by hash, and 44 of 45 overall. That is NOT 44
changed screens. The harness seeds a fixture per run with a per-process `TAG`,
so every fixture name changes between runs (`mt7bjrxorkhp` -> `mt7h9q4cwkxs`)
and the proportional font re-wraps the title, shifting the whole page down.
Compared visually, cricket `01-pre-768` is IDENTICAL apart from that tag.

A hash diff of this gallery measures tag noise. The only instrument that
answers the question is looking at the pixels.

### What actually moved

- **`ad55ec356` (ribbon detail) DOES change cricket.** The recording chip read
  `Ball recorded` before and reads `Ball recorded - Cau...` after — the detail
  suffix every skin already built, now rendered because `buildRibbon` finally
  receives `detail`. Visible on `04-dock` at every width; cricket is a
  SIGNED-OFF sport, so this copy change is owed a re-look.
- **`7ada026e0` (scorebug who-line wrap)** produced no visible cricket change
  in these states: the who-line fits at all three widths in both runs. It
  guards a long unbroken name cricket's fixture does not produce.
- **`8a66c00f6` (dock on screen when it opens)** produced no visible cricket
  change: the WHO'S OUT dock renders in the same place in both runs.
- **`74a912ee2` (E, cricket focus ring) is INVISIBLE to this gallery** and
  always will be — it only paints on `:focus-visible`, and the harness focuses
  nothing before screenshotting. It cannot be signed off from these PNGs. It
  was verified instead by cascade reasoning plus `focus-ring-cascade.test.ts`,
  whose 3 targeted tests go red when the `[data-sport-theme]` scope is
  stripped. Do not read "no visual diff" as "no change" for that commit.

### Consequence for the sign-off sheet

Cricket's `04-dock` (and any state showing the chip) needs the owner's eye
again — one copy change, not a re-review of the sport. Football is new in this
wave and needs all five states reviewed regardless.


---

## R3 — `/code-review` round 3 (2026-08-24): 5 findings, 1 fixed, 2 DISPROVEN

Run against the full branch diff (49 files). Verified each before acting;
three did not survive verification in the form they were reported.

**1. `pad-host.tsx` — `openSwapId` outlives its slot. REPORTED AS REACHABLE; IT
IS NOT.** The mechanism is real: `openSwapId` is set on the tile tap (`:793`)
and cleared only by `onSwap`/`onCancel` (`:1012`/`:1016`), so nothing resets it
when the slot stops resolving. The stated scenario is wrong. It needs a
play -> non-play -> play sequence, and football has none:
`applyPeriod`'s `HT` arm is `pushPeriod(close(), "H2")` (`football.ts:1549`),
and H1 and H2 are BOTH in the skin's `PLAY_PHASES` (`skins/football.tsx:181`),
so the sheet never unmounts at half time. `FT` goes to `ET_H1` (also a play
phase) or to `done`/`SHOOTOUT`, which never return to a play phase. A defensive
reset was written and then REVERTED: no test can fail without it, and this
repo's rule is that every change ships a test that does. Revisit if a wave ever
adds a non-play interval a scorer can leave and re-enter.

**2. `swap-sheet.tsx` — no refusal on the OFF step. ALREADY KNOWN, and pinned.**
Not a new finding. `scorepad-v3-football.spec.ts` (~`:404`) already documents it
as "a known limit of the R3 chassis fix, not an accident", and its e2e exists
specifically so a later change cannot silently "fix" it. A fix was written and
reverted on that basis. It is also bigger than it looks: `policyVerdict` does
not change between steps, so refusing at the OFF step makes the ON step's
refusal branch UNREACHABLE dead code, and breaks four existing tests that reach
it. `SwapSheet` is chassis shared by eleven skins including signed-off cricket,
so this is an owner decision, not a review fix.

**3. `sport-theme.ts` — `SPORT_PALETTES` had a prototype. FIXED.** All three
readers index the table by a bare string, so `SPORT_PALETTES["constructor"]`
answered truthy: `sportThemeAttr` would emit `data-sport-theme="constructor"`
while `sportThemeStyle` emitted no tokens, breaking the pair invariant that
`[data-sport-theme] .pad-half:focus-visible` depends on and dropping the ring
back onto the shared default. Now `Object.create(null)`, matching the choice
`registry.ts` already made for `V3_SKINS` and for the same stated reason.
Unreachable from today's sport keys; now unreachable by construction. Three
tests added, two of which go red against the plain literal (the third is a
deliberate control that passes both ways).

**4. `football.ts` — the entitlement comment overclaimed. NARROWED.** Band 3's
move to `scoring.ball_by_ball` is safe at the PLAN level, and that much was
verified against V112/V290. But entitlements also resolve through
`org_entitlement_overrides` and `competition_passes`, keyed per FEATURE
(V306__entitlement_resolver_parity.sql), so an org holding an override or pass
for `scoring.match_timeline` and not `scoring.ball_by_ball` silently loses band
3. No such row is known to exist and none is created here; the comment now says
plan-level and names the backfill that is owed.

**5. `skins/football.tsx` — 24 dock chips for a goal. OWNER DECISION, not
fixed.** `buildDock` pushes a scorer chip AND an assist chip per on-pitch
player: 24 at 11-a-side, inside a ~6s soft-commit window, against a dock F4
measured at 213px/369px. `block: "nearest"` then reveals only the top edge.
The observation is sound and the arithmetic is right. The fix is a flow change
(scorer first, assist after) that alters how every goal is recorded, which is a
design ruling this review has no standing to make.


---

## R3 — OWNER VISUAL SIGN-OFF, RECORDED (2026-08-24)

`_RULES.md` §1: visual sign-off is a MERGE GATE, and the gate is these
verdicts being written here — not the sheet existing. All fifteen states
**APPROVED**, no changes requested, nothing blocked.

Sheet: https://claude.ai/code/artifact/f1a30e65-076e-41c1-9d1b-2b2953a9391a
Captured from a production build at `2f4ac70c4` (46 commits on
`feat/scorepad-v3-r3-football`), 45 captures, 3 widths each.

| Sport | State | Verdict |
| --- | --- | --- |
| football | 01-pre | APPROVE |
| football | 02-live | APPROVE |
| football | 03-scored | APPROVE |
| football | 04-dock | APPROVE |
| football | 05-devicelink | APPROVE |
| cricket | 01-pre | APPROVE |
| cricket | 02-live | APPROVE |
| cricket | 03-scored | APPROVE |
| cricket | 04-dock | APPROVE |
| cricket | 05-devicelink | APPROVE |
| cricket | 06-overtile | APPROVE |
| cricket | 07-oversheet | APPROVE |
| cricket | 08-bowlerpicker | APPROVE |
| cricket | 09-retiresheet | APPROVE |
| cricket | 10-reviewblocked | APPROVE |

**Cricket was re-signed deliberately, not carried over.** R2's sign-off did
not cover this wave: three R3 commits change chassis code shared by eleven
skins, so cricket's ten states were re-captured from the same build as
football's and re-approved. `04-dock` is the one that genuinely moved — the
recording chip now renders the detail suffix ("Ball recorded — Caught…") that
`ad55ec356` finally passes into `buildRibbon`.

**Three limits were stated ON the sheet and approved with them in view** — they
are not discovered afterwards, and they are the honest boundary of what this
sign-off covers:

1. The crowded 11-a-side goal dock is **not pictured**. The capture fixture
   rosters two or three players a side, so what was approved is the dock's
   SHAPE, not its length. The 24 -> 13/12 chip reduction is covered by unit
   test only.
2. Cricket's focus ring is **invisible to this harness** by construction — it
   paints on `:focus-visible` and the capture focuses nothing. Approved on the
   cascade reasoning and `focus-ring-cascade.test.ts`, not on any pixel.
3. 44 of 45 files differ byte-for-byte from the previous sheet purely because
   the harness re-seeds fixture names per run. That is not 44 changed screens.

**Gate at sign-off:** v3 unit 867/867 (0 files resolving outside the worktree),
engine football 266/266, tsc EXIT=0 from the worktree root, eslint clean, i18n
parity 5010 keys x 4 locales, 320px overflow 0px across all 15 states.

**Merge is no longer blocked on sign-off.** What remains before merge is the PR
itself, whose body owes: smoke deferred to **R8 by name**; the engine exception
`b00c85162` (band 3 -> `scoring.ball_by_ball`) called out as deliberate; and the
entitlement-override backfill this wave records but does not perform.


---

## R3 — rebased onto `origin/main`, and why the sign-off still stands (2026-08-24)

48 commits rebased onto `origin/main` cleanly, no conflicts. Recovery tag
`r3-prerebase` points at the pre-rebase head.

**THE SIGN-OFF RECORD CITES A COMMIT THAT NO LONGER EXISTS.** The section above
says the approved captures came from `2f4ac70c4`. Rebasing rewrote every SHA on
this branch, so that commit is NOT reachable from it any more — a later reader
looking it up finds nothing and cannot tell whether the sheet was real. The
mapping, recorded rather than left to be re-derived:

| Pre-rebase | Post-rebase | What it is |
| --- | --- | --- |
| `2f4ac70c4` | `7baadc9e4` | the build the approved captures came from |
| `790626127` | `34e88ea53` | the sign-off record itself |
| — | `21115f19a` | branch head after the rebase |

**The captures were NOT retaken, and that is a decision with evidence behind
it, not an omission.** Main's four commits (scheduling, exports, public-site,
P9.5) overlap this branch in exactly five files: the four locale dictionaries
and the GENERATED `i18n-keys.ts`. Checked rather than assumed:

- main only ADDED keys — `documents.*`, `board.conflict.*`, `calendar.*`,
  `poster.*`, `export.*`. The single removed line is `export.description.ticket`
  re-added with a trailing comma.
- **Zero `pad.*`, `score.*` or `scorepad.*` keys were touched**, so nothing the
  pad renders changed.
- `i18n:check` parity OK at 5025 keys x 4, and `i18n:gen-keys` is a NO-OP after
  the rebase, so the generated file carries both sides' keys with no drift.

A clean rebase is not evidence of a working tree — it only says the text
merged. Gate re-run at the rebase boundary:

- engine 4088 total / 4075 passed / **0 failed** across 1013 suites
- apps/web 9830 total / 9756 passed / **0 real failures** / 74 pending, across
  3090 suites, 0 files resolving outside the worktree
- tsc EXIT=0 from the worktree ROOT, i18n parity 5025 x 4

**The apps/web run first reported 4 failures, and they were ENVIRONMENTAL.** All
four were in `schedule-build-honours-locks.test.ts`, the suite that solves
through the CP-SAT placement service; without it running those paths fall back
and the assertions go red for a reason that has nothing to do with the code.
This mattered more than usual here and was NOT waved through on the known
signature alone: main's four commits touch `packages/engine/src/scheduling/**`
(P9.5, court windows), so a genuine regression would look identical. Started the
service (`seazn-env up --label r3 --placement`) and re-ran that suite alone:
**12/12**. Environmental, confirmed by re-running rather than by recognising the
shape.

If any pad-facing key ever DOES change on main under a signed-off wave, the
captures are stale and the sign-off has to be retaken — that is the test to
apply, not the fact that a rebase was clean.


---

## R3 — the two-step goal dock SHIPPED INERT, and unit tests could not see it (2026-08-25)

The wave's one near-miss, and the reason `0b709fadd` exists AFTER the sign-off.

The owner ruled 24 chips in a ~6s window undecidable, so `buildDock` was split
to ask one question at a time: scorer chips, then assist chips, keyed on
`held.payload.scorer`. Five unit tests, every one red without the change. **It
never worked in the browser.** Two independent breaks, either alone sufficient:

- `pad-host.tsx`'s `heldSubmit` captured `payload` at TAP time. A chip mutates
  the QUEUE entry through `store.mutateHeld` and never that React state, so
  `buildDock` was re-invoked forever with the ORIGINAL payload.
- `dockController` closed over the `spec` it was constructed with, and
  `DetailDock` rebuilds the controller only when `heldId` changes — so even a
  fresh spec prop was ignored.

**"It uses the same mechanism cricket already uses" was the false premise**, and
it is what stopped the bug being reasoned out. Cricket's no-ball/plain-single
dock genuinely works — its variants are chosen at TILE-TAP time, so each is a
new `heldId` and gets a new controller. Football needed the spec to change
WITHIN one held entry, which nothing supported.

Three things generalise, and none is "add more unit tests":

1. **A pure builder whose output depends on live state is fully testable AND
   fully inert at once.** Unit tests call it directly with whatever state they
   like; they prove the mapping and say NOTHING about re-invocation.
2. **The test that catches it already existed, unrun.**
   `scorepad-v3-football.spec.ts` already taps Penalty -> scorer -> assist in
   sequence and would have failed the moment the split landed. The failure was
   not missing coverage — it was not re-running the e2e that covers the thing
   changed, because units were green and a screenshot looked right.
3. **The gallery cannot see this class of defect.** The capture fixture rosters
   two or three players a side, where a one-step and a two-step dock render
   identically. The sign-off's limit 1 above already said the dock's LENGTH was
   unpictured; this is what that limit costs when it is forgotten.

Fix: `DockController.setSpec(next)` plus a live `current` spec read through
getters, and a `dockStore` wrapper in `pad-host.tsx` that mirrors the mutation
into local `held.payload` so the builder is re-invoked with the advanced value.

### Review round 5 (2026-08-25) — CLEAN, plus three latent MINORs

Reviewed `0b709fadd` in place, confirmed at HEAD (v3 870/870, paths resolved
under the worktree). Verdict CLEAN: 0 blockers, 0 majors. What it confirmed is
worth as much as what it found — **the new `DetailDock` rerender test drives the
real component through the real React-dispatcher harness and fails pre-fix**,
and the pre-existing e2e asserts the DRAINED payload, closing the "mutated a
copy" loophole that made the original bug invisible.

Three MINORs, none reachable today, all of the form "the NEXT skin pays":

- **`setSpec(next: DockSpec)` takes no `null`.** A skin whose `dock()` goes
  spec -> null for the SAME `heldId` would freeze the dock on stale chips
  instead of dismissing it. Neither `buildDock` does this. Widen to
  `DockSpec | null` when a skin needs it.
- **`chip.mutate` is applied TWICE independently** — once through `queue.ts`'s
  `mutateHeld`, once through the local mirror. Correct only because every
  shipped chip is a pure last-write spread (checked all: football's
  person/ownGoal/penalty/offence, cricket's batRun/extraRun) and because
  football's step-gating means step-2 chips do not exist in the DOM until
  step 1 lands. **Nothing in the `DockChip` contract enforces purity.** A
  counter-style mutate would diverge between mirror and store.
- **`controller.setSpec(spec)` is a render-BODY side effect.** Safe today
  because `DetailDock` is unmemoized and this repo has no React Compiler; it
  would silently stop working under a future `memo()` with nothing to catch it.

Selection semantics checked and correct: football's ids are namespaced
(`scorer:`/`assist:`) so no cross-step collision, and `ownGoal`/`penalty` are
meant to stay selected across the step boundary.

**Non-football impact, confirmed rather than assumed:** the `dockStore` wrapper
calls `setHeld` on every landed chip mutation for EVERY skin. Cricket's
`buildDock` output never depends on the mirrored payload (`extraKind` is fixed
at hold time), so no behaviour change — only more render work.

## Swap-sheet OFF-step enforcement — standalone chassis addition (2026-08-25), smoke deferred

Not a numbered wave — no R-prompt file owns this, it is a small opt-in
primitive layered directly on top of the R3 chassis sub-wave above, and it
reuses that wave's `data-role="swap-refusal"` markup verbatim rather than
inventing a second one. Recorded here per `_RULES.md` §5/§6 ("a wave that
defers one [test type] names the wave that owes it") since there is no wave
prompt file for standalone work to record it in instead.

**What shipped** (`c57c7d384`, `d143a01b4`): `scoring.swap_off_step_
enforcement`, a CHASSIS-level entitlement key — not a fidelity-band one, no
`PadSpec` names it. `fidelity.ts`'s `resolveScorePadBootstrap` resolves it
unconditionally via `hasFeatureFn`, merged into the same `entitlements` map
every fidelity-band key already lands in. `pad-host.tsx` threads
`view.entitlements["scoring.swap_off_step_enforcement"] === true` into
`SwapSheet`'s new `enforceOffStep` prop. `swap-sheet.tsx`'s
`shouldRefuseOffStep(policyVerdict, enforceOffStep)` decides: only when an
org has opted in AND the module's own policy verdict is genuinely refused
does the OFF step itself show the ON step's `swap-refusal` markup and copy,
before any candidate is picked. Default (`undefined`/`false`) stays
byte-identical to the R3 chassis behaviour — pinned by
`scorepad-v3-football.spec.ts`'s own maxSubs test as "a known limit of the R3
chassis fix, not an accident": today's OFF step always shows the picker
regardless of verdict, and a refusal only ever surfaces on the ON step.

**Coverage shipped**: unit (`context-swap.test.ts` — `shouldRefuseOffStep`'s
full truth table, plus a `SwapSheet` render matrix crossing refused/ok ×
enforceOffStep true/false/undefined) and e2e
(`scorepad-v3-swap-off-step-enforcement.spec.ts`, two tests against a fresh
org: a refused verdict refuses the OFF step immediately, and — added in a
follow-up review pass — a still-legal substitution completes normally end to
end, both steps unrefused, `football.sub` actually reaching the ledger with
the picked pair). Regression: `scorepad-v3-football.spec.ts` reruns
unmodified, confirming the shared Pro org's pinned default-off behaviour
never moved.

**Smoke — DEFERRED, and why** (reviewer finding on the follow-up review pass,
verified rather than assumed): the key is structurally unreachable from any
HTTP-observable surface. `requiredFeatureForEvent`
(`apps/web/src/server/usecases/fidelity.ts:22-34`) is untouched — it only
ever returns a key named in some `fidelityTiers` entry, and
`scoring.swap_off_step_enforcement` is not one. No route reads this key
directly. `GET /api/orgs/[id]/entitlements` structurally excludes any key
absent from `plan_entitlements`, which this key is BY DESIGN — it is
override-only, no plan grants it. So smoke's HTTP-probe idiom (hit a route,
read a JSON field) has nothing real to assert here: there is no response
body this key would ever appear in, gated or not.

**Who owes it**: nobody today, by construction — this is not a wave deferring
work forward to R4-R8, because no amount of waiting makes the key
HTTP-observable. It becomes assertable only if a future change gives it one
(e.g. an admin entitlements-listing endpoint, or the key moving from
override-only to plan-granted so `GET .../entitlements` would carry it).
Whoever makes that change owns adding the smoke check in the same PR —
recorded here so the gap is not silently rediscovered, or silently skipped,
once that surface exists.

---

## R4 (2026-08-25) — owner rulings, taken before any code

Scoping session, all four taken against RE-PINNED facts on `origin/main`
`9080cb959`, not the brief's pre-R1 line numbers. Two of the four were put to
the owner as A/B choices and came back as "what do you recommend" — the
recommendation and the reason it was taken are recorded here in full, because
a ruling whose reasoning is not written down gets re-litigated by the next
session.

| # | Decision | Ruling |
|---|---|---|
| R4-1 | The brief's `Fault/Let/Code/Retire` minor row — but the engine has no fault and no let event, and §9 bars new event types | **No new events. Drop Fault and Let as tiles; ship `ace / double_fault / winner / ue` as DOCK CHIPS on the point.** `NestedPointMeta.kind` (`nested/kernel.ts:200-205`) already carries exactly those four and is already optional on every `tennis.point`. See the false premise below — this is not a workaround, it is the surface the payload was built for |
| R4-2 | Retire: `core.forfeit` folds (`kernel.ts:1899`) but tennis's `padSpec` declares no such action, and D-12 routes Forfeit/Abandon to console chrome | **No Retire tile.** `fixture-console.tsx:700-728` already ships a Forfeit control with a reason prompt, on the same page as the pad, so the tile would be a SECOND entry point to a capability that already exists one level up — the two-divergent-entry-points defect R2c closed for `cricket.retire`, rebuilt deliberately. R4 adds the **Interruption tile** (medical/heat/toilet) instead, which is what actually precedes a retirement and is today reachable only by scrolling a generic drawer form |
| R4-3 | §9.1's engine item: the reader exists but needs a `serviceTurn`, derivable from `games`/`serving`/`tbFirstServer` | **Additive engine export**, not a skin-side derivation. One source of truth for the ITF rotation; a pad copy would be the placer/verifier fork this repo keeps paying for, and R5 (badminton/tabletennis doubles) inherits whichever answer this wave gives. Engine touched ⇒ conformance + golden replay + engine lint owed |
| R4-4 | Tennis's `--sport-*` palette (R3-6 obligation) | **A — Hardcourt.** board `#0b2545`, board-2 `#13315c`, ink `#f4f7fb`, led `#d9f000`, caution `#f2a900`, dismissal `#c1272d`. `led` is spent on the serving player's pip and the strip digits and nothing else. Chosen over clay (its second colour IS white, so the pip has nothing to be, and cream+terracotta is one of the three generated-design default clusters) and over grass (Wimbledon purple measures **1.4:1** on the green, so the signature colour could never appear, and the board collides with football's floodlit turf in the same sign-off sheet). Comps: <https://claude.ai/code/artifact/7ee55396-2efd-42eb-8d66-e12c44f36db8> |

**Recorded with R4-4, so it is not discovered at sign-off:** tennis's code
violation ladder has FOUR steps (`warning → point_penalty → game_penalty →
default`, `kernel.ts:250-255`) against TWO colour tokens. The ends take
`caution` and `dismissal`; the two middle steps read as words in the sanction
sheet and carry no colour.

## R4 — false premises found (verified on `origin/main` `9080cb959`, before any code)

Six. Two of them change what the wave IS, rather than how it is built.

- **D-2's "`pairOrder` unread by the nested kernel (S3 seam left inert)" is
  FALSE, and it is the programme's only engine item.** `expectedDoublesServer`
  exists IN the nested kernel (`nested/kernel.ts:438-444`) and reads `pairOrder`
  through `expectedPairServerOf` (`sports/squad-state.ts:130-137`). Both dossier
  rows already describe it as shipped (`tennis/DOMAIN.md:65`,
  `setbased/DOMAIN.tabletennis.md:41`). What is actually missing is a CALLER: the
  function has zero production call sites, and its `serviceTurn` argument — which
  service turn the side is on — has no reader anywhere. So §9.1 as written ("the
  nested kernel consumes `pairOrder`") is already done, and the real work is the
  `serviceTurn` derivation plus the pad that asks. R4-3 rules where that lives.
  The seam was inert in the "no consumer" sense, never in the "not implemented"
  sense, and the distinction decides how much engine work this wave carries.
- **The brief's minor row is half unrepresentable.** Tennis declares exactly five
  event types (`kernel.ts:1766-1772`): `point`, `set_summary`, `sanction`,
  `interruption`, `game.award`. There is no fault event and no let event, and
  §9.4 bars new ones. A Fault tile and a Let tile would dispatch nothing.
- **…and the fix was already in the payload.** `NestedPointMeta.kind` is
  `ace | double_fault | winner | ue` (`kernel.ts:200-205`), optional on every
  point, and `NestedPersonTally` already folds ace and double-fault counts
  crediting the SERVER (`kernel.ts:447-449`). The v2 pad cannot send any of it —
  its one-tap Home/Away posts `{by}` alone (`skins/tennis-skin.tsx:291-323`) — so
  tennis has a DECLARED stat model that is INERT from the pad. R4-1 makes it
  live, and that is more product value than the two tiles it replaces. A
  first-serve fault and a let genuinely have no representation and no stat: they
  are "the point has not happened yet" states, and a per-serve model (first-serve
  %) is out of scope by §9.
- **D-16 is a DEAD-END TAP, not a layout complaint.** The register calls it
  "set-score entry offered mid-game (tennis at 30–30)". `applySetSummary` already
  refuses it — `if (setInProgress(state)) invalid("this set is being scored
  point-by-point — a set summary is not allowed for it")` (`kernel.ts:1053-1055`)
  — so today's tile 422s. It is the same coarse/fine mutual exclusion cricket has,
  scoped PER SET rather than per innings, so a match may legally mix summary sets
  and point-scored sets. Closing D-16 is therefore `refusedEventTypes` +
  tile gating, and the copy must name the real cause (R2b's binding "never show a
  generic error where the exact reason is known").
- **D-3's root cause is a UNIT MISMATCH, and it is not in the engine.**
  `positions.lineup.size = 1` for tennis (`sports/tennis/tennis.ts:10-13`) is one
  nominated UNIT per side — correct, and the comment says so. The editor then
  compares it against a count of PEOPLE: `startingCount` counts slots
  (`lineup-editor.tsx:224`) and renders `lineup.starting {n}/{total}` against the
  raw `lineupSize` (`:267`). A doubles pair is 2 people in 1 unit → "2/1". The
  file already computes `pairShaped = isPairShaped(side.kind)` (`:217`) for a
  different purpose, so the fix is one expression and one counter, exactly as the
  brief predicted. Not the lineup editor's data model, not the engine.
- **Tennis already declares real `fidelityEntitlements`.** `{3:
  "scoring.rally_by_rally"}` (`kernel.ts:1478-1485`), so the recording chip has a
  real band to gate and the R2 standing item does not bite here. Band 2 is
  deliberately unoccupied for this kernel; bands are `set_summary` 0,
  `sanction`/`interruption` 1, `point`/`game.award` 3. **Consequence worth stating
  before it is discovered on a screenshot:** below band 3 the halves are not
  tappable at all, because the point event is band 3 — a band-0 org's tennis pad
  offers set summaries and nothing else. That is coherent (it is the coarse lane),
  but it means tap model S is invisible to most orgs and the gallery must capture
  a band-3 fixture or it pictures a board nobody can tap.
- **The chassis already has tap model S and nobody has used it.**
  `ScorebugHalf.tappable` + `tapEvent` exist (`v3/types.ts:91-92`), are enforced
  by `assertScorebugSpec` (`:1050-1058`, tappable REQUIRES `hintKey` + `tapEvent`),
  and `scorebug.tsx:150-155` already renders a tappable half as a real `<button>`.
  Neither cricket nor football sets it. R4 is the first consumer, so no chassis
  work is owed for the tap model itself — but R4 is also the first wave that can
  observe defects in that path, and it inherits the R3 lesson about being the
  first real user of a chassis primitive (`SwapSheet` surfaced five).

### R4 — the doubles serve pip is UNTESTABLE until the e2e seeder can declare a pair order (2026-08-25)

Found while scoping the e2e/gallery task, before that task was dispatched.
Generalises past tennis: **R5 inherits it**, since badminton and table-tennis
doubles reuse this exact pattern.

`expectedDoublesServer` returns `null` unless the team sheet declared a
`pairOrder`, and that is correct — `LineupSlot.pairOrder` is
`.positive().optional()` (`core/types.ts:222`) and `lineup.ts:354` omits the key
when absent, so an undeclared partner is filtered OUT of `pairOrderOf` rather
than silently defaulting to 0. The documented "empty rather than guessing"
posture holds end to end; this was checked rather than assumed, because a
nullable column plus a `!== undefined` filter is exactly the shape that usually
does NOT hold.

The gap is on the test side: `RosterSlotSpec` (`e2e/helpers.ts:1015-1025`) has
no pair-order field and `seedRosteredFixture`'s lineup PUT (`:1147-1153`) never
sends one. So **every doubles fixture in e2e and in the gallery seeds a pair
with no declared order**, and with it:

- the `tennis-doubles` gallery screens — the ones the brief requires the owner
  to verdict BY NAME as their stated pain — would render no serve pip at all.
  The wave's headline feature would be absent from its own sign-off sheet and
  would read as a defect rather than as missing fixture data.
- the doubles serve-dot e2e would be vacuous.

This is the R2c lesson in a new place: there, the gallery could not SEE the
wave's change because no state opened the picker; here, the fixture cannot
PRODUCE the change at all. A recapture fixes neither.

The API already accepts it (`schemas.ts:941`, `pair_order` nullish) and the
lineup editor already sends it, so the fix is three lines in the seeder and it
lands BEFORE the e2e and gallery work rather than inside it. Spread-omit the
field rather than sending an explicit `null`, so individual-entrant fixtures
keep declaring nothing.

### R4 — two more owner rulings, taken mid-wave off a review finding (2026-08-25)

| # | Decision | Ruling |
|---|---|---|
| R4-5 | The v3 point dock records the shot type but not WHO won the point | **Scorer chips in doubles; auto-set in singles.** One chip per player of the winning pair, as the SECOND dock question after the shot type — football's goal-scorer dock, which is where `DockChip.labelText` came from. Singles sets `scorer` at tap time with no chip, because with one player there is nothing to choose |
| R4-6 | `meta.receiverSide` (deuce/ad) is lost with it | **Stays out, knowingly.** It only applies at a no-ad deciding point, the fold never reads it, and the ~6s dock window is tightest on exactly that point. Dropped deliberately and recorded here, not discovered later |

**The regression these answer, and why it is not what the review first called
it.** The review reported that v2's tennis TILE posted `meta.receiverSide`.
It did not — `git grep -a receiverSide` over `skins/tennis-skin.tsx` returns
nothing. The real mechanism is one level up and costs more: `padSpec` declares
TWO point actions sharing ONE wire type (`nested/kernel.ts:1422-1440`) — a bare
`pointAction` and a `pointAttributedAction` carrying `meta.kind`,
`meta.receiverSide` and person attribution for `server` AND `scorer`. Both were
reachable as generic More-sheet forms in v2. Dedicating `tennis.point` in v3
removes BOTH, and the v3 dock replaced only `meta.kind`.

So the loss is not a niche enum. It is `scorer`: **in doubles, which partner
won the point became unrecordable**, and `NestedPersonTally.points` folds
exactly that field — leaving a doubles league's per-player point counts empty
on the wave whose headline is that per-player tennis stats finally work from
the pad. Singles was never affected (one player, never ambiguous).

Worth generalising for R5, which converts three more sports onto the same
chassis: **a v2 sport's capability inventory is not its skin's tile list.**
Anything `padSpec` declared was reachable through the generic form, so
dedicating a wire type silently retires every OTHER declared action sharing
that type. Diff the padSpec actions by TYPE before flipping a registry entry,
not the v2 skin's buttons.

### R4 — what the two review passes found, and what they did not (2026-08-25)

Two reviewers, disjoint lenses (correctness/contracts; product value/coverage).
Both returned NEEDS FIXES. Recorded because the SHAPE of the result matters as
much as the list.

**Everything they blocked on is e2e and gallery — the one task not yet started
— and nothing in the engine or the pad's contracts.** Verified clean by hand-
derivation plus JSON-confirmed runs: `serveContext`/`completedGames` across
game, tie-break and match-tie-break boundaries; the stale-serve omission
(`hasStaleServeInfo`) proven against real folds rather than a fixture; the
`nested` barrel exporting readers and no mutators; and `dedicatedEventTypes`'s
tapModel-S widening proven for cricket and football through their OWN
`buildScorebug`, not a stand-in.

The blockers, in the order they hurt:

1. **The sign-off gate cannot run at all.** Both `gallery.capture.ts` tennis
   entries `scoreOne` by clicking `getByRole("button", {name: "Home"})`; a v3
   half's accessible name is the PLAYER'S NAME plus hint text
   (`scorebug.tsx:159`), so the script errors before capturing a single
   screenshot. The owner would be asked to verdict a wave with zero pictures.
2. **No `EXTRA_STATES` for tennis anywhere**, so even a fixed `scoreOne` never
   opens the doubles serve pip or the sanction sheet — the wave's headline
   feature would have no screen to sign off, which is R2c's standing
   instruction ignored one wave later.
3. **Three pre-existing e2e specs go red** (`scorepad-skins.spec.ts`,
   `v6-sports.spec.ts` ×2) on selectors the build spec itself predicted would
   break and which were then left unfixed. `registry.ts` routes tennis to v3
   unconditionally — no flag — so whoever opens the PR gets them red in CI.
4. **Zero tennis e2e exists**, so the dock's advance-on-tap has no
   browser-level proof. The skin says so in its own source rather than
   claiming coverage it lacks. This is R3's inert-dock incident with the
   warning label already attached.

**A process note worth keeping.** One reviewer ended its turn on the line
"Waiting on the last fork to complete" and reported no findings at all — the
stall shape where an agent returns `completed` carrying nothing. It had done
the work; it just never said it. Woken with an explicit "report what you have,
mark the rest UNANSWERED", it returned eight findings. A review that reports
nothing is indistinguishable from a review that found nothing, and only one of
those is safe to act on.

---

## R4 final review (2026-08-26) — two defects the green gate could not see

The branch was already gated green (apps/web 10363/0, engine 4092/0, e2e 39/39,
seven widths, gallery 12/12) and pushed as PR #649 when a final reviewer was
scoped at the eight fix commits, `df23e0319`, and the rebase. It came back
NEEDS FIXES, and following its lead surfaced a second defect it had not seen.
Both are the same shape, and it is this programme's signature shape: **a test
and the code it guards, wrong together, agreeing.**

**D-20 — `serveContext` could name a partner off a rotation the fold never
agreed to.** `bankSet` never advances `state.serving`, so a tier-0
`*.set_summary` freezes it; the turn walk has no such gap and advances across
the banked set's game parity. An odd-game summary (6-3, 6-1 — ordinary
scorelines, not corner cases) desyncs the two permanently, and the composed
answer pairs a stale side with an advanced turn index.

Ruling **R4-7**: neither derivation is patched to match the other. The walk is
right about the rotation; `serving` is right about what the fold committed to.
`serveContext` compares them and reports `serveOrderKnown`, returning
`personId: null` on disagreement. It is a **drift detector, not a summary-set
sniffer** — it compares the two derivations rather than scanning history for an
event type, so a future fold/walk fork trips it too.

The guard is deliberately precise. An EVEN-game summary (6-4, 2-6) leaves both
derivations in step and still names the partner — that is the common real case
(a scorer backfilling the sets already played), and a blanket "any summary set
kills the rotation" would have cost the feature exactly there.

Correcting `state.serving` itself on the summary path is the real underlying
fix. It moves the public scoreboard's serve indicator, which **ten golden
streams pin**, so it belongs to its own wave — logged, not silently inherited.

**D-21 — the pad's shim dropped two fields `serveContext` actually reads, and
the covering test agreed by parity coincidence.** `deriveServeContext` builds a
`Pick<NestedState, …>` shim; it omitted each closed set's `tb` block, which the
walk reads to subtract the breaker's banked "+1" game and credit its real ITF
turns. A 7-6 set therefore looked like 13 standard games, and the pad **named
the wrong partner from the game after any tie-break** — live on this branch.

The existing tie-break test passed the whole time: the shim's turn 6 and the
true turn 8 share a parity and select the same player. One more game crosses
the floor(_/2) boundary. `tbFirstServer` was the second missing field, newly
read by R4-7's guard; without it the pad reads its own match as desynced for
half of every tie-break.

**The shim's own doc comment had predicted this precisely** — "a FUTURE kernel
edit that makes the call graph read a FIFTH field this shim never populates …
would still type-check and would still throw at render time." It did not throw;
it silently answered wrong. A hand-copied field list at a module boundary is a
standing liability, and the comment naming the liability is not a control.

**What actually caught them, in order:** a reviewer told to try to BREAK the
new code rather than confirm it; then five mutants, each required to be killed
by a named test. Two of the five survived first time — the `tbFirstServer`
fallback and the shim field — and each survivor was a genuine coverage hole,
not a scoring artefact. **A mutant that survives is the finding.**

Owner instruction recorded the same day: **verify every working feature
VISUALLY, not on green counts.** `11-doublesserve` photographs service turn 0,
and turn 0 names the right partner under every derivation anyone has shipped,
correct or not — so the gallery was structurally blind to D-21. Added
`14-serveafterbreaker`, the game after a closed tie-break, which is the screen
where a wrong human name appears.

### R4 final review, round two (2026-08-26) — two real, one not

A second `/code-review high` over `main...HEAD` returned three findings. Two
were real and are fixed here; the third was not, and saying so is part of the
record — a review's severity claim is a hypothesis, and this programme has now
had one over-claimed finding in each of its last two rounds.

**D-22 — `walkServe` flipped the serve after a MATCH tie-break unconditionally,
so the drift detector R4-7 introduced fired on a defect of its own.** ITF Rule
5b hands the next set to the breaker's first server's opponent, and
`applyTbPoint` enforces it on the fold side with an unconditional `serving:
opponent(tbFirstServer)`. That overwrite lives on the ORDINARY-breaker branch
only. A match tie-break has no next set to hand off to: its branch returns
straight through `bankSet`, banking the raw point-by-point rotation, which
flips after every odd point — `ceil(points / 2)` times in total. The walk
flipped once regardless, so it agreed with the fold only when that count was
odd. Every doubles match decided 10-1, 10-2, 10-5, 10-6 … reported
`serveOrderKnown: false` and named nobody for the whole post-match view.

The comment shipped alongside the bug asserted the opposite of the code it sat
next to ("`applyTbPoint` still applies ITF 5b to `serving` on the closing
point"). It does not. **A comment that states a cross-module invariant is a
claim, and nothing type-checks it.**

The test written to catch this pinned 10-0 only — and 10-0 is one of the
parities where an unconditional flip is accidentally right. The suite was
green over the defect it was authored for. Replaced with the full 10-0 … 10-8
table; the unconditional-flip mutant now dies on exactly the four rows the
reviewer predicted empirically, and nothing else.

**D-23 — the pad inverted ace and double fault on half of every tie-break's
points, on any fixture with no declared lineup.** `rosterlessServerSide`
re-derives the serving SIDE for fixtures that can name no server person, and
excluded the one boundary where `state.serving` runs ahead of the point just
contested: the game/set close, detected by points reading back (0, 0). Inside a
breaker `state.serving` also rotates MID-GAME, after every odd point, and a
breaker at 5-3 is not at (0, 0). So `buildDock` offered `double_fault` where
`ace` was correct, and the reverse — a wrong serving statistic recorded against
a person, silently, in the phase of a set where aces decide it.

Corrected rather than withheld: the rotation is a pure function of the point
count, so the server of the point just played is the current `serving` flipped
iff an odd number of points have been played. Withholding would have dropped
the chips for half of every tie-break, which is the feature's best moment.

**NOT a defect — the third finding.** The review reported `tennis.game.award`
as a live dead-end tap through the More sheet during a breaker, reasoning that
`buildTiles` withholds the tile, the type therefore drops out of
`dedicatedEventTypes`, and `moreActions` puts the generic form back. Each step
is true in isolation and the conclusion is still wrong: `nestedPadSpec`'s
Award-game panel already carries a `gate` on `state.points.kind`
(`kernel.ts`), so `buildPadView` never emits the action during a breaker and
`moreActions` has nothing to offer. Verified against the running production
build, not argued: with the pad-side refusal deliberately removed and the
bundle rebuilt, the More sheet during a tie-break still read "Nothing else to
record here yet."

The pad-side refusal was kept anyway, as a second layer, and the tile's
condition was extracted into ONE predicate both `buildTiles` and
`refusedEventTypes` consume — a real drift class removed, since two copies of
the same boolean is what the finding assumed had already gone wrong. It is
labelled as defence in depth in the code and is not claimed as a fix.

The hazard behind it IS real, and the second layer is not decorative: with
BOTH the engine gate and the pad refusal removed, the same capture goes red
with the sheet reading `More actions / Cancel / Award game`. So
`16-breakermore` is a screen that can fail, over a mechanism that can happen —
it is only the single-layer version of the story that was wrong.

**Ruling R4-8**: a review finding is not a defect until the state it describes
has been reproduced. Two of the three findings here reproduced on the live
build within one capture each; the third did not, and the layer above it was
found only by going looking for the reason it did not.

### Cloud review (2026-08-26) — D-24, the guard that suppressed a correct answer

One finding, real, and it was the thing the previous round had deliberately
left alone. `hasStaleServeInfo` refused whenever ANY `tennis.set_summary` had
folded, on the reasoning that `bankSet` never advances `state.serving` so the
serve is "stale BY CONSTRUCTION for the REST of the match". Half right: a
summary desyncs the fold from the turn walk only when it banks an ODD number
of games, and R4-7's `serveOrderKnown` already said which.

The cost was not cosmetic. Both callers short-circuited before
`deriveServeContext` ran, so `buildHalf` stamped no `server`, every later
`tennis.point` went out unattributed, and `NestedPersonTally` credited no ace
or double fault again. **A scorer who backfills one already-played set lost
the wave's headline capability for the rest of the match**, in the most
ordinary workflow there is.

Two lessons worth keeping apart:

- **A guard that hides a defect looks exactly like a guard that prevents
  one.** D-20 had "no UI symptom" precisely because this guard was suppressing
  the whole feature. That absence of symptom was recorded last round as a
  reason NOT to touch it. It was the defect.
- **The pad second-guessed the engine after the engine had been taught to
  answer.** R4-7 built the drift detector specifically so the pad would not
  have to sniff for event types; the sniffer stayed anyway, coarser and wrong.
  When a wave adds a precise answer, the imprecise callers it was written for
  are part of the change.

The covering test used a 6-0 summary — even, therefore derivable — so it
pinned the over-refusal. Written to match the implementation, not the design.

Singles is not exempt and a mutation test now says so: one player a side makes
the PERSON unambiguous while the SIDE is still `state.serving`.

`17-serveaftersummary` is the screen, proved red against the pre-fix bundle.

### Merge

Owner instruction 2026-08-26: **"No gaps then CI is green then merge"** — the
`_RULES.md` §1 visual sign-off gate is satisfied by that instruction rather
than by per-screen verdicts on the sheet. Recorded here because the rule says
the gate is the verdicts being recorded in this file, and this is what was
given in their place.

---

## R5 (2026-08-27) — owner rulings, taken before any code

Scoping session against RE-PINNED facts on `main` `addd126c5`, not the brief's
pre-R1 line numbers. Two scouts re-pinned the engine and the web surface
independently before a single question was put to the owner.

| # | Decision | Ruling |
|---|---|---|
| R5-1 | D-17 ("badminton SERVING shows —"). The brief says to derive it from "the setbased kernel's server field". There is no such field — see FP-1 | **Additive ENGINE reader plus a first-server anchor.** `setBasedServeContext(state, cfg)`, one derivation for three sports and for the public scoreboard. Serving is a PURE FUNCTION of the fold once the match's first server is known (badminton/volleyball side-out; table tennis alternating every 2, every 1 at 10-10 and under expedite), and the per-game first server is itself derivable (BWF: previous game's winner; ITTF/FIVB: alternate). So exactly ONE datum is missing, and it rides the ALREADY-EXISTING optional `serving` field on the first rally — no new event type (§9 holds), no schema change, module stays `1.0.0`. Undeclared ⇒ `serveOrderKnown:false` ⇒ the pad renders NOTHING and asks; it must never render "—" again and must never guess. Rejected: three per-skin derivations (the placer/verifier fork this repo keeps paying for, and R4-3 already ruled against it), and deferring the row to R8 |
| R5-2 | The attributed rally action carries `server` + `scorer` persons and is INERT from the v2 pad — tennis's D-2 shape, ×3 | **Dock chips on all three sports.** R4-5's exact pattern: one chip per player of the winning pair/team as the dock question, auto-set in singles where there is nothing to choose; the server comes from R5-1's derivation and is never asked. This is the wave's product headline — per-player point and serve stats become recordable for badminton, table tennis and volleyball for the first time. Rejected: badminton+TT only (volleyball's scorer was argued ambiguous; it is not — the payload names a person, not a skill), and plain-rally-only, which would silently retire two of the three declared actions |
| R5-3 | Three `--sport-*` palettes owed under R3-6 | **badminton A "Sprung Floor"** (maple-hall board `#241a14`/`#33261d`, BWF-mat teal led `#2fe0bd`), **tabletennis A "Two-Colour Bat"** (graphite `#101418`, ITTF-blue band `#0f2d40`, ball-orange led `#ff9440`), **volleyball B "Court Azure"** (arena slate `#161d27`/`#232c39`, court azure led `#4aa8ff`). Owner asked to see it first; comps published and ruled off them, R4-4's precedent. Comps: <https://claude.ai/code/artifact/97a11b49-c1dc-4c4a-b969-2610712ef7c3> |
| R5-4 | How many whole-match walkthroughs | **All three.** Owner overrode the recommendation of one (volleyball). Cost is real and stated: the walkthrough leg is already the workflow's floor at ~300s on CI with `tennis-mtb` alone. Closes D-13 at full depth — table tennis has never been driven in a browser at all |
| R5-5 | `ContextSlot.messageTone` — badminton's band-3 lock needed a context-strip message, and that strip hard-codes `text-red-600`. Chassis change, so raised rather than taken | **KEEP the additive `messageTone?: "alert" \| "info"`** (`types.ts:402`, consumed `context-strip.tsx:273-280` as `slot.messageTone ?? "alert"`). Red on this pad already MEANS "your tap was rejected" (cricket's ineligible bowler); a plan boundary is not a rejection, and the recording chip two controls away already words the same lock in amber — the two surfaces were arguing. `text-amber-700` clears the 4.5 floor (~5.0:1 on white, computed off the Tailwind **v3** hex `#b45309`; this repo is on v4 oklch, where the value shifts — see `sport-theme.ts`'s own lime-400 warning — so indicative, not exact) and already carries plan/upgrade meaning in `settings/billing`, `settings`, `o/[orgSlug]`, `my-matches`. Blast radius is nil by construction: opt-in, defaults to `"alert"`, cricket byte-identical, pinned in both directions — same shape as `readOnly`/`candidates`/`blocked` already on that type |
| R5-6 | How much review each task gets. C1 shipped and was only reviewed after the owner asked whether a reviewer had run; the answer was no, and the review that followed found two real defects behind an all-green gate | **Reviewer loop per TASK, not per wave** (owner instruction, 2026-08-27): implementer → adversarial reviewer → fix → re-verify, before the next task is called done. Two operational notes paid for in this wave: (1) when a later task is already in flight in the same worktree, scope the review to the earlier task's COMMITS (`git show <sha>:<path>`), never the working tree — otherwise the reviewer reports the next task's half-written state as findings; (2) hand the reviewer what you already checked yourself, so the budget goes on what you did NOT check. Track record so far: engine reader 6 findings, C1 2 findings, and acting on one of C1's ("you claimed tennis doubles gains the separator and never checked") found a THIRD defect nobody had looked for |

### R5-3 — what the palette ruling rejected, and the rule it establishes

The owner's first instinct was "all B". Rejected on the family strip, which is
the collision test R4-4 flagged and could not run for want of anything to run
it against. Two of the three B options collide:

- **tabletennis B** board `#062535` against tennis's shipped `#0b2545` — six
  bytes apart, and in the strip they read as one board. This was the weakest of
  the six candidates and its own card said so; it was in the sheet to be
  judged, not picked.
- **badminton B** collides with football on BOTH axes at once — dark
  teal-GREEN ground against football's dark green, and cork-amber `#ffc94d`
  against football's fourth-official amber `#ffb703`.
- **volleyball B** collides with nothing, and beats its own A on a product
  argument rather than a taste one: volleyball is the only one of the three
  where a referee shows a card mid-rally, and A's coral serve signal sits one
  hue step from A's own red card ON THE SAME BOARD. A serve cue that can be
  misread as a sanction is a defect, so B wins here and A wins twice above.

**The rule this establishes for R6/R7, stated so it is not re-derived:** no two
sports may share BOTH a ground family and an accent family. The six lanes now
spent are violet+lime (cricket), green+amber (football), navy+optic-yellow
(tennis), warm-brown+teal (badminton), graphite+orange (tabletennis),
slate+azure (volleyball). R6 (hockey, icehockey) and R7 (boardgame, carrom,
generic) pick from what is left, and the family strip is how that is judged —
not a swatch grid, and not one board at a time.

### R5 — false premises found (verified on `main` `addd126c5`, before any code)

Three. The first changes what the wave IS.

- **FP-1 — "serving NEVER renders '—' (D-17) — derive from the setbased
  kernel's server field" is FALSE, and D-17 is therefore an ENGINE gap, not a
  render bug.** `setbased/kernel.ts:172-173` states it outright: *the set-based
  kernel holds no serving state*. `serving: EntrantId.optional()` (`:179`) is a
  RALLY PAYLOAD field and `server: PersonId.optional()` (`:148`) feeds a
  `serves` tally only; neither is folded. `racquet-skin.tsx:35`'s header
  `serving` is a documented PLACEHOLDER. Nothing computes BWF's interval-at-11
  or ITTF's alternate-every-2 either — `badminton.ts:29-36` is a comment, not
  code. A wave that followed the brief would have gone looking for a field to
  render and found nothing to render. Ruling R5-1 is the answer.
- **FP-2 — `${key}.rally` carries THREE actions, not one.** `rallyAction`
  (`kernel.ts:1008`), `rallyAttributedAction` (`:1014`) and
  `rallyExpediteAction` (`:1068`) all share the one wire type. R4's lesson
  applies three times over: **dedicating a wire type silently retires every
  OTHER action sharing it**, and R3.5 added that it also drops the generic
  form's `attribution` person field. So a naive conversion would have removed
  per-player attribution AND table tennis's expedite system from all three
  sports at once, with nothing failing. Diff the padSpec actions BY TYPE before
  flipping a registry entry — never the v2 skin's buttons.
- **FP-3 — `expectedDoublesServer` is NOT nested/tennis-only.** It exists
  independently in the set-based kernel too (`kernel.ts:393-398`), delegating
  to the same shared `expectedPairServerOf` (`squad-state.ts:145`), and
  `pairOrder` support is already wired through `State.squads`. R4's engine work
  is therefore already inherited by this family; what is missing is the same
  thing tennis was missing — a CALLER supplying `serviceTurn`. R5-1's reader is
  that caller, and must not become a second copy of the rotation.

### R5 — what is already true and must not be re-litigated

- **D-7's evidence line OVERSTATES, and the main thread asserted it wrongly
  before the harness task checked — corrected here.** The band map
  (`setbased/kernel.ts:1714-1736`) is summary 0, timeout/sanction/sub/expedite
  1, **rally 3**, and `fidelityEntitlements: {3: preset.rallyEntitlement}`
  (`:1737`) keys **band 3 ONLY**. Bands 0-2 are therefore UNGATED, and a
  community org resolves to **band 2, never band 0**. So the free badminton pad
  is not "a lone Set score button" as BAD-03 records and as this file first
  repeated: it is Set score **plus a Sanctions drawer**, because every admin
  event sits at the ungated band 1. Verified in a real browser against a real
  plan flip, not read off the map.
  The SUBSTANCE of D-7 survives intact — the rally group is simply absent with
  **no visible reason given** — and that is what the recording chip must word.
  Band 2 is genuinely unoccupied for this kernel (no player-line analogue), as
  it is for tennis.
  Two smaller pins corrected with it: the earlier `kernel.ts:1178` /
  `:1170-1177` refs in this file were stale, and the coarse event type must be
  posted FULLY QUALIFIED — a bare `game.summary` returns `422 INVALID_EVENT`.
- **Some branches are registered but permanently dead by preset.**
  `kernel.ts:945-956`: badminton/tabletennis register every branch but build no
  action for ones their `records` flags disable (e.g. `badminton.timeout`,
  `tabletennis.sub`). Declared-but-dead BY DESIGN, not a bug — but the More
  sheet would offer them, so each skin owes `refusedEventTypes`, which R3/E
  made a REQUIRED argument precisely so a default could not silently restore
  the defect.
- **Volleyball's libero handling is generic, and so is its refusal copy.**
  `volleyball.ts:86-91` declares `{reentry:"once", reentryPositionLock:true,
  exemptions:{libero:{}}}`; the refusals come from `core/lineup.ts:466/472/482`
  and are generic strings that name an ID. R2b's binding ruling — never show a
  generic error where the exact reason is known, and never surface the engine's
  own English ID-bearing prose — means the skin words these itself from the
  machine `.reason` slug, in four locales.
- **No ribbon keys exist for any of the three.**
  `scorepad.skin.{badminton,tabletennis,volleyball}.*` appear nowhere in the
  tree. R1's standing item bites here: keys go into `PAD_LABEL_KEYS`
  (`lib/scoring-vocab.ts`), not only into the four dictionaries, or ribbon copy
  stays on the generic fallback forever with nothing failing.
- **THREE e2e files drive the racquet pad DOM, not six** — corrected against
  `git grep -aln "racquet-header" -- apps/web/e2e/`, which returns exactly
  `gallery.capture.ts`, `scorepad-skins.spec.ts` and `scoring.spec.ts`. The
  scoping scout listed six; `formats` and `funnel` do not reference these
  sports at all, and `me-career`/`stats` touch them ONLY by posting
  `badminton.rally` through the API (`me-career.spec.ts:222`,
  `stats.spec.ts:221`). Those two survive the flip untouched — **and that is
  the point worth keeping**: an API-driven spec is blind to the pad by
  construction, so neither of them would have noticed if the pad stopped
  building a correct payload entirely. They prove the engine's stats path, not
  the surface. The repair surface is three files. Flipping the registry breaks
  all six; repairing them is R5 scope, not R8's. `gallery.capture.ts`'s three
  `scoreOne` implementations (`:1564-1654`) drive the very controls this
  conversion deletes — the same break that left R4 unable to run its own
  sign-off gate.

### R5 — a contrast finding raised and then DISPROVED (2026-08-27)

Recorded in full, including that it was wrong, because "we checked and it was
fine" is worth as much here as a defect and this file has no other record of it.

Computing R5's candidate palettes meant computing the three SHIPPED ones as a
baseline, and all three came back under the 4.5:1 text floor for `dismissal` on
`board-2`: cricket **3.57**, football **2.56**, tennis **3.94**. Football's is
a card SWATCH and cricket has no cards, but tennis words its violation ladder —
so tennis looked like a live WCAG failure that R4's own fix had missed by
checking `board` only. It was raised to the owner as exactly that, pending
reproduction.

**It does not reproduce, because the PAIRING IS ONE NOTHING RENDERS.**
`board-2` is the scorebug BAND (`tokens.ts:108` `bandBg`, consumed at
`scorebug.tsx:150` and `:192`), and the band paints only `ink` and `led`
(`scorebug.tsx:207` is the sole tone branch and it tests for `led`). The two
card tones reach the screen through `SPORT_TONE_CLASSES` as guided-sheet
SWATCHES and as `pad-tone-wash` at 12% alpha behind text (`guided-sheet.tsx:314`,
`:346`) — never as text on `board-2`. `contrast.test.ts` already pins tennis's
tones against `board`, where they DO land, mutation-proved against the
originally-specced `#c1272d`, and pins `board-2`/`ink` separately.

Two things worth keeping:

- **Ruling R4-8 did its job in the cheap direction.** "A review finding is not
  a defect until the state it describes has been reproduced" is usually quoted
  about over-claimed severity; here it stopped a one-token edit to a
  signed-off sport's palette, which would have been a change with no defect
  under it.
- **An exhaustive token matrix generates pairings the product never composes.**
  Every token crossed with every ground is not the same question as "what does
  this pad render". The wave's own six candidates were held to that stricter
  bar anyway, which costs nothing — but the FINDING was an artefact of the
  method, not of the code. The usage-driven licence scan in `contrast.test.ts`
  is the honest instrument and it was already correct.


### R5 Task A DONE — the serve reader, `80386a342` + `26a04f4dd` (2026-08-27)

`setBasedServeContext(module, state, events)` (`setbased/kernel.ts:1285`, exported
from `index.ts:10`). Gate re-run IN THE MAIN THREAD, not taken from the
implementer: engine **4178 total / 4165 passed / 0 failed / 0 failed suites**
(13 pending are pre-existing skips), `success: true`, and **0** result paths
resolving outside the worktree — the cwd trap that has produced false greens
here. `tsc --noEmit` EXIT=0; `turbo lint --filter=@seazn/engine` 0 problems.
**No golden, schema-snapshot or `.schema.json` byte moved**, confirmed by
`git diff --name-only origin/main..HEAD`; no `UPDATE_GOLDEN`/`REBASELINE_GOLDEN`.

**The rotation rule is DATA, not a sport-key branch** — the thing that makes
this one derivation rather than three. Each preset declares its own law:

- badminton `{within:"rally-winner", setStart:"set-winner"}` (BWF: rally winner
  serves; the previous game's winner starts the next)
- tabletennis `{within:"fixed-turns", turnLength:2, acceleratesAtDeuce:true,
  setStart:"alternate", serverFromPairOrder:true}` (ITTF)
- volleyball `{within:"rally-winner", setStart:"alternate",
  decidingSetTossed:true, serverFromPairOrder:true, nonServingRoles:["libero"],
  rotationCycle:6}` (FIVB)

R6/R7 add a sport by declaring a preset, never by editing the reader.

**The brief's signature `(state, cfg)` was FALSE and the implementer was right
to reject it.** `cfg` is already `state.cfg`, and — the part that matters — the
aggregate state holds set TOTALS, not the rally sequence, so a state-only
reader could name a server only at 0-0 of a set. It takes the LEDGER and
replays it through the real `applyRally`/`applySummary`/`bankSet` (the
`setBasedMatchOutcomesFold` precedent), never a second set predicate.
**Corollary nobody assumed:** side-out sports need the anchor LESS than R5-1
stated — once one rally is recorded the ledger answers for itself, so badminton
needs a declared `serving` only at 0-0 of game 1 and volleyball only at 0-0 of
the tossed decider. Table tennis needs it once per match.

**Mutation: 27 run, 26 died, 1 survived and the survivor is EQUIVALENT.**
Red-step first (reader stubbed to always-unknown → 27/30 red), then each guard
broken in turn against a named test: drift detector, drift widened past the
set, score-jump guard, score-jump widened to fixed-turns, ledger-mismatch,
deciding-set toss, match-over, libero, pair-size, rotation squad-size, deuce
derived from cfg, hardcoded 10-all, both set-start swaps, two turn-index
off-by-ones, serve-number off-by-one, side-out ignoring the rally winner, and
expedite not carried into the next game. Survivor: deuce `2*(target-1)` →
`2*target-1`, checked numerically over targets 2–59 — provably equivalent at
`turnLength` 1 and 2, diverging only at ≥3, which no preset declares. Left
unpatched deliberately; an equivalent mutant is not a coverage hole.

**R4's 10-0 lesson recurred, in a new place, and was caught.** A first mutant
(`expediteFrom = pointsNow()` → `0`) SURVIVED because the covering test pinned
a single expedite trigger at 5 points — a parity where the wrong turn index
still names the right side. The TEST was fixed, not the code: the trigger is
now swept 2..7 asserting side, turn index and serve number, and the mutant dies
in six tests (`26a04f4dd`). **A single-parity pin is this programme's most
repeated false green** — R4 tie-break 10-0, R4 D-21 turn 6/8, now this.

### R5 — the implementer's reported blocker is FALSE for this wave

Reported: "`SkinProps`/`SkinLayoutCtx` hand a skin only `state`, never the
ledger", so the reader is unreachable from a skin without chassis threading.
True of the **v2** lane, and irrelevant here — R5 builds **v3** skins, and
`PadHostView.events` already exists (`v3/types.ts:1081`), documented as the
same list `pipeline.events` exposes, oldest first, ledger plus still-queued
local events, never a re-derived copy. **No chassis threading is owed.**
Recorded because a later session reading only the task report would go and
build a seam that has been there since R2.

Corollary for R6/R7: a v3 skin may call an engine reader that needs history.
`view.events` is the supported route; do not add a second one.

### R5 Task B DONE — the harness photographs the defects FIRST, `c60b920bf` + `015f7ec5b`

Two `EXTRA_STATES`, added BEFORE the conversion on purpose. `V3_SKINS` still
holds only cricket/football/tennis; all three sports still render v2
`racquet-skin.tsx`, and an untouched control sport (carrom, 5 states) still
captures green.

- **`11-servingplaceholder`** — all three sports (D-17). Game/set 1 banked by
  summary, then **three rallies TAPPED in the browser**; the board reads
  SETS 1–0, POINTS 2–1, SERVING `—`. Deliberately **not turn 0**, and table
  tennis's is past a 2-serve rotation boundary — the first browser-driven
  rotation crossing that sport has ever had (D-13).
- **`12-bandlimited`** — badminton (D-7). A community org's live pad: no Rally
  group, and a greyed `Detail 🔒` with no words anywhere explaining it. Plan
  flipped and restored in a `finally`.

**320px overflow: 0px on all 19 states across the three sports**;
`padRowsByWidth` agrees at 320/768/1280, so each published trio is provably
three views of ONE state rather than three states.

**The probes were mutation-checked in the direction that matters.** Both
POST-fix expectations were run against today's build and FAIL — serving reports
`Received: "—"` after 44 polls, the rally group `resolved to 0 elements`. A
probe that cannot fail proves nothing, and this is the wave's own version of
R3.5's "inverted, never deleted": each flipping assertion is commented inline
with what it becomes.

| today | at conversion |
|---|---|
| `expect(serving).toHaveText("—")` | `.not.toHaveText("—")` + the server's name |
| `expect(rallyGroup).toHaveCount(0)` | `toHaveCount(1)` |
| `expect(lockedReason).toHaveCount(0)` | `toBeVisible()` |

BEFORE sheet published for the owner:
<https://claude.ai/code/artifact/1ad7abe5-01f9-46f6-ae75-00f4cfbaf284>

**Seen only by looking at the rendered page** — three further register rows are
visibly present on this surface and no test asserts any of them. Recorded, not
taken:

- **D-11 (score rendered 3× above the fold) is LIVE on the v2 racquet lane** —
  the fixture header, the LCD "SCORE" panel, and the SETS/POINTS board all
  state it. Spec §8 assigns D-11 to R1, which shipped the single scorebug but
  could not retire the v2 lane. **R5's conversion closes it for these three
  sports as a side effect** — worth asserting in the AFTER captures rather than
  leaving it to be noticed.
- **D-7/GF-3's raw picker is exactly as described** — `Result only | Card |
  Timeline | Detail 🔒`, a bare padlock with no words. This is the screen the
  recording chip replaces.
- **D-4 (Activity ledger rendered twice per console page) is present here too.**
  Assigned to R7 and NOT taken; recorded so R7 knows the racquet family shows
  it as well, not just cricket.

**A capture artefact that must not be read as a defect:** a full-page
screenshot paints the sticky nav a second time mid-image on a tall page. Known
Chromium behaviour with `position: sticky`, documented at
`gallery.capture.ts:404-406` and disclosed in the generated sheet's own text at
`:2277`. Called out in the published BEFORE sheet too, since that sheet's whole
job is showing the owner defects.

### R5 Task C1 DONE — palettes ×3 + badminton converted (`83c527da0` `20e2042ce` `ad3fa577c` `c8ca84b10`)

Gate re-run in the MAIN THREAD: apps/web `v3`+`lib` **3302 total / 3277 passed /
0 failed / 0 failed suites** (25 skipped), `success: true`, **0** result paths
outside the worktree, and `badminton.test.ts` confirmed COLLECTED by name — a
suite that fails to collect contributes no failures and reads as green. tsc
EXIT=0. Lint 0 errors / 124 warnings (125 before; one removed). `i18n:gen-keys`
+ `i18n:check` clean with `git status --porcelain` EMPTY. e2e 16 passed;
gallery badminton 7 states, **every state 0px overflow at 320**.

**Verified visually by the main thread at 768 and 320**, not on counts: the
board reads `Serving <name>` (D-17 closed), `Right service court` (BWF Law
10.2, derived from score parity — a genuine addition, not in the brief),
`Interval at 11` as STATUS not a tile, a worded `Every detail` chip in place of
the `Result only | Card | Timeline | Detail 🔒` picker (D-7 closed), and all
tiles dashed-minor with NO primary weight competing with the tappable halves.
At 320 the strip wraps to three rows rather than overflowing.

**A SCREENSHOT CAUGHT WHAT NO TEST DID — new trap, general to every skin.**
The half's hint shipped as the RAW KEY `pad.badminton.scorebug.rally.hint`.
Cause: `hintKey` resolves through `padLabel`, which gates on `PAD_LABEL_KEYS`
**MEMBERSHIP**, not on dictionary copy — so a key present in all four
dictionaries but absent from `PAD_LABEL_KEYS` renders its own name, and every
unit test passes because they assert the KEY. Fixed, plus a membership guard
for hint and ribbon keys. This is the third distinct way this repo can ship a
raw i18n key (after cricket's defaulted `t` and R1's ribbon-fallback item), and
the only one no assertion caught.

**A surviving mutant became a real fix, again.** The serve was guarded TWICE
(`serveOrderKnown` AND `side === null`) and NEITHER mutant could be killed —
each half covered for the other, so both looked tested and neither was.
Collapsed to one guard asserting the engine invariant directly; the
fabrication mutant now dies twice. **Two guards that cover for each other are
indistinguishable from one tested guard** — worth adding to the mutation
checklist for R6/R7.

**Found false in this task's brief:**
- `kernel.ts:945-956` was already stale (R5-1 moved it).
- `badminton.timeout` is dead for every SHIPPED config, but `records` is a
  per-fixture cfg knob — so `refusedEventTypes` must read the FIXTURE's own
  cfg, never the preset. A preset-driven refusal would be wrong for a custom
  config.
- **`[data-band="3"]` no longer exists on a converted sport** — `RecordingChip`
  REPLACES `FidelitySwitcher`, so a third D-7 probe had to move as well; the
  brief flagged only two. `renderLockedTile` and `scorepad.locked.reason` do
  not exist in v3 either, and v3 has no panel headings. **Every locator in a
  pre-conversion probe moves at the flip** — inverting the assertion is not
  enough on its own.
- `globals.css` needed no edit, as predicted — confirmed by measuring the
  rendered focus ring at `#2fe0bd`.

**CHASSIS ADDITION, declared rather than smuggled** (outside the task's owned
files): `ContextSlot.messageTone` in `v3/types.ts` + `context-strip.tsx`. The
chassis had ONE hard-coded error red for every context message, and a plan-tier
notice is not a fault. Opt-in, defaults to today's red, **cricket byte-identical**,
pinned in both directions — the R3-6 pattern. Four chassis test files carry that
gate's registration. Flagged to the owner rather than accepted silently.

### R5 — SESSION STATE, written for compaction (2026-08-27)

Worktree `.claude/worktrees/r5-racquet`, branch `feat/scorepad-v3-r5-racquet-split`.
Env label `r5`: server **http://localhost:3368** (localhost, NEVER 127.0.0.1),
Postgres :54573 db `seazn_r5`. `eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label r5)"`
is REQUIRED before any apps/web vitest run — a guard now refuses to run when
`DATABASE_URL` comes from `.env.local` and points at the dev DB.

**DONE**
- Task A — `setBasedServeContext` (engine). Main-thread gate: 4178/0 failed.
- Task B — gallery BEFORE states `11-servingplaceholder` (×3 sports) +
  `12-bandlimited` (badminton). BEFORE sheet:
  <https://claude.ai/code/artifact/1ad7abe5-01f9-46f6-ae75-00f4cfbaf284>
- Task C1 — 3 palettes + **badminton converted and flipped**. Main-thread gate:
  apps/web v3+lib **3302/0 failed**, tsc 0, lint 0 errors, i18n clean, gallery
  badminton 7 states 0px @320.
- Adversarial review of Task A: 6 findings, all reproduced.

**IN FLIGHT**
- Engine fix agent on review findings F1–F6 (`packages/engine/src/sports/setbased`
  ONLY; instructed to commit with an explicit pathspec because the git index is
  shared).

**NOT STARTED — the remaining wave**
1. **C2 tabletennis skin** + flip (+ expedite; `records` is a per-FIXTURE cfg
   knob, so `refusedEventTypes` reads the fixture cfg, never the preset).
2. **C3 volleyball skin** + flip (+ libero swap refusal, sport-worded from the
   machine `.reason` slug — the engine's own prose is English-only and names a
   personId).
3. **Three walkthroughs** (`e2e/walkthrough/`, ruling R5-4). A file dropped in
   that folder joins the `walkthrough` project automatically — no `e2e.yml` or
   config edit owed, and the wiring guard is generic. Shorten matches through
   CFG, never the API. The double-submit guard costs 750ms per SAME-SIDE
   repeat, which side-out sports (badminton, volleyball) hit constantly.
   `shot(page,caption)` in the existing specs writes numbered captioned
   screenshots at 1280/768/320 — that IS the owner's visual step record.
4. **DELETE `skins/racquet-skin.tsx`** + its 3 `RESOLUTION_KIND` rows, with
   `git grep -a` zero-ref proof. Only after all three sports are flipped.
5. Gallery AFTER sheet + owner sign-off + live walkthrough offered.
6. Smoke DEFERRED to R8 by name, stated in the PR body.

**OWNER RULING OWED**: keep or revert `ContextSlot.messageTone` (chassis
addition from C1 — opt-in, cricket byte-identical, pinned both ways).

**Repair surface is THREE e2e files**, not six: `gallery.capture.ts`,
`scorepad-skins.spec.ts`, `scoring.spec.ts` (badminton's are done).

### R5 — what PLAYING the pad found that the green gate could not (2026-08-27)

Task C1 was fully green — 5/5 e2e, unit suite passing, gallery screenshots
captured and read — before anyone had *driven* the badminton pad through a
doubles rally. Doing that (a throwaway `e2e/__play-badminton.spec.ts`, deleted
after) found two real defects, disproved one suspicion, and confirmed one
designed refusal. The pattern is worth naming: **all four are doubles-only, and
every earlier check in this wave used a SINGLES fixture.** A sport's own most
common club format was the untested one.

**P-1 (FIXED) — two names on a half rendered as one run-on string.**
`scorebug.tsx`'s `HalfContent` maps one `<span>` per `WhoLine` with nothing but
a 6px `gap-x-1.5` between them, so a real doubles half read
`ADA LOVELACEALAN TURING`. Meanwhile `whoNames()` — the ACCESSIBLE name of that
same button — has always joined with `", "`. So sighted and screen-reader users
were reading materially different content off ONE control, and only the
screen-reader one was right. Fixed with an `aria-hidden` `/` separator gated on
`i > 0` (a racquet pair is written CHEN/WANG; the spoken name keeps its comma
and must never say "slash"). Blast radius verified rather than asserted:
cricket and football build exactly ONE `WhoLine` per half, so the branch never
fires there and both render byte-for-byte as before; tennis doubles gains the
same fix. RED proved by disabling the branch and re-running — the failure
message is the defect itself (`HomeA mtbnwea5V3 Bad Pair HomeB`).
Pinned in `scorepad-v3-badminton.spec.ts`, **both halves** of the disagreement:
the visible text carries the slash AND the `aria-label` keeps the comma, since
fixing either one alone re-opens the gap.

**P-2 (FIXED) — the dock asked a question the scorer had already answered.**
`pad.badminton.dock.rally.scorer.title` was "Who won the rally?" while offering
only the WINNING pair's two players. The rally winner is settled by which half
you tapped; the dock is asking which PARTNER scored. Now "Which player won it?"
in all four locales. Note the first rewrite — "Which player won the rally?" —
**truncated at 320** (`Which player won the ra…`), caught on the 320 screenshot
and not by any assertion: the dock title ellipsises at roughly 22 characters, a
pre-existing chassis limit that no test guards. Tennis's own
`pad.tennis.dock.point.scorer.title` ("Who won the point?") has the identical
ambiguity and is left alone deliberately — it is a merged wave's copy, so it is
raised rather than taken.

**P-3 (NOT a defect — my own single-parity sampling.)** The strip read "Left
service court" at every score I happened to observe, which looked wrong. It was
not: BWF 10.2 is right court on an EVEN score, and my three samples were 1, 1
and 3 — all odd. Both parities are already unit-covered
(`badminton.test.ts:416/418`). Recording it because the near-miss is the same
single-parity trap this programme has now paid for four times, and this time it
was the OBSERVER who sampled one parity, not the test.

**P-4 (by design, already pinned) — badminton doubles names no server, ever.**
`serverFromPairOrder` is absent from badminton's preset, so
`setBasedServeContext` answers `serverPersonId: null` for a pair and the pad
prints the serving SIDE only. That is correct: BWF picks the doubles server by
the service COURT the players stand in, which needs the pair's starting
positions — a datum this kernel does not fold. Honest refusal, ruling R5-1's
stance, and `scorepad-v3-badminton.spec.ts` already pins both the absent
`server` payload and the side-only strip. **Consequence to state in the PR:**
the wave's per-player SERVE stats are singles-only for badminton. Per-player
POINT stats (the scorer chip) work in both.

**P-5 (OPEN, chassis, raised not taken) — the 6-second window silently drops
the wave's headline stat.** A doubles rally opens the dock; if nobody answers
within `HOLD_MS` (~6s) the hold drains and the rally submits with `wonBy` only.
Observed directly: of five tapped rallies, the one where a chip was clicked
carries `keys=wonBy,scorer` and the other four carry `keys=wonBy`. There is no
recovery — `activity.tsx:347` offers `v3-activity-void` and v3 has NO edit or
amend path anywhere — so the only way back is to void the rally and re-tap it.
Per-player badminton stats are therefore collected only when the scorer beats a
6s clock, which biases the data toward SLOW points. Options weighed: widen
`HOLD_MS` per skin (cheapest, still loses the late look), attribute
retroactively from the Activity row (correct, its own wave), or label the stat
as partial wherever it surfaces. Owner-facing recommendation: label it now,
retro-attribution as its own wave; do NOT widen a chassis constant for one
sport mid-wave.

### R5 — the C1 adversarial review, and the defect that VERIFYING A CLAIM found

Reviewer run on the un-reviewed half of the wave (the badminton skin, the three
palettes, `messageTone`, the registry flip, and the two play-through fixes) —
the ENGINE serve reader had already had its own reviewer, whose six findings
are closed. Counts: **1220/1220 v3 unit tests passing, 0 failed, 26 files, all
paths resolved inside the worktree; `turbo typecheck --filter=@seazn/web`
clean.** Verdict "needs fixes (non-blocking)", two findings.

**Clean in five of the seven categories it was pointed at**, and worth recording
so a later wave does not re-hunt them: single-parity pins (service court,
interval, rally-winner, game-change serve all swept both parities AND both
sides), redundant guards, inert seams (the dock `mutate`→submitted payload is
proved in e2e, not merely unit-tested), palette tokens (all three new entries
inside the closed `board/board-2/ink/led/caution/dismissal` vocabulary, cricket
untouched), i18n (42/42 `pad.badminton.*` keys identical across all four
dictionaries with matching placeholders; no `gen-keys` regen owed, because only
a VALUE changed), and vacuous assertions.

**Review finding 1 = P-5 above**, independently reproduced by code reading and
correctly characterised: `HOLD_MS` is a sport-agnostic chassis race in
`queue.ts`, not a per-sport knob. Still open, still an owner decision.

**Review finding 2 — "you claimed tennis doubles gains the separator and never
checked."** Fair, and acting on it found a THIRD defect that neither the review
nor the play-through had seen. Driving a real tennis-doubles fixture showed:

```
visible:    "Ada Lovelace/Alan Turing"          ← fixed by P-1
aria-label: "Ada Lovelace, Serving, Alan Turing" ← still broken
```

`whoNames()` folds a serving label into its line with a comma AND joined the
LINES with a comma, so the two levels were indistinguishable: a listener gets
three flat items and cannot tell that "Serving" belongs to Ada rather than to
Alan. **The chassis's own unit test had frozen this as its expectation**
(`scorebug.test.ts`, `.toBe("Alice, Serving, Bob")`) — the "test froze the bug"
class, and the reason the defect survived R4's sign-off and this wave's review
alike. Lines now join with `"; "`: `"Ada Lovelace, Serving; Alan Turing"`.
Blast radius is pinned rather than asserted this time — a new test proves a
single who-line joins a one-element array and can carry no separator at all, so
cricket's two halves, football's two and every singles fixture in every sport
are byte-for-byte unchanged. v3 unit suite 1220 → **1221/1221**; badminton +
tennis + the doubles probe **11/11 e2e green**; verified visually at 320.

**The transferable lesson, and it is the third time this wave has paid it:**
P-1 came from playing rather than reading, P-3 came from noticing my OWN
sampling was single-parity, and this one came from checking a sentence I had
written in a commit message as though it were a result. A claim about a surface
you did not open is a hypothesis. This programme's screenshots, unit tests and
adversarial review all passed over it.

### R5 — SESSION STATE #2, written for compaction (2026-08-27, later)

Supersedes the earlier "SESSION STATE" block above wherever they disagree.

**Where.** Worktree `.claude/worktrees/r5-racquet`, branch
`feat/scorepad-v3-r5-racquet-split` off `main` `addd126c5`. Env label `r5`:
server `http://localhost:3368`, Postgres `:54573`, db `seazn_r5`. Bring the
env vars into a shell with
`eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label r5)"`,
and note vitest here REFUSES to start without a `DATABASE_URL=` prefix.

**DONE — all three sports are converted and the registry is flipped.**

| Task | Commits | Reviewed? |
| --- | --- | --- |
| A — engine serve reader | `80386a342` `26a04f4dd` + fixes `8becbca50` `add70056a` `85cc79166` `4f2e7e9b3` `1191627a4` | yes — 6 findings, all closed, 11/11 mutants die |
| B — e2e harness photographs the defects first | `c60b920bf` `015f7ec5b` | n/a |
| C1 — badminton + 3 palettes | `83c527da0` `20e2042ce` `ad3fa577c` `c8ca84b10` | yes — 2 findings; acting on one found a third defect |
| C2 — table tennis | `2a6344f67` `a55c371b2` `efc5c2fb6` + fixes `acd53ac27` | yes — 2 defects + 3 coverage holes, all fixed |
| C3 — volleyball | `c05506c9d` `5d3a342f7` | **reviewer IN FLIGHT at compaction** |
| chassis fixes from playing | `14b3a4650` `721d975c9` | yes |
| rulings/docs | `538333433` `1915cff0a` | n/a |

**Counts I ran myself (not agent-reported), at `5d3a342f7`:** v3 unit
**1397/1397**, 0 failed, 0 failed suites, 28 files, zero paths outside the
worktree. `turbo typecheck --filter=@seazn/web` 0 errors uncached. i18n parity
OK. e2e: table tennis 5/5, badminton + tennis 11/11.

**STILL OWED, in order.** (1) C3's reviewer findings → fix + re-verify.
(2) PLAY volleyball in a browser — a rebuild was in flight at compaction; this
is the step that found real defects in both earlier sports and must not be
skipped. (3) Three walkthroughs in `e2e/walkthrough/` (ruling R5-4) — the
directory, the Playwright project (absolute-path-anchored regex,
`playwright.config.ts:119`) and the CI leg (`e2e.yml:181-183`) all already
exist. (4) Delete `skins/racquet-skin.tsx` + its 3 `RESOLUTION_KIND` rows with
`git grep -a` zero-ref proof — only now that all three sports have flipped.
(5) Gallery AFTER sheet + owner sign-off. Smoke DEFERRED to R8 by name; say so
in the PR body.

**Owner instructions taken this session, both standing.**
- **Reviewer loop per TASK** (ruling R5-6), not per wave.
- **NEVER file a GitHub issue — or any outward-facing artifact — unless the
  owner asks for that specific one.** One approval is not a pattern: `#675`
  was asked for, `#676` was not, and filing it was corrected. Record findings
  in this file and in chat by default; if an issue seems warranted, ask in one
  line and carry on. Saved to memory as `feedback_never_file_issues_unprompted`.

**Two CHASSIS defects, both OPEN, both deliberately NOT fixed in R5** (each
would touch all eleven skins mid-wave):
- **#675** — the ~6s `HOLD_MS` window drops the wave's headline per-player
  attribution with no recovery (`activity.tsx:347` offers void only; v3 has no
  edit path). Entrant credit SURVIVES via `points_won`'s `fromEntrant` fallback
  — only the per-player split is lost. Proposed fix is a commutative
  `<sport>.rally.credit { targetSeq, scorer }`, because a point is ordered and
  a tally is not. Rejected: env var (client-side, `NEXT_PUBLIC_*` bakes at
  build), 6s→10s (worsens spectator lag), per-division cfg (`configSchema`
  STRIPS unknown keys, so it would silently vanish; a first-class column beside
  `scorer_can_finalize` would work but hands the org a dial for a race).
- **#676** — `PadHostView.state` is the OPTIMISTIC fold while
  `PadHostView.events` is the CONFIRMED ledger (`pad-host.tsx:785`), so they
  disagree by one event for the whole hold. The serve reader correctly refuses,
  and **the serve strip blanks for ~6s on EVERY rally, in badminton AND table
  tennis** (reproduced twice each in a browser). Predates R5. Fix is to make
  `view.events` optimistic too — its own wave.

**The pattern this wave keeps paying for, worth carrying forward.** Every
defect found here came from something ASSERTED rather than EXECUTED, and all of
it sat behind a green gate of ~1300 unit tests plus passing e2e and
screenshots:
- a commit message claiming tennis doubles was fixed → checking it found the
  `whoNames` accessible-name defect, which the chassis's own test had FROZEN as
  its expectation;
- a test COMMENT arguing carefully for a property its fixture did not have →
  the `setStart:"alternate"` fixture defeated "winner serves next" but not
  "loser serves next" (proved by mutating the kernel: the old test SURVIVED);
- an e2e spec written but never RUN → two real table tennis defects;
- my own single-parity SAMPLING while playing → nearly reported a correct
  service-court rule as broken.
So: run the spec, play the pad, mutate the guard. A green suite is the floor.

### R5 — the parallel finding sweep, and what four independent reviewers found

Run after C3 landed, with the owner's explicit "start in parallel if possible
for finding". Four agents on provably disjoint read-only ground: a zero-ref
scout for the `racquet-skin.tsx` deletion, an adversarial reviewer on the C3
volleyball diff, a cross-sport capability-regression reviewer (what did a
sport LOSE in the split?), and a preset-law-vs-skin truth auditor.

Every finding below was re-verified by the main thread before it was believed.
Three of the four survived; the numbers matter more than the prose.

**F1 — `needsServeAnchor`'s two exclusions are held by NOTHING, in BOTH
volleyball and table tennis.** `volleyball.tsx:793-796` and the byte-identical
`tabletennis.tsx:671`. The reviewer neutered the predicate body to
`return true`; the full 97-test volleyball skin suite stayed GREEN. Verified
independently: `grep -a "recorded-disagrees\|ledger-mismatch"` across
`__tests__/volleyball.test.ts` and `__tests__/tabletennis.test.ts` returns
ZERO matches. The shipped logic reads correct against `kernel.ts`'s own
`setBasedServeContext` (~:1355-1400) — this is a missing gate, not a live bug,
and C3 inherited it from C2 rather than closing it.

**F2 — table tennis's dock vanishes the moment the LAST question is answered,
and the wave's own fix caused half of it.** C2 fixed the DOUBLES case by
adding a `pair.length > 1` gate at `tabletennis.tsx:1039-1049`; that gate then
excludes SINGLES, where step 2 (the ITTF expedite return count,
`state.expedite === true`) genuinely does ask a question. A singles scorer
under expedite taps the return chip and the whole dock disappears, taking the
"Send now" control — the only way to commit before `HOLD_MS` expires — with
it. Worse, and NOT in the reviewer's report: in DOUBLES the settled dock shows
only the scorer chip, so the expedite answer is never confirmed either. Every
sibling's equivalent branch is unconditional — `badminton.tsx:1100`,
`volleyball.tsx:1310`, `tennis.tsx:1224`.
`tabletennis.test.ts:884-887` FROZE the closed-dock behaviour as intended, two
tests below the very fix it was modelled on. Invert that probe, never delete
it (`reference_task_verify_green_while_breaking_another_harness`).

**F3 — badminton drops the side label on a Time-out.** `badmintonDetail`
(`badminton.tsx:1142-1167`) has no `TIMEOUT_TYPE` case and falls to
`default: return undefined`, so the activity ribbon shows a bare "Time-out
recorded". Both siblings resolve `payload.by` through `ctx.state`
(`tabletennis.tsx:1081-1089`, `volleyball.tsx:1348-1355`). Reachable on a
legal cfg: `badminton.tsx:942` reads `records.timeouts` PER FIXTURE rather
than hardcoding the type off, so this is an oversight, not a dead path.

**F4 — volleyball's serve anchor is a ONE-SHOT window (product gap, not a code
defect).** Engine-verified at `kernel.ts:1244-1252`: `serving` self-heals on
every ordinary rally unconditionally, but `chainBroken` — which gates
`rotation` and `serverPersonId` — clears only via a fresh declaration or a
resolved set boundary. `needsServeAnchor` gates on `ctx.side !== null`, which
resolves after rally 1. So in the NATURAL flow (open the pad, start scoring,
never touch the separate "note the server" tile) the anchor withdraws after
one tap and the rotation number stays dark for the rest of the set. Documented
in three independent places, so deliberate — but the tile is `kind: "minor"`
(`volleyball.tsx:917-926`), the same tier as three neighbours, with no
elevated urgency on a window that closes after a single tap.

**F5 — FR and NL reintroduce the 320px truncation this wave already fixed
once.** `pad.volleyball.dock.rally.scorer.title`: FR 31 chars, NL 26, against
the sibling wording's 21/17 (EN and ES match the siblings). Only FR and NL
translated "won it" as "won THE RALLY". The EN original was shortened earlier
this wave for exactly this reason, and the shortening did not travel.

**Not a finding, but the deletion is bigger than the brief said.**
`racquet-skin.tsx` is runtime-UNREACHABLE (`registry.tsx:292-312` short-
circuits to the v3 lane for all three sports before `skinFor` can run) but it
is NOT zero-reference: three live static imports (`skins/registry.ts:38,43`,
`__tests__/skin-locked.test.tsx:66`, plus its own dedicated unit test), 9
`scorepad.skin.racquet.*` keys × 4 dictionaries, and a now-dead v2 branch of
the `lane === "v3" ? … : racquetHeaderValue(...)` ternaries in
`gallery.capture.ts`. A one-line delete would red the build.

### R5 — the width bar the wave was about to merge without

`git grep -a` for badminton, tabletennis or volleyball across
`apps/web/e2e/mobile.spec.ts` returned ZERO matches. R5 ships three brand-new
v3 render trees, and this file's seven projects (320/360/375/390/430/768/834)
are the only place any new surface gets width coverage narrower than 375/768
at all — the exact reasoning T16 gives for cricket, unapplied three more
times. Closed by **T17**: one test per sport, each asserting the pad rendered
(not just a 2xx shell), both tap-model-S scoreboard halves at the 44px floor,
and no horizontal scroll; table tennis and volleyball additionally open the
serve-anchor SHEET, and volleyball opens the libero **Swap-sheet** — twelve
candidate rows in one list, the densest thing any of these three pads renders,
and a surface neither sibling has at all.

### R5 — environment trap that cost three build attempts

`seazn-env rebuild --label r5` exited 0, printed its own success line, and
emitted NO `.next/standalone` at all; the server then died with
`Cannot find module .../standalone/apps/web/server.js`, which reads as a
broken build. Cause: turbo's local cache is shared across ALL worktrees of
this repo by content hash, not by path, so a same-hash HIT replays another
worktree's build verbatim and bakes that tree's absolute `appDir` into
`required-server-files.json`. `up --server` carries the guard and re-runs with
`--force`; `rebuild` did not catch it. Two more masks compounded it in the
same ten minutes: `--filter=web` is wrong (the package is `@seazn/web`; turbo
exits 1 with `No package found`), and the background command's own completion
notification reported "exit code 0" while the log's `EXIT=$?` said 1. Assert
the ARTIFACT, never the exit code. Written to memory as
`reference_turbo_build_cache_hit_from_another_worktree`.

### R5-7 — owner ruling, 2026-08-27: the serve anchor stays while it can still fix something

Taken after the gap was demonstrated live rather than argued. Volleyball's
anchor tile gated on `ctx.side !== null`, and `side` self-heals on the first
ordinary rally — so a scorer who simply started scoring lost the FIVB 7.6.2
rotation number for the whole set, with sanction, time-out and More the only
tiles left. Driven in a browser at 390px:

| | anchor tile | rotation |
|---|---|---|
| on open | present | — |
| after ONE ordinary tap | **gone** | never appears |
| after five rallies | gone | still nothing |

The same fixture anchored first showed Rotation 2, then 3.

Two C3 tests asserted the withdrawal deliberately, reasoning the tile "does
not linger asking for a rotation number `side` alone cannot fix". True of
`side` — but the tile posts a DECLARATION, and a declaration is exactly what
clears `chainBroken`. The premise named the wrong thing.

**Ruling: keep offering it while anything it can fix is unresolved; withdraw
once the pad can report both.** The owner chose this over retitling the tile
(rejected: a new key in four locales for a wording problem the strip's own
copy does not actually create) and over merely elevating its `kind` (rejected:
the window still closes, and a scorer who misses it still loses the set's
rotation). `fieldsTheRotation` — the kernel's unexported `sideFieldsTheRotation`
restated, pinned against a real fold of the beach variant — stops the tile
becoming permanent furniture for a pair, which has no six to rotate.

Shipped in `aca58a959`, re-driven live afterwards: the tile survives five
ordinary rallies and the rotation is recoverable.

### R5 — the defect a SCREENSHOT found that no assertion could

Reading the 320px capture of a played volleyball match: the Activity list held
five rows, every one of them "Rally recorded", each with its own Void button.
`activityDetail`'s rally case returns `join([named(scorer), named(server)])`,
which is `undefined` when nobody was attributed — and for volleyball that is
the ORDINARY case, its halves being team-level, not an edge one. Badminton and
table tennis reach it too, on any pair rally sent before the dock's scorer
question is answered.

At a scoring desk this is how the wrong point gets voided. All three sports
now fall back to naming the winning side; a named person still wins, being the
more specific fact. Fixed in `aca58a959`, mutation-killed one test per sport,
and confirmed by re-reading the same 320px screen: rows now read "Rally
recorded — Home" / "— Away".

Worth keeping for the next wave: this is the second finding in two days that
came off a screenshot rather than a suite, and both were in the ribbon/activity
surface, which no unit test renders and no e2e spec reads for MEANING.

### R5 — two verification traps that produced false signals this session

**A vitest JSON run reported `numFailedTests: 0` while 25 suites failed to
COLLECT.** Green by the usual reading, and by `_RULES.md` §2's own instruction
to judge from the JSON reporter. The tell was `numTotalTests` falling from
1402 to 42 — the failed count alone says nothing when nothing ran. Cause: the
run was launched from the WORKTREE ROOT, so `@/` aliases did not resolve and
paths came back as `/r5-racquet/src/...` instead of `/r5-racquet/apps/web/
src/...`. **Run vitest from `apps/web`, and judge `numTotalTests` first.**

**`seazn-env.sh`'s appDir guard could never match.** Next writes
`required-server-files.json` with `"appDir": "/abs/path"` — a space after the
colon — and the guard grepped for `"appDir":"..."` without one. It therefore
fired on every invocation: force-rebuild, "wrong" appDir again, rebuild again,
never starting a server, ~4 minutes a lap. Patched in the machine-local script
to match against a space-normalised copy with `grep -F` (a worktree path
contains `.claude`, so an unescaped regex would be wrong too). The underlying
hazard it guards is real and worth knowing: **turbo's build cache is shared
across ALL worktrees by content hash, so a cache HIT replays another
worktree's build and bakes that tree's absolute appDir in.** Two further masks
compounded it — `--filter=web` is wrong (the package is `@seazn/web`, and
turbo exits 1 with `No package found`), and a backgrounded command's own
completion notification said "exit code 0" while the log's `EXIT=$?` said 1.
Assert the ARTIFACT (`ls .next/standalone/apps/web/server.js`), never the exit
code.

### R5 — SESSION STATE #3, written for compaction (2026-08-27, late)

**PR #678 is OPEN** — `feat/scorepad-v3-r5-racquet-split`, worktree
`.claude/worktrees/r5-racquet`, label `r5`, server `http://localhost:3368`,
Postgres `:54573`, db `seazn_r5`. Everything below is PUSHED except where said.

`eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label r5)"`

**THE ONE DEFECT THAT MATTERS MOST, root-caused and NOT yet fixed.**
The libero swap — C3's headline feature — CANNOT SUBMIT AT ALL.
`LIBERO_TYPE` is `core.lineup.replacement` (`volleyball.tsx:255`), but the
setbased `padSpec` declares only rally / summary / timeout / sanction / sub /
expedite (`kernel.ts` ~1549-1700). `createSkinDispatch`
(`scorepad/skins/types.ts:154`) THROWS on any type the spec does not declare,
and `pad-host.tsx:1146` calls it as `void dispatch(...)` — so the promise
rejects into nothing: the sheet closes, no event is written, no banner, no
log. The engine is innocent, proven by folding the exact payload the UI
builds: it succeeds cleanly and puts MB back on court with `timesOn: 1`.
Football avoids this by posting `football.sub`, a DECLARED MODULE type
(`football.tsx:1304`); volleyball is the only skin posting a core type.
Unit-green throughout — the builder is tested, the dispatch gate never is.
Fix candidates, in order: (a) post the declared `SUB_TYPE` carrying the libero
exemption — check `SetBasedSub`'s strict schema first, it is
`{by, off?, on?}` and does NOT carry `exemption` or `on.roles`, so this
likely needs an engine change; (b) let `core.lineup.*` past the declared-set
gate, since that gate exists for MODULE actions and the swap surface has its
own eligibility gating. `scorepad-v3-volleyball.spec.ts`'s libero test is
RED and left red on purpose so this cannot be lost.

**Shipped this session (11 commits).** `c1ef8133e` T17 seven-width bar +
volleyball anchor exclusions · `a1e3265fe` TT dock for every answered question
+ badminton time-out side · `2d9cd02ec` racquet-skin deleted ·
`aca58a959` R5-7 anchor stays + activity side fallback ×3 sports ·
`4db264be3` FR/NL truncation swept · `098be05a7` docs · `db4c5de2a`
`fieldsTheRotation` reads the kernel's own input · `ad793b52a` three
walkthroughs + volleyball spec fixed (was 3/6 RED, committed unrun) ·
`555c1aff0` decided board no longer names a game nobody played ·
`f0e7b2cbe` walkthroughs to the decider + undo + re-finish, T17 vacuity —
**NOT YET GREEN, see below**.

**Owed, in order.**
1. `f0e7b2cbe` is UNVERIFIED. Last run: badminton and TT failed on my own
   arithmetic (fixed there, unrun); volleyball failed its PRE-EXISTING
   post-undo `halfScore(home) === "2"` with `"0"`, and it passed before those
   edits — settle whether that is a real undo defect at a set boundary or
   contention from three specs on one loaded machine. Run:
   `cd apps/web && PLAYWRIGHT_BASE=http://localhost:3368 E2E_PROD_TARGET=1 npx playwright test --project=walkthrough --workers=1`
2. The libero dispatch defect above.
3. `scorepad-skins.spec.ts:307` is RED — CONFIRMED by live run, times out at
   120s on `getByLabel("Points — Away")`, and `[data-role="confirm"]` has ZERO
   producers in v3. Fix with `scorepad-v3-volleyball.spec.ts:269-274`'s idiom:
   per step, `getByRole("spinbutton")` then `Confirm`, twice. Merges red
   otherwise — e2e triggers on push to `main`, so the PR never shows it.
4. Two review agents still unreported at compaction: volleyball libero/ribbon
   claims (both-sides tile, `timesOff` candidate filter, FIVB 19.3.2.1 unlimited
   libero replacements vs the pad's `reentry-limit`, missing `LIBERO_TYPE`/
   `SUB_TYPE` activity rows, `pad.volleyball.ribbon.sub` in NEITHER
   `PAD_LABEL_KEYS` nor any dictionary) and the TT/badminton claims (expedite
   chip possibly folding `EXPEDITE_WRONG_WINNER` and DROPPING A POINT; ITTF
   2.15.1/2.15.2 unenforced; `intervalHint` off-by-one re-announcing "Interval
   now"; badminton singles dock self-answering, frozen by a test whose name
   contradicts its assertion).
5. MERGE GATES STILL OPEN: owner visual sign-off (gallery sheet not published)
   and smoke, deferred to R8 by name.

**Two engine-core items needing an owner call, deliberately NOT fixed:**
FIVB 19.3.2.1 makes libero replacements UNLIMITED while `core/lineup.ts`'s
`reentry: "once"` caps them at two stints; and `setBasedServeWalk` is
documented "Total and never throws" but calls `resolveVoids` unguarded, which
can throw inside render where the pipeline's own catch cannot degrade it.

**Verification traps confirmed THIS session, all of which produced a false
signal before being caught:** vitest run from the WORKTREE ROOT reports
`numFailedTests: 0` while 25 suites fail to COLLECT — read `numTotalTests`
first, and run from `apps/web`; a blanked `DATABASE_URL=` silently skips ~490
DB tests into `pending`; turbo's build cache is shared across worktrees by
content hash, so a hit replays another tree's build and `seazn-env.sh`'s
appDir guard could never match it (patched locally); a backgrounded command's
completion notification says "exit code 0" while the log's own `EXIT=$?` says
1; and `rtk`'s grep elided PRODUCTION hits for `data-candidate-id`, which
nearly cost a wrong conclusion about the swap sheet.

**The pattern, now at eight instances.** Every defect this wave came from
something ASSERTED rather than EXECUTED, and the last two came off a
SCREENSHOT and a BROWSER, not a suite: five identical "Rally recorded" rows
each with its own Void button, and a serve anchor that vanished after one tap.
A committed e2e spec that had never been run was 3/6 red. My own new width
test seeded two sports wrongly and would have 422'd at all seven widths. My
own "confirmation" of a reviewer's finding used a grep that could not see
prose test titles. Run the spec, play the pad, mutate the guard.

### R5 — volleyball review verdicts, reproduced against the real fold (2026-08-27)

Landed just at the compaction boundary. All four reproduced with live probes,
not read.

**V-1 — CONFIRMED, REAL, and WORSE than reported. The libero cap blocks
legitimate play partway through SET ONE, permanently.** `core/lineup.ts:469`
(`bringOn`) takes no exemption argument, so `reentry: "once"` applies to a
libero exactly as to an ordinary player — and `kernel.ts:525-534` (`bankSet`)
resets only `subs.thisSet`, never `squads`, so there is no per-set reset
either. A direct `reduceLineupEvent` probe under the real policy refuses the
libero's THIRD on-court entrance: `{ok:false, reason:"reentry-limit"}`. FIVB
19.3.2.1 makes libero replacements UNLIMITED, separated only by a completed
rally; a side using its libero normally is refused mid-set-one for the rest of
the match, with no workaround. **ENGINE CORE — owner call.** Fix: make
`bringOn`'s reentry check exemption-aware.

**V-2 — CONFIRMED, REAL, highest frequency. Every ordinary substitution
renders the raw wire type: "volleyball.sub recorded", in all four locales.**
`scoring-vocab.ts:936` registers `pad.volleyball.action.sub` and all four
dictionaries translate it, so the More sheet genuinely offers Substitution —
but `:955-958` register four sibling RIBBON keys and never
`pad.volleyball.ribbon.sub`. `ribbon.ts:137-146` gates on PAD_LABEL_KEYS
MEMBERSHIP, so it falls to `pad.ribbon.fallback` = `"{event} recorded"`.
Indoor defaults `records.substitutions: true`, and a match runs up to ~60
substitutions. Fix: add the key and translate ×4.

**V-3 — CONFIRMED, REAL.** `volleyballDetail` handles RALLY/SUMMARY/SANCTION/
TIMEOUT and defaults to undefined, so every libero exchange and every
substitution renders an identical, name-free, individually-voidable row —
byte-for-byte the defect this wave already fixed for the RALLY case, left open
for the two event types this skin uniquely introduces. Fix: the same shape,
`join([named(payload.off), named(on)])` falling back to `sideOfEntrant`.

**V-4 — REFUTED, THEORETICAL.** The "Libero tile offered to both sides with a
`timesOff` filter admitting ordinary players" claim conflates the engine's
generic capability with what this skin can reach: `applySub` writes only
`state.subs`, never `state.squads`, and no volleyball UI path emits
`core.lineup.substitution`/`retirement` at all. Probed: the libero-less side's
candidate list is genuinely `[]`. The dev comment was right.

Ranked by harm to a scorer: **V-1 > V-2 > V-3 > V-4 (none)**.

### R5 — decided-board and vacuity verdicts (2026-08-27)

**CONFIRMED, all three.** (a) `scorepad-skins.spec.ts:307` is RED by live run —
times out at 120s on `getByLabel("Points — Away")`, and `[data-role="confirm"]`
has ZERO producers in v3; fix with `scorepad-v3-volleyball.spec.ts:269-274`'s
per-step `getByRole("spinbutton")` + `Confirm`. (b) This branch's own T17
badminton probe was VACUOUS — proven by commenting out both taps and watching
it pass at 320px; fixed in `f0e7b2cbe` by anchoring on the `server` strip item.
(c) The decided board named a game nobody played — real-fold probes returned
`{"bestOf":3,"game":4}`, `{"bestOf":5,"game":6}`, `{"bestOf":5,"set":6}`;
fixed in `555c1aff0`. The three walkthroughs sailed over (c) silently, because
their last on-screen check happens BEFORE the decider closes and afterwards
they read only `fixtureState` then reload the pad away.

### R5 — the racquet-claim sweep: five findings, all CONFIRMED, all fixed (2026-08-28)

Independent verification of five claims against table tennis and badminton.
Every one was reproduced by a live fold or a live board, and **every one was
already covered by a green unit suite** — the wave's own meta-pattern, now at
thirteen instances: the defect was ASSERTED away in a comment, never EXECUTED.
Fixed in `b152353ef`; ranked here by harm to a scorer.

1. **The pad offered an answer the fold would refuse, and destroyed the rally
   for taking it.** With the serve anchor's `serving` present and the SERVING
   side credited, the expedite dock's 13th-return chip made `checkExpedite`
   (`kernel.ts:576`) throw `EXPEDITE_WRONG_WINNER` — ITTF 2.15.4 gives the
   point to the RECEIVER on their 13th good return, so a 13-return rally cannot
   credit the server. The throw rejects the WHOLE rally: the scorer answered two
   questions correctly, tapped the chip the pad itself offered, and lost the
   point and the serve fact with nothing on screen. The chip's own doc comment
   said it was "always safe to offer regardless of who won ... never an engine
   refusal" — false, and written rather than run. The suite already proved the
   engine throws on that payload, and separately proved the dock offers the
   chip; **nobody had put the two in one test.** Both new tests now fold the
   dock's own `mutate()` output through the real engine.
2. **ITTF 2.15.1's score clause was unenforced.** The expedite gate carried no
   score term at all, so one frictionless tap put a match irreversibly into
   expedite from ANY score; 2.15.4 keeps it there to the end of the MATCH,
   `applyExpedite` refuses only a SECOND start, and the only recovery is voiding
   the event. Withheld now at 9-all-or-better — in the tile AND in
   `refusedEventTypes`, since hiding a tile only moves the action into the More
   sheet. **The ten-minute half stays unenforceable and is now owed out loud:**
   this pad folds no game clock and the kernel holds no elapsed time.
3. **Silent non-enforcement, contrary to the dossier.** With `serving` absent
   the fold cannot compare a receiver, so it counts the rally in
   `expediteUnchecked` and lets it stand — correct coarse-tier behaviour, but
   `expediteUnchecked` has ZERO readers in `apps/web` and the dock said the
   identical thing either way. `DOMAIN.tabletennis.md:97-101` asks precisely
   that a pad which cannot enforce the rule "say so rather than let a scorer
   believe the rule is being enforced". It now has its own title.
4. **Badminton's interval announcement lingered for three rallies.**
   `Math.max` has no memory of when the mark was reached: "Interval" showed at
   11-9 (right), 11-10 and 11-11 (wrong — the 60 seconds had been taken and play
   had resumed), clearing only at 12-11. Its own doc claimed "returns null once
   the mark is passed". **The regression test could not see it by
   construction** — its stream scores one side every rally, so the leader never
   sits still while the game moves underneath it. BWF Law 8.1 supplies the
   missing memory free: the rally winner serves next, so "on the mark AND still
   serving" is exactly "the rally that just took them there".
5. **A dock on every singles rally, asking a question with one pre-chosen
   answer.** The settled-scorer branch returned before the singles guard, and
   `buildHalf` stamps the sole scorer at tap time — so every point of every
   singles match opened "Which player won it?" with one chip. Harmless
   (re-stamping the same person) which is why nothing broke. **Its own test was
   named "returns nothing for a SINGLES rally" and asserted `.not.toBeNull()`**
   — the suite pinning the defect in place under a name that denied it.

### R5 — the libero swap, fixed at BOTH ends (2026-08-28, `b152353ef`)

The headline C3 feature could not submit at all. Two independent faults:

- **The type gate.** `LIBERO_TYPE` is `core.lineup.replacement`, and the
  declared set `createSkinDispatch` checks is built from the sport MODULE's
  PadSpec. No module declares a `core.*` type and none ever can — `padLabel`'s
  registry is keyed by per-sport `PadLabel.key`, and `ribbon.ts`'s
  `CORE_RIBBON_KEY` exists precisely because these types cannot earn one. So the
  gate was never "a skin may not invent an event type"; it was a categorical ban
  on a skin emitting ANY core event, including the five the kernel validates
  itself. It now admits `LINEUP_EVENT_SCHEMAS` — sourced from the engine so a
  sixth lineup type is admitted with it rather than going inert the same way —
  and still refuses `core.void`/`core.finalize`, which are host business.
- **The swallow, which is the deeper one.** All six dispatch sites in
  `pad-host.tsx` were bare `void dispatch(...)`, discarding the rejected
  promise: no event, no banner, no console line, sheet closed. Any future
  dispatch fault would have been equally invisible. One `send` now surfaces the
  refusal on the same banner the server's 422s already use, and logs the detail.

The engine was proven innocent first, by folding the exact payload
`buildLiberoEvent` builds: it succeeds and puts the player back on court.

### R5 — a REAL chassis defect the walkthrough found: undo-after-decided crashes the pad (2026-08-28)

**Not an R5 defect, not a flake, and NOT fixed here — a subagent is on it.**

Undoing a match-DECIDING event from the fixture console's "Undo last"
(`fixture-console.tsx:559`) crashes the v3 pad into `ScoringErrorBoundary`:

```
EngineError: core.void targets unknown or non-prior event "<uuid>"
```

Reproduced 4 times in 6 runs of `scorepad-v3-volleyball-match.spec.ts`.
**The fault is client-side, and that is proven rather than assumed:** the
server accepted the void (the fixture goes `in_play`, `outcome: null`) and the
server folds BEFORE inserting, so the server's ledger is valid by construction.
The list that throws is the pad's own.

Prime hypothesis, handed to the subagent to verify or refute: the pad's pipeline
stamps a CLIENT-fabricated id (the idempotency key) on every event it knows
about and never learns the server's row id — `fixture-console.tsx`'s own doc
comment says exactly this, and warns against the same hazard one layer out. The
console's void targets the SERVER id, which the pad's list does not contain.
That also explains why a reload recovers: a cold mount folds the server's list
verbatim.

**Three traps this cost, worth more than the bug:**
- The first red read as a SCORING defect — a stable "0" where the fold said 2.
  It was the error boundary having replaced the scorebug; the locator was
  resolving against the crash screen. **The screenshot settled in one look what
  four log readings had not.**
- The same assertion passed under no load and failed under a concurrent vitest
  run. Load-sensitivity made a real crash look like a race, and a race look
  like a real crash — in opposite runs.
- Three of my own arithmetic errors hid inside it: `away` is 0 after the undo
  (not 2 — the fold says so), four away taps are needed to take a set from
  2-0 at `setTo 3 / winBy 2 / cap 5` (not one), and the fourth tap decides the
  match, so the pad unmounts and there is no board left to read a "4" from.

### R5 — SESSION STATE #4 (2026-08-28)

Branch at `b152353ef`. **Walkthroughs: 10 of 11 green in one full run**
(13.0m, `--workers=1`) — badminton 2.1m, table tennis 2.9m, tennis MTB 3.0m,
football, cricket ×3 all green. The eleventh is volleyball, red ONLY on the
chassis crash above.

Owed, in order:
1. The subagent's undo fix — then re-run the volleyball walkthrough 3× (it is
   intermittent; one green run is not evidence).
2. `scorepad-skins.spec.ts:307` — CONFIRMED red, still unfixed. Use
   `scorepad-v3-volleyball.spec.ts:269-274`'s per-step `getByRole("spinbutton")`
   + `Confirm` idiom.
3. **Owner call, engine core, unchanged from #3:** V-1, the libero re-entry cap
   (`core/lineup.ts:469` `bringOn`) refuses legitimate play partway through set
   one and never resets — FIVB 19.3.2.1 makes libero replacements unlimited.
   Second item: `setBasedServeWalk` throws though documented "Total and never
   throws".
4. Merge gates still open: owner visual sign-off (gallery sheet unpublished),
   and smoke (deferred to R8 by name).

### R5 — the undo crash, root-caused: TWO defects, one symptom (2026-08-29)

The "undo after a decided match crashes the pad" red was **two independent
information losses in the same seam**, either of which alone reproduces the
symptom. That is why it was intermittent: which one fired depended on whether
the console's undo reached the pad through a `router.refresh()` (a full
`initialEvents` batch) or through a **poll tick** — a race, decided differently
run to run.

**Defect 1 — the pad's ledger keeps a client-fabricated id forever.**
An event this pad scored keeps the idempotency key it minted as its ledger id
for the life of the mount: `AppendSuccess` carries no row id, so nothing ever
teaches the pad what the server called that row. A foreign void — built
server-side — names the REAL id. Unresolvable. `mergeEnvelopesIntoLedger`'s
blanket "existing wins" then discarded the correctly-id'd copy that the very
same batch carried for it. Note this also made **S12/#421 pass J inert**: pass
J merges a freshly-read, correctly-id'd row into the ledger through this same
primitive, and "existing wins" was silently dropping it.

**Defect 2 — a polled void names nothing at all.**
`voids_event_id` is on the wire (`EventOut`, `ScoreEvent`) and was
**parsed-then-DROPPED** at the transport boundary; `LedgerSlotEvent` never
carried it. So every void this device did not itself submit, arriving via the
poll path, widened into a `core.void` with no target. `resolveVoids` rejects
that exactly as it rejects an unknown id. **This was never console-specific:
a second referee's undo on a shared fixture took the same path.** Found only
by running the walkthrough three times against the Defect-1 fix — 2 green,
1 red — and reading the screenshot, which showed a live pad behind a rejection
banner rather than the error boundary.

**Why it crashed rather than degraded.** `foldedState` catches. But a v3 skin
computing a serve/rotation label reads `pipeline.events` — the raw, unfolded
list — synchronously during render with no try/catch, so the throw reached
`ScoringErrorBoundary`.

**Fixed** in `transport.ts` (keep the field), `types.ts` (`LedgerSlotEvent`
carries it), `ledgerSlotToEnvelope` (widen it into `voids`), and
`mergeEnvelopesIntoLedger`, whose rule is now stated as what it always meant:
on a seq collision the WIRE copy wins where the two genuinely disagree on
`.id` or `.voids`, unless adopting it would DROP a void target already held.
Both halves are needed — correcting an id under a seq without allowing a void
to be re-targeted just moves the dangling reference to the other side.

Each half has its own MUTATION TARGET test, verified to red independently.

**The trap worth keeping:** one green run proved nothing. The first fix passed
the walkthrough twice before the third run exposed a second, unrelated defect
underneath it.

### R5 — every `minor` tile in every v3 skin was a 40px touch target (2026-08-30)

Found by the new mobile spec, then MEASURED in a real browser rather than
argued: `tile-grid.tsx`'s `minor` kind painted 40px and claimed the repo's
44px floor through a `::before` bleed of 2px top and bottom. It never worked.
`document.elementFromPoint` 1px above the tile returns the **grid container**,
and a click dispatched there does not open the tile's sheet. So the quietest
tile in cricket, tennis, football, badminton, table tennis and volleyball has
been under the floor since the technique shipped.

Two reasons it survived four waves:
- **The e2e probe measured paint, not tappability.** `boundingBox()` cannot
  see a hit area larger *or smaller* than the painted box, so it could not
  tell a real 44 from a claimed one. The volleyball anchor passed the old
  assertion only by accident — its second label line grows the box past 44 —
  while table tennis's identical `minor` anchor, one line shorter, reported 40.
  The new `assertTapFloor` hit-tests the control's own edges instead.
- **The technique warned about itself.** Its own comment recorded that any
  ancestor with `overflow: hidden` clips the bleed back to 40px "with no
  warning anywhere at runtime" — two ways to be wrong, for 4px.

Fixed by painting the real height: `minor` is 44, the dead `::before` classes
are gone. Verified at 320 / 768 / 1280 — no horizontal scroll, and every tile
on the pad measures ≥ 44 with both edges hit-testing to the tile itself.

**The trap:** a floor assertion that measures the wrong property is worse than
no assertion — it certifies the defect. Ask what a finger does, not what the
box says.

Two test bugs of my own surfaced in the same run and are fixed with it: the
volleyball floor spec seeded all six players as starters and then posted a
libero exchange bringing one of them ON (`LINEUP_INVALID: … is already on the
field`) — it needed a seventh, on the bench, carrying `roles: ["libero"]`,
which is also the Swap tile's own gate; and the first version of
`assertTapFloor` probed `elementFromPoint` without scrolling, which answers
`null` for anything below the fold and reads exactly like a product defect.

### R5 — SESSION STATE #5 (2026-08-30)

**Pushed** — `f0bbc91f9..d71559161` on `feat/scorepad-v3-r5-racquet-split`:
- `caf43aee2` the foreign-undo fix (three defects, below)
- `d71559161` the 44px minor-tile fix (below)

**Uncommitted in the worktree at the time of writing** — engine libero ruling
(5 files, verified green by me, not by the agent's word) + `swap-sheet.tsx`
clip fix (rebuild in flight, not yet visually confirmed). One subagent still
running on the apps/web half of the libero ruling.

#### Decisions taken this session (all owner-level, all deliberate)

1. **A libero replacement does not consume the substitution re-entry
   allowance.** `bringOn` gained `exemptReplacement`; for a
   `core.lineup.replacement` carrying a declared exemption the two COUNT
   refusals (`reentry-forbidden`, `reentry-limit`) are skipped. FIVB 19.3.2.1
   vs 15.6.
2. **`reentryPositionLock` STAYS applying, exempt or not.** This is the half I
   nearly got wrong: my first proposal was "bypass the re-entry knobs", and
   reading the tests showed two of them assert the lock ON the libero path,
   deliberately. FIVB has the replaced player return to the position they
   left. `it("REFUSES a return to any other position")` must stay green and
   UNEDITED — it is now the guard rail that stops the bypass widening.
3. **The bypass covers ANY declared exemption, not just libero.** Justified by
   measurement, not principle alone: every exemption in the repo carries its
   own cap (volleyball `libero: {}` uncapped by intent; football
   `concussion: {max: cfg.concussionSubs}`; cricket `{max: concussion}`), all
   enforced separately in `reduceLineupEvent`. So the bypass removes no limit
   — it routes each exemption to the limit its own variant declared. A
   concussion replacement is one-way, so the change is inert outside
   volleyball.
4. **One engine test REVERSED, on the record.** `"REFUSES a second return —
   re-entry is `once`"` asserted a refusal FIVB does not have. Rewritten into
   `"permits an unlimited libero cycle"`, extended to 6 replacements, with the
   old assertion and the reason it was wrong preserved in the comment. Paired
   with a new `core/lineup.test.ts` guard proving an ORDINARY substitution
   under `reentry: "once"` is still refused on its second return.
5. **`minor` tiles are 44px, painted.** The `::before` bleed that claimed 44
   never worked (measured: `elementFromPoint` 1px above returns the grid
   container; a dispatched click does not open the sheet). Dead classes
   removed. Costs 4px of visual quiet on every v3 skin — owner may prefer the
   alternative that keeps both (40px paint inside a 44px button); that is a
   restructure of the tile and was NOT done.
6. **`mergeEnvelopesIntoLedger`'s rule restated** as what it always meant: on
   a seq collision the WIRE copy wins where the two genuinely disagree on
   `.id` or `.voids`, unless adopting it would DROP a void target already
   held. `incomingIsLocal` marks the one caller whose incoming is local.

#### Defects found and fixed, with the mechanism worth remembering

- **The undo crash was THREE defects** (`caf43aee2`), each sufficient alone,
  which is why it was ~2-in-3 flaky: client-fabricated ledger id;
  `voids_event_id` parsed-then-dropped at the transport boundary (so any
  FOREIGN void arriving by poll named nothing — a second referee's undo, not
  just the console's); and `runDrain`'s ack append letting the local copy win
  even for ALREADY-APPLIED, reached when a reload aborts a POST the server
  already committed.
- **`minor` tile 40px** (`d71559161`) — see decision 5.
- **The swap sheet's off-chip is CLIPPED** (uncommitted). `swap-sheet.tsx:376`
  carried `shrink-0` and no `max-w-full`: measured at 390px the chip is 375px
  wide inside a 314px row and spills 77px past the card, which the wrapper's
  `overflow-hidden` then clips — the player's name is cut mid-string on the
  one control whose job is confirming who leaves the court. **Invisible to
  `expectNoHorizontalScroll`**, because the clip means the page never scrolls:
  proven, `pageHScroll: 0` while spilling. Any regression test must assert the
  chip's right edge against its CONTAINER's, never the page's.

#### Open questions — none blocking, all owner calls

1. **The 44px visual delta** (decision 5) — accept, or restructure the tile to
   keep 40px of paint inside a 44px hit box?
2. **The Swap sheet's "WHO COMES OFF?" step is six visually identical rows.**
   Observed at 390px: two-line wrapping names, nothing encoding position
   (MB/OH/S/OPP) or which player is the libero — and `liberoCandidatesFor`
   already computes the libero/returning distinction (`hasLiberoRole(member)
   || member.timesOff > 0`) and throws it away by flattening to
   `candidates: string[]`. For a control tapped between rallies the referee
   scans by POSITION, not by name. Proposal: lead each row with the position,
   name secondary, and mark the libero. NOT done — it is a real UI change with
   4-dictionary i18n cost and e2e impact, so it needs a ruling first.
3. **R5 merge gates still open**: owner visual sign-off (gallery sheet
   unpublished) and smoke (deferred to R8 by name).
4. **e2e gives this branch NO signal until it merges** — `e2e.yml` triggers on
   push to `main` only. Everything verified this session is local.

#### Verification standard that caught the most

Every "engine-only" change was re-run against `apps/web`, and that is what
caught the libero UI fork: the skin keeps its OWN copy of the re-entry rule
(`volleyball.tsx`'s `liberoBlockedReason`, whose comment says "Mirrors
`core/lineup.ts`'s own `bringOn` reentry checks"), so the engine started
permitting an exchange the pad still greyed out. The test that caught it is
the skin's own MUTATION PROOF, which folds the pad's verdict through the REAL
`reduceLineupEvent` precisely so the two cannot drift. Keep that shape.

### SESSION STATE #6 — R5 wave boundary, all gates re-run by the orchestrator

Everything in #5 above stands. What follows is verification, not new decisions,
plus two corrections found while verifying.

#### The libero ruling landed on both sides

`liberoBlockedReason` (`v3/skins/volleyball.tsx`) now returns `null`
unconditionally, and the claim underneath it was checked rather than accepted:
`bringOn` skips ONLY the two count refusals (`reentry-forbidden`,
`reentry-limit`) for an exempt replacement, and `reentryPositionLock` still
applies. The lock is nonetheless unreachable from this UI in all three of its
cases, because `buildLiberoEvent` sends `lastPositionKey` exactly when the lock
would read it — `timesOff > 0 && lastPositionKey !== undefined` on both sides.
So the pad cannot offer a candidate the engine will then refuse.

Two tests were deliberately reversed and one retired ("threads it into the swap
sheet's blocked reason") — the `t()` call site it exercised is now unreachable.
Each carries a "formerly asserted X, and here is why that was wrong" comment.
`LIBERO_REFUSAL_KEY` and its four dictionaries were kept, not deleted: the
wave's brief names both "once" AND the position lock as wording this skin owes.

#### Correction 1 — `assertTapFloor` had a scroll artifact, not a defect

The helper failed at **320px only**: `scrollIntoViewIfNeeded()` scrolls the
minimum distance, parking the tile FLUSH with the viewport top, beneath the
sticky nav — so the top-edge `elementFromPoint` landed on the nav and reported
a healthy control as untappable. It reads exactly like a width-specific product
defect. Now `scrollIntoView({ block: "center" })`, which leaves the occlusion
check the probe exists for fully intact.

#### Correction 2 — the chip fix is proven, not asserted

Mutated `max-w-full` back to `shrink-0`, rebuilt, re-ran: `the who-came-off
chip spills 61px past its container's RIGHT edge (359px inside 314px)`.
Restored, rebuilt, green. The regression now lives in `mobile.spec.ts` as
`assertNoContainerSpill`, and the volleyball test drives **step 2 of the swap
sheet** — the half no earlier gate reached at all.

#### Counts, run by the orchestrator at the boundary

| Gate | Result |
| --- | --- |
| `packages/engine` vitest | 4192 total, 4179 passed, **0 failed**, 0 failed suites |
| `apps/web` scorepad vitest | 1918 total, 1916 passed, **0 failed**, 2 pending, 489 suites |
| `turbo typecheck lint` (full repo, CI's own command) | 4/4 tasks, **0 errors**, 125 warnings — the pre-existing baseline |
| Racquet pad e2e, all **seven** widths | 21/21 passed |

The two new lint warnings the UI change introduced (unused `member`/`policy`)
were cleared with a scoped disable and its reason: removing the parameters
cascades into `t` and `LIBERO_REFUSAL_KEY` going unused, a strictly larger
blast radius than the seam is worth.

---

## R6 (2026-08-30) — period pair: hockey + ice hockey

Wave opened 2026-08-30. R5 (#678) merged as `e23dcf241`. R6 and **R7 run
CONCURRENTLY** by owner ruling, separate worktrees, separate PRs. The
cross-session file contract with R7 is recorded at the end of this block.

### R6 — owner rulings, taken before any code

| id | ruling | reason recorded with it |
| --- | --- | --- |
| R6-1 | **Ice hockey palette = candidate A, glacier cyan** (`board #08090c`, `board-2 #14181f`, `ink #eef2f6`, `led #67e8f9`, `caution #ffc233`, `dismissal #ff6b6b`) | Owner ruled A off the published comps sheet. Recorded because it went **against the session's recommendation of B**: A measures ink 17.70 / accent 13.74 on the board, a separation of only **1.29**, so score and labels sit at near-identical luminance; B measured 8.96 / 17.84, separation 1.99, the only candidate where the score out-glows everything. **Mitigation owed by the build:** the scorebug's hierarchy must come from SIZE and WEIGHT, not luminance, or the score stops dominating. Verify at sign-off. |
| R6-2 | **Field hockey palette approved as drawn** — the blue water pitch (`board #06323c`, `board-2 #0a4657`, `ink #eef6f8`, `led #ffd23f`, `advisory #3ddc84`, `caution #ffd60a`, `dismissal #ff5a4d`) | Only teal ground in the set, a full hue from tennis's navy. All floors pass: ink 12.54, accent 9.51, green swatch 7.70, red 4.46. |
| R6-3 | **A SEVENTH sport token, `advisory`, is APPROVED** for the FIH green card | FIH umpires carry three cards and all three are SWATCHES held up, not words; every class sets `teamShort: true`, so they are one signal at three strengths. Two tokens cannot express a three-step ladder, and collapsing green into prose loses colour at the exact place colour IS the information. Tennis's "ends take the tones, middles read as words" precedent does not transfer: tennis's ladder genuinely is words. **Blast radius, approved explicitly:** `SPORT_TOKENS` + the hockey palette (`sport-theme.ts`), `SheetChoiceStep.tone` (`types.ts`), one `.pad-*` rule (`globals.css`), `contrast.test.ts`, `sport-theme.test.ts`. Record under `Unplanned fixes` in the PR. |
| R6-4 | **D-10 CLOCK = option B — the pad builds a local clock that stamps `at`** | See the false premise below; this is the wave's biggest scope change and it was taken deliberately. Options offered were A (match football: read `asOf`, omit when absent — ships ice hockey with no clock AND no PP countdown, D-10 slips to R8), B (build it), C (derive from wall time — rejected: both sports are stop-clock, so it drifts on every stoppage). **Football inherits a working clock for free.** |
| R6-5 | **HOC-04b card-flow presentation: build the straightforward version, owner rules LIVE in the walkthrough** | The question is tap sequence and how the person lands, which a mockup cannot judge. The walkthrough is already a merge gate, so it costs nothing extra. |
| R6-6 | **44px tile delta (left open by R5): CLOSED at 44px** | It is the accessibility floor and already the standing bar. **Hit-test with `elementFromPoint`, never `boundingBox()`** — R5's defect was that the measurement lied (it measures paint, not tap area), not that the number was wrong. |
| R6-7 | **Swap-sheet "who comes off" row (left open by R5): position-led, built in R6, walkthrough verdict** | Both sports declare position slots with `reentry: "unlimited"` and a keeper group (hockey 11 + 7 bench, `GK`; icehockey 6 + 17, `G`). Rolling subs run through this sheet constantly; no other wave exercises it as hard. **CONDITIONAL — see the `resolvePositions` finding below.** |
| R6-8 | Concussion-replacement origination (no pad can send `core.lineup.replacement` with `exemption`) — **proposed routing to R7, owner silent, NOT yet ruled** | It is a lineup-editor surface and R7 owns the lineup editor (D-1, D-18). Recorded as PROPOSED, not decided. Re-raise before R6's PR, or it dies in the gap between two waves — which is the exact failure mode this register exists to prevent. |

### R6 — false premises found (verified against the tree, before any code)

- **"Football's R3-2 stamps `at` from a view clock, so R6 reuses the precedent" — FALSE, and it is the reason R6-4 exists.** `v3/skins/football.tsx:312` `readClock` reads `state.asOf` and returns `undefined` when absent or stale; the strip item is then OMITTED. The skin's own comment (:305-310) states it outright: `state.asOf` is set ONLY by a stamped event's `at`, and **no v3 tile sends `at`** except the swap, which copies an `asOf` that already exists. A stream recorded entirely through the pad therefore has **no clock at all, ever**. Football renders none and is honest about it.
  **The consequence nobody had drawn:** `ActiveSuspension.expiresAt` (`sports/period/suspensions.ts:137-153`) derives from `startedAt`, which comes from the suspension event's own `at`. No `at` ⇒ no `expiresAt` ⇒ **the power-play countdown never runs either.** D-10 is not a rendering bug — the number was never produced. Ice hockey's headline strip (period · clock · PP countdown) was two-thirds dead on arrival.
- **The R6 brief's "period-skin deleted, `git grep -a` zero refs" understates the deletion.** R7 re-pinned the referrer set independently: 5 e2e specs, 5 unit tests, `skins/registry.ts:50`, `pad-renderer.tsx:303`, `skins/types.ts:272`, `cricket-skin.tsx`, `football-skin.tsx`, `tennis-skin.tsx`, `attribution-picker.tsx:189`, `timeline.tsx:194,197`. R6 is re-pinning it independently rather than taking either brief on trust.
- **`pad-renderer.tsx` has NO sport-specific fallback branch** (R7, verified). It renders off `props.module.padSpec?.(props.cfg)` and is sport-agnostic. So R6's period-skin deletion and R7's legacy-lane deletion are **one demolition**, and both briefs understate it.
- **`resolvePositions` (`packages/engine/src/sport/catalog.ts:53`) has ZERO production callers** (R7, verified; R6 re-verifying independently). The three page bootstraps read `sportModule.positions.groups` directly. If confirmed, hockey's and ice hockey's declared per-variant positions **do not reach the lineup editor**, and R6-7's position-led swap row would be built on a dead seam. R6-7 is conditional on this.
- **The defect register has been wrong in BOTH directions** (R7, verified): it listed D-3 as open after R4 closed it, and D-13 as closed while boardgame's half is open. D-8/D-9/D-10 are therefore being re-pinned against the tree, not trusted.

### R6 — the R5 review findings file was stale; all 8 open rows are REJECTED

`R5-review-678-findings.md` carried 8 rows marked CLAIMED (#1, #3–#9), and the
main thread flagged them as customer-visible defects shipped in #678. **That
flag was wrong.** All eight were found and fixed during #678's own review cycle
BEFORE merge — each fix carries a comment citing "review of PR #678, finding N"
— and none survives on `main`. Verified by reading the fixes and running
`skins/__tests__/{volleyball,badminton,tabletennis}.test.ts`: **273/273 passed**.
The scorebug shows the last game's score on a decided match, the deuce clause
reads `>= target - 1`, the decided branch uses games actually played, and
`join` de-dupes through a `Set`. `pad.badminton.ribbon.timeout` is registered in
`PAD_LABEL_KEYS` (`lib/scoring-vocab.ts:703`) and present in all four
dictionaries.

**One real gap survives and R6 takes it:** finding #7's dedupe has **no test
where `scorer === server`** — the actual singles collision the `Set` exists for.
Existing tests only cover `scorer !== server`, so the fix is structurally
correct and unverified.

### R6 — cross-session file contract with R7 (closed 2026-08-30)

R7: worktree `.claude/worktrees/r7-console`, branch
`feat/scorepad-v3-r7-universal-console` off `e23dcf241`, env label `r7`.

| file | split |
| --- | --- |
| `v3/registry.ts` | R6 adds hockey + icehockey, R7 adds boardgame + carrom + generic, to `V3_SKINS` AND `CONVERTED_SPORTS`. **Alphabetical order inside both literals** so the conflict resolves mechanically. |
| `e2e/gallery.capture.ts` | R6 owns the icehockey (:2215) and hockey (:2245) recipes only. **No reflow, no recipe reordering** by either side. |
| `pad-renderer.tsx` | R6 owns :303 and the period-skin deletion. |
| `v3/sport-theme.ts` | R6 adds two palettes. **R7 adds ZERO** — `generic` must be ABSENT, not present-with-defaults, or `sportThemeStyle` stops returning `undefined` for the one sport whose job is to look like the default. R7 will message before adding any. |
| `v3/types.ts` | `advisory` / `SheetChoiceStep.tone` / `SPORT_TOKENS` are **R6's alone**; R7 will not touch them. |
| i18n | Own-sport key blocks only, no neighbour reflow. **`i18n-keys.ts` is GENERATED — never hand-merge; take either side and rerun `npm run i18n:gen-keys`.** Same for openapi drift output. |

**Sequencing:** R7's headline acceptance ("`LEGACY_SPORTS` is empty, totality
proves on the v3 lane alone") needs FIVE sports gone — R7's three plus R6's two.
R7 holds that flip as a single unstarted commit at its branch tip and will not
write it on an assumption about R6's timeline. R6 pings R7 on (a) gated green
and (b) merged.

### R6 — D-8/D-9/D-10 re-pinned against the tree (2026-08-30, before any code)

R7's caution was right and it paid immediately: **two of R6's three register
rows are MISSTATED.** The rows were filed 2026-08-15 against the v2 pad; the
tree does not support two of them.

| row | verdict | evidence |
| --- | --- | --- |
| **D-8** "icehockey goal form permanently open with a resting validation error" | **MISSTATED — the claim never matched this file** | The goal form is the shared `ActionForm` (`v2/scorepad/action-form.tsx`, used by `period-skin.tsx:68,744`). `:192` `const [expanded, setExpanded] = useState(false)` — **collapsed by default**, a single-tap button while `!expanded` (:229). Validation text renders only inside the expanded branch, gated on `!validity.ok` (:265), never at rest. That chassis has been unchanged since `period-skin.tsx` was created (`f5a1628750`, 2026-08-13) — **two days BEFORE the register filed the row.** |
| **D-9** "person chips overflow the card (clipped names)" | **MISSTATED — spill, not clip; does not reproduce** | Chip row is `period-skin.tsx:453` `flex gap-2 overflow-x-auto pb-1 -mx-1 px-1`; chips use `shared.tsx:42` `chipClass` (`shrink-0`, no `max-w-full`) — the same class shape R5 fixed in `v3/swap-sheet.tsx` (`120f0b0f1`). **But R5's bug needed an `overflow-hidden` ancestor to turn spill into a clip, and none exists here:** the row is `overflow-x-auto` (scrolls) and `.card` (`globals.css:207-209`) declares no `overflow` at all. Names scroll into view rather than clipping. R5's fix was never applied to `shared.tsx`/`period-skin.tsx`, which is true and moot — v3 replaces both. |
| **D-10** "icehockey CLOCK renders '—'" | **STILL PRESENT, and deeper than filed** | `period-skin.tsx:268` `{ id: "clock", value: readClock(ctx.state) ?? "—" }`; `readClock` (:227-233) returns `null` when `asOf.elapsed` is absent, and the field is force-coerced to a literal em-dash **at rest**. v3 football took the opposite posture (`football.tsx:313-320` returns `undefined`, `:590-593` omits the item); period-skin never adopted it. The em-dash is only the symptom — see the clock false premise above: nothing has ever produced a stamp to read. |

**Ruling: D-8 and D-9 are CLOSED as misstatements, not as fixes.** R6 still
ships a tile-based goal flow and wrapping chips, because that is the v3 design,
but neither is repairing a defect that existed. Recorded so a later wave does
not "re-fix" them or treat their absence as a regression.

### R6 — `resolvePositions` re-verified, and the real defect is narrower than feared

**Confirmed: `resolvePositions` (`packages/engine/src/sport/catalog.ts:53`) has
ZERO non-test callers.** All ~70 call sites are `*.test.ts` or
`packages/engine/src/testkit/**`. The three page bootstraps read
`sportModule.positions.*` directly: `f/[no]/page.tsx:165-167`,
`d/[divSlug]/page.tsx:432-433`, `score/[token]/page.tsx:166-168`.
`catalog.ts:43` documents the direct read as intentional.

**R6-7 is therefore NOT blocked.** Hockey's `GK {min:1,max:1}` +
`lineup {size:11, benchMax:7}` (`hockey.ts:33,39,168`) and ice hockey's
`G {min:1,max:1}` + `lineup {size:6, benchMax:17}` (`icehockey.ts:43,48,204`)
are STATIC declarations, so they reach the lineup editor and swap sheet fine
through the direct-read path.

**What does NOT reach the UI is the cfg-conditional relaxation**, and that is a
real defect R6 owns: the period kernel declares `positionsFor`
(`period/kernel.ts:2434-2443`) which, when `cfg.goalkeeper === "optional"`,
relaxes the keeper group's `min` to 0. Only `resolvePositions` invokes it, and
nothing in the app calls that. So **a competition configured to allow an empty
net still presents `GK`/`G` as min 1 in the lineup editor and swap sheet** — a
keeper is always shown as required. The relaxation is visible only to the
engine's own `validateLineup`.

This lands squarely on ice hockey, whose goal payload carries an `emptyNet`
field: the pad can RECORD an empty-net goal while the lineup UI insists a keeper
is mandatory. R6 fixes the read path for its two sports and records the
remaining sports as owed.

### R6 — D-8's disposition is DATED PROVENANCE, not "could not reproduce"

R7's point, taken and recorded in the stronger form: `f5a1628750` (2026-08-13)
created `period-skin.tsx` with the collapsed-by-default `ActionForm` already in
place, **two days before D-8 was filed on 2026-08-15**. So the row was filed
against a build that already had the behaviour it claims was missing. That is a
dated provenance argument and it closes the row for good; "could not reproduce"
would invite a later wave to re-open it on a different machine.

### PROGRAMME-LEVEL FINDING — the defect register is no longer a reliable input

Across R6 and R7 running concurrently on 2026-08-30, **five register/index rows
were wrong** — R6's D-8 and D-9 (filed against behaviour that did not exist),
R7's D-3 (closed by R4, still listed open), D-13 (listed closed, boardgame half
open) and D-11 (listed closed by R1 while R1 itself shipped a third score
render) — **plus two brief premises**: the "fallback branch" in
`pad-renderer.tsx` that does not exist, and `resolvePositions` being described
as reaching the lineup editor when it has zero production callers.

Both waves now re-pin every register row against the tree before sizing.
Recorded ONCE here as a programme-level finding rather than as separate rows in
each wave; R8's sweep owns the register's own accuracy. R7 points at this line
rather than restating it.

### R6 — the third score render (R7's find), and what R6's headline says

`pad-host.tsx:1075` renders `data-role="v3-headline"` — a slate-900 bar carrying
the engine's `summaryHeadline` — ABOVE the scorebug. D-11/GF-2 ("score rendered
3× above the fold") is recorded closed by R1, and R1 shipped this third render.

For R6's two sports the period kernel builds it at `period/kernel.ts:2537`:
`${home} — ${away}${soSuffix}${otSuffix}${phaseSuffix}` — e.g. `3 — 2 · P2`.
Against R6's own surfaces that is **entirely duplicated**: the scorebug halves
already carry `3` and `2`, and the strip already carries `P2`.

**Except in two states**, where the headline carries the only statement of a
fact nothing else shows: the shootout tally (`(GWS 2–1)`) and the extra-time
marker (`(OT)`).

**R6's position, sent to R7:** do not hardcode a per-sport suppression list in
the chassis. A skin should DECLARE whether it owns the headline's information,
the same opt-in shape `phase?(view)` already uses — then hockey and ice hockey
suppress it once their own strip surfaces shootout and OT, cricket keeps it
(the chase equation earns its place), and no chassis-side list has to be kept in
sync with eleven skins.

### R6 — three cross-checks run at R7's prompt (2026-08-30), one is a real gap

R7 flagged three things from its own engine pinning. Checked all three against
R6's surface rather than assumed:

1. **`fidelityEntitlements` — R6 is CLEAN.** R7's three sports declare `{}`
   (empty), which renders a recording-chip upsell for a band nothing gates. The
   period kernel declares real ones: `{2: preset.timelineEntitlement, 3: same}`
   (`period/kernel.ts:2170-2193`), and both presets set
   `timelineEntitlement: "scoring.match_timeline"` (`hockey.ts:216`,
   `icehockey.ts:253`). Band 2 and band 3 gate on the SAME entitlement — correct,
   with a stale comment citing football's shape, which R6 fixes
   (`kernel.ts:2172-2178`).

2. **Accent contrast against the BAND, not just the ground — R6 is CLEAN**, and
   this is the check R7 nearly shipped a fail on (`#e5484d` measures 4.40:1 on
   its ground and **3.79:1 on its band**, and `led` paints strip digits, which
   are small text). R6's were computed against both from the start:
   hockey `led` 9.51 board / **7.18 band**; ice hockey `led` 13.74 / **12.28**.
   Recorded because the band is the harder surface and the one that fails
   quietly.

3. **`captureExtra` — R6 HAS THE GAP.** VERIFIED: `captureExtra` is defined at
   seven recipes in `gallery.capture.ts` (:1082, :1541, :1677, :1854, :2063,
   :2119, :2177). **Neither icehockey (:2205) nor hockey (:2231) has one.** So
   the gallery captures only the five shared `STATES`, none of which opens a
   dock or a sheet — exactly R2c's recorded ruling that "the gallery is BLIND to
   a narrowing wave unless it adds states", and the R4 zero-screenshot class in a
   quieter form: the capture SUCCEEDS and photographs nothing that changed.

   Left unfixed, R6's sign-off sheet would show the owner five screens that look
   almost identical to v2 while the entire wave — the dock-driven goal flow, the
   card ladder, the penalty countdown, the running clock, the swap sheet — never
   appears in a single frame. **R6 owes `captureExtra` for BOTH sports**, and it
   is a merge-gate item, not a nicety. States owed: goal → dock with
   scorer/assist, penalty with a live countdown, hockey's three-card ladder,
   swap sheet at step 2, and the clock running.

R7's own warning to R6 (field hockey's ground would read as football's) was
tested in CIELAB and REJECTED — dE 16.6, hue 226° vs 161°, `#06323c` is a teal
whose blue channel leads its green. R7 reproduced the whole matrix
independently, agreed, and recorded it as a false premise of its own making.

### A SPORT TONE HAS A THREE-FILE FANOUT, NOT TWO (recorded 2026-08-30, R6+R7)

Adding `advisory` was scoped as "sport-theme.ts + types.ts + a CSS rule". It is
not. The complete set a tone touches:

1. `v3/sport-theme.ts` — `SPORT_TOKENS` and the palette values
2. `v3/types.ts` — `SheetChoiceStep.tone`'s accepted subset
3. **`v3/tokens.ts` — `SPORT_TONE_CLASSES`**, which `guided-sheet.tsx` indexes
   with a `SportTone`. **tsc forces this one and no brief listed it.**
4. `apps/web/src/app/globals.css` — the `.pad-*` rule reading `var(--sport-*)`
5. `v3/__tests__/contrast.test.ts` — the new token's pairs on BOTH grounds
6. `v3/__tests__/sport-theme.test.ts` — the identity/default locks

R7's framing, taken: if a later wave adds an eighth tone believing it is a
two-file change, that is a trap. It is a compile-time fanout, so it fails loudly
rather than silently — but only after the work is done and only in a file the
author did not expect.

### `SPORT_PALETTES` IS NOT ALPHABETICAL — it is WAVE ORDER

football, tennis, badminton, tabletennis, volleyball. R6 and R7 built a
cross-session contract rule ("alphabetical, so a conflict resolves
mechanically") on a grep that showed the keys and not their order. R6's
implementer refused to re-sort — correctly, since re-sorting is a reflow and
would have broken the same contract's no-reflow rule.

**Amended rule, in force for both waves:** insert a new palette among its
NEIGHBOURS, never re-sort the literal. R6's two sit between `football` and
`tennis`; R7's two go above `football`. The anchors do not touch, so the two
inserts cannot land in one another's hunk — the mechanical-resolution property
survives without the alphabetical premise that was never true.

### R7 DECLINED THE REBASE — and was right to (recorded because it is a rule)

R6 offered R7 a rebase onto R6's branch for a clean palette insert. R7 declined:
rebasing onto a feature branch makes R7 a STACKED PR whose base is a branch
rather than `main`, so a squash-merge of R6 orphans R7's history against a base
that no longer exists. This repo has already been bitten by that class once. The
coupling is also asymmetric — only the totality flip is genuinely gated on R6.

**Rule: concurrent waves stay based on `main` and resolve additive conflicts at
merge time. Never rebase one wave onto another for convenience.**

### THE META-LESSON BOTH WAVES CONVERGED ON, 2026-08-30

Three cross-session assertions were made and withdrawn in one day: field hockey's
ground "would read as football's" (it is a teal, dE 16.6), `SPORT_PALETTES` "is
alphabetical" (wave order), and `resolvePositions` "means positions never reach
the editor" (static positions arrive; only the cfg-conditional shape is dead).

**All three were assertions about files that had been GREPPED, never READ.** A
grep answers what exists. It does not answer how a thing is ordered, what
channel dominates a hex, or which of two paths a value actually takes. Every one
was caught by the other session computing or reading rather than agreeing —
which is the argument for two concurrent waves reviewing each other, and the
argument against either of them trusting a one-line claim from the other.

### R6-1a — ice hockey's ground STAYS at `#08090c` (owner ruled 2026-08-30)

Raised because it measures **dE 4.2 from table tennis's `#101418`** — below the
~8 threshold at which two colours read as one side by side. Owner ruled: LEAVE
IT.

Reasoning recorded so no later wave "fixes" this as a defect: on screen only one
sport is ever shown at a time, and the two accents are a full hue apart (glacier
cyan `#67e8f9` vs the 40mm orange ball `#ff9440`), so no scorer can confuse
them. The collision exists only on a comps sheet showing all nine grounds at
once, which is a review artifact, not a product surface.

**This is polish that was declined, not a defect that was missed.** A future
session measuring the palette set will find this pair and should read this line
rather than re-raising it. If the sign-off sheet itself ever becomes a customer
surface, revisit.

### RETRACTION — the goalkeeper "customer fact" recorded above is FALSE

Earlier in this block R6 recorded, in R7's words and with R6's endorsement:
*"a competition configured to play without a goalkeeper still shows the editor
demanding one."* **That never happened and cannot have happened.**

At `ac207cb71` the lineup editor had **no minimum logic at all** —
`SportInfo.positionGroups` is `{key,name}[]`, with `PositionGroup.min` stripped
a layer above the editor. Nothing in that UI has ever expressed a position
requirement, so nothing ever demanded a keeper. There was no nag to fix.

**R7's change is therefore a FEATURE, not a defect fix**: the editor expresses
position minima for the first time, and expresses them cfg-correctly.

**R6's share of this is not zero and is recorded deliberately.** R7 stated it;
R6 called it "better than my framing", adopted it verbatim, sharpened it into
"the single point of failure for the empty-net case", and wrote it into this
index — all without reproducing it. R6 had, in the same session, written "a grep
is not a read" into `AGENTS.md`. The next step of the same failure is **a read
is not a run**: `resolvePositions` having no production callers is true and
grep-checkable; what a user therefore SEES is neither, and neither of us looked.

This register is unreliable because people wrote down what must be true instead
of what they saw. Both waves did it again today while complaining about it.

**Consequence R6 accepts:** default-config hockey and ice hockey sides will
NEWLY show "Starting line-up still needs: Goalkeeper × 1" at R7's merge. R6 has
ruled to KEEP it — both modules genuinely declare `GK`/`G` at `min 1, max 1`, so
the notice is true and useful to an organiser building a lineup — but it must
appear in R6's OWN gallery captures deliberately, and be named at the
walkthrough, rather than arriving in the owner's captures as a surprise. Added
to the `captureExtra` states R6 owes.

**Still unreachable, and NOT R6's to fix:** `cfg.goalkeeper` is settable
nowhere — no hockey variant sets it (`hockey.ts:137+`) and only the divisions
API accepts it (`usecases/divisions.ts:250,719`). The cfg-conditional path is
now correctly wired to a state no organiser can produce. Dead REACH rather than
dead code. R7 owns the `goalkeeper` rule field (`match-rules.tsx`).

**Adjacent, recorded for R8:** `validateLineup` and `assertLineup`
(`sport/catalog.ts:73,143`) also have ZERO production callers, and the lineup
PUT route (`lineups/[entrantId]/route.ts:17-24`) does no catalog validation at
all — a lineup violating a group minimum saves fine. Two more inert seams side
by side.

### R6 SHIPS AS ONE PR — the split recommendation is WITHDRAWN

R6 proposed splitting the clock into its own PR ahead of the skins, on the
argument that football has never had a working match clock and that value
should not wait behind a seven-width matrix and a visual sign-off.

**Withdrawn, on evidence found after the proposal.** The skins reviewer showed
the clock and the skins are entangled AT THE CHASSIS: the penalty countdown is
measured against `state.asOf`, which moves only on a stamped event, and
`PadHostView` (`types.ts:1189-1200`) carries no clock — so no skin can reach
live seconds and the countdown is STATIC. Fixing it means passing the host's
elapsed into the view, which is a clock change whose only consumer is the
skins.

A split would therefore have shipped a foundation PR whose actual consumer was
broken, and a reviewer of the clock alone could not have seen it — the defect
is only visible where the two meet. **One PR.**

Recorded because the reasoning generalises: a "ship the foundation early" split
is safe only when the foundation's consumers are already proven against it.
Here the consumer did not exist when the split was proposed, which is exactly
when the argument sounded strongest and was least supportable.

### R6 — the visual sign-off plan (owner instruction, 2026-08-30)

Owner restated two standing rules and they govern task E: `frontend-design`
loads before ANY UI work, and every change is verified VISUALLY including
cosmetic ones. Task E owes, on a real prod build (`E2E_PROD_TARGET`,
`localhost` — `127.0.0.1` 401s every API call), at **320 / 768 / 1280**:

- goal → dock with scorer and assists
- **penalty with the countdown visibly TICKING** — static until fix pass 2, and
  the wave's headline
- hockey's three-card ladder (green/yellow/red) as swatches
- swap sheet at step 2, position-led
- the clock bar INCLUDING the new set/correct control
- the "Starting line-up still needs: Goalkeeper × 1" notice arriving from R7 —
  captured deliberately so the owner does not meet new UI in a screenshot

Cosmetic items that no test count can prove and that the gallery must show:
the score dominating by SIZE AND WEIGHT (the glacier-cyan ruling leaves only
1.29 luminance separation), the ice hockey ground at `#040a22`, and the card
swatches. No horizontal page scroll at any width; tap targets hit-tested with
`elementFromPoint`, never `boundingBox` (R5's defect was the measurement, not
the number).

### THE SIGN-OFF TOOL ITSELF RUNS IN NO CI JOB (found 2026-08-30, R7; R6 concurs)

`apps/web/e2e/gallery.capture.ts` is its own Playwright project and **is not
run by any CI job**. It is the instrument every wave's visual sign-off gate
depends on, and nothing tests the instrument.

Demonstrated, not theorised: R7's console-history consolidation moved the
ledger OUT of the pad root, so `padEventRows` — which counts activity rows
INSIDE that root — returned zero, and the capture died at football `02-live`
**for every converted sport**. It would have surfaced on R6's wave, hours
later, as "your gallery run is broken", with no visible connection to the
commit that caused it. Fixed at `7dcab192a` (one hunk, page-wide; R6's two
recipes byte-identical, no reflow).

This is `AGENTS.md` failure class 10 in its purest form — the visual gate has
its own vacuous mode — with a new edge: the gate can be broken by a change in
a DIFFERENT wave and stay broken until someone tries to use it.

**R6's product recommendation, for the owner:** put `gallery.capture.ts` under
CI on at least one sport. Not the full eleven-sport run — that is minutes of
wall clock for a tool used at sign-off — but ONE sport, on the PR trigger, so a
change that breaks the capture harness fails in the PR that breaks it rather
than in the next wave that needs it. Cost is one short job; the thing it
protects is the only gate that can see what a customer sees.

**Contract note:** R7 edited `gallery.capture.ts` beyond the two recipes our
cross-session contract allotted them — specifically the shared `padEventRows`
helper — and told R6 rather than letting it be discovered. R6 ACCEPTS: their
change broke the shared helper, so fixing it is theirs; leaving it broken for
the next wave to trip over would be strictly worse than a contract deviation
that was disclosed. Recorded because the disclosure is the part worth keeping.

**Operational note for R6:** running the gallery BEFORE rebasing onto a `main`
containing `7dcab192a` will fail at `02-live` with zero rows and it is NOT an
R6 defect. Do not spend a debugging pass on it. R6's own walkthrough captures
use a throwaway script rather than `gallery.capture.ts`, so they are unaffected.

---

## R6 SESSION STATE — written for compaction, 2026-08-30

**Branch** `feat/scorepad-v3-r6-period-pair`, 21 commits off `e23dcf241`.
**Worktree** `.claude/worktrees/r6-period`. **Env label `r6`** — postgres 54834,
prod server built FROM THIS WORKTREE at **http://localhost:3356** (assets
verified; use `localhost`, `127.0.0.1` 401s every API call).
**Walkthrough PNGs (61 images + 4 report JSONs, 81 measurements):**
`/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/d0758d6e-db26-4eb8-9fbd-a0c0fb857052/scratchpad/r6-walkthrough/`

### Verified by the orchestrator, not taken on an agent's report

Gate **2150 total / 2148 passed / 0 failed / 0 failed suites / 56 files**, every
`.testResults[].name` under the r6 worktree. Clock exists and stamps `at`; never
stamps unstarted (the regression that would have turned football's honest
omission into a frozen `0:00`); correctable. Both skins declare `clock()` and
`PadClockBar` is mounted and reachable. Registry flipped for both sports, both
literals sorted A-Z. Palettes + `advisory` live and mutation-pinned.

**Driven on the real product** (not asserted): decided shoot-out renders
`3 — 2 (GWS 3–0)` matching `summary.headline` exactly at 320/768/1280 while
`state.goals` stays `{2,2}` — the wrong-score defect is dead. Countdown ticks
2:00 → 0:56 across 62s with `seqBefore === seqAfter`. Zero horizontal scroll,
zero controls under 44×44 (tightest 44×45) across 81 measurements. Tokens
resolve live: ice `#040a22`/`#67e8f9`, hockey `#06323c`/`#ffd23f`/`#3ddc84`.
Type: big number 36px/700, side name 13–14px/600, strip 12px/600 — hierarchy
from SIZE AND WEIGHT, which R6-1's glacier-cyan ruling requires.

### TWO DEFECTS FOUND BY DRIVING IT, invisible to ~2150 passing tests

1. **SHIP-BLOCKER — the pad renders a REFUSED write as recorded.** Band-1 (free)
   org, ice hockey: `POST …/events` returns **402 `PAYMENT_REQUIRED —
   scoring.match_timeline`**, server ledger keeps only `core.start`, and the pad
   still shows ribbon "Penalty — Minor · Undo", TWO Activity rows, chips
   "ON ICE 3V5" and "BACK ON MINOR", and a ticking countdown — **no rejection
   banner anywhere**. The scorer believes a penalty is recorded and the side is
   short; nothing is recorded and on reload it is all gone. Reproduced twice.
   Evidence `icehockey-band1-penalty-320.png`, `report-band1.json`.
   **Root cause is in `apps/web/src/components/v2/scorepad/transport.ts`** (fix
   pass 3 found it there) — i.e. SHARED transport, not the v3 pad, so this
   plausibly affects every sport and every refusal type, not just 402.
2. **The card/penalty picker is in Postgres jsonb key order, not severity.**
   Hockey's umpire is offered **Red, Green, Yellow**; ice hockey Major, Match,
   Minor, Misconduct, Bench minor, Double minor, Game misconduct. Someone
   reaching for green under pressure taps red. Evidence `hockey-cards-320.png`.

### OWNER RULING — cards and penalties are FREE (2026-08-30)

The engine puts `suspension.start`/`end` at **band 1**; the server demands
**band 2** (`scoring.match_timeline`). Owner ruled the engine is right: in
hockey a card IS match state — it changes on-ice strength, which changes how
the score is reached — so a free org that cannot record one has a WRONG product
(scorebug reads 5v5 when it is 4v5), not a smaller one. Gate the rich timeline,
never the state-affecting event.

**NOT YET APPLIED — deliberately.** A scout is enumerating, across all eleven
sports, exactly what would newly become free if the gate is aligned, plus which
tests pin the current refusal and which other surfaces (device link especially)
share the gate. Moving this without that list risks silently freeing football's
cards, cricket's wickets or tennis's code violations with a green suite. The
lying UI (defect 1) is being fixed INDEPENDENTLY of this ruling — a refusal must
never render as recorded regardless of who is right about the band.

### In flight at compaction

1. **Fix pass 3** — defect 1 + defect 2. Mid-write: `transport.ts`,
   `v3/pad-host.tsx` modified; `refusal-copy.ts`, `v3/__tests__/refused-write.test.ts`
   new. Instructed to STOP AND REPORT if the blast radius reaches shared write
   plumbing — `transport.ts` is exactly that line, so hold it to the report.
2. **`/code-review high`** across the whole branch — targeted at the BRANCH
   explicitly, because `/code-review` reviews `main` here and from the main
   checkout would have found an empty diff and reported clean.
3. **Entitlement scout** — see the ruling above.
4. **R7** (separate session) — converting `generic`, then boardgame, carrom.

### Owed before merge

- reviewer pass on fix pass 3, then RE-DRIVE the product (per-task walkthrough
  is an owner-set gate, not per-wave)
- **`captureExtra` for both sports — DOES NOT EXIST.** A gallery run today
  captures the five shared `STATES`, none of which opens a dock or a sheet, so
  the owner would be shown five screens identical to v2. Merge-gate item.
- seven-width e2e; gallery published; **owner per-screen verdicts**; live
  walkthrough for HOC-04b (card-flow presentation) and the swap sheet
- check R7's two chassis findings against R6's skins: the ribbon stops offering
  a take-back after a void (correct, by design), and a device link CAN void its
  own rows but shows NO recorded-by attribution — R6's card and penalty rows
  live in that panel
- rebase onto a `main` containing R7's `7dcab192a`, or the gallery dies at
  `02-live` with zero rows for a reason that is not R6's
- follow-up recorded but NOT built: correcting the clock cannot retro-fix an
  already-derived `expiresAt` (a stamped `at` is a frozen fact), so a penalty
  recorded against a wrong clock stays wrong. Owner steer requested on whether
  the void-and-re-record amend path belongs in R6 — R6's recommendation is NO,
  it is a separate change with its own review.
- UNVERIFIED: an implementer reported `npm run typecheck` failing in the MAIN
  checkout. Main is clean and R6 never touched it, so probably pre-existing.
  Confirm when the machine is quiet — typecheck peaks ~2.8 GB.

### THE 402 IS NOT A BUG — there are TWO fidelity models, by design

Pinned 2026-08-30 before acting on the owner's "cards are free" ruling. The
ruling stands; the IMPLEMENTATION is not what R6 assumed.

**Where:** `server/usecases/scoring.ts:266-268` (`assertEntitledToScore`, from
`scoreEvent:95`) via `server/usecases/fidelity.ts:28-33`. The predicate walks
the module's **legacy `fidelityTiers` array** — the LOWEST tier declaring the
event type wins, and `tier <= 1` is free. **It never reads `PadSpec.fidelity`.**

**Why band 1 trips a band-2 key:** not a `>=`/`>` slip, not the org's band. Two
parallel hand-kept models disagree for this event. `period/kernel.ts:1850-1853`
lists only `[goal, advance, attempt]` in tiers 0-1; the suspension types first
appear in `tier2Types` (:1838) with `entitlement: preset.timelineEntitlement`.
The redesigned map at `:2161-2168` says `[suspStartType]: 1`. **The drift is
DELIBERATE and documented** — `packages/engine/src/sport/module.ts:102-106`
says the new map is additive and "the paywall (`fidelity.ts`) and every other
`apps/web` read site keep reading `fidelityTiers` exactly as they do today".

**Blast radius of a naive "align the server to `padSpec`" — 12 event types
across 5 sports, NOT the two hockey ones:**
icehockey + hockey `suspension.start`/`.end` (`scoring.match_timeline`);
volleyball `timeout`/`sanction`/`sub`, badminton `sanction`, tabletennis
`timeout`/`sanction`/`expedite.start`, tennis `sanction`/`interruption` (all
`scoring.rally_by_rally`). **Football frees NOTHING** — `football.card`/`sub`/
`penalty`/`sinbin.*` are band 2 in BOTH models (`football.ts:2374-2383`).
Cricket frees nothing.

**And it drifts the OTHER way once:** `cricket.superover.ball` is `fidelityTiers`
tier 1 (FREE today, `cricket.ts:3471`) but `padSpec` band **3**
(`cricket.ts:3000`). A naive realignment newly PAYWALLS it behind
`scoring.ball_by_ball` — a revenue change in the opposite direction, on a sport
this wave never touched.

**Tests pinning today's behaviour:** `scripts/smoke.ts:5486-5525` asserts the
402 + `feature_key` for `icehockey.suspension.start`, `tabletennis.expedite.start`
and `tennis.interruption` — three of its four cases would red on a broad
realignment. `server/usecases/__tests__/fidelity.test.ts:63-79`'s sweep iterates
volleyball, so freeing its three reds it. No test outside smoke pins a
hockey/icehockey suspension refusal.

**One HTTP door:** `api/v1/fixtures/[id]/events/route.ts:16` → `scoreEvent`,
used by BOTH console and device link (`scorepad/transport.ts:201` is the only
POST path). The batch importer (`event-import.ts:246`) shares
`requiredFeatureForEvent` and moves in lockstep.

**R6's recommendation to the owner: the NARROW change** — move
`suspension.start`/`.end` from `tier2Types` to tier 1 in `period/kernel.ts` for
the period family only. It delivers the ruling exactly, frees nothing else,
paywalls nothing, and reds one smoke case rather than four. **Explicitly NOT
recommended:** realigning the server to `padSpec`, which is a programme-level
decision about retiring a documented dual model and carries a cricket
regression.

**Inconsistency the owner should decide separately:** after the narrow change a
HOCKEY card is free while a FOOTBALL card is paid, though R6's own argument for
free — "a card is match state; it changes on-field strength, which changes how
the score is reached" — applies to football identically. R6 has NOT extended the
ruling to football on its own; that is a revenue decision, not a consistency
tidy-up.

---

## R9 REGISTERED — scoring goes free (owner ruling, 2026-08-30)

New wave, prompt at `R9-scoring-free.md`. **Runs AFTER R6 and R7 merge.** The
Order table at the top of this file does not list it — that table has gone
stale three times already and this note is the authority.

**Ruling:** keep the fidelity bands, make them free and open. Bands stay as a
UX choice about how much detail a scorer records — a volunteer picks "just the
score", a club recording for stats picks ball-by-ball — and stop being a price
boundary. Every band reachable on every plan. **Principle: charge for leverage,
never for correctness.** Entitlements elsewhere (AI credits, seats, scale,
registration, payments) are explicitly untouched; those gate real marginal
cost, and a scoring event is a cheap row.

**Why it is a wave and not a deletion:** three things move together — the
server gate stops refusing, `fidelityTiers` retires (with nothing paywalled it
has no job), and the recording chip loses its lock and upsell. That third piece
closes **D-7** ("raw fidelity picker + unexplained 🔒"), which R1 addressed by
explaining the lock rather than removing it.

**Why NOT folded into R6**, recorded so it is not re-litigated: the pricing
page would still advertise scoring as paid on the day it goes free; a billing
change deserves a reviewer reading it AS a billing change rather than as the
tail of a pad wave; and R6 already carries a clock, two skins, a seventh token,
a chassis transport fix and a joint demolition with R7. R6 does ONLY the narrow
piece the earlier ruling requires — period-family `suspension.start`/`.end` to
tier 1, so hockey cards work free today.

**Instrumentation is recommended, in parallel, and is NOT a gate:** log scoring
refusals (event type, org, plan) before removal, so the owner learns afterwards
what the gate was actually worth. The owner has already decided; this measures
rather than blocks.

**The trap R9 defuses by construction, recorded because a half-read could
reintroduce it:** the two fidelity models drift in BOTH directions.
`cricket.superover.ball` is `fidelityTiers` tier 1 — FREE today
(`cricket.ts:3471`) — but `PadSpec.fidelity` band **3** (`cricket.ts:3000`), so
any migration that "aligns the server to `padSpec`" newly PAYWALLS it. R9 makes
everything free, so the drift stops mattering; a future partial migration would
resurrect it.

### `V3_SKINS` — the sort was checked, the comments survived, it STAYS sorted

R7 warned that `V3_SKINS` is not a literal at all — it is `Object.create(null)`
plus individual assignments, each carrying a multi-line provenance comment, and
that a sort which moved only the assignment lines would silently reattach every
comment to the WRONG entry. tsc and every test pass either way, because comments
are comments. The warning was exactly right in principle and is the same
argument R6 used to refuse sorting `SPORT_PALETTES`.

**Verified by reading the file, not by trusting the implementer:** the comments
moved WITH their assignments — badminton's note sits on badminton, football's on
football, and so on. The "same reason as football's own entry above" style
cross-references, which a sort WOULD have broken, were rewritten: the shared
factory-type rationale is now stated ONCE in a header above the block rather
than repeated per entry with "above" pointers. Each remaining comment names its
own wave and ordinal ("the fourth conversion", "the SECOND of the three
`sports/setbased` sports"), so provenance is recoverable per entry without
depending on file order.

**Ruling: `V3_SKINS` and `CONVERTED_SPORTS` stay sorted A-Z.** The merge
property is worth more than top-to-bottom narrative here, and the narrative
survived. R7 sorts theirs to match rather than leaving the two branches
divergent — a shared order agreed before either ships is the whole point.

**The general rule, which is NOT "sorting is fine":** a sort is safe only where
per-entry commentary either moves with its entry or does not exist.
`SPORT_PALETTES` fails that test and stays in wave order; `V3_SKINS` passes it
only because the sort was done carefully and then CHECKED. Two literals in one
file, two answers — the same shape as `registry.ts` vs `sport-theme.ts`.

### RETRACTION — the empty-`fidelityEntitlements` claim recorded earlier is FALSE

An earlier entry in this block recorded, from R7 and endorsed by R6, that R7's
three sports declaring `fidelityEntitlements: {}` would make the recording chip
render an upsell for a band nothing gates, and that R6 was "clean" by contrast.
**R7 has retracted it and R6 concurs:** `entitledBandsFrom({}, {})` returns all
four bands, so `showUpsell` is false and the chip renders no chevron at all.
Confirmed on screen by R7.

R6's own position is unaffected on the facts — the period kernel really does
declare `{2: "scoring.match_timeline", 3: same}` — but the CONTRAST drawn
against R7's sports was wrong, and R6 recorded another session's unverified
claim as fact for the second time today. Same shape as the goalkeeper
retraction: a plausible statement about what a user would see, adopted without
driving it.

---

## R6 FIX PASS 4 (2026-08-30) — the six branch-review findings, plus the narrow entitlement change

Branch `feat/scorepad-v3-r6-period-pair`, still open. Closes all six rows in
`R6-review-branch-findings.md` and executes the "R6's recommendation to the
owner" from the entitlement section above — the owner ruling for it arrived
directly in this fix pass's own dispatch brief, so it is no longer a
recommendation awaiting one.

### THE CLOCK-CORRECTION RULE (findings 1+2) — decided and stated, per the brief

**Rule: clamp the CORRECTION at the high-water mark — never let the display
move below what the fold has already accepted in the current period.** Not
the alternative the brief also offered (clamp only the stamp, let the display
lie below it). Reasoning: this whole file's design is that the display IS
what gets stamped (`stampOf` reads the exact `elapsedOf` `PadClockBar`
renders) — a display that no longer matches its own future stamp would be a
SECOND silent disagreement, the same shape of defect `PadHostView.clockAt`
(fix pass 2) was built to close, not one to reopen while fixing its sibling.

**Mechanically:** `adjustClock` (`v3/clock.ts`) now takes `nowMs` (closing
finding 1: it clamps against the LIVE total, `elapsedOf`, not the banked
`base` alone — a running clock that has never been paused can move again) and
an optional `floor: GameTimeStamp` (closing finding 2: the corrected total
cannot go below `floor.elapsed` when `floor.period` matches the clock's own
period). `pad-host.tsx`'s `adjustClockNow` sources that floor from
`clockSpec.seed` — the SKIN's clock declaration, rebuilt fresh every render
from the live fold — rather than from anything the host itself is holding,
so the floor cannot go stale between renders the way the held `clock` state
deliberately does (property 3).

**Why the ~2200-test suite could not see finding 2 at all, and the fix for
that too:** `__tests__/_period-fold.ts` folded with no `strictFromSeq`
anywhere, and its one "did the fold accept this" probe (`phaseVerdict`)
called `module.apply` directly — which does not contain the monotonic-time
guard; that guard lives one layer up, in `foldMatchWithStoppage`. A NEW,
additive `appendVerdict` export folds the whole stream with `strictFromSeq`
naming the freshly-appended candidate, exactly as `server/engine-db/
append-event.ts` does for a real HTTP append. `phaseVerdict` itself was left
untouched — it has ~20 call sites across the WRONG_PHASE sweep in
`period-pair.test.ts`, and routing it through a full strict replay risked a
second, unrelated behaviour change landing on all of them for a fix scoped to
one guard.

### The entitlement change — EXECUTED, exactly as recommended above

`period/kernel.ts`: `suspStartType`/`suspEndType` moved out of `tier2Types`
into `tier1Types` (renamed from the old `attributed`/`tier2Types` split),
**period family only** — nothing else in `fidelityTiers` moved, `PadSpec
.fidelity` is untouched (the two models still disagree by design, per
`sport/module.ts:102-106`; R9 is still the wave that reconciles them).
`scripts/smoke.ts:5486-5525`'s icehockey-suspension case moved from the
`gated`-402 loop to its own 201 check, reusing the SAME `freeIce` fixture and
ledger so the existing tier-0-advance control right after it still exercises
one continuous stream. `tabletennis.expedite.start` and `tennis.interruption`
are untouched and still assert 402 — this remains the narrow change, not R9.

### Verified by the orchestrator

**2233 total / 2231 passed / 0 failed / 2 pending across
`src/components/v2/scorepad`, 59 files** (baseline going in was
2204/2202/0/2 pending/59 — +29 tests, 0 regressions), every
`.testResults[].name` confirmed under the r6-period worktree. Full engine
suite (`packages/engine`) 0 failed both before and after.
`fidelity.test.ts` 37/37; `entitlements-v2.test.ts` (real Postgres, RLS +
triggers) 32/32. tsc clean on BOTH workspaces (`apps/web` and
`packages/engine`), final pass after every mutation restore. Lint: 0
problems on every touched file in both workspaces (`scripts/smoke.ts` has no
lint config at the repo root — confirmed, not skipped). i18n parity OK,
5653 keys × 4 locales.

**12 mutants, one at a time, all 12 DIE:** kernel.ts's `tier1Types` reverted
whole and narrowly (the set-piece leak); clock.ts's floor clamp and its
finding-1 elapsedOf-not-base fix, independently; `laterAsOf`;
`classIsPermanent`; `otherSide` (survived the FIRST sweep — the generic
padSpec-reachability test proved a key was settable but not which roster it
drew from; closed with a dedicated goalkeeper-side test, see the commit
below); `appendVerdict`'s `strictFromSeq`; `PadClockBar`'s `fixtureId`-derived
id; `adjustClockNow`'s floor-sourcing (source-audit only — no jsdom); the
suspension sheet's `servedBy` field dropped in isolation; and kernel.ts's
full revert, confirmed dying at BOTH the pure-unit layer and the real-Postgres
`scoreEvent` layer in the same run.

**A free-plan org's icehockey card, through the real usecase door (not the
running server — see the entitlement section's own note on why):**
`entitlements-v2.test.ts`'s new case creates a community-plan org, real
Postgres row and all, calls `scoreEvent` directly with
`icehockey.suspension.start` and gets back `seq: 2` (recorded), then calls it
again with `icehockey.set_piece` on the SAME fixture and gets a 402 with
`feature_key: "scoring.match_timeline"` — the narrowness of the ruling,
proved on one continuous stream rather than asserted separately. A literal
HTTP attempt against the actually-running (pre-built) server at
`localhost:3356` was also made and correctly still returns 402 for the
suspension — expected: that server was built before this fix pass and
rebuilding it was explicitly out of scope.

Six commits: `42674cd93` (finding 4), `0c56feb19` (findings 1+2+6),
`e5ae81ab3` (this note), `93eeff91a` (finding 5), `331c6ac74` (finding-4
goalkeeper-side follow-up from the mutation sweep), `62eeab661` (finding E).

---

## R6 SESSION STATE #2 — supersedes SESSION STATE above (2026-08-31)

**31 commits** on `feat/scorepad-v3-r6-period-pair`, tree clean, main clean.
Worktree `.claude/worktrees/r6-period`, env label `r6` (pg 54834), prod server
built FROM THIS WORKTREE at **http://localhost:3356** (`localhost` only —
`127.0.0.1` 401s). **`origin/main` HAS MOVED** to `fb81bd54f` (RS008 #682), so a
rebase is owed before the PR.

**Gate, rerun by the orchestrator: 2204 total / 2202 passed / 0 failed /
0 failed suites / 59 files**, zero paths outside the worktree.

### Landed since SESSION STATE #1

- **The transport defect — the biggest find of the wave, and it is NOT
  hockey-specific.** `transport.ts` classified only 409 and 422, so every other
  4xx fell through to `network-error`, which `sendOne`/`use-pad-pipeline`
  deliberately answers by KEEPING the optimistic fold and going offline. A 402
  was filed as flaky wifi and retried forever behind a pad still claiming the
  write landed — and **400/401/403/404 had the identical silent symptom, on
  every sport and BOTH pad lanes**. Fixed structurally via `isPermanentRefusal`
  (4xx permanent except 409/408/429; 5xx and thrown fetch stay transient), with
  rollback falling out of the existing `rejected` branch. New `refusal-copy.ts`,
  5 keys × 4 locales, banner has `role="alert"`. Without the new copy the
  scorer would have read the raw server prose "Plan upgrade required:
  scoring.match_timeline". Found by driving a free org's pad for ten seconds;
  invisible to ~2200 tests and three reviews.
- **Card picker ordered by severity** — hockey Green→Yellow→Red, verified live.
  NOTE: the brief's premise "order icehockey by ascending PIM 2/4/5/10/20/25"
  was FALSE — `match` is 5 minutes carrying 25 PIM and `game_misconduct` has
  `minutes: null`, so a minutes sort puts the worst penalty 5th of 7. The
  implementer rejected the instruction and used skin declaration order. That is
  the orchestrator's own false premise, the third of the session.
- **`R6-review-branch-findings.md`** — the high-effort `/code-review` on the
  whole branch, six findings, all recorded with evidence.
- **`R9-scoring-free.md`** registered — see its own block above.
- **Agent topology corrected.** All three roles are Sonnet at **xHigh**, set in
  `.claude/agents/*.md` frontmatter (the only place effort takes effect). The
  orchestrator had dispatched every implementer and reviewer on **opus** all
  session, following a stale line in the v2 `_RULES.md`. Three duplicate copies
  of the topology now POINT AT `docs/superpowers/RULES.md` instead of restating
  it, each saying never to pass `model:` on a dispatch. **Everything R6 built
  before this correction was produced by opus agents, not the specified
  topology** — held up under three reviews and a walkthrough, not redone.

### In flight at compaction

**Fix pass 4** (Sonnet xHigh, no model override) — the six branch-review
findings plus the narrow entitlement change. Ordered so finding 4 lands first:
the suspension sheet claims the event type but collects only `class`/`reason`,
dropping the `minutes` and `servedBy` fields the engine's `padSpec` declares and
whose copy already ships in four locales — so every FIH yellow takes the class
default and the countdown counts to the wrong moment. Also: `−1 min` is a dead
button on a running never-paused clock, and a successful backward correction
stamps below the high-water mark so `NON_MONOTONIC_TIME` refuses every later
event for a real minute. **And the harness fix that matters more than either
bug: `_period-fold.ts` passes no `strictFromSeq` and its accept-probe calls
`module.apply`, which lacks the guard the server applies — a test harness more
permissive than production cannot see a whole class of defect.**

### R7's two chassis findings — CHECKED against R6's skins, both clean

No reference to ribbon-undo anywhere in `hockey.tsx`, `icehockey.tsx` or
`period-shared.ts`. Nothing reads `recordedBy`/`createdBy`; the chassis already
documents that a device link has no user identity and uses
`deviceLinkId`/`ownEventIds` as the void authority. All copy keys present in all
four locales — 3/3 hockey card classes, 7/7 ice hockey penalty classes.

**One judgement call left OPEN for the owner's walkthrough, deliberately not
closed here:** the activity row joins class + person + reason with NO VERB
("Yellow card · Jane Doe · dissent"), and the device pad shows no recorded-by,
so it could be read as "Jane Doe entered this". R6's position is LEAVE IT — the
convention is consistent (the named person is always the event's SUBJECT, never
the recorder) and the dock asks "Who was carded?" explicitly — but a fresh
reader catches what a familiar one cannot, so the owner reads that row cold at
the walkthrough.

**A scout's CONCERN that was a false alarm, recorded so it is not re-raised:**
"no `hockey.test.ts`/`icehockey.test.ts` exist, zero direct skin tests". They
exist as `v3/__tests__/period-pair.test.ts` (72KB) and `period-class-order.test.ts`
— the implementer's declared deviation, one PAIR file because the two sports
share a kernel. Verified nothing globs `skins/__tests__/`. A future reader WILL
look in `skins/__tests__/` and find nothing; that is the only cost.

### Owed before merge

Re-drive the product (per-TASK gate, owner-set) · `captureExtra` for both
sports, which DOES NOT EXIST and without which the gallery shows five screens
identical to v2 · seven-width e2e · gallery published + owner per-screen
verdicts · live walkthrough for HOC-04b and the swap sheet · rebase onto
`fb81bd54f` and onto R7's `7dcab192a` (without it the gallery dies at `02-live`
with zero rows, and that is NOT an R6 defect) · the period-skin demolition
(9 production / 6 test / 4 e2e referrers) · UNVERIFIED: `npm run typecheck`
reportedly fails in the MAIN checkout, main is clean and untouched by R6.

**Walkthrough PNGs from the last drive (61 images + 4 report JSONs, 81
measurements):** `<scratchpad>/r6-walkthrough/`. They PREDATE the transport fix
and the picker reorder, so they still show the old `Red, Green, Yellow` and no
refusal banner. Re-drive before publishing anything to the owner.

### Re-verified by the orchestrator after fix pass 4 (2026-08-31)

Run myself, not accepted from the implementer. `cd apps/web` first, JSON
reporter, every `.testResults[].name` confirmed under `r6-period`:

- **`src/components/v2/scorepad` + `fidelity.test.ts` + `entitlements-v2.test.ts`:
  2302 total / 2300 passed / 0 failed / 2 pending, 61 files.**
- **`packages/engine`, run TWICE back to back on the same commit:
  4198 total / 4185 passed / 0 failed / 13 pending / 149 files — IDENTICAL
  both runs**, including per-file assertion counts.

**A claim from fix pass 4 is RETRACTED here: there is no ±13 flake.** The
report said the engine total "drifts by ±13 between runs from a pre-existing
property test in `src/import/plan.property.test.ts`". Two consecutive runs
show that file at 17 assertions, passed, both times, and no file anywhere in
the suite differing by one assertion. **13 is the constant skip count** —
`passed` was being compared against `total`. This same 13 is already visible
in this file's own earlier record (`engine 4088 total / 4075 passed`, R4). A
future session must not go hunting a flake that does not exist.

The 13 skips, all accounted for and none of them R6's:
- 7 × placement / repair-decompose integration — skip without a running
  CP-SAT service, which is correct behaviour, not a pass.
- 3 × `build-determinism`, 2 × `build-budget` — scheduling, pre-existing,
  untouched by this wave.
- 1 × `time-kernel.conformance` case **4c for `hockey` only**, via
  `it.skipIf(carriedPast === undefined)`. Deliberate and reasoned in the
  adapter: FIH has no overtime and the carry refuses to spill into a
  shoot-out (no match clock there), so no expiry can be indexed past Q4 and
  4c is structurally unreachable for that sport. **Ice hockey, which does
  have OT, runs 4c** — so the pair is covered where the case exists.

**An orchestrator trap paid for again in this pass:** the first gate run used
`npx vitest run --root apps/web …` from the worktree root. It came back with
**8 red files** — `refusal-copy`, `server-boundary`, `clock`, `contrast`,
`focus-ring-cascade`, `period-pair`, `refused-write`, `sport-theme` — all
`ENOENT … /r6-period/src/…`. `--root` moves vitest's root but leaves
`process.cwd()` alone, so every test that reads a repo file by path resolves
against the wrong directory. Four of the eight failed to COLLECT (0
assertions), which reads exactly like a broken branch. `cd apps/web &&` in
the same call, no `--root`: 0 failed. Judge a red on this suite by looking
for `ENOENT` before believing it.

### R6 visual sign-off — GIVEN by the owner, 2026-08-31

Owner reviewed the recaptured gallery (22 screens, both sports, 1280 + 320,
from a production build after the W-1 fix) and said: **"all good in gallery"**.

Recorded scope of that approval, deliberately narrow so a later session does
not over-read it:

- **The screens ship.** Both skins' boards, palettes, chips, docks, sheets and
  the clock bar are approved as captured. No restyle owed.
- **W-5 is CLOSED as accepted.** The clock renders as a page-coloured card
  below the sport-themed board rather than on it. That was raised as a design
  question, shown, and approved as-is. Do not "fix" it in a later wave without
  asking again.
- **W-1 stays fixed** (`a8a9e5c2d`), proven by two rows in `score_events`:
  `minutes: 2` before, `minutes: 5` after, same class, same door.
- **W-3 and W-4 are NOT covered by this sign-off.** They are behaviour, not
  appearance — the minute-only clock correction and the 4-second attribution
  dock — and were still open when the gallery was approved.

Gallery artifact (owner's, private): the R6 period-pair gallery published from
this session. Regenerate any time with
`PLAYWRIGHT_BASE=<base> GALLERY_DIR=<dir> npx playwright test --project=gallery -g "icehockey|hockey"`
from `apps/web`. **Two traps that cost a run each:** `PLAYWRIGHT_BASE` defaults
to `:3000`, and `seazn-env env` exports `E2E_PROD_TARGET` as a URL while
`playwright.config.ts`'s header says `=1` — overriding it to `1` made the run
hang to the 10-minute kill with no output. Also: under load (15-min avg ~10)
hockey blew its 180s per-test timeout inside a `fullPage` screenshot and read
as a failure; on a quiet machine the same test passes in **59.1s**.

### R6-9 — `HOLD_MS = 12000` applies to EVERY sport (owner-ruled 2026-08-31)

Raised as W-4 against hockey/ice hockey, but `queue.ts`'s R1 ruling makes the
soft-commit hold window a **chassis constant, not per-sport config**, so the
change necessarily reaches cricket, tennis, badminton, table tennis,
volleyball, football, carrom, generic and boardgame too. Put to the owner
explicitly with that consequence stated. **Owner: "HOLD_MS=12 in all sport is
fine."**

The reasoning generalises, which is why chassis-wide is the right shape rather
than a reluctant side effect: the window is how long a human has to read a
chip row and find one name, and human reading speed is not a property of the
sport. The costs stay asymmetric everywhere — a lingering chip row is tidied
by the next tap; lost attribution is permanent, because nothing later can
recover who an event belonged to.

**Do NOT reintroduce a per-sport override for this.** R1 ruled against it, and
this ruling reaffirms the constant rather than replacing it.

A mutation note worth keeping, because it nearly let this ship untested: every
test in `soft-commit.test.ts` and `use-pad-pipeline.test.tsx` is written
HOLD_MS-RELATIVE, which is correct for behaviour and leaves all of them blind
to the window's VALUE. Reverting 12000 to 6000 initially left the whole suite
green. The guard is now a FLOOR stating the product requirement rather than
the number (`HOLD_MS >= 10_000`, "long enough to pick one name out of a full
side"), so raising the window later needs no re-baseline while dropping back
below a roster scan goes red. Two tests also carried literal advances tied to
the old 6000 and are now expressed in the symbol.

### R6-11 — `HOLD_MS` is env-overridable for e2e ONLY, and the floor moved with it (owner-ruled 2026-08-31)

R6-9's chassis-wide 6s -> 12s had a consequence nobody costed at the time: the
v3 pad soft-commits **every** tap, so a walkthrough spec that polls the ledger
waits out a full window per tap. Badminton taps sixteen rallies, table tennis
twenty-one. Doubling the window pushed both past their flat `test.setTimeout(180_000)`,
and they went red on `main` in run 33421617731 — badminton on its fifteenth tap.

**The failure did not look like a timing failure.** Playwright reported
`Expected: 15 / Received: 14` from the `expect.poll` that happened to be in
flight when the test clock expired, with the timeout printed as a separate
line. Read quickly, that is a scoring defect: the ledger is short a rally. It
is not — the poll's own 20s budget was never exceeded, and 12s fits inside it.
One event, two error lines, and the misleading one comes first.

**Owner ruling: make the window configurable — ~3s in e2e, 12s live.**
Implemented as `NEXT_PUBLIC_SCOREPAD_HOLD_MS`, with three constraints that are
the whole reason this is safe rather than a mask:

1. **The floor test moved to `HOLD_MS_DEFAULT`, not `HOLD_MS`.** R6-9's
   `>= 10_000` guard is a statement about what SHIPS. Left on the live
   constant it would have failed in the one process where the short window is
   correct, and the obvious repair — delete the floor — would have thrown away
   the guard R6-9 was written to install.
2. **Every spec-side wait derives from `HOLD_MS`, never a literal.** Both
   walkthrough timeouts are now `Math.max(180_000, 60_000 + taps * (HOLD_MS + 2_000))`,
   so they hold at 3s in CI and at the shipped 12s locally. One live literal
   was found and fixed in the same pass: `gallery.capture.ts`'s `timeout: 4_000`,
   commented "under HOLD_MS", was under the window at 6s and at 12s and would
   have sat ABOVE it at 3s — reporting "the dock closed" as "the button was
   missing".
3. **The env read is spelled out literally** (`process.env.NEXT_PUBLIC_SCOREPAD_HOLD_MS`),
   because Next substitutes that TEXT at build time. A dynamic read
   (`process.env[HOLD_MS_ENV_VAR]`) compiles to `undefined` in the client
   bundle, so the pad would hold for 12s while the Node-side specs shortened
   their waits to 3s — every spec still passing, purely by racing. TypeScript
   cannot see that, so `soft-commit.test.ts` reads `queue.ts` as text and
   requires the literal member expression.

Set at **job level** in `e2e.yml` (all three jobs), not on the build step, so
one value reaches both the production build and the Playwright runner.
`resolveHoldMs` falls back to the shipped 12s for anything unusable — blank,
non-numeric, or below 500ms — so a typo'd CI variable makes the leg slower
rather than turning the hold off everywhere silently.

The standing cost, stated rather than buried: **e2e no longer exercises the
shipped window.** What still does is the floor test on the default, the
derived local run, and R6-9's own asymmetry argument. This is a deliberate
trade, and the mitigation is that nothing in the e2e tree names a hold
duration in absolute terms any more.

Verified, not assumed: a real standalone prod build with the var baked in,
served on :3382, ran both walkthroughs green in **2.0m** for the pair. At 12s
badminton's holds alone are 16 x 13s = 208s, so that wall time is only
reachable if the substitution took in the CLIENT bundle — the run is the proof
the knob is wired, not just the unit test.

### R6-10 — the v2 `period-skin.tsx` demolition is DEFERRED, not forgotten (2026-08-31)

R6 owed a decision on demolishing `components/v2/scorepad/skins/period-skin.tsx`.
**Recommendation made to the owner and approved: do NOT demolish it in R6.**

Verified before recommending, not assumed:
- `period-skin.tsx:854` declares `sports: ["hockey", "icehockey"]` — exactly the
  two keys R6 moved to the v3 lane, so it has no remaining sport.
- `registry.tsx:330-351` calls `resolvePad` FIRST and **returns `<PadHostV3>`
  before `resolveScorePad` is reached**, so the v2 skin is genuinely
  unreachable through `ScorePad`, not merely deprioritised.

So it IS dead through the product. The reason to leave it anyway is
consistency: `cricket-skin.tsx`, `tennis-skin.tsx` and `football-skin.tsx` are
**equally unreachable** and were deliberately kept when their sports converted.
The one deletion this programme has done — R5's `racquet-skin.tsx` — happened
because nothing else shared it and the wave was forced to decide. Deleting
period-skin alone would leave three files in exactly the state the deletion is
supposed to fix, i.e. it moves the inconsistency rather than removing it.

**The right shape is one cleanup that removes all four v2 skins together**,
with their tests, after the v3 lane owns every sport that has a hand-crafted
skin. Until then the registry's own comment block is the honest record, and it
already says these rows are unreachable rather than pretending otherwise.

**Do not read this as "period-skin is load-bearing".** It is not. It is kept
for symmetry with three siblings, and the moment those go, it goes with them.

### R6 seven-width e2e — RUN, and what the first run's 7 reds actually were

`--project=mobile-se|mobile-14|mobile-320|mobile-360|mobile-430|tablet-768|tablet-834`
against the prod build on :3356, after W-1/W-3/W-4 and the branch-review fixes.

**Result: 201 passed, 4 skipped, 1 failed — and the 1 is a known pre-existing
race, not this wave.** `dual-role header (#516)` on `mobile-360` died on
`duplicate key … persons_org_user_lane_uq`; the same test PASSED on the other
six widths, and passes **alone in 7.1s**. The constraint is from V348/V356,
long predating R6 and the rebase. This is the shared-org race the matrix has
hit before: seven projects claim a player profile for the same org+user
concurrently and one loses.

**THE TRAP THIS RUN PAID FOR — read this before debugging any e2e red after a
rebase.** The FIRST run came back **7 failed**, one per width, all on the same
`setup: public competition with an entrant-ready division`, all
`expect(settings.status).toBeLessThan(300)` receiving **500**. It looks
exactly like a responsive regression in whatever the wave just touched — and
this wave had just crowded a two-button row into four at 320px, the single
most plausible suspect. It was neither.

The server log gave the real cause in one line:
`column "free_agent_fee_cents" of relation "registration_settings" does not
exist`. RS009 added that column in **V388**; the rebase brought the CODE that
reads it, while the label's database sat at **387**. `db:apply` moved it to
388 and six of the seven reds vanished.

**Rule: a rebase onto a moved `main` can desynchronise code and schema even
when the rebase is clean and touches none of YOUR migrations — because the
migration belongs to somebody else.** Nothing warns. After any rebase, run
`db:apply` against the label's DB before believing an e2e red. And read
`/tmp/seazn-env/<label>/server.log` for a 500 before reading the assertion:
the assertion says "500", the log says why.
---

## R7 (2026-08-30) — universal console. Rulings taken BEFORE any code

Worktree `.claude/worktrees/r7-console`, branch `feat/scorepad-v3-r7-universal-console`
off `e23dcf241` (the R5 merge, #678). Env label `r7` (pg 54559, server :3348).
Run CONCURRENTLY with R6 by owner ruling — the two waves hold a written
file contract, recorded below.

Evidence these rulings were taken against: a live football fixture on the R7
build, captured at 1280/768/375, not the defect register. Scoping sheet with
before/after specimens:
<https://claude.ai/code/artifact/84bd58c0-7bd3-4df6-8642-d77fa96e2166>

### R7-1 — the merged ledger lives in the PAD, and that is forced, not chosen

D-4 says the Activity ledger "renders twice". It renders **three** times, and
two of them are not duplicates — they do different jobs:

- `v3/activity.tsx:301` (`data-role="v3-activity"`), inside the pad: skin-aware
  plain-words rows that NAME PEOPLE, with `Void`. This is D-5's fix.
- `fixture-console.tsx:619-683`, page level: a hand-rolled `<ul>` carrying
  `#seq`, timestamp, WHO RECORDED, `void`, plus `Ledger Verified ✓` and
  `Download audit`. This is the one printing the raw copy D-5 complained about.
- `pad-host.tsx:1107` (`data-role="v3-ribbon"`), the last-event strip.

**Ruling:** consolidate by MERGE, not delete. `v3/activity.tsx` is the one
renderer; the page panel's provenance (seq, time, recorded-by) and its audit
controls move INTO it; `fixture-console.tsx:619-683` is deleted.

Which panel survives is **forced by the device link**: `/score/[token]` has no
page chrome, so `v3/activity.tsx` is the only history a courtside scorer ever
sees. Deleting it to satisfy a literal reading of spec §4 would leave the
device link with no history at all. Spec §4's wording ("the pad's ribbon
replaces the old second Activity card") predates `v3/activity.tsx` existing.
The console mounts the component WITH void authority, provenance and audit; the
device link mounts the same component without them.

Presentation ruling taken with it: the coloured type chip is DROPPED — the row
sentence already says "Yellow card", so the chip only repeated it — and the
event type survives as a 3px left stripe on the row, which encodes type at a
glance without saying it twice.

Satisfies `_INDEX` L2560: use `view.events`, never build a second history route.

### R7-2 — chess/boardgame commit grammar: tap DECIDES, dock enriches

Owner ruling. A tap on a player half commits the result immediately; the ribbon
reads the result in words with Undo; a ~6s dock offers Method (checkmate /
resignation / timeout / agreement) as OPTIONAL enrichment. Identical grammar to
football's goal, and honest to the engine — the result is the event, the method
is a field on it.

Rejected: "tap arms, Method commits" (breaks the foundation ruling that nothing
records slower than one tap, on the one sport where that ruling costs least),
and press-and-hold (invents a gesture that exists nowhere else in the product
and is undiscoverable on touch).

The mis-tap exposure is real and is accepted, mitigated by Undo only.

### R7-3 — authority gets a labelled band BELOW the pad (D-12)

Owner ruling. Today Forfeit / Abandon / Undo last render as a BARE BUTTON ROW
ABOVE the scoring card (`fixture-console.tsx:497-567`) — no container, no
heading, nothing saying these end the match, and Abandon is the second control
on the page. `Start match` and `Finalize` are both `btn btn-primary` and are
pixel-identical.

**Ruling:** scoring stays top. Match lifecycle moves into its own labelled,
visually quieter band BELOW the pad and BELOW the ledger, captioned
"Match actions" with a sentence saying what it costs. Outlined buttons, never
filled, so nothing in the band competes with a scoring tile. Forfeit and
Abandon carry danger tint; Abandon confirms.

`Finalize result` belongs IN the band (R7-3a, owner ruling): it is the
most-used authority action and burying it behind an overflow menu costs a tap
on every completed fixture.

### R7-4 — device handover moves beside the pad header (D-19)

`DeviceLinkPanel` renders at `f/[no]/page.tsx:218`; `FixtureConsole` at `:149`.
At 375 the page is 2433px tall and handover is the LAST card, below the audit.
It takes the slot the authority row vacates, beside the pad header — where an
organiser is looking at the moment they want it.

### R7-5 — the two "Undo" controls are NOT the same control. Do not collapse them

The scoping sheet recommended folding them together. That recommendation is
**WITHDRAWN on evidence** before any code was written, and the owner's
"apply your recommendation" was answered with this correction rather than
executed.

- Pad ribbon Undo (`pad-host.tsx:1113` → `handleUndo` → `decideUndo`): if the
  event is still HELD inside the soft-commit window it **drops the held
  submission** — the event never reaches the server and leaves NO trace.
  Otherwise it submits `core.void`.
- Console "Undo last" (`fixture-console.tsx:555-565`): ALWAYS
  `send("core.void", { event_id: lastVoidable.id })`. It can never cancel
  before send.

Collapsing them deletes the cancel-before-send path. **Ruling:** both stay;
each is renamed for what it actually does, so two controls never again share
one word while behaving differently.

Open, to verify, NOT yet asserted: the two also aim at different targets.
`latestEvent` (`pad-host.tsx:965`) is `events[events.length-1]`, UNFILTERED,
while `lastVoidable` (`fixture-console.tsx:421`) skips `core.void` rows and
already-voided events. If `events` at :965 is genuinely unfiltered, the ribbon
can target a `core.void` and void a void. Verify before claiming.

### R7-6 — D-11 is OPEN, and R1 shipped the third render (NOT in the register)

Found live, in no register row. On a live console the score renders three
times: the page header, `pad-host.tsx:1075` `data-role="v3-headline"` (a
`bg-slate-900` bar carrying the engine's `summaryHeadline`), and the scorebug
beneath it. D-11 / GF-2 is recorded closed by R1 as "§2.1 single scorebug" —
and R1 introduced `v3-headline` in the same wave that owned the row.

Owner ruling: **taken this wave.**

**Not a delete**, and not a per-sport suppression list either. Design adopted
from R6 (better than the one first proposed here — record it as R6's):
**DECLARE, DO NOT LIST.** A chassis-side list of suppressed sports must be kept
in sync with eleven skins and nothing fails when it drifts. Instead give
`SkinDefV3` an opt-in in the shape `phase?(view)` already uses: a skin declares
that it OWNS the headline's information, and the chassis renders the bar only
when no skin has claimed it.

- cricket KEEPS it — the chase equation is information the scorebug cannot hold.
- football SUPPRESSES it — `readClock`'s sibling: the headline is literally the
  scorebug's two numbers with an em dash between them.
- hockey / ice hockey: R6 reports `period/kernel.ts:2537` builds
  `${home} — ${away}${soSuffix}${otSuffix}${phaseSuffix}`, e.g. `3 — 2 · P2`,
  which duplicates BOTH their scorebug and their strip. **But** `(GWS 2–1)` and
  `(OT)` are today the only statement of the shoot-out tally and the extra-time
  marker above the fold. **HARD CONSTRAINT: do not suppress hockey/icehockey
  until R6's skins surface shoot-out tally and OT state themselves.** R7 pings
  R6 before flipping; a duplicated headline is strictly better than a screen
  with no shoot-out score.

### R7-7 — extra scope accepted (owner ruling, all four)

Beyond the R7 brief, by the fix-inline rule:

1. **`resolvePositions` read path** — see R7-8.
2. **D-13's boardgame half** — chess pad e2e, its first ever.
3. **Cricket's empty More sheet at bands 0-1** (`_INDEX` L1507-1516, routed to
   R7, "ROUTED NOT FIXED"), with cricket re-captured in this wave.
4. **P-5, the dock amend path** — the ~6s window silently drops a per-player
   stat if the scorer does not answer in time, and v3 activity has no edit or
   amend path. Chassis work; widens the wave; taken deliberately.

### R7-8 — `resolvePositions` is an inert seam, and it has a customer face

`packages/engine/src/sport/catalog.ts:53` has **zero production callers**. Every
caller is `testkit/**` or `__tests__`. All three page bootstraps read
`sportModule.positions.groups` directly: `f/[no]/page.tsx:165-167`,
`d/[divSlug]/page.tsx:432-433`, `score/[token]/page.tsx:166-168`.

The first statement of this finding was too broad and R6 corrected it: the
STATIC positions do arrive, so this is not "positions never reach the editor".
What never runs is the **cfg-conditional** half. `period/kernel.ts:2434-2443`
declares `positionsFor` dropping the keeper group's `min` to 0 when
`cfg.goalkeeper === "optional"`, and ONLY `resolvePositions` invokes it.

Stated as the customer sees it: **a competition configured to play without a
goalkeeper still shows the lineup editor demanding one.**

Split with R6: R7 owns the READ PATH (all three bootstraps + `lineup-editor.tsx`)
because the lineup editor is R7's surface this wave; R6 owns hockey's and ice
hockey's declarations and does not touch the page files. boardgame, carrom and
generic declare no `positionsFor` (`boardgame.ts:326`, `carrom.ts:507`,
`generic.ts:487`), so R7's own three sports have no conditional shape to lose.

### R7 — FALSE PREMISES (verified against the tree `e23dcf241`, before any code)

- **FP-1. There is no universal fallback branch in `pad-renderer.tsx` to
  delete.** The brief's headline acceptance ("the fallback branch is DELETED")
  describes something that does not exist. `PadRenderer` (`:111`) is genuinely
  sport-agnostic — it renders off `props.module.padSpec?.(props.cfg)` (`:139`),
  and grepping boardgame/carrom/generic inside that file returns one unrelated
  comment at `:59`. The real deletion target is `registry.ts:133`
  `LEGACY_SPORTS` plus the v2 lane (`skins/registry.ts:50`, the v2 skin path,
  `timeline.tsx`). This makes R6's period-skin demolition and R7's legacy-lane
  demolition **the same demolition**, and it is bigger than either brief says.
- **FP-2. D-3 is CLOSED.** The brief says "Fix D-3 here if R4 didn't". R4 did —
  `lineup-editor.tsx:209`, `expectedStarting = pairShaped ? lineupSize * 2 :
  lineupSize`. Nothing owed.
- **FP-3. D-13's boardgame half is OPEN**, despite this index recording D-13
  closed at full depth by R5. No chess/boardgame pad spec exists anywhere;
  `games.spec.ts` is Seazn Games (`/games/chess-quest`), unrelated. Carrom has
  `carrom-pad.spec.ts`. Chess has never been browser-driven, exactly as the
  original register row said.
- **FP-4. D-4 is understated** — three surfaces, not two, and two of them do
  different jobs. See R7-1.
- **FP-5. D-11 is open, not closed.** See R7-6.
- **FP-6. `resolvePositions` is dead in production.** See R7-8.

Note the direction of the errors: the index marked a CLOSED row open (D-3) and
an OPEN row closed (D-13). It is wrong in both directions. See the
programme-level finding R6 recorded.

### R7 ↔ R6 concurrent-wave file contract (agreed in writing, both sessions)

Six shared files. Neither session touches the other's side.

| File | R6 | R7 |
|---|---|---|
| `v3/registry.ts` | adds hockey, icehockey | adds boardgame, carrom, generic |
| `v3/sport-theme.ts` `SPORT_PALETTES` | adds hockey, icehockey | **adds nothing** (see below) |
| `v3/types.ts` | widens `SheetChoiceStep.tone` with `advisory` | **does not touch tone** |
| `e2e/gallery.capture.ts` | icehockey `:2215`, hockey `:2245` | carrom `:2295`, generic `:2332`, boardgame `:2372` |
| `pad-renderer.tsx` | owns `:303` + the period-skin deletion | owns the legacy-lane deletion |
| dictionaries ×4 + `PAD_LABEL_KEYS` | own-sport blocks only | own-sport blocks + a `console.*` block |

Rules agreed: entries go in ALPHABETICAL order inside `V3_SKINS` and
`CONVERTED_SPORTS` so the conflict resolution is mechanical; nobody reflows
`gallery.capture.ts` or reorders its recipes; `i18n-keys.ts` is GENERATED —
on conflict take either side and rerun `npm run i18n:gen-keys`, never hand-merge.

**`generic` must be ABSENT from `SPORT_PALETTES`, not present-with-defaults.**
That file holds OVERRIDES ONLY; a present entry stops `sportThemeStyle`
returning `undefined` and the pad root gains a style attribute it should not
have (`__tests__/sport-theme.test.ts` locks this). Generic is by definition the
"no skin" baseline, so it is the one sport that must inherit.

**SEQUENCING — R7's totality flip is gated on R6 merging.** R7's acceptance
("the LEGACY set is EMPTY and the gate proves totality") needs FIVE sports
gone: R7's three and R6's two. `resolvePad` (`registry.ts:157-160`) THROWS for
a key in neither set, so deleting the legacy lane early does not degrade
hockey/icehockey — it bricks them. The flip is a single commit held at the tip
and is NOT written on an assumption about R6's timeline.

### R7 — inherited from R6, do not re-derive

- **Referrer sweeps must go by SPORT KEY, not filename.**
  `__tests__/skin-coverage.test.ts:173-174` maps `hockey`/`icehockey` to
  `"period"` by sport key; no grep for the string `period-skin` will ever
  surface it. R7 sweeps `"boardgame"`, `"carrom"`, `"generic"` as bare string
  literals across `src/` and `e2e/` before touching the legacy lane. This is
  AGENTS.md failure class 16 in a form a filename grep cannot catch.
- **No v3 tile sends `at`, so `state.asOf` is never set** — football's
  `readClock` (`v3/skins/football.tsx:305-312`) has been reading a value
  nothing produces. R6 is building a pad-local clock that stamps `at`, so
  football inherits a working clock when R6 merges; any R7 assumption that the
  clock strip item is never present expires at that merge.
- R6's D-8 and D-9 are closed as **MISSTATEMENTS**, not fixes — `f5a1628750`
  (2026-08-13) created `period-skin.tsx` with the collapsed `ActionForm`
  already in it, two days BEFORE D-8 was filed. Recorded that way so nobody
  re-fixes them or reads their absence as a regression.

### R7-9 — sport palettes for boardgame and carrom; generic stays ABSENT

Owner asked what boardgame/chess gets in `SPORT_PALETTES`. Answered from the
closed token set (`sport-theme.ts:55` — `board`, `board-2`, `ink`, `led`,
`caution`, `dismissal`; overrides only; painting goes through the `.pad-*`
classes in `globals.css`, so an entry using existing tokens needs no new CSS).

**boardgame — the chess CLOCK, not the chess board.**

    board    #1c1a17   warm near-black, tournament clock casing
    board-2  #2a2621   the band the player names sit on
    ink      #efe9d8   the buff of the light square (#eeeed2 tournament vinyl)
    led      #e8b53a   amber — the running side's indicator, nothing else
    caution / dismissal — DELIBERATELY OMITTED

The board is the obvious source and the wrong one: tournament green `#769656`
lands beside football's `#0b1f16`, and two green LCD tiles is not an identity.
The clock is the better source because it is the one instrument in chess that
IS two halves side by side — which is exactly what the v3 scorebug is under
ruling R7-2 (tap a half, that player wins). Warm near-black also separates it
from every other skin, all of which are cool.

`caution`/`dismissal` omitted on purpose. `SportPalette` is `Partial`, and chess
has no card ladder; carrying yellow and red for a sport with no discipline
events is the "colour as decoration" the token doc's own header argues against.
Arbiter forfeits are authority chrome, not a card.

**carrom — the queen.**

    board    #2a1810   lacquered board brown
    board-2  #3a2318
    ink      #f4ece0
    led      #c1272d   the queen's red
    caution / dismissal — OMITTED (no discipline events)

**generic — NO ENTRY, and this one is forced, not chosen.** It is the baseline
for what "no skin" looks like. A present-with-defaults entry stops
`sportThemeStyle` returning `undefined`, the pad root gains a style attribute it
should not have, and `__tests__/sport-theme.test.ts` fails. Absent is the
correct state.

**Owner ruling on the verdict route (2026-08-30): these get their per-screen
verdict at the WAVE GALLERY, alongside the skins — not on a separate swatch
sheet.** So Task A must land the palette entries before the gallery run, or the
gate is theatre: the capture would show three sports on default styling and the
owner would be signing off on a palette that is not in the picture.

Sequencing: R6 is editing `sport-theme.ts` for the `advisory` token widening.
R7 warned R6 before adding these, per the file contract; entries go in
ALPHABETICAL order, so boardgame and carrom both sort ahead of R6's `hockey`.
Every value is contrast-computed against the surface it actually paints on in
`__tests__/contrast.test.ts` — that file's header records that adding a token
without adding its pairs there is the failure mode that ships an unreadable
board.

### R7-9a — AMENDED same day. R7-9's two palettes COLLIDED; measured, not argued

R6 measured all nine board grounds in CIELAB (CIE76 dE) rather than arguing hue
names. R7 reproduced the computation independently and got identical numbers.
Two outcomes, one of them against R7:

**R7's warning to R6 was WRONG.** R7 warned that field hockey's natural green
would land beside football's `#0b1f16`. Measured: hockey `#06323c` vs football
`#0b1f16` is **dE 16.6** (hue 226° vs 161°, L* 18.6 vs 9.9) — it is a teal, blue
channel dominating green. No risk. Recorded as a false premise of R7's own
making, to balance the six it found in other people's documents.

**R7-9's own two palettes were the real collision:**

    badminton #241a14 ~ boardgame #1c1a17   dE 5.1   TOO CLOSE
    badminton #241a14 ~ carrom    #2a1810   dE 4.9   TOO CLOSE

Three warm near-black browns within dE 5.1. R7-9's own argument — "two green LCD
tiles is not an identity" — applies exactly, and it was three brown ones. The
carrom case is STRUCTURAL, not a hex accident: a lacquered carrom board and a
maple badminton hall floor are the same material family, so no amount of nudging
the brown fixes it. The material had to change, not the shade.

**AMENDED VALUES** (dE measured against all seven shipped/planned grounds;
contrast computed against both the ground and the band):

    boardgame: board "#25142e"   aubergine
               board-2 "#33203d"
               ink  "#efe9d8"    buff of the light square
               led  "#f4767a"    the analogue clock's FALLING FLAG
               caution/dismissal OMITTED
      min dE 15.1 (vs tennis) · ink 14.22:1 / 12.24:1 · led 6.34:1 / 5.46:1

    carrom:    board "#3a0f14"   the red lacquered border
               board-2 "#4a161c"
               ink  "#f4ece0"
               led  "#e0a63c"    french polish / the brass striker
               caution/dismissal OMITTED
      min dE 18.0 (vs badminton, was 4.9) · ink 14.24:1 / 12.60:1 · led 7.70:1 / 6.81:1

    boardgame ~ carrom = dE 25.7.

The accents SWAPPED sides as a consequence, and both are still true to source.
Carrom's queen red moved from the accent to the GROUND — which is the better
place for it, since the queen is the centre of the board and the ground *is* the
board — and the accent became the board's french polish. Boardgame lost the
amber clock-casing story with the warm ground and gained a sharper one: the
falling flag is the single most iconic signal in chess timekeeping, and it is
red. It is now the only red-accented skin in the product.

`led` had to be tuned for legibility, not chosen: the true flag red `#e5484d`
measured 4.40:1 on the ground and **3.79:1 on the band — a FAIL**, and `led`
paints strip digits, which are small text. `#f4767a` clears AA text on both
(6.34 / 5.46) and still reads as a flag rather than pink.

Method note for later waves: dE < 8 means "reads as one colour on a sign-off
sheet"; 8–12 is close; the amended values sit at 15.1 and 18.0. Both R7 palettes
must be pinned EXPLICITLY in `__tests__/contrast.test.ts` the way R5's racquet
block is — that file's tone licence is USAGE-DRIVEN and only holds a tone to the
text floor once it finds it used as text in a real skin source, so a palette
landing before its skin exists would red NOTHING on a bad hex.

Also still open and NOT R7's to fix: R6 measured `tabletennis #101418 ~
icehockey #08090c` at dE 4.2 and is taking its ground back to the owner as a
refinement within the already-approved direction (accent unchanged).

### R7-10 — engine surface of the three sports, pinned before Task A

Facts that change the Task A design, verified against the modules:

- **All three declare `fidelityEntitlements: {}`** — empty, not absent
  (`boardgame.ts:476`, `carrom.ts:709`, `generic.ts:376`). Per the R2 inherited
  obligation, an empty map means the recording chip renders an UPSELL for a band
  nothing gates. All three skins owe a real map or a justified empty one.
- **boardgame's method enum is 13 values, not 4** (`boardgame.ts:103-117`):
  checkmate, resign, time, agreement, stalemate, insufficient, forfeit,
  adjudication, double_forfeit, repetition, fifty_move, dead_position,
  illegal_move — split into `DECISIVE_METHODS` and `DRAWN_METHODS`
  (`:423-433`). R7-2's dock must offer the DECISIVE set after a half tap and the
  DRAWN set after the ½–½ tile, never one flat list of 13.
- **A draw is not a separate event.** `boardgame.result` with `winner: null`
  (or omitted) plus a drawn method. The whole payload is optional with a
  `.refine` requiring at least one fact (`:133-148`).
- **`generic` declares NO `entrantModel` at all** — the field is absent from the
  module object, not defaulted. Any skin logic branching on it must handle
  undefined.
- **`generic`'s padSpec branches on `resultMode`** (`win_loss` vs `score`), the
  only one of the three whose variant changes the pad. boardgame's
  classical/rapid/blitz is clock metadata with ZERO event-surface or pad effect;
  carrom's icf/club-29 shifts cfg numbers only.
- **"Three thin skins" is optimistic.** The smallest existing `tapModel: "S"`
  skin is `skins/tabletennis.tsx` at 1290 lines (tennis 1313, badminton 1313,
  volleyball 1761). Size the wave accordingly.
- **The gallery is BLIND to all three docks.** None of boardgame, carrom or
  generic declares an `EXTRA_STATES` entry, and the five shared `STATES` do not
  open a dock. Per the standing instruction at `_INDEX` L656, anything behind a
  tap needs its own `EXTRA_STATES` entry or the gate is theatre — and R7-2 puts
  boardgame's Method behind exactly such a tap.
- Current `scoreOne` selectors that this conversion DELETES: boardgame `:2372`
  clicks `"Draw / no result"` then `getByLabel("Method").selectOption`; carrom
  `:2295` clicks `"Board (queen covered)"`; generic `:2332` clicks
  `"Add points"`. All three must be rewritten in the same change.

### R7-11 — R7's OWN false premises, and the pattern behind them

Three premises R7 asserted and then had to withdraw, all on the same day, all
against the R6 session. Recorded because the PATTERN is the finding, not the
individual errors:

1. **"Field hockey's green will collide with football's."** Measured at dE 16.6
   — it is a teal. Wrong.
2. **"`SPORT_PALETTES` is alphabetical, so keep entries alphabetical and the
   conflict resolution is mechanical."** The literal was NEVER alphabetical: it
   runs football, tennis, badminton, tabletennis, volleyball — **wave order**.
   A contract rule was built on this and had to be rewritten as
   "alphabetical AMONG NEIGHBOURS, never re-sort" — a reflow would have broken
   the no-reflow rule the same contract sets.
3. **"R6 owes `positionsFor` declarations for its two sports."** The period
   kernel already declares it (`kernel.ts:2434-2443`), shared by both. No
   declaration was owed; R7's read path is the ENTIRE fix.

**The pattern: all three were assertions about files R7 had GREPPED but never
READ.** A grep returns the keys and not their order, the hex and not its
measured distance, the absence of a symbol in one file and not its presence in
a shared kernel. Every one of these was stated with enough confidence that
another session acted on it, and in case 2 a shared contract rule was written
from it.

This is AGENTS.md failure class 5 ("the brief is a hypothesis") turned around:
the wave that was busy finding six false premises in other people's documents
authored three of its own in a few hours. A premise is not more reliable for
being newly derived — and the register's own unreliability, recorded as a
programme-level finding, is what a fresh derivation is supposed to fix.

Corollary now standing for the rest of this wave: **anything R7 asserts to
another session, or writes into a contract, must come from a READ of the file
or a MEASUREMENT — never from a grep hit.**

### R7-12 — branch topology: R7 does NOT stack on R6

R6 committed its token widening and both palettes on
`feat/scorepad-v3-r6-period-pair` and invited R7 to rebase onto it. **Declined.**

Rebasing R7 onto R6's branch makes R7 a stacked PR: R7's diff would carry R6's
commits, R7's base would be a branch rather than `main`, and a squash-merge of
R6 orphans R7's history against a base that no longer exists — a class this repo
has already been bitten by.

Instead both waves add their `SPORT_PALETTES` entries to their OWN branch and
git resolves two inserts at merge. Safe here specifically because the anchors do
not touch: R6's sit between `football` and `tennis`, R7's go above `football`,
so neither insert lands in the other's hunk. There is no semantic overlap, so a
conflict is resolved by taking both sides.

The only thing genuinely gated on R6 remains the totality flip.

### R7-13 — a tone value has a THREE-file compile-time fanout (from R6)

R6's `advisory` widening touched `v3/types.ts` and `v3/sport-theme.ts` as
briefed, and was then FORCED by tsc into `v3/tokens.ts` as well —
`SPORT_TONE_CLASSES` is indexed by `SportTone` imported from
`guided-sheet.tsx`. Recorded so a later wave adding an eighth tone does not
size it as a two-file change: the tone set fans out to types.ts,
sport-theme.ts, tokens.ts, a `.pad-*` rule in globals.css, and both
`contrast.test.ts` and `sport-theme.test.ts`.

### R7 Tasks B + B2 — DONE. Five more false premises, three of them R7's own

Commits `6dcc4dbc1`, `a0ef34463`, `03ace92e6`, `69de895c5`, `29c3e4cbd`.

**Gate, rerun by the MAIN THREAD on the worktree, not taken from the
implementer:** vitest `src/components/v2 src/app` = **4424 total / 4422 passed /
0 failed / 2 pending**, 1341 suites, **0 failed suites**; `jq -r
'.testResults[].name' | grep -vc worktrees/r7-console` = **0** (no path resolved
outside the worktree); `rtk proxy npx tsc --noEmit -p apps/web` **0 errors**;
`rtk proxy npm run lint` **✖ 125 problems (0 errors, 125 warnings)** — the
pre-existing baseline, unchanged. Baseline before the pass: 4370/4368/0, so +54.

A bare `npx tsc --noEmit` returned the string **"TypeScript: No errors found"** —
the exact fabrication signature `_RULES.md` §6 records. Rerun through
`rtk proxy` it emitted nothing and exited 0, which is what a real clean tsc does.
The trap is live; the first result was discarded.

**FP-7 (R7's own, and the most important finding of the pass): the B2 fix as
briefed would have shipped INERT.** `SportInfo.positionGroups` was
`{key,name}[]`, so `PositionGroup.min` was stripped one layer ABOVE the lineup
editor and nothing in the editor ever expressed a position requirement.
Repointing the three bootstraps at `resolvePositions` — the entire fix as R7-8
and the plan described it — would have resolved the conditional catalog
correctly and then thrown the conditional part away one layer later. **A fix for
an inert seam that was itself an inert seam.** Three layers had to land: resolve,
CARRY `min`, RENDER it (new `lineup.needsPositions` string × 4 dictionaries, new
`server/usecases/lineup-catalog.ts`).

This is failure class 1 caught mid-flight by an implementer who checked the
consumer instead of the producer. It is also the exact reason the wave's build
rule says to fold a producer's output through its REAL consumer.

**FP-8 (R7's own): the plan's column table mapped the wrong control.** It said
role select `:330-345` gates on declared roles. `:330-345` is the
engine-universal `LineupSlot.role` (player/coach/staff, `core/lineup.ts`, read by
`playingSquad` and cricket's `orderFromLineup`). The design of record means
Captain/Wicketkeeper **flags** — the checkboxes at `:366-390`, already gated by
mapping over declared `roles`. Following the plan would have DELETED a working
control from tennis, badminton and tabletennis. The implementer refused and was
right to.

**FP-9 (R7's own): "pair-order only for sports whose kernel consumes it" is
TAUTOLOGICAL** once the hide predicate lands — every still-visible pair-capable
sport consumes it, and carrom (the one that does not) is hidden. Expressing it
would need a new `SportModule` declaration (module.ts + 4 modules + conformance)
for a guard no test can kill. Left as `pairShaped`; out of blast radius.

**FP-10: path typo carried by both the brief and the plan** — `positionsFor` is
`packages/engine/src/**sports**/period/kernel.ts:2434`, not `sport/period/`.

**FP-11: the dispatch's own verify command could not run as written.**
`apps/web/vitest.config.ts` now hard-refuses an `.env.local` `DATABASE_URL`;
`DATABASE_URL=` would have silently skipped ~22 DB-backed files. The live `r7`
label env was used instead. Any later R7 dispatch must carry the label env, not
a bare vitest line.

Running total of premises this wave found false: **eleven**. Six in the
brief/register/index, **five authored by R7 itself** (three here, two in R7-11).

### R7-14 — REVIEW of B/B2: SHIP, with a false premise of R7's own at the centre

Reviewer pass run after the owner pointed out that B/B2 had gone
implementer → gate-rerun → commit with ZERO reviewer passes. That is AGENTS.md
failure class 12 exactly, and rerunning a gate is NOT a review: it proves the
tests that exist pass, never that they test anything. Reviewer loop is now
standing for every pass in this wave.

**VERIFIED GOOD** (this is what the loop was for):
- The seam is genuinely wired end to end. Every hop reads `min`:
  `sports/period/kernel.ts:2434-2443` → `sport/catalog.ts:53-56` →
  `server/usecases/lineup-catalog.ts:33` → `f/[no]/page.tsx:68,168` +
  `score/[token]/page.tsx:107,167` → `fixture-console.tsx:168` → `:620` →
  `lineup-editor.tsx:313` → `:256` (`g.min ?? 0`) → `:370-376`. Not inert.
- Tests drive REAL modules through REAL renders, no fixture on both ends. Every
  absence probe anchored on `="`. No test name disagrees with its assertion.
  Reviewer re-ran independently: 54/54, 3 suites.
- The implementer's REFUSAL was correct. `lineup-editor.tsx:421-436` is the
  engine-universal `LineupSlot.role` (player/coach/staff, read by
  `core/lineup.ts:333` `playingSquad`); Captain/Wicketkeeper are the checkboxes
  at `:457-485`, already self-gating on an empty `roles`. Gating the select
  would have deleted a working control from tennis, badminton and tabletennis.

**FP-12 — R7's SIXTH false premise, and the worst kind: R7-8's customer fact
did not exist.** R7-8 asserted, and the plan and two dispatch briefs repeated:
"a competition configured to play without a goalkeeper still shows the lineup
editor demanding one." Pre-wave (`ac207cb71`) the editor had **no minimum logic
at all** — nothing demanded a keeper, because nothing expressed a requirement.

So the wave did not FIX a nag; it ADDED one. The real change is that the editor
now expresses position minima for the first time, and it expresses them
cfg-correctly. That is still worth having, but it is a FEATURE, not a defect fix,
and it has a user-visible consequence nobody asked for: default-config hockey and
football sides will now newly see "Starting line-up still needs: Goalkeeper × 1".

R6 adopted R7's wording verbatim into their own index. Correction sent.

**Gaps to close (queued behind Task C — same worktree, one implementer at a
time):**

- **MAJOR, false comment + a SECOND inert seam.**
  `lineup-editor.tsx:227-229,366-368` claim the amber notice is the engine's
  `group_min` refusal "said in advance instead of as a 422 after Save".
  **No such 422 exists.** `validateLineup`/`assertLineup`
  (`sport/catalog.ts:73,143`) have ZERO production callers, and the lineup PUT
  route (`lineups/[entrantId]/route.ts:17-24`) does no catalog validation at
  all. The notice is advisory and Save never blocks. Two inert seams sitting
  adjacent, and the fix for one wrote a comment asserting the other works.
- **MAJOR, the win is not reachable by an organiser.** `goalkeeper` is settable
  NOWHERE in the UI — no hockey variant sets it (`hockey.ts:137+`), only the
  divisions API accepts it (`usecases/divisions.ts:250,719`). The chain is wired
  and correct and no organiser can produce the state that exercises it. This is
  the inert-seam class one level up: not dead code, but dead REACH. Football's
  `teamSize` half IS UI-reachable (`match-rules.tsx:286`), so the chain is not
  wholly unreachable.
- **MINOR, coverage shrank.** `fixture-console-ssr.test.tsx:34` and
  `fixture-console-undo-pad-events.test.tsx:86` got `benchMax: 0` beside a
  pre-existing `lineupSize: 0`, making `lineupEditorApplies` false, so both
  suites now render no lineup editor where they previously did. Nothing
  inverted, but SSR-determinism coverage is smaller. Use `benchMax: 1`.

Running total of premises found false this wave: **twelve**. Six in the
brief/register/index, **six authored by R7 itself**.

### R7-15 — owner rulings on the two review MAJORs (2026-08-30)

**The unguarded lineup write path: COMMENT ONLY in R7; the wiring is OWED.**
Correct `lineup-editor.tsx:227-229,366-368` so they stop asserting an engine 422
that does not exist. Do NOT wire `validateLineup` into the PUT route this wave.

Stated accurately for whoever picks it up, because "fix the comment" understates
what is left behind: this is **two inert seams and an unguarded write path**, not
a stale comment. `validateLineup` and `assertLineup` (`sport/catalog.ts:73,143`)
both have ZERO production callers, and `lineups/[entrantId]/route.ts:17-24`
performs no catalog validation, so **a lineup violating a declared group minimum
saves fine today**. That is a data-integrity question with real blast radius —
turning an always-succeeding save into one that can 422 on a route every sport
uses, with existing violating lineups failing on their next edit — and it needs
its own e2e. OWED BY R8 or its own change; recorded here so it is not rediscovered
as a defect.

The amber notice therefore stays ADVISORY: it tells an organiser what is missing
without blocking Save. For a club product that is arguably correct on its own
merits, not merely the cheap option.

**Keep the new notice, and ADD THE LEVER.** `goalkeeper` is settable nowhere in
the UI, so R7's correctly-wired conditional serves a state no organiser can
produce. A `goalkeeper` field goes into `match-rules.tsx` this wave. Without it
the whole B2 chain is correct and unusable.

**Dead code vs DEAD REACH** — the distinction this wave produced, worth carrying
forward. Dead code is unreachable and shows up in coverage. Dead reach is
wired, typed, tested, covered, and serves a state the product gives no user a
way to enter. **It passes every test a working seam passes.** The only thing
that catches it is asking "can a real organiser produce this state, and through
which control?" — a question no test suite asks.

**R6's position on the nag, taken independently:** keep it. Both period modules
declare `GK`/`G` at `min 1, max 1` (`hockey.ts:33`, `icehockey.ts:43`), so
"Starting line-up still needs: Goalkeeper × 1" is TRUE and useful to an organiser
building a side. R6 is adding it to their `captureExtra` states deliberately and
naming it at their walkthrough as new behaviour arriving from R7 — rather than
having it appear unexplained in a capture. Suppressing a true, useful notice to
keep a review artifact tidy optimises the artifact over the product.

### R7-16 — "a read is not a run", now in AGENTS.md (joint finding with R6)

The generalisation behind R7's sixth false premise, promoted by R6 into
`AGENTS.md` so it reaches every session rather than living in two indexes:

> "`resolvePositions` has no production callers" is TRUE and grep-checkable.
> "…so a user sees the editor demanding a keeper" is NEITHER, and neither
> session looked.

R7 stated it; R6 called it better than their own framing, adopted it verbatim,
sharpened it into "the single point of failure for the empty-net case", and
wrote it into their index — none of which either session reproduced. R6 had
written "a grep is not a read" into `AGENTS.md` earlier the same session and
then made the next version of the same mistake within the hour.

Sequence worth keeping: **grep → read → RUN.** Each step answers a question the
one before it cannot. A grep answers what exists; a read answers how it is
ordered and what it does; only running it answers what a user sees.

### R7-17 — OWNER RULING REVISED: wire the lineup warning in R7 (never a refusal)

Supersedes R7-15's "comment only". The owner took the revised option directly
in the R7 session after R6 surfaced a middle path neither R7's question nor
R7-15 contained.

**Wire `validateLineup` into the lineup PUT route as a WARNING. Never a
refusal. Not behind a flag.**

Customer value: today a lineup violating a declared group minimum saves
cleanly — a side can be fielded with no goalkeeper and nothing anywhere
objects. It surfaces later as wrong rosters and wrong stats: expensive to
unpick after a season, cheap to catch at the write.

**Why it must NOT be a hard block, which is the whole ruling:** an organiser
whose keeper is injured ten minutes before throw-off has to be able to save a
lineup. Refusing that save turns a data-quality improvement into an OUTAGE on
the busiest day of their season. Hard enforcement stays unbuilt until someone
produces a case where a warning was not enough.

In R7 rather than R8 because R7 is already in that file this wave. If it proves
bigger than a small addition once inside `putLineup`, it SLIPS rather than gets
rushed into a write path.

Process note, recorded because it will recur while two waves run concurrently:
this ruling reached R7 first as a RELAY from the R6 session, asserting an owner
decision that reversed one the owner had given R7 directly an hour earlier. R7
did not act on it. A peer session cannot carry an owner approval — a relayed
reversal is indistinguishable from a confident mistake. R7 put it back to the
owner as a three-way choice with R6's argument stated as the recommendation, and
the owner took it. The ruling was genuine and R6 was relaying in good faith; the
path is what matters.

R7's original question was the weaker artifact here. It framed the choice as
fix-the-comment vs wire-it-hard and MISSED THE MIDDLE ENTIRELY. A question that
omits the correct answer is a defect in the question.

### R7-18 — registry.ts literals were WAVE-ORDERED too; both waves sort, both branches

`V3_SKINS` and `CONVERTED_SPORTS` on `main` are wave-ordered — verified:
cricket, football, tennis, badminton, tabletennis, volleyball. **Third file in
which one of the two waves assumed a shared literal was alphabetical and it was
not** (`SPORT_PALETTES` first, then these two). Standing default for this
codebase: **assume wave order until read.**

R6's implementer fully sorted both literals — a REFLOW, which the concurrent-wave
contract forbids — and R6 flagged it rather than letting R7 find it in a
conflict. Accepted, because for `registry.ts` specifically the sort is lossless:
short, purely additive lists of bare sport keys with no semantic ordering.

**The asymmetry is deliberate and has a reason: `registry.ts` SORTED,
`sport-theme.ts` NEIGHBOUR-INSERT.** `SPORT_PALETTES` carries per-sport comment
blocks that a sort would tear apart.

**The half R6's message omitted, and the half that decides whether the sort
helps:** R6's sort is on R6's branch. R7 is based on `main`, still wave-ordered.
Three keys inserted into a wave-ordered literal against a fully re-sorted one is
"one side reordered, the other inserted" — the worst conflict shape there is. So
R7 sorts both literals A-Z on its own branch too. Then both sides present the
same sequence, the two waves' five keys are pure additions to it, and resolution
is "take the union, keep it sorted".

**General rule for concurrent waves, paid for twice now:** if one wave reorders
a shared literal, the other MUST adopt the same order on its own branch. A
unilateral sort is only safe when the other side never touches the file.

Also carried: the totality test fails a key present in BOTH sets as loudly as a
key in neither, so add-and-exclude must land in the SAME commit.
