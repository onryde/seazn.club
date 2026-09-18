"use client";

// Match rules — the CLIENT half: the shared field grid rendered by the
// division builder and the division Settings tab (v8), so the two format
// editors can't drift. The table itself (RuleField, SPORT_RULES,
// buildRuleOverride, hydrateRuleValues, configKeysFor, STAGE_RULES_SPORTS)
// moved to `@/lib/match-rules` — directive-free and JSX-free — so the SERVER
// can import it by value; design 2026-09-17 §T0. It is re-exported below so
// existing importers keep working unchanged.
// Field labels/options are sport-rules vocabulary, kept canonical/English
// like sport + format names; only the picker chrome (Default / On / Off)
// localizes, and that chrome is what lives here.
import { useMsg } from "@/components/i18n/dict-provider";
import { SPORT_RULES } from "@/lib/match-rules";

export type { RuleField } from "@/lib/match-rules";
export {
  SPORT_RULES,
  buildRuleOverride,
  hydrateRuleValues,
  configKeysFor,
  STAGE_RULES_SPORTS,
} from "@/lib/match-rules";

/** The builder's field grid, extracted verbatim so both editors share it. */
export function MatchRuleFields({
  sportKey,
  values,
  onChange,
  disabled = false,
}: {
  sportKey: string;
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  disabled?: boolean;
}) {
  const msg = useMsg();
  const fields = SPORT_RULES[sportKey] ?? [];
  if (fields.length === 0) return null;
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {fields.map((field) => {
        const current = values[field.key] ?? "";
        const offered =
          field.kind === "bool" ? ["on", "off"] : (field.options ?? []).map((o) => o.value);
        const unofferable = current !== "" && !offered.includes(current);
        return (
          <label key={field.key} className="block">
            <span className="label">{field.label}</span>
          {field.kind === "number" ? (
            <input
              type="number"
              min={field.min}
              max={field.max}
              disabled={disabled}
              value={values[field.key] ?? ""}
              onChange={(e) => onChange({ ...values, [field.key]: e.target.value })}
              placeholder={msg("rules.default")}
              className="input"
            />
          ) : (
            <select
              disabled={disabled}
              value={values[field.key] ?? ""}
              onChange={(e) => onChange({ ...values, [field.key]: e.target.value })}
              className="select"
            >
              <option value="">{msg("rules.default")}</option>
              {/* D9 (owner ruling 2026-09-18) — a SAVED value this select
                  cannot offer must be shown, not swallowed. Badminton's
                  `bestOf` offers [1,3] while `{"bestOf":5}` is a perfectly
                  valid saved config, and without this option the browser has
                  nothing to land on and falls back to "Default" — telling the
                  organiser the field is unset over a config that really
                  carries a value. That misreading is one tap from data loss on
                  the stage panel, whose PUT is a FRAGMENT where an omitted key
                  means INHERIT. Labelled from the raw value: there is no
                  declared label for a value the table does not declare, and
                  inventing one would be a second lie. */}
              {unofferable && <option value={current}>{current}</option>}
              {field.kind === "bool" ? (
                <>
                  <option value="on">{msg("rules.on")}</option>
                  <option value="off">{msg("rules.off")}</option>
                </>
              ) : (
                (field.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))
              )}
            </select>
          )}
          {field.help && (
            /* R3.5/Task P — was text-slate-400 (2.63:1 on the .card this
               span renders inside at both call sites, under the WCAG AA
               4.5:1 floor); text-slate-600 clears 7.58:1. Task I's
               shootoutWin/shootoutLoss help text renders through here. */
            <span className="mt-0.5 block text-[11px] text-slate-600">{field.help}</span>
            )}
          </label>
        );
      })}
    </div>
  );
}
