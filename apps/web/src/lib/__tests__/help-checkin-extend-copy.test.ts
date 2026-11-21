// Truth-in-copy for the help section on extending a board's check-in (sports/chess.md, "Online chess: adding time to check-in").
//
// The section describes Match Day's screens: a "+5 min (3 left)" on the board panel and on each row of the round panel's waiting list,
// a "+5 min to the round" in the round panel, and the answers they give. Everything it QUOTES (every bold span) is a line one of those
// screens draws, and this test holds it to that by RENDERING them: the real BoardPanelView and RoundFocus, as an organiser's reader
// sees them, before a press and after one (the press driven through the panel's own handlers with the network doubled), and reading
// the text each puts on the page. A quoted line no screen draws fails the test and is named.
//
// Why render, and not check that a dictionary key EXISTS (what this file did before, and what the first Match Day build slipped past):
// the section once promised four "Can't extend check-in: ..." reasons and a round "short reason" - keys that exist, are translated,
// and that no Match Day screen renders (the board panel and the round bar print no reason). A key's existence says nothing about
// whether anything draws it. The reasons' keys, their translations and the helpers that read them are deleted now (B1); their words are
// typed in _retired-extend-reasons.ts, and the render is what says no screen says them.
//
// The numbers are SPELLED in the prose, so the expected words come from a number-word table keyed by the constants - never typed beside
// the claim. A value the table lacks fails the test and says so (it must be extended on purpose), so a step of 7 cannot slip past as
// "no claim found". Expected sentences come from the dictionary's entry for the key the spec names, with the fixture's numbers.
// Single-sport reason: the article is the chess page; no other sport has a check-in or a Match Day online block.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import en from "@/dictionaries/en/ui.json";
import { arbiterDecision, initialArbiterDecision, type ArbiterDecisionState } from "@/components/v2/arbiter-decision";
import { BoardPanelView, type BoardPanelViewProps } from "@/components/v2/match-day/board-focus";
import type { MatchDayCtx } from "@/components/v2/match-day/court-focus";
import { RoundFocus, WaitingList, type RoundFocusProps } from "@/components/v2/match-day/round-focus";
import { arbiterRound, board, iso, NOW, openWindow, round } from "@/components/v2/match-day/__tests__/_online-fixtures";
import {
  CHECKIN_EXTEND_MAX,
  CHECKIN_EXTEND_STEP_MINUTES,
  EXTEND_ROUND_SKIP_COPY,
  emptyExtendTally,
  type CheckinExtendRoundResult,
  type CheckinExtendState,
} from "@/lib/checkin-extend";
import type { Dict } from "@/lib/i18n-constants";
import type { Reader } from "@/lib/match-day/online";
import type { MatchDayBoard, MatchDayOnlineRound } from "@/lib/match-day/types";
import type { OpenRoundPairing, OpenRoundView } from "@/lib/open-round";
import type { ArbiterBoard } from "@/lib/arbiter-view";
import { helpArticleBySlug } from "./_help-copy";
import { RETIRED_EXTEND_REASONS, RETIRED_EXTEND_REASON_LEADS } from "./_retired-extend-reasons";

// The two seams the panels need outside a browser: the chessground board (a client-only dynamic import) and the network, answered by hand.
vi.mock("next/dynamic", async () => {
  const { createElement } = await import("react");
  return { default: () => () => createElement("span", { "data-testid": "board-stub" }) };
});
// The viewer's clock is a timer in production (it reads the REAL time once a tick has fired, which would close every window the fixtures
// open at NOW); here it is the fixtures' own instant, so a panel re-rendered after a press still reads the windows as they were.
vi.mock("@/components/v2/use-extend-clock", () => ({ useExtendClock: vi.fn(() => Date.parse("2026-11-19T18:00:00.000Z")) }));
type Call = { url: string; resolve: (v: unknown) => void };
const net = vi.hoisted(() => ({ calls: [] as Call[] }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return { ...actual, apiV1: (url: string) => new Promise((resolve) => net.calls.push({ url, resolve })) };
});

