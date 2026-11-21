// Truth-in-copy for the help section on Match Day's online rounds and boards (scheduling/match-day.md, "Online chess rounds and boards").
//
// The section quotes the screens in bold: the words a round's row and a board's row say, the round panel's presses, the board panel's
// decisions, the cameras' fold, the Needs you action and the way back on a phone. help-match-day-officials-copy.test.ts already holds every
// bold phrase of the page to a DICTIONARY string - which says a key exists, and nothing about whether a screen draws it (the first Match
// Day build quoted four reasons that existed, were translated, and were drawn nowhere). This test holds the section to what is DRAWN: it
// renders the real screens - the whole page, the online list, the round panel in each phase, the board panel in each state and the Needs
// you rows - reads the text nodes each prints, and fails naming every bold span of the section that no screen printed.
//
// A bold span may carry a live number (a time, a move, a count of players): those are compared with every run of digits read as "#", so
// "Live · move 12" is the line a board at move 23 prints, and a span whose WORDS differ still fails. The fixtures decide what is on the
// screen (a board's state, a window's offsets), never the page.
// Single-sport reason: the section is the chess online block; no other sport has one.
import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import en from "@/dictionaries/en/ui.json";
import publicEn from "@/dictionaries/en/public.json";
import type { ArbiterBoard, ArbiterFlag } from "@/lib/arbiter-view";
import type { Dict } from "@/lib/i18n-constants";
import type { Reader } from "@/lib/match-day/online";
import type { MatchDayBoard, MatchDayOnlineRound } from "@/lib/match-day/types";
import { NO_FROZEN_NAMES } from "@/lib/match-day/frozen-names";
import type { CompetitionDesk } from "@/server/usecases/competition-desk";
import type { Attention } from "@/lib/division-phase";
import { initialArbiterDecision } from "@/components/v2/arbiter-decision";
import { NeedsYou, needsYouItems } from "@/components/v2/desk/needs-you";
import { BoardPanelView, type BoardPanelViewProps } from "@/components/v2/match-day/board-focus";
import type { MatchDayCtx } from "@/components/v2/match-day/court-focus";
import { MatchDayShell } from "@/components/v2/match-day/match-day-shell";
import { OnlineList } from "@/components/v2/match-day/online-list";
import type { JoinViews } from "@/components/v2/match-day/online/arbiter-joins";
import type { ArbiterVideoView } from "@/components/v2/match-day/online/arbiter-video";
import { RoundFocus, type RoundFocusProps } from "@/components/v2/match-day/round-focus";
import { arbiterRound, board, held, iso, live, NOW, onlineView, openWindow, overRound, pairedRound, playingRound, present, round, withState } from "@/components/v2/match-day/__tests__/_online-fixtures";
import { emptyExtendTally } from "@/lib/checkin-extend";
import type { OpenRoundPairing, OpenRoundView } from "@/lib/open-round";
import { helpArticleBySlug } from "./_help-copy";

// The chessground board is a client-only dynamic import; the clock is a timer in production, a fixed instant here.
vi.mock("next/dynamic", async () => {
  const { createElement } = await import("react");
  return { default: () => () => createElement("span", { "data-testid": "board-stub" }) };
});
vi.mock("@/components/v2/use-extend-clock", () => ({ useExtendClock: vi.fn(() => Date.parse("2026-11-19T18:00:00.000Z")) }));

const dict = en as unknown as Dict;
const SLUG = "scheduling/match-day";
const MIN = 60_000;

/** The section, from its heading to the next one. */
function section(): string {
  const md = helpArticleBySlug(SLUG);
  const start = md.indexOf("## Online chess rounds and boards");
  expect(start, "the section exists").toBeGreaterThan(-1);
  const next = md.indexOf("\n## ", start + 1);
  return md.slice(start, next === -1 ? undefined : next);
}

const decode = (s: string) => s.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
/** The text nodes a screen draws: tags cut away, entities read back, white space collapsed, every run of digits read as "#". */
const textNodes = (h: string): string[] =>
  h
    .replace(/<[^>]*>/g, "\u0000")
    .split("\u0000")
    .map((t) => decode(t).replace(/\s+/g, " ").trim().replace(/\d+/g, "#"))
    .filter((t) => t !== "");
const underEnglish = (node: ReactNode) => renderToStaticMarkup(<DictProvider dict={dict} locale="en">{node}</DictProvider>);

const ctx = { dict, locale: "en", orgSlug: "club", compSlug: "autumn", competitionId: "comp-1", tz: "Europe/London", readOnly: false, frozen: false, orgId: "org-1" } as unknown as MatchDayCtx;
const EDITOR: Reader = { editor: true, offered: true, frozen: false };
const noop = () => {};

// ---- the screens -------------------------------------------------------------------------------------------------------------------

