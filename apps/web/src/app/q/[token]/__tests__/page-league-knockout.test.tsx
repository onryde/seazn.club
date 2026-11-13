// Quick match plan 5, Task 7 (plan docs/superpowers/plans/2026-11-13-quick-match-5-league-knockout.md D6-D9, Task 7; spec
// docs/superpowers/specs/2026-11-12-quick-match-league-knockout-design.md §5, §6, §11, §12; mockup qmd13a01 §7-12, layout
// only): the guest's home for a League + Knockout — the knockout drawn from the start, the tie at the cut asked as the
// hero, "Setting up the knockout", the bracket above the table once it fills, and the champion from the final.
//
// Two halves:
//   - THE VIEW over `QuickMatchHome` literals, one per state the read model (T5) produces: the read's own shapes, built
//     here by hand so every state (a three-way tie, a seed-ordered tie with no lot, a pick, a toss, the champion who is not
//     the league's leader) is reached without steering a real league into it. Expected words come from the en dictionary
//     and the mockup's numbers (6 league + 3 knockout = 9; 4 sides twice = 12 + 1 = 13), never from the view.
//   - THE PAGE over real quick matches (chess: each winner steered by resignation, `playWin`), made by the real create and
//     played through the real write path, so the producer and the consumer are both real (AGENTS.md class 1): the tie's
//     two forms post to the cut routes, a decision stored with no advance (a second phone's answer) fills on the next load,
//     and the champion is the final's winner.
//
// Sports: badminton in the literals (a set score, the mockup's own sport); chess on the DB side (single kind, steerable).
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { t as tRuntime, plural as pluralRuntime } from "@/lib/i18n-runtime";
import { levelWords } from "@/lib/score/levels";
import { QUICK_MATCH_ERRORS } from "@/lib/quick-match-constants";
import type { CreateQuickMatch } from "@/server/api-v1/schemas";
import type { CreatedQuickMatch } from "@/server/usecases/quick-match-create";
import { decideQuickMatchCut, type CutDecision } from "@/server/usecases/quick-match-advance";
import type { CutTie } from "@/server/usecases/quick-match-cut";
import {
  resolveQuickMatchToken,
  type QuickMatchFixture,
  type QuickMatchHome,
  type QuickMatchKnockout,
  type QuickMatchKnockoutSeat,
  type QuickMatchSide,
} from "@/server/usecases/quick-match-home";
import { hardDeleteQuickMatchCompetition } from "@/server/usecases/quick-match-delete";
import { skipQuickMatchFixture } from "@/server/usecases/quick-match-skip";
import { listQuickMatchSports } from "@/server/usecases/quick-match-sports";
import { hashVisitorKey, mintVisitorKey } from "@/server/usecases/quick-match-tokens";
import { createQuickMatchAnyFormat } from "@/server/usecases/__tests__/_quick-match-knockout";
import { pairKey, playWin } from "@/server/usecases/__tests__/_quick-match-results";
import * as homeModule from "@/components/quick-match/home";
import * as standingsModule from "@/components/quick-match/standings";
import * as drawModule from "@/components/quick-match/draw";
import * as listModule from "@/components/quick-match/match-list";
import * as saveFormModule from "@/components/quick-match/save-form";
import { homeFlash, QuickMatchHomeView, type CutView, type QuickMatchCopy } from "@/components/quick-match/home";
import { QuickMatchCutPrompt } from "@/components/quick-match/cut-prompt";
import type { RowMenuRequest } from "@/components/quick-match/match-list";
import en from "@/dictionaries/en/ui.json";
import enPublic from "@/dictionaries/en/public.json";
import QuickMatchHomePage from "../page";

vi.stubEnv("DEVICE_LINK_KEK", kekBytes(32).toString("hex"));
const locale = vi.hoisted(() => ({ value: "en" as "en" | "fr" }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => locale.value) }));
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));

const HAS_DB = !!process.env.DATABASE_URL;
/** C1 / §7.2: an unsaved quick match is kept this many days after its last activity. The spec's number, typed. */
const SPEC_EXPIRY_DAYS = 7;

const en_ = (key: keyof typeof en, vars?: Record<string, string | number>) => tRuntime(en, key, vars);
const plural_ = (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(en, key, count, "en", vars);
const list_ = (names: string[]) => new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(names);

// ── the server-render expansion (page.test.tsx's own harness) ───────────────────────────────────────────────────────

const SERVER = new Set<unknown>(
  [homeModule, standingsModule, drawModule, listModule, saveFormModule].flatMap((m) =>
    Object.values(m).filter((v) => typeof v === "function"),
  ),
);
async function expand(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map((n) => expand(n as ReactNode)));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function" && SERVER.has(el.type)) {
    return expand(await (el.type as (p: unknown) => ReactNode | Promise<ReactNode>)(el.props));
  }
  if (el.props.children === undefined) return el;
  const children = await expand(el.props.children as ReactNode);
  return cloneElement(el, undefined, ...(Array.isArray(children) ? children : [children]));
}
type El = ReactElement<Record<string, unknown>>;
function all(node: unknown, pred: (el: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const n of node) all(n, pred, out);
  } else if (isValidElement(node)) {
    const el = node as El;
    if (pred(el)) out.push(el);
    all(el.props.children, pred, out);
  }
  return out;
}
const byTestId = (tree: unknown, id: string) => all(tree, (el) => el.props["data-testid"] === id);
const oneByTestId = (tree: unknown, id: string) => {
  const hits = byTestId(tree, id);
  expect(hits, `exactly one [data-testid=${id}]`).toHaveLength(1);
  return hits[0]!;
};
function textOf(node: unknown): string {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (isValidElement(node)) return textOf((node.props as { children?: unknown }).children);
  return "";
}
const words = (node: unknown) => textOf(node).replace(/\s+/g, " ").trim();
/** Every test id in document order: the page's composition, membership and order (and repeats). */
const testIds = (tree: unknown) => all(tree, (el) => typeof el.props["data-testid"] === "string").map((el) => String(el.props["data-testid"]));
const indexOfId = (tree: unknown, id: string) => {
  const i = testIds(tree).indexOf(id);
  expect(i, `[data-testid=${id}] is on the page`).toBeGreaterThanOrEqual(0);
  return i;
};

// ── the literals ────────────────────────────────────────────────────────────────────────────────────────────────────

const side = (entrantId: string, name: string): QuickMatchSide => ({ entrantId, name });
// The mockup's four (qmd13a01 §7-12), typed in this order.
const RAVI = side("e-ravi", "Ravi");
const INES = side("e-ines", "Ines");
const MIKA = side("e-mika", "Mika");
const SOFIA = side("e-sofia", "Sofia");
const FOUR = [RAVI, INES, MIKA, SOFIA];

/** A badminton result as the engine stores it (`detail.sets`, home first). */
const sets = (...games: [number, number][]) => ({ detail: { sets: games.map(([home, away]) => ({ home, away, closed: true })) } });

function fx(o: Partial<QuickMatchFixture> & Pick<QuickMatchFixture, "id" | "fixtureNo">): QuickMatchFixture {
  return {
    roundNo: 1,
    seqInRound: 1,
    home: null,
    away: null,
    homeSlotLabel: null,
    awaySlotLabel: null,
    status: "scheduled",
    summary: null,
    isBye: false,
    isFinal: false,
    winnerEntrantId: null,
    phase: "waiting",
    resultMovedOn: false,
    stage: "league",
    knockoutSeats: null,
    ...o,
  };
}
/** A league line: settled (`winner`, its sets home first), or ready to play. */
function leagueLine(
  n: number,
  home: QuickMatchSide,
  away: QuickMatchSide,
  result?: { winner: QuickMatchSide; games: [number, number][]; movedOn?: boolean },
): QuickMatchFixture {
  return fx({
    id: `f-${n}`,
    fixtureNo: n,
    roundNo: Math.ceil(n / 2),
    seqInRound: n % 2 === 1 ? 1 : 2,
    home,
    away,
    stage: "league",
    ...(result
      ? {
          status: "decided",
          summary: sets(...result.games),
          winnerEntrantId: result.winner.entrantId,
          phase: "settled" as const,
          resultMovedOn: result.movedOn ?? false,
        }
      : { status: "scheduled", phase: "ready" as const }),
  });
}
const rankSeat = (rank: number, toDecide = false): QuickMatchKnockoutSeat => ({ from: "league", rank, toDecide });
const winnerSeat = (fixtureId: string): QuickMatchKnockoutSeat => ({ from: "winner", fixtureId });
/** A knockout line of a League + Knockout: its seats' waits (`knockoutSeats`), and the sides once they sit there. */
function koLine(
  o: Pick<QuickMatchFixture, "id" | "fixtureNo" | "roundNo" | "seqInRound"> & {
    seats: [QuickMatchKnockoutSeat, QuickMatchKnockoutSeat];
    home?: QuickMatchSide | null;
    away?: QuickMatchSide | null;
    isFinal?: boolean;
    result?: { winner: QuickMatchSide; games: [number, number][] };
    live?: boolean;
    /** The result has moved the match on (its winner sits in the next line): the pad will not reopen it. */
    movedOn?: boolean;
  },
): QuickMatchFixture {
  const home = o.home ?? null;
  const away = o.away ?? null;
  const phase: QuickMatchFixture["phase"] = o.result ? "settled" : o.live ? "live" : home && away ? "ready" : "waiting";
  return fx({
    id: o.id,
    fixtureNo: o.fixtureNo,
    roundNo: o.roundNo,
    seqInRound: o.seqInRound,
    home,
    away,
    stage: "knockout",
    isFinal: o.isFinal ?? false,
    status: o.result ? "decided" : o.live ? "in_play" : "scheduled",
    summary: o.result ? sets(...o.result.games) : null,
    winnerEntrantId: o.result?.winner.entrantId ?? null,
    phase,
    resultMovedOn: o.movedOn ?? false,
    knockoutSeats: { home: o.seats[0], away: o.seats[1] },
  });
}

