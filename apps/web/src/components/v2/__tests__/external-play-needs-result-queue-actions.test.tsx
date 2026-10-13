// T16 — the queue's clicks, through the REAL component and the REAL decision
// reducer and runner (arbiter-decision.ts), with the network doubled at
// `apiV1`. What reaches the server for each button, one request at a time
// across the whole queue, the answer shown on the row it was sent for — and,
// when the refresh that answers it takes the row away, still shown.
// No DOM in this workspace: the hook harness renders the island and calls
// its handlers the way a browser would.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { FlaggedBoard } from "@/server/usecases/external-play/arbiter";

// Next's router is one stable instance per app, as here: the runner is built once per mount.
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
const refresh = router.refresh;
vi.mock("next/navigation", () => ({ useRouter: () => router }));

type Call = { url: string; json?: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const net = vi.hoisted(() => ({ calls: [] as Call[] }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    // Each request waits until the test answers it: "in flight" is a real state here.
    apiV1: (url: string, options?: { json?: unknown }) =>
      new Promise((resolve, reject) => net.calls.push({ url, json: options?.json, resolve, reject })),
  };
});
const EN_UI: Dict = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", "en", "ui.json"), "utf8")) as Dict;
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return {
    ...actual,
    useT: () => (key: string, vars?: Record<string, string | number>) => tRuntime(EN_UI, key, vars),
    usePlural: () => (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(EN_UI, key, count, "en", vars),
    useLocale: () => "en",
  };
});

import { ApiV1Error } from "@/lib/client-v1";
import { ExternalPlayNeedsResultQueue, type ExternalPlayQueueProps, type HeldRow } from "../external-play-needs-result-queue";

const SLUGS = { org: "o", comp: "c", div: "d" };
const HELD = (fixtureId: string, over: Partial<HeldRow> = {}): HeldRow => ({
  fixtureId,
  homeName: "Hal",
  awayName: "Ana",
  whiteSide: "home",
  revokedSeat: null,
  roundNo: 1,
  boardNo: 1,
  stageName: "League",
  canResync: true,
  seated: false,
  reason: "aborted",
  ...over,
});
const FLAGGED = (fixtureId: string, over: Partial<FlaggedBoard> = {}): FlaggedBoard =>
  ({
    fixtureId,
    fixtureNo: 1,
    boardNo: 2,
    white: { name: "W", personId: null },
    black: { name: "B", personId: null },
    state: { kind: "live" },
    clock: null,
    cameraPolicy: "off",
    videoOverridden: false,
    cameraReport: null,
    canResync: true,
    playable: true,
    canSettle: true,
    whiteSide: "home",
    tiebreakOwed: false,
    flags: [
      { id: `${fixtureId}-a`, kind: "out_of_band_play", at: "2026-10-12T19:00:00.000Z", plies: null },
      { id: `${fixtureId}-b`, kind: "out_of_band_play", at: "2026-10-12T19:01:00.000Z", plies: null },
    ],
    roundNo: 1,
    stageName: "League",
    ...over,
  }) as FlaggedBoard;

/** Distinct elements (walk revisits) carrying a test id. */
function byTestId(tree: ReactElement[], id: string): ReactElement[] {
  return [...new Set(tree.filter((n) => propsOf(n)["data-testid"] === id))];
}
function inRow(tree: ReactElement[], rowId: string): ReactElement[] {
  const row = [...new Set(tree.filter((n) => propsOf(n).id === rowId))];
  expect(row, `row ${rowId}`).toHaveLength(1);
  const out: ReactElement[] = [];
  const visit = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (n && typeof n === "object" && "props" in (n as object)) {
      out.push(n as ReactElement);
      visit(propsOf(n as ReactElement).children);
    }
  };
  visit(propsOf(row[0]!).children);
  return out;
}
const click = (el: ReactElement | undefined) => (propsOf(el!).onClick as () => void)();
const settleButton = (tree: ReactElement[], rowId: string, choice: string) =>
  inRow(tree, rowId).find((n) => propsOf(n)["data-settle"] === choice);
