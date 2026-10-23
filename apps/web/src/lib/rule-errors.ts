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
  /** W2c Task 15 (X-SR-7, owner P-1 "A") — a scoring pad's tap sent under rules the match no longer plays by: the pad's
   *  `rules_version` is not the match's (`append-event.ts`, refused before any insert). The pad reloads the rules and
   *  the scorer taps again under them. */
  FIXTURE_RULES_CHANGED: 409,
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
  FIXTURE_RULES_CHANGED: "rules.err.fixtureRulesChanged",
} as const satisfies Record<RuleErrorCode, MessageKey>;

/** Why a match's format is locked (`FIXTURE_FORMAT_LOCKED`'s `extra.reason`): FINISHED (finalized), CANCELLED (batch-6
 *  M-1: a called-off match is not a finished one, and the sentence must not say so; the match block's own sentence), or
 *  DECIDED without play where no correction applies — a bye, or an award its current format cannot re-score (the
 *  batch-3 review: neither is a finished match, and the sentence must not say so). */
export const FIXTURE_LOCK_KEYS = {
  finished: "rules.err.fixtureFormatLocked",
  cancelled: "matchRules.lockedCancelled",
  decided: "rules.err.fixtureDecidedWithoutPlay",
} as const satisfies Record<string, MessageKey>;
export type FixtureLockReason = keyof typeof FIXTURE_LOCK_KEYS;
/** A reason this app can say (an older or newer server's other value reads as finished, the pre-M-1 default). */
const isLockReason = (r: unknown): r is FixtureLockReason => typeof r === "string" && Object.hasOwn(FIXTURE_LOCK_KEYS, r);

/** The sentences the codes' own sentences are built with. */
export const RULE_ERROR_SUPPORT_KEYS = {
  ruleNotSettableBecause: "rules.err.ruleNotSettableBecause",
  match: "rules.err.match",
  thisMatch: "rules.err.thisMatch",
  matchSays: "rules.err.matchSays",
  /** POINTS_RULE_INEXPRESSIBLE's reason: "this division scores {fields} separately". */
  pointsSplit: "rules.err.pointsSplit",
  /** FIXTURE_RULES_CHANGED when the describer has no line for the corrected format (or the reader's client does not
   *  have it in the reader's language): "the format was corrected", without naming it. */
  fixtureRulesChangedNoLine: "rules.err.fixtureRulesChangedNoLine",
  /** FORMAT_DOES_NOT_FIT_PLAY whose reason is the ENGINE's own sentence (no `fit_reason`): "The match so far doesn't fit
   *  that format: {reason}" - the frame is the reader's language, the reason the engine's (W2c Task 19). */
  formatDoesNotFitPlayBecause: "rules.err.formatDoesNotFitPlayBecause",
  /** DIVISION_FORMAT_LOCKED when the stage's matches take no format of their own (final review M2): the sport declares
   *  no match-scope key for that stage (`fixtureKeysFor` is empty, chess today), so the sentence does not send the
   *  organiser to change individual matches. The emitter says which (`extra.match_edits`). */
  divisionFormatLockedNoMatchEdits: "rules.err.divisionFormatLockedNoMatchEdits",
  /** A refusal naming the stage it is about ("{stage}: {reason}"): RULE_NOT_SETTABLE under a division save carries the
   *  stage's name (`extra.stage_name`, final review M1), and the server's English is the same composition. */
  stageSays: "rules.err.stageSays",
} as const satisfies Record<string, MessageKey>;

/** Why a key is not settable, as its emitter names it (`extra.reason`, a code, never English), each with its reason in the
 *  reader's language (final review M1). `online_division`: rebase ruling D1, the key belongs to an online (Lichess)
 *  division (its clock and clock family), never to one of its stages. Another or no reason reads as the plain sentence. */
export const RULE_NOT_SETTABLE_REASON_KEYS = {
  online_division: "rules.err.notSettable.onlineDivision",
} as const satisfies Record<string, MessageKey>;
export type RuleNotSettableReason = keyof typeof RULE_NOT_SETTABLE_REASON_KEYS;
const isNotSettableReason = (r: unknown): r is RuleNotSettableReason =>
  typeof r === "string" && Object.hasOwn(RULE_NOT_SETTABLE_REASON_KEYS, r);
/** The server's English for a not-settable reason: the en dictionary's, as every other refusal sentence. */
export const notSettableReasonEn = (r: RuleNotSettableReason): string => enMsg(RULE_NOT_SETTABLE_REASON_KEYS[r]);

