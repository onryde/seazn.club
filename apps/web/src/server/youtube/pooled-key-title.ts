import "server-only";
// server/youtube/pooled-key-title.ts — the names Seazn gives the liveStreams it pools (its stream keys), as a matcher. The disconnect
// (disconnect.ts) lists the channel's own streams and deletes the ones named like this: a Seazn key that no row of ours records (an
// orphan - made at YouTube, then lost before Seazn pooled it) would otherwise stay in the club's Studio after it was told everything was
// deleted (stg, 2026-10-30). It deletes NOTHING else, so a club's own keys are safe: the match is the WHOLE title, never a part of it.
//
// Today's names come from the dictionaries - `streaming.youtube.streamKeyTitle` in every locale, rendered by `msgFor` exactly as growPool
// (prepare.ts) renders it, `{n}` being the pool slot - so a reworded or a new locale's name is matched with no change here. The names keys
// were given BEFORE today are history no dictionary still holds, and existing keys are never renamed, so each is kept below with where it
// came from.
import { LOCALES } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";

/** Every pooled key's name before 79a208d8b0 (2026-10-29: one name in every locale, prepare.ts's former `STREAM_TITLE`). */
const NAME_BEFORE_SLOTS = "Seazn stream key";
/** The fr name from 79a208d8b0 until a614ecf4fa (#1088) corrected "diffusión" to "diffusion" - as a dictionary template, `{n}` the slot. */
const FR_TEMPLATE_BEFORE_1088 = "Seazn Club · clé de diffusión {n}";

/** What stands in for the slot while a template is turned into a pattern: text no name contains. */
const SLOT = "<<seazn-pool-slot>>";
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A name with the slot marked -> a pattern for the WHOLE title, the slot being one or more digits. A name with no slot is itself. */
const wholeTitle = (marked: string): RegExp => new RegExp(`^${marked.split(SLOT).map(escape).join("[0-9]+")}$`);

const PATTERNS: readonly RegExp[] = [
  ...LOCALES.map((locale) => wholeTitle(msgFor(locale, "streaming.youtube.streamKeyTitle", { n: SLOT }))),
  wholeTitle(FR_TEMPLATE_BEFORE_1088.replace("{n}", SLOT)),
  wholeTitle(NAME_BEFORE_SLOTS),
];

/** Is this a name Seazn gives (or gave) a pooled stream key? The whole title, case and spacing as Seazn wrote it. */
export function isPooledKeyTitle(title: string): boolean {
  return typeof title === "string" && PATTERNS.some((p) => p.test(title));
}
