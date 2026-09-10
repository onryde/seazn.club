// Fix round I1 (review-unreviewed-range.md, 2026-09-10) — `?delay=` used to
// hold the CLOCK back and not the SCORE.
//
// `useLiveFixture` seeded its state straight from the server-rendered
// `initial` and routed only POLLED snapshots through the delay buffer, so for
// the first `delayMs` (and in fact until the first poll matured, delayMs +
// POLL_MS) an overlay carrying `?delay=30000` painted the score as it was at
// page load while its clock read 30 s earlier. OBS reloads a browser source on
// every scene change, so that window opened over and over on air — the exact
// spoiler the parameter exists to remove. AGENTS.md class 19: reachable was
// worse than inert, because the inert version had no wrong value to express.
//
// These are the tests that had to exist first. `overlay-stage-delay.test.tsx`
// asserted the CLOCK TEXT only, which is precisely why this shipped past a
// green suite, a mutant list and a branch review.
//
// Driven through `renderIsland` rather than `renderToStaticMarkup`: a delay is
// a thing that happens over TIME, and SSR is one frozen instant with no
// effects and no timers. `_hook-harness.tsx` grew a `useLayoutEffect` slot for
// this (the stage's canvas-scale effect is one); with `fit` falsy that effect
// returns before it touches `window`, so no DOM is needed. Assertions read the
// model the stage HANDS its theme — the real stage→theme seam — never a
// hand-written model.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentType, ReactElement } from "react";
import { OverlayStage, type OverlayStageProps } from "../overlay-stage";
import { OVERLAY_THEMES } from "../theme-registry";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import type { OverlayModel } from "@/lib/overlay-model";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";

const FIXED_NOW = 1_700_000_000_000;
/** 60 s of wall time before FIXED_NOW — an in-play fixture 60 s into H1. */
const ANCHOR_MS = FIXED_NOW - 60_000;
const DELAY_MS = 5_000;

/** Every registered theme's component, derived from the registry rather than
 *  named — a set written by hand freezes today's default (see
 *  `theme-registry.ts`'s own note about exactly this). */
const THEME_COMPONENTS = new Set<unknown>(Object.values(OVERLAY_THEMES).map((t) => t.component));

afterEach(() => {
  vi.useRealTimers();
});
beforeEach(() => {
  vi.useFakeTimers({ now: FIXED_NOW });
});

/** The score at page load: home 2, away 1. The value the spoiler leaked. */
function baseProps(delayMs: number | undefined): OverlayStageProps {
  const initial: OverlayLiveData = {
    status: "in_play",
    summary: {
      perSide: [
        { entrantId: "home", line: "2" },
        { entrantId: "away", line: "1" },
      ],
    },
    outcome: null,
    lastSeq: 1,
    venueTz: "UTC",
    clock: { phase: "H1", anchorSeconds: 0, anchorAtWallMs: ANCHOR_MS },
  };
  return {
    fixtureId: "f1",
    initial,
    realtime: false,
    sportKey: "football",
    style: "bug",
    sides: [
      { id: "home", name: "Home XI" },
      { id: "away", name: "Away XI" },
    ],
    startLabel: null,
    dict: {},
    decidedTemplates: decidedOutcomeTemplates((k) => k),
    delayMs,
  };
}

/** The same fixture after full time, home having won. `led` is only ever true
 *  for the winner, the batting side or the serving side (`ledEntrantId`), and
 *  an in-play football fixture is none of those — so this is the props set in
 *  which "leaks nothing" and "leaks the lead" give DIFFERENT answers. It is
 *  also the scenario that matters most: an OBS reload seconds after the final
 *  whistle must not announce the result before the picture reaches it. */
function decidedProps(delayMs: number | undefined): OverlayStageProps {
  const base = baseProps(delayMs);
  return {
    ...base,
    initial: {
      ...base.initial,
      status: "decided",
      outcome: { kind: "win", winner: "home" },
      clock: undefined,
    },
  };
}

const mount = (delayMs: number | undefined) =>
  renderIsland<OverlayStageProps>(OverlayStage, baseProps(delayMs));

const mountDecided = (delayMs: number | undefined) =>
  renderIsland<OverlayStageProps>(OverlayStage, decidedProps(delayMs));

const themeElOf = (tree: ReactElement[]): ReactElement | undefined =>
  tree.find((el) => THEME_COMPONENTS.has(el.type as ComponentType<unknown>));

