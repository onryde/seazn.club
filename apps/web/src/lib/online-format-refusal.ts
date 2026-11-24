// Online Chess runs Swiss and knockout events (spec 2026-11-23-online-chess-credits-design.md §3 decision 9, §8.1; P16). The organiser's
// screens read this rule to grey the Lichess option on a format that holds a league, group or ladder stage, and the format cards of an
// online division. The AUTHORITY is the leaf's allowed list (`ONLINE_ALLOWED_STAGE_KINDS`), the very list the server's stage door asks
// (`assertOnlineFormat`): a kind nobody listed is refused, so a format added later runs online only when somebody says so.
import { STAGE_TEMPLATES } from "@/lib/format-templates";
import { ONLINE_ALLOWED_STAGE_KINDS } from "@/lib/online-chess-package";

/** The first of `kinds` (in the order given) that Online Chess does not run, or null. An empty list has no format to refuse. */
export function onlineRefusedKind(kinds: readonly string[]): string | null {
  return kinds.find((k) => !ONLINE_ALLOWED_STAGE_KINDS.includes(k)) ?? null;
}

/** The knobs a template is built at when only its stage KINDS are read: the kinds do not depend on the knobs. */
const KIND_PROBE_KNOBS = { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 } as const;

/** Whether the format card `key` builds a stage Online Chess does not run. An unknown key is not refused: there is nothing to judge. */
export function templateRefusedOnline(key: string): boolean {
  const t = STAGE_TEMPLATES.find((x) => x.key === key);
  return t !== undefined && onlineRefusedKind(t.build(KIND_PROBE_KNOBS).map((s) => s.kind)) !== null;
}
