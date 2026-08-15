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
