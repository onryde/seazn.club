// /api/v1 contracts — competitions: create/patch/read, discovery info, public-quota degraded, the date-order check (ENDS_BEFORE_STARTS).
// One module of the schemas/ folder; ./index.ts is the map and the public surface. Pure zod (loads bare under
// `node --experimental-strip-types`): relative imports carry an explicit `.ts`, types come in through `import type`.
import { z } from "zod";
import { Slug, Visibility, CompetitionStatus, Uuid } from "./common.ts";

// ---------------------------------------------------------------------------
// Competitions
// ---------------------------------------------------------------------------

/** #376: ISO `YYYY-MM-DD` sorts lexicographically, so a string compare IS the
 *  date compare. Attached to both the create and the patch body; the patch can
 *  only see the dates it CARRIES, which is why the same order is re-checked in
 *  `patchCompetition` (usecases/competitions.ts) against the stored row. That
 *  re-check landed with settings-walkthrough F8 (2026-09-07) — this sentence
 *  described it for months before it existed, and a `PATCH { ends_on }` alone
 *  answered 200 the whole time, so do not read it as evidence for the next
 *  claim of the same shape.
 *
 *  Message mirrors the `en` copy for `comp.validation.endsBeforeStarts` — the
 *  forms render the localized key, and an API client reads this same sentence
 *  either out of a **400**'s `issues` (this refinement, when one body carries
 *  both dates) or out of a **422**'s `error.message` (the use-case's own
 *  `HttpError`, when the inversion is only visible against the stored row).
 *  Two layers, two statuses, one sentence: change it here and both move. */
export const ENDS_BEFORE_STARTS = "The end date cannot be before the start date.";

