# C7 — z3 stage D: public contract retirement

Spec of record: `../2026-08-12-z3-retirement-design.md` (stage D).
Gate: C4 + C5 **deployed** — nothing writes z3 rows anymore. Verify that
before starting, don't assume it.

## Goal

`"z3"` / `"z3+lns"` leave the public API and the database. Enum end states:
`engine: ["greedy","optimized"]`, repair: `["none","optimized","llm"]`.

## Order inside the PR is load-bearing

1. Migration (next free V-number — check the deltas dir): rewrite rows
   `engine z3|z3+lns → optimized`, repair `z3 → optimized`.
2. THEN narrow `schemas.ts:1016` and `:2190`. **`ScheduleConfig` is the READ
   path** — narrowing before the rewrite 500s every old row.
3. Regenerate `openapi/v1.public.json` (drift gate is CI-only — run locally,
   porcelain clean).
4. Regenerate the demo fixture `apps/web/src/demo/ai-templates/northside-open.json`.
5. Remove z3 branches from `result-strip.tsx` ENGINE_KEY + the four locale
   dictionaries (UI copy for z3 and optimized is already identical — this is
   deletion, not wording).
6. Grep e2e for the literal values (`-a`) before merging.

## Do NOT touch

The z3 solver code/deps (C8), reflow/repair call sites (done), greedy.

## Acceptance

- Schema test rejects `"z3"` as input (fails before narrowing).
- A stored-row fixture predating the migration reads back `"optimized"`.
- openapi snapshot has zero `"z3"` occurrences (was 3).
- Changelog/release note for the public API breaking change — written, in
  the PR.
- Full suites + e2e green; migration tested against a fresh schema
  (`db:apply` + `sync:sports`, never the dev DB).

## Verify

Suites, drift gens, migration on fresh DB — all numbers raw.
