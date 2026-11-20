// Match Day online, Task 8 - the board panel (`BoardFocus`, its pure body `BoardPanelView`, and `BoardPosition`): the chess board, the
// flags and the decisions of ONE online board, in the focus column of the day.
//
// Two ways of looking, on purpose (round-focus.test.tsx does the same): `renderToStaticMarkup` reads what a person would see (copy comes
// from the English dictionary, never typed here), and the hook harness (`renderIsland`, no DOM in this workspace) drives the REAL seam -
// the panel's own read, reducer and runner with the network doubled at `apiV1` - because a pure view cannot see whether the press it
// renders is wired to anything (AGENTS recurring classes 1 and 2). The real chessground `Board` is a dynamic, client-only import: here
// `next/dynamic` answers a stub that prints the props it was given, and the real board mounting is the e2e spec's job.
//
// Where an expected value comes from: counts and clock readings come from the FIXTURE (a clock typed in milliseconds, its reading worked
// out by hand), sentences from the dictionary's entry for the key the spec names, paths from the server's own routes. Anti-vacuity: every
// sweep reports what it checked, and every "no press" claim is paired with the same view WITH its presses.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import { flagsForReader, type ArbiterBoard, type ArbiterFlag } from "@/lib/arbiter-view";
import type { Dict } from "@/lib/i18n-constants";
import type { Reader } from "@/lib/match-day/online";
import type { BoardPosition as PositionData, MatchDayBoard, MatchDayBoardRow, MatchDayOnlineRound } from "@/lib/match-day/types";
import { NEEDS_REASONS } from "@/server/external-play/types";
import { MatchDayBoard as MatchDayBoardSchema } from "@/server/api-v1/schemas/fixtures";
import { initialArbiterDecision } from "../../arbiter-decision";
import type { MatchDayCtx } from "../court-focus";
import { BoardFocus, BoardPanelView, isMatchDayBoard, type BoardFocusProps, type BoardPanelViewProps } from "../board-focus";
import { BoardPosition } from "../board-position";
import { arbiterRound, held, iso, live, meeting, NOW, openWindow, present, round, withState } from "./_online-fixtures";

const MIN = 60_000;

// The one chessground import: a stub that prints what the panel handed the board.
vi.mock("next/dynamic", async () => {
  const { createElement } = await import("react");
  return {
    default: () => (props: Record<string, unknown>) =>
      createElement("span", {
        "data-testid": "board-stub",
        "data-fen": String(props.fen),
        "data-view-only": String(props.viewOnly),
        "data-movable": String(props.movable),
        "data-label": String(props.label),
        "data-last-move": props.lastMove === null ? "" : (props.lastMove as string[]).join(""),
      }),
  };
});
// The clock is a timer in production; here it is a fixed instant (the shell's own clock is tested in the shell's suites).
vi.mock("../../use-extend-clock", () => ({ useExtendClock: vi.fn(() => Date.parse("2026-11-19T18:00:00.000Z")) }));

type Call = { url: string; json?: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const net = vi.hoisted(() => ({ calls: [] as Call[] }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    // Each request waits until the test answers it: "in flight" is a real state here.
    apiV1: (url: string, options?: { json?: unknown }) => new Promise((resolve, reject) => net.calls.push({ url, json: options?.json, resolve, reject })),
  };
});
const { ApiV1Error } = await import("@/lib/client-v1");

const EN = enUi as Record<string, string>;
const t = (key: string, vars: Record<string, string | number> = {}) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), EN[key]!);
/** React escapes text; compare against the escaped form. */
const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const dict = enUi as unknown as Dict;
const ctx = { dict, locale: "en", orgSlug: "club", compSlug: "autumn", competitionId: "comp-1", tz: "Europe/London", readOnly: false, frozen: false, orgId: "org-1" } as unknown as MatchDayCtx;
const EDITOR: Reader = { editor: true, offered: true, frozen: false };
const FROZEN: Reader = { ...EDITOR, frozen: true };
const VIEWER: Reader = { ...EDITOR, editor: false };
const NOT_OFFERED: Reader = { ...EDITOR, offered: false };

// ---- fixtures ------------------------------------------------------------------------------------------------------------------------

