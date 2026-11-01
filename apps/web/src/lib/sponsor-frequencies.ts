// The sponsor rotation's dial (R4 sponsors on stream; spec 2026-10-27 §3.2): THE list of its positions, in display order.
// Dependency-free on purpose - `server/api-v1/schemas.ts` builds its zod enum from it and runs under the standalone OpenAPI
// generator (bare `node --experimental-strip-types`, no `@/` alias), so nothing here may import anything.
// V483's `sponsor_stream_settings_frequency_check` must name the same three: server/sponsors/__tests__/migration.test.ts reads
// it back and compares. The planner (lib/sponsor-plan.ts) re-exports the list and type; the PUT route's enum, the settings
// writer's check and the On stream tab's dial all read it.
export const SPONSOR_FREQUENCIES = ["light", "normal", "busy"] as const;
export type SponsorFrequency = (typeof SPONSOR_FREQUENCIES)[number];
