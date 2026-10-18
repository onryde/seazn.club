// The shared preview render (R2007 step 4.3; spec 2026-10-15 §4.8): the ONE path a non-broadcast surface draws an
// overlay through — the staff gallery now, R2006's picker next. Rendered for real (`renderToStaticMarkup`, node), so
// what is asserted is the markup a browser receives.
//
// The no-network half is a seam with two ends: the preview must ASK for a snapshot-only stage, and the stage must
// HONOUR it by handing the live-fixture hook a fetcher that never leaves the page. `useLiveFixture` is wrapped (never
// replaced — the real hook still runs) so the fetcher the stage hands it can be called here: under `environment: "node"`
// no effect runs, so the hook itself never would. The browser end — zero fixture requests across every gallery cell —
// is `e2e/overlay-gallery.spec.ts` check 6.
import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";
import type { OverlayMoment } from "@/lib/overlay-moments";
import { OverlayPreview, type OverlayPreviewProps } from "../overlay-preview";
import { OverlayStage, type OverlayStageProps } from "../overlay-stage";
import { OVERLAY_TEMPLATES } from "../template-registry";

type HookOptions = { fetcher?: (fixtureId: string) => Promise<OverlayLiveData> };
const hookCalls = vi.hoisted(() => [] as { fixtureId: string; options: unknown }[]);
vi.mock("@/components/public-site/match-centre/use-live-fixture", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/public-site/match-centre/use-live-fixture")>();
  return {
    ...real,
    useLiveFixture: (...args: Parameters<typeof real.useLiveFixture>) => {
      hookCalls.push({ fixtureId: args[0], options: args[3] });
      return real.useLiveFixture(...args);
    },
  };
});

afterEach(() => {
  hookCalls.length = 0;
  vi.unstubAllGlobals();
});

