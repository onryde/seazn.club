// The RealtimeKit call budget's NUMBERS, with no imports: budget.ts (the bucket, `server-only`) spends by them, and the load harness
// (e2e/load/load-stats.ts LOAD_LIMITS, a Playwright runner that cannot import a `server-only` module) judges a run by the same ones -
// read, never copied. Why these numbers: budget.ts's header.

/** The vendor's published limit: RealtimeKit REST calls per account per five minutes (the RealtimeKit "Limits" page, budget.ts). */
export const RTK_VENDOR_LIMIT_PER_WINDOW = 3_500;
export const RTK_BUDGET_WINDOW_MS = 5 * 60_000;
/** What this process lets through in ANY five-minute window: 75% of the vendor's limit (2,625). */
export const RTK_CALLS_PER_WINDOW = (RTK_VENDOR_LIMIT_PER_WINDOW * 3) / 4;
/** The bucket's capacity. B + r*W = RTK_CALLS_PER_WINDOW, so the burst is spent out of the same ceiling. */
export const RTK_BUDGET_BURST = 525;
/** Tokens per second: what is left of the ceiling after the burst, over the window. */
export const RTK_BUDGET_REFILL_PER_S = (RTK_CALLS_PER_WINDOW - RTK_BUDGET_BURST) / (RTK_BUDGET_WINDOW_MS / 1_000);
