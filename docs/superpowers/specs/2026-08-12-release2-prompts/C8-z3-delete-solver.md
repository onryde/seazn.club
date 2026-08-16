# C8 — z3 stage E: delete the solver

Spec of record: `../2026-08-12-z3-retirement-design.md` (stage E).
Last in the programme. Gate: C7 merged + deployed.

## Goal

The z3 dependency and every code path that loads it are gone.

## File set

- The z3 npm dependency (lockfile churn expected — `pnpm`, frozen-lockfile
  discipline).
- `next.config` WASM plumbing: BOTH the tracing includes AND the
  `serverExternalPackages` entry — the pair was needed for standalone; both
  go, and removing only one leaves dead config.
- z3 reflow/repair code paths, their env flags, their tests — narrowed by C9
  (2026-08-16), see "Do NOT touch" below. Concretely: `repair.ts` (the
  ascending-k z3 encoder itself), `z3-load.ts` (WASM load/reset/lock), and
  — INSIDE `repair-decompose.ts` only — the `repairDecomposed()` function
  body and its z3-only imports (`repairSchedule`, `RepairVerificationError`
  from `./repair.ts`; `resetZ3` from `./z3-load.ts`). Their own test files
  (`repair.test.ts`, `z3-load.test.ts`, `z3-handle-release.test.ts`,
  `z3-serialisation.test.ts`, and the `describe("repairDecomposed"...)` /
  `describe("two repairs at once"...)` blocks in `repair-decompose.test.ts`
  that exercise it) go with them. `bench-repair.ts` and `bench-decompose.ts`
  (both z3-only benches) go too.
- Any `z3` branch left in solver-selection logic.

## Do NOT touch

Placement service, greedy, the historical docs/migrations C6 classified as
stays-for-history.

**Added by C9 (2026-08-16), narrowing the z3 file set above — do not widen it
back:** `repairComponents()` and `dayCapGuard()` in `repair-decompose.ts`
(the component graph and the day-cap decompose/whole-board guard — both
proven solver-agnostic; the file's own doc comment already says so), and
`disjointConflictBound()` in `repair-minimality.ts` — none of these three
import z3 or `repair.ts`, and `packages/engine/src/scheduling/
repair-decompose-cpsat.ts` (C9's own CP-SAT driver, and its tests) is the
production caller that reuses them. C9 verified this end to end:
`repairDecomposedCpsat` has ZERO production callers of `repairDecomposed`
(the z3 driver) left to protect — after C9, `repairDecomposed` itself joins
z3's own file set above (dead in production, kept compiling only for its
own tests and benches until this task deletes it) — but the GRAPH beneath
it does not, and deleting `repair-decompose.ts` wholesale (the reading this
brief's file set would otherwise invite) would take C9's own production
driver down with it. Leave `repair-decompose.ts` as a file that exists after
this task, containing only `repairComponents()`/`dayCapGuard()` and the
shared types both drivers already used (`RepairComponent`,
`RepairComponentReport`, `ComponentOutcome`, `ComponentSkipReason`,
`DecomposedRepairResult`, `DecomposedRepairStatus`, `DecompositionMode`,
`DecompositionModeReason`, `MinimalityCertificate`, `MinimalityVerdict`,
`MinimalityCaveat`) — everything else in that file (the `repairDecomposed`
function, its JSDoc describing the z3 ascending-k mechanism, its
`repairSchedule`/`resetZ3`/`RepairVerificationError` imports) goes. Leave
`repair-minimality.ts` untouched in full — it never imported z3 to begin
with. Re-verify this file:line split against `main` at the time C8 actually
runs; C9 only guarantees it was true the day it landed.

## Acceptance

- Dependency-graph proof (knip/depcheck or an import test) that the z3
  package is unreferenced — fails while any import remains.
- `git grep -a -i z3` clean outside history/migrations/specs — paste the
  remaining-hits list.
- Prod-build smoke: standalone build + reflow + AI loop e2e green (the WASM
  config removal is exactly the kind of change that ships a silent prod
  no-op — prove the prod server path, not the dev server).
- Full suites green, numbers raw.
- `repairComponents()`, `dayCapGuard()` (`repair-decompose.ts`) and
  `disjointConflictBound()` (`repair-minimality.ts`) still exist, still
  compile, still pass their own tests, and `repair-decompose-cpsat.ts`
  (C9's driver) still imports and uses them — the z3 deletion must not take
  the reusable graph down with it. `git grep -n "repairDecomposedCpsat"` and
  confirm it is unchanged by this task's diff.

## Verify

Prod build + `E2E_PROD_TARGET` locally (e2e workflow stays disabled);
suites via JSON reporter.
