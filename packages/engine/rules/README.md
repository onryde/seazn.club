# Rules reference

The engine's rules, one row per rule (owner ruling 75, 2026-10-08). This directory moves with the engine.

A rule row is a line of the table whose header is exactly:

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|

- **id**: stable, `<SPORT>-<AREA>-<n>`. X = cross-sport. Never reused, never renumbered.
- **rule**: one sentence a scorer or organiser could check.
- **citation**: a federation article, or "product rule" with the ruling that made it.
- **status**: `signed <ruling> <date>`, `deviation <ruling> <date>` or `⬜ open`.
- **enforced at**: backticked repo paths, separated by `<br>`, or `—`.
- **proved by**: backticked repo-relative test paths, separated by `<br>`, or `—` while open. A signed or deviation
  row needs at least one, and EVERY path listed must be a test file (`*.test.ts`, `*.test.tsx` or `*.spec.ts`) outside
  `packages/engine/rules/`, `docs/` and the checker itself, with the id as a whole token in the title of an `it(`,
  `test(` or `describe(` call (`X-ST-1` is not proved by a title that only says `X-ST-10`, by a comment, or by a string
  in a test body). A conditional skip still counts, because CI's DB jobs run it: `it.skipIf(!HAS_DB)("X-ST-1 …")`,
  `it.runIf(…)`, and `test.describe.serial|parallel("X-ST-1 …")`. An unconditional skip does not, and nothing inside it
  does either: `describe.skip`, `it.skip`, `.todo` and `.fixme`. `matrix:<caseId>` entries may be added as extra
  evidence; they are never sufficient alone.

`packages/engine/test/rules-reference.test.ts` checks every row, and runs on every pull request in the `gates` job of
`.github/workflows/ci.yml` (a rule proved in `apps/web`, e2e or `tools` is checked even when no engine file changed). A
row-shaped line the parser does not read is a failure. The wave rulebooks under
`docs/superpowers/specs/2026-09-27-format-matrix-prompts/rulebook-W2-*.md` are frozen research drafts: this
directory is the authority from W2a on.
