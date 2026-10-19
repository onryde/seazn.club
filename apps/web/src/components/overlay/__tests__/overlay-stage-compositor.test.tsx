// R2005 — the stage's compositor-host wiring, through the REAL OverlayStage under the effect-running harness:
//
//  - the scene layer: never without the host or an override (an OBS page shows none); with one, the backdrop is the
//    canvas's FIRST child, before the template, and the scene picks the card (`sceneFor`)
//  - moments follow the active scene's `momentsFire` (Final discards, Reconnecting shows) — the stage's own wiring of
//    A3's rule, so a stage that hard-codes `discard: false` (M12) or `true` (M6) goes red here as well as in e2e
//  - the host: ready, the alive beat across a scene change and a reconnect, the steady poll, the relay poll access;
//    and without it (OBS): no console line, no loopback request, the default poll
//  - carrom's toss reaches the warming card (change 11's seam: the stage hands `data.carromToss` on)
//
// One substitution: `fetchOverlayFixture` (the overlay route) and `fetch` (the loopback endpoint) are stubbed — the
// network hop. Everything between them and the tree is production code.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";
import en from "@/dictionaries/en/public.json";
import { OVERLAY_SCENES, type SceneId } from "../overlay-scenes";

const live = vi.hoisted(() => ({ calls: [] as unknown[][], next: null as null | (() => unknown) }));
vi.mock("@/components/public-site/live-score-data", async () => {
  const actual = await vi.importActual<typeof import("@/components/public-site/live-score-data")>(
    "@/components/public-site/live-score-data",
  );
  return {
    ...actual,
    fetchOverlayFixture: vi.fn(async (...args: unknown[]) => {
      live.calls.push(args);
      return live.next ? live.next() : (args[0] as never);
    }),
  };
});

import { OverlayStage, type OverlayStageProps } from "../overlay-stage";
import { OverlayMatchCard } from "../overlay-slate";
import { OverlaySceneBackdrop } from "../overlay-scene";

