// Quick match home (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 3, §7.5, C11, C15, C18; plan 2
// Task 5; mockup docs/superpowers/specs/mockups/2026-11-03-quick-match/home.html, layout only): what the share link opens.
// In the mockup's order: the eyebrow (sport · kind · format), the name, the played line, the hero (the match up next or in
// play, or the winner once every match is played), the actions, the standings (league) or the draw (knockout), then every
// match with the finished ones at the bottom.
//
// A SERVER component. It reads plan 1's `QuickMatchHome` and passes only strings and ids on: the read's `row` (the
// creator's email, the sealed token) never leaves this file (A14), and nothing here is a client boundary. The actions are
// SLOTS the later tasks fill (Score: Task 6, Share: Task 7, Add a match: Task 8); Save is hidden in plan 2 (D13).
//
// Words: every string a guest reads is a dictionary key in the VIEWER's locale (D10). Matches are numbered D12's way (the
// 1-based index among non-bye matches in play order), a waiting seat names its feeder in words, never a round code, and a
// knockout's rounds are named by their place in the bracket (`roundRoleFor`).
//
// Phone first: one column, each name wrapping or truncating inside a `min-w-0` chain, so a 40-character side never
// widens a 320px screen. From `lg` the name, hero and actions hold a sticky left column beside the table and the list.
import type { ReactNode } from "react";
import type { EntrantKind } from "@seazn/engine/sport";
import type { Locale } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import { QUICK_MATCH_EXPIRY_DAYS } from "@/lib/quick-match-constants";
import { roundRoleFor } from "@/lib/round-role-label";
import { compactScore } from "@/lib/match-day/view";
import { scoreLineOf, type LevelWords } from "@/lib/score/levels";
import { setBreakdown } from "@/lib/public-site";
import type { QuickMatchFixture, QuickMatchHome, QuickMatchSide } from "@/server/usecases/quick-match-home";
import { QuickMatchStandings, type StandingsView } from "./standings";
import { QuickMatchDraw, type DrawCard, type DrawRound } from "./draw";
import { QuickMatchList, type MatchView, type ScoreSlot, type SeatView } from "./match-list";
import { fixtureLabel, winnerOfLabel, type FixtureLabel } from "./fixture-label";

type Vars = Record<string, string | number>;

/** The viewer's words, resolved by the page from the dictionaries. */
export interface QuickMatchCopy {
  t: (key: MessageKey, vars?: Vars) => string;
  plural: (key: string, count: number, vars?: Vars) => string;
  /** The public dictionary's live-level marks (TB, MTB, Ad) for a live score. */
  levels: LevelWords;
}

/** What Tasks 6, 7 and 8 put on the home. Each is optional: an empty slot renders nothing. */
export interface QuickMatchSlots {
  /** The Score control of a playable match: in the hero, and on its list row. Never offered for a waiting seat (C18). */
  score?: ScoreSlot;
  share?: ReactNode;
  /** League only (C5): a knockout never shows it. */
  addMatch?: ReactNode;
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
  winner: { kicker: string; names: string[] } | null;
  standings: StandingsView | null;
  draw: DrawRound[] | null;
  matches: MatchView[];
}

