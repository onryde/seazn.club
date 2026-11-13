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
//
// A League + Knockout (plan docs/superpowers/plans/2026-11-13-quick-match-5-league-knockout.md T5; spec
// docs/superpowers/specs/2026-11-12-quick-match-league-knockout-design.md §6, §11, §12) is one division with two stages,
// read as one home: every line carries its stage, "N of M played" counts both (D8), the league's own counts drive its hero,
// and the knockout's state (the question at the cut, Setting up, filled) is the advance's own cut (`loadLeagueCut`), never
// the knockout stage's status. Its load is the advance's retry (D2 caller d).
import { withTenant } from "@/lib/db";
import { SETTLED_FIXTURE_STATUSES } from "@/lib/fixture-status";
import { messages, type MessageKey } from "@/lib/messages";
import { systemAuth } from "@/lib/quick-match-auth";
import { QUICK_MATCH_SYSTEM_ORG_ID } from "@/lib/quick-match-constants";
import { isQuickMatchFinished, type QuickMatchCounts } from "@/lib/quick-match-finished";
import { isBye, type MatchLineRow } from "@/lib/run-sheet-groups";
import type { EntrantKind } from "@seazn/engine/sport";
import { PLAIN_LAYOUT, type TableLayout } from "@seazn/engine/competition";
import type { MetricSpecLike } from "@/lib/public-site";
import { resolveModule } from "@/server/engine-db";
import { stageTableRulesDocs, type StageTableRulesDoc } from "@/server/engine-db/table-rules";
import { tableLayoutFor } from "@/server/public-site/standings-view";
import { isCarriedForward, SETTLED_OPEN_STATUSES } from "./carried-forward";
import { listDivisionFixtures } from "./fixtures";
import { advanceQuickMatch, loadLeagueCut, type CutDecision } from "./quick-match-advance";
import { openTie, type CutTie } from "./quick-match-cut";
import { quickMatchStageCount, type QuickMatchFormat } from "./quick-match-preview";
import { findQuickMatchByCompetition, isNotPlayed, playedOf, toRow, type QuickMatchDbRow, type QuickMatchRow } from "./quick-match-row";
import { offerFor } from "./quick-match-sports";
import { log } from "@/server/logger";
import { hashHomeToken, isHomeTokenShaped, tryOpenHomeToken, type HomeTokenOpenRefusal } from "./quick-match-tokens";
import { getStandings, type FixtureRow, type StandingsOut } from "./stages";

const SYSTEM_ORG = QUICK_MATCH_SYSTEM_ORG_ID;

// The one "finished" (plan 4 D4), client-safe in lib so the Continue card can read it too; every server caller takes it from
// here, beside the count it reads.
export { isQuickMatchFinished, type QuickMatchCounts };
// The row and the count live below the home (`quick-match-row.ts`, plan 5 T5) so the League + Knockout advance can read them
// without importing the home; every importer keeps reading them from here.
export { findQuickMatchByCompetition, playedOf, toRow, type QuickMatchDbRow, type QuickMatchRow };

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

/** A recent row with its counts: `playedOf`, the home's own (owner 2026-11-12: the setup page's Continue card says it, and
 *  is shown only while the match is not finished, `isQuickMatchFinished`), so the card never says a different "played" from
 *  the match's home. Only that page reads it, so only it pays the fixture read (review m5: `listRecentQuickMatches`'
 *  `counts`). */
