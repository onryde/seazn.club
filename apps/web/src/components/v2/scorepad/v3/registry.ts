// v3 skin-registry lane — R1 chassis (Task 2). Sits BESIDE the legacy
// registry (../registry.tsx's `resolveScorePad`/`RESOLUTION_KIND`), which
// keeps rendering every sport unchanged through R1. This file is the FIRST
// production code that ties the pad registry to the engine's own module
// list (`builtinModules`) — the legacy `RESOLUTION_KIND` table is
// hand-written and carries no such import, so a 12th engine sport shipping
// today would silently land on "universal" there with nobody having
// decided that was right (see ../registry.tsx's header). `resolvePad`
// below refuses that: an unowned key throws instead of guessing.
//
// R1 converts NO sport: `V3_SKINS` stays empty and `LEGACY_SPORTS` names
// every engine key, so every real call resolves "legacy" today. A later
// wave moves one sport at a time by adding it to `V3_SKINS` (and, in the
// same change, removing it from `LEGACY_SPORTS` — see the totality test,
// which fails a key present in both just as loudly as a key in neither).
import { builtinModules } from "@seazn/engine/sports";
import type { SkinDefV3 } from "./types";

/** Sport key -> v3 skin. Empty in R1; populated sport-by-sport from R2. */
export const V3_SKINS: Partial<Record<string, SkinDefV3>> = {};

/**
 * Every engine sport key, computed from `builtinModules` rather than
 * hand-copied — a new engine sport lands here automatically, so the
 * totality gate (`__tests__/registry-totality.test.ts`) stays meaningful
 * instead of silently passing against a stale hardcoded set. R1 converts
 * no sports, so this is EVERY key the engine ships, not a subset.
 */
export const LEGACY_SPORTS: ReadonlySet<string> = new Set(builtinModules.map((m) => m.key));

export type PadLaneResolution = { lane: "v3"; skin: SkinDefV3 } | { lane: "legacy" };

/**
 * Resolve a sport key to its rendering lane. Throws on a key owned by
 * neither lane — deliberately no silent universal fallback (contrast
 * ../registry.tsx's `resolveScorePad`, which defaults an unlisted key to
 * "universal" at runtime, by design, for a different reason: this lane
 * question is meant to be a written decision from day one, not eased in).
 */
export function resolvePad(key: string): PadLaneResolution {
  const skin = V3_SKINS[key];
  if (skin) return { lane: "v3", skin };
  if (LEGACY_SPORTS.has(key)) return { lane: "legacy" };
  throw new Error(`resolvePad: "${key}" has no pad lane (not in V3_SKINS or LEGACY_SPORTS)`);
}
