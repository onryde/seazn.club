// Task A1 (R2 wave, chassis piece): the guided-sheet step-wizard renderer.
// R1 shipped GuidedSheetSpec/SheetChoiceStep/SheetPersonStep and
// TileSpec.action = {sheet: string} (v3/types.ts) with ZERO consumers —
// tile-grid.tsx forwarded {sheet} tiles raw to onAction and nothing
// anywhere rendered a step wizard (_INDEX.md, R1 "owed by later waves").
// Cricket's wicket flow (kind -> who out -> fielder) is the first real use
// and lands in a later task; this file proves the chassis renderer it will
// consume.
//
// SPLIT (matches tile-grid.tsx/tilesForPhase, detail-dock.tsx/
// dockController, scorebug.tsx/assertScorebugSpec): the step machine
// (initialSheetState/currentStep/answerStep/backStep) is a pure, exported
// builder — data in, data out, no React — proved directly with plain
// values. `GuidedSheet` itself uses useState (current step index,
// accumulated answers), so its rendering is proved with the shared
// _hook-harness (renderIsland/walk/textOf/propsOf), same as
// context-swap.test.ts proves ContextStrip/SwapSheet — calling a
// useState component directly throws "Invalid hook call" under this
// workspace's jsdom-less, environment:"node" vitest config.
//
// Person steps resolve candidates through context-strip.tsx's resolvePool
// (R1 Ruling F) — "onfield" is onFieldPersons(), "bench" is playingSquad()
// minus on-field — never attribution-picker.tsx's candidatesForPerson
// (bench-INCLUSIVE, cannot make the split; A1 dispatch, explicit
// constraint). The rendering tests below prove the split empirically
// through GuidedSheet's own output, the same way context-swap.test.ts
// proves it through ContextStrip/SwapSheet rather than re-deriving
// resolvePool's own already-tested behaviour.
import { describe, it, expect } from "vitest";
import type { SideSquad, SquadMember } from "@seazn/engine/core";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import {
  GuidedSheet,
  answerStep,
  backStep,
  currentStep,
  initialSheetState,
  type GuidedSheetProps,
} from "../guided-sheet";
import type { GuidedSheetSpec } from "../types";

function member(over: Partial<SquadMember> = {}): SquadMember {
  return {
    personId: "p1",
    role: "player",
    provenance: "named",
    orderNo: 1,
    onField: true,
    started: true,
    timesOff: 0,
    timesOn: 0,
    ...over,
  };
}

function squad(members: SquadMember[]): SideSquad {
  return { entrantId: "home-1", members, subsUsed: 0, exemptUsed: {} };
}

const wicketSpec: GuidedSheetSpec = {
  event: "cricket.wicket",
  steps: [
    {
      id: "kind",
      kind: "choice",
      title: "pad.sheet.wicket.kind.title",
      options: [
        { id: "bowled", label: "pad.sheet.wicket.kind.bowled" },
        { id: "caught", label: "pad.sheet.wicket.kind.caught" },
      ],
    },
    { id: "who", kind: "person", title: "pad.sheet.wicket.who.title", pool: "onfield" },
    { id: "fielder", kind: "person", title: "pad.sheet.wicket.fielder.title", pool: "bench" },
  ],
  buildPayload: (answers) => ({ kind: answers.kind, out: answers.who, fielder: answers.fielder }),
};

// --- Pure step machine ------------------------------------------------------

describe("initialSheetState / currentStep", () => {
  it("starts at step 0 with no answers", () => {
    const state = initialSheetState();
    expect(state).toEqual({ stepIndex: 0, answers: {} });
    expect(currentStep(wicketSpec, state)).toBe(wicketSpec.steps[0]);
  });

  it("returns null once the index runs past the last step (defensive — a live GuidedSheet never lets this happen)", () => {
    expect(currentStep(wicketSpec, { stepIndex: 3, answers: {} })).toBeNull();
  });
});