export interface RecentQuickMatchWithCounts extends RecentQuickMatch {
  played: number;
  /** Matches marked Not played (plan 4). */
  notPlayed: number;
  total: number;
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
 *
 * `counts` (review m5, controller ruling 2026-11-13): each row's played count, from a second read of the matches' fixtures
 * in the same transaction. Only the setup page asks (its Continue card); the marketing home's strip shows a name and a
 * date, so it never runs the fixture read, and that read's failure can never hide its strip.
 */
export function listRecentQuickMatches(
  visitorHash: string,
  opts: { limit?: number; counts: true },
): Promise<RecentQuickMatchWithCounts[]>;
export function listRecentQuickMatches(visitorHash: string, opts?: { limit?: number; counts?: false }): Promise<RecentQuickMatch[]>;
export async function listRecentQuickMatches(
  visitorHash: string,
  { limit = 5, counts = false }: { limit?: number; counts?: boolean } = {},
): Promise<RecentQuickMatch[]> {
  const { rows, fixtures } = await withTenant(SYSTEM_ORG, async (tx) => {
    const rows = await tx<{ id: string; competition_id: string; name: string; created_at: Date; token_enc: Uint8Array }[]>`
      select id, competition_id, name, created_at, token_enc
      from quick_matches
      where visitor_hash = ${visitorHash} and (expires_at is null or expires_at > now())
      order by created_at desc, id desc
      limit ${limit * 2}`;
    if (rows.length === 0 || !counts) return { rows, fixtures: null };
    // The same fixture read as the account list's (`listMyQuickMatches`), for `playedOf`.
    const fixtures = await tx<(MatchLineRow & { competition_id: string })[]>`
      select d.competition_id, f.status, f.outcome, f.home_entrant_id, f.away_entrant_id, f.home_slot_label, f.away_slot_label,
             f.ext_key
        from fixtures f
        join divisions d on d.id = f.division_id
       where d.competition_id = any(${rows.map((r) => r.competition_id)}::uuid[])`;
    return { rows, fixtures };
  });
  const byCompetition = new Map<string, MatchLineRow[]>();
  for (const f of fixtures ?? []) byCompetition.set(f.competition_id, [...(byCompetition.get(f.competition_id) ?? []), f]);
  const out: RecentQuickMatch[] = [];
  const skipped: { id: string; reason: HomeTokenOpenRefusal }[] = [];
  for (const r of rows) {
    if (out.length === limit) break;
    const opened = tryOpenHomeToken(r.token_enc);
    if (opened.ok) {
      const row: RecentQuickMatch = { token: opened.token, name: r.name, createdAt: r.created_at.toISOString() };
      out.push(fixtures === null ? row : { ...row, ...playedOf(byCompetition.get(r.competition_id) ?? []) });
    } else skipped.push({ id: r.id, reason: opened.reason });
  }
  if (skipped.length > 0) {
    log.warn({ skipped }, "quick match recent strip: rows skipped, their home token could not be opened");
  }
  return out;
}

/** One row of the account's "Quick matches" (spec §7.7, C9, C13, C19; plan 3 Task 6, Amend T6 [B26, B29]). Client-safe on
 *  purpose, as the strip's row is: no email, no envelope. */
export interface MyQuickMatch {
  id: string;
  name: string;
  /** The home token in the clear, opened from the row's envelope (the list's link is `routes.quickMatch(token)`), or null when it
   *  would not open (B29): the row is then listed without a link, never dropped. */
  token: string | null;
  format: QuickMatchFormat;
  /** `playedOf`, the home's own count: the list never says a different "played" from the match's home. */
  played: number;
  /** Matches marked Not played (plan 4). */
  notPlayed: number;
  total: number;
}

/**
 * The quick matches `userId` has saved, the most recently active first (spec §7.7: read from `quick_matches` by
 * `saved_by_user_id`). Never the account's own competitions (C9): every row is the system org's. A saved row carries no expiry,
 * so there is nothing to filter on aliveness. One read of the rows and one of all their fixtures, both as the system org.
 *
 * Each row's home token is opened with the NON-throwing `tryOpenHomeToken` (B29; controller ruling 2026-11-08): a row that does
 * not open (no usable DEVICE_LINK_KEK, a damaged envelope) is listed with `token: null`, so the account page never fails for
 * every saver at once, with ONE warning for the read naming each such row's id and reason, never a token or an envelope.
 *
 * `links: false` (a staff impersonation, T6 review m3, the admin page's rule: staff never get a guest's link): no token is
 * opened at all and every row's `token` is null. That is the caller's rule, not a fault, so it warns nothing. The caller must
 * say which, every time.
 */
export async function listMyQuickMatches(userId: string, opts: { links: boolean }): Promise<MyQuickMatch[]> {
  const { matches, fixtures } = await withTenant(SYSTEM_ORG, async (tx) => {
    const matches = await tx<{ id: string; competition_id: string; name: string; format: QuickMatchFormat; token_enc: Uint8Array }[]>`
      select id, competition_id, name, format, token_enc
        from quick_matches
       where saved_by_user_id = ${userId}
       order by last_activity_at desc, created_at desc, id desc`;
    if (matches.length === 0) return { matches, fixtures: [] };
    const fixtures = await tx<(MatchLineRow & { competition_id: string })[]>`
      select d.competition_id, f.status, f.outcome, f.home_entrant_id, f.away_entrant_id, f.home_slot_label, f.away_slot_label,
             f.ext_key
        from fixtures f
        join divisions d on d.id = f.division_id
       where d.competition_id = any(${matches.map((m) => m.competition_id)}::uuid[])`;
    return { matches, fixtures };
  });
  const byCompetition = new Map<string, MatchLineRow[]>();
  for (const f of fixtures) byCompetition.set(f.competition_id, [...(byCompetition.get(f.competition_id) ?? []), f]);
  const unopened: { id: string; reason: HomeTokenOpenRefusal }[] = [];
  const out = matches.map((m): MyQuickMatch => {
    const opened = opts.links ? tryOpenHomeToken(m.token_enc) : null;
    if (opened && !opened.ok) unopened.push({ id: m.id, reason: opened.reason });
    return {
      id: m.id,
      name: m.name,
      token: opened?.ok ? opened.token : null,
      format: m.format,
      ...playedOf(byCompetition.get(m.competition_id) ?? []),
    };
  });
  if (unopened.length > 0) {
    log.warn({ unopened }, "quick match account list: rows listed without a link, their home token could not be opened");
  }
  return out;
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
   *  row's Score and the hero's next can never disagree: `notPlayed` (marked Not played, plan 4: whatever its seats, and
   *  never next), `settled` (SETTLED_FIXTURE_STATUSES; a bye's walkover too), `live` (in play), `ready` (scheduled, both
   *  sides known: C11) or `waiting` (anything else: a side still unknown, C18, or a held result no guest can settle, C23). */
  phase: QuickMatchPhase;
  /** A settled result that has already moved the match on (carried-forward.ts's own predicate, read from these rows): its
   *  winner or loser is seated in a later match, or the stage is complete. The pad refuses to reopen it
   *  (RESULT_CARRIED_FORWARD), so the home offers it no "Edit result" (branch review A M6). False for anything not settled.
   *  Read against the line's OWN stage (plan 5 T5): a League + Knockout's league lines move on when the league completes, as
   *  the knockout fills (D3). */
  resultMovedOn: boolean;
  /** The kind of the stage the line belongs to (plan 5 T5): a League + Knockout holds both; a League or a Knockout one. */
  stage: "league" | "knockout";
  /** A League + Knockout's knockout line (plan 5 T5, D7): what each seat waits on, whether or not a side sits in it yet.
   *  null on a league line and on every line of a plain League or Knockout (whose seats the slot labels already name). */
  knockoutSeats: { home: QuickMatchKnockoutSeat; away: QuickMatchKnockoutSeat } | null;
}

export type QuickMatchPhase = "settled" | "live" | "ready" | "waiting" | "notPlayed";

/**
 * One seat of a League + Knockout's knockout line (plan 5 D7), from the line's stored slot label or, for a later round, the
 * generator's own feed edge (`winner_to_fixture` / `winner_to_slot`):
 *   - `league`: the side ranked `rank` in the league takes it ("1st in the league"), the first round's seats. It keeps its
 *     rank once a side sits in it ("1st"). `toDecide`: the seat waits on the tie the guests are asked about (the cut's open
 *     question, `QuickMatchKnockout.state === "tie"`): "2nd in the league — to decide";
 *   - `winner`: the winner of `fixtureId`, a line of the same knockout ("Winner of semi-final 1").
 */
export type QuickMatchKnockoutSeat =
  | { from: "league"; rank: number; toDecide: boolean }
  | { from: "winner"; fixtureId: string };

/**
 * Where a League + Knockout stands (plan 5 D2, spec §6, §11), the hero follows it:
 *   - `league`: a league match is still to play (or the league was reopened by an edit);
 *   - `tie`: the league is done and a tie straddles the cut with no answer: the hero is the question (`tie`);
 *   - `settingUp`: the league is done, nothing is left to ask, and the knockout is not filled yet: an advance has not run
 *     or failed (logged); every home load retries it (spec §11, "Setting up the knockout");
 *   - `filled`: the knockout's seats are filled from the league (its seed proposal is confirmed).
 */
export type QuickMatchKnockoutState = "league" | "tie" | "settingUp" | "filled";

/** A League + Knockout's knockout, as the home shows it (plan 5 T5). */
export interface QuickMatchKnockout {
  /** How many of the league go through: the knockout's own progression (D1), 2 or 4. */
  qualifiers: 2 | 4;
  state: QuickMatchKnockoutState;
  /** The seats are filled from the league (the confirmed seed proposal; never the knockout stage's status, which is active
   *  from the create). */
  filled: boolean;
  /** A knockout line is in play or settled (from the lines themselves, never the stage's status): the bracket's turn. */
  started: boolean;
  /** The question (§5 case 1): the tie that straddles the cut, while it is open (`state === "tie"`); null otherwise. Its
   *  `byLot` false means no lot ordered it (nothing was counted): Pick only, no Toss. */
  tie: CutTie | null;
  /** The guests' answer to the tie at the cut, once the league is done (m9: a stored answer on a reopened league is no
   *  answer); kept after the fill, for the result line. */
  decision: CutDecision | null;
  /** D6, once the league is done: every member of a class the lot ordered that goes through whole (§5 case 2), and every
   *  member of the straddling class when a toss settled it. Never a class the engine ordered by seed (`CutTie.byLot`
   *  false): no lot was drawn for it. In the table's order. */
  byLot: string[];
  /** D6: the sides the guests picked through (a Pick's `through`), once the league is done. */
  picked: string[];
}

export interface QuickMatchHome {
  row: QuickMatchRow;
  divisionId: string;
  /** The FIRST stage: a League's or a Knockout's one stage, a League + Knockout's league (the add form, the full table). */
  stageId: string;
  /** A League + Knockout's knockout stage (seq 2); null for a League or a Knockout (`CreatedQuickMatch.knockoutStageId`). */
  knockoutStageId: string | null;
  /** Dictionary keys, never English names (C1/C10). */
  sport: { key: string; labelKey: MessageKey };
  /** The entrants' one kind (D2): the eyebrow's "sport · kind · format". */
  kind: EntrantKind;
  /** The sport offers more than one kind, so the guest CHOSE this one (the setup page's kind switch is shown only then):
   *  the eyebrow names the kind only when this is true (chess and football have one kind, and say nothing of it). */
  kindChosen: boolean;
  /** In seed order: the order the guest typed them (C20). */
  sides: QuickMatchSide[];
  /** In (stage, round, fixture number) order, byes included: a League + Knockout's league lines first. */
  fixtures: QuickMatchFixture[];
  next: QuickMatchFixture | null;
  /** Non-bye fixtures whose status is settled (SETTLED_FIXTURE_STATUSES, B7d). */
  played: number;
  /** Non-bye fixtures marked Not played (plan 4): done, but no result. */
  notPlayed: number;
  /** Non-bye fixtures: Task 5's matchCount (C17). Every match, played or not (§6); a League + Knockout's knockout lines
   *  included, waiting seats and all (plan 5 D8, spec §12). */
  total: number;
  /** The league stage's lines only (plan 5 D8: the hero's "match n of m" while the league is on), and `done` =
   *  `isQuickMatchFinished` of them. A plain League's equal the match's own counts; null for a Knockout (no league). */
  league: (QuickMatchCounts & { done: boolean }) | null;
  /** A League + Knockout's knockout; null for a League or a Knockout. */
  knockout: QuickMatchKnockout | null;
  /** The final's winner (plan 5 D8: the champion comes from the final, never the table), once the final is settled; null
   *  before, and for a League (its winner is its table's). */
  champion: { entrantId: string; finalFixtureId: string } | null;
  /** The stored table of a league stage; null for a knockout, which has none (§7.10). */
  standings: StandingsOut | null;
  /** The unit the stored points are in (`TableLayout.unit`, the public table's own `tableLayoutFor` over the stage's
   *  rules): "half" for chess's FIDE half-points, which print through the engine's `pointsText` ("1½"), else "whole". */
  pointsUnit: TableLayout["unit"];
  /** The full table's ingredients (owner 2026-11-12, "Full table"), the public table's own: the league stage's table rules
   *  (`stageTableRulesDocs`, the one loader: its points rule and tie-break order) and the sport's standings metrics from the
   *  division's pinned module. Null and empty for a knockout; null rules or empty metrics also when the loader or the
   *  module refuses, as the public table falls back to its structural columns. */
  tableRules: StageTableRulesDoc | null;
  metricSpecs: MetricSpecLike[];
  /** `isQuickMatchFinished`: at least one match, and every one played or Not played (plan 4 D4). Derived on each read. A
   *  League + Knockout's counts its knockout too: it is finished once the final is decided (D8). */
  finished: boolean;
}

const byRoundThenNumber = (a: QuickMatchFixture, b: QuickMatchFixture): number =>
  a.roundNo - b.roundNo || a.fixtureNo - b.fixtureNo;

type Seated = Pick<QuickMatchFixture, "status" | "home" | "away">;

const isLive = (f: Seated): boolean => f.status === "in_play";
/** Scheduled with both sides known (C18: a match whose sides are not yet known cannot be scored). A held level result
 *  (`needs_decision`) is never playable: it waits for an organizer's settle, which C23 keeps unreachable for guests. */
const isReady = (f: Seated): boolean => f.status === "scheduled" && f.home !== null && f.away !== null;

/** `QuickMatchFixture.phase`: Not played first (whatever its seats, plan 4), then settled (a bye's walkover is settled
 *  whatever its seats), then live, then ready. Exported for its pure status sweep. */
export const phaseOf = (f: Seated): QuickMatchPhase =>
  isNotPlayed(f)
    ? "notPlayed"
    : SETTLED_FIXTURE_STATUSES.has(f.status)
      ? "settled"
      : isLive(f)
        ? "live"
        : isReady(f)
          ? "ready"
          : "waiting";

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

/** The stage kinds a quick match of `format` is built with, in seq order (`quickMatchStageInputs`, T3): a League + Knockout is
 *  a league then a knockout; a League or a Knockout is one stage of either kind (the read has always taken both, and Swiss
 *  never). Anything else is refused loudly. */
function stagesFit(format: QuickMatchFormat, kinds: readonly string[]): boolean {
  if (kinds.length !== quickMatchStageCount(format)) return false;
  return format === "league_knockout"
    ? kinds[0] === "league" && kinds[1] === "knockout"
    : kinds[0] === "league" || kinds[0] === "knockout";
}

/** A first-round knockout seat's stored slot label (`writeProgressionSetupFixtures`, T3): `slot.rank_range` with the league
 *  rank it waits on. Any other label is not a rank seat. */
function rankOfLabel(label: unknown): number | null {
  const l = label as { key?: unknown; params?: { rank?: unknown } } | null;
  return l?.key === "slot.rank_range" && typeof l.params?.rank === "number" ? l.params.rank : null;
}

/**
 * The quick match home's read, or null when the row's competition is gone (deleted since the row was resolved, Review
 * Focus 3). Every query runs as the system org (`withTenant(SYSTEM_ORG)`), each in its own transaction, in sequence
 * (withTenant never nests, lib/db.ts):
 *   0. a League + Knockout only: THE RETRY (plan 5 D2, caller d; spec §11): `advanceQuickMatch` first, best-effort, so a
 *      knockout a score, a skip or an answer left unfilled (its own advance failed, or a second phone's answer ran none)
 *      fills on the next load. A failure is logged (`quick_match_advance_failed`) and the read goes on: the home then shows
 *      "Setting up the knockout" (`knockout.state`), never a stuck page, and the next load tries again;
 *   1. THE PER-MATCH CHECK: the division by the row's own competition — none → null, before anything else is read — then
 *      its stages and its sides;
 *   2. a League + Knockout's cut (`loadLeagueCut`: the tie at the cut, the stored answer, whether the knockout is filled),
 *      read BEFORE the fixtures, so a cut that says filled never meets seats older than it;
 *   3. the fixtures (`listDivisionFixtures`, scoped by that division);
 *   4. their summaries from `match_states`, by the ids just listed AND the row's competition (B7d);
 *   5. the league's stored table (`getStandings`).
 * A quick match is one division with the stages its format is built with (§7.1; plan 5 T3: a league then a knockout for a
 * League + Knockout, one stage otherwise); a competition holding more, a stage graph of another shape, a seat naming an
 * entrant outside the division's own sides, or a knockout seat that names neither a league rank nor a feeder, is refused
 * loudly rather than read half-right.
 */
export async function readQuickMatchHome(row: QuickMatchRow): Promise<QuickMatchHome | null> {
  const auth = systemAuth();
  const lk = row.format === "league_knockout";

  if (lk) {
    // try/await, not `.catch`: an advance that throws before it returns a promise is the same best-effort failure.
    try {
      await advanceQuickMatch(row);
    } catch (err) {
      log.error(
        { err, event: "quick_match_advance_failed", quickMatch: row.id },
        "quick match home: the knockout's advance failed on load (the home shows Setting up and retries on its next load)",
      );
    }
  }

  const head = await withTenant(SYSTEM_ORG, async (tx) => {
    const divisions = await tx<{ id: string; sport_key: string; variant_key: string; module_version: string }[]>`
      select d.id, d.sport_key, d.variant_key, d.module_version from divisions d where d.competition_id = ${row.competitionId}`;
    if (divisions.length === 0) return null;
    if (divisions.length > 1) {
      throw new Error(`quick match ${row.id}: competition ${row.competitionId} holds ${divisions.length} divisions, not one`);
    }
    const division = divisions[0]!;
    const stages = await tx<{ id: string; kind: string; status: string; seq: number }[]>`
      select id, kind, status, seq from stages where division_id = ${division.id} order by seq, id`;
    const owed = quickMatchStageCount(row.format);
    if (stages.length !== owed) {
      throw new Error(`quick match ${row.id}: division ${division.id} holds ${stages.length} stages, not ${owed === 1 ? "one" : owed}`);
    }
    // CreateQuickMatch's stages are leagues and knockouts, never Swiss: `resultMovedOn` below reads no Swiss pairing on that
    // premise (branch-fix A review m3), so any other kind, or a League + Knockout of another shape, is refused rather than
    // read half-right.
    if (!stagesFit(row.format, stages.map((s) => s.kind))) {
      throw new Error(
        lk
          ? `quick match ${row.id}: a League + Knockout is a league then a knockout, division ${division.id} holds [${stages.map((s) => s.kind).join(", ")}]`
          : `quick match ${row.id}: stage ${stages[0]!.id} is a ${stages[0]!.kind} stage, not a league or a knockout`,
      );
    }
    const entrants = await tx<{ id: string; display_name: string; kind: EntrantKind }[]>`
      select id, display_name, kind from entrants where division_id = ${division.id} order by seed nulls last, created_at, id`;
    return { division, stages, entrants };
  });
  if (!head) return null;
  const { division, stages, entrants } = head;
  const stageById = new Map(stages.map((s) => [s.id, s]));
  const leagueStage = stages.find((s) => s.kind === "league") ?? null;
  const knockoutStage = stages.find((s) => s.kind === "knockout") ?? null;

  const kinds = new Set(entrants.map((e) => e.kind));
  if (kinds.size !== 1) {
    throw new Error(`quick match ${row.id}: division ${division.id} holds ${kinds.size} entrant kinds, not one (D2)`);
  }
  const labelKey = `sport.${division.sport_key}`;
  if (!isMessageKey(labelKey)) throw new Error(`quick match ${row.id}: no dictionary key names sport ${division.sport_key}`);

  const cut = lk ? await loadLeagueCut(row) : null;
  if (lk && cut === null) return null;   // the competition went between the reads: the dead link, as step 1's null

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
  // A League + Knockout's filled first-round seats lose their slot labels to the fill (the confirm writes the entrant over
  // the label), so their league rank is the confirmed proposal's (`destinationSlot` → `rank`, the seed that slot was drawn
  // for). Read AFTER the fixtures: a seat seen filled was filled by a confirm already committed.
  const filledSlotRank = new Map<string, number>(
    lk
      ? (await withTenant(SYSTEM_ORG, (tx) => tx<{ slot: string; rank: number }[]>`
          select q->>'destinationSlot' as slot, (q->>'rank')::int as rank
          from stage_seed_proposals p, jsonb_array_elements(p.computed->'qualifiers') q
          where p.stage_id = ${knockoutStage!.id} and p.status = 'confirmed'`)).map((q) => [q.slot, q.rank])
      : [],
  );
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const stageOf = (r: FixtureRow) => {
    const stage = stageById.get(r.stage_id);
    if (!stage) throw new Error(`quick match ${row.id}: fixture ${r.id} belongs to stage ${r.stage_id}, outside its own stages`);
    return stage;
  };
  /** The seat a feed edge names (1 = home, 2 = away) is taken: carried-forward.ts's SQL, over the rows already loaded. A feed
   *  into a match outside this division's own rows is refused loudly, as a foreign entrant is above. */
  const feedFilled = (fixtureId: string, target: string | null | undefined, slot: number | null | undefined): boolean => {
    if (target == null) return false;
    const into = rowById.get(target);
    if (!into) throw new Error(`quick match ${row.id}: fixture ${fixtureId} feeds ${target}, outside its own division`);
    return slot === 1 ? into.home_entrant_id !== null : slot === 2 ? into.away_entrant_id !== null : false;
  };
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

  // The league's own lines (D8): its counts, and whether it is done, read off the same rows the list shows.
  const leagueRows = leagueStage ? rows.filter((r) => r.stage_id === leagueStage.id) : [];
  const leagueCounts = leagueStage ? playedOf(leagueRows) : null;
  const leagueDone = leagueCounts !== null && isQuickMatchFinished(leagueCounts);

  // A League + Knockout's state (§6, §11), from the cut's one read. A stored answer counts only on a league that is done by
  // both reads (m9: until an advance drops it, an answer can sit on a reopened league).
  const cutFinal = cut !== null && cut.leagueDone && leagueDone;
  const decision = cutFinal ? cut.decision : null;
  const open = cut !== null ? openTie(cut.ties) : null;   // asked only of a done league (`state` below)
  const state: QuickMatchKnockoutState | null =
    cut === null ? null : cut.filled ? "filled" : !leagueDone ? "league" : open !== null && decision === null ? "tie" : "settingUp";
  const question = state === "tie" ? open : null;

  /** A knockout seat of a League + Knockout (D7): the league rank its label names (a seat still waiting), else the line whose
   *  winner the generator's edge sends into it (a later round), else the rank the confirmed proposal filled it for (a
   *  first-round seat the fill took). None of the three is a stage graph this read does not know, refused loudly. */
  const seatOf = (r: FixtureRow, side: "home" | "away"): QuickMatchKnockoutSeat => {
    const label = rankOfLabel(side === "home" ? r.home_slot_label : r.away_slot_label);
    if (label !== null) {
      const toDecide = question !== null && label >= question.place && label < question.place + question.seats;
      return { from: "league", rank: label, toDecide };
    }
    const slot = side === "home" ? 1 : 2;
    const feeders = rows.filter((f) => f.winner_to_fixture === r.id && f.winner_to_slot === slot);
    if (feeders.length === 1) return { from: "winner", fixtureId: feeders[0]!.id };
    const filled = feeders.length === 0 ? filledSlotRank.get(`${r.id}:${side}`) : undefined;
    if (filled === undefined) {
      throw new Error(`quick match ${row.id}: knockout fixture ${r.id}'s ${side} seat names no league rank and no feeder`);
    }
    return { from: "league", rank: filled, toDecide: false };
  };

  const fixtures = rows
    .map((r): QuickMatchFixture => {
      const stage = stageOf(r);
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
        resultMovedOn:
          SETTLED_OPEN_STATUSES.has(r.status) &&
          isCarriedForward({
            winnerFeedFilled: feedFilled(r.id, r.winner_to_fixture, r.winner_to_slot),
            loserFeedFilled: feedFilled(r.id, r.loser_to_fixture, r.loser_to_slot),
            // Leagues and knockouts only (refused otherwise, above): there is no Swiss round to pair.
            swissNextRoundSeated: false,
            stageComplete: stage.status === "complete",
          }),
        stage: stage.kind as QuickMatchFixture["stage"],
        knockoutSeats: lk && stage.kind === "knockout" ? { home: seatOf(r, "home"), away: seatOf(r, "away") } : null,
      };
    })
    // Stage first: a League + Knockout's knockout lines are numbered after the league's, but their rounds restart at 1.
    .sort((a, b) => stageOf(rowById.get(a.id)!).seq - stageOf(rowById.get(b.id)!).seq || byRoundThenNumber(a, b));