const flush = () => new Promise((r) => setTimeout(r, 0));
const statusText = (tree: ReactElement[]) => textOf(byTestId(tree, "external-play-queue-status")[0]);

function mount(props: Partial<ExternalPlayQueueProps>) {
  const all: ExternalPlayQueueProps = { held: [], flagged: [], ownFlagged: 0, slugs: SLUGS, ...props };
  return renderIsland(ExternalPlayNeedsResultQueue, all);
}

beforeEach(() => {
  net.calls.length = 0;
  refresh.mockReset();
});

describe("what each button sends", () => {
  it("Settle → resolve with the button's side; Resync → resync; 'Let the game go on' → flags/close with the ids ON SCREEN", async () => {
    const ui = mount({ held: [HELD("h1", { whiteSide: "away" })], flagged: [FLAGGED("g1")] });
    // White is Ana (away): "Ana wins" sends away_wins.
    const ana = inRow(ui.tree(), "external-play-queue-row-h1").find((n) => textOf(n) === "Ana wins");
    expect(propsOf(ana!)["data-settle"]).toBe("away_wins");
    click(ana);
    expect(net.calls.map((c) => [c.url, c.json])).toEqual([["/api/v1/fixtures/h1/external-play/resolve", { kind: "away_wins" }]]);
    net.calls[0]!.resolve({ status: "finished" });
    await flush();

    click(byTestId(ui.tree(), "external-play-resync")[0]);
    expect(net.calls[1]!.url).toBe("/api/v1/fixtures/h1/external-play/resync");
    net.calls[1]!.resolve({ read: true, adopted: 0 });
    await flush();

    click(byTestId(ui.tree(), "external-play-go-on")[0]);
    expect([net.calls[2]!.url, net.calls[2]!.json]).toEqual(["/api/v1/fixtures/g1/external-play/flags/close", { ids: ["g1-a", "g1-b"] }]);
    net.calls[2]!.resolve({ closed: 2, stillOpen: 0 });
    await flush();
    expect(net.calls).toHaveLength(3);
    expect(refresh, "each answer refreshes the page").toHaveBeenCalledTimes(3);
  });

  it("ONE request at a time across the whole queue: a second press anywhere while one is in flight sends nothing", async () => {
    const ui = mount({ held: [HELD("h1"), HELD("h2")], flagged: [FLAGGED("g1")] });
    click(settleButton(ui.tree(), "external-play-queue-row-h1", "draw"));
    // While it is in flight: the same button, another row's settle, a go-on.
    click(settleButton(ui.tree(), "external-play-queue-row-h1", "draw"));
    click(settleButton(ui.tree(), "external-play-queue-row-h2", "home_wins"));
    click(byTestId(ui.tree(), "external-play-go-on")[0]);
    expect(net.calls).toHaveLength(1);
    // Every button reads disabled meanwhile.
    const buttons = [...new Set(ui.tree().filter((n) => n.type === "button"))];
    expect(buttons.length, "buttons on screen").toBeGreaterThan(0);
    for (const b of buttons) expect(propsOf(b).disabled, textOf(b)).toBe(true);
    net.calls[0]!.resolve({ status: "finished" });
    await flush();
    click(settleButton(ui.tree(), "external-play-queue-row-h2", "home_wins"));
    expect(net.calls, "freed by the answer").toHaveLength(2);
  });
});

