// lib/canonical-json.ts — key-sorted JSON (Task 14 re-review 3 N2). Object keys are sorted at every depth and arrays
// keep their order, so two equal values serialise equal whatever order their fields were built in. Both checkout
// idempotency keys hash it (lib/relay-checkout.ts `relayCheckoutIdempotencyKey`, lib/credit-packs.ts), and one rule
// for both is the point: two private copies were free to drift apart. Pure and dependency-free.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, (val as Record<string, unknown>)[k]]))
      : val,
  );
}