  const counts = playedOf(rows);
  const knockoutLines = fixtures.filter((f) => f.stage === "knockout");
  let knockout: QuickMatchKnockout | null = null;
  if (cut !== null && state !== null) {
    // D6, once the league is done: a lot-ordered class that goes through whole is "by lot"; the straddling class is "by lot"
    // when a toss settled it, its picked sides "picked" when a pick did. A seed-ordered class is never "by lot".
    const byLot: string[] = [];
    let picked: string[] = [];
    if (cutFinal) {
      for (const tie of cut.ties) {
        if (!tie.straddles) {
          if (tie.byLot) byLot.push(...tie.ranked);
        } else if (decision?.how === "toss") {
          byLot.push(...tie.ranked);
        } else if (decision?.how === "pick") {
          picked = [...decision.through];
        }
      }
    }
    knockout = {
      qualifiers: cut.qualifiers,
      state,
      filled: cut.filled,
      started: knockoutLines.some((f) => f.phase === "live" || f.phase === "settled"),
      tie: question,
      decision,
      byLot,
      picked,
    };
  }
  // The champion is the final's winner (D8), never the table's leader: a stored outcome names one only once the final is
  // decided (a void clears it).
  const final = knockoutLines.find((f) => f.isFinal && f.winnerEntrantId !== null) ?? null;

