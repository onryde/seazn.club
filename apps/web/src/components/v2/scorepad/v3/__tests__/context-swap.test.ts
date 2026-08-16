// Task 8 (R1 chassis): Context strip + Swap sheet primitives.
//
// resolvePool(slot, view) is Ruling F verbatim (progress.md, scout re-pin
// 2026-08-16): "onfield" comes from the engine's own `onFieldPersons()`,
// "bench" is `playingSquad()` MINUS on-field, "all" is `playingSquad()`
// unfiltered. This corrects a false premise in the original plan, which
// pointed at attribution-picker.tsx's `candidatesForPerson` — that helper
// calls `playingSquad()` alone with no on-field/bench split, so reusing it
// would let a swap sheet offer currently-on-field players as their OWN
// substitutes. `onFieldPersons`/`playingSquad` both already filter to
// `role === "player"` internally (core/lineup.ts) — a coach/staff member
// never reaches either pool, which one test below proves rather than
// assumes.
//
// swapCandidates(view, policyVerdict) is spec §2.7 (Swap sheet, owner ask
// 2026-08-15): the engine models substitution law per sport as a VALUE,
// never a throw (S3/#426's `reduceLineupEvent` — refusal is `{ok:false,
// reason: LineupRejectionReason, message: string}`, structurally never an
// exception). `.reason` is a terse MACHINE SLUG ("sub-cap-reached"); the
// sport-worded prose a scorer actually reads lives in `.message` ("this
// side has used all 3 substitutions this variant allows"). A refused
// verdict must collapse the candidate pool to empty AND carry that PROSE
// through VERBATIM via `PolicyVerdict.message`, so the sheet can render
// sport-worded refusal copy instead of a dead or silently-disabled control
// (task-8-brief.md's explicit bar) — and never the raw slug (fix round 1,
// review finding 1: this file originally conflated the two under a field
// named `reason`; `PolicyVerdict.message` below is the corrected shape,
// branded via `refusalMessage()` so a `LineupRejectionReason`-typed value
// cannot be threaded in by mistake — see the "@ts-expect-error" and
// real-`reduceLineupEvent` tests in the `swapCandidates` block).
//
// Rendering is proved with the shared `_hook-harness` (renderIsland/walk/
// textOf), NOT direct function invocation — both components use `useState`
// (which picker is open / which step), and calling a hook-bearing
// component directly throws "Invalid hook call" under this workspace's
// jsdom-less, environment:"node" vitest config (see _hook-harness.tsx's own
// header). Every candidate/chip is rendered inline via the plain function
// `renderCandidateRow` (context-strip.tsx) rather than a nested JSX
// component, precisely so `walk()` — which only descends through
// `.props.children`, never invoking a nested custom component's own
// function — sees every button (same precedent as attribution-picker.tsx's
// `renderAttributionItem`).
import { describe, it, expect } from "vitest";
import type { LineupPolicy, LineupRejectionReason, SideSquad, SquadMember, SquadState } from "@seazn/engine/core";
import { reduceLineupEvent } from "@seazn/engine/core";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { resolvePool, ContextStrip, type ContextStripProps } from "../context-strip";
import {
  refusalMessage,
  swapCandidates,
  SwapSheet,
  type PolicyVerdict,
  type SwapSheetProps,
} from "../swap-sheet";
import type { ContextStripSpec } from "../types";

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

describe("resolvePool", () => {
  it('"onfield" returns only on-field players', () => {
    const s = squad([member({ personId: "a", onField: true }), member({ personId: "b", onField: false })]);
    expect(resolvePool({ pool: "onfield" }, { squad: s })).toEqual(["a"]);
  });

  it('"bench" returns playing-squad members who are NOT on field — the Ruling F split, never the bench-inclusive-of-onfield shape candidatesForPerson would give', () => {
    const s = squad([
      member({ personId: "a", onField: true }),
      member({ personId: "b", onField: false }),
      member({ personId: "c", onField: false }),
    ]);
    expect(resolvePool({ pool: "bench" }, { squad: s })).toEqual(["b", "c"]);
  });

  it('"bench" excludes a coach even though the coach is off field — role filtering (onFieldPersons/playingSquad, core/lineup.ts) is not bypassed', () => {
    const s = squad([member({ personId: "a", onField: false }), member({ personId: "coach-1", role: "coach", onField: false })]);
    expect(resolvePool({ pool: "bench" }, { squad: s })).toEqual(["a"]);
  });

  it('"all" returns every playing-squad member regardless of onField', () => {
    const s = squad([member({ personId: "a", onField: true }), member({ personId: "b", onField: false })]);
    expect(resolvePool({ pool: "all" }, { squad: s })).toEqual(["a", "b"]);
  });

  it("returns an empty array for a pool with no matching members, never throws", () => {
    const s = squad([member({ personId: "a", onField: false })]);
    expect(resolvePool({ pool: "onfield" }, { squad: s })).toEqual([]);
  });
});

