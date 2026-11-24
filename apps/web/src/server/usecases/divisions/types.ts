import "server-only";
import type { CameraPolicy } from "@/server/external-play/camera-policy";

export interface DivisionRow {
  id: string;
  competition_id: string;
  name: string;
  slug: string;
  /** Markdown (v3/06 §2), rendered on the public division page. */
  description: string | null;
  sport_key: string;
  variant_key: string;
  config: unknown;
  module_version: string;
  tiebreakers: string[] | null;
  /** V364/V380 first-class eligibility columns — the ONE eligibility
   *  representation (RS007/V380 dropped the jsonb `eligibility` column this
   *  comment used to say "read alongside"); see
   *  registration-eligibility.ts's EligibilityDivision. */
  category: string | null;
  age_min: number | null;
  age_max: number | null;
  /** RS007/V380: both-or-neither — enforced by `checkAgeCutoff` (api-v1/schemas/divisions.ts)
   *  on the request body and by `patchDivision`'s merge-check below on the
   *  merged row, NOT by `divisions_age_cutoff_check`, which a one-sided
   *  orphan satisfies (see that merge-check's own comment).
   *  Null defaults to 1 January of the season-start year
   *  (registration-rules.ts's `ageBandEligibilityIssues`). */
  age_cutoff_month: number | null;
  age_cutoff_day: number | null;
  /** RS007/V380: the retired jsonb "custom rule" note, now a first-class
   *  column the public entry/join pages render as a warning. */
  eligibility_note: string | null;
  status: string;
  officials_hide_names: boolean;
  scheduling_mode: string;
  auto_progress: boolean;
  /** SPEC-2: draft a news post when results land in this division. */
  auto_posts: boolean;
  /** V416: publish seed numbers on the public site (`public_entrants_v`
   *  redacts `seed` when false). Admin reads are unaffected. */
  show_seeds: boolean;
  schedule_locked: boolean;
  archived_at: string | null;
  created_at: string;
  /** Division event-ledger head — the board's optimistic token (gap 10). */
  seq: number;
  /** Youth privacy (v3/11 gap 8): auto from U-age eligibility, overridable. */
  youth: boolean;
  player_name_display: "full" | "first_initial" | null;
  /** Card identity (V274, v8): uploaded logo; null → monogram tile. */
  logo_url: string | null;
  logo_storage_path: string | null;
  /** D5/P8 candidate-court filter (V367): tags ⊇ required_court_tags, empty
   *  = any court. CRUD lives here; the READ path that actually FILTERS a
   *  candidate set is P9 pass 2b's `usecases/court-candidates.ts`
   *  (`resolveCandidateCourts`/`unionRequiredCourtTags`), unioned with
   *  `stages.required_court_tags` (the sibling V367 column, wired the same
   *  pass — CRUD for the stage side still does not exist). */
  required_court_tags: string[];
  /** V451 online-chess camera requirement for this division; null = inherit
   *  the competition's (NOT NULL floor). Resolved per fixture, with the stage
   *  level, by camera-policy.ts's fixtureCameraPolicy. */
  camera_policy: CameraPolicy | null;
}

export const COLS = [
  "id", "competition_id", "name", "slug", "description", "sport_key", "variant_key", "config",
  "module_version", "tiebreakers", "category", "age_min", "age_max", "age_cutoff_month",
  "age_cutoff_day", "eligibility_note", "status",
  "officials_hide_names", "scheduling_mode", "auto_progress", "auto_posts", "show_seeds", "schedule_locked",
  "archived_at", "created_at", "seq", "youth", "player_name_display", "logo_url",
  "logo_storage_path", "required_court_tags", "camera_policy",
] as const;

/** One variant choice for the Settings tab's format editor. `config` is the preset exactly as the row stores it - only the keys
 *  the variant declares (scripts/sync-sports.ts), never a parsed config - because a variant switch needs to know WHICH keys
 *  the old and the new variant own (W2e Task 29); `system` tells a built-in from this org's own preset. */
export interface VariantOption {
  key: string;
  name: string;
  system: boolean;
  config: Record<string, unknown>;
}
