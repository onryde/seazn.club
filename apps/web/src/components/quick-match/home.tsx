// Quick match home (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 3, §7.5, C11, C15, C18; plan 2
// Task 5; mockup docs/superpowers/specs/mockups/2026-11-03-quick-match/home.html, layout only): what the share link opens.
// In the mockup's order: the eyebrow (sport · kind · format), the name, the played line, the hero (the match up next or in
// play, or the winner once the league is finished), the actions, the standings (league) or the draw (knockout), then every
// match with the finished ones at the bottom.
//
// Not played (plan docs/superpowers/plans/2026-11-13-quick-match-4-skip-match.md Task 4; spec 2026-11-12 §3, §6; mockup
// qmd13a01 sections 1-5, layout only): each row's ⋯ menu (the `rowMenu` slot, match-list.tsx decides what it offers), the
// played line naming how many were not played (M stays the full total), "Counts played matches only" over the table, and
// "finished" read from the one predicate (`QuickMatchHome.finished`, `isQuickMatchFinished`): every match played or Not
// played. Finished with a match played, the winner card says how many were played and how many were not; finished with
// none played, the table is hidden and the home says "No matches were played", with the way to start a new quick match.
//
// A SERVER component. It reads plan 1's `QuickMatchHome` and passes only strings and ids on: the read's `row` (the
// creator's email, the sealed token) never leaves this file (A14), and nothing here is a client boundary. The actions are
// SLOTS the later tasks fill (Score: Task 6, Share: Task 7, Add a match: Task 8, Save: plan 3 Task 5). Save is offered on a
// match nobody has saved (to anyone, signed in or not: C3); its saver reads "Saved" instead; anyone else sees neither.
//
// Words: every string a guest reads is a dictionary key in the VIEWER's locale (D10). Matches are numbered D12's way (the
// 1-based index among non-bye matches in play order), a waiting seat names its feeder in words, never a round code, and a
// knockout's rounds are named by their place in the bracket (`roundRoleFor`).
//
// Phone first: one column, each name wrapping or truncating inside a `min-w-0` chain, so a 40-character side never
// widens a 320px screen. From `lg` the name, hero and actions hold a sticky left column beside the table and the list.
//
// League + Knockout (plan docs/superpowers/plans/2026-11-13-quick-match-5-league-knockout.md Task 7, D6-D9; spec
// 2026-11-12-quick-match-league-knockout-design.md §5, §6, §11, §12; mockup qmd13a01 §7-12, layout only): the table on top
// with the knockout drawn below it from the start ("1st in the league", "Winner of semi-final 1"); the league's matches
// alone under "League matches". The hero follows `QuickMatchHome.knockout.state`: the league's next match ("match 3 of 6",
// the league's own count), then the tie at the cut as a question (`qm-cut`, the `cut` slot answers it: Pick, and Toss when
// a lot ordered the tie), "Setting up the knockout" (with a Refresh, the `refresh` slot) while an advance has not filled it,
// then the knockout's next round, then the champion — the FINAL's winner, never the table's leader. Once the knockout fills,
// it moves above the table (§12), the table is the final league table, and Add a match is gone (§6, D3).
import type { ReactNode } from "react";
import { Check, RotateCw, Trophy } from "lucide-react";
import { isLevelTable, pointsText, rankText } from "@seazn/engine/competition";
import type { EntrantKind } from "@seazn/engine/sport";
import type { Locale } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import type { TKey } from "@/lib/i18n-runtime";
import {
  QUICK_MATCH_ACCOUNT_SECTION_ID,
  QUICK_MATCH_ERRORS,
  QUICK_MATCH_EXPIRY_DAYS,
  QUICK_MATCH_MAX_ADHOC,
} from "@/lib/quick-match-constants";
import { roundRoleFor } from "@/lib/round-role-label";
import { routes } from "@/lib/routes";
import { compactScore } from "@/lib/match-day/view";
import { scoreLineOf, type LevelWords, type ScoreLine } from "@/lib/score/levels";
import { setBreakdown } from "@/lib/public-site";
import { isQuickMatchFinished } from "@/lib/quick-match-finished";
import type {
  QuickMatchFixture,
  QuickMatchHome,
  QuickMatchKnockout,
  QuickMatchKnockoutSeat,
  QuickMatchSide,
} from "@/server/usecases/quick-match-home";
import { QuickMatchDeletionLine } from "./deletion-line";
import { QuickMatchStandings, type FullTableData, type StandingsView } from "./standings";
import { QuickMatchDraw, type DrawCard, type DrawRound, type DrawSeat } from "./draw";
import { QuickMatchList, type MatchView, type RowMenuSlot, type ScoreSlot, type SeatView, type SkipCopy } from "./match-list";
import { fixtureLabel, winnerOfLabel, type FixtureLabel } from "./fixture-label";
import { playedLine } from "./played-line";

type Vars = Record<string, string | number>;

/** The viewer's words, resolved by the page from the dictionaries. */
export interface QuickMatchCopy {
  /** The viewer's language (D10), for the dates the page writes. */
  locale: Locale;
  t: (key: MessageKey, vars?: Vars) => string;
  plural: (key: string, count: number, vars?: Vars) => string;
  /** The public dictionary's live-level marks (TB, MTB, Ad) for a live score. */
  levels: LevelWords;
  /** The PUBLIC dictionary: the public table's own column words (`table.abbr.*` and `table.col.*`) and its level mark. */
  pub: (key: TKey, vars?: Vars) => string;
}

/** What "Add a match" offers (Task 8, spec C5): every side, in the order the guest typed them, and the two its selects open
 *  at: the table's top two (the decider a level top asks for), or the first two sides when there is no table yet. */
export interface AddMatchView {
  sides: { id: string; name: string }[];
  home: string;
  away: string;
}
export type AddMatchSlot = (view: AddMatchView) => ReactNode;

/** The tie at a League + Knockout's cut as the guests answer it (plan 5 D5, spec §5, §11): every side of the tie in the
 *  order the guests typed them (never the lot's: the open question shows no lot order), how many of them go through
 *  ("pick N of M"), and whether "Toss a coin" may be offered (`CutTie.byLot`: a tie no lot ordered has no coin to reveal). */
export interface CutView {
  members: { id: string; name: string }[];
  seats: number;
  toss: boolean;
}
export type CutSlot = (view: CutView) => ReactNode;

/** What Tasks 6, 7 and 8 put on the home. Each is optional: an empty slot renders nothing. */
export interface QuickMatchSlots {
  /** The Score control of a playable match: in the hero, and on its list row. Never offered for a waiting seat (C18). */
  score?: ScoreSlot;
  share?: ReactNode;
  /** League only (C5): a knockout never asks for it. */
  addMatch?: AddMatchSlot;
  /** Plan 3 Task 5: the Save form. Drawn only while nobody has saved the match (`savedSlot`). */
  save?: ReactNode;
  /** Plan 4 Task 4: one row's ⋯ menu (Score and Not played, Edit result, or Put back), asked only for a row with something to
   *  offer (match-list.tsx `rowMenuItems`). */
  rowMenu?: RowMenuSlot;
  /** Plan 5 Task 7: a League + Knockout's tie at the cut — the Pick panel and the Toss form (`cut-prompt.tsx`), asked only
   *  while the question is open. */
  cut?: CutSlot;
  /** Plan 5 Task 7: "Setting up the knockout"'s Refresh (the home's own path, `QuickMatchRefreshLink`). */
  refresh?: ReactNode;
}

const KIND_KEY = {
  individual: "quickMatch.kind.individual",
  pair: "quickMatch.kind.pair",
  team: "quickMatch.kind.team",
} as const satisfies Record<EntrantKind, MessageKey>;

const FORMAT_KEY = {
  league: "quickMatch.format.league",
  knockout: "quickMatch.format.knockout",
  league_knockout: "quickMatch.format.league_knockout",
} as const satisfies Record<QuickMatchHome["row"]["format"], MessageKey>;

/**
 * The home's flash (pre-flight D3): a home action's refusal lands back here as `?e=<code>` (QUICK_MATCH_ERRORS), and each
 * code reads as its own `quickMatch.flash.*` line in the viewer's language. The codes are the Score route's
 * (app/q/[token]/score/[fixtureId]/route.ts) and Add-a-match's (app/q/[token]/add-match/route.ts: the cap, whose line names
 * QUICK_MATCH_MAX_ADHOC as `{max}`, the same side twice, and a knockout), and plan 4's Not played and Put back routes
 * (app/q/[token]/skip, put-back: a match with a result, a finished league). An expiry has none: the home is then the dead
 * screen, which ignores `?e=` (D16; T6 review m1). A repeated `?e=` reads its first, a blank one is
 * no flash, and anything else (a crafted value, a code of another page) is the generic line: the raw value never reaches
 * the page.
 *
 * One code is no refusal: EMAIL_LIMITED, the create's own landing when a mail limit kept the link mail back (branch review
 * B m3). The match was made; the line tells the guest to share or bookmark it, so it reads as information (`info`: a
 * status, not an alert, and not in the refusal's red).
 */
