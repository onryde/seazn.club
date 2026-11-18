// W5 app PR A, Task 24 (T5-b): F4 - unequal pools (RB5-U1..U8: a field that does not divide by the pool count, the cross-pool best-Nth at k = size - min,
// the pool floor in the fold). PLANNED AND NOT RUN here: the fold that makes a short pool's table honest ships in app PR B with the engine major (pool
// membership as seating, `TableStage.pools`, `PoolTable.expunged`; progress.md, Task 21 ruling), so a script written now would read the 9.x table it
// replaces. The cell is planned (w5a-cells.ts W5A_F4 on the pooled rows) and renders deferred to the wave that owns it, never green.
import { ScenarioUnsupported, type Scenario } from "./types.ts";

const WHY = "F4 unequal pools: the pool fold at k = size - min ships in app PR B with the engine major";

export const f4UnequalPools: Scenario = {
  key: "W5A_F4",
  entrantCount: 8,
  canaryCheck: null,
  // not async: nothing is awaited; the refusal is a rejected promise, the shape a deferral takes in the runner
  run() {
    return Promise.reject(new ScenarioUnsupported("W5", WHY));
  },
};

export const w5aF4Scenarios: Readonly<Partial<Record<"W5A_F4", Scenario>>> = Object.freeze({ W5A_F4: f4UnequalPools });
