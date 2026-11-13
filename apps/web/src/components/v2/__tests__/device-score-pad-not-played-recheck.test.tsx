// Quick match plan 4, FR3 (T5 findings 1 and 2, controller PO rec 2026-11-13): a guest's pad left open on a match the home
// marked Not played. Before, it stayed View-only after a Put back on another phone until the tab was left and come back to,
// or reloaded; and its header pill said "cancelled" over the Not played line.
//
// What this file pins (`apps/web` vitest is `environment: "node"`: `document`/`window` are recording stand-ins and the
// component's own handlers are invoked the way the browser would call them; the browser proof is
// e2e/quick-match-home.spec.ts "Pad left open" and "Stale screens"):
//   - the Not played screen reads the match again on a clock (`NOT_PLAYED_RECHECK_MS`) while the tab is visible, on a tab
//     return (visibility or focus) and on "Check again"; a hidden tab, an unmounted pad, a dead link, a live screen and an
//     ordinary pad arm no clock;
//   - a read that finds the match put back lifts View-only with no reload, onto the pad SEEDED from that read (never the
//     page's load-time ledger) at the stored score, or onto Confirm when it was put back unplayed;
//   - the pill says "Not played" on a quick match only; an ordinary pad keeps "cancelled".
// Single sport (generic): every branch here reads the fixture's status alone, never the sport (the T3 I1 rows' reason).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import en from "@/dictionaries/en/ui.json";
import { DeviceScorePad, type PadEventIn } from "@/components/v2/device-score-pad";
import { ScorePad } from "@/components/v2/scorepad/registry";
import { OPPORTUNISTIC_RESYNC_MS, type SideInfo, type SportInfo } from "@/components/v2/fixture-console";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { NOT_PLAYED_RECHECK_MS, type ViewOnlyReason } from "@/lib/scan-screen";

const dict = en as Record<string, string>;
const DEVICE_LINK_ID = "dl-1";

const START: PadEventIn = {
  id: "ev-start",
  seq: 1,
  type: "core.start",
  payload: {},
  recorded_at: "2026-11-13T10:00:00.000Z",
  voids_event_id: null,
  device_link_id: DEVICE_LINK_ID,
  recorded_by: "u1",
};
/** The rally scored before the skip: Put back restores it (plan Q1), so the pad must come back holding it. */
const RALLY: PadEventIn = {
  id: "ev-rally",
  seq: 2,
  type: "generic.result",
  payload: { p1Score: 1, p2Score: 0 },
  recorded_at: "2026-11-13T10:01:00.000Z",
  voids_event_id: null,
  device_link_id: DEVICE_LINK_ID,
  recorded_by: "u1",
};

/** The server behind `apiV1`: the match's status and ledger, moved by the test as the home's skip and Put back would. */
const server = vi.hoisted(() => ({
  status: "cancelled",
  ledger: [] as unknown[],
  headline: null as string | null,
  /** Every GET refused with this code (a dead link). */
  refuse: null as string | null,
  /** A half-open socket: a GET settles only through the caller's abort. */
  hang: false,
  /** FR4 m2: `/state`'s `quick_match_finished`, which the server adds on a quick match's Not played match only; undefined =
   *  the key is absent (any other match, an organiser's above all). */
  finished: undefined as boolean | undefined,
  /** FR4 m4: each hung GET's answer, held until the test releases it (`releaseHung`), as a slow network answers late. */
  held: [] as (() => void)[],
  gets: [] as string[],
}));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: vi.fn((url: string, options?: { method?: string; signal?: AbortSignal }) => {
      if (options?.method === "POST") return Promise.resolve({});
      server.gets.push(url);
      if (server.refuse !== null) return Promise.reject(new actual.ApiV1Error("dead", 410, server.refuse));
      const answer = () =>
        url.includes("/events")
          ? server.ledger
          : {
              status: server.status,
              last_seq: server.ledger.length,
              summary: server.headline === null ? null : { headline: server.headline },
              state: {},
              outcome: null,
              ...(server.finished === undefined ? {} : { quick_match_finished: server.finished }),
            };
      if (server.hang) {
        return new Promise((resolve, reject) => {
          server.held.push(() => resolve(answer()));
          options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
        });
      }
      return Promise.resolve(answer());
    }),
  };
});

