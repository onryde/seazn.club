// Pure, client-safe dictionary subsetting. `lib/i18n.ts` is server-only, so the
// helper lives here and takes the loaded dict as an argument — a public page can
// then ship just the keys it renders instead of the whole 196KB ui.json.
import type { Dict } from "@/lib/i18n-constants";

/** Keys of `dict` (flat dotted-key JSON) that START with any of `prefixes`.
 *  Prefixes are matched literally, so pass the trailing dot: `"board.ai."`. */
export function pickDictPrefixes(dict: Dict, prefixes: readonly string[]): Dict {
  return Object.fromEntries(
    Object.entries(dict).filter(([k]) => prefixes.some((p) => k.startsWith(p))),
  );
}
