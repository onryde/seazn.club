// R4 sponsors on stream, S7 — the sponsor card through the REAL OverlayStage under the effect-running harness. The
// seam this proves: a plan the REAL planner (`planSponsors`) made, carried on the overlay payload, becomes sponsor
// moments in the stage's ONE `incoming` list, airs through the REAL queue (`useMomentQueue` → `momentQueueReducer`),
// draws the card in its template's declared slot, and — at `host=compositor` only — logs the proof-of-play lines the
// hook emits (spec 2026-10-27 §3.6). No fixture on both ends: the lines are what the hook printed to `console.info`.
//
// Where the expected values come from: the slot boxes from the registry entry the stage renders (`sponsorSlots`), the
// holds from `SPONSOR_STYLE_BY_SIZE` (spec §3.2), the fold from `OVERLAY_MOMENT_FOLD_MS`, the poll from
// `STREAM_POLL_MS`, the region rule from `cardRegionBeside`, the line forms from spec §3.6.
//
// One substitution, as in `overlay-stage-compositor.test.tsx`: `fetchOverlayFixture` (the overlay route) and `fetch`
// (the loopback endpoint) are stubbed — the network hop. S5, the server producer of `sponsorPlan`, is not built yet:
// the payload here carries the planner's own output, and the live served-plan seam is owed to S15.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";
import { STREAM_POLL_MS } from "@/lib/stream-session-view";
import { sponsorMoments } from "@/lib/overlay-moments";
import {
  SPONSOR_STYLE_BY_SIZE,
  planSponsors,
  sponsorMomentId,
  type BreakDecl,
  type SponsorCard,
  type SponsorPlan,
} from "@/lib/sponsor-plan";
import en from "@/dictionaries/en/public.json";
import { OVERLAY_MOMENT_FOLD_MS } from "../moment-timing";
import { OVERLAY_TEMPLATES, cardRegionBeside, cardRegionFor, type TemplateId } from "../template-registry";

const live = vi.hoisted(() => ({ calls: [] as unknown[][], snapshot: null as unknown }));
vi.mock("@/components/public-site/live-score-data", async () => {
  const actual = await vi.importActual<typeof import("@/components/public-site/live-score-data")>(
    "@/components/public-site/live-score-data",
  );
  return {
    ...actual,
    fetchOverlayFixture: vi.fn(async (...args: unknown[]) => {
      live.calls.push(args);
      if (live.snapshot === null) throw new Error("test: no snapshot scripted");
      return live.snapshot;
    }),
  };
});

import { OverlayStage, type OverlayStageProps } from "../overlay-stage";
import { OverlayMatchCard } from "../overlay-slate";
import { OVERLAY_SCENES } from "../overlay-scenes";
import { SponsorCardView, SponsorCarousel } from "../sponsor-card";
import { SPONSOR_STALE_MS } from "@/lib/sponsor-plan";

