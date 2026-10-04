// /api/v1 request/response contracts (doc 08 §3–§5). Single source of truth:
// route handlers parse requests with these, and openapi.ts derives the served
// spec from them — code and contract cannot drift.
//
// NOT server-only: pure Zod, shared with the OpenAPI generator script.
import { z } from "zod";
// #398: durable division rules speak the SAME vocabulary a compiled instruction
// does, so the wire schema reuses the engine's zod rather than restating it —
// a second declaration is a second thing to drift.
import { HardConstraint, type ConflictDetailKind } from "@seazn/engine/scheduling";
// Type-only (erased under strip-types, so openapi-gen.ts still loads this
// file bare): the TakeRuleSchema tie below compares against it.
import type { TakeRule } from "@seazn/engine/competition";
// RS007 review fix L1 — the SAME every-year-safe days-per-month predicate
// ageBandEligibilityIssues (registration-rules.ts) uses to fail loudly on
// the read side; pure and DB-free, so it is safe to reuse here. RELATIVE,
// with the explicit .ts extension (matching this file's own sibling
// openapi.ts, e.g. `from "./schemas.ts"`) — NOT the `@/` alias: this module
// is shared with the standalone OpenAPI generator script
// (scripts/openapi-gen.ts), which runs via bare
// `node --experimental-strip-types` with no bundler and no tsconfig `paths`
// resolution, so a `@/...` import throws ERR_MODULE_NOT_FOUND there even
// though it resolves fine under tsc/Next.js/vitest.
import { isValidCutoffDay, REASON_MIN, REASON_MAX } from "../../lib/registration-rules.ts";
// The entrant name limit, shared with the console's Name field (entrants-panel.tsx).
import { ENTRANT_NAME_MAX } from "../../lib/entrant-roster-name.ts";
// The player name limit, shared with the directory's rename field (persons-panel.tsx).
import { PERSON_NAME_MAX } from "../../lib/person-name.ts";
// Task 9 (spectator surface W1) — the match-centre document schema, reused
// verbatim as `PublicFixtureSummary.match_centre`'s type below rather than
// restated: match-centre-schema.ts is pure Zod with no imports beyond zod
// itself (verified by reading it), so it is safe for the standalone OpenAPI
// generator script the same way this whole file is — relative import, `.ts`
// extension, same reasoning as `registration-rules.ts` above.
import { MatchCentreDoc } from "../public-site/match-centre-schema.ts";
// Stream overlay W1 (Task 3) — the ONE stream-link validator (R16), reused
// here rather than restated. Relative + explicit `.ts`, same reason as
// registration-rules.ts above: this file is shared with the standalone
// OpenAPI generator script, which has no `@/` alias resolution.
import { streamUrlSchema } from "../../lib/stream-url.ts";
// Streaming R1 (Task 9) — the capture QR's ONE schema (design §7.6), re-exported
// in the relay block below, never re-typed. Relative + explicit `.ts`, same
// reason as stream-url.ts above; lib/capture-qr.ts imports zod and nothing else.
import { CaptureQrV1, CaptureQrV2 } from "../../lib/capture-qr.ts";
// Capture QR v2 (PR-1 T1) — the phone↔web contract's zod twins (docs/contracts/capture-*.json), re-exported, never
// re-typed. Relative + explicit `.ts`, same reason as above; capture-schemas.ts imports zod and nothing else.
export {
  CAPTURE_CODE_RE, CaptureEndReason, CaptureStartedBy, CaptureCause, CapturePhoneState, CaptureNotReady,
  CaptureStartFailed, CaptureWaiting, CaptureCred, CaptureSession, CaptureDescriptor, CaptureBeat, CaptureBeatAnswer,
  CaptureStartBody, CaptureStartOk, CaptureRefusalCode, CaptureRefusal,
} from "./capture-schemas.ts";
// m2 — the ONE Intl-backed zone validator, reused rather than restated, so
// `schedule_settings.tz` refuses exactly what `users.timezone` (lib/types.ts)
// and `organizations.timezone` (api/orgs/[id]/route.ts) already refuse.
// RELATIVE with an explicit `.ts` extension, NOT the `@/` alias, for the same
// reason as registration-rules.ts above: this module is shared with the
// standalone OpenAPI generator (scripts/openapi-gen.ts), which runs under bare
// `node --experimental-strip-types` with no tsconfig `paths` resolution.
// lib/tz.ts is deliberately import-free, so it is safe for that generator.
import { isValidIana } from "../../lib/tz.ts";
// D6 (fixture-page stream, 2026-09-30) — the platforms a NEW destination may name. RELATIVE with `.ts`, never `@/`,
// for the same reason as the imports above; lib/stream-destinations.ts is deliberately import-free.
import { STREAM_PLATFORMS } from "../../lib/stream-destinations.ts";

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