interface TableRow {
  side: QuickMatchSide;
  rank: number;
  played: number;
  won: number;
  points: number;
  /** The class this row is level with (the engine's `tieBreak.with`), ordered by `key`. */
  tie?: { with: QuickMatchSide[]; key: "lots" | "seed" };
}
function standingsOf(stageId: string, rows: TableRow[], level = false): QuickMatchHome["standings"] {
  return {
    stage_id: stageId,
    pool_id: null,
    computed_through_seq: "1",
    updated_at: null,
    rows: rows.map((r) => ({
      entrantId: r.side.entrantId,
      played: r.played,
      won: r.won,
      drawn: 0,
      lost: r.played - r.won,
      points: r.points,
      metrics: {},
      rank: r.rank,
      level,
      tieUnbroken: r.tie !== undefined,
      ...(r.tie ? { tieBreak: { key: r.tie.key, with: r.tie.with.map((s) => s.entrantId) } } : {}),
    })),
  } as QuickMatchHome["standings"];
}

const counts = (fixtures: QuickMatchFixture[], stage?: "league" | "knockout") => {
  const lines = fixtures.filter((f) => !f.isBye && (stage === undefined || f.stage === stage));
  return {
    played: lines.filter((f) => f.phase === "settled").length,
    notPlayed: lines.filter((f) => f.phase === "notPlayed").length,
    total: lines.length,
  };
};

function lkHome(o: {
  sides: QuickMatchSide[];
  fixtures: QuickMatchFixture[];
  table: TableRow[];
  level?: boolean;
  knockout: Omit<QuickMatchKnockout, "filled"> & { filled?: boolean };
  champion?: QuickMatchHome["champion"];
  saved?: boolean;
}): QuickMatchHome {
  const all_ = counts(o.fixtures);
  const league = counts(o.fixtures, "league");
  const leagueDone = league.total > 0 && league.played + league.notPlayed === league.total;
  const finished = all_.total > 0 && all_.played + all_.notPlayed === all_.total;
  const ordered = [...o.fixtures];
  const live = ordered.find((f) => f.phase === "live");
  return {
    row: {
      id: "qm-lk", competitionId: "c-lk", name: "Thursday Smash", format: "league_knockout", email: null, locale: "en",
      lastActivityAt: new Date(), expiresAt: o.saved ? null : new Date(Date.now() + 7 * 86_400_000), savedByUserId: null,
      tokenEnc: new Uint8Array(),
    },
    divisionId: "d-lk",
    stageId: "s-league",
    knockoutStageId: "s-ko",
    sport: { key: "badminton", labelKey: "sport.badminton" },
    kind: "individual",
    kindChosen: true,
    sides: o.sides,
    fixtures: o.fixtures,
    next: live ?? ordered.find((f) => f.phase === "ready") ?? null,
    ...all_,
    league: { ...league, done: leagueDone },
    knockout: { filled: o.knockout.state === "filled", ...o.knockout },
    champion: o.champion ?? null,
    standings: standingsOf("s-league", o.table, o.level),
    pointsUnit: "whole",
    tableRules: null,
    metricSpecs: [],
    finished,
  };
}
const ko = (over: Partial<QuickMatchKnockout> & Pick<QuickMatchKnockout, "state" | "qualifiers">): Omit<QuickMatchKnockout, "filled"> => ({
  started: false,
  tie: null,
  decision: null,
  byLot: [],
  picked: [],
  ...over,
});

// ── the plain formats' literals (unchanged by plan 5: their composition is pinned below) ─────────────────────────────

function plainLeague(): QuickMatchHome {
  const fixtures = [
    leagueLine(1, RAVI, SOFIA, { winner: RAVI, games: [[15, 9], [15, 11]] }),
    leagueLine(2, INES, MIKA, { winner: INES, games: [[15, 12], [13, 15], [15, 10]] }),
    leagueLine(3, INES, RAVI),
    leagueLine(4, MIKA, SOFIA),
    leagueLine(5, RAVI, MIKA),
    leagueLine(6, SOFIA, INES),
  ];
  const h = lkHome({
    sides: FOUR,
    fixtures,
    table: [
      { side: RAVI, rank: 1, played: 1, won: 1, points: 2 },
      { side: INES, rank: 2, played: 1, won: 1, points: 2 },
      { side: MIKA, rank: 3, played: 1, won: 0, points: 0 },
      { side: SOFIA, rank: 4, played: 1, won: 0, points: 0 },
    ],
    knockout: ko({ state: "league", qualifiers: 2 }),
  });
  return { ...h, row: { ...h.row, format: "league" }, knockoutStageId: null, knockout: null };
}
function plainKnockout(): QuickMatchHome {
  const label = (round: number, seq: number) => ({ key: "slot.winner_match", params: { round, seq } });
  const fixtures = [
    fx({ id: "k-1", fixtureNo: 1, roundNo: 1, seqInRound: 1, home: RAVI, away: SOFIA, stage: "knockout", status: "decided",
      summary: sets([15, 9], [15, 12]), winnerEntrantId: RAVI.entrantId, phase: "settled", resultMovedOn: true }),
    fx({ id: "k-2", fixtureNo: 2, roundNo: 1, seqInRound: 2, home: INES, away: MIKA, stage: "knockout", phase: "ready" }),
    fx({ id: "k-3", fixtureNo: 3, roundNo: 2, seqInRound: 1, home: RAVI, away: null, stage: "knockout", isFinal: true,
      homeSlotLabel: label(1, 1), awaySlotLabel: label(1, 2), phase: "waiting" }),
  ];
  const h = lkHome({ sides: FOUR, fixtures, table: [], knockout: ko({ state: "league", qualifiers: 2 }) });
  return {
    ...h, row: { ...h.row, format: "knockout" }, knockoutStageId: null, knockout: null, league: null, standings: null,
    stageId: "s-ko",
  };
}

// ── the view's copy and slots ─────────────────────────────────────────────────────────────────────────────────────

const enCopy = (): QuickMatchCopy => ({
  locale: "en",
  t: (k, v) => tRuntime(en, k, v),
  plural: (k, n, v) => pluralRuntime(en, k, n, "en", v),
  levels: levelWords(enPublic),
  pub: (k, v) => tRuntime(enPublic, k, v),
});
const stubSlots = () => ({
  score: vi.fn((f: { id: string; live: boolean }, place: "hero" | "row") => (
    <span data-testid="slot-score" data-fixture-id={f.id} data-live={String(f.live)} data-place={place} />
  )),
  rowMenu: vi.fn((r: RowMenuRequest) => (
    <span data-testid="slot-row-menu" data-fixture-id={r.fixtureId} data-items={r.items.map((i) => i.kind).join(",")} />
  )),
  share: <span data-testid="slot-share" />,
  addMatch: vi.fn(() => <span data-testid="slot-add-match" />),
  cut: vi.fn((view: CutView) => <span data-testid="slot-cut" data-seats={view.seats} />),
  refresh: <span data-testid="slot-refresh" />,
});
type Slots = ReturnType<typeof stubSlots>;
async function renderView(home: QuickMatchHome, o: { slots?: Slots; flash?: { text: string; tone: "refusal" | "info" } } = {}) {
  const slots = o.slots ?? stubSlots();
  const tree = await expand(<QuickMatchHomeView home={home} copy={enCopy()} slots={slots as never} flash={o.flash ?? null} />);
  return { tree, slots };
}


// ── the states' literals (mockup qmd13a01 §7-12) ───────────────────────────────────────────────────────────────────────

/** A round robin of the four, as typed: every pair once. */
const RR4: readonly (readonly [QuickMatchSide, QuickMatchSide])[] = [
  [RAVI, SOFIA], [INES, MIKA], [INES, RAVI], [MIKA, SOFIA], [RAVI, MIKA], [SOFIA, INES],
];
/** A round robin of three. */
const RR3: readonly (readonly [QuickMatchSide, QuickMatchSide])[] = [[RAVI, INES], [MIKA, RAVI], [INES, MIKA]];
type End = "home" | "away" | "ready" | "notPlayed";
const HOME_WINS: [number, number][] = [[21, 15], [21, 18]];
const AWAY_WINS: [number, number][] = [[15, 21], [18, 21]];
/** Both are read winner first, in games joined by " · " (the list's own score line, page.test.tsx). */
const WON_2_0 = "21–15 · 21–18";
/** The league's lines in order, the pairs repeated round after round; each line ended as `ends` says. */
function leagueOf(pairs: typeof RR4, ends: readonly End[], movedOn = false): QuickMatchFixture[] {
  return ends.map((end, k) => {
    const [home, away] = pairs[k % pairs.length]!;
    const n = k + 1;
    if (end === "ready") return leagueLine(n, home, away);
    if (end === "notPlayed") return { ...leagueLine(n, home, away), status: "cancelled", phase: "notPlayed" as const };
    return leagueLine(n, home, away, { winner: end === "home" ? home : away, games: end === "home" ? HOME_WINS : AWAY_WINS, movedOn });
  });
}
const times = <T,>(n: number, v: T): T[] => Array.from({ length: n }, () => v);

