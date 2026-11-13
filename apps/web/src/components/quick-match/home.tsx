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
import type { ReactNode } from "react";
import { Check } from "lucide-react";
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
import { scoreLineOf, type LevelWords } from "@/lib/score/levels";
import { setBreakdown } from "@/lib/public-site";
import { isQuickMatchFinished } from "@/lib/quick-match-finished";
import type { QuickMatchFixture, QuickMatchHome, QuickMatchSide } from "@/server/usecases/quick-match-home";
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
}

const KIND_KEY = {
  individual: "quickMatch.kind.individual",
  pair: "quickMatch.kind.pair",
  team: "quickMatch.kind.team",
} as const satisfies Record<EntrantKind, MessageKey>;

const FORMAT_KEY = {
  league: "quickMatch.format.league",
  knockout: "quickMatch.format.knockout",
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
  draw: DrawRound[] | null;
  matches: MatchView[];
  /** A league's "Add a match" (C5); null for a knockout, and for a quick match with fewer than two sides to pick. */
  addMatch: AddMatchView | null;
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
  const matchNo = new Map(home.fixtures.filter((f) => !f.isBye).map((f, i) => [f.id, i + 1]));
  /** A knockout card's name ("Semi-final", "Semi-final 2", "Final"); a bye is not a match and has none. */
  const roundName = (f: QuickMatchFixture): string => {
    const { role, count, index } = placeOf(f, home.fixtures);
    return say(fixtureLabel(role, f.roundNo, count, index));
  };

  const seat = (f: QuickMatchFixture, side: QuickMatchSide | null, label: unknown): SeatView => {
    const winner = side !== null && !f.isBye && f.phase === "settled" && side.entrantId === f.winnerEntrantId;
    if (side !== null) return { name: side.name, label: side.name, winner };
    if (f.isBye) return { name: null, label: "", winner: false };
    // The feeder in the setup preview's words (`winnerOfLabel`): the list and the draw say the same thing.
    const feeder = feederOf(label, home.fixtures);
    const { role, count, index } = placeOf(feeder, home.fixtures);
    return { name: null, label: say(winnerOfLabel(role, count, index, matchNo.get(feeder.id)!)), winner: false };
  };

  const heroFixture = home.finished ? null : home.next;
  // The confirm sheet's body (plan 4 D6): skipping a match now finishes the league exactly when every OTHER match is played
  // or Not played, the one finished predicate asked one Not played ahead; then the sheet says it cannot be put back.
  const skipFinishes = isQuickMatchFinished({ played: home.played, notPlayed: home.notPlayed + 1, total: home.total });
  const skipCopyOf = (f: QuickMatchFixture, home_: SeatView, away: SeatView): SkipCopy => {
    const live = f.phase === "live" ? scoreText(f, home.sport.key, copy.levels) : null;
    return {
      title: t("quickMatch.skip.title", { home: home_.label, away: away.label }),
      body: t(skipFinishes ? "quickMatch.skip.bodyLast" : "quickMatch.skip.body"),
      partial: live === null ? null : t("quickMatch.skip.partial", { score: live }),
    };
  };
  const matches: MatchView[] = home.fixtures
    .filter((f) => !f.isBye)
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
      const skippable = !knockout && (f.phase === "ready" || f.phase === "live");
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
        putBack: !knockout && f.phase === "notPlayed" && !home.finished,
        skipCopy: skippable ? skipCopyOf(f, homeSeat, awaySeat) : null,
      };
    });

  let hero: Built["hero"] = null;
  if (heroFixture !== null && heroFixture.home !== null && heroFixture.away !== null) {
    const live = heroFixture.phase === "live";
    const n = matchNo.get(heroFixture.id)!;
    const kicker = knockout
      ? t(live ? "quickMatch.home.liveRound" : "quickMatch.home.upNextRound", { round: roundName(heroFixture) })
      : t(live ? "quickMatch.home.liveMatch" : "quickMatch.home.upNext", { n, total: home.total });
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
    leaders = top ? [top.entrantId, ...(top.tieUnbroken ? (top.tieBreak?.with ?? []) : [])] : [];
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
    standings = {
      // A finished league's table is final (mockup qmd13a01 §4); with a match Not played it says it counts played ones only.
      title: t(home.finished ? "quickMatch.home.finalTable" : "quickMatch.home.standings"),
      note: home.notPlayed > 0 ? t("quickMatch.home.countsPlayedOnly") : null,
      rankLabel: t("ladder.rank"),
      sideLabel: t("quickMatch.home.sideCol"),
      levelLabel: level ? copy.pub("table.level") : null,
      columns,
      full,
      rows: rows.map((r) => ({
        entrantId: r.entrantId,
        place: top && leaders.includes(r.entrantId) ? rankText(top, false) : rankText(r, level),
        name: nameOf(r.entrantId),
        cells: columns.map((c) => (c.key === "points" ? pointsText(r.points, home.pointsUnit) : String(r[c.key]))),
        leader: leaders.includes(r.entrantId),
      })),
    };
  }

  let winner: Built["winner"] = null;
  let noPlay: Built["noPlay"] = null;
  if (home.finished) {
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

  let draw: DrawRound[] | null = null;
  if (knockout) {
    const byRound = new Map<number, DrawCard[]>();
    for (const f of home.fixtures) {
      // Settled: the score sits on the winner's line, read winner first (the mockup's card); live: under both seats.
      const settled = !f.isBye && f.phase === "settled" ? settledScore(f, home.sport.key) : null;
      const withScore = (s: SeatView): DrawSeat => (s.winner && settled !== null ? { ...s, score: settled } : s);
      const homeSeat = withScore(seat(f, f.home, f.homeSlotLabel));
      const awaySeat = withScore(seat(f, f.away, f.awaySlotLabel));
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
      };
      byRound.set(f.roundNo, [...(byRound.get(f.roundNo) ?? []), card]);
    }
    draw = [...byRound.entries()].sort(([a], [b]) => a - b).map(([roundNo, cards]) => ({ roundNo, cards }));
  }

  // "Add a match" (C5, Task 8): the decider a level top asks for, so its selects open at the table's top two, in the
  // stored table's own order (the producer ranks it); before there is a table, at the first two sides as typed.
  let addMatch: Built["addMatch"] = null;
  if (!knockout && home.sides.length >= 2) {
    const ranked = ((home.standings?.rows ?? []) as { entrantId: string }[]).map((r) => r.entrantId);
    const [first, second] = ranked.length >= 2 ? ranked : home.sides.map((s) => s.entrantId);
    addMatch = { sides: home.sides.map((s) => ({ id: s.entrantId, name: s.name })), home: first!, away: second! };
  }

  return {
    // The kind only where the guest chose it (the setup page shows its kind switch only then): "Chess · League".
    eyebrow: [t(home.sport.labelKey), ...(home.kindChosen ? [t(KIND_KEY[home.kind])] : []), t(FORMAT_KEY[home.row.format])].join(
      " · ",
    ),
    // A saved match has no expiry (plan 3 Task 2): it is kept until its owner deletes it, so its line carries no countdown (A-I3).
    // The Continue card and the account's list say the same words (`playedLine`), without the countdown.
    played: playedLine(copy.plural, home, home.row.expiresAt === null ? null : QUICK_MATCH_EXPIRY_DAYS),
    hero,
    winner,
    noPlay,
    standings,
    draw,
    matches,
    addMatch,
  };
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
            {v.hero ? heroCard(v.hero, t, slots.score) : null}
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
            {v.standings ? <QuickMatchStandings view={v.standings} /> : null}
            {v.draw ? (
              <QuickMatchDraw
                title={t("quickMatch.home.draw")}
                rounds={v.draw}
                byeLabel={t("bracket.slot.bye")}
                liveLabel={t("quickMatch.home.live")}
              />
            ) : null}
            {v.matches.length > 0 ? (
              <QuickMatchList
                title={t("quickMatch.home.all")}
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