/**
 * W2c Task 13 — the division points a stage PointsRule cannot express, by their config key (the engine's
 * `pointsRuleExpressible` names them: ice hockey's OT split, hockey's and football's shoot-out split, cricket's tie and no
 * result, a set sport's `pointsMap` that pays more than one pair), each with its label. POINTS_RULE_INEXPRESSIBLE carries
 * the KEYS (`extra.keys`), never English, and every reader names them through this table: the server in en, a client in
 * the reader's language. Swept against every sport's declared points in rule-errors-copy.test.ts: a key the engine can
 * refuse over with no label here is a red, and so is a label for a key it never refuses over.
 */
export const POINTS_SPLIT_LABEL_KEYS = {
  otWin: "rules.err.pointsSplit.otWin",
  otLoss: "rules.err.pointsSplit.otLoss",
  shootoutWin: "rules.err.pointsSplit.shootoutWin",
  shootoutLoss: "rules.err.pointsSplit.shootoutLoss",
  tie: "rules.err.pointsSplit.tie",
  noResult: "rules.err.pointsSplit.noResult",
  pointsMap: "rules.err.pointsSplit.pointsMap",
} as const satisfies Record<string, MessageKey>;

const isSplitKey = (k: unknown): k is keyof typeof POINTS_SPLIT_LABEL_KEYS =>
  typeof k === "string" && Object.hasOwn(POINTS_SPLIT_LABEL_KEYS, k);

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
  /** POINTS_RULE_INEXPRESSIBLE: the division's split keys (`pointsRuleExpressible`), named by their labels. */
  keys?: readonly string[];
  /** FIXTURE_RULES_CHANGED: the corrected format as the public describer says it, in the sentence's language. */
  format?: string;
  /** DIVISION_FORMAT_LOCKED: whether the stage's matches can take a format of their own (default true). False drops the
   *  advice to change individual unstarted matches (final review M2). */
  matchEdits?: boolean;
}

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** One code's sentence through `m` — the en dictionary on the server, the reader's on a client. */
function sentence(code: RuleErrorCode, p: RuleErrorParams, m: Msg): string {
  switch (code) {
    case "FIXTURE_FORMAT_LOCKED":
      return m(FIXTURE_LOCK_KEYS[p.lock ?? "finished"]);
    case "FORMAT_DOES_NOT_FIT_PLAY":
      return p.reason ?? m(RULE_ERROR_KEYS.FORMAT_DOES_NOT_FIT_PLAY);
    case "RULE_NOT_SETTABLE": {
      const said = p.reason
        ? m(RULE_ERROR_SUPPORT_KEYS.ruleNotSettableBecause, { field: p.field ?? "", reason: p.reason })
        : m(RULE_ERROR_KEYS.RULE_NOT_SETTABLE, { field: p.field ?? "" });
      return p.stage !== undefined ? m(RULE_ERROR_SUPPORT_KEYS.stageSays, { stage: p.stage, reason: said }) : said;
    }
    case "POINTS_RULE_INEXPRESSIBLE": {
      // The keys by their labels; a key with no label (none today: swept) by its config key rather than dropped.
      const reason = p.keys !== undefined
        ? m(RULE_ERROR_SUPPORT_KEYS.pointsSplit, { fields: p.keys.map((k) => (isSplitKey(k) ? m(POINTS_SPLIT_LABEL_KEYS[k]) : k)).join(", ") })
        : p.reason ?? "";
      return m(RULE_ERROR_KEYS.POINTS_RULE_INEXPRESSIBLE, { reason });
    }
    case "FIXTURE_HAS_OWN_FORMAT":
    case "FIXTURE_OWN_FORMAT_NO_LONGER_FITS":
      return m(RULE_ERROR_KEYS[code], { match: p.match ?? m(RULE_ERROR_SUPPORT_KEYS.thisMatch) });
    case "DIVISION_FORMAT_LOCKED":
      return p.matchEdits === false
        ? m(RULE_ERROR_SUPPORT_KEYS.divisionFormatLockedNoMatchEdits, { stage: p.stage ?? "" })
        : m(RULE_ERROR_KEYS[code], { stage: p.stage ?? "" });
    case "STAGE_FORMAT_LOCKED":
    case "DIVISION_TABLE_RULES_LOCKED":
      return m(RULE_ERROR_KEYS[code], { stage: p.stage ?? "" });
    case "FIXTURE_RULES_CHANGED":
      return p.format !== undefined
        ? m(RULE_ERROR_KEYS.FIXTURE_RULES_CHANGED, { format: p.format })
        : m(RULE_ERROR_SUPPORT_KEYS.fixtureRulesChangedNoLine);
  }
}

