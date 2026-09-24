// Scorer sheets §4.5 — the chrome's two ways into View-only. The INNER pad's
// way (pipeline → registry → this callback) is only proven end to end by
// e2e/walkthrough/device-pad-carried-forward.spec.ts; this file pins the
// chrome's half: the prop it hands down, and its own send() path.
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ReactElement } from "react";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { officialLabelKey } from "@/lib/official-label";
import type { ViewOnlyReason } from "@/lib/scan-screen";
import { DeviceScorePad, type PadEventIn } from "@/components/v2/device-score-pad";
import { ScorePad } from "@/components/v2/scorepad/registry";
import type { SideInfo, SportInfo } from "@/components/v2/fixture-console";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";

const dict = en as Record<string, string>;
const DEVICE_LINK_ID = "dl-1";
const OWN: PadEventIn = {
  id: "ev-own",
  seq: 2,
  type: "generic.result",
  payload: { p1Score: 2, p2Score: 1 },
  recorded_at: "2026-09-23T10:00:00.000Z",
  voids_event_id: null,
  device_link_id: DEVICE_LINK_ID,
};

const api = vi.hoisted(() => ({
  postRefusal: null as null | { code: string; status: number },
  posts: 0,
  stateReads: 0,
  /** What the server's `/state` says once the competition has moved on:
   *  settled, with a score the chrome's stale header has never seen. Hoisted
   *  with the mock: a module-scope const is not yet initialised when the
   *  factory runs. */
  serverFinal: "2 — 1",
  /** The status `/state` answers with — `decided` unless a test finalises or
   *  cancels the match behind the screen. */
  serverStatus: "decided",
}));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: vi.fn((url: string, options?: { method?: string }) => {
      if (options?.method === "POST") {
        api.posts += 1;
        return api.postRefusal
          ? Promise.reject(new actual.ApiV1Error("over", api.postRefusal.status, api.postRefusal.code))
          : Promise.resolve({});
      }
      if (url.includes("/events")) return Promise.resolve([OWN]);
      api.stateReads += 1;
      return Promise.resolve({
        status: api.serverStatus,
        last_seq: 2,
        summary: { headline: api.serverFinal },
        state: {},
        outcome: { kind: "win" },
      });
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

function props(status: string, outcome: unknown) {
  return {
    token: "dl_test",
    deviceLinkId: DEVICE_LINK_ID,
    fixture: { id: "f1", round_no: 1, venue: null, court_label: "Court 2", competition_name: "Cup", division_name: "Open" },
    sport,
    home: side("h", "Nia"),
    away: side("a", "Mira"),
    initialState: { status, last_seq: 2, summary: null, state: {}, outcome },
    initialEvents: [OWN],
    scorePadV2: {
      moduleVersion: "1.0.0",
      resolvedConfig: {},
      initialEvents: [],
      entitlements: {},
      band: 0 as const,
      identity: { recordedBy: null, deviceLinkId: DEVICE_LINK_ID },
    },
  };
}

const byTestId = (tree: ReactElement[], id: string) => tree.find((e) => propsOf(e)["data-testid"] === id);
const textOfTree = (tree: ReactElement[]) => textOf(tree[0]);
/** The LED header — the "final scoreboard" View-only keeps (§4.5.3). */
const headerText = (tree: ReactElement[]) => textOf(tree.find((e) => e.type === "header"));
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
  api.postRefusal = null;
  api.posts = 0;
  api.stateReads = 0;
  api.serverStatus = "decided";
});

