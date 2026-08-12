# P6 — Stage progression: proposal UI + confirm flow (D4b)

Read first: `docs/superpowers/RULES.md` → `_INDEX.md` → spec
`../2026-08-13-stage-progression-design.md`. Depends on P5 merged.
Worktree + fresh branch.

## Scope

1. Stage page panel: proposal table (rank, entrant, source, destination
   slot), tie rows demanding a pick before confirm, edit-in-place,
   confirm CTA; stale-proposal banner + recompute.
2. TBD slot labels rendered EVERYWHERE fixtures appear (org pages,
   public pages, exports keep raw labels) — localized patterns ("Winner
   {group}", "Runner-up {group}", "{nth} best 3rd", "Winner {match}"),
   ×4 locales.
3. Destructive-edit warning dialog for late structure changes (names the
   fixtures + applied schedule being discarded), wired to P5's codes.

## Files (scout re-pins first)

- stage page + fixture list components (org and public — scout
  enumerates every fixture renderer), 4 dictionaries, e2e specs

## Do NOT touch

P5's server logic (bugs found → fix inline only if in-file-scope small,
else escalate per RULES.md), scoring pad surfaces, templates.

## Acceptance criteria

- Unit: label pattern renderer (params, all 4 locales resolve, no
  concatenation).
- Regression: fixture list with a MIX of filled + TBD rows renders both
  (anchor on `="` per the RSC vacuous-assertion rule — a bare data-*
  probe passes in both states).
- E2E: full browser flow — group stage decided → panel → edit one slot
  → resolve a tie → confirm → bracket shows real entrants, schedule
  times unchanged on screen; destructive-edit dialog path.
- Smoke: existing smoke gains the proposal-confirm step (extend the
  P5 step to drive it via UI-facing routes).
- **UI-text-breaks-e2e rule**: grep new/changed visible strings across
  `apps/web/e2e/**` before merging.
- Panel + labels verified 1280/320/768; no horizontal page scroll; tie
  picker touch-friendly.

## Verify (verbatim)

```bash
npx vitest run --reporter=json --outputFile=/tmp/p6.json apps/web/src
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p6.json
rtk proxy npm run lint
npm run openapi:gen && git status --porcelain   # UI-only session: must stay empty
```

E2E per the local recipe (fresh port, prod server, `E2E_PROD_TARGET`) —
never enable `.github/workflows/e2e.yml`.

## Output cap

Final message under 15 lines — commits, verified counts, files touched,
deviations, blockers. No file contents, no diffs.
