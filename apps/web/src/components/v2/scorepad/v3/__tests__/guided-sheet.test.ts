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
import { resolvePool } from "../context-strip";
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

// A5 (R2, folded into this task): "who out" and "fielder" are genuinely
// OPPOSITE sides in a real wicket flow — the batting side's on-field pair
// vs the fielding side's own roster. `side` proves that split: "who" reads
// "home", "fielder" reads "away", so a passing suite is proof the wizard
// resolved each step against the RIGHT squad, not just A squad.
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
    { id: "who", kind: "person", title: "pad.sheet.wicket.who.title", pool: "onfield", side: "home" },
    { id: "fielder", kind: "person", title: "pad.sheet.wicket.fielder.title", pool: "bench", side: "away" },
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
    expect(backStep(wicketSpec, state)).toBe(state);
  });

  it("decrements the index and keeps every answer already given", () => {
    const s1 = answerStep(wicketSpec, initialSheetState(), "caught");
    if (s1.done) throw new Error("expected step 1");
    expect(backStep(wicketSpec, s1.state)).toEqual({ stepIndex: 0, answers: { kind: "caught" } });
  });
});

// --- G2 (controller ruling, 2026-08-16): conditional `when(answers)` steps -

// Mirrors cricket's real wicket sheet shape (kind -> who out [only runout] ->
// fielder [only caught/runout/stumped]) with a THIRD, unconditional step
// tacked on the end so a "skip the only conditional step" run still has a
// real next step to land on, distinguishing "skipped forward" from
// "wizard complete" in the same test.
const conditionalSpec: GuidedSheetSpec = {
  event: "cricket.wicket",
  steps: [
    {
      id: "kind",
      kind: "choice",
      title: "pad.sheet.wicket.kind.title",
      options: [
        { id: "bowled", label: "pad.sheet.wicket.kind.bowled" },
        { id: "runout", label: "pad.sheet.wicket.kind.runout" },
      ],
    },
    {
      id: "who",
      kind: "person",
      title: "pad.sheet.wicket.who.title",
      pool: "onfield",
      side: "home",
      when: (answers) => answers.kind === "runout",
    },
    { id: "fielder", kind: "person", title: "pad.sheet.wicket.fielder.title", pool: "bench", side: "away" },
  ],
  buildPayload: (answers) => ({ kind: answers.kind, out: answers.who, fielder: answers.fielder }),
};

describe("currentStep / answerStep / backStep — G2 conditional steps", () => {
  it("a false `when` skips the step WITHOUT a tap: answering 'bowled' (when()=false) lands directly on 'fielder', not 'who'", () => {
    const outcome = answerStep(conditionalSpec, initialSheetState(), "bowled");
    if (outcome.done) throw new Error("expected step 2 (fielder), not done");
    expect(outcome.state.stepIndex).toBe(2);
    expect(currentStep(conditionalSpec, outcome.state)?.id).toBe("fielder");
  });

  it("a true `when` shows the step: answering 'runout' (when()=true) lands on 'who'", () => {
    const outcome = answerStep(conditionalSpec, initialSheetState(), "runout");
    if (outcome.done) throw new Error("expected step 1 (who), not done");
    expect(outcome.state.stepIndex).toBe(1);
    expect(currentStep(conditionalSpec, outcome.state)?.id).toBe("who");
  });

  it("mutation proof: a `when` that is never consulted (always true) would show 'who' after 'bowled' too — the real function disagrees", () => {
    const alwaysVisible = conditionalSpec.steps.map((s) => ({ ...s, when: undefined }));
    const mutantSpec: GuidedSheetSpec = { ...conditionalSpec, steps: alwaysVisible as GuidedSheetSpec["steps"] };
    const real = answerStep(conditionalSpec, initialSheetState(), "bowled");
    const mutant = answerStep(mutantSpec, initialSheetState(), "bowled");
    if (real.done || mutant.done) throw new Error("expected both mid-wizard");
    expect(real.state.stepIndex).not.toBe(mutant.state.stepIndex);
    expect(real.state.stepIndex).toBe(2); // fielder — who skipped
    expect(mutant.state.stepIndex).toBe(1); // who — NOT skipped, proving the predicate is load-bearing
  });

  it("backStep skips a gated-off step going backward too — from 'fielder' after 'bowled', Back returns to 'kind', never the skipped 'who'", () => {
    const afterBowled = answerStep(conditionalSpec, initialSheetState(), "bowled");
    if (afterBowled.done) throw new Error("expected step 2 (fielder)");
    const back = backStep(conditionalSpec, afterBowled.state);
    expect(back.stepIndex).toBe(0);
    expect(currentStep(conditionalSpec, back)?.id).toBe("kind");
  });

  it("backStep lands on a conditional step when it WAS shown: from 'fielder' after 'runout'+a who-pick, Back returns to 'who'", () => {
    const afterRunout = answerStep(conditionalSpec, initialSheetState(), "runout");
    if (afterRunout.done) throw new Error("expected step 1 (who)");
    const afterWho = answerStep(conditionalSpec, afterRunout.state, "somePerson");
    if (afterWho.done) throw new Error("expected step 2 (fielder)");
    const back = backStep(conditionalSpec, afterWho.state);
    expect(back.stepIndex).toBe(1);
    expect(currentStep(conditionalSpec, back)?.id).toBe("who");
  });

  it("a step with no `when` at all behaves exactly as before G2 — always visible, unaffected by answers", () => {
    // wicketSpec (above) declares no `when` anywhere; its own pre-existing
    // answerStep/backStep tests already pin this, this is an explicit
    // cross-check against the NEW conditional machinery specifically.
    const outcome = answerStep(wicketSpec, initialSheetState(), "bowled");
    if (outcome.done) throw new Error("expected step 1 (who) — unconditional in wicketSpec");
    expect(outcome.state.stepIndex).toBe(1);
  });
});