const SEMI_1 = "k-semi-1";
const SEMI_2 = "k-semi-2";
const FINAL = "k-final";
type KoPlay = Partial<Pick<Parameters<typeof koLine>[0], "home" | "away" | "result" | "live" | "movedOn">>;
/** Semi-finals 1st v 4th and 2nd v 3rd, the final fed by their winners (the rulebook; T5 case (a)). */
function semis(first: number, o: { s1?: KoPlay; s2?: KoPlay; final?: KoPlay } = {}): QuickMatchFixture[] {
  return [
    koLine({ id: SEMI_1, fixtureNo: first, roundNo: 1, seqInRound: 1, seats: [rankSeat(1), rankSeat(4)], ...o.s1 }),
    koLine({ id: SEMI_2, fixtureNo: first + 1, roundNo: 1, seqInRound: 2, seats: [rankSeat(2), rankSeat(3)], ...o.s2 }),
    koLine({ id: FINAL, fixtureNo: first + 2, roundNo: 2, seqInRound: 1, isFinal: true, seats: [winnerSeat(SEMI_1), winnerSeat(SEMI_2)], ...o.final }),
  ];
}
/** A League → Final: the final, 1st v 2nd, either seat to decide while a tie is open. */
function finalOnly(first: number, toDecide: [boolean, boolean], o: KoPlay = {}): QuickMatchFixture[] {
  return [koLine({ id: FINAL, fixtureNo: first, roundNo: 1, seqInRound: 1, isFinal: true, seats: [rankSeat(1, toDecide[0]), rankSeat(2, toDecide[1])], ...o })];
}
const row = (s: QuickMatchSide, rank: number, played: number, won: number, tie?: TableRow["tie"]): TableRow => ({
  side: s, rank, played, won, points: won * 2, ...(tie ? { tie } : {}),
});
const ids = (...s: QuickMatchSide[]) => s.map((x) => x.entrantId);
const AT = "2026-11-13T10:00:00.000Z";

/** §7: mid-league, Semi-finals; two of six league matches played. */
const midLeague = () =>
  lkHome({
    sides: FOUR,
    fixtures: [...leagueOf(RR4, ["home", "home", "ready", "ready", "ready", "ready"]), ...semis(7)],
    table: [row(RAVI, 1, 1, 1), row(INES, 2, 1, 1), row(MIKA, 3, 1, 0), row(SOFIA, 4, 1, 0)],
    knockout: ko({ state: "league", qualifiers: 4 }),
  });
/** Nothing played yet, a League → Final: a table no match has reached is level. */
const freshFinal = () =>
  lkHome({
    sides: FOUR,
    fixtures: [...leagueOf(RR4, times(6, "ready")), ...finalOnly(7, [false, false])],
    table: FOUR.map((s, i) => row(s, i + 1, 0, 0)),
    level: true,
    knockout: ko({ state: "league", qualifiers: 2 }),
  });
/** §8: Twice, the league done; Ines and Mika level for 2nd, the lot (stored, unrevealed) ordered Mika first. */
const LEVEL_2ND: TableRow["tie"] = { with: [INES, MIKA], key: "lots" };
const TIE_2ND: CutTie = {
  entrantIds: ids(INES, MIKA), ranked: ids(MIKA, INES), place: 2, seats: 1, straddles: true, byLot: true,
};
const tieFor2nd = () =>
  lkHome({
    sides: FOUR,
    fixtures: [...leagueOf(RR4, times(12, "home")), ...finalOnly(13, [false, true])],
    table: [row(RAVI, 1, 6, 6), row(MIKA, 2, 6, 3, LEVEL_2ND), row(INES, 3, 6, 3, LEVEL_2ND), row(SOFIA, 4, 6, 0)],
    knockout: ko({ state: "tie", qualifiers: 2, tie: TIE_2ND }),
  });
/** Three in a circle (each won one): level for 1st, two places; the lot ordered Mika, Ravi, Ines. */
const LEVEL_ALL3: TableRow["tie"] = { with: [RAVI, INES, MIKA], key: "lots" };
const threeWay = () =>
  lkHome({
    sides: [RAVI, INES, MIKA],
    fixtures: [...leagueOf(RR3, times(3, "home")), ...finalOnly(4, [true, true])],
    table: [row(MIKA, 1, 2, 1, LEVEL_ALL3), row(RAVI, 2, 2, 1, LEVEL_ALL3), row(INES, 3, 2, 1, LEVEL_ALL3)],
    knockout: ko({
      state: "tie", qualifiers: 2,
      tie: { entrantIds: ids(INES, MIKA, RAVI), ranked: ids(MIKA, RAVI, INES), place: 1, seats: 2, straddles: true, byLot: true },
    }),
  });
/** Every league match Not played (T5 case (g)): nothing counted, so no lot; the engine fell back to seed (typing order). */
const allSkipped = () =>
  lkHome({
    sides: [RAVI, INES, MIKA],
    fixtures: [...leagueOf(RR3, times(3, "notPlayed")), ...finalOnly(4, [true, true])],
    table: [RAVI, INES, MIKA].map((s, i) => row(s, i + 1, 0, 0, { with: [RAVI, INES, MIKA], key: "seed" })),
    level: true,
    knockout: ko({
      state: "tie", qualifiers: 2,
      tie: { entrantIds: ids(INES, MIKA, RAVI), ranked: ids(RAVI, INES, MIKA), place: 1, seats: 2, straddles: true, byLot: false },
    }),
  });
/** §12: the league done with no tie, the fill not yet stored (an advance missed): Setting up. */
const settingUp = () =>
  lkHome({
    sides: [RAVI, INES, MIKA],
    fixtures: [...leagueOf(RR3, ["home", "away", "home"]), ...finalOnly(4, [false, false])],
    table: [row(RAVI, 1, 2, 2), row(INES, 2, 2, 1), row(MIKA, 3, 2, 0)],
    knockout: ko({ state: "settingUp", qualifiers: 2 }),
  });
/** §9: the tie for 2nd tossed: the lot (Mika first) sent Mika through; the final is next. */
const tossedFor2nd = () =>
  lkHome({
    sides: FOUR,
    fixtures: [...leagueOf(RR4, times(12, "home"), true), ...finalOnly(13, [false, false], { home: RAVI, away: MIKA })],
    table: [row(RAVI, 1, 6, 6), row(MIKA, 2, 6, 3, LEVEL_2ND), row(INES, 3, 6, 3, LEVEL_2ND), row(SOFIA, 4, 6, 0)],
    knockout: ko({
      state: "filled", qualifiers: 2,
      decision: { how: "toss", through: ids(MIKA), tie: ids(INES, MIKA), at: AT } satisfies CutDecision,
      byLot: ids(MIKA, INES),
    }),
  });
/** The same tie, picked: Ines through, though the lot had Mika ahead. */
const pickedFor2nd = () =>
  lkHome({
    sides: FOUR,
    fixtures: [...leagueOf(RR4, times(12, "home"), true), ...finalOnly(13, [false, false], { home: RAVI, away: INES })],
    table: [row(RAVI, 1, 6, 6), row(MIKA, 2, 6, 3, LEVEL_2ND), row(INES, 3, 6, 3, LEVEL_2ND), row(SOFIA, 4, 6, 0)],
    knockout: ko({
      state: "filled", qualifiers: 2,
      decision: { how: "pick", through: ids(INES), tie: ids(INES, MIKA), at: AT } satisfies CutDecision,
      picked: ids(INES),
    }),
  });
const LEAGUE_DONE: TableRow[] = [row(RAVI, 1, 3, 3), row(INES, 2, 3, 2), row(MIKA, 3, 3, 1), row(SOFIA, 4, 3, 0)];
/** §10: Semi-finals on: semi 1 decided (Ravi), semi 2 live. */
const semisOn = () =>
  lkHome({
    sides: FOUR,
    fixtures: [
      ...leagueOf(RR4, times(6, "home"), true),
      ...semis(7, {
        s1: { home: RAVI, away: SOFIA, result: { winner: RAVI, games: HOME_WINS }, movedOn: true },
        s2: { home: INES, away: MIKA, live: true },
        final: { home: RAVI },
      }),
    ],
    table: LEAGUE_DONE,
    knockout: ko({ state: "filled", qualifiers: 4, started: true }),
  });