/** The model the stage hands the theme, or null while it is handing it none. */
const modelOf = (tree: ReactElement[]): OverlayModel | null => {
  const theme = themeElOf(tree);
  return theme ? (propsOf(theme).model as OverlayModel) : null;
};

const rootOf = (tree: ReactElement[]): ReactElement | undefined =>
  tree.find((el) => propsOf(el)["data-testid"] === "ovl-root");

describe("a delayed overlay never paints a snapshot fresher than the picture (I1)", () => {
  it("delayMs=5000 at t=0: NO score reaches the theme — not the undelayed 2, not anything", () => {
    const island = mount(DELAY_MS);
    // The whole finding in one assertion: at t=0 the only snapshot in hand is
    // the one taken at t=0, which says nothing about t−5000.
    expect(modelOf(island.tree()), "a snapshot taken now is not evidence about 5 s ago").toBeNull();
  });

  it("delayMs absent at t=0: the score IS painted immediately — 2 and 1, unchanged from before the fix", () => {
    const model = modelOf(mount(undefined).tree());
    expect(model, "no delay, nothing to hold").not.toBeNull();
    expect([model!.sides[0].big, model!.sides[1].big]).toEqual(["2", "1"]);
  });

  it("delayMs=5000: still holding at t=4999, presenting at t=5000 — the hold ends at delayMs, not at the first poll", async () => {
    const island = mount(DELAY_MS);
    await vi.advanceTimersByTimeAsync(4_000); // the 1 s drain has ticked four times
    expect(modelOf(island.tree()), "4 s < 5 s — nothing is due yet").toBeNull();

    await vi.advanceTimersByTimeAsync(1_000); // t = 5 000
    const model = modelOf(island.tree());
    expect(model, "the initial snapshot is due at exactly delayMs").not.toBeNull();
    // The value distinguishes "presented the snapshot we were holding" from
    // "presented whatever a poll brought": POLL_MS is 15 s, so no poll has
    // happened, and a hook that started its buffer at the first poll would
    // still be showing nothing here.
    expect([model!.sides[0].big, model!.sides[1].big]).toEqual(["2", "1"]);
  });

  it("the offset still reaches the clock — 01:00 at t=5000 under a 5 s delay, where an undelayed stage reads 01:05", async () => {
    // This is `overlay-stage-delay.test.tsx`'s "00:55" assertion, moved to the
    // instant where a delayed stage has something to draw. The two constants
    // differ, so the test witnesses the offset rather than agreeing with any
    // value: 60 s elapsed at the DELAYED picture time, 65 s at wall time.
    const delayed = mount(DELAY_MS);
    const liveNow = mount(undefined);
    await vi.advanceTimersByTimeAsync(DELAY_MS);

    expect(modelOf(delayed.tree())!.header.clock, "wall time minus 5 s").toBe("01:00");
    expect(modelOf(liveNow.tree())!.header.clock, "wall time").toBe("01:05");
  });

  it("while holding, the stage still mounts its root and leaks nothing through it", () => {
    const root = rootOf(mount(DELAY_MS).tree());
    expect(root, "an OBS browser source must not get a blank document").toBeDefined();
    // `data-led` is derived from the score. Emitting the real one while
    // refusing to draw it would put who-is-leading in the DOM anyway.
    expect(propsOf(root!)["data-led"]).toBe("none");
    expect(propsOf(root!)["data-awaiting-delay"]).toBe("1");
  });

  it("delayMs absent: no awaiting marker, ever — a delayMs-less caller is byte-identical", () => {
    const root = rootOf(mount(undefined).tree());
    expect(propsOf(root!)["data-awaiting-delay"]).toBeUndefined();
  });

  it("a DECIDED fixture with no delay puts the winner on data-led — the positive pair for the case below", () => {
    const root = rootOf(mountDecided(undefined).tree());
    expect(propsOf(root!)["data-led"], "home won; without this the next test is vacuous").toBe("home");
  });

  it("while holding a DECIDED fixture, the WINNER does not leak through data-led", () => {
    // An OBS reload just after the final whistle. `data-led` is CSS's hook for
    // the winner's bar, so emitting the real value while drawing no theme
    // would put the result in the document anyway — and 30 s before the
    // picture gets there.
    const root = rootOf(mountDecided(DELAY_MS).tree());
    expect(propsOf(root!)["data-awaiting-delay"]).toBe("1");
    expect(propsOf(root!)["data-led"]).toBe("none");
  });
});
