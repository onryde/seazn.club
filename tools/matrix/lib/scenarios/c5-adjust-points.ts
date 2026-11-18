// W5 app PR A, Task 24 (T5-b): C5 - the organiser adjusts a table's points (a deduction or a bonus the rules do not compute). PLANNED AND NOT RUN here:
// the adjustment is app PR B's (W5 plan, Out of scope: it rides the engine major's `PoolTable` / points override), so a script now would drive a door
// that does not exist. The cell is planned (w5a-cells.ts W5A_C5 on the table rows) and renders deferred to the wave that owns it, never green.
import { ScenarioUnsupported, type Scenario } from "./types.ts";

const WHY = "C5 adjust points: the adjustment ships in app PR B with the engine major";

export const c5AdjustPoints: Scenario = {
  key: "W5A_C5",
  entrantCount: 8,
  canaryCheck: null,
  async run() {
    throw new ScenarioUnsupported("W5", WHY);
  },
};

export const w5aC5Scenarios: Readonly<Partial<Record<"W5A_C5", Scenario>>> = Object.freeze({ W5A_C5: c5AdjustPoints });