describe("swapCandidates", () => {
  const ok: PolicyVerdict = { ok: true };

  it("returns the bench pool (via resolvePool) when the policy verdict is ok", () => {
    const s = squad([member({ personId: "a", onField: true }), member({ personId: "b", onField: false })]);
    expect(swapCandidates({ squad: s }, ok)).toEqual({ candidates: ["b"] });
  });

  it("ok verdict + genuinely empty bench: empty candidates, undefined message (not a policy refusal)", () => {
    const s = squad([member({ personId: "a", onField: true })]);
    expect(swapCandidates({ squad: s }, ok)).toEqual({ candidates: [], message: undefined });
  });

  it("refused verdict: candidates collapse to empty and message is surfaced VERBATIM, byte-identical to the module's own string", () => {
    const s = squad([member({ personId: "a", onField: true }), member({ personId: "b", onField: false })]);
    const verdict: PolicyVerdict = {
      ok: false,
      message: refusalMessage("Rolling subs aren't allowed in 11-a-side — 3 of 3 used"),
    };
    expect(swapCandidates({ squad: s }, verdict)).toEqual({
      candidates: [],
      message: "Rolling subs aren't allowed in 11-a-side — 3 of 3 used",
    });
  });

  it("refused verdict never fabricates a message when the module gave none — stays undefined, never throws", () => {
    const s = squad([member({ personId: "a", onField: true }), member({ personId: "b", onField: false })]);
    expect(swapCandidates({ squad: s }, { ok: false })).toEqual({ candidates: [], message: undefined });
  });

  // --- Fix round 1, finding 1 (Important) -----------------------------
  // `reduceLineupEvent`'s refusal is `{ok:false, reason: LineupRejectionReason,
  // message: string}` (core/lineup.ts:270-295) — `.reason` is a MACHINE SLUG,
  // `.message` is the sport-worded PROSE. This file originally named its own
  // field `reason` and documented it as mirroring the engine's `{ok:false,
  // reason}` — wrong on both counts. These two tests prove the corrected
  // contract two different ways: a compile-time type rejection, and a
  // runtime proof against the REAL engine reducer (not a hand-maintained
  // mock that could silently drift from what the engine actually returns).

  it("TYPE-LEVEL: refusalMessage rejects a value statically typed LineupRejectionReason — proves the slug cannot compile where prose belongs", () => {
    const slug: LineupRejectionReason = "sub-cap-reached";
    // @ts-expect-error — a machine slug must never be threaded as refusal
    // prose (fix round 1, finding 1). If NotRejectionCode/refusalMessage's
    // negative constraint ever stops working, tsc reports THIS line as an
    // unused "@ts-expect-error" directive (TS2578) and `npm run typecheck`
    // fails — this is a real, tsc-checked assertion, not a comment.
    refusalMessage(slug);
  });

  it("RUNTIME, against the real engine: PolicyVerdict.message carries reduceLineupEvent's .message, never its .reason slug", () => {
    const home = squad([member({ personId: "a", onField: true })]);
    const away = squad([member({ personId: "x", onField: true })]);
    const squads: SquadState = { home, away };
    const policy: LineupPolicy = { reentry: "none", reentryPositionLock: false, allowSquadGrowth: false, maxSubs: 0 };

    const result = reduceLineupEvent(
      squads,
      {
        type: "core.lineup.substitution",
        payload: { side: "home-1", off: "a", on: { personId: "new1", slot: "bench", orderNo: 99 } },
      },
      policy,
    );

    if (result.ok) throw new Error("expected a real sub-cap refusal from the engine");
    expect(result.reason).toBe("sub-cap-reached"); // the machine slug — never rendered
    expect(result.message).toBe("this side has used all 0 substitutions this variant allows"); // the prose

    const verdict: PolicyVerdict = { ok: false, message: refusalMessage(result.message) };
    const { message } = swapCandidates({ squad: home }, verdict);
    expect(message).toBe(result.message);
    expect(message).not.toBe(result.reason);
  });
});

// --- Rendering: real ≥44px controls, never a dead/disabled one -----------

const t: ContextStripProps["t"] = (k) => k;

function contextSpec(over: Partial<ContextStripSpec> = {}): ContextStripSpec {
  return {
    slots: [
      { id: "striker", label: "pad.context.striker", personId: "kannan", pool: "onfield", required: true },
      { id: "bowler", label: "pad.context.bowler", pool: "onfield", required: true },
    ],
    ...over,
  };
}

