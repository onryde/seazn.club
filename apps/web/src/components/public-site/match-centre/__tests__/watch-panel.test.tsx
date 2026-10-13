// T16 — the public fixture page's watch panel: an online board's state for
// whoever is looking (the page is ISR, one HTML for everyone), then kept live
// after hydration by the poll and the pushed moves.
//
//  - first paint: every state, in four locales, from the server's own doc —
//    live (the move list, Match details), held (a knockout draw keeps its
//    final position; any other hold is "to be confirmed"), finished (who won,
//    how, on which move, the score), not opened, not started (fix round 1, I4);
//  - a DECIDED fixture is finished for the spectators whatever its bridge
//    reads — never "needs the organiser", never polled (fix round 1, I1);
//  - one owner per testid (fix round 1, M9);
//  - the island: an immediate poll (the ISR page may be 30 s old), the poll
//    cadence, pushed boards through the REAL relay (live-board-channel), a
//    push the panel cannot place (White unknown, or the move list behind)
//    asking the poll at once, polling ending when the game is over for us,
//    unmount, and a navigation to another fixture.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { PublicBoardPush, PublicExternalPlay, PublicGameResult, PublicWatch, PublicWatchDoc } from "@/server/external-play/public-view";

const LOCALES = ["en", "es", "fr", "nl"] as const;
type Loc = (typeof LOCALES)[number];
const DICTS = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Dict]),
) as Record<Loc, Dict>;
const current = vi.hoisted(() => ({ locale: "en" as string }));
vi.mock("@/components/i18n/dict-provider", () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => tRuntime(DICTS[current.locale as Loc], key, vars),
  usePlural: () => (key: string, count: number, vars?: Record<string, string | number>) =>
    pluralRuntime(DICTS[current.locale as Loc], key, count, current.locale as Loc, vars),
  useLocale: () => current.locale,
}));

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client", async (importOriginal) => ({ ...(await importOriginal<object>()), api: apiMock }));

import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { POLL_MS } from "../use-live-fixture";
import { publishBoardPush } from "../live-board-channel";
import { WatchBoard } from "../watch-board";
import { WatchPanel, WatchPanelInner, fetchPublicBoard } from "../watch-panel";
import { showWatchPanel } from "../watch-state";

const s = (loc: Loc, key: string) => String(DICTS[loc][key]);
const sv = (loc: Loc, key: string, vars: Record<string, string | number>) => tRuntime(DICTS[loc], key as never, vars);
const esc = (x: string) => x.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const NAMES = { home: "Ada Home", away: "Bo Away" };
// The venue's zone is an hour off UTC in October, so a clock read in UTC is visibly wrong.
const DETAILS = { scheduledAt: "2026-10-16T18:00:00.000Z", clock: { limitSeconds: 900, incrementSeconds: 10 }, timeZone: "Europe/London" };
const SAN = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O"];
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
  moves: SAN.slice(0, ply),
  ...o,
});
const OPENED_AT = "2026-10-13T09:58:00.000Z";
const ep = (status: PublicExternalPlay["status"], watch: PublicWatch | null, o: Partial<PublicExternalPlay> = {}): PublicExternalPlay => ({
  status,
  watch,
  decided: false,
  hold: null,
  result: null,
  ...o,
});
const docOf = (play: PublicExternalPlay | null, roundOpened = true): PublicWatchDoc => ({
  roundOpened,
  roundOpenedAt: roundOpened ? OPENED_AT : null,
  externalPlay: play,
});
const live = (w: PublicWatch): PublicWatchDoc => docOf(ep("live", w));
const RESULT: PublicGameResult = { kind: "win", winner: "home", method: "resign", score: "0–1", recordedAt: "2026-10-13T10:05:00.000Z" };
const finished = (o: Partial<PublicExternalPlay> = {}) =>
  docOf(ep("finished", board(9, { over: true }), { decided: true, result: RESULT, ...o }));
type Details = { scheduledAt: string | null; clock: { limitSeconds: number; incrementSeconds: number } | null; timeZone: string };
const paint = (doc: PublicWatchDoc, loc: Loc = "en", details: Details = DETAILS) => {
  current.locale = loc;
  return renderToStaticMarkup(<WatchPanel fixtureId="f1" initial={doc} names={NAMES} details={details} />);
};
const testids = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!);

