// /api/v1 contracts — org news posts, duplicate review and merge (#404), venues and courts (D5).
// One module of the schemas/ folder; ./index.ts is the map and the public surface. Pure zod (loads bare under
// `node --experimental-strip-types`): relative imports carry an explicit `.ts`, types come in through `import type`.
import { z } from "zod";
import { patchOf } from "../../../lib/zod-patch.ts";
import { Uuid, RequiredCourtTags } from "./common.ts";
import { Person } from "./persons.ts";
import { AiPlanConflict } from "./ai-planning.ts";

// Org news (SPEC-2 / PROMPT-82) -----------------------------------------------

export const PostKind = z.enum(["news", "result", "round_recap", "announcement", "weekly_digest"]);
export const PostStatus = z.enum(["draft", "published", "archived"]);

export const CreatePost = z.object({
  title: z.string().min(1).max(300),
  body_md: z.string().max(50_000).optional(),
  kind: PostKind.optional(),
  competition_id: Uuid.optional(),
  division_id: Uuid.optional(),
  hero_image_path: z.string().max(500).optional(),
});
export type CreatePost = z.infer<typeof CreatePost>;

export const PatchPost = z
  .object({
    title: z.string().min(1).max(300),
    body_md: z.string().max(50_000),
    hero_image_path: z.string().max(500).nullable(),
    competition_id: Uuid.nullable(),
    division_id: Uuid.nullable(),
    /** Lifecycle: publish stamps published_at + freezes the slug; archive hides. */
    action: z.enum(["publish", "archive"]),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "empty patch");
export type PatchPost = z.infer<typeof PatchPost>;

// House convention: every /api/v1 response is snake_case (see auto_posts on
// Division, org_id on Competition, module_version on Fixture). The usecase
// layer (org-posts.ts) stays camelCase for server components — routes
// translate at the boundary via toApiPost() in posts.ts.
export const OrgPost = z.object({
  id: Uuid,
  org_id: Uuid,
  competition_id: Uuid.nullable(),
  division_id: Uuid.nullable(),
  kind: PostKind,
  status: PostStatus,
  slug: z.string(),
  title: z.string(),
  body_md: z.string(),
  hero_image_path: z.string().nullable(),
  auto_source: z.record(z.string(), z.unknown()).nullable(),
  published_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

// ---------------------------------------------------------------------------
// Duplicate review + merge (#404) — response contracts
// ---------------------------------------------------------------------------

/** What a merge did, from the caller's point of view. `merge_id` is the handle
 *  the undo control posts back to; `revealed` is a REPORT, not a refusal — the
 *  merge already happened (spec §5). */
export const MergeResult = z.object({
  merge_id: Uuid,
  survivor: Person,
  revealed: z.array(
    z.object({ division_id: Uuid, conflicts: z.array(AiPlanConflict) }),
  ),
});
export type MergeResult = z.infer<typeof MergeResult>;

/** Why a pair was suggested. `detail` is org DATA — a name, a date, an entrant
 *  name — never a sentence, so the panel phrases it in the viewer's locale. */
export const DuplicateEvidence = z.object({
  kind: z.enum(["name", "dob", "shared_entrant"]),
  detail: z.string(),
});

/** The ranked queue. `a` is the older row — the default survivor. */
export const DuplicateCandidates = z.object({
  items: z.array(
    z.object({
      a: Person,
      b: Person,
      score: z.number(),
      evidence: z.array(DuplicateEvidence),
    }),
  ),
});
export type DuplicateCandidates = z.infer<typeof DuplicateCandidates>;

/** The org's merge log, newest first. `reversed_at` is what decides whether a
 *  row still offers Undo — a reversed merge is kept, never deleted (#403 R2/R3),
 *  so the list is an audit trail as well as a set of undo handles. */
export const MergeLog = z.object({
  items: z.array(
    z.object({
      merge_id: Uuid,
      survivor_id: Uuid,
      absorbed_id: Uuid,
      survivor_name: z.string(),
      absorbed_name: z.string(),
      created_at: z.string(),
      reversed_at: z.string().nullable(),
    }),
  ),
});
export type MergeLog = z.infer<typeof MergeLog>;

// Venues & courts (D5/P8) -----------------------------------------------------
// Runtime validation lives in usecases/venues.ts (the actual parseBody
// schemas the routes use); these mirror that shape for OpenAPI generation
// only, same split as the Sponsor CRM group above.

export const CourtHoursRangeS = z.object({
  weekday: z.number().int().min(0).max(6),
  open_min: z.number().int().min(0).max(1440),
  close_min: z.number().int().min(0).max(1440),
});

export const CourtExceptionS = z.object({
  date: z.string(),
  closed: z.boolean(),
  open_min: z.number().int().nullable(),
  close_min: z.number().int().nullable(),
});

/** Plain court row — the create/patch response shape. */
export const Court = z.object({
  id: Uuid,
  venue_id: Uuid,
  name: z.string(),
  sort: z.number().int(),
  tags: z.array(z.string()),
  archived_at: z.string().nullable(),
  created_at: z.string(),
});

/** A court nested under a venue in the list response, its full calendar
 *  embedded — there is no separate GET for a court or its calendar. */
export const CourtWithCalendar = Court.extend({
  hours: z.array(CourtHoursRangeS),
  exceptions: z.array(CourtExceptionS),
});

/** Plain venue row — the create/patch response shape. */
export const Venue = z.object({
  id: Uuid,
  name: z.string(),
  address: z.string().nullable(),
  sort: z.number().int(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
});

export const VenueWithCourts = Venue.extend({
  courts: z.array(CourtWithCalendar),
});

export const CreateVenue = z.object({
  name: z.string().min(1).max(200),
  address: z.string().max(500).nullish(),
  sort: z.number().int().default(0),
});

// `patchOf`, not `.partial()`: a partial still fills the defaults, so saving a venue reset its `sort` to 0 and renaming
// or reordering a court wiped its `tags` — every stage's required court tags with them (fix/patch-schema-partial-defaults).
export const PatchVenue = patchOf(CreateVenue);

export const CreateCourt = z.object({
  name: z.string().min(1).max(200),
  sort: z.number().int().default(0),
  tags: RequiredCourtTags.default([]),
});

export const PatchCourt = patchOf(CreateCourt);

export const PutCourtCalendar = z.object({
  hours: z.array(CourtHoursRangeS).max(200).default([]),
  exceptions: z.array(CourtExceptionS).max(500).default([]),
});

export const CourtCalendar = z.object({
  court_id: Uuid,
  hours: z.array(CourtHoursRangeS),
  exceptions: z.array(CourtExceptionS),
  /** Advisory only (owner ruling): EVERY unplayed fixture on this court
   *  currently outside a usable window — whatever stranded it, including a
   *  division session window or blackout this write never touched.
   *  Non-blocking; the real conflict code is P10's. */
  strandedFixtureCount: z.number().int(),
  /** Advisory only: the subset of the above that THIS write caused, by
   *  fixture identity (a write can strand one fixture and free another, so
   *  this is a set difference, not a subtraction). Clients that attribute
   *  the number to the edit — the venues panel's copy says "now falls
   *  outside these hours" — must read this one, not the total. */
  newlyStrandedFixtureCount: z.number().int(),
});
