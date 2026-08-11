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
- z3 reflow/repair code paths, their env flags, their tests.
- Any `z3` branch left in solver-selection logic.

## Do NOT touch

Placement service, greedy, the historical docs/migrations C6 classified as
stays-for-history.

## Acceptance

- Dependency-graph proof (knip/depcheck or an import test) that the z3
  package is unreferenced — fails while any import remains.
- `git grep -a -i z3` clean outside history/migrations/specs — paste the
  remaining-hits list.
- Prod-build smoke: standalone build + reflow + AI loop e2e green (the WASM
  config removal is exactly the kind of change that ships a silent prod
  no-op — prove the prod server path, not the dev server).
- Full suites green, numbers raw.

## Verify

Prod build + `E2E_PROD_TARGET` locally (e2e workflow stays disabled);
suites via JSON reporter.
