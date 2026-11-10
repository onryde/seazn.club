// /api/v1 contracts — stage actions: generate, rebuild and unpair results, Swiss reshape and rounds, open round, check-in extension, complete.
// One module of the schemas/ folder; ./index.ts is the map and the public surface. Pure zod (loads bare under
// `node --experimental-strip-types`): relative imports carry an explicit `.ts`, types come in through `import type`.
import { z } from "zod";
import { SWISS_REQUESTED_BYES_DEFERRED_MESSAGE } from "../../../lib/swiss-refusals.ts";
// T19 (D12): the Open round vocabulary — one list, shared with the organiser control.
import { OPEN_ROUND_REFUSALS, OPEN_ROUND_SKIP_REASONS } from "../../../lib/open-round.ts";
import { Uuid } from "./common.ts";
import { Fixture } from "./scoring.ts";

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

/** W3 T11 (X-SW-16; rulebook-W3-swiss.md §3.1/§3.2): a Swiss round count against the field a Generate minted or paired
 *  for — the field's recommended count, safe maximum ⌊n/2⌋ and hard maximum (n − 1 even, n odd). On a Generate's answer
 *  only as a warning: `warn` (above the safe maximum), or `shrunk` (fix round 1: a running Swiss's field shrank under its
 *  count while this round still pairs — it can reach at most `hardMax` rounds; `rounds`, `field` and `canFinish` ride
 *  with it, `canFinish` false for round 1, where nothing is played yet). Above the hard maximum otherwise the Generate is refused (SWISS_ROUNDS_ABOVE_MAX). */
export const SwissRoundsJudgementResult = z.object({
  verdict: z.enum(["warn", "shrunk"]),
  recommended: z.number().int(),
  safeMax: z.number().int(),
  hardMax: z.number().int(),
  rounds: z.number().int().optional(),
  field: z.number().int().optional(),
  canFinish: z.boolean().optional(),
});

export const GenerateResult = z.object({
  created: z.number().int(),
  existing: z.number().int(),
  fixtures: z.array(Fixture),
  reshaped: SwissReshapeResult.optional(),
  swiss_rounds: SwissRoundsJudgementResult.optional(),
  /** W3 app-B T7 (X-SW-10; rulebook-W3-swiss.md §3.3 "Prevention"): the Swiss one-round look-ahead's verdict on the round AFTER
   *  the one just seated, ABSENT unless it was asked for (a stage above its safe maximum, never the last round) and the answer
   *  was not "pairable". `unpairable`: every legal pairing of the round just seated leaves the next one with none (the next
   *  Pair will be refused SWISS_NO_LEGAL_PAIRING). `unknown`: the search ran out of budget before the engine could tell. The
   *  round is seated either way; `swiss_paired_round` names it. */
  swiss_next_round: z.enum(["unpairable", "unknown"]).optional(),
  /** The round this Pair seated, sent with `swiss_next_round` so a client names both rounds from one number. */
  swiss_paired_round: z.number().int().optional(),
  /** W4 T8 (FX-G2; spec 2026-11-04 §6.5): a root knockout's Generate over a bracket that already has its lines — ABSENT
   *  on a first Generate and on every other kind. `noop`: nothing changed. `in_place`: each entrant id in `placed` took a
   *  bye, each in `vacated` left and their opponent now holds a bye; no line was inserted or deleted. `regenerated`: the
   *  field crossed a power of two (or a change in place could not express the departures), so the bracket was drawn again,
   *  slots carried by bracket role (`slots`, as Rebuild reports them) — refused 409 KO_REDRAW_WOULD_CLEAR_SETUP when its
   *  lines carry any match setup (usecases/stages/roster-drift.ts `stageAttachmentCounts`). After Start an arrival is refused 409 KO_GENERATE_AFTER_START. */
  reconcile: z
    .object({
      kind: z.enum(["noop", "in_place", "regenerated"]),
      placed: z.array(z.string()),
      vacated: z.array(z.string()),
      /** Every seat emptied: a departed entrant's, and one whose entrant was deleted (no id left to list). */
      vacated_seats: z.number().int(),
      slots: z.object({ kept: z.number().int(), freed: z.number().int(), unscheduled: z.number().int() }).optional(),
    })
    .optional(),
});

/** POST /stages/{id}/generate body. `pairing` = a ROUND-1-ONLY Swiss override
 *  (spec 2026-09-22); never stored. Absent body ≡ {}. */
export const GenerateStageInput = z.object({ pairing: z.enum(["fold", "rank_adjacent"]).optional() }).strict();
export type GenerateStageInput = z.infer<typeof GenerateStageInput>;

/** F3 Task 5 (5b) — POST /stages/{id}/rebuild's response: GenerateResult plus
 *  how many stale fixtures were deleted before regenerating, and (W3 T1, X-RB-1)
 *  what became of the stage's slots (a time, a court, a venue or a pin): `kept`
 *  by a rebuilt fixture at the same (pool, round, seq) — a shrinking Swiss round
 *  keeps the boards that hold the most — `freed` because no rebuilt fixture
 *  inherits them, and the rebuilt fixtures left `unscheduled` at a new position
 *  (counted only when the stage had a layout). */
export const RebuildResult = GenerateResult.extend({
  removed: z.number().int(),
  slots: z.object({
    kept: z.number().int(),
    freed: z.number().int(),
    unscheduled: z.number().int(),
  }),
});

/** POST /stages/{id}/unpair — clears the latest seated Swiss round onto kept shells. */
export const UnpairResult = z.object({
  cleared: z.number().int(),
  round: z.number().int(),
});

