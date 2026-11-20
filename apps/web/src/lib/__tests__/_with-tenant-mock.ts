// Test-only stand-in for `withTenant` in the page suites that stub `@/lib/db` (MD-R29). Not a test file (no `.test.` in the name), so
// vitest never collects it; the caller owns the `vi.mock("@/lib/db")`, because `vi.mock` is per file.
//
// The real `withTenant` (lib/db.ts) runs `opts.privilegedPrelude(tx)` FIRST, on the transaction's own connection, then the callback. A stub
// that hands the callback its transaction and drops `opts` answers every caller that has no prelude, and breaks every caller that has one:
// `withRoundOpensToday` (usecases/match-day.ts) reads the SEALED round opens in a prelude and throws, fail-closed, when it never ran - which
// is what 76 tests in the division page's suite hit the day `competitionFixturesToday` started to read them. Use this instead of
// `fn(tx)`; lib/__tests__/with-tenant-mock-sweep.test.ts fails on the dropping shape wherever it is written again.
//
//   const tx = () => Promise.resolve([]);
//   vi.mock("@/lib/db", () => ({
//     sql: () => Promise.resolve([]),
//     withTenant: (_orgId: string, fn: (t: unknown) => unknown, opts?: TenantOpts) => tenantRunningPrelude(tx, fn, opts),
//     statementCount: () => 0,
//   }));
//
// (`tx` is read when `withTenant` is CALLED, never when the factory runs: `vi.mock` is hoisted above the `const`.)
export type TenantOpts = { privilegedPrelude?: (tx: unknown) => Promise<void> };

/** `withTenant`'s order, over a stand-in transaction: the prelude (when given) is awaited with `tx`, then `fn(tx)` runs and is awaited.
 *  A prelude that rejects rejects the call and `fn` never runs, as it does in the real one (the whole transaction rolls back). */
export async function tenantRunningPrelude<T>(tx: unknown, fn: (t: unknown) => T | Promise<T>, opts?: TenantOpts): Promise<T> {
  if (opts?.privilegedPrelude !== undefined) await opts.privilegedPrelude(tx);
  return fn(tx);
}
