// Spectator surface W2, Task 14 — the wire shape of the public player page's
// match lines: what `GET /api/v1/public/orgs/{orgSlug}/competitions/{slug}/
// players/{personId}/matches` returns and what the page's client island polls.
//
// Zod only, no `server-only` and no `@/` imports, for the two readers that
// cannot take the reader module itself: `server/api-v1/openapi.ts` (loaded by
// `scripts/openapi-gen.ts` under `--experimental-strip-types`) and the client
// island, which imports TYPES from here and never from `@/server/**` code that
// pulls a database client into the browser bundle.
//
// ONE SHAPE, TWO DECLARATIONS. `PlayerMatchLine` (public-player-matches.ts) is
// the authority; this restates it for the spec. The usecase test pins the two
// equal with `expectTypeOf`, so tsc fails the moment either side moves alone.
import { z } from "zod";

export const PlayerMatchLineSchema = z.object({
  fixtureId: z.string(),
  /** The fixture's public match centre. */
  href: z.string(),
  divisionName: z.string(),
  divisionSlug: z.string(),
  /** ISO instant, or null when the division has not released its schedule. */
  scheduledAt: z.string().nullable(),
  /** The venue's IANA zone, for formatting `scheduledAt`. */
  tz: z.string(),
  /** Already consent-masked by the reader. */
  opponentName: z.string(),
  /** Pre-formatted figures in the org's locale; "—" when there are none. */
  line: z.string(),
  result: z.enum(["won", "lost", "drawn", "live"]).nullable(),
});
export type PlayerMatchLineT = z.infer<typeof PlayerMatchLineSchema>;

export const PublicPlayerMatches = z.object({
  /** Newest first — the reader's order, never re-sorted by a consumer. */
  matches: z.array(PlayerMatchLineSchema),
  /** When this document was built. The page's "Updated Ns ago" line counts
   *  from here — the document's own clock, never the fetch's (W1's ruling,
   *  `use-live-competition.ts`), and a poll never replaces a newer document
   *  with an older one. */
  generatedAt: z.string(),
});
export type PublicPlayerMatchesT = z.infer<typeof PublicPlayerMatches>;