const WORDS: Record<number, string> = { 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten" };
const EN = en as Record<string, string>;
const SLUG = "sports/chess";
const MIN = 60_000;

/** A dictionary entry with its slots filled (the screens' own `{name}` syntax), and a plural entry for a count. */
const fill = (key: string, vars: Record<string, string | number> = {}): string => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), EN[key]!);
const plural = (key: string, n: number, vars: Record<string, string | number> = {}): string => fill(`${key}.${n === 1 ? "one" : "other"}`, { count: n, ...vars });

/** The section, from its heading to the next one. */
function section(): string {
  const md = helpArticleBySlug(SLUG);
  const start = md.indexOf("## Online chess: adding time to check-in");
  expect(start, "the section exists").toBeGreaterThan(-1);
  const next = md.indexOf("\n## ", start + 1);
  return md.slice(start, next === -1 ? undefined : next);
}

// ---- the screens -------------------------------------------------------------------------------------------------------------------

const dict = en as unknown as Dict;
const ctx = { dict, locale: "en", orgSlug: "club", compSlug: "autumn", competitionId: "comp-1", tz: "Europe/London", readOnly: false, frozen: false, orgId: "org-1" } as unknown as MatchDayCtx;
const EDITOR: Reader = { editor: true, offered: true, frozen: false };
const VIEWER: Reader = { ...EDITOR, editor: false };
const FROZEN: Reader = { ...EDITOR, frozen: true };
const noop = () => {};
const underEnglish = (node: ReactElement) => renderToStaticMarkup(createElement(DictProvider, { dict, locale: "en" } as { dict: Dict; locale: "en"; children: ReactNode }, node));
const count = (h: string, testid: string) => h.split(`data-testid="${testid}"`).length - 1;
const decode = (s: string) => s.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
/** The text nodes a screen draws, in order: the markup's tags cut away, entities read back, white space collapsed. */
const textNodes = (h: string): string[] =>
  h
    .replace(/<[^>]*>/g, "\u0000")
    .split("\u0000")
    .map((t) => decode(t).replace(/\s+/g, " ").trim())
    .filter((t) => t !== "");

const HERE = { here: true, invites: [] };
const AWAY = { here: false, invites: [] };
/** Board 3: white is here, black is not; board 4: nobody is. Both are inside an open check-in window with all their extensions left. */
const b3 = (over: Partial<ArbiterBoard> = {}) => board({ fixtureId: "c-3", boardNo: 3, seats: { white: HERE, black: AWAY }, ...over });
const b4 = () => board({ fixtureId: "c-4", boardNo: 4, seats: { white: AWAY, black: AWAY } });
const toRow = (b: ArbiterBoard) => ({ ...b, stage_id: "stage-1", round_no: 3 });

const pairing = (b: ArbiterBoard): OpenRoundPairing => ({ fixtureId: b.fixtureId, boardNo: b.boardNo, whiteName: b.white.name, blackName: b.black.name, invitedAt: null, owedSeats: 2, canResend: true });
const viewOf = (boards: ArbiterBoard[]): OpenRoundView => ({
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
});
/** A round in its check-in phase over these boards, with its open-round view (what `readOnlineRounds` builds from one). */
const checkinRow = (boards: ArbiterBoard[]): MatchDayOnlineRound => round("stage-1:3", "checkin", arbiterRound(boards, { extendableBoards: boards.length }), { view: viewOf(boards) });

const roundProps = (r: MatchDayOnlineRound, reader: Reader = EDITOR): RoundFocusProps => ({
  ctx,
  round: r,
  next: null,
  reader,
  nowMs: NOW,
  backLabel: "All rounds",
  onBack: noop,
  onChanged: noop,
  onFrozen: noop,
  onOpenBoard: noop,
  onOpenRound: noop,
});
const roundHtml = (r: MatchDayOnlineRound, reader: Reader = EDITOR) => underEnglish(createElement(RoundFocus, roundProps(r, reader)));

const ON = { extend: noop, resync: noop, goOn: noop, toggleSettle: noop, settle: noop, override: noop };
const boardProps = (b: ArbiterBoard, reader: Reader, decision?: ArbiterDecisionState): BoardPanelViewProps => ({
  ctx,
  round: checkinRow([b]),
  row: toRow(b),
  answer: { ...toRow(b), hold_reason: null, position: null } as MatchDayBoard,
  readFailed: false,
  reader,
  decision: decision ?? initialArbiterDecision(b.fixtureId),
  nowMs: NOW,
  on: ON,
  backLabel: "All boards",
  onBack: noop,
  cameraMode: "board",
  onCameraMode: noop,
  camerasFolded: false,
  onCamerasFolded: noop,
});
const boardHtml = (b: ArbiterBoard, reader: Reader = EDITOR, decision?: ArbiterDecisionState) => underEnglish(createElement(BoardPanelView, boardProps(b, reader, decision)));

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  net.calls.length = 0;
});