describe("WatchPanel — first paint, every state", () => {
  // [label, doc, data-state, data-hold, the board shown?, the keys of the copy that names the state]
  const STATES: [string, PublicWatchDoc, string, string | null, boolean, string[]][] = [
    ["not opened", docOf(null, false), "not_opened", null, false, ["externalPlay.watch.notOpenedTitle", "externalPlay.watch.notOpened"]],
    ["not started", docOf(null), "not_started", null, false, ["externalPlay.watch.notStartedTitle", "externalPlay.watch.notStarted"]],
    ["ready, no move yet", docOf(ep("ready", board(0))), "not_started", null, false, ["externalPlay.watch.notStartedTitle"]],
    ["live", live(board(5)), "live", null, true, ["externalPlay.watch.title", "externalPlay.watch.viewOnly", "externalPlay.watch.intro", "externalPlay.watch.moves"]],
    [
      "held: a knockout draw keeps its final position",
      docOf(ep("needs_organiser", board(9, { over: true }), { hold: "tiebreak" })),
      "held", "tiebreak", true,
      ["externalPlay.watch.hold.tiebreakTitle", "externalPlay.watch.hold.tiebreakBody"],
    ],
    [
      "held to confirm, with a game",
      docOf(ep("needs_organiser", board(4), { hold: "confirm" })),
      "held", "confirm", true,
      ["externalPlay.watch.hold.confirmTitle", "externalPlay.needsOrganiser"],
    ],
    ["held to confirm, no game", docOf(ep("needs_organiser", null, { hold: "confirm" })), "held", "confirm", false, ["externalPlay.watch.hold.confirmTitle"]],
    ["finished", finished(), "finished", null, true, ["externalPlay.watch.finalTitle"]],
  ];

  it("each state names itself in its own words, in all four locales; one owner per testid; none links to Lichess", () => {
    let checked = 0;
    for (const [label, doc, state, hold, hasBoard, keys] of STATES) {
      for (const loc of LOCALES) {
        const html = paint(doc, loc);
        const at = `${loc} ${label}`;
        expect(html, at).toContain(`data-testid="watch-panel" data-state="${state}"`);
        if (hold === null) expect(html, at).not.toContain("data-hold=");
        else expect(html, at).toContain(`data-testid="watch-hold" data-hold="${hold}"`);
        for (const key of keys) {
          expect(typeof DICTS[loc][key] === "string" && s(loc, key).trim().length > 0, `${at} ${key}`).toBe(true);
          if (loc !== "en") expect(s(loc, key), `${at} ${key}: translated`).not.toBe(s("en", key));
          expect(html, `${at} ${key}`).toContain(esc(s(loc, key)));
        }
        expect(html.includes('data-testid="watch-board"'), `${at}: board`).toBe(hasBoard);
        const ids = testids(html);
        expect(ids.length, `${at}: anti-vacuity`).toBeGreaterThan(2);
        expect(ids.filter((id, i) => ids.indexOf(id) !== i), `${at}: a testid owned twice (M9)`).toEqual([]);
        expect(html, at).not.toMatch(/lichess\.org/);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: states × locales").toBe(STATES.length * LOCALES.length);
  });

  it("I1: a DECIDED fixture whose bridge is still held reads finished — never 'needs the organiser', never polled", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      const html = paint(docOf(ep("needs_organiser", board(6), { decided: true, hold: null, result: RESULT })), loc);
      expect(html, loc).toContain('data-state="finished"');
      expect(html, loc).toContain('data-polling="false"');
      expect(html, loc).not.toContain(esc(s(loc, "externalPlay.needsOrganiser")));
      expect(html, loc).not.toContain('data-testid="watch-hold"');
      expect(html, loc).toContain(esc(sv(loc, "externalPlay.watch.result.won", { name: NAMES.home })));
      checked += 1;
    }
    expect(checked).toBe(4);
    // The positive pair: the same board under an OPEN fixture is held, and polled.
    const open = paint(docOf(ep("needs_organiser", board(6), { hold: "confirm" })));
    expect(open).toContain('data-state="held"');
    expect(open).toContain('data-polling="true"');
    expect(open).toContain(esc(s("en", "externalPlay.needsOrganiser")));
  });

  it("the board names each side from White's side on file — the AWAY entrant plays White here", () => {
    const html = paint(live(board(1)));
    expect(html).toMatch(/data-testid="watch-clock-white"[^]*?Bo Away/);
    expect(html).toMatch(/data-testid="watch-clock-black"[^]*?Ada Home/);
  });

  it("the move list: two plies a row, numbered, every ply once, the last one marked; a focusable scroll region", () => {
    let checked = 0;
    for (const ply of [1, 2, 5, 9]) {
      const html = paint(live(board(ply)));
      const list = html.slice(html.indexOf('data-testid="watch-moves"'));
      const rows = Math.ceil(ply / 2);
      for (let n = 1; n <= rows; n++) expect(list, `ply ${ply}: row ${n}`).toContain(`>${n}.</span>`);
      expect(list, `ply ${ply}: no row past the game`).not.toContain(`>${rows + 1}.</span>`);
      expect(list.match(/data-testid="watch-move-last"[^>]*>([^<]+)</)?.[1], `ply ${ply}: the last move marked`).toBe(SAN[ply - 1]);
      expect(list.match(/data-testid="watch-move-last"/g)?.length, `ply ${ply}`).toBe(1);
      for (const san of SAN.slice(0, ply)) expect(list, `ply ${ply}: ${san}`).toContain(`>${esc(san)}</span>`);
      checked += 1;
    }
    expect(checked).toBe(4);
    // axe's scrollable-region-focusable: a scrolling region is reachable by keyboard and named.
    expect(paint(live(board(5)))).toMatch(new RegExp(`role="region" aria-label="${esc(s("en", "externalPlay.watch.moves"))}" tabindex="0"`));
  });

  it("Match details: scheduled and round opened in the VENUE's zone, the time control spelled out, played online", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      const html = paint(live(board(3)), loc);
      const dd = (key: string) => html.match(new RegExp(`data-detail="${key}"[^]*?<dd[^>]*>([^<]*)</dd>`))?.[1];
      // Expected from Intl in the venue's zone and the dictionary — 18:00Z is 19:00 in London in October.
      const fmt = (iso: string, o: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat(loc, { ...o, hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Europe/London" }).format(new Date(iso));
      expect(dd("scheduled"), loc).toBe(esc(fmt(DETAILS.scheduledAt, { weekday: "short", day: "numeric", month: "short" })));
      expect(dd("scheduled"), `${loc}: the venue's hour, not UTC's`).toContain("19:00");
      expect(dd("round-opened"), loc).toBe("10:58");
      const p = (k: string, n: number) => pluralRuntime(DICTS[loc], k, n, loc);
      expect(dd("time-control"), loc).toBe(esc(`${p("externalPlay.room.minutes", 15)} + ${p("externalPlay.room.seconds", 10)}`));
      expect(dd("played"), loc).toBe(esc(s(loc, "externalPlay.watch.details.online")));
      checked += 1;
    }
    expect(checked).toBe(4);
    // A fact the page does not have is left out, never shown blank.
    const bare = paint(docOf(ep("live", board(3)), false), "en", { scheduledAt: null, clock: null, timeZone: "Europe/London" });
    expect(bare.match(/data-detail="([^"]+)"/g)).toEqual(['data-detail="played"']);
    // …and one it cannot read is left out too: a public page never 500s on a bad moment.
    const odd = paint(docOf(ep("live", board(3)), false), "en", { scheduledAt: "not a date", clock: null, timeZone: "Europe/London" });
    expect(odd.match(/data-detail="([^"]+)"/g)).toEqual(['data-detail="played"']);
  });

  it("the finished header: who won (by entrant, not colour), how, on which move, the score White first, and when it was recorded", () => {
    // Home won; the AWAY entrant plays White here, so the score reads 0–1 and the winner is NOT White.
    const cells: [string, PublicGameResult | null, string, (loc: Loc) => string[]][] = [
      ["a win by resignation", RESULT, "win", (loc) => [sv(loc, "externalPlay.watch.result.won", { name: NAMES.home }), s(loc, "method.resign"), sv(loc, "externalPlay.watch.result.move", { move: 5 }), "0–1"]],
      ["the away side's win", { ...RESULT, winner: "away", score: "1–0", method: "checkmate" }, "win", (loc) => [sv(loc, "externalPlay.watch.result.won", { name: NAMES.away }), s(loc, "method.checkmate"), "1–0"]],
      ["a draw", { ...RESULT, kind: "draw", winner: null, method: "agreement", score: "½–½" }, "draw", (loc) => [s(loc, "externalPlay.watch.result.draw"), s(loc, "method.agreement"), "½–½"]],
      ["no result", { ...RESULT, kind: "no_result", winner: null, method: null, score: "" }, "no_result", (loc) => [s(loc, "externalPlay.watch.result.noResult")]],
      ["no result on the fixture yet", null, "none", (loc) => [s(loc, "externalPlay.watch.result.over")]],
    ];
    let checked = 0;
    for (const [label, result, kind, want] of cells) {
      for (const loc of LOCALES) {
        const html = paint(finished({ result, decided: result !== null }), loc);
        const header = html.slice(html.indexOf('data-testid="watch-result"'), html.indexOf('data-testid="watch-board"'));
        expect(header, `${loc} ${label}`).toContain(`data-kind="${kind}"`);
        for (const w of want(loc)) expect(header, `${loc} ${label}: ${w}`).toContain(esc(w));
        // The final position and its last move (ply 9 is White's fifth): "5. O-O".
        expect(html, `${loc} ${label}`).toContain(esc(sv(loc, "externalPlay.watch.finalLine", { move: "5. O-O" })));
        checked += 1;
      }
    }
    expect(checked).toBe(cells.length * LOCALES.length);
    // An unknown method is left out rather than printed as a key; a method never shows as a raw key.
    const odd = paint(finished({ result: { ...RESULT, method: "teleport" } }));
    expect(odd).not.toContain("teleport");
    expect(odd).not.toContain("method.");
    // Recorded at 10:05Z = 11:05 at the venue.
    expect(paint(finished())).toContain(esc(sv("en", "externalPlay.watch.result.recordedAt", { time: "11:05" })));
    expect(paint(finished({ result: null, decided: false }))).toContain(esc(s("en", "externalPlay.watch.result.toConfirm")));
    expect(paint(finished({ result: null, decided: true }))).toContain(esc(s("en", "externalPlay.watch.result.noRecord")));
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
    const none = docOf(null);
    const cells: [string, PublicWatchDoc, boolean][] = [
      ["scheduled", none, true],
      ["in_play", none, true],
      ["needs_decision", none, true],
      ["finalized", none, false],
      ["decided", none, false],
      ["cancelled", none, false],
      ["finalized", finished(), true],
      ["finalized", docOf(ep("needs_organiser", null, { decided: true })), false],
      ["cancelled", docOf(ep("needs_organiser", board(4), { decided: true })), true],
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
  const attr = (island: { tree: () => ReactElement[] }, name: string) =>
    island.tree().map((el) => propsOf(el)[name]).find((x) => typeof x === "string");
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
    renderIsland(WatchPanelInner, { fixtureId, initial, names: NAMES, details: DETAILS, fetchBoard });
  const pushOf = (ply: number, o: Partial<PublicBoardPush> = {}): PublicBoardPush => ({
    fen: board(ply).fen, lastMove: "e2e4", turn: ply % 2 === 0 ? "white" : "black", ply, whiteMs: 600_000, blackMs: 600_000, over: false, ...o,
  });

  it("polls at once (the page may be 30 s old), then every POLL_MS; a newer board lands", async () => {
    fetchBoard.mockResolvedValue(live(board(3)));
    const island = mount(docOf(null));
    expect(attr(island, "data-state")).toBe("not_started");
    await flush();
    expect(fetchBoard.mock.calls).toEqual([["f1"]]);
    expect(boards(island).map((w) => w.ply)).toEqual([3]);
    expect(attr(island, "data-state")).toBe("live");
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

  it("a push the panel cannot place asks the poll at once — White unknown, or the move list behind — and only then", async () => {
    // White not known yet.
    fetchBoard.mockResolvedValueOnce(docOf(null));
    const a = mount(docOf(null));
    await flush();
    expect(fetchBoard).toHaveBeenCalledTimes(1);
    fetchBoard.mockResolvedValueOnce(live(board(1, { whiteSide: "home" })));
    publishBoardPush("f1", pushOf(1));
    await flush();
    expect(fetchBoard, "White unknown: asked at once, not at the next tick").toHaveBeenCalledTimes(2);
    expect(boards(a).map((w) => w.whiteSide)).toEqual(["home"]);
    a.unmount();

    // White known, but the pushed ply is past the list: the poll brings the list level.
    fetchBoard.mockReset();
    fetchBoard.mockResolvedValue(live(board(2)));
    const b = mount(live(board(2)));
    await flush();
    expect(fetchBoard).toHaveBeenCalledTimes(1);
    fetchBoard.mockResolvedValue(live(board(3)));
    publishBoardPush("f1", pushOf(3));
    await flush();
    expect(fetchBoard, "list behind: asked at once").toHaveBeenCalledTimes(2);
    expect(boards(b).map((w) => w.moves.length)).toEqual([3]);
    // The positive pair: a correction push to a ply the list already holds asks nothing.
    publishBoardPush("f1", pushOf(2));
    await flush();
    expect(fetchBoard, "a placeable push asks nothing").toHaveBeenCalledTimes(2);
    b.unmount();
  });

  it("polling ends once the game is over for us — the bridge finished, or the fixture DECIDED under a held bridge (I1) — and a failed poll keeps the board", async () => {
    let checked = 0;
    const ends: [string, PublicWatchDoc][] = [
      ["bridge finished", docOf(ep("finished", board(9, { over: true })))],
      ["fixture decided, bridge held", docOf(ep("needs_organiser", board(9), { decided: true, result: RESULT }))],
    ];
    for (const [label, end] of ends) {
      fetchBoard.mockReset();
      fetchBoard.mockRejectedValueOnce(new TypeError("fetch failed"));
      const island = mount(live(board(4)));
      await flush();
      expect(boards(island).map((w) => w.ply), `${label}: a failed poll keeps the board`).toEqual([4]);
      fetchBoard.mockResolvedValue(end);
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(boards(island).map((w) => [w.ply, w.over]), label).toEqual([[9, true]]);
      expect([attr(island, "data-state"), attr(island, "data-polling")], label).toEqual(["finished", "false"]);
      const calls = fetchBoard.mock.calls.length;
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
      expect(fetchBoard.mock.calls.length, `${label}: no poll after the end`).toBe(calls);
      island.unmount();
      checked += 1;
    }
    expect(checked).toBe(ends.length);
  });

  it("a held board under an OPEN fixture keeps polling — its result is still to come", async () => {
    fetchBoard.mockResolvedValue(docOf(ep("needs_organiser", board(9, { over: true }), { hold: "tiebreak" })));
    const island = mount(docOf(ep("needs_organiser", board(9, { over: true }), { hold: "tiebreak" })));
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(fetchBoard).toHaveBeenCalledTimes(3);
    expect([attr(island, "data-state"), attr(island, "data-hold")]).toEqual(["held", "tiebreak"]);
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
    expect(() => publishBoardPush("f1", pushOf(2))).not.toThrow();
  });

  it("a navigation to another fixture starts from THAT fixture's doc — the panel is keyed by its fixture", () => {
    const el = WatchPanel({ fixtureId: "f2", initial: live(board(1)), names: NAMES, details: DETAILS }) as ReactElement;
    expect(el.type).toBe(WatchPanelInner);
    expect(el.key).toBe("f2");
  });
});

describe("fetchPublicBoard — what reaches the network", () => {
  it("asks the public board route for THIS fixture (encoded), never from the browser's cache", async () => {
    // The route's Cache-Control is for the edge; a browser-cached answer would freeze a poll-only spectator.
    apiMock.mockReset();
    apiMock.mockResolvedValue(live(board(3)));
    expect(await fetchPublicBoard("f 1")).toEqual(live(board(3)));
    expect(apiMock.mock.calls).toEqual([["/api/v1/public/fixtures/f%201/board", { cache: "no-store" }]]);
  });
});

describe("the fixture page (a server component) calls nothing from a client module", () => {
  // Found by the browser pass: `showWatchPanel` once lived in watch-panel.tsx ("use client"), and the page's
  // call answered 500 — "Attempted to call showWatchPanel() from the server". A node render never sees it.
  it("every binding it imports from a \"use client\" module is a component (or a type)", () => {
    const SRC = join(__dirname, "..", "..", "..", "..");
    const page = readFileSync(join(SRC, "app", "(public)", "shared", "[orgSlug]", "[competitionSlug]", "[divisionSlug]", "fixtures", "[fixtureId]", "page.tsx"), "utf8");
    const imports = [...page.matchAll(/^import (type )?\{([^}]*)\} from "@\/([^"]+)";$/gm)];
    let clientModules = 0;
    const offenders: string[] = [];
    for (const [, typeOnly, names, mod] of imports) {
      if (typeOnly) continue;
      const base = join(SRC, mod!);
      const file = [".tsx", ".ts"].map((x) => base + x).find((f) => { try { return statSync(f).isFile(); } catch { return false; } });
      if (!file || !/^\s*["']use client["']/.test(readFileSync(file, "utf8"))) continue;
      clientModules += 1;
      for (const raw of names!.split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!;
        if (name === "" || raw.trim().startsWith("type ")) continue;
        if (!/^[A-Z]/.test(name)) offenders.push(`${mod}: ${name}`);
      }
    }
    expect(clientModules, "anti-vacuity: client modules the page imports").toBeGreaterThan(2);
    expect(offenders).toEqual([]);
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
