// Shared by the Stryker tests that spawn a process (stryker-groups, stryker-floor, stryker-matrix). AGENTS.md class 20: a flat
// timeout beside a derived cost is a latent red, so a spawning test states its budget from the SAME constant as the spawn's cap
// and a hung child is reported as ITS failure (status null, signal SIGTERM), not as vitest's generic timeout.

/** One spawned process's own cap. */
export const SPAWN_MS = 30_000;
/** Time a test spends outside its spawns: scratch trees, git setup, reading reports. */
const SLACK_MS = 5_000;

/** The budget for a test that spawns `spawns` processes, one after another. */
export function spawnBudget(spawns: number): number {
  if (!Number.isInteger(spawns) || spawns < 1) throw new Error(`spawnBudget: ${spawns} is not a spawn count of at least 1`);
  return spawns * SPAWN_MS + SLACK_MS;
}
