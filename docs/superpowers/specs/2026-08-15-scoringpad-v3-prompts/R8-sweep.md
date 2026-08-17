# R8 — Sweep and close

Read `_RULES.md`, `_INDEX.md`, spec §5–§8. Scout re-pins.

**Task:** the programme's discharge wave.

- Delete the legacy lane machinery entirely (compat shim, `LEGACY_SPORTS`,
  any v2 skin remnants) — `git grep -a` zero refs; totality gate now asserts
  the v3 lane alone.
- The v2 pad spec files that the conversions rewrote piecemeal get a final
  reconciliation pass: no orphaned helpers, no dead dictionary keys (S13
  found 160 — run the same sweep).
- **Smoke debt discharged**: `scripts/smoke.ts` drives the v3 pad on the pro
  AND free paths (every wave deferred smoke here by name).
- i18n: `i18n:check` + the event-copy gate seeded from the engine's own type
  list (the S3 fix — verify it still reds on a missing `pad.*.ribbon` key).
- a11y: axe per skin (all 11), 44px sweep, contrast test green.
- Full seven-width `mobile.spec.ts` run including the pad surfaces; add any
  new-surface projects that are missing (a surface outside the matrix has
  zero width coverage).
- Help tree: `content/help/**` scoring pages updated (English only) + smoke
  demo updated.
- **Final all-sports gallery** (the harness, all 12 captures) + full owner
  walkthrough — the programme's closing sign-off, recorded in `_INDEX.md`.
- Register audit: every D-row closed or carrying a recorded reason; every
  GF mapped section spot-checked against the shipped UI.
- Memory + `_INDEX.md` PROGRAMME CLOSED section, v2-style.

**Acceptance:** all four test types green programme-wide (JSON counts), zero
deferred debt without a named owner, owner's closing sign-off recorded.

## Inherited from R2 — debts with your name on them

- **Attribution has no required/optional flag, so nothing can validate it.**
  `checkActionValidity` (`apps/web/src/components/v2/scorepad/view-model.ts:208`)
  deliberately skips attribution, and its own docstring says why:
  `PadAttributionItem` (`packages/engine/src/sport/module.ts:264`) carries only
  `kind`, `path`, `role?` and `labelKey?` — nothing distinguishes a required
  item from an optional one, and the same action legitimately has both
  (`cricket.review`: `by` required, `person`/`against` optional). Today an
  action can be confirmed with a required person unfilled; the engine's
  `strictObject` then rejects it and the scorer's tap DEAD-ENDS on a refusal
  (`cricket.toss.wonBy`, `cricket.review.by`). It is a dead-end tap, not data
  loss. Fix = add the flag to the engine contract, populate it across all 11
  sports' `padSpec` declarations, honour it in `checkActionValidity`, then
  conformance + golden replay because `padSpec` output is recorded surface.
  R2 could not take it: §9 permits no engine work there. See §9 item 2.
- **Cricket's dock has no shot-type chip.** Spec §3 promises shot-type
  enrichment; `CricketBall` is a `z.strictObject` with no field to carry it, so
  the dock ships with Free hit alone. Adding the field is a payload change with
  golden-corpus consequences. See §9 item 3.
- **Delete `skins/cricket-skin.tsx`** (dead for cricket since R2's flip, kept on
  disk because the v2 path must work until the last sport converts), and drop
  cricket's now-unreached `RESOLUTION_KIND` row with the rest of the legacy
  machinery.
- **R2 deferred SMOKE to you by name** — `scripts/smoke.ts` has never driven the
  v3 cricket pad, on either the pro or the free path.
- **Finish `content/help/scoring/fidelity.md`.** R2 reworded it to be true of
  BOTH lanes (worded recording chip for cricket, raw picker for the other ten).
  Once the last sport converts, that dual wording becomes wrong. `basics.md`
  now links `scoring/cricket.md`; the per-sport page convention is the pattern.
- **Verify the event-copy gate reds on a missing `pad.<sport>.ribbon` key** —
  R2 added cricket's ribbon keys to `PAD_LABEL_KEYS`, which is what makes that
  gate meaningful.

## Inherited from R2b — owner-assigned, 2026-08-17

Full context and evidence: `R2b-remaining.md` §D beside this file; rulings in
`_INDEX.md`.

- **D2 — nothing on screen says which SCORING MODE an innings is in.**
  Cricket has TWO modes, not three: `createInnings(state, fidelity)`
  (`packages/engine/src/sports/cricket/cricket.ts:661`) takes `"fine"`
  (ball-by-ball) or `"coarse"` (summary), and "innings totals" is the same
  coarse path with `partial` omitted. The mode is **locked by the first event
  of the innings** and is reversible only by undoing that event — the fold
  re-derives it on replay. Today a scorer infers the mode ONLY from which
  tiles are present (over tile vs ball tiles), so someone who does not already
  know the rule cannot learn it from the pad.
  **Not fixed in R2b deliberately**: no owner ruling exists for what an
  indicator should SAY, and the chassis is shared by eleven skins — inventing
  copy would push it onto all of them. R8 owns it because R8 is the wave that
  sees every skin at once.
  Needs from the owner BEFORE code: the wording, and whether the indicator is
  cricket-only or a chassis affordance every sport gets.
  Do NOT conflate this with the **fidelity band** (0–3, closed): that gates
  plan entitlements and is a different concept wearing a similar word.

- **D3 — cricket smoke, restated with what R2b added.** Already owed above
  ("R2 deferred SMOKE to you by name"), but the surface grew: smoke must now
  also cover the over-by-over lane (`cricket.innings.summary` with
  `partial: true`), not just ball-by-ball. Both lanes are mutually exclusive
  per innings, so a single fixture cannot exercise both — plan two.

- **Standing warning for the sweep, from R2b's review.** The recurring defect
  class this programme keeps hitting is **the pad offering what the engine
  will refuse**. R2b found and fixed four instances in cricket alone (bowler
  ineligible at an over boundary, an unconditional free-hit chip, a tappable
  grid on a closed innings, all ten wicket kinds during a free hit). Three
  more are open and need chassis work (`R2b-remaining.md` §C, owner-assigned
  to R2c). When sweeping the other ten skins, hunt this class specifically:
  for every guided-sheet option list and every context-strip candidate pool,
  ask whether the engine can refuse a member of it in the CURRENT fold state.
  `assertDisabledTilesExplained` (`v3/tile-grid.tsx`, added in R2b) is
  test-only and catches the *unexplained* half, not the *offered* half.