const sport: SportInfo = {
  key: "generic",
  config: {},
  scorerLabel: "Umpire",
  positionGroups: [],
  roles: [],
  lineupSize: 1,
  benchMax: 0,
};
const side = (id: string, name: string): SideInfo => ({ id, name, members: [], lineup: [] });

/** The pad as the scan page renders it: `initialViewOnly` is the page's (`scanScreen`: cancelled → View-only), and the
 *  bootstrap ledger is EMPTY, so a pad mounted on it rather than on a fresh read is told apart by its seed. */
function padProps(status: string, ledger: PadEventIn[], quickMatch: boolean, initialViewOnly: ViewOnlyReason | null) {
  return {
    token: "dl_test",
    deviceLinkId: DEVICE_LINK_ID,
    fixture: { id: "f1", round_no: 1, venue: null, court_label: null, competition_name: "QM", division_name: "Quick match" },
    sport,
    home: side("h", "Ravi & Sam"),
    away: side("a", "Priya & Tom"),
    initialState: { status, last_seq: ledger.length, summary: null, state: {}, outcome: null },
    initialEvents: ledger,
    initialViewOnly,
    quickMatch,
    scorePadV2: {
      moduleVersion: "1.0.0",
      resolvedConfig: {},
      initialEvents: [],
      entitlements: {},
      stageKind: null,
      band: 0 as const,
      identity: { recordedBy: null, deviceLinkId: DEVICE_LINK_ID },
    },
  };
}
/** A guest's pad opened on a match already marked Not played (the page chose View-only). */
const openedNotPlayed = (ledger: PadEventIn[]) => padProps("cancelled", ledger, true, "cancelled");

type Listener = () => void;
function recordingTarget() {
  const listeners: Record<string, Listener[]> = {};
  return {
    listeners,
    addEventListener: (type: string, fn: Listener) => void (listeners[type] ??= []).push(fn),
    removeEventListener: (type: string, fn: Listener) =>
      void (listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn)),
  };
}
function stubDom(visibilityState: DocumentVisibilityState = "visible") {
  const doc = { ...recordingTarget(), visibilityState };
  const win = recordingTarget();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
  return { doc, win };
}
const fire = (target: { listeners: Record<string, Listener[]> }, type: string) => {
  for (const fn of [...(target.listeners[type] ?? [])]) fn();
};

