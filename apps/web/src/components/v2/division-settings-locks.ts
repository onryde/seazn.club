// W2c Task 20 (S4, X-SR-4 UI half) - which of the division settings form's fields a started stage locks, and how the form
// names them. The SERVER decides (`divisionRefusals`, rule-locks.ts): the page hands the form that same read as
// `lockedFields` (computed as "if this key changed, would a save refuse it"), and a save's own answer (`refused` on a 200,
// on a 409's `extra`) is the fallback for a stage that started after the page loaded. This file only matches the form's
// fields to those refusals and words them: no second opinion about what is locked.
//
// Client-safe: no `server-only`, no JSX. The sentences are the dictionary's (`ruleLock.*`), said in the reader's language.
import type { RuleField } from "@/lib/match-rules";
import { BEST_OF_ONE_PAIR } from "@/lib/match-rules/best-of-one";
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

/** One line of "what the save kept": the name the organiser knows the control by, and the refusal that explains it. */
export interface RefusedLine {
  /** Becomes the line's testid suffix: the refusal's own field, or "other" for the grouped line. */
  id: string;
  label: string;
  lock: RefusedField;
}

/**
 * What a save kept, one line per CONTROL the organiser can see, never one per config key (M-4): the variant picker, each
 * rule field that edits a refused key (its own label), the standings-points boxes when this division has them. A refused
 * key the form has no control for (a table rule such as `pointsMap`, the cascade a variant change drags along, an API-only
 * key) is not named by its raw key: all of them are ONE line, "Other format settings", worded by the first of them. So a
 * refused variant reads as the handful of settings the organiser sees, not as the length of its cascade.
 *
 * `fields` is what the form SHOWS (`visibleRuleFields`, over the values and inherited config its grid reads), not the sport's
 * whole table (batch-6 T20-1): on best of 1 the points pair collapses to one control and the other is hidden, so a line must
 * never name a control the organiser cannot see. One control writes both keys of the pair, so a refusal of the HIDDEN key is
 * a refusal of the visible one - one line, not "other settings".
 *
 * `pointsBox`: this division edits its standings points in the form (the `points` key is then that group, not "other").
 */
export function refusedLines(fields: readonly RuleField[], refused: readonly RefusedField[], m: Msg, pointsBox: boolean): RefusedLine[] {
  const lines: RefusedLine[] = [];
  const listed = new Set<string>();
  let other: RefusedLine | undefined;
  for (const r of refused) {
    if (r.field === "variant_key") {
      lines.push({ id: r.field, label: m("divset.variant"), lock: r });
      continue;
    }
    if (r.field === "points" && pointsBox) {
      lines.push({ id: r.field, label: m("divset.standingsPoints"), lock: r });
      continue;
    }
    const named =
      fields.find((f) => f.key === r.field) ??
      fields.find((f) => f.edits.some((e) => topOf(e) === r.field)) ??
      // The hidden twin of a collapsed pair (best of 1): the visible control writes it too.
      (r.field === BEST_OF_ONE_PAIR.shadow ? fields.find((f) => f.key === BEST_OF_ONE_PAIR.shown) : undefined);
    if (named === undefined) {
      other ??= { id: "other", label: m("ruleLock.otherSettings"), lock: r };
      continue;
    }
    if (listed.has(named.key)) continue; // two refusals for one control (a field that edits two keys): one line
    listed.add(named.key);
    lines.push({ id: r.field, label: m(named.labelKey), lock: r });
  }
  if (other !== undefined) lines.push(other);
  return lines;
}
