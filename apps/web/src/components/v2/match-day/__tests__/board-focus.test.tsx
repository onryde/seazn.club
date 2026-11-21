// Match Day online, Task 8 - the board panel (`BoardFocus`, its pure body `BoardPanelView`, and `BoardPosition`): the chess board, the
// flags and the decisions of ONE online board, in the focus column of the day.
//
// Chess only: the board panel is the online-chess board's (a board the shell opens through the online block); no other sport reaches it, so
// the sport sweep this suite owes is the one over the hold reasons and flag kinds, not over the sport registry.
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
import { RETIRED_EXTEND_WORDS } from "@/lib/__tests__/_retired-extend-reasons";
import type { MatchDayCtx } from "../court-focus";
import { BoardFocus, BoardPanelView, isMatchDayBoard, type BoardFocusProps, type BoardPanelViewProps } from "../board-focus";
import { BoardPosition } from "../board-position";
import type { JoinViews } from "../online/arbiter-joins";
import type { ArbiterVideoView } from "../online/arbiter-video";
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
/** A side whose player has arrived: the room is open and the loader calls it joinable (the only kind the shell joins). */
const joinable = (camera: "live" | "off" = "live") => ({ ...present(camera), joinable: true });
/** What the shell's `useArbiterJoins` hands the panel for a board: a view per side, keyed the way the hook keys them. */
const joinsFor = (b: ArbiterBoard, kinds: Partial<Record<"home" | "away", ArbiterVideoView>>) => ({
  views: new Map(Object.entries(kinds).map(([side, v]) => [`${b.fixtureId}:${side}`, v])) as unknown as JoinViews,
  retry: vi.fn(),
});
const WATCHING: ArbiterVideoView = { kind: "watching", tile: { present: true, live: true, offSinceMs: null, track: null } };
const UNAVAILABLE: ArbiterVideoView = { kind: "unavailable" };
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
  cameraMode: "board",
  onCameraMode: noop,
  camerasFolded: false,
  onCamerasFolded: noop,
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