const byTestId = (tree: ReactElement[], id: string) => tree.find((e) => propsOf(e)["data-testid"] === id);
/** How many times the match was read: one `/state` per re-read (each beside one ledger read). */
const reads = () => server.gets.filter((u) => u.endsWith("/state")).length;
/** Settle the mocks' promises without moving the fake clock (`setImmediate` is left real). */
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
/** Move the clock and settle what it fired. */
const tick = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
};
const seedOf = (tree: ReactElement[]) => {
  const pad = tree.find((e) => e.type === ScorePad);
  expect(pad, "the pad is mounted").toBeDefined();
  return (propsOf(pad!).initialEvents as { type: string; seq: number }[]).map((e) => [e.type, e.seq]);
};
const pill = (tree: ReactElement[]) => textOf(byTestId(tree, "scan-status"));
const checkAgain = (tree: ReactElement[]) => byTestId(tree, "scan-check-again");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  server.status = "cancelled";
  server.ledger = [];
  server.headline = null;
  server.refuse = null;
  server.hang = false;
  server.finished = undefined;
  server.held.length = 0;
  server.gets.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DeviceScorePad — a quick match's Not played screen reads the match again (FR3)", () => {
  it("the empty cases: a live quick-match pad, and an ordinary pad on a cancelled match, arm no clock and offer no Check again", async () => {
    stubDom("visible");
    server.status = "in_play";
    const live = renderIsland(DeviceScorePad, padProps("in_play", [START], true, null));
    server.status = "cancelled";
    const ordinary = renderIsland(DeviceScorePad, padProps("cancelled", [START], false, "cancelled"));
    expect(textOf(byTestId(ordinary.tree(), "scan-view-only")), "the ordinary pad is on View-only").toBe(
      dict["device.scan.viewOnly.cancelled"],
    );
    await tick(3 * NOT_PLAYED_RECHECK_MS);
    expect(reads(), "nothing reads the match on a clock").toBe(0);
    expect(checkAgain(live.tree()), "a live pad has nothing to check").toBeUndefined();
    expect(checkAgain(ordinary.tree()), "an organiser's match has no Put back to wait for").toBeUndefined();
  });

  it("opened on Not played: the clock reads it every NOT_PLAYED_RECHECK_MS; a Put back it finds lifts View-only onto the pad, seeded from that read at the stored score; then the clock stops", async () => {
    stubDom("visible");
    server.ledger = [START, RALLY];
    const island = renderIsland(DeviceScorePad, openedNotPlayed([START, RALLY]));
    expect(textOf(byTestId(island.tree(), "scan-view-only"))).toBe(dict["device.quickMatch.notPlayed"]);
    expect(textOf(checkAgain(island.tree()))).toBe(dict["device.quickMatch.checkAgain"]);
    expect(island.tree().find((e) => e.type === ScorePad), "precondition: no pad on View-only").toBeUndefined();

    await tick(NOT_PLAYED_RECHECK_MS - 1);
    expect(reads(), "not before the interval").toBe(0);
    await tick(1);
    expect(reads(), "one read at the interval").toBe(1);
    expect(textOf(byTestId(island.tree(), "scan-view-only")), "still Not played: still View-only").toBe(
      dict["device.quickMatch.notPlayed"],
    );

    // Put back on another phone: live again at its score (plan Q1).
    server.status = "in_play";
    server.headline = "1 — 0";
    await tick(NOT_PLAYED_RECHECK_MS);
    expect(reads()).toBe(2);
    expect(byTestId(island.tree(), "scan-view-only"), "the read that found it put back lifts View-only").toBeUndefined();
    expect(checkAgain(island.tree())).toBeUndefined();
    // The page loaded the pad's bootstrap while the match was Not played; the pad mounts on THIS read's ledger, or it would
    // open at a score the match no longer has and send its first tap at a stale seq.
    expect(seedOf(island.tree())).toEqual([
      ["core.start", 1],
      ["generic.result", 2],
    ]);
    expect(textOf(island.tree().find((e) => e.type === "header")), "the header at the stored score").toContain("1 — 0");

    await tick(3 * NOT_PLAYED_RECHECK_MS);
    expect(reads(), "live again: the clock is gone").toBe(2);
  });

  it("put back unplayed: the read lifts View-only onto Confirm, with Start", async () => {
    stubDom("visible");
    const island = renderIsland(DeviceScorePad, openedNotPlayed([]));
    expect(byTestId(island.tree(), "scan-confirm"), "precondition: no Confirm on View-only").toBeUndefined();
    server.status = "scheduled";
    await tick(NOT_PLAYED_RECHECK_MS);
    expect(reads()).toBe(1);
    expect(byTestId(island.tree(), "scan-view-only")).toBeUndefined();
    expect(byTestId(island.tree(), "score-start-match"), "Confirm offers Start again").toBeDefined();
  });

  it("skipped behind a live pad (no View-only from the page): the clock starts with the Not played screen and its Put back lifts it, seeded fresh", async () => {
    stubDom("visible");
    server.status = "in_play";
    server.ledger = [START];
    const island = renderIsland(DeviceScorePad, padProps("in_play", [START], true, null));
    const pad = island.tree().find((e) => e.type === ScorePad);
    expect(pad, "precondition: live, the pad is up").toBeDefined();
    // The home skips it; the pad's next tap re-reads (T3).
    server.status = "cancelled";
    (propsOf(pad!).onEvents as () => void)();
    await flush();
    expect(textOf(byTestId(island.tree(), "scan-view-only"))).toBe(dict["device.quickMatch.notPlayed"]);
    expect(reads()).toBe(1);
    // A rally landed before the skip; Put back keeps it.
    server.status = "in_play";
    server.ledger = [START, RALLY];
    await tick(NOT_PLAYED_RECHECK_MS);
    expect(reads()).toBe(2);
    expect(byTestId(island.tree(), "scan-view-only")).toBeUndefined();
    expect(seedOf(island.tree()), "not the seed taken at the first Start").toEqual([
      ["core.start", 1],
      ["generic.result", 2],
    ]);
  });

  it("a hidden tab arms no clock; hiding stops it; showing it again reads at once and re-arms it", async () => {
    const { doc } = stubDom("hidden");
    const island = renderIsland(DeviceScorePad, openedNotPlayed([]));
    await tick(3 * NOT_PLAYED_RECHECK_MS);
    expect(reads(), "mounted hidden: no read on a clock").toBe(0);

    doc.visibilityState = "visible";
    fire(doc, "visibilitychange");
    await flush();
    expect(reads(), "the return reads at once").toBe(1);
    await tick(NOT_PLAYED_RECHECK_MS);
    expect(reads(), "and the clock is armed").toBe(2);

    doc.visibilityState = "hidden";
    fire(doc, "visibilitychange");
    await tick(3 * NOT_PLAYED_RECHECK_MS);
    expect(reads(), "hidden: the clock stopped").toBe(2);
    expect(textOf(byTestId(island.tree(), "scan-view-only"))).toBe(dict["device.quickMatch.notPlayed"]);
  });

  it.each([
    ["a visibility change to visible", "doc", "visibilitychange"],
    ["a window focus", "win", "focus"],
  ] as const)("%s reads it at once, and a Put back it finds lifts View-only", async (_, target, type) => {
    const dom = stubDom("visible");
    server.ledger = [START, RALLY];
    const island = renderIsland(DeviceScorePad, openedNotPlayed([START, RALLY]));
    server.status = "in_play";
    fire(dom[target], type);
    await flush();
    expect(reads(), "one read, before any interval").toBe(1);
    expect(byTestId(island.tree(), "scan-view-only")).toBeUndefined();
    expect(seedOf(island.tree())).toEqual([
      ["core.start", 1],
      ["generic.result", 2],
    ]);
  });

  it("Check again reads it on tap: still Not played stays View-only; put back, it lifts", async () => {
    stubDom("visible");
    server.ledger = [START, RALLY];
    const island = renderIsland(DeviceScorePad, openedNotPlayed([START, RALLY]));
    const button = checkAgain(island.tree());
    expect(propsOf(button!).type).toBe("button");
    expect(propsOf(button!).disabled, "at rest the button is live").toBe(false);
    (propsOf(button!).onClick as () => void)();
    await flush();
    expect(reads(), "the tap read the match").toBe(1);
    expect(textOf(byTestId(island.tree(), "scan-view-only")), "still Not played").toBe(dict["device.quickMatch.notPlayed"]);

    server.status = "in_play";
    (propsOf(checkAgain(island.tree())!).onClick as () => void)();
    await flush();
    expect(reads()).toBe(2);
    expect(byTestId(island.tree(), "scan-view-only"), "put back: lifted on the tap").toBeUndefined();
    expect(seedOf(island.tree())).toEqual([
      ["core.start", 1],
      ["generic.result", 2],
    ]);
  });

  it("one read at a time: while a read hangs, Check again is greyed and neither a second tap nor the clock adds one; the read's own budget frees it", async () => {
    stubDom("visible");
    const island = renderIsland(DeviceScorePad, openedNotPlayed([]));
    await tick(NOT_PLAYED_RECHECK_MS / 2);
    server.hang = true;
    (propsOf(checkAgain(island.tree())!).onClick as () => void)();
    await flush();
    expect(reads()).toBe(1);
    expect(propsOf(checkAgain(island.tree())!).disabled, "greyed while it reads").toBe(true);
    (propsOf(checkAgain(island.tree())!).onClick as () => void)();
    await tick(NOT_PLAYED_RECHECK_MS / 2); // the clock's tick lands while the read still hangs
    expect(reads(), "no second read while one is in flight").toBe(1);
    // The read is bounded like every opportunistic refresh (`OPPORTUNISTIC_RESYNC_MS`): past it, the button is live again.
    server.hang = false;
    await tick(OPPORTUNISTIC_RESYNC_MS - NOT_PLAYED_RECHECK_MS / 2);
    expect(propsOf(checkAgain(island.tree())!).disabled, "freed at its budget").toBe(false);
    await tick(NOT_PLAYED_RECHECK_MS);
    expect(reads(), "and the clock reads again").toBeGreaterThan(1);
  });

  it("unmounting stops the clock and removes its listener", async () => {
    const { doc } = stubDom("visible");
    const island = renderIsland(DeviceScorePad, openedNotPlayed([]));
    expect((doc.listeners.visibilitychange ?? []).length, "the tab return's and the clock's").toBe(2);
    island.unmount();
    expect((doc.listeners.visibilitychange ?? []).length).toBe(0);
    await tick(3 * NOT_PLAYED_RECHECK_MS);
    expect(reads(), "nothing reads after unmount").toBe(0);
  });

  it("a dead link found by the clock lands on the dead screen, and the clock stops", async () => {
    stubDom("visible");
    const island = renderIsland(DeviceScorePad, openedNotPlayed([]));
    server.refuse = "LINK_EXPIRED";
    await tick(NOT_PLAYED_RECHECK_MS);
    expect(reads()).toBe(1);
    expect(byTestId(island.tree(), "scan-dead-link")).toBeDefined();
    await tick(3 * NOT_PLAYED_RECHECK_MS);
    expect(reads(), "a dead link is never asked again").toBe(1);
  });
});

