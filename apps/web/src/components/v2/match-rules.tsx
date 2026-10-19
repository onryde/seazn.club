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
import { setRuleValue, visibleRuleFields } from "@/lib/match-rules";
import { RuleFieldControl } from "@/components/v2/stage-rules/rule-field-control";

export type { RuleField } from "@/lib/match-rules";
export {
  SPORT_RULES,
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
}) {
  const fields = visibleRuleFields(sportKey, values, inherited).filter((f) => !omit?.includes(f.key));
  if (fields.length === 0) return null;
  const edit = (key: string, raw: string) =>
    onChange(setRuleValue(sportKey, values, key, raw, inherited));
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {fields.map((field) => (
        // An ordered list needs the row's width; a number or a picker sits in a column.
        <div key={field.key} className={field.kind === "sequence" ? "sm:col-span-3" : undefined}>
          <RuleFieldControl
            sportKey={sportKey}
            field={field}
            value={values[field.key] ?? ""}
            onEdit={(raw) => edit(field.key, raw)}
            disabled={disabled}
            inherited={inherited}
          />
        </div>
      ))}
    </div>
  );
}
