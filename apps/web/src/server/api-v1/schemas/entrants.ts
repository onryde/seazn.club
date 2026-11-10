// /api/v1 contracts — entrants: create/patch/read, teams and squads, roster sync, withdraw cascade, Swiss and knockout late-entry results.
// One module of the schemas/ folder; ./index.ts is the map and the public surface. Pure zod (loads bare under
// `node --experimental-strip-types`): relative imports carry an explicit `.ts`, types come in through `import type`.
import { z } from "zod";
// The entrant name limit, shared with the console's Name field (entrants-panel.tsx).
import { ENTRANT_NAME_MAX } from "../../../lib/entrant-roster-name.ts";
import { Uuid, EntrantKind, EntrantStatus } from "./common.ts";
import { EligibilityOverride } from "./divisions.ts";

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
  /** W3 T9 (ruling C4): the first Swiss round a late player is in the field for, in the Swiss stage
   *  `swiss_first_round_stage_id` names (V486/V487); null = from round 1 (everyone enrolled before Start). */
  swiss_first_round: z.number().int().min(1).nullable(),
  swiss_first_round_stage_id: Uuid.nullable(),
});

/** W3 T15 review m3: the withdrawal cascade's report (`withdrawEntrantCascade`) — what a disqualification through
 *  `PATCH /entrants/{id}` walked over, voided or left to the organiser. Mirrors `WithdrawCascadeOut` (withdrawal.ts);
 *  disqualify-cascade.test.ts parses the real report strictly against it. */
export const WithdrawCascadeReport = z.object({
  entrant_id: Uuid,
  status: z.enum(["withdrawn", "disqualified"]),
  policy: z.enum(["none", "walkover", "expunge"]),
  walkovers: z.number().int(),
  voided: z.number().int(),
  skipped_finalized: z.number().int(),
  walked_over_held: z.number().int(),
  /** Fixtures the cascade wrote nothing to, each still the organiser's to void or settle (an abandoned Swiss board
   *  holds the next round until it is settled, X-AB-5). */
  left_to_organiser: z.array(Uuid),
  /** W4 T13 (RB4-V2): the lucky loser who took the departed qualifier's main-draw round-1 seat, and that line; null when
   *  none did (the line walked over). */
  lucky_loser: z.object({ entrant_id: Uuid, fixture_id: Uuid }).nullable(),
});
/** W3 T9 (ruling 250, X-SW-12/13/14): what "Add late player" did with an entrant added to a division whose Swiss is
 *  running. (a) re-paired the unstarted round with the newcomer (`repaired`: the players whose opponent changed; a
 *  board the odd→even field needed is `new_board`); (b) seated the newcomer against the round's bye holder
 *  (`bye_holder_id`, ruling C3) on a new board (`new_board`); (c) the newcomer joins round `round`'s Pair. */
export const SwissLateEntryResult = z.object({
  format: z.literal("swiss"),
  entrant_id: Uuid,
  stage_id: Uuid,
  case: z.enum(["a", "b", "c"]),
  round: z.number().int().min(1),
  repaired: z.object({ changed_entrant_ids: z.array(Uuid) }).optional(),
  new_board: z.object({ fixture_id: Uuid, scheduled: z.boolean() }).optional(),
  bye_holder_id: Uuid.optional(),
});
export type SwissLateEntryResult = z.infer<typeof SwissLateEntryResult>;

/** W4 T9/T10 (rules X-LE-3…X-LE-13, design 2026-11-04 §4.1): what "Add late player" did with an entrant added to a
 *  division whose root knockout is drawn. `bye` — the newcomer took the lowest-seeded holder's round-1 bye and plays
 *  `opponent_id` on `fixture_id`; `withdrawn_slot` — the newcomer took a withdrawn entrant's round-1 seat (its walkover
 *  reversed) against `opponent_id`; `waiting` — an automatic arrival (registration, import, Reinstate) is held for one
 *  organiser tap (ruling 271); `refused` / `rebuild_offered` — round 1 has no slot left (`reason`), and when nothing has
 *  started a Rebuild is offered (`rebuild_offered`: on an organiser's add the player is KEPT and waits, RB4-L6). `refused`
 *  answers a tap (no slot, a match has started: KO_LATE_ENTRY_NO_SLOT) or a Reinstate whose place has been played on
 *  (KO_LATE_ENTRY_PLAYED_ON, T19) — never an organiser's add, which once a match has started is a 409 instead.
 *  `scheduled`: the new match found a free slot (else it is unscheduled and flagged, X-LE-12). */
export const KnockoutLateEntryResult = z.object({
  format: z.literal("knockout"),
  entrant_id: Uuid,
  stage_id: Uuid,
  case: z.enum(["bye", "withdrawn_slot", "waiting", "refused", "rebuild_offered"]),
  fixture_id: Uuid.optional(),
  opponent_id: Uuid.optional(),
  /** `withdrawn_slot` only (W4 T19): whose departed seat the late player took — themself, for a reinstated player whose
   *  own walkover was reversed. The desk's notice names them ("… takes {withdrawn}'s place against {opponent}"). */
  withdrawn_id: Uuid.optional(),
  scheduled: z.boolean().optional(),
  /** T26c fix round 1 (I2): set (true) only with `scheduled: false` when the division's schedule is frozen - a frozen
   *  timetable gives a late entry no time or court, so the match waits for one until the schedule is unfrozen, and the
   *  notice says so (`knockout.lateEntry.unscheduledFrozen`). Absent otherwise. */
  schedule_frozen: z.literal(true).optional(),
  /** `refused` / `rebuild_offered`: why — KO_LATE_ENTRY_NO_SLOT (round 1 has no slot left), KO_LATE_ENTRY_SCHEDULE_FROZEN (no
   *  slot, nothing started, but the division's schedule is frozen: Rebuild refuses a frozen schedule, so none is offered and
   *  the player waits until it is unfrozen — final review m1), or KO_LATE_ENTRY_PLAYED_ON (a reinstated player whose place in
   *  the bracket has been played on: back on the list, never back in the bracket). */
  reason: z.string().optional(),
});
export type KnockoutLateEntryResult = z.infer<typeof KnockoutLateEntryResult>;

/** A late add's answer, by the entry stage's FORMAT: a running root Swiss (W3) or a drawn root knockout (W4). Every
 *  reader narrows on `format` before it reads a case. */
export const LateEntryResult = z.discriminatedUnion("format", [SwissLateEntryResult, KnockoutLateEntryResult]);
export type LateEntryResult = z.infer<typeof LateEntryResult>;

/** `PATCH /entrants/{id}`'s reply: the entrant, plus `cascade` when the patch disqualified an entrant still in the field
 *  (the withdrawal's fixture surgery ran, W3 T15). */
export const PatchedEntrant = Entrant.extend({
  cascade: WithdrawCascadeReport.optional(),
  /** W4 T19 (K13): a REINSTATEMENT into a division whose entry stage is a running Swiss or a started root knockout — how
   *  the player rejoins it (a knockout: `waiting` for the organiser's Add to bracket, or `refused` with
   *  KO_LATE_ENTRY_PLAYED_ON when their place has been played on). Absent on every other patch. */
  late_entry: LateEntryResult.optional(),
});

/** POST /divisions/{id}/entrants response row: the entrant, plus `late_entry` when it joined a running Swiss or a
 *  drawn root knockout. */
export const CreatedEntrant = Entrant.extend({ late_entry: LateEntryResult.optional() });
