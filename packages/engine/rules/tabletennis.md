# Table tennis

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| TT-WO-1 | Table tennis walkover = the games needed to win, each 11-0. | ITTF Handbook 2.3.7 | signed 86 2026-10-08 | `packages/engine/src/sports/setbased/kernel.ts` | `packages/engine/src/sport/forfeit-credit.test.ts`<br>`packages/reference/src/families/walkover-credit.test.ts` |
| TT-RT-1 | Table tennis retirement = points played stand, current game completed for the winner, remaining games 11-0. | ITTF Handbook 2.3.7 | signed 87 2026-10-08 | `packages/engine/src/sports/setbased/kernel.ts` | `packages/engine/src/sport/forfeit-credit.test.ts`<br>`packages/reference/src/families/walkover-credit.test.ts` |
| TT-PT-1 | 2/1/0, unplayed loss 0. | W2d spec 2026-10-20 Appendix A (ruling 75); signed by ruling 197 (2026-10-24, W2d Task 0) | signed 197 2026-10-24 | `packages/engine/src/competition/points.ts`<br>`packages/engine/src/sports/setbased/tabletennis.ts` | `packages/engine/src/competition/table-points-parity.test.ts` |
| TT-TB-1 | a mini-league among the tied with exclusion, then lots. | W2d spec 2026-10-20 Appendix A (ruling 75); signed by ruling 197 (2026-10-24, W2d Task 0) | signed 197 2026-10-24 | `packages/engine/src/competition/tiebreakers.ts`<br>`packages/engine/src/sports/setbased/tabletennis.ts` | `packages/engine/src/competition/tiebreak-keys-w2d.test.ts` |