export type HomeFlashTone = "refusal" | "info";
export interface HomeFlash {
  key: MessageKey;
  tone: HomeFlashTone;
  /** The line's placeholders, from the constants (never typed into the copy). */
  vars?: Vars;
}
const FLASH: Readonly<Record<string, HomeFlash>> = {
  [QUICK_MATCH_ERRORS.LINK_LIMITED]: { key: "quickMatch.flash.linkLimit", tone: "refusal" },
  [QUICK_MATCH_ERRORS.NOT_FOUND]: { key: "quickMatch.flash.notFound", tone: "refusal" },
  [QUICK_MATCH_ERRORS.SIDES_UNKNOWN]: { key: "quickMatch.flash.notReady", tone: "refusal" },
  [QUICK_MATCH_ERRORS.ACTION_FAILED]: { key: "quickMatch.flash.generic", tone: "refusal" },
  [QUICK_MATCH_ERRORS.EMAIL_LIMITED]: { key: "quickMatch.flash.emailLimited", tone: "info" },
  [QUICK_MATCH_ERRORS.ADHOC_LIMIT]: { key: "quickMatch.flash.adhocLimit", tone: "refusal", vars: { max: QUICK_MATCH_MAX_ADHOC } },
  [QUICK_MATCH_ERRORS.SAME_SIDE]: { key: "quickMatch.flash.sameSide", tone: "refusal" },
  [QUICK_MATCH_ERRORS.LEAGUE_ONLY]: { key: "quickMatch.flash.leagueOnly", tone: "refusal" },
  // Save's confirm route (plan 3 Task 5): somebody saved it first, and staff looking through a user's account.
  [QUICK_MATCH_ERRORS.TAKEN]: { key: "quickMatch.flash.taken", tone: "refusal" },
  [QUICK_MATCH_ERRORS.SAVE_IMPERSONATED]: { key: "quickMatch.flash.impersonating", tone: "refusal" },
  // Not played and Put back (plan 4 Task 3's routes): a skip of a match that has a result (or of a knockout's), and a stale
  // Put back once the league has finished.
  [QUICK_MATCH_ERRORS.NOT_SKIPPABLE]: { key: "quickMatch.flash.notSkippable", tone: "refusal" },
  [QUICK_MATCH_ERRORS.LEAGUE_FINISHED]: { key: "quickMatch.flash.leagueFinished", tone: "refusal" },
  // The Score route on a match someone else marked Not played after this page loaded (T1 review G1): put it back first.
  [QUICK_MATCH_ERRORS.NOT_PLAYED]: { key: "quickMatch.flash.notPlayed", tone: "refusal" },
  // A League + Knockout's cut (plan 5 T4's routes): a second answer (or one after the fill), a question the table no
  // longer asks, a Pick of the wrong count, and Add a match once the league is complete.
  [QUICK_MATCH_ERRORS.ALREADY_DECIDED]: { key: "quickMatch.flash.alreadyDecided", tone: "refusal" },
  [QUICK_MATCH_ERRORS.TIE_NOT_OPEN]: { key: "quickMatch.flash.tieChanged", tone: "refusal" },
  [QUICK_MATCH_ERRORS.PICK_INVALID]: { key: "quickMatch.flash.pickInvalid", tone: "refusal" },
  [QUICK_MATCH_ERRORS.LEAGUE_COMPLETE]: { key: "quickMatch.flash.leagueComplete", tone: "refusal" },
};
const GENERIC_FLASH: HomeFlash = { key: "quickMatch.flash.generic", tone: "refusal" };
export function homeFlash(e: string | string[] | undefined): HomeFlash | null {
  const raw = (Array.isArray(e) ? e[0] : e)?.trim();
  if (!raw) return null;
  return Object.hasOwn(FLASH, raw) ? FLASH[raw]! : GENERIC_FLASH;
}

/** A refusal for a state plan 1's read never produces: a page that hit it would otherwise print a blank or a code. */
export class QuickMatchHomeShapeError extends Error {
  constructor(what: string) {
    super(`quick match home: ${what}`);
    this.name = "QuickMatchHomeShapeError";
  }
}

// ── the view model ──────────────────────────────────────────────────────────────────────────────────────────────────

interface Built {
  eyebrow: string;
  played: string;
  hero: { kicker: string; home: string; away: string; score: string | null; fixture: { id: string; live: boolean } } | null;
  /** `note` (plan 4): how many were played and how many were not, when the league finished with some Not played. */
  winner: { kicker: string; names: string[]; note: string | null } | null;
  /** Finished with no match played (plan 4, spec §3 Edge): "No matches were played", in place of a winner and a table. */
  noPlay: { kicker: string; title: string; hint: string } | null;
  standings: StandingsView | null;
  /** The bracket: a Knockout's "The draw", a League + Knockout's "Knockout" (with its caption while it waits). */
  draw: { title: string; rounds: DrawRound[]; leagueKnockout: { caption: string | null } | null } | null;
  matches: MatchView[];
  /** "All matches", or a League + Knockout's "League matches" (its knockout's lines are the bracket's cards). */
  matchesTitle: string;
  /** A league's "Add a match" (C5); null for a knockout, for a quick match with fewer than two sides to pick, and for a
   *  League + Knockout whose league is complete (§6). */
  addMatch: AddMatchView | null;
  /** A League + Knockout (plan 5 T7): the tie at the cut as the hero's question, while it is open. */
  cut: { kicker: string; title: string; body: string; view: CutView } | null;
  /** A League + Knockout: the league is done and the knockout not filled yet (spec §11). */
  settingUp: { kicker: string; title: string; hint: string } | null;
  /** A League + Knockout: how the tie at the cut was settled, above the knockout's hero (§11: the same on every phone). */
  cutResult: string[] | null;
  /** A League + Knockout: the final's winner (D8), once the final is decided. */
  champion: { kicker: string; name: string; beat: string | null; topToo: string | null } | null;
  /** A League + Knockout whose knockout has filled: the bracket above the table (§12). */
  knockoutFirst: boolean;
}

/** A league rank's words, for the ranks a knockout of 2 or 4 seats (D7: keys per rank, no ordinal arithmetic). */
const LEAGUE_RANK_KEY = {
  1: "quickMatch.home.leagueRank.1",
  2: "quickMatch.home.leagueRank.2",
  3: "quickMatch.home.leagueRank.3",
  4: "quickMatch.home.leagueRank.4",
} as const satisfies Record<number, MessageKey>;
const RANK_SHORT_KEY = {
  1: "quickMatch.home.rankShort.1",
  2: "quickMatch.home.rankShort.2",
  3: "quickMatch.home.rankShort.3",
  4: "quickMatch.home.rankShort.4",
} as const satisfies Record<number, MessageKey>;
/** The key for `rank`, refused loudly past the ranks a knockout of 4 seats: a rank the read never seats has no words. */
function rankKey<K extends MessageKey>(keys: Readonly<Record<number, K>>, rank: number): K {
  if (!Object.hasOwn(keys, rank)) throw new QuickMatchHomeShapeError(`a knockout seat names league rank ${rank}, which has no words`);
  return keys[rank]!;
}

/** Each side's own line from the engine's summary (`ScoreSummary.perSide[{entrantId, line}]`), by entrant: null unless it
 *  names both of the match's sides. */
function perSideLines(f: QuickMatchFixture): { home: string; away: string } | null {
  const perSide = (f.summary as { perSide?: unknown } | null)?.perSide;
  if (!Array.isArray(perSide) || f.home === null || f.away === null) return null;
  const lineOf = (entrantId: string) => {
    const hit = perSide.find((p) => (p as { entrantId?: unknown } | null)?.entrantId === entrantId) as { line?: unknown } | undefined;
    return typeof hit?.line === "string" ? hit.line : null;
  };
  const home = lineOf(f.home.entrantId);
  const away = lineOf(f.away.entrantId);
  return home === null || away === null ? null : { home, away };
}

/** A finished match's score, read in the result sentence's order (winner first; home first for a draw), so "Red beat Blue"
 *  never sits beside "0–1": a set sport as its games ("21–15 · 21–18"), any other as the sides' own lines from the engine's
 *  `perSide`; the published headline only when `perSide` does not name both sides. */