const NOW = Date.parse("2026-10-31T10:00:00.000Z");
const dict = en as Record<string, string>;
let lines: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  lines = [];
  live.calls = [];
  live.snapshot = null;
  vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => void lines.push(String(a[0])));
  // The loopback phase endpoint never answers: the programme phase stays unknown, so no scene unless overridden.
  vi.stubGlobal("fetch", (_url: string, init: { signal: AbortSignal }) =>
    new Promise<Response>((_, reject) =>
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
    ),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sponsorLines = () => lines.filter((l) => l.startsWith("seazn:sponsor:"));
const parse = (line: string) => {
  const at = line.indexOf(" ");
  return { prefix: line.slice(0, at), body: JSON.parse(line.slice(at + 1)) as Record<string, unknown> };
};

const TITLE: SponsorCard = {
  id: "card-title",
  sponsorId: "sponsor-title",
  name: "Northbridge Athletic Football & Social Club",
  logoUrl: null,
  tier: "title",
  onStream: true,
  shortCode: "NB7K",
};
const GOLD: SponsorCard = { id: "card-gold", sponsorId: "sponsor-gold", name: "Gold Co", logoUrl: null, tier: "gold", onStream: true };
/** Unticked, but assigned to an earlier break of this fixture: the planner carries it in `plan.cards`. */
const UNTICKED: SponsorCard = { id: "card-old", sponsorId: "sponsor-old", name: "Old Co", logoUrl: null, tier: "silver", onStream: false };

/** The real planner's plan for one break opened at `seq` (the engine's `opensAt` is S5's). */
function planAt(seq: number, d: BreakDecl, cards: readonly SponsorCard[] = [TITLE]): SponsorPlan {
  const at = new Date(Date.now()).toISOString();
  const { plan } = planSponsors({
    breaks: [{ seq, at, ...d }],
    windowSeqs: [seq],
    settings: { enabled: true, frequency: "busy" },
    cards,
    assignedCards: [],
    assigned: [],
    operatorLog: [],
    nextPosition: 0,
    now: Date.now() + 500,
    complete: true,
  });
  expect(plan?.airings, "premise: the planner gave the break a card").toHaveLength(1);
  return plan;
}
/** A plan with the carousel's cards and no airing (no break in the window). */
function cardsOnly(cards: readonly SponsorCard[], assigned: readonly SponsorCard[] = []): SponsorPlan {
  return planSponsors({
    breaks: [],
    windowSeqs: [],
    settings: { enabled: true, frequency: "busy" },
    cards,
    assignedCards: assigned,
    assigned: [],
    operatorLog: [],
    nextPosition: 0,
    now: Date.now(),
    complete: true,
  }).plan;
}

/** The real planner's plan when this fixture's break at `seq` is FROZEN to the unticked sponsor (assigned before the
 *  untick): `plan.cards` then carries the unticked card beside the ticked ones (S4: "the ticked cards plus any unticked
 *  card an airing still references"). */
function planWithUnticked(seq: number): SponsorPlan {
  const d: BreakDecl = { kind: "over_end", size: "minor" };
  const look = SPONSOR_STYLE_BY_SIZE[d.size];
  return planSponsors({
    breaks: [{ seq, at: new Date(Date.now()).toISOString(), ...d }],
    windowSeqs: [seq],
    settings: { enabled: true, frequency: "busy" },
    cards: [TITLE, GOLD],
    assignedCards: [UNTICKED],
    assigned: [
      {
        momentId: sponsorMomentId(seq, d.kind),
        seq,
        sponsorId: UNTICKED.sponsorId,
        sponsorName: UNTICKED.name,
        position: 0,
        source: "rotation",
        breakKind: d.kind,
        style: look.style,
        holdMs: look.holdMs,
        operatorChoiceAt: null,
      },
    ],
    operatorLog: [],
    nextPosition: 1,
    now: Date.now() + 500,
    complete: true,
  }).plan;
}

/** A ledger event that raises no score moment in any sport (no `MOMENT_RULES` entry). */
const quiet = (seq: number) => ({ seq, type: "core.start", at: new Date(NOW).toISOString(), payload: {} });
const goal = (seq: number) => ({ seq, type: "football.goal", at: new Date(NOW).toISOString(), payload: { side: 0 as const } });

const snap = (over: Partial<OverlayLiveData> = {}): OverlayLiveData => ({
  status: "in_play",
  summary: { perSide: [{ entrantId: "home", line: "1" }, { entrantId: "away", line: "0" }] },
  outcome: null,
  lastSeq: 1,
  venueTz: "UTC",
  recent: [],
  ...over,
});

function props(over: Partial<OverlayStageProps> = {}): OverlayStageProps {
  return {
    fixtureId: "f1",
    initial: snap(),
    realtime: false,
    sportKey: "cricket",
    style: "bar",
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
const cardView = (tree: ReactElement[]) => tree.find((el) => el.type === SponsorCardView);
const carousel = (tree: ReactElement[]) => tree.find((el) => el.type === SponsorCarousel);

const SPORTS = [
  { sportKey: "cricket", style: "bar" as TemplateId, d: { kind: "over_end", size: "minor" } as BreakDecl }, // engine 1.1.0 cricket.ts:4697
  { sportKey: "badminton", style: "bug" as TemplateId, d: { kind: "game_end", size: "major" } as BreakDecl }, // S4's SPORTS table
];

describe("the seam: planner → payload → stage → queue → card + lines (host=compositor)", () => {
  for (const { sportKey, style, d } of SPORTS) {
    const look = SPONSOR_STYLE_BY_SIZE[d.size];
    it(`${sportKey} ${d.kind}: hold → ONE start; a second poll → no duplicate; out → ONE end, cutShort false; the card in its ${look.style} slot`, async () => {
      live.snapshot = snap();
      const island = renderIsland<OverlayStageProps>(OverlayStage, props({ host: "compositor", sportKey, style }));
      await vi.advanceTimersByTimeAsync(0);
      expect(sponsorLines(), "nothing before the break").toEqual([]);

      const plan = planAt(7, d);
      live.snapshot = snap({ lastSeq: 7, recent: [quiet(7)], sponsorPlan: plan });
      await vi.advanceTimersByTimeAsync(STREAM_POLL_MS); // the poll lands; the card folds in
      expect(sponsorLines(), "folding in: no line yet").toEqual([]);
      const pollAt = Date.now();
      await vi.advanceTimersByTimeAsync(OVERLAY_MOMENT_FOLD_MS);
      const started = sponsorLines();
      expect(started, "hold: exactly one start").toHaveLength(1);
      expect(parse(started[0]!)).toEqual({
        prefix: "seazn:sponsor:start",
        body: {
          momentId: sponsorMomentId(7, d.kind),
          cardId: TITLE.id,
          style: look.style,
          source: "rotation",
          breakKind: d.kind,
          at: new Date(pollAt + OVERLAY_MOMENT_FOLD_MS).toISOString(),
        },
      });

      // The card on air: the real card view, in the slot the template declares for this look.
      const tree = island.tree();
      const view = cardView(tree);
      expect(view, "the card renders").toBeDefined();
      expect(propsOf(view!)).toMatchObject({ card: TITLE, style: look.style, phase: "hold" });
      const [slot] = byTestId(tree, "ovl-sponsor-slot");
      const box = OVERLAY_TEMPLATES[style].sponsorSlots[look.style];
      expect(propsOf(slot!)["data-slot"]).toBe(look.style);
      expect(propsOf(slot!).style).toMatchObject({
        "--ovl-sponsor-x": `${box.x}px`,
        "--ovl-sponsor-y": `${box.y}px`,
        "--ovl-sponsor-w": `${box.width}px`,
        "--ovl-sponsor-h": `${box.height}px`,
      });
      // The moment slot stays empty: a sponsor card is never drawn as a score slab.
      expect(propsOf(byTestId(tree, "ovl-moment-slot")[0]!).children ?? null).toBeNull();

      // A second poll re-sends the same window and plan: no second start.
      await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
      expect(sponsorLines(), "a second poll adds no line").toHaveLength(1);

      await vi.advanceTimersByTimeAsync(look.holdMs + 2 * OVERLAY_MOMENT_FOLD_MS + 1_000);
      const all = sponsorLines();
      expect(all, "one start, one end").toHaveLength(2);
      expect(parse(all[1]!)).toMatchObject({ prefix: "seazn:sponsor:end", body: { momentId: sponsorMomentId(7, d.kind), cutShort: false } });
      expect(Object.keys(parse(all[1]!).body)).toEqual(["momentId", "at", "cutShort"]);
      expect(cardView(island.tree()), "gone after its out fold").toBeUndefined();

      // And the plan staying on later polls never airs it again.
      await vi.advanceTimersByTimeAsync(3 * STREAM_POLL_MS);
      expect(sponsorLines()).toHaveLength(2);
    });
  }

  it("no host (an OBS page): the card airs the same, and NO line is ever logged", async () => {
    live.snapshot = snap();
    const island = renderIsland<OverlayStageProps>(OverlayStage, props());
    await vi.advanceTimersByTimeAsync(0);
    live.snapshot = snap({ lastSeq: 7, recent: [quiet(7)], sponsorPlan: planAt(7, SPORTS[0]!.d) });
    let aired = false;
    for (let t = 0; t < 40_000; t += 250) {
      await vi.advanceTimersByTimeAsync(250);
      if (cardView(island.tree())) aired = true;
    }
    expect(aired, "premise: the card aired on the OBS page").toBe(true);
    expect(lines).toEqual([]);
  });

  it("a preview (snapshotOnly) ignores the host: the card can air, no line", async () => {
    const p = props({ host: "compositor", snapshotOnly: true });
    const island = renderIsland<OverlayStageProps>(OverlayStage, p);
    island.rerender({ ...p, initial: snap({ lastSeq: 7, recent: [quiet(7)], sponsorPlan: planAt(7, SPORTS[0]!.d) }) });
    let aired = false;
    for (let t = 0; t < 40_000; t += 250) {
      await vi.advanceTimersByTimeAsync(250);
      if (cardView(island.tree())) aired = true;
    }
    expect(aired, "premise: the preview aired the card").toBe(true);
    expect(sponsorLines()).toEqual([]);
  });
});

describe("the queue's rules reach the lines through the stage", () => {
  it("an undo of the break strikes the card on air: ONE end, cutShort true", async () => {
    live.snapshot = snap();
    renderIsland<OverlayStageProps>(OverlayStage, props({ host: "compositor" }));
    await vi.advanceTimersByTimeAsync(0);
    live.snapshot = snap({ lastSeq: 7, recent: [quiet(7)], sponsorPlan: planAt(7, SPORTS[0]!.d) });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS + OVERLAY_MOMENT_FOLD_MS);
    expect(sponsorLines(), "premise: on air").toHaveLength(1);
    // The scorer undoes the over's last ball: the break is gone, so the plan no longer carries the airing.
    live.snapshot = snap({ lastSeq: 6, recent: [], sponsorPlan: null });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS + 2 * OVERLAY_MOMENT_FOLD_MS);
    const all = sponsorLines();
    expect(all).toHaveLength(2);
    expect(parse(all[1]!).body).toMatchObject({ momentId: sponsorMomentId(7, "over_end"), cutShort: true });
  });

  it("a goal on the next poll cuts the card on air: ONE end, cutShort true — and the goal's slab airs", async () => {
    const d: BreakDecl = { kind: "after_goal", size: "minor" };
    live.snapshot = snap();
    const island = renderIsland<OverlayStageProps>(OverlayStage, props({ host: "compositor", sportKey: "football", style: "bug" }));
    await vi.advanceTimersByTimeAsync(0);
    live.snapshot = snap({ lastSeq: 7, recent: [quiet(7)], sponsorPlan: planAt(7, d) });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS + OVERLAY_MOMENT_FOLD_MS);
    expect(sponsorLines(), "premise: on air").toHaveLength(1);
    live.snapshot = snap({ lastSeq: 8, recent: [quiet(7), goal(8)], sponsorPlan: planAt(7, d) });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
    await vi.advanceTimersByTimeAsync(OVERLAY_MOMENT_FOLD_MS);
    const all = sponsorLines();
    expect(all).toHaveLength(2);
    expect(parse(all[1]!).body).toMatchObject({ momentId: sponsorMomentId(7, d.kind), cutShort: true });
    await vi.advanceTimersByTimeAsync(OVERLAY_MOMENT_FOLD_MS);
    const slab = propsOf(byTestId(island.tree(), "ovl-moment-slot")[0]!).children as ReactElement | null;
    expect((propsOf(slab!).moment as { seq: number }).seq, "the goal took the air").toBe(8);
  });

  it("the mount filter: a break at or below the mount's tip never airs (OBS opened mid-broadcast)", async () => {
    const plan = planAt(7, SPORTS[0]!.d);
    const initial = snap({ lastSeq: 7, recent: [quiet(7)], sponsorPlan: plan });
    live.snapshot = initial;
    const island = renderIsland<OverlayStageProps>(OverlayStage, props({ host: "compositor", initial }));
    for (let t = 0; t < 30_000; t += 250) {
      await vi.advanceTimersByTimeAsync(250);
      expect(cardView(island.tree()), `t=${t}`).toBeUndefined();
    }
    expect(sponsorLines()).toEqual([]);
    // Premise: the same plan arriving AFTER mount (break above the tip) would air — the filter, not the plan, held it.
    expect(sponsorMoments(plan).map((m) => m.seq)).toEqual([7]);
  });

  it("the delay gate: under ?delay=, nothing airs and nothing logs while the transport catches up", async () => {
    const DELAY = 10_000;
    const initial = snap({ lastSeq: 7, recent: [], sponsorPlan: planAt(7, SPORTS[0]!.d) });
    live.snapshot = initial;
    const island = renderIsland<OverlayStageProps>(OverlayStage, props({ host: "compositor", delayMs: DELAY, initial }));
    let steps = 0;
    for (let t = 0; t < DELAY - 500; t += 250) {
      await vi.advanceTimersByTimeAsync(250);
      expect(cardView(island.tree()), `t=${t}: nothing drawn`).toBeUndefined();
      expect(byTestId(island.tree(), "ovl-sponsor-slot"), `t=${t}: no slot`).toEqual([]);
      steps++;
    }
    expect(steps, "anti-vacuity").toBeGreaterThan(0);
    expect(sponsorLines(), "nothing while awaiting the delay").toEqual([]);
  });

  it("Final discards a card ARRIVING under it: it never airs (owner ruling 4)", async () => {
    const p = props({ snapshotOnly: true, sceneOverride: "final" });
    const island = renderIsland<OverlayStageProps>(OverlayStage, p);
    island.rerender({ ...p, initial: snap({ lastSeq: 7, recent: [quiet(7)], sponsorPlan: planAt(7, SPORTS[0]!.d) }) });
    for (let t = 0; t < 30_000; t += 250) {
      await vi.advanceTimersByTimeAsync(250);
      expect(cardView(island.tree()), `t=${t}`).toBeUndefined();
    }
  });
});