function buttonsOf(tree: ReturnType<typeof walk>) {
  return tree.filter((el) => el.type === "button");
}

/** Simulates a click on a rendered button — the same cast-and-invoke idiom
 *  every other `_hook-harness` suite in this repo uses (e.g.
 *  schedule-gate-dialog.test.tsx), since `propsOf()` types every prop as
 *  `unknown` and a bare `?.()` on that has no call signature under tsc. */
function click(el: ReturnType<typeof buttonsOf>[number]): void {
  (propsOf(el).onClick as () => void)();
}

describe("ContextStrip rendering", () => {
  const baseSquad = squad([
    member({ personId: "kannan", onField: true }),
    member({ personId: "arjun", onField: true }),
  ]);
  const names = { kannan: "Kannan", arjun: "Arjun" };

  it("renders one real ≥44px chip button per slot, no picker open initially", () => {
    const island = renderIsland(ContextStrip, {
      spec: contextSpec(),
      view: { squad: baseSquad },
      personNames: names,
      t,
      onSelect: () => {},
    });
    const chips = buttonsOf(island.tree());
    expect(chips).toHaveLength(2);
    for (const chip of chips) expect(propsOf(chip).style).toMatchObject({ minHeight: 44 });
  });

  it("an unset required slot shows the lime attention dot; a filled slot does not", () => {
    const island = renderIsland(ContextStrip, {
      spec: contextSpec(),
      view: { squad: baseSquad },
      personNames: names,
      t,
      onSelect: () => {},
    });
    const tree = island.tree();
    const dots = tree.filter((el) => (propsOf(el).className as string | undefined)?.includes("bg-lime-400"));
    expect(dots).toHaveLength(1); // only the bowler slot (unset, required)
  });

  it("the assigned chip's text combines the slot label and the resolved person name", () => {
    const island = renderIsland(ContextStrip, {
      spec: contextSpec(),
      view: { squad: baseSquad },
      personNames: names,
      t,
      onSelect: () => {},
    });
    expect(island.text()).toContain("pad.context.striker: Kannan");
  });

  it("tapping a chip opens ITS OWN slot's picker with real ≥44px candidate buttons from resolvePool", () => {
    const island = renderIsland(ContextStrip, {
      spec: contextSpec(),
      view: { squad: baseSquad },
      personNames: names,
      t,
      onSelect: () => {},
    });
    const [strikerChip] = buttonsOf(island.tree());
    click(strikerChip!);

    const afterOpen = island.tree();
    // 2 chips + 2 candidates (onfield pool: kannan, arjun) = 4 buttons.
    expect(buttonsOf(afterOpen)).toHaveLength(4);
    for (const b of buttonsOf(afterOpen)) expect(propsOf(b).style).toMatchObject({ minHeight: 44 });
  });

  it("tapping a candidate calls onSelect(slotId, personId) and closes the picker", () => {
    let selected: [string, string] | null = null;
    const island = renderIsland(ContextStrip, {
      spec: contextSpec(),
      view: { squad: baseSquad },
      personNames: names,
      t,
      onSelect: (slotId, personId) => {
        selected = [slotId, personId];
      },
    });
    const [strikerChip] = buttonsOf(island.tree());
    click(strikerChip!);
    const candidateButtons = buttonsOf(island.tree()).slice(2); // after the 2 chips
    const arjunButton = candidateButtons.find((b) => textOf(b) === "Arjun")!;
    click(arjunButton);

    expect(selected).toEqual(["striker", "arjun"]);
    expect(buttonsOf(island.tree())).toHaveLength(2); // picker closed
  });

  it("a long unbroken person name renders with break-words, and the chip stays min-w-0 (320px overflow guard)", () => {
    const longName = "A".repeat(90);
    const island = renderIsland(ContextStrip, {
      spec: { slots: [{ id: "striker", label: "pad.context.striker", personId: "long1", pool: "onfield", required: true }] },
      view: { squad: squad([member({ personId: "long1", onField: true })]) },
      personNames: { long1: longName },
      t,
      onSelect: () => {},
    });
    const [chip] = buttonsOf(island.tree());
    expect(propsOf(chip).className as string).toContain("min-w-0");
    const nameSpan = walk(chip).find((el) => textOf(el) === `pad.context.striker: ${longName}`);
    // The chip's own label span carries break-words; assert on the deepest
    // span actually holding the text, matching tile-grid.tsx's own
    // "assert break-words on the span holding the text" precedent.
    const spans = walk(chip).filter((el) => el.type === "span");
    expect(spans.some((s) => (propsOf(s).className as string | undefined)?.includes("break-words"))).toBe(true);
    void nameSpan;
  });
});