/** §11: the champion, Ines (2nd in the league), beat Ravi (1st) in the final: never the table's leader. */
const championInes = () =>
  lkHome({
    sides: FOUR,
    fixtures: [
      ...leagueOf(RR4, times(6, "home"), true),
      ...semis(7, {
        s1: { home: RAVI, away: SOFIA, result: { winner: RAVI, games: HOME_WINS }, movedOn: true },
        s2: { home: INES, away: MIKA, result: { winner: INES, games: HOME_WINS }, movedOn: true },
        final: { home: RAVI, away: INES, result: { winner: INES, games: AWAY_WINS } },
      }),
    ],
    table: LEAGUE_DONE,
    knockout: ko({ state: "filled", qualifiers: 4, started: true }),
    champion: { entrantId: INES.entrantId, finalFixtureId: FINAL },
  });
/** The tossed tie's final, won by Ravi, who topped the league too. */
const championRavi = () => {
  const h = tossedFor2nd();
  const fixtures = h.fixtures.map((f) =>
    f.id === FINAL ? koLine({ id: FINAL, fixtureNo: 13, roundNo: 1, seqInRound: 1, isFinal: true, seats: [rankSeat(1), rankSeat(2)],
      home: RAVI, away: MIKA, result: { winner: RAVI, games: HOME_WINS } }) : f,
  );
  return { ...h, fixtures, next: null, played: 13, finished: true, knockout: { ...h.knockout!, started: true },
    champion: { entrantId: RAVI.entrantId, finalFixtureId: FINAL } };
};

// ── reading the page back ───────────────────────────────────────────────────────────────────────────────────────────

/** The league table as printed: name, place as shown, its marks, its tag ("kind:words"), and the cut line above it. */
function tableOf(tree: unknown) {
  return byTestId(tree, "qm-standings-row").map((r) => {
    const tag = byTestId(r, "qm-standings-tag")[0];
    const tagText = tag ? words(tag) : null;
    const th = words(all(r, (el) => el.type === "th")[0]);
    return {
      name: tagText === null ? th : th.slice(0, -tagText.length).trim(),
      place: words(all(r, (el) => el.type === "td")[0]),
      through: r.props["data-through"] === "true",
      toDecide: r.props["data-to-decide"] === "true",
      tag: tag ? `${String(tag.props["data-kind"])}:${tagText}` : null,
      cut: String(r.props.className).includes("[border-top-style:dashed]"),
    };
  });
}
/** The knockout's cards in order: name, the next edge, each seat (its words, rank note, winner mark, score), its actions. */
function cardsOf(tree: unknown) {
  return byTestId(tree, "qm-draw-card").map((c) => ({
    id: String(c.props["data-fixture-id"]),
    round: words(byTestId(c, "qm-draw-round")[0]),
    next: c.props["data-next"] === "true",
    seats: byTestId(c, "qm-draw-seat").map((s) => ({
      label: words(byTestId(s, "qm-draw-name")[0]),
      note: byTestId(s, "qm-draw-note").map(words)[0] ?? null,
      winner: s.props["data-winner"] === "true",
      score: byTestId(s, "qm-draw-seat-score").map(words)[0] ?? null,
    })),
    actions: byTestId(c, "qm-draw-actions").flatMap((a) =>
      all(a, (el) => String(el.props["data-testid"] ?? "").startsWith("slot-")).map((el) =>
        el.props["data-testid"] === "slot-score" ? `score:${String(el.props["data-place"])}:${String(el.props["data-live"])}` : `menu:${String(el.props["data-items"])}`,
      ),
    ),
  }));
}
const seat = (label: string, o: { note?: string; winner?: boolean; score?: string } = {}) => ({
  label, note: o.note ?? null, winner: o.winner ?? false, score: o.score ?? null,
});
const heroOf = (tree: unknown) => {
  const hits = byTestId(tree, "qm-hero");
  if (hits.length === 0) return null;
  return { kicker: words(oneByTestId(hits[0], "qm-hero-kicker")), home: words(oneByTestId(hits[0], "qm-hero-home")), away: words(oneByTestId(hits[0], "qm-hero-away")) };
};
const listTitle = (tree: unknown) => words(all(tree, (el) => el.props.id === "qm-all-title"));
const listIds = (tree: unknown) => byTestId(tree, "qm-match").map((r) => String(r.props["data-fixture-id"]));
const has = (tree: unknown, id: string) => byTestId(tree, id).length > 0;
const before = (tree: unknown, a: string, b: string) => indexOfId(tree, a) < indexOfId(tree, b);
const menus = (slots: Slots) => slots.rowMenu.mock.calls.map(([r]) => r);
const rank = (n: 1 | 2 | 3 | 4) => en_(`quickMatch.home.leagueRank.${n}`);
const short = (n: 1 | 2 | 3 | 4) => en_(`quickMatch.home.rankShort.${n}`);
const semiWord = (n: number) => en_("quickMatch.home.semiFinal", { n });
const FINAL_WORD = en_("bracket.round.final");
/** "N of M matches played · deleted …" (the whole match's N of M, D8). */
const playedOf = (played: number, total: number) => plural_("quickMatch.home.played", total, { played, days: SPEC_EXPIRY_DAYS });

describe("the plain formats stay as they were (plan 5 Task 7 (g))", () => {
  // Captured from the pre-plan-5 view over these same literals (the markup was byte-identical after the change): a plain
  // League keeps its leader, list and Add a match; a plain Knockout keeps `qm-draw`, its cards and its list. No `qm-knockout`,
  // no cut, no champion: the League + Knockout's blocks never reach them.
  const LEAGUE_IDS = [
    "qm-home", "qm-eyebrow", "qm-name", "qm-played", "qm-hero", "qm-hero-kicker", "qm-hero-home", "qm-hero-away", "slot-score",
    "qm-actions", "slot-share", "qm-standings", "qm-standings-title", "qm-standings-short", "qm-standings-head",
    ...times(4, ["qm-standings-row", "qm-cell", "qm-cell", "qm-cell"]).flat(),
    ...times(4, ["qm-match", "qm-match-no", "qm-match-sides", "slot-score", "slot-row-menu"]).flat(),
    ...times(2, ["qm-match", "qm-match-no", "qm-match-sides", "qm-match-score", "slot-row-menu"]).flat(),
    "slot-add-match", "qm-anyone",
  ];
  const KNOCKOUT_IDS = [
    "qm-home", "qm-eyebrow", "qm-name", "qm-played", "qm-hero", "qm-hero-kicker", "qm-hero-home", "qm-hero-away", "slot-score",
    "qm-actions", "slot-share", "qm-draw", "qm-draw-title",
    "qm-draw-card", "qm-draw-round", "qm-draw-seat", "qm-draw-name", "qm-draw-seat-score", "qm-draw-seat", "qm-draw-name",
    ...times(2, ["qm-draw-card", "qm-draw-round", "qm-draw-seat", "qm-draw-name", "qm-draw-seat", "qm-draw-name"]).flat(),
    "qm-match", "qm-match-no", "qm-match-sides", "slot-score",
    "qm-match", "qm-match-no", "qm-match-sides",
    "qm-match", "qm-match-no", "qm-match-sides", "qm-match-score",
    "qm-anyone",
  ];
  it("a plain League's and a plain Knockout's composition: membership, order and repeats of every test id", async () => {
    expect(LEAGUE_IDS, "the captured league composition").toHaveLength(63);
    expect(KNOCKOUT_IDS, "the captured knockout composition").toHaveLength(44);
    const league = await renderView(plainLeague());
    expect(testIds(league.tree)).toEqual(LEAGUE_IDS);
    expect(league.slots.cut).not.toHaveBeenCalled();
    expect(words(oneByTestId(league.tree, "qm-eyebrow"))).toBe(`${en_("sport.badminton")} · ${en_("quickMatch.kind.individual")} · ${en_("quickMatch.format.league")}`);
    expect(listTitle(league.tree)).toBe(en_("quickMatch.home.all"));
    expect(byTestId(league.tree, "qm-standings-row").filter((r) => r.props["data-leader"] === "true"), "the plain League still marks its leader").toHaveLength(1);
    const knockout = await renderView(plainKnockout());
    expect(testIds(knockout.tree)).toEqual(KNOCKOUT_IDS);
    expect(words(oneByTestId(knockout.tree, "qm-draw-title"))).toBe(en_("quickMatch.home.draw"));
  });
});