/** A settled set sport reads as its sets, winner first ("21–15 · 21–18"); anything else as the sport's own score line. */
function scoreText(f: QuickMatchFixture, sportKey: string, levels: LevelWords): string | null {
  if (f.phase === "settled") {
    const sets = setBreakdown(f.summary, sportKey);
    if (sets !== null) {
      const awayWon = f.away !== null && f.away.entrantId === f.winnerEntrantId;
      return sets.sets.map((s) => (awayWon ? `${s.away}–${s.home}` : `${s.home}–${s.away}`)).join(" · ");
    }
  }
  if (f.phase !== "settled" && f.phase !== "live") return null;
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

export function buildHomeView(home: QuickMatchHome, copy: QuickMatchCopy): Built {
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

  const heroFixture = home.allPlayed ? null : home.next;
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
      return {
        id: f.id,
        n: matchNo.get(f.id)!,
        phase: f.phase,
        home: seat(f, f.home, f.homeSlotLabel),
        away: seat(f, f.away, f.awaySlotLabel),
        score: scoreText(f, home.sport.key, copy.levels),
        result,
        next: heroFixture !== null && heroFixture.id === f.id,
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
      rank?: number | null;
      tieUnbroken?: boolean;
      tieBreak?: { with?: string[] };
    }[];
    // The top of the table: the rank-1 row and every row it is still level with (a tie the engine split by lots is a tie).
    // Before any match counts, the stored table still ranks every side (all level at 1): no leader and no place yet.
    const anyPlayed = rows.some((r) => r.played > 0);
    const top = rows.find((r) => r.rank === 1);
    leaders = !anyPlayed || !top ? [] : [top.entrantId, ...(top.tieUnbroken ? (top.tieBreak?.with ?? []) : [])];
    const draws = rows.some((r) => r.drawn > 0);
    const columns = [
      { key: "played", label: t("slideshow.col.played") },
      { key: "won", label: t("slideshow.col.won") },
      ...(draws ? [{ key: "drawn", label: t("slideshow.col.drawn") }] : []),
      { key: "points", label: t("slideshow.col.points") },
    ];
    standings = {
      title: t("quickMatch.home.standings"),
      rankLabel: t("ladder.rank"),
      sideLabel: t("quickMatch.home.sideCol"),
      columns,
      rows: rows.map((r) => ({
        entrantId: r.entrantId,
        place: anyPlayed && typeof r.rank === "number" ? String(r.rank) : "",
        name: nameOf(r.entrantId),
        cells: columns.map((c) => String(r[c.key as "played" | "won" | "drawn" | "points"])),
        leader: leaders.includes(r.entrantId),
      })),
    };
  }

  let winner: Built["winner"] = null;
  if (home.allPlayed) {
    if (knockout) {
      const final = home.fixtures.find((f) => f.isFinal);
      if (final?.winnerEntrantId) winner = { kicker: t("quickMatch.home.winner"), names: [nameOf(final.winnerEntrantId)] };
    } else if (leaders.length > 0) {
      winner = {
        kicker: t(leaders.length === 1 ? "quickMatch.home.winner" : "quickMatch.home.level"),
        names: leaders.map(nameOf),
      };
    }
  }

  let draw: DrawRound[] | null = null;
  if (knockout) {
    const byRound = new Map<number, DrawCard[]>();
    for (const f of home.fixtures) {
      const homeSeat = seat(f, f.home, f.homeSlotLabel);
      const awaySeat = seat(f, f.away, f.awaySlotLabel);
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
        score: f.isBye ? null : scoreText(f, home.sport.key, copy.levels),
      };
      byRound.set(f.roundNo, [...(byRound.get(f.roundNo) ?? []), card]);
    }
    draw = [...byRound.entries()].sort(([a], [b]) => a - b).map(([roundNo, cards]) => ({ roundNo, cards }));
  }

  return {
    eyebrow: [t(home.sport.labelKey), t(KIND_KEY[home.kind]), t(FORMAT_KEY[home.row.format])].join(" · "),
    played: copy.plural("quickMatch.home.played", home.total, { played: home.played, days: QUICK_MATCH_EXPIRY_DAYS }),
    hero,
    winner,
    standings,
    draw,
    matches,
  };
}

// ── the page body ───────────────────────────────────────────────────────────────────────────────────────────────────

const LABEL = "app-display text-xs font-semibold tracking-[0.14em] text-[#b7aede]";

export function QuickMatchHomeView({
  home,
  copy,
  slots = {},
}: {
  home: QuickMatchHome;
  copy: QuickMatchCopy;
  slots?: QuickMatchSlots;
}) {
  const { t } = copy;
  const v = buildHomeView(home, copy);
  return (
    <main data-testid="qm-home" className="min-h-screen bg-night text-cream">
      {gantry(t)}
      <div className="mx-auto grid w-full max-w-5xl min-w-0 gap-6 px-4 pb-10 pt-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-10 lg:pt-8">
        <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
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
          {slots.share ? <div className="flex min-w-0 flex-wrap gap-2">{slots.share}</div> : null}
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
              score={slots.score}
            />
          ) : null}
          {home.row.format === "league" && slots.addMatch ? <div className="min-w-0">{slots.addMatch}</div> : null}
          <p data-testid="qm-anyone" className="text-xs text-[#8d7fc0]">
            {t("quickMatch.home.anyoneCanScore")}
          </p>
        </div>
      </div>
    </main>
  );
}

// Plain functions, not components: the page's element tree then holds what they render (the score page's `scanColumn`
// convention), so the server render and its test both see it.

function gantry(t: QuickMatchCopy["t"]): ReactNode {
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
        {winner.names.map((name) => (
          <li
            key={name}
            data-testid="qm-winner-name"
            className="app-display text-[1.75rem] font-bold leading-[1.1] text-cream [overflow-wrap:anywhere]"
          >
            {name}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── the dead link ───────────────────────────────────────────────────────────────────────────────────────────────────

/** An unknown, malformed, changed, expired or deleted home token (§5, Review Focus 3): one screen for all of them, so the
 *  page never says which. Its own test id (`qm-dead-link`), never the pad's `scan-dead-link`. */
export function QuickMatchDead({ locale, t }: { locale: Locale; t: QuickMatchCopy["t"] }) {
  return (
    <main className="flex min-h-screen flex-col bg-night text-cream">
      {gantry(t)}
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
          href={`/${locale}/play`}
          className="app-display mt-2 inline-flex min-h-11 max-w-full items-center justify-center rounded-xl bg-[color:var(--mk-lime)] px-5 py-2.5 text-center text-base font-bold leading-tight text-night focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream"
        >
          {t("quickMatch.dead.startNew")}
        </a>
      </section>
    </main>
  );
}
