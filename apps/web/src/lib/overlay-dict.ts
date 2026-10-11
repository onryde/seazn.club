// The public dictionary slice the console's stream panel ships to its client island (`overlayDict`), so the overlay
// PREVIEW reads the same words as the `/overlay` page, which holds the whole public namespace. `getDictionary` is
// server-only, so the island cannot load it; the slice keeps the flight small. One function, shared by the loader
// (server/stream-panel-context.ts) and the preview's render test — never a retyped prefix list.
//
// W2b T13 re-review N-1: the overlay's own `overlay.*` words AND every key the stage's forfeit copy reads
// (`forfeitCopyOf` → the tag and sentence keys). With `overlay.*` alone the preview put the raw key
// "forfeit.sentence.walkover" on air.
import { FORFEIT_SENTENCE_KEYS, FORFEIT_TAG_KEYS } from "@/lib/forfeit-tag";

const FORFEIT_COPY_KEYS: ReadonlySet<string> = new Set<string>([...FORFEIT_TAG_KEYS, ...FORFEIT_SENTENCE_KEYS]);

export function overlayDictOf(dict: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(dict).filter(([k]) => k.startsWith("overlay.") || FORFEIT_COPY_KEYS.has(k)));
}