function checkDateOrder(
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

// ---------------------------------------------------------------------------
// Divisions
// ---------------------------------------------------------------------------

/** F5: the engine's TiebreakerKey union, enforced at the edge — an unknown
 *  key (e.g. the preset NAME "fifa2026") silently no-ops every comparison and
 *  standings degrade to the deterministic seed-order fallback. 400 instead. */
export const TiebreakerKeyS = z.enum([
  "points", "wins", "h2h_points", "h2h_diff", "h2h_for", "diff", "for", "nrr",
  "set_ratio", "game_ratio", "board_ratio", "point_ratio", "buchholz",
  "buchholz_cut1", "sberger", "direct", "fair_play", "seed", "lots",
]);

/** V364 first-class eligibility: gender category badge/gate (evaluated in
 *  registration-eligibility.ts). `open`, null, and `mixed` all constrain
 *  nothing at the individual level — `mixed` is a roster-wide rule. */
export const DivisionCategory = z.enum(["open", "mens", "womens", "mixed"]);

// Exported so usecases/divisions.ts can raise the SAME message when it
// catches the single-field case this refine cannot see (RS004 review
// finding 1 — checkAgeBand only fires when both sides are in ONE patch).
export const AGE_MAX_BEFORE_MIN = "age_max must be greater than or equal to age_min.";

function checkAgeBand(
  v: { age_min?: number | null; age_max?: number | null },
  ctx: z.RefinementCtx,
): void {
  if (v.age_min != null && v.age_max != null && v.age_max < v.age_min) {
    ctx.addIssue({ code: "custom", path: ["age_max"], message: AGE_MAX_BEFORE_MIN });
  }
}

// RS007/V380: the age-band cutoff override — both-or-neither. This refinement
// sees the request BODY only, so it catches the single-request case and
// answers 400 with an issue on `age_cutoff_day`. Since W8/F12 the SAME
// sentence is also raised as a 422 by `patchDivision` (usecases/divisions.ts),
// which merges the patch against the STORED row before deciding — the
// constant is exported for that use, so the two layers cannot drift apart.
//
// The merge-check is not redundant with this one, and the reason is subtle:
// `!= null` cannot distinguish an OMITTED field from one set to an explicit
// `null`, so `{ age_cutoff_day: null }` against a stored month reads
// `false !== false` here and passes. Before F12 that patch answered 200 and
// stored an orphan half.
//
// THE DB CHECK IS NOT A BACKSTOP FOR THIS RULE, and that is where the cutoff
// pair differs from AGE_MAX_BEFORE_MIN/checkAgeBand above — do not read the
// two as the same three-layer arrangement. `divisions_age_cutoff_check`
// (V380) is
//
//   (month is null and day is null)
//   or (month between 1 and 12 and day between 1 and 31)
//
// and with exactly one side NULL and the PRESENT half IN RANGE, the first
// disjunct is false while the second is NULL (`null between 1 and 31` is
// NULL, and `true and NULL` is NULL), so the whole predicate is NULL — which
// SATISFIES a CHECK under SQL's tri-valued logic. A one-sided orphan of
// otherwise-valid values passes it, always.
//
// The "in range" qualifier is load-bearing, and getting it wrong is what a
// W8 T6 re-review caught here: `false and NULL` is FALSE, not NULL, so a
// one-sided half that is OUT of range collapses the second disjunct to false
// and IS refused. Verified against this constraint's live definition rather
// than reasoned about — `(13, null)` and `(null, 32)` REFUSED, `(9, null)`
// and `(null, 5)` SATISFIED, `(2, 31)` (31 February) SATISFIED.
//
// So what the constraint actually refuses is: any PRESENT half outside its
// own range, one-sided included. That is a third rule neither refinement here
// states, and it is not day-per-month either. `isAgeCutoffCheckViolation`
// (usecases/divisions.ts) maps it to a 422 carrying THIS sentence, which is
// the wrong sentence for a range violation — harmless today only because
// zod's own `.min`/`.max` below bound every half before it can be sent, so
// nothing reaches the constraint over /api/v1.
//
// Two consequences worth stating plainly. `patchDivision`'s merge-check is
// the SOLE enforcement point for both-or-neither — there is no database
// invariant underneath it. And READ COMMITTED therefore has a residual this
// pair cannot close the way the age band closes it: two concurrent PATCHes
// that each read the pre-commit row can still commit an orphan between them.
// Known and accepted (W8/F12), not a TODO — closing it needs a constraint
// that can see the case, e.g. `num_nulls(age_cutoff_month,
// age_cutoff_day) <> 1`, which is its own migration.
export const AGE_CUTOFF_BOTH_OR_NEITHER =
  "age_cutoff_month and age_cutoff_day must be set together, or both left null.";

// RS007 review fix L1: age_cutoff_day was only range-checked 1-31 (this
// schema's own min/max below, and the DB CHECK) — 31 September or
// 30 February parsed successfully and silently rolled a month at READ time
// (ageBandEligibilityIssues, @/lib/registration-rules — `new
// Date(Date.UTC(...))` normalises an out-of-range day), shifting eligibility
// by days with no error anywhere.
//
// Over /api/v1 this rule really is self-contained: a body that reaches it
// with both halves present carries both, and the both-or-neither check just
// above rejects every body that carries only one — so there is no stale
// stored half to race against, and the 400 raised here is the whole story.
// `patchDivision` re-checks it on the MERGED pair anyway (W8/F12), NOT for
// that case but for the caller shape zod never sees at all: the use-case is
// exported and a direct caller gets no schema parse. Same predicate
// (`isValidCutoffDay`), same sentence, 422 instead of 400.
export const AGE_CUTOFF_DAY_INVALID_FOR_MONTH = "age_cutoff_day is not a valid day for age_cutoff_month.";

function checkAgeCutoff(
  v: { age_cutoff_month?: number | null; age_cutoff_day?: number | null },
  ctx: z.RefinementCtx,
): void {
  if ((v.age_cutoff_month != null) !== (v.age_cutoff_day != null)) {
    ctx.addIssue({ code: "custom", path: ["age_cutoff_day"], message: AGE_CUTOFF_BOTH_OR_NEITHER });
    return;
  }
  if (
    v.age_cutoff_month != null &&
    v.age_cutoff_day != null &&
    !isValidCutoffDay(v.age_cutoff_month, v.age_cutoff_day)
  ) {
    ctx.addIssue({ code: "custom", path: ["age_cutoff_day"], message: AGE_CUTOFF_DAY_INVALID_FOR_MONTH });
  }
}

export const CreateDivision = z
  .object({
    name: z.string().min(1).max(200),
    slug: Slug.optional(),
    sport_key: z.string().min(1),
    variant_key: z.string().min(1),
    /** Merged over the variant preset, then validated by the sport module. */
    config: z.record(z.string(), z.unknown()).default({}),
    tiebreakers: z.array(TiebreakerKeyS).nullish(),
    /** RS007/V380: the SAME first-class eligibility columns PatchDivision
     *  carries (field comments below), now writable at create time too — the
     *  division-creation wizard's Eligibility tab used to POST a jsonb
     *  `eligibility` array this (non-strict) schema didn't declare, which
     *  zod silently dropped, so every wizard-created division shipped with
     *  no restriction at all. All optional: a division created with none of
     *  these set has no restriction, exactly as before. */
    category: DivisionCategory.nullable().optional(),
    age_min: z.number().int().min(0).max(120).nullable().optional(),
    age_max: z.number().int().min(0).max(120).nullable().optional(),
    age_cutoff_month: z.number().int().min(1).max(12).nullable().optional(),
    age_cutoff_day: z.number().int().min(1).max(31).nullable().optional(),
    eligibility_note: z.string().max(2000).nullable().optional(),
  })
  .superRefine(checkAgeBand)
  .superRefine(checkAgeCutoff);
export type CreateDivision = z.infer<typeof CreateDivision>;

export const PatchDivision = z
  .object({
    name: z.string().min(1).max(200),
    /** Markdown (v3/06 §2), shown on the public division page. */
    description: z.string().max(20_000).nullable(),
    tiebreakers: z.array(TiebreakerKeyS).nullable(),
    /** V364/V380 first-class eligibility columns — the ONE eligibility
     *  representation (RS007/V380 dropped the jsonb `eligibility` rules this
     *  comment used to say "read alongside"). */
    category: DivisionCategory.nullable(),
    /** Years, evaluated at the age_cutoff_month/day below (1 Jan when
     *  null) of the season-start year. Nullable independently of age_max;
     *  combined they must satisfy age_max >= age_min (checkAgeBand below) —
     *  the DB CHECK backstops any caller that bypasses this schema (e.g. a
     *  direct usecase call in a test). */
    age_min: z.number().int().min(0).max(120).nullable(),
    age_max: z.number().int().min(0).max(120).nullable(),
    /** RS007/V380: overrides the age band's cutoff date (default 1
     *  January) — school-year age groups commonly run 1 September.
     *  Both-or-neither via `checkAgeCutoff` below on the body, and
     *  `patchDivision`'s merge-check on the merged row (W8/F12). Unlike
     *  age_min/age_max two fields up, the DB CHECK does NOT backstop this
     *  one — a one-sided orphan satisfies it (`false OR NULL`), so the
     *  merge-check is the sole enforcement point. Full reasoning at
     *  AGE_CUTOFF_BOTH_OR_NEITHER above. */
    age_cutoff_month: z.number().int().min(1).max(12).nullable(),
    age_cutoff_day: z.number().int().min(1).max(31).nullable(),
    /** RS007/V380: the retired jsonb "custom rule" note, now a first-class
     *  column the public entry/join pages render as a warning. */
    eligibility_note: z.string().max(2000).nullable(),
    status: DivisionStatus,
    /** Hide official names on all public reads (Jul3/02, 25 Jun). */
    officials_hide_names: z.boolean(),
    /** Jul3/08 §5: progression fires without a button (Pro formats.advanced). */
    auto_progress: z.boolean(),
    /** SPEC-2: draft a news post when results land (Pro `news.auto` on write). */
    auto_posts: z.boolean(),
    /** V416: publish entrants' seed numbers on the public site. Off redacts
     *  `seed` in `public_entrants_v` (so every public reader gets null and
     *  sorts by name); the organiser's own reads keep every seed. */
    show_seeds: z.boolean(),
    /** Youth flag (v3/11 gap 8): auto-set from U-age eligibility, this is
     *  the organiser override. */
    youth: z.boolean(),
    /** Public name rendering; null resolves youth → first_initial. */
    player_name_display: z.enum(["full", "first_initial"]).nullable(),
    /** Card logo (V274, v8); null reverts the tile to the monogram. */
    logo_storage_path: z.string().max(500).nullable(),
    /** Format edit (v8) — allowed only pre-fixtures; usecase enforces
     *  FORMAT_LOCKED and re-validates via the pinned module schema. */
    variant_key: z.string().min(1).max(100),
    config: z.record(z.string(), z.unknown()),
    /** D5/P8 candidate-court filter (design doc "Tag semantics"): a court
     *  must carry every one of these tags; empty = any court. Normalised
     *  (trim/lowercase/dedupe) by usecases/divisions.ts via the SAME
     *  normalizeTags() the courts path uses — same shape, same rules, one
     *  copy. Read by scheduling as of P9 pass 2b: `usecases/court-
     *  candidates.ts`'s `resolveCandidateCourts`, unioned with the sibling
     *  `stages.required_court_tags` (V367) — that column's own CRUD still
     *  does not exist, only its read into this union. */
    required_court_tags: RequiredCourtTags,
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "empty patch")
  .superRefine(checkAgeBand)
  .superRefine(checkAgeCutoff);
export type PatchDivision = z.infer<typeof PatchDivision>;

export const Division = z.object({
  id: Uuid,
  competition_id: Uuid,
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  sport_key: z.string(),
  variant_key: z.string(),
  config: z.unknown(),
  module_version: z.string(),
  tiebreakers: z.array(TiebreakerKeyS).nullable(),
  // V364/V380 first-class eligibility columns; see PatchDivision above.
  category: DivisionCategory.nullable(),
  // Bounded 0-120, matching PatchDivision's request-side bounds above
  // (RS004 review finding 4) — the generated OpenAPI spec described this
  // field two different ways otherwise.
  age_min: z.number().int().min(0).max(120).nullable(),
  age_max: z.number().int().min(0).max(120).nullable(),
  age_cutoff_month: z.number().int().min(1).max(12).nullable(),
  age_cutoff_day: z.number().int().min(1).max(31).nullable(),
  eligibility_note: z.string().max(2000).nullable(),
  status: DivisionStatus,
  officials_hide_names: z.boolean(),
  scheduling_mode: z.enum(["timed", "flexible"]),
  auto_progress: z.boolean(),
  auto_posts: z.boolean(),
  show_seeds: z.boolean(), // V416 — seeds on the public site; see PatchDivision above
  archived_at: z.string().nullable(), // v3/09 §4 — set = archived (hidden, restorable)
  created_at: z.string(),
  required_court_tags: z.array(z.string()), // D5/P8 candidate-court filter; see PatchDivision above
});

// ---------------------------------------------------------------------------
// Eligibility (RS011) — organiser-side gate. Divisions declare eligibility
// (`CreateDivision`/`PatchDivision`'s `category`/`age_min`/`age_max` above);
// the organiser-side roster-write bodies below carry this ONE optional field
// so an organiser can knowingly override a violation with a reason, audited
// (`usecases/registration-eligibility.ts`'s `gateRosterEligibility`). Absent
// = no override attempted; present with a violation present = the gate
// writes one `eligibility.overridden` ledger row and proceeds.
// ---------------------------------------------------------------------------

// RS011 review round 3, finding 4: the two bounds are defined ONCE in
// `@/lib/registration-rules` (client-safe — the override dialog's own
// `armed`/`maxLength` check imports the SAME constants) so this schema and
// the client-side gate can never silently drift apart.
export const EligibilityOverride = z.object({
  reason: z.string().min(REASON_MIN).max(REASON_MAX),
});
export type EligibilityOverride = z.infer<typeof EligibilityOverride>;

// ---------------------------------------------------------------------------
// Entrants
// ---------------------------------------------------------------------------

// G1 (bench B03 product-gaps, 2026-09-02): V356 widened persons.lane's CHECK
// to 'coach'/'staff' (mirroring LineupSlot.role) but no writer followed —
// this is that writer's request-side half. 'official' excluded on purpose:
// officials.ts has its own dedicated creation path, and this is additive to
// what a generic /persons POST could already do, not a replacement for it.
export const PersonLane = z.enum(["player", "coach", "staff"]);
export type PersonLane = z.infer<typeof PersonLane>;

export const EntrantMemberInput = z.object({
  person_id: Uuid,
  squad_number: z.number().int().min(0).nullish(),
  default_position_key: z.string().nullish(),
  is_captain: z.boolean().default(false),
  roles: z.array(z.string()).default([]),
});

/** PROMPT-60 §2 — a member created inline with the entrant (same transaction),
 *  so a whole team + roster is one request. Explicit person_id remains the way
 *  to reuse an existing person; inline members are never merged/deduped
 *  against existing org persons. Create-time only.
 *
 *  `dob`/`gender` (RS011): optional, same shape/validation as `CreatePerson`'s
 *  — without them, an inline person has neither, which is the MISSING_DOB/
 *  MISSING_GENDER warning state at the eligibility gate, not a bug (an
 *  organiser adding someone by name alone is normal). */
export const NewPersonMemberInput = z.object({
  new_person: z.object({
    full_name: z.string().min(1).max(200),
    dob: z.iso.date().nullish(),
    gender: z.enum(["m", "f", "x"]).nullish(),
    // G1: registering a coach/staff member AS PART OF THE SQUAD — the exact
    // scenario V356's own comment names ("a team official is IN the squad").
    lane: PersonLane.optional(),
  }),
  squad_number: z.number().int().min(0).nullish(),
  default_position_key: z.string().nullish(),
  is_captain: z.boolean().default(false),
  roles: z.array(z.string()).default([]),
});
export const CreateEntrantMemberInput = z.union([EntrantMemberInput, NewPersonMemberInput]);
export type CreateEntrantMemberInput = z.infer<typeof CreateEntrantMemberInput>;

export const CreateEntrant = z
  .object({
    kind: EntrantKind,
    // Optional when enrolling an existing team: the server snapshots the name
    // from teams.name at creation so a later rename never rewrites history.
    display_name: z.string().min(1).max(ENTRANT_NAME_MAX).optional(),
    team_id: Uuid.nullish(),
    seed: z.number().int().min(1).nullish(),
    // National-squad sizes (~26) must pass; 40 caps abuse (PROMPT-60 §2).
    members: z.array(CreateEntrantMemberInput).max(40).default([]),
    // Copy the roster from an earlier entrant of the SAME team (season rollover,
    // league + cup). Resolved server-side in the creation transaction.
    copy_roster_from_entrant_id: Uuid.nullish(),
    // PROMPT-60: lightweight crest/badge/flag — an external URL or an
    // assets-bucket storage path. Club-independent, so free orgs get it.
    badge_url: z.string().min(1).max(1000).nullish(),
    // RS011: an organiser knowingly overriding a violation the resolved
    // roster (explicit members / copy_roster / squad-seed) would otherwise
    // hard-block on. See `EligibilityOverride`'s own comment above.
    eligibility_override: EligibilityOverride.optional(),
  })
  .refine((e) => e.display_name != null || e.team_id != null, {
    message: "display_name is required unless team_id is provided",
    path: ["display_name"],
  });
export type CreateEntrant = z.infer<typeof CreateEntrant>;

/** POST /divisions/{id}/entrants — one entrant or a bulk array (doc 08 §3). */
export const CreateEntrants = z.union([CreateEntrant, z.array(CreateEntrant).min(1).max(500)]);

/** POST /clubs/{id}/teams — create a team under a club. */
export const CreateTeam = z.object({
  name: z.string().min(1).max(200),
  short_name: z.string().max(60).nullish(),
});
export type CreateTeam = z.infer<typeof CreateTeam>;

/** PUT /teams/{id}/squad — full-replace the team's persistent squad. No
 *  `eligibility_override` here (RS011): `setTeamSquad` never hard-blocks —
 *  it is division-agnostic (a squad has no division of its own, only the
 *  divisions its entrants happen to be enrolled in today) and returns
 *  advisory warnings instead, so there is never a violation to override. */
export const SetTeamSquad = z.object({
  members: z.array(EntrantMemberInput).default([]),
});
export type SetTeamSquad = z.infer<typeof SetTeamSquad>;

/** POST /entrants/{id}/roster/sync — no other body field; RS011 adds the
 *  override as the whole payload (previously this endpoint took none). */
export const SyncEntrantRoster = z.object({
  eligibility_override: EligibilityOverride.optional(),
});
export type SyncEntrantRoster = z.infer<typeof SyncEntrantRoster>;

export const PatchEntrant = z
  .object({
    display_name: z.string().min(1).max(ENTRANT_NAME_MAX),
    seed: z.number().int().min(1).nullable(),
    status: EntrantStatus, // withdraw = status: 'withdrawn'
    members: z.array(EntrantMemberInput), // full replacement
    badge_url: z.string().min(1).max(1000).nullable(), // PROMPT-60
    // RS011: see CreateEntrant's field of the same name above. Only relevant
    // when `members` is also present — nothing else in a patch touches a
    // roster.
    eligibility_override: EligibilityOverride,
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "empty patch");
export type PatchEntrant = z.infer<typeof PatchEntrant>;

export const Entrant = z.object({
  id: Uuid,
  division_id: Uuid,
  kind: EntrantKind,
  team_id: Uuid.nullable(),
  display_name: z.string(),
  seed: z.number().int().nullable(),
  status: EntrantStatus,
  created_at: z.string(),
});

// ---------------------------------------------------------------------------
// Persons & profiles
// ---------------------------------------------------------------------------

export const Consent = z
  .object({
    public_name: z.boolean().optional(),
    public_photo: z.boolean().optional(),
  })
  .default({});

export const CreatePerson = z.object({
  full_name: z.string().min(1).max(PERSON_NAME_MAX),
  dob: z.iso.date().nullish(), // eligibility only; never exposed publicly
  gender: z.enum(["m", "f", "x"]).nullish(),
  consent: Consent,
  external_ref: z.string().max(200).nullish(),
  lane: PersonLane.optional(),
});
export type CreatePerson = z.infer<typeof CreatePerson>;

export const PatchPerson = z
  .object({
    full_name: z.string().min(1).max(PERSON_NAME_MAX),
    dob: z.iso.date().nullable(),
    gender: z.enum(["m", "f", "x"]).nullable(),
    consent: z.object({ public_name: z.boolean().optional(), public_photo: z.boolean().optional() }),
    external_ref: z.string().max(200).nullable(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "empty patch");
export type PatchPerson = z.infer<typeof PatchPerson>;

/**
 * #404 §8. `confirmed` is `literal(true)`, not `boolean`: a merge rewrites
 * every dependent row of two people and the ledger records who said yes, so an
 * absent field and an explicit `false` must both refuse. A plain boolean would
 * accept `false` silently — the one shape that reads like a decision and is not.
 *
 * `allow_dob_mismatch` is the organiser's hand-override of the strongest signal
 * in the data that these are two humans (§6); the queue never proposes such a
 * pair, so it can only ever arrive from someone who typed it.
 */
export const MergePersons = z.object({
  duplicate_id: Uuid,
  confirmed: z.literal(true),
  allow_dob_mismatch: z.boolean().optional(),
});
export type MergePersons = z.infer<typeof MergePersons>;

/** Reversal is as consequential as the merge — same explicit affirmation. */
export const ReverseMerge = z.object({ confirmed: z.literal(true) });
export type ReverseMerge = z.infer<typeof ReverseMerge>;

export const PutProfile = z.object({
  attributes: z.record(z.string(), z.unknown()),
});
export type PutProfile = z.infer<typeof PutProfile>;

export const Person = z.object({
  id: Uuid,
  full_name: z.string(),
  dob: z.string().nullable(),
  gender: z.enum(["m", "f", "x"]).nullable(),
  consent: z.record(z.string(), z.unknown()),
  external_ref: z.string().nullable(),
  // G1: full four-value set on the READ side (unlike CreatePerson/
  // NewPersonMemberInput's lane, which exclude 'official' — a row created
  // through officials.ts's own path still reads back its true lane here).
  lane: z.enum(["player", "official", "coach", "staff"]),
  /** Set once a player has claimed this row (PROMPT-53). */
  user_id: Uuid.nullable(),
  created_at: z.string(),
  /** List read only: an open, unexpired claim invite exists. */
  claim_pending: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Player accounts (PROMPT-53) — claims, availability, the /me surface
// ---------------------------------------------------------------------------

export const CreateClaimInvite = z.object({ email: z.email().max(200) });
export type CreateClaimInvite = z.infer<typeof CreateClaimInvite>;

export const PersonClaim = z.object({
  id: Uuid,
  person_id: Uuid,
  email: z.string(),
  invited_by: Uuid.nullable(),
  expires_at: z.string(),
  claimed_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  created_at: z.string(),
});

/** POST response only — claim_url embeds the secret, shown exactly once. */
export const CreatedPersonClaim = PersonClaim.extend({
  claim_url: z.string(),
  /** Whether the invite email was accepted by the provider. */
  email_sent: z.boolean(),
});

export const PutAvailability = z.object({
  status: z.enum(["in", "out", "maybe"]),
  note: z.string().max(280).nullish(),
});
export type PutAvailability = z.infer<typeof PutAvailability>;

export const Availability = z.object({
  fixture_id: Uuid,
  person_id: Uuid,
  status: z.enum(["in", "out", "maybe"]),
  note: z.string().nullable(),
  checked_in_at: z.string().nullable(),
  updated_at: z.string(),
});

export const PatchMyConsent = z
  .object({ public_name: z.boolean(), public_photo: z.boolean() })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "empty patch");
export type PatchMyConsent = z.infer<typeof PatchMyConsent>;

/** dob never rides out — only the derived guardian lock does. */
export const MyPerson = z.object({
  id: Uuid,
  full_name: z.string(),
  org_name: z.string(),
  consent: z.object({ public_name: z.boolean().optional(), public_photo: z.boolean().optional() }),
  consent_locked: z.boolean(),
});

export const MyFixture = z.object({
  id: Uuid,
  fixture_no: z.number().int(),
  person_id: Uuid,
  person_name: z.string(),
  org_name: z.string(),
  org_slug: z.string(),
  competition_name: z.string(),
  competition_slug: z.string(),
  competition_visibility: z.string(),
  division_name: z.string(),
  division_slug: z.string(),
  sport_key: z.string(),
  round_no: z.number().int(),
  entrant_name: z.string().nullable(),
  opponent_name: z.string().nullable(),
  scheduled_at: z.string().nullable(),
  // Review finding #9 (P9 venues/courts cutover): mirrors Fixture's own
  // migration exactly (line ~769 above) — court_id/venue_id + derived,
  // read-only court_name/venue_name. The frozen `venue`/`court_label` text
  // columns leave the wire entirely; listMyFixtures (usecases/me.ts) never
  // selected them post-cutover, so declaring them here as required was
  // already false — there is no compatibility shim to preserve.
  court_id: CourtId.nullable(),
  court_name: z.string().nullable(),
  venue_id: VenueId.nullable(),
  venue_name: z.string().nullable(),
  /** Venue zone (V305): division override -> org timezone -> UTC. Selected by
   *  `listMyFixtures` and shipped on the wire since V305, but never declared
   *  here — the times in this payload are unreadable without it, and a
   *  consumer that parses against this schema drops it. Found closing #9. */
  venue_tz: z.string().nullable(),
  status: z.string(),
  availability: z
    .object({ status: z.enum(["in", "out", "maybe"]), note: z.string().nullable() })
    .nullable(),
  checked_in_at: z.string().nullable(),
});

export const MyResult = z.object({
  id: Uuid,
  fixture_no: z.number().int(),
  competition_name: z.string(),
  competition_slug: z.string(),
  competition_visibility: z.string(),
  division_name: z.string(),
  division_slug: z.string(),
  org_name: z.string(),
  org_slug: z.string(),
  entrant_name: z.string().nullable(),
  opponent_name: z.string().nullable(),
  scheduled_at: z.string().nullable(),
  summary: z.unknown().nullable(),
  outcome: z.unknown().nullable(),
});

export const MyTeam = z.object({
  entrant_id: Uuid,
  entrant_name: z.string(),
  division_name: z.string(),
  competition_name: z.string(),
  org_name: z.string(),
  sport_key: z.string(),
});

export const MyFixtures = z.object({
  upcoming: z.array(MyFixture),
  results: z.array(MyResult),
  teams: z.array(MyTeam),
});

export const CheckinLink = z.object({ url: z.string(), expires_at: z.string() });

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

// F2 (unified progression field) — one ProgressionSchema replaces the two
// prior vocabularies: QualificationSpecSchema (topN | bestOfRank |
// losersOfRound | take/picks | combine, auto-seed-on-complete only) and
// StageSeedingSchema (rankRange | topNPerGroup | bestNth, source/take/
// placement/map, TBD-at-setup + propose/confirm). Mirrors the plain-TS shape
// in @seazn/engine/competition (TakeRule/ProgressionSource/SeededMapEntry)
// field-for-field — usecases import THOSE types, not these zod schemas, so a
// shape drift here would 400 at the edge. TakeRule is no longer kept in step
// by hand: the compile-time tie under TakeRuleSchema fails tsc on a drift in
// either direction (ruling 55, CL-R2).
//
// Collapse (owner ruling 4, F2 plan Decision 2): `rankRange` survives `topN`
// (topN:n IS rankRange{from:1,to:n}); `bestNth` survives `bestOfRank`,
// absorbing its `normaliseUnequalPools` field (Decision 2b — the merged rule
// still refuses unequal pool sizes by default; setting the flag silences the
// refusal, carried forward as a documented, production-unreachable gap, not
// newly closed here). `picks`/`roundLosers` are qualification's
// TakePicks/RoundLosers, unchanged in meaning, given the kind-tagged shape
// the rest of this union already uses. `take[].pool` / `picks[].pool` match
// the pool KEY ("A"); the display name ("Pool A") is also accepted — the
// engine normalises.
const PoolRankPickS = z.object({ pool: z.string().min(1), rank: z.number().int().min(1) }).strict();
const RankRangeTakeS = z
  .object({ kind: z.literal("rankRange"), from: z.number().int().min(1), to: z.number().int().min(1) })
  .strict()
  .refine((t) => t.to >= t.from, { message: "rankRange: to must be >= from", path: ["to"] });
const TopNPerGroupTakeS = z.object({ kind: z.literal("topNPerGroup"), n: z.number().int().min(1).max(16) }).strict();
const BestNthTakeS = z
  .object({
    kind: z.literal("bestNth"),
    nth: z.number().int().min(1),
    count: z.number().int().min(1),
    normaliseUnequalPools: z.boolean().optional(),
  })
  .strict();
const PicksTakeS = z.object({ kind: z.literal("picks"), picks: z.array(PoolRankPickS).min(1) }).strict();
// L3/#414 — losers of a completed bracket round (KO->plate, qualifying-KO
// wildcards). `round` is a bracket-wiring label, never an arithmetic
// quantity (rounds number sparsely — see progression.ts's roundLosers).
// `count` is REQUIRED, mirroring the engine exactly: `progressionSize` reads
// `roundLosers.count` unconditionally, so an optional count here would let a
// malformed spec 400 loudly at create time only to 500 later, deep inside a
// read path that must never throw.
const RoundLosersTakeS = z
  .object({ kind: z.literal("roundLosers"), round: z.number().int().min(1), count: z.number().int().min(1) })
  .strict();
export const TakeRuleSchema = z.union([RankRangeTakeS, TopNPerGroupTakeS, BestNthTakeS, PicksTakeS, RoundLosersTakeS]);

// The single-source tie (ruling 55, CL-R2): what this schema parses and the
// engine's TakeRule must be assignable BOTH ways. One direction alone is not
// enough — wire→engine fails only for a schema that is too LOOSE (a wider
// field, an extra kind); engine→wire fails only for one that is too STRICT
// (a missing kind, a required field the engine has as optional).
//
// Compared twice. (1) Deep-readonly on both sides, because zod infers
// mutable arrays where the engine declares `readonly PoolRankPick[]` —
// mutability is not a wire property. (2) Additionally with every optional
// made required, because plain assignability cannot see an OPTIONAL field
// that exists on one side only (`normaliseUnequalPools` dropped from the
// schema would pass (1) in both directions).
//
// Value-level rules (min/max/int, .strict(), the rankRange refine) are
// runtime and invisible here; __tests__/take-rule-schema.test.ts parses every
// shipped template's take rules through this schema for that half.
type WireDeepReadonly<T> = T extends readonly (infer E)[]
  ? readonly WireDeepReadonly<E>[]
  : T extends object
    ? { readonly [K in keyof T]: WireDeepReadonly<T[K]> }
    : T;
type WireDeepRequired<T> = T extends readonly (infer E)[]
  ? readonly WireDeepRequired<E>[]
  : T extends object
    ? { readonly [K in keyof T]-?: WireDeepRequired<Exclude<T[K], undefined>> }
    : T;
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;
type TakeRuleWire = z.infer<typeof TakeRuleSchema>;
export type TakeRuleSchemaMatchesEngine = AssertTrue<
  MutuallyAssignable<WireDeepReadonly<TakeRuleWire>, WireDeepReadonly<TakeRule>>
>;
export type TakeRuleSchemaMatchesEngineFields = AssertTrue<
  MutuallyAssignable<WireDeepRequired<TakeRuleWire>, WireDeepRequired<TakeRule>>
>;

const SeededMapEntryS = z.object({ slot: z.string().min(1).max(20), source: z.string().min(1).max(40) }).strict();

const ProgressionSourceS = z
  .object({
    stage: z.union([z.literal("previous"), z.object({ stageId: Uuid }).strict()]),
    take: z.array(TakeRuleSchema).min(1).max(8),
  })
  .strict();

// Decision 1 (F2 plan) — `timing` is the axis the design doc's own proposed
// shape omitted: whether this stage's fixtures appear at setup, as TBD
// placeholders (old `.seeding`), or only once every source stage completes
// (old `.qualification`). Required, no default — ruling 5's "strict
// constraints from day one, no permissive interim state". Multi-source
// `sources[]` (new capability — Finding 1: it never actually worked
// server-side before F2) is enforced for dedupe at RESOLUTION time
// (resolveProgression), not at parse time — two sources are both
// independently well-formed here even if they could later name the same
// entrant.
export const ProgressionSchema = z
  .object({
    sources: z.array(ProgressionSourceS).min(1).max(8),
    placement: z.enum(["seeded_map", "snake", "rank_order"]),
    map: z.array(SeededMapEntryS).max(64).optional(),
    timing: z.enum(["setup", "on_complete"]),
    // Carry prior points/metrics into the qualified stage's opening
    // standings (Jul3/05 §3) — like `timing`, an apps/web/DB-orchestration
    // concept the engine's pure ProgressionSpec has no notion of (take-rule
    // expansion/placement/resolution math never reads it). Restored from
    // the old QualificationSpec.carry: this plan's own grounding said no
    // shipped writer sets it (true for format-templates.ts/the catalogue),
    // but custom-points.test.ts exercises it end to end against a
    // hand-built stage graph, and it backs a MARKETED Pro entitlement
    // (standings.carry_over — feature-copy.ts's paywall copy,
    // pricing.matrix.standings.carry_over in all 4 marketing dictionaries).
    // Deleting it would silently break a paid, advertised feature.
    // Accepted on BOTH timings as of F6. Applied in seedNextStage for
    // `on_complete` and in confirmSeedProposal for `setup`. computeSeedProposal
    // refuses a non-real source at propose time (HttpError 422
    // SEEDING_CARRY_SOURCE_INVALID); confirm re-checks the same belt before
    // writing `carry_deltas` + one `standings_carried` event.
    // A refine here used to reject the pair outright, because carry was
    // read only under `on_complete` and the entitlement gate
    // (`progression?.carry`, timing-agnostic) would otherwise have charged
    // the org's `standings.carry_over` for a silent no-op.
    carry: z.enum(["none", "points", "full"]).optional(),
  })
  .strict()
  .refine((s) => s.placement !== "seeded_map" || (s.map !== undefined && s.map.length > 0), {
    message: "seeded_map placement needs a non-empty map",
    path: ["map"],
  });
export type ProgressionInput = z.infer<typeof ProgressionSchema>;

/**
 * A stage's `config`, with the KEY SET closed.
 *
 * `CreateStage` below has been `.strict()` since F2 Task 5, but `config` was
 * `z.record(z.string(), z.unknown())` — so the very bug that strictness was
 * added to stop survived one level down. A misspelled `byes`, `slotOrder` or
 * `legs` inside `config` parsed fine, was stored, was never read by anything,
 * and the product then seeded its own draw and returned 201. No error, no log.
 * The organiser sees a draw they did not ask for and has nothing to go on.
 *
 * Two deliberate halves:
 *
 * KEYS are closed. That is the defect, and only `.strictObject` fixes it.
 * Every key below has a real reader; omitting one would make it permanently
 * unreachable, because `CreateStage` is the ONLY client write path (there is
 * no PatchStage/UpdateStage) and the server's own later writes —
 * `config.ladder_order` at `usecases/stages.ts:3385`, and `qualified` /
 * `cross_feeds` / `rank_overrides` / `carry_deltas` / `rngSeed` — round-trip
 * through rows this schema has to be a superset of. The list was derived by
 * enumerating every reader and every writer, not typed from memory.
 *
 * VALUES are typed only where THIS file is the authority. `points` belongs to
 * the engine's `PointsRule`, `shootout`/`extraTime` to each sport module's
 * `configSchema` (`packages/engine/src/sport/module.ts`), and `cross_feeds` /
 * `placements` / `rank_overrides` / `carry_deltas` to the usecases that read
 * them. Restating those shapes here would create a second copy of a fact that
 * already has an owner — which is exactly how two shapes of one fact drift
 * apart, and exactly why `tools/bench/lib/pack-schema.ts:456` deliberately
 * declined to copy this vocabulary. `z.unknown()` means "this key is real,
 * its shape is someone else's to enforce".
 *
 * Net effect for the bench: a pack no longer needs its own copy of this
 * vocabulary to catch a typo, because the product now rejects one at the
 * door — which is the guarantee `pack-schema.ts` wanted and could not give
 * itself.
 */
export const StageConfig = z
  .strictObject({
    // League / group shape.
    legs: z.number().int().min(1).max(8).optional(),
    pools: z.strictObject({ count: z.number().int().min(1) }).optional(),
    // Knockout shape. `byes` are entrant ids; `slotOrder` is a draw order with
    // `null` for an empty slot — the two fields §18.2 was raised about.
    thirdPlace: z.boolean().optional(),
    byes: z.array(z.string()).optional(),
    slotOrder: z.array(z.number().int().nullable()).optional(),
    bracketReset: z.boolean().optional(),
    // Americano / Mexicano.
    mode: z.enum(["americano", "mexicano"]).optional(),
    courtCount: z.number().int().min(1).optional(),
    // Swiss (also `rounds`).
    rounds: z.number().int().min(1).optional(),
    chess: z.boolean().optional(),
    // Which pairing model the swiss generator uses. Mirrors the engine's
    // `SwissConstraints.pairing` (packages/engine/src/scheduling/swiss.ts) —
    // spelled out rather than imported because this file may not reach into
    // `@/` or the engine (see the import-boundary note at the top). OMITTED
    // is the fold default: every swiss stage that predates Swiss Playoff
    // carries no `pairing` key and must keep folding top-vs-bottom, so this
    // deliberately has NO `.default()`.
    pairing: z.enum(["fold", "rank_adjacent"]).optional(),
    // Ladder.
    challengeRange: z.number().int().min(1).optional(),
    ladder_order: z.array(z.string()).optional(),
    // Seeding / standings, any kind.
    qualified: z.array(z.string()).optional(),
    h2h_scope: z.literal("overall").optional(),
    rngSeed: z.number().optional(),
    // Shapes owned elsewhere — key allowed, value left to its own authority.
    points: z.unknown().optional(),
    carry_deltas: z.unknown().optional(),
    rank_overrides: z.unknown().optional(),
    cross_feeds: z.unknown().optional(),
    placements: z.unknown().optional(),
    shootout: z.unknown().optional(),
    extraTime: z.unknown().optional(),
    /** Per-stage match-format override (design 2026-09-17 §T3). Deliberately
     *  LOOSE here: this file is executed by `scripts/openapi-gen.ts` under bare
     *  `node --experimental-strip-types`, which parses neither `@/` imports nor
     *  JSX, so it cannot see the per-sport rules table. The real per-sport
     *  allowlist and the merged-config validation live in
     *  `usecases/stage-rules.ts`, which can import it. Nothing may WRITE this
     *  key through a stage-config body — `createStages`/`replaceStages` refuse
     *  it (D2a); `PUT /stages/{id}/rules` is the only writer. */
    rules: z.record(z.string(), z.unknown()).nullish(),
  })
  .default({});

// F2 Task 5 — .strict(): before this, an unknown key (the old
// .qualification/.seeding shape, or any typo) parsed successfully with the
// key silently STRIPPED — stages-panel.tsx's live "Add stage" POST
// (qualification: {topN}) created a stage with progression: null, returned
// 201, and generated nobody. No error, no log, ever. Strict converts that
// whole class of bug from silent to loud: the same POST now 400s, naming the
// offending key (zod's unrecognized_keys issue). `config` carries the same
// guarantee one level down since 2026-09-10 — see StageConfig above.
export const CreateStage = z
  .object({
    seq: z.number().int().min(1),
    kind: StageKind,
    name: z.string().min(1).max(200),
    config: StageConfig,
    progression: ProgressionSchema.nullish(),
  })
  .strict();

/** POST /divisions/{id}/stages — the stage graph, one or many (doc 08 §3). */
export const CreateStages = z.union([CreateStage, z.array(CreateStage).min(1).max(20)]);

/** POST /stages/{id}/fixtures — ad-hoc single fixture (PROMPT-66).
 *
 *  P9 pass 3c-2: this was the one writer the venues/courts cutover missed —
 *  it still took a free-text `venue`. Real venue/court by id now, same as
 *  `PatchFixture`. `.strict()` for the same reason that schema documents: a
 *  client still sending `venue` gets a loud 400 instead of a silent no-op. */
// ---------------------------------------------------------------------------
// #622 — stage- and round-scoped required court tags
// ---------------------------------------------------------------------------

/** A `roundRoleKey()` value from `@seazn/engine/competition` — `final`,
 *  `semi_final`, `quarter_final`, `round_of_16`, `losers_round_2`,
 *  `grand_final`, `rung_3`, `plain_round_4`, … The usecase re-validates with
 *  `isRoundRoleKey()`, which is the authoritative vocabulary; this pattern is
 *  the cheap shape gate in front of it, deliberately not a duplicate of the
 *  role list (a second copy would go stale the next time a stage format ships
 *  a new role). */
const RoundRoleKey = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, "not a round role key");

export const StageRoundCourtTags = z.object({
  round_role: RoundRoleKey,
  required_court_tags: RequiredCourtTags,
});

/** PUT semantics on `rounds`: whole-list replace, so an omitted round is
 *  DELETED. Omitting the KEY itself leaves the stage's round rules untouched —
 *  the two are different, which is why neither field has a default. */
export const PutStageCourtTags = z
  .object({
    required_court_tags: RequiredCourtTags,
    rounds: z.array(StageRoundCourtTags).max(64),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "empty patch");
export type PutStageCourtTags = z.infer<typeof PutStageCourtTags>;

export const StageCourtTags = z.object({
  stage_id: Uuid,
  required_court_tags: z.array(z.string()),
  rounds: z.array(StageRoundCourtTags),
  /** The roles this stage's fixtures currently occupy, in bracket order — a
   *  picker source, never a constraint on what may be written (a stage whose
   *  fixtures are not generated yet occupies none). */
  available_round_roles: z.array(z.string()),
});

/** Per-stage match-format override (design 2026-09-17 §T3). A WHOLE-FRAGMENT
 *  replace: what you send is what the stage carries, and `rules: null` clears
 *  it back to the division's format. Values are unconstrained HERE for the
 *  openapi-gen reason on `StageConfig.rules` above; `usecases/stage-rules.ts`
 *  enforces the per-sport allowlist (400 UNKNOWN_RULE_KEY), the sets-based
 *  sport gate (400 SPORT_NOT_SUPPORTED), the merged-config parse (422
 *  CONFIG_INVALID) and the per-stage lock (409 STAGE_FORMAT_LOCKED). */
export const PutStageRules = z.object({
  rules: z.record(z.string(), z.unknown()).nullable(),
});
export type PutStageRules = z.infer<typeof PutStageRules>;

export const StageRules = z.object({
  rules: z.record(z.string(), z.unknown()).nullable(),
});

export const AddFixture = z
  .object({
    home_entrant_id: Uuid,
    away_entrant_id: Uuid,
    round_no: z.number().int().min(1).optional(),
    scheduled_at: z.string().datetime({ offset: true }).nullish(),
    venue_id: VenueId.nullish(),
    court_id: CourtId.nullish(),
  })
  .strict();
export type AddFixture = z.infer<typeof AddFixture>;
export type CreateStages = z.infer<typeof CreateStages>;

// F2 — READ-path shape (Task 6): the two old columns this response used to
// expose (qualification/seeding) were dropped by V374; API consumers now
// see the one unified field. Deliberately `z.record(...).nullable()`, not
// `ProgressionSchema.nullable()` — a response schema should not 400 a row
// this API itself wrote (defence-in-depth against a shape ProgressionSchema
// would reject slipping in through a future direct-SQL writer), matching
// this field's pre-F2 precedent (`qualification`/`seeding` were never
// validated on the way OUT either).
export const Stage = z.object({
  id: Uuid,
  division_id: Uuid,
  seq: z.number().int(),
  kind: StageKind,
  name: z.string(),
  config: z.record(z.string(), z.unknown()),
  progression: z.record(z.string(), z.unknown()).nullable(),
  status: z.enum(["pending", "active", "complete"]),
});

// ---------------------------------------------------------------------------
// Templates (D1a design doc, P4) — curated built-ins only, v1: no
// user-generated templates, no sharing. `checkDateOrder` is the SAME
// superRefine CreateCompetition uses; a template still needs real dates,
// only the structure comes from the catalog.
// ---------------------------------------------------------------------------

export const CreateFromTemplate = z
  .object({
    template_key: z.string().min(1),
    /** Optional stale-catalog guard: when present, must match the catalog's
     *  CURRENT version for this key, else 409 template.version_retired — a
     *  wizard detail sheet that sat open across a catalog deploy must not
     *  silently instantiate a different shape than what was reviewed. */
    template_version: z.number().int().positive().optional(),
    name: z.string().min(1).max(200),
    starts_on: z.iso.date().nullish(),
    ends_on: z.iso.date(),
    /** Public by default, same ruling and same degrade as CreateCompetition —
     *  the two create paths must not disagree about what an omitted
     *  visibility means. */
    visibility: Visibility.default("public"),
  })
  .superRefine(checkDateOrder);
export type CreateFromTemplate = z.infer<typeof CreateFromTemplate>;

const TemplateStageResultS = z.object({ id: Uuid, fixtureCount: z.number().int().min(0) });
const TemplateDivisionResultS = z.object({ id: Uuid, stages: z.array(TemplateStageResultS) });
export const FromTemplateResult = z.object({
  competitionId: Uuid,
  /** So the wizard can navigate straight to the created competition page —
   *  same pattern the blank-form wizard already uses off its own POST. */
  slug: Slug,
  /** The visibility that was ACTUALLY applied (T20). `createCompetition`
   *  returns the whole row, so its caller could always diff requested against
   *  created; this result carried no visibility at all, which is why the
   *  template gallery — the DEFAULT create path, the one `/competitions/new`
   *  opens on — redirected unconditionally into a silently private
   *  competition whose public link 404s. */
  visibility: Visibility,
  /** Present ONLY when the public-dashboard cap turned this create private —
   *  the same note POST /competitions carries, deliberately the same field
   *  name and the same shape so one concept has one name on both create
   *  paths. */
  public_quota_degraded: PublicQuotaDegraded.optional(),
  divisions: z.array(TemplateDivisionResultS),
  templateKey: z.string(),
  templateVersion: z.number().int(),
});
export type FromTemplateResult = z.infer<typeof FromTemplateResult>;

// ---------------------------------------------------------------------------
// Fixtures, lineups, scoring
// ---------------------------------------------------------------------------

export const PatchFixture = z
  .object({
    scheduled_at: z.iso.datetime({ offset: true }).nullable(),
    // P9 pass 3a (venues/courts cutover, FULL — not a compatibility shim):
    // `venue`/`court_label` free text leave the wire entirely. A request
    // names a real venue/court by id; `court_label`/`venue` stay in the DB,
    // unwritten, until the drop PR.
    venue_id: VenueId.nullable(),
    court_id: CourtId.nullable(),
    officials: z.array(z.record(z.string(), z.unknown())),
    /** Pin/lock (doc 12 §2): locked assignments survive re-running auto. */
    schedule_locked: z.boolean(),
    /** Optimistic token (v3/11 gap 10): the division seq the client loaded.
     *  Stale → 409 SEQ_CONFLICT, the board refetches and toasts. */
    expected_seq: z.number().int().nonnegative(),
  })
  .partial()
  // P9 pass 3a: `.strict()` so a client still sending the retired
  // `court_label`/`venue` gets a loud 400 instead of a silent no-op — a
  // plain (non-strict) object schema STRIPS an unknown key rather than
  // refusing it, and "I set court_label but the fixture never moved, with
  // no error" is a far worse failure than a 400 telling the client its
  // field name is gone. Same reasoning `ApplyCompetitionScheduleRequest`'s
  // own `.strict()` documents.
  .strict()
  .refine((p) => Object.keys(p).length > 0, "empty patch");
export type PatchFixture = z.infer<typeof PatchFixture>;

/** PUT /fixtures/{id}/stream (stream overlay W1). `.strict()` for the reason
 *  `PatchFixture` documents: a client sending `stream_url` (snake) instead of
 *  `streamUrl` gets a loud 400 rather than a silent no-op. The value is
 *  validated by the ONE allowlist both this route and the organiser panel
 *  share (`@/lib/stream-url`, R16) — never a second host list here. */
export const PutFixtureStream = z.object({ streamUrl: streamUrlSchema }).strict();
export type PutFixtureStream = z.infer<typeof PutFixtureStream>;

export const FixtureStream = z.object({
  id: z.string(),
  stream_url: z.string().nullable(),
});
export type FixtureStream = z.infer<typeof FixtureStream>;

// ---------------------------------------------------------------------------
// Streaming R1 — relay sessions (design §6.3 / §6.4 / §7.6). Every shape a
// route or the panel exchanges lives here; the QR payload's schema is
// lib/capture-qr.ts (client-safe — the panel renders it) and is RE-EXPORTED,
// never re-typed (imported at the top of this file with the other relative
// `.ts` imports the standalone OpenAPI generator needs).
// ---------------------------------------------------------------------------
export { CaptureQrV1 };

export const StreamMode = z.enum(["passthrough", "composed"]);
export type StreamMode = z.infer<typeof StreamMode>;
export const StreamSessionState = z.enum(["requested", "provisioning", "warming", "live", "ending", "completed", "failed"]);
export type StreamSessionState = z.infer<typeof StreamSessionState>;
/** §6.4 — NOT storage_exhausted (E5: a create-time refusal with no row). */
export const StreamFailReason = z.enum([
  "no_inbound_timeout", "target_rejected", "no_credits",
  // the Fly machine lifecycle's reasons (plan §"Fly machine lifecycle"; domain/runner.ts RunnerFailReason)
  "machine_create_failed", "machine_boot_timeout", "machine_exit_nonzero", "machine_oom", "machine_crash",
  // The two TIMED exits the domain's expiry owns (Task 2B `evaluate`): a create
  // that never finished (F16) and a row admitted but never provisioned (F18).
  // They belong HERE and not in StreamEndReason: a failed session carries no
  // end reason at all (P1-F-b). Eleven members — the copy map (Task 13) is total
  // over this enum, so adding one here owes four dictionary keys there.
  "provision_timeout", "admission_timeout",
  // M10 (Task 14b review): a deployment with no relay ended a session left up from before.
  "relay_disabled",
]);
/** How a COMPLETED session ended — the deadline is not a failure. Capture QR v2 (T6, §5.3): the five DB reasons
 *  (domain/end-reason.ts `DB_END_REASONS`, V430's end_reason check) — the organiser's Stop, the phone operator's
 *  Stop (W12), the automatic stop after the result (W7), the phone and its video gone (W19), and the wall clock.
 *  stream-contract.test.ts pins this list against both. */
export const StreamEndReason = z.enum(["stopped", "operator_stopped", "auto_stopped", "phone_lost", "max_duration"]);
export type StreamEndReason = z.infer<typeof StreamEndReason>;
export type StreamFailReason = z.infer<typeof StreamFailReason>;
export const StreamTargetKind = z.enum(["youtube", "facebook", "twitch", "kick", "custom_rtmp"]);
export type StreamTargetKind = z.infer<typeof StreamTargetKind>;

export const CreateStreamSession = z
  .object({ mode: StreamMode, targetId: z.string().uuid(), themeId: z.string().min(1).max(40).optional() })
  .strict();
export type CreateStreamSession = z.infer<typeof CreateStreamSession>;
export const StreamSessionCreated = z.object({ sessionId: z.string() });
export type StreamSessionCreated = z.infer<typeof StreamSessionCreated>;

export const StreamHealth = z.object({
  fps: z.number().nullable(),
  bitrateKbps: z.number().nullable(),
  lastBeatAt: z.string().nullable(),
});
export type StreamHealth = z.infer<typeof StreamHealth>;
/** C6: the ingest STATE, worded as what it is — never "healthy". */
export const StreamIngest = z.object({
  state: z.enum(["connected", "disconnected", "unknown"]),
  protocol: z.enum(["srt", "rtmps"]).nullable(),
});
export type StreamIngest = z.infer<typeof StreamIngest>;
/** D3 (spec §5.6) — the destination's side of a passthrough broadcast. For a non-ok `state`, `since` is when the
 *  destination last received — the start of the current not-ok period, however its word changed inside it (I1, B2
 *  review); for `ok`, when it began receiving. Clamped to go-live (the destination is not tried before it). `connecting`
 *  is still dialling, never ok. `elapsedMs` is `now - since` on the SERVER's clock at this response (M6): the client
 *  judges the 30 s warning on it, never on its own clock, so a browser running ahead cannot warn early. */
export const StreamOutput = z.object({
  state: z.enum(["ok", "connecting", "rejected", "unknown"]),
  since: z.string(),
  elapsedMs: z.number().int().nonnegative(),
});
export type StreamOutput = z.infer<typeof StreamOutput>;

export const StreamSessionCurrent = z
  .object({
    id: z.string(),
    fixtureId: z.string(),
    mode: StreamMode,
    state: StreamSessionState,
    desiredState: z.enum(["live", "ending"]),
    failReason: StreamFailReason.nullable(),
    health: StreamHealth.nullable(),
    ingest: StreamIngest.nullable(),
    /** D3: null for a composed session, and whenever the server's poll did not read the destination (not warming/live,
     *  or the provider read failed) — never a default object. */
    output: StreamOutput.nullable(),
    /** Present only while provisioning/warming and only when the slot row exists — else null, never a default object. */
    qr: CaptureQrV1.nullable(),
    balance: z.number().int(),
    startedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    replayUrl: z.string().nullable(),
    target: z.object({ id: z.string(), kind: StreamTargetKind, label: z.string() }),
    fixtureDecided: z.boolean(),
    endReason: StreamEndReason.nullable(),
    /** True iff THIS session's own consume still stands: the sum of its `consume` + `refund` credit rows is below zero.
     *  A restart inside the reuse window consumed nothing, and a refund linked to the session nets its consume out —
     *  both read false, so the "1 credit used" chip is never a false money claim (lane D D3). */
    creditUsed: z.boolean(),
    /** I-1 (lane-close review): true iff a new start on THIS fixture would cost nothing right now — a consume of this
     *  fixture still stands inside the reuse window (§5.2 "a restart after a failure is the same match"). Computed through
     *  the one authority admission asks (`reuseWindowOpen`), so the Phone tab never sells a pack for a restart the server
     *  would admit at balance 0. A fixture fact, not this session's: a restart that consumed nothing still reads true. */
    restartFree: z.boolean(),
    /** Capture QR v2 §5.3 (T6): who started this session — the organiser's Go live, the phone operator's start, or
     *  the automatic start. V430's start_cause; set at creation and never changed. */
    startCause: z.enum(["organiser", "operator", "automatic"]),
  })
  .strict();
export type StreamSessionCurrent = z.infer<typeof StreamSessionCurrent>;

/** Capture QR v2 §6.1 / §9 (T5): the stable stream code as the organiser's panel shows it — `POST …/stream-code` (ensure)
 *  and `POST …/stream-code/reissue`. `qr` is the v2 payload (lib/capture-qr.ts, re-used, never re-typed); `issuedAt`
 *  is when this code was minted, so a re-show answers the same instant. Served `private, no-store`: the tok is live. */
export const StreamCodeShown = z.object({ qr: CaptureQrV2, issuedAt: z.string() }).strict();
export type StreamCodeShown = z.infer<typeof StreamCodeShown>;
/** §6.7.3: the destination pre-pick. PR-1 carries `targetId` only (PR-2 adds `autoStream`); `null` clears it. */
export const PutStreamSettings = z.object({ targetId: z.string().uuid().nullable() }).strict();
export type PutStreamSettings = z.infer<typeof PutStreamSettings>;
export const StreamSettings = z.object({ targetId: z.string().uuid().nullable() }).strict();
export type StreamSettings = z.infer<typeof StreamSettings>;

/** D6: the platforms a NEW destination may name — a subset of `StreamTargetKind`, which stays whole for stored rows. */
export const StreamPlatform = z.enum(STREAM_PLATFORMS);
export type StreamPlatform = z.infer<typeof StreamPlatform>;

export const CreateStreamTarget = z
  .object({
    kind: StreamPlatform,
    label: z.string().min(1).max(80),
    /** The platform's stream key. The ingest URL is filled by the server from the platform's preset
     *  (lib/stream-destinations.ts STREAM_PLATFORM_PRESETS) — there is no url field (spec §5.2). */
    streamKey: z.string().min(1).max(200),
    /** The destination's PUBLIC watch link (R16 allowlist) — what the replay fill copies. */
    watchUrl: streamUrlSchema.optional(),
  })
  .strict();
export type CreateStreamTarget = z.infer<typeof CreateStreamTarget>;

/** Spec §5.3 — the session holding a destination. Nullable fields: a holder whose fixture was deleted
 *  (`fixture_id` is `on delete set null`) still holds, and cannot be named or linked. `matchNo` is a number, never an
 *  English "Match n": every client renders it through its own locale's `breadcrumb.match`. */
export const StreamTargetHolder = z.object({
  sessionId: z.string(),
  fixtureId: z.string().nullable(),
  href: z.string().nullable(),
  matchNo: z.number().int().nullable(),
  courtName: z.string().nullable(),
  state: z.enum(["live", "waiting"]),
});
export type StreamTargetHolder = z.infer<typeof StreamTargetHolder>;

export const StreamTarget = z.object({
  id: z.string(),
  kind: StreamTargetKind,
  label: z.string(),
  watchUrl: z.string().nullable(),
  createdAt: z.string(),
  /** The key's last 3 characters, or null for a key under 12 characters or an envelope that will not open (§5.3). */
  keyHint: z.string().nullable(),
  inUse: StreamTargetHolder.nullable(),
});
export type StreamTarget = z.infer<typeof StreamTarget>;

/** How a create landed (secret-columns.ts `insertStreamTarget`, spec §5.2 create order): `existing` — the key is already
 *  an active destination, returned UNCHANGED (A19, owner decision (a): the typed name and watch link are not applied);
 *  `restored` — a removed one brought back under the typed name and watch link (D2); `inserted` — a new row. */
export const StreamTargetSaveOutcome = z.enum(["existing", "restored", "inserted"]);
export type StreamTargetSaveOutcome = z.infer<typeof StreamTargetSaveOutcome>;
/** POST /orgs/{id}/stream-targets — the stored row as the list reads it, plus how the save landed. */
export const StreamTargetSaved = StreamTarget.extend({ outcome: StreamTargetSaveOutcome });
export type StreamTargetSaved = z.infer<typeof StreamTargetSaved>;

/** Spec §5.2 — Rename (`{label}`, allowed at any time) or Replace key (`{streamKey}`, refused while held). Exactly one. */
export const PatchStreamTarget = z
  .object({ label: z.string().min(1).max(80).optional(), streamKey: z.string().min(1).max(200).optional() })
  .strict()
  .refine((b) => (b.label === undefined) !== (b.streamKey === undefined), { message: "send exactly one of label or streamKey" });
export type PatchStreamTarget = z.infer<typeof PatchStreamTarget>;
export const StreamTargetRemoved = z.object({ removed: z.literal(true) });

/** The Machine's beat (§6.3) — the control channel; the reply carries desired_state. */
export const RelayHeartbeat = z
  .object({
    state: z.enum(["starting", "playing", "stalled", "stopped"]),
    videoState: z.string().max(40).nullable().optional(),
    fps: z.number().nonnegative().nullable().optional(),
    bitrateKbps: z.number().nonnegative().nullable().optional(),
    egressBytes: z.number().int().nonnegative().optional(),
    measuredLatencyMs: z.number().int().nonnegative().nullable().optional(),
    // A29 — the encoder facts the R2 supervisor can read off ffmpeg. All
    // OPTIONAL: the supervisor sends what it has, and a field it omits is NULL
    // in the sample rather than a zero that reads as "measured and fine".
    // Declared HERE, in the one schema the route parses; Task 10's `heartbeat`
    // is their only consumer and writes them to typed sample columns.
    droppedFrames: z.number().int().nonnegative().nullable().optional(),
    encoderSpeed: z.number().nonnegative().nullable().optional(),
    cpuPct: z.number().nonnegative().nullable().optional(),
    memMb: z.number().nonnegative().nullable().optional(),
  })
  .strict();
export type RelayHeartbeat = z.infer<typeof RelayHeartbeat>;
export const RelayHeartbeatReply = z.object({ desiredState: z.enum(["live", "ending"]) });
export type RelayHeartbeatReply = z.infer<typeof RelayHeartbeatReply>;

/** D4a (P5) i18n pattern ref for a not-yet-filled slot — {key, params}, never
 *  a prebuilt string. Named rather than inlined because THREE published
 *  schemas carry it (Fixture, AssignedFixture) and a per-schema copy is how
 *  two shapes of the same field drift apart. */
export const SlotLabelRef = z
  .object({ key: z.string(), params: z.record(z.string(), z.unknown()) })
  .nullable();

export const Fixture = z.object({
  id: Uuid,
  stage_id: Uuid,
  division_id: Uuid,
  pool_id: Uuid.nullable(),
  round_no: z.number().int(),
  seq_in_round: z.number().int(),
  /** Per-division ordinal (PROMPT-30) — the `/f/{no}` public URL segment.
   *  Declared here because it is already SERVED: `FIXTURE_COLS` selects it and
   *  every fixture route returns its row unmapped. Nothing applies a response
   *  schema at runtime, so its absence was a silent gap between the published
   *  spec and the real payload rather than a missing field. */
  fixture_no: z.number().int(),
  home_entrant_id: Uuid.nullable(),
  away_entrant_id: Uuid.nullable(),
  /** D4a (P5): i18n pattern ref for a not-yet-filled slot ("Winner Group A"),
   *  {key, params} — never a prebuilt string. Cleared on fill (design's Fill
   *  algorithm step 4); non-null only while the matching *_entrant_id is null. */
  home_slot_label: SlotLabelRef,
  away_slot_label: SlotLabelRef,
  scheduled_at: z.string().nullable(),
  // P9 pass 3c-2: court_id/venue_id + derived, read-only court_name/
  // venue_name — same shape as ScheduleAssignment. The frozen `venue`/
  // `court_label` text columns leave the wire entirely here (unlike the
  // general internal FixtureRow, which keeps them for callers not yet
  // migrated): this is the published v1 API contract, the highest-visibility
  // reader, and the one place P9 makes a clean break rather than adding
  // alongside. A client still reading `court_label` off this response
  // needs to move to `court_name` — there is no compatibility shim.
  court_id: CourtId.nullable(),
  court_name: z.string().nullable(),
  venue_id: VenueId.nullable(),
  venue_name: z.string().nullable(),
  officials: z.array(z.unknown()),
  status: z.enum(["scheduled", "in_play", "decided", "finalized", "abandoned", "forfeited", "cancelled"]),
  outcome: z.unknown().nullable(),
  schedule_source: z.enum(["none", "auto", "manual", "ai"]),
  schedule_locked: z.boolean(),
  created_at: z.string(),
  /** F1 (2026-08-17): the engine's bracket-position role, persisted instead
   *  of re-derived per consumer (V374/V369). Declared here for the same
   *  reason as `fixture_no` above — `FIXTURE_COLS` now selects it and every
   *  fixture route returns its row unmapped, so leaving it undocumented
   *  would be a silent gap between the published spec and the real
   *  payload, not a missing field. `.optional()`, unlike `fixture_no`: a
   *  real response always sends it, but dozens of pre-existing tests
   *  `Fixture.parse()` a hand-built row literal that predates these five
   *  fields, and `.optional()` is this schema's own established way of
   *  landing a new response field without breaking every one of them
   *  (see ScheduleSolverInfo's later fields for the same convention). */
  ext_key: z.string().nullable().optional(),
  lane: z.enum(["WB", "LB", "GF"]).nullable().optional(),
  is_final: z.boolean().optional(),
  third_place: z.boolean().optional(),
  conditional: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Competition desk (W3 Task 6): the in-play band's producer, served bare by
// GET /competitions/{id}/desk (usecases/competition-desk.ts's
// `getCompetitionDesk`, "one shape, two doors" — the SSR page reads the same
// function directly). Mirrors that module's exported interfaces field for
// field.
// ---------------------------------------------------------------------------

export const DeskInPlayFixture = z.object({
  id: Uuid,
  division_id: Uuid,
  division_name: z.string(),
  home: z.string().nullable(),
  away: z.string().nullable(),
  fixture_no: z.number().int(),
  event_count: z.number().int(),
  started_at: z.string().nullable(),
});

/** competition-desk.ts's `DeskNextFixture` (`Omit<NextFixture, "court_label">`) —
 *  no existing schema to reuse: `NextFixture` (card-stats.ts) has never
 *  crossed the wire before this route. */
export const DeskNextFixture = z.object({
  home: z.string().nullable(),
  away: z.string().nullable(),
  scheduled_at: z.string().nullable(),
  in_play: z.boolean(),
});

export const CompetitionDesk = z.object({
  in_play: z.number().int(),
  // Ordered by kickoff ascending, nulls last — see getCompetitionDesk. The
  // SAME rows `in_play` above counts: `in_play === in_play_fixtures.length`
  // always (competition-desk.test.ts's Task 6 case pins this).
  in_play_fixtures: z.array(DeskInPlayFixture),
  up_next: DeskNextFixture.nullable(),
  // The usecase's own type is `Map<string, DeskDivision>` — a bare Map
  // serialises to `{}` over JSON (no own enumerable properties), so the
  // route converts it with `Object.fromEntries` before this schema ever
  // sees it. Left loosely typed rather than a full `DeskDivision` mirror:
  // no consumer of this wire contract reads inside `divisions` yet (the W3
  // band reads only in_play/in_play_fixtures/up_next), and DeskDivision's
  // own shape (division-phase.ts's `Attention` discriminated union, etc.)
  // has no established Zod schema to reuse — inventing one is out of this
  // task's scope.
  divisions: z.record(z.string(), z.unknown()),
  now: z.string(),
});

export const LineupSlotInput = z.object({
  person_id: Uuid,
  slot: z.enum(["starting", "bench"]).default("starting"),
  position_key: z.string().nullish(),
  order_no: z.number().int().min(1).nullish(),
  roles: z.array(z.string()).default([]),
  // S4 (#428) review round 1, finding 1 — V357. Mirrors LineupSlot.role
  // exactly. `.optional()`, NOT `.default()` — a `.default()` makes `role`
  // a REQUIRED key on the inferred `PutLineup` TS type, which would break
  // every existing caller that constructs a slots array without it
  // (`putLineup` is called directly, bypassing this schema, by
  // `usecases/__tests__/_seed.ts`-style test helpers and possibly future
  // internal callers — the same "who parses vs. who just gets the TS type"
  // seam `reference_usecase_vs_schema_seam` names elsewhere). The usecase
  // (`fixtures.ts`) falls back to `"player"` at the SQL boundary instead,
  // the same `?? default` idiom `position_key`/`order_no` already use on
  // the line above.
  role: z.enum(["player", "coach", "staff"]).optional(),
  // S12/#421 pass D — V361. Mirrors LineupSlot.pairOrder exactly (which of a
  // pair entrant's two bound members serves/plays first). `.nullish()`, the
  // same convention `order_no` already uses one line up: it stays optional
  // on the inferred PutLineup TS type (never required), and an explicit
  // `null` is a valid "no declared order" alongside an omitted key.
  pair_order: z.number().int().positive().nullish(),
});

export const PutLineup = z.object({
  slots: z.array(LineupSlotInput).max(100),
  // RS011: see CreateEntrant's field of the same name — a lineup can name a
  // person who was never gated at roster time (a pre-feature roster).
  eligibility_override: EligibilityOverride.optional(),
});
export type PutLineup = z.infer<typeof PutLineup>;

/** THE scoring request (doc 08 §4). */
export const AppendEventRequest = z.object({
  expected_seq: z.number().int().min(0),
  type: z.string().min(1).max(100), // 'cricket.ball', 'core.void', …
  payload: z.unknown(),
  idempotency_key: z.string().min(1).max(200).optional(),
});
export type AppendEventRequest = z.infer<typeof AppendEventRequest>;

/** P11 (D6) batch score-event import. `seq` is assigned server-side 1..n,
 *  gapless — a caller never sends one. (This said "0..n" until 2026-09-02; the
 *  implementation has always assigned `seq: i + 1` from the array index —
 *  `usecases/event-import.ts:289`, whose own comment at :282 correctly says
 *  "seq 1..n, gapless". Corrected because an offline replayer that mints
 *  0-based seq from this comment would disagree with the write path about
 *  event identity.) `core.void` is refused here rather than downstream:
 *  a void is a live-scoring undo, and a wrong import is re-run under a new
 *  import_id (owner ruling R2). */
export const EventImportRequest = z.object({
  import_id: z.string().min(1).max(200),
  streams: z.array(
    z.object({
      fixture: z.union([
        z.object({ id: z.uuid() }),
        z.object({ ext_key: z.string().min(1).max(200) }),
      ]),
      events: z.array(
        z.object({
          // `.max(100)` mirrors `AppendEventRequest.type` above, and is not
          // decoration. It was the one unbounded string in this request, in
          // the shape that carries up to `IMPORT_CAPS.eventsPerCall` (10,000)
          // of them per body — so the BATCH door stood wider than the
          // single-append door it batches. Nothing downstream narrows it
          // either: `score_events.type` is `text`, and a type the engine does
          // not know is refused by VALUE, at the fold, after the whole string
          // has travelled through resolution and into the report. The two
          // bounds are pinned equal by `schemas.test.ts`, so a change to one
          // that forgets the other is a red rather than a silent re-widening.
          type: z.string().min(1).max(100).refine((t) => t !== "core.void", {
            message: "core.void cannot be imported",
          }),
          payload: z.record(z.string(), z.unknown()).default({}),
          // A real ISO-8601 INSTANT, the same idiom every other timestamp in
          // this file uses. Not decoration: `at` lands in a `timestamptz`
          // column, the engine's own envelope only asks `.min(1)`, and the
          // dry-run fold never touches it — so a malformed value used to
          // survive every guard and raise Postgres 22007 inside the write
          // transaction, which is neither a unique violation nor an
          // EngineError and therefore rethrew as a 500, discarding the report
          // for streams that had already committed.
          at: z.iso.datetime({ offset: true }).optional(),
        }),
      ).min(1),
    }),
  ).min(1),
});
export type EventImportRequest = z.infer<typeof EventImportRequest>;

export const EventImportReport = z.object({
  importId: z.string(),
  totals: z.object({ imported: z.number(), skipped: z.number(), rejected: z.number() }),
  results: z.array(
    z.object({
      fixture: z.string(),
      status: z.enum(["imported", "skipped_duplicate", "rejected"]),
      eventsAppended: z.number(),
      outcome: z.unknown().optional(),
      error: z.object({ code: z.string() }).loose().optional(),
    }),
  ),
});

export const ScoreEvent = z.object({
  id: Uuid,
  seq: z.number().int(),
  type: z.string(),
  payload: z.unknown(),
  recorded_at: z.string(),
  recorded_by: Uuid.nullable(),
  voids_event_id: Uuid.nullable(),
  /** Doc 13 §7: set when the event arrived via a day-of device link. */
  device_link_id: Uuid.nullable(),
});

export const AppendEventResponse = z.object({
  seq: z.number().int(),
  state_summary: z.unknown(),
  outcome: z.unknown().nullable(),
  status: z.string(),
  /** The id of the row this append wrote (on an idempotent replay, the row the
   *  original append wrote) — the same id `GET /events` reports for it and a
   *  `core.void`'s `event_id` names. Lets a client hold the event under the
   *  server's id from the moment it lands. */
  event_id: Uuid,
});

export const FixtureState = z.object({
  fixture_id: Uuid,
  status: z.string(),
  last_seq: z.number().int(),
  summary: z.unknown(),
  state: z.unknown(),
  outcome: z.unknown().nullable(),
});

export const StandingsRowOut = z.object({
  entrantId: z.string(),
  rank: z.number().int(),
  played: z.number().optional(),
  points: z.number().optional(),
});

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export const CreateApiKey = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(ApiKeyScope).min(1).default(["read"]),
  /** Optional pin: the key only works inside this competition (v3/08 §2). */
  competition_id: Uuid.nullish(),
});
export type CreateApiKey = z.infer<typeof CreateApiKey>;

export const ApiKey = z.object({
  id: Uuid,
  name: z.string(),
  scopes: z.array(ApiKeyScope),
  competition_id: Uuid.nullable(),
  last_used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  created_at: z.string(),
});

export const CreatedApiKey = ApiKey.extend({
  /** The sc_ secret — returned exactly once, at creation. */
  secret: z.string(),
});

// ---------------------------------------------------------------------------
// Device links (doc 13 §7, PROMPT-21)
// ---------------------------------------------------------------------------

export const CreateDeviceLink = z.object({
  /** 'Court 3 phone' — organiser-facing label, optional. */
  label: z.string().min(1).max(100).nullish(),
});
export type CreateDeviceLink = z.infer<typeof CreateDeviceLink>;

export const DeviceLink = z.object({
  id: Uuid,
  fixture_id: Uuid,
  label: z.string().nullable(),
  issued_by: Uuid,
  expires_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  created_at: z.string(),
});

export const CreatedDeviceLink = DeviceLink.extend({
  /** The dl_ secret. Re-shown unchanged by ensure (sealed, scorer sheets §4.1); replaced only by reissue. QR payload = /score/{secret}. */
  secret: z.string(),
});

/** POST /competitions/{id}/exports/scorer-sheets (scorer sheets §4.4). */
export const ScorerSheetsRequest = z
  .object({
    /** One day to print, `YYYY-MM-DD` on the organisation's clock. */
    date: z.iso.date().optional(),
    /** Or a range (inclusive, either end optional). With `divisionId`, no date at all = every scheduled day. */
    dateFrom: z.iso.date().optional(),
    dateTo: z.iso.date().optional(),
    /** Narrow the sheet to one division of the competition. Omitted = every division. */
    divisionId: z.uuid().optional(),
    /** Page runs: by court (default), or by division with the court printed on each card. */
    groupBy: z.enum(["court", "division"]).optional(),
  })
  .refine((v) => v.date === undefined || (v.dateFrom === undefined && v.dateTo === undefined), {
    message: "date and dateFrom/dateTo are exclusive",
  })
  .refine((v) => v.divisionId !== undefined || v.groupBy === "division" || v.date !== undefined, {
    message: "date is required unless divisionId is given or groupBy is division",
  });

// ---------------------------------------------------------------------------
// Generate (fixtures) response
// ---------------------------------------------------------------------------

/** Swiss only: what a Generate/Pair-next press MOVED in the shell set, so the
 *  organiser can be told. Optional and omitted entirely when nothing moved —
 *  the ordinary Pair must not report four zeroes. Matches and byes are counted
 *  apart because only a match needs a court and a slot. */
export const SwissReshapeResult = z.object({
  matches_added: z.number().int(),
  matches_removed: z.number().int(),
  byes_added: z.number().int(),
  byes_removed: z.number().int(),
});

export const GenerateResult = z.object({
  created: z.number().int(),
  existing: z.number().int(),
  fixtures: z.array(Fixture),
  reshaped: SwissReshapeResult.optional(),
});

/** POST /stages/{id}/generate body. `pairing` = a ROUND-1-ONLY Swiss override
 *  (spec 2026-09-22); never stored. Absent body ≡ {}. */
export const GenerateStageInput = z.object({ pairing: z.enum(["fold", "rank_adjacent"]).optional() }).strict();
export type GenerateStageInput = z.infer<typeof GenerateStageInput>;

/** F3 Task 5 (5b) — POST /stages/{id}/rebuild's response: GenerateResult plus
 *  how many stale fixtures were deleted before regenerating. */
export const RebuildResult = GenerateResult.extend({
  removed: z.number().int(),
});

/** POST /stages/{id}/unpair — clears the latest seated Swiss round onto kept shells. */
export const UnpairResult = z.object({
  cleared: z.number().int(),
  round: z.number().int(),
});

export const CompleteResult = z.object({
  completed: z.boolean(),
  events: z.array(z.record(z.string(), z.unknown())),
  /** Set when completion resolved the next stage's progression rules. */
  qualified: z.object({ stage_id: Uuid, entrants: z.array(Uuid) }).optional(),
});

// ---------------------------------------------------------------------------
// Scheduling console (doc 12, PROMPT-17)
// ---------------------------------------------------------------------------

/** The wire key CAPACITY_IMPOSSIBLE's 422 carries its report under
 *  (`HttpError.extra`, spread verbatim onto `error.*` by api-v1/http.ts —
 *  no rename). Lives here, not in the server-only capacity-guard.ts,
 *  because openapi.ts documents it too and openapi.ts is NOT server-only
 *  (it's imported by /api/v1/openapi.json/route.ts, a live bundled route,
 *  as well as the CI drift script) — schemas.ts is the one home both
 *  capacity-guard.ts and openapi.ts can import without crossing that
 *  boundary. A P1 review finding: the throw site, the OpenAPI doc and
 *  smoke.ts's assertion had each spelled this differently (`report` vs
 *  `capacity_report`), so the smoke check could never pass. Import this,
 *  never retype the string. */
export const CAPACITY_REPORT_KEY = "capacity_report";

const IsoDateTime = z.iso.datetime({ offset: true });

/** Doc 12 §3 schedule_settings.config — the calendar pass inputs (05 §2.6). */
export const ScheduleConfig = z.object({
  startAt: IsoDateTime.nullish(),
  /** Last day the timetable runs — drives the week view's day span. */
  endAt: IsoDateTime.nullish(),
  matchMinutes: z.number().int().min(1).max(24 * 60).default(30),
  gapMinutes: z.number().int().min(0).max(24 * 60).default(0),
  /** V374 cutover: real court ids only, no tolerant string union — the
   *  migration IS the compatibility strategy (design doc "Stored-config
   *  migration"). The original design named `.min(1)`, dropped here: a
   *  division that has never configured courts parses `courts` as
   *  `undefined`, and zod's `.default()` substitutes WITHOUT re-running the
   *  array's own checks (verified against the installed zod@4.4.3 — an
   *  explicit `[]` DOES fail `.min(1)`, but a defaulted `[]` does not), so
   *  `.min(1)` cannot be paired with an empty-array default, and no static
   *  default can name a real per-org court id. An empty array is therefore a
   *  legitimate, parseable "no courts configured yet" state; the capacity
   *  guard already needs to treat zero usable courts as a first-class case
   *  (`capacity.no_matching_court`, design doc "Scheduler integration") —
   *  pass 3's job, not this one's. */
  courts: z.array(CourtId).max(50).default([]),
  perEntrantMinRest: z.number().int().min(0).max(24 * 60).default(0),
  /** P9 pass 4c: real court id, like `courts` above — was
   *  `z.string().max(100)` (a court NAME). `courts` moved to real ids in
   *  pass 1 while this field stayed free text, so a court-scoped blackout
   *  could no longer match the court it named (silently went global or
   *  inert depending on the reader). V374 rewrites every stored
   *  `blackouts[].court` name -> id on migration, reusing the same
   *  court_mapping `courts` itself is rewritten through. Review wave 1,
   *  finding 2: an entry that cannot be mapped is DROPPED entirely, never
   *  left in place (this field is required-shaped — `.optional()` only
   *  drops the KEY, a present-but-unmappable string still fails `CourtId`)
   *  and never widened into a venue-wide blackout by dropping just the
   *  `court` key — that would block every court during the window instead
   *  of the one the organiser could no longer be identified. Counted in the
   *  migration's dry-run report either way, so an operator can see it. */
  blackouts: z
    .array(z.object({ court: CourtId.optional(), from: IsoDateTime, to: IsoDateTime }))
    .max(200)
    .default([]),
  sessionWindows: z
    .array(z.object({ from: IsoDateTime, to: IsoDateTime }))
    .max(200)
    .default([]),
  /** Quick-start rolling times (doc 12 §1.A): round r starts at startAt + (r−1)·roundMinutes. */
  roundMinutes: z.number().int().min(1).max(24 * 60).nullish(),
  /** Constraints v2 (Jul3/04 §3; Pro `scheduling.constraints`). API times are
   *  ISO; the engine consumes epoch ms. */
  constraints: z
    .object({
      restMin: z.number().int().min(0).max(24 * 60).optional(),
      restByGroup: z.record(z.string(), z.number().int().min(0).max(24 * 60)).optional(),
      noBackToBack: z.boolean().default(false),
      startWindows: z
        .array(
          z.object({
            target: z.object({ kind: z.enum(["entrant", "pool", "division"]), id: z.string() }),
            notBefore: IsoDateTime.optional(),
            notAfter: IsoDateTime.optional(),
          }),
        )
        .max(200)
        .default([]),
      fieldFairness: z.enum(["off", "balance", "rotate"]).default("off"),
      parallelism: z.enum(["block", "mixed"]).default("mixed"),
      crossPersonClash: z.enum(["warn", "hard"]).default("warn"),
      /** Durable division rules (#398) in the SAME vocabulary a compiled
       *  instruction produces — per-day caps, weekday and date targets,
       *  earliest/latest starts, minimum rest. They merge with the compiled
       *  instruction into one stream at `verifyConfig`, so a hard rule has
       *  exactly one home and one enforcement.
       *
       *  Optional, never defaulted: this type is built as an object literal at
       *  dozens of call sites, and a defaulted field is required in the zod
       *  OUTPUT type. Read it as `constraints?.hard ?? []`. */
      hard: z.array(HardConstraint).max(200).optional(),
    })
    .optional(),
});
export type ScheduleConfig = z.infer<typeof ScheduleConfig>;

/** A blackout or a session window, not a whole schedule — worth its own wording
 *  so a 422 points the organiser at the row they inverted rather than at the
 *  competition dates, which is what `ENDS_BEFORE_STARTS` reads as. */
export const WINDOW_ENDS_BEFORE_STARTS = "A window's end cannot be before its start.";

/** Every ordered instant pair a schedule config carries, checked on the way IN.
 *
 *  Deliberately on this wrapper and NOT on `ScheduleConfig` itself. That schema
 *  is the READ path too — `schedule.ts:296` runs `ScheduleConfig.parse` over the
 *  stored `schedule_settings.config` jsonb and `.parse` throws, and
 *  `competition-schedule-ai.ts:2429` `safeParse`s the same rows. A refine there
 *  would take every division that ALREADY holds a reversed range and turn its
 *  schedule page into a 500, punishing organisers for a value the product let
 *  them save. Refusing new bad writes fixes the source without breaking the
 *  divisions the gap already produced; the stored rows stay readable and become
 *  correctable through this very endpoint.
 *
 *  `startAt` is an instant and `endAt` is the venue-local END of its day (the
 *  panel stores 23:59 in the org zone), so a same-day range is `startAt < endAt`
 *  and equality is not expected — but it is permitted rather than rejected,
 *  because a zero-length window is merely empty, not incoherent, and the
 *  organiser gets a clearer signal from an unschedulable board than from a
 *  validation error they cannot act on. Only strict inversion is refused. */
function checkInstantOrder(
  v: { config?: { startAt?: string | null; endAt?: string | null; blackouts?: { from: string; to: string }[]; sessionWindows?: { from: string; to: string }[] } },
  ctx: z.RefinementCtx,
): void {
  const c = v.config;
  if (c === undefined) return;
  // EPOCH comparison, never string order. `IsoDateTime` is
  // `z.iso.datetime({ offset: true })`, which accepts ANY offset, not just `Z`
  // — and lexicographic order is chronological only within a single offset.
  // `2026-03-01T01:00:00-05:00` (06:00 UTC) is genuinely later than
  // `2026-03-01T02:00:00+02:00` (00:00 UTC), yet sorts BEFORE it as a string,
  // so a reversed range from a mixed-offset client would sail straight through
  // and reproduce the exact empty-board-no-error bug this check exists to stop.
  // The console only ever emits `Z` (`isoFromZonedParts`), but this endpoint is
  // a documented platform API and does not get to assume its own console is the
  // only caller. The sibling `checkDateOrder` above IS safe on string order —
  // it compares date-only `YYYY-MM-DD`, which carries no offset at all; do not
  // read it as precedent for instants.
  const at = (s: string): number => Date.parse(s);
  const reversed = (from: string, to: string): boolean => {
    const [a, b] = [at(from), at(to)];
    // An unparseable value is not this check's to report — the field schema
    // already rejected it, and guessing here would add a second, confusing
    // issue on the same path.
    return Number.isFinite(a) && Number.isFinite(b) && b < a;
  };
  if (typeof c.startAt === "string" && typeof c.endAt === "string" && reversed(c.startAt, c.endAt)) {
    ctx.addIssue({ code: "custom", path: ["config", "endAt"], message: ENDS_BEFORE_STARTS });
  }
  for (const [key, rows] of [
    ["blackouts", c.blackouts],
    ["sessionWindows", c.sessionWindows],
  ] as const) {
    (rows ?? []).forEach((row, i) => {
      if (reversed(row.from, row.to)) {
        ctx.addIssue({ code: "custom", path: ["config", key, i, "to"], message: WINDOW_ENDS_BEFORE_STARTS });
      }
    });
  }
}

export const PutScheduleSettings = z.object({
  config: ScheduleConfig,
  /**
   * Venue-local timezone (doc 12 §6 — DST boundaries in sessionWindows).
   *
   * Since V305 the venue zone is set on the ORGANISATION and inherited; there
   * is no division-level timezone control in the console any more. The column
   * and this field survive for the divisions that already hold a value (and
   * for platform-API clients), so this is tri-state:
   *   omitted  → leave the division's stored value untouched (what the
   *              console now always does — a save must never move a
   *              division's venue zone)
   *   null     → clear it, inherit from the org
   *   string   → pin this division to an explicit zone
   *
   * A string is additionally checked against the runtime's Intl: the length
   * bounds alone let any 1-64 character value reach the column, and the two
   * public loaders resolve it in SQL as `coalesce(ss.tz, o.timezone, 'UTC')`,
   * which rescues NULL only — so a junk zone stored here flows straight out
   * to a spectator surface instead of degrading to the org's zone.
   */
  tz: z.string().min(1).max(64).refine(isValidIana, { message: "Unknown timezone" }).nullish(),
}).superRefine(checkInstantOrder);
export type PutScheduleSettings = z.infer<typeof PutScheduleSettings>;

export const ScheduleSettings = z.object({
  division_id: Uuid,
  config: ScheduleConfig,
  /** RESOLVED venue zone (V305): stored division tz → org timezone → 'UTC'. */
  tz: z.string(),
  updated_at: z.string(),
});

/** The rule vocabulary the scheduling prompts teach (#399). `CAP` is the
 *  capacity case: demand exceeded capacity and no single rule was broken. */
export const RuleCode = z.enum(["H2", "H3", "H4", "H5", "H6", "H8", "CAP"]);
export type RuleCode = z.infer<typeof RuleCode>;

// Structured conflict detail (C3, 2026-08-13 design amendment,
// `docs/superpowers/specs/2026-08-12-conflict-detail-names-design.md`). One
// member per family template the engine's `ConflictDetailKind` union
// enumerates.
//
// The witness below is the SAME idiom the engine's own
// `conflict-detail.ts` uses for its field-order witness: a
// `Record<ConflictDetailKind, true>` object literal requires every key of
// the engine's union and rejects any key not in it, so a kind added to (or
// renamed in) the engine's 25 and forgotten here is a TYPE ERROR at this
// file, not a wire enum that silently stops matching what the engine emits.
const CONFLICT_DETAIL_KIND_WITNESS: Record<ConflictDetailKind, true> = {
  person_double_booking: true,
  locked_slot_clash: true,
  no_slot_start_window: true,
  no_slot_person_bound: true,
  no_slot_horizon: true,
  instruction_feeder_gap: true,
  instruction_day_cap: true,
  instruction_weekday: true,
  instruction_date: true,
  instruction_time: true,
  outside_competition_window: true,
  outside_start_window: true,
  court_double_booking: true,
  court_tag_mismatch: true,
  outside_court_hours: true,
  inside_blackout: true,
  outside_session_windows: true,
  entrant_overlap: true,
  entrant_below_rest: true,
  person_overlap: true,
  person_below_rest: true,
  order_before_feeder: true,
  order_inside_feeder_rest: true,
  round_order_day: true,
  round_order_same_day: true,
  no_slot_lattice: true,
  no_slot_budget: true,
  stranded_fixture: true,
};
const CONFLICT_DETAIL_KINDS = Object.keys(CONFLICT_DETAIL_KIND_WITNESS) as [
  ConflictDetailKind,
  ...ConflictDetailKind[],
];
/** Shared between the snake_case wire shape below and the camelCase
 *  `AiPlanConflict` one near it — the kind STRING never changes casing,
 *  only the sibling field names do. */
const ConflictDetailKindSchema = z.enum(CONFLICT_DETAIL_KINDS);

/** Snake_case wire mirror of the engine's `ConflictDetail` (house style for
 *  this schema — see `fixture_id`/`shortfall_minutes` on `ScheduleConflict`
 *  below). Every field beyond `kind` is optional because each family
 *  template only populates the subset it needs (design doc's per-kind
 *  table); id fields are `Uuid` to match `fixture_id` on the conflict
 *  itself. */
const ScheduleConflictDetail = z.object({
  kind: ConflictDetailKindSchema,
  entrant_ids: z.array(Uuid).optional(),
  person_ids: z.array(Uuid).optional(),
  other_fixture_id: Uuid.optional(),
  court: z.string().optional(),
  /** P9 pass 3a: `court` is now a real `courts.id`; this is the DERIVED,
   *  read-only display name resolved by the usecase before this leaves the
   *  server — mirrors the engine's own `ConflictDetail.courtName` (see its
   *  doc comment). Absent exactly when `court` is, or on the rare miss a
   *  resolver could not name. */
  court_name: z.string().optional(),
  day: z.string().optional(),
  other_day: z.string().optional(),
  weekday: z.string().optional(),
  required_weekday: z.string().optional(),
  required_date: z.string().optional(),
  time: z.string().optional(),
  required_time: z.string().optional(),
  rule_type: z.string().optional(),
  round_no: z.number().int().optional(),
  other_round_no: z.number().int().optional(),
  minutes: z.number().int().optional(),
  required_minutes: z.number().int().optional(),
  count: z.number().int().optional(),
  required_count: z.number().int().optional(),
});

/** Doc 12 §2 conflict taxonomy. Since #399 `blocking` is DELTA-based: a court
 *  clash, a person double-booking, an out-of-window slot or a direct feed
 *  ordering breach blocks when THIS change introduced or worsened it. The same
 *  conflict already on the board comes back as a badge, so a dirty board stays
 *  editable. Blocked writes are rejected; warnings persist as badges. */
export const ScheduleConflict = z.object({
  fixture_id: Uuid,
  code: z.enum([
    "conflict.court",
    "conflict.start_window",
    "warn.rest",
    "warn.person_overlap",
    "warn.order",
    "warn.blackout",
    // #397: outside the competition's resolved calendar window. A warning this
    // wave — W4 (#399) makes it blocking, and delta-based so a board that was
    // already outside its window stays editable.
    "warn.window",
    // #398: breaks a rule compiled from the organiser's own instruction ("two
    // matches per day", "final on Friday"), or a durable division rule in the
    // same vocabulary. A warning this wave — W4 (#399) gives it rule code H8
    // and decides what blocks.
    "warn.instruction",
    "warn.no_slot",
    "warn.official_declined",
    "warn.official_unavailable",
  ]),
  blocking: z.boolean(),
  /** @deprecated Pre-C3 English, derived server-side (byte-for-byte) from
   *  `details` by the deprecated `legacyConflictDetail` — kept only for
   *  clients that read prose off the wire. New clients should read
   *  `details` and localize at render time (C3, 2026-08-13 design
   *  amendment). */
  detail: z.string().optional(),
  /** Structured, id-only conflict detail (C3, 2026-08-13 design amendment).
   *  Additive: absent only for a `Conflict` the engine built without a
   *  `details` entry (there should be none — every one of the 25 family
   *  templates sets it — but the field stays optional to match the
   *  engine's own `Conflict.details?`). */
  details: ScheduleConflictDetail.optional(),
  /** The rule this conflict breaks, in the vocabulary the AI prompts teach
   *  (#399) — so a refusal, a badge and a repair round all cite one token. */
  rule: RuleCode.optional(),
  /** How far a MEASURED breach falls short, in minutes (#399). Carried beside
   *  the conflict rather than inside `detail`, because `detail` is part of the
   *  conflict's identity and a number in there would move that identity every
   *  time the card moved. */
  shortfall_minutes: z.number().int().optional(),
});
export type ScheduleConflict = z.infer<typeof ScheduleConflict>;

/** The PATCH /fixtures/{id} response (#461).
 *
 *  The fixture as `Fixture` describes it, PLUS the conflicts the move was judged
 *  against. `moveFixture` has always computed a full report for the destination
 *  slot; it used it for the blocking gate and then discarded it, because the
 *  function returned `void`. Blocking conflicts 409 and are visible that way, so
 *  the ones this field exists for are the WARN-level ones — a rest shortfall, a
 *  stored typed rule, a slot outside the competition's days — which an API
 *  client dragging a card previously heard nothing about.
 *
 *  Always present, `[]` when the patch touched no timetable field, so a client
 *  need not distinguish "no conflicts" from "not evaluated" by key absence.
 *  Additive: no existing consumer of this endpoint reads it. */
export const PatchedFixture = Fixture.extend({
  conflicts: z.array(ScheduleConflict),
});
export type PatchedFixture = z.infer<typeof PatchedFixture>;

export const ScheduleAssignment = z.object({
  fixture_id: Uuid,
  scheduled_at: z.string(),
  ends_at: z.string(),
  court_id: CourtId,
  /** DERIVED, read-only (P9 pass 3a) — resolved from `court_id` by the
   *  usecase. Nullable rather than omitted on a miss: `court_id` itself is
   *  always present on a real assignment, so a client can always render
   *  SOMETHING (fall back to the id) without a key-absence check. */
  court_name: z.string().nullable(),
});
export type ScheduleAssignment = z.infer<typeof ScheduleAssignment>;

/** POST /stages/{id}/schedule/auto — propose only, nothing persisted (doc 12 §4).
 *
 *  `mode` has a default DERIVED from another field, which `.default()` cannot
 *  express. The obvious `.object({...}).transform(...)` is a trap here:
 *  openapi.ts converts every registered schema with `z.toJSONSchema(…, { io:
 *  "output" })`, and a trailing transform is the OUTPUT node, so the whole
 *  generator dies with "Transforms cannot be represented in JSON Schema" —
 *  the same hazard AiApplyMeta's comment above warns about.
 *
 *  `z.preprocess` pipes the other way: the transform is the INPUT node and the
 *  plain object is the output, so `io: "output"` converts cleanly and `mode`
 *  is a required, non-optional string on the inferred type (which the usecase
 *  branches on without a null check).
 *
 *  Consequence to know: `mode` is listed in the spec's `required` even though
 *  callers need not send it — exactly how the pre-existing defaulted
 *  `only_unlocked` has always rendered. Every existing caller keeps its
 *  behaviour: re-flowing is a REFLOW, a fresh pass is a BUILD. */
export const AutoScheduleRequest = z.preprocess(
  (value) => {
    // Let the object schema own the error for non-objects.
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const body = value as Record<string, unknown>;
    if (body.mode !== undefined) return body;
    // `=== false` and not `!body.only_unlocked`: an absent flag defaults to
    // true, so it must derive "reflow", not "build".
    return { ...body, mode: body.only_unlocked === false ? "build" : "reflow" };
  },
  z.object({
    /** true (default) = re-flow unlocked fixtures only, locked ones are fixed
     *  obstacles ("re-flow remaining", doc 12 §2); false = fresh full pass.
     *
     *  Steers `mode` derivation ONLY (above). It used to also gate whether a
     *  `schedule_locked` fixture was honoured, which was a bug
     *  (#pins-in-build): the primary Auto-schedule button always posts
     *  `false` here (to derive `mode: "build"`), so that gate silently
     *  dropped every lock on the one mode organisers reach for by default. A
     *  lock is honoured on every mode now, unconditionally; `ignore_locks`
     *  below is the only way to turn that off. */
    only_unlocked: z.boolean().default(true),
    /** Which solver this run is asking for. Absent is derived from
     *  `only_unlocked` by the preprocess above. */
    mode: z.enum(["build", "reflow", "polish"]),
    /** The explicit escape hatch (owner ruling, 2026-08-12): the ONLY thing
     *  that can make this run move a `schedule_locked` (or scope-locked)
     *  fixture. Every mode honours a lock by default — a lock must be
     *  ignored on purpose; there is no silent path to it. Meant for a
     *  caller who has just been told BUILD is infeasible because of its own
     *  pins and wants one explicit re-run that treats the whole board as
     *  movable.
     *
     *  `.optional()`, not `.default(false)`: `z.infer` of a `.default()`'d
     *  field is non-optional (the default only shapes what `.parse()`
     *  accepts as INPUT, via `z.input<>`), and `autoSchedule(auth, stageId,
     *  body: AutoScheduleRequest)` is called directly — bypassing this
     *  schema entirely — by dozens of usecase tests with a hand-built object
     *  literal that predates this field. A `.default()` here would make
     *  every one of them fail typechecking for a field they have no reason
     *  to know about. `.optional()` keeps those literals valid; the usecase
     *  applies the same `false` fallback where it reads the field instead
     *  (`body.ignore_locks ?? false`). */
    ignore_locks: z.boolean().optional(),
  }),
);
export type AutoScheduleRequest = z.infer<typeof AutoScheduleRequest>;

/** Board quality of a proposal. snake_case on the wire; the engine's camelCase
 *  equivalents are mapped across at the usecase seam, once. */
export const ScheduleMetrics = z.object({
  makespan_minutes: z.number(),
  worst_idle_gap_minutes: z.number(),
  court_imbalance_minutes: z.number(),
  placed: z.number().int(),
  total: z.number().int(),
});
export type ScheduleMetrics = z.infer<typeof ScheduleMetrics>;

/** How the proposal was produced — telemetry, not policy. `status` tracks the
 *  engine's BuildStatus union one-for-one. */
export const ScheduleSolverInfo = z.object({
  /** Mirrors the engine's `BuildResult["engine"]` exactly: `schedule.ts`
   *  assigns that field into this one one-for-one, so a member missing here is
   *  a board the API has no shape for — and that is not hypothetical, TS
   *  already refuses `engine: out.engine` when the two drift.
   *
   *  Two members since C7, which retired the z3-era `"z3"` and `"z3+lns"`.
   *  Nothing had produced either since C4 and C9 moved the last callers onto
   *  the placement service. */
  engine: z.enum(["greedy", "optimized"]),
  /** Which solver the request asked for, echoed back.
   *
   *  NOT redundant with `engine`, which names what actually produced the board:
   *  a REFLOW that timed out and a BUILD that expired before finishing its first
   *  tier both come back `engine: "greedy"`, `budget_expired: true`,
   *  `tiers_completed: 0`, `tiers_total: 6` — byte for byte the same payload,
   *  describing two different events.
   *
   *  It matters because only the BUILD path has a tier ladder. `reflowExisting`
   *  keeps `tiersCompleted` at 0 deliberately (reporting a number from a ladder
   *  it never walked would make an optimality claim nothing proved) while
   *  `tiers_total` stays the build ladder's size, so a reader with only those two
   *  numbers renders "0 of 6 targets improved" about a run that was never on that
   *  scale. This is the field that lets it say something true instead.
   *
   *  Optional and additive: absent, a reader keeps the tier sentence, which is
   *  what it rendered before the field existed. */
  mode: z.enum(["build", "reflow", "polish"]).optional(),
  status: z.enum([
    "ok",
    "already_optimal",
    "infeasible",
    "verifier_rejected",
    "solver_busy",
    /**
     * The solver could not represent this board on its lattice, so it never
     * searched it.
     *
     * NOT a failure, and not a quality claim — the deliberate ABSENCE of one.
     * The greedy board it arrives with is valid. What it refuses to say is
     * whether a better one exists, and that refusal is the whole reason the
     * member exists: the behaviour it replaces reported `already_optimal` —
     * which is a PROOF — about a board no tier had ever been in a position to
     * ask a question about.
     *
     * Listed here rather than left off because `schedule.ts` assigns the
     * engine's `BuildStatus` into this object one-for-one, so a member missing
     * from this enum is a board the API has no shape for.
     */
    "not_searched",
    /**
     * The service call resolved but not into a trustworthy board — a transport
     * fault, an unmapped/unreadable status, or the RPC rejecting outright.
     *
     * Listed here rather than left off for the same reason `not_searched`
     * above is: `schedule.ts` assigns `BuildStatus` into this object
     * one-for-one. It shared `board.result.unavailable` with a z3-era
     * `z3_unavailable` that meant the same thing to an organiser; C7 retired
     * that older name, so this is now the only identifier for it. The copy is
     * unchanged — it was always the same string.
     *
     * Deliberately NOT what a `SOLVER_BUSY` refusal maps to — that stays
     * the existing `"solver_busy"` a few lines up, because a retry helps
     * there and this copy does not promise one will.
     */
    "solver_unavailable",
  ]),
  /**
   * WHICH of `not_searched`'s five exits produced this board — `status` alone
   * cannot say, because all five collapse onto that one member (see the engine's
   * `NotSearchedReason` doc comment, `build.ts`). Present only when
   * `status === "not_searched"`; absent on every other status, and absent from
   * a server one deploy behind this field — a reader untaught about it degrades
   * to the shared `board.result.notSearched` sentence, which is still true, just
   * less specific.
   *
   * A sixth member, `per_court_grid`, lived here until task C2 closed the gap
   * that produced it (`placement.model.build_model` now enforces each court's
   * own tick set directly, so a per-court blackout reaches the solver instead
   * of being refused) — removed, not merely undocumented, matching the
   * engine's own union.
   *
   * HAND-MIRRORED, not generated: this file has no codegen link to
   * `packages/engine`, so a member added to the engine union without a match
   * here is a value `schedule.ts`'s `out.notSearchedReason` assignment cannot
   * type as this field — TS catches it at the usecase seam, the same trap
   * `status` above and `ScheduleSolverInfo`'s own doc comment already warn
   * about.
   */
  not_searched_reason: z
    .enum(["too_big", "window_empty", "lattice_unusable", "out_of_time", "no_verdict"])
    .optional(),
  tiers_completed: z.number().int(),
  /** How many improvement targets the ladder HAS — the denominator
   *  `tiers_completed` is a numerator of.
   *
   *  Sent rather than left to the client because a bare `tiers_completed` has
   *  no meaning without it: the result strip had to carry its own
   *  `IMPROVEMENT_TARGETS = 4`, which is a constant in a different package from
   *  the ladder it describes and drifts the day a tier is added or removed with
   *  nothing to notice. A denominator on the wire moves that fact to the one
   *  place that knows it.
   *
   *  Optimality is `tiers_completed === tiers_total`, NOT `!budget_expired`: a
   *  term or metric drift exits a tier without ever setting the flag. */
  tiers_total: z.number().int(),
  budget_expired: z.boolean(),
  elapsed_ms: z.number(),
  moved: z.number().int(),
  /** How many of `moved` were cards this run placed for the FIRST time.
   *
   *  `moved` counts every card the run put somewhere, and for a REFLOW over an
   *  unscheduled stage that is the entire board — cards that were never anywhere
   *  to be moved FROM. Without this the best copy available is "N matches
   *  moved", which is wrong about every one of them.
   *
   *  CARRIED, not inferred. A reader cannot recover it from `moved` and
   *  `placed`: `moved === placed` happens on plenty of ordinary boards that
   *  seeded nothing at all, so a component deriving it that way would relabel a
   *  genuine re-flow as a first-time scheduling run.
   *
   *  Present only on the REFLOW path, which is the only one that distinguishes a
   *  seed from a move. BUILD and POLISH re-place everything by definition, so
   *  the distinction does not arise and the field is absent. */
  seeded: z.number().int().optional(),
  /** How many cards that HELD a slot on the organiser's board no longer have
   *  one after this run (R21).
   *
   *  Its own field rather than folded into `moved`, because the two are
   *  different events and only one of them is a rearrangement. Folded, a single
   *  substitution — one card in, one card out — read as 2 moves on a board that
   *  had only moved one thing, and `moved` could exceed the size of the board it
   *  described. A strip printing "moved N" cannot honestly print an N larger
   *  than the board.
   *
   *  Not derivable from `total - placed`, which counts every card with no slot
   *  including ones that never had one. On a stage of 22 with 18 placed, four
   *  cards are unplaced and only the ones the organiser had already scheduled
   *  are a time somebody may have to be un-told about.
   *
   *  0 rather than absent whenever there is no baseline to lose from: the engine
   *  measures it against `BuildInput.current`, and a BUILD that supplies none
   *  reports 0 by definition. Optional on the wire only so a server one deploy
   *  behind parses. */
  lost: z.number().int().optional(),
  /** The PINNED fixtures an `infeasible` verdict is about, sorted.
   *
   *  `infeasible` has two sources and they say opposite things to an organiser.
   *  The board source means not one card can be placed legally. The PIN source
   *  means the rest of the board is fine and two locked placements cannot both
   *  be kept. Present only for the second, and its ABSENCE on an `infeasible`
   *  result is itself the signal that the proof is about the board.
   *
   *  Optional and additive: a reader that has not been taught about it degrades
   *  to `total - placed`, which is the same number in the measured case and
   *  wrong whenever an unplaced card is not a pinned one. Never synthesised
   *  here — it is forwarded only when the engine supplied it. */
  contradictory_pins: z.array(z.string()).optional(),
  /** How many of THIS stage's own fixtures were held fixed because they were
   *  locked (`schedule_locked`, or caught by a division scope lock) — the set
   *  `autoSchedule` anchored into the solve rather than left movable. A
   *  companion signal to `contradictory_pins`: that field fires only when two
   *  locked placements directly contradict each other, but a lock can also
   *  make a board `infeasible` by leaving no room for the rest — `locked_kept
   *  > 0` alongside `status: "infeasible"` is enough for a client to suggest
   *  the `ignore_locks` escape hatch even when `contradictory_pins` is absent.
   *
   *  0 whenever nothing in this stage is locked, or the caller asked to
   *  `ignore_locks` — this server always sends a real number, never `undefined`.
   *
   *  Optional on the wire only, matching `lost`/`seeded`/`contradictory_pins`
   *  right above: a reader on an older client build, or a cached/replayed
   *  response from a server one deploy behind, must still parse.
   *
   *  Counts PLACEMENTS, not the division's lock flag: a locked fixture with
   *  no `scheduled_at`/`court_id` yet has nothing to anchor to and is not
   *  counted (the same rule the anchor itself uses — see `lockedFixtureIds`
   *  in `schedule.ts`). */
  locked_kept: z.number().int().optional(),
});
export type ScheduleSolverInfo = z.infer<typeof ScheduleSolverInfo>;

// ---------------------------------------------------------------------------
// Capacity pre-check (D2, docs/superpowers/specs/bench-product-value/designs/
// 2026-08-13-capacity-precheck-design.md) — the 422 CAPACITY_IMPOSSIBLE
// report on /stages/{id}/schedule/auto and /competitions/{id}/schedule/
// ai-plan, and the shape the setup card's live client-side recompute
// produces (packages/engine/src/scheduling/capacity.ts's assessCapacity —
// an engine lib import, no fetch, for that path).
//
// camelCase, DELIBERATELY breaking this file's snake_case wire convention:
// mirrors the engine's CapacityReport field for field so the client can hand
// a 422's `report` extra straight to the SAME renderer the live card uses,
// with no mapping step — the design doc states this explicitly ("the card
// consumes the identical type client-side"), unlike ScheduleConflict, whose
// `Conflict.reason` union genuinely needs `REASON_CODE` at the boundary.
export const CapacityReport = z.object({
  verdict: z.enum(["impossible", "tight", "ok"]),
  slotSupply: z.number().int().nonnegative(),
  slotDemand: z.number().int().nonnegative(),
  perDay: z.array(
    z.object({
      date: z.string(),
      supply: z.number().int().nonnegative(),
      demandCeiling: z.number().int().nonnegative(),
    }),
  ),
  restBound: z.array(
    z.object({
      entrantId: z.string(),
      need: z.number().nonnegative(),
      available: z.number().nonnegative(),
      violated: z.boolean(),
    }),
  ),
  suggestions: z.array(
    z.object({
      kind: z.enum(["add_day", "add_court", "shorten_match", "shrink_gap", "raise_cap"]),
      amount: z.number(),
      flipsVerdict: z.boolean(),
    }),
  ),
});
export type CapacityReport = z.infer<typeof CapacityReport>;

/** POST /divisions/{id}/schedule/capacity (P10 §4) — the board's live,
 *  unsaved config/fixtures, so the server can run the SAME precheck the
 *  client used to run alone, now with real court calendars (P9 stopped
 *  shipping them to the board payload; that is unchanged — only the NUMBERS
 *  travel back over this endpoint).
 *
 *  A WIRE-side schema, deliberately separate from the usecase-side
 *  `CapacityPrecheckInput` in `capacity-guard.ts` that the route actually
 *  parses the request with — registered here only so the generated spec
 *  documents the shape (the `ReorderSponsors`/`ReorderSponsorsInput` pair
 *  above this file's sponsors section is this repo's own precedent for the
 *  two staying independent objects, not a shared source of truth).
 *
 *  `fixtures` mirrors `CapacityFixtureInput` (capacity-input.ts) field for
 *  field, not raw DB column names: both existing client call sites already
 *  map their fixture rows into this exact shape before running the
 *  precheck locally, so sending it as-is needs no second mapping step.
 *  `config` mirrors `CapacityConfigInput` minus `tz` (never client-supplied
 *  — `settings.orgTz` is the governing clock, #397, resolved server-side)
 *  and `courtCalendars` (what this endpoint exists to add). */
export const CapacityPrecheck = z.object({
  fixtures: z
    .array(
      z.object({
        id: Uuid.optional(),
        extKey: z.string().nullable().optional(),
        winnerTo: z.string().nullable().optional(),
        home: Uuid.optional(),
        away: Uuid.optional(),
        poolId: Uuid.optional(),
      }),
    )
    .max(2000),
  config: z.object({
    // These two bounds are LITERALS here on purpose, and they must equal
    // `CAPACITY_PRECHECK_MAX_FIXTURES`/`_COURTS` (lib/capacity-bounds.ts),
    // which the route's own parser (capacity-guard.ts) and the client hooks
    // both import.
    //
    // Importing them here does not work: this file is consumed by
    // `scripts/openapi-gen.ts` under plain `node --experimental-strip-types`
    // (see this file's header — "shared with the OpenAPI generator script"),
    // which does NOT resolve the `@/` tsconfig path alias. Adding that
    // import made `npm run openapi:gen` die with `ERR_MODULE_NOT_FOUND:
    // Cannot find package '@/lib'` — and, worse, the drift check that runs
    // straight afterwards still reported "no drift", because a generator
    // that never ran rewrites nothing. That is why the parity is enforced by
    // an actual test instead: `capacity-precheck-bounds.test.ts` parses
    // over-bound payloads against BOTH schemas and pins them to the shared
    // constants, so a change to one that is not mirrored in the other fails
    // loudly rather than silently widening the published contract.
    courts: z.array(CourtId).max(50),
    sessionWindows: z.array(z.object({ from: z.number(), to: z.number() })).max(200).optional(),
    blackouts: z
      .array(z.object({ court: CourtId.optional(), from: z.number(), to: z.number() }))
      .max(200)
      .optional(),
    matchMinutes: z.number().int().positive(),
    gapMinutes: z.number().int().min(0),
    perEntrantMinRest: z.number().int().min(0),
    // Review fix (finding 3, resource exhaustion): mirrors the same 365-day
    // span cap capacity-guard.ts's CapacityPrecheckInput now carries (that
    // schema — deliberately independent, see its own header — is what the
    // route actually parses the live request with; this one governs the
    // generated spec). Unbounded from/to let one authenticated POST force
    // ~200k usableWindows calls (courts.max(50) x calendarDays' own 4000-day
    // internal ceiling in capacity-input.ts). 365 days matches this repo's
    // own precedent for a schedule's default span (calendar.ts's
    // `horizonMinutes ?? 365 * 24 * 60`).
    window: z
      .object({ from: z.number(), to: z.number() })
      .refine((w) => w.to - w.from <= 365 * 24 * 60 * 60 * 1000, {
        message: "window must not span more than 365 days",
      })
      .optional(),
    constraints: z
      .object({
        restMin: z.number().int().min(0).optional(),
        // Bounded like every sibling in this schema: an unbounded record was the
        // one uncapped field on a client-supplied body (P10 Task 5 review). Value
        // range matches the other two restByGroup declarations in this file.
        restByGroup: z
          .record(z.string(), z.number().int().min(0).max(24 * 60))
          .refine((r) => Object.keys(r).length <= 200, { message: "at most 200 groups" })
          .optional(),
        noBackToBack: z.boolean().optional(),
        hard: z.array(HardConstraint).max(200).optional(),
      })
      .optional(),
    hard: z.array(HardConstraint).max(200).optional(),
  }),
});
export type CapacityPrecheck = z.infer<typeof CapacityPrecheck>;

// ---------------------------------------------------------------------------
// Schedule health score (D3, docs/superpowers/specs/bench-product-value/
// designs/2026-08-13-schedule-health-design.md) — GET /stages/{id}/schedule/
// health's 200 body. camelCase, same deliberate break from this file's
// snake_case wire convention CapacityReport takes above, and for the same
// reason: mirrors the engine's HealthMetric/HealthReport field for field
// (packages/engine/src/scheduling/health.ts's assessHealth) so the panel can
// render the wire response with the same renderer a client-side recompute
// would use, no mapping step.
export const HealthOffender = z.object({
  kind: z.enum(["entrant", "court", "courtDay"]),
  id: z.string(),
  label: z.string(),
  value: z.number(),
});

export const HealthMetric = z.object({
  key: z.enum(["restSpread", "courtBalance", "gapDispersion", "homeAwayAlternation", "primeSlotFairness"]),
  score: z.number().int().min(0).max(100),
  // Structured, never literal prose — the engine lib emits an i18n KEY, not
  // English (standing i18n rule; see health.ts's HealthExplanation doc
  // comment). The panel resolves `key` against the active locale's
  // `schedule.health.explain.*` dictionary entry, interpolating `params`.
  explanation: z.object({
    key: z.string(),
    params: z.record(z.string(), z.number()).optional(),
  }),
  offenders: z.array(HealthOffender),
});
export type HealthMetric = z.infer<typeof HealthMetric>;

/** 5 entries, or 4 when the stage is not table-shaped (league/group/swiss/
 *  americano) — homeAwayAlternation is ABSENT then, never a present entry
 *  scored 0 (design doc, verbatim; see schedule-health.ts's TABLE_KINDS). */
export const ScheduleHealthReport = z.object({
  stageId: Uuid,
  computedAt: z.iso.datetime({ offset: true }),
  metrics: z.array(HealthMetric).min(4).max(5),
});
export type ScheduleHealthReport = z.infer<typeof ScheduleHealthReport>;

/** GET /competitions/{id}/schedule/health's 200 body — the joint variant
 *  (design doc: "returns per-division arrays + a combined block"). A stage
 *  entry is EITHER a full report or a bare `{stageId, status:"empty"}` —
 *  never a thrown 409, so one unscheduled division cannot take the whole
 *  joint call down (mirrors the "aggregate every division, never
 *  short-circuit on the first" shape `aiPlanForCompetition`'s capacity
 *  guard uses). */
export const StageHealthEntry = z.discriminatedUnion("status", [
  z.object({
    stageId: Uuid,
    status: z.literal("ready"),
    computedAt: z.iso.datetime({ offset: true }),
    metrics: z.array(HealthMetric).min(4).max(5),
  }),
  z.object({ stageId: Uuid, status: z.literal("empty") }),
]);

export const DivisionHealthEntry = z.object({
  divisionId: Uuid,
  name: z.string(),
  stages: z.array(StageHealthEntry),
});

export const CompetitionScheduleHealthReport = z.object({
  competitionId: Uuid,
  computedAt: z.iso.datetime({ offset: true }),
  divisions: z.array(DivisionHealthEntry),
  // gapDispersion + primeSlotFairness ONLY (design doc: "computed over the
  // union where meaningful") — always exactly 2 entries.
  combined: z.object({ metrics: z.array(HealthMetric).length(2) }),
});
export type CompetitionScheduleHealthReport = z.infer<typeof CompetitionScheduleHealthReport>;

export const AutoScheduleResult = z.object({
  assignments: z.array(ScheduleAssignment),
  conflicts: z.array(ScheduleConflict),
  metrics: ScheduleMetrics,
  solver: ScheduleSolverInfo,
});

/** POST /stages/{id}/schedule/apply — persist an assignment set. */
/** Optional AI provenance stamped into the apply/assign ledger events (v4/03 §10).
 *  Present only when the apply originated from the AI Schedule/Officials Architect;
 *  the instruction is trimmed server-side and recalled by
 *  GET /divisions/{id}/schedule/ai-last. Shared by ApplyScheduleRequest and the
 *  officials ApplyAssignmentsInput. */
export const AiApplyMeta = z.object({
  /** Trimmed server-side at the apply seam (schedule.ts / officials.ts), so it
   *  stays a plain string here — a zod transform would break openapi:gen. */
  instruction: z.string().max(500),
  summary: z.string().max(600),
  model: z.string(),
  repair_rounds: z.number().int().nonnegative(),
});
export type AiApplyMeta = z.infer<typeof AiApplyMeta>;

export const ApplyScheduleRequest = z.object({
  assignments: z
    .array(
      z
        .object({
          fixture_id: Uuid,
          scheduled_at: IsoDateTime,
          // P9 pass 3a — see PatchFixture's identical note just above, incl.
          // why `.strict()` below: a client still sending `court_label`
          // must get a loud 400, not a silently-stripped-and-then-required-
          // -field-missing error that names the wrong thing.
          court_id: CourtId,
          venue_id: VenueId.nullish(),
          schedule_locked: z.boolean().optional(),
          // ECHOED, ignored. `/schedule/auto` returns these two alongside the
          // assignment, and posting its response straight back to /apply is the
          // documented round-trip (the board does it, and so does
          // auto-schedule.spec.ts). `.strict()` below turned that into a 400 on
          // an unknown key, which is a contract break dressed as validation —
          // the strictness exists to reject a client still sending
          // `court_label`, not to reject this endpoint's own output.
          ends_at: IsoDateTime.optional(),
          court_name: z.string().nullish(),
        })
        .strict(),
    )
    .min(1)
    .max(500),
  source: z.enum(["auto", "manual", "ai"]).default("auto"),
  /** Optimistic token (v3/11 gap 10) — see PatchFixture.expected_seq. */
  expected_seq: z.number().int().nonnegative().optional(),
  /** Audit provenance when source === "ai" (v4/03 §10). */
  ai: AiApplyMeta.optional(),
});
export type ApplyScheduleRequest = z.infer<typeof ApplyScheduleRequest>;

/** GET /divisions/{id}/schedule/ai-last — the most recent AI-sourced apply
 *  (null when the division has never been AI-scheduled) plus the division's
 *  generation budget: `used` counts successful schedule generations from the
 *  run ledger, `max` is the plan's per-division cap (null = unlimited). */
export const AiLastResult = z.object({
  last: z.object({ at: z.string(), instruction: z.string(), summary: z.string() }).nullable(),
  runs: z.object({ used: z.number().int(), max: z.number().int().nullable() }),
});
export type AiLastResult = z.infer<typeof AiLastResult>;

export const ApplyScheduleResult = z.object({
  applied: z.number().int().nonnegative(),
  /** Listed fixtures left where they are because they hold a result (a start
   *  taken back leaves a match `scheduled` with its scoring). */
  skipped: z.number().int().nonnegative(),
  conflicts: z.array(ScheduleConflict),
  /** The division's seq after this call — the next write's `expected_seq`.
   *  Advanced when the apply moved something, unchanged when it moved
   *  nothing (every listed fixture skipped): adopt it, never assume +1. */
  seq: z.number().int().nonnegative(),
});

export const ValidateScheduleResult = z.object({
  conflicts: z.array(ScheduleConflict),
});

/** POST /divisions/{id}/publish-schedule (#230 item 2).
 *
 *  Publish runs the board through the same validator the conflicts panel runs.
 *  Blocking conflicts refuse outright — there is deliberately NO field here that
 *  overrides those. `acknowledge_warnings` covers only the warning level: the
 *  organiser has seen the rest shortfall or the day-cap breach and is publishing
 *  anyway, and `reason` records why, on the `schedule_published` event.
 *
 *  Every field is optional and the route parses an ABSENT body as `{}` — the
 *  console and existing API clients POST this endpoint with no body at all, and
 *  adding a gate is not a licence to 400 them. */
export const PublishScheduleRequest = z.object({
  acknowledge_warnings: z.boolean().optional(),
  reason: z.string().max(500).optional(),
});
export type PublishScheduleRequest = z.infer<typeof PublishScheduleRequest>;

export const PublishScheduleResult = z.object({
  division_id: Uuid,
  status: DivisionStatus,
  published: z.boolean(),
});

/** POST /competitions/{id}/schedule/publish — the competition-wide twin.
 *
 *  Same two fields as the per-division request above, meaning the same things:
 *  ONE acknowledgement covers every division in the run, and `reason` is
 *  stamped on every `schedule_published` event it writes. A competition with
 *  eight unreleased divisions is otherwise eight visits to eight pages.
 *
 *  Body optional, parsed from an absent one as `{}`, exactly like the
 *  per-division route. */
export const PublishCompetitionScheduleRequest = z.object({
  acknowledge_warnings: z.boolean().optional(),
  reason: z.string().max(500).optional(),
});
export type PublishCompetitionScheduleRequest = z.infer<typeof PublishCompetitionScheduleRequest>;

/** BEST EFFORT, so the result is a REPORT, not a count.
 *
 *  Publishing is independent per division, so one refused board must not
 *  withhold the rest: the `published` divisions are live and the refused ones
 *  come back with their reason attached. `blocking` distinguishes the two
 *  refusals an organiser acts on differently — `PUBLISH_UNACKNOWLEDGED`
 *  (false) clears by re-sending with `acknowledge_warnings`, `PUBLISH_BLOCKED`
 *  (true) never does. Only divisions still at `setup` are candidates, so a
 *  division that has already released its times appears nowhere in `results`. */
export const PublishCompetitionScheduleResult = z.object({
  published: z.number().int(),
  needs_acknowledgement: z.number().int(),
  blocked: z.number().int(),
  results: z.array(
    z.object({
      division_id: Uuid,
      name: z.string(),
      published: z.boolean(),
      refusal: z
        .object({
          code: z.string(),
          blocking: z.boolean(),
          conflicts: z.array(ScheduleConflict),
        })
        .optional(),
    }),
  ),
});
export type PublishCompetitionScheduleResult = z.infer<typeof PublishCompetitionScheduleResult>;

// ---------------------------------------------------------------------------
// Scorer console (doc 13, PROMPT-18)
// ---------------------------------------------------------------------------

/** GET /me/assigned-fixtures — the "My matches" read (doc 13 §3/§6). */
export const AssignedFixture = z.object({
  id: Uuid,
  // Seven fields below were selected by `listAssignedFixtures` and shipped on
  // the wire while this schema never declared them, so the published contract
  // understated the payload and any consumer parsing against it dropped them.
  // Pre-dates the venues cutover; found while closing review finding #9, which
  // was the same drift one field over.
  fixture_no: z.number().int(),
  org_id: Uuid,
  org_name: z.string(),
  org_slug: z.string(),
  competition_id: Uuid,
  competition_name: z.string(),
  competition_slug: z.string(),
  division_id: Uuid,
  division_name: z.string(),
  division_slug: z.string(),
  division_status: z.string(),
  sport_key: z.string(),
  module_version: z.string(),
  round_no: z.number().int(),
  home_entrant_id: Uuid.nullable(),
  away_entrant_id: Uuid.nullable(),
  home_name: z.string().nullable(),
  away_name: z.string().nullable(),
  /** D4b (P6): set only while the matching *_entrant_id is null. */
  home_slot_label: SlotLabelRef,
  away_slot_label: SlotLabelRef,
  scheduled_at: z.string().nullable(),
  /** Venue zone (V305): division override -> org timezone -> UTC. */
  venue_tz: z.string().nullable(),
  // Review finding #9 (P9 venues/courts cutover): same clean break as
  // Fixture and MyFixture above — court_id/venue_id + derived, read-only
  // court_name/venue_name. `venue`/`court_label` leave the wire entirely;
  // listAssignedFixtures (usecases/scorers.ts) never selected them
  // post-cutover, so declaring them here as required was already false —
  // there is no compatibility shim to preserve.
  court_id: CourtId.nullable(),
  court_name: z.string().nullable(),
  venue_id: VenueId.nullable(),
  venue_name: z.string().nullable(),
  status: z.string(),
});

/** POST /divisions/{id}/start (#230 item 2 follow-up).
 *
 *  Starting the tournament PUBLISHES the schedule, so it carries the publish
 *  contract verbatim: blocking conflicts refuse outright with no override,
 *  `acknowledge_warnings` covers only the warning level, and `reason` records
 *  why on the `schedule_published` event. A separate schema rather than a reuse
 *  of `PublishScheduleRequest` because the two endpoints are separate promises
 *  to API clients — but any divergence between them is a defect, not a feature.
 *
 *  Every field is optional and the route parses an ABSENT body as `{}`: the
 *  console and existing key clients POST this endpoint with no body at all, and
 *  adding a gate is not a licence to 400 them. */
export const StartDivisionRequest = z.object({
  acknowledge_warnings: z.boolean().optional(),
  reason: z.string().max(500).optional(),
});
export type StartDivisionRequest = z.infer<typeof StartDivisionRequest>;

export const StartDivisionResult = z.object({
  division_id: Uuid,
  status: DivisionStatus,
  started: z.boolean(),
  /** Fixtures generated by quick-start (0 when they already existed). */
  generated: z.number().int(),
});

// ---------------------------------------------------------------------------
// Registration & entry fees (doc 16 §1.1, PROMPT-20a)
// ---------------------------------------------------------------------------

/** RS005 W1b: the ONE exported source for this status set — the DB CHECK
 *  (`db/migration/deltas/V364__registrations_regroup.sql`) allows all seven;
 *  the route allowlists and the OpenAPI query enum both derive from
 *  `RegistrationStatus.options` rather than hand-copying the list, so a
 *  fourth copy can't silently drift out of sync (RS005 W1a's `rejected`
 *  status was previously missing here and from the division list route). */
export const RegistrationStatus = z.enum([
  "pending", "paid", "confirmed", "waitlisted", "withdrawn", "expired", "rejected",
]);

/** RS005 W1a `ListRegistrationsFilters.sort` — single source for the same
 *  reason as `RegistrationStatus` above. */
export const RegistrationSort = z.enum(["oldest", "newest"]);

/** How a division collects its entry fee (spec 2026-07-12 §3). */
export const RegistrationPaymentMethod = z.enum(["offline", "stripe"]);

/** V364/RS004: 'auto' reproduces pre-RS004 behaviour untouched — every
 *  entry auto-confirms. 'manual' routes entries through approve/reject
 *  (registration-approval.ts) before they materialise. */
export const RegistrationApproval = z.enum(["auto", "manual"]);

/** Bounded form-field builder (doc 16 §1.1): text/select/checkbox only. */
export const RegistrationFormField = z
  .object({
    key: z.string().min(1).max(40).regex(/^[a-z0-9_]+$/, "lowercase snake_case"),
    label: z.string().min(1).max(120),
    kind: z.enum(["text", "select", "checkbox"]),
    options: z.array(z.string().min(1).max(80)).min(1).max(20).optional(),
    required: z.boolean().default(false),
  })
  .strict()
  .refine((f) => f.kind !== "select" || (f.options?.length ?? 0) > 0, {
    message: "select fields need options",
  });
export type RegistrationFormField = z.infer<typeof RegistrationFormField>;

export const PutRegistrationSettings = z
  .object({
    enabled: z.boolean(),
    entrant_kind: EntrantKind.default("individual"),
    opens_at: z.iso.datetime({ offset: true }).nullish(),
    closes_at: z.iso.datetime({ offset: true }).nullish(),
    capacity: z.number().int().min(1).max(10000).nullish(),
    fee_cents: z.number().int().min(0).max(100_000_00).default(0),
    // No `currency` (RS001b): it is org-level now (`organizations.currency`,
    // allowlisted by DB CHECK), because one cart can span divisions and a
    // Stripe checkout session has exactly one currency. The org settings page
    // owns the select; this panel shows a read-only chip.
    refund_lock_at: z.iso.datetime({ offset: true }).nullish(),
    /** V389/RS012. `null` (the default) means "use the division's own
     *  `closes_at`" (ruling 2) — the pool-deadline sweep's own fallback,
     *  registrations.ts. Nullable, not optional-with-a-sentinel, for the
     *  same reason `refund_lock_at` above is: clearing it back to the
     *  default is a real, meaningful edit, not "field omitted". */
    place_by_at: z.iso.datetime({ offset: true }).nullish(),
    form_fields: z.array(RegistrationFormField).max(12).default([]),
    payment_method: RegistrationPaymentMethod.default("offline"),
    /** Per-division override of the org's offline payment instructions. */
    payment_instructions: z.string().max(5000).nullish(),
    /** V364/RS004. Default reproduces pre-RS004 behaviour untouched. */
    approval: RegistrationApproval.default("auto"),
    /** V364/RS004: meaningful only when entrant_kind is 'team' — the usecase
     *  rejects `true` on a non-team division (putRegistrationSettings). */
    allow_free_agents: z.boolean().default(false),
    /** V388/RS009: what ONE person pays to enter this team division alone.
     *  `null` (the default) means "no separate price — charge fee_cents",
     *  which is what every division did before this existed. 0 is a real
     *  price meaning free, so this is nullish rather than optional-with-0:
     *  the two must not collapse. The usecase rejects a value here when
     *  allow_free_agents is off, and rejects a negative one. */
    free_agent_fee_cents: z.number().int().min(0).nullish(),
  })
  .superRefine((s, ctx) => {
    const keys = s.form_fields.map((f) => f.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: "custom", message: "duplicate form field keys" });
    }
  });
/** Input shape (pre-parse): defaulted fields stay optional so direct callers
 *  (tests, scripts) can omit them; the usecase normalises like the route. */
export type PutRegistrationSettings = z.input<typeof PutRegistrationSettings>;

export const RegistrationSettings = z.object({
  division_id: Uuid,
  enabled: z.boolean(),
  entrant_kind: EntrantKind,
  opens_at: z.string().nullable(),
  closes_at: z.string().nullable(),
  capacity: z.number().int().nullable(),
  fee_cents: z.number().int(),
  /** The ORG's currency (RS001b), echoed here so the division settings panel
   *  can render its read-only chip without a second fetch. Not writable — the
   *  request schema has no `currency`. */
  currency: z.string(),
  refund_lock_at: z.string().nullable(),
  /** V389/RS012 — null means "use closes_at" (ruling 2); see PutRegistrationSettings above. */
  place_by_at: z.string().nullable(),
  form_fields: z.array(RegistrationFormField),
  payment_method: RegistrationPaymentMethod,
  payment_instructions: z.string().nullable(),
  approval: RegistrationApproval,
  allow_free_agents: z.boolean(),
  /** V388/RS009. `null` = no separate price; the panel renders the team fee
   *  as the effective price in that case. */
  free_agent_fee_cents: z.number().int().nullable(),
  /** Org fallbacks for the settings UI (spec §3). */
  org_payment_instructions: z.string().nullable(),
  org_default_payment_method: z.string(),
  /** Paid registration readiness (org-level): Stripe Connect charges enabled. */
  charges_enabled: z.boolean(),
  updated_at: z.string().nullable(),
});

/** Organiser view of one registration — a DOCUMENTED SUBSET of
 *  `RegistrationWithGroupRow`, not a stripped mirror of it. `v1()` neither
 *  validates nor strips against this schema (`api-v1/http.ts:124-149`
 *  serialises whatever the handler returns), so every row field the handler
 *  does not delete still rides the wire: `org_id`, `user_id`,
 *  `checkout_session_id`, `dispute_id`, `fee_percent`, `privacy_consent_at`,
 *  `group_refunded_cents`, `updated_at` and more. Only `access_token_hash` is
 *  removed by construction, because it is credential-derived. Adding a field
 *  here documents it; it does not start shipping it, and omitting a field does
 *  not stop it.
 *  RS005 W1b: `dob`/`gender`/`guardian_name`/`guardian_consent` dropped —
 *  RS001 moved them off `registrations` onto `registration_players`
 *  (per-player, not per-entry) before this route surface ever shipped, so
 *  they were never real columns here. `contact_name`/`group_id`/`join_code`/
 *  `free_agent` added — the row has always carried them. */
export const Registration = z.object({
  id: Uuid,
  division_id: Uuid,
  status: RegistrationStatus,
  ref_code: z.string().nullable(),
  display_name: z.string(),
  contact_name: z.string(),
  contact_email: z.string(),
  answers: z.record(z.string(), z.unknown()),
  amount_cents: z.number().int(),
  currency: z.string().nullable(),
  payment_method: z.string().nullable(),
  payment_intent_id: z.string().nullable(),
  refunded_cents: z.number().int(),
  refunded_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  offline_marked_paid_at: z.string().nullable(),
  disputed_at: z.string().nullable(),
  entrant_id: Uuid.nullable(),
  promoted_at: z.string().nullable(),
  withdrawn_at: z.string().nullable(),
  /** The cart this entry belongs to (V364) — every entry has exactly one. */
  group_id: Uuid,
  /** Set when this (team) entry can hand out a self-join link. */
  join_code: z.string().nullable(),
  free_agent: z.boolean(),
  created_at: z.string(),
});

export const RefundRegistration = z.object({
  /** Omitted = refund the full remaining amount. */
  amount_cents: z.number().int().min(1).optional(),
});
export type RefundRegistration = z.infer<typeof RefundRegistration>;

/** `listRegistrations`' wire shape (RS005 W1a/W1b) — `Registration` widened
 *  with the seven columns the Registrants-tab list/export routes add:
 *  the division's own name/slug, its resolved `entrant_kind`, roster
 *  fill/cap, pending-consent count and (waitlisted rows only) queue
 *  position. Kept SEPARATE from `Registration` rather than folding these
 *  fields into it — the single-registration action routes (approve/reject/
 *  promote/confirm/…) return the narrow shape and never carry
 *  `waitlist_position` or the rest; collapsing the two would advertise those
 *  fields on a response that can never carry them. */
export const RegistrationListEntry = Registration.extend({
  division_name: z.string(),
  division_slug: z.string(),
  entrant_kind: EntrantKind,
  roster_count: z.number().int(),
  /** null = unlimited (the sport declares no lineup config). */
  roster_cap: z.number().int().nullable(),
  consent_pending_count: z.number().int(),
  /** 1-based rank within the division's waitlist; null for every other
   *  status. */
  waitlist_position: z.number().int().nullable(),
  /** RS009 — where a SOLO SIGN-UP currently sits, or null while still in the
   *  pool. Null on every non-solo-sign-up row. Derived from the roster row
   *  pointing back at this entry, never mirrored onto `registrations`, so the
   *  pool and the roster cannot disagree. */
  assigned_team_id: Uuid.nullable(),
  assigned_team_name: z.string().nullable(),
  /** RS009 — the solo sign-up's own gender when the division collected one.
   *  The assign sheet predicts a mixed division's refusal from it BEFORE the
   *  organiser spends a click; null means unknown, and it then predicts
   *  nothing rather than guessing. */
  player_gender: z.string().nullable(),
  /** RS009 — has this row's division started, in the sense that its rosters
   *  are no longer the organiser's to shuffle? True once the division has any
   *  fixture, or once its competition's `starts_on` has passed. Mirrors
   *  `unassignSoloSignUp`'s own refusal so the hub never renders a Remove
   *  button the server will refuse. */
  division_started: z.boolean(),
});

/** `POST /registrations/{id}/promote` body. `id` in the URL resolves which
 *  division to promote within (every registration belongs to exactly one);
 *  `registration_id`, when given, overrides which waitlisted entry gets
 *  promoted instead of the oldest (`PromoteFromWaitlistOpts.registrationId`,
 *  registration-approval.ts) — it need not equal the URL `id`. Omitted →
 *  oldest-first, `promoteFromWaitlist`'s default. */
export const PromoteRegistration = z.object({
  registration_id: Uuid.optional(),
});
export type PromoteRegistration = z.infer<typeof PromoteRegistration>;

/** `POST /registrations/{id}/assign` body (RS009) — places the solo sign-up
 *  `id` onto `target_registration_id`, a team entry in the same division.
 *  `assignSoloSignUp` (registration-assign.ts) owns every rule this can
 *  fail: same-division, roster cap, mixed-division composition, idempotent
 *  re-assign, 409 when the player is already on a different team. */
export const AssignSoloSignUp = z.object({
  target_registration_id: Uuid,
});
export type AssignSoloSignUp = z.infer<typeof AssignSoloSignUp>;

/** `GET /registrations/{id}/assign-targets` response (RS009) — every
 *  assignable team entry in `id`'s division: non-free-agent, non-terminal
 *  registrations, with enough roster state for the UI to explain, BEFORE
 *  the click, why a mixed division will refuse a placement (the same rule
 *  `assignSoloSignUp` enforces server-side). */
export const AssignTargets = z.object({
  division_id: Uuid,
  division_category: z.string().nullable(),
  targets: z.array(
    z.object({
      registration_id: Uuid,
      display_name: z.string(),
      roster_count: z.number().int(),
      /** null = unlimited (the sport declares no lineup config) — same
       *  convention as `RegistrationListEntry.roster_cap`. */
      roster_cap: z.number().int().nullable(),
      is_full: z.boolean(),
      genders: z.array(z.enum(["m", "f", "x"]).nullable()),
    }),
  ),
});
export type AssignTargets = z.infer<typeof AssignTargets>;

/** `POST /registrations/{id}/assign` response (RS009). Carries the roster
 *  state AFTER the placement so a caller need not re-fetch to render the new
 *  fill — the same reason `RegistrationListEntry` carries roster_count and
 *  roster_cap rather than letting each consumer recompute them. */
export const AssignSoloSignUpResult = z.object({
  registration_id: Uuid,
  target_registration_id: Uuid,
  /** The roster row created — or the one already there, since assign is
   *  idempotent and a repeat returns the existing placement. */
  player_id: Uuid,
  target_display_name: z.string(),
  roster_count: z.number().int(),
  /** null = unlimited, never zero. */
  roster_cap: z.number().int().nullable(),
});
export type AssignSoloSignUpResult = z.infer<typeof AssignSoloSignUpResult>;

/** `POST /registrations/{id}/unassign` response (RS009). */
export const UnassignSoloSignUpResult = z.object({
  registration_id: Uuid,
  /** The team they were removed from, or null when they were already in the
   *  pool — unassign is idempotent, and "already where you asked for" is a
   *  success, not an error. */
  target_registration_id: Uuid.nullable(),
});
export type UnassignSoloSignUpResult = z.infer<typeof UnassignSoloSignUpResult>;

// Public register flow -------------------------------------------------------

/** One division on the public register panel. */
export const PublicRegistrationDivision = z.object({
  division_id: Uuid,
  name: z.string(),
  slug: z.string(),
  sport_key: z.string(),
  entrant_kind: EntrantKind,
  fee_cents: z.number().int(),
  /** RS009 — what ONE person pays to enter this team division alone. null =
   *  no separate price; the stepper then quotes `fee_cents`. Present so the
   *  public quote and the server's charge cannot disagree. */
  free_agent_fee_cents: z.number().int().nullable(),
  currency: z.string(),
  payment_method: RegistrationPaymentMethod,
  opens_at: z.string().nullable(),
  closes_at: z.string().nullable(),
  capacity: z.number().int().nullable(),
  /** Spots left before new submissions waitlist; null = uncapped. */
  remaining: z.number().int().nullable(),
  /** Spots taken — the masthead capacity meter (v3/05 §2). */
  taken: z.number().int(),
  open: z.boolean(),
  /** 'window' | 'full' (waitlist only) | 'payments_unavailable' | null */
  closed_reason: z.string().nullable(),
  /** V364 first-class columns (RS006 W1): the ENTRIES step badges these and
   *  greys a self-ineligible division using the same category/age-band
   *  predicates the server evaluates with (@/lib/registration-rules). */
  category: z.string().nullable(),
  age_min: z.number().int().nullable(),
  age_max: z.number().int().nullable(),
  /** RS007/V380 — the age-band cutoff override (default 1 January when
   *  null), threaded onto the wire so the ENTRIES step's client-side self-
   *  check evaluates the SAME cutoff the server enforces at submit. */
  age_cutoff_month: z.number().int().nullable(),
  age_cutoff_day: z.number().int().nullable(),
  /** Team-only; drives the ENTRIES step's free-agent option. */
  allow_free_agents: z.boolean(),
  requires_dob: z.boolean(),
  requires_gender: z.boolean(),
  /** Youth division (v3/11 gap 8): the form always adds guardian consent. */
  youth: z.boolean(),
  form_fields: z.array(RegistrationFormField),
  /** RS007/V380 — the retired jsonb "custom rule" note, now a first-class
   *  column the ENTRIES step renders as an organiser notice. Organiser-
   *  authored free text: render as TEXT, never as HTML/markdown. */
  eligibility_note: z.string().nullable(),
});

export const PublicRegistrationInfo = z.object({
  competition: z.object({
    id: Uuid,
    name: z.string(),
    slug: z.string(),
    starts_on: z.string().nullable(),
    ends_on: z.string().nullable(),
  }),
  org: z.object({ name: z.string(), slug: z.string(), logo_url: z.string().nullable() }),
  divisions: z.array(PublicRegistrationDivision),
});

// The old single-entry `PublicRegisterRequest`/`PublicRegisterResponse` pair
// (and the POST route that used them) was deleted in the RS001 registration
// demolition — V363/V364 replaced the one-row-per-entry shape with
// `registration_groups` (cart) + `registration_players` (per-player rows),
// which this schema had no way to express. RS003 defines the new group-shaped
// request/response (design `2026-08-16-registration-redesign-design.md` §4).

/** Contact captured once, cart-wide — every entry's self-declaration and the
 *  guardian-consent gate both read from this one shape (`SubmitGroupContact`
 *  mirror, registration-submit.ts:47-58). */
export const PublicRegisterGroupContact = z.object({
  name: z.string().min(1).max(120),
  email: z.email().max(200),
  dob: z.iso.date().nullish(),
  gender: z.enum(["m", "f", "x"]).nullish(),
  guardian_name: z.string().max(120).nullish(),
  guardian_consent: z.boolean().optional(),
});

/** One player row on an entry (`SubmitGroupPlayerInput` mirror, registration-
 *  submit.ts:60-67). Reused unchanged by the join request below — a joiner
 *  IS a player row, just for an entry that already exists. */
export const PublicRegisterGroupPlayer = z.object({
  full_name: z.string().min(1).max(120),
  dob: z.iso.date().nullish(),
  gender: z.enum(["m", "f", "x"]).nullish(),
  email: z.email().max(200).nullish(),
  squad_number: z.number().int().min(0).max(999).nullish(),
  is_captain: z.boolean().optional(),
});

/** One cart line (`SubmitGroupEntryInput` mirror, registration-submit.ts:69-89). */
export const PublicRegisterGroupEntry = z.object({
  division_id: Uuid,
  entrant_kind: EntrantKind,
  team_name: z.string().max(120).nullish(),
  partner_name: z.string().max(120).nullish(),
  free_agent: z.boolean().optional(),
  players: z.array(PublicRegisterGroupPlayer).max(50).optional(),
  answers: z.record(z.string(), z.unknown()).optional(),
  /** True when the CONTACT themselves is one of this entry's players. */
  registering_self: z.boolean().optional(),
  /** 0-based index into `players` identifying which row IS the contact. */
  self_player_index: z.number().int().min(0).optional(),
});

/**
 * Full cart submit (`SubmitGroupInput` mirror, registration-submit.ts:91-98).
 * No `currency` field on purpose — it is server-resolved from
 * `organizations.currency` and snapshotted by the usecase (registration-
 * submit.ts:497); a client-supplied one is simply never declared here, so
 * Zod's default (non-`.strict()`) object mode strips it rather than
 * rejecting the whole request — same as every other public request schema
 * in this file.
 *
 * #402 lineage: the pre-redesign single-entry `PublicRegisterRequest` had
 * a self-declaration coherence rule, expressed per-player-row (a top-level
 * `registering_self` PLUS a `players[].self` flag — see this file's history
 * at `850cc6308^` and `public-register-request.test.ts` at that revision).
 * The group shape collapses the two flags into one per-entry pair
 * (`registering_self` + `self_player_index`); the superRefine below is that
 * rule's per-entry replacement: a contact dob whenever ANY entry claims
 * `registering_self`, and each claim's index must land on a real player row
 * (registration-submit.ts:384-390 silently DROPS an unresolvable self
 * declaration rather than erroring, so this is the only place that tells
 * the registrant their link didn't take). A registrant MAY claim
 * `registering_self` on more than one entry cart-wide (RS006: singles +
 * doubles at the same tournament) — nothing here caps it, and
 * `self_player_index` being a single int per entry already makes "one self
 * row per ENTRY" true by construction, so no additional uniqueness check is
 * needed.
 */
export const PublicRegisterGroupRequest = z
  .object({
    contact: PublicRegisterGroupContact,
    locale: z.string().max(10).nullish(),
    privacy_consent: z.boolean(),
    /** Optional — mirrors `privacy_consent` structurally but never blocks
     *  submit (RS006 §A). Stamped the same way (timestamp + LEGAL_VERSION,
     *  registration-submit.ts) when true; left null otherwise. */
    media_consent: z.boolean().optional(),
    entries: z.array(PublicRegisterGroupEntry).min(1).max(10),
    /** Honeypot (v3/05 §4): hidden on the real form; the ROUTE decides what
     *  to do with a filled one, not this schema. */
    website: z.string().max(200).optional(),
  })
  .superRefine((v, ctx) => {
    const selfEntries = v.entries
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.registering_self);
    // A registrant may be `registering_self` on more than one entry (singles
    // + doubles at the same tournament is the common case in racket sports).
    // Nothing above this comment enforces a cart-wide cap any more — see
    // `self_player_index`'s own field comment above: a single int per entry
    // already makes "one self row PER ENTRY" true by construction, which is
    // all uniqueness this shape ever needed. Do not reintroduce a cart-wide
    // counter here "for safety" — that was the defect, not a guard.
    if (selfEntries.length > 0 && !v.contact.dob) {
      ctx.addIssue({
        code: "custom",
        path: ["contact", "dob"],
        message: "A date of birth is required when you're registering yourself",
      });
    }
    // Per-DIVISION, and deliberately not the cart-wide counter the comment
    // above forbids: linking yourself on entries in two DIFFERENT divisions
    // is the legitimate singles + doubles case. Twice in ONE division is the
    // same person entered twice into one draw — `persons` get-or-create keys
    // on name+dob, so both entries resolve to a single person who then holds
    // two capacity slots and is charged for both. There is no unique index on
    // (division_id, entrant) to catch it, so this is the only guard.
    const selfDivisionFirstSeen = new Map<string, number>();
    for (const { e, i } of selfEntries) {
      const firstIndex = selfDivisionFirstSeen.get(e.division_id);
      if (firstIndex === undefined) {
        selfDivisionFirstSeen.set(e.division_id, i);
      } else {
        ctx.addIssue({
          code: "custom",
          path: ["entries", i, "registering_self"],
          message: `You're already entered as yourself on another entry in this division (entry ${firstIndex + 1}) — a division can only have you once`,
        });
      }
    }
    for (const { e, i } of selfEntries) {
      // This MUST mirror the usecase's own resolution verbatim
      // (registration-submit.ts:383-393): an explicit index, or the implied 0
      // that a one-player INDIVIDUAL entry gets — and nothing else. A team,
      // pair or free-agent entry that claims `registering_self` without
      // naming the row resolves to `undefined` there and has its self
      // declaration DROPPED SILENTLY: the entry submits, the registrant is
      // never linked to their own player row, and nothing anywhere errors.
      // Defaulting to 0 here instead of `undefined` would validate exactly
      // that request and hand it to the drop. This layer is the only one that
      // can tell the registrant their self-link did not take.
      const players = e.players ?? [];
      const idx =
        e.self_player_index ??
        (e.entrant_kind === "individual" && players.length === 1 ? 0 : undefined);
      if (idx === undefined || !players[idx]) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", i, "self_player_index"],
          message: "self_player_index must identify which player on this entry is you",
        });
      }
    }
  });