function settledScore(f: QuickMatchFixture, sportKey: string): string | null {
  const awayWon = f.away !== null && f.away.entrantId === f.winnerEntrantId;
  const sets = setBreakdown(f.summary, sportKey);
  if (sets !== null) return sets.sets.map((s) => (awayWon ? `${s.away}–${s.home}` : `${s.home}–${s.away}`)).join(" · ");
  const lines = perSideLines(f);
  if (lines !== null) return awayWon ? `${lines.away}–${lines.home}` : `${lines.home}–${lines.away}`;
  const headline = (f.summary as { headline?: unknown } | null)?.headline;
  return typeof headline === "string" && headline !== "" ? headline : null;
}

/** The score as it stands (live: the sport's own levels, in seat order) or as it ended (settled); null otherwise. */
function scoreText(f: QuickMatchFixture, sportKey: string, levels: LevelWords): string | null {
  if (f.phase === "settled") return settledScore(f, sportKey);
  if (f.phase !== "live") return null;
  const line = scoreLineOf(f.summary);
  return line === null ? null : compactScore(line, levels);
}

/**
 * Whether a live match has anything but noughts on the board (FR4 m1, whole-branch review m1): a match that was only
 * Started is live at "0 — 0" and has scored nothing, so the confirm sheet must not call that score "already scored". Read
 * from the engine's own figures, never its headline (a period sport's carries its period, "0 — 0 · P1"; a board game's
 * reads "vs" until it is decided): a set sport's sets, games and points as `scoreLineOf` splits them (an advantage call is
 * a point), else any figure on a side's own line (`ScoreSummary.perSide[].line`: goals, games and the board in play, a
 * shoot-out's tally). A summary with no per-side lines is not the engine's shape: its score is quoted as before, so the
 * sheet warns rather than hides.
 */
function scoreStands(line: ScoreLine, summary: unknown): boolean {
  if (line.kind === "sets") {
    const { won, mid, live } = line.levels;
    return [...won, ...(mid ?? [])].some((n) => Number(n) > 0) || (live?.sides.some((s) => s !== "0") ?? false);
  }
  const perSide = (summary as { perSide?: unknown }).perSide;
  if (!Array.isArray(perSide)) return true;
  return perSide.some((s) => /[1-9]/.test(String((s as { line?: unknown } | null)?.line ?? "")));
}

/** A knockout fixture's role in its bracket, and its place among its round's NON-BYE fixtures: what `fixtureLabel` and
 *  `winnerOfLabel` (the setup preview's own helper, controller ruling 2026-11-08) number a card and a feeder by. */
function placeOf(f: QuickMatchFixture, all: readonly QuickMatchFixture[]) {
  const role = roundRoleFor(
    all.map((x) => ({ round_no: x.roundNo, lane: null })),
    { round_no: f.roundNo, lane: null, is_final: f.isFinal, third_place: false, conditional: false },
    "knockout",
  );
  // `all` is in (round, fixture number) order, so the round's non-bye fixtures are too.
  const round = all.filter((x) => x.roundNo === f.roundNo && !x.isBye);
  return { role, count: round.length, index: round.findIndex((x) => x.id === f.id) };
}

/** The fixture a waiting seat's slot label names (`{key: "slot.winner_match", params: {round, seq}}`, plan 1's D12 test). */
function feederOf(label: unknown, all: readonly QuickMatchFixture[]): QuickMatchFixture {
  const params = (label as { key?: unknown; params?: { round?: unknown; seq?: unknown } } | null)?.params;
  const key = (label as { key?: unknown } | null)?.key;
  const hits =
    key === "slot.winner_match" && params
      ? all.filter((f) => f.roundNo === Number(params.round) && f.seqInRound === Number(params.seq))
      : [];
  if (hits.length !== 1) throw new QuickMatchHomeShapeError(`a waiting seat names no single feeder (${JSON.stringify(label)})`);
  return hits[0]!;
}

/** `fullTable`: the public table's columns and cells for this league (owner 2026-11-12, "Full table"), built by the page
 *  (`app/q/[token]/full-table.ts`); null for a knockout, or when the page has none to give. */
