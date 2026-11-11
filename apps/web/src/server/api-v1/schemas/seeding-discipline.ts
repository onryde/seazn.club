// /api/v1 contracts — seed proposals (D4a), ladder challenge, discipline and suspensions, official marks, match reports.
// One module of the schemas/ folder; ./index.ts is the map and the public surface. Pure zod (loads bare under
// `node --experimental-strip-types`): relative imports carry an explicit `.ts`, types come in through `import type`.
import { z } from "zod";
import { Uuid } from "./common.ts";
import { RoundRoleKey } from "./stages.ts";
import { Fixture } from "./scoring.ts";

// ---------------------------------------------------------------------------
// Seed proposals (D4a design doc, P5) — propose + confirm cross-stage fill.
// API contracts & error codes section, verbatim shape; error CODES are
// ALL_CAPS_SNAKE per repo convention (ruling already made for D2/P1's
// CAPACITY_IMPOSSIBLE — the design doc's dotted-lowercase codes here
// (`seeding.source_stage_incomplete` etc.) are i18n-key-shaped, not the
// convention typed codes use anywhere in this tree; see usecases/stages/ for the
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
  /** A plate asked for a third-place match and its field gave under two real semi-finals: it was drawn without (RB4-E5/T4). */
  thirdPlaceDropped: z.literal(true).optional(),
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
  /** The matches the ban still covers, in the order they will be missed (owner-approved 4A): an active ban's next
   *  `matchesTotal - matchesServed`, a pending one's next `matchesTotal` were it confirmed now — computed by the same
   *  rule that serves it. A null `fixtureId` is a placeholder: the team has fewer fixtures left than the ban has
   *  matches. Empty for a served or waived ban. */
  coveredMatches: z.array(
    z.object({
      fixtureId: Uuid.nullable(),
      /** A `roundRoleKey()` of the fixture's round in its own stage (`plain_round_4`, `semi_final`); null for a placeholder. */
      roundRole: RoundRoleKey.nullable(),
      /** The other side's entrant name; null while that seat is undecided, and for a placeholder. */
      opponentName: z.string().nullable(),
      scheduledAt: z.string().nullable(),
    }),
  ),
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