describe("a League + Knockout's home, state by state (plan 5 Task 7)", () => {
  it("(a) mid-league, Semi-finals (§7): the knockout drawn from the start under the table, each seat waiting on its league rank or its semi-final", async () => {
    const { tree, slots } = await renderView(midLeague());
    expect(words(oneByTestId(tree, "qm-eyebrow")), "the LK's own label").toBe("Badminton · Singles · League + Knockout");
    expect(en_("quickMatch.format.league_knockout")).toBe("League + Knockout");
    // 4 sides: a round robin of 4·3/2 = 6 league matches, a knockout of 4 is 4 − 1 = 3 (the rulebook). N of M counts both.
    expect(words(oneByTestId(tree, "qm-played"))).toBe(`${playedOf(2, 9)} · ${en_("quickMatch.home.stagePart.split", { league: 6, knockout: 3 })}`);
    expect(words(oneByTestId(tree, "qm-played"))).toContain("6 league, 3 knockout");
    // The hero counts among the league's matches only: the next is the 3rd of 6.
    expect(heroOf(tree)).toEqual({ kicker: en_("quickMatch.home.upNext", { n: 3, total: 6 }), home: "Ines", away: "Ravi" });
    expect(before(tree, "qm-standings", "qm-knockout"), "the league's turn: the table first").toBe(true);
    expect(has(tree, "qm-draw"), "a League + Knockout's section is the knockout, not a draw").toBe(false);
    expect(words(oneByTestId(tree, "qm-standings-title"))).toBe(en_("quickMatch.home.standings"));
    expect(words(oneByTestId(tree, "qm-standings-caption"))).toBe(en_("quickMatch.home.goThrough", { count: 4 }));
    expect(words(oneByTestId(tree, "qm-draw-title"))).toBe(en_("quickMatch.home.knockout"));
    expect(words(oneByTestId(tree, "qm-knockout-caption"))).toBe(en_("quickMatch.home.knockoutFills"));
    expect(cardsOf(tree)).toEqual([
      { id: SEMI_1, round: semiWord(1), next: false, seats: [seat(rank(1)), seat(rank(4))], actions: [] },
      { id: SEMI_2, round: semiWord(2), next: false, seats: [seat(rank(2)), seat(rank(3))], actions: [] },
      { id: FINAL, round: FINAL_WORD, next: false, seats: [seat(en_("quickMatch.home.winnerOfSemi", { n: 1 })), seat(en_("quickMatch.home.winnerOfSemi", { n: 2 }))], actions: [] },
    ]);
    // The list is the league's (the knockout's lines are its cards), and the league still takes a match.
    expect(listTitle(tree)).toBe(en_("quickMatch.home.leagueMatches"));
    // Its own order (plan 1: what is left to play first, then what was played).
    expect(listIds(tree)).toEqual(["f-3", "f-4", "f-5", "f-6", "f-1", "f-2"]);
    expect(slots.addMatch).toHaveBeenCalledTimes(1);
    // Four sides, four places: everyone is on course; the table names no leader (the winner is the final's).
    const table = tableOf(tree);
    expect(table.map((r) => [r.name, r.through, r.cut, r.tag])).toEqual([
      ["Ravi", true, false, null], ["Ines", true, false, null], ["Mika", true, false, null], ["Sofia", true, false, null],
    ]);
    expect(byTestId(tree, "qm-standings-row").filter((r) => r.props["data-leader"] === "true")).toHaveLength(0);
    for (const id of ["qm-cut", "qm-setting-up", "qm-cut-result", "qm-champion", "qm-winner", "qm-no-play"]) expect(has(tree, id), id).toBe(false);
    expect(slots.cut).not.toHaveBeenCalled();
  });

  it("(a′) nothing played yet (a League → Final): the table is level, so nobody is marked through and there is no cut line", async () => {
    const { tree, slots } = await renderView(freshFinal());
    expect(words(oneByTestId(tree, "qm-played"))).toBe(`${playedOf(0, 7)} · ${en_("quickMatch.home.stagePart.split", { league: 6, knockout: 1 })}`);
    expect(heroOf(tree)?.kicker).toBe(en_("quickMatch.home.upNext", { n: 1, total: 6 }));
    const table = tableOf(tree);
    expect(table).toHaveLength(4);
    expect(table.filter((r) => r.through || r.cut || r.tag !== null || r.toDecide)).toEqual([]);
    expect(words(oneByTestId(tree, "qm-standings-caption"))).toBe(en_("quickMatch.home.goThrough", { count: 2 }));
    expect(cardsOf(tree)).toEqual([{ id: FINAL, round: FINAL_WORD, next: false, seats: [seat(rank(1)), seat(rank(2))], actions: [] }]);
    expect(slots.addMatch).toHaveBeenCalledTimes(1);
  });

  it("(b) a tie for 2nd, two sides (§8): the question is the hero; the tied rows read '=' in the order typed, never the lot's", async () => {
    const { tree, slots } = await renderView(tieFor2nd());
    // 4 sides twice: 2 × 6 = 12 league matches, and the final.
    expect(words(oneByTestId(tree, "qm-played"))).toBe(`${playedOf(12, 13)} · ${en_("quickMatch.home.stagePart.split", { league: 12, knockout: 1 })}`);
    expect(heroOf(tree), "nothing to play while the question is open").toBeNull();
    const cut = oneByTestId(tree, "qm-cut");
    expect(words(oneByTestId(cut, "qm-cut-kicker"))).toBe(plural_("quickMatch.cut.kicker", 1));
    expect(words(oneByTestId(cut, "qm-cut-title"))).toBe(en_("quickMatch.cut.title", { place: short(2), names: list_(["Ines", "Mika"]) }));
    expect(words(oneByTestId(cut, "qm-cut-title")), "the mockup's words").toBe("Tie for 2nd: Ines and Mika");
    expect(words(oneByTestId(cut, "qm-cut-body"))).toBe(en_("quickMatch.cut.body"));
    expect(slots.cut).toHaveBeenCalledTimes(1);
    expect(slots.cut.mock.calls[0]![0]).toEqual({ members: [{ id: INES.entrantId, name: "Ines" }, { id: MIKA.entrantId, name: "Mika" }], seats: 1, toss: true });
    expect(byTestId(cut, "slot-cut"), "the answers sit inside the question").toHaveLength(1);
    expect(before(tree, "qm-standings", "qm-knockout"), "not filled: the table stays first").toBe(true);
    // The stored table has Mika 2nd (the lot); the page shows the tie as typed, Ines first, and reveals no order.
    expect(tableOf(tree)).toEqual([
      { name: "Ravi", place: "1", through: true, toDecide: false, tag: null, cut: false },
      { name: "Ines", place: "=", through: false, toDecide: true, tag: `toDecide:${en_("quickMatch.home.levelToDecide")}`, cut: true },
      { name: "Mika", place: "=", through: false, toDecide: true, tag: `toDecide:${en_("quickMatch.home.levelToDecide")}`, cut: false },
      { name: "Sofia", place: "4", through: false, toDecide: false, tag: null, cut: true },
    ]);
    expect(cardsOf(tree)).toEqual([
      { id: FINAL, round: FINAL_WORD, next: false, seats: [seat(rank(1)), seat(en_("quickMatch.home.toDecide", { seat: rank(2) }))], actions: [] },
    ]);
    expect(words(oneByTestId(tree, "qm-knockout-caption"))).toBe(en_("quickMatch.home.knockoutWaiting"));
    expect(slots.addMatch, "the league is complete: no match to add").not.toHaveBeenCalled();
    expect(menus(slots).filter((r) => r.items.some((i) => i.kind === "skip" || i.kind === "putBack"))).toEqual([]);
  });

  it("(b3) a three-way tie for 1st, two places: 'Tie for 1st: 3 sides, 2 places', both seats to decide, checkboxes' worth of seats", async () => {
    const { tree, slots } = await renderView(threeWay());
    expect(words(oneByTestId(tree, "qm-cut-kicker"))).toBe(plural_("quickMatch.cut.kicker", 2));
    expect(words(oneByTestId(tree, "qm-cut-title"))).toBe(plural_("quickMatch.cut.titleMany", 2, { place: short(1), sides: 3 }));
    expect(words(oneByTestId(tree, "qm-cut-title"))).toBe("Tie for 1st: 3 sides, 2 places");
    expect(slots.cut.mock.calls[0]![0]).toEqual({
      members: [RAVI, INES, MIKA].map((s) => ({ id: s.entrantId, name: s.name })), seats: 2, toss: true,
    });
    expect(tableOf(tree).map((r) => [r.name, r.place, r.toDecide, r.through, r.cut])).toEqual([
      ["Ravi", "=", true, false, false], ["Ines", "=", true, false, false], ["Mika", "=", true, false, false],
    ]);
    const toDecide = (n: 1 | 2) => en_("quickMatch.home.toDecide", { seat: rank(n) });
    expect(cardsOf(tree)[0]!.seats).toEqual([seat(toDecide(1)), seat(toDecide(2))]);
  });

  it("(b0) every league match Not played: no lot was drawn, so the question offers Pick only; no 'no match played' card on a League + Knockout", async () => {
    const { tree, slots } = await renderView(allSkipped());
    expect(slots.cut.mock.calls[0]![0]).toMatchObject({ seats: 2, toss: false });
    expect(words(oneByTestId(tree, "qm-cut-title"))).toBe("Tie for 1st: 3 sides, 2 places");
    expect(has(tree, "qm-no-play")).toBe(false);
    expect(has(tree, "qm-standings"), "the table stays: it is what the question is about").toBe(true);
    expect(tableOf(tree).map((r) => [r.name, r.place, r.toDecide, r.through, r.cut, r.tag])).toEqual(
      ["Ravi", "Ines", "Mika"].map((n) => [n, "=", true, false, false, `toDecide:${en_("quickMatch.home.levelToDecide")}`]),
    );
    expect(tableOf(tree).filter((r) => r.tag?.startsWith("lot:")), "a seed order is never 'by lot'").toEqual([]);
    expect(words(oneByTestId(tree, "qm-played"))).toBe(
      `${plural_("quickMatch.home.playedSkipped", 4, { played: 0, skipped: plural_("quickMatch.home.notPlayedPart", 3), days: SPEC_EXPIRY_DAYS })} · ${en_("quickMatch.home.stagePart.split", { league: 3, knockout: 1 })}`,
    );
  });

  it("(c) Setting up the knockout (§12): the league finished, no question, a Refresh; the final table, the knockout still under it", async () => {
    const { tree, slots } = await renderView(settingUp());
    const card = oneByTestId(tree, "qm-setting-up");
    expect(words(oneByTestId(card, "qm-setting-up-kicker"))).toBe(en_("quickMatch.home.leagueFinished"));
    expect(words(oneByTestId(card, "qm-setting-up-title"))).toBe(en_("quickMatch.home.settingUp"));
    expect(words(oneByTestId(card, "qm-setting-up-hint"))).toBe(en_("quickMatch.home.settingUpHint"));
    expect(byTestId(card, "slot-refresh"), "Refresh is the card's").toHaveLength(1);
    expect(heroOf(tree)).toBeNull();
    expect(has(tree, "qm-cut")).toBe(false);
    expect(slots.cut).not.toHaveBeenCalled();
    expect(words(oneByTestId(tree, "qm-standings-title"))).toBe(en_("quickMatch.home.finalLeagueTable"));
    expect(has(tree, "qm-knockout-caption"), "nothing to wait on but the fill").toBe(false);
    expect(before(tree, "qm-standings", "qm-knockout")).toBe(true);
    expect(tableOf(tree).map((r) => [r.name, r.through, r.cut])).toEqual([["Ravi", true, false], ["Ines", true, false], ["Mika", false, true]]);
    expect(slots.addMatch).not.toHaveBeenCalled();
  });

  it("(c′) Setting up after a Pick (T5 case (b): the answer stored, the fill not yet): the picked side is marked through before its seat holds it", async () => {
    const h = lkHome({
      sides: FOUR,
      fixtures: [...leagueOf(RR4, times(12, "home")), ...finalOnly(13, [false, false])],
      table: [row(RAVI, 1, 6, 6), row(MIKA, 2, 6, 3, LEVEL_2ND), row(INES, 3, 6, 3, LEVEL_2ND), row(SOFIA, 4, 6, 0)],
      knockout: ko({
        state: "settingUp", qualifiers: 2,
        decision: { how: "pick", through: ids(INES), tie: ids(INES, MIKA), at: AT } satisfies CutDecision,
        picked: ids(INES),
      }),
    });
    const { tree } = await renderView(h);
    expect(has(tree, "qm-setting-up")).toBe(true);
    expect(has(tree, "qm-cut-result"), "the answer is said once the knockout shows it").toBe(false);
    expect(tableOf(tree)).toEqual([
      { name: "Ravi", place: "1", through: true, toDecide: false, tag: null, cut: false },
      { name: "Ines", place: "=", through: true, toDecide: false, tag: `picked:${en_("quickMatch.home.picked")}`, cut: false },
      { name: "Mika", place: "=", through: false, toDecide: false, tag: null, cut: true },
      { name: "Sofia", place: "4", through: false, toDecide: false, tag: null, cut: false },
    ]);
    expect(cardsOf(tree)[0]!.seats, "the seats still wait on the fill").toEqual([seat(rank(1)), seat(rank(2))]);
  });

  it("(d) after a toss (§9): the result above the final's hero, the bracket above the table, the lot's sides marked 'decided by lot'", async () => {
    const { tree, slots } = await renderView(tossedFor2nd());
    const result = oneByTestId(tree, "qm-cut-result");
    expect(all(result, (el) => el.type === "p").map(words)).toEqual([
      en_("quickMatch.cut.tossResult", { names: "Mika" }),
      en_("quickMatch.cut.tossBody"),
    ]);
    expect(before(tree, "qm-cut-result", "qm-hero")).toBe(true);
    expect(heroOf(tree)).toEqual({ kicker: en_("quickMatch.home.upNextRound", { round: FINAL_WORD }), home: "Ravi", away: "Mika" });
    expect(before(tree, "qm-knockout", "qm-standings"), "filled: the bracket is what people watch").toBe(true);
    expect(words(oneByTestId(tree, "qm-played"))).toBe(`${playedOf(12, 13)} · ${en_("quickMatch.home.stagePart.knockoutOn")}`);
    expect(words(oneByTestId(tree, "qm-standings-title"))).toBe(en_("quickMatch.home.finalLeagueTable"));
    expect(words(oneByTestId(tree, "qm-standings-caption"))).toBe(en_("quickMatch.home.wentThrough", { count: 2 }));
    expect(has(tree, "qm-knockout-caption")).toBe(false);
    const lot = `lot:${en_("quickMatch.home.byLot")}`;
    expect(tableOf(tree)).toEqual([
      { name: "Ravi", place: "1", through: true, toDecide: false, tag: null, cut: false },
      { name: "Mika", place: "2", through: true, toDecide: false, tag: lot, cut: false },
      { name: "Ines", place: "3", through: false, toDecide: false, tag: lot, cut: true },
      { name: "Sofia", place: "4", through: false, toDecide: false, tag: null, cut: false },
    ]);
    expect(cardsOf(tree)).toEqual([
      {
        id: FINAL, round: FINAL_WORD, next: true,
        seats: [seat("Ravi", { note: short(1) }), seat("Mika", { note: `${short(2)} · ${en_("quickMatch.home.byLotShort")}` })],
        actions: ["score:row:false"],
      },
    ]);
    expect(slots.score.mock.calls.filter(([f]) => f.id === FINAL).map(([, place]) => place).sort()).toEqual(["hero", "row"]);
    for (const id of ["qm-cut", "qm-setting-up", "qm-champion"]) expect(has(tree, id), id).toBe(false);
    expect(slots.addMatch).not.toHaveBeenCalled();
    expect(menus(slots).filter((r) => r.fixtureId.startsWith("f-")), "the league's results are locked").toEqual([]);
  });

  it("(e) after a Pick: 'Picked to go through', the class still level ('='), the picked first and marked", async () => {
    const { tree } = await renderView(pickedFor2nd());
    expect(all(oneByTestId(tree, "qm-cut-result"), (el) => el.type === "p").map(words)).toEqual([
      en_("quickMatch.cut.pickResult", { names: "Ines" }),
    ]);
    expect(tableOf(tree)).toEqual([
      { name: "Ravi", place: "1", through: true, toDecide: false, tag: null, cut: false },
      { name: "Ines", place: "=", through: true, toDecide: false, tag: `picked:${en_("quickMatch.home.picked")}`, cut: false },
      { name: "Mika", place: "=", through: false, toDecide: false, tag: null, cut: true },
      { name: "Sofia", place: "4", through: false, toDecide: false, tag: null, cut: false },
    ]);
    expect(cardsOf(tree)[0]!.seats, "no lot: the rank alone").toEqual([seat("Ravi", { note: short(1) }), seat("Ines", { note: short(2) })]);
  });

  it("(f) Semi-finals on (§10): the live semi is the hero and the next card; the decided one carries its score and no Score", async () => {
    const { tree } = await renderView(semisOn());
    expect(heroOf(tree)).toEqual({ kicker: en_("quickMatch.home.liveRound", { round: semiWord(2) }), home: "Ines", away: "Mika" });
    expect(before(tree, "qm-knockout", "qm-standings")).toBe(true);
    expect(words(oneByTestId(tree, "qm-played"))).toBe(`${playedOf(7, 9)} · ${en_("quickMatch.home.stagePart.knockoutOn")}`);
    expect(cardsOf(tree)).toEqual([
      { id: SEMI_1, round: semiWord(1), next: false, seats: [seat("Ravi", { winner: true, score: WON_2_0 }), seat("Sofia")], actions: [] },
      { id: SEMI_2, round: semiWord(2), next: true, seats: [seat("Ines", { note: short(2) }), seat("Mika", { note: short(3) })], actions: ["score:row:true"] },
      { id: FINAL, round: FINAL_WORD, next: false, seats: [seat("Ravi"), seat(en_("quickMatch.home.winnerOfSemi", { n: 2 }))], actions: [] },
    ]);
    expect(has(tree, "qm-cut-result"), "no tie was asked").toBe(false);
  });

  it("(g) the champion is the final's winner (§11), never the table's leader: Ines (2nd) beat Ravi (1st); the final keeps Edit result", async () => {
    const { tree } = await renderView(championInes());
    const card = oneByTestId(tree, "qm-champion");
    expect(words(oneByTestId(card, "qm-champion-kicker"))).toBe(en_("quickMatch.home.champion"));
    expect(words(oneByTestId(card, "qm-champion-name"))).toBe("Ines");
    expect(words(oneByTestId(card, "qm-champion-beat"))).toBe(en_("quickMatch.home.championBeat", { loser: "Ravi", score: WON_2_0 }));
    expect(words(card), "Ravi topped the league, not the champion").not.toContain(en_("quickMatch.home.championTopToo"));
    for (const id of ["qm-winner", "qm-hero", "qm-no-play", "qm-cut-result"]) expect(has(tree, id), id).toBe(false);
    // Finished: the whole match's count, no countdown, no stage part.
    expect(words(oneByTestId(tree, "qm-played"))).toBe(plural_("quickMatch.home.playedSaved", 9, { played: 9 }));
    expect(cardsOf(tree).at(-1)).toEqual({
      id: FINAL, round: FINAL_WORD, next: false, seats: [seat("Ravi"), seat("Ines", { winner: true, score: WON_2_0 })], actions: ["menu:edit"],
    });
  });

  it("(g′) a champion who topped the league too says so; a finished match drops the toss's result line", async () => {
    const { tree } = await renderView(championRavi());
    expect(words(oneByTestId(tree, "qm-champion-name"))).toBe("Ravi");
    expect(words(oneByTestId(tree, "qm-champion-beat"))).toBe(
      `${en_("quickMatch.home.championBeat", { loser: "Mika", score: WON_2_0 })} ${en_("quickMatch.home.championTopToo")}`,
    );
    expect(has(tree, "qm-cut-result")).toBe(false);
  });

  it("(h) the skip warning counts the league's matches (T5 review): skipping the last league match finishes the league; Put back hides once the league is done", async () => {
    // League 4 played, 1 Not played, 1 to play, then the final: skipping the 6th finishes the LEAGUE (6 of 6), though not
    // the match (6 of 7).
    const open = lkHome({
      sides: FOUR,
      fixtures: [...leagueOf(RR4, ["home", "home", "home", "home", "notPlayed", "ready"]), ...finalOnly(7, [false, false])],
      table: [row(RAVI, 1, 3, 3), row(INES, 2, 2, 1), row(MIKA, 3, 2, 0), row(SOFIA, 4, 1, 0)],
      knockout: ko({ state: "league", qualifiers: 2 }),
    });
    const a = await renderView(open);
    const skip = menus(a.slots).find((r) => r.fixtureId === "f-6")!.items.find((i) => i.kind === "skip");
    expect(skip, "the open league match offers Not played").toBeDefined();
    expect(skip!.kind === "skip" && skip!.copy.body).toBe(en_("quickMatch.skip.bodyLast"));
    expect(menus(a.slots).find((r) => r.fixtureId === "f-5")?.items, "the league is open: Put back").toEqual([{ kind: "putBack" }]);

    // The 6th played: the league is done (5 played, 1 Not played) and the final filled, the match not finished.
    const done = lkHome({
      sides: FOUR,
      fixtures: [...leagueOf(RR4, ["home", "home", "home", "home", "notPlayed", "home"], true), ...finalOnly(7, [false, false], { home: RAVI, away: INES })],
      table: [row(RAVI, 1, 3, 3), row(INES, 2, 3, 2), row(MIKA, 3, 2, 0), row(SOFIA, 4, 2, 0)],
      knockout: ko({ state: "filled", qualifiers: 2 }),
    });
    expect(done.finished, "premise: the final is still to play").toBe(false);
    expect(done.league!.done).toBe(true);
    const b = await renderView(done);
    expect(byTestId(b.tree, "qm-match").find((r) => r.props["data-fixture-id"] === "f-5")?.props["data-state"]).toBe("notPlayed");
    expect(menus(b.slots).filter((r) => r.items.some((i) => i.kind === "putBack")), "the server refuses it (LEAGUE_FINISHED)").toEqual([]);
  });

  it("the home's flash for the cut routes' refusals: each its own line, a refusal, first on the page", async () => {
    const cases: [string, string][] = [
      [QUICK_MATCH_ERRORS.ALREADY_DECIDED, "quickMatch.flash.alreadyDecided"],
      [QUICK_MATCH_ERRORS.TIE_NOT_OPEN, "quickMatch.flash.tieChanged"],
      [QUICK_MATCH_ERRORS.PICK_INVALID, "quickMatch.flash.pickInvalid"],
      [QUICK_MATCH_ERRORS.LEAGUE_COMPLETE, "quickMatch.flash.leagueComplete"],
    ];
    for (const [code, key] of cases) expect(homeFlash(code), code).toEqual({ key, tone: "refusal" });
    expect(cases).toHaveLength(4);
    const { tree } = await renderView(tossedFor2nd(), { flash: { text: en_("quickMatch.flash.alreadyDecided"), tone: "refusal" } });
    expect(words(oneByTestId(tree, "qm-flash"))).toBe("Someone already decided. Here is who goes through.");
    expect(oneByTestId(tree, "qm-flash").props.role).toBe("alert");
    expect(before(tree, "qm-flash", "qm-eyebrow")).toBe(true);
  });
});

