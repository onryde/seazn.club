// /api/v1 contracts — clubs, contacts, standalone teams, logo assignment, bulk import preview and commit, officials CRUD.
// One module of the schemas/ folder; ./index.ts is the map and the public surface. Pure zod (loads bare under
// `node --experimental-strip-types`): relative imports carry an explicit `.ts`, types come in through `import type`.
import { z } from "zod";
// A PATCH twin whose omitted fields stay omitted (zod 4's `.partial()` fills a `.default()`); pure zod, relative + `.ts`.
import { patchOf } from "../../../lib/zod-patch.ts";
import { Uuid } from "./common.ts";
import { EligibilityOverride } from "./divisions.ts";

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

// `patchOf`, not `.partial()`: a partial still fills `role_keys`' default, so every edit that did not send roles
// rewrote them to ["referee"] (fix/patch-schema-partial-defaults).
export const PatchOfficial = patchOf(CreateOfficial);
