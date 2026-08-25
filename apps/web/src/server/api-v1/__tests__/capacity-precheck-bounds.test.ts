// The capacity-precheck size bounds exist in THREE places and cannot be a
// single import in all three:
//
//   1. `CAPACITY_PRECHECK_MAX_COURTS`/`_FIXTURES` (lib/capacity-bounds.ts) —
//      the definition. The client hooks (use-capacity-report.ts) import it to
//      refuse sending a body they can prove will be rejected.
//   2. `CapacityPrecheckInput` (usecases/capacity-guard.ts) — what the route
//      actually parses with. Imports the constants.
//   3. `CapacityPrecheck` (api-v1/schemas.ts) — the wire twin the generated
//      OpenAPI spec publishes. CANNOT import them: that file is consumed by
//      `scripts/openapi-gen.ts` under plain `node --experimental-strip-types`,
//      which does not resolve the `@/` alias, so the import turns
//      `npm run openapi:gen` into `ERR_MODULE_NOT_FOUND` — and the drift
//      check that follows still reports "no drift", because a generator that
//      never ran rewrites nothing. Its bounds stay literals.
//
// So the third copy is held to the other two HERE, and behaviourally: each
// schema is handed a payload sized exactly at the bound and one exactly over
// it, and must accept the first and reject the second. Asserting on the
// literals by reading the source, or on `._def` internals, would pass just as
// happily against a schema that had stopped enforcing anything at all.
import { describe, expect, it } from "vitest";
import { CapacityPrecheck } from "../schemas";
import { CapacityPrecheckInput } from "@/server/usecases/capacity-guard";
import {
  CAPACITY_PRECHECK_MAX_COURTS,
  CAPACITY_PRECHECK_MAX_FIXTURES,
} from "@/lib/capacity-bounds";

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const body = (courts: number, fixtures: number) => ({
  fixtures: Array.from({ length: fixtures }, (_, i) => ({ id: uuid(i + 100_000) })),
  config: {
    courts: Array.from({ length: courts }, (_, i) => uuid(i)),
    matchMinutes: 30,
    gapMinutes: 0,
    perEntrantMinRest: 0,
  },
});

// Both schemas, driven through the same table — the whole point is that they
// answer identically, so testing them separately would let a divergence read
// as two independently-passing suites.
const schemas = [
  ["CapacityPrecheck (wire twin, api-v1/schemas.ts)", CapacityPrecheck],
  ["CapacityPrecheckInput (route parser, capacity-guard.ts)", CapacityPrecheckInput],
] as const;

describe("capacity-precheck bounds are the same in every copy", () => {
  for (const [name, schema] of schemas) {
    it(`${name} accepts exactly ${CAPACITY_PRECHECK_MAX_COURTS} courts and rejects one more`, () => {
      expect(schema.safeParse(body(CAPACITY_PRECHECK_MAX_COURTS, 1)).success).toBe(true);
      expect(schema.safeParse(body(CAPACITY_PRECHECK_MAX_COURTS + 1, 1)).success).toBe(false);
    });

    it(`${name} accepts exactly ${CAPACITY_PRECHECK_MAX_FIXTURES} fixtures and rejects one more`, () => {
      expect(schema.safeParse(body(1, CAPACITY_PRECHECK_MAX_FIXTURES)).success).toBe(true);
      expect(schema.safeParse(body(1, CAPACITY_PRECHECK_MAX_FIXTURES + 1)).success).toBe(false);
    });
  }
});