const NOW = 1_700_000_000_000;
const dict = en as Record<string, string>;
let lines: string[] = [];
let loopback: string[] = [];
let phases: Array<{ phase: string; seq: number }> = [];

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  lines = [];
  loopback = [];
  phases = [];
  live.calls = [];
  live.next = null;
  vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => void lines.push(String(a[0])));
  vi.stubGlobal("fetch", (url: string, init: { signal: AbortSignal }) => {
    loopback.push(url);
    const next = phases.shift();
    if (next) return Promise.resolve(new Response(JSON.stringify(next), { status: 200 }));
    return new Promise<Response>((_, reject) =>
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
    );
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const snap = (over: Partial<OverlayLiveData> = {}): OverlayLiveData => ({
  status: "in_play",
  summary: { perSide: [{ entrantId: "home", line: "1" }, { entrantId: "away", line: "0" }] },
  outcome: null,
  lastSeq: 1,
  venueTz: "UTC",
  recent: [],
  ...over,
});
const SLATES: Record<"warming" | "live" | "ended", Partial<OverlayLiveData>> = {
  warming: { status: "scheduled", summary: null, lastSeq: null },
  live: {},
  ended: { status: "decided", outcome: { kind: "win", winner: "home" } as never },
};

function props(over: Partial<OverlayStageProps> = {}): OverlayStageProps {
  return {
    fixtureId: "f1",
    initial: snap(),
    realtime: false,
    sportKey: "football",
    style: "bug",
    sides: [
      { id: "home", name: "Kings" },
      { id: "away", name: "Royals" },
    ],
    startLabel: null,
    dict,
    decidedTemplates: decidedOutcomeTemplates((k) => k),
    ...over,
  };
}

const byTestId = (tree: ReactElement[], id: string) => tree.filter((el) => propsOf(el)["data-testid"] === id);
/** The harness never expands a child component, so the backdrop is found by its element type; its scene is its prop
 *  (and its own markup is pinned below by rendering it). */
const scenesOf = (tree: ReactElement[]) => tree.filter((el) => el.type === OverlaySceneBackdrop).map((el) => propsOf(el).scene);
const backdropIndex = (tree: ReactElement[]) => tree.findIndex((el) => el.type === OverlaySceneBackdrop);
const cardOf = (tree: ReactElement[]) => tree.find((el) => el.type === OverlayMatchCard);
const indexOfTestId = (tree: ReactElement[], id: string) => tree.findIndex((el) => propsOf(el)["data-testid"] === id);

describe("the scene layer", () => {
  it("no host and no override: no scene in any slate state — the OBS page's tree carries no backdrop", () => {
    let checked = 0;
    for (const [slate, over] of Object.entries(SLATES)) {
      const tree = renderIsland<OverlayStageProps>(OverlayStage, props({ initial: snap(over), snapshotOnly: true })).tree();
      expect(scenesOf(tree), slate).toHaveLength(0);
      const card = cardOf(tree);
      if (card) expect(propsOf(card).card, `${slate}: the layer's card, no scene prop`).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("every declared scene as an override: the backdrop (when not live) comes BEFORE the template; the card is the scene's", () => {
    const EXPECTED_CARD: Record<SceneId, Record<string, string | null>> = {
      live: { warming: "upcoming", live: null, ended: "result" },
      starting: { warming: "upcoming", live: null, ended: "result" },
      reconnecting: { warming: "reconnecting", live: "reconnecting", ended: "result" },
      final: { warming: "ended", live: "ended", ended: "result" },
    };
    let checked = 0;
    for (const def of OVERLAY_SCENES) {
      for (const [slate, over] of Object.entries(SLATES)) {
        const tree = renderIsland<OverlayStageProps>(
          OverlayStage,
          props({ initial: snap(over), snapshotOnly: true, sceneOverride: def.id }),
        ).tree();
        const scenes = scenesOf(tree);
        if (def.id === "live") {
          expect(scenes, `live × ${slate}: no scene`).toHaveLength(0);
        } else {
          expect(scenes, `${def.id} × ${slate}`).toEqual([def.id]);
          expect(backdropIndex(tree), "the backdrop precedes the template").toBeGreaterThan(-1);
          expect(backdropIndex(tree), "the backdrop precedes the template").toBeLessThan(indexOfTestId(tree, "ovl-template"));
        }
        const card = cardOf(tree);
        const want = EXPECTED_CARD[def.id][slate]!;
        const shown = card ? (propsOf(card).card ?? (slate === "warming" ? "upcoming" : slate === "ended" ? "result" : null)) : null;
        expect(shown, `${def.id} × ${slate}: card`).toBe(want);
        checked++;
      }
    }
    console.log(`scene × slate cells checked: ${checked}`);
    expect(checked).toBe(OVERLAY_SCENES.length * 3);
  });

  it("the backdrop's own markup: the testid, the scene, hidden from assistive tech, the house class", () => {
    const html = renderToStaticMarkup(<OverlaySceneBackdrop scene="reconnecting" />);
    expect(html).toBe('<div data-testid="ovl-scene" data-scene="reconnecting" class="ovl-scene" aria-hidden="true"></div>');
  });

  it("the Reconnecting card renders its line and its lamp; the Stream-ended card its title and the score", () => {
    const tree = renderIsland<OverlayStageProps>(OverlayStage, props({ snapshotOnly: true, sceneOverride: "reconnecting" })).tree();
    const html = renderToStaticMarkup(cardOf(tree)!);
    expect(html).toContain(dict["overlay.scene.reconnecting.line"]);
    expect(html).toContain('data-testid="ovl-slate-status-dot"');
    expect(html).toContain('data-card="reconnecting"');
    const ended = renderToStaticMarkup(
      cardOf(renderIsland<OverlayStageProps>(OverlayStage, props({ snapshotOnly: true, sceneOverride: "final" })).tree())!,
    );
    expect(ended).toContain(dict["overlay.scene.ended.title"]);
    expect(ended).toContain('class="ovl-slate-tile-score">1<');
    expect(ended).toContain('data-card="ended"');
  });
});

describe("moments follow the active scene (change 7)", () => {
  const goal = { seq: 2, type: "football.goal", at: new Date(NOW).toISOString(), payload: { side: 0 as const } };
  const slabAfterGoal = async (scene: SceneId) => {
    const p = props({ snapshotOnly: true, sceneOverride: scene });
    const island = renderIsland<OverlayStageProps>(OverlayStage, p);
    // The snapshot fetcher hands back the newest `initial`: the next poll carries the goal.
    island.rerender({ ...p, initial: snap({ lastSeq: 2, recent: [goal] }) });
    await vi.advanceTimersByTimeAsync(15_000);
    const slot = byTestId(island.tree(), "ovl-moment-slot")[0]!;
    return (propsOf(slot).children ?? null) !== null;
  };
  it("a goal shows on the live camera, under Starting soon and under Reconnecting; never under Final", async () => {
    const shown: Record<string, boolean> = {};
    for (const def of OVERLAY_SCENES) shown[def.id] = await slabAfterGoal(def.id);
    expect(shown).toEqual({ live: true, starting: true, reconnecting: true, final: false });
  });
});

describe("the compositor host", () => {
  it("ready once, then the beat every 2 s — through a scene change (reconnecting → live) and back", async () => {
    phases.push({ phase: "live", seq: 0 }, { phase: "reconnecting", seq: 1 });
    const island = renderIsland<OverlayStageProps>(OverlayStage, props({ host: "compositor" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(lines.filter((l) => l === "seazn:ready")).toHaveLength(1);
    expect(scenesOf(island.tree()), "reconnecting on air").toEqual(["reconnecting"]);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(lines.filter((l) => l === "seazn:alive")).toHaveLength(2);
    phases.push({ phase: "live", seq: 2 });
    // The pending long poll is aborted at its hold + grace, a failure, then the next request takes the scripted reply.
    await vi.advanceTimersByTimeAsync(12_000 + 1_000);
    expect(scenesOf(island.tree()), "back on the camera").toHaveLength(0);
    const beats = lines.filter((l) => l === "seazn:alive").length;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(lines.filter((l) => l === "seazn:alive").length - beats, "the beat survived both scene changes").toBe(3);
    expect(lines.filter((l) => l === "seazn:ready"), "still one ready").toHaveLength(1);
    expect(lines).toContain("seazn:phase-channel=loopback");
  });

  it("polls the overlay route every STREAM_POLL_MS, with the relay access when the page has it", async () => {
    renderIsland<OverlayStageProps>(OverlayStage, props({ host: "compositor", relay: { sid: "s1", st: "tok" } }));
    await vi.advanceTimersByTimeAsync(0);
    const atMount = live.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(live.calls.length - atMount).toBe(1);
    expect(live.calls.at(-1)).toEqual(["f1", { sid: "s1", st: "tok" }]);
  });

  // Review round 1, item 4: fallback B's phase is the compositor's NOW. A delayed page (`?delay=`, the composed
  // session's own) presents the SCORE `delayMs` late, but must read the phase off the newest RECEIVED snapshot — a
  // stage that read it off the presented (`data`) one would air Reconnecting a whole delay after the camera dropped.
  it("delayMs > 0: the web phase is read off the newest RECEIVED snapshot, not the delayed presented one", async () => {
    const DELAY = 10_000;
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("connection refused")));
    const island = renderIsland<OverlayStageProps>(
      OverlayStage,
      props({ host: "compositor", delayMs: DELAY, relay: { sid: "s1", st: "tok" }, initial: snap({ programmePhase: "live" }) }),
    );
    await vi.advanceTimersByTimeAsync(DELAY + 500);
    expect(lines, "premise: three refusals put the page on the web channel").toContain("seazn:phase-channel=web");
    expect(lines, "premise: the delay matured (ready fires on the first drawn snapshot)").toContain("seazn:ready");
    expect(scenesOf(island.tree()), "premise: live, no scene").toEqual([]);
    live.next = () => snap({ lastSeq: 2, programmePhase: "reconnecting" });
    const before = live.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(live.calls.length - before, "premise: one poll answered").toBe(1);
    expect(scenesOf(island.tree()), "the phase arrived with the poll, not a delay later").toEqual(["reconnecting"]);
  });

  it("OBS (no host): no console line, NO loopback request, and the default 15 s poll with no relay access", async () => {
    renderIsland<OverlayStageProps>(OverlayStage, props());
    await vi.advanceTimersByTimeAsync(0);
    const atMount = live.calls.length;
    await vi.advanceTimersByTimeAsync(14_999);
    expect(live.calls.length, "no steady poll").toBe(atMount);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lines).toEqual([]);
    expect(loopback).toEqual([]);
    expect(live.calls.every((c) => c.length === 1), "the public poll carries no relay access").toBe(true);
  });

  it("a preview (snapshotOnly) ignores the host: no request of any kind, no signal", async () => {
    renderIsland<OverlayStageProps>(OverlayStage, props({ host: "compositor", snapshotOnly: true }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(lines).toEqual([]);
    expect(loopback).toEqual([]);
    expect(live.calls).toEqual([]);
  });
});

describe("carrom's toss reaches the warming card (change 11's seam)", () => {
  it("the stage hands `data.carromToss` to the card, and the card says who breaks first", () => {
    const tree = renderIsland<OverlayStageProps>(
      OverlayStage,
      props({ sportKey: "carrom", snapshotOnly: true, initial: snap({ ...SLATES.warming, carromToss: { firstBreakSide: 1 } }) }),
    ).tree();
    const card = cardOf(tree)!;
    expect(propsOf(card).carromToss).toEqual({ firstBreakSide: 1 });
    expect(renderToStaticMarkup(card)).toContain("Royals breaks first");
  });
});