describe("DeviceScorePad — the header pill on a Not played match (FR3, T5 finding 2)", () => {
  it("a quick match's pill says Not played, never cancelled; an ordinary pad's says cancelled", () => {
    const quick = renderIsland(DeviceScorePad, openedNotPlayed([]));
    expect(pill(quick.tree())).toBe(dict["quickMatch.home.notPlayed"]);
    expect(pill(quick.tree())).not.toBe(dict["score.status.cancelled"]);
    const ordinary = renderIsland(DeviceScorePad, padProps("cancelled", [], false, "cancelled"));
    expect(pill(ordinary.tree())).toBe(dict["score.status.cancelled"]);
    expect(dict["quickMatch.home.notPlayed"], "the pair can tell them apart").not.toBe(dict["score.status.cancelled"]);
  });

  it("on a quick match only cancelled changes words: finalized and scheduled keep the ordinary pill", () => {
    const rows = [
      ["finalized", "finalized" as const],
      ["scheduled", null],
    ] as const;
    let checked = 0;
    for (const [status, viewOnly] of rows) {
      const quick = renderIsland(DeviceScorePad, padProps(status, [], true, viewOnly));
      expect(pill(quick.tree()), status).toBe(dict[`score.status.${status}`]);
      checked++;
    }
    expect(checked, "rows checked").toBe(rows.length);
  });
});

