# Cross-sport rules

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| X-BR-1 | In a bracket kind, a fixture is decided only by a win (from play, a decider, a forfeit or settle); `draw`, `tie` and `no_result` are never a decided result. | product rule, ruling 72 | signed 72 2026-10-08 | `apps/web/src/server/engine-db/append-event.ts`<br>`apps/web/src/server/usecases/scoring.ts` | — |
| X-BR-2 | A play-produced level result in a bracket kind is held as `needs_decision`: not decided, nobody seated. | product rule, ruling 79 | signed 79 2026-10-08 | `apps/web/src/server/engine-db/append-event.ts` | — |
| X-ST-1 | `core.settle` applies only to a level outcome, an abandon with no outcome, or a chess bracket game awaiting its tie-break (lots is the organiser's settle); it never names a withdrawn entrant; it records the winner and the method (lot, higher seed, organiser), invents no score, and seats winner and loser. | product rule, ruling 72; preflight rulings C12, C17 (controller, 2026-10-08) | signed 72 2026-10-08 | `packages/engine/src/core/events.ts`<br>`apps/web/src/server/engine-db/append-event.ts` | — |
| X-ST-2 | `core.settle`, `core.forfeit` and `core.abandon` are organiser-only on the server. | product rule, ruling 77 | signed 77 2026-10-08 | `apps/web/src/server/usecases/scoring.ts` | — |
| X-DR-1 | Draws are allowed only in league, group, swiss and americano, and only where the sport allows them. | product rule, rulings 72 and 78 | signed 78 2026-10-08 | `packages/engine/src/core/types.ts` | `packages/engine/src/sport/supports-draws.test.ts`<br>`packages/engine/src/core/stage-kind-sets.test.ts` |