export type PublicRegisterGroupRequest = z.infer<typeof PublicRegisterGroupRequest>;

/** One entry's outcome (`SubmitGroupEntryResult` mirror, registration-
 *  submit.ts:112-119). */
export const PublicRegisterGroupEntryResult = z.object({
  registration_id: Uuid,
  division_id: Uuid,
  status: RegistrationStatus,
  amount_cents: z.number().int(),
  join_code: z.string().nullable(),
  free_agent: z.boolean(),
});


/** Cart-level outcome (`SubmitGroupResult` mirror, registration-
 *  submit.ts:121-130). `checkout_url` is required-but-nullable: wave 3 wires
 *  Stripe and starts returning a real URL when a payment is due now, but the
 *  field exists from this wave on so the wire contract never has to widen. */
export const PublicRegisterGroupResponse = z.object({
  group_id: Uuid,
  ref_code: z.string().nullable(),
  access_token: z.string(),
  currency: z.string(),
  amount_cents: z.number().int(),
  checkout_url: z.string().nullable(),
  entries: z.array(PublicRegisterGroupEntryResult),
});

/** Join an existing team OR pair entry via its `join_code` link
 *  (`JoinTeamEntryInput` mirror, registration-submit.ts). A joiner is one
 *  player row, so this reuses the same player shape submit uses.
 *  `player_id` (optional) is a per-slot claim link naming ONE existing
 *  captain-entered row to CLAIM in place — omitted, it falls back to
 *  inserting a genuinely new player (refused for a `pair`, whose roster is
 *  fixed at two). */
