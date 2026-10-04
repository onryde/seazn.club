// One spawned CLI's cap, and the test budget derived from it (final batch
// FB-6). AGENTS.md class 20: a flat test timeout beside a derived cost is a
// latent red. CI runs these suites with --testTimeout=30000, below the caps
// some spawns carried (60 s, 120 s), so under load vitest's generic timeout
// fired first and hid the child's own failure. A spawning test now states
// its budget from the same constant as the spawn's cap: `spawnBudget(n)`
// covers n sequential spawns at their cap plus slack, so a hung child is
// reported as ITS failure (status null, signal SIGTERM). A file whose tests
// spawn a varying number of CLIs counts them through a SpawnMeter, which
// refuses by name the spawn past the budget it was declared with.

/** A CLI spawn's own cap. Every covered spawn measures under 3 s idle. */
export const SPAWN_MS = 25_000;
/** Time a test spends outside its spawns: setup, git, reading reports. */
export const SLACK_MS = 5_000;

export class SpawnBudgetExceeded extends Error {
  constructor(max: number) {
    super(`test: more than ${max} CLI spawn(s) in one test — its budget covers ${max}; raise the meter's max, which raises the budget with it`);
    this.name = "SpawnBudgetExceeded";
  }
}

/** The budget for a test that spawns `spawns` CLIs, one after another. */
export function spawnBudget(spawns: number, capMs: number = SPAWN_MS): number {
  if (!Number.isInteger(spawns) || spawns < 1) throw new Error(`spawnBudget: ${spawns} is not a spawn count ≥ 1`);
  if (!Number.isInteger(capMs) || capMs < 1) throw new Error(`spawnBudget: ${capMs} is not a cap in ms`);
  return spawns * capMs + SLACK_MS;
}

/** Counts one test's spawns against the budget it was declared with. */
export class SpawnMeter {
  readonly max: number;
  readonly budget: number;
  #spawned = 0;
  constructor(max: number, capMs: number = SPAWN_MS) {
    this.budget = spawnBudget(max, capMs);
    this.max = max;
  }
  /** Call before each test (beforeEach). */
  reset(): void {
    this.#spawned = 0;
  }
  /** Call before each spawn. */
  tick(): void {
    this.#spawned++;
    if (this.#spawned > this.max) throw new SpawnBudgetExceeded(this.max);
  }
}
