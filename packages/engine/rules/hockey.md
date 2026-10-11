# Hockey

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| HK-WO-1 | Hockey walkover = 5-0 (default changes from 3). | FIH GTR Reg 13.1 | signed 86 2026-10-08 | `packages/engine/src/sports/hockey/hockey.ts`<br>`packages/engine/src/sports/period/kernel.ts` | `packages/engine/src/sport/forfeit-credit.test.ts`<br>`packages/reference/src/families/walkover-credit.test.ts` |
| HK-RT-1 | Hockey retirement or post-start forfeit = 5-0, or the real score if worse for the offender. | FDC 28.1 analogue (RBB RB2B-6) | signed 87 2026-10-08 | `packages/engine/src/sports/period/kernel.ts`<br>`packages/engine/src/sport/forfeit-credit.ts` | `packages/engine/src/core/w2b-repro.probe.test.ts`<br>`packages/engine/src/sport/forfeit-credit.test.ts`<br>`packages/reference/src/families/walkover-credit.test.ts` |
| HK-AB-1 | Same as FB-AB-1 for hockey. | product rule W2b-R6 | signed 88 2026-10-08 | `packages/engine/src/sports/period/kernel.ts`<br>`apps/web/src/server/engine-db/append-event.ts` | `apps/web/src/server/engine-db/__tests__/award-abandon-status.test.ts`<br>`packages/engine/src/sport/abandon-result.test.ts` |
