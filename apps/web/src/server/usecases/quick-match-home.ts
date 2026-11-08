import "server-only";
// Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.1 point 3, §7.4, §7.5, §7.10; plan 1
// Task 7; pre-flight B7, C9-C11): a home token to its quick match, and the quick match home's read.
//
// The home token is the guest's only credential (§7.4). It resolves to the `quick_matches` row, and through it to ONE
// competition. Every quick match lives in the one system org, so a system-org session is scoped by RLS to every guest's
// match at once: the per-match check (§7.1 point 3) is what keeps two strangers apart, and it runs FIRST — the division
// is looked up by the row's own competition before anything else is read, and a competition with no division (deleted)
// answers null.
//
// Nothing here computes a result. The table is the stored one (`getStandings`), the bracket is the fixture rows as the
// generator and the write path left them (winners already seated by `onDecided`, §7.10), and a bye is the shared
// predicate (`isBye`, lib/run-sheet-groups.ts), never re-derived.
import { withTenant } from "@/lib/db";
import { SETTLED_FIXTURE_STATUSES } from "@/lib/fixture-status";
import { toLocale, type Locale } from "@/lib/i18n-constants";
import { messages, type MessageKey } from "@/lib/messages";
import { systemAuth } from "@/lib/quick-match-auth";
import { QUICK_MATCH_SYSTEM_ORG_ID } from "@/lib/quick-match-constants";
import { isBye } from "@/lib/run-sheet-groups";
import { variantWordKey } from "@/lib/variant-label-keys";
import type { EntrantKind } from "@seazn/engine/sport";
import { PLAIN_LAYOUT, type TableLayout } from "@seazn/engine/competition";
import { stageTableRulesDocs } from "@/server/engine-db/table-rules";
import { tableLayoutFor } from "@/server/public-site/standings-view";
import { listDivisionFixtures } from "./fixtures";
import type { QuickMatchFormat } from "./quick-match-preview";
import { offerFor } from "./quick-match-sports";
import { log } from "@/server/logger";
import { hashHomeToken, isHomeTokenShaped, tryOpenHomeToken, type HomeTokenOpenRefusal } from "./quick-match-tokens";
import { getStandings, type FixtureRow, type StandingsOut } from "./stages";

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
  format: QuickMatchFormat;   // V506's check constraint: 'league' | 'knockout'
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
  // A locale the app does not speak reads as the default, never as a broken page. V493's check constraint keeps such a
  // value out of the column; this stays as defence in depth (a locale dropped later would leave old rows behind it).
  locale: toLocale(r.locale),
  lastActivityAt: r.last_activity_at,
  expiresAt: r.expires_at,
  savedByUserId: r.saved_by_user_id,
  tokenEnc: r.token_enc,
});

/**
 * The quick match a home token opens, or null: a string that is not a home token's shape (checked before any lookup),
 * a token no row holds (never issued, or its match deleted), or an expired row. A null `expires_at` is ALIVE: a saved
 * row carries none (§7.7), and a bare `expires_at > now()` would kill every saved link (pre-flight B7a). Reading never
 * spends the token.
 */
export async function resolveQuickMatchToken(token: string): Promise<QuickMatchRow | null> {
  if (!isHomeTokenShaped(token)) return null;
  const hash = hashHomeToken(token);
  const [row] = await withTenant(SYSTEM_ORG, (tx) => tx<QuickMatchDbRow[]>`
    select id, competition_id, name, format, email, locale, last_activity_at, expires_at, saved_by_user_id, token_enc
    from quick_matches
    where token_hash = ${hash} and (expires_at is null or expires_at > now())`);
  return row ? toRow(row) : null;
}

/** One row of the "recent quick matches" strip (plan 2 Task 9, D11): the home it links to, its name and when it was made.
 *  Client-safe on purpose: no email, no envelope (the strip is a server component, but its props are the page's). */
export interface RecentQuickMatch {
  /** The home token in the clear, opened from the row's envelope: the strip's link is `routes.quickMatch(token)`. */
  token: string;
  name: string;
  /** ISO 8601 (UTC). */
  createdAt: string;
}

