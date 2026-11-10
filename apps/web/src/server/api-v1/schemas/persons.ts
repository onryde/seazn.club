// /api/v1 contracts — persons and profiles: consent, merge, claims, availability, and the /me surface (MyFixtures, MyTeam, CheckinLink).
// One module of the schemas/ folder; ./index.ts is the map and the public surface. Pure zod (loads bare under
// `node --experimental-strip-types`): relative imports carry an explicit `.ts`, types come in through `import type`.
import { z } from "zod";
// The player name limit, shared with the directory's rename field (persons-panel.tsx).
import { PERSON_NAME_MAX } from "../../../lib/person-name.ts";
import { Uuid, CourtId, VenueId } from "./common.ts";
import { PersonLane } from "./entrants.ts";

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
  /** The player's entrant holds the home seat. `summary.headline` reads home first; /me names the player's side first
   *  and reads the score from that side (fix round 3). Selected by `listMyFixtures` and declared here so a consumer
   *  that parses against this schema keeps it. */
  player_home: z.boolean(),
  scheduled_at: z.string().nullable(),
  summary: z.unknown().nullable(),
  outcome: z.unknown().nullable(),
  /** Loop R M-11 — the seats and the active abandon's reason, which with `outcome` say which credited result this is
   *  (a walkover, a retirement, an abandon decided by DLS): /me prints its tag after the score. */
  home_entrant_id: Uuid.nullable(),
  away_entrant_id: Uuid.nullable(),
  abandon_reason: z.string().nullable(),
  /** W3 T15 ruling 2 — the status of the outcome's LOSER (an award's), else null: /me words a disqualified opponent's
   *  walkover (reason `withdrew`, the withdrawal cascade's) as the plain walkover, never a withdrawal. */
  forfeit_loser_status: z.string().nullable(),
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
