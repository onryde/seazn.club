# P5 — Stage progression: seeding rules + TBD fixtures + fill engine (D4a)

Read first: `docs/superpowers/RULES.md` → `_INDEX.md` → spec
`../2026-08-13-stage-progression-design.md`. Worktree + fresh branch.
Server/engine only — UI is P6.

## Scope

1. `StageSeeding` zod (rankRange / topNPerGroup / bestNth; placement
   seeded_map | snake | rank_order) on `stages.seeding jsonb`
   (migration; re-verify next free V number).
2. TBD fixtures: nullable `home/away_entrant_id` + jsonb
   `home/away_slot_label` pattern params; `generateStageFixtures`
   produces fully-TBD fixtures for seeded stages at division start;
   count/shape derived from rules.
3. Cross-stage fill routes through the SAME slot-fill pathway as
   intra-bracket advancement (`fillSlot` family) — one pathway, not two.
4. `stage_seed_proposals` table + compute on `completeStage` (qualifiers
   per rules from `getStandings`, bestNth cross-group cascade, tie
   flags, standings snapshot hash); `overrideStandings` marks drafts
   stale + recomputes.
5. Routes: `POST /stages/{id}/seed-proposal`, `POST
   .../seed-proposal/confirm` (validates entrants ∈ division, each slot
   filled once; fills; re-runs schedule validation; pino `stage_seeded`).
   OpenAPI regen. Late structure edits stay destructive-with-warning —
   guard text is P6's, the 409/422 codes are P5's.

## Files (scout re-pins first — enumerate EVERY fixture reader)

- `apps/web/src/server/usecases/stages.ts` (generate/complete/standings/
  fillSlot), fixtures migration + readers scout list (public pages,
  stats, exports, scoring guard — scoring an unfilled fixture must 422),
  `schemas.ts`, `openapi.ts`, new migration(s)

## Do NOT touch

`schedule.ts`/`build.ts` beyond the one validation re-run call,
placement service, `packages/engine/**` fold code, wizard/UI (P6),
templates (P7).

## Acceptance criteria

- Unit: every `take` kind; UEFA third-place table reproduced for
  bestNth; snake + seeded_map placement; double-assignment + foreign
  entrant rejected; tie flagged never silently ordered.
- Regression: **confirm leaves `scheduled_at`/court/pins byte-identical
  on filled fixtures** (the non-destructive guarantee this design exists
  for); stale-proposal on standings override; unfilled-fixture scoring
  422s with a typed code.
- E2E (API-level here; browser flow is P6): groups → complete → proposal
  → confirm → KO entrants filled, schedule intact.
- Smoke: seed → complete → propose → confirm → next stage playable.
- `crossPersonClash` skip-until-filled recorded in code comment +
  re-validated on fill (warning surfaces, run not blocked).

## Verify (verbatim)

```bash
npx vitest run --reporter=json --outputFile=/tmp/p5.json apps/web/src/server
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p5.json
rtk proxy npm run lint
npm run openapi:gen && git status --porcelain
```

## Output cap

Final message under 15 lines — commits, verified counts, files touched,
deviations, blockers. No file contents, no diffs.
