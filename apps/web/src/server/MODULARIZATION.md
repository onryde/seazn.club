# Modularizing `src/server`

Rules for splitting a large file into a folder. A split changes where code
lives, never what it does.

## When

- Over **1500 lines**: split when you next touch it for a feature.
- Over **3000 lines**: split before adding anything to it.
- Never split a generated file (`lib/i18n-keys.ts`) — fix the generator.
- Never split a file another open branch is editing. Check first:
  `git diff main...<branch> --stat -- <file>`. Overlap means sequence after
  that branch merges, or stack on it.

## Shape

`usecases/foo.ts` becomes:

```
usecases/foo/
  index.ts      barrel: re-exports the exact public names foo.ts exported
  types.ts      types/interfaces/consts shared by the siblings
  queries.ts    read paths
  commands.ts   write paths
  helpers.ts    private pure helpers used by 2+ siblings
```

- Group by **concern** (a domain noun or read/write), not by size. No
  `part1.ts`, `misc.ts`, `utils.ts`.
- Names above are a default. Prefer domain names when the file has clear
  sub-domains (`stages/knockout.ts`, `stages/swiss.ts`).
- Importers keep `from "@/server/usecases/foo"`. Resolution lands on
  `foo/index.ts`. **No importer edits in a split commit.**
- `schemas.ts`-style files: one file per resource group, barrel re-exports
  every schema and inferred type.

## Rules

1. **Verbatim moves.** No renames, signature changes, reordering of logic or
   "while I'm here" fixes. Behaviour changes go in their own commit.
2. **Public surface identical.** Capture the export list before and after
   (`tsc` declaration emit or a grep of `export`) and diff it. Empty diff or
   the split is wrong.
3. **No cycles.** Siblings import from `types.ts`/`helpers.ts` or one
   direction only. Never import from `./index`.
4. **Mocks follow the module path.** `vi.mock("@/server/usecases/foo")`
   still hits the barrel; a test that mocks an internal sibling must be
   updated to the sibling path.
5. **Split the test file to mirror the source** (`__tests__/foo/queries.test.ts`)
   so each pair stays reviewable. Do not weaken or delete assertions.
6. **One file per commit**, split commit separate from any follow-up.
7. **Type-only imports stay type-only** (`import type`). Client components
   must not start importing server modules through a new barrel.

## Verify (scoped only — never the full suite)

```
cd apps/web && npx tsc --noEmit
cd apps/web && npx vitest run <the foo test paths> --reporter=json --outputFile=<f>
```

Read `numPassedTests`/`numTotalTests` from the JSON and confirm
`.testResults[].name` resolve inside this worktree. Mutation-check once:
delete one re-export from the barrel and confirm `tsc` goes red.
