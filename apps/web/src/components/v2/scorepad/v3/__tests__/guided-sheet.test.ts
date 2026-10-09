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
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SideSquad, SquadMember } from "@seazn/engine/core";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { SPORT_TONE_CLASSES } from "../tokens";
import type { Dict } from "@/lib/i18n-constants";
import { t as realT } from "@/lib/i18n-runtime";
import type { MessageKey } from "@/lib/messages";
import { resolvePool } from "../context-strip";
import {
  GuidedSheet,
  keepHyphenatedWordsWhole,
  answerStep,
  backStep,
  currentStep,
  initialSheetState,
  type GuidedSheetProps,
} from "../guided-sheet";
import type { Blocked, GuidedSheetSpec, TapEvent } from "../types";

// This suite proves the CHASSIS renderer, sport-agnostic on purpose (see
// numberSpec's own comment below) — every `title`/`options[].label` here is a
// synthetic fixture key, echoed verbatim by the identity `t` stub (line ~300)
// and never resolved against the real dictionary, so it is cast rather than
// spelled as a genuine `pad.<sport>.*` entry.
const K = (key: string): MessageKey => key as MessageKey;

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
      title: K("pad.sheet.wicket.kind.title"),
      options: [
        { id: "bowled", label: "pad.sheet.wicket.kind.bowled" },
        { id: "caught", label: "pad.sheet.wicket.kind.caught" },
      ],
    },
    { id: "who", kind: "person", title: K("pad.sheet.wicket.who.title"), pool: "onfield", side: "home" },
    { id: "fielder", kind: "person", title: K("pad.sheet.wicket.fielder.title"), pool: "bench", side: "away" },
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
      title: K("pad.sheet.wicket.kind.title"),
      options: [
        { id: "bowled", label: "pad.sheet.wicket.kind.bowled" },
        { id: "runout", label: "pad.sheet.wicket.kind.runout" },
      ],
    },
    {
      id: "who",
      kind: "person",
      title: K("pad.sheet.wicket.who.title"),
      pool: "onfield",
      side: "home",
      when: (answers) => answers.kind === "runout",
    },
    { id: "fielder", kind: "person", title: K("pad.sheet.wicket.fielder.title"), pool: "bench", side: "away" },
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

  // -------------------------------------------------------------------------
  // B4 (owner ruling R3-6): the chassis's side of the card code. The SKIN only
  // names tones (skins/__tests__/football.test.ts pins that); this is what
  // those names actually render as, and the thing football's own suite cannot
  // see. Class names come from ../tokens, never retyped here, so a class edit
  // there reds in exactly one place instead of desyncing silently.
  // -------------------------------------------------------------------------

  const tonedSpec: GuidedSheetSpec = {
    event: "football.card",
    steps: [
      {
        id: "color",
        kind: "choice",
        title: K("card.title"),
        options: [
          { id: "yellow", label: "cardColor.yellow", tone: ["caution"] },
          { id: "red", label: "cardColor.red", tone: ["dismissal"] },
          { id: "second_yellow", label: "cardColor.second_yellow", tone: ["caution", "dismissal"] },
          { id: "plain", label: "cardColor.plain" },
        ],
      },
    ],
    buildPayload: (answers) => ({ color: answers.color }),
  };

  // Takes the TREE, not the island: `renderIsland`'s return type is generic in
  // its props, so a `ReturnType<typeof renderIsland>` parameter is invariant
  // in `rerender` and rejects every real call site.
  const optionButton = (tree: ReturnType<typeof walk>, id: string) =>
    tree.find((el) => propsOf(el)["data-choice-option-id"] === id)!;

  it("W2a: an option's labelText (a name no dictionary holds) wins over its key; an option without one renders its key", () => {
    const named: GuidedSheetSpec = {
      event: "boardgame.tiebreak",
      steps: [
        {
          id: "winner",
          kind: "choice",
          title: K("winner.title"),
          options: [
            { id: "home", label: "scorepad.attribution.home", labelText: "Magnus Carlsen" },
            { id: "away", label: "scorepad.attribution.away" },
          ],
        },
      ],
      buildPayload: (answers) => ({ winner: answers.winner }),
    };
    const island = renderIsland(GuidedSheet, { spec: named, views, personNames: names, t, onComplete: () => {} });
    expect(textOf(optionButton(island.tree(), "home"))).toBe("Magnus Carlsen");
    expect(textOf(optionButton(island.tree(), "away"))).toBe("scorepad.attribution.away");
  });

  it("washes a toned option in its OUTCOME tone and stamps a locale-independent data hook", () => {
    const island = renderIsland(GuidedSheet, { spec: tonedSpec, views, personNames: names, t, onComplete: () => {} });
    const yellow = propsOf(optionButton(island.tree(), "yellow"));
    expect(yellow.className).toContain(SPORT_TONE_CLASSES.wash);
    expect(yellow.className).toContain(SPORT_TONE_CLASSES.caution);
    expect(yellow["data-choice-option-tone"]).toBe("caution");

    // A second yellow's WASH is the sending-off, not the caution — the last
    // tone is the outcome. This is the assertion that fails if someone
    // "simplifies" the outcome pick to `tone[0]`.
    const second = propsOf(optionButton(island.tree(), "second_yellow"));
    expect(second.className).toContain(SPORT_TONE_CLASSES.dismissal);
    expect(second.className).not.toContain(SPORT_TONE_CLASSES.caution);
    expect(second["data-choice-option-tone"]).toBe("caution dismissal");
  });

  it("draws ONE swatch per tone — so a second yellow shows two cards, not one", () => {
    const island = renderIsland(GuidedSheet, { spec: tonedSpec, views, personNames: names, t, onComplete: () => {} });
    const swatchesUnder = (id: string) => {
      const button = optionButton(island.tree(), id);
      return walk(button).filter((el) => {
        const cls = propsOf(el).className;
        return typeof cls === "string" && cls.includes(SPORT_TONE_CLASSES.swatch);
      });
    };
    expect(swatchesUnder("yellow")).toHaveLength(1);
    expect(swatchesUnder("red")).toHaveLength(1);
    expect(swatchesUnder("second_yellow")).toHaveLength(2);
    expect(swatchesUnder("plain")).toHaveLength(0);

    // Decorative only: the option's own label already SAYS which card it is,
    // in four locales. A swatch that were the sole carrier would put the one
    // piece of information colour is doing here out of a screen reader's
    // reach.
    const stack = walk(optionButton(island.tree(), "second_yellow")).find(
      (el) => propsOf(el).className === SPORT_TONE_CLASSES.stack,
    );
    expect(propsOf(stack!)["aria-hidden"]).toBe("true");
  });

  it("leaves an UNTONED option exactly as it rendered before B4 — no wash, no hook, no swatch", () => {
    const island = renderIsland(GuidedSheet, { spec: tonedSpec, views, personNames: names, t, onComplete: () => {} });
    const plain = propsOf(optionButton(island.tree(), "plain"));
    expect(plain.className).not.toContain("pad-tone");
    expect(plain["data-choice-option-tone"]).toBeUndefined();
    // Same 44px floor, toned or not.
    expect(plain.style).toMatchObject({ minHeight: 44 });
    expect(propsOf(optionButton(island.tree(), "red")).style).toMatchObject({ minHeight: 44 });
  });

  it("a toned option still ANSWERS the step — the colour is decoration on a real control", () => {
    let built: unknown = null;
    const island = renderIsland(GuidedSheet, {
      spec: tonedSpec,
      views,
      personNames: names,
      t,
      onComplete: (event: unknown) => {
        built = event;
      },
    });
    click(optionButton(island.tree(), "second_yellow"));
    expect(built).toEqual({ type: "football.card", payload: { color: "second_yellow" } });
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
      title: K("pad.sheet.wicket.who.title"),
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
      title: K("pad.sheet.overSummary.runs.title"),
      initial: 24,
      min: 0,
      hintText: "24/1 pre-localised hint",
    },
    { id: "wickets", kind: "number", title: K("pad.sheet.overSummary.wickets.title"), initial: 1, min: 0, max: 10 },
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
  // present adds a second, renderNumberStep's own `<p>{step.hintText}</p>`
  // (field renamed from `hint` — R2b-cricket-over follow-up, hint-field
  // naming pass, 2026-08-17); a hint absent must leave the count at one, not
  // merely at an empty string.
  it("a number step declaring no hint renders exactly ONE paragraph (the title) — no hint paragraph at all, not merely an empty one", () => {
    const noHintSpec: GuidedSheetSpec = {
      event: "cricket.summary",
      steps: [{ id: "runs", kind: "number", title: K("pad.sheet.overSummary.runs.title"), initial: 0 }],
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
      spec: numberSpec, // "runs" step declares hintText: "24/1 pre-localised hint"
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

  // Fix round (review finding 2, deferred from the chassis review): the
  // stopgap above described a "dedicated increment/decrement key... still
  // owed" — the dictionaries were a parallel agent's files at the time.
  // They are free now. Re-checked before adding anything (this test's own
  // regression, not just the report): `addOns.extraOrg.increase`/
  // `.decrease` is billing-specific wording hardcoded to "extra
  // organisations", and `board.ai.stepperAria`/`board.ai.trace.stepperAria`
  // name a WORKFLOW step indicator, not a numeric +/- control — neither
  // reusable here, confirming the earlier report. New GENERIC chassis keys,
  // same `pad.sheet.*` namespace as `pad.sheet.back`/`.cancel`:
  // `pad.sheet.decrease`/`pad.sheet.increase`, interpolated with the step's
  // own already-resolved `{title}`. Verb choice per locale matches the
  // `addOns.extraOrg` precedent exactly — the identical "raise/lower a
  // quantity" concept, not a fresh translation decision.
  it("review fix: the − and + buttons carry an accessible name built from dedicated pad.sheet.decrease/increase keys, not the bare glyph", () => {
    const island = renderIsland(GuidedSheet, {
      spec: numberSpec,
      views: numberViews,
      personNames: {},
      t,
      onComplete: () => {},
    });
    const title = t("pad.sheet.overSummary.runs.title");
    expect(propsOf(findByText(buttonsOf(island.tree()), "−"))["aria-label"]).toBe(
      t("pad.sheet.decrease", { title }),
    );
    expect(propsOf(findByText(buttonsOf(island.tree()), "+"))["aria-label"]).toBe(
      t("pad.sheet.increase", { title }),
    );
  });

  // Coordinator fix (minor, post-approval of 1f7403c0): this file's own `t`
  // stub (above, `(k) => k`) ignores its `vars` argument entirely, so the
  // test above proves the KEY is right but never proves `{title}` is
  // actually threaded through — a future edit that dropped the second
  // argument (`t("pad.sheet.decrease")` instead of
  // `t("pad.sheet.decrease", { title })`) would keep that test green while
  // production read the literal string "Decrease {title}" aloud to
  // screen-reader users. Uses the REAL `t` from lib/i18n-runtime.ts against
  // a dict seeded with the actual en content for both keys plus the step's
  // own title key — same pattern tiles.test.ts's "review finding 1" describe
  // block already established for the identical problem (a stub that can't
  // distinguish "resolved" from "echoed verbatim"), not a second one.
  it("review fix, interpolation: the − and + buttons' aria-label genuinely threads {title} through the REAL t(), not just the bare key", () => {
    const dict: Dict = {
      "pad.sheet.overSummary.runs.title": "Total runs",
      "pad.sheet.decrease": "Decrease {title}",
      "pad.sheet.increase": "Increase {title}",
    };
    const realTStub: GuidedSheetProps["t"] = (k, vars) => realT(dict, k, vars);
    const island = renderIsland(GuidedSheet, {
      spec: numberSpec,
      views: numberViews,
      personNames: {},
      t: realTStub,
      onComplete: () => {},
    });
    expect(propsOf(findByText(buttonsOf(island.tree()), "−"))["aria-label"]).toBe("Decrease Total runs");
    expect(propsOf(findByText(buttonsOf(island.tree()), "+"))["aria-label"]).toBe("Increase Total runs");
  });

  // Review fix, item 2 (MINOR): clampNumberStep had no Number.isFinite
  // guard, so a non-finite `initial` (NaN/Infinity) would sail through both
  // bound checks unclamped (every NaN comparison is false). Unreachable
  // through today's one call path but skin-supplied data a later R3-R7 skin
  // is not guaranteed to hand back already-finite.
  it("review fix: a non-finite `initial` (NaN) normalises to a finite, in-bounds value rather than surviving unclamped", () => {
    const nanSpec: GuidedSheetSpec = {
      event: "cricket.summary",
      steps: [{ id: "runs", kind: "number", title: K("t"), initial: NaN, min: 0, max: 10 }],
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

// --- R2b-over: SheetChoiceStep.hintKey — a reason line for a choice step
// whose options the SKIN has narrowed (first use: cricket's wicket "kind"
// step during a free hit, skins/cricket.tsx). A plain i18n KEY (types.ts's
// own doc on the field explains why this is unlike SheetNumberStep.
// hintText's pre-resolved convention above) — resolved here via
// `t(step.hintKey)`, same as `title`/`options[].label`. Proved the same
// STRUCTURAL way the number step's hint is proved above (paragraph count,
// not a vacuous string probe — this file's own review-fix precedent, right
// above this block): `GuidedSheet` always renders exactly one `<p>` for the
// step title; a hint present must add exactly one more.
//
// Field renamed from `hint` (R2b-cricket-over follow-up, hint-field naming
// pass, 2026-08-17) — see `SheetChoiceStep.hintKey`'s doc (types.ts).
// -----------------------------------------------------------------------

const choiceNoHintSpec: GuidedSheetSpec = {
  event: "cricket.wicket",
  steps: [
    {
      id: "kind",
      kind: "choice",
      title: K("pad.sheet.wicket.kind.title"),
      options: [{ id: "runout", label: "pad.sheet.wicket.kind.runout" }],
    },
  ],
  buildPayload: (answers) => ({ kind: answers.kind }),
};

const choiceWithHintSpec: GuidedSheetSpec = {
  event: "cricket.wicket",
  steps: [
    {
      id: "kind",
      kind: "choice",
      title: K("pad.sheet.wicket.kind.title"),
      options: [{ id: "runout", label: "pad.sheet.wicket.kind.runout" }],
      hintKey: "pad.sheet.wicket.kind.freeHitHint",
    },
  ],
  buildPayload: (answers) => ({ kind: answers.kind }),
};

describe("GuidedSheet rendering — SheetChoiceStep.hintKey (R2b-over)", () => {
  it("a choice step declaring no hint renders exactly ONE paragraph (the title) — no hint paragraph at all", () => {
    const island = renderIsland(GuidedSheet, {
      spec: choiceNoHintSpec,
      views: numberViews,
      personNames: {},
      t,
      onComplete: () => {},
    });
    expect(paragraphsOf(island.tree())).toHaveLength(1);
  });

  it("a choice step WITH a hint renders exactly TWO paragraphs (title + hint), the hint resolved through t() like title/options", () => {
    const island = renderIsland(GuidedSheet, {
      spec: choiceWithHintSpec,
      views: numberViews,
      personNames: {},
      t,
      onComplete: () => {},
    });
    expect(paragraphsOf(island.tree())).toHaveLength(2);
    expect(island.text()).toContain(t("pad.sheet.wicket.kind.freeHitHint"));
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
      title: K("t"),
      options: [
        { id: "partial", label: "partial" },
        { id: "final", label: "final" },
      ],
    },
    {
      id: "runs",
      kind: "number",
      title: K("runs"),
      initial: 0,
      when: (answers) => answers.kind === "partial",
    },
    { id: "note", kind: "choice", title: K("note"), options: [{ id: "ok", label: "ok" }] },
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

// ---------------------------------------------------------------------------
// R2c — SheetChoiceStep.blocked. The counterpart to ContextSlot.blocked, and
// a METHOD rather than a value because the deciding fact is not known when
// `sheets(view)` builds the spec: it depends on answers accumulated SO FAR.
// Same evaluation point and same single-argument signature `when`
// (StepPredicate) already uses.
//
// The motivating case is cricket's review sheet, and it is also the proof
// that Task 4's brief was wrong to call it a step-ORDERING problem: `kind` is
// step 1 and `by` is step 3, so by the time `by` renders the answer that
// decides the quota already exists. No reorder needed.
// ---------------------------------------------------------------------------

describe("GuidedSheet rendering — R2c SheetChoiceStep.blocked", () => {
  const squads = { home: { squad: squad([member({ personId: "kannan" })]) }, away: { squad: squad([member({ personId: "bowler1" })]) } };
  const names = { kannan: "Kannan", bowler1: "Bowler One" };

  // kind -> by, exactly the shape of cricket's review sheet.
  function reviewLike(blocked?: (a: Readonly<Record<string, string>>) => Readonly<Record<string, string>>): GuidedSheetSpec {
    return {
      event: "cricket.review",
      steps: [
        {
          id: "kind",
          kind: "choice",
          title: K("sheet.review.kind"),
          options: [
            { id: "player", label: "opt.player" },
            { id: "umpire", label: "opt.umpire" },
          ],
        },
        {
          id: "by",
          kind: "choice",
          title: K("sheet.review.by"),
          options: [
            { id: "HOME", label: "opt.home" },
            { id: "AWAY", label: "opt.away" },
          ],
          ...(blocked ? { blocked } : {}),
        },
      ],
      buildPayload: (a) => ({ ...a }),
    };
  }

  function openBy(spec: GuidedSheetSpec, kind: "player" | "umpire") {
    const island = renderIsland(GuidedSheet, { spec, views: squads, personNames: names, t, onComplete: () => {} });
    click(findByText(buttonsOf(island.tree()), kind === "player" ? "opt.player" : "opt.umpire"));
    return island;
  }

  const quota = (a: Readonly<Record<string, string>>): Blocked =>
    a.kind === "player" ? { AWAY: "Australia has no reviews left in this innings." } : {};

  /** By the stable data hook, not by text — a blocked option's text now also
   *  carries its reason, which is the whole point of the feature. */
  const optionEl = (island: { tree: () => ReturnType<typeof walk> }, id: string) => {
    const found = buttonsOf(island.tree()).find((b) => propsOf(b)["data-choice-option-id"] === id);
    if (!found) throw new Error(`no option button ${id}`);
    return found;
  };

  it("absent blocked leaves every option selectable — every pre-R2c choice step is unchanged", () => {
    const island = openBy(reviewLike(), "player");
    for (const id of ["HOME", "AWAY"]) {
      expect(propsOf(optionEl(island, id)).disabled).toBeFalsy();
    }
  });

  it("a blocked option is still RENDERED, disabled, and does not advance the sheet", () => {
    let completed = false;
    const island = renderIsland(GuidedSheet, {
      spec: reviewLike(quota),
      views: squads,
      personNames: names,
      t,
      onComplete: () => {
        completed = true;
      },
    });
    click(findByText(buttonsOf(island.tree()), "opt.player"));
    const away = optionEl(island, "AWAY");
    expect(propsOf(away).disabled).toBe(true);
    expect(propsOf(away).onClick).toBeUndefined();
    expect(completed).toBe(false);
  });

  it("the reason renders as visible text beside the option, never a tooltip", () => {
    const island = openBy(reviewLike(quota), "player");
    expect(island.text()).toContain("Australia has no reviews left in this innings.");
    expect(textOf(optionEl(island, "AWAY"))).toContain("Australia has no reviews left in this innings.");
    expect(propsOf(optionEl(island, "AWAY")).title).toBeUndefined();
  });

  it("is RE-EVALUATED against the answers so far — an umpire review is never capped, so nothing blocks", () => {
    // The whole reason this is a method and not a value: the same step, the
    // same fold, a different earlier answer, a different verdict.
    const island = openBy(reviewLike(quota), "umpire");
    expect(propsOf(optionEl(island, "AWAY")).disabled).toBeFalsy();
    expect(island.text()).not.toContain("no reviews left");
  });

  it("an unblocked sibling still answers normally", () => {
    let completed: TapEvent | null = null;
    const island = renderIsland(GuidedSheet, {
      spec: reviewLike(quota),
      views: squads,
      personNames: names,
      t,
      onComplete: (event) => {
        completed = event;
      },
    });
    click(findByText(buttonsOf(island.tree()), "opt.player"));
    click(optionEl(island, "HOME"));
    expect(completed).toEqual({ type: "cricket.review", payload: { kind: "player", by: "HOME" } });
  });

  it("carries stable data-* hooks for Playwright", () => {
    const island = openBy(reviewLike(quota), "player");
    const home = optionEl(island, "HOME");
    const away = optionEl(island, "AWAY");
    expect(propsOf(home)["data-choice-option-id"]).toBe("HOME");
    expect(propsOf(away)["data-choice-option-id"]).toBe("AWAY");
    expect(propsOf(away)["data-blocked"]).toBe("true");
    expect(propsOf(home)["data-blocked"]).toBeUndefined();
  });
});

// Loop R M7(c) — at 320 the tie-break winner step split its heading "TIE-" / "BREAK?" and wrapped Back onto a line of its
// own ABOVE the options (the header row was `flex-wrap`: a title that fills the width pushes Back down). The header no
// longer wraps — the title shrinks and wraps beside Back — and a hyphenated word is one unbreakable run.
describe("loop R M7(c): the step header keeps Back beside its title, and never splits a hyphenated word", () => {
  it("keepHyphenatedWordsWhole: each hyphenated word becomes one nowrap run; a plain title and the empty title pass through", () => {
    const html = (s: string) => renderToStaticMarkup(createElement(Fragment, null, keepHyphenatedWordsWhole(s)));
    const rows: [string, string][] = [
      ["Who won the tie-break?", 'Who won the <span class="whitespace-nowrap">tie-break?</span>'],
      ["Sous-titre co-équipier", '<span class="whitespace-nowrap">Sous-titre</span> <span class="whitespace-nowrap">co-équipier</span>'],
      ["No hyphen here", "No hyphen here"],
      ["", ""],
    ];
    let checked = 0;
    for (const [input, want] of rows) {
      expect(html(input), JSON.stringify(input)).toBe(want);
      checked++;
    }
    expect(checked).toBe(rows.length);
  });

  it("on a later step the header row does not wrap: the title shrinks beside Back, its hyphenated word whole; Back stays out of the options", () => {
    const twoStep: GuidedSheetSpec = {
      event: "boardgame.tiebreak",
      steps: [
        { id: "rung", kind: "choice", title: K("pad.sheet.rung.title"), options: [{ id: "rapid", label: K("pad.sheet.rung.rapid") }] },
        {
          id: "winner",
          kind: "choice",
          title: K("Who won the tie-break?"),
          options: [
            { id: "home", label: K("pad.sheet.winner.home") },
            { id: "away", label: K("pad.sheet.winner.away") },
          ],
        },
      ],
      buildPayload: (answers) => ({ ...answers }),
    };
    const island = renderIsland(GuidedSheet, {
      spec: twoStep,
      views: candidatesViews,
      personNames: {},
      t,
      onComplete: () => {},
    });
    // Empty case first: step 1 has no Back, so the header holds the title alone.
    expect(buttonsOf(island.tree()).some((b) => textOf(b) === "pad.sheet.back")).toBe(false);
    click(findByText(buttonsOf(island.tree()), "pad.sheet.rung.rapid"));
    const tree = island.tree();
    const back = findByText(buttonsOf(tree), "pad.sheet.back");
    const title = tree.find((el) => el.type === "p" && String(propsOf(el).className ?? "").split(/\s+/).includes("mk-eyebrow"));
    expect(title, "the step title renders").toBeDefined();
    expect(renderToStaticMarkup(title!)).toContain('Who won the <span class="whitespace-nowrap">tie-break?</span>');
    // `.mk-eyebrow` is an inline-flex: every child is its own flex item, so loose words beside the nowrap run stacked
    // out of order at 320 ("WHO" / "WON TIE-BREAK?" / "THE"). The words are ONE child.
    const items = ([] as unknown[]).concat(propsOf(title!).children as unknown).filter((c) => c !== null && c !== false && c !== "");
    expect(items, "one flex item for the whole title").toHaveLength(1);
    const header = tree.find((el) => {
      const kids = ([] as unknown[]).concat(propsOf(el).children as unknown);
      return el.type === "div" && kids.includes(title) && kids.some((k) => k === back);
    });
    expect(header, "the title and Back share one header row").toBeDefined();
    const cls = (el: (typeof tree)[number]) => String(propsOf(el).className ?? "").split(/\s+/);
    expect(cls(header!)).toContain("flex");
    expect(cls(header!), "a wrapping header pushes Back above the options at 320").not.toContain("flex-wrap");
    expect(cls(title!)).toEqual(expect.arrayContaining(["min-w-0", "flex-1"]));
    expect(cls(back)).toContain("shrink-0");
    const whole = walk(title!).find((el) => el.type === "span" && cls(el).includes("whitespace-nowrap"));
    expect(whole && textOf(whole), "the hyphenated word is one unbreakable run").toBe("tie-break?");
  });
});

