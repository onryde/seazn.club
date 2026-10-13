// T16 — the public fixture page's watch panel: an online board's state for
// whoever is looking (the page is ISR, one HTML for everyone), then kept live
// after hydration by the poll and the pushed moves.
//
//  - first paint: every state, in four locales, from the server's own doc;
//  - the island: an immediate poll (the ISR page may be 30 s old), the poll
//    cadence, pushed boards through the REAL relay (live-board-channel), a
//    push without White's side asking the poll at once, polling ending when
//    the game is finished, unmount, and a navigation to another fixture.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { PublicBoardPush, PublicWatch, PublicWatchDoc } from "@/server/external-play/public-view";

const LOCALES = ["en", "es", "fr", "nl"] as const;
type Loc = (typeof LOCALES)[number];
const DICTS = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Dict]),
) as Record<Loc, Dict>;
const current = vi.hoisted(() => ({ locale: "en" as string }));
vi.mock("@/components/i18n/dict-provider", () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => tRuntime(DICTS[current.locale as Loc], key, vars),
}));

import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { POLL_MS } from "../use-live-fixture";
import { publishBoardPush } from "../live-board-channel";
import { WatchBoard } from "../watch-board";
import { WatchPanel, WatchPanelInner, showWatchPanel } from "../watch-panel";

const s = (loc: Loc, key: string) => String(DICTS[loc][key]);
const esc = (x: string) => x.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const NAMES = { home: "Ada Home", away: "Bo Away" };
const board = (ply: number, o: Partial<PublicWatch> = {}): PublicWatch => ({
  fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
  lastMove: "e2e4",
  turn: ply % 2 === 0 ? "white" : "black",
  ply,
  whiteMs: 600_000,
  blackMs: 600_000,
  asOf: "2026-10-13T10:00:00.000Z",
  clockRunning: false,
  over: false,
  whiteSide: "away",
  ...o,
});
const live = (w: PublicWatch): PublicWatchDoc => ({ roundOpened: true, externalPlay: { status: "live", watch: w } });
const paint = (doc: PublicWatchDoc, loc: Loc = "en") => {
  current.locale = loc;
  return renderToStaticMarkup(<WatchPanel fixtureId="f1" initial={doc} names={NAMES} />);
};

describe("WatchPanel — first paint, every state", () => {
  const STATES: [string, PublicWatchDoc, string | null][] = [
    ["not_opened", { roundOpened: false, externalPlay: null }, "externalPlay.watch.notOpened"],
    ["not_started", { roundOpened: true, externalPlay: null }, "externalPlay.watch.notStarted"],
    ["held", { roundOpened: true, externalPlay: { status: "needs_organiser", watch: null } }, "externalPlay.needsOrganiser"],
    ["board", live(board(1)), null],
  ];

  it("each state names itself, in its own words in all four locales; none links to Lichess", () => {
    let checked = 0;
    for (const [state, doc, key] of STATES) {
      for (const loc of LOCALES) {
        const html = paint(doc, loc);
        expect(html, `${loc} ${state}`).toContain(`data-testid="watch-panel" data-state="${state}"`);
        expect(html, `${loc} ${state}`).toContain(esc(s(loc, "externalPlay.watch.title")));
        if (key !== null) {
          expect(typeof DICTS[loc][key] === "string" && s(loc, key).trim().length > 0, `${loc} ${key}`).toBe(true);
          if (loc !== "en") expect(s(loc, key), `${loc} ${key}: translated`).not.toBe(s("en", key));
          expect(html, `${loc} ${state}`).toContain(esc(s(loc, key)));
          expect(html).not.toContain('data-testid="watch-board"');
        }
        expect(html, `${loc} ${state}`).not.toMatch(/lichess\.org/);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: states × locales").toBe(STATES.length * LOCALES.length);
  });

  it("the board names each side from White's side on file — the AWAY entrant plays White here", () => {
    current.locale = "en";
    const html = paint(live(board(1)));
    expect(html).toMatch(/data-testid="watch-clock-white"[^]*?Bo Away/);
    expect(html).toMatch(/data-testid="watch-clock-black"[^]*?Ada Home/);
  });

  it("the old waiting-for-your-link sentence D12 falsified is gone from every dictionary", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      expect(DICTS[loc]["externalPlay.waitingForLink"], loc).toBeUndefined();
      expect(DICTS[loc]["externalPlay.soon"], loc).toBeUndefined();
      checked += 1;
    }
    expect(checked).toBe(4);
  });
});

describe("showWatchPanel — when the page shows it", () => {
  it("an open fixture always; a decided or cancelled one only with a game to show", () => {
    const none: PublicWatchDoc = { roundOpened: true, externalPlay: null };
    const cells: [string, PublicWatchDoc, boolean][] = [
      ["scheduled", none, true],
      ["in_play", none, true],
      ["needs_decision", none, true],
      ["finalized", none, false],
      ["decided", none, false],
      ["cancelled", none, false],
      ["finalized", { roundOpened: true, externalPlay: { status: "finished", watch: board(9, { over: true }) } }, true],
      ["finalized", { roundOpened: true, externalPlay: { status: "needs_organiser", watch: null } }, false],
    ];
    let checked = 0;
    for (const [status, doc, show] of cells) {
      expect(showWatchPanel(status, doc), `${status} ${JSON.stringify(doc.externalPlay?.status ?? null)}`).toBe(show);
      checked += 1;
    }
    expect(checked).toBe(cells.length);
  });
});

