# Badminton

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| BD-WO-1 | Badminton walkover = 2-0 games, each 21-0. | product rule (BWF silent) W2b-R4 | signed 86 2026-10-08 | `packages/engine/src/sports/setbased/kernel.ts` | `apps/web/src/server/public-site/__tests__/qualification-view.test.ts`<br>`packages/engine/src/sport/forfeit-credit.test.ts`<br>`packages/reference/src/families/walkover-credit.test.ts` |
| BD-WO-2 | In a badminton group stage BD-WO-1 applies instead of BWF GCR 16.2.5's delete-all-results (until W5). | BWF GCR 16.2.5 | deviation 86 2026-10-08 | `packages/engine/src/sports/setbased/kernel.ts` | `packages/engine/src/sport/forfeit-credit.test.ts` |
| BD-RT-1 | Badminton retirement = points played stand, the current game completed for the winner to its legal end (21, or two clear up to the 30 cap), remaining games 21-0 (until W5's 16.2.5). | BWF GCR 16.2.5; legal game end worded at build per Task 15 review M-6 | deviation 87 2026-10-08 | `packages/engine/src/sports/setbased/kernel.ts` | `packages/engine/src/sport/forfeit-credit.test.ts`<br>`packages/reference/src/families/walkover-credit.test.ts` |
| BD-TB-1 | BWF 16.2. | W2d spec 2026-10-20 Appendix A (ruling 75); signed by ruling 197 (2026-10-24, W2d Task 0) | signed 197 2026-10-24 | `packages/engine/src/competition/tiebreakers.ts`<br>`packages/engine/src/sports/setbased/badminton.ts` | `packages/engine/src/competition/tie-what-if.test.ts`<br>`packages/engine/src/competition/tiebreak-keys-w2d.test.ts` |
