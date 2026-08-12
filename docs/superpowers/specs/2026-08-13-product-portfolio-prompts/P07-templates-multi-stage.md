# P7 — Multi-stage templates (D1b)

Read first: `docs/superpowers/RULES.md` → `_INDEX.md` → specs
`../2026-08-13-format-templates-design.md` +
`../2026-08-13-stage-progression-design.md`. Depends on P4 AND P5 merged
(consumes `StageSeeding`). Worktree + fresh branch.

## Scope

1. `CompetitionTemplate` gains `stages[].seeding?: StageSeeding` —
   import the P5 schema, do NOT redeclare it (one vocabulary; drift
   between two copies is the parallel-paths defect class).
2. Add the 3 held-back templates: `euro24` (6 groups → best-thirds R16
   chain), `t20-super8` (4 groups → Super 8 → SF/F), `league-playoff`
   (league → top-4 page playoff*). *page_playoff only if DB-checked; else
   knockout(4) and note it.
3. Instantiation generates seeded stages + their TBD fixtures via P5's
   pathway; wizard detail sheet renders the progression map (textual:
   "Top 2 per group → QF").

## Files (scout re-pins first)

- `apps/web/src/server/templates/schema.ts` + catalog JSONs +
  instantiation usecase + its tests, wizard detail sheet, 4 dictionaries

## Do NOT touch

P5 server internals, stages.ts, engine. Escalate if `StageSeeding` needs
a field templates can't express — do not fork the schema.

## Acceptance criteria

- Unit: 3 new entries parse + instantiate; instantiated seeded stages
  carry rules AND fully-TBD fixtures with correct slot counts (euro24:
  16 R16 slots incl. 4 best-third sources).
- Regression: pinned-shape table extended; P4's 5 entries byte-stable
  (adding multi-stage must not disturb single-stage output).
- E2E: create from `t20-super8` → three stages visible, Super 8 fixtures
  TBD-labeled.
- Smoke: one multi-stage from-template creation.
- i18n ×4 for new template/stage name keys + progression-map strings.

## Verify (verbatim)

```bash
npx vitest run --reporter=json --outputFile=/tmp/p7.json apps/web/src/server
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p7.json
rtk proxy npm run lint
npm run openapi:gen && git status --porcelain
```

## Output cap

Final message under 15 lines — commits, verified counts, files touched,
deviations, blockers. No file contents, no diffs.
