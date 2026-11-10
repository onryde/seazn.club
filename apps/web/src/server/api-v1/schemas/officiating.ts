// /api/v1 contracts — officiating portal and official assignment, schedule undo and versioning (checkpoints, locks, clear).
// One module of the schemas/ folder; ./index.ts is the map and the public surface. Pure zod (loads bare under
// `node --experimental-strip-types`): relative imports carry an explicit `.ts`, types come in through `import type`.
import { z } from "zod";
import { Uuid, CourtId, VenueId } from "./common.ts";
import { AiApplyMeta } from "./schedule-analysis.ts";

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

export const AssignPolicyBody = z.object({
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
  // migration; `usecases/schedule/board.ts`'s `scopeLocked` matches on
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
