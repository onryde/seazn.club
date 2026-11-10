// /api/v1 contracts — divisions: create/patch/read, age band and cutoff checks, camera policy, patched-division report, eligibility override (RS011).
// One module of the schemas/ folder; ./index.ts is the map and the public surface. Pure zod (loads bare under
// `node --experimental-strip-types`): relative imports carry an explicit `.ts`, types come in through `import type`.
import { z } from "zod";
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
import { isValidCutoffDay, REASON_MIN, REASON_MAX } from "../../../lib/registration-rules.ts";
import { CAMERA_POLICIES } from "../../../lib/camera-policy.ts";
import { Slug, DivisionStatus, RequiredCourtTags, Uuid } from "./common.ts";

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
  // W2d (spec §5.6; Task 4's keys, moved here by PS-2c): the BWF/ITTF/ATP/FIH/IIHF steps and the h2h block modifiers.
  "set_diff", "point_diff", "h2h_two", "h2h_wins", "h2h_set_ratio", "h2h_point_ratio", "h2h_reapply", "h2h_exclusion",
  "matches_played", "field_goals",
  // W3 app-B T1 (X-SW-9; engine 2.0.0): the Swiss chain's opponents' score difference (the sport's own unit).
  "opp_diff",
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

/** Online-chess camera policy (design §5.1, V451). The vocabulary is
 *  lib/camera-policy.ts's — one definition shared with the server ladder and
 *  the settings control. */
export const CameraPolicyS = z.enum(CAMERA_POLICIES);

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
    /** Online-chess camera requirement for this division (V451
     *  `divisions.camera_policy`). Absent or null ⇒ inherit the competition's
     *  (NOT NULL, default 'off'); a stage may override it. Board games only —
     *  any other sport refuses 'optional'/'required' (422 CAMERA_POLICY_SPORT). */
    camera_policy: CameraPolicyS.nullable().optional(),
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
    /** Jul3/08 §5: progression fires without a button (free on every plan
     *  since V471; was Pro `formats.advanced`). */
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
    /** Format edit (W2c, owner P-2 "A") — applied PER FIELD: a change a started stage depends on is refused (409
     *  DIVISION_FORMAT_LOCKED / DIVISION_TABLE_RULES_LOCKED, each naming the stage, listed in `refused`) while the
     *  rest lands; re-validated via the pinned module schema, and against every stage's own rules. */
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
    /** Online-chess camera requirement (see CreateDivision). null clears this
     *  division's own value ⇒ inherit the competition's. Once any round of the
     *  division has been opened the EFFECTIVE requirement may only be relaxed
     *  (D9) — a tightening is 409 POLICY_LOCKED — and every real change writes
     *  a `chess.camera_policy_changed` competition_events row. A re-send of
     *  the stored value is a no-op. */
    camera_policy: CameraPolicyS.nullable(),
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
  camera_policy: CameraPolicyS.nullable(), // V451 — null = inherit the competition's; see PatchDivision above
});

/** W2c (owner P-2 "A") — one field a division save did not apply, and the first started stage that depends on it: the
 *  wire shape of `RefusedField` (`lib/rule-errors.ts`, which this file may not import: openapi-gen runs it under bare
 *  strip-types, with no `@/`). Pinned to that type, both codes and every key, in `refused-field-schema.test.ts`. */
export const RefusedFieldS = z.object({
  field: z.string(),
  code: z.enum(["DIVISION_FORMAT_LOCKED", "DIVISION_TABLE_RULES_LOCKED"]),
  stageId: Uuid,
  stageName: z.string(),
});

/** W2d Task 10 (spec §5.4) — a started stage that kept its pinned table rules while this save moved what its live layers
 *  would give (the division's order, the points its sport layer pays). */
export const KeptPinnedStageS = z.object({ stageId: Uuid, name: z.string() });

/** PATCH /divisions/{id}'s 200: the division as saved, what was refused beside it (applied per field), and the pinned
 *  stages the save did not reach (W2d: a started stage is pinned, so a division order or points change is never refused
 *  for it; it is listed here instead). */
export const PatchedDivision = Division.extend({
  refused: z.array(RefusedFieldS),
  stagesKeptPinned: z.array(KeptPinnedStageS),
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