/** The inner HTML of the first element with this test id (tags kept): what sits INSIDE it, nested elements and all. */
const innerOf = (h: string, testid: string): string | null => {
  const open = new RegExp(`<([a-z0-9]+)\\b[^>]*data-testid="${testid}"[^>]*>`).exec(h);
  if (!open) return null;
  const re = new RegExp(`<(/?)${open[1]}\\b[^>]*>`, "g");
  re.lastIndex = open.index + open[0].length;
  let depth = 1;
  let m: RegExpExecArray | null;
  const from = open.index + open[0].length;
  while ((m = re.exec(h)) !== null) {
    depth += m[1] === "/" ? -1 : 1;
    if (depth === 0) return h.slice(from, m.index);
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

  it("the cameras: offered to an editor on a board whose division REQUIRES them, drawn from the shell's joins, and the position draws BESIDE them", () => {
    const b = live(5, { fixtureId: "b-cam", white: ADA, black: BEN, clock: CLOCK, cameraPolicy: "required", sides: { home: joinable("live"), away: joinable("off") } });
    const joins = joinsFor(b, { home: WATCHING, away: WATCHING });
    const h = html(b, { answer: answerOf(b, { position: POSITION }), joins });
    expect(count(h, "md-board-cameras")).toBe(1);
    expect(count(h, "md-cameras")).toBe(1);
    expect(count(h, "md-camera-tile"), "two tiles, one per player").toBe(2);
    expect(count(h, "board-stub"), "the board is still drawn (a switch below lg, both from lg)").toBe(1);
    // The tiles carry the names; the first tile is White's.
    const tiles = [...h.matchAll(/<figure[^>]*data-testid="md-camera-tile"[^>]*data-colour="(white|black)"[^>]*>/g)].map((m) => m[1]);
    expect(tiles).toEqual(["white", "black"]);
    // The pair, each way a panel does NOT carry cameras: the reader may not watch, the division does not require them, nobody shell-joined.
    const none = (over: Partial<BoardPanelViewProps>) => count(html(b, { answer: answerOf(b, { position: POSITION }), joins, ...over }), "md-board-cameras");
    expect(none({ reader: VIEWER }), "a view-only member").toBe(0);
    expect(none({ reader: NOT_OFFERED }), "a club not offered online chess").toBe(0);
    expect(none({ joins: undefined }), "the shell handed no joins").toBe(0);
    const optional = { ...b, cameraPolicy: "optional" as const };
    expect(count(html(optional, { answer: answerOf(optional, { position: POSITION }), joins }), "md-board-cameras"), "policy optional").toBe(0);
    const overridden = { ...b, videoOverridden: true };
    expect(count(html(overridden, { answer: answerOf(overridden, { position: POSITION }), joins }), "md-board-cameras"), "let go without video").toBe(0);
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

  it("the hold's reason is the answer's, once there is an answer: a lifted hold (null) is not painted from the list's stale row (the pair)", () => {
    const stale = { ...toRow(heldBoard), hold_reason: "fair_play" as const };
    const lifted = html(heldBoard, { row: stale, answer: answerOf(heldBoard, { hold_reason: null }) });
    expect(count(lifted, "md-board-hold"), "the answer says there is no hold").toBe(0);
    // Before the first answer the list's row is all there is, so its reason is what shows.
    const before = html(heldBoard, { row: stale, answer: null });
    expect(count(before, "md-board-hold")).toBe(1);
    expect(tagOf(before, "md-board-hold")).toContain('data-reason="fair_play"');
    // And an answer that has one wins over the row's.
    const changed = html(heldBoard, { row: stale, answer: answerOf(heldBoard, { hold_reason: "lichess_unlinked" }) });
    expect(tagOf(changed, "md-board-hold")).toContain('data-reason="lichess_unlinked"');
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
    { fixtureId: "b-decide", white: ADA, black: BEN, canResync: true, canSettle: true, flags: [camera()], flagCount: 1, checkin: openWindow(), cameraPolicy: "required", sides: { home: joinable(), away: joinable() } },
  );
  const board = () => answerOf(deciding, { hold_reason: "clock_flag_unsettled" });
  const decide = (reader: Reader, over: Partial<BoardPanelViewProps> = {}) => html(deciding, { answer: board(), reader, ...over });
  /** The vendor is down: the join route answered 503 VIDEO_UNAVAILABLE for both players' meetings. */
  const down = joinsFor(deciding, { home: UNAVAILABLE, away: UNAVAILABLE });
  const up = joinsFor(deciding, { home: WATCHING, away: WATCHING });
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

  it("B7 (MD-R36 headroom): the two quiet decisions share ONE row from lg - the wrapper is out of the box tree below lg, two columns from lg, a lone button spans it, Settle is not in it, and with neither there is no wrapper", () => {
    const group = (h: string) => /<div data-testid="arbiter-quiet-decisions" class="([^"]*)">([\s\S]*?)<\/div>/.exec(h);
    const both = group(decide(EDITOR));
    expect(both, "the pair is grouped").not.toBeNull();
    expect(both![1], "out of the box tree below lg").toMatch(/(^|\s)contents(\s|$)/);
    expect(both![1], "two columns from lg").toMatch(/(^|\s)lg:grid-cols-2(\s|$)/);
    expect(both![1], "a lone button takes the row").toContain("lg:[&amp;&gt;:only-child]:col-span-2"); // the markup's own escaping of lg:[&>:only-child]:col-span-2
    expect(has(both![2]!, resync) && has(both![2]!, goOn), "both quiet buttons are in it").toBe(true);
    expect(has(both![2]!, settle), "Settle is the primary press, on a row of its own").toBe(false);
    // One alone (no flag to close): the group holds just the resync.
    const noFlags = { ...deciding, flags: [], flagCount: 0 };
    const lone = group(html(noFlags, { answer: answerOf(noFlags, { hold_reason: "clock_flag_unsettled" }), reader: EDITOR }));
    expect(lone, "a lone button is still grouped (it spans the row)").not.toBeNull();
    expect(has(lone![2]!, resync) && !has(lone![2]!, goOn)).toBe(true);
    // Neither (no game to resync, no flag): no empty wrapper; the decision is still there for Settle.
    const neither = { ...deciding, flags: [], flagCount: 0, canResync: false };
    const none = html(neither, { answer: answerOf(neither, { hold_reason: "clock_flag_unsettled" }), reader: EDITOR });
    expect(group(none), "no empty wrapper").toBeNull();
    expect(count(none, "arbiter-decision"), "premise: the decision section is still drawn").toBe(1);
    expect(has(none, settle)).toBe(true);
  });

  it("a viewer sees no decision section and no outage card - and no press of any kind", () => {
    const h = decide(VIEWER, { joins: down });
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
    for (const words of RETIRED_EXTEND_WORDS) expect(has(h, words), `and none of the retired reasons' words: "${words}"`).toBe(false);
    expect(RETIRED_EXTEND_WORDS.length, "anti-vacuity: seven probes").toBe(7);
  });

  it("(O4) a FROZEN competition: the finishing decisions still render (scoring is exempt), the +5 min does not; unfrozen it does (the pair)", () => {
    const frozen = decide(FROZEN);
    for (const word of [resync, goOn, settle]) expect(has(frozen, word), word).toBe(true);
    expect(has(frozen, extendLabel)).toBe(false);
    expect(count(frozen, "arbiter-extend-board")).toBe(0);
    expect(has(decide({ ...FROZEN, frozen: false }), extendLabel)).toBe(true);
  });

  it("(O4) the outage card ('let this board play without video') is a finishing decision: shown for a frozen editor, not for a viewer", () => {
    expect(count(decide(FROZEN, { joins: down }), "arbiter-outage")).toBe(1);
    expect(count(decide(EDITOR, { joins: down }), "arbiter-outage")).toBe(1);
    expect(count(decide(VIEWER, { joins: down }), "arbiter-outage")).toBe(0);
    // Only while the vendor is down (a join answered VIDEO_UNAVAILABLE), only while the board is still to be played and not already let go.
    expect(count(decide(EDITOR, { joins: up }), "arbiter-outage"), "the vendor is up").toBe(0);
    expect(count(decide(EDITOR), "arbiter-outage"), "no joins at all (the shell keeps none)").toBe(0);
    expect(count(decide(EDITOR, { joins: down, answer: answerOf({ ...deciding, videoOverridden: true }) }), "arbiter-outage"), "already let go").toBe(0);
    // One side down is enough (either player's room failing is the outage); a side not yet checked in is not an outage.
    expect(count(decide(EDITOR, { joins: joinsFor(deciding, { home: WATCHING, away: UNAVAILABLE }) }), "arbiter-outage")).toBe(1);
    const notHere = { ...deciding, sides: { home: joinable(), away: meeting() } };
    expect(count(html(notHere, { answer: answerOf(notHere, { hold_reason: "clock_flag_unsettled" }), joins: joinsFor(notHere, { home: WATCHING, away: UNAVAILABLE }) }), "arbiter-outage"), "a stale answer for a side that is not watchable does not count").toBe(0);
  });

  it("(MD-R37/R38) the outage card's words follow the FIRST MOVE (started_at, exposed as cameraReport !== null), not a game on file: moved = CARRY ON (camera evidence stops here), not yet = START - the whole state table, never both sets of words", () => {
    // `moved` is the rulebook's fact (the game has started only when a first move was played, reconcile.ts started_at); `gameOnFile` is the loader's
    // `canResync`. They differ in exactly the rows that matter: a game exists at Lichess and nobody has moved (starting; a held no-show).
    const STATES: { label: string; state: ArbiterBoard["state"]; gameOnFile: boolean; moved: boolean }[] = [
      { label: "checking in: no game yet", state: { kind: "checking_in" }, gameOnFile: false, moved: false },
      { label: "starting: a game exists, nobody has moved", state: { kind: "starting" }, gameOnFile: true, moved: false },
      { label: "live: a move was played", state: { kind: "live", moveNo: 7 }, gameOnFile: true, moved: true },
      { label: "held with a game on file and moves played", state: { kind: "on_hold" }, gameOnFile: true, moved: true },
      { label: "held no-show: a game on file, 0 moves", state: { kind: "on_hold" }, gameOnFile: true, moved: false },
      { label: "held with no game (a link hold)", state: { kind: "on_hold" }, gameOnFile: false, moved: false },
    ];
    const started = [t("arbiter.outage.bodyStarted"), t("arbiter.outage.ctaStarted")];
    const before = [t("arbiter.outage.body"), t("arbiter.outage.cta")];
    expect(new Set([...started, ...before]).size, "the two sets of words are different words").toBe(4);
    let checked = 0;
    let moved = 0;
    for (const { label, state, gameOnFile, moved: played } of STATES) {
      const b = withState(state, { ...deciding, state, canResync: gameOnFile, cameraReport: played ? "pending" : null, seats: null, checkin: null });
      const h = html(b, { answer: answerOf(b, state.kind === "on_hold" ? { hold_reason: "clock_flag_unsettled" } : {}), reader: EDITOR, joins: joinsFor(b, { home: UNAVAILABLE, away: UNAVAILABLE }) });
      expect(count(h, "arbiter-outage"), `${label}: the card is offered`).toBe(1);
      for (const w of played ? started : before) expect(has(h, w), `${label}: has "${w}"`).toBe(true);
      for (const w of played ? before : started) expect(has(h, w), `${label}: lacks "${w}"`).toBe(false);
      checked += 1;
      if (played) moved += 1;
    }
    expect(checked, "every state was read").toBe(STATES.length);
    expect(moved, "some rows are moved and some are not: the table can tell the two sets apart").toBeGreaterThan(0);
    expect(moved).toBeLessThan(STATES.length);
    // The settled report is a started game too (the report is only ever written once a move was played).
    const settled = withState({ kind: "live", moveNo: 7 }, { ...deciding, state: { kind: "live", moveNo: 7 }, canResync: true, cameraReport: "settled", seats: null, checkin: null });
    expect(has(html(settled, { answer: answerOf(settled), reader: EDITOR, joins: joinsFor(settled, { home: UNAVAILABLE, away: UNAVAILABLE }) }), started[1]!), "a settled camera report: started").toBe(true);
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

describe("BoardPanelView: two columns from lg (MD-R33, MD-R34)", () => {
  // A held board with everything the right-hand column can carry: why it is held, a flag, every decision, the outage card, and presence
  // marks (so the seat strip draws). Its answer has a position, so the board draws in the left column.
  const FULL = withState(
    { kind: "on_hold" },
    { fixtureId: "b-grid", white: ADA, black: BEN, canResync: true, canSettle: true, flags: [camera()], flagCount: 1, cameraPolicy: "required", sides: { home: joinable("live"), away: joinable("off") } },
  );
  const fullAnswer = () => answerOf(FULL, { hold_reason: "fair_play", position: POSITION });
  const full = (over: Partial<BoardPanelViewProps> = {}) => html(FULL, { answer: fullAnswer(), joins: joinsFor(FULL, { home: UNAVAILABLE, away: UNAVAILABLE }), ...over });
  /** The `lg:order-N` a block carries (null = none): the visual order the right column re-sorts into from lg. */
  const orderOf = (h: string, testid: string): number | null => {
    const m = /\blg:order-(\d+)\b/.exec(tagOf(h, testid) ?? "");
    return m ? Number(m[1]) : null;
  };
  /** Test ids in the order they appear in the markup: the DOM order a phone (and a tablet, below lg) reads. */
  const domOrder = (h: string, ids: readonly string[]) => ids.map((id) => ({ id, at: h.indexOf(`data-testid="${id}"`) })).sort((a, b) => a.at - b.at);

  it("EMPTY CASE FIRST: with no position there is ONE column from lg too - the loading line, the failed line and the no-game note span the whole width, no hole on the left", () => {
    const wide = (h: string) => {
      const grid = tagOf(h, "md-board-grid")!;
      expect(grid, "the grid wrapper is there").not.toBeNull();
      expect(grid).toContain("min-w-0");
      expect(grid, "no second column without a board to put in it").not.toMatch(/lg:grid-cols|lg:items-start/);
      return h;
    };
    let seen = 0;
    for (const [h, id] of [
      [wide(html(LIVE, { answer: null })), "md-board-loading"],
      [wide(html(LIVE, { answer: null, readFailed: true })), "md-board-read-failed"],
      [wide(html(NOGAME)), "md-board-nogame"],
      [wide(html(held(0, { fixtureId: "b-held", white: ADA, black: BEN }))), "md-board-nogame"],
    ] as const) {
      expect(count(h, id), `${id} is drawn`).toBe(1);
      expect(innerOf(h, "md-board-grid")!, `${id} sits in the grid`).toContain(`data-testid="${id}"`);
      expect(tagOf(h, "md-board-left") ?? "", `${id}: the note is not pinned into a left column`).not.toMatch(/lg:col-start|lg:row-span/);
      seen += 1;
    }
    expect(seen, "every no-position case was checked").toBe(4);
    // Cameras with no board to sit beside (the game is not on file) are the one column too: the tiles span the width.
    const camLive = withState({ kind: "on_hold" }, { fixtureId: "b-nopos", white: ADA, black: BEN, cameraPolicy: "required", sides: { home: joinable(), away: joinable() } });
    const withCameras = html(camLive, { answer: answerOf(camLive), joins: joinsFor(camLive, { home: WATCHING, away: WATCHING }) });
    expect(count(withCameras, "md-board-cameras"), "the tiles are drawn").toBe(1);
    expect(tagOf(withCameras, "md-board-grid")).not.toMatch(/lg:grid-cols/);
    expect(count(withCameras, "md-camera-switch"), "nothing to switch to without a board").toBe(0);
  });

  it("with a position the grid is two columns from lg: a fluid left column capped at 420px / 42%, top-aligned, and the board sits ONLY in the left one", () => {
    const h = full();
    const grid = tagOf(h, "md-board-grid")!;
    expect(grid).toContain("min-w-0");
    expect(grid).toContain("lg:grid-cols-[minmax(0,min(420px,42%))_1fr]");
    expect(grid).toContain("lg:items-start");
    const left = innerOf(h, "md-board-left")!;
    expect(left, "the board and its clocks are in the left column").toContain('data-testid="md-board-position"');
    expect(left).toContain('data-testid="md-board-clock-white"');
    expect(left).toContain('data-testid="md-board-clock-black"');
    for (const id of ["md-online-state", "md-board-seats", "md-board-hold", "md-board-flags", "arbiter-decision", "arbiter-outage"]) {
      expect(left, `${id} is not in the left column`).not.toContain(`data-testid="${id}"`);
    }
    // Everything else is in the right column's two blocks: the head (state row, seats) and the rest (why, decisions, flags).
    const head = innerOf(h, "md-board-head")!;
    const rest = innerOf(h, "md-board-rest")!;
    for (const id of ["md-online-state", "md-board-seats"]) expect(head, id).toContain(`data-testid="${id}"`);
    for (const id of ["md-board-hold", "md-board-flags", "arbiter-decision", "arbiter-outage"]) expect(rest, id).toContain(`data-testid="${id}"`);
    // And the pair: no block is in two places.
    expect(count(h, "md-board-position")).toBe(1);
    expect(count(h, "arbiter-decision")).toBe(1);
  });

  it("the board is capped at 420px from lg and keeps its 560px cap below it (a phone and a tablet are one column)", () => {
    const tag = tagOf(full(), "md-board-position")!;
    expect(tag).toContain("lg:max-w-[420px]");
    expect(tag).toMatch(/\bmax-w-\[560px\]/);
  });

  it("DOM order (a phone, a tablet): state, the switch, seats, board, CAMERAS (after the board, before the reason), why, flags, decision, outage", () => {
    const ids = ["md-online-state", "md-camera-switch", "md-board-seats", "md-board-position", "md-board-cameras", "md-board-hold", "md-board-flags", "arbiter-decision", "arbiter-outage"];
    const order = domOrder(full(), ids);
    expect(order.every((o) => o.at >= 0), "every block is drawn (a missing one would hide in the sort)").toBe(true);
    expect(order.map((o) => o.id)).toEqual(ids);
    expect(order.length, "the sweep checked all nine").toBe(9);
  });

  it("from lg the right column reads: state row, seats, why it is held, the decision (and the outage card), THEN the flags", () => {
    const h = full();
    const rest = ["md-board-hold", "arbiter-decision", "arbiter-outage", "md-board-flags"] as const;
    const orders = rest.map((id) => ({ id, order: orderOf(h, id) }));
    expect(orders.every((o) => o.order !== null), `each block of the rest carries an lg:order: ${JSON.stringify(orders)}`).toBe(true);
    // The cameras carry NO lg:order (order 0), so from lg they are the right column's top - above every block that has one (all are 1 or more).
    expect(orderOf(h, "md-board-cameras"), "the cameras wrapper has no order of its own").toBeNull();
    expect(Math.min(...orders.map((o) => o.order!)), "every ordered block sorts after the cameras").toBeGreaterThanOrEqual(1);
    // Flex re-sorts by (order, DOM position): the sort a browser does, so a changed number moves this and nothing else.
    const visual = orders
      .map((o, domIndexOf) => ({ ...o, domIndexOf }))
      .sort((a, b) => a.order! - b.order! || a.domIndexOf - b.domIndexOf)
      .map((o) => o.id);
    expect(visual).toEqual(["md-board-hold", "arbiter-decision", "arbiter-outage", "md-board-flags"]);
    expect(orders.length, "the sweep checked all four").toBe(4);
    // The head is above the rest, by the grid's own rows.
    expect(tagOf(h, "md-board-head")).toMatch(/lg:col-start-2/);
    expect(tagOf(h, "md-board-head")).toMatch(/lg:row-start-1/);
    expect(tagOf(h, "md-board-rest")).toMatch(/lg:col-start-2/);
    expect(tagOf(h, "md-board-rest")).toMatch(/lg:row-start-2/);
    expect(tagOf(h, "md-board-left")).toMatch(/lg:col-start-1/);
    expect(tagOf(h, "md-board-left"), "the board spans both rows: the extra height lands in the stretchy row, not between the right blocks").toMatch(/lg:row-span-2/);
    expect(tagOf(h, "md-board-grid")).toContain("lg:grid-rows-[auto_1fr]");
  });

  it("a failed read after an answer keeps the board and the line under it, in the left column (a note about the board it is under)", () => {
    const h = full({ readFailed: true });
    expect(innerOf(h, "md-board-left")).toContain('data-testid="md-board-read-failed"');
    expect(tagOf(h, "md-board-grid")).toContain("lg:grid-cols-[minmax(0,min(420px,42%))_1fr]");
  });

  it("a viewer's board is the same two columns: no decision, no hold, and the flags are the whole of the right column's rest", () => {
    const h = full({ reader: VIEWER });
    expect(count(h, "arbiter-decision")).toBe(0);
    expect(count(h, "md-board-hold")).toBe(0);
    expect(innerOf(h, "md-board-rest")).toContain('data-testid="md-board-flags"');
    expect(innerOf(h, "md-board-left")).toContain('data-testid="md-board-position"');
    // A cell with nothing in it must not leave its 16px gap in the grid (React draws no node for null, so `:empty` matches).
    expect(tagOf(h, "md-board-rest")).toContain("empty:hidden");
    expect(tagOf(h, "md-board-left")).toContain("empty:hidden");
  });
});

describe("BoardPanelView: cameras and the board share the screen (Task 9)", () => {
  // Below lg the two share ONE column, so a switch picks one; from lg both show (cameras at the right column's top).
  const CAM = withState({ kind: "live", moveNo: 9 }, { fixtureId: "b-cam2", white: ADA, black: BEN, clock: CLOCK, cameraPolicy: "required", sides: { home: joinable("live"), away: joinable("live") } });
  const camJoins = joinsFor(CAM, { home: WATCHING, away: WATCHING });
  const camAnswer = () => answerOf(CAM, { position: POSITION });
  const cam = (over: Partial<BoardPanelViewProps> = {}) => html(CAM, { answer: camAnswer(), joins: camJoins, cameraMode: "cameras", ...over });
  const classOf = (h: string, testid: string) => /class="([^"]*)"/.exec(tagOf(h, testid) ?? "")?.[1] ?? "";
  const hasClass = (h: string, testid: string, cls: string) => classOf(h, testid).split(/\s+/).includes(cls);

  it("EMPTY CASE FIRST: a panel without cameras has no switch and hides nothing - not the board, not the seats - in either mode", () => {
    let checked = 0;
    for (const mode of ["cameras", "board"] as const) {
      const h = html(LIVE, { answer: answerOf(LIVE, { position: POSITION }), cameraMode: mode });
      expect(count(h, "md-camera-switch"), mode).toBe(0);
      expect(count(h, "md-board-cameras"), mode).toBe(0);
      expect(hasClass(h, "md-board-left", "max-lg:hidden"), `${mode}: the board is never hidden when there are no cameras`).toBe(false);
      expect(count(h, "board-stub")).toBe(1);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("cameras picked: the switch says so (aria-pressed), the board is hidden below lg, the cameras are not - and both show from lg", () => {
    const h = cam();
    const buttons = [...h.matchAll(/<button[^>]*data-mode="(cameras|board)"[^>]*>/g)];
    expect(buttons.map((m) => m[1]), "Cameras first, then Board").toEqual(["cameras", "board"]);
    expect(buttons[0]![0]).toContain('aria-pressed="true"');
    expect(buttons[1]![0]).toContain('aria-pressed="false"');
    expect(hasClass(h, "md-camera-switch", "lg:hidden"), "from lg there is nothing to pick").toBe(true);
    expect(hasClass(h, "md-board-left", "max-lg:hidden"), "the board gives the phone up (max-lg only, so it still shows from lg)").toBe(true);
    expect(hasClass(h, "md-board-cameras", "max-lg:hidden")).toBe(false);
    // The words are the dictionary's.
    expect(has(h, t("matchDay.cameras.viewCameras"))).toBe(true);
    expect(has(h, t("matchDay.cameras.viewBoard"))).toBe(true);
  });

  it("board picked: the cameras are hidden below lg and the board is not; the pair of the case above", () => {
    const h = cam({ cameraMode: "board" });
    const buttons = [...h.matchAll(/<button[^>]*data-mode="(cameras|board)"[^>]*>/g)];
    expect(buttons[0]![0]).toContain('aria-pressed="false"');
    expect(buttons[1]![0]).toContain('aria-pressed="true"');
    expect(hasClass(h, "md-board-cameras", "max-lg:hidden")).toBe(true);
    expect(hasClass(h, "md-board-left", "max-lg:hidden")).toBe(false);
  });

  it("(MD-R36) the fold's press is on the STATE ROW, not in the strip: one toggle, in the head beside the state word, before the switch; it names the strip's body and says what it will do", () => {
    const headOf = (h: string) => innerOf(h, "md-board-head")!;
    let checked = 0;
    for (const folded of [true, false]) {
      const h = cam({ camerasFolded: folded });
      expect(count(h, "md-cameras-toggle"), `folded=${folded}: exactly one toggle`).toBe(1);
      expect(innerOf(h, "md-board-cameras"), `folded=${folded}: none inside the strip`).not.toContain("md-cameras-toggle");
      const head = headOf(h);
      expect(head.indexOf("md-online-state"), "after the state word").toBeLessThan(head.indexOf("md-cameras-toggle"));
      expect(head.indexOf("md-cameras-toggle"), "before the Cameras / Board switch (so it is on the state row, not under it)").toBeLessThan(head.indexOf("md-camera-switch"));
      const tag = tagOf(h, "md-cameras-toggle")!;
      expect(tag).toContain(`aria-expanded="${!folded}"`);
      const controls = /aria-controls="([^"]+)"/.exec(tag)![1]!;
      expect(h.split(`id="${controls}"`).length - 1, "aria-controls names exactly one element - the strip's body").toBe(1);
      expect(innerOf(h, "md-board-cameras")).toContain(`id="${controls}"`);
      expect(has(headOf(h), t(folded ? "matchDay.cameras.show" : "matchDay.cameras.hide")), `folded=${folded}: the words`).toBe(true);
      expect(tagOf(h, "md-cameras")).toContain(`data-folded="${folded}"`);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("(MD-R36) the toggle goes with the strip: hidden below lg when the BOARD is picked (nothing to fold there), shown otherwise; with no switch (no board drawn) it is always there; and no cameras = no toggle", () => {
    const hidden = (h: string) => classOf(h, "md-cameras-toggle").split(/\s+/).includes("max-lg:hidden");
    expect(hidden(cam({ cameraMode: "board" })), "board picked: the strip is hidden below lg, so is its toggle").toBe(true);
    expect(hidden(cam({ cameraMode: "cameras" })), "cameras picked").toBe(false);
    expect(hidden(cam({ cameraMode: "board" })) === hasClass(cam({ cameraMode: "board" }), "md-board-cameras", "max-lg:hidden"), "the toggle follows the strip").toBe(true);
    const noPos = withState({ kind: "on_hold" }, { fixtureId: "b-nopos3", white: ADA, black: BEN, cameraPolicy: "required", sides: { home: joinable(), away: joinable() } });
    for (const mode of ["cameras", "board"] as const) {
      const h = html(noPos, { answer: answerOf(noPos), joins: joinsFor(noPos, { home: WATCHING, away: WATCHING }), cameraMode: mode });
      expect(count(h, "md-cameras-toggle"), mode).toBe(1);
      expect(hidden(h), `${mode}: no board to switch to, so the cameras (and the toggle) are the panel`).toBe(false);
    }
    expect(count(html(LIVE, { answer: answerOf(LIVE, { position: POSITION }) }), "md-cameras-toggle"), "a panel without cameras").toBe(0);
  });

  it("the switch buttons are phone-sized taps (44px); their press is the e2e's (a click needs a DOM, which this workspace's vitest does not have)", () => {
    const h = cam();
    let checked = 0;
    for (const m of h.matchAll(/<button[^>]*data-mode="(?:cameras|board)"[^>]*>/g)) {
      expect(m[0]).toMatch(/\bmin-h-11\b/);
      checked += 1;
    }
    expect(checked, "both buttons were read").toBe(2);
  });

  it("no board drawn (the game is not on file yet): no switch - there is nothing to switch to - and the cameras are never hidden", () => {
    const b = withState({ kind: "on_hold" }, { fixtureId: "b-nopos2", white: ADA, black: BEN, cameraPolicy: "required", sides: { home: joinable(), away: joinable() } });
    for (const mode of ["cameras", "board"] as const) {
      const h = html(b, { answer: answerOf(b), joins: joinsFor(b, { home: WATCHING, away: WATCHING }), cameraMode: mode });
      expect(count(h, "md-camera-switch"), mode).toBe(0);
      expect(count(h, "md-board-cameras"), mode).toBe(1);
      expect(hasClass(h, "md-board-cameras", "max-lg:hidden"), `${mode}: with no board the cameras are the panel`).toBe(false);
    }
  });

  it("the seat cards are the tiles' own words while the tiles show: hidden then, kept for a board in its check-in (they carry the check-in and invite words)", () => {
    // A live board: the tiles carry the names and marks; below lg the seats go with the cameras and back when the board is picked.
    expect(hasClass(cam(), "md-board-seats", "hidden"), "cameras showing: the seat cards are redundant").toBe(true);
    const boardMode = cam({ cameraMode: "board" });
    expect(hasClass(boardMode, "md-board-seats", "hidden"), "board picked: the seat cards are a phone's way to name the players").toBe(false);
    expect(hasClass(boardMode, "md-board-seats", "lg:hidden"), "...but from lg the tiles are there, so the cards are not").toBe(true);
    // A board in its check-in has seats with words: always shown.
    const checkin = withState({ kind: "checking_in" }, { fixtureId: "b-ci", white: ADA, black: BEN, cameraPolicy: "required", seats: { white: { here: true, invites: [] }, black: { here: false, invites: ["delivered"] } }, checkin: openWindow(), sides: { home: joinable(), away: meeting() } });
    const h = html(checkin, { answer: answerOf(checkin), joins: joinsFor(checkin, { home: WATCHING }), cameraMode: "cameras" });
    expect(count(h, "md-board-seats")).toBe(1);
    expect(hasClass(h, "md-board-seats", "hidden")).toBe(false);
    expect(hasClass(h, "md-board-seats", "lg:hidden")).toBe(false);
  });

  it("the cameras draw BEFORE the reason and the decision in the right column (and from lg carry no order, so they are its top)", () => {
    const heldCam = withState({ kind: "on_hold" }, { fixtureId: "b-hc", white: ADA, black: BEN, canSettle: true, cameraPolicy: "required", sides: { home: joinable(), away: joinable() } });
    const h = html(heldCam, { answer: answerOf(heldCam, { hold_reason: "clock_flag_unsettled", position: POSITION }), joins: joinsFor(heldCam, { home: WATCHING, away: WATCHING }), cameraMode: "cameras" });
    const at = (id: string) => h.indexOf(`data-testid="${id}"`);
    expect(at("md-board-cameras")).toBeGreaterThan(at("md-board-position"));
    expect(at("md-board-cameras")).toBeLessThan(at("md-board-hold"));
    expect(at("md-board-hold")).toBeLessThan(at("arbiter-decision"));
    expect(innerOf(h, "md-board-rest")).toContain('data-testid="md-board-cameras"');
  });
});

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
    onAnswer: noop,
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

  it("the shell's joins reach the view whole, and the camera mode opens on the cameras while there is something to watch (the board otherwise)", () => {
    const watched = withState({ kind: "live", moveNo: 3 }, { fixtureId: "b-watch", white: ADA, black: BEN, cameraPolicy: "required", sides: { home: joinable(), away: joinable() } });
    const joins = joinsFor(watched, { home: WATCHING, away: WATCHING });
    const ui = renderIsland(BoardFocus, focusProps(watched, { joins }));
    expect(viewOf(ui).joins, "the very object the shell made").toBe(joins);
    expect(viewOf(ui).cameraMode).toBe("cameras");
    // The pair: a reader who may not watch, a board that is over, and a division that does not require cameras all open on the board.
    expect(viewOf(renderIsland(BoardFocus, focusProps(watched, { joins, reader: VIEWER }))).cameraMode, "a view-only member").toBe("board");
    const over = withState({ kind: "result", score: "1-0", noResult: false }, { fixtureId: "b-over2", white: ADA, black: BEN, cameraPolicy: "required" });
    expect(viewOf(renderIsland(BoardFocus, focusProps(over, { joins: joinsFor(over, {}) }))).cameraMode, "a finished game has nothing to watch").toBe("board");
    const optional = { ...watched, cameraPolicy: "optional" as const };
    expect(viewOf(renderIsland(BoardFocus, focusProps(optional, { joins }))).cameraMode, "cameras not required").toBe("board");
  });

  it("a picked mode is the panel's own and outlives the polls: the board picked stays picked across a new refreshKey and a new row (a poll never flips the view)", async () => {
    const watched = withState({ kind: "live", moveNo: 3 }, { fixtureId: "b-pick", white: ADA, black: BEN, cameraPolicy: "required", sides: { home: joinable(), away: joinable() } });
    const joins = joinsFor(watched, { home: WATCHING, away: WATCHING });
    const ui = renderIsland(BoardFocus, focusProps(watched, { joins, refreshKey: 1 }));
    expect(viewOf(ui).cameraMode).toBe("cameras");
    viewOf(ui).onCameraMode("board");
    expect(viewOf(ui).cameraMode).toBe("board");
    ui.rerender(focusProps({ ...watched, state: { kind: "live", moveNo: 4 } }, { joins: joinsFor(watched, { home: WATCHING, away: WATCHING }), refreshKey: 2 }));
    await flush();
    expect(viewOf(ui).cameraMode, "the poll moved the board on; the picked view stays").toBe("board");
    viewOf(ui).onCameraMode("cameras");
    expect(viewOf(ui).cameraMode).toBe("cameras");
  });

  it("(MD-R36) the cameras' fold is the PANEL's: a held board opens FOLDED, any other OPEN; the press flips it, and a poll or a new row never refolds it", async () => {
    const mk = (state: ArbiterBoard["state"]) => withState(state, { fixtureId: "b-fold", white: ADA, black: BEN, cameraPolicy: "required", sides: { home: joinable(), away: joinable() } });
    const joinsOf = (b: ArbiterBoard) => joinsFor(b, { home: WATCHING, away: WATCHING });
    let checked = 0;
    for (const [state, folded] of [[{ kind: "on_hold" }, true], [{ kind: "live", moveNo: 3 }, false], [{ kind: "checking_in" }, false], [{ kind: "starting" }, false]] as const) {
      const b = mk(state);
      expect(viewOf(renderIsland(BoardFocus, focusProps(b, { joins: joinsOf(b) }))).camerasFolded, state.kind).toBe(folded);
      checked += 1;
    }
    expect(checked).toBe(4);
    // The press: folded -> open -> folded; and the poll that follows (a new refreshKey, the board moved off hold) does not put it back.
    const held = mk({ kind: "on_hold" });
    const ui = renderIsland(BoardFocus, focusProps(held, { joins: joinsOf(held), refreshKey: 1 }));
    expect(viewOf(ui).camerasFolded).toBe(true);
    viewOf(ui).onCamerasFolded(false);
    expect(viewOf(ui).camerasFolded, "the press opened it").toBe(false);
    const live = mk({ kind: "live", moveNo: 4 });
    ui.rerender(focusProps(live, { joins: joinsOf(live), refreshKey: 2 }));
    await flush();
    expect(viewOf(ui).camerasFolded, "a poll never refolds it").toBe(false);
    viewOf(ui).onCamerasFolded(true);
    ui.rerender(focusProps(held, { joins: joinsOf(held), refreshKey: 3 }));
    await flush();
    expect(viewOf(ui).camerasFolded, "nor opens it again when a board goes back on hold").toBe(true);
  });

  it("B7 (T9 m5): the panel's own answer is handed UP to the shell as soon as it is read, replaced by the next one, and taken back (null) when the panel goes - the shell's join keys follow the board the tiles are drawn from", async () => {
    const onAnswer = vi.fn();
    const ui = renderIsland(BoardFocus, focusProps(LIVE, { onAnswer, refreshKey: 1 }));
    expect(onAnswer, "nothing read yet: nothing handed up").toHaveBeenLastCalledWith(LIVE.fixtureId, null);
    net.calls[0]!.resolve(full(LIVE));
    await flush();
    const [id, answer] = onAnswer.mock.calls.at(-1)!;
    expect(id).toBe(LIVE.fixtureId);
    expect(answer, "the very answer the view draws from").toBe(viewOf(ui).answer);
    expect((answer as MatchDayBoard).position).toEqual(POSITION);
    // The next read replaces it: the shell is handed the NEW answer, not the first one kept.
    ui.rerender(focusProps(LIVE, { onAnswer, refreshKey: 2 }));
    net.calls[1]!.resolve(full(LIVE, { hold_reason: "mismatch" }));
    await flush();
    expect((onAnswer.mock.calls.at(-1)![1] as MatchDayBoard).hold_reason).toBe("mismatch");
    ui.unmount();
    expect(onAnswer, "the panel going away takes its answer back").toHaveBeenLastCalledWith(LIVE.fixtureId, null);
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

  it("a re-read that answers 404 after a press means the board is gone: the last answer stays and no 'could not read' line is raised (the pair: a first read, and a 503)", async () => {
    const b = withState({ kind: "on_hold" }, { fixtureId: "b-gone", white: ADA, black: BEN, canSettle: true, canResync: true });
    const ui = renderIsland(BoardFocus, focusProps(b));
    net.calls[0]!.resolve(full(b));
    await flush();
    void viewOf(ui).on.resync();
    net.calls.at(-1)!.resolve({ read: true, adopted: 0 });
    await flush();
    const reread = reads().at(-1)!;
    expect(reads(), "the press re-read the board").toHaveLength(2);
    reread.reject(new ApiV1Error("not found", 404, "NOT_FOUND"));
    await flush();
    expect(viewOf(ui).answer?.position, "the last answer stays").toEqual(POSITION);
    expect(viewOf(ui).readFailed, "gone is not a failed read").toBe(false);
    // The pair, same board and same press: a 503 on the re-read IS a failed read.
    const other = renderIsland(BoardFocus, focusProps(b));
    const first = net.calls.length - 1;
    net.calls[first]!.resolve(full(b));
    await flush();
    void viewOf(other).on.resync();
    net.calls.at(-1)!.resolve({ read: true, adopted: 0 });
    await flush();
    reads().at(-1)!.reject(new ApiV1Error("offline", 503, "UNAVAILABLE"));
    await flush();
    expect(viewOf(other).readFailed).toBe(true);
  });

  it("a 404 on the FIRST read has no answer to keep: that one is a failed read (nothing to show, so say so)", async () => {
    const ui = renderIsland(BoardFocus, focusProps(LIVE));
    net.calls[0]!.reject(new ApiV1Error("not found", 404, "NOT_FOUND"));
    await flush();
    expect(viewOf(ui).answer).toBeNull();
    expect(viewOf(ui).readFailed).toBe(true);
  });

  it("SEQUENCE (T8 minor): a failed read raises the line, and a LATER 404 with the answer in hand takes it down - the board is gone, not unreadable (the pair: a later 503 keeps it up)", async () => {
    const ui = renderIsland(BoardFocus, focusProps(LIVE, { refreshKey: 1 }));
    net.calls[0]!.resolve(full(LIVE));
    await flush();
    ui.rerender(focusProps(LIVE, { refreshKey: 2 }));
    net.calls[1]!.reject(new ApiV1Error("offline", 503, "UNAVAILABLE"));
    await flush();
    expect(viewOf(ui).readFailed, "the failed read raised the line").toBe(true);
    ui.rerender(focusProps(LIVE, { refreshKey: 3 }));
    net.calls[2]!.reject(new ApiV1Error("not found", 404, "NOT_FOUND"));
    await flush();
    expect(viewOf(ui).answer?.position, "the last answer stays").toEqual(POSITION);
    expect(viewOf(ui).readFailed, "the earlier failure is cleared: gone, not unreadable").toBe(false);
    // The pair: the same board, a failed read, then ANOTHER failed read (a 503): the line stays.
    ui.rerender(focusProps(LIVE, { refreshKey: 4 }));
    net.calls[3]!.reject(new ApiV1Error("offline", 503, "UNAVAILABLE"));
    await flush();
    ui.rerender(focusProps(LIVE, { refreshKey: 5 }));
    net.calls[4]!.reject(new ApiV1Error("offline", 503, "UNAVAILABLE"));
    await flush();
    expect(viewOf(ui).readFailed).toBe(true);
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