export function buildHomeView(home: QuickMatchHome, copy: QuickMatchCopy, fullTable: FullTableData | null = null): Built {
  const { t } = copy;
  const say = ({ key, params }: FixtureLabel) => t(key, params);
  const knockout = home.row.format === "knockout";
  const lk = lkOf(home);
  const matchNo = new Map(home.fixtures.filter((f) => !f.isBye).map((f, i) => [f.id, i + 1]));
  /** The bracket's own lines: a Knockout's every line (as it always was), a League + Knockout's knockout stage (its rounds
   *  restart at 1, so a round's name is read among these alone, never beside the league's rounds). */
  const bracket = lk === null ? home.fixtures : home.fixtures.filter((f) => f.stage === "knockout");
  /** A knockout card's name ("Semi-final", "Semi-final 2", "Final"); a bye is not a match and has none. */
  const roundName = (f: QuickMatchFixture): string => {
    const { role, count, index } = placeOf(f, bracket);
    return say(fixtureLabel(role, f.roundNo, count, index));
  };
  const listOf = (names: readonly string[]) =>
    new Intl.ListFormat(copy.locale, { style: "long", type: "conjunction" }).format(names);

  const seat = (f: QuickMatchFixture, side: QuickMatchSide | null, label: unknown): SeatView => {
    const winner = side !== null && !f.isBye && f.phase === "settled" && side.entrantId === f.winnerEntrantId;
    if (side !== null) return { name: side.name, label: side.name, winner };
    if (f.isBye) return { name: null, label: "", winner: false };
    // The feeder in the setup preview's words (`winnerOfLabel`): the list and the draw say the same thing.
    const feeder = feederOf(label, home.fixtures);
    const { role, count, index } = placeOf(feeder, home.fixtures);
    return { name: null, label: say(winnerOfLabel(role, count, index, matchNo.get(feeder.id)!)), winner: false };
  };

  // A League + Knockout's tie and "Setting up" need no guard of their own here: the league is done and no knockout seat
  // holds a side yet, so the read has nothing next (T5) and the question or the wait stands in the hero's place (§6, §11).
  const heroFixture = home.finished ? null : home.next;
  // The confirm sheet's body (plan 4 D6): skipping a match now finishes the league exactly when every OTHER match is played
  // or Not played, the one finished predicate asked one Not played ahead; then the sheet says it cannot be put back. A
  // League + Knockout asks it of its league's own lines (D8): its knockout's are never skipped.
  const skipCounts = lk !== null ? lk.league : home;
  const skipFinishes = isQuickMatchFinished({ played: skipCounts.played, notPlayed: skipCounts.notPlayed + 1, total: skipCounts.total });
  /** Put back is hidden once the league has finished (§6): a League + Knockout's league, else the match itself. */
  const leagueOver = lk !== null ? lk.league.done : home.finished;
  /** The partial line (D6): a live match's score that will not count, quoted only once a score stands (`scoreStands`); a
   *  live match with nothing scored yet says it has started (FR4 m1). Nothing for a match not in play, or one whose summary
   *  this reader cannot split. */
  const partialOf = (f: QuickMatchFixture): string | null => {
    if (f.phase !== "live") return null;
    const line = scoreLineOf(f.summary);
    if (line === null) return null;
    return scoreStands(line, f.summary)
      ? t("quickMatch.skip.partial", { score: compactScore(line, copy.levels) })
      : t("quickMatch.skip.started");
  };
  const skipCopyOf = (f: QuickMatchFixture, home_: SeatView, away: SeatView): SkipCopy => ({
    title: t("quickMatch.skip.title", { home: home_.label, away: away.label }),
    body: t(skipFinishes ? "quickMatch.skip.bodyLast" : "quickMatch.skip.body"),
    partial: partialOf(f),
  });
  const matches: MatchView[] = home.fixtures
    // A League + Knockout's list is its league's: the knockout's lines are the bracket's cards (mockup qmd13a01 §7).
    .filter((f) => !f.isBye && (lk === null || f.stage === "league"))
    .map((f) => {
      const result =
        f.phase !== "settled" || f.home === null || f.away === null
          ? null
          : f.winnerEntrantId === f.home.entrantId
            ? t("quickMatch.home.result", { winner: f.home.name, loser: f.away.name })
            : f.winnerEntrantId === f.away.entrantId
              ? t("quickMatch.home.result", { winner: f.away.name, loser: f.home.name })
              : f.status === "decided"
                ? t("quickMatch.home.drawn", { a: f.home.name, b: f.away.name })
                : null;
      const homeSeat = seat(f, f.home, f.homeSlotLabel);
      const awaySeat = seat(f, f.away, f.awaySlotLabel);
      // Spec §6: only an unplayed or in-progress match is skippable, and only a league's (P12: a bracket needs a winner).
      const skippable = !knockout && f.stage === "league" && (f.phase === "ready" || f.phase === "live");
      return {
        id: f.id,
        n: matchNo.get(f.id)!,
        phase: f.phase,
        home: homeSeat,
        away: awaySeat,
        score: scoreText(f, home.sport.key, copy.levels),
        result,
        next: heroFixture !== null && heroFixture.id === f.id,
        // A settled match the pad will reopen (A-M6): not one whose result has already moved the match on.
        editable: f.phase === "settled" && !f.resultMovedOn,
        skippable,
        // §6: Put back is hidden once the league has finished (the server refuses a stale one, LEAGUE_FINISHED).
        putBack: !knockout && f.stage === "league" && f.phase === "notPlayed" && !leagueOver,
        skipCopy: skippable ? skipCopyOf(f, homeSeat, awaySeat) : null,
      };
    });

  let hero: Built["hero"] = null;
  if (heroFixture !== null && heroFixture.home !== null && heroFixture.away !== null) {
    const live = heroFixture.phase === "live";
    const n = matchNo.get(heroFixture.id)!;
    // A League + Knockout's league match counts among the league's matches only (D8: "match 3 of 6"); its knockout's is
    // named by its round, as a Knockout's is (§6: "Semi-final 1").
    const kicker =
      knockout || heroFixture.stage === "knockout"
        ? t(live ? "quickMatch.home.liveRound" : "quickMatch.home.upNextRound", { round: roundName(heroFixture) })
        : t(live ? "quickMatch.home.liveMatch" : "quickMatch.home.upNext", { n, total: lk !== null ? lk.league.total : home.total });
    hero = {
      kicker,
      home: heroFixture.home.name,
      away: heroFixture.away.name,
      score: live ? scoreText(heroFixture, home.sport.key, copy.levels) : null,
      fixture: { id: heroFixture.id, live },
    };
  }

  const nameOf = (entrantId: string) => {
    const side = home.sides.find((s) => s.entrantId === entrantId);
    if (!side) throw new QuickMatchHomeShapeError(`the table names an entrant the quick match does not hold (${entrantId})`);
    return side.name;
  };

  let standings: StandingsView | null = null;
  let leaders: string[] = [];
  /** The table's rank-1 side, on a table some match has reached (a League + Knockout's champion "top of the league too"). */
  let tableTop: string | null = null;
  if (!knockout && home.standings) {
    const rows = home.standings.rows as {
      entrantId: string;
      played: number;
      won: number;
      drawn: number;
      points: number;
      rank?: number;
      level?: boolean;
      tieUnbroken?: boolean;
      tieBreak?: { with?: string[] };
    }[];
    // The engine's level semantics, as the public table reads them: a table no counted fixture has reached is LEVEL
    // (`isLevelTable`: every row `level`; the producer still stores positional ranks), so it has no leader and every place
    // prints the level dash (`rankText`). Otherwise the top is the rank-1 row and every row its tie is still unbroken
    // with (a tie split only by seed or lots is a tie): co-leaders, who share the top place.
    const level = isLevelTable(rows);
    const top = level ? undefined : rows.find((r) => r.rank === 1);
    tableTop = top?.entrantId ?? null;
    // A League + Knockout's table names no leader (its winner is the final's): its marks are who goes through (`lkRows`).
    leaders = top && lk === null ? [top.entrantId, ...(top.tieUnbroken ? (top.tieBreak?.with ?? []) : [])] : [];
    const draws = rows.some((r) => r.drawn > 0);
    const columns = (["played", "won", ...(draws ? (["drawn"] as const) : []), "points"] as const).map((key) => ({
      key,
      abbr: copy.pub(`table.abbr.${key}`),
      word: copy.pub(`table.col.${key}`),
    }));
    // The fold, only where the public table shows more than the short one does (P, W, D, Pts): its rows are the short
    // table's, in the same order, each with the public table's cells for that entrant.
    const shortKeys = new Set<string>(columns.map((c) => c.key));
    const full: StandingsView["full"] =
      fullTable === null || fullTable.columns.every((c) => shortKeys.has(c.key))
        ? null
        : {
            label: t("quickMatch.home.fullTable"),
            regionLabel: copy.pub("table.regionCaptioned", { caption: t("quickMatch.home.fullTable") }),
            columns: fullTable.columns,
            cells: rows.map((r) => {
              const cells = Object.hasOwn(fullTable.cells, r.entrantId) ? fullTable.cells[r.entrantId]! : undefined;
              if (cells === undefined || cells.length !== fullTable.columns.length) {
                throw new QuickMatchHomeShapeError(`the full table has no row of ${fullTable.columns.length} cells for entrant ${r.entrantId}`);
              }
              return cells;
            }),
          };
    const plainRows = rows.map((r) => ({
      entrantId: r.entrantId,
      place: top && leaders.includes(r.entrantId) ? rankText(top, false) : rankText(r, level),
      name: nameOf(r.entrantId),
      cells: columns.map((c) => (c.key === "points" ? pointsText(r.points, home.pointsUnit) : String(r[c.key]))),
      leader: leaders.includes(r.entrantId),
    }));
    const marked = lk === null ? null : lkRows(lk.ko, rows, plainRows, level, bracket, home.sides, t);
    standings = {
      // A finished league's table is final (mockup qmd13a01 §4); with a match Not played it says it counts played ones only.
      // A League + Knockout's is final once its league is done and nothing is left to ask (§12, mockup §9-12).
      title: t(
        lk !== null
          ? lk.ko.state === "filled" || lk.ko.state === "settingUp"
            ? "quickMatch.home.finalLeagueTable"
            : "quickMatch.home.standings"
          : home.finished
            ? "quickMatch.home.finalTable"
            : "quickMatch.home.standings",
      ),
      ...(lk !== null
        ? { caption: t(lk.ko.filled ? "quickMatch.home.wentThrough" : "quickMatch.home.goThrough", { count: lk.ko.qualifiers }) }
        : {}),
      note: home.notPlayed > 0 ? t("quickMatch.home.countsPlayedOnly") : null,
      rankLabel: t("ladder.rank"),
      sideLabel: t("quickMatch.home.sideCol"),
      levelLabel: level ? copy.pub("table.level") : null,
      columns,
      full: full === null || marked === null ? full : { ...full, cells: marked.order.map((i) => full.cells[i]!) },
      rows: marked === null ? plainRows : marked.rows,
    };
  }

  let winner: Built["winner"] = null;
  let noPlay: Built["noPlay"] = null;
  let champion: Built["champion"] = null;
  if (lk !== null) {
    // The champion is the final's winner (D8), never the table's leader: the read names it once the final is decided.
    if (home.champion !== null) {
      const { entrantId, finalFixtureId } = home.champion;
      const final = bracket.find((f) => f.id === finalFixtureId);
      if (!final || final.home === null || final.away === null) {
        throw new QuickMatchHomeShapeError(`the champion's final ${finalFixtureId} is not a seated line of this knockout`);
      }
      const loser = final.home.entrantId === entrantId ? final.away : final.away.entrantId === entrantId ? final.home : null;
      if (loser === null) throw new QuickMatchHomeShapeError(`the champion ${entrantId} did not play the final ${final.id}`);
      const score = settledScore(final, home.sport.key);
      champion = {
        kicker: t("quickMatch.home.champion"),
        name: nameOf(entrantId),
        beat: score === null ? null : t("quickMatch.home.championBeat", { loser: loser.name, score }),
        topToo: tableTop === entrantId ? t("quickMatch.home.championTopToo") : null,
      };
    }
  } else if (home.finished) {
    if (knockout) {
      const final = home.fixtures.find((f) => f.isFinal);
      if (final?.winnerEntrantId) winner = { kicker: t("quickMatch.home.winner"), names: [nameOf(final.winnerEntrantId)], note: null };
    } else if (home.played === 0) {
      // Spec §3 Edge: every match Not played. No winner, and no table (its every row would read 0, its order meaningless).
      noPlay = {
        kicker: t("quickMatch.home.leagueFinished"),
        title: t("quickMatch.home.noPlay"),
        hint: copy.plural("quickMatch.home.noPlayHint", home.total),
      };
      standings = null;
    } else if (leaders.length > 0) {
      winner = {
        kicker: t(leaders.length === 1 ? "quickMatch.home.winner" : "quickMatch.home.level"),
        names: leaders.map(nameOf),
        // A short league is never mistaken for a full one (mockup qmd13a01 §4): "Top of the table after 4 played matches.
        // 2 matches were not played."
        note:
          home.notPlayed > 0
            ? `${copy.plural("quickMatch.home.winnerAfter", home.played)} ${copy.plural("quickMatch.home.winnerSkipped", home.notPlayed)}`
            : null,
      };
    }
  }

  /** A League + Knockout's knockout seat (D7): what it waits on in words while empty ("1st in the league", "2nd in the
   *  league — to decide", "Winner of semi-final 1"); once a side sits in a league seat, its rank beside the name ("1st",
   *  "2nd · by lot") until the match is played. */
  const lkSeat = (f: QuickMatchFixture, s: QuickMatchSide | null, wait: QuickMatchKnockoutSeat, byLot: readonly string[]): DrawSeat => {
    const won = s !== null && f.phase === "settled" && s.entrantId === f.winnerEntrantId;
    if (wait.from === "league") {
      if (s === null) {
        const words = t(rankKey(LEAGUE_RANK_KEY, wait.rank));
        return { name: null, label: wait.toDecide ? t("quickMatch.home.toDecide", { seat: words }) : words, winner: false };
      }
      const rank = t(rankKey(RANK_SHORT_KEY, wait.rank));
      if (f.phase === "settled") return { name: s.name, label: s.name, winner: won };
      return { name: s.name, label: s.name, winner: won, note: byLot.includes(s.entrantId) ? `${rank} · ${t("quickMatch.home.byLotShort")}` : rank };
    }
    if (s !== null) return { name: s.name, label: s.name, winner: won };
    const feeder = bracket.find((x) => x.id === wait.fixtureId);
    if (!feeder) throw new QuickMatchHomeShapeError(`a knockout seat waits on ${wait.fixtureId}, which is no line of this knockout`);
    const { role, count, index } = placeOf(feeder, bracket);
    return { name: null, label: say(winnerOfLabel(role, count, index, matchNo.get(feeder.id)!)), winner: false };
  };

  let draw: Built["draw"] = null;
  if (knockout || lk !== null) {
    const byRound = new Map<number, DrawCard[]>();
    for (const f of bracket) {
      // Settled: the score sits on the winner's line, read winner first (the mockup's card); live: under both seats.
      const settled = !f.isBye && f.phase === "settled" ? settledScore(f, home.sport.key) : null;
      const withScore = (s: DrawSeat): DrawSeat => (s.winner && settled !== null ? { ...s, score: settled } : s);
      const seats = lk !== null ? f.knockoutSeats : null;
      if (lk !== null && seats === null) throw new QuickMatchHomeShapeError(`the knockout line ${f.id} names no seats`);
      const homeSeat = withScore(seats ? lkSeat(f, f.home, seats.home, lk!.ko.byLot) : seat(f, f.home, f.homeSlotLabel));
      const awaySeat = withScore(seats ? lkSeat(f, f.away, seats.away, lk!.ko.byLot) : seat(f, f.away, f.awaySlotLabel));
      const onWinnerLine = homeSeat.score !== undefined || awaySeat.score !== undefined;
      // A bye's card lists the side going through first, then the bye.
      const [first, second] = f.isBye && f.home === null ? [awaySeat, homeSeat] : [homeSeat, awaySeat];
      const card: DrawCard = {
        id: f.id,
        round: f.isBye ? null : roundName(f),
        bye: f.isBye,
        isFinal: f.isFinal,
        live: f.phase === "live",
        home: first,
        away: second,
        score: f.phase === "live" ? scoreText(f, home.sport.key, copy.levels) : onWinnerLine ? null : settled,
        // A League + Knockout's cards carry what its list rows would (the list is the league's): the hero's edge, Score on a
        // match to play, Edit result on a settled one the pad will reopen. Never Not played (a bracket needs a winner).
        ...(lk !== null
          ? {
              next: heroFixture !== null && heroFixture.id === f.id,
              play: f.phase === "ready" || f.phase === "live" ? { live: f.phase === "live" } : null,
              edit: f.phase === "settled" && !f.resultMovedOn,
            }
          : {}),
      };
      byRound.set(f.roundNo, [...(byRound.get(f.roundNo) ?? []), card]);
    }
    const rounds = [...byRound.entries()].sort(([a], [b]) => a - b).map(([roundNo, cards]) => ({ roundNo, cards }));
    draw =
      lk !== null
        ? {
            title: t("quickMatch.home.knockout"),
            rounds,
            leagueKnockout: {
              caption:
                lk.ko.state === "league"
                  ? t("quickMatch.home.knockoutFills")
                  : lk.ko.state === "tie"
                    ? t("quickMatch.home.knockoutWaiting")
                    : null,
            },
          }
        : { title: t("quickMatch.home.draw"), rounds, leagueKnockout: null };
  }

  // "Add a match" (C5, Task 8): the decider a level top asks for, so its selects open at the table's top two, in the
  // stored table's own order (the producer ranks it); before there is a table, at the first two sides as typed.
  let addMatch: Built["addMatch"] = null;
  // A League + Knockout's league takes no match once it is complete (§6, D3: its knockout fills, or asks, from that league).
  if (!knockout && home.sides.length >= 2 && !(lk !== null && lk.league.done)) {
    const ranked = ((home.standings?.rows ?? []) as { entrantId: string }[]).map((r) => r.entrantId);
    const [first, second] = ranked.length >= 2 ? ranked : home.sides.map((s) => s.entrantId);
    addMatch = { sides: home.sides.map((s) => ({ id: s.entrantId, name: s.name })), home: first!, away: second! };
  }

  // The tie at the cut (§5, §11): the hero's question while it is open. Its sides are named in the order the guests typed
  // them, never the lot's; "Tie for 2nd: Ines and Mika" for two, "Tie for 1st: 3 sides, 2 places" for more (pick N of M).
  let cut: Built["cut"] = null;
  let settingUp: Built["settingUp"] = null;
  let cutResult: Built["cutResult"] = null;
  if (lk !== null) {
    const { ko } = lk;
    if (ko.state === "tie") {
      const tie = ko.tie;
      if (tie === null) throw new QuickMatchHomeShapeError("the knockout asks about a tie at the cut, but names none");
      const members = home.sides.filter((s) => tie.entrantIds.includes(s.entrantId));
      if (members.length !== tie.entrantIds.length) {
        throw new QuickMatchHomeShapeError(`the tie at the cut names a side the quick match does not hold (${tie.entrantIds.join(", ")})`);
      }
      const place = t(rankKey(RANK_SHORT_KEY, tie.place));
      cut = {
        kicker: copy.plural("quickMatch.cut.kicker", tie.seats),
        title:
          members.length === 2
            ? t("quickMatch.cut.title", { place, names: listOf(members.map((m) => m.name)) })
            : copy.plural("quickMatch.cut.titleMany", tie.seats, { place, sides: members.length }),
        body: t("quickMatch.cut.body"),
        view: { members: members.map((m) => ({ id: m.entrantId, name: m.name })), seats: tie.seats, toss: tie.byLot },
      };
    } else if (ko.state === "settingUp") {
      settingUp = {
        kicker: t("quickMatch.home.leagueFinished"),
        title: t("quickMatch.home.settingUp"),
        hint: t("quickMatch.home.settingUpHint"),
      };
    } else if (ko.state === "filled" && !home.finished && ko.decision !== null) {
      // The answer, above the knockout's hero (mockup §9): the same names on every phone and every reload (§11).
      const names = listOf(ko.decision.through.map(nameOf));
      cutResult =
        ko.decision.how === "toss"
          ? [t("quickMatch.cut.tossResult", { names }), t("quickMatch.cut.tossBody")]
          : [t("quickMatch.cut.pickResult", { names })];
    }
  }

  // The played line keeps the whole match's N of M (D8, §12: league + knockout); a League + Knockout says how M splits
  // while its league is on, and that the knockout is on once it has filled.
  const playedText = playedLine(copy.plural, home, home.row.expiresAt === null || home.finished ? null : QUICK_MATCH_EXPIRY_DAYS);
  const stagePart =
    lk === null || home.finished
      ? null
      : lk.ko.state === "filled"
        ? t("quickMatch.home.stagePart.knockoutOn")
        : t("quickMatch.home.stagePart.split", { league: lk.league.total, knockout: home.total - lk.league.total });

  return {
    // The kind only where the guest chose it (the setup page shows its kind switch only then): "Chess · League".
    eyebrow: [t(home.sport.labelKey), ...(home.kindChosen ? [t(KIND_KEY[home.kind])] : []), t(FORMAT_KEY[home.row.format])].join(
      " · ",
    ),
    // A saved match has no expiry (plan 3 Task 2): it is kept until its owner deletes it, so its line carries no countdown (A-I3).
    // A finished one (plan 4, T4 review m1) carries none either: "deleted N days after the last score" names a clock the
    // guest no longer runs, and a league finished with nothing played has no score at all. Its deletion is still said, by
    // the dated "Not saved — deleted on …" line under Save. The Continue card and the account's list say the same words
    // (`playedLine`), without the countdown.
    played: stagePart === null ? playedText : `${playedText} · ${stagePart}`,
    hero,
    winner,
    noPlay,
    standings,
    draw,
    matches,
    matchesTitle: t(lk !== null ? "quickMatch.home.leagueMatches" : "quickMatch.home.all"),
    addMatch,
    cut,
    settingUp,
    cutResult,
    champion,
    knockoutFirst: lk !== null && lk.ko.state === "filled",
  };
}

