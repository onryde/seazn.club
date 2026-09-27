# W1b — catalogues + reference skeleton

**Goal.** When this wave is done the programme knows exactly what it will test
and how big that is: the 69 scenarios split into atomic cases, a committed
applicability file with a reason per drop and a floor per row, a committed
variant set and L2 pair file, a fast-check command model hunting transition
bugs like #879, and an empty `packages/reference/` behind a CI import gate.
An organiser benefits indirectly: every later wave's "done" is measured against
these files, and a hole nobody listed now has a mechanism that can find it.

## Read first

- `_RULES.md` (R7–R13, R25–R29) and `_INDEX.md` (rulings 7, 10, 21).
- Design §3, §4 (whole scenario catalogue, applicability, compound split), §5
  (variants, boundary classes), §6.2 (layer sizes — you publish the real
  counts), §7.2 (reference package, import boundary, Dockerfile), §7.3, §7.3a,
  §7.5 item 1, §11 (O9, O10), §12.
- Audits: `audit-2026-09-27/spec-review.md`, `offered-matrix.md` (row list),
  `plan-facts-repo.md` (§1 workspace, §2 runners, §3 boundary gate, §5 CI),
  `plan-facts-sports.md` (declared variants per sport).
- W1a's merged harness and its `_INDEX.md` notes.

## Prerequisites

W1a merged (design §8 order, R1). Own worktree off `main` after that merge.

## Scope

- fast-check command model over the organiser actions (§7.5 item 1), run in L3
  over `HttpDriver`, seeds logged; anti-vacuity counts on every invariant (§7.3a).
- `forEachSport` test helper (R26) and the CI listing of unreasoned
  single-sport tests.
- Atomic case split of compound scenarios (R4, M7, M8, X1, X4, C3, F5, Q1, Q4 →
  `R4a`/`R4b`…).
- Applicability predicates over (format, sport, variant); committed drop list
  with a reason per drop; per-row applicable-case floors.
- Variant set with boundary classes (min, default, max, one interior); L2 pair
  file. Both committed (R11).
- `packages/reference/` skeleton, boundary gate in the style of
  `scripts/engine-boundary.ts`, `Dockerfile` manifest line.
- **Routed gaps: none** (harness wave). Formulas and real counts for §6.2.

## Lifecycle

No rulebook step (harness wave). The reference package ships **empty of
families** — families arrive wave by wave from signed rulebooks (§7.2). Use
§10 steps 4, 5 and 7.

## Decisions owed

Put to the owner as recommendations, each with its owner value:
- **O9** — entry path E: its own scenarios, or an axis multiplying M and C.
- **O10** — reference import mode: `import type` from engine core types, or a
  leaf types package if type-only proves insufficient.
The committed drop list is also reviewed like the pair file — show it.

## Done when

- The atomic catalogue, drop list, variant set and pair file are committed and
  reviewed; every applicability predicate mutated to `return false` produces a
  red; every row meets its floor (R13, R17).
- fast-check model runs on W1a's slice, reports non-zero counts, and a shrunk
  failure (if any) is committed as a named regression case with its seed (R29).
- Boundary gate wired in `ci.yml` and proven by a deliberate violation; the
  container job still builds; new package tests run in an explicit CI step.
- Real §6.2 counts written into `_INDEX.md`. No previously green check red.

## Traps

1. **An over-broad predicate reaches "zero ❌" by testing nothing** (§4). The
   floor and the `return false` mutation exist for that; a drop without a
   written reason is a defect in the file.
2. **The new package is invisible to the root chains**: `lint`, `typecheck`
   and `test` in the root `package.json` are explicit per-workspace lists, and
   tests are not run through turbo. The `Dockerfile` pre-install `COPY` must
   list the manifest before `pnpm install --frozen-lockfile` (`plan-facts-repo.md` §1, §5).
3. **The pack types import engine runtime values** (`pack-schema.ts:144-145`) —
   do not share them with the reference package (§7.2).
4. **Do not sort the sport registry** for `forEachSport`: registry order is
   wave order, not alphabetical (`AGENTS.md` class 18).
5. **A random draw at run time is not a pair file** (R11). Regeneration is a
   reviewed diff.

## Output and handoff

Update the W1b row and the decision log in `_INDEX.md` as things happen (R22):
real counts, the O9/O10 recommendations and — only once the owner answers — the
rulings, in their own section.