/** What a press and its answer put on the screens, driven through the panels' own handlers: board 3's "+5 min" on the waiting list (its answer
 *  under that row), the board panel after its own "+5 min", and the round's "+5 min to the round" answering `result`. */
async function answered(result: CheckinExtendRoundResult): Promise<{ waitingRow: string; boardPanel: string; roundBar: string }> {
  // The waiting list's row for board 3.
  const row = renderIsland(RoundFocus, roundProps(checkinRow([b3(), b4()])));
  const waitingOf = () => row.tree().find((e) => e.type === WaitingList)!;
  (propsOf(waitingOf()).on as { extendBoard(id: string): void }).extendBoard("c-3");
  expect(net.calls.map((c) => c.url), "the board's press went to the board's route").toEqual(["/api/v1/fixtures/c-3/external-play/extend-checkin"]);
  const boardAnswer = { fixtureId: "c-3", extensions: 1, extensionsLeft: CHECKIN_EXTEND_MAX - 1, addedMinutes: CHECKIN_EXTEND_STEP_MINUTES, deadlineAt: iso(NOW + 13 * MIN) };
  net.calls[0]!.resolve(boardAnswer);
  await flush();
  const waitingRow = underEnglish(waitingOf());

  // The board panel after the same press (its reducer: the press, then the door's answer).
  let decision = arbiterDecision(initialArbiterDecision("c-3"), { type: "extend", boardId: "c-3" });
  decision = arbiterDecision(decision, { type: "extendDone", boardId: "c-3", boardNo: 3, outcome: { ok: true, result: boardAnswer } });
  const boardPanel = boardHtml(b3(), EDITOR, decision);

  // The round's own press, on a fresh panel (one request at a time).
  const bar = renderIsland(RoundFocus, roundProps(checkinRow([b3(), b4()])));
  const heroOf = () => bar.tree().find((e) => propsOf(e).roundExtend !== undefined)!;
  (propsOf(propsOf(heroOf()).roundExtend as ReactElement).onExtend as () => void)();
  expect(net.calls.map((c) => c.url).at(-1), "the round's press went to the stage's route").toBe("/api/v1/stages/stage-1/extend-checkin");
  net.calls.at(-1)!.resolve(result);
  await flush();
  const roundBar = underEnglish(propsOf(heroOf()).roundExtend as ReactElement);
  return { waitingRow, boardPanel, roundBar };
}

/** The round press answered with six boards extended and two skipped because a game had started - the page's own example. */
const SIX_AND_TWO: CheckinExtendRoundResult = { extended: 6, skipped: { closed: 0, gameStarted: 2, capReached: 0 }, notOpenYet: 0, ownBoards: 0, failed: 0, addedMinutes: CHECKIN_EXTEND_STEP_MINUTES };

// ---- the tests ---------------------------------------------------------------------------------------------------------------------