export const PublicJoinRequest = z.object({
  join_code: z.string().min(1).max(80),
  player: PublicRegisterGroupPlayer,
  player_id: Uuid.nullish(),
  guardian_name: z.string().max(120).nullish(),
  guardian_consent: z.boolean().optional(),
  /** RS007 review defect #4 fix — collected by the join page's own CONSENT
   *  step (StepConsent, reused verbatim) and persisted PER-PLAYER by
   *  joinTeamEntry (registration_players.privacy_consent_at/.version,
   *  V384), never on registration_groups — that would silently apply the
   *  CAPTAIN's own choice to every later joiner, which is the bug that fix
   *  closed. REQUIRED here, same as PublicRegisterGroupRequest.privacy_consent
   *  (consent-asymmetry follow-up, 2026-08-28): this field was previously
   *  optional, enforced only by the join form's own client-side gate
   *  (validateConsent) — a direct API call could join with no consent
   *  recorded at all, and an omitted value was indistinguishable from a
   *  refusal. joinTeamEntry now throws 422 on a falsy value, mirroring
   *  submitRegistrationGroup's own gate (registration-submit.ts:547),
   *  identically on BOTH the claim and insert branches — a captain-typed
   *  row's own consent was never collected either, so the claim moment is
   *  exactly as much this player's first consent as a fresh insert's is. */
  privacy_consent: z.boolean(),
  /** Optional, never blocks — mirrors PublicRegisterGroupRequest.media_consent
   *  structurally (RS006 §A: "media consent is OPTIONAL and never blocks
   *  submit"). Stamped when true, left null otherwise (a deliberate `false`
   *  persists as a refusal, same as that field). */
  media_consent: z.boolean().optional(),
});
export type PublicJoinRequest = z.infer<typeof PublicJoinRequest>;

