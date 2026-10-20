// W2c Task 20 (S4, X-SR-4 UI half) - which of the division settings form's fields a started stage locks, and how the form
// names them. The SERVER decides (`divisionRefusals`, rule-locks.ts): the page hands the form that same read as
// `lockedFields` (computed as "if this key changed, would a save refuse it"), and a save's own answer (`refused` on a 200,
// on a 409's `extra`) is the fallback for a stage that started after the page loaded. This file only matches the form's
// fields to those refusals and words them: no second opinion about what is locked.
//
// Client-safe: no `server-only`, no JSX. The sentences are the dictionary's (`ruleLock.*`), said in the reader's language.
import { SPORT_RULES } from "@/lib/match-rules";
import type { MessageKey } from "@/lib/messages";
import type { RefusedField } from "@/lib/rule-errors";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Each refusal code's lock line (ui.json): "Locked: {stage} has started and ...". */
export const RULE_LOCK_KEYS = {
  DIVISION_FORMAT_LOCKED: "ruleLock.DIVISION_FORMAT_LOCKED",
  DIVISION_TABLE_RULES_LOCKED: "ruleLock.DIVISION_TABLE_RULES_LOCKED",
} as const satisfies Record<RefusedField["code"], MessageKey>;

/** "Saved. {n} setting(s) were kept because a stage has started". */
export const RULE_LOCK_PARTIAL_KEY = "ruleLock.partialSave" as const satisfies MessageKey;

/** The first segment of a declared cfg path ("overtime.minutes" -> "overtime"): a refusal names the config's TOP-level key. */
const topOf = (path: string): string => path.split(".")[0]!;

/**
 * The lock a form field carries, or undefined when it is open: the first refusal naming the field's own key, or the top
 * segment of any engine key the field `edits` (a field may edit several, and the config key a refusal names is not always
 * the field's key: generic's "abandon" field edits `abandonPolicy`). The list's own order answers when two match.
 */
export function lockLineFor(
  fieldKey: string,
  lockedFields: readonly RefusedField[],
  edits: readonly string[] = [],
): RefusedField | undefined {
  const names = new Set([fieldKey, ...edits.map(topOf)]);
  return lockedFields.find((r) => names.has(r.field));
}

/** The page's locks and a save response's, one entry per field: the earlier list's entry stands for a field both name. */
export function mergeLocks(base: readonly RefusedField[], more: readonly RefusedField[]): RefusedField[] {
  const out = [...base];
  for (const r of more) if (!out.some((o) => o.field === r.field)) out.push(r);
  return out;
}

/** A lock line's sentence, the stage named. */
export function lockSentence(lock: RefusedField, m: Msg): string {
  return m(RULE_LOCK_KEYS[lock.code], { stage: lock.stageName });
}

/**
 * The name a refused field is listed under: the variant picker's, the label of the form field that edits the key, or the
 * key itself when the form has no field for it (an API-only key, a future one) rather than a name made up here.
 */
export function refusedFieldLabel(sportKey: string, field: string, m: Msg): string {
  if (field === "variant_key") return m("divset.variant");
  const fields = Object.hasOwn(SPORT_RULES, sportKey) ? SPORT_RULES[sportKey]! : [];
  const named = fields.find((f) => f.key === field) ?? fields.find((f) => f.edits.some((e) => topOf(e) === field));
  return named?.label ?? field;
}
