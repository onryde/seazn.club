// W2c Task 19 (X-SR-2, S4) - the tags a run-sheet row carries beside its names. Client-safe and pure, so the decision has
// unit killers (`__tests__/run-sheet-tags.test.ts`); `run-sheet-row.tsx` renders what this answers.
import type { MessageKey } from "@/lib/messages";

/**
 * The "Format changed" chip's dictionary key, or null. A match is tagged exactly when it carries its OWN format
 * (`fixtures.rules_override is not null`, read by `listDivisionFixtures` as `format_changed`): one that plays its stage's
 * rules - never overridden, or set back with "Use stage rules" - carries no tag. Strict `=== true`: the wire column is a
 * boolean, and an absent or null value (a hand-built row, an older caller) is "not changed", never "changed".
 * The return type names the key through `MessageKey`, so a key the dictionaries lack is a compile error here.
 */
export function formatChangedTag(row: { format_changed?: boolean | null }): Extract<MessageKey, "runSheet.formatChanged"> | null {
  return row.format_changed === true ? "runSheet.formatChanged" : null;
}
