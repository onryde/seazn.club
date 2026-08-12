# P4 — Format templates: catalog + instantiation + wizard (D1a, single-stage)

Read first: `docs/superpowers/RULES.md` → `_INDEX.md` → spec
`../2026-08-13-format-templates-design.md`. Worktree + fresh branch.

## Scope

1. `apps/web/src/server/templates/schema.ts` (`CompetitionTemplate` zod,
   NO `seeding` field yet — that lands in P7 with D4) + catalog loader +
   `catalog/*.json` for the 5 single-stage launch templates: `slam128`,
   `swiss11`, `wc32` (groups only, KO stage without cross-stage seeding),
   `americano-night`, `box-league`.
2. `POST /api/v1/competitions/from-template` + `createFromTemplate`
   usecase: competition → divisions (through EXISTING validation paths —
   templates can never bypass config validation) → stages; transactional
   rollback on any failure; stamps `template_key`+`template_version`
   (migration adds the two columns). OpenAPI regen.
3. Wizard step 0: template gallery + detail sheet + "start blank";
   routes into entrant-add with placeholder counts. i18n ×4 — catalog
   JSON contains KEYS only, never English.

## Files (scout re-pins first)

- new: `apps/web/src/server/templates/**`, migration `V<next>` (re-verify
  next free number at execution)
- create-competition wizard components (scout locates), `schemas.ts`,
  `openapi.ts`, key-scopes, 4 dictionaries

## Do NOT touch

`stages.ts` generators, D4 surfaces, `packages/engine/**`, demo
`ai-templates/**` (marketing demo is a different mechanism — do not
merge them).

## Acceptance criteria

- Unit: every catalog entry zod-parses AND instantiates against a test
  org (structure counts, valid cfg snapshots, provenance stamped);
  induced mid-instantiation failure → full rollback (no orphan
  competition).
- Regression: per-template instantiated shape pinned (divisions × stages
  × kinds) — catalog edits that change shape must red.
- E2E: pick template → structure on competition page → entrant guidance.
- Smoke: `from-template` once, then normal flow continues on it.
- Catalog uses DB-checked StageKinds ONLY (the 9-vs-6 divergence stays a
  bench-spec triage item — do not "fix" it here; escalate if it blocks).
- Gallery verified 1280/320/768 (one column at 320).

## Verify (verbatim)

```bash
npx vitest run --reporter=json --outputFile=/tmp/p4.json apps/web/src/server
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p4.json
rtk proxy npm run lint
npm run openapi:gen && git status --porcelain
```

## Output cap

Final message under 15 lines — commits, verified counts, files touched,
deviations, blockers. No file contents, no diffs.
