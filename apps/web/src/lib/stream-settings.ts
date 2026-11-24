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
import { OVERLAY_TEMPLATES, resolveTemplate, templatesForSportFrom, type TemplateId, type TemplateRegistry } from "@/components/overlay/template-registry";
// TYPES only: `@/server/**` is server code, and a runtime import from a client island breaks the build.
import type { StreamMode } from "@/server/api-v1/schemas";

/** V462's `fixture_stream_settings.overlay_delay_ms` check (0–30000). `PutStreamSettings` states the same bound as a
 *  literal (api-v1/schemas/ may not import `@/lib`); stream-settings.test.ts holds the two equal. */
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

/** The preferences as one READ of the settings row, with the row's `revision`: a counter every write bumps under the row
 *  lock (`fixture_stream_settings.revision`, V466), so a later write to one row always reads higher — or null when no row
 *  exists, older than any write. The page's read and each PUT answer carry it, so the panel can order a read against a
 *  save it has already seen settle (PR #989 confirm N1) — values alone cannot. */
export interface StreamPrefsRead extends StreamPrefs {
  revision: number | null;
}

/** A fixture with no settings row, as a read: the defaults, before any write. */
export const NO_STREAM_PREFS_READ: StreamPrefsRead = { ...DEFAULT_STREAM_PREFS, revision: null };

// ---------------------------------------------------------------------------------------------------------------------
// Task 38 (V558): the club's default Score style and Score timing. A match's own choice wins, then the club's, then the
// default — for the style the sport's own, for the timing the server's (config.ts `overlayDelayDefaultMs`).
//
// The ONE COURT RULE (owner, 2026-11-24): the club's STYLE applies to a court's streams like any other; the club's TIMING
// applies to MATCH streams only — a court keeps its own default (0 s) however the club set its timing, because the court's
// default exists for a reason the club's number does not know about (device check 3).
// ---------------------------------------------------------------------------------------------------------------------

/** The club's two defaults as stored (`org_stream_defaults`): each null is "the club sets none", and falls to the default. */
export interface ClubStreamPrefs {
  overlayTemplate: string | null;
  overlayDelayMs: number | null;
}

/** The club defaults as one READ, with the row's `revision` (a counter every write bumps; null: no row yet, older than any write). */
export interface ClubStreamPrefsRead extends ClubStreamPrefs {
  revision: number | null;
}

/** An org with no row: the club sets nothing. */
export const NO_CLUB_STREAM_PREFS_READ: ClubStreamPrefsRead = { overlayTemplate: null, overlayDelayMs: null, revision: null };

/** Whether `id` is a template the registry serves NOW (it exists and is not retired) — the club write's refusal rule. The club
 *  holds no sport, so the sport suitability is NOT asked here: a template a sport does not suit is simply not what that sport
 *  resolves to (`resolveTemplate` falls back to the sport's own default). Injectable for the same reason `isPickableTemplate` is. */
export function isKnownTemplate<Id extends string>(id: string, registry: TemplateRegistry<Id> = OVERLAY_TEMPLATES as unknown as TemplateRegistry<Id>): boolean {
  return Object.hasOwn(registry, id) && registry[id as Id].retired === undefined;
}

/** The style a session started now would serve: the match's own stored choice, else the club's, else the sport's default —
 *  resolved, so a retired or sport-unsuitable id reads as what every reader of the session's copy shows. Never throws. */
export function effectiveTemplateId(a: { match: string | null; club: string | null; sportKey: string }): TemplateId {
  return resolveTemplate(a.match ?? a.club, a.sportKey).id;
}

/** The delay a session started now would serve: the match's own, else the club's (a MATCH stream only), else the default —
 *  a court's `courtDefaultMs`, every other session's `matchDefaultMs`. `0` is a real value at every link. */
export function effectiveDelayMs(a: { match: number | null; club: number | null; court: boolean; matchDefaultMs: number; courtDefaultMs: number }): number {
  return a.match ?? (a.court ? null : a.club) ?? (a.court ? a.courtDefaultMs : a.matchDefaultMs);
}
