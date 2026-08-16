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
