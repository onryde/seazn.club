// Run one read per id at once, then answer the way a serial loop over the same ids would have (registration redesign B1 T4; moved
// out of usecases/registration-submit.ts verbatim, B1 fix round 1 MOD-1). No imports and nothing registration-specific in here.

/**
 * Registration redesign B1 T4: reads that used to run one division at a time now run together. `settleEach` runs `read` for every
 * id at once (`allSettled`, so a later read's failure is never left unhandled) and pairs each outcome with its id, in the order
 * given. The caller then walks the pairs in that order, so what a refused cart is told is what the serial loop told it: the
 * failure of the earliest id, never whichever read happened to fail first.
 */
export async function settleEach<T>(ids: readonly string[], read: (id: string) => Promise<T>): Promise<[string, PromiseSettledResult<T>][]> {
  const settled = await Promise.allSettled(ids.map(read));
  return ids.map((id, i) => [id, settled[i]!]);
}

/** The values by id, or the first failure in the pairs' order (see `settleEach`). */
export function valuesInOrder<T>(pairs: readonly [string, PromiseSettledResult<T>][]): Map<string, T> {
  const out = new Map<string, T>();
  for (const [id, r] of pairs) {
    if (r.status === "rejected") throw r.reason;
    out.set(id, r.value);
  }
  return out;
}