const swapSpec: SwapSheetProps["spec"] = { offLabel: "pad.swap.off", onLabel: "pad.swap.on" };

describe("SwapSheet rendering", () => {
  const names = { a: "Player A", b: "Player B" };

  it("the off step renders real ≥44px candidate buttons for the on-field pool, no disabled controls", () => {
    const s = squad([member({ personId: "a", onField: true }), member({ personId: "b", onField: false })]);
    const island = renderIsland(SwapSheet, {
      spec: swapSpec,
      view: { squad: s },
      policyVerdict: { ok: true },
      personNames: names,
      t,
      onSwap: () => {},
    });
    const buttons = buttonsOf(island.tree());
    expect(buttons).toHaveLength(1); // only "a" is onfield
    expect(propsOf(buttons[0]!).style).toMatchObject({ minHeight: 44 });
    expect(propsOf(buttons[0]!).disabled).toBeFalsy();
  });

  it("picking the off player moves to the on step and shows an ok verdict's bench candidates", () => {
    const s = squad([member({ personId: "a", onField: true }), member({ personId: "b", onField: false })]);
    let swapped: [string, string] | null = null;
    const island = renderIsland(SwapSheet, {
      spec: swapSpec,
      view: { squad: s },
      policyVerdict: { ok: true },
      personNames: names,
      t,
      onSwap: (off, on) => {
        swapped = [off, on];
      },
    });
    click(buttonsOf(island.tree())[0]!);

    const onStepButtons = buttonsOf(island.tree());
    // 1 "off chosen" header chip (violet, shows "Player A") + 1 bench candidate ("b").
    expect(onStepButtons).toHaveLength(2);
    expect(island.text()).toContain("Player A");
    const benchButton = onStepButtons.find((b) => textOf(b) === "Player B")!;
    click(benchButton);
    expect(swapped).toEqual(["a", "b"]);
  });

  it("a refused policy verdict renders the message as inline text, NEVER inside a button, with zero candidate controls", () => {
    const s = squad([member({ personId: "a", onField: true }), member({ personId: "b", onField: false })]);
    const message = "Rolling subs aren't allowed in 11-a-side — 3 of 3 used";
    const island = renderIsland(SwapSheet, {
      spec: swapSpec,
      view: { squad: s },
      policyVerdict: { ok: false, message: refusalMessage(message) },
      personNames: names,
      t,
      onSwap: () => {},
    });
    click(buttonsOf(island.tree())[0]!); // off -> "a"

    const onStepButtons = buttonsOf(island.tree());
    expect(onStepButtons).toHaveLength(1); // ONLY the "off chosen" header chip — no candidate buttons
    for (const b of onStepButtons) expect(propsOf(b).disabled).toBeFalsy();
    expect(island.text()).toContain(message);
  });

  // Fix round 1, finding 2 (Minor): the empty/non-refused branch of
  // renderCandidateRow (context-strip.tsx) was previously proven only via
  // swapCandidates' own unit tests — never through an actual render. This
  // drives it through SwapSheet directly: an ok verdict whose bench is
  // genuinely empty (nobody left to bring on) must paint the reused
  // "noRoster" empty text, not silently render nothing.
  it("an ok verdict with a genuinely empty bench renders the reused empty-pool text, not a blank on-step", () => {
    const s = squad([member({ personId: "a", onField: true })]); // nobody else at all
    const island = renderIsland(SwapSheet, {
      spec: swapSpec,
      view: { squad: s },
      policyVerdict: { ok: true },
      personNames: { a: "Player A" },
      t,
      onSwap: () => {},
    });
    click(buttonsOf(island.tree())[0]!); // off -> "a"

    const onStepButtons = buttonsOf(island.tree());
    expect(onStepButtons).toHaveLength(1); // only the "off chosen" header chip — no candidate buttons
    expect(island.text()).toContain("scorepad.attribution.noRoster"); // emptyText, via the identity t stub
  });

  it("the off-chosen header chip is itself tappable to reopen the off step", () => {
    const s = squad([member({ personId: "a", onField: true }), member({ personId: "b", onField: false })]);
    const island = renderIsland(SwapSheet, {
      spec: swapSpec,
      view: { squad: s },
      policyVerdict: { ok: true },
      personNames: names,
      t,
      onSwap: () => {},
    });
    click(buttonsOf(island.tree())[0]!); // -> on step
    const headerChip = buttonsOf(island.tree())[0]!;
    click(headerChip); // -> back to off step

    expect(buttonsOf(island.tree())).toHaveLength(1); // back to the single off candidate
  });
});