describe("the scene carousel's mount", () => {
  const render = (over: Partial<OverlayStageProps>) =>
    renderIsland<OverlayStageProps>(OverlayStage, props({ snapshotOnly: true, ...over })).tree();

  it("on Starting soon and Reconnecting: mounted with the TICKED cards only (never an unticked card plan.cards carries)", () => {
    const plan = planWithUnticked(7);
    expect(plan?.cards.map((c) => c.id), "premise: plan.cards carries the unticked assigned card").toContain(UNTICKED.id);
    let checked = 0;
    for (const scene of ["starting", "reconnecting"] as const) {
      for (const style of ["bar", "bug"] as const) {
        // The frozen break is at the mount's tip, so it never airs here: nothing is on air, the carousel does not yield.
        const el = carousel(render({ sceneOverride: scene, style, initial: snap({ lastSeq: 7, recent: [quiet(7)], sponsorPlan: plan }) }));
        expect(el, `${scene} × ${style}`).toBeDefined();
        const p = propsOf(el!);
        expect((p.cards as SponsorCard[]).map((c) => c.id)).toEqual([TITLE.id, GOLD.id]);
        expect(p.scene).toBe(scene);
        expect(p.host, "a preview logs nothing").toBeNull();
        expect(p.yielding).toBe(false);
        checked++;
      }
    }
    expect(checked, "anti-vacuity").toBe(4);
  });

  it("the empty case: no plan, or no ticked card, mounts no carousel", () => {
    expect(carousel(render({ sceneOverride: "starting" }))).toBeUndefined();
    expect(carousel(render({ sceneOverride: "starting", initial: snap({ sponsorPlan: cardsOnly([], [UNTICKED]) }) }))).toBeUndefined();
  });

  it("never on the live camera or under Final", () => {
    const plan = cardsOnly([TITLE]);
    for (const scene of ["live", "final"] as const) {
      expect(carousel(render({ sceneOverride: scene, initial: snap({ sponsorPlan: plan }) })), scene).toBeUndefined();
    }
    expect(carousel(render({ initial: snap({ sponsorPlan: plan }) })), "no scene at all (OBS)").toBeUndefined();
  });

  it("at host=compositor the carousel gets the host (its lines are on)", () => {
    live.snapshot = snap({ sponsorPlan: cardsOnly([TITLE]) });
    const tree = renderIsland<OverlayStageProps>(
      OverlayStage,
      props({ host: "compositor", sceneOverride: "starting", initial: snap({ sponsorPlan: cardsOnly([TITLE]) }) }),
    ).tree();
    expect(propsOf(carousel(tree)!).host).toBe("compositor");
  });

  it("yields while a moment is on air (one card at a time)", () => {
    const pinned = sponsorMoments(planAt(7, SPORTS[0]!.d))[0]!;
    const tree = render({
      sceneOverride: "starting",
      initial: snap({ sponsorPlan: { ...cardsOnly([TITLE])!, airings: planAt(7, SPORTS[0]!.d)!.airings } }),
      pinnedMoment: pinned,
    });
    expect(propsOf(carousel(tree)!).yielding).toBe(true);
  });

  it("the match card moves clear of the carousel's banner: the canvas carries cardRegionBeside's region", () => {
    let checked = 0;
    for (const style of ["bar", "bug"] as const) {
      const def = OVERLAY_TEMPLATES[style];
      const region = cardRegionFor(def.sceneCardSafeArea)!;
      const beside = cardRegionBeside(region, def.sponsorSlots.banner)!;
      const vars = (tree: ReactElement[]) => propsOf(byTestId(tree, "ovl-root")[0]!).style as Record<string, string>;
      const withCarousel = vars(render({ sceneOverride: "starting", style, initial: snap({ status: "scheduled", summary: null, lastSeq: null, sponsorPlan: cardsOnly([TITLE]) }) }));
      const without = vars(render({ sceneOverride: "starting", style, initial: snap({ status: "scheduled", summary: null, lastSeq: null }) }));
      // Fix round 1 (CI check 4): the brand keeps the WHOLE region's top-right corner — never the strip's, where a
      // card filling the strip would reach it.
      expect(withCarousel["--ovl-brand-x"], `${style}: brand on the whole region`).toBe(`${region.x}px`);
      expect(withCarousel["--ovl-brand-y"]).toBe(`${region.y}px`);
      expect(withCarousel["--ovl-brand-w"]).toBe(`${region.width}px`);
      expect(without["--ovl-brand-w"], `${style}: no carousel, the same corner`).toBe(`${region.width}px`);
      expect(withCarousel["--ovl-card-x"], style).toBe(`${beside.x}px`);
      expect(withCarousel["--ovl-card-w"], style).toBe(`${beside.width}px`);
      expect(withCarousel["--ovl-card-h"], style).toBe(`${beside.height}px`);
      expect(without["--ovl-card-w"], `${style}: no carousel, the whole region`).toBe(`${region.width}px`);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

// ── fix round 1 ────────────────────────────────────────────────────────────────────────────────────────────────────

const SILVER: SponsorCard = { id: "card-silver", sponsorId: "sponsor-silver", name: "Silver Co", logoUrl: null, tier: "silver", onStream: true };
/** A break card's lines (the queue's: `source: "rotation"` on its start) — never the carousel's `scene:` ids. */
const rotationLines = () => sponsorLines().filter((l) => !String(parse(l).body.momentId).startsWith("scene:"));
const matchCardUp = (tree: ReactElement[]) => tree.some((el) => el.type === OverlayMatchCard);
/** A break card drawn by the stage itself — not the carousel's (its card renders inside SponsorCarousel). */
const breakCardSlot = (tree: ReactElement[]) => byTestId(tree, "ovl-sponsor-slot").filter((el) => propsOf(el)["data-carousel"] === undefined);

describe("ruling m4 — break cards WAIT while a match card is up; the carousel is the scene's sponsor path", () => {
  const d = SPORTS[0]!.d;

  it("Reconnecting's card is up: the break card waits (nothing drawn, no line); the scene leaves within 20 s → it airs, ONE start", async () => {
    live.snapshot = snap();
    const p = props({ host: "compositor", sceneOverride: "reconnecting" });
    const island = renderIsland<OverlayStageProps>(OverlayStage, p);
    await vi.advanceTimersByTimeAsync(0);
    expect(matchCardUp(island.tree()), "premise: Reconnecting draws its card").toBe(true);
    live.snapshot = snap({ lastSeq: 7, recent: [quiet(7)], sponsorPlan: planAt(7, d) });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
    const arrived = Date.now();
    for (let t = 0; t < 10_000; t += 250) {
      await vi.advanceTimersByTimeAsync(250);
      expect(cardView(island.tree()), `t=${t}: no break card over the match card`).toBeUndefined();
    }
    expect(rotationLines(), "nothing logged for a card that waits").toEqual([]);
    expect(carousel(island.tree()), "the carousel is the scene's sponsor path").toBeDefined();
    island.rerender({ ...p, sceneOverride: "live" });
    expect(Date.now() - arrived, "premise: inside the stale cut").toBeLessThan(SPONSOR_STALE_MS);
    await vi.advanceTimersByTimeAsync(OVERLAY_MOMENT_FOLD_MS);
    expect(cardView(island.tree()), "back on the live camera, the waiting card airs").toBeDefined();
    const starts = rotationLines().filter((l) => l.startsWith("seazn:sponsor:start"));
    expect(starts).toHaveLength(1);
    expect(parse(starts[0]!).body.momentId).toBe(sponsorMomentId(7, d.kind));
  });

  it("…held past SPONSOR_STALE_MS it is dropped: back on the live camera it never airs, and nothing is logged for it", async () => {
    live.snapshot = snap();
    const p = props({ host: "compositor", sceneOverride: "reconnecting" });
    const island = renderIsland<OverlayStageProps>(OverlayStage, p);
    await vi.advanceTimersByTimeAsync(0);
    live.snapshot = snap({ lastSeq: 7, recent: [quiet(7)], sponsorPlan: planAt(7, d) });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS + SPONSOR_STALE_MS + 1_000);
    island.rerender({ ...p, sceneOverride: "live" });
    for (let t = 0; t < 20_000; t += 250) {
      await vi.advanceTimersByTimeAsync(250);
      expect(cardView(island.tree()), `t=${t}`).toBeUndefined();
    }
    expect(rotationLines()).toEqual([]);
  });

  it("a card ON AIR when Reconnecting comes up is cut: ONE end, cutShort true, and the card leaves", async () => {
    live.snapshot = snap();
    const p = props({ host: "compositor" });
    const island = renderIsland<OverlayStageProps>(OverlayStage, p);
    await vi.advanceTimersByTimeAsync(0);
    live.snapshot = snap({ lastSeq: 7, recent: [quiet(7)], sponsorPlan: planAt(7, d) });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS + OVERLAY_MOMENT_FOLD_MS);
    expect(rotationLines(), "premise: on air").toHaveLength(1);
    island.rerender({ ...p, sceneOverride: "reconnecting" });
    await vi.advanceTimersByTimeAsync(2 * OVERLAY_MOMENT_FOLD_MS);
    const all = rotationLines();
    expect(all).toHaveLength(2);
    expect(parse(all[1]!)).toMatchObject({ prefix: "seazn:sponsor:end", body: { momentId: sponsorMomentId(7, d.kind), cutShort: true } });
    expect(cardView(island.tree())).toBeUndefined();
  });

  it("witness: every template × scene × snapshot — whenever the match card is up, no break card is drawn (and off it, one airs)", async () => {
    let underCard = 0;
    let aired = 0;
    let combos = 0;
    for (const style of ["bar", "bug"] as const) {
      for (const scene of OVERLAY_SCENES) {
        for (const status of ["in_play", "scheduled", "completed"] as const) {
          // The compositor host polls at STREAM_POLL_MS whatever the status, so every combo receives the break.
          live.snapshot = snap({ status });
          const island = renderIsland<OverlayStageProps>(
            OverlayStage,
            props({ host: "compositor", sceneOverride: scene.id, style, initial: snap({ status }) }),
          );
          await vi.advanceTimersByTimeAsync(0);
          live.snapshot = snap({ status, lastSeq: 7, recent: [quiet(7)], sponsorPlan: planAt(7, d) });
          for (let t = 0; t < STREAM_POLL_MS + 12_000; t += 250) {
            await vi.advanceTimersByTimeAsync(250);
            const tree = island.tree();
            if (matchCardUp(tree)) {
              underCard++;
              expect(breakCardSlot(tree), `${style} × ${scene.id} × ${status} t=${t}`).toEqual([]);
            } else if (breakCardSlot(tree).length > 0) aired++;
          }
          island.unmount();
          combos++;
        }
      }
    }
    console.log(`m4 witness: ${combos} combos, ${underCard} steps under a match card, ${aired} steps with a break card off it`);
    expect(combos).toBe(2 * OVERLAY_SCENES.length * 3);
    expect(underCard, "anti-vacuity: the match card was up").toBeGreaterThan(0);
    expect(aired, "anti-vacuity: off the match card the same break DOES air").toBeGreaterThan(0);
  });
});

describe("I1 — the carousel's rotation survives a remount (the stage keeps the memory)", () => {
  // The harness renders the stage, not its children: the carousel's own resumption (unmount at 12 s, remount at 15 s ⇒
  // no start before 20 s, then the next card under a new id) is `sponsor-card.test.tsx`'s, run with a memory box. What
  // only the stage can prove is that the box OUTLIVES the mount — the same object on every mount, for the page's life.
  it("every carousel mount — after leaving the scene, after a poll with no plan — receives the SAME memory object", async () => {
    const plan = cardsOnly([TITLE, GOLD, SILVER]);
    live.snapshot = snap({ sponsorPlan: plan });
    const p = props({ host: "compositor", sceneOverride: "reconnecting", initial: snap({ sponsorPlan: plan }) });
    const island = renderIsland<OverlayStageProps>(OverlayStage, p);
    await vi.advanceTimersByTimeAsync(0);
    const first = propsOf(carousel(island.tree())!).memory as { read: () => { next: number } };
    expect(typeof first.read().next, "premise: a memory store").toBe("number");
    island.rerender({ ...p, sceneOverride: "live" });
    expect(carousel(island.tree()), "premise: the carousel unmounted").toBeUndefined();
    island.rerender({ ...p, sceneOverride: "reconnecting" });
    expect(propsOf(carousel(island.tree())!).memory, "re-entering the scene").toBe(first);
    live.snapshot = snap({ sponsorPlan: null });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
    expect(carousel(island.tree()), "premise: a poll with no plan unmounts it").toBeUndefined();
    live.snapshot = snap({ sponsorPlan: plan });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
    expect(propsOf(carousel(island.tree())!).memory, "after a null plan").toBe(first);
  });
});

describe("m2 — a refused line is dropped at the emit site: the overlay stays up, one warning", () => {
  it("a break card whose start body is over 512 bytes airs, logs nothing, warns once — and a second poll warns no more", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const LONG: SponsorCard = { ...TITLE, id: `card-${"x".repeat(600)}` };
    live.snapshot = snap();
    const island = renderIsland<OverlayStageProps>(OverlayStage, props({ host: "compositor" }));
    await vi.advanceTimersByTimeAsync(0);
    live.snapshot = snap({ lastSeq: 7, recent: [quiet(7)], sponsorPlan: planAt(7, SPORTS[0]!.d, [LONG]) });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS + OVERLAY_MOMENT_FOLD_MS);
    expect(cardView(island.tree()), "the card is on air").toBeDefined();
    await vi.advanceTimersByTimeAsync(2 * STREAM_POLL_MS);
    expect(sponsorLines()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("m5 — Final flushes a card already QUEUED (owner ruling 4), which the hold alone would not", () => {
  it("a card queued behind a goal when Final enters never airs — not even back on the live camera inside the stale cut", async () => {
    const d: BreakDecl = { kind: "after_goal", size: "minor" };
    live.snapshot = snap();
    const p = props({ host: "compositor", sportKey: "football", style: "bug" });
    const island = renderIsland<OverlayStageProps>(OverlayStage, p);
    await vi.advanceTimersByTimeAsync(0);
    live.snapshot = snap({ lastSeq: 8, recent: [goal(8)], sponsorPlan: planAt(8, d) });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
    const arrived = Date.now();
    await vi.advanceTimersByTimeAsync(OVERLAY_MOMENT_FOLD_MS);
    const slab = propsOf(byTestId(island.tree(), "ovl-moment-slot")[0]!).children as ReactElement | null;
    expect((propsOf(slab!).moment as { seq: number }).seq, "premise: the goal is on air, the card queued behind it").toBe(8);
    island.rerender({ ...p, sceneOverride: "final" });
    await vi.advanceTimersByTimeAsync(1_000);
    island.rerender({ ...p, sceneOverride: "live" });
    expect(Date.now() - arrived, "premise: back inside the stale cut — only the flush can keep it off").toBeLessThan(SPONSOR_STALE_MS);
    for (let t = 0; t < 30_000; t += 250) {
      await vi.advanceTimersByTimeAsync(250);
      expect(cardView(island.tree()), `t=${t}`).toBeUndefined();
    }
    expect(rotationLines()).toEqual([]);
  });
});
