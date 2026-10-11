# Ice hockey

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| IH-WO-1 | Ice hockey walkover = 5-0. | product rule (IIHF Rule 66 names no score) W2b-R4 | signed 86 2026-10-08 | `packages/engine/src/sports/icehockey/icehockey.ts`<br>`packages/engine/src/sports/period/kernel.ts` | `packages/engine/src/sport/forfeit-credit.test.ts`<br>`packages/reference/src/families/walkover-credit.test.ts` |
| IH-RT-1 | Ice hockey retirement or post-start forfeit = 5-0, or the real score if worse for the offender. | FDC 28.1 analogue | signed 87 2026-10-08 | `packages/engine/src/sports/period/kernel.ts`<br>`packages/engine/src/sport/forfeit-credit.ts` | `packages/engine/src/core/w2b-repro.probe.test.ts`<br>`packages/engine/src/sport/forfeit-credit.test.ts`<br>`packages/reference/src/families/walkover-credit.test.ts` |
| IH-AB-1 | Same as FB-AB-1 for ice hockey. | product rule W2b-R6 | signed 88 2026-10-08 | `packages/engine/src/sports/period/kernel.ts`<br>`apps/web/src/server/engine-db/append-event.ts` | `packages/engine/src/sport/abandon-result.test.ts`<br>`tools/matrix/__tests__/w2b-scenarios.test.ts` |