export function checkDateOrder(
  v: { starts_on?: string | null; ends_on?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (typeof v.starts_on === "string" && typeof v.ends_on === "string" && v.ends_on < v.starts_on) {
    ctx.addIssue({ code: "custom", path: ["ends_on"], message: ENDS_BEFORE_STARTS });
  }
}

export const CreateCompetition = z
  .object({
    name: z.string().min(1).max(200),
    slug: Slug.optional(), // derived from name when omitted
    /** Markdown (v3/06 §2) — rendered through lib/prose on every surface. */
    description: z.string().max(20_000).nullish(),
    starts_on: z.iso.date().nullish(),
    /** #376: MANDATORY. A null end date can never cross `past_ends_on`, so the
     *  Event Pass date lock never fires and the competition holds a
     *  `competitions.max_active` slot for good. Required here, and non-nullable
     *  on PATCH — a nullable patch would reopen the same door. */
    ends_on: z.iso.date(),
    /** PUBLIC BY DEFAULT (entitlements v18 W2 T15/F, owner ruling
     *  2026-09-03). A competition nobody can see is a competition that does
     *  not grow the product, and the organiser who wanted private says so.
     *  The public-dashboard cap does NOT refuse a create over this default —
     *  `createCompetition` degrades to private instead (see its comment), so
     *  flipping the default cannot start 402ing callers who never asked for a
     *  public one. */
    visibility: Visibility.default("public"),
    branding: z.record(z.string(), z.unknown()).default({}),
    /** Doc 15 §1 "Showcase on seazn.club" — opt-in at create time; requires
     *  public visibility, same rule as PATCH. Omitted = false. */
    discoverable: z.boolean().optional(),
  })
  .superRefine(checkDateOrder);
export type CreateCompetition = z.infer<typeof CreateCompetition>;

/** Organiser-entered discovery presentation (doc 15 §1). tagline/hero are
 *  `discovery.branding`-gated at the write (use-case), not here. */
export const DiscoveryInfo = z
  .object({
    city: z.string().max(100).nullish(),
    country: z.string().max(100).nullish(),
    tagline: z.string().max(200).nullish(),
    hero_image_path: z.string().max(500).nullish(),
  })
  .strict();
export type DiscoveryInfo = z.infer<typeof DiscoveryInfo>;

export const PatchCompetition = z
  .object({
    name: z.string().min(1).max(200),
    slug: Slug,
    description: z.string().max(20_000).nullable(),
    starts_on: z.iso.date().nullable(),
    /** #376: changeable but NOT removable. `.partial()` below keeps it optional
     *  to SEND; dropping `.nullable()` is what stops an org PATCHing it back to
     *  null and falling out of the `past_ends_on` pass lock again. */
    ends_on: z.iso.date(),
    visibility: Visibility,
    branding: z.record(z.string(), z.unknown()),
    status: CompetitionStatus,
    /** Doc 15 §1 "Showcase on seazn.club" — explicit opt-in, public only. */
    discoverable: z.boolean(),
    discovery: DiscoveryInfo,
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "empty patch")
  .superRefine(checkDateOrder);
export type PatchCompetition = z.infer<typeof PatchCompetition>;

export const Competition = z.object({
  id: Uuid,
  org_id: Uuid,
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  starts_on: z.string().nullable(),
  ends_on: z.string().nullable(),
  visibility: Visibility,
  branding: z.record(z.string(), z.unknown()),
  status: CompetitionStatus,
  created_at: z.string(),
  discoverable: z.boolean(),
  discovery: DiscoveryInfo,
  /** doc 10 §2.4 — true when over-quota after a downgrade (read-only). */
  frozen: z.boolean().optional(),
});

/**
 * The create-time public-dashboard degrade, stated in the RESPONSE (T20,
 * reviewer pass 3, 2026-09-03).
 *
 * V396 made competitions public by default and, at `dashboard.public.max`,
 * made a create DEGRADE to private rather than 402 (T15/F, owner ruling
 * 2026-09-03). The degrade was invisible: a 201 came back carrying something
 * other than what was asked for, and the only way to notice was to diff the
 * returned row against the request — which exactly one client did. A 201 that
 * silently substitutes a different resource is wrong for every consumer, so
 * the substitution is now NAMED, with the cap that caused it.
 *
 * Two properties this shape is chosen for:
 *
 *   * A caller that IGNORES it is still not misled — both create responses
 *     also carry the visibility that was actually applied, so the resource
 *     representation is truthful on its own. This note is the explicit
 *     signal, never the only one.
 *   * The cap travels WITH the note (`limit` + `reason`, built by
 *     `publicDashboardsReason`) rather than being restated in copy, for the
 *     same reason the 402 does it: the flat sentence in feature-copy.ts said
 *     "one public dashboard at a time" through caps of 1, 3 and 2.
 *
 * ABSENT when nothing was degraded — never `false`/null-filled, so
 * `if (res.public_quota_degraded)` is the whole client-side test and a
 * consumer is never trained to ignore a field that is usually there.
 */
export const PublicQuotaDegraded = z.object({
  feature_key: z.literal("dashboard.public.max"),
  /** What the caller asked for. `unlisted` is here because it consumes a slot
   *  too — `public_competitions_v` serves an unlisted competition the same
   *  dashboard it serves a public one, so the cap counts both (owner ruling
   *  2026-09-05, see PUBLICLY_READABLE_VISIBILITIES in usecases/competitions.ts).
   *  A note that could only ever say "public" would misreport an unlisted
   *  request back to the client that made it. */
  requested_visibility: z.enum(["public", "unlisted"]),
  applied_visibility: z.literal("private"),
  /** The resolved cap, null when unlimited. */
  limit: z.number().int().nullable(),
  /** Same sentence the 402 carries — `publicDashboardsReason(limit)`. */
  reason: z.string(),
  /** TRUE when the caller also asked to be listed on the seazn.club showcase
   *  and that opt-in was dropped with the visibility.
   *
   *  Two substitutions happen on a degraded create and only one used to be
   *  reported. Showcase rides visibility — a private competition cannot be
   *  showcased, so `discoverable` is forced false — and a caller who asked for
   *  `{visibility: "public", discoverable: true}`, PASSED the `discovery.listed`
   *  entitlement check, and got a 201 had no way to learn the second half did
   *  not happen. They would reasonably believe their competition is on the
   *  showcase.
   *
   *  Optional and only ever present as `true`, matching this object's own
   *  rule about absent-not-false: a consumer must not be trained to ignore a
   *  field that is usually there. */
  discoverable_dropped: z.literal(true).optional(),
});
export type PublicQuotaDegraded = z.infer<typeof PublicQuotaDegraded>;

/** POST /competitions' 201 body: the competition, plus the degrade note when
 *  the public-dashboard cap turned a requested public create private. Only
 *  the CREATE response can carry it — a later GET/list of the same row has no
 *  request to have degraded — which is why this is a separate schema rather
 *  than an optional field on `Competition`. */
export const CreatedCompetition = Competition.extend({
  public_quota_degraded: PublicQuotaDegraded.optional(),
});
export type CreatedCompetition = z.infer<typeof CreatedCompetition>;