/** A League + Knockout's two reads the view leans on, refused loudly when the read did not give them. */
function lkOf(home: QuickMatchHome): { ko: QuickMatchKnockout; league: NonNullable<QuickMatchHome["league"]> } | null {
  if (home.row.format !== "league_knockout") return null;
  if (home.knockout === null || home.league === null) {
    throw new QuickMatchHomeShapeError("a League + Knockout read with no knockout or no league counts");
  }
  return { ko: home.knockout, league: home.league };
}

type TableRowIn = { entrantId: string; rank?: number };
type ViewRow = StandingsView["rows"][number];

/**
 * A League + Knockout's table rows (D6, D9; mockup qmd13a01 §7-12), from the plain rows in the stored table's order:
 *   - who goes through, lime: once filled, the sides the knockout's league seats hold (the confirmed fill is the one
 *     authority); before, the top `qualifiers` by the table, less an open tie, less a tie settled by Pick but its picks;
 *   - an OPEN tie at the cut (D9): its rows read "=" and "level — to decide", in the order the guests typed them — never
 *     the lot's order, which the question has not revealed (§11);
 *   - a tie settled by PICK: "=" (the lot did not decide it), the picked first, marked "picked";
 *   - a tie the lot ordered (a toss, or sides who all go through, §5 case 2): their places, marked "decided by lot";
 *   - a dashed line at the cut, between the sides going through, an open tie and the rest.
 * A table no match has reached is level: no side is going anywhere yet, so nothing is marked until the knockout fills.
 * `order[i]` is the plain row each new row came from (the full table's cells follow it).
 */
