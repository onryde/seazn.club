// The W2c rule-lock error codes: one table of HTTP statuses and one English sentence per code (spec §7).
//
// Client-safe by design (plan Global Constraints, Boundaries): no `server-only`, no `@/server/*` import. The server
// throws `HttpError(RULE_ERROR_STATUS[code], ruleErrorMessage(code, …), code, extra)`; a client that only has the code
// can pick the same status and the same sentence.
//
// Batch-3 M1: the sentences live in the dictionaries (`rules.err.*`, ui.json, all four locales) and nowhere else. The
// server's English IS the en dictionary (`ruleErrorMessage` reads it through `msg`), and the client says the refusal in
// the reader's language off its CODE and the structured facts in its `extra` (`ruleRefusalText`) — never the server's
// English message.
import { msg as enMsg, type MessageKey } from "@/lib/messages";

export const RULE_ERROR_STATUS = {
  STAGE_FORMAT_LOCKED: 409,
  DIVISION_TABLE_RULES_LOCKED: 409,
  DIVISION_FORMAT_LOCKED: 409,
  FIXTURE_FORMAT_LOCKED: 409,
  FORMAT_DOES_NOT_FIT_PLAY: 409,
  RULE_NOT_SETTABLE: 400,
  POINTS_RULE_INEXPRESSIBLE: 422,
  /** W2c Task 14 — a delete (rebuild, Undo of a generation, pool clear, Swiss reshape) that would take a match's own
   *  format with it (`fixture-override-guards.ts`). The organiser sets that match back to its stage's format first. */
  FIXTURE_HAS_OWN_FORMAT: 409,
  /** W2c Task 11 — a stage or division save that would leave an UNSTARTED match's own format unable to fit the stage it
   *  plays in (a decider the match shortened, now shorter than the match's; `fixture-override-guards.ts`). The sibling of
   *  FIXTURE_HAS_OWN_FORMAT: that one is a delete taking the format away, this one a save invalidating it. */
  FIXTURE_OWN_FORMAT_NO_LONGER_FITS: 409,
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

/** Each code's sentence (ui.json). Pinned against the code table and all four locales in rule-errors-copy.test.ts. */
export const RULE_ERROR_KEYS = {
  STAGE_FORMAT_LOCKED: "rules.err.stageFormatLocked",
  DIVISION_TABLE_RULES_LOCKED: "rules.err.divisionTableRulesLocked",
  DIVISION_FORMAT_LOCKED: "rules.err.divisionFormatLocked",
  FIXTURE_FORMAT_LOCKED: "rules.err.fixtureFormatLocked",
  FORMAT_DOES_NOT_FIT_PLAY: "rules.err.formatDoesNotFitPlay",
  RULE_NOT_SETTABLE: "rules.err.ruleNotSettable",
  POINTS_RULE_INEXPRESSIBLE: "rules.err.pointsRuleInexpressible",
  FIXTURE_HAS_OWN_FORMAT: "rules.err.fixtureHasOwnFormat",
  FIXTURE_OWN_FORMAT_NO_LONGER_FITS: "rules.err.fixtureOwnFormatNoLongerFits",
} as const satisfies Record<RuleErrorCode, MessageKey>;

/** Why a match's format is locked (`FIXTURE_FORMAT_LOCKED`'s `extra.reason`): FINISHED (finalized or cancelled), or
 *  DECIDED without play where no correction applies — a bye, or an award its current format cannot re-score (the
 *  batch-3 review: neither is a finished match, and the sentence must not say so). */
export const FIXTURE_LOCK_KEYS = {
  finished: "rules.err.fixtureFormatLocked",
  decided: "rules.err.fixtureDecidedWithoutPlay",
} as const satisfies Record<string, MessageKey>;
export type FixtureLockReason = keyof typeof FIXTURE_LOCK_KEYS;

/** The sentences the codes' own sentences are built with. */
export const RULE_ERROR_SUPPORT_KEYS = {
  ruleNotSettableBecause: "rules.err.ruleNotSettableBecause",
  match: "rules.err.match",
  thisMatch: "rules.err.thisMatch",
  matchSays: "rules.err.matchSays",
} as const satisfies Record<string, MessageKey>;

/** One field a division save did not apply, and the first started stage that depends on it. Lives here, not beside
 *  `divisionRefusals` (server-only): the 409 body and the 200 body's `refused` list both carry it to a client. */
export interface RefusedField {
  field: string;
  code: Extract<RuleErrorCode, "DIVISION_FORMAT_LOCKED" | "DIVISION_TABLE_RULES_LOCKED">;
  stageId: string;
  stageName: string;
}

const REFUSED_CODES: ReadonlySet<string> = new Set<RefusedField["code"]>(["DIVISION_FORMAT_LOCKED", "DIVISION_TABLE_RULES_LOCKED"]);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The `refused` list an error's data carries, as the wire may say it: only well-formed entries, only their four keys,
 *  null when none (W2c Task 12 — the division save's CONFIG_INVALID after a per-field refusal names the fields it kept
 *  as stored, and `http.ts` forwards them). */
export function refusedFieldsOf(data: unknown): RefusedField[] | null {
  const list = isRecord(data) ? data.refused : undefined;
  if (!Array.isArray(list)) return null;
  const out: RefusedField[] = [];
  for (const r of list) {
    if (!isRecord(r)) continue;
    const { field, code, stageId, stageName } = r;
    if (typeof field !== "string" || typeof code !== "string" || !REFUSED_CODES.has(code)) continue;
    if (typeof stageId !== "string" || typeof stageName !== "string") continue;
    out.push({ field, code: code as RefusedField["code"], stageId, stageName });
  }
  return out.length === 0 ? null : out;
}

/** The fit reasons' sentences (ui.json); their en copy IS `FORMAT_FIT_REASONS` (pinned). */
export const FORMAT_FIT_REASON_KEYS = {
  ends: "rules.err.fit.ends",
  result: "rules.err.fit.result",
  score: "rules.err.fit.score",
} as const satisfies Record<keyof typeof FORMAT_FIT_REASONS, MessageKey>;
export type FormatFitReason = keyof typeof FORMAT_FIT_REASONS;

/** The fit reason a sentence is, or undefined for any other (the engine's own message): what an emitter of
 *  FORMAT_DOES_NOT_FIT_PLAY puts in `extra.fit_reason`, so a client can say it in the reader's language. */
export const fitReasonOf = (reason: string): FormatFitReason | undefined =>
  (Object.keys(FORMAT_FIT_REASONS) as FormatFitReason[]).find((k) => FORMAT_FIT_REASONS[k] === reason);

export interface RuleErrorParams {
  stage?: string;
  field?: string;
  reason?: string;
  /** The match as the board names it ("Match 3"). */
  match?: string;
  /** FIXTURE_FORMAT_LOCKED: why (default finished). */
  lock?: FixtureLockReason;
}

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** One code's sentence through `m` — the en dictionary on the server, the reader's on a client. */
function sentence(code: RuleErrorCode, p: RuleErrorParams, m: Msg): string {
  switch (code) {
    case "FIXTURE_FORMAT_LOCKED":
      return m(FIXTURE_LOCK_KEYS[p.lock ?? "finished"]);
    case "FORMAT_DOES_NOT_FIT_PLAY":
      return p.reason ?? m(RULE_ERROR_KEYS.FORMAT_DOES_NOT_FIT_PLAY);
    case "RULE_NOT_SETTABLE":
      return p.reason
        ? m(RULE_ERROR_SUPPORT_KEYS.ruleNotSettableBecause, { field: p.field ?? "", reason: p.reason })
        : m(RULE_ERROR_KEYS.RULE_NOT_SETTABLE, { field: p.field ?? "" });
    case "POINTS_RULE_INEXPRESSIBLE":
      return m(RULE_ERROR_KEYS.POINTS_RULE_INEXPRESSIBLE, { reason: p.reason ?? "" });
    case "FIXTURE_HAS_OWN_FORMAT":
    case "FIXTURE_OWN_FORMAT_NO_LONGER_FITS":
      return m(RULE_ERROR_KEYS[code], { match: p.match ?? m(RULE_ERROR_SUPPORT_KEYS.thisMatch) });
    case "STAGE_FORMAT_LOCKED":
    case "DIVISION_TABLE_RULES_LOCKED":
    case "DIVISION_FORMAT_LOCKED":
      return m(RULE_ERROR_KEYS[code], { stage: p.stage ?? "" });
  }
}

/** The server's sentence: the en dictionary's. */
export const ruleErrorMessage = (code: RuleErrorCode, p: RuleErrorParams): string => sentence(code, p, enMsg);

const isCode = (code: string): code is RuleErrorCode => Object.hasOwn(RULE_ERROR_STATUS, code);

/**
 * A rule-lock refusal in the reader's language, read off its code and the facts its emitter puts in `extra`:
 * `refused[0].stageName` (the division save), `stage_name` (the stage save), `fixture_no` (the match's number on the board), `reason` (why a match is
 * locked), `fit_reason` (which fit reason), `field`. Null when it is not a rule-lock code, or when the sentence needs a
 * fact the refusal does not carry — and for an engine's own reason (no `fit_reason`), which this app cannot say better:
 * the caller then keeps its own copy.
 */
export function ruleRefusalText(code: string | undefined, extra: Readonly<Record<string, unknown>> | undefined, m: Msg): string | null {
  if (code === undefined || !isCode(code)) return null;
  const x = extra ?? {};
  const match = typeof x.fixture_no === "number" ? m(RULE_ERROR_SUPPORT_KEYS.match, { n: x.fixture_no }) : undefined;
  switch (code) {
    case "DIVISION_TABLE_RULES_LOCKED":
    case "DIVISION_FORMAT_LOCKED": {
      const first: unknown = Array.isArray(x.refused) ? x.refused[0] : undefined;
      const stage = typeof first === "object" && first !== null ? (first as { stageName?: unknown }).stageName : undefined;
      return typeof stage === "string" ? sentence(code, { stage }, m) : null;
    }
    case "FIXTURE_FORMAT_LOCKED":
      return sentence(code, { lock: x.reason === "decided" ? "decided" : "finished" }, m);
    case "FORMAT_DOES_NOT_FIT_PLAY": {
      const fit = typeof x.fit_reason === "string" && Object.hasOwn(FORMAT_FIT_REASON_KEYS, x.fit_reason)
        ? m(FORMAT_FIT_REASON_KEYS[x.fit_reason as FormatFitReason])
        : null;
      if (fit === null) return null;
      return match === undefined ? fit : m(RULE_ERROR_SUPPORT_KEYS.matchSays, { match, reason: fit });
    }
    case "RULE_NOT_SETTABLE":
      return typeof x.field === "string" ? sentence(code, { field: x.field }, m) : null;
    case "POINTS_RULE_INEXPRESSIBLE":
      return null; // no emitter yet, and its reason is English: the caller keeps the message
    case "FIXTURE_HAS_OWN_FORMAT":
    case "FIXTURE_OWN_FORMAT_NO_LONGER_FITS":
      return sentence(code, { match }, m);
    case "STAGE_FORMAT_LOCKED":
      return typeof x.stage_name === "string" ? sentence(code, { stage: x.stage_name }, m) : null;
  }
}