/** The one `OverlayStage` element in a rendered tree (the preview has no hooks, so it can be called as a function). */
function stageElementOf(node: ReactNode): ReactElement<OverlayStageProps> {
  const found: ReactElement<OverlayStageProps>[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    if (n.type === OverlayStage) found.push(n as ReactElement<OverlayStageProps>);
    walk((n.props as { children?: ReactNode }).children);
  };
  walk(node);
  expect(found.length, "the preview draws exactly one stage").toBe(1);
  return found[0]!;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DICT: Record<string, string> = JSON.parse(readFileSync(join(HERE, "../../../dictionaries/en/public.json"), "utf8"));

const LIVE: OverlayLiveData = {
  status: "in_play",
  summary: {
    perSide: [
      { entrantId: "home", line: "2" },
      { entrantId: "away", line: "1" },
    ],
  },
  outcome: null,
  lastSeq: 6,
  venueTz: "UTC",
} as OverlayLiveData;

const MOMENT: OverlayMoment = { kind: "goal", headline: "GOAL", line: "Ada Okafor", tone: "led", seq: 7 };

const props = (over: Partial<OverlayPreviewProps>): OverlayPreviewProps => ({
  template: "bug",
  sportKey: "football",
  scene: "live",
  snapshot: LIVE,
  sides: [
    { id: "home", name: "Milton Keynes Rovers" },
    { id: "away", name: "Northbridge Athletic Football & Social Club" },
  ],
  startLabel: null,
  dict: DICT,
  decidedTemplates: decidedOutcomeTemplates((k) => k),
  frameWidth: 390,
  ...over,
});

describe("OverlayPreview", () => {
  it("for every template: its root, its template and scene, the stage's data-style, and the frame's scale", () => {
    let checked = 0;
    for (const def of Object.values(OVERLAY_TEMPLATES)) {
      const html = renderToStaticMarkup(<OverlayPreview {...props({ template: def.id })} />);
      expect(html, def.id).toContain('data-testid="ovl-preview"');
      expect(html, def.id).toContain(`data-template="${def.id}"`);
      expect(html, def.id).toContain('data-scene="live"');
      expect(html, def.id).toContain(`data-style="${def.id}"`);
      // 390 / 1920, the frame's own ratio — the whole 1920×1080 canvas, scaled, never cropped.
      expect(html, def.id).toContain(`scale(${390 / 1920})`);
      checked++;
    }
    console.log(`templates checked: ${checked}`);
    // The registry's own size (review, PR #974): a third template is swept here with no edit; ≥ 2 is the floor the
    // spec's bar and bug set, so an emptied registry still fails.
    expect(checked).toBe(Object.keys(OVERLAY_TEMPLATES).length);
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it("the frame's height is width × 1080 / 1920", () => {
    const html = renderToStaticMarkup(<OverlayPreview {...props({ frameWidth: 844 })} />);
    expect(html).toMatch(/data-testid="ovl-preview"[^>]*style="[^"]*width:844px/);
    expect(html).toMatch(/data-testid="ovl-preview"[^>]*style="[^"]*height:474.75px/);
    expect(html).toContain(`scale(${844 / 1920})`);
  });

  it("asks for a snapshot-only stage: no realtime, no purpose, no key", () => {
    let checked = 0;
    for (const def of Object.values(OVERLAY_TEMPLATES)) {
      const stage = stageElementOf(OverlayPreview(props({ template: def.id })));
      expect(stage.props.snapshotOnly, def.id).toBe(true);
      expect(stage.props.realtime, def.id).toBe(false);
      expect(stage.props.realtimePurpose, def.id).toBeUndefined();
      expect(stage.props.overlayKey, def.id).toBeUndefined();
      checked++;
    }
    console.log(`templates checked: ${checked}`);
    expect(checked).toBe(Object.keys(OVERLAY_TEMPLATES).length);
    expect(checked).toBeGreaterThan(0);
  });

  it("passes the slate's context (competition, stage) through to the stage, and omits it when absent", () => {
    const meta = { competition: "Ashgrove & District Midweek Twenty20 Championship", stage: "Quarter-finals" };
    expect(stageElementOf(OverlayPreview(props({ slateMeta: meta }))).props.slateMeta).toEqual(meta);
    expect(stageElementOf(OverlayPreview(props({}))).props.slateMeta).toBeUndefined();
  });

  it("the stage it draws hands the live-fixture hook a fetcher that returns the snapshot and never calls fetch", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    renderToStaticMarkup(<OverlayPreview {...props({})} />);
    expect(hookCalls.length, "anti-vacuity: the stage reached the hook").toBeGreaterThan(0);
    for (const call of hookCalls) {
      const fetcher = (call.options as HookOptions).fetcher;
      expect(typeof fetcher, call.fixtureId).toBe("function");
      await expect(fetcher!(call.fixtureId)).resolves.toBe(LIVE);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("…the positive pair: a stage WITHOUT snapshotOnly hands the hook a fetcher that does go to the network", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(LIVE), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const stage = stageElementOf(OverlayPreview(props({})));
    const { snapshotOnly: _omit, ...live } = stage.props;
    void _omit;
    renderToStaticMarkup(<OverlayStage {...live} />);
    expect(hookCalls.length).toBeGreaterThan(0);
    const fetcher = (hookCalls.at(-1)!.options as HookOptions).fetcher!;
    await fetcher(hookCalls.at(-1)!.fixtureId).catch(() => undefined);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("with a moment, the slab and its text render; without one, no slab element at all", () => {
    const withMoment = renderToStaticMarkup(<OverlayPreview {...props({ moment: MOMENT })} />);
    expect(withMoment).toContain('data-testid="overlay-moment"');
    expect(withMoment).toContain("GOAL");
    expect(withMoment).toContain("Ada Okafor");
    const without = renderToStaticMarkup(<OverlayPreview {...props({})} />);
    expect(without).not.toContain('data-testid="overlay-moment"');
    expect(without).not.toContain("Ada Okafor");
  });
});