function lkRows(
  ko: QuickMatchKnockout,
  stored: readonly TableRowIn[],
  plain: readonly ViewRow[],
  level: boolean,
  bracket: readonly QuickMatchFixture[],
  sides: readonly QuickMatchSide[],
  t: QuickMatchCopy["t"],
): { rows: ViewRow[]; order: number[] } {
  const open = new Set(ko.state === "tie" && ko.tie !== null ? ko.tie.entrantIds : []);
  const pickClass = new Set(ko.decision?.how === "pick" ? ko.decision.tie : []);
  const picked = new Set(ko.picked);
  const byLot = new Set(ko.byLot);
  const typed = new Map(sides.map((s, i) => [s.entrantId, i]));
  const rankOf = new Map(stored.map((r) => [r.entrantId, r.rank ?? Number.POSITIVE_INFINITY]));
  let through: Set<string>;
  if (ko.filled) {
    through = new Set(
      bracket.flatMap((f) =>
        (["home", "away"] as const).flatMap((at) => {
          const s = f[at];
          return s !== null && f.knockoutSeats?.[at].from === "league" ? [s.entrantId] : [];
        }),
      ),
    );
  } else {
    through = new Set(
      stored
        .filter((r) => (r.rank ?? Number.POSITIVE_INFINITY) <= ko.qualifiers && !open.has(r.entrantId) && !pickClass.has(r.entrantId))
        .map((r) => r.entrantId),
    );
    for (const id of picked) through.add(id);
  }

  // The display order: each open or picked class keeps its block of places, its rows reordered within it.
  const order = plain.map((_, i) => i);
  const reorder = (members: ReadonlySet<string>, key: (id: string) => number) => {
    const places = order.flatMap((row, place) => (members.has(plain[row]!.entrantId) ? [place] : []));
    const rowsIn = places.map((place) => order[place]!).sort((a, b) => key(plain[a]!.entrantId) - key(plain[b]!.entrantId) || a - b);
    places.forEach((place, k) => (order[place] = rowsIn[k]!));
  };
  if (open.size > 0) reorder(open, (id) => typed.get(id) ?? Number.POSITIVE_INFINITY);
  if (pickClass.size > 0) reorder(pickClass, (id) => (picked.has(id) ? 0 : 1) * 1e6 + (rankOf.get(id) ?? 0));

  // A level table (nothing counted yet) sends nobody anywhere, so no tint and no line, until the knockout fills: the fill is
  // the authority then, even over a league whose every match was Not played. A tie it asks about is marked either way.
  const marks = ko.filled || !level;
  const group = (id: string) => (open.has(id) ? 1 : through.has(id) ? 0 : 2);
  const rows = order.map((i, k): ViewRow => {
    const r = plain[i]!;
    const id = r.entrantId;
    const tag: ViewRow["tag"] = open.has(id)
      ? { text: t("quickMatch.home.levelToDecide"), kind: "toDecide" }
      : pickClass.has(id)
        ? picked.has(id)
          ? { text: t("quickMatch.home.picked"), kind: "picked" }
          : null
        : byLot.has(id)
          ? { text: t("quickMatch.home.byLot"), kind: "lot" }
          : null;
    const prev = k > 0 ? plain[order[k - 1]!]!.entrantId : null;
    return {
      ...r,
      ...(open.has(id) || pickClass.has(id) ? { place: "=", placeHidden: true } : {}),
      leader: false,
      through: marks && through.has(id),
      ...(open.has(id) ? { toDecide: true } : {}),
      ...(tag !== null ? { tag } : {}),
      ...(marks && prev !== null && group(prev) !== group(id) ? { cutAbove: true } : {}),
    };
  });
  return { rows, order };
}

// ── the page body ───────────────────────────────────────────────────────────────────────────────────────────────────

const LABEL = "app-display text-xs font-semibold tracking-[0.14em] text-[#b7aede]";

/**
 * What the actions row shows for Save (plan 3 Task 5): the form while nobody has saved the match, "Saved" for the account
 * that did, and nothing for anyone else (signed out included: the page cannot know it is theirs, and a saved match is no
 * longer anyone else's to save). `viewerId` is the signed-in account, or null.
 */
export type SaveState = "offer" | "saved" | "none";
export function saveStateFor(savedByUserId: string | null, viewerId: string | null): SaveState {
  if (savedByUserId === null) return "offer";
  return viewerId !== null && viewerId === savedByUserId ? "saved" : "none";
}

