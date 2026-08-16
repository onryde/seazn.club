# R2 — Cricket conversion (owner priority 1)

Read `_RULES.md`, `_INDEX.md`, spec §2/§3 (cricket row), §8. Scout re-pins
everything; the v2 skin is `skins/cricket-skin.tsx` (976 lines at capture).

**Task:** Convert cricket to a `SkinDefV3` (tapModel **T**): night scorebug
(`12/0` batting half passive, overs half passive; strip = ▸ striker* ·
non-striker · over dots · ⚾ bowler), run keypad 0–6 + Wide + red Wicket +
extras minor row, **context strip** (striker/non-striker/bowler — replaces
the three dropdowns, D-14), wicket as guided sheet (kind → who out → fielder,
D-15), dock enrichment (shot type), ribbon copy keys
`pad.cricket.ribbon.*` ×4 locales, new-batter prompt after wicket +
`cricket.retire` flow via the Swap-sheet primitive (spec §2.7).

**Variants:** t20/odi/hundred identical spec; `test` adds declare/follow-on/
match.close tiles (phase-aware). The hundred's 5-ball over is cfg-only and
NEVER appears in PadSpec (S11 finding) — the over-dots strip must read
`ballsPerOver` from cfg, not assume 6.

**Two things R1 left for you — read before scoping, they widen this task:**

1. **The guided-sheet renderer does not exist.** R1 shipped
   `GuidedSheetSpec` / `SheetChoiceStep` / `SheetPersonStep` and
   `TileSpec.action = {sheet: string}` in `v3/types.ts` with ZERO consumers:
   `tile-grid.tsx` forwards `tile.action` to `onAction` untouched and nothing
   renders a step wizard. R1's `swap-sheet.tsx` was built against its own
   `SwapSheetSpec`, so `{swap:true}` has a component and `{sheet}` does not.
   The wicket flow above is the first real use, so **R2 builds the chassis
   renderer as well as cricket's use of it.**
2. **The recording chip.** Spec §2.6 replaces the raw fidelity picker with the
   worded chip *when a sport converts*, so cricket is where it first renders —
   yet R1 shipped `buildRecording` with a hardcoded `planLabel("pro")` stand-in
   because no module declares `fidelityEntitlements` and the chip had no import
   sites. `plan-label.ts` already lists `pro_plus`. **Parameterise the plan name
   before the chip renders**, or an org already on Pro is told the band is
   "available on Pro". If you decide cricket should NOT wire the chip this
   wave, record that in `_INDEX.md` — silently leaving the old picker
   contradicts §2.6.

**Register rows owed:** D-4 (single ledger presentation on this surface),
D-5 (ribbon words, not payload dumps), D-14, D-15. Close or record why not.

**Do NOT touch:** engine modules, other skins, lineup editor (R7), console
chrome (R7).

**Acceptance:** registry gate flips cricket to the v3 lane (mutation-proved
both directions); every `cricket.*` event type reachable from the new surface
(dispatch-guard test); four test types — unit (builders), e2e (full over +
wicket + undo + device link, real rosters), smoke deferred to R8 (say so in
the PR body), regression (D-14/D-15 shaped); 320/768/1280 screenshots; axe on
the converted skin; **gallery + owner walkthrough sign-off recorded in
`_INDEX.md` before merge**.
