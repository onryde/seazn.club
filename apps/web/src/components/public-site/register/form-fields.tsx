"use client";
// RS006 Step 3 — custom form_fields renderer (design §4 step 3). Ported
// from the recovered pre-redesign renderer (git history 76ef7987b:
// apps/web/src/components/public-site/register-form.tsx:394-430) — same
// three-way switch on `kind` (checkbox / select / text), same "*" suffix
// for a required label. `f.label`/`f.options` are organiser-authored
// content, not app copy — rendered as-is, same as a division's own `name`
// elsewhere in this tree; no i18n owed (AGENTS.md's i18n rule covers
// strings THIS app authors, not user/organiser-entered content).
import { useT } from "@/components/i18n/dict-provider";
import { FIELD, FIELD_LABEL as LABEL } from "./styles";
import type { FormFieldDef } from "./types";

export function FormFields({
  fields,
  answers,
  onChange,
}: {
  fields: readonly FormFieldDef[];
  answers: Record<string, string | boolean>;
  onChange: (key: string, value: string | boolean) => void;
}) {
  const t = useT();
  if (fields.length === 0) return null;

  return (
    <div className="space-y-3">
      <h4 className="font-display text-xs font-semibold uppercase tracking-wider text-ink-muted">
        {t("register.section.questions")}
      </h4>
      {fields.map((f) => {
        const fieldId = `reg-field-${f.key}`;
        if (f.kind === "checkbox") {
          return (
            <label key={f.key} className="flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                checked={answers[f.key] === true}
                onChange={(e) => onChange(f.key, e.target.checked)}
              />
              <span>
                {f.label} {f.required ? "*" : ""}
              </span>
            </label>
          );
        }
        return (
          <div key={f.key}>
            <label className={LABEL} htmlFor={fieldId}>
              {f.label} {f.required ? "*" : ""}
            </label>
            {f.kind === "select" ? (
              <select
                id={fieldId}
                className={`${FIELD} min-w-0`}
                value={(answers[f.key] as string) ?? ""}
                onChange={(e) => onChange(f.key, e.target.value)}
              >
                <option value="" disabled>
                  {f.label}
                </option>
                {(f.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={fieldId}
                type="text"
                maxLength={1000}
                className={`${FIELD} min-w-0`}
                value={(answers[f.key] as string) ?? ""}
                onChange={(e) => onChange(f.key, e.target.value)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
