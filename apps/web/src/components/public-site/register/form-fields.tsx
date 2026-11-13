"use client";
// RS006 Step 3 — custom form_fields renderer (design §4 step 3). Ported
// from the recovered pre-redesign renderer (git history 76ef7987b:
// apps/web/src/components/public-site/register-form.tsx:394-430) — same
// three-way switch on `kind` (checkbox / select / text), same "*" suffix
// for a required label. `f.label`/`f.options` are organiser-authored
// content, not app copy — rendered as-is, same as a division's own `name`
// elsewhere in this tree; no i18n owed (AGENTS.md's i18n rule covers
// strings THIS app authors, not user/organiser-entered content).
//
// B2 T9 (spec 7.3): the block is headed "Questions from {org}", and a question the person may skip carries an "Optional" tag; a required
// one carries none and keeps its "*". The tag follows the label's text inside the same <label>, so it is part of the control's name.
import { useT } from "@/components/i18n/dict-provider";
import { FIELD, FIELD_LABEL as LABEL, TAG_NEUTRAL } from "./styles";
import type { FormFieldDef } from "./types";

export function FormFields({
  fields,
  answers,
  onChange,
  entryId,
  orgName,
}: {
  fields: readonly FormFieldDef[];
  answers: Record<string, string | boolean>;
  onChange: (key: string, value: string | boolean) => void;
  /** Scopes each field's DOM id to the cart entry rendering it (review
   *  finding #1, MEDIUM). Two cart entries on the SAME division is a
   *  normal, unrestricted case (e.g. two teams in one "Open" division) —
   *  each renders that division's form_fields, and an unscoped
   *  `reg-field-${f.key}` collided across them: `label[for]` resolves to
   *  the FIRST matching id, so clicking the second entry's label focused
   *  the first entry's input. Same entry-scoping precedent as
   *  entry-details.tsx's `reg-self-index-${entry.id}`. */
  entryId: string;
  /** Who is asking: the organisation's name, for the heading. */
  orgName: string;
}) {
  const t = useT();
  if (fields.length === 0) return null;
  const optionalTag = (f: FormFieldDef) =>
    f.required ? null : <span className={`ml-2 ${TAG_NEUTRAL}`}>{t("register.field.optional")}</span>;

  return (
    <div className="space-y-3 border-t border-zinc-200 pt-4">
      <h4 className="font-display text-base font-semibold text-ink">{t("register.details.questionsFrom", { org: orgName })}</h4>
      {fields.map((f) => {
        const fieldId = `reg-field-${entryId}-${f.key}`;
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
                {optionalTag(f)}
              </span>
            </label>
          );
        }
        return (
          <div key={f.key}>
            <label className={LABEL} htmlFor={fieldId}>
              {f.label} {f.required ? "*" : ""}
              {optionalTag(f)}
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