describe("WatchPanel — after hydration", () => {
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const boards = (island: { tree: () => ReactElement[] }) =>
    island.tree().filter((el) => el.type === WatchBoard).map((el) => propsOf(el).watch as PublicWatch);
  const state = (island: { tree: () => ReactElement[] }) =>
    island.tree().map((el) => propsOf(el)["data-state"]).find((x) => typeof x === "string");
  let fetchBoard: ReturnType<typeof vi.fn<(id: string) => Promise<PublicWatchDoc>>>;
  beforeEach(() => {
    vi.useFakeTimers();
    current.locale = "en";
    fetchBoard = vi.fn<(id: string) => Promise<PublicWatchDoc>>();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const mount = (initial: PublicWatchDoc, fixtureId = "f1") =>
    renderIsland(WatchPanelInner, { fixtureId, initial, names: NAMES, fetchBoard });

  it("polls at once (the page may be 30 s old), then every POLL_MS; a newer board lands", async () => {
    fetchBoard.mockResolvedValue(live(board(3)));
    const island = mount({ roundOpened: true, externalPlay: null });
    expect(state(island)).toBe("not_started");
    await flush();
    expect(fetchBoard.mock.calls).toEqual([["f1"]]);
    expect(boards(island).map((w) => w.ply)).toEqual([3]);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchBoard).toHaveBeenCalledTimes(2);
    island.unmount();
  });

  it("a pushed move lands through the real relay — and a stale poll does not take it back", async () => {
    fetchBoard.mockResolvedValue(live(board(1)));
    const island = mount(live(board(1)));
    await flush();
    const push: PublicBoardPush = {
      fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
      lastMove: "e7e5", turn: "white", ply: 2, whiteMs: 590_000, blackMs: 595_000, over: false,
    };
    publishBoardPush("f1", push);
    await flush();
    expect(boards(island).map((w) => [w.ply, w.lastMove, w.whiteSide])).toEqual([[2, "e7e5", "away"]]);
    await vi.advanceTimersByTimeAsync(POLL_MS); // answers ply 1, from before the push
    expect(boards(island).map((w) => w.ply)).toEqual([2]);
    publishBoardPush("other-fixture", { ...push, ply: 3, turn: "black", lastMove: "g1f3" });
    await flush();
    expect(boards(island).map((w) => w.ply), "another fixture's push").toEqual([2]);
    island.unmount();
  });

  it("a push for a board whose White is not known yet asks the poll at once, which tells it", async () => {
    fetchBoard.mockResolvedValueOnce({ roundOpened: true, externalPlay: null });
    const island = mount({ roundOpened: true, externalPlay: null });
    await flush();
    expect(fetchBoard).toHaveBeenCalledTimes(1);
    fetchBoard.mockResolvedValueOnce(live(board(1, { whiteSide: "home" })));
    publishBoardPush("f1", { fen: board(1).fen, lastMove: "e2e4", turn: "black", ply: 1, whiteMs: 600_000, blackMs: 600_000, over: false });
    await flush();
    expect(fetchBoard, "asked at once, not at the next tick").toHaveBeenCalledTimes(2);
    expect(boards(island).map((w) => w.whiteSide)).toEqual(["home"]);
    island.unmount();
  });

  it("polling ends once the game is finished — and a failed poll keeps the board", async () => {
    fetchBoard.mockRejectedValueOnce(new TypeError("fetch failed"));
    const island = mount(live(board(4)));
    await flush();
    expect(boards(island).map((w) => w.ply), "a failed poll keeps the board").toEqual([4]);
    fetchBoard.mockResolvedValue({ roundOpened: true, externalPlay: { status: "finished", watch: board(9, { over: true }) } });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(boards(island).map((w) => [w.ply, w.over])).toEqual([[9, true]]);
    const calls = fetchBoard.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(fetchBoard.mock.calls.length, "no poll after the finish").toBe(calls);
    island.unmount();
  });

  it("after unmount nothing more is asked, and a push reaches no one", async () => {
    fetchBoard.mockResolvedValue(live(board(1)));
    const island = mount(live(board(1)));
    await flush();
    island.unmount();
    const calls = fetchBoard.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(fetchBoard.mock.calls.length).toBe(calls);
    expect(() => publishBoardPush("f1", { fen: board(2).fen, lastMove: "e7e5", turn: "white", ply: 2, whiteMs: 1, blackMs: 1, over: false })).not.toThrow();
  });

  it("a navigation to another fixture starts from THAT fixture's doc — the panel is keyed by its fixture", () => {
    const el = WatchPanel({ fixtureId: "f2", initial: live(board(1)), names: NAMES }) as ReactElement;
    expect(el.type).toBe(WatchPanelInner);
    expect(el.key).toBe("f2");
  });
});

describe("no spectator surface links off to Lichess", () => {
  it("public-site components (bar the players' own room) and the public pages carry no lichess.org URL", () => {
    const SRC = join(__dirname, "..", "..", "..", "..");
    const roots = [join(SRC, "components", "public-site"), join(SRC, "app", "(public)")];
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((e) => {
        const f = join(d, e);
        return statSync(f).isDirectory() ? walk(f) : /\.(ts|tsx)$/.test(e) ? [f] : [];
      });
    const files = roots.flatMap(walk).filter((f) => !f.includes("__tests__") && !f.includes(`${join("public-site", "match-room")}`));
    expect(files.length, "anti-vacuity: files scanned").toBeGreaterThan(100);
    const offenders = files.filter((f) => /https?:\/\/(www\.)?lichess\.org/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
});
