import "server-only";
// server/youtube/pooled-key-title.ts — the names Seazn gives the liveStreams it pools (its stream keys), as a matcher. The disconnect
// (disconnect.ts) lists the channel's own streams and deletes the ones named like this: a Seazn key that no row of ours records (an
// orphan - made at YouTube, then lost before Seazn pooled it) would otherwise stay in the club's Studio after it was told everything was
// deleted (stg, 2026-10-30). It deletes NOTHING else, so a club's own keys are safe: the match is the WHOLE title, never a part of it.
//
// A key keeps the name it was MADE with (YouTube never renames it, and neither do we), so the names to match are every name a key has
// ever been given, not just today's. They are the union of two sources:
//   - POOLED_KEY_TITLES_SHIPPED below: every name ever shipped, per locale, APPEND-ONLY. Rewording `streaming.youtube.streamKeyTitle`
//     in a dictionary fails pooled-key-title.test.ts until the new wording is added here, so the keys made under the old wording stay
//     matchable;
//   - the dictionaries' `streaming.youtube.streamKeyTitle`, rendered by `msgFor` exactly as growPool (prepare.ts) renders it.
// Every name contains "Seazn" (pinned by the test): without it a name would be a club's own key name, and the sweep would delete it.
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";

/** Every name a pooled key has been given, per locale, as shipped - `{n}` is the pool slot. APPEND-ONLY: never edit or drop an entry.
 *  - "Seazn stream key": every key in every locale, bdf12da878 (2026-10-28) until 79a208d8b0 (prepare.ts's `STREAM_TITLE`);
 *  - the `streamKeyTitle` dictionary values from 79a208d8b0 (2026-10-29) on, including the fr "diffusión" that a614ecf4fa (#1088)
 *    corrected to "diffusion" (2026-10-30). */
export const POOLED_KEY_TITLES_SHIPPED = {
  en: ["Seazn stream key", "Seazn Club · stream key {n}"],
  fr: ["Seazn stream key", "Seazn Club · clé de diffusión {n}", "Seazn Club · clé de diffusion {n}"],
  es: ["Seazn stream key", "Seazn Club · clave de emisión {n}"],
  nl: ["Seazn stream key", "Seazn Club · streamsleutel {n}"],
} as const satisfies Record<Locale, readonly string[]>;

/** What stands in for the slot while a name is turned into a pattern: text no name contains. */
const SLOT = "<<seazn-pool-slot>>";
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A name with the slot marked -> a pattern for the WHOLE title, the slot being one or more digits. A name with no slot is itself. */
const wholeTitle = (marked: string): RegExp => new RegExp(`^${marked.split(SLOT).map(escape).join("[0-9]+")}$`);

const MARKED: ReadonlySet<string> = new Set([
  ...LOCALES.flatMap((locale) => POOLED_KEY_TITLES_SHIPPED[locale].map((t) => t.replaceAll("{n}", SLOT))),
  ...LOCALES.map((locale) => msgFor(locale, "streaming.youtube.streamKeyTitle", { n: SLOT })),
]);
const PATTERNS: readonly RegExp[] = [...MARKED].map(wholeTitle);

/** Is this a name Seazn gives (or gave) a pooled stream key? The whole title, case and spacing as Seazn wrote it. */
export function isPooledKeyTitle(title: string): boolean {
  return typeof title === "string" && PATTERNS.some((p) => p.test(title));
}