describe("where the answer shows", () => {
  it("a refusal shows on the row it was sent for, by its code — and nowhere else", async () => {
    const ui = mount({ held: [HELD("h1"), HELD("h2")] });
    click(settleButton(ui.tree(), "external-play-queue-row-h2", "draw"));
    net.calls[0]!.reject(new ApiV1Error("x", 409, "ALREADY_RESOLVED"));
    await flush();
    const notices = byTestId(ui.tree(), "external-play-row-notice");
    expect(notices).toHaveLength(1);
    expect(textOf(notices[0]), "the route's code, in words").toBe(EN_UI["arbiter.notice.alreadyResolved"]);
    expect(inRow(ui.tree(), "external-play-queue-row-h2")).toContain(notices[0]);
    expect(refresh, "a refusal changes nothing to refresh").not.toHaveBeenCalled();
  });

  it("N2: a board another organiser settled at the same moment — told it CHANGED, by its own code, not that it has its result", async () => {
    const ui = mount({ held: [HELD("h1")] });
    click(settleButton(ui.tree(), "external-play-queue-row-h1", "home_wins"));
    net.calls[0]!.reject(new ApiV1Error("x", 409, "BOARD_CHANGED"));
    await flush();
    const notices = byTestId(ui.tree(), "external-play-row-notice");
    expect(notices).toHaveLength(1);
    expect(textOf(notices[0])).toBe(EN_UI["arbiter.notice.boardChanged"]);
    expect(textOf(notices[0])).not.toBe(EN_UI["arbiter.notice.alreadyResolved"]);
  });

  it("the sequence: settle the LAST held board → the refresh removes its row → the answer is still on screen; the empty queue keeps only that", async () => {
    const ui = mount({ held: [HELD("h1")] });
    click(settleButton(ui.tree(), "external-play-queue-row-h1", "home_wins"));
    net.calls[0]!.resolve({ status: "finished" });
    await flush();
    // The page's refresh hands down a queue without the row.
    ui.rerender({ held: [], flagged: [], ownFlagged: 0, slugs: SLUGS });
    expect(statusText(ui.tree())).toBe(EN_UI["arbiter.notice.settled"]);
    expect(propsOf(byTestId(ui.tree(), "external-play-queue-status")[0]!).className, "visible, not screen-reader only").not.toContain("sr-only");
    expect(byTestId(ui.tree(), "external-play-held")).toHaveLength(0);
  });

  it("a finished board's flags, closed: 'Marked as reviewed' — a live board's: 'The game goes on'; each after its row leaves", async () => {
    const cases = [
      { over: true, expected: EN_UI["externalPlay.queue.reviewed"] },
      { over: false, expected: EN_UI["arbiter.notice.wentOn"] },
    ];
    let checked = 0;
    for (const c of cases) {
      net.calls.length = 0;
      const board = FLAGGED("g1", c.over ? { state: { kind: "result", score: "1–0" } } : {});
      const ui = mount({ flagged: [board] });
      expect(textOf(byTestId(ui.tree(), "external-play-go-on")[0])).toBe(c.over ? "Mark as reviewed" : "Let the game go on");
      click(byTestId(ui.tree(), "external-play-go-on")[0]);
      net.calls[0]!.resolve({ closed: 2, stillOpen: 0 });
      await flush();
      ui.rerender({ held: [], flagged: [], ownFlagged: 0, slugs: SLUGS });
      expect(statusText(ui.tree()), `over: ${c.over}`).toBe(c.expected);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("A: a flag raised after the screen loaded stays open — the answer says so and the board stays listed", async () => {
    const ui = mount({ flagged: [FLAGGED("g1")] });
    click(byTestId(ui.tree(), "external-play-go-on")[0]);
    net.calls[0]!.resolve({ closed: 2, stillOpen: 1 });
    await flush();
    ui.rerender({ held: [], flagged: [FLAGGED("g1", { flags: [{ id: "late", kind: "out_of_band_play", at: "2026-10-12T19:05:00.000Z", plies: null }] })], ownFlagged: 0, slugs: SLUGS });
    const notice = byTestId(ui.tree(), "external-play-row-notice");
    expect(textOf(notice[0])).toBe(tRuntime(EN_UI, "arbiter.notice.wentOnNew.one", { count: 1 }));
  });
});