// FR4 m2 (whole-branch review m2, controller PO rec 2026-11-13): once the league is finished no Put back can come (§6 hides
// it; the server refuses a stale one, LEAGUE_FINISHED), so the Not played screen stops reading the match on its clock and on
// a tab return, and its line drops the Put back hint. `/state` says so (`quick_match_finished`, present on a quick match's
// Not played match only). "Check again" stays: an Add a match on the home un-finishes the league, and a read that sees it
// brings the hint and the clock back. FR4 m4: every re-read of the Not played screen, the tab return's included, is one at
// a time.
describe("DeviceScorePad — Not played on a finished league (FR4 m2) and one re-read at a time (FR4 m4)", () => {
  /** Opened on Not played, the page's `/state` saying whether the league has finished. */
  const openedIn = (finished: boolean, ledger: PadEventIn[] = []) => {
    const props = openedNotPlayed(ledger);
    return { ...props, initialState: { ...props.initialState, quick_match_finished: finished } };
  };
  const listening = (dom: ReturnType<typeof stubDom>) =>
    (dom.doc.listeners.visibilitychange ?? []).length + (dom.win.listeners.focus ?? []).length;

  it("the words: the finished line says the match was not played and offers no Put back, in every locale's own key", () => {
    expect(dict["device.quickMatch.notPlayedFinal"]).toBe("This match was not played.");
    expect(dict["device.quickMatch.notPlayedFinal"]).not.toBe(dict["device.quickMatch.notPlayed"]);
    expect(dict["device.quickMatch.notPlayed"], "the open league's line keeps its hint").toContain("Put it back");
    expect(dict["device.quickMatch.notPlayedFinal"]).not.toMatch(/put/i);
  });

  it("opened on a finished league: the final line, no clock, no tab-return read and no listener; Check again still reads", async () => {
    const dom = stubDom("visible");
    server.finished = true;
    const island = renderIsland(DeviceScorePad, openedIn(true));
    expect(textOf(byTestId(island.tree(), "scan-view-only"))).toBe(dict["device.quickMatch.notPlayedFinal"]);
    expect(pill(island.tree()), "still the home's word").toBe(dict["quickMatch.home.notPlayed"]);
    expect(listening(dom), "neither the tab return nor the clock listens").toBe(0);
    await tick(3 * NOT_PLAYED_RECHECK_MS);
    fire(dom.doc, "visibilitychange");
    fire(dom.win, "focus");
    await flush();
    expect(reads(), "no clock, no tab-return read").toBe(0);
    (propsOf(checkAgain(island.tree())!).onClick as () => void)();
    await flush();
    expect(reads(), "Check again is a tap, not a poll: it reads").toBe(1);
    expect(textOf(byTestId(island.tree(), "scan-view-only")), "still finished").toBe(dict["device.quickMatch.notPlayedFinal"]);
    await tick(3 * NOT_PLAYED_RECHECK_MS);
    expect(reads(), "and arms nothing").toBe(1);
  });

  it("the league finishes while the screen shows Not played: the read that sees it stops the clock and the tab return, and drops the hint", async () => {
    const dom = stubDom("visible");
    server.finished = false;
    const island = renderIsland(DeviceScorePad, openedIn(false));
    expect(textOf(byTestId(island.tree(), "scan-view-only"))).toBe(dict["device.quickMatch.notPlayed"]);
    expect(listening(dom), "precondition: the tab return (2) and the clock (1) listen").toBe(3);
    await tick(NOT_PLAYED_RECHECK_MS);
    expect(reads()).toBe(1);
    // The last open match is skipped on the home.
    server.finished = true;
    await tick(NOT_PLAYED_RECHECK_MS);
    expect(reads()).toBe(2);
    expect(textOf(byTestId(island.tree(), "scan-view-only"))).toBe(dict["device.quickMatch.notPlayedFinal"]);
    expect(listening(dom), "both stopped").toBe(0);
    await tick(3 * NOT_PLAYED_RECHECK_MS);
    fire(dom.win, "focus");
    await flush();
    expect(reads(), "nothing reads it again on its own").toBe(2);
  });

  it("an Add a match un-finishes it: Check again sees it, and the hint, the clock and the tab return come back", async () => {
    const dom = stubDom("visible");
    server.finished = true;
    const island = renderIsland(DeviceScorePad, openedIn(true));
    server.finished = false;
    (propsOf(checkAgain(island.tree())!).onClick as () => void)();
    await flush();
    expect(reads()).toBe(1);
    expect(textOf(byTestId(island.tree(), "scan-view-only"))).toBe(dict["device.quickMatch.notPlayed"]);
    expect(listening(dom)).toBe(3);
    await tick(NOT_PLAYED_RECHECK_MS);
    expect(reads(), "the clock again").toBe(2);
    fire(dom.win, "focus");
    await flush();
    expect(reads(), "the tab return again").toBe(3);
  });

  it.each([
    ["a visibility change to visible", "doc", "visibilitychange"],
    ["a window focus", "win", "focus"],
  ] as const)("m4: %s while a Not played read is out adds none; once it is answered, the return reads", async (_, target, type) => {
    const dom = stubDom("visible");
    const island = renderIsland(DeviceScorePad, openedIn(false));
    server.hang = true;
    (propsOf(checkAgain(island.tree())!).onClick as () => void)();
    await flush();
    expect(reads(), "Check again's read is out").toBe(1);
    fire(dom[target], type);
    await flush();
    expect(reads(), "the tab return waits for the read in flight").toBe(1);
    // The network answers (well inside the clock's interval: no tick has run).
    server.hang = false;
    for (const answer of server.held.splice(0)) answer();
    await flush();
    expect(propsOf(checkAgain(island.tree())!).disabled, "answered: the button is live again").toBe(false);
    expect(reads(), "nothing more while it was out").toBe(1);
    fire(dom[target], type);
    await flush();
    expect(reads(), "answered: the return reads").toBe(2);
  });

  it("the empty cases keep their tab return: a live quick-match pad, and an organiser's cancelled pad whatever the body says", async () => {
    const dom = stubDom("visible");
    server.status = "in_play";
    server.ledger = [START];
    const live = renderIsland(DeviceScorePad, padProps("in_play", [START], true, null));
    fire(dom.win, "focus");
    await flush();
    expect(reads(), "a live quick-match pad reads on a return").toBe(1);
    live.unmount();
    server.status = "cancelled";
    server.finished = true; // never sent for an organiser's match; even so, it changes nothing there
    const ordinary = padProps("cancelled", [START], false, "cancelled");
    const island = renderIsland(DeviceScorePad, { ...ordinary, initialState: { ...ordinary.initialState, quick_match_finished: true } });
    expect(textOf(byTestId(island.tree(), "scan-view-only")), "an organiser's line").toBe(dict["device.scan.viewOnly.cancelled"]);
    expect(checkAgain(island.tree())).toBeUndefined();
    expect(listening(dom), "the organiser's tab return listens (2), no clock").toBe(2);
    fire(dom.win, "focus");
    await flush();
    expect(reads(), "the organiser's pad reads on a return, as it always did").toBe(2);
  });
});