const HERE = { here: true, invites: [] };
const AWAY = { here: false, invites: [] };
const pairing = (b: ArbiterBoard): OpenRoundPairing => ({ fixtureId: b.fixtureId, boardNo: b.boardNo, whiteName: b.white.name, blackName: b.black.name, invitedAt: null, owedSeats: 2, canResend: true });
const viewOf = (boards: ArbiterBoard[], over: Partial<OpenRoundView> = {}): OpenRoundView => ({
  stageId: "stage-1",
  stageName: "Swiss",
  roundNo: 3,
  state: "open",
  openedAt: null,
  deadlineAt: null,
  windowMinutes: 15,
  staggered: false,
  batches: [],
  staggerSpanMinutes: 0,
  scheduledAt: null,
  press: "none",
  earlierInPlay: [],
  pairings: boards.map(pairing),
  extendableBoards: 0,
  extendWindows: [],
  extendRefusals: emptyExtendTally(),
  ...over,
});
const roundProps = (r: MatchDayOnlineRound, o: Partial<RoundFocusProps> = {}): RoundFocusProps => ({
  ctx,
  round: r,
  next: null,
  reader: EDITOR,
  nowMs: NOW,
  backLabel: "Back to the list",
  onBack: noop,
  onChanged: noop,
  onFrozen: noop,
  onOpenBoard: noop,
  onOpenRound: noop,
  ...o,
});
const roundHtml = (r: MatchDayOnlineRound, o: Partial<RoundFocusProps> = {}) => underEnglish(createElement(RoundFocus, roundProps(r, o)));