/** (`JoinTeamEntryResult` mirror, registration-submit.ts). `consent_status`
 *  is deliberately the 2-value subset this path actually returns —
 *  'pending' is `registration_players`' 3rd DB-level value, and neither the
 *  claim nor the insert branch of `joinTeamEntry` ever produces it (both
 *  only ever pick granted or guardian). */
export const PublicJoinResponse = z.object({
  registration_id: Uuid,
  player_id: Uuid,
  consent_status: z.enum(["granted", "guardian"]),
});

/** One CAPTAIN-ENTERED, still-`pending` slot on an entry — claimable by
 *  sending its `player_id` back as `PublicJoinRequest.player_id`
 *  (`JoinPreviewSlot` mirror, registration-submit.ts). */
export const PublicJoinPreviewSlot = z.object({
  player_id: Uuid,
  full_name: z.string(),
});

/** Join-link preview (`JoinPreviewResult` mirror, registration-submit.ts) —
 *  the join page's first read, before it asks anyone to type anything: who/
 *  where the link joins, which slots are still unclaimed, and whether the
 *  page may offer an "add someone new" option (never for a `pair`; never
 *  once the sport's roster cap is met). */
export const PublicJoinPreviewResponse = z.object({
  registration_id: Uuid,
  display_name: z.string(),
  division_name: z.string(),
  competition_name: z.string(),
  competition_slug: z.string(),
  org_slug: z.string(),
  org_name: z.string(),
  unclaimed_slots: z.array(PublicJoinPreviewSlot),
  allow_new_player: z.boolean(),
  /** RS007 join page — whether the WHO-equivalent step must collect a
   *  dob/gender before this division's eligibility can be evaluated
   *  (`JoinPreviewResult` mirror, registration-submit.ts). */
  requires_dob: z.boolean(),
  requires_gender: z.boolean(),
  /** This entry's WHOLE roster size — lets the join page compute a fill
   *  meter after a successful join with no second round-trip. */
  total_players: z.number().int().nonnegative(),
  /** RS007/V380 — the retired jsonb "custom rule" note, now a first-class
   *  column the join page renders as an organiser notice. Organiser-
   *  authored free text: render as TEXT, never as HTML/markdown. */
  eligibility_note: z.string().nullable(),
});
export type PublicJoinPreviewResponse = z.infer<typeof PublicJoinPreviewResponse>;

