// X-ST-2 (ruling 77, widened by owner ruling D-O1 2026-10-08): only an organiser (owner/admin, or an org API key —
// not a device link, not an official scorer) may settle, forfeit or abandon a match, or record a forfeit or walkover
// through a sport's own result event. ONE module: the server's refusal (usecases/scoring.ts) and the pad's tile
// filter (scorepad/v3/pad-host.tsx) both read it, so the two cannot drift. No `server-only`: the pad imports it, and
// a client component importing server code breaks the build.

/** The three core types, organiser-only whatever their payload. */
export const ORGANISER_ONLY_EVENT_TYPES = ["core.settle", "core.forfeit", "core.abandon"] as const;
export const ORGANISER_ONLY: ReadonlySet<string> = new Set(ORGANISER_ONLY_EVENT_TYPES);

/** D-O1: sport events that record a forfeit or walkover through one payload field. Restated here because the pad
 *  cannot import the engine's fold; pinned EQUAL to the list derived from the engine's own declarations (every
 *  module's `eventSchemas` enum value whose application decides the match as a forfeit) in
 *  `server/usecases/__tests__/organiser-only-events.test.ts`, so a sport that gains such a value reds that test. */
export const ORGANISER_ONLY_SPORT_EVENTS: Readonly<Record<string, { readonly field: string; readonly values: readonly string[] }>> = {
  "boardgame.result": { field: "method", values: ["forfeit", "double_forfeit"] },
};

/** THE predicate: is this (type, payload) organiser-only? A core type always; a sport event when its declared field
 *  carries one of its forfeit values. Anything unrecognised is NOT organiser-only (the engine validates payloads). */
export function isOrganiserOnlyEvent(type: string, payload: unknown): boolean {
  if (ORGANISER_ONLY.has(type)) return true;
  if (!Object.hasOwn(ORGANISER_ONLY_SPORT_EVENTS, type)) return false;
  const arm = ORGANISER_ONLY_SPORT_EVENTS[type]!;
  if (typeof payload !== "object" || payload === null) return false;
  const value = (payload as Record<string, unknown>)[arm.field];
  return typeof value === "string" && arm.values.includes(value);
}
