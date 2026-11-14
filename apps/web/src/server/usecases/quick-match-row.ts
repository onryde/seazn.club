import "server-only";
// Quick match plan 5, Task 5 (plan docs/superpowers/plans/2026-11-13-quick-match-5-league-knockout.md): a quick match's row
// and the count of its matches, the two facts every quick match usecase reads, BELOW the home read
// (`quick-match-home.ts`, which re-exports every name here unchanged).
//
// Moved verbatim out of quick-match-home.ts so the League + Knockout advance (`quick-match-advance.ts`) can read the row and
// the count without importing the home, and the home can import the advance's cut (`loadLeagueCut`) without a cycle: one
// direction only, home → advance → this module.
import { withTenant } from "@/lib/db";
import { SETTLED_FIXTURE_STATUSES } from "@/lib/fixture-status";
import { toLocale, type Locale } from "@/lib/i18n-constants";
import { QUICK_MATCH_SYSTEM_ORG_ID } from "@/lib/quick-match-constants";
import type { QuickMatchCounts } from "@/lib/quick-match-finished";
import { isBye, type MatchLineRow } from "@/lib/run-sheet-groups";
import type { QuickMatchFormat } from "./quick-match-preview";

const SYSTEM_ORG = QUICK_MATCH_SYSTEM_ORG_ID;

export interface QuickMatchRow {
  id: string;
  competitionId: string;
  name: string;
  format: QuickMatchFormat;
  email: string | null;
  locale: Locale;
  lastActivityAt: Date;
  /** null on a saved row (§7.7): alive, never expiring. */
  expiresAt: Date | null;
  savedByUserId: string | null;
  /** The home token's sealed envelope (C19): `openHomeToken` rebuilds the page link from it. */
  tokenEnc: Uint8Array;
}

export interface QuickMatchDbRow {
  id: string;
  competition_id: string;
  name: string;
  format: QuickMatchFormat;   // V517's check constraint: 'league' | 'knockout' | 'league_knockout'
  email: string | null;
  locale: string;
  last_activity_at: Date;
  expires_at: Date | null;
  saved_by_user_id: string | null;
  token_enc: Uint8Array;
}

/** A `quick_matches` row as the app reads it. Exported for its pure test (the locale fallback below). */
export const toRow = (r: QuickMatchDbRow): QuickMatchRow => ({
  id: r.id,
  competitionId: r.competition_id,
  name: r.name,
  format: r.format,
  email: r.email,
  // A locale the app does not speak reads as the default, never as a broken page. V515's check constraint keeps such a
  // value out of the column; this stays as defence in depth (a locale dropped later would leave old rows behind it).
  locale: toLocale(r.locale),
  lastActivityAt: r.last_activity_at,
  expiresAt: r.expires_at,
  savedByUserId: r.saved_by_user_id,
  tokenEnc: r.token_enc,
});

/** A match marked Not played (plan 4 D1): the skip writes `cancelled`, and no other quick match path does. The count and
 *  the phase read this one predicate. */
export const isNotPlayed = (f: { status: string }): boolean => f.status === "cancelled";

/** A quick match's "{played} of {count}" (plan 2 Task 5, B7d): its matches are its non-bye fixtures (`isBye`, the shared
 *  predicate, never re-derived), the played ones are those whose status is settled (SETTLED_FIXTURE_STATUSES), and the Not
 *  played ones (plan 4) are counted beside them, never out of the total (§6: "N of M played · K not played", M the full
 *  total). The home, the Continue card, the account list and /admin read this one count. */
export function playedOf(rows: readonly MatchLineRow[]): QuickMatchCounts {
  const matches = rows.filter((r) => !isBye(r));
  return {
    played: matches.filter((r) => SETTLED_FIXTURE_STATUSES.has(r.status)).length,
    notPlayed: matches.filter(isNotPlayed).length,
    total: matches.length,
  };
}

/**
 * The quick match whose competition this is, or null for any other competition — whatever its expiry: the row stands
 * until the sweep deletes it (plan 3), and a score re-arms it (D5). The pad's way back to the home (Task 9).
 */
export async function findQuickMatchByCompetition(competitionId: string): Promise<QuickMatchRow | null> {
  const [row] = await withTenant(SYSTEM_ORG, (tx) => tx<QuickMatchDbRow[]>`
    select id, competition_id, name, format, email, locale, last_activity_at, expires_at, saved_by_user_id, token_enc
    from quick_matches
    where competition_id = ${competitionId}`);
  return row ? toRow(row) : null;
}
