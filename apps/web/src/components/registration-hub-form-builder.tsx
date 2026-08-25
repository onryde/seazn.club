"use client";

// Registration hub config panel — sign-up form builder (RS004 W3c).
//
// Ported VERBATIM (task brief: "port it verbatim, do not redesign") from
// the pre-deletion apps/web/src/components/v2/registration-settings.tsx
// (`git show 850cc6308^:apps/web/src/components/v2/registration-settings.tsx`),
// FormBuilder :373-381, field rows :397-487 — bounded text/select/checkbox
// question builder (doc 16 §1.1). Only the import path changed; the JSX,
// class names, slugify logic and 12-field cap are byte-identical to the
// deleted component.
//
// The FormField shape is FROZEN (pre-deletion registrations-panel.tsx
// :26-32, `export interface FormField`) and mirrors the wire schema
// (`RegistrationFormField` in server/api-v1/schemas.ts) exactly — declared
// locally rather than imported from schemas.ts, which is DO-NOT-TOUCH for
// this task and carries value-level imports this client bundle has no
// business pulling in.
import { useMsg } from "@/components/i18n/dict-provider";

export interface FormField {
  key: string;
  label: string;
  kind: "text" | "select" | "checkbox";
  options?: string[];
  required: boolean;
}

export function FormBuilder({
  fields,
  canEdit,
  onChange,
}: {
  fields: FormField[];
  canEdit: boolean;
  onChange: (fields: FormField[]) => void;
}) {
  const msg = useMsg();
  function update(i: number, patch: Partial<FormField>) {
    onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  }

  function add() {
    // A blank label fails validation and blocks the whole save, so seed a
    // valid default the organiser can rename.
    //
    // Finding 2: `fields.length + 1` alone repeats a key once the array has
    // shrunk from a delete (add Q1/Q2, delete Q1, add again — length is back
    // to 1, minting "question_2" a second time). Start from the same
    // length-derived guess, but keep incrementing past any key already in
    // use — covers both the delete-then-add case and a coincidental
    // collision with a manually relabelled field's slugified key.
    const existing = new Set(fields.map((f) => f.key));
    let n = fields.length + 1;
    while (existing.has(`question_${n}`)) n++;
    onChange([
      ...fields,
      { key: `question_${n}`, label: msg("reg.form.questionN", { n }), kind: "text", required: false },
    ]);
  }

  // Lives inside a ~340px accordion column: every control gets the full row
  // (a shared row collapsed the label input to nothing), and the add button
  // sits full-width under the list where it can't crowd the intro copy.
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-400">{msg("reg.form.intro")}</p>
      {fields.length === 0 && <p className="text-xs text-slate-400">{msg("reg.form.examples")}</p>}
      {fields.map((f, i) => (
        <div key={i} className="space-y-2 rounded-md border border-slate-200 p-3">
          <label className="block text-xs text-slate-500">
            {msg("reg.form.label")}
            <input
              placeholder={msg("reg.form.labelPlaceholder")}
              disabled={!canEdit}
              value={f.label}
              onChange={(e) =>
                update(i, {
                  label: e.target.value,
                  key:
                    e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, "_")
                      .replace(/^_+|_+$/g, "")
                      .slice(0, 40) || f.key,
                })
              }
              className="input mt-1 w-full text-sm"
            />
          </label>
          {f.kind === "select" && (
            <input
              placeholder={msg("reg.form.options")}
              aria-label={msg("reg.form.optionsAria")}
              disabled={!canEdit}
              value={(f.options ?? []).join(", ")}
              onChange={(e) =>
                update(i, {
                  options: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              className="input w-full text-sm"
            />
          )}
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label={msg("reg.form.type")}
              disabled={!canEdit}
              value={f.kind}
              onChange={(e) =>
                update(i, {
                  kind: e.target.value as FormField["kind"],
                  options: e.target.value === "select" ? (f.options ?? [""]) : undefined,
                })
              }
              className="input min-w-0 flex-1 text-sm"
            >
              <option value="text">{msg("reg.form.type.text")}</option>
              <option value="select">{msg("reg.form.type.select")}</option>
              <option value="checkbox">{msg("reg.form.type.checkbox")}</option>
            </select>
            <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-slate-500">
              <input
                type="checkbox"
                disabled={!canEdit}
                checked={f.required}
                onChange={(e) => update(i, { required: e.target.checked })}
              />
              {msg("reg.form.required")}
            </label>
            {canEdit && (
              <button
                type="button"
                onClick={() => onChange(fields.filter((_, j) => j !== i))}
                className="ml-auto text-xs text-red-500 hover:underline"
              >
                {msg("reg.form.remove")}
              </button>
            )}
          </div>
        </div>
      ))}
      {canEdit && fields.length < 12 && (
        <button type="button" onClick={add} className="btn btn-ghost w-full text-xs">
          {msg("reg.form.add")}
        </button>
      )}
      <p className="text-[11px] text-slate-400">{msg("reg.form.saveNote")}</p>
    </div>
  );
}
