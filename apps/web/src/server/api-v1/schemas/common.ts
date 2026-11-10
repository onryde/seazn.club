// /api/v1 contracts — ids (Uuid, CourtId, VenueId, Slug), status and kind enums, ApiKeyScope, RequiredCourtTags: the leaf every module may import.
// One module of the schemas/ folder; ./index.ts is the map and the public surface. Pure zod (loads bare under
// `node --experimental-strip-types`): relative imports carry an explicit `.ts`, types come in through `import type`.
// /api/v1 request/response contracts (doc 08 §3–§5). Single source of truth:
// route handlers parse requests with these, and openapi.ts derives the served
// spec from them — code and contract cannot drift.
//
// NOT server-only: pure Zod, shared with the OpenAPI generator script.
import { z } from "zod";

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

export const Uuid = z.uuid();
/** A real `courts.id` (V374 cutover) — structurally identical to Uuid;
 *  named separately so a stored `ScheduleConfig.courts` entry documents what
 *  it actually references (never a free-text court name post-migration). */
export const CourtId = Uuid;

/** One tag vocabulary, every scope it is required at: a court's own `tags`
 *  (`CreateCourt`), and every `required_court_tags` list matched against them —
 *  division (`PatchDivision`), stage and round role (`StageRoundCourtTags`,
 *  #622). ONE bounds declaration rather than a fourth hand-copy of
 *  `z.array(z.string().min(1).max(40)).max(50)` that can drift from the rest
 *  the next time the cap changes. */
export const RequiredCourtTags = z.array(z.string().min(1).max(40)).max(50);
/** A real `venues.id` (V374 cutover — `fixtures.venue_id`, backfilled from
 *  the legacy free-text `fixtures.venue`). P9 pass 3a's own sibling of
 *  `CourtId`, same reasoning. */
export const VenueId = Uuid;
export const Slug = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase letters, digits and hyphens");

export const Visibility = z.enum(["private", "unlisted", "public"]);
export const CompetitionStatus = z.enum(["draft", "published", "live", "completed", "archived"]);
// Doc 12 §1: 'scheduled' = timetable published, scoring not yet open.
export const DivisionStatus = z.enum(["setup", "scheduled", "active", "completed"]);
export const StageKind = z.enum(["league", "group", "swiss", "knockout", "double_elim", "stepladder", "page_playoff", "americano", "ladder"]);
export const EntrantKind = z.enum(["team", "individual", "pair"]);
export const EntrantStatus = z.enum(["registered", "confirmed", "withdrawn", "disqualified"]);
// v3/08 §2: ranked scopes — read < score < manage. "write" is the legacy
// name for manage; still accepted on input, stored as manage.
export const ApiKeyScope = z.enum(["read", "score", "manage", "write"]);
