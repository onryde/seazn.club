"use client";

// Match rules — the CLIENT half: the shared field grid rendered by the
// division builder and the division Settings tab (v8), so the two format
// editors can't drift. The table itself (RuleField, SPORT_RULES,
// buildRuleOverride, hydrateRuleValues, configKeysFor)
// moved to `@/lib/match-rules` — directive-free and JSX-free — so the SERVER
// can import it by value; design 2026-09-17 §T0. It is re-exported below so
// existing importers keep working unchanged.
// W2c Task 17: one field's CONTROL (number / Default-On-Off / select / the
// ordered list) lives in `stage-rules/rule-field-control.tsx`, shared with the
// stage format row so the two editors cannot drift; this file keeps the grid.
import { useMsg } from "@/components/i18n/dict-provider";
import { configIssueText } from "@/lib/config-issue-copy";
import { setRuleValue, visibleRuleFields } from "@/lib/match-rules";
import type { RefusedField } from "@/lib/rule-errors";
import { RuleFieldControl } from "@/components/v2/stage-rules/rule-field-control";
import { lockLineFor, lockSentence } from "./division-settings-locks";
import type { RuleFormState } from "./match-rules-state";

export type { RuleField } from "@/lib/match-rules";
export {
  SPORT_RULES,
  rulesFor,
  buildRuleOverride,
  hydrateRuleValues,
  configKeysFor,
} from "@/lib/match-rules";
export { inheritedPlaceholder } from "@/components/v2/stage-rules/rule-field-control";

/** The builder's field grid, extracted verbatim so both editors share it. */
export function MatchRuleFields({
  sportKey,
  values,
  onChange,
  disabled = false,
  inherited,
  omit,
  lockedFields = [],
  state,
}: {
  sportKey: string;
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  disabled?: boolean;
  /** The config `values` fall back to where a field is blank — the division's
   *  for a stage's rules fragment, the saved config for division settings.
   *  Read for one thing only: whether the EFFECTIVE best-of is 1, in which case
   *  the grid shows one "Points to win" field that writes both points keys
   *  (owner ruling 2026-09-25 — see `visibleRuleFields`). */
  inherited?: Record<string, unknown>;
  /** Field keys another control stands in for (chess under Online play = Lichess: the clock picker). Their values
   *  stay in `values` and are still built on save — they are only not drawn. */
  omit?: readonly string[];
  /** W2c Task 20 (S4): the fields a started stage locks (`divisionLockedFields`, plus whatever a save has since refused).
   *  A locked field renders read-only with its lock line - said before the organiser types, not after Save. Matched by the
   *  field's own key or any engine key it edits (`lockLineFor`). Left out by the division builder, which has no stage yet. */
  lockedFields?: readonly RefusedField[];
  /** W2e Task 29: what the form knows before Save (`ruleFormState`) - the write doors' sentences beside the fields they are
   *  about, the fields the variant has no use for (not drawn), and the detail a switch holds (drawn disabled, with why).
   *  Absent: the grid is exactly what it was. */
  state?: RuleFormState;
}) {
  const msg = useMsg();
  const fields = visibleRuleFields(sportKey, values, inherited).filter((f) => !omit?.includes(f.key) && state?.hidden.has(f.key) !== true);
  if (fields.length === 0) return null;
  const edit = (key: string, raw: string) =>
    onChange(setRuleValue(sportKey, values, key, raw, inherited));
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {fields.map((field) => {
        const lock = lockLineFor(field.key, lockedFields, field.edits);
        const heldBy = state?.held.get(field.key);
        const problems = state?.invalid.get(field.key);
        return (
          // An ordered list needs the row's width; a number or a picker sits in a column.
          <div
            key={field.key}
            data-testid={`rule-field-${field.key}`}
            data-held={heldBy === undefined ? undefined : "true"}
            className={field.kind === "sequence" ? "sm:col-span-3" : undefined}
          >
            <RuleFieldControl
              sportKey={sportKey}
              field={field}
              value={values[field.key] ?? ""}
              onEdit={(raw) => edit(field.key, raw)}
              disabled={disabled || lock !== undefined || heldBy !== undefined}
              inherited={inherited}
              problem={problems === undefined ? undefined : { text: problems.map((message) => configIssueText({ path: [], message }, msg)).join(" "), idScope: "division" }}
            />
            {heldBy !== undefined && (
              <p className="mt-1 text-[11px] leading-snug text-slate-700" data-testid={`rule-field-off-${field.key}`}>
                {msg("stageRules.detail.off", { decider: msg(heldBy) })}
              </p>
            )}
            {lock !== undefined && (
              <p className="mt-1 text-[11px] leading-snug text-slate-700" data-testid={`division-locked-${field.key}`}>
                <span aria-hidden="true">🔒 </span>
                {lockSentence(lock, msg)}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
