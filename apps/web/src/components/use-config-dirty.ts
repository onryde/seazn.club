"use client";

// B7 T23 (spec §9.3) — "would Save change anything, and where?" for the division settings page.
//
// `saved` is what the server holds as far as this editor knows: the values it loaded, moved forward by each request that
// landed (useRegistrationConfigPanelState owns that snapshot). `draft` is what the organiser sees. Both are compared in the
// form the save SENDS — the PATCH and PUT bodies, built by the same `toDivisionPatchBody`/`toRegistrationSettingsPutBody` the
// save calls — so the field set is the save's own, never a second list to keep in step. Those two builders are projections
// (each field passes through unchanged); the normalising happens here, per field, and asks only "would the stored value
// differ?":
//
// - a value is compared as the JSON the request carries, with object keys in any order. The sign-up form builder hands back a
//   new array of new objects on every keystroke, and may leave `options: undefined` behind, which JSON drops — so a question
//   relabelled and relabelled back is the same question.
// - the four clock fields are instants. The editor re-derives one through `toISOString()` ("…00.000Z"), and a stored value may
//   be spelled differently ("…00Z"); the column is a timestamptz, so two spellings of one instant store the same thing.
//
// A field edited back to its saved value is therefore clean, and the count is of FIELDS (what "{n} unsaved changes" says),
// with each section listed once, in the page's own section order. A clock half-typed (date picked, time blank) never reaches
// the draft, so the caller names it in `pending`, and it counts too.
import { useMemo } from "react";
import {
  toDivisionPatchBody,
  toRegistrationSettingsPutBody,
  type RegistrationConfigState,
} from "@/components/registration-hub-config-state";
import { SECTION_IDS, sectionForField, type SectionId } from "@/components/registration-hub-config-panel-sections";
import type { ConfigFieldKey } from "@/components/registration-hub-save-error";

export interface ConfigDirty {
  dirty: boolean;
  /** Fields that differ from the saved values. */
  count: number;
  /** The sections holding them, each once, in SECTION_IDS order. */
  sections: SectionId[];
}

/** The fields whose value is a point in time, compared as one. */
const INSTANT_FIELDS: ReadonlySet<string> = new Set<keyof RegistrationConfigState>([
  "opens_at",
  "closes_at",
  "refund_lock_at",
  "place_by_at",
]);

function sentBy(state: RegistrationConfigState): Record<string, unknown> {
  return { ...toDivisionPatchBody(state), ...toRegistrationSettingsPutBody(state) };
}

/** JSON as the request would carry it, with object keys sorted so key order never reads as a change. */
function wire(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

function sameStoredValue(field: string, a: unknown, b: unknown): boolean {
  if (INSTANT_FIELDS.has(field) && typeof a === "string" && typeof b === "string") {
    const at = Date.parse(a);
    const bt = Date.parse(b);
    if (!Number.isNaN(at) && !Number.isNaN(bt)) return at === bt;
  }
  return wire(a) === wire(b);
}

/**
 * Clean until both sides exist: a draft with nothing saved beside it is a load in flight, not "everything changed".
 *
 * `pending`: fields with an edit in progress that the draft does not hold yet — a clock with its date picked and its time
 * still blank, which the panel keeps out of the state until both halves are there (registration-hub-tz-input.ts). Save
 * refuses such a field, so it is unsaved whatever the draft says: each one counts, once, in its own section, even when the
 * draft's value for it happens to equal the saved one.
 */
export function configDirty(
  saved: RegistrationConfigState | null,
  draft: RegistrationConfigState | null,
  pending: readonly ConfigFieldKey[] = [],
): ConfigDirty {
  if (!saved || !draft) return { dirty: false, count: 0, sections: [] };
  const before = sentBy(saved);
  const after = sentBy(draft);
  const changed = new Set<string>(pending);
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!sameStoredValue(field, before[field], after[field])) changed.add(field);
  }
  const touched = new Set<SectionId>();
  for (const field of changed) {
    const section = sectionForField(field as ConfigFieldKey);
    // Every field the save sends is in SECTION_FIELDS (registration-hub-config-panel-sections.ts, and the sweep in
    // registration-hub-config-panel.test.ts, which reads the section off the rendered page). One that is not would be an edit
    // counted nowhere a person can find it: refuse loudly.
    if (!section) throw new Error(`configDirty: "${field}" is saved but belongs to no section in SECTION_FIELDS`);
    touched.add(section);
  }
  const count = changed.size;
  return { dirty: count > 0, count, sections: SECTION_IDS.filter((id) => touched.has(id)) };
}

/** Rebuilt from the summary itself, so the memo is keyed on nothing but the summary. */
function fromSummary(summary: string): ConfigDirty {
  const [count, list] = summary.split("|");
  const n = Number(count);
  return { dirty: n > 0, count: n, sections: list ? (list.split(",") as SectionId[]) : [] };
}

/**
 * `configDirty`, with an identity that holds while the answer does: a second keystroke in a field that is already changed
 * hands back the same object, so a caller can key an effect (the panel's `onDirtyChange` report) on it directly.
 */
export function useConfigDirty(
  saved: RegistrationConfigState | null,
  draft: RegistrationConfigState | null,
  pending: readonly ConfigFieldKey[] = [],
): ConfigDirty {
  const { count, sections } = configDirty(saved, draft, pending);
  const summary = `${count}|${sections.join(",")}`;
  return useMemo(() => fromSummary(summary), [summary]);
}