// ── the page over real quick matches ─────────────────────────────────────────────────────────────────────────────────

let CHESS: { variant: string; kind: CreateQuickMatch["kind"] };
const made: string[] = [];
interface Lk {
  out: CreatedQuickMatch;
  /** Each side's entrant id by the name it was typed as. */
  id: Map<string, string>;
}
async function lkMatch(sides: string[], qualifiers: 2 | 4, plays: 1 | 2 = 1): Promise<Lk> {
  const out = await createQuickMatchAnyFormat(
    {
      name: `QM LK ${randomUUID().slice(0, 8)}`, sport_key: "boardgame", variant_key: CHESS.variant, kind: CHESS.kind,
      format: "league_knockout", qualifiers, sides, plays, email: null, locale: "en",
    },
    { visitorHash: hashVisitorKey(mintVisitorKey()) },
  );
  made.push(out.competitionId);
  const entrants = await sql<{ id: string; display_name: string }[]>`
    select id, display_name from entrants where division_id = ${out.divisionId}`;
  return { out, id: new Map(entrants.map((e) => [e.display_name, e.id])) };
}
const linesOf = (stageId: string) => sql<{ id: string; home_entrant_id: string; away_entrant_id: string; is_final: boolean }[]>`
  select id, home_entrant_id, away_entrant_id, is_final from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`;