  const standings = leagueStage ? await getStandings(auth, leagueStage.id) : null;
  const tableRules = leagueStage
    ? ((await withTenant(SYSTEM_ORG, (tx) => stageTableRulesDocs(tx, [leagueStage.id])))[leagueStage.id] ?? null)
    : null;
  const pointsUnit = leagueStage ? tableLayoutFor(tableRules).unit : PLAIN_LAYOUT.unit;
  // The division page's own fallback: a module this build cannot resolve shows the structural columns only.
  let metricSpecs: MetricSpecLike[] = [];
  if (leagueStage) {
    try {
      metricSpecs = resolveModule(division.sport_key, division.module_version).metrics;
    } catch {
      metricSpecs = [];
    }
  }
  const kindChosen = (await offerFor(division.sport_key, division.variant_key)).kinds.length > 1;

  return {
    row,
    divisionId: division.id,
    stageId: stages[0]!.id,
    knockoutStageId: lk ? knockoutStage!.id : null,
    sport: {
      key: division.sport_key,
      labelKey,
    },
    kind: entrants[0]!.kind,
    kindChosen,
    sides,
    fixtures,
    // No stage rule is owed here: a knockout line has a side only once the league is done and the knockout filled (the
    // advance, D2), and a league result is locked from then on (P16), so the two stages are never playable at once.
    next: nextPlayable(fixtures),
    ...counts,
    league: leagueCounts === null ? null : { ...leagueCounts, done: leagueDone },
    knockout,
    champion: final === null ? null : { entrantId: final.winnerEntrantId!, finalFixtureId: final.id },
    standings,
    pointsUnit,
    tableRules,
    metricSpecs,
    // The empty case first (the predicate's own): no match at all is not finished.
    finished: isQuickMatchFinished(counts),
  };
}