describe("help: extending a board's check-in", () => {
  it("the step and the cap it names are the constants' (spelled), and no other count of minutes or times is claimed", () => {
    const s = section();
    const step = WORDS[CHECKIN_EXTEND_STEP_MINUTES];
    const max = WORDS[CHECKIN_EXTEND_MAX];
    expect(step, "the number-word table covers the step").toBeTruthy();
    expect(max, "the number-word table covers the cap").toBeTruthy();
    expect(s).toContain(`adds ${step} minutes to that board's check-in`);
    expect(s).toContain(`up to ${max} times`);
    const minutes = [...s.matchAll(/\b(\w+) minutes\b/g)].map((m) => m[1]!.toLowerCase());
    expect(minutes.length, "anti-vacuity: the minutes claimed").toBeGreaterThanOrEqual(1);
    // Every "N minutes" the section says is the step: the word of the press, and the digit in each answer it quotes ("Added 5 minutes to ...").
    expect(new Set(minutes), "every count of minutes is the step").toEqual(new Set([step, String(CHECKIN_EXTEND_STEP_MINUTES)]));
  });

  it("every line the section quotes is a line a Match Day screen draws - and every line it must quote is quoted", async () => {
    const s = section();
    const done = await answered(SIX_AND_TWO);
    // The corpus: what the real screens print, before a press (the board panel, the round panel with its bar and waiting list) and after one.
    const screens: Record<string, string> = {
      "the board panel": boardHtml(b3()),
      "the round panel": roundHtml(checkinRow([b3(), b4()])),
      "the waiting list, after a board's press": done.waitingRow,
      "the board panel, after its press": done.boardPanel,
      "the round bar, after the round's press": done.roundBar,
    };
    const drawn = Object.entries(screens).flatMap(([name, h]) => textNodes(h).map((text) => ({ name, text })));
    for (const [name, h] of Object.entries(screens)) expect(textNodes(h).length, `anti-vacuity: ${name} drew text`).toBeGreaterThan(0);
    expect(drawn.length, "anti-vacuity: the corpus").toBeGreaterThan(20);

    // 1. What the section quotes: every bold span and every line in quotation marks.
    const quoted = [...s.matchAll(/\*\*([^*]+)\*\*|"([^"\n]+)"|“([^”\n]+)”/g)].map((m) => (m[1] ?? m[2] ?? m[3]!).trim());
    expect(quoted.length, "anti-vacuity: the section quotes lines").toBeGreaterThanOrEqual(8);
    const undrawn = quoted.filter((q) => !drawn.some((d) => d.text.includes(q)));
    expect(undrawn, "quoted lines that no Match Day screen draws").toEqual([]);

    // 2. What it must quote, from the dictionary entries the screens read (the numbers are the fixtures'): the labels, the closing line, the
    // list's heading and the three answers. Deleting one of them from the page fails here.
    const must = [
      fill("externalPlay.checkinExtend.board", { minutes: CHECKIN_EXTEND_STEP_MINUTES, left: CHECKIN_EXTEND_MAX }),
      fill("externalPlay.checkinExtend.round", { minutes: CHECKIN_EXTEND_STEP_MINUTES }),
      fill("externalPlay.checkinExtend.closesAt", { time: "" }).trim(),
      plural("arbiter.column.waiting", 2),
      `+${CHECKIN_EXTEND_STEP_MINUTES} min`,
      fill("externalPlay.checkinExtend.notice.board", { minutes: CHECKIN_EXTEND_STEP_MINUTES, n: 3, time: "" }).split(". ")[0]! + ".",
      plural("externalPlay.checkinExtend.notice.round", SIX_AND_TWO.extended, { minutes: CHECKIN_EXTEND_STEP_MINUTES }),
      plural(EXTEND_ROUND_SKIP_COPY.gameStarted, SIX_AND_TWO.skipped.gameStarted),
    ];
    const missing = must.filter((m) => !s.includes(`**${m}**`));
    expect(missing, "lines the section should quote and does not").toEqual([]);
    expect(must.length, "anti-vacuity: the lines it must quote").toBe(8);
  });

  it("where the section says there is no button, the screens draw none and say nothing in its place - and the same board with an open window has it", () => {
    const s = section();
    expect(s).toContain("there is no button");
    // Every reason the old page promised, as the words it said them in (typed: the dictionary keys are gone, B1, so a screen that drew one
    // again would do it under a new key - and the lead-in catches the same reason reworded).
    const reasons = [...Object.values(RETIRED_EXTEND_REASONS), ...RETIRED_EXTEND_REASON_LEADS];
    expect(reasons.length, "anti-vacuity: the five sentences and the two lead-ins").toBe(7);
    const open = openWindow();
    const refused: Record<string, CheckinExtendState> = {
      "not opened yet": { ...open, canExtend: false, refusal: "not_open", opensAt: iso(NOW + 5 * MIN), deadlineAt: iso(NOW + 25 * MIN) },
      closed: { ...open, canExtend: false, refusal: "closed", deadlineAt: iso(NOW - MIN) },
      "game started": { ...open, canExtend: false, refusal: "game_started" },
      "no extensions left": { ...open, canExtend: false, refusal: "cap_reached", extensionsLeft: 0 },
    };
    const WINDOW_OPEN = new Set(["game started", "no extensions left"]);
    let checked = 0;
    for (const [name, checkin] of Object.entries(refused)) {
      const b = b3({ checkin });
      const onBoard = boardHtml(b);
      const onRound = roundHtml(checkinRow([b]));
      // The waiting list is the boards whose check-in window is open now (round-column.ts `openWindowBoards`): a board that is not open yet or
      // has closed is not in it at all, and the two that are open (a game on file, no extensions left) are listed with their button gone.
      expect(count(onRound, "arbiter-waiting-row"), `${name}: the waiting list lists the board only while its window is open`).toBe(WINDOW_OPEN.has(name) ? 1 : 0);
      expect(count(onBoard, "arbiter-extend-board"), `${name}: no +5 min on the board panel`).toBe(0);
      expect(count(onRound, "arbiter-extend-round-cta"), `${name}: no +5 min to the round`).toBe(0);
      expect(count(onRound, "arbiter-waiting-extend"), `${name}: no +5 min on a waiting row`).toBe(0);
      for (const reason of reasons) {
        expect(textNodes(onBoard + onRound).some((t) => t.includes(reason)), `${name}: no reason in its place ("${reason}")`).toBe(false);
      }
      checked += 1;
    }
    expect(checked, "anti-vacuity: the four refusals read").toBe(4);

    // The pair: the same board, window open, has all three buttons.
    const ok = b3();
    expect(count(boardHtml(ok), "arbiter-extend-board"), "open window: the board panel's +5").toBe(1);
    expect(count(roundHtml(checkinRow([ok])), "arbiter-extend-round-cta"), "open window: the round's +5").toBe(1);
    expect(count(roundHtml(checkinRow([ok])), "arbiter-waiting-extend"), "open window: the waiting row's +5").toBe(1);

    // "Only organisers who can run the day get these buttons": the same open board, two readers who do not.
    let readers = 0;
    for (const [who, reader] of [["a Viewer", VIEWER], ["a read-only (frozen) competition", FROZEN]] as const) {
      const onBoard = boardHtml(ok, reader);
      const onRound = roundHtml(checkinRow([ok]), reader);
      expect(count(onRound, "arbiter-waiting-row"), `${who}: the round still lists the board`).toBe(1);
      expect(count(onBoard, "arbiter-extend-board") + count(onRound, "arbiter-extend-round-cta") + count(onRound, "arbiter-waiting-extend"), `${who}: no +5 anywhere`).toBe(0);
      readers += 1;
    }
    expect(readers, "anti-vacuity: both readers").toBe(2);
    expect(s).toContain("A Viewer sees the round and its boards but no button");
    expect(s).toContain("a competition that went read-only after a [downgrade](/help/billing/downgrade) shows none either");
  });

  it("the rules it states: the round button skips what it says it skips (each in the round's own answer), every use is logged, the players' countdown moves", async () => {
    const s = section().replace(/\s+/g, " ");
    expect(s).toContain("It works only while check-in is open");
    expect(s).toContain("Every use is logged");
    expect(s).toContain("the check-in countdown on their board updates");

    // Each thing the round button is said to skip is one the round's answer reports as left alone, by the answer's own line for it.
    const ALL_ONE: CheckinExtendRoundResult = { extended: 1, skipped: { closed: 1, gameStarted: 1, capReached: 1 }, notOpenYet: 1, ownBoards: 1, failed: 0, addedMinutes: CHECKIN_EXTEND_STEP_MINUTES };
    const { roundBar } = await answered(ALL_ONE);
    const lines = textNodes(roundBar);
    const claims: [string, keyof typeof EXTEND_ROUND_SKIP_COPY][] = [
      ["boards whose check-in has not opened yet", "notOpenYet"],
      ["or has already closed", "closed"],
      ["boards whose game has started", "gameStarted"],
      ["boards with no extensions left", "capReached"],
      ["any board you are playing on yourself", "ownBoards"],
    ];
    for (const [claim, key] of claims) {
      expect(s, `the page says it skips: ${claim}`).toContain(claim);
      expect(lines, `the answer has a line for ${key}`).toContain(plural(EXTEND_ROUND_SKIP_COPY[key], 1));
    }
    expect(claims.length, "anti-vacuity: five skips claimed").toBe(5);
  });
});
