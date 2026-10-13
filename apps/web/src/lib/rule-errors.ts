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

export type RuleErrorCode = keyof typeof RULE_ERROR_STATUS;

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
