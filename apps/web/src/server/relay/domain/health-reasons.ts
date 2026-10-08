// Capture QR v2 PR-2 (spec §7.4, W9). The amber reasons' ONE declaration, in W9's priority order. It imports NOTHING, on purpose:
// api-v1/schemas.ts takes `z.enum(HEALTH_REASONS)` from here, and that file is also loaded by the standalone OpenAPI generator
// (node --experimental-strip-types, no module resolver), which cannot follow phone-health.ts's `../config` import.
// domain-purity.test.ts pins that every domain file schemas.ts imports has no imports of its own.

/** §7.4's amber reasons in PRIORITY order: not responding, stalled, hot, battery low. W8: silence only warns. */
export const HEALTH_REASONS = ["not_responding", "stalled", "hot", "battery_low"] as const;
export type HealthReason = (typeof HEALTH_REASONS)[number];