/** The server's sentence: the en dictionary's. */
export const ruleErrorMessage = (code: RuleErrorCode, p: RuleErrorParams): string => sentence(code, p, enMsg);

const isCode = (code: string): code is RuleErrorCode => Object.hasOwn(RULE_ERROR_STATUS, code);

/**
 * A rule-lock refusal in the reader's language, read off its code and the facts its emitter puts in `extra`:
 * `refused[0].stageName` (the division save), `stage_name` (the stage save; and the stage a division save's RULE_NOT_SETTABLE is
 * about), `fixture_no` (the match's number on the board), `reason` (why a match is locked; why a key is not settable),
 * `fit_reason` (which fit reason), `field`, `keys` (the points a stage rule cannot express), `match_edits` (whether a locked
 * stage's matches take a format of their own). Null when it is not a rule-lock code, or when the sentence needs a
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
      return typeof stage === "string" ? sentence(code, { stage, matchEdits: x.match_edits !== false }, m) : null;
    }
    case "FIXTURE_FORMAT_LOCKED":
      return sentence(code, { lock: isLockReason(x.reason) ? x.reason : "finished" }, m);
    case "FORMAT_DOES_NOT_FIT_PLAY": {
      const fit = typeof x.fit_reason === "string" && Object.hasOwn(FORMAT_FIT_REASON_KEYS, x.fit_reason)
        ? m(FORMAT_FIT_REASON_KEYS[x.fit_reason as FormatFitReason])
        : null;
      if (fit === null) return null;
      return match === undefined ? fit : m(RULE_ERROR_SUPPORT_KEYS.matchSays, { match, reason: fit });
    }
    case "RULE_NOT_SETTABLE":
      return typeof x.field === "string"
        ? sentence(
            code,
            {
              field: x.field,
              reason: isNotSettableReason(x.reason) ? m(RULE_NOT_SETTABLE_REASON_KEYS[x.reason]) : undefined,
              stage: typeof x.stage_name === "string" ? x.stage_name : undefined,
            },
            m,
          )
        : null;
    case "POINTS_RULE_INEXPRESSIBLE": {
      // W2c Task 13: the stage PUT, the create door and the division save send the split keys. Only keys this app can
      // name: anything else is the server's to say (null: the caller keeps the message).
      const keys = Array.isArray(x.keys) ? (x.keys as unknown[]) : [];
      return keys.length > 0 && keys.every(isSplitKey) ? sentence(code, { keys }, m) : null;
    }
    case "FIXTURE_HAS_OWN_FORMAT":
    case "FIXTURE_OWN_FORMAT_NO_LONGER_FITS":
      return sentence(code, { match }, m);
    case "STAGE_FORMAT_LOCKED":
      return typeof x.stage_name === "string" ? sentence(code, { stage: x.stage_name }, m) : null;
    case "FIXTURE_RULES_CHANGED":
      // `extra.format` is the SERVER's line (en): never spliced into another language's sentence. The reader's own line
      // comes with the reload (`GET /fixtures/{id}/rules`, `format_line`), which the pad's banner says.
      return sentence(code, {}, m);
  }
}

/**
 * W2c Task 19 - a rule-lock refusal as an editor SAYS it: `ruleRefusalText`'s sentence where the app owns one, else, for a
 * FORMAT_DOES_NOT_FIT_PLAY carrying only the ENGINE's own reason (a fold that refused the corrected format), a frame in the
 * reader's language around that reason - the engine's English sentence is not something this app can translate, but the
 * organiser should not read a bare English line in a Spanish console. Null when it is neither (the caller keeps its own
 * copy). `message` is the refusal's own message (the server's English, which IS the engine's reason for that shape).
 */
export function ruleRefusalSentence(
  code: string | undefined,
  extra: Readonly<Record<string, unknown>> | undefined,
  message: string,
  m: Msg,
): string | null {
  const text = ruleRefusalText(code, extra, m);
  if (text !== null) return text;
  return code === "FORMAT_DOES_NOT_FIT_PLAY" && message !== ""
    ? m(RULE_ERROR_SUPPORT_KEYS.formatDoesNotFitPlayBecause, { reason: message })
    : null;
}