// A video view per side, keyed the way the shell's joins key them (`<fixtureId>:<side>`).
const WATCHING: ArbiterVideoView = { kind: "watching", tile: { present: true, live: true, offSinceMs: null, track: null } };
const joinable = { ...present("live"), joinable: true };
const camera = (): ArbiterFlag => ({
  id: "flag-cam",
  kind: "camera_lost",
  at: iso(NOW - 30 * MIN),
  personName: "Ben C.",
  report: { offSeconds: 90, windowSeconds: 600, intervals: [{ from: iso(NOW - 20 * MIN), to: iso(NOW - 18 * MIN), confirmedByEvents: true }], connections: 2, sessions: 1 },
  windowFrom: iso(NOW - 40 * MIN),
});
const POSITION = { fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3", lastMove: ["b8", "c6"] as [string, string], turn: "white" as const };
const answerOf = (b: ArbiterBoard, over: Partial<MatchDayBoard> = {}): MatchDayBoard =>
  ({ ...b, stage_id: "stage-1", round_no: 3, hold_reason: null, position: null, ...over }) as MatchDayBoard;
const boardView = (b: ArbiterBoard, o: Partial<BoardPanelViewProps> = {}): string =>
  underEnglish(
    createElement(BoardPanelView, {
      ctx,
      round: round("stage-1:3", "playing", arbiterRound([b])),
      row: { ...b, stage_id: "stage-1", round_no: 3 },
      answer: answerOf(b, { hold_reason: "clock_flag_unsettled" }),
      readFailed: false,
      reader: EDITOR,
      decision: initialArbiterDecision(b.fixtureId),
      nowMs: NOW,
      on: { extend: noop, resync: noop, goOn: noop, toggleSettle: noop, settle: noop, override: noop },
      backLabel: "Back to the list",
      onBack: noop,
      cameraMode: "board",
      onCameraMode: noop,
      camerasFolded: false,
      onCamerasFolded: noop,
      ...o,
    } as BoardPanelViewProps),
  );

/** A held board with every decision the loader would allow and both cameras required: the board panel's fullest state. */
const deciding = withState(
  { kind: "on_hold" },
  { fixtureId: "b-decide", boardNo: 4, canResync: true, canSettle: true, flags: [camera()], flagCount: 1, checkin: openWindow(), cameraPolicy: "required", sides: { home: joinable, away: joinable } },
);
const joins = (b: ArbiterBoard, away: ArbiterVideoView = WATCHING) => ({
  views: new Map<string, ArbiterVideoView>([
    [`${b.fixtureId}:home`, WATCHING],
    [`${b.fixtureId}:away`, away],
  ]) as unknown as JoinViews,
  retry: noop,
});
/** A game on the board with both cameras required, one tile's join failed: the switch between the cameras and the board, and "Try again". */
const playing = live(12, { fixtureId: "b-live", boardNo: 2, cameraPolicy: "required", sides: { home: joinable, away: joinable } });

/** The Needs you rows a held board and a flagged board raise (the desk's own builder), shown by the Match Day shell's list. */
const NEEDS = needsYouItems(
  dict,
  {
    divisions: new Map([
      [
        "d1",
        {
          attention: [
            { kind: "board_held", fixtureId: "fx-a", stageId: "stage-1", roundNo: 3, boardNo: 4, home: "Novak", away: "Silva", reason: "no_show_white", reopen: false },
            { kind: "board_flagged", fixtureId: "fx-b", roundNo: 3, boardNo: 7, home: "Chen", away: "Abara", flags: 1 },
          ] satisfies Attention[],
          fixture_names: {},
        },
      ],
    ]),
  } as unknown as CompetitionDesk,
  [{ id: "d1", name: "Open", slug: "open" }],
  "acme",
  "westway-open",
  "en",
);

/** An online night: a round in check-in (one board still short of a player, one live, one held with a report, one over; a player of the
 *  organisation on a board of their own), a round paired and not opened, one not started, one in play and one finished. */
function night(): MatchDayOnlineRound[] {
  const boards = [
    board({ boardNo: 1, fixtureId: "n-1", seats: { white: HERE, black: AWAY } }),
    board({ boardNo: 5, fixtureId: "n-5", seats: { white: AWAY, black: AWAY } }),
    live(23, { boardNo: 2, fixtureId: "n-2", sides: { home: present(), away: present("off") } }),
    held(1, { boardNo: 3, fixtureId: "n-3" }),
    withState({ kind: "result", score: "1-0", noResult: false }, { boardNo: 4, fixtureId: "n-4" }),
  ];
  return [
    round("stage-1:3", "checkin", arbiterRound(boards, { extendableBoards: 1 }), { own_boards: 1, view: viewOf(boards) }),
    pairedRound("stage-b:2", { division_id: "div-b", division_name: "Club Blitz", stage_name: "Knockout" }),
    round("stage-d:1", "not_started", null, { division_id: "div-d", division_name: "Juniors" }),
    playingRound("stage-e:2", { division_id: "div-e", division_name: "Seniors" }),
    overRound("stage-c:1", { division_id: "div-c", division_name: "Veterans" }),
  ];
}

const shell = (rounds: MatchDayOnlineRound[]) =>
  underEnglish(
    createElement(MatchDayShell, {
      competitionId: "comp-1",
      competitionName: "Westway Open",
      orgSlug: "acme",
      compSlug: "westway-open",
      locale: "en",
      divisions: [],
      initial: onlineView(rounds, { needs_you: NEEDS }),
      dict,
      scoreDict: publicEn as Dict,
      viewerPlan: "pro",
      frozenNames: NO_FROZEN_NAMES,
    } as never),
  );

// ---- the test ----------------------------------------------------------------------------------------------------------------------

describe("help: Match Day's online rounds and boards", () => {
  it("every bold span of the section is a line a Match Day screen draws", () => {
    const s = section();
    const paired = pairedRound("stage-1:3", { view: viewOf([board({ boardNo: 1, fixtureId: "p-1" }), board({ boardNo: 2, fixtureId: "p-2" })], { state: "paired", press: "open" }) });
    const checkingIn = night()[0]!;
    const screens: Record<string, string> = {
      "the page, one online night": shell(night()),
      "the online list": underEnglish(createElement(OnlineList, { rounds: night(), selected: null, dict, locale: "en", nowMs: NOW, onOpenRound: noop, onOpenBoard: noop })),
      "the round panel, paired": roundHtml(paired),
      "the round panel, checking in": roundHtml(checkingIn),
      "the round panel, every board over, the next round paired": roundHtml(overRound("stage-1:3", { pair_next_round: 4 }), { next: pairedRound("stage-1:4") }),
      "the board panel, held, with its decisions and cameras": boardView(deciding, { joins: joins(deciding), cameraMode: "cameras" }),
      "the board panel, cameras folded": boardView(deciding, { joins: joins(deciding), cameraMode: "cameras", camerasFolded: true }),
      "the board panel, a game on the board, one camera failed": boardView(playing, { answer: answerOf(playing, { position: POSITION }), joins: joins(playing, { kind: "error" }) }),
      "the Needs you rows": underEnglish(createElement(NeedsYou, { dict, items: NEEDS })),
    };
    const drawn: string[] = [];
    for (const [name, h] of Object.entries(screens)) {
      const nodes = textNodes(h);
      expect(nodes.length, `anti-vacuity: ${name} drew text`).toBeGreaterThan(5);
      drawn.push(...nodes);
    }
    expect(drawn.length, "anti-vacuity: the corpus").toBeGreaterThan(150);

    const spans = [...s.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]!.trim().replace(/\d+/g, "#"));
    expect(spans.length, "anti-vacuity: the section quotes screen lines").toBeGreaterThanOrEqual(20);
    const undrawn = spans.filter((sp) => !drawn.some((d) => d.includes(sp)));
    if (undrawn.length > 0) throw new Error(`bold lines no Match Day screen draws: ${JSON.stringify(undrawn)}`);
  });

  it("the Viewer line is true: a Viewer sees the round panel's board list and none of its presses", () => {
    const s = section();
    expect(s).toContain("A Viewer sees the rounds and boards and has no buttons that change anything");
    const checkingIn = night()[0]!;
    const as = (reader: Reader) => roundHtml(checkingIn, { reader });
    const PRESSES = ["arbiter-waiting-extend", "arbiter-waiting-resend", "arbiter-extend-round-cta", "md-round-open-cta", "md-round-pair-next"];
    const presses = (h: string) => PRESSES.reduce((n, id) => n + (h.split(`data-testid="${id}"`).length - 1), 0);
    expect(presses(as(EDITOR)), "the editor's panel has its presses (the pair)").toBeGreaterThan(0);
    expect(presses(as({ ...EDITOR, editor: false })), "a Viewer's panel has none").toBe(0);
    expect(as({ ...EDITOR, editor: false }).split('data-testid="arbiter-waiting-row"').length - 1, "and still lists the boards").toBeGreaterThan(0);
  });
});