describe("DeviceScorePad — View-only (scorer sheets §4.5)", () => {
  it("the chrome's own 'Void my last entry' refused RESULT_CARRIED_FORWARD → View-only, controls gone", async () => {
    api.postRefusal = { code: "RESULT_CARRIED_FORWARD", status: 403 };
    const island = renderIsland(DeviceScorePad, props("decided", { kind: "win" }));
    // Empty case first: a live link opens on its controls, never View-only.
    expect(byTestId(island.tree(), "scan-view-only"), "precondition: not View-only before any refusal").toBeUndefined();
    const voidBtn = byTestId(island.tree(), "device-void-mine");
    expect(voidBtn, "precondition: the link's own result offers its undo").toBeDefined();
    expect(textOfTree(island.tree()), "precondition: the 'result recorded' line shows while the undo is live").toContain(
      dict["device.resultRecorded"],
    );

    (propsOf(voidBtn!).onClick as () => void)();
    await flush();

    expect(api.posts, "the void really went to the server").toBe(1);
    const screen = byTestId(island.tree(), "scan-view-only");
    expect(screen, "the refusal must move the chrome to View-only").toBeDefined();
    expect(textOf(screen), "and say WHY — the carried-forward copy, not another reason's").toBe(
      dict["device.scan.viewOnly.carried"],
    );
    expect(byTestId(island.tree(), "device-void-mine"), "View-only offers no undo").toBeUndefined();
    // "Use 'Void my last'" would now be advice the screen cannot follow.
    expect(textOfTree(island.tree())).not.toContain(dict["device.resultRecorded"]);
    // The header View-only keeps is the FINAL scoreboard, so it is re-read from
    // the server rather than left on whatever this screen last knew.
    expect(api.stateReads, "entering View-only re-reads /state once").toBe(1);
    expect(headerText(island.tree()), "the header shows the server's final score").toContain(api.serverFinal);
  });

  it("an ordinary refusal does NOT switch screens (the negative pair)", async () => {
    api.postRefusal = { code: "FORBIDDEN", status: 403 };
    const island = renderIsland(DeviceScorePad, props("decided", { kind: "win" }));
    (propsOf(byTestId(island.tree(), "device-void-mine")!).onClick as () => void)();
    await flush();
    expect(api.posts).toBe(1);
    expect(byTestId(island.tree(), "scan-view-only")).toBeUndefined();
    expect(byTestId(island.tree(), "device-void-mine"), "the undo stays offered after an ordinary refusal").toBeDefined();
    expect(api.stateReads, "an ordinary refusal re-reads nothing").toBe(0);
    expect(headerText(island.tree())).not.toContain(api.serverFinal);
  });

  // Rebase onto #856 (knockout void un-fill): a second refusal code reaches
  // this same catch. 409 NEXT_MATCH_STARTED — "void the next match first" —
  // is the organiser's to act on, and the umpire stays on the screen, reading
  // why in their own words (#856's copy). It must never be mistaken for the
  // carried-forward refusal and end the surface.
  it("a 409 NEXT_MATCH_STARTED on the chrome's own void stays on the screen with its own words — never View-only", async () => {
    api.postRefusal = { code: "NEXT_MATCH_STARTED", status: 409 };
    const island = renderIsland(DeviceScorePad, props("decided", { kind: "win" }));
    (propsOf(byTestId(island.tree(), "device-void-mine")!).onClick as () => void)();
    await flush();
    expect(api.posts, "the void really went to the server").toBe(1);
    expect(byTestId(island.tree(), "scan-view-only"), "NEXT_MATCH_STARTED is not a chrome-terminal refusal").toBeUndefined();
    expect(byTestId(island.tree(), "device-void-mine"), "the undo stays offered").toBeDefined();
    expect(textOfTree(island.tree()), "the refusal is said in the scorer's words").toContain(
      dict["scorepad.refusal.nextMatchStarted"],
    );
  });

  it("hands the inner pad an onTerminalRefusal that switches to View-only and unmounts the pad", async () => {
    const island = renderIsland(DeviceScorePad, props("in_play", null));
    const pad = island.tree().find((e) => e.type === ScorePad);
    expect(pad, "precondition: the inner pad is mounted in play").toBeDefined();
    expect(byTestId(island.tree(), "scan-view-only")).toBeUndefined();
    expect(headerText(island.tree()), "precondition: a live pad's header reads Live").toContain(dict["device.live"]);
    const cb = propsOf(pad!).onTerminalRefusal as ((r: { code: string; message: string }) => void) | undefined;
    expect(cb, "the seam: DeviceScorePad must hand the pad this callback").toBeTypeOf("function");
    cb!({ code: "RESULT_CARRIED_FORWARD", message: "" });
    const screen = byTestId(island.tree(), "scan-view-only");
    expect(screen).toBeDefined();
    expect(textOf(screen)).toBe(dict["device.scan.viewOnly.carried"]);
    expect(island.tree().find((e) => e.type === ScorePad), "View-only leaves no pad to tap").toBeUndefined();
    expect(byTestId(island.tree(), "device-void-mine"), "…and no chrome undo either").toBeUndefined();

    // Nothing told this chrome the match ended — that is how its pad came to
    // tap at all — so its header still says Live. View-only's "final
    // scoreboard" must not: it re-reads the server's settled state.
    await flush();
    expect(api.stateReads, "entering View-only re-reads /state once").toBe(1);
    const header = headerText(island.tree());
    expect(header, "no Live pill above 'Match over'").not.toContain(dict["device.live"]);
    expect(header).toContain(dict["score.status.decided"]);
    expect(header, "the header shows the server's final score").toContain(api.serverFinal);
  });

  it("initialViewOnly renders View-only from the first paint, with that reason's copy", () => {
    const island = renderIsland(DeviceScorePad, {
      ...props("finalized", { kind: "win" }),
      initialViewOnly: "finalized" as const,
    });
    const screen = byTestId(island.tree(), "scan-view-only");
    expect(screen).toBeDefined();
    // The reason decides the words: a finalized match must not read "carried forward".
    expect(textOf(screen)).toBe(dict["device.scan.viewOnly.finalized"]);
    expect(dict["device.scan.viewOnly.finalized"]).not.toBe(dict["device.scan.viewOnly.carried"]);
  });

  it("the pad chrome registers no interval of its own (Waiting's poll must not leak into it)", async () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      const island = renderIsland(DeviceScorePad, props("in_play", null));
      await flush(); // effects run: a mount-time setInterval would be recorded here
      island.rerender(props("in_play", null));
      await flush();
      expect(spy.mock.calls.map((c) => c[1]), "DeviceScorePad must not poll: the stream owns freshness").toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("initialViewOnly on an in-play fixture still mounts no pad and no controls", () => {
    // The differential for the first-paint gate: in play, with no View-only,
    // the pad and the undo are both there (test above); with it, neither is.
    const island = renderIsland(DeviceScorePad, {
      ...props("in_play", null),
      initialViewOnly: "carried_forward" as const,
    });
    expect(byTestId(island.tree(), "scan-view-only")).toBeDefined();
    expect(island.tree().find((e) => e.type === ScorePad)).toBeUndefined();
    expect(byTestId(island.tree(), "device-void-mine")).toBeUndefined();
  });
});

describe("DeviceScorePad — Confirm (scorer sheets §4.5.1)", () => {
  // Owner ruling (naming, #851/#854): the scorebug names the round the way the
  // board does. The page resolves that label (`scanMatchNames`); the chrome
  // prints what it is handed, on Confirm and View-only alike.
  it("the scorebug prints the round label it was handed, never its own 'Round N'", () => {
    const roundN = dict["schedule.round"]!.replace("{n}", "1");
    for (const [status, viewOnly] of [["scheduled", null], ["decided", "carried_forward"]] as const) {
      const text = renderIsland(DeviceScorePad, {
        ...props(status, null),
        initialEvents: [],
        initialViewOnly: viewOnly,
        fixture: { ...props(status, null).fixture, round_label: "«board round»" },
      }).text();
      expect(text, `${status}: the handed label, after the division`).toMatch(/Open\s+·\s+«board round»/);
      expect(text, `${status}: not the round number`).not.toContain(roundN);
    }
  });

  // At 320 the scorebug's first line truncated as ONE span, so the round — the
  // part the ruling is about — was the first thing cut ("SCAN CUP … · FI…").
  // The round is its own element that never shrinks or wraps; the division
  // beside it is what gives way.
  it("the round label never gives way to the division: its own element, which does not shrink", () => {
    const tree = renderIsland(DeviceScorePad, {
      ...props("scheduled", null),
      initialEvents: [],
      fixture: { ...props("scheduled", null).fixture, division_name: "A very long division name indeed", round_label: "Final" },
    }).tree();
    const round = byTestId(tree, "scan-scorebug-round");
    expect(round, "the round has its own element").toBeDefined();
    expect(textOf(round!)).toMatch(/·\s*Final$/);
    const cls = (round!.props as { className?: string }).className ?? "";
    expect(cls, "it never shrinks").toMatch(/\bshrink-0\b/);
    expect(cls, "it never truncates").not.toMatch(/\btruncate\b/);
    const division = byTestId(tree, "scan-scorebug-division");
    expect(division, "the division is its own element").toBeDefined();
    expect(textOf(division!)).toBe("A very long division name indeed");
    expect((division!.props as { className?: string }).className ?? "", "the division is what truncates").toMatch(
      /\bmin-w-0\b.*\btruncate\b|\btruncate\b.*\bmin-w-0\b/,
    );
  });

  it("scheduled with both sides: the Confirm card with Start, and NO inner pad yet", () => {
    const island = renderIsland(DeviceScorePad, {
      ...props("scheduled", null),
      initialEvents: [],
      fixture: { ...props("scheduled", null).fixture, match_ref: "R1·3", scheduled_label: "Wed 23 Sep, 10:30" },
    });
    const card = byTestId(island.tree(), "scan-confirm");
    expect(card).toBeDefined();
    expect(textOf(card), "the card names the match").toContain("R1·3");
    expect(textOf(card), "and its time").toContain("Wed 23 Sep, 10:30");
    expect(textOf(card), "and its court").toContain("Court 2");
    expect(textOf(card), "and both sides, for the umpire to check").toContain("Nia");
    expect(textOf(card)).toContain("Mira");
    expect(textOf(card)).toContain(dict["device.scan.confirmTitle"]);
    const start = byTestId(island.tree(), "score-start-match");
    expect(start, "Start lives on the Confirm card").toBeDefined();
    expect(textOf(byTestId(walk(card!), "score-start-match")), "…inside it, not beside it").toBe(dict["score.startMatch"]);
    expect(island.tree().find((e) => e.type === ScorePad)).toBeUndefined();
  });

  it("in play: no Confirm card — the pad", () => {
    const island = renderIsland(DeviceScorePad, props("in_play", null));
    expect(byTestId(island.tree(), "scan-confirm")).toBeUndefined();
    expect(byTestId(island.tree(), "score-start-match")).toBeUndefined();
    expect(island.tree().find((e) => e.type === ScorePad)).toBeDefined();
  });

  it("Start match sends core.start, then mounts the pad SEEDED with the post-start ledger", async () => {
    const island = renderIsland(DeviceScorePad, { ...props("scheduled", null), initialEvents: [] });
    const { apiV1 } = await import("@/lib/client-v1");
    // Restore the file-level mock afterwards: vitest.config.ts has no
    // mockReset/restoreMocks, so a replaced implementation would leak into
    // every later test in this file (pre-flight A18).
    const original = vi.mocked(apiV1).getMockImplementation()!;
    onTestFinished(() => void vi.mocked(apiV1).mockImplementation(original));
    const started = {
      id: "ev-start",
      seq: 1,
      type: "core.start",
      payload: {},
      recorded_at: "2026-09-23T10:31:00.000Z",
      voids_event_id: null,
      device_link_id: DEVICE_LINK_ID,
      recorded_by: "u1",
    };
    const posted: unknown[] = [];
    vi.mocked(apiV1).mockImplementation(((url: string, options?: { method?: string; json?: unknown }) => {
      if (options?.method === "POST") {
        posted.push(options.json);
        return Promise.resolve({});
      }
      if (url.includes("/events")) return Promise.resolve([started]);
      return Promise.resolve({ status: "in_play", last_seq: 1, summary: null, state: {}, outcome: null });
    }) as typeof apiV1);
    // Empty case first: the pad is not there before Start.
    expect(island.tree().find((e) => e.type === ScorePad)).toBeUndefined();
    (propsOf(byTestId(island.tree(), "score-start-match")!).onClick as () => void)();
    await flush();
    expect(posted.map((p) => (p as { type: string }).type), "Start posts exactly one core.start").toEqual(["core.start"]);
    const pad = island.tree().find((e) => e.type === ScorePad);
    expect(pad, "the pad mounts once the match is started").toBeDefined();
    expect(byTestId(island.tree(), "scan-confirm"), "Confirm is gone once started").toBeUndefined();
    const seeded = propsOf(pad!).initialEvents as { type: string; seq: number; recordedBy: string | null }[];
    // Not the page's pre-start bootstrap (`scorePadV2.initialEvents`, empty
    // here): the pad's stream does not read on mount, so a pad opened on the
    // bootstrap would send its first tap at a stale seq (P8).
    expect(seeded.map((e) => [e.type, e.seq, e.recordedBy])).toEqual([["core.start", 1, "u1"]]);
  });

  // Task 6 review I1: the test above is only ONE way into "started". Every
  // other way — another device's Start seen on a tab return, this phone's Start
  // refused SEQ_CONFLICT because another device got there first, a second tap
  // after a Start whose re-read failed — used to mount the pad on the page's
  // PRE-start bootstrap (empty here), the P8 hazard: its stream does not read on
  // mount, so its first tap goes out at a stale seq for up to POLL_MS.
  describe("every way into 'started' seeds the pad from the read that saw it (review I1)", () => {
    /** Another device's Start: a different link and a different human, so a
     *  seed from it cannot be confused with a local fabrication. */
    const OTHER_START = {
      id: "ev-start-other",
      seq: 1,
      type: "core.start",
      payload: {},
      recorded_at: "2026-09-23T10:31:00.000Z",
      voids_event_id: null,
      device_link_id: "dl-other",
      recorded_by: "u-other",
    };
    type Server = {
      status: string;
      ledger: unknown[];
      /** What each POST does, in order; past the end, resolve. */
      posts: (() => Promise<unknown>)[];
      /** Fail the next N reads with a dropped connection. */
      failReads: number;
      posted: string[];
    };
    /** A fake server behind `apiV1`, restored after the test. */
    async function serve(server: Server) {
      const { apiV1, ApiV1Error } = await import("@/lib/client-v1");
      const original = vi.mocked(apiV1).getMockImplementation()!;
      onTestFinished(() => void vi.mocked(apiV1).mockImplementation(original));
      vi.mocked(apiV1).mockImplementation(((url: string, options?: { method?: string; json?: { type: string } }) => {
        if (options?.method === "POST") {
          server.posted.push(options.json!.type);
          const next = server.posts.shift();
          return next ? next() : Promise.resolve({});
        }
        if (server.failReads > 0) {
          server.failReads -= 1;
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        if (url.includes("/events")) return Promise.resolve(server.ledger);
        return Promise.resolve({ status: server.status, last_seq: server.ledger.length, summary: null, state: {}, outcome: null });
      }) as typeof apiV1);
      return ApiV1Error;
    }
    const seedOf = (tree: ReactElement[]) => {
      const pad = tree.find((e) => e.type === ScorePad);
      expect(pad, "the pad mounts once the match reads as started").toBeDefined();
      return (propsOf(pad!).initialEvents as { type: string; seq: number; recordedBy: string | null }[]).map(
        (e) => [e.type, e.seq, e.recordedBy],
      );
    };
    const scheduled = () => ({ ...props("scheduled", null), initialState: { status: "scheduled", last_seq: 0, summary: null, state: {}, outcome: null }, initialEvents: [] });

    it("a tab return that first sees ANOTHER device's Start mounts the pad on that read's ledger", async () => {
      const doc = { ...tabTarget(), visibilityState: "visible" as DocumentVisibilityState };
      const win = tabTarget();
      vi.stubGlobal("document", doc);
      vi.stubGlobal("window", win);
      onTestFinished(() => void vi.unstubAllGlobals());
      const server: Server = { status: "scheduled", ledger: [], posts: [], failReads: 0, posted: [] };
      await serve(server);
      const island = renderIsland(DeviceScorePad, scheduled());
      await flush();
      expect(byTestId(island.tree(), "scan-confirm"), "precondition: Confirm, no pad").toBeDefined();
      // The other device starts the match; this phone taps nothing.
      server.status = "in_play";
      server.ledger = [OTHER_START];
      for (const fn of [...(win.listeners.focus ?? [])]) fn();
      await flush();
      expect(server.posted, "this phone sent nothing").toEqual([]);
      expect(seedOf(island.tree())).toEqual([["core.start", 1, "u-other"]]);
    });

    it("Start refused SEQ_CONFLICT (another device started first): the conflict's re-read seeds the pad", async () => {
      const server: Server = { status: "scheduled", ledger: [], posts: [], failReads: 0, posted: [] };
      const ApiV1Error = await serve(server);
      server.posts = [
        () => {
          // The other device's Start landed first; this one's expected_seq is stale.
          server.status = "in_play";
          server.ledger = [OTHER_START];
          return Promise.reject(new ApiV1Error("stale", 409, "SEQ_CONFLICT"));
        },
      ];
      const island = renderIsland(DeviceScorePad, scheduled());
      (propsOf(byTestId(island.tree(), "score-start-match")!).onClick as () => void)();
      await flush();
      expect(server.posted).toEqual(["core.start"]);
      expect(seedOf(island.tree())).toEqual([["core.start", 1, "u-other"]]);
    });

    it("a Start that landed but whose re-read failed: the second tap's re-read seeds the pad", async () => {
      const server: Server = { status: "scheduled", ledger: [], posts: [], failReads: 0, posted: [] };
      const ApiV1Error = await serve(server);
      const OWN_START = { ...OTHER_START, id: "ev-start-own", device_link_id: DEVICE_LINK_ID, recorded_by: "u1" };
      server.posts = [
        () => {
          server.status = "in_play";
          server.ledger = [OWN_START];
          server.failReads = 2; // the re-read's /state and /events both drop
          return Promise.resolve({});
        },
        // The second tap still carries expected_seq 0: the server's tip is 1.
        () => Promise.reject(new ApiV1Error("stale", 409, "SEQ_CONFLICT")),
      ];
      const island = renderIsland(DeviceScorePad, scheduled());
      (propsOf(byTestId(island.tree(), "score-start-match")!).onClick as () => void)();
      await flush();
      expect(byTestId(island.tree(), "scan-confirm"), "the failed re-read left the phone on Confirm").toBeDefined();
      (propsOf(byTestId(island.tree(), "score-start-match")!).onClick as () => void)();
      await flush();
      expect(server.posted).toEqual(["core.start", "core.start"]);
      expect(seedOf(island.tree())).toEqual([["core.start", 1, "u1"]]);
    });

    it("a double tap on Start sends core.start exactly once (the busy guard)", async () => {
      const server: Server = { status: "scheduled", ledger: [], posts: [], failReads: 0, posted: [] };
      await serve(server);
      let land: () => void = () => {};
      server.posts = [
        () =>
          new Promise((resolve) => {
            land = () => {
              server.status = "in_play";
              server.ledger = [{ ...OTHER_START, device_link_id: DEVICE_LINK_ID, recorded_by: "u1" }];
              resolve({});
            };
          }),
      ];
      const island = renderIsland(DeviceScorePad, scheduled());
      /** A tap as the browser delivers it: a disabled button fires nothing. */
      const tap = () => {
        const start = propsOf(byTestId(island.tree(), "score-start-match")!);
        if (!start.disabled) (start.onClick as () => void)();
      };
      tap();
      tap(); // the second tap lands while the first POST is still in flight
      land();
      await flush();
      expect(server.posted, "exactly one core.start for two taps").toEqual(["core.start"]);
    });

    // Task 6 review round 2 (item 4): `/state` and the ledger are two
    // CONCURRENT reads, so the ledger's can be answered before a Start that
    // `/state` then sees. `/state` says started, the ledger holds nothing, and
    // the pad would mount on that empty ledger — the P8 hazard again, by a
    // different door. The ledger is re-read until it reaches `/state`'s tip.
    /** A server whose ledger reads answer from `ledgers` in turn (the last
     *  one repeats) while `/state` already reports the match at `lastSeq`. */
    async function serveLaggingLedger(ledgers: unknown[][], lastSeq = 1, status = "in_play") {
      const { apiV1 } = await import("@/lib/client-v1");
      const original = vi.mocked(apiV1).getMockImplementation()!;
      onTestFinished(() => void vi.mocked(apiV1).mockImplementation(original));
      const reads = { events: 0, state: 0 };
      vi.mocked(apiV1).mockImplementation(((url: string, options?: { method?: string }) => {
        if (options?.method === "POST") return Promise.resolve({});
        if (url.includes("/events")) {
          reads.events += 1;
          return Promise.resolve(ledgers[Math.min(reads.events, ledgers.length) - 1]);
        }
        reads.state += 1;
        return Promise.resolve({ status, last_seq: lastSeq, summary: null, state: {}, outcome: null });
      }) as typeof apiV1);
      return reads;
    }
    const OWN_START = { ...OTHER_START, id: "ev-start-own", device_link_id: DEVICE_LINK_ID, recorded_by: "u1" };

    it("a ledger read answered BEFORE the Start /state saw is re-read: the pad never mounts without core.start", async () => {
      const reads = await serveLaggingLedger([[], [OWN_START]]);
      const island = renderIsland(DeviceScorePad, scheduled());
      (propsOf(byTestId(island.tree(), "score-start-match")!).onClick as () => void)();
      await flush();
      expect(reads.events, "the lagging ledger was read again").toBe(2);
      expect(reads.state, "…and /state only once: the ledger is what was behind").toBe(1);
      expect(seedOf(island.tree())).toEqual([["core.start", 1, "u1"]]);
    });

    // The ledger's tip is its LAST row, not its first: a read that already
    // holds the Start but not the point `/state` saw after it is still behind.
    it("a ledger one event short of /state's tip is re-read too: the tip is the LAST row", async () => {
      const POINT = { ...OWN_START, id: "ev-point", seq: 2, type: "generic.result", payload: { p1Score: 1, p2Score: 0 } };
      const reads = await serveLaggingLedger([[OWN_START], [OWN_START, POINT]], 2);
      const island = renderIsland(DeviceScorePad, scheduled());
      (propsOf(byTestId(island.tree(), "score-start-match")!).onClick as () => void)();
      await flush();
      expect(reads.events).toBe(2);
      expect(seedOf(island.tree())).toEqual([
        ["core.start", 1, "u1"],
        ["generic.result", 2, "u1"],
      ]);
    });

    it("a ledger that never catches up is re-read a BOUNDED number of times and seeds nothing", async () => {
      const reads = await serveLaggingLedger([[]]);
      const island = renderIsland(DeviceScorePad, scheduled());
      (propsOf(byTestId(island.tree(), "score-start-match")!).onClick as () => void)();
      await flush();
      expect(reads.events, "one read, then LEDGER_CATCHUP_READS re-reads, then it gives up").toBe(3);
      expect(island.tree().find((e) => e.type === ScorePad), "no pad on a ledger behind /state").toBeUndefined();
      expect(byTestId(island.tree(), "scan-confirm"), "the phone stays on Confirm").toBeDefined();
      expect(textOfTree(island.tree()), "and says the refresh failed, in the dictionary's words").toContain(
        dict["device.failed"],
      );
    });

    // The empty case: a match with no events is at tip 0 on BOTH reads, so it
    // is caught up — an organiser cancelling an unstarted match must still
    // reach the Confirm phone on its next tab return, on one ledger read.
    it("an empty ledger at /state's tip 0 is caught up: a match cancelled before Start reaches View-only", async () => {
      const doc = { ...tabTarget(), visibilityState: "visible" as DocumentVisibilityState };
      const win = tabTarget();
      vi.stubGlobal("document", doc);
      vi.stubGlobal("window", win);
      onTestFinished(() => void vi.unstubAllGlobals());
      const reads = await serveLaggingLedger([[]], 0, "cancelled");
      const island = renderIsland(DeviceScorePad, scheduled());
      expect(byTestId(island.tree(), "scan-confirm"), "precondition: Confirm").toBeDefined();
      for (const fn of [...(win.listeners.focus ?? [])]) fn();
      await flush();
      expect(reads.events, "one ledger read: nothing to catch up").toBe(1);
      expect(textOf(byTestId(island.tree(), "scan-view-only"))).toBe(dict["device.scan.viewOnly.cancelled"]);
    });
  });
});

/** A recording `EventTarget` stand-in for the tab-return listeners (the same
 *  double the freshness-floor suite uses). */
function tabTarget() {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    listeners,
    addEventListener: (type: string, fn: () => void) => void (listeners[type] ??= []).push(fn),
    removeEventListener: (type: string, fn: () => void) =>
      void (listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn)),
  };
}