export function QuickMatchHomeView({
  home,
  copy,
  slots = {},
  flash = null,
  viewerId = null,
  fullTable = null,
}: {
  home: QuickMatchHome;
  copy: QuickMatchCopy;
  slots?: QuickMatchSlots;
  /** The public table's columns and cells for a league (`app/q/[token]/full-table.ts`): the "Full table" fold. */
  fullTable?: FullTableData | null;
  /** The `?e=` line (`homeFlash`), already in the viewer's words, and its tone; null for none. */
  flash?: { text: string; tone: HomeFlashTone } | null;
  /** The signed-in viewer's account id, or null: only read to tell the match's saver "Saved". */
  viewerId?: string | null;
}) {
  const { t } = copy;
  const v = buildHomeView(home, copy, fullTable);
  const save = saveStateFor(home.row.savedByUserId, viewerId);
  const drawNode = v.draw ? (
    <QuickMatchDraw
      title={v.draw.title}
      rounds={v.draw.rounds}
      byeLabel={t("bracket.slot.bye")}
      liveLabel={t("quickMatch.home.live")}
      leagueKnockout={
        v.draw.leagueKnockout ? { caption: v.draw.leagueKnockout.caption, score: slots.score, rowMenu: slots.rowMenu } : undefined
      }
    />
  ) : null;
  // Owner 2026-11-12: under Save, while nobody holds the match, the DAY it is deleted, from the row's own expiry, named in
  // the guest's own zone and never late (`deletion-line.tsx`, review I1). No expiry, no line: a match whose saver's account
  // was deleted is offered Save again (`saved_by_user_id` is ON DELETE SET NULL) but `expires_at` stays null, and nothing
  // will delete it.
  const saveNode =
    save === "offer" && slots.save ? (
      <div className="flex min-w-0 flex-col gap-1.5">
        {slots.save}
        {home.row.expiresAt !== null ? (
          <QuickMatchDeletionLine
            expiresAt={home.row.expiresAt.toISOString()}
            lang={copy.locale}
            line={t("quickMatch.home.notSaved")}
          />
        ) : null}
      </div>
    ) : save === "saved" ? (
      // "Saved", and the way to where the saver renames or deletes it (plan 3 Task 6, controller ruling): the account's Quick
      // matches. Its saver's only, as "Saved" is.
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <p
          data-testid="qm-saved"
          className="app-display inline-flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-lg bg-[rgb(163_230_53/0.1)] px-4 py-2 text-sm font-semibold text-[color:var(--mk-lime)]"
        >
          <Check aria-hidden="true" className="h-4 w-4 flex-none" strokeWidth={2.5} />
          <span className="min-w-0">{t("quickMatch.home.saved")}</span>
        </p>
        <a
          data-testid="qm-in-account"
          href={`${routes.me()}#${QUICK_MATCH_ACCOUNT_SECTION_ID}`}
          className="inline-flex min-h-11 min-w-0 items-center text-sm font-medium text-[#b7aede] underline decoration-[rgb(183_174_222/0.5)] underline-offset-4 [overflow-wrap:anywhere] hover:text-cream hover:decoration-cream"
        >
          {t("quickMatch.home.inAccount")}
        </a>
      </div>
    ) : null;
  return (
    <div className="min-h-screen bg-night text-cream">
      {gantry(t)}
      <main data-testid="qm-home" className="min-w-0">
        <div className="mx-auto grid w-full max-w-5xl min-w-0 gap-6 px-4 pb-10 pt-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-10 lg:pt-8">
          <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
            {/* First in the page: the redirect lands at the top, so the refusal is the first thing seen and read. */}
            {flash ? (
              <p
                role={flash.tone === "info" ? "status" : "alert"}
                data-testid="qm-flash"
                data-tone={flash.tone}
                className={`min-w-0 rounded-xl border px-3 py-2.5 text-sm leading-snug text-cream [overflow-wrap:anywhere] ${
                  flash.tone === "info"
                    ? "border-[rgb(183_174_222/0.45)] bg-[rgb(183_174_222/0.12)]"
                    : "border-[rgb(239_68_68/0.55)] bg-[rgb(239_68_68/0.14)]"
                }`}
              >
                {flash.text}
              </p>
            ) : null}
            <div className="min-w-0">
              <p data-testid="qm-eyebrow" className={`${LABEL} [overflow-wrap:anywhere]`}>
                {v.eyebrow}
              </p>
              <h1
                data-testid="qm-name"
                className="app-display mt-1 text-[1.75rem] font-bold leading-[1.1] text-cream [overflow-wrap:anywhere] lg:text-[2.25rem]"
              >
                {home.row.name}
              </h1>
              <p data-testid="qm-played" className="mt-1.5 text-[13px] leading-snug text-[#b7aede]">
                {v.played}
              </p>
            </div>
            {v.cutResult ? cutResultLine(v.cutResult) : null}
            {v.hero ? heroCard(v.hero, t, slots.score) : null}
            {v.cut ? cutCard(v.cut, slots.cut) : null}
            {v.settingUp ? settingUpCard(v.settingUp, slots.refresh) : null}
            {v.champion ? championCard(v.champion) : null}
            {v.winner ? winnerCard(v.winner) : null}
            {v.noPlay ? noPlayCard(v.noPlay, routes.quickMatchSetup(copy.locale), t("quickMatch.dead.startNew")) : null}
            {slots.share || saveNode ? (
              <div data-testid="qm-actions" className="flex min-w-0 flex-col gap-3">
                {slots.share ?? null}
                {saveNode}
              </div>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-col gap-6">
            {/* A League + Knockout's bracket moves above the table once it has filled (§12): it is what people watch. */}
            {v.knockoutFirst ? drawNode : null}
            {v.standings ? <QuickMatchStandings view={v.standings} /> : null}
            {v.knockoutFirst ? null : drawNode}
            {v.matches.length > 0 ? (
              <QuickMatchList
                title={v.matchesTitle}
                matches={v.matches}
                versus={t("quickMatch.home.versus")}
                waits={t("quickMatch.home.waits")}
                liveLabel={t("quickMatch.home.live")}
                notPlayedLabel={t("quickMatch.home.notPlayed")}
                score={slots.score}
                rowMenu={slots.rowMenu}
              />
            ) : null}
            {v.addMatch && slots.addMatch ? <div className="min-w-0">{slots.addMatch(v.addMatch)}</div> : null}
            <p data-testid="qm-anyone" className="text-xs text-[#8d7fc0]">
              {t("quickMatch.home.anyoneCanScore")}
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

// Plain functions, not components: the page's element tree then holds what they render (the score page's `scanColumn`
// convention), so the server render and its test both see it.

/** The quick match pages' header bar: the wordmark and "Quick match". Exported for the save page (plan 3 Task 5). */
export function gantry(t: QuickMatchCopy["t"]): ReactNode {
  return (
    <header className="border-b border-[#2a1c5c] bg-night-2">
      <div className="mx-auto flex w-full max-w-5xl min-w-0 items-center gap-3 px-4 py-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- the static wordmark, as the pad's own header paints it */}
        <img src="/logo-wide-night.png" alt="Seazn Club" width={96} height={24} className="h-6 w-auto flex-none" />
        <span className="app-display truncate text-sm font-semibold tracking-[0.08em] text-[#b7aede]">
          {t("quickMatch.home.title")}
        </span>
      </div>
    </header>
  );
}

function heroCard(hero: NonNullable<Built["hero"]>, t: QuickMatchCopy["t"], score?: ScoreSlot): ReactNode {
  const live = hero.fixture.live;
  return (
    <section
      data-testid="qm-hero"
      aria-labelledby="qm-hero-kicker"
      className="min-w-0 rounded-2xl border border-[color:var(--mk-lime)] bg-night-2 p-4 shadow-[0_0_0_1px_rgba(163,230,53,0.12),0_18px_40px_-24px_rgba(163,230,53,0.45)]"
    >
      <p
        id="qm-hero-kicker"
        data-testid="qm-hero-kicker"
        className="app-display flex min-w-0 items-center gap-2 text-sm font-semibold tracking-[0.06em] text-[color:var(--mk-lime)]"
      >
        {live ? (
          <span aria-hidden="true" className="h-2 w-2 flex-none rounded-full bg-[color:var(--mk-live)] motion-safe:animate-pulse" />
        ) : null}
        <span className="min-w-0 [overflow-wrap:anywhere]">{hero.kicker}</span>
      </p>
      <div className="app-display mt-2 flex min-w-0 flex-col gap-1 text-[1.6rem] font-bold leading-[1.1] text-cream">
        <span data-testid="qm-hero-home" className="min-w-0 [overflow-wrap:anywhere]">
          {hero.home}
        </span>
        {live && hero.score !== null ? (
          <span data-testid="qm-hero-score" className="text-lg tabular-nums tracking-[0.04em] text-[color:var(--mk-lime)]">
            {hero.score}
          </span>
        ) : (
          <span className="text-base font-semibold text-[#b7aede]">{t("quickMatch.home.versus")}</span>
        )}
        <span data-testid="qm-hero-away" className="min-w-0 [overflow-wrap:anywhere]">
          {hero.away}
        </span>
      </div>
      {score ? <div className="mt-4 min-w-0">{score(hero.fixture, "hero")}</div> : null}
    </section>
  );
}

/** The tie at the cut, as the hero (plan 5 T7, spec §5, mockup qmd13a01 §8): orange where the hero is lime, so a question
 *  never reads as a match to play. The answers are the page's (`cut` slot: the Pick panel and the Toss form). */
function cutCard(cut: NonNullable<Built["cut"]>, slot?: CutSlot): ReactNode {
  return (
    <section
      data-testid="qm-cut"
      aria-labelledby="qm-cut-title"
      className="min-w-0 rounded-2xl border border-[color:var(--mk-orange)] bg-night-2 p-4 shadow-[0_0_0_1px_rgba(251,146,60,0.12),0_18px_40px_-24px_rgba(251,146,60,0.5)]"
    >
      <p
        data-testid="qm-cut-kicker"
        className="app-display text-sm font-semibold tracking-[0.06em] text-[color:var(--mk-orange)] [overflow-wrap:anywhere]"
      >
        {cut.kicker}
      </p>
      <h2
        id="qm-cut-title"
        data-testid="qm-cut-title"
        className="app-display mt-2 text-[1.6rem] font-bold leading-[1.1] text-cream [overflow-wrap:anywhere]"
      >
        {cut.title}
      </h2>
      <p data-testid="qm-cut-body" className="mt-2 text-sm leading-snug text-[#d9d2f2] [overflow-wrap:anywhere]">
        {cut.body}
      </p>
      {slot ? <div className="mt-4 min-w-0">{slot(cut.view)}</div> : null}
    </section>
  );
}

/** The league is done and the knockout not filled yet (spec §11, mockup qmd13a01 §12): what is happening, and a Refresh —
 *  every load retries the fill. A calm card: there is nothing to tap but Refresh. */
function settingUpCard(card: NonNullable<Built["settingUp"]>, refresh?: ReactNode): ReactNode {
  return (
    <section
      data-testid="qm-setting-up"
      aria-labelledby="qm-setting-up-title"
      className="min-w-0 rounded-2xl border border-[#3b2a6e] bg-night-2 p-4"
    >
      <p data-testid="qm-setting-up-kicker" className="app-display text-sm font-semibold tracking-[0.06em] text-[#b7aede]">
        {card.kicker}
      </p>
      <h2
        id="qm-setting-up-title"
        data-testid="qm-setting-up-title"
        className="app-display mt-1.5 text-[1.6rem] font-bold leading-[1.1] text-cream [overflow-wrap:anywhere]"
      >
        {card.title}
      </h2>
      <p data-testid="qm-setting-up-hint" className="mt-2 text-sm leading-snug text-[#d9d2f2] [overflow-wrap:anywhere]">
        {card.hint}
      </p>
      {refresh ? <div className="mt-4 min-w-0">{refresh}</div> : null}
    </section>
  );
}

/** "Setting up the knockout"'s Refresh: a plain link to the home's own path (`routes.quickMatch(token)`, built by the page),
 *  so it works with no script and the load it starts retries the fill. The path holds the home token (O3): no capture. */
export function QuickMatchRefreshLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      data-testid="qm-refresh"
      href={href}
      className="ph-no-capture app-display inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-[#4a3a80] px-5 py-2.5 text-center text-base font-semibold leading-tight text-cream hover:border-[#6b5aa6] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream"
    >
      <RotateCw aria-hidden="true" className="h-4 w-4 flex-none" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
    </a>
  );
}

/** How the tie at the cut was settled (§11, mockup qmd13a01 §9), above the knockout's hero once it has filled. */
function cutResultLine(lines: readonly string[]): ReactNode {
  return (
    <div
      data-testid="qm-cut-result"
      className="min-w-0 rounded-xl border border-[rgb(183_174_222/0.35)] bg-[rgb(183_174_222/0.08)] px-3 py-2.5 text-sm leading-snug text-[#d9d2f2] [overflow-wrap:anywhere]"
    >
      {lines.map((line, i) => (
        <p key={i} className={i === 0 ? "font-semibold text-cream" : "mt-1"}>
          {line}
        </p>
      ))}
    </div>
  );
}

/** The champion (D8, mockup qmd13a01 §11): the final's winner, who they beat and by what, and whether they topped the
 *  league too. The one trophy on the page. */
function championCard(champion: NonNullable<Built["champion"]>): ReactNode {
  return (
    <section
      data-testid="qm-champion"
      aria-labelledby="qm-champion-kicker"
      className="min-w-0 rounded-2xl border border-[color:var(--mk-lime)] bg-night-2 p-4 shadow-[0_0_0_1px_rgba(163,230,53,0.12),0_18px_40px_-24px_rgba(163,230,53,0.45)]"
    >
      <p
        id="qm-champion-kicker"
        data-testid="qm-champion-kicker"
        className="app-display flex min-w-0 items-center gap-2 text-sm font-semibold tracking-[0.06em] text-[color:var(--mk-lime)]"
      >
        <Trophy aria-hidden="true" className="h-4 w-4 flex-none" strokeWidth={2.25} />
        <span className="min-w-0 [overflow-wrap:anywhere]">{champion.kicker}</span>
      </p>
      <p
        data-testid="qm-champion-name"
        className="app-display mt-2 text-[2rem] font-bold leading-[1.05] text-cream [overflow-wrap:anywhere]"
      >
        {champion.name}
      </p>
      {champion.beat !== null || champion.topToo !== null ? (
        <p data-testid="qm-champion-beat" className="mt-2 text-sm leading-snug text-[#d9d2f2] [overflow-wrap:anywhere]">
          {[champion.beat, champion.topToo].filter((x) => x !== null).join(" ")}
        </p>
      ) : null}
    </section>
  );
}

function winnerCard(winner: NonNullable<Built["winner"]>): ReactNode {
  return (
    <section
      data-testid="qm-winner"
      aria-labelledby="qm-winner-kicker"
      className="min-w-0 rounded-2xl border border-[color:var(--mk-lime)] bg-night-2 p-4"
    >
      <p
        id="qm-winner-kicker"
        data-testid="qm-winner-kicker"
        className="app-display text-sm font-semibold tracking-[0.06em] text-[color:var(--mk-lime)]"
      >
        {winner.kicker}
      </p>
      <ul className="mt-2 flex min-w-0 flex-col gap-1">
        {/* Keyed by place, never by name: side names are not unique, so two co-leaders can share one (final review A m-2).
            The list is rendered once per request and never reorders. */}
        {winner.names.map((name, i) => (
          <li
            key={i}
            data-testid="qm-winner-name"
            className="app-display text-[1.75rem] font-bold leading-[1.1] text-cream [overflow-wrap:anywhere]"
          >
            {name}
          </li>
        ))}
      </ul>
      {winner.note !== null ? (
        <p data-testid="qm-winner-note" className="mt-2 text-sm leading-snug text-[#d9d2f2] [overflow-wrap:anywhere]">
          {winner.note}
        </p>
      ) : null}
    </section>
  );
}

/** Finished with nothing played (plan 4, spec §3 Edge, mockup qmd13a01 §5): the league is over and names no winner; the
 *  way on is a new quick match, on the viewer's own setup page (the dead link's words: the same action). */
function noPlayCard(noPlay: NonNullable<Built["noPlay"]>, startHref: string, startLabel: string): ReactNode {
  return (
    <section
      data-testid="qm-no-play"
      aria-labelledby="qm-no-play-title"
      className="min-w-0 rounded-2xl border border-[#3b2a6e] bg-night-2 p-4"
    >
      <p data-testid="qm-no-play-kicker" className="app-display text-sm font-semibold tracking-[0.06em] text-[#b7aede]">
        {noPlay.kicker}
      </p>
      <h2
        id="qm-no-play-title"
        data-testid="qm-no-play-title"
        className="app-display mt-1.5 text-[1.6rem] font-bold leading-[1.1] text-cream [overflow-wrap:anywhere]"
      >
        {noPlay.title}
      </h2>
      <p data-testid="qm-no-play-hint" className="mt-2 text-sm leading-snug text-[#d9d2f2] [overflow-wrap:anywhere]">
        {noPlay.hint}
      </p>
      <a
        data-testid="qm-no-play-start"
        href={startHref}
        className="app-display mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-xl border border-[color:var(--mk-lime)] px-5 py-2.5 text-center text-base font-bold leading-tight text-[color:var(--mk-lime)] hover:bg-[rgb(163_230_53/0.08)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream"
      >
        {startLabel}
      </a>
    </section>
  );
}

// ── the dead link ───────────────────────────────────────────────────────────────────────────────────────────────────

/** An unknown, malformed, changed, expired or deleted home token (§5, Review Focus 3): one screen for all of them, so the
 *  page never says which. Its own test id (`qm-dead-link`), never the pad's `scan-dead-link`. */
export function QuickMatchDead({ locale, t }: { locale: Locale; t: QuickMatchCopy["t"] }) {
  return (
    <div className="flex min-h-screen flex-col bg-night text-cream">
      {gantry(t)}
      <main className="flex min-w-0 flex-1 flex-col">
        <section
          data-testid="qm-dead-link"
          aria-labelledby="qm-dead-title"
          className="mx-auto flex w-full max-w-md min-w-0 flex-1 flex-col items-start justify-center gap-3 px-6 py-12"
        >
          <h1 id="qm-dead-title" data-testid="qm-dead-title" className="app-display text-2xl font-bold leading-tight text-cream">
            {t("quickMatch.dead.title")}
          </h1>
          <p data-testid="qm-dead-hint" className="text-sm leading-relaxed text-[#b7aede]">
            {t("quickMatch.dead.hint", { days: QUICK_MATCH_EXPIRY_DAYS })}
          </p>
          <a
            data-testid="qm-dead-start"
            href={routes.quickMatchSetup(locale)}
            className="app-display mt-2 inline-flex min-h-11 max-w-full items-center justify-center rounded-xl bg-[color:var(--mk-lime)] px-5 py-2.5 text-center text-base font-bold leading-tight text-night focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream"
          >
            {t("quickMatch.dead.startNew")}
          </a>
        </section>
      </main>
    </div>
  );
}
