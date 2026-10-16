// The time budget of a golden test that sweeps the sport registry, stated from the work it does (AGENTS.md class 20: a flat
// timeout beside a derived cost is a latent red). A sweep costs "sports x what one sport costs", so the budget is the same
// product: a twelfth sport moves it, instead of a literal that was right for eleven.
//
// The per-sport figures are the slowest durations measured for each kind of sweep, taken with the machine at a load average of
// about 40 (the box these suites share), with room above them. They are declared once, here, so a kind that gets slower is
// one number to move.
import { builtinModules } from "../sports/index.ts";

/** What one sport costs a sweep, by kind of work. */
export const SWEEP_MS_PER_SPORT = {
  /** Read and replay committed corpora: fold or compare streams, no probe. Measured: up to 0.6 s per sport. */
  read: 3_000,
  /** Ablation probes or recordings over a corpus: fold each stream several times. Measured: up to 1.1 s per sport. */
  probe: 4_000,
  /** Build the floor streams from scratch (the scenario search) and compare byte for byte. Measured: up to 2.4 s per sport. */
  build: 9_000,
} as const;

/** Time a sweep spends outside its per-sport work: reading the corpora, the first fold's warm-up. */
export const SWEEP_SLACK_MS = 5_000;

/** The budget of a test that does `kind` of work for `sports` sports (default: the whole registry). */
export function sweepBudget(kind: keyof typeof SWEEP_MS_PER_SPORT, sports: number = builtinModules.length): number {
  if (!Number.isInteger(sports) || sports < 1) throw new Error(`sweepBudget: ${sports} is not a sport count of at least 1`);
  return SWEEP_SLACK_MS + sports * SWEEP_MS_PER_SPORT[kind];
}