/** 1.e4 e5 2.Nf3 Nc6: White to move, the last move b8c6. */
const POSITION: PositionData = { fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3", lastMove: ["b8", "c6"], turn: "white" };
const RND: MatchDayOnlineRound = round("stage-1:3", "playing", arbiterRound([]));
const toRow = (b: ArbiterBoard): MatchDayBoardRow => ({ ...b, stage_id: "stage-1", round_no: 3 });
const answerOf = (b: ArbiterBoard, over: Partial<MatchDayBoard> = {}): MatchDayBoard => ({ ...toRow(b), hold_reason: null, position: null, ...over });

const ADA = { name: "Ada Lovelace", personId: null };
const BEN = { name: "Ben Carson", personId: null };
/** White has 4:32 less... worked out: 272 000 ms as of 4 s ago and running -> 268 000 ms now = 4:28; Black's 301 000 ms is stopped = 5:01. */
const CLOCK = { whiteMs: 272_000, blackMs: 301_000, asOf: iso(NOW - 4_000), running: true, turn: "white" as const };
const LIVE = live(5, { fixtureId: "b-live", boardNo: 4, white: ADA, black: BEN, clock: CLOCK, sides: { home: present("live"), away: present("off") } });
const NOGAME = withState({ kind: "checking_in" }, { fixtureId: "b-wait", boardNo: 2, white: ADA, black: BEN, seats: { white: { here: true, invites: [] }, black: { here: false, invites: ["delivered"] } }, checkin: openWindow(), sides: { home: present("live"), away: meeting() } });

const camera = (over: Partial<Extract<ArbiterFlag, { kind: "camera_lost" }>> = {}): ArbiterFlag => ({
  id: "flag-cam",
  kind: "camera_lost",
  at: iso(NOW - 30 * MIN),
  personName: "Ben C.",
  report: { offSeconds: 90, windowSeconds: 600, intervals: [{ from: iso(NOW - 20 * MIN), to: iso(NOW - 18 * MIN), confirmedByEvents: true }], connections: 2, sessions: 1 },
  windowFrom: iso(NOW - 40 * MIN),
  ...over,
});
const outOfBand: ArbiterFlag = { id: "flag-oob", kind: "out_of_band_play", at: iso(NOW - 10 * MIN), plies: { from: 7, to: 8 } };
const connection: ArbiterFlag = { id: "flag-conn", kind: "camera_connection_problems", at: iso(NOW - 9 * MIN), personName: "Ada L.", seconds: 40, stamps: 2 };
const devices: ArbiterFlag = { id: "flag-dev", kind: "multiple_devices", at: iso(NOW - 8 * MIN), personName: "Ben C.", report: { devices: 2, seconds: 60, intervals: [{ from: iso(NOW - 12 * MIN), to: iso(NOW - 11 * MIN) }] } };
const ALL_FLAGS = [camera(), outOfBand, connection, devices];

const noop = () => {};
const ON = () => ({ extend: vi.fn(), resync: vi.fn(), goOn: vi.fn(), toggleSettle: vi.fn(), settle: vi.fn(), override: vi.fn() });
const viewProps = (b: ArbiterBoard, over: Partial<BoardPanelViewProps> = {}): BoardPanelViewProps => ({
  ctx,
  round: RND,
  row: toRow(b),
  answer: answerOf(b),
  readFailed: false,
  reader: EDITOR,
  decision: initialArbiterDecision(b.fixtureId),
  nowMs: NOW,
  on: ON(),
  backLabel: "All boards",
  onBack: noop,
  ...over,
});
const underEnglish = (node: ReactElement) => renderToStaticMarkup(<DictProvider dict={dict} locale="en">{node}</DictProvider>);
const html = (b: ArbiterBoard, over: Partial<BoardPanelViewProps> = {}) => underEnglish(<BoardPanelView {...viewProps(b, over)} />);

const count = (h: string, testid: string) => h.split(`data-testid="${testid}"`).length - 1;
const has = (h: string, text: string) => h.includes(esc(text));
const tagOf = (h: string, testid: string): string | null => new RegExp(`<[a-z0-9]+\\b[^>]*data-testid="${testid}"[^>]*>`).exec(h)?.[0] ?? null;
/** The inner text of the first element with this test id (tags stripped). */
const textIn = (h: string, testid: string): string | null => {
  const open = new RegExp(`<([a-z0-9]+)\\b[^>]*data-testid="${testid}"[^>]*>`).exec(h);
  if (!open) return null;
  const re = new RegExp(`<(/?)${open[1]}\\b[^>]*>`, "g");
  re.lastIndex = open.index + open[0].length;
  let depth = 1;
  let m: RegExpExecArray | null;
  const from = open.index + open[0].length;
  while ((m = re.exec(h)) !== null) {
    depth += m[1] === "/" ? -1 : 1;
    if (depth === 0) return h.slice(from, m.index).replace(/<[^>]+>/g, "");
  }
  return null;
};

beforeEach(() => {
  net.calls.length = 0;
});

// ---- the position -----------------------------------------------------------------------------------------------------------------------

describe("BoardPosition: the read-only board and the two clocks", () => {
  const bare = (o: Partial<Parameters<typeof BoardPosition>[0]> = {}) =>
    underEnglish(<BoardPosition position={POSITION} white="Ada Lovelace" black="Ben Carson" clock={CLOCK} nowMs={NOW} label="Board, White to move" {...o} />);

  it("hands the board the fen, the last move and the label, view-only and not movable", () => {
    const h = bare();
    const tag = tagOf(h, "board-stub")!;
    expect(tag, "the board stub rendered").not.toBeNull();
    expect(tag).toContain(`data-fen="${POSITION.fen}"`);
    expect(tag).toContain('data-view-only="true"');
    expect(tag).toContain('data-movable="false"');
    expect(tag).toContain('data-last-move="b8c6"');
    expect(tag).toContain('data-label="Board, White to move"');
  });

  it("reads each clock from its base, the running one worked forward to now (4 s on White's)", () => {
    const h = bare();
    expect(textIn(h, "md-board-clock-white-time")).toBe("4:28");
    expect(textIn(h, "md-board-clock-black-time")).toBe("5:01");
    expect(tagOf(h, "md-board-clock-white"), "White is the side to move").toContain('data-active="true"');
    expect(tagOf(h, "md-board-clock-black")).toContain('data-active="false"');
    expect(has(h, "Ada Lovelace") && has(h, "Ben Carson")).toBe(true);
  });

  it("before the viewer's clock is known it shows the bases, not a guess", () => {
    const h = bare({ nowMs: null });
    expect(textIn(h, "md-board-clock-white-time")).toBe("4:32");
    expect(textIn(h, "md-board-clock-black-time")).toBe("5:01");
  });

  it("a stopped clock does not run (the same instant, the same face)", () => {
    const h = bare({ clock: { ...CLOCK, running: false } });
    expect(textIn(h, "md-board-clock-white-time")).toBe("4:32");
  });

  it("no clock on file: the board still shows, and each clock is a dash, never 0:00", () => {
    const h = bare({ clock: null });
    expect(count(h, "board-stub")).toBe(1);
    expect(textIn(h, "md-board-clock-white-time")).toBe("—");
    expect(textIn(h, "md-board-clock-black-time")).toBe("—");
  });
});

// ---- the panel, read as a person reads it --------------------------------------------------------------------------------------------

describe("BoardPanelView: what the board shows", () => {
  it("EMPTY CASE FIRST: before the first read answers, the panel is the list's own row - its name and state - and says it is loading", () => {
    const h = html(LIVE, { answer: null });
    expect(count(h, "md-online-state"), "the state line").toBe(1);
    expect(count(h, "board-stub"), "no position yet, so no board").toBe(0);
    expect(count(h, "md-board-loading")).toBe(1);
    expect(has(h, t("matchDay.board.loading"))).toBe(true);
    expect(count(h, "md-board-nogame"), "loading is not 'no game'").toBe(0);
  });

  it("a read that failed with nothing to show says so, and keeps the row's header", () => {
    const h = html(LIVE, { answer: null, readFailed: true });
    expect(count(h, "md-board-read-failed")).toBe(1);
    expect(has(h, t("matchDay.board.readFailed"))).toBe(true);
    expect(count(h, "md-board-loading")).toBe(0);
  });

  it("a read that failed AFTER one answered keeps the board and adds the line (the last answer stays)", () => {
    const h = html(LIVE, { answer: answerOf(LIVE, { position: POSITION }), readFailed: true });
    expect(count(h, "board-stub")).toBe(1);
    expect(count(h, "md-board-read-failed")).toBe(1);
  });

  it("a live board with a position: the board gets the fen, both clocks run off the board's own clock", () => {
    const h = html(LIVE, { answer: answerOf(LIVE, { position: POSITION }) });
    expect(tagOf(h, "board-stub")).toContain(`data-fen="${POSITION.fen}"`);
    // The label names the side to move, from the dictionary's own words.
    expect(tagOf(h, "board-stub")).toContain(`data-label="${esc(t("externalPlay.room.board.whiteToMove"))}"`);
    expect(textIn(h, "md-board-clock-white-time")).toBe("4:28");
    expect(textIn(h, "md-board-clock-black-time")).toBe("5:01");
    expect(count(h, "md-board-nogame")).toBe(0);
    expect(tagOf(h, "md-online-state"), "the row's state word survives into the panel").not.toBeNull();
  });

  it("a finished board's label says it is the final position", () => {
    const over = withState({ kind: "result", score: "1-0", noResult: false }, { fixtureId: "b-over", white: ADA, black: BEN });
    const h = html(over, { answer: answerOf(over, { position: POSITION }) });
    expect(tagOf(h, "board-stub")).toContain(`data-label="${esc(t("externalPlay.room.board.final"))}"`);
  });

  it("a board with no game shows the two seats' check-in and invite words, and no board", () => {
    const h = html(NOGAME);
    expect(count(h, "board-stub")).toBe(0);
    expect(count(h, "md-board-nogame")).toBe(1);
    expect(has(h, t("matchDay.board.noGame"))).toBe(true);
    expect(count(h, "md-board-seat")).toBe(2);
    // White is here; Black is not, and the invite he was sent was delivered. The words are the dictionary's, by the seat words' own keys.
    const white = /<li[^>]*data-testid="md-board-seat"[^>]*data-colour="white"[^>]*>[\s\S]*?<\/li>/.exec(h)![0];
    const black = /<li[^>]*data-testid="md-board-seat"[^>]*data-colour="black"[^>]*>[\s\S]*?<\/li>/.exec(h)![0];
    expect(white).toContain(esc(t("arbiter.column.here")));
    expect(black).toContain(esc(t("arbiter.column.notHereYet")));
    expect(black).toContain(esc(t("arbiter.invite.delivered")));
    expect(white).not.toContain(esc(t("arbiter.column.notHereYet")));
  });

  it("a held board with no seats and no game still says there is no game (never an empty box)", () => {
    const heldBoard = held(0, { fixtureId: "b-held", white: ADA, black: BEN });
    const h = html(heldBoard);
    expect(count(h, "md-board-nogame")).toBe(1);
    expect(count(h, "md-board-seat"), "seat words are the check-in's: none outside one").toBe(2);
    expect(count(h, "md-board-seat")).toBe(2);
  });

  it("the cameras seam: a node handed in takes the top panel (Task 9 fills it), and the position does not draw beside it", () => {
    const h = html(LIVE, { answer: answerOf(LIVE, { position: POSITION }), cameras: <p data-testid="cameras-probe">two tiles</p> });
    expect(count(h, "cameras-probe")).toBe(1);
    expect(count(h, "md-board-cameras")).toBe(1);
    expect(count(h, "board-stub")).toBe(0);
    // Without it the position is the panel (the pair).
    expect(count(html(LIVE, { answer: answerOf(LIVE, { position: POSITION }) }), "board-stub")).toBe(1);
  });

  it("presence marks sit beside the names: Ada here, Ben present with the camera off, each in the colour's own seat", () => {
    const h = html(LIVE, { answer: answerOf(LIVE, { position: POSITION }) });
    // whiteSide is "home": Ada (White) is the home seat, present with a live camera; Ben (Black) is away, camera off.
    const seats = [...h.matchAll(/<li[^>]*data-testid="md-board-seat"[^>]*data-colour="(white|black)"[^>]*>([\s\S]*?)<\/li>/g)];
    expect(seats.length, "both seats listed").toBe(2);
    const mark = (colour: string) => /data-mark="(here|off|away)"/.exec(seats.find((s) => s[1] === colour)![2]!)?.[1] ?? null;
    expect(mark("white")).toBe("here");
    expect(mark("black")).toBe("off");
    expect(count(h, "md-presence")).toBe(2);
  });

  it("the marks follow the COLOUR through a swap: with Black's seat at home, White's mark is the away seat's", () => {
    const swapped = { ...LIVE, whiteSide: "away" as const };
    const h = html(swapped, { answer: answerOf(swapped, { position: POSITION }) });
    const seats = [...h.matchAll(/<li[^>]*data-testid="md-board-seat"[^>]*data-colour="(white|black)"[^>]*>([\s\S]*?)<\/li>/g)];
    const mark = (colour: string) => /data-mark="(here|off|away)"/.exec(seats.find((s) => s[1] === colour)![2]!)?.[1] ?? null;
    expect(seats.length).toBe(2);
    // The home seat is present with a live camera, the away seat with it off (LIVE's own sides); White now plays away.
    expect(mark("white")).toBe("off");
    expect(mark("black")).toBe("here");
  });

  it("a board that plays without cameras draws no marks, and a live one draws no seat strip at all (the clocks name them)", () => {
    const off = { ...LIVE, cameraPolicy: "off" as const };
    const h = html(off, { answer: answerOf(off, { position: POSITION }) });
    expect(count(h, "md-presence")).toBe(0);
    expect(count(h, "md-board-seat")).toBe(0);
    expect(count(h, "md-board-clock-white")).toBe(1);
  });

  it("the Open match link goes to the match's own page, and is absent when the board has no match number", () => {
    const h = html(LIVE);
    expect(tagOf(h, "md-open-pad")).toContain(`href="/o/club/c/autumn/d/online-rapid/f/${LIVE.fixtureNo}"`);
    const none = { ...LIVE, fixtureNo: null };
    expect(count(html(none), "md-open-pad")).toBe(0);
  });
});

describe("BoardPanelView: why a board is held (editors only)", () => {
  const heldBoard = held(0, { fixtureId: "b-link", white: ADA, black: BEN, canSettle: true });

  it("an editor reads the hold's title and its sentence, from the reason the server stamped", () => {
    const h = html(heldBoard, { answer: answerOf(heldBoard, { hold_reason: "lichess_unlinked" }) });
    expect(count(h, "md-board-hold")).toBe(1);
    expect(tagOf(h, "md-board-hold")).toContain('data-reason="lichess_unlinked"');
    expect(has(h, t("externalPlay.held.lichessUnlinked"))).toBe(true);
    expect(has(h, t("externalPlay.reason.lichessUnlinked"))).toBe(true);
  });

  it("a reader the server sent no reason (null) sees no hold card, only the state word (the pair)", () => {
    const h = html(heldBoard, { answer: answerOf(heldBoard, { hold_reason: null }), reader: VIEWER });
    expect(count(h, "md-board-hold")).toBe(0);
    expect(tagOf(h, "md-online-state")).not.toBeNull();
  });

  it("a view-only reader is not shown a reason even if one reached the page (the view asks too)", () => {
    const h = html(heldBoard, { answer: answerOf(heldBoard, { hold_reason: "fair_play" }), reader: VIEWER });
    expect(count(h, "md-board-hold")).toBe(0);
    expect(count(html(heldBoard, { answer: answerOf(heldBoard, { hold_reason: "fair_play" }) }), "md-board-hold"), "the editor's, the pair").toBe(1);
  });

  it("every reason in the server's vocabulary has words (a sweep, with its count)", () => {
    let checked = 0;
    for (const reason of NEEDS_REASONS) {
      const h = html(heldBoard, { answer: answerOf(heldBoard, { hold_reason: reason }) });
      expect(count(h, "md-board-hold"), reason).toBe(1);
      const body = textIn(h, "md-board-hold")!;
      expect(body.length, `${reason}: words`).toBeGreaterThan(10);
      expect(body, `${reason}: no raw key`).not.toMatch(/externalPlay\./);
      checked += 1;
    }
    expect(checked, "the sweep checked every reason").toBe(NEEDS_REASONS.length);
    expect(checked).toBeGreaterThan(0);
  });
});

describe("BoardPanelView: flags", () => {
  const flagged = (flags: ArbiterFlag[], over: Partial<ArbiterBoard> = {}) => held(flags.length, { fixtureId: "b-flag", white: ADA, black: BEN, flags, ...over });

  it("EMPTY CASE FIRST: a board with no flags and no pending report has no flag section", () => {
    const h = html(LIVE);
    expect(count(h, "md-board-flags")).toBe(0);
    expect(count(h, "md-board-flag")).toBe(0);
  });

  it("an editor gets every flag card whole: the kinds, the player named, the times", () => {
    const b = flagged(ALL_FLAGS);
    const h = html(b, { answer: answerOf(b) });
    expect(count(h, "md-board-flag"), "one card per flag").toBe(ALL_FLAGS.length);
    expect([...h.matchAll(/data-testid="md-board-flag"[^>]*data-kind="([a-z_]+)"/g)].map((m) => m[1])).toEqual(ALL_FLAGS.map((f) => f.kind));
    // The names the flags carry (short forms the header never prints, so this is the card's own text).
    expect(has(h, "Ben C.") && has(h, "Ada L.")).toBe(true);
    expect(has(h, t("arbiter.flags.lede"))).toBe(true);
    expect(has(h, t("matchDay.board.flagsViewer"))).toBe(false);
  });

  it("a viewer's stripped flags draw without error: the kind and the time, nothing the server did not send, no 'could not be read'", () => {
    const stripped = flagsForReader(ALL_FLAGS, false);
    const b = flagged(stripped);
    const h = html(b, { answer: answerOf(b), reader: VIEWER });
    expect(count(h, "md-board-flag")).toBe(ALL_FLAGS.length);
    // Each kind's own chip, from the dictionary's key for it.
    expect(has(h, t("arbiter.flag.outOfBand.chip"))).toBe(true);
    expect(has(h, t("arbiter.flag.cameraOff.chipPlain"))).toBe(true);
    expect(has(h, t("arbiter.flag.connection.chipPlain"))).toBe(true);
    expect(has(h, t("arbiter.flag.devices.chipPlain"))).toBe(true);
    // Found at <time>: one per flag, the venue's clock.
    expect(h.split(esc(t("arbiter.flag.foundAt", { time: "" })).trim()).length - 1, "a time per flag").toBeGreaterThanOrEqual(ALL_FLAGS.length);
    expect(has(h, t("matchDay.board.flagsViewer"))).toBe(true);
    expect(has(h, "Ben C.") || has(h, "Ada L."), "a viewer's card names nobody").toBe(false);
    // The details the server stripped are not "unread": a viewer is told the details are the organiser's, not that something failed.
    for (const unread of ["arbiter.flag.cameraOff.unread", "arbiter.flag.connection.unread", "arbiter.flag.devices.unread", "arbiter.flag.outOfBand.unread"]) {
      expect(h, unread).not.toContain(esc(t(unread, { name: t("arbiter.flag.aPlayer") })));
    }
  });

  it("a camera report still to come is a card of its own, for either reader", () => {
    const b = flagged([], { cameraReport: "pending" });
    for (const reader of [EDITOR, VIEWER]) {
      const h = html(b, { answer: answerOf(b), reader });
      expect(has(h, t("arbiter.flag.pending.chip"))).toBe(true);
    }
  });

  it("(O1) a cancelled board with an open flag keeps its flag cards and the review press - and is not settled (it is over)", () => {
    const cancelled = withState({ kind: "cancelled" }, { fixtureId: "b-cancel", white: ADA, black: BEN, flags: [camera()], flagCount: 1 });
    const h = html(cancelled, { answer: answerOf(cancelled) });
    expect(count(h, "md-board-flag")).toBe(1);
    expect(has(h, t("externalPlay.queue.markReviewed")), "the review press of an over board").toBe(true);
    expect(count(h, "md-board-nogame"), "a cancelled board has no game to show").toBe(1);
    // The settle is never offered on a board that is over (`offersSettle`): the pair is a live board with the same press.
    expect(has(h, t("arbiter.decide.settle"))).toBe(false);
    const liveFlagged = flagged([camera()], { canSettle: true });
    expect(has(html(liveFlagged, { answer: answerOf(liveFlagged) }), t("arbiter.decide.settle"))).toBe(true);
  });
});

// ---- the decisions ------------------------------------------------------------------------------------------------------------------

describe("BoardPanelView: who is offered which decision", () => {
  /** A held board with every decision the loader would allow: a game to resync, a flag to close, a result to settle, and an open check-in. */
  const deciding = withState(
    { kind: "on_hold" },
    { fixtureId: "b-decide", white: ADA, black: BEN, canResync: true, canSettle: true, flags: [camera()], flagCount: 1, checkin: openWindow(), cameraPolicy: "required" },
  );
  const board = () => answerOf(deciding, { hold_reason: "clock_flag_unsettled" });
  const decide = (reader: Reader, over: Partial<BoardPanelViewProps> = {}) => html(deciding, { answer: board(), reader, ...over });
  const resync = t("arbiter.decide.resync");
  const goOn = t("arbiter.decide.goOn");
  const settle = t("arbiter.decide.settle");
  const extendLabel = t("externalPlay.checkinExtend.board", { minutes: 5, left: 3 });

  it("an editor in an offered club, unfrozen: every decision AND the +5 min (the baseline of every pair below)", () => {
    const h = decide(EDITOR);
    expect(count(h, "arbiter-decision")).toBe(1);
    for (const word of [resync, goOn, settle, extendLabel]) expect(has(h, word), word).toBe(true);
    expect(count(h, "arbiter-extend-board")).toBe(1);
  });

  it("a viewer sees no decision section and no outage card - and no press of any kind", () => {
    const h = decide(VIEWER, { videoUnavailable: true });
    expect(count(h, "arbiter-decision")).toBe(0);
    expect(count(h, "arbiter-outage")).toBe(0);
    for (const word of [resync, goOn, settle, extendLabel]) expect(has(h, word), word).toBe(false);
    // The viewer still reads the board: the pair is the same board with its flag card.
    expect(count(h, "md-board-flag")).toBe(1);
  });

  it("an editor in a club not offered online chess: resync, go on and settle, and NO +5 min and no reason for its absence", () => {
    const h = decide(NOT_OFFERED);
    for (const word of [resync, goOn, settle]) expect(has(h, word), word).toBe(true);
    expect(has(h, extendLabel)).toBe(false);
    expect(count(h, "arbiter-extend-board")).toBe(0);
    expect(count(h, "arbiter-extend-why"), "Match Day prints no unprompted reason").toBe(0);
  });

  it("(O4) a FROZEN competition: the finishing decisions still render (scoring is exempt), the +5 min does not; unfrozen it does (the pair)", () => {
    const frozen = decide(FROZEN);
    for (const word of [resync, goOn, settle]) expect(has(frozen, word), word).toBe(true);
    expect(has(frozen, extendLabel)).toBe(false);
    expect(count(frozen, "arbiter-extend-board")).toBe(0);
    expect(has(decide({ ...FROZEN, frozen: false }), extendLabel)).toBe(true);
  });

  it("(O4) the outage card ('let this board play without video') is a finishing decision: shown for a frozen editor, not for a viewer", () => {
    expect(count(decide(FROZEN, { videoUnavailable: true }), "arbiter-outage")).toBe(1);
    expect(count(decide(EDITOR, { videoUnavailable: true }), "arbiter-outage")).toBe(1);
    expect(count(decide(VIEWER, { videoUnavailable: true }), "arbiter-outage")).toBe(0);
    // Only while the vendor is down (the seam Task 9 sets), only while the board is still to be played and not already let go.
    expect(count(decide(EDITOR, { videoUnavailable: false }), "arbiter-outage")).toBe(0);
    expect(count(decide(EDITOR, { videoUnavailable: true, answer: answerOf({ ...deciding, videoOverridden: true }) }), "arbiter-outage")).toBe(0);
  });

  it("a board that is not held: the go-on press is the flag's, and a finished board's is 'mark as reviewed' (words by state)", () => {
    const over = withState({ kind: "result", score: "1-0", noResult: false }, { fixtureId: "b-done", white: ADA, black: BEN, flags: [camera()], flagCount: 1 });
    const h = html(over, { answer: answerOf(over) });
    expect(has(h, t("externalPlay.queue.markReviewed"))).toBe(true);
    expect(has(h, goOn)).toBe(false);
  });

  it("the settle disclosure offers the six choices by colour; an older round's link hold offers No result (a league abandons)", () => {
    const link = withState({ kind: "on_hold" }, { fixtureId: "b-old", white: ADA, black: BEN, canSettle: true, noResultOffer: { kind: "void" } });
    const open = { ...initialArbiterDecision(link.fixtureId), settleOpen: true };
    const h = html(link, { answer: answerOf(link, { hold_reason: "lichess_unlinked", round_no: 1 }), decision: open });
    expect([...h.matchAll(/data-settle="([a-z_]+)"/g)].map((m) => m[1]).sort()).toEqual(["away_wins", "draw", "home_wins", "no_result"]);
    // A Swiss round refuses the void and says why (the pair).
    const swiss = { ...link, noResultOffer: { kind: "refused" as const, why: "swiss" as const } };
    const s = html(swiss, { answer: answerOf(swiss), decision: open });
    expect(s).not.toContain('data-settle="no_result"');
    expect(count(s, "arbiter-settle-guidance")).toBe(1);
  });
});

// ---- the guard ----------------------------------------------------------------------------------------------------------------------

describe("isMatchDayBoard: the answer the panel will dereference", () => {
  const UUID_A = "11111111-1111-4111-8111-111111111111";
  const UUID_B = "22222222-2222-4222-8222-222222222222";
  const valid = () => JSON.parse(JSON.stringify({ ...answerOf(LIVE, { position: POSITION, fixtureId: UUID_A, stage_id: UUID_B }) })) as Record<string, unknown>;

  it("accepts what the server sends, with a position and without", () => {
    expect(isMatchDayBoard(valid())).toBe(true);
    expect(isMatchDayBoard({ ...valid(), position: null })).toBe(true);
  });

  it("rejects what the panel could not draw: not an object, no state, no flags, no sides, a bad position", () => {
    const bad: [string, unknown][] = [
      ["null", null],
      ["a string", "board"],
      ["an array", []],
      ["no state", { ...valid(), state: undefined }],
      ["flags not an array", { ...valid(), flags: "none" }],
      ["no sides", { ...valid(), sides: undefined }],
      ["no names", { ...valid(), white: undefined }],
    ];
    for (const [name, raw] of bad) expect(isMatchDayBoard(raw), name).toBe(false);
    expect(bad.length).toBeGreaterThan(0);
  });

  it("agrees with the server's own schema on the keys the schema declares (a sweep: both verdicts, per case)", () => {
    const cases: [string, Record<string, unknown>, boolean][] = [
      ["valid with a position", valid(), true],
      ["valid, position null", { ...valid(), position: null }, true],
      ["an undeclared extra key", { ...valid(), extra: 1 }, true],
      ["position missing", { ...valid(), position: undefined }, false],
      ["position.fen a number", { ...valid(), position: { ...POSITION, fen: 7 } }, false],
      ["position.turn unknown", { ...valid(), position: { ...POSITION, turn: "green" } }, false],
      ["position.lastMove one square", { ...valid(), position: { ...POSITION, lastMove: ["e2"] } }, false],
      ["hold_reason outside the vocabulary", { ...valid(), hold_reason: "bogus" }, false],
      ["hold_reason missing", { ...valid(), hold_reason: undefined }, false],
      ["every real hold_reason", { ...valid(), hold_reason: NEEDS_REASONS[0] }, true],
      ["stage_id missing", { ...valid(), stage_id: undefined }, false],
      ["round_no a string", { ...valid(), round_no: "3" }, false],
    ];
    let accepted = 0;
    let rejected = 0;
    for (const [name, raw, expected] of cases) {
      const server = MatchDayBoardSchema.safeParse(raw).success;
      expect(server, `${name}: the server's verdict is the expectation's`).toBe(expected);
      expect(isMatchDayBoard(raw), `${name}: the client's verdict agrees`).toBe(server);
      if (server) accepted += 1;
      else rejected += 1;
    }
    expect(accepted, "the sweep saw acceptances").toBeGreaterThan(0);
    expect(rejected, "the sweep saw refusals").toBeGreaterThan(0);
    expect(accepted + rejected).toBe(cases.length);
  });

  it("knows every reason the server does: the client's list is the held-copy table's, which tsc keeps total over the vocabulary", () => {
    for (const reason of NEEDS_REASONS) expect(isMatchDayBoard({ ...valid(), hold_reason: reason }), reason).toBe(true);
  });
});

// ---- the seam: the read, the reducer and the runner ---------------------------------------------------------------------------------

describe("BoardFocus: the read rides the poll, the decisions are the runner's", () => {
  const focusProps = (b: ArbiterBoard, o: Partial<BoardFocusProps> = {}): BoardFocusProps => ({
    ctx,
    round: RND,
    row: toRow(b),
    reader: EDITOR,
    nowMs: NOW,
    refreshKey: 1,
    backLabel: "All boards",
    onBack: noop,
    onChanged: noop,
    onFrozen: noop,
    ...o,
  });
  const viewOf = (ui: ReturnType<typeof renderIsland<BoardFocusProps>>) => propsOf(ui.tree().find((e) => e.type === BoardPanelView)!) as unknown as BoardPanelViewProps;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const reads = () => net.calls.filter((c) => c.url.endsWith("/match-day-board"));
  const READ = `/api/v1/fixtures/${LIVE.fixtureId}/match-day-board`;
  const full = (b: ArbiterBoard, over: Partial<MatchDayBoard> = {}) => JSON.parse(JSON.stringify(answerOf(b, { position: POSITION, ...over })));

  it("EMPTY CASE FIRST: mounting sends exactly one read, of this board, with no body, and shows nothing read yet", () => {
    const ui = renderIsland(BoardFocus, focusProps(LIVE));
    expect(net.calls.map((c) => [c.url, c.json])).toEqual([[READ, undefined]]);
    expect(viewOf(ui).answer).toBeNull();
    expect(viewOf(ui).readFailed).toBe(false);
  });

  it("the answer reaches the view, whole", async () => {
    const ui = renderIsland(BoardFocus, focusProps(LIVE));
    net.calls[0]!.resolve(full(LIVE));
    await flush();
    expect(viewOf(ui).answer?.position).toEqual(POSITION);
    expect(viewOf(ui).readFailed).toBe(false);
  });

  it("a new refreshKey is exactly one more read; the same key again is none (2 after one change, 2 after a re-render)", async () => {
    const ui = renderIsland(BoardFocus, focusProps(LIVE, { refreshKey: 1 }));
    net.calls[0]!.resolve(full(LIVE));
    await flush();
    ui.rerender(focusProps(LIVE, { refreshKey: 2 }));
    expect(reads(), "mount + one change").toHaveLength(2);
    ui.rerender(focusProps(LIVE, { refreshKey: 2 }));
    expect(reads(), "the same key again").toHaveLength(2);
    ui.rerender(focusProps(LIVE, { refreshKey: 2, nowMs: NOW + MIN }));
    expect(reads(), "a new minute of the shell's clock is not a poll").toHaveLength(2);
    expect(new Set(reads().map((c) => c.url)), "every read is of this board").toEqual(new Set([READ]));
  });

  it("the board stays on screen while the next read is out, and a failed read keeps it (the last answer) with the line", async () => {
    const ui = renderIsland(BoardFocus, focusProps(LIVE, { refreshKey: 1 }));
    net.calls[0]!.resolve(full(LIVE));
    await flush();
    ui.rerender(focusProps(LIVE, { refreshKey: 2 }));
    expect(viewOf(ui).answer?.position, "kept while the next read is in flight").toEqual(POSITION);
    net.calls[1]!.reject(new ApiV1Error("offline", 503, "UNAVAILABLE"));
    await flush();
    expect(viewOf(ui).answer?.position, "kept after the failed read").toEqual(POSITION);
    expect(viewOf(ui).readFailed).toBe(true);
    // The next good read clears the line.
    ui.rerender(focusProps(LIVE, { refreshKey: 3 }));
    net.calls[2]!.resolve(full(LIVE, { position: { ...POSITION, turn: "black" } }));
    await flush();
    expect(viewOf(ui).readFailed).toBe(false);
    expect(viewOf(ui).answer?.position?.turn).toBe("black");
  });

  it("an older read that answers late never replaces a newer one's board", async () => {
    const ui = renderIsland(BoardFocus, focusProps(LIVE, { refreshKey: 1 }));
    ui.rerender(focusProps(LIVE, { refreshKey: 2 }));
    expect(reads()).toHaveLength(2);
    net.calls[1]!.resolve(full(LIVE, { position: { ...POSITION, turn: "black" } }));
    await flush();
    net.calls[0]!.resolve(full(LIVE, { position: { ...POSITION, turn: "white" } }));
    await flush();
    expect(viewOf(ui).answer?.position?.turn, "the newer read's answer stands").toBe("black");
  });

  it("an answer the panel cannot read is a failed read, never a half-drawn board; so is one for another board", async () => {
    const ui = renderIsland(BoardFocus, focusProps(LIVE, { refreshKey: 1 }));
    net.calls[0]!.resolve({ fixtureId: LIVE.fixtureId, position: "nope" });
    await flush();
    expect(viewOf(ui).answer).toBeNull();
    expect(viewOf(ui).readFailed).toBe(true);
    ui.rerender(focusProps(LIVE, { refreshKey: 2 }));
    net.calls[1]!.resolve(full({ ...LIVE, fixtureId: "someone-else" }));
    await flush();
    expect(viewOf(ui).answer, "another board's answer is not this board's").toBeNull();
    expect(viewOf(ui).readFailed).toBe(true);
  });

  it("a settle the server refuses keeps its notice through the next poll (and the next read still goes out)", async () => {
    const b = withState({ kind: "on_hold" }, { fixtureId: "b-settle", white: ADA, black: BEN, canSettle: true });
    const ui = renderIsland(BoardFocus, focusProps(b, { refreshKey: 1 }));
    net.calls[0]!.resolve(full(b));
    await flush();
    void viewOf(ui).on.settle("home_wins");
    expect(net.calls.at(-1)).toMatchObject({ url: "/api/v1/fixtures/b-settle/external-play/resolve", json: { kind: "home_wins" } });
    net.calls.at(-1)!.reject(new ApiV1Error("resolved", 409, "ALREADY_RESOLVED"));
    await flush();
    expect(viewOf(ui).decision.notice).toMatchObject({ kind: "settle_failed", code: "ALREADY_RESOLVED", boardId: "b-settle" });
    const before = net.calls.length;
    ui.rerender(focusProps(b, { refreshKey: 2 }));
    expect(net.calls.length, "the poll's read goes out").toBe(before + 1);
    net.calls.at(-1)!.resolve(full(b));
    await flush();
    expect(viewOf(ui).decision.notice, "the refusal outlives the poll").toMatchObject({ kind: "settle_failed", code: "ALREADY_RESOLVED" });
  });

  it("a press that went through refreshes the day AND re-reads this board (the answer on screen is the one after the press)", async () => {
    const onChanged = vi.fn();
    const b = withState({ kind: "on_hold" }, { fixtureId: "b-ok", white: ADA, black: BEN, canSettle: true, canResync: true });
    const ui = renderIsland(BoardFocus, focusProps(b, { onChanged }));
    net.calls[0]!.resolve(full(b));
    await flush();
    void viewOf(ui).on.resync();
    expect(net.calls.at(-1)).toMatchObject({ url: "/api/v1/fixtures/b-ok/external-play/resync" });
    net.calls.at(-1)!.resolve({ read: true, adopted: 2 });
    await flush();
    expect(onChanged, "the shell's quiet day read, once").toHaveBeenCalledTimes(1);
    expect(reads(), "and this board's own read, straight after the press").toHaveLength(2);
    expect(viewOf(ui).decision.notice).toMatchObject({ kind: "resynced", adopted: 2 });
  });

  it("(O4) the +5 min of a competition that froze under the page: the server's 402 is worded as the freeze, and the shell is told once", async () => {
    const onFrozen = vi.fn();
    const b = withState({ kind: "checking_in" }, { fixtureId: "b-402", white: ADA, black: BEN, checkin: openWindow(), seats: { white: { here: true, invites: [] }, black: { here: false, invites: [] } } });
    const ui = renderIsland(BoardFocus, focusProps(b, { onFrozen }));
    net.calls[0]!.resolve(full(b, { position: null }));
    await flush();
    void viewOf(ui).on.extend();
    expect(net.calls.at(-1)).toMatchObject({ url: "/api/v1/fixtures/b-402/external-play/extend-checkin" });
    net.calls.at(-1)!.reject(new ApiV1Error("frozen", 402, "PAYMENT_REQUIRED"));
    await flush();
    expect(onFrozen, "MD-R30: the shell learns the freeze from the answer").toHaveBeenCalledTimes(1);
    expect(viewOf(ui).decision.notice).toMatchObject({ kind: "extend_failed", code: "PAYMENT_REQUIRED" });
    // The sentence a person reads is the freeze's, not "failed".
    const h = underEnglish(<BoardPanelView {...viewOf(ui)} />);
    expect(has(h, t("runsheet.round.err.frozen"))).toBe(true);
    expect(has(h, t("arbiter.notice.failed"))).toBe(false);
    ui.rerender(focusProps(b, { onFrozen, refreshKey: 2 }));
    expect(onFrozen, "a later poll does not tell it again").toHaveBeenCalledTimes(1);
  });

  it("a 402 on a FINISHING decision is not the freeze (scoring is exempt): the shell is not told", async () => {
    const onFrozen = vi.fn();
    const b = withState({ kind: "on_hold" }, { fixtureId: "b-402b", white: ADA, black: BEN, canSettle: true });
    const ui = renderIsland(BoardFocus, focusProps(b, { onFrozen }));
    net.calls[0]!.resolve(full(b));
    await flush();
    void viewOf(ui).on.settle("draw");
    net.calls.at(-1)!.reject(new ApiV1Error("odd", 402, "PAYMENT_REQUIRED"));
    await flush();
    expect(onFrozen).not.toHaveBeenCalled();
  });

  it("the handlers carry the reader's rights too: a viewer sends nothing; a frozen editor settles but cannot +5; an unoffered club cannot +5", async () => {
    const b = withState({ kind: "on_hold" }, { fixtureId: "b-rights", white: ADA, black: BEN, canSettle: true, canResync: true, flags: [camera()], flagCount: 1, checkin: openWindow() });
    const posts = () => net.calls.filter((c) => !c.url.endsWith("/match-day-board")).map((c) => c.url.replace("/api/v1/fixtures/b-rights/external-play/", ""));

    const viewer = renderIsland(BoardFocus, focusProps(b, { reader: VIEWER }));
    const v = viewOf(viewer).on;
    void v.resync();
    void v.goOn([camera().id]);
    void v.settle("draw");
    void v.extend();
    void v.override();
    expect(posts(), "a viewer's every press is refused before the network").toEqual([]);

    const frozen = renderIsland(BoardFocus, focusProps(b, { reader: FROZEN }));
    void viewOf(frozen).on.extend();
    expect(posts(), "frozen: no +5").toEqual([]);
    void viewOf(frozen).on.settle("draw");
    expect(posts(), "frozen: the settle goes").toEqual(["resolve"]);

    net.calls.length = 0;
    const unoffered = renderIsland(BoardFocus, focusProps(b, { reader: NOT_OFFERED }));
    void viewOf(unoffered).on.extend();
    expect(posts(), "not offered: no +5").toEqual([]);
    void viewOf(unoffered).on.resync();
    expect(posts(), "not offered: the resync goes").toEqual(["resync"]);
  });

  it("the video override is the audit log's: its note says it was Match Day", () => {
    const b = withState({ kind: "live", moveNo: 3 }, { fixtureId: "b-ov", white: ADA, black: BEN, cameraPolicy: "required" });
    const ui = renderIsland(BoardFocus, focusProps(b));
    void viewOf(ui).on.override();
    const call = net.calls.at(-1)!;
    expect(call.url).toBe("/api/v1/fixtures/b-ov/external-play/video-override");
    const note = (call.json as { note: string }).note;
    expect(note).toMatch(/Match Day/);
    expect(note).not.toMatch(/arbiter panel/i);
  });

  it("the panel keys its decisions on the board it was handed: one fixture, one reducer", () => {
    const ui = renderIsland(BoardFocus, focusProps(LIVE));
    expect(viewOf(ui).decision.boardId).toBe(LIVE.fixtureId);
  });
});

describe("the copy the panel adds exists in every language", () => {
  const KEYS = ["matchDay.board.noGame", "matchDay.board.loading", "matchDay.board.readFailed", "matchDay.board.flagsViewer"];
  it("each new key has its own words in en, es, fr and nl (a sweep, with its count)", () => {
    let checked = 0;
    for (const [name, d] of [["en", enUi], ["es", esUi], ["fr", frUi], ["nl", nlUi]] as const) {
      for (const key of KEYS) {
        const value = (d as Record<string, string>)[key];
        expect(value, `${name} ${key}`).toBeTypeOf("string");
        expect(value!.length, `${name} ${key}`).toBeGreaterThan(8);
        if (name !== "en") expect(value, `${name} ${key} is translated, not copied`).not.toBe(EN[key]);
        checked += 1;
      }
    }
    expect(checked).toBe(KEYS.length * 4);
  });
});
