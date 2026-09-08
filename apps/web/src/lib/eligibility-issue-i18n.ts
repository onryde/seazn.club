// B05 — the ONE organiser-facing mapping from a structured eligibility refusal
// to its localized sentence.
//
// `EligibilityIssue.message` (registration-rules.ts) is documented as "English,
// the display fallback … No i18n owed (server-side errors stay English
// repo-wide); a locale-aware surface renders off `code` instead". Every issue
// carries a stable `code` plus structured `meta` (the age limit, the category)
// precisely so a surface can render its own copy — this module is that surface's
// half of the bargain. The server keeps building English; nothing here changes
// what it sends.
//
// WHY A SHARED MODULE, and what it is NOT shared with:
//
//  - `EligibilityOverrideDialog` (components/v2/eligibility-override-dialog.tsx)
//    is mounted by BOTH organiser surfaces that can hit a 422
//    `ELIGIBILITY_VIOLATION` — `entrants-panel.tsx` (roster writes) and
//    `import-wizard.tsx` (CSV commit) — so one map on the dialog already covers
//    both without either owning a private copy.
//  - `import-wizard.tsx`'s own `ISSUE_I18N` is deliberately NOT folded in here.
//    It maps a DISJOINT code space: the import PLAN's issue codes
//    (`DIVISION_NOT_FOUND`, `AMBIGUOUS_PERSON`, `BAD_POSITION`, … — see
//    packages/engine/src/import/plan.ts), on an `ImportIssue` that carries
//    `messageArgs`, not an `EligibilityIssue` carrying `meta`. Two code spaces
//    with no member in common are two facts, and merging them into one table
//    would invite exactly the lookup-by-the-wrong-code bug the split prevents.
//  - `INELIGIBLE_MESSAGE_KEY`
//    (components/public-site/register/eligibility-presentation.ts) stays
//    separate on purpose: its copy is REGISTRANT-facing and second-person
//    ("Add your date of birth in step 1 …"), which is the wrong voice for an
//    organiser reading someone else's roster. Same rule, two audiences.
//
// GENDER_NOT_ALLOWED has no entry, for the same reason the public map skips it:
// RS007/V380 dropped the jsonb `eligibility` rules that were its only producer,
// so no evaluator emits it any more and a key would be untestable dead copy.
// It therefore exercises the English fallback, which is the point of keeping one.
import type { MessageKey } from "@/lib/messages";
import type { EligibilityCode, EligibilityIssue } from "@/lib/registration-rules";

/** The `useMsg()`/`msg()` shape, passed in rather than hooked so this module
 *  stays a plain function callable from a render body — the same convention
 *  `offenderLabel` (eligibility-override-dialog.tsx) and `eligibilityBadges`
 *  (entrants-panel.tsx) already use. */
export type MsgFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

interface IssueEntry {
  messageKey: MessageKey;
  /** Derives the key's interpolation vars from the issue's `meta`. Returns
   *  `null` when this issue cannot supply them — see `eligibilityIssueText`. */
  vars?: (issue: EligibilityIssue) => Record<string, string | number> | null;
}

/** AGE_TOO_OLD/AGE_TOO_YOUNG both carry `meta.limit` (the age_max / age_min the
 *  division declared — registration-rules.ts `ageBandEligibilityIssues`). */
function ageLimitVars(issue: EligibilityIssue): Record<string, string | number> | null {
  const limit = issue.meta?.limit;
  return typeof limit === "number" ? { limit } : null;
}

export const ORGANISER_ELIGIBILITY_ISSUE_I18N: Partial<Record<EligibilityCode, IssueEntry>> = {
  AGE_TOO_OLD: {
    messageKey: "divset.entrants.eligibilityGate.issue.ageTooOld",
    vars: ageLimitVars,
  },
  AGE_TOO_YOUNG: {
    messageKey: "divset.entrants.eligibilityGate.issue.ageTooYoung",
    vars: ageLimitVars,
  },
  MISSING_DOB: { messageKey: "divset.entrants.eligibilityGate.issue.missingDob" },
  MISSING_GENDER: { messageKey: "divset.entrants.eligibilityGate.issue.missingGender" },
  CATEGORY_MISMATCH: { messageKey: "divset.entrants.eligibilityGate.issue.categoryMismatch" },
  MIXED_NEEDS_BOTH_GENDERS: {
    messageKey: "divset.entrants.eligibilityGate.issue.mixedNeedsBothGenders",
  },
};

/**
 * The sentence an organiser reads for one refusal.
 *
 * Falls back to `issue.message` — the server's English — in exactly two cases,
 * and never to blank:
 *
 *  1. no entry for the code (a code this map has not learned yet, or one with
 *     no producer). English is a worse read than a translation; a missing
 *     bullet is a worse read than either.
 *  2. an entry whose key INTERPOLATES a value the issue cannot supply
 *     (`vars` returns `null`). `msg()` leaves an unsupplied `{limit}` in the
 *     output verbatim (lib/messages.ts), and a refusal that says "over the age
 *     limit ({limit} and under)" — or, worse, quietly drops the number — is
 *     strictly worse than the English sentence it replaced, which always
 *     carries it. AGENTS.md rule 19: a present-but-wrongly-seeded value beats
 *     an absent one only when it is actually right.
 */
export function eligibilityIssueText(issue: EligibilityIssue, msg: MsgFn): string {
  const entry = ORGANISER_ELIGIBILITY_ISSUE_I18N[issue.code];
  if (!entry) return issue.message;
  if (!entry.vars) return msg(entry.messageKey);
  const vars = entry.vars(issue);
  if (vars === null) return issue.message;
  return msg(entry.messageKey, vars);
}

/**
 * The discipline gate's refusal (B05), which is NOT an `EligibilityIssue` and
 * so is not in the map above: `gateLineupSuspensions`
 * (server/usecases/discipline.ts) throws `HttpError(422, …, "SUSPENDED_PLAYER",
 * { suspended: [{ person_id, full_name }] })` — the code sits on the ERROR, not
 * on an issue row, and `putLineup` is its only caller. `suspendedPlayersMessage`
 * (registration-rules.ts) builds the English sentence and its own doc comment
 * flags the English as a known gap; this renders the same fact off the
 * structured `suspended` list instead.
 *
 * Returns `null` when the names are unusable, so the caller can keep the
 * server's own sentence rather than render a nameless accusation.
 */
export function suspendedPlayersText(names: readonly string[], msg: MsgFn): string | null {
  const usable = names.filter((n) => typeof n === "string" && n.trim().length > 0);
  if (usable.length === 0) return null;
  return msg("divset.entrants.eligibilityGate.issue.suspendedPlayer", {
    names: usable.join(", "),
  });
}
