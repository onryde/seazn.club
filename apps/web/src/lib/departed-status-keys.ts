// The departed vocabulary as a tuple - the closed set of entrant statuses that mean "left the field" (W5 T20, ST-G20).
//
// A LEAF with no imports, on purpose: wire schemas (`server/public-site/competition-hub-schema.ts`, `server/api-v1/schemas/stages.ts`)
// build a `z.enum` from this list and are loaded by the standalone OpenAPI generator under bare `node --experimental-strip-types`
// and type-checked by the scripts tsconfig (`nodenext`), which resolve no `@/` alias. `departed-status-chips.ts` carries the chips'
// i18n keys (`@/lib/i18n-runtime`) and so cannot be imported by a schema; it imports this one instead, so the two never disagree.
export const DEPARTED_STATUS_KEYS = ["withdrawn", "disqualified"] as const;