/** PATCH /stages/{id} (W3 T12, SW-M10 / #838, X-SW-17 and BG-SW-1) — a Swiss stage's round count and chess colours,
 *  editable until the stage's first start. At least one key; an unknown key is refused (strict). */
export const PatchSwissStage = z
  // `requestedByes` (W3 T18, RB3-7(c)): deferred — refused by name on this door as on `StageConfig`.
  .object({ rounds: z.number().int().min(1), chess: z.boolean(), requestedByes: z.never({ error: SWISS_REQUESTED_BYES_DEFERRED_MESSAGE }) })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, "empty patch");
export type PatchSwissStage = z.infer<typeof PatchSwissStage>;

export const PatchSwissStageResult = z.object({
  rounds: z.number().int(),
  chess: z.boolean(),
  /** The count against the field its next Pair seats (rulebook §3.1/§3.2); null when `rounds` was not sent or there is
   *  no pairable field yet. Above the hard maximum the PATCH is refused instead (SWISS_ROUNDS_ABOVE_MAX). */
  swiss_rounds: z
    .object({
      verdict: z.enum(["ok", "warn"]),
      recommended: z.number().int(),
      safeMax: z.number().int(),
      hardMax: z.number().int(),
    })
    .nullable(),
  /** Shells deleted for removed rounds (`slots_freed`: how many of them held a laid-out slot) and minted for added ones. */
  shells: z.object({
    added: z.number().int(),
    removed: z.number().int(),
    slots_freed: z.number().int(),
  }),
});

/** POST /stages/{id}/swiss/add-round (W3 T12, X-SW-17) — the new round count and the shells minted for it. */
export const AddSwissRoundResult = z.object({
  rounds: z.number().int(),
  shells_added: z.number().int(),
});

/** POST /stages/{id}/swiss/finish (W3 T13, X-SW-26) — the round whose standings became final, the rows past it deleted
 *  (and how many held a laid-out slot), and the stage's completion (`completeStage`'s own answer). */
export const FinishSwissResult = z.object({
  finished_after: z.number().int(),
  shells_removed: z.number().int(),
  slots_freed: z.number().int(),
  completed: z.boolean(),
  events: z.array(z.record(z.string(), z.unknown())),
  qualified: z.object({ stage_id: Uuid, entrants: z.array(Uuid) }).optional(),
  next_stage_fixtures: z.number().int().optional(),
  division_completed: z.boolean().optional(),
  seed_proposal: z.object({ id: Uuid, status: z.string() }).optional(),
});

/** GET /stages/{id}/swiss-cut (W3 T17, RB3-19, X-SW-25) — who a correction moved across a completed Swiss's cut after its
 *  knockout began. `drift` is null when nothing moved (or there is nothing to compare: a running Swiss, an unseated or
 *  unbegun bracket). `out` held a seat in the bracket and would not make today's cut; `in` would and holds none — entrant
 *  ids, in table order. The bracket itself never moves. */
export const SwissCutDriftResult = z.object({
  drift: z.object({ out: z.array(Uuid), in: z.array(Uuid) }).nullable(),
});

/** POST /stages/{id}/open-round (T19, D12) — the organiser opens one round
 *  of an online-play stage: stamps it and invites its players. */
export const OpenRoundInput = z.object({ roundNo: z.number().int().positive() }).strict();
export type OpenRoundInput = z.infer<typeof OpenRoundInput>;

export const OpenRoundSkip = z.object({ fixtureId: Uuid, reason: z.enum(OPEN_ROUND_SKIP_REASONS) });

/** `invited` counts SEATS whose invite the mail provider accepted (two per
 *  board), never boards; `retrying` counts the seats whose invite is queued and still being tried. Every refusal wrote nothing. */
export const OpenRoundResult = z.union([
  z.object({ opened: z.literal(true), invited: z.number().int(), retrying: z.number().int(), skipped: z.array(OpenRoundSkip) }),
  z.object({ opened: z.literal(false), reason: z.literal("already_open"), skipped: z.array(OpenRoundSkip) }),
  z.object({ opened: z.literal(false), reason: z.enum(OPEN_ROUND_REFUSALS) }),
]);

/** POST /fixtures/{id}/external-play/extend-checkin (spec §3.2.2) - the arbiter adds time to ONE board's check-in. No body. */
export const CheckinExtendBoardOut = z.object({
  fixtureId: Uuid,
  /** Presses made on this board, this one included. */
  extensions: z.number().int(),
  extensionsLeft: z.number().int(),
  /** Minutes this press added. */
  addedMinutes: z.number().int(),
  /** The board's new deadline. */
  deadlineAt: z.iso.datetime({ offset: true }),
});

/** POST /stages/{id}/extend-checkin (spec §3.2.2) - the same press on every board of an opened round whose check-in is open now. */
export const ExtendRoundCheckinInput = z.object({ roundNo: z.number().int().positive() }).strict();
export type ExtendRoundCheckinInput = z.infer<typeof ExtendRoundCheckinInput>;
export const CheckinExtendRoundOut = z.object({
  extended: z.number().int(),
  skipped: z.object({ closed: z.number().int(), gameStarted: z.number().int(), capReached: z.number().int() }),
  notOpenYet: z.number().int(),
  ownBoards: z.number().int(),
  failed: z.number().int(),
  addedMinutes: z.number().int(),
});

export const CompleteResult = z.object({
  completed: z.boolean(),
  events: z.array(z.record(z.string(), z.unknown())),
  /** Set when completion resolved the next stage's progression rules. */
  qualified: z.object({ stage_id: Uuid, entrants: z.array(Uuid) }).optional(),
});
