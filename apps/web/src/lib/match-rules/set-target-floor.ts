// The fewest points a set may be played to in a sport whose write door refuses a lower target (W2e ruling 31: volleyball and
// table tennis, 5). Client-safe: bare engine barrels only, no "use client", no JSX, no `@/components` or `@/server` import.
//
// The engine declares the floor on the preset (`SetBasedPreset.minSetTo`) but exposes only what it DOES with it: the module's
// `configWriteIssues` answers `setTargetBelowFloor(min)` for a `setTo` or `finalSetTo` below it. The editor's number inputs take
// their `min` from that answer, so it is read off the module rather than typed a second time next to the engine's own 5.
import { builtinModules } from "@seazn/engine/sports";

/** Where the search stops. The fields declare `max: 100`, and no sport's floor comes near it. */
const PROBE_CEILING = 100;

/**
 * The smallest set target (both `setTo` and `finalSetTo`) the sport's write door accepts, found by asking it; 1 for a sport
 * whose door refuses no target. Asked of the schema's own defaults, so only the target decides the answer.
 */
export function setTargetFloorOf(sportKey: string): number {
  const sportModule = builtinModules.find((m) => m.key === sportKey);
  if (sportModule === undefined || sportModule.configWriteIssues === undefined) return 1;
  const defaults = sportModule.configSchema.parse({}) as Record<string, unknown>;
  for (let n = 1; n <= PROBE_CEILING; n++) {
    if (sportModule.configWriteIssues({ ...defaults, setTo: n, finalSetTo: n } as never).length === 0) return n;
  }
  return 1;
}
