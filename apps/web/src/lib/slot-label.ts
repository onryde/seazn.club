// Slot-label resolver (P6/D4b, task A1). `fixtures.home_slot_label` /
// `away_slot_label` (V360) carry `SlotLabel | null` — an i18n pattern ref
// (`{key, params}`, produced by `descriptorLabel()` in
// server/usecases/stage-seeding.ts) while the matching `*_entrant_id` is
// still null. This is the ONE place that turns that value into display
// text — every renderer (client island via useMsg(), server component via
// msgFor()) goes through it instead of hand-building a string, so the
// null → "TBD" fallback and the {key,params} → string substitution each
// exist exactly once.
//
// `lookup` is intentionally just a callback, not an import of useMsg()/
// msgFor() — msgFor pulls in `server-only`, so importing it directly here
// would break every client caller. `fallbackKey` is supplied by the call
// site (not defaulted) because several surfaces already had their own
// localized "TBD" key before this module existed (schedule.tbd,
// bracket.tbd, me.tbd, …) with slightly different translations per
// surface; the resolver reuses whichever one already fit rather than
// inventing a new canonical string.
import type { MessageKey } from "@/lib/messages";
import type { SlotLabel } from "@/server/usecases/stage-seeding";

export type SlotLabelLookup = (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

/** `SlotLabel | null` → display string. Never builds text itself — every
 *  character returned comes from `lookup`'s dictionary, so there is no
 *  concatenation path to audit. */
export function resolveSlotLabel(
  label: SlotLabel | null,
  lookup: SlotLabelLookup,
  fallbackKey: MessageKey,
): string {
  if (!label) return lookup(fallbackKey);
  const vars: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(label.params)) {
    vars[k] = typeof v === "number" ? v : String(v);
  }
  return lookup(label.key as MessageKey, vars);
}