describe("answerStep", () => {
  it("records the answer under the CURRENT step's own id and advances the index", () => {
    const outcome = answerStep(wicketSpec, initialSheetState(), "caught");
    expect(outcome).toEqual({ done: false, state: { stepIndex: 1, answers: { kind: "caught" } } });
  });

  it("accumulates answers across steps, keyed by each step's own id, never overwriting an earlier one", () => {
    const s1 = answerStep(wicketSpec, initialSheetState(), "caught");
    if (s1.done) throw new Error("expected step 1, not done");
    const s2 = answerStep(wicketSpec, s1.state, "kannan");
    if (s2.done) throw new Error("expected step 2, not done");
    expect(s2.state).toEqual({ stepIndex: 2, answers: { kind: "caught", who: "kannan" } });
  });

  it("on the LAST step, returns done:true with buildPayload run over every accumulated answer, not just the last one", () => {
    const s1 = answerStep(wicketSpec, initialSheetState(), "caught");
    if (s1.done) throw new Error("expected step 1");
    const s2 = answerStep(wicketSpec, s1.state, "kannan");
    if (s2.done) throw new Error("expected step 2");
    const s3 = answerStep(wicketSpec, s2.state, "arjun");
    expect(s3).toEqual({
      done: true,
      event: { type: "cricket.wicket", payload: { kind: "caught", out: "kannan", fielder: "arjun" } },
    });
  });

  it("is a no-op (same state, unchanged) once the index is already past the end — defensive, never throws", () => {
    const state = { stepIndex: 99, answers: { a: "1" } };
    expect(answerStep(wicketSpec, state, "x")).toEqual({ done: false, state });
  });
});

describe("backStep", () => {
  it("is a no-op on the first step — returns the SAME state reference, never a negative index", () => {
    const state = initialSheetState();
    expect(backStep(state)).toBe(state);
  });

  it("decrements the index and keeps every answer already given", () => {
    const s1 = answerStep(wicketSpec, initialSheetState(), "caught");
    if (s1.done) throw new Error("expected step 1");
    expect(backStep(s1.state)).toEqual({ stepIndex: 0, answers: { kind: "caught" } });
  });
});

// --- Rendering: real >=44px controls, forward-on-answer, Back/Cancel -------

const t: GuidedSheetProps["t"] = (k) => k;

function buttonsOf(tree: ReturnType<typeof walk>) {
  return tree.filter((el) => el.type === "button");
}

/** Same cast-and-invoke idiom context-swap.test.ts uses: propsOf() types
 *  every prop `unknown`, which has no call signature under tsc. */
function click(el: ReturnType<typeof buttonsOf>[number]): void {
  (propsOf(el).onClick as () => void)();
}

function findByText(tree: ReturnType<typeof buttonsOf>, text: string) {
  const found = tree.find((b) => textOf(b) === text);
  if (!found) throw new Error(`no button with text ${JSON.stringify(text)}`);
  return found;
}

