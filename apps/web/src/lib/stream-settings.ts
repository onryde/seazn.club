// lib/stream-settings.ts — R2006 (owner ruling 2026-10-19, "Option C"): the fixture's stored stream preferences, as
// rules. Pure and import-light, so the organiser's panel (client) and the start paths (server) read ONE answer.
//
//  - The MODE: the score is the default. A stored `passthrough` is the organiser's "Camera only"; anything else streams
//    the score whenever this deployment can run a composed session, and the camera only when it cannot — the organiser
//    is never blocked (V466). Availability is the deployment's (drivers.ts `composedUnavailable()`), handed in by the
//    caller: this module never restates that rule.
//  - The TEMPLATE: a stored id is written only if the fixture's sport is offered it now (`isPickableTemplate`); a stored
//    id that is later retired still READS and resolves (template-registry.ts `resolveTemplate`).
//  - The DELAY: null is the server's default, 0 a real override; the bound is V462's column check.
import { OVERLAY_TEMPLATES, templatesForSportFrom, type TemplateRegistry } from "@/components/overlay/template-registry";
// TYPES only: `@/server/**` is server code, and a runtime import from a client island breaks the build.
import type { StreamMode } from "@/server/api-v1/schemas";

/** V462's `fixture_stream_settings.overlay_delay_ms` check (0–30000). `PutStreamSettings` states the same bound as a
 *  literal (schemas.ts may not import `@/lib`); stream-settings.test.ts holds the two equal. */
export const OVERLAY_DELAY_MAX_MS = 30_000;

/** The mode a start streams with. `stored` is `fixture_stream_settings.stream_mode` (null = never chosen);
 *  `composedAvailable` is the deployment's answer. Only an explicit "Camera only" turns the score off; an unavailable
 *  compositor streams the camera instead of refusing. */
export function effectiveStreamMode(stored: StreamMode | null, composedAvailable: boolean): StreamMode {
  if (stored === "passthrough") return "passthrough";
  return composedAvailable ? "composed" : "passthrough";
}

/** Whether `id` is a template this sport's picker offers NOW — the write's refusal rule (an unknown, retired or
 *  sport-unsuitable id is refused before anything is written). The registry is injectable because the shipped one has
 *  no retired or sport-restricted entry for a test to reach. */
export function isPickableTemplate<Id extends string>(
  id: string, sportKey: string, registry: TemplateRegistry<Id> = OVERLAY_TEMPLATES as unknown as TemplateRegistry<Id>,
): boolean {
  return templatesForSportFrom(registry, sportKey).some((def) => def.id === id);
}

/** The three stored preferences of one fixture, as stored (`StreamSettings` without the pick and the switch). Each null
 *  is "the default": the score when available, the sport's template, the server's delay. */
export interface StreamPrefs {
  streamMode: StreamMode | null;
  overlayTemplate: string | null;
  overlayDelayMs: number | null;
}

/** A fixture with no settings row: every preference at its default. */
export const DEFAULT_STREAM_PREFS: StreamPrefs = { streamMode: null, overlayTemplate: null, overlayDelayMs: null };

/** The preferences as one READ of the settings row, with the row's `revision`: microseconds since the epoch of its last
 *  write (`fixture_stream_settings.updated_at`, stamped `clock_timestamp()` after the row lock, so later writes to one
 *  row always read higher), or null when no row exists. The page's read and each PUT answer carry it, so the panel can
 *  order a read against a save it has already seen settle (PR #989 confirm N1) — values alone cannot. */
export interface StreamPrefsRead extends StreamPrefs {
  revision: number | null;
}

/** A fixture with no settings row, as a read: the defaults, before any write. */
export const NO_STREAM_PREFS_READ: StreamPrefsRead = { ...DEFAULT_STREAM_PREFS, revision: null };
