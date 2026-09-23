// Scorer sheets §4.5 — the chrome's two ways into View-only. The INNER pad's
// way (pipeline → registry → this callback) is only proven end to end by
// e2e/walkthrough/device-pad-carried-forward.spec.ts; this file pins the
// chrome's half: the prop it hands down, and its own send() path.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import en from "@/dictionaries/en/ui.json";
import { DeviceScorePad, type PadEventIn } from "@/components/v2/device-score-pad";
import { ScorePad } from "@/components/v2/scorepad/registry";
import type { SideInfo, SportInfo } from "@/components/v2/fixture-console";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";

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