describe("GuidedSheet rendering", () => {
  const baseSquad = squad([
    member({ personId: "kannan", onField: true }),
    member({ personId: "arjun", onField: true }),
    member({ personId: "bench1", onField: false }),
  ]);
  const names = { kannan: "Kannan", arjun: "Arjun", bench1: "Bench One" };

  it("renders the first step's title and its choice options as real >=44px buttons, no Back on step 1, Cancel always present", () => {
    const island = renderIsland(GuidedSheet, {
      spec: wicketSpec,
      view: { squad: baseSquad },
      personNames: names,
      t,
      onComplete: () => {},
    });
    expect(island.text()).toContain("pad.sheet.wicket.kind.title");
    const buttons = buttonsOf(island.tree());
    expect(buttons).toHaveLength(3); // 2 choice options + Cancel, no Back
    for (const b of buttons) expect(propsOf(b).style).toMatchObject({ minHeight: 44 });
    expect(buttons.some((b) => textOf(b) === "pad.sheet.back")).toBe(false);
    expect(buttons.some((b) => textOf(b) === "pad.sheet.cancel")).toBe(true);
  });

  it("answering the choice step advances to the person step and shows a Back control", () => {
    const island = renderIsland(GuidedSheet, {
      spec: wicketSpec,
      view: { squad: baseSquad },
      personNames: names,
      t,
      onComplete: () => {},
    });
    click(findByText(buttonsOf(island.tree()), "pad.sheet.wicket.kind.caught"));

    expect(island.text()).toContain("pad.sheet.wicket.who.title");
    expect(buttonsOf(island.tree()).some((b) => textOf(b) === "pad.sheet.back")).toBe(true);
  });

  it('a person step with pool "onfield" resolves candidates via resolvePool — onfield only, bench excluded', () => {
    const island = renderIsland(GuidedSheet, {
      spec: wicketSpec,
      view: { squad: baseSquad },
      personNames: names,
      t,
      onComplete: () => {},
    });
    click(findByText(buttonsOf(island.tree()), "pad.sheet.wicket.kind.caught"));

    const shown = buttonsOf(island.tree())
      .map((b) => textOf(b))
      .filter((text) => text !== "pad.sheet.back" && text !== "pad.sheet.cancel");
    expect(shown.sort()).toEqual(["Arjun", "Kannan"]); // onfield only — bench1 excluded
  });

  it('the fielder step (pool "bench") resolves the bench-only split — never candidatesForPerson\'s bench-inclusive pool', () => {
    const island = renderIsland(GuidedSheet, {
      spec: wicketSpec,
      view: { squad: baseSquad },
      personNames: names,
      t,
      onComplete: () => {},
    });
    click(findByText(buttonsOf(island.tree()), "pad.sheet.wicket.kind.caught"));
    click(findByText(buttonsOf(island.tree()), "Kannan")); // who out

    const shown = buttonsOf(island.tree())
      .map((b) => textOf(b))
      .filter((text) => text !== "pad.sheet.back" && text !== "pad.sheet.cancel");
    expect(shown).toEqual(["Bench One"]); // bench only: kannan/arjun (onfield) excluded
  });

  it("answering the last step calls onComplete with {type: spec.event, payload: buildPayload(answers)} for ALL accumulated answers", () => {
    let completed: unknown = null;
    const island = renderIsland(GuidedSheet, {
      spec: wicketSpec,
      view: { squad: baseSquad },
      personNames: names,
      t,
      onComplete: (event) => {
        completed = event;
      },
    });
    click(findByText(buttonsOf(island.tree()), "pad.sheet.wicket.kind.caught"));
    click(findByText(buttonsOf(island.tree()), "Kannan"));
    click(findByText(buttonsOf(island.tree()), "Bench One"));

    expect(completed).toEqual({
      type: "cricket.wicket",
      payload: { kind: "caught", out: "kannan", fielder: "bench1" },
    });
  });

  it("tapping Back returns to the previous step's own controls without ever calling onComplete", () => {
    let completed = false;
    const island = renderIsland(GuidedSheet, {
      spec: wicketSpec,
      view: { squad: baseSquad },
      personNames: names,
      t,
      onComplete: () => {
        completed = true;
      },
    });
    click(findByText(buttonsOf(island.tree()), "pad.sheet.wicket.kind.caught"));
    click(findByText(buttonsOf(island.tree()), "pad.sheet.back"));

    expect(island.text()).toContain("pad.sheet.wicket.kind.title");
    expect(completed).toBe(false);
  });

  it("tapping Cancel emits nothing — never calls onComplete — even after answers were already given", () => {
    let completed = false;
    let cancelled = false;
    const island = renderIsland(GuidedSheet, {
      spec: wicketSpec,
      view: { squad: baseSquad },
      personNames: names,
      t,
      onComplete: () => {
        completed = true;
      },
      onCancel: () => {
        cancelled = true;
      },
    });
    click(findByText(buttonsOf(island.tree()), "pad.sheet.wicket.kind.caught"));
    click(findByText(buttonsOf(island.tree()), "pad.sheet.cancel"));

    expect(cancelled).toBe(true);
    expect(completed).toBe(false);
  });

  it("Cancel with no onCancel handler does not throw and still emits nothing", () => {
    let completed = false;
    const island = renderIsland(GuidedSheet, {
      spec: wicketSpec,
      view: { squad: baseSquad },
      personNames: names,
      t,
      onComplete: () => {
        completed = true;
      },
    });
    expect(() => click(findByText(buttonsOf(island.tree()), "pad.sheet.cancel"))).not.toThrow();
    expect(completed).toBe(false);
  });

  it("a genuinely empty candidate pool renders the reused noRoster empty text, not a blank step", () => {
    const soloSquad = squad([member({ personId: "kannan", onField: true })]);
    const island = renderIsland(GuidedSheet, {
      spec: wicketSpec,
      view: { squad: soloSquad },
      personNames: { kannan: "Kannan" },
      t,
      onComplete: () => {},
    });
    click(findByText(buttonsOf(island.tree()), "pad.sheet.wicket.kind.caught"));
    click(findByText(buttonsOf(island.tree()), "Kannan")); // -> fielder step, bench pool empty

    expect(island.text()).toContain("scorepad.attribution.noRoster");
  });
});
