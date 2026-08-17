"use client";

// The ONE chip input in the repo (P8/D5a) — free-form, org-scoped tag slugs,
// no registry, no server-side validation (design doc, "Tag semantics": tags
// are lowercase slugs, dedupe is the only normalisation). Two call sites need
// identical normalise/dedupe/suggest behaviour — a court's own tags
// (components/v2/venues-panel.tsx) and a division's required-court-tags
// (components/v2/division-settings.tsx) — so it lives here once instead of
// twice; the P8 design doc names this exact duplication as "the defect shape
// this programme has found repeatedly."
//
// Deliberately copy-free: `label`/`placeholder`/`addLabel`/`removeLabelFor`/
// `suggestionsLabel` are all rendered strings, not message keys, the same
// choice `DateTimeField` makes and for the same reason — every caller already
// has a `useMsg()` bound to its own DictProvider, and this component would
// otherwise need one of its own for no benefit.
import { useState, type KeyboardEvent } from "react";

/** Trim + lowercase — the same rule the server applies (`normalizeTags`,
 *  server/usecases/venues.ts) so a chip renders in its final form before it
 *  is ever sent. Reimplemented here rather than imported: that module starts
 *  with `import "server-only"` and would break the client bundle. */
export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Normalise, drop empty, dedupe against what is already chosen. Order is
 *  preserved and the new tag is appended — never reordered — so a chip never
 *  jumps around the list the moment it is added. */
export function addTag(tags: readonly string[], raw: string): string[] {
  const next = normalizeTag(raw);
  if (!next || tags.includes(next)) return [...tags];
  return [...tags, next];
}

export function removeTag(tags: readonly string[], tag: string): string[] {
  return tags.filter((t) => t !== tag);
}

export interface TagChipInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  /** Already ranked (most-used first) — see `rankTagsByCount` in
   *  venues-panel.tsx. Tags already chosen, and (while typing) tags that
   *  don't match the draft, are filtered out here — the caller does not need
   *  to pre-filter. */
  suggestions?: string[];
  disabled?: boolean;
  label: string;
  placeholder?: string;
  addLabel: string;
  removeLabelFor: (tag: string) => string;
  suggestionsLabel?: string;
}

export function TagChipInput({
  value,
  onChange,
  suggestions = [],
  disabled,
  label,
  placeholder,
  addLabel,
  removeLabelFor,
  suggestionsLabel,
}: TagChipInputProps) {
  const [draft, setDraft] = useState("");

  const commit = () => {
    if (!draft.trim()) return;
    onChange(addTag(value, draft));
    setDraft("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Comma-separated entry is common when pasting a short list of tags —
    // treat it the same as Enter rather than letting a literal comma into
    // the stored slug.
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    }
  };

  const normalizedDraft = normalizeTag(draft);
  const offeredSuggestions = suggestions
    .filter((s) => !value.includes(s))
    .filter((s) => !normalizedDraft || s.includes(normalizedDraft))
    .slice(0, 8);

  return (
    <fieldset className="min-w-0 space-y-1.5 [min-inline-size:0]" disabled={disabled}>
      <legend className="label">{label}</legend>

      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((tag) => (
            <li key={tag} className="chip inline-flex items-center gap-1 lowercase">
              {tag}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onChange(removeTag(value, tag))}
                  aria-label={removeLabelFor(tag)}
                  className="rounded-full leading-none text-purple-500 hover:text-purple-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300"
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!disabled && (
        <div className="flex gap-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            aria-label={placeholder ?? label}
            className="input"
          />
          <button
            type="button"
            disabled={!draft.trim()}
            onClick={commit}
            className="btn btn-ghost shrink-0 px-3 py-2 text-xs"
          >
            {addLabel}
          </button>
        </div>
      )}

      {!disabled && offeredSuggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {suggestionsLabel && <span className="text-[11px] text-slate-400">{suggestionsLabel}</span>}
          {offeredSuggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onChange(addTag(value, s))}
              className="rounded-full border border-dashed border-slate-300 px-2.5 py-0.5 text-xs lowercase text-slate-500 transition hover:border-purple-300 hover:text-purple-700"
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </fieldset>
  );
}
