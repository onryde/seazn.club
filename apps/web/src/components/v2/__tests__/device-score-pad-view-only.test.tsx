// Scorer sheets §4.5 — the chrome's two ways into View-only. The INNER pad's
// way (pipeline → registry → this callback) is only proven end to end by
// e2e/walkthrough/device-pad-carried-forward.spec.ts; this file pins the
// chrome's half: the prop it hands down, and its own send() path.
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ReactElement } from "react";
import en from "@/dictionaries/en/ui.json";
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
        status: "decided",
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
});
