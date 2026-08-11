# z3 retirement — full removal, staged

**Date:** 2026-08-12 · **Status:** approved design, not implemented ·
**Scope decision:** all four jobs (prose, internal identifiers, public
contract, solver deletion). Solver deletion requires CP-SAT to replace the two
surfaces z3 still serves.

## Where z3 is live today

- **REFLOW** ("Re-flow unlocked") and the **AI generate/refine/repair rounds**
  still call z3, both default ON. BUILD and POLISH are already off it.
- `"z3"` is a **public enum value**: `apps/web/src/server/api-v1/schemas.ts:1016`
  (`engine: greedy | z3 | z3+lns | optimized`) and `:2190`
  (repair: `none | z3 | llm`); three occurrences in `openapi/v1.public.json`.
- `"z3"` is **stored** in board rows and in the demo fixture
  `apps/web/src/demo/ai-templates/northside-open.json`.
- `"optimized"` is the CP-SAT placement path (Task 06b, renamed from
  "cp-sat"), and the UI already renders z3 and optimized with identical copy
  ("Solver") in every locale (`result-strip.test.tsx:76-126`) — so the
  replacement vocabulary exists and a row rewrite is user-invisible.

## Stage order (each stage = one PR unless noted)

### A — CP-SAT reflow
Route reflow through the placement service: locked rows become `existing`
pins, unlocked become movable `fixtures`. The build contract already expresses
reflow; this is wiring, not new solver capability. Boards record
`engine: "optimized"`.
**Gate:** bench parity vs z3 reflow on the prod-shaped board — N ≥ 6 runs per
side (single runs vs a nondeterministic solver are coin flips), conflict count
never worse; reflow e2e specs green; solve wall respected.

### B — AI repair rounds on CP-SAT
The generate/refine/repair loop's z3 repair step becomes a placement-service
call (pin what stands, re-solve violators). End-state repair enum value:
`"optimized"`. Note: z3's own LNS repair was already proven a dead end (never
fires on the prod board even gate-bypassed) — this replaces the call, it does
not port LNS.
**Gate:** AI demo (#364) generate → refine → repair loop green in e2e; repair
bench not worse. Known limit: the repair bench omits hard rules (#455) — gate
on conflict counts from the verifier, not on the bench alone.

### C — prose, docs, internal identifiers (parallel-safe, anytime)
Comments, docs, internal function/module names. **Never touches stored enum
VALUES** — an identifier that is also a persisted value belongs to stage D.
Zero behavior change; no gate beyond green suites.

### D — public contract retirement (after A+B deployed: nothing writes z3)
1. Migration (next free V-number): rewrite rows `engine z3 | z3+lns →
   optimized`, repair `z3 → optimized`. Rewrite-then-narrow order is
   mandatory: `ScheduleConfig` is the READ path — narrowing the enum while
   old rows exist 500s them.
2. Narrow `schemas.ts:1016` to `["greedy","optimized"]` and `:2190` to
   `["none","optimized","llm"]`.
3. Regenerate `openapi/v1.public.json` — drift gate is CI-only; run the gen
   locally and commit, `git status --porcelain` clean.
4. Regenerate the demo fixture (`northside-open.json`).
5. Remove z3 branches from `result-strip.tsx` ENGINE_KEY and the four locale
   dictionaries (i18n rule: all 4 dicts, flat dotted keys).
6. Grep e2e for the literal text before merging (UI-text-breaks-e2e rule),
   and grep with `-a` (files here report as binary).
7. **Breaking change:** public API consumers lose `"z3"`/`"z3+lns"` as input
   values — changelog entry + release note owed.

### E — delete the solver (last)
- Remove the z3 npm dependency and its WASM plumbing: the `next.config`
  tracing includes AND `serverExternalPackages` entry (the pair was needed to
  make z3 work in standalone; both go).
- Delete the z3 reflow/repair code paths, their env flags, and their tests.
- **Gate:** `git grep -a -i z3` clean outside historical docs, migrations,
  and this spec; full suite green; prod-shaped board reflow + AI loop e2e
  green.

## Tests (failing-without, per stage)

- A/B: a reflow (resp. repair) invocation asserts the placement client was
  called and no z3 module loads (spy on the import boundary).
- D: schema test rejects `"z3"` as input; a stored-row fixture predating the
  migration reads back as `"optimized"`; openapi snapshot has zero `"z3"`.
- E: dependency-graph test (or knip/depcheck gate) proves the z3 package is
  unreferenced.

## Out of scope

- Round-ordering awareness for reflow/repair arrives automatically with
  stages A/B (CP-SAT enforces it once the round spec lands) — closing the gap
  named in the round-ordering spec, but not designed here.
- No changes to greedy or POLISH paths.