/** Registrant-facing status view (token-gated; no dob, no payment ids). */
export const PublicRegistrationStatus = z.object({
  id: Uuid,
  status: RegistrationStatus,
  /** Quotable reference (v3/05 §3); null on pre-v2 rows. */
  ref_code: z.string().nullable(),
  display_name: z.string(),
  division_name: z.string(),
  competition_name: z.string(),
  competition_slug: z.string(),
  org_slug: z.string(),
  org_name: z.string(),
  starts_on: z.string().nullable(),
  ends_on: z.string().nullable(),
  fee_cents: z.number().int(),
  amount_cents: z.number().int(),
  currency: z.string().nullable(),
  refunded_cents: z.number().int(),
  /** True when a payment is due and the registrant can (re)open checkout. */
  payment_due: z.boolean(),
  created_at: z.string(),
});

export const PublicRegistrationToken = z.object({ token: z.string().min(10).max(200) });
export type PublicRegistrationToken = z.infer<typeof PublicRegistrationToken>;

// Stripe Connect (org onboarding) --------------------------------------------

export const ConnectStatus = z.object({
  connected: z.boolean(),
  charges_enabled: z.boolean(),
  details_submitted: z.boolean().nullable(),
  payouts_enabled: z.boolean(),
  disabled_reason: z.string().nullable(),
  requirements_due: z.number(),
  /** Card-unsupported state (RS001b): the connected account's settlement
   *  currency when it is outside `REGISTRATION_CURRENCIES`, else null. The
   *  same-currency rule means we cannot charge in it and will not charge
   *  across it, so card registration is unavailable until the account settles
   *  in an allowlisted currency. Surfaced at connect time; RS004 renders it. */
  unsupported_currency: z.string().nullable(),
  /** V411 — payout health: why the club's money is not reaching its bank when
   *  `payouts_enabled` still reads true. Set by `payout.failed` and the two
   *  `account.external_account.*` events, cleared by `payout.paid`. The value
   *  SELECTS the banner's copy, so the wire carries no English; the operator
   *  detail behind it (Stripe's failure code, the account identifier) stays
   *  server-side and is deliberately not exposed here. */
  payout_alert: z.enum(["payout_failed", "bank_removed", "bank_changed"]).nullable(),
});

export const CreateConnectOnboarding = z.object({
  /** App-relative path to return to after Stripe onboarding. */
  return_path: z.string().max(300).regex(/^\//, "app-relative path").default("/settings/billing"),
  /** Acceptance of the entry-fee chargeback terms (ToS §5). Required for the
   *  first connect — the connected account is only created once accepted;
   *  resuming onboarding does not re-ask (PROMPT-55). */
  tos_agreed: z.boolean().default(false),
});
export type CreateConnectOnboarding = z.infer<typeof CreateConnectOnboarding>;

export const ConnectOnboardingLink = z.object({ url: z.string() });

// Clubs & bulk import (Jul3/01, PROMPT-21) ------------------------------------

export const Club = z.object({
  id: z.string(),
  name: z.string(),
  short_name: z.string().nullable(),
  logo_path: z.string().nullable(),
  colors: z.record(z.string(), z.string()).nullable(),
  external_ref: z.string().nullable(),
  slug: z.string().nullable(),
  home_ground: z.string().nullable(),
  website: z.string().nullable(),
  notes: z.string().nullable(),
  created_at: z.string(),
});

export const CreateClub = z.object({
  name: z.string().min(1).max(200),
  short_name: z.string().min(1).max(40).optional(),
  colors: z.record(z.string(), z.string()).optional(),
  external_ref: z.string().min(1).max(100).optional(),
  home_ground: z.string().min(1).max(200).optional(),
  website: z.string().url().max(200).optional(),
  notes: z.string().max(2000).optional(),
});
export type CreateClub = z.infer<typeof CreateClub>;

export const PatchClub = z.object({
  name: z.string().min(1).max(200).optional(),
  short_name: z.string().min(1).max(40).nullable().optional(),
  colors: z.record(z.string(), z.string()).nullable().optional(),
  external_ref: z.string().min(1).max(100).nullable().optional(),
  logo_path: z.string().nullable().optional(),
  slug: z.string().min(1).max(80).nullable().optional(),
  home_ground: z.string().min(1).max(200).nullable().optional(),
  website: z.string().url().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export type PatchClub = z.infer<typeof PatchClub>;

// Club contacts (W1 §4.2 FA officer model). is_primary is unique per club.
export const ClubContact = z.object({
  id: z.string(), club_id: z.string(), role_key: z.string(),
  full_name: z.string(), email: z.string().nullable(), phone: z.string().nullable(),
  is_primary: z.boolean(), user_id: z.string().nullable(),
  claimed_at: z.string().nullable(), created_at: z.string(),
});
export const CreateClubContact = z.object({
  role_key: z.enum(["secretary", "chairman", "treasurer", "welfare", "manager", "other"]),
  full_name: z.string().min(1).max(200),
  email: z.string().email().max(200).nullable().optional(),
  phone: z.string().min(3).max(40).nullable().optional(),
  is_primary: z.boolean().optional(),
});
export type CreateClubContact = z.infer<typeof CreateClubContact>;
export const PatchClubContact = CreateClubContact.partial();
export type PatchClubContact = z.infer<typeof PatchClubContact>;

// Standalone team create + move/detach (W1 §5.2).
export const CreateTeamStandalone = z.object({
  name: z.string().min(1).max(200),
  short_name: z.string().min(1).max(60).optional(),
  club_id: z.string().uuid().optional(),
});
export type CreateTeamStandalone = z.infer<typeof CreateTeamStandalone>;
export const PatchTeam = z.object({ club_id: z.string().uuid().nullable() });
export type PatchTeam = z.infer<typeof PatchTeam>;

export const ClubDetail = Club.extend({
  teams: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      short_name: z.string().nullable(),
      logo_path: z.string().nullable(),
      entries: z.array(
        z.object({
          division_id: z.string(),
          entrant_id: z.string(),
          division_name: z.string(),
          competition_id: z.string(),
        }),
      ),
    }),
  ),
  contacts: z.array(ClubContact),
});

export const LogoAssignment = z.object({
  filename: z.string(),
  clubId: z.string().nullable(),
  clubName: z.string().nullable(),
  matchedBy: z.enum(["filename", "manual", "order"]).nullable(),
  logoPath: z.string().nullable(),
});

// The plan itself is the engine's ImportPlan (typed there); the API documents
// it loosely — clients treat it as display data.
export const ImportPreview = z.object({
  importId: z.string(),
  filename: z.string(),
  status: z.enum(["planned", "committed"]),
  rowCount: z.number().int(),
  mapping: z.record(z.string(), z.string()).optional(),
  plan: z.object({
    ops: z.array(z.record(z.string(), z.unknown())),
    stats: z.object({
      clubs: z.number().int(),
      teams: z.number().int(),
      persons: z.number().int(),
      entrants: z.number().int(),
      rosters: z.number().int(),
      /** W4: squad places written to `team_members`. Distinct from `rosters`,
       *  which counts entrant-roster spots — a file with no Division column
       *  has zero of those and a non-zero `squads`. */
      squads: z.number().int(),
    }),
    issues: z.array(
      z.object({
        rowNo: z.number().int(),
        column: z.string().optional(),
        severity: z.enum(["error", "warn"]),
        code: z.string(),
        message: z.string(),
      }),
    ),
  }),
});

/** POST /imports/{id}/commit — no body field until RS011: `commitImport`
 *  aggregates eligibility issues across every division the plan's
 *  `roster.add` ops touch and, on a violation, accepts exactly ONE override
 *  for the whole import (one audit row, not one per row — see
 *  `commitImport`'s own comment). */
export const ImportCommitRequest = z.object({
  eligibility_override: EligibilityOverride.optional(),
});
export type ImportCommitRequest = z.infer<typeof ImportCommitRequest>;

