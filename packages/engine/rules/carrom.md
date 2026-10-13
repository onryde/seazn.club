# Carrom

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| CA-KO-1 | A bracket match always plays the ICF extra board, whatever the division's `tieBoard`. | ICF Laws, Law 56; ruling 74 | signed 74 2026-10-08 | `packages/engine/src/sports/carrom/carrom.ts` | `packages/engine/src/sport/bracket-deciders.test.ts`<br>`packages/engine/src/sports/carrom/carrom.test.ts` |
| CA-WO-1 | Carrom walkover = games needed to win, each 25-0. | product rule (ICF silent) W2b-R4 | signed 86 2026-10-08 | `packages/engine/src/sports/carrom/carrom.ts` | `packages/engine/src/sport/forfeit-credit.test.ts`<br>`packages/reference/src/families/walkover-credit.test.ts` |
| CA-RT-1 | Carrom retirement = completed games stand, the unfinished game 25–(opponent's score), remaining games 25-0. | product rule W2b-R5 | signed 87 2026-10-08 | `packages/engine/src/sports/carrom/carrom.ts` | `packages/engine/src/sport/forfeit-credit.test.ts`<br>`packages/engine/src/sports/carrom/carrom.test.ts`<br>`packages/reference/src/families/walkover-credit.test.ts` |
| CA-AB-1 | Carrom abandon = replay by default (no shared points; opt-in sharing is W2c). | product rule RB2B-25 / W2b-R6 | signed 88 2026-10-08 | `packages/engine/src/sports/carrom/carrom.ts` | `packages/engine/src/core/w2b-repro.probe.test.ts`<br>`packages/engine/src/sport/abandon-result.test.ts`<br>`packages/engine/src/sports/carrom/carrom.test.ts` |
| CA-AB-2 | An abandoned carrom league match is replayed or the points are shared, as the stage says. | product rule, W2c spec 2026-10-13 item 12 (RB2B-25, ruling 71; owner Q10); signed 2026-10-13 (Task 0, P-6) | signed 71 2026-10-13 | `packages/engine/src/sports/carrom/carrom.ts` | — |
