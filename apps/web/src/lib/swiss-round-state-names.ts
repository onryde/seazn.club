// The closed set of states a Swiss table's "Round X of N" chip can be in (W3 T16, SW-L11).
//
// A LEAF with no imports, on purpose: `server/public-site/competition-hub-schema.ts` builds its `z.enum` from this list and
// is loaded by the standalone OpenAPI generator under bare `node --experimental-strip-types` (and type-checked by the
// scripts tsconfig, `nodenext`), which resolves no `@/` alias and no extensionless relative import. `swiss-round-state.ts`
// reaches `swiss-shell.ts` (and its `@/` imports), so the schema must not import that module; it imports this one.
export const SWISS_ROUND_STATES = ["paired", "in_play", "complete", "final"] as const;
export type SwissRoundStateName = (typeof SWISS_ROUND_STATES)[number];
