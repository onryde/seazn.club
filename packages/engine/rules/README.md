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
- **proved by**: backticked repo-relative test paths whose text contains the id, or `matrix:<caseId>`, or `—` while open.

`packages/engine/test/rules-reference.test.ts` checks every row. The wave rulebooks under
`docs/superpowers/specs/2026-09-27-format-matrix-prompts/rulebook-W2-*.md` are frozen research drafts: this
directory is the authority from W2a on.