export const ImportCommitResult = z.object({
  importId: z.string(),
  stats: ImportPreview.shape.plan.shape.stats,
  divisionIds: z.array(z.string()),
});

// Referee & officials assignment (Jul3/02, PROMPT-22) -------------------------

export const Official = z.object({
  id: z.string(),
  person_id: z.string().nullable(),
  entrant_id: z.string().nullable(),
  display_name: z.string(),
  email: z.string().nullable(),
  role_keys: z.array(z.string()),
  home_pool_id: z.string().nullable(),
  max_per_day: z.number().int().nullable(),
  created_at: z.string(),
});

export const CreateOfficial = z.object({
  display_name: z.string().min(1).max(200),
  person_id: Uuid.optional(),
  entrant_id: Uuid.optional(),
  email: z.email().max(200).nullable().optional(),
  role_keys: z.array(z.string().min(1)).min(1).default(["referee"]),
  home_pool_id: Uuid.nullable().optional(),
  max_per_day: z.number().int().positive().nullable().optional(),
});

export const PatchOfficial = CreateOfficial.partial();

// Sponsor CRM (v10 PROMPT-56) -------------------------------------------------

export const SponsorTier = z.enum(["title", "gold", "silver", "partner"]);
export const SponsorStatus = z.enum(["active", "pending", "inactive"]);

export const Sponsor = z.object({
  id: z.string(),
  competition_id: z.string().nullable(),
  name: z.string(),
  url: z.string().nullable(),
  logo_path: z.string().nullable(),
  tier: SponsorTier,
  display_order: z.number().int(),
  status: SponsorStatus,
  click_count: z.number().int(),
  created_at: z.string(),
  /** Set on list reads when a paid package order activated this placement. */
  paid_order_id: z.string().nullable().optional(),
  /** List reads: true while that order carries an open payment dispute — the
   *  placement was parked by the dispute handler and can't be re-activated. */
  dispute_parked: z.boolean().optional(),
  /** List reads: a lost dispute wrote the activating order off — the
   *  placement stays down and this explains why. */
  dispute_lost: z.boolean().optional(),
});

export const CreateSponsor = z.object({
  name: z.string().min(1).max(80),
  url: z.string().url().max(500).nullish(),
  logo_path: z.string().max(500).nullish(),
  tier: SponsorTier.default("partner"),
  competition_id: Uuid.nullish(),
  status: SponsorStatus.default("active"),
});

export const PatchSponsor = CreateSponsor.partial();

export const ReorderSponsors = z.object({ ids: z.array(Uuid).min(1).max(200) });

export const SponsorPackage = z.object({
  id: z.string(),
  competition_id: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  price_cents: z.number().int(),
  currency: z.string(),
  tier: SponsorTier,
  active: z.boolean(),
  created_at: z.string(),
});

export const CreateSponsorPackage = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullish(),
  price_cents: z.number().int().positive().max(5_000_000),
  currency: z.string().length(3).toLowerCase().default("gbp"),
  tier: SponsorTier.default("partner"),
  competition_id: Uuid.nullish(),
});

export const SponsorOrder = z.object({
  id: z.string(),
  package_id: z.string(),
  sponsor_name: z.string(),
  sponsor_email: z.string(),
  payment_intent_id: z.string().nullable(),
  amount_cents: z.number().int(),
  currency: z.string(),
  status: z.enum(["pending", "paid", "failed", "refunded"]),
  sponsor_id: z.string().nullable(),
  created_at: z.string(),
  paid_at: z.string().nullable(),
  disputed_at: z.string().nullable(),
  dispute_id: z.string().nullable(),
});

export const StartSponsorCheckout = z.object({
  package_id: Uuid,
  sponsor_name: z.string().min(1).max(80),
  sponsor_email: z.string().email().max(320),
});

export const SponsorCheckoutStarted = z.object({
  order: SponsorOrder,
  checkout_url: z.string(),
});

// ---------------------------------------------------------------------------
// Officiating portal (PROMPT-57) — assignment responses, blackout dates,
// the official's score link
// ---------------------------------------------------------------------------

export const OfficiatingResponseInput = z.object({
  response: z.enum(["accepted", "declined"]),
  decline_reason: z.string().max(500).nullish(),
});
export type OfficiatingResponseInput = z.infer<typeof OfficiatingResponseInput>;

export const OfficiatingResponseOut = z.object({
  fixture_id: Uuid,
  response: z.enum(["pending", "accepted", "declined"]),
  decline_reason: z.string().nullable(),
});

export const OfficiatingBlackoutInput = z.object({
  date: z.iso.date(),
  note: z.string().max(200).nullish(),
});
export type OfficiatingBlackoutInput = z.infer<typeof OfficiatingBlackoutInput>;

export const OfficiatingBlackout = z.object({
  date: z.string(),
  note: z.string().nullable(),
});

/** POST response only — the pad URL embeds the secret, shown exactly once. */
export const OfficiatingScoreLink = z.object({
  secret: z.string(),
  expires_at: z.string(),
});

/** POST /me/officiating-claims/{id}/accept response (v11.1 — the /me
 *  "Pending invites" card; the list itself is server-rendered, not an
 *  /api/v1 route, so this is the only officiating-claim schema needed). */
export const OfficiatingClaimAccepted = z.object({
  org_name: z.string(),
  official_name: z.string(),
});

const AssignPolicyBody = z.object({
  roles: z.array(z.string().min(1)).min(1),
  poolLock: z.boolean().default(false),
  blockStay: z.boolean().default(false),
  fairness: z.enum(["tournament", "per_day"]).default("tournament"),
  teamRefKeepDivision: z.boolean().default(false),
  restMinMinutes: z.number().int().nonnegative().default(0),
  blockGapMinutes: z.number().int().positive().default(30),
});

export const AutoAssignOfficials = z.object({
  policy: AssignPolicyBody,
  rng_seed: z.string().default("officials"),
});

export const OfficialsProposal = z.object({
  assignments: z.array(
    z.object({
      fixtureId: z.string(),
      officialId: z.string(),
      roleKey: z.string(),
      locked: z.boolean().optional(),
    }),
  ),
  conflicts: z.array(
    z.object({
      kind: z.string(),
      severity: z.enum(["block", "warn"]),
      fixtureId: z.string().optional(),
      officialId: z.string().optional(),
      roleKey: z.string().optional(),
      detail: z.string().optional(),
    }),
  ),
});

export const ApplyOfficials = z.object({
  assignments: z.array(
    z.object({
      fixture_id: Uuid,
      official_id: Uuid,
      role_key: z.string().min(1),
      locked: z.boolean().default(false),
    }),
  ),
  /** Audit provenance when the set came from the AI Officials Architect (v4/03
   *  §10) — shared with ApplyScheduleRequest; merged into officials_assigned. */
  ai: AiApplyMeta.optional(),
});

export const PatchFixtureOfficials = z.object({
  set: z.array(
    z.object({
      official_id: Uuid,
      role_key: z.string().min(1),
      locked: z.boolean().default(false),
    }),
  ),
});

export const SourceOfficials = z.object({
  sources: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("rank"),
          fromStage: z.string(),
          take: z.array(z.object({ poolId: z.string().optional(), rank: z.number().int().positive() })),
        }),
        z.object({
          kind: z.literal("result"),
          fromFixture: z.string(),
          side: z.enum(["winner", "loser"]),
        }),
      ]),
    )
    .min(1),
});

// Schedule undo & versioning (Jul3/03, PROMPT-23) -----------------------------

export const HistoryStep = z.object({
  /** Optimistic token: the division seq the client last saw (409 on stale). */
  expected_seq: z.number().int().optional(),
});

export const CreateCheckpoint = z.object({
  label: z.string().min(1).max(120),
  /** V303. Omitted = "manual": an organiser's own save point, counted against
   *  schedule.checkpoints.max. "ai" is the undo anchor the AI accept flow
   *  creates on their behalf, and is exempt from that quota. */
  kind: z.enum(["manual", "ai"]).optional(),
});

export const RestoreCheckpoint = z.object({
  checkpoint_id: Uuid,
  confirm: z.literal(true),
});

export const DivisionLocks = z.object({
  schedule_locked: z.boolean().optional(),
  // P9 pass-3a-FIX: courts/venues are real ids (V374's locked_scopes
  // migration; `usecases/schedule.ts`'s `scopeLocked` matches on
  // court_id/venue_id, not organiser-typed names) — CourtId/VenueId, not a
  // bare string, mirrors `usecases/history.ts`'s `LockInput` (the schema
  // that actually validates this route's body; kept identical by hand, same
  // as before this pass, to avoid the two drifting).
  locked_scopes: z
    .array(
      z.object({
        courts: z.array(CourtId).optional(),
        venues: z.array(VenueId).optional(),
        pool_ids: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

export const ClearSchedule = z.object({
  division_id: Uuid,
  scope: z
    .object({
      stageId: z.string().optional(),
      poolIds: z.array(z.string()).optional(),
      rounds: z.array(z.number().int()).optional(),
      courts: z.array(z.string()).optional(),
      excludeLocked: z.boolean().default(true),
    })
    .default({ excludeLocked: true }),
  confirm: z.literal(true),
});

export const ClearPoolEntrants = z.object({ confirm: z.literal(true) });

// Scheduling constraints v2 & AI (Jul3/04, PROMPT-24) -------------------------

export const ScheduleShift = z.object({
  division_id: Uuid,
  scope: z
    .object({
      stageId: z.string().optional(),
      poolIds: z.array(z.string()).optional(),
      courts: z.array(z.string()).optional(),
      excludeLocked: z.boolean().default(true),
    })
    .default({ excludeLocked: true }),
  delta_minutes: z.number().int().min(-1440).max(1440),
});

// Token-weighted AI credit rung (lib/ai-rung.ts, issue #348).
const RungLiteral = z.union([z.literal(1), z.literal(2), z.literal(3)]);

/**
 * What an AI run cost and what that bought, spread into every AI response so
 * the confirm card reads one shape whatever endpoint answered it. Mirrors
 * `RunMeterStamp` in lib/ai-rung.ts — the single builder both phases (and #350's
 * joint solve) stamp their ledger event and response with.
 *
 * Optional so fixtures and clients written before this field set still satisfy
 * the type; every real response sends `credits`, `budget`, `spent_tokens`,
 * `underfunded`, `stopped_on_budget` and `est_tokens`. `rung`/`predicted_rung`
 * are the single-division flat form; `divisions`/`discount` the joint form.
 */
const AiRunPriceFields = {
  /** Credits actually charged (after any joint batch discount). */
  credits: z.number().int().optional(),
  /** Hard generation-token budget those credits bought. */
  budget: z.number().int().optional(),
  /** Generation tokens the run actually spent. */
  spent_tokens: z.number().int().optional(),
  /** Advisory pre-run estimate the confirm card showed. */
  est_tokens: z.number().int().optional(),
  /** A rung below the prediction was chosen. */
  underfunded: z.boolean().optional(),
  /** The run ended because the budget ran out, not because it was done. */
  stopped_on_budget: z.boolean().optional(),
  /** Single-division form. */
  rung: RungLiteral.optional(),
  predicted_rung: RungLiteral.optional(),
  /**
   * Set ONLY when the client's confirm card quoted a different number than the
   * server charged (#387).
   *
   * The card computes its quote by calling the same pure function the server
   * calls — deliberately, so there is one arithmetic implementation and no
   * per-keystroke fetch. That rests on one premise: same function, same inputs,
   * same environment. PR #359 found three ways it breaks and #385 closed the
   * largest; this field makes any residual divergence VISIBLE instead of
   * silent.
   *
   * Both directions are reported. An over-quote is a bad surprise on screen; an
   * under-quote is a billing complaint. Absent means they agreed — or that the
   * caller sent no quote at all, which is not the same as quoting zero.
   */
  quote_mismatch: z.object({ quoted: z.number().int(), charged: z.number().int() }).optional(),
  /** Joint (multi-division) form — issue #350. */
  discount: z.number().int().optional(),
  divisions: z
    .array(
      z.object({
        id: z.string(),
        rung: RungLiteral,
        predicted_rung: RungLiteral,
        underfunded: z.boolean(),
      }),
    )
    .optional(),
};

// v4 AI Schedule Architect (design/v4/00-03) — Phase A propose-only endpoint.
// The model proposes times+courts; the engine verifier is authoritative. This
// contract carries the request instruction, an optional repair scope, an
// optional prior proposal (refine), and an optional officials policy for a dry
// coverage preview (no LLM). `officials_policy` reuses the officials-auto body.
export const AiPlanRequest = z.object({
  instruction: z.string().min(3).max(4000),
  mode: z.enum(["generate", "refine", "repair"]).default("generate"),
  scope: z
    .object({
      from: IsoDateTime.optional(),
      // P9 pass 3b: real `courts.id` values — `buildSchedulePack`'s own
      // `inScope()` matches this against a fixture's `court_id`, and its
      // scope-validation check compares it against `ScheduleConfig.courts`
      // (`CourtId[]` since pass 1), so a bare `z.string()` here let a
      // free-text label through the parse only to silently never match
      // anything downstream.
      courts: z.array(CourtId).optional(),
      pool_ids: z.array(Uuid).optional(),
    })
    .optional(),
  prior: z
    .object({
      instruction: z.string(),
      assignments: z.array(
        z.object({ fixture_id: Uuid, scheduled_at: z.string(), court_label: z.string() }),
      ),
    })
    .optional(),
  officials_policy: AssignPolicyBody.optional(),
  // Token-weighted AI credit rung (lib/ai-rung.ts): defaults to the server
  // prediction when omitted. A caller may pick below the prediction — the run
  // still executes, capped to the chosen rung's token budget, and the ledger
  // stamps `underfunded: true`.
  rung: RungLiteral.optional(),
  /**
   * W5 (#400): the confirmed compile from `POST .../schedule/ai-preview`. When
   * present the run reuses that stored parse instead of compiling a second
   * time, so the rules the organiser approved are the rules the architect
   * executes under — and a `preview_id` whose stored instruction no longer
   * matches this request's is a 409 `preview_stale` rather than a silent
   * recompile.
   *
   * OPTIONAL, and it must stay that way: smoke, the e2e API paths and every
   * external consumer post a run without one, and compile inline exactly as
   * they always have.
   */
  preview_id: Uuid.optional(),
  /**
   * What the confirm card showed (#387). The server compares it against what it
   * actually charged, reports the divergence on `quote_mismatch` and records a
   * `schedule.ai_quote_mismatch` competition_event.
   *
   * OPTIONAL, and it must stay that way: server-side callers, smoke and every
   * external consumer send none. `.positive()` rather than `.nonnegative()`
   * because there is no such thing as a zero-credit quote — an absent value must
   * never be read as "quoted nothing", and a client that means "I showed no
   * price" says so by omitting the field.
   */
  quoted_credits: z.number().int().positive().optional(),
});
export type AiPlanRequest = z.infer<typeof AiPlanRequest>;

const AiPlanAssignment = z.object({
  fixture_id: Uuid,
  scheduled_at: z.string(),
  court_label: z.string(),
  schedule_locked: z.boolean().optional(),
});

/** CamelCase mirror of `ScheduleConflictDetail` above — same fields, same
 *  `ConflictDetailKindSchema`, matching the engine's own `ConflictDetail`
 *  casing 1:1 (this schema's whole point is to carry the engine's verbatim
 *  shape, per `AiPlanConflict`'s own comment below).
 *
 *  Id fields are plain `z.string()`, NOT `Uuid`, unlike `ScheduleConflictDetail`
 *  — deliberately looser, matching `AiPlanConflict.fixtureId` right below.
 *  The joint pack collapses two `persons` rows that share a display name onto
 *  a synthetic `name:<lowercased name>` key (competition-schedule-ai.ts) and
 *  that key can be exactly what rides in `personIds` here; a strict UUID
 *  format would reject a real, correctly-computed conflict. */
const AiPlanConflictDetail = z.object({
  kind: ConflictDetailKindSchema,
  /** Review wave 3: the DERIVED, venue-qualified court name beside the raw
   *  `court` id. Without it declared, zod strips whatever a caller attaches
   *  and `formatConflictDetail` degrades every court conflict to "Unknown
   *  court" — the field has to exist here as well as be resolved server-side. */
  courtName: z.string().optional(),
  entrantIds: z.array(z.string()).optional(),
  personIds: z.array(z.string()).optional(),
  otherFixtureId: z.string().optional(),
  court: z.string().optional(),
  day: z.string().optional(),
  otherDay: z.string().optional(),
  weekday: z.string().optional(),
  requiredWeekday: z.string().optional(),
  requiredDate: z.string().optional(),
  time: z.string().optional(),
  requiredTime: z.string().optional(),
  ruleType: z.string().optional(),
  roundNo: z.number().int().optional(),
  otherRoundNo: z.number().int().optional(),
  minutes: z.number().int().optional(),
  requiredMinutes: z.number().int().optional(),
  count: z.number().int().optional(),
  requiredCount: z.number().int().optional(),
});

// Engine verifier conflict (camelCase, @seazn/engine/scheduling Conflict).
const AiPlanConflict = z.object({
  fixtureId: z.string(),
  reason: z.string(),
  /** @deprecated Pre-C3 English, derived server-side (byte-for-byte) from
   *  `details` by the deprecated `legacyConflictDetail` — kept only for
   *  clients that read prose off the wire (the C3 design doc's ruling: the
   *  MODEL's own copy of a conflict, on the repair-round conversation, is a
   *  separate JSON.stringify that never reaches this schema and stays
   *  byte-identical to pre-C3 on its own — see schedule-ai.ts/
   *  competition-schedule-ai.ts). New clients should read `details` and
   *  localize at render time. */
  detail: z.string().optional(),
  /** Structured, id-only conflict detail (C3, 2026-08-13 design amendment).
   *  Declared here or zod strips it on any call site that actually
   *  `.parse()`s this shape, the same trap the `rule` comment above already
   *  names for this object. */
  details: AiPlanConflictDetail.optional(),
  direct: z.boolean().optional(),
  /** The rule the prompt taught for this reason (#399), so a repair round is
   *  handed the token it knows instead of a word we invented. Declared here or
   *  zod strips it and the model goes back to interpreting prose. */
  rule: RuleCode.optional(),
  /** How short a measured breach falls, in minutes — the number a repair round
   *  needs to know how far to move the card (#399). */
  shortfallMinutes: z.number().int().optional(),
});

// A durable constraints delta the architect inferred from the instruction —
// the ENGINE constraints family, but with startWindow bounds converted from
// epoch ms to ISO-with-offset in the division timezone (the shape clients + the
// schedule-settings PUT speak). Mirrors ScheduleConfig.constraints, all fields
// optional (it is a suggestion delta).
const AiConstraintSuggestions = z.object({
  restMin: z.number().int().min(0).max(24 * 60).optional(),
  restByGroup: z.record(z.string(), z.number().int().min(0).max(24 * 60)).optional(),
  noBackToBack: z.boolean().optional(),
  startWindows: z
    .array(
      z.object({
        target: z.object({ kind: z.enum(["entrant", "pool", "division"]), id: z.string() }),
        notBefore: IsoDateTime.optional(),
        notAfter: IsoDateTime.optional(),
      }),
    )
    .optional(),
  fieldFairness: z.enum(["off", "balance", "rotate"]).optional(),
  parallelism: z.enum(["block", "mixed"]).optional(),
  crossPersonClash: z.enum(["warn", "hard"]).optional(),
});

/**
 * W6 (#401): how a schedule reached its final state.
 *
 * `engine` is the headline and the rest is why. `"none"` means no repair changed
 * the board — it verified clean, or repair was attempted and nothing was
 * adopted. `"optimized"` means the placement CP-SAT service fixed it, for no
 * credits and no model call (z3 retirement design, stage B, shipped by C9 —
 * the repair round's own solver call is `buildSchedule` via
 * `repairDecomposedCpsat`). `"llm"` means the assistant was asked to repair it.
 *
 * A z3-era `"z3"` member sat here until C7 (stage D) removed it. It was never
 * persisted — this schema is response-only telemetry, verified across the DDL,
 * the live schema and every read path — so retiring it needed no data
 * migration.
 *
 * The rest of the object exists because #401 requires the FALLBACK to be
 * visible, not merely correct: a run where the solver timed out, was queued
 * behind another run, or came back with families it could not satisfy must say
 * which, or "we tried and gave up" is indistinguishable from "we never tried".
 *
 * Every field but `engine` and `solver_ran` is optional, because most of them
 * are facts only a completed solve produces. Kept OPEN (a plain object rather
 * than a closed union) so a new diagnostic is an additive change — the same
 * reason `usage` is shaped this way.
 */
export const AiRepairReport = z.object({
  engine: z.enum(["none", "optimized", "llm"]),
  /** Did the solver actually run? False on the clean path, and on both paths
   *  where the attempt was declined before it started. */
  solver_ran: z.boolean(),
  status: z.enum(["clean", "repaired", "partial", "unrepaired"]).optional(),
  /** `k` — the number of fixtures moved. */
  moved: z.number().int().nonnegative().optional(),
  /** Wall-clock the request paid, queue wait included. */
  ms: z.number().int().nonnegative().optional(),
  checks: z.number().int().nonnegative().optional(),
  /** `upper_bound` means `moved` is the fewest this decomposition found, not the
   *  fewest that exist. Never rendered as "minimal" unless this says `proved`. */
  minimality: z.enum(["proved", "upper_bound"]).optional(),
  components_solved: z.number().int().nonnegative().optional(),
  components_skipped: z.number().int().nonnegative().optional(),
  /** Fixtures the solver left for the assistant. */
  unresolved: z.number().int().nonnegative().optional(),
  /** Conflicts the board still carries, blocking or not. */
  residual: z.number().int().nonnegative().optional(),
  /** Constraint families a component dropped to find any answer at all. */
  relaxed: z.array(z.string()).optional(),
  /** Families that cannot hold together — "no schedule can satisfy all of
   *  these at once". */
  families: z.array(z.string()).optional(),
  timed_out: z.boolean().optional(),
  fallback: z
    .enum([
      "disabled",
      "queue_wait",
      "budget",
      "partial",
      "unrepaired",
      "error",
      "not_adopted",
      "court_split",
    ])
    .optional(),
});
export type AiRepairReport = z.infer<typeof AiRepairReport>;

export const AiPlanResponse = z.object({
  proposal: z.array(AiPlanAssignment),
  unschedulable: z.array(z.object({ fixture_id: Uuid, reason: z.string(), rule: RuleCode })),
  warnings: z.array(AiPlanConflict),
  blocking: z.array(AiPlanConflict),
  diff: z.object({
    moved: z.array(z.string()),
    placed: z.array(z.string()),
    unscheduled: z.array(z.string()),
    unchanged: z.array(z.string()),
  }),
  explanations: z.array(z.object({ fixture_id: Uuid, note: z.string() })),
  constraint_suggestions: AiConstraintSuggestions.optional(),
  summary: z.string(),
  /**
   * The ARCHITECT's own assumptions (stage 2, model-authored): what it assumed
   * while placing. NOT the resolver's — those are stage 1, deterministic, and
   * ride on `AiParsePreviewResponse.compiled.assumptions`, shown before a credit
   * is spent. Two different arrays in two different responses; merging them
   * would tell the organiser the machine assumed something it did not.
   *
   * `.default([])` rather than `.optional()`: the prompt schema makes the field
   * optional and the model omits it routinely, while the review panel maps over
   * it. `undefined` here is a client crash, not a cosmetic gap.
   */
  assumptions: z.array(z.string()).default([]),
  usage: z.object({
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    repair_rounds: z.number().int(),
  }),
  /** W6 (#401): which engine repaired this board, and what the automatic one
   *  did or could not do. */
  repair: AiRepairReport,
  /** Dry officials coverage preview (present only when officials_policy sent). */
  officials_coverage: z
    .object({
      fillable: z.number().int(),
      total: z.number().int(),
      unfilled: z.array(z.object({ fixture_id: z.string(), role_key: z.string() })),
    })
    .nullable(),
  ...AiRunPriceFields,
});
export type AiPlanResponse = z.infer<typeof AiPlanResponse>;

// v4 AI Schedule Architect — Phase B (officials architect, design/v4/03 §2). The
// model assigns officials to a dry-run (or the current) schedule; the engine
// referee is authoritative and nothing is written. `instruction` may be empty —
// then the deterministic solver draft is returned with no LLM call. `policy`
// reuses the officials-auto body; `prior.assignments` mirror the response
// `assignments` (engine FixtureOfficial, camelCase) so a refine turn round-trips.
export const AiOfficialsPlanRequest = z.object({
  instruction: z.string().max(2000).default(""),
  schedule: z
    .array(z.object({ fixture_id: Uuid, scheduled_at: IsoDateTime, court_label: z.string() }))
    .optional(),
  policy: AssignPolicyBody,
  prior: z
    .object({
      instruction: z.string(),
      assignments: z.array(
        z.object({
          fixtureId: Uuid,
          officialId: Uuid,
          roleKey: z.string().min(1),
          locked: z.boolean().optional(),
        }),
      ),
    })
    .optional(),
  // Token-weighted AI credit rung (lib/ai-rung.ts): defaults to the server
  // prediction when omitted; see AiPlanRequest.rung for the full contract.
  // Ignored on the empty-instruction path, which makes no model call and is
  // always priced at 1 credit.
  rung: RungLiteral.optional(),
  /**
   * What the confirm card showed (#387). The server compares it against what it
   * actually charged, reports the divergence on `quote_mismatch` and records a
   * `schedule.ai_quote_mismatch` competition_event.
   *
   * OPTIONAL, and it must stay that way: server-side callers, smoke and every
   * external consumer send none. `.positive()` rather than `.nonnegative()`
   * because there is no such thing as a zero-credit quote — an absent value must
   * never be read as "quoted nothing", and a client that means "I showed no
   * price" says so by omitting the field.
   */
  quoted_credits: z.number().int().positive().optional(),
});
export type AiOfficialsPlanRequest = z.infer<typeof AiOfficialsPlanRequest>;

// Engine-taxonomy conflict (camelCase, @seazn/engine/officials OfficialConflict)
// plus the server-side "ineligible" verdict; `severity` flags the blocking ones.
const AiOfficialsConflict = z.object({
  kind: z.string(),
  severity: z.enum(["block", "warn"]),
  fixtureId: z.string().optional(),
  officialId: z.string().optional(),
  roleKey: z.string().optional(),
  detail: z.string().optional(),
});

export const AiOfficialsPlanResponse = z.object({
  // Proposed assignments (engine FixtureOfficial). Locked rows are echoed with
  // locked:true; the empty-instruction path returns the solver draft verbatim.
  assignments: z.array(
    z.object({
      fixtureId: z.string(),
      officialId: z.string(),
      roleKey: z.string(),
      locked: z.boolean().optional(),
    }),
  ),
  conflicts: z.array(AiOfficialsConflict),
  diff: z.object({
    // Fixture ids whose assignment set differs from / matches the baseline
    // (the prior proposal when given, else the locked assignments).
    changed: z.array(z.string()),
    unchanged: z.array(z.string()),
    // Slots the plan could not fill, each with the model's short reason.
    unfilled: z.array(z.object({ fixture_id: z.string(), role_key: z.string(), reason: z.string() })),
  }),
  // Declared-unfilled slots the referee's solver CAN fill, with a candidate — a
  // suggestion the organiser may accept (design/v4/03 §7 decision 8).
  lazy_unfilled: z.array(
    z.object({ fixture_id: z.string(), role_key: z.string(), candidate_official_id: z.string() }),
  ),
  explanations: z.array(z.object({ fixture_id: z.string(), note: z.string() })),
  summary: z.string(),
  usage: z.object({
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    repair_rounds: z.number().int(),
  }),
  ...AiRunPriceFields,
});
export type AiOfficialsPlanResponse = z.infer<typeof AiOfficialsPlanResponse>;

// ---------------------------------------------------------------------------
// #350 Multi-division JOINT AI scheduling — POST /competitions/{id}/schedule/
// ai-plan. One model call over several divisions of one competition, priced as
// a batch. The orchestrator is `aiPlanForCompetition`
// (server/usecases/competition-schedule-ai.ts); these are the wire contracts.
// ---------------------------------------------------------------------------

export const AiCompetitionPlanRequest = z.object({
  /**
   * The divisions to solve together. The **>= 2 rule is deliberately NOT a
   * `.min(2)` here** — it is the orchestrator's, which answers 400
   * `AI_PLAN_SINGLE_DIVISION`.
   *
   * Zod cannot be the authority for it in either direction. It is not
   * sufficient: `[d, d]` is two array entries and one division, and a division
   * with nothing movable is DROPPED before the quote (ruling R6), so a
   * three-id request can legitimately arrive at one solvable division. And it
   * is not necessary: the orchestrator already de-duplicates and re-checks
   * after the drop. Two mechanisms for one rule would also give the client two
   * different 400s for the same mistake — a `VALIDATION` blob of zod issues,
   * or the code the board renders "use the division schedule page" from.
   *
   * The ceiling stays here: 20 is a shape limit, and nothing downstream needs
   * to have loaded a competition to enforce it.
   */
  division_ids: z.array(Uuid).min(1).max(20),
  instruction: z.string().min(1).max(2000),
  mode: z.enum(["generate", "refine", "repair"]).default("generate"),
  /** Per-division rung override from the confirm card's segmented control.
   *  Advisory — the server always recomputes the quote, and an entry naming a
   *  division outside the run is ignored rather than rejected. */
  rung_overrides: z.record(Uuid, RungLiteral).optional(),
  prior: z
    .object({
      instruction: z.string(),
      assignments: z.array(
        z.object({
          fixture_id: Uuid,
          scheduled_at: IsoDateTime,
          court_label: z.string(),
          division_id: Uuid,
        }),
      ),
    })
    .optional(),
  /** W5 (#400): the confirmed compile from `POST .../schedule/ai-preview`. The
   *  joint twin of {@link AiPlanRequest.preview_id}, and scoped the same way —
   *  a preview taken against ONE division is refused here, because its window
   *  was resolved from a different fixture count than this run's. */
  preview_id: Uuid.optional(),
  /**
   * What the confirm card showed (#387). The server compares it against what it
   * actually charged, reports the divergence on `quote_mismatch` and records a
   * `schedule.ai_quote_mismatch` competition_event.
   *
   * OPTIONAL, and it must stay that way: server-side callers, smoke and every
   * external consumer send none. `.positive()` rather than `.nonnegative()`
   * because there is no such thing as a zero-credit quote — an absent value must
   * never be read as "quoted nothing", and a client that means "I showed no
   * price" says so by omitting the field.
   */
  quoted_credits: z.number().int().positive().optional(),
});
export type AiCompetitionPlanRequest = z.infer<typeof AiCompetitionPlanRequest>;

export const AiCompetitionPlanResponse = z.object({
  /** Every slot names the division the SERVER resolved it to — JOINT_RULES
   *  tells the model not to emit one, so this is never an echo. */
  proposal: z.array(
    z.object({
      fixture_id: z.string(),
      scheduled_at: z.string(),
      court_label: z.string(),
      division_id: z.string(),
      schedule_locked: z.boolean().optional(),
    }),
  ),
  unschedulable: z.array(z.object({ fixture_id: z.string(), reason: z.string(), rule: RuleCode })),
  // The ENGINE verifier's camelCase Conflict, exactly as the single-division
  // AiPlanResponse carries it — NOT the snake_case ScheduleConflict of the
  // apply/validate endpoints. The orchestrator returns `Conflict[]` verbatim,
  // so declaring the other shape here would strip every field of every warning
  // and publish a contract the route does not honour.
  warnings: z.array(AiPlanConflict),
  blocking: z.array(AiPlanConflict),
  diff: z.object({
    moved: z.array(z.string()),
    placed: z.array(z.string()),
    unscheduled: z.array(z.string()),
    unchanged: z.array(z.string()),
  }),
  explanations: z.array(z.object({ fixture_id: z.string(), note: z.string() })),
  summary: z.string(),
  /** The ARCHITECT's own assumptions (stage 2), exactly as
   *  {@link AiPlanResponse.assumptions} carries them — never the resolver's,
   *  which are stage 1 and ride on the preview response. `.default([])` because
   *  the model omits the key routinely and the review panel maps over it. */
  assumptions: z.array(z.string()).default([]),
  /** Court labels not shared by every solved division. Cross-division court
   *  identity is a string match and nothing else, so the board warns. */
  divergent_courts: z.array(z.string()),
  /** Requested divisions dropped before quoting (ruling R6) — the organiser is
   *  told why a division they picked is missing rather than silently getting a
   *  smaller board back. */
  skipped_divisions: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      reason: z.literal("no_movable_fixtures"),
    }),
  ),
  /** Public shape only — `cost_usd` stays on the ledger event. */
  usage: z.object({
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    repair_rounds: z.number().int(),
  }),
  /** W6 (#401): the joint solve runs ONCE over the whole board, so this is one
   *  report for the competition, never one per division. */
  repair: AiRepairReport,
  // ---------------------------------------------------------------------
  // ORDER IS LOAD-BEARING. `AiRunPriceFields` declares its own `divisions`
  // key — the meter stamp's per-division PRICE rows — and the override below
  // MUST come after it. A joint response carries ONE `divisions` array
  // holding both those price rows and the board's picker data (the division's
  // name and movable count), exactly as `aiPlanForCompetition` builds it:
  // two sibling arrays over one key would be a join every client redoes on
  // every render.
  //
  // The two directions are NOT symmetric — measured, not assumed:
  //
  //   * Swapping this order (spread AFTER the override) does NOT compile:
  //     1 x TS2783 "'divisions' is specified more than once", plus 4 x TS2339
  //     and 7 x TS18048 knock-on. The wrong order cannot ship, and `tsc` is a
  //     real net for THAT mistake specifically.
  //   * The order as written is the SILENT one. Any later edit that keeps the
  //     shapes structurally compatible — dropping a key from the merged row,
  //     letting the two arrays drift apart — passes `tsc` clean, and Zod does
  //     not error either: it STRIPS the keys the winning schema does not
  //     declare, so `name`/`movable` (or `rung`/`predicted_rung`) simply
  //     vanish from a 200 response with no exception and no warning.
  //
  // Neither this comment nor an assertion on `divisions.length` catches the
  // silent case. The guard is competition-schedule-ai-http.test.ts, which
  // asserts BOTH sets of fields survive one parse of a real orchestrator
  // result.
  // ---------------------------------------------------------------------
  ...AiRunPriceFields,
  divisions: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      movable: z.number().int(),
      rung: RungLiteral,
      predicted_rung: RungLiteral,
      underfunded: z.boolean(),
    }),
  ),
});
export type AiCompetitionPlanResponse = z.infer<typeof AiCompetitionPlanResponse>;