// Task 5 review carries: the chrome's own words for the screen it is on.
describe("DeviceScorePad — View-only chrome (scorer sheets §4.5.3)", () => {
  it("the footer names the sport's official from the dictionary, never the engine's English label", () => {
    // A sentinel engine label: if it reaches the screen, the footer is still
    // reading `sport.scorerLabel` (English in every locale).
    const island = renderIsland(DeviceScorePad, {
      ...props("in_play", null),
      sport: { ...sport, key: "badminton", scorerLabel: "Enginelabel" },
    });
    const official = dict[officialLabelKey("badminton")]!;
    expect(official, "precondition: the dictionary's official differs from the generic one").not.toBe(
      dict[officialLabelKey("generic")],
    );
    const header = headerText(island.tree());
    expect(header).toContain(dict["device.courtsideFooter"]!.replace("{scorer}", official.toLowerCase()));
    expect(header.toLowerCase()).not.toContain("enginelabel");
  });

  // Links live until the match is finalised or cancelled since Task 2; the
  // footer used to promise "link active today only" in every locale.
  it.each(Object.entries({ en, es, fr, nl }))("%s: the footer never promises 'today only'", (_locale, d) => {
    const footer = (d as Record<string, string>)["device.courtsideFooter"]!;
    expect(footer).not.toMatch(/\btoday\b|aujourd|\bhoy\b|vandaag/i);
    expect(footer, "the official placeholder is still there").toContain("{scorer}");
  });

  it.each([
    ["finalized", "device.scan.viewOnly.finalized"],
    ["cancelled", "device.scan.viewOnly.cancelled"],
  ] as const)("a match %s behind a live screen lands on View-only with that wording", async (status, key) => {
    const island = renderIsland(DeviceScorePad, props("in_play", null));
    const pad = island.tree().find((e) => e.type === ScorePad);
    // Empty case first: live and in play, no View-only.
    expect(pad, "precondition: the pad is up").toBeDefined();
    expect(byTestId(island.tree(), "scan-view-only")).toBeUndefined();

    // The organiser finalises / cancels elsewhere; the chrome's next re-read
    // (a pad event here — the same path a tab return takes) sees it.
    api.serverStatus = status;
    (propsOf(pad!).onEvents as () => void)();
    await flush();

    const screen = byTestId(island.tree(), "scan-view-only");
    expect(screen, `a ${status} match must explain itself, not just lose its controls`).toBeDefined();
    expect(textOf(screen)).toBe(dict[key]);
    expect(island.tree().find((e) => e.type === ScorePad), "no pad").toBeUndefined();
    expect(byTestId(island.tree(), "device-void-mine"), "no undo").toBeUndefined();
  });

  it("a terminal status outranks a carried-forward refusal's wording (same order as the scan page)", async () => {
    const island = renderIsland(DeviceScorePad, props("in_play", null));
    const pad = island.tree().find((e) => e.type === ScorePad)!;
    api.serverStatus = "finalized";
    (propsOf(pad).onTerminalRefusal as (r: { code: string; message: string }) => void)({
      code: "RESULT_CARRIED_FORWARD",
      message: "",
    });
    await flush();
    expect(textOf(byTestId(island.tree(), "scan-view-only"))).toBe(dict["device.scan.viewOnly.finalized"]);
  });

  it("a later initialViewOnly from the server is honoured, both ways", () => {
    const live = { ...props("in_play", null), initialViewOnly: null as ViewOnlyReason | null };
    const island = renderIsland(DeviceScorePad, live);
    expect(byTestId(island.tree(), "scan-view-only"), "precondition: live").toBeUndefined();

    island.rerender({ ...live, initialViewOnly: "carried_forward" });
    const screen = byTestId(island.tree(), "scan-view-only");
    expect(screen, "the server's newer verdict moves the screen to View-only").toBeDefined();
    expect(textOf(screen)).toBe(dict["device.scan.viewOnly.carried"]);
    expect(island.tree().find((e) => e.type === ScorePad)).toBeUndefined();

    // …and back: an organiser void can lift the carry (#856), and the server
    // then renders the page with no reason at all.
    island.rerender({ ...live, initialViewOnly: null });
    expect(byTestId(island.tree(), "scan-view-only"), "a lifted verdict leaves View-only").toBeUndefined();
    expect(island.tree().find((e) => e.type === ScorePad)).toBeDefined();
  });
});