// --- R2 review finding: stale answers from an abandoned branch must not ---
// --- survive a branch-determining answer changing (guided-sheet.tsx:186) -

// Back up, change a branch-determining answer (kind), and a stale key from
// the abandoned branch must NOT survive into `state.answers` — reuses
// conditionalSpec (kind -> who[only runout] -> fielder[unconditional]),
// exactly cricket's own wicket-sheet shape.
describe("answerStep — prunes an abandoned branch's stale answer when an earlier answer changes", () => {
  it("switching kind from runout to bowled after answering 'who' drops 'who' from state.answers, not just skips past it", () => {
    const afterRunout = answerStep(conditionalSpec, initialSheetState(), "runout");
    if (afterRunout.done) throw new Error("expected step 1 (who)");
    const afterWho = answerStep(conditionalSpec, afterRunout.state, "somePerson");
    if (afterWho.done) throw new Error("expected step 2 (fielder)");
    expect(afterWho.state.answers).toEqual({ kind: "runout", who: "somePerson" });

    // Back up past "who" to "kind" — backStep itself never touches answers
    // (its own doc), so both are still carried at this point.
    const backToWho = backStep(conditionalSpec, afterWho.state);
    const backToKind = backStep(conditionalSpec, backToWho);
    expect(backToKind).toEqual({ stepIndex: 0, answers: { kind: "runout", who: "somePerson" } });

    // Change the branch-determining answer: "who" is no longer reachable
    // (when() now false), "fielder" still is (no `when` in conditionalSpec).
    const switched = answerStep(conditionalSpec, backToKind, "bowled");
    if (switched.done) throw new Error("expected step 2 (fielder) — unconditional in conditionalSpec");
    expect(switched.state.stepIndex).toBe(2);
    // The actual bug: pre-fix, answerStep only ever SPREADS {...state.answers,
    // [step.id]: value} — "who" survives the merge even though its own step
    // is no longer reachable under kind:"bowled".
    expect(switched.state.answers).toEqual({ kind: "bowled" });
  });

  it("the pruned state is what a skin's buildPayload actually sees — a spec that blindly spreads every answer never receives the stale key", () => {
    // Cricket's own buildPayload re-derives every read from the final `kind`
    // and would mask this bug (plan doc's own "safe by discipline, not by
    // contract" finding) — this spec is deliberately the OPPOSITE, sloppy
    // skin the chassis itself must still protect.
    const spreadingSpec: GuidedSheetSpec = { ...conditionalSpec, buildPayload: (answers) => ({ ...answers }) };
    const afterRunout = answerStep(spreadingSpec, initialSheetState(), "runout");
    if (afterRunout.done) throw new Error("expected step 1 (who)");
    const afterWho = answerStep(spreadingSpec, afterRunout.state, "somePerson");
    if (afterWho.done) throw new Error("expected step 2 (fielder)");
    const backToKind = backStep(spreadingSpec, backStep(spreadingSpec, afterWho.state));
    const switched = answerStep(spreadingSpec, backToKind, "bowled");
    if (switched.done) throw new Error("expected step 2 (fielder), not the end yet");

    const finished = answerStep(spreadingSpec, switched.state, "someFielder");
    if (!finished.done) throw new Error("expected done");
    expect(finished.event.payload).toEqual({ kind: "bowled", fielder: "someFielder" }); // no stale "who"
  });

  it("does not prune an answer whose step is STILL visible after the change — only genuinely unreachable ones", () => {
    // Answer runout -> who, then go back to kind and re-answer runout again
    // (same branch). "who" stays visible throughout, so its answer must
    // survive — pruning must not be a blanket wipe on every kind change.
    const afterRunout = answerStep(conditionalSpec, initialSheetState(), "runout");
    if (afterRunout.done) throw new Error("expected step 1 (who)");
    const afterWho = answerStep(conditionalSpec, afterRunout.state, "somePerson");
    if (afterWho.done) throw new Error("expected step 2 (fielder)");
    const backToKind = backStep(conditionalSpec, backStep(conditionalSpec, afterWho.state));
    const reAnswered = answerStep(conditionalSpec, backToKind, "runout");
    if (reAnswered.done) throw new Error("expected step 1 (who) again");
    expect(reAnswered.state.answers).toEqual({ kind: "runout", who: "somePerson" });
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
  // A5: TWO distinct squads — "who" (side: "home") must resolve against
  // baseSquad ONLY, "fielder" (side: "away") against fieldingSquad ONLY. A
  // host that mixed the two up (e.g. always passing `views.home` regardless
  // of `step.side`) would leak home names into the fielder step or vice
  // versa — every assertion below on WHICH names appear is the guard
  // against exactly that.
  const baseSquad = squad([
    member({ personId: "kannan", onField: true }),
    member({ personId: "arjun", onField: true }),
    member({ personId: "bench1", onField: false }),
  ]);
  const fieldingSquad = squad([
    member({ personId: "bowler1", onField: true }),
    member({ personId: "fieldBench1", onField: false }),
  ]);
  const views = { home: { squad: baseSquad }, away: { squad: fieldingSquad } };
  const names = { kannan: "Kannan", arjun: "Arjun", bench1: "Bench One", bowler1: "Bowler One", fieldBench1: "Field Bench One" };

  it("renders the first step's title and its choice options as real >=44px buttons, no Back on step 1, Cancel always present", () => {
    const island = renderIsland(GuidedSheet, {
      spec: wicketSpec,
      views,
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
      views,
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
      views,
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
      views,
      personNames: names,
      t,
      onComplete: () => {},
    });
    click(findByText(buttonsOf(island.tree()), "pad.sheet.wicket.kind.caught"));
    click(findByText(buttonsOf(island.tree()), "Kannan")); // who out

    const shown = buttonsOf(island.tree())
      .map((b) => textOf(b))
      .filter((text) => text !== "pad.sheet.back" && text !== "pad.sheet.cancel");
    // Bench of the AWAY squad (side: "away") — never baseSquad's own bench
    // (bench1/"Bench One"), which would leak if the host used `views.home`
    // for both steps instead of resolving per `step.side`.
    expect(shown).toEqual(["Field Bench One"]);
  });

  it("A5: the who step and the fielder step draw from DIFFERENT squads — a home name never appears as a fielder candidate and vice versa", () => {
    const island = renderIsland(GuidedSheet, {
      spec: wicketSpec,
      views,
      personNames: names,
      t,
      onComplete: () => {},
    });
    click(findByText(buttonsOf(island.tree()), "pad.sheet.wicket.kind.caught"));
    const whoShown = buttonsOf(island.tree())
      .map((b) => textOf(b))
      .filter((text) => text !== "pad.sheet.back" && text !== "pad.sheet.cancel");
    expect(whoShown).not.toContain("Bowler One"); // away-side onfield member must not leak into the home-side "who" step
    expect(whoShown).not.toContain("Field Bench One");

    click(findByText(buttonsOf(island.tree()), "Kannan"));
    const fielderShown = buttonsOf(island.tree())
      .map((b) => textOf(b))
      .filter((text) => text !== "pad.sheet.back" && text !== "pad.sheet.cancel");
    expect(fielderShown).not.toContain("Arjun"); // home-side member must not leak into the away-side "fielder" step
    expect(fielderShown).not.toContain("Bench One");
  });

  it("answering the last step calls onComplete with {type: spec.event, payload: buildPayload(answers)} for ALL accumulated answers", () => {
    let completed: unknown = null;
    const island = renderIsland(GuidedSheet, {
      spec: wicketSpec,
      views,
      personNames: names,
      t,
      onComplete: (event) => {
        completed = event;
      },
    });
    click(findByText(buttonsOf(island.tree()), "pad.sheet.wicket.kind.caught"));
    click(findByText(buttonsOf(island.tree()), "Kannan"));
    click(findByText(buttonsOf(island.tree()), "Field Bench One"));

    expect(completed).toEqual({
      type: "cricket.wicket",
      payload: { kind: "caught", out: "kannan", fielder: "fieldBench1" },
    });
  });

  it("tapping Back returns to the previous step's own controls without ever calling onComplete", () => {
    let completed = false;
    const island = renderIsland(GuidedSheet, {
      spec: wicketSpec,
      views,
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
      views,
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
      views,
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
    // The away squad needs its OWN onfield member (so "fielder"'s bench pool
    // is empty for the honest reason — nobody on the bench — not merely
    // because this squad happens to be tiny).
    const soloAwaySquad = squad([member({ personId: "onlyFielder", onField: true })]);
    const island = renderIsland(GuidedSheet, {
      spec: wicketSpec,
      views: { home: { squad: soloSquad }, away: { squad: soloAwaySquad } },
      personNames: { kannan: "Kannan", onlyFielder: "Only Fielder" },
      t,
      onComplete: () => {},
    });
    click(findByText(buttonsOf(island.tree()), "pad.sheet.wicket.kind.caught"));
    click(findByText(buttonsOf(island.tree()), "Kannan")); // -> fielder step, bench pool empty

    expect(island.text()).toContain("scorepad.attribution.noRoster");
  });
});

// --- G6 (controller ruling, 2026-08-16): SheetPersonStep.candidates -------

// A bench player ("bench1") deliberately chosen as the ONLY declared
// candidate for a step whose own `pool` is "onfield" — `resolvePool({pool:
// "onfield"}, ...)` can NEVER produce a bench id on its own (onFieldPersons()
// excludes it by construction), so this is a case `pool` cannot express at
// all, not merely a narrower version of what `pool` would already offer.
// Proves `candidates` truly SUPERSEDES `pool` rather than being merged with
// or filtered by it.
const candidatesSquad = squad([
  member({ personId: "kannan", onField: true }),
  member({ personId: "arjun", onField: true }),
  member({ personId: "bench1", onField: false }),
]);
const candidatesViews = { home: { squad: candidatesSquad }, away: { squad: candidatesSquad } };
const candidatesNames = { kannan: "Kannan", arjun: "Arjun", bench1: "Bench One" };

const candidatesSpec: GuidedSheetSpec = {
  event: "cricket.wicket",
  steps: [
    {
      id: "who",
      kind: "person",
      title: "pad.sheet.wicket.who.title",
      pool: "onfield", // would resolve to kannan/arjun ONLY if consulted
      side: "home",
      candidates: ["bench1"],
    },
  ],
  buildPayload: (answers) => ({ out: answers.who }),
};

describe("GuidedSheet rendering — G6 candidates supersede pool", () => {
  it("an explicit candidates list renders VERBATIM — a bench id pool:\"onfield\" could never produce on its own", () => {
    const island = renderIsland(GuidedSheet, {
      spec: candidatesSpec,
      views: candidatesViews,
      personNames: candidatesNames,
      t,
      onComplete: () => {},
    });
    const shown = buttonsOf(island.tree())
      .map((b) => textOf(b))
      .filter((text) => text !== "pad.sheet.back" && text !== "pad.sheet.cancel");
    expect(shown).toEqual(["Bench One"]);
  });

  it("mutation proof: a resolver that used pool INSTEAD of candidates disagrees with the real one — onfield pair vs the bench candidate", () => {
    // The mutant this guards against: candidatesForStep's own body reverted
    // to `resolvePool({ pool: step.pool }, view)` unconditionally, ignoring
    // `step.candidates` entirely.
    const viaPoolMutant = resolvePool({ pool: "onfield" }, candidatesViews.home);
    expect([...viaPoolMutant].sort()).toEqual(["arjun", "kannan"]);
    // The REAL rendering (previous test) shows exactly ["Bench One"] — the
    // two outputs are provably different, so the candidates branch is
    // genuinely load-bearing, not dead code the pool path already covers.
    expect(viaPoolMutant).not.toContain("bench1");
  });

  it("a step with no candidates at all still resolves via pool — the pre-G6 path is unchanged", () => {
    const island = renderIsland(GuidedSheet, {
      spec: wicketSpec, // "who" step: pool:"onfield", side:"home", no candidates
      views: candidatesViews,
      personNames: candidatesNames,
      t,
      onComplete: () => {},
    });
    click(findByText(buttonsOf(island.tree()), "pad.sheet.wicket.kind.caught"));
    const shown = buttonsOf(island.tree())
      .map((b) => textOf(b))
      .filter((text) => text !== "pad.sheet.back" && text !== "pad.sheet.cancel");
    expect(shown.sort()).toEqual(["Arjun", "Kannan"]); // onfield pair — bench1 still excluded, same as pool-only always did
  });
});

// --- R2b/task 2: SheetNumberStep — a `−`/value/`+` stepper + editable field
// ----------------------------------------------------------------------------

// Two number steps in sequence — enough to prove per-step reseeding and
// chained confirm-to-advance without needing cricket's real three-field
// shape (runs/wickets/legalBalls is task 3's own job, not this chassis
// test's — this spec is deliberately sport-agnostic, same posture as
// wicketSpec/conditionalSpec above).
const numberSpec: GuidedSheetSpec = {
  event: "cricket.summary",
  steps: [
    {
      id: "runs",
      kind: "number",
      title: "pad.sheet.overSummary.runs.title",
      initial: 24,
      min: 0,
      hint: "24/1 pre-localised hint",
    },
    { id: "wickets", kind: "number", title: "pad.sheet.overSummary.wickets.title", initial: 1, min: 0, max: 10 },
  ],
  buildPayload: (answers) => ({ runs: answers.runs, wickets: answers.wickets }),
};
const numberViews = { home: { squad: squad([]) }, away: { squad: squad([]) } };

function inputsOf(tree: ReturnType<typeof walk>) {
  return tree.filter((el) => el.type === "input");
}

function paragraphsOf(tree: ReturnType<typeof walk>) {
  return tree.filter((el) => el.type === "p");
}

describe("GuidedSheet rendering — SheetNumberStep", () => {
  it("renders the hint above the control, a −/value/+ stepper at 44px, an editable field seeded from `initial`, and a confirm control", () => {
    const island = renderIsland(GuidedSheet, {
      spec: numberSpec,
      views: numberViews,
      personNames: {},
      t,
      onComplete: () => {},
    });
    expect(island.text()).toContain("24/1 pre-localised hint");
    expect(island.text()).toContain("pad.sheet.overSummary.runs.title");

    const buttons = buttonsOf(island.tree());
    expect(buttons).toHaveLength(4); // minus, plus, confirm, cancel — no Back on step 1
    const minus = findByText(buttons, "−");
    const plus = findByText(buttons, "+");
    const confirm = findByText(buttons, "scorepad.action.confirm");
    for (const b of [minus, plus, confirm]) expect(propsOf(b).style).toMatchObject({ minHeight: 44 });

    const fields = inputsOf(island.tree());
    expect(fields).toHaveLength(1);
    expect(propsOf(fields[0]!).value).toBe(24); // seeded from step.initial, never 0
    expect(propsOf(fields[0]!).style).toMatchObject({ minHeight: 44 });
  });

  it("tapping + increments the displayed value by 1, tapping − decrements it", () => {
    const island = renderIsland(GuidedSheet, {
      spec: numberSpec,
      views: numberViews,
      personNames: {},
      t,
      onComplete: () => {},
    });
    const value = () => propsOf(inputsOf(island.tree())[0]!).value;

    click(findByText(buttonsOf(island.tree()), "+"));
    expect(value()).toBe(25);
    click(findByText(buttonsOf(island.tree()), "+"));
    expect(value()).toBe(26);
    click(findByText(buttonsOf(island.tree()), "−"));
    expect(value()).toBe(25);
  });

  it("clamps IN THE CHASSIS: − below min (0) holds at 0, + above max (10) holds at 10 — never a value the skin has to reject", () => {
    const island = renderIsland(GuidedSheet, {
      spec: numberSpec,
      views: numberViews,
      personNames: {},
      t,
      onComplete: () => {},
    });
    // Confirm "runs" unedited to reach "wickets" (initial 1, min 0, max 10).
    click(findByText(buttonsOf(island.tree()), "scorepad.action.confirm"));
    expect(island.text()).toContain("pad.sheet.overSummary.wickets.title");
    const value = () => propsOf(inputsOf(island.tree())[0]!).value;

    click(findByText(buttonsOf(island.tree()), "−")); // 1 -> 0
    expect(value()).toBe(0);
    click(findByText(buttonsOf(island.tree()), "−")); // holds at min, never negative
    expect(value()).toBe(0);

    for (let i = 0; i < 12; i++) click(findByText(buttonsOf(island.tree()), "+"));
    expect(value()).toBe(10); // holds at max, never 12
  });

  it("mutation proof: clamping is genuinely enforced, not merely a max value the fixture never reaches", () => {
    // clampNumberStep unclamped would let repeated + taps sail past `max`;
    // this pins the boundary is load-bearing rather than incidentally never
    // hit (the previous test already stops exactly AT 10 — this one proves
    // one MORE tap still cannot cross it).
    const island = renderIsland(GuidedSheet, {
      spec: numberSpec,
      views: numberViews,
      personNames: {},
      t,
      onComplete: () => {},
    });
    click(findByText(buttonsOf(island.tree()), "scorepad.action.confirm")); // -> wickets, initial 1
    for (let i = 0; i < 30; i++) click(findByText(buttonsOf(island.tree()), "+"));
    expect(propsOf(inputsOf(island.tree())[0]!).value).toBe(10);
  });

  it("typing directly into the field sets the value, clamped the same as the stepper buttons", () => {
    const island = renderIsland(GuidedSheet, {
      spec: numberSpec,
      views: numberViews,
      personNames: {},
      t,
      onComplete: () => {},
    });
    const field = () => inputsOf(island.tree())[0]!;
    const onChange = () => propsOf(field()).onChange as (e: { target: { value: string } }) => void;

    onChange()({ target: { value: "40" } });
    expect(propsOf(field()).value).toBe(40);

    // "runs" has min:0 and no max — a negative typed value clamps to 0.
    onChange()({ target: { value: "-5" } });
    expect(propsOf(field()).value).toBe(0);
  });

  it("an empty or non-numeric typed value is ignored (keeps the last valid value) rather than crashing or going to NaN", () => {
    const island = renderIsland(GuidedSheet, {
      spec: numberSpec,
      views: numberViews,
      personNames: {},
      t,
      onComplete: () => {},
    });
    const field = () => inputsOf(island.tree())[0]!;
    const onChange = () => propsOf(field()).onChange as (e: { target: { value: string } }) => void;

    onChange()({ target: { value: "" } });
    expect(propsOf(field()).value).toBe(24);
    onChange()({ target: { value: "abc" } });
    expect(propsOf(field()).value).toBe(24);
  });

  it("completing a spec of two number steps calls onComplete with BOTH answers as decimal STRINGS, not numbers", () => {
    let completed: unknown = null;
    const island = renderIsland(GuidedSheet, {
      spec: numberSpec,
      views: numberViews,
      personNames: {},
      t,
      onComplete: (event) => {
        completed = event;
      },
    });
    click(findByText(buttonsOf(island.tree()), "+")); // runs: 24 -> 25
    click(findByText(buttonsOf(island.tree()), "scorepad.action.confirm")); // -> wickets
    click(findByText(buttonsOf(island.tree()), "scorepad.action.confirm")); // wickets stays 1, confirm

    expect(completed).toEqual({
      type: "cricket.summary",
      payload: { runs: "25", wickets: "1" },
    });
    const payload = (completed as { payload: { runs: unknown } }).payload;
    expect(typeof payload.runs).toBe("string"); // never widened to a number — types.ts's own ruling
  });

  it("Back to an already-confirmed number step re-shows the CONFIRMED value, not the step's original `initial`", () => {
    const island = renderIsland(GuidedSheet, {
      spec: numberSpec,
      views: numberViews,
      personNames: {},
      t,
      onComplete: () => {},
    });
    click(findByText(buttonsOf(island.tree()), "+")); // runs: 24 -> 25
    click(findByText(buttonsOf(island.tree()), "scorepad.action.confirm")); // -> wickets, runs answer = "25"
    click(findByText(buttonsOf(island.tree()), "pad.sheet.back")); // back to runs

    expect(island.text()).toContain("pad.sheet.overSummary.runs.title");
    expect(propsOf(inputsOf(island.tree())[0]!).value).toBe(25); // NOT reset to 24
  });

  it("Cancel emits nothing from a number step, even after edits, and never calls onComplete", () => {
    let completed = false;
    let cancelled = false;
    const island = renderIsland(GuidedSheet, {
      spec: numberSpec,
      views: numberViews,
      personNames: {},
      t,
      onComplete: () => {
        completed = true;
      },
      onCancel: () => {
        cancelled = true;
      },
    });
    click(findByText(buttonsOf(island.tree()), "+"));
    click(findByText(buttonsOf(island.tree()), "pad.sheet.cancel"));
    expect(cancelled).toBe(true);
    expect(completed).toBe(false);
  });

  // Review fix (follow-up to c70c0e90, item 4): the previous version of this
  // test asserted `island.text()).not.toContain("pre-localised hint")` — a
  // string that only ever lived in numberSpec's OWN "runs" hint fixture, not
  // in this test's noHintSpec at all, so it could never appear here either
  // way and the assertion was vacuous (see this file's own mutation-proof
  // convention elsewhere — this one had none). Fixed to a STRUCTURAL check:
  // count `<p>` elements. `GuidedSheet` itself always renders exactly one
  // (the step title, in its own JSX, outside renderNumberStep) — a hint
  // present adds a second, renderNumberStep's own `<p>{step.hint}</p>`; a
  // hint absent must leave the count at one, not merely at an empty string.
  it("a number step declaring no hint renders exactly ONE paragraph (the title) — no hint paragraph at all, not merely an empty one", () => {
    const noHintSpec: GuidedSheetSpec = {
      event: "cricket.summary",
      steps: [{ id: "runs", kind: "number", title: "pad.sheet.overSummary.runs.title", initial: 0 }],
      buildPayload: (answers) => ({ runs: answers.runs }),
    };
    const island = renderIsland(GuidedSheet, {
      spec: noHintSpec,
      views: numberViews,
      personNames: {},
      t,
      onComplete: () => {},
    });
    expect(paragraphsOf(island.tree())).toHaveLength(1);
  });

  it("a number step WITH a hint renders exactly TWO paragraphs (title + hint) — proves the count above is measuring the hint, not something incidental", () => {
    const island = renderIsland(GuidedSheet, {
      spec: numberSpec, // "runs" step declares hint: "24/1 pre-localised hint"
      views: numberViews,
      personNames: {},
      t,
      onComplete: () => {},
    });
    expect(paragraphsOf(island.tree())).toHaveLength(2);
  });

  // Review fix, item 1 (IMPORTANT): the numeric field had no label
  // association at all — no aria-label, no id/aria-labelledby pair to the
  // title paragraph (which is rendered by the PARENT, outside
  // renderNumberStep). Choice/person steps self-label via their button
  // text; a number field's visible content is just a number, so a screen
  // reader user got an unlabelled spinbutton. Wired to the step's own
  // (already-resolved) title.
  it("review fix: the numeric field carries aria-label from the step's own title — never an unlabelled spinbutton", () => {
    const island = renderIsland(GuidedSheet, {
      spec: numberSpec,
      views: numberViews,
      personNames: {},
      t,
      onComplete: () => {},
    });
    const field = inputsOf(island.tree())[0]!;
    expect(propsOf(field)["aria-label"]).toBe(t("pad.sheet.overSummary.runs.title"));
  });

  // Review fix, item 3 (MINOR): the −/+ buttons carried only the bare
  // Unicode glyph as their accessible name. No existing dictionary key
  // covers increment/decrement (checked: addOns.extraOrg.increase/decrease
  // is billing-specific wording, board.ai.stepperAria means a WORKFLOW step
  // indicator — neither fits, and dictionaries/scoring-vocab.ts are a
  // parallel agent's files this wave, not touched). Stopgap: derive the
  // label from the step's own already-resolved title plus the glyph already
  // visible on the button — a dedicated increment/decrement key is still
  // owed (reported to the coordinator).
  it("review fix: the − and + buttons carry an aria-label derived from the step title, not just the bare glyph", () => {
    const island = renderIsland(GuidedSheet, {
      spec: numberSpec,
      views: numberViews,
      personNames: {},
      t,
      onComplete: () => {},
    });
    const title = t("pad.sheet.overSummary.runs.title");
    expect(propsOf(findByText(buttonsOf(island.tree()), "−"))["aria-label"]).toBe(`${title} −`);
    expect(propsOf(findByText(buttonsOf(island.tree()), "+"))["aria-label"]).toBe(`${title} +`);
  });

  // Review fix, item 2 (MINOR): clampNumberStep had no Number.isFinite
  // guard, so a non-finite `initial` (NaN/Infinity) would sail through both
  // bound checks unclamped (every NaN comparison is false). Unreachable
  // through today's one call path but skin-supplied data a later R3-R7 skin
  // is not guaranteed to hand back already-finite.
  it("review fix: a non-finite `initial` (NaN) normalises to a finite, in-bounds value rather than surviving unclamped", () => {
    const nanSpec: GuidedSheetSpec = {
      event: "cricket.summary",
      steps: [{ id: "runs", kind: "number", title: "t", initial: NaN, min: 0, max: 10 }],
      buildPayload: (answers) => ({ runs: answers.runs }),
    };
    const island = renderIsland(GuidedSheet, {
      spec: nanSpec,
      views: numberViews,
      personNames: {},
      t,
      onComplete: () => {},
    });
    const value = propsOf(inputsOf(island.tree())[0]!).value as number;
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(10);
  });
});

// --- a number step obeys `when`/stepVisible identically to choice/person ---
// Pure step-machine only — stepVisible/answerStep/backStep never branch on
// `.kind`, so this is a parity check that the new kind rides the EXISTING
// mechanism rather than needing its own.

const numberConditionalSpec: GuidedSheetSpec = {
  event: "cricket.summary",
  steps: [
    {
      id: "kind",
      kind: "choice",
      title: "t",
      options: [
        { id: "partial", label: "partial" },
        { id: "final", label: "final" },
      ],
    },
    {
      id: "runs",
      kind: "number",
      title: "runs",
      initial: 0,
      when: (answers) => answers.kind === "partial",
    },
    { id: "note", kind: "choice", title: "note", options: [{ id: "ok", label: "ok" }] },
  ],
  buildPayload: (answers) => ({ ...answers }),
};

describe("currentStep / answerStep / backStep — a number step obeys `when` identically to choice/person", () => {
  it("a false `when` skips the number step without a tap", () => {
    const outcome = answerStep(numberConditionalSpec, initialSheetState(), "final");
    if (outcome.done) throw new Error("expected step 2 (note), not done");
    expect(currentStep(numberConditionalSpec, outcome.state)?.id).toBe("note");
  });

  it("a true `when` shows the number step", () => {
    const outcome = answerStep(numberConditionalSpec, initialSheetState(), "partial");
    if (outcome.done) throw new Error("expected step 1 (runs), not done");
    expect(currentStep(numberConditionalSpec, outcome.state)?.id).toBe("runs");
  });
});