// ---------------------------------------------------------------------------
// W5 (#400) — the parse-only preview that precedes either run
// ---------------------------------------------------------------------------

/**
 * POST /divisions/{id}/schedule/ai-preview and
 * POST /competitions/{id}/schedule/ai-preview.
 *
 * One request body for both routes. It runs stage 1 ONLY — the instruction
 * compile — and returns what was compiled without spending a credit or calling
 * the architect, so the organiser can see the rules before paying for a run
 * against them. Declining is a client no-op.
 */
export const AiParsePreviewRequest = z.object({
  instruction: z.string().min(1).max(2000),
  /** Joint route only: the divisions in scope, so the resolver reads the same
   *  window the run will. Omitted on the single-division route, where the
   *  division is the path parameter. */
  division_ids: z.array(Uuid).optional(),
  /** Single-division route only. Advisory, exactly as on {@link AiPlanRequest} —
   *  it is here so the affordability refusal below prices the SAME run the
   *  confirm will start. Without it a rung-3 run would be previewed against a
   *  rung-1 floor and an org that cannot pay would be compiled for anyway. */
  rung: RungLiteral.optional(),
  /** Joint route only. The twin of `rung`, per {@link AiCompetitionPlanRequest}. */
  rung_overrides: z.record(Uuid, RungLiteral).optional(),
});
export type AiParsePreviewRequest = z.infer<typeof AiParsePreviewRequest>;

export const AiParsePreviewResponse = z.object({
  /** Reuse token for the run. ABSENT when the compile failed schema twice —
   *  there is nothing to confirm then, only a fallback to choose. */
  preview_id: Uuid.optional(),
  /** True when stage 1 failed schema twice. The client must offer the explicit
   *  preference fallback and must NEVER fall back on its own: presenting a rule
   *  as enforced while nothing enforces it is the failure this wave closes. */
  failed: z.boolean(),
  compiled: z.object({
    /** Engine constraints, already resolved against the org clock — the rules
     *  the referee will actually check. */
    hard: z.array(HardConstraint),
    soft: z.array(
      z.object({ note: z.string(), weight: z.union([z.literal(1), z.literal(2), z.literal(3)]) }),
    ),
    /** Verbatim. Never converted into a rule. Carries the whole instruction back
     *  when `failed` is true, so the card always has something honest to show. */
    unparsed: z.array(z.string()),
    /** RESOLVER assumptions (stage 1, deterministic, pre-credit) — how we read
     *  the window and the weekdays. NOT the architect's own assumptions, which
     *  are stage 2 and ride on the plan response. The two are different arrays
     *  and must never be merged. */
    assumptions: z.array(z.string()),
  }),
  /** The calendar window the INSTRUCTION stated, in the org timezone, as
   *  YYYY-MM-DD — null when it stated none.
   *
   *  Null rather than the run's default window on purpose: the default is
   *  computed by the pack builder from settings, already-scheduled instants and
   *  session windows, and there is exactly one writer of it
   *  (`buildSchedulePack`). Recomputing a second copy here to fill this field
   *  would be a renderer that can drift from the one the run uses. */
  window: z.object({ start: z.string(), end: z.string(), tz: z.string() }).nullable(),
  /** When this preview stops being reusable. A stale preview is stale by
   *  wall-clock as well as by content: the org's clock may have crossed a day
   *  boundary, and "tomorrow" with it. */
  expires_at: IsoDateTime,
});
export type AiParsePreviewResponse = z.infer<typeof AiParsePreviewResponse>;

/**
 * GET /competitions/{id}/schedule/ai-last — the joint mirror of
 * {@link AiLastResult}, field for field.
 *
 * A recall of the last APPLIED plan, not of the last proposal. An AI plan is
 * propose-only and nothing about it is written down unless the organiser
 * applies it — that has been true of the single-division board since v4, and it
 * is why this is the twin's shape rather than a partial plan response. `last`
 * stays null until a joint apply exists (#350 Task 6); `runs.used` counts joint
 * runs on the competition, and `max` is null because joint runs are metered by
 * the credit wallet rather than by a run quota. See `lastCompetitionAiApply`.
 *
 * Declared separately from `AiLastResult` rather than reusing it: the two
 * endpoints count different events and are free to diverge, and `at` is pinned
 * to an ISO instant here where the older schema left it a bare string.
 */
export const AiCompetitionLastResult = z.object({
  last: z.object({ at: IsoDateTime, instruction: z.string(), summary: z.string() }).nullable(),
  runs: z.object({ used: z.number().int(), max: z.number().int().nullable() }),
});
export type AiCompetitionLastResult = z.infer<typeof AiCompetitionLastResult>;

/**
 * POST /competitions/{id}/schedule/apply — persist a joint plan across several
 * divisions ATOMICALLY (#350 Task 6, spec §8). One transaction writes every
 * division's board or none of it; the per-stage endpoint cannot do this, and
 * calling it in a loop leaves half a board written on any mid-flight failure.
 */
export const ApplyCompetitionScheduleRequest = z.object({
  divisions: z
    .array(
      z.object({
        division_id: Uuid,
        /** REQUIRED here, unlike the per-stage apply's optional token: a joint
         *  write that skipped the check on one division would let a stale board
         *  silently overwrite a concurrent edit there while every other
         *  division was guarded. */
        expected_seq: z.number().int().nonnegative(),
        assignments: z
          .array(
            z
              .object({
                fixture_id: Uuid,
                scheduled_at: IsoDateTime,
                // P9 pass 3b: a real `courts.id`, not the legacy free-text
                // label — mirrors `ApplyScheduleRequest`'s identical field
                // (the per-stage apply's own `.strict()` reasoning above
                // applies verbatim here: a client still sending `court_label`
                // must get a loud 400). `venue_id` is optional, same
                // coalesce-over-unchanged semantics `applySchedule`
                // (schedule.ts) already gives it.
                court_id: CourtId,
                venue_id: VenueId.nullish(),
              })
              /**
               * `.strict()`, because the plan's own output is WIDER than this.
               * `AiCompetitionPlanResponse.proposal` carries an optional
               * `schedule_locked` (see above), and zod STRIPS unknown keys — so
               * a plan asking to pin a fixture would apply 200 with no pin, and
               * two schemas of one feature would disagree in silence. Strict
               * makes that a loud 400.
               *
               * Deliberately not "support pinning": accepting the field would
               * need the `scheduling.board` gate the per-stage apply puts on pin
               * changes (schedule.ts:485-487). Nothing sends it today, so this
               * costs no capability and leaves Task 7 free to add pinning as a
               * decision rather than inherit it as an accident.
               */
              .strict(),
          )
          .min(1)
          .max(500),
      }),
    )
    /**
     * `.min(1)`, NOT `.min(2)` — and that is not an oversight.
     *
     * The >= 2 rule on the PLAN endpoint exists to stop discount arbitrage: a
     * joint run is priced at max(1, sum of rungs - 1), so a one-division "joint"
     * run would buy a single-division solve at a discount. Applying costs
     * nothing. Refusing a one-division apply would only mean the board had to
     * decide, per outcome, which of two endpoints to post an already-paid-for
     * plan to — and ruling R6 lets a run legitimately end up with fewer solved
     * divisions than were requested.
     *
     * The ceiling matches the plan request's, since one apply can never span
     * more divisions than one run planned.
     */
    .min(1)
    .max(20),
  /** "ai" only. Manual board edits stay on the per-stage endpoint: a hand edit
   *  is one division by construction. */
  source: z.literal("ai"),
  /** Audit provenance (v4/03 §10) — stamped into every division's
   *  `schedule_applied` row AND the one `schedule.applied_multi` row that
   *  GET /competitions/{id}/schedule/ai-last recalls. `model` is overwritten
   *  server-side with the model that actually ran. */
  ai: AiApplyMeta.optional(),
});
export type ApplyCompetitionScheduleRequest = z.infer<typeof ApplyCompetitionScheduleRequest>;

export const ApplyCompetitionScheduleResult = z.object({
  applied: z.number().int().nonnegative(),
  /** Listed fixtures left where they are because they hold a result, across
   *  every division. */
  skipped: z.number().int().nonnegative(),
  /** Each listed division's seq after this call, in domain order: advanced
   *  when something of it moved, unchanged when nothing did. */
  divisions: z.array(z.object({ division_id: Uuid, seq: z.number().int().nonnegative() })),
  /** The ENGINE verifier's camelCase `Conflict`, exactly as the joint ai-plan
   *  response carries it — NOT the snake_case `ScheduleConflict` of the
   *  per-stage apply. `applyCompetitionSchedule` returns `Conflict[]` verbatim,
   *  so declaring the other shape here would strip every field of every warning
   *  down to `{}` and publish a contract the route does not honour. */
  conflicts: z.array(AiPlanConflict),
});
export type ApplyCompetitionScheduleResult = z.infer<typeof ApplyCompetitionScheduleResult>;

/**
 * POST /competitions/{id}/schedule/restore — undo one joint apply (#386).
 *
 * The anchors come from the CLIENT because only the client holds them: the
 * `schedule.applied_multi` event carries `division_ids` and nothing else. The
 * usecase checks the division set against that event, so a body naming fewer
 * (or other) divisions is a 422 rather than a partial restore.
 */
export const RestoreCompetitionScheduleRequest = z.object({
  checkpoints: z.array(z.object({ division_id: Uuid, checkpoint_id: Uuid })).min(1).max(20),
  /** Double-submit guard, same literal as the per-division restore. */
  confirm: z.literal(true),
});
export type RestoreCompetitionScheduleRequest = z.infer<typeof RestoreCompetitionScheduleRequest>;

/**
 * The joint restore's result — the usecase's `CompetitionRestoreOut`, verbatim.
 *
 * BOTH arrays are contract. The restore is deliberately not one transaction, so
 * a division that refuses is REPORTED in `failed` while the rest still rewind;
 * a caller that reads only `ok` cannot tell WHICH divisions still carry the AI
 * board, which is the reason this endpoint exists at all.
 */
export const RestoreCompetitionScheduleResult = z.object({
  restored: z.array(
    z.object({
      division_id: Uuid,
      /** The division's edit watermark after the rewind. */
      watermark: z.number().int(),
      /** Inverse events appended; 0 means it was already at the anchor. */
      steps: z.number().int(),
    }),
  ),
  /** `reason` is the refusal's message (a missing checkpoint, a stale seq, …).
   *  `code` is `HttpError.code` where the refusal carried one — present for a
   *  frozen division (SCHEDULE_LOCKED), absent for a bare `HttpError` or a
   *  plain `Error`. It is what lets the console say a refusal it recognises in
   *  the reader's own language instead of painting the server's English prose
   *  into a translated card; a client that does not recognise it falls back to
   *  `reason`. Optional, so every existing consumer keeps working. */
  failed: z.array(z.object({ division_id: Uuid, reason: z.string(), code: z.string().optional() })),
  ok: z.boolean(),
});
export type RestoreCompetitionScheduleResult = z.infer<typeof RestoreCompetitionScheduleResult>;

// Custom points & rank control (Jul3/05, PROMPT-25) ---------------------------

export const OverrideStandings = z.object({
  rows: z
    .array(
      z.object({
        entrant_id: Uuid,
        rank: z.number().int().min(1),
        reason: z.string().min(1).max(300),
      }),
    )
    .min(1)
    .max(64),
});
export type OverrideStandings = z.infer<typeof OverrideStandings>;

// ---------------------------------------------------------------------------
// Seed proposals (D4a design doc, P5) — propose + confirm cross-stage fill.
// API contracts & error codes section, verbatim shape; error CODES are
// ALL_CAPS_SNAKE per repo convention (ruling already made for D2/P1's
// CAPACITY_IMPOSSIBLE — the design doc's dotted-lowercase codes here
// (`seeding.source_stage_incomplete` etc.) are i18n-key-shaped, not the
// convention typed codes use anywhere in this tree; see stages.ts for the
// SEEDING_* HttpError codes this route surface actually throws).
// ---------------------------------------------------------------------------

const QualifierOutS = z.object({
  rank: z.number().int(),
  source: z.object({ stageId: Uuid, group: z.string().optional(), rank: z.number().int() }),
  entrantId: Uuid,
  /** `"<fixtureId>:home" | "<fixtureId>:away"` — resolvable straight back to
   *  a fillSlot(tx, fixtureId, slot, entrantId) call at confirm time. */
  destinationSlot: z.string(),
});
const TieOutS = z.object({
  slots: z.array(z.string()),
  entrantIds: z.array(Uuid),
  reason: z.string(),
});
export const SeedProposalComputed = z.object({
  qualifiers: z.array(QualifierOutS),
  ties: z.array(TieOutS),
  standingsHash: z.string(),
});
export type SeedProposalComputed = z.infer<typeof SeedProposalComputed>;

export const SeedProposal = z.object({
  id: Uuid,
  stageId: Uuid,
  status: z.enum(["draft", "confirmed", "stale"]),
  computed: SeedProposalComputed,
});
export type SeedProposal = z.infer<typeof SeedProposal>;

/** POST /stages/{id}/seed-proposal/confirm. */
export const ConfirmSeedProposal = z.object({
  proposalId: Uuid,
  edits: z.array(z.object({ destinationSlot: z.string(), entrantId: Uuid })).max(200).optional(),
  tiePicks: z.array(z.object({ slots: z.array(z.string()).min(1), order: z.array(Uuid).min(2) })).max(50).optional(),
});
export type ConfirmSeedProposal = z.infer<typeof ConfirmSeedProposal>;

export const ConfirmSeedProposalResult = z.object({
  proposalId: Uuid,
  filled: z.number().int(),
  fixtures: z.array(Fixture),
});
export type ConfirmSeedProposalResult = z.infer<typeof ConfirmSeedProposalResult>;

// Format extensions (Jul3/08, PROMPT-28) --------------------------------------

export const LadderChallenge = z.object({
  challenger_id: Uuid,
  opponent_id: Uuid,
});

// Discipline & suspensions (SPEC-1 / PROMPT-78) -------------------------------
// Colours are validated against the sport module's declared keys at the
// usecase (SPEC-1), not here — zod only enforces shape.

export const SuspensionStatus = z.enum(["pending", "active", "served", "waived"]);

const AccumulationRule = z.object({
  key: z.string().min(1),
  color: z.string().min(1),
  count: z.number().int().positive(),
  ban_matches: z.number().int().positive(),
  // S4 (#428) — scope the rule to one DisciplineCard.reason ("three cards for
  // dissent"), not just the colour. Optional: a plain `z.object` here already
  // STRIPS an unrecognized key on parse rather than rejecting it, so without
  // this the usecase's new reason-scoped rule would be silently unreachable
  // from the real PUT endpoint.
  reason: z.string().min(1).optional(),
});
const DismissalRule = z.object({
  key: z.string().min(1),
  color: z.string().min(1),
  ban_matches: z.number().int().positive(),
});
export const DisciplineRulesDoc = z.object({
  accumulation: z.array(AccumulationRule),
  dismissal: z.array(DismissalRule),
});

export const PutDisciplineRules = z.object({
  enabled: z.boolean(),
  rules: DisciplineRulesDoc,
});

export const DisciplineRulesResponse = z
  .object({
    enabled: z.boolean(),
    rules: DisciplineRulesDoc,
    sportColors: z.array(z.object({ key: z.string(), label: z.string() })),
  })
  .nullable();

export const CreateSuspension = z.object({
  person_id: Uuid,
  matches_total: z.number().int().min(1),
  reason: z.string().min(1).max(300),
});

export const DecideSuspension = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("confirm") }),
  z.object({ kind: z.literal("waive") }),
  z.object({
    kind: z.literal("adjust"),
    matches_total: z.number().int().min(1).optional(),
    reason: z.string().min(1).max(300).optional(),
  }),
]);

export const Suspension = z.object({
  id: Uuid,
  divisionId: Uuid,
  personId: Uuid,
  personName: z.string(),
  entrantId: Uuid.nullable(),
  entrantName: z.string().nullable(),
  status: SuspensionStatus,
  source: z.enum(["auto_accumulation", "auto_dismissal", "manual", "report"]),
  reason: z.string(),
  matchesTotal: z.number().int(),
  matchesServed: z.number().int(),
  fixtureId: Uuid.nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  triggerVoided: z.boolean(),
});

// Official marks & match reports (SPEC-3 / PROMPT-80) --------------------------

export const PutMarkBody = z.object({
  mark: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional(),
});

export const MarkSummary = z.object({
  average: z.number().nullable(),
  count: z.number().int(),
  recent: z.array(
    z.object({
      mark: z.number().int(),
      comment: z.string().nullable(),
      fixtureLabel: z.string(),
      createdAt: z.string(),
    }),
  ),
});

export const IncidentKind = z.enum(["red_card", "misconduct", "injury", "other"]);

export const ReportIncident = z.object({
  kind: IncidentKind,
  person_id: Uuid.optional(),
  entrant_id: Uuid.optional(),
  note: z.string().min(1).max(2000),
});

export const PutReportBody = z.object({
  body: z.string().max(5000),
  incidents: z.array(ReportIncident).max(50),
});

export const MatchReport = z.object({
  id: Uuid,
  fixtureOfficialId: Uuid,
  status: z.enum(["draft", "submitted"]),
  body: z.string(),
  incidents: z.array(ReportIncident),
  submittedAt: z.string().nullable(),
});

export const FixtureReport = MatchReport.extend({ officialName: z.string() });

export const FixtureSquadMember = z.object({
  person_id: Uuid,
  full_name: z.string(),
  entrant_id: Uuid,
  entrant_name: z.string(),
});

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

export const PatchVenue = CreateVenue.partial();

export const CreateCourt = z.object({
  name: z.string().min(1).max(200),
  sort: z.number().int().default(0),
  tags: RequiredCourtTags.default([]),
});

export const PatchCourt = CreateCourt.partial();

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

// ---------------------------------------------------------------------------
// Public — GET /public/fixtures/{id}
// ---------------------------------------------------------------------------

/**
 * Task 9 (spectator surface W1) — the response the route actually returns
 * had NO `response:` schema in `openapi.ts`'s route table at all (a recorded
 * false premise from the W2 draft, confirmed by reading `openapi.ts` — the
 * `/public/fixtures/{id}` row carried no `response` field before this task);
 * this is the first one. Shaped to match `usecases/public.ts`'s
 * `publicFixture` return EXACTLY — the same `Pick<PublicFixture, …>` plus
 * `venue_name`/`court_name` (`withCourtVenueName`'s own derived fields) plus
 * `match_centre` (this task's addition). `outcome`/`summary` mirror
 * `PublicFixture`'s own loose shape (public-site/data.ts) rather than
 * `Fixture.outcome`'s bare `z.unknown()` above — the public route's outcome
 * carries `method`, which that broader admin-facing schema does not attempt
 * to type.
 */
export const PublicFixtureOutcome = z
  .object({
    kind: z.string().optional(),
    winner: z.string().optional(),
    loser: z.string().optional(),
    method: z.string().optional(),
  })
  .nullable();

export const PublicFixtureSummarySchema = z
  .object({
    headline: z.string().optional(),
    perSide: z.array(z.object({ entrantId: z.string(), line: z.string() })).optional(),
    detail: z.unknown().optional(),
  })
  .nullable();

export const PublicFixtureSummary = z.object({
  id: Uuid,
  division_id: Uuid,
  stage_id: Uuid,
  pool_id: Uuid.nullable(),
  round_no: z.number().int(),
  seq_in_round: z.number().int(),
  home_entrant_id: Uuid.nullable(),
  away_entrant_id: Uuid.nullable(),
  home_slot_label: SlotLabelRef,
  away_slot_label: SlotLabelRef,
  scheduled_at: z.string().nullable(),
  // LEGACY, read-only — frozen since the P9 venues/courts cutover (same
  // fields `Fixture` above documents at length); `venue_name`/`court_name`
  // below are what a consumer should render.
  venue: z.string().nullable(),
  court_label: z.string().nullable(),
  venue_name: z.string().nullable(),
  court_name: z.string().nullable(),
  status: Fixture.shape.status,
  outcome: PublicFixtureOutcome,
  summary: PublicFixtureSummarySchema,
  last_seq: z.number().int().nullable(),
  /** Task 9 — the match-centre view model, built by the SAME loader the
   *  page's own data fetch (`getPublicFixture`) uses. */
  match_centre: MatchCentreDoc,
});

/** Spectator W2, Task 15 — what the org home's chip island polls: the org's
 *  LISTED competitions — `visibility = 'public'` once published, i.e. past
 *  draft, and still listed live, completed or archived
 *  (`lib/competition-listing.ts`) — each with its status and how
 *  many of its public fixtures are in play. A competition with a match in play
 *  is "on now" whatever its status says (`lib/public-site.ts`'s
 *  `competitionChip`). */
export const PublicOrgLive = z.object({
  competitions: z.array(
    z.object({
      id: Uuid,
      status: CompetitionStatus,
      in_play: z.number().int().min(0),
    }),
  ),
});
export type PublicOrgLiveT = z.infer<typeof PublicOrgLive>;
export type MergeLog = z.infer<typeof MergeLog>;
