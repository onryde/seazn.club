// The W2c rule-lock error codes: one table of HTTP statuses and one English sentence per code (spec §7).
//
// Client-safe by design (plan Global Constraints, Boundaries): no `server-only`, no `@/server/*` import. The server
// throws `HttpError(RULE_ERROR_STATUS[code], ruleErrorMessage(code, …), code)`; a client that only has the code can
// pick the same status and the same sentence. The en dictionary carries the same sentences for the UI (later task);
// the three other locales translate them there, never here.

export const RULE_ERROR_STATUS = {
  STAGE_FORMAT_LOCKED: 409,
  DIVISION_TABLE_RULES_LOCKED: 409,
  DIVISION_FORMAT_LOCKED: 409,
  FIXTURE_FORMAT_LOCKED: 409,
  FORMAT_DOES_NOT_FIT_PLAY: 409,
  RULE_NOT_SETTABLE: 400,
  POINTS_RULE_INEXPRESSIBLE: 422,
} as const;

/** X-SR-5 (owner P-4 "A") — why a correction does not fit the recorded play when the engine's fold did NOT refuse it:
 *  the corrected fold must keep the outcome and the score as shown. `ends` is the owner's sentence (P-4). When the fold
 *  itself refuses, the engine's own reason is the message instead. */
export const FORMAT_FIT_REASONS = {
  ends: "This format would end the match as it stands",
  result: "This format would change the result as it stands",
  score: "This format would change the score as it stands",
} as const;

export type RuleErrorCode = keyof typeof RULE_ERROR_STATUS;

/** One field a division save did not apply, and the first started stage that depends on it. Lives here, not beside
 *  `divisionRefusals` (server-only): the 409 body and the 200 body's `refused` list both carry it to a client. */
export interface RefusedField {
  field: string;
  code: Extract<RuleErrorCode, "DIVISION_FORMAT_LOCKED" | "DIVISION_TABLE_RULES_LOCKED">;
  stageId: string;
  stageName: string;
}

export interface RuleErrorParams {
  stage?: string;
  field?: string;
  reason?: string;
}

const EN: Record<RuleErrorCode, (p: RuleErrorParams) => string> = {
  STAGE_FORMAT_LOCKED: (p) => `${p.stage} has started — its rules are locked.`,
  DIVISION_TABLE_RULES_LOCKED: (p) => `${p.stage} has started — table rules are locked.`,
  DIVISION_FORMAT_LOCKED: (p) =>
    `${p.stage} has started; its match format is locked. Change individual unstarted matches instead.`,
  FIXTURE_FORMAT_LOCKED: () => "This match is finished — its format is locked.",
  FORMAT_DOES_NOT_FIT_PLAY: (p) => p.reason ?? "The recorded play does not fit this format.",
  RULE_NOT_SETTABLE: (p) => `${p.field} can't be set here${p.reason ? ` — ${p.reason}` : ""}.`,
  POINTS_RULE_INEXPRESSIBLE: (p) => `These points can't be set per stage yet — ${p.reason}.`,
};

export const ruleErrorMessage = (code: RuleErrorCode, p: RuleErrorParams): string => EN[code](p);
