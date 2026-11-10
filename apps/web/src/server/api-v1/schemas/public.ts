// /api/v1 contracts — public fixture summary (GET /public/fixtures/{id}) and PublicOrgLive.
// One module of the schemas/ folder; ./index.ts is the map and the public surface. Pure zod (loads bare under
// `node --experimental-strip-types`): relative imports carry an explicit `.ts`, types come in through `import type`.
import { z } from "zod";
// Loop R M-14: the award's closed reason vocabulary, the engine's own list (loads bare under strip-types).
import { AWARD_REASONS } from "@seazn/engine/core";
// Task 9 (spectator surface W1) — the match-centre document schema, reused
// verbatim as `PublicFixtureSummary.match_centre`'s type below rather than
// restated: match-centre-schema.ts is pure Zod with no imports beyond zod
// itself (verified by reading it), so it is safe for the standalone OpenAPI
// generator script the same way this whole file is — relative import, `.ts`
// extension, same reasoning as `registration-rules.ts` above.
import { MatchCentreDoc } from "../../public-site/match-centre-schema.ts";
import { Uuid, CompetitionStatus } from "./common.ts";
import { SlotLabelRef, Fixture } from "./scoring.ts";

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
    // W2b (D2): an award's loser, `null` for a bye — nobody lost to the side that advanced.
    loser: z.string().nullable().optional(),
    method: z.string().optional(),
    /** W2b (D1, D2; Loop R M-14) — WHY an award was given, from the engine's closed vocabulary (`AWARD_REASONS`: the
     *  four forfeit reasons and the system's `bye`). Present on every award the engine writes; absent on every other
     *  kind, and on an award stored before W2b (which carried its reason as `method`). */
    reason: z.enum(AWARD_REASONS).optional(),
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
  /** W4 (V499): when the organiser ruled this unplayed final a joint title (`status` decided, `outcome` null); else null. */
  joint_winners_at: z.string().nullable().optional(),
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
