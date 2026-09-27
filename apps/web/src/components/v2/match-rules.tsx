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
import { ruleOptionLabel, setRuleValue, visibleRuleFields } from "@/lib/match-rules";

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
  inherited,
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
}) {
  const msg = useMsg();
  const fields = visibleRuleFields(sportKey, values, inherited);
  if (fields.length === 0) return null;
  const edit = (key: string, raw: string) =>
    onChange(setRuleValue(sportKey, values, key, raw, inherited));
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
              onChange={(e) => edit(field.key, e.target.value)}
              placeholder={inheritedPlaceholder(msg("rules.default"), inherited?.[field.key])}
              className="input"
            />
          ) : (
            <select
              disabled={disabled}
              value={values[field.key] ?? ""}
              onChange={(e) => edit(field.key, e.target.value)}
              className="select"
            >
              <option value="">{msg("rules.default")}</option>
              {/* D9 (owner ruling 2026-09-18) — a SAVED value this select
                  cannot offer must be shown, not swallowed. Badminton's
                  `bestOf` offers [1,3,5] while `{"bestOf":7}` is a perfectly
                  valid saved config, and without this option the browser has
                  nothing to land on and falls back to "Default" — telling the
                  organiser the field is unset over a config that really
                  carries a value. That misreading is one tap from data loss on
                  the stage panel, whose PUT is a FRAGMENT where an omitted key
                  means INHERIT.

                  Labelled through `ruleOptionLabel` — the SAME lookup the
                  stage card's summary line uses. This option shipped as a
                  bare value, so the open dropdown read
                  `Default · 5 · Best of 1 · Best of 3` directly under a
                  summary line saying "Best of 5": one value, two labels, one
                  screen. (That case was `bestOf: 5` against a picker offering
                  [1,3]; the owner widened badminton to [1,3,5] on 2026-09-20,
                  so 5 is now a real option and this branch no longer fires for
                  it.) Falls back to the raw value when NO sport declares one —
                  inventing copy for a value the table does not declare would
                  be a second lie. */}
              {unofferable && (
                <option value={current}>
                  {ruleOptionLabel(sportKey, field.key, current) ?? current}
                </option>
              )}
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

/**
 * What a BLANK number field says it falls back to. "Default" alone hid the
 * number: on a best-of-1 volleyball stage the single "Points to win" field
 * read "Default" while the match plays to the division's deciding set, 15 —
 * not the 25 an organiser would guess. Where the editor is told what a blank
 * inherits (`inherited`: the stage editor's division config, the settings
 * editor's variant), the placeholder names it; where it is not (the builder),
 * it stays "Default" rather than invent one.
 */
export function inheritedPlaceholder(defaultWord: string, inheritedValue: unknown): string {
  return typeof inheritedValue === "number" && Number.isFinite(inheritedValue)
    ? `${defaultWord} (${inheritedValue})`
    : defaultWord;
}