/** `winner` beats `loser` on their `nth` league line (0-based), through the real write path. */
async function beat(m: Lk, winner: string, loser: string, nth = 0): Promise<void> {
  const key = pairKey(m.id.get(winner)!, m.id.get(loser)!);
  const line = (await linesOf(m.out.stageId)).filter((f) => pairKey(f.home_entrant_id, f.away_entrant_id) === key)[nth];
  if (!line) throw new Error(`precondition: no league line ${nth} between ${winner} and ${loser}`);
  await playWin(line.id, m.id.get(winner)!);
}
async function rowOf(m: Lk) {
  const row = await resolveQuickMatchToken(m.out.token);
  if (!row) throw new Error("precondition: the quick match's token resolves");
  return row;
}
async function renderPage(token: string, e?: string) {
  const raw = await QuickMatchHomePage({ params: Promise.resolve({ token }), ...(e ? { searchParams: Promise.resolve({ e }) } : {}) });
  const tree = await expand(raw as ReactNode);
  return { tree, html: renderToStaticMarkup(<>{tree}</>) };
}
/** O3: every element of the page whose action or href holds the home token is kept out of session replay. Returns how many. */
function expectTokenBearersUnrecorded(html: string, token: string): number {
  const bearing = [...html.matchAll(/<([a-z]+)\b[^>]*\b(?:action|href)="([^"]*)"[^>]*>/g)].filter(([, , url]) => url!.includes(token));
  for (const [tag] of bearing) expect(tag, "a token-bearing element without ph-no-capture").toMatch(/class="[^"]*\bph-no-capture\b/);
  return bearing.length;
}
const promptOf = (tree: unknown) => {
  const hits = all(tree, (el) => el.type === QuickMatchCutPrompt);
  expect(hits, "one cut prompt").toHaveLength(1);
  return hits[0]!.props as unknown as Parameters<typeof QuickMatchCutPrompt>[0];
};
const entrantInputs = (html: string) =>
  [...html.matchAll(/<input\b[^>]*>/g)].map(([tag]) => tag).filter((tag) => tag.includes(`name="entrant"`)).map((tag) => ({
    type: /type="([^"]+)"/.exec(tag)?.[1], value: /value="([^"]+)"/.exec(tag)?.[1],
  }));