/**
 * The visitor's recent quick matches for the strip (spec §5 step 5; plan 2 pre-flight A9, A10, D11): the ALIVE rows this
 * visitor hash made, newest first, at most `limit`.
 *
 * Alive is `resolveQuickMatchToken`'s predicate above, word for word: no expiry (a saved row, §7.7) or a future one; a link
 * the strip shows must open a home, not the dead screen. The visitor hash is the caller's: a hash of a cookie that is a
 * visitor key's shape (`isVisitorKeyShaped`), never of whatever arrived.
 *
 * Each row's home token is opened with the NON-throwing `tryOpenHomeToken` (controller ruling 2026-11-08): a row that does
 * not open (no usable DEVICE_LINK_KEK, a damaged envelope, a key rotated without re-sealing) is skipped and the rest are
 * listed, with ONE warning for the read naming each skipped row's id and reason, never a token or an envelope. A skipped
 * row does not cost the guest a place: the read fetches twice `limit` and stops at `limit` rows that open, so a damaged
 * newest row lets the next older live one in. A failure of the read itself (the database) still throws: the page's
 * caller decides what an unreadable strip is.
 */
export async function listRecentQuickMatches(visitorHash: string, limit = 5): Promise<RecentQuickMatch[]> {
  const rows = await withTenant(SYSTEM_ORG, (tx) => tx<{ id: string; name: string; created_at: Date; token_enc: Uint8Array }[]>`
    select id, name, created_at, token_enc
    from quick_matches
    where visitor_hash = ${visitorHash} and (expires_at is null or expires_at > now())
    order by created_at desc, id desc
    limit ${limit * 2}`);
  const out: RecentQuickMatch[] = [];
  const skipped: { id: string; reason: HomeTokenOpenRefusal }[] = [];
  for (const r of rows) {
    if (out.length === limit) break;
    const opened = tryOpenHomeToken(r.token_enc);
    if (opened.ok) out.push({ token: opened.token, name: r.name, createdAt: r.created_at.toISOString() });
    else skipped.push({ id: r.id, reason: opened.reason });
  }
  if (skipped.length > 0) {
    log.warn({ skipped }, "quick match recent strip: rows skipped, their home token could not be opened");
  }
  return out;
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

export interface QuickMatchSide {
  entrantId: string;
  name: string;
}

export interface QuickMatchFixture {
  id: string;
  roundNo: number;
  fixtureNo: number;
  /** fixtures.seq_in_round, 1-based within its round (plan 2 D12): a waiting seat's slot label names its feeder as
   *  `{round, seq}`, and this is the `seq` half, so the home names the feeder in words instead of the label's own code. */
  seqInRound: number;
  /** null while the seat is unknown (a bracket seat its feeder has not filled yet, or a bye's empty seat). */
  home: QuickMatchSide | null;
  away: QuickMatchSide | null;
  homeSlotLabel: unknown;
  awaySlotLabel: unknown;
  status: string;
  /** The match's stored summary (`match_states.summary`); null before its first event. */
  summary: unknown;
  isBye: boolean;
  /** fixtures.is_final (C10): plan 2 marks the final without guessing from the round. */
  isFinal: boolean;
  /** The outcome's winner when it names one (an entrant id, lib/outcome-text.ts); null otherwise. */
  winnerEntrantId: string | null;
  /** Where the match stands for a guest (plan 2 Task 5), decided by the SAME predicates `nextPlayable` reads, so a list
   *  row's Score and the hero's next can never disagree: `settled` (SETTLED_FIXTURE_STATUSES; a bye's walkover too),
   *  `live` (in play), `ready` (scheduled, both sides known: C11) or `waiting` (anything else: a side still unknown, C18,
   *  or a held result no guest can settle, C23). */
  phase: QuickMatchPhase;
}

export type QuickMatchPhase = "settled" | "live" | "ready" | "waiting";

export interface QuickMatchHome {
  row: QuickMatchRow;
  divisionId: string;
  stageId: string;
  /** Dictionary keys, never English names (C1/C10). */
  sport: { key: string; labelKey: MessageKey; variantKey: string; variantLabelKey: MessageKey | null };
  /** The entrants' one kind (D2): the eyebrow's "sport · kind · format". */
  kind: EntrantKind;
  /** The sport offers more than one kind, so the guest CHOSE this one (the setup page's kind switch is shown only then):
   *  the eyebrow names the kind only when this is true (chess and football have one kind, and say nothing of it). */
  kindChosen: boolean;
  /** In seed order: the order the guest typed them (C20). */
  sides: QuickMatchSide[];
  /** In (round, fixture number) order, byes included. */
  fixtures: QuickMatchFixture[];
  next: QuickMatchFixture | null;
  /** The first match in play, in the same order. */
  live: QuickMatchFixture | null;
  /** Non-bye fixtures whose status is settled (SETTLED_FIXTURE_STATUSES, B7d). */
  played: number;
  /** Non-bye fixtures: Task 5's matchCount (C17). */
  total: number;
  /** The stored table of a league stage; null for a knockout, which has none (§7.10). */
  standings: StandingsOut | null;
  /** The unit the stored points are in (`TableLayout.unit`, the public table's own `tableLayoutFor` over the stage's
   *  rules): "half" for chess's FIDE half-points, which print through the engine's `pointsText` ("1½"), else "whole". */
  pointsUnit: TableLayout["unit"];
  allPlayed: boolean;
}

const byRoundThenNumber = (a: QuickMatchFixture, b: QuickMatchFixture): number =>
  a.roundNo - b.roundNo || a.fixtureNo - b.fixtureNo;

type Seated = Pick<QuickMatchFixture, "status" | "home" | "away">;

const isLive = (f: Seated): boolean => f.status === "in_play";
/** Scheduled with both sides known (C18: a match whose sides are not yet known cannot be scored). A held level result
 *  (`needs_decision`) is never playable: it waits for an organizer's settle, which C23 keeps unreachable for guests. */
const isReady = (f: Seated): boolean => f.status === "scheduled" && f.home !== null && f.away !== null;

/** `QuickMatchFixture.phase`: settled first (a bye's walkover is settled whatever its seats), then live, then ready. */
const phaseOf = (f: Seated): QuickMatchPhase =>
  SETTLED_FIXTURE_STATUSES.has(f.status) ? "settled" : isLive(f) ? "live" : isReady(f) ? "ready" : "waiting";

/** The hero's next match (C11): the first by (round, fixture number) in play, else the first scheduled with both sides
 *  known; null when there is none (an empty list included). */
export function nextPlayable(fixtures: QuickMatchFixture[]): QuickMatchFixture | null {
  const ordered = [...fixtures].sort(byRoundThenNumber);
  return ordered.find(isLive) ?? ordered.find(isReady) ?? null;
}

const winnerOf = (outcome: unknown): string | null => {
  const winner = (outcome as { winner?: unknown } | null)?.winner;
  return typeof winner === "string" ? winner : null;
};

const isMessageKey = (k: string): k is MessageKey => Object.hasOwn(messages, k);

/**
 * The quick match home's read, or null when the row's competition is gone (deleted since the row was resolved, Review
 * Focus 3). Every query runs as the system org (`withTenant(SYSTEM_ORG)`), each in its own transaction, in sequence
 * (withTenant never nests, lib/db.ts):
 *   1. THE PER-MATCH CHECK: the division by the row's own competition — none → null, before anything else is read — then
 *      its stage and its sides;
 *   2. the fixtures (`listDivisionFixtures`, scoped by that division);
 *   3. their summaries from `match_states`, by the ids just listed AND the row's competition (B7d);
 *   4. a league's stored table (`getStandings`).
 * A quick match is one division with one stage (§7.1); a competition holding more, or a seat naming an entrant outside
 * the division's own sides, is refused loudly rather than read half-right.
 */
export async function readQuickMatchHome(row: QuickMatchRow): Promise<QuickMatchHome | null> {
  const auth = systemAuth();

  const head = await withTenant(SYSTEM_ORG, async (tx) => {
    const divisions = await tx<{ id: string; sport_key: string; variant_key: string }[]>`
      select d.id, d.sport_key, d.variant_key from divisions d where d.competition_id = ${row.competitionId}`;
    if (divisions.length === 0) return null;
    if (divisions.length > 1) {
      throw new Error(`quick match ${row.id}: competition ${row.competitionId} holds ${divisions.length} divisions, not one`);
    }
    const division = divisions[0]!;
    const stages = await tx<{ id: string; kind: string }[]>`select id, kind from stages where division_id = ${division.id}`;
    if (stages.length !== 1) {
      throw new Error(`quick match ${row.id}: division ${division.id} holds ${stages.length} stages, not one`);
    }
    const entrants = await tx<{ id: string; display_name: string; kind: EntrantKind }[]>`
      select id, display_name, kind from entrants where division_id = ${division.id} order by seed nulls last, created_at, id`;
    return { division, stage: stages[0]!, entrants };
  });
  if (!head) return null;
  const { division, stage, entrants } = head;

  const kinds = new Set(entrants.map((e) => e.kind));
  if (kinds.size !== 1) {
    throw new Error(`quick match ${row.id}: division ${division.id} holds ${kinds.size} entrant kinds, not one (D2)`);
  }
  const labelKey = `sport.${division.sport_key}`;
  if (!isMessageKey(labelKey)) throw new Error(`quick match ${row.id}: no dictionary key names sport ${division.sport_key}`);

  const sides: QuickMatchSide[] = entrants.map((e) => ({ entrantId: e.id, name: e.display_name }));
  const sideById = new Map(sides.map((s) => [s.entrantId, s]));
  const sideOf = (fixtureId: string, entrantId: string | null): QuickMatchSide | null => {
    if (entrantId === null) return null;
    const side = sideById.get(entrantId);
    if (!side) throw new Error(`quick match ${row.id}: fixture ${fixtureId} seats entrant ${entrantId}, outside its own sides`);
    return side;
  };

  const rows: FixtureRow[] = await listDivisionFixtures(auth, division.id);
  const ids = rows.map((r) => r.id);
  const summaries = new Map(
    ids.length === 0
      ? []
      : (await withTenant(SYSTEM_ORG, (tx) => tx<{ fixture_id: string; summary: unknown }[]>`
          select ms.fixture_id, ms.summary
          from match_states ms
          join fixtures f on f.id = ms.fixture_id
          join divisions d on d.id = f.division_id
          where ms.fixture_id = any(${ids}::uuid[]) and d.competition_id = ${row.competitionId}`)).map((s) => [s.fixture_id, s.summary]),
  );

  const fixtures = rows
    .map((r): QuickMatchFixture => {
      const home = sideOf(r.id, r.home_entrant_id);
      const away = sideOf(r.id, r.away_entrant_id);
      return {
        id: r.id,
        roundNo: r.round_no,
        fixtureNo: r.fixture_no,
        seqInRound: r.seq_in_round,
        home,
        away,
        homeSlotLabel: r.home_slot_label,
        awaySlotLabel: r.away_slot_label,
        status: r.status,
        summary: summaries.get(r.id) ?? null,
        isBye: isBye(r),
        isFinal: r.is_final === true,
        winnerEntrantId: winnerOf(r.outcome),
        phase: phaseOf({ status: r.status, home, away }),
      };
    })
    .sort(byRoundThenNumber);

  const matches = fixtures.filter((f) => !f.isBye);
  const total = matches.length;
  const played = matches.filter((f) => SETTLED_FIXTURE_STATUSES.has(f.status)).length;
  const standings = stage.kind === "league" ? await getStandings(auth, stage.id) : null;
  const pointsUnit =
    stage.kind === "league"
      ? tableLayoutFor((await withTenant(SYSTEM_ORG, (tx) => stageTableRulesDocs(tx, [stage.id])))[stage.id]).unit
      : PLAIN_LAYOUT.unit;
  const kindChosen = (await offerFor(division.sport_key, division.variant_key)).kinds.length > 1;

  return {
    row,
    divisionId: division.id,
    stageId: stage.id,
    sport: {
      key: division.sport_key,
      labelKey,
      variantKey: division.variant_key,
      variantLabelKey: variantWordKey(division.sport_key, division.variant_key) ?? null,
    },
    kind: entrants[0]!.kind,
    kindChosen,
    sides,
    fixtures,
    next: nextPlayable(fixtures),
    live: fixtures.find(isLive) ?? null,
    played,
    total,
    standings,
    pointsUnit,
    // The empty case first: no match at all is not "all played".
    allPlayed: total > 0 && played === total,
  };
}
