# Tennis

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| TN-WO-1 | Tennis walkover = straight sets for set %; the match's games excluded from game %. | ATP 4.01 C.4 | signed 86 2026-10-08 | `packages/engine/src/sports/nested/kernel.ts` | `packages/engine/src/competition/w2b-tables.test.ts`<br>`packages/engine/src/core/w2b-repro.probe.test.ts`<br>`packages/engine/src/sport/forfeit-credit.test.ts`<br>`packages/reference/src/families/walkover-credit.test.ts` |
| TN-RT-1 | Tennis retirement = same credit as TN-WO-1. | ATP 4.01 C.4 | signed 87 2026-10-08 | `packages/engine/src/sports/nested/kernel.ts` | `packages/engine/src/sport/forfeit-credit.test.ts`<br>`packages/reference/src/families/walkover-credit.test.ts` |
| TN-TB-1 | ATP 4.01 C.3: matches won, matches played, then set percentage and game percentage, each step leaving two players to their head-to-head, then the seed, then a drawing of lots (deviation: ATP stops at the ranking). | W2d spec 2026-10-20 Appendix A (ruling 75); signed by ruling 197 (2026-10-24, W2d Task 0) | deviation 197 2026-10-24 | `packages/engine/src/sports/tennis/tennis.ts` | `packages/engine/src/competition/tiebreak-keys-w2d.test.ts` |
| TN-TB-2 | on the table a won match tie-break counts as one set and one game to its winner, none to the loser (ATP 4.02, RB2A-11). | W2d spec 2026-10-20 Appendix A (ruling 75); signed by ruling 197 (2026-10-24, W2d Task 0) | signed 197 2026-10-24 | `packages/engine/src/sports/nested/kernel.ts` | `packages/engine/src/competition/tables-rulebook.test.ts` |