describe.skipIf(!HAS_DB)("the page over real League + Knockout quick matches (chess, plan 5 Task 7)", () => {
  beforeAll(async () => {
    const chess = (await listQuickMatchSports()).find((s) => s.sport_key === "boardgame");
    if (!chess) throw new Error("premise: chess is offered for quick matches (run `npm run sync:sports`)");
    CHESS = { variant: chess.variants[0]!.variant_key, kind: chess.kinds.at(-1)! };
  });
  afterAll(async () => {
    for (const id of made) await hardDeleteQuickMatchCompetition(id).catch(() => undefined);
    vi.unstubAllEnvs();
    const g = globalThis as { _sql?: { end(): Promise<void> } };
    const client = g._sql;
    g._sql = undefined;
    await client?.end();
  });

  it("mid-league, Semi-finals: 'Chess · League + Knockout', the knockout under the table, its seats by league rank and semi-final", async () => {
    const m = await lkMatch(["Ravi", "Ines", "Mika", "Sofia"], 4);
    await beat(m, "Ravi", "Ines");
    const { tree, html } = await renderPage(m.out.token);
    expect(words(oneByTestId(tree, "qm-eyebrow")), "chess has one kind, so no kind in the line").toBe("Chess · League + Knockout");
    expect(words(oneByTestId(tree, "qm-played"))).toContain(` · ${en_("quickMatch.home.stagePart.split", { league: 6, knockout: 3 })}`);
    expect(before(tree, "qm-standings", "qm-knockout")).toBe(true);
    const cards = cardsOf(tree);
    expect(cards, "two semi-finals and the final").toHaveLength(3);
    // The rulebook's pairings, 1st v 4th and 2nd v 3rd, whichever card the generator lists first.
    expect(cards.slice(0, 2).map((c) => c.seats.map((s) => s.label).sort()).sort()).toEqual([[rank(1), rank(4)].sort(), [rank(2), rank(3)].sort()].sort());
    expect(cards[2]!.seats.map((s) => s.label).sort()).toEqual([1, 2].map((n) => en_("quickMatch.home.winnerOfSemi", { n })).sort());
    expect(byTestId(tree, "qm-match"), "the league's six").toHaveLength(6);
    expect(has(tree, "qm-cut")).toBe(false);
    expect(expectTokenBearersUnrecorded(html, m.out.token)).toBeGreaterThan(0);
  });

  describe("a tie for 2nd under Twice: asked, answered on another phone, refused late, and played to a champion", () => {
    let m: Lk;
    let ines: string;
    let mika: string;
    let through: string;
    beforeAll(async () => {
      m = await lkMatch(["Ravi", "Ines", "Mika"], 2, 2);
      for (const nth of [0, 1]) {
        await beat(m, "Ravi", "Ines", nth);
        await beat(m, "Ravi", "Mika", nth);
      }
      await beat(m, "Ines", "Mika", 0);
      await beat(m, "Mika", "Ines", 1);
      ines = m.id.get("Ines")!;
      mika = m.id.get("Mika")!;
    });

    it("the page asks (§8): Pick posts the tied sides to the cut route, Toss posts to its own; a radio per side as typed; no hero", async () => {
      const token = m.out.token;
      const { tree, html } = await renderPage(token);
      const cut = oneByTestId(tree, "qm-cut");
      expect(words(oneByTestId(cut, "qm-cut-title"))).toBe("Tie for 2nd: Ines and Mika");
      expect(heroOf(tree)).toBeNull();
      const p = promptOf(cut);
      expect({ pick: p.pickAction, toss: p.tossAction, back: p.backHref, members: p.members, seats: p.seats }).toEqual({
        pick: `/q/${token}/cut/pick`,
        toss: `/q/${token}/cut/toss`,
        back: `/q/${token}`,
        members: [{ id: ines, name: "Ines" }, { id: mika, name: "Mika" }],
        seats: 1,
      });
      expect(p.words).toEqual({
        pick: en_("quickMatch.cut.pick"), toss: en_("quickMatch.cut.toss"), back: en_("quickMatch.cut.back"),
        question: plural_("quickMatch.cut.pickQuestion", 1), send: en_("quickMatch.cut.send"),
      });
      expect(html).toContain(`action="/q/${token}/cut/pick"`);
      expect(html).toContain(`action="/q/${token}/cut/toss"`);
      expect(entrantInputs(html)).toEqual([{ type: "radio", value: ines }, { type: "radio", value: mika }]);
      expect(expectTokenBearersUnrecorded(html, token), "the two cut forms and Back, at least").toBeGreaterThanOrEqual(3);
      expect(cardsOf(tree).map((c) => c.seats.map((s) => s.label).sort())).toEqual([[rank(1), en_("quickMatch.home.toDecide", { seat: rank(2) })].sort()]);
    });

    it("another phone tosses (the answer stored, nothing advanced here): this page's next load shows the knockout filled from it", async () => {
      ({ through: [through] } = (await decideQuickMatchCut(await rowOf(m), { how: "toss" })) as { through: [string] });
      expect([ines, mika], "premise: the toss sends one of the two").toContain(through);
      const name = through === ines ? "Ines" : "Mika";
      const { tree, html } = await renderPage(m.out.token);
      expect(has(tree, "qm-cut")).toBe(false);
      expect(all(oneByTestId(tree, "qm-cut-result"), (el) => el.type === "p").map(words)).toEqual([
        en_("quickMatch.cut.tossResult", { names: name }),
        en_("quickMatch.cut.tossBody"),
      ]);
      const hero = heroOf(tree)!;
      expect(hero.kicker).toBe(en_("quickMatch.home.upNextRound", { round: FINAL_WORD }));
      expect([hero.home, hero.away].sort()).toEqual(["Ravi", name].sort());
      expect(cardsOf(tree)[0]!.seats.map((s) => [s.label, s.note]).sort()).toEqual(
        [["Ravi", short(1)], [name, `${short(2)} · ${en_("quickMatch.home.byLotShort")}`]].sort(),
      );
      expect(before(tree, "qm-knockout", "qm-standings")).toBe(true);
      expect(tableOf(tree).filter((r) => r.tag === `lot:${en_("quickMatch.home.byLot")}`).map((r) => r.name).sort()).toEqual(["Ines", "Mika"]);
      expect(html).not.toContain("/cut/toss");
    });

    it("a late answer is refused ALREADY_DECIDED, and its landing reads the flash over the filled knockout", async () => {
      const other = through === ines ? mika : ines;
      await expect(decideQuickMatchCut(await rowOf(m), { how: "pick", entrantIds: [other] })).rejects.toMatchObject({
        code: QUICK_MATCH_ERRORS.ALREADY_DECIDED,
      });
      const { tree } = await renderPage(m.out.token, QUICK_MATCH_ERRORS.ALREADY_DECIDED);
      expect(words(oneByTestId(tree, "qm-flash"))).toBe(en_("quickMatch.flash.alreadyDecided"));
      expect(oneByTestId(tree, "qm-flash").props["data-tone"]).toBe("refusal");
      expect(has(tree, "qm-cut-result")).toBe(true);
      expect(has(tree, "qm-cut")).toBe(false);
      expect(heroOf(tree)?.kicker).toBe(en_("quickMatch.home.upNextRound", { round: FINAL_WORD }));
    });

    it("the 2nd seed wins the final: the champion is the final's winner, not the table's leader", async () => {
      const [final] = (await linesOf(m.out.knockoutStageId!)).filter((f) => f.is_final);
      expect(final, "premise: one final").toBeDefined();
      await playWin(final!.id, through);
      const name = through === ines ? "Ines" : "Mika";
      const { tree } = await renderPage(m.out.token);
      const card = oneByTestId(tree, "qm-champion");
      expect(words(oneByTestId(card, "qm-champion-name"))).toBe(name);
      expect(words(card)).toContain("Ravi");
      expect(words(card), "Ravi topped the league").not.toContain(en_("quickMatch.home.championTopToo"));
      for (const id of ["qm-winner", "qm-hero", "qm-cut-result", "qm-cut"]) expect(has(tree, id), id).toBe(false);
    });
  });

  it("every league match Not played (3 sides, a final): Pick only, three checkboxes for two places; a Pick fills the final", async () => {
    const m = await lkMatch(["Ravi", "Ines", "Mika"], 2);
    const row_ = await rowOf(m);
    for (const l of await linesOf(m.out.stageId)) expect(await skipQuickMatchFixture(row_, l.id)).toEqual({ changed: true });
    const token = m.out.token;
    const asked = await renderPage(token);
    expect(words(oneByTestId(asked.tree, "qm-cut-title"))).toBe("Tie for 1st: 3 sides, 2 places");
    const p = promptOf(asked.tree);
    expect(p.tossAction, "no lot was drawn: no coin to toss").toBeNull();
    expect(p.seats).toBe(2);
    expect(asked.html).not.toContain("/cut/toss");
    expect(entrantInputs(asked.html).map((i) => i.type)).toEqual(["checkbox", "checkbox", "checkbox"]);
    expect(has(asked.tree, "qm-no-play")).toBe(false);

    const [ravi, mika] = [m.id.get("Ravi")!, m.id.get("Mika")!];
    await decideQuickMatchCut(await rowOf(m), { how: "pick", entrantIds: [mika, ravi] });
    const filled = await renderPage(token);
    expect(all(oneByTestId(filled.tree, "qm-cut-result"), (el) => el.type === "p").map(words)).toEqual([
      en_("quickMatch.cut.pickResult", { names: list_(["Ravi", "Mika"]) }),
    ]);
    const picked = `picked:${en_("quickMatch.home.picked")}`;
    // The table is level (nothing was counted), but the fill is the authority: the two picked are marked through.
    expect(tableOf(filled.tree).map((r) => [r.name, r.place, r.tag, r.through, r.cut])).toEqual([
      ["Ravi", "=", picked, true, false], ["Mika", "=", picked, true, false], ["Ines", "=", null, false, true],
    ]);
    expect(cardsOf(filled.tree)[0]!.seats.map((s) => s.note).sort(), "no lot: ranks alone").toEqual([short(1), short(2)].sort());
  });
});
