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

// ---------------------------------------------------------------------------
// Blocker 2 (R2 review finding, `docs/superpowers/plans/2026-08-16-scorepad-
// v3-r2-cricket.md`) — a `readOnly` slot must never look tappable: the
// engine's strict-fold sports (cricket's striker/non-striker) reject every
// scorer override for such a slot on the live submit path, so a picker that
// LOOKS like it works but always gets refused server-side is the "picker
// opens and silently fails" defect G5 was fixed to close, reopened.
// ---------------------------------------------------------------------------

describe("ContextStrip rendering — readOnly slots (blocker 2)", () => {
  const baseSquad = squad([
    member({ personId: "kannan", onField: true }),
    member({ personId: "arjun", onField: true }),
  ]);
  const names = { kannan: "Kannan", arjun: "Arjun" };

  function mixedSpec(): ContextStripSpec {
    return {
      slots: [
        { id: "striker", label: "pad.context.striker", personId: "kannan", pool: "onfield", required: true, readOnly: true },
        { id: "bowler", label: "pad.context.bowler", personId: "arjun", pool: "onfield", required: true },
      ],
    };
  }

  it("a readOnly slot renders no <button> — only the editable slot is a real tap target", () => {
    const island = renderIsland(ContextStrip, {
      spec: mixedSpec(),
      view: { squad: baseSquad },
      personNames: names,
      t,
      onSelect: () => {},
    });
    expect(buttonsOf(island.tree())).toHaveLength(1); // bowler only
    expect(island.text()).toContain("pad.context.striker: Kannan"); // still shown, just not tappable
  });

  it("no button anywhere in the tree carries the readOnly striker's own label — nothing there for a scorer to tap", () => {
    const island = renderIsland(ContextStrip, {
      spec: mixedSpec(),
      view: { squad: baseSquad },
      personNames: names,
      t,
      onSelect: () => {},
    });
    const strikerButton = buttonsOf(island.tree()).find((b) => textOf(b).includes("pad.context.striker"));
    expect(strikerButton).toBeUndefined();
  });

  it("the editable chip still opens its own picker and reports onSelect normally — the fix does not disturb the editable slot", () => {
    let selected: [string, string] | null = null;
    const island = renderIsland(ContextStrip, {
      spec: mixedSpec(),
      view: { squad: baseSquad },
      personNames: names,
      t,
      onSelect: (slotId, personId) => {
        selected = [slotId, personId];
      },
    });
    const bowlerChip = buttonsOf(island.tree()).find((b) => textOf(b).includes("pad.context.bowler"))!;
    click(bowlerChip);
    const arjunCandidate = buttonsOf(island.tree()).find((b) => textOf(b) === "Arjun")!;
    click(arjunCandidate);
    expect(selected).toEqual(["bowler", "arjun"]);
  });

  it("a readOnly slot never shows the unset attention dot, even when required and unset — nothing to tap to fix", () => {
    const island = renderIsland(ContextStrip, {
      spec: { slots: [{ id: "striker", label: "pad.context.striker", pool: "onfield", required: true, readOnly: true }] },
      view: { squad: baseSquad },
      personNames: names,
      t,
      onSelect: () => {},
    });
    const dots = island.tree().filter((el) => (propsOf(el).className as string | undefined)?.includes("bg-lime-400"));
    expect(dots).toHaveLength(0);
  });

  it("an EDITABLE unset slot still shows the dot — the suppression is specific to readOnly, not a general regression", () => {
    const island = renderIsland(ContextStrip, {
      spec: { slots: [{ id: "bowler", label: "pad.context.bowler", pool: "onfield", required: true }] },
      view: { squad: baseSquad },
      personNames: names,
      t,
      onSelect: () => {},
    });
    const dots = island.tree().filter((el) => (propsOf(el).className as string | undefined)?.includes("bg-lime-400"));
    expect(dots).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// R2b (owner ruling, bowler-eligibility block, 2026-08-17): `ContextSlot.
// message` — a pre-localised raw string, rendered VERBATIM (never through
// `t()`, same convention `WhoLine.servingLabel`/`TileSpec.labelText` already
// establish). First use: cricket's bowler slot explains WHY the run/wicket
// tiles are currently disabled, right next to the chip a scorer would tap to
// fix it. Must be real visible text with a stable `data-*` hook, never a
// `title`/tooltip (invisible on touch).
// ---------------------------------------------------------------------------

describe("ContextStrip rendering — slot message (R2b bowler-eligibility block)", () => {
  const baseSquad = squad([
    member({ personId: "kannan", onField: true }),
    member({ personId: "arjun", onField: true }),
  ]);
  const names = { kannan: "Kannan", arjun: "Arjun" };

  function messageEl(tree: ReturnType<typeof walk>, slotId: string) {
    return tree.find(
      (el) => propsOf(el)["data-role"] === "context-slot-message" && propsOf(el)["data-slot-id"] === slotId,
    );
  }

  it("a slot with a message renders it as real visible text with a stable data-* hook", () => {
    const island = renderIsland(ContextStrip, {
      spec: {
        slots: [
          { id: "striker", label: "pad.context.striker", personId: "kannan", pool: "onfield", required: true },
          {
            id: "bowler",
            label: "pad.context.bowler",
            pool: "onfield",
            required: true,
            message: "Kannan has bowled his 4 overs.",
          },
        ],
      },
      view: { squad: baseSquad },
      personNames: names,
      t,
      onSelect: () => {},
    });
    const el = messageEl(island.tree(), "bowler");
    expect(el).toBeDefined();
    expect(textOf(el!)).toBe("Kannan has bowled his 4 overs.");
    expect(island.text()).toContain("Kannan has bowled his 4 overs.");
  });

  it("a slot with no message renders no message element for that slot", () => {
    const island = renderIsland(ContextStrip, {
      spec: contextSpec(), // neither slot sets `message`
      view: { squad: baseSquad },
      personNames: names,
      t,
      onSelect: () => {},
    });
    expect(messageEl(island.tree(), "striker")).toBeUndefined();
    expect(messageEl(island.tree(), "bowler")).toBeUndefined();
  });

  // R2b-cricket-over review fix (item 3): `message: ""` must behave like
  // "no message", not "a real but empty <p>". The renderer used to filter on
  // `slot.message !== undefined`, so an EMPTY STRING (truthy-false, but not
  // undefined) still passed the filter and rendered a real, empty
  // `data-role="context-slot-message"` element — a landmine for a skin
  // computing `message: someCondition ? text : ""` (a `?? ""` idiom, say)
  // instead of `undefined`. `StripItem.id` (scorebug.tsx) already gets this
  // right with a truthy check; this brings `ContextSlot.message` in line.
  // Not reachable today (cricket never sets `""`) — this is a landmine
  // fix, not a live-bug fix, which is why it needs its own test rather than
  // riding along with an existing one.
  it('a slot with message: "" (empty string) renders NO message element — absent-vs-empty must not diverge', () => {
    const island = renderIsland(ContextStrip, {
      spec: {
        slots: [{ id: "bowler", label: "pad.context.bowler", pool: "onfield", required: true, message: "" }],
      },
      view: { squad: baseSquad },
      personNames: names,
      t,
      onSelect: () => {},
    });
    expect(messageEl(island.tree(), "bowler")).toBeUndefined();
  });

  it("only the slot carrying a message gets one — an unset sibling slot stays silent", () => {
    const island = renderIsland(ContextStrip, {
      spec: {
        slots: [
          { id: "striker", label: "pad.context.striker", personId: "kannan", pool: "onfield", required: true },
          { id: "bowler", label: "pad.context.bowler", pool: "onfield", required: true, message: "No bowler is eligible." },
        ],
      },
      view: { squad: baseSquad },
      personNames: names,
      t,
      onSelect: () => {},
    });
    expect(messageEl(island.tree(), "striker")).toBeUndefined();
    expect(messageEl(island.tree(), "bowler")).toBeDefined();
  });

  it("a message renders even on a readOnly slot — the two concerns are orthogonal", () => {
    const island = renderIsland(ContextStrip, {
      spec: {
        slots: [
          {
            id: "striker",
            label: "pad.context.striker",
            personId: "kannan",
            pool: "onfield",
            required: true,
            readOnly: true,
            message: "Read-only, with a message too.",
          },
        ],
      },
      view: { squad: baseSquad },
      personNames: names,
      t,
      onSelect: () => {},
    });
    expect(textOf(messageEl(island.tree(), "striker")!)).toBe("Read-only, with a message too.");
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
    expect(buttons).toHaveLength(2); // "a" is onfield, + the Cancel control
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
    // 1 "off chosen" header chip (violet, shows "Player A") + 1 bench candidate ("b") + Cancel.
    expect(onStepButtons).toHaveLength(3);
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
    expect(onStepButtons).toHaveLength(2); // the "off chosen" header chip + Cancel — no candidate buttons
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
    expect(onStepButtons).toHaveLength(2); // the "off chosen" header chip + Cancel — no candidate buttons
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

    expect(buttonsOf(island.tree())).toHaveLength(2); // back to the off step: 1 candidate + Cancel
  });
});

// ---------------------------------------------------------------------------
// Defect fix (found while prepping a live v3 walkthrough, 2026-08-17):
// SwapSheet shipped with no dismiss control on EITHER step — pad-host.tsx
// mounted it with spec/view/policyVerdict/personNames/t/onSwap and nothing
// else, while the sibling GuidedSheet (same file, guided-sheet.tsx) was
// always given `onCancel`. A scorer who opened cricket's Retire flow could
// only finish the whole off->on swap or abandon the page — mid-match, that
// strands them. Fixed by mirroring GuidedSheet's own cancel contract exactly
// (optional `onCancel`, an always-rendered Cancel control using the same
// reused `pad.sheet.cancel` key and the same quiet dashed styling) rather
// than inventing a second pattern.
// ---------------------------------------------------------------------------

describe("SwapSheet — cancel (defect fix)", () => {
  const s = squad([member({ personId: "a", onField: true }), member({ personId: "b", onField: false })]);
  const names = { a: "Player A", b: "Player B" };

  it("the off step renders a real >=44px Cancel control that fires onCancel, never onSwap", () => {
    let cancelled = false;
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
      onCancel: () => {
        cancelled = true;
      },
    });
    const cancelButton = buttonsOf(island.tree()).find((b) => textOf(b) === "pad.sheet.cancel")!;
    expect(cancelButton).toBeDefined();
    expect(propsOf(cancelButton).style).toMatchObject({ minHeight: 44 });

    click(cancelButton);
    expect(cancelled).toBe(true);
    expect(swapped).toBeNull();
  });

  it("the on step ALSO renders a Cancel control, reachable after an off pick has already been made", () => {
    let cancelled = false;
    const island = renderIsland(SwapSheet, {
      spec: swapSpec,
      view: { squad: s },
      policyVerdict: { ok: true },
      personNames: names,
      t,
      onSwap: () => {},
      onCancel: () => {
        cancelled = true;
      },
    });
    const offCandidate = buttonsOf(island.tree()).find((b) => textOf(b) === "Player A")!;
    click(offCandidate); // -> on step

    const cancelButton = buttonsOf(island.tree()).find((b) => textOf(b) === "pad.sheet.cancel")!;
    expect(cancelButton).toBeDefined();
    expect(propsOf(cancelButton).style).toMatchObject({ minHeight: 44 });

    click(cancelButton);
    expect(cancelled).toBe(true);
  });

  it("cancelling from the on step clears the pending off pick — back to a fresh off step, no half-made swap left in state", () => {
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
      onCancel: () => {},
    });
    const offCandidate = buttonsOf(island.tree()).find((b) => textOf(b) === "Player A")!;
    click(offCandidate); // -> on step, "a" pending as the off pick
    expect(island.text()).toContain("Player A"); // the violet "off chosen" header chip

    const cancelButton = buttonsOf(island.tree()).find((b) => textOf(b) === "pad.sheet.cancel")!;
    click(cancelButton);

    const afterCancel = buttonsOf(island.tree());
    // "Player A" itself still legitimately appears (it is the off-step's
    // own onfield candidate button) — the real tell for "still stuck on
    // the on step" is the bench candidate "Player B", which only renders
    // once a step past the off pick. 2 (not 3, the on-step's own count
    // with a real bench candidate — the earlier test above) plus no
    // "Player B" together prove offId truly went back to null, not just
    // that onCancel fired while the on-step stayed rendered underneath.
    expect(afterCancel).toHaveLength(2); // back to the off step: 1 candidate ("a") + Cancel
    expect(afterCancel.some((b) => textOf(b) === "Player B")).toBe(false); // never a stale on-step
    expect(swapped).toBeNull(); // never finalized by a cancel
  });
});

// ---------------------------------------------------------------------------
// R2c — candidate narrowing on the context strip. TWO operations, because
// there are two causes (design: `R2c-task1-design.md` §3.0):
//
//   SCOPE       `candidates` — the person is not in question at all (a batter
//               in a bowler picker). Removed; nobody expects them and eleven
//               greyed names is noise at 320px.
//   ELIGIBILITY `blocked`    — in scope but blocked right now. Kept VISIBLE,
//               disabled, and REASONED, which is R2b's binding "visible,
//               blocked, and REASONED — not removed" ruling (_INDEX.md,
//               2026-08-17) applied to a candidate list instead of a tile.
// ---------------------------------------------------------------------------

describe("ContextStrip — R2c scope narrowing (ContextSlot.candidates)", () => {
  const bothSquads = squad([
    member({ personId: "kannan", onField: true }),
    member({ personId: "arjun", onField: true }),
    member({ personId: "root", onField: true }),
  ]);
  const names = { kannan: "Kannan", arjun: "Arjun", root: "Root" };

  function open(slot: Record<string, unknown>) {
    const island = renderIsland(ContextStrip, {
      spec: { slots: [{ id: "bowler", label: "pad.context.bowler", pool: "onfield", required: true, ...slot }] },
      view: { squad: bothSquads },
      personNames: names,
      t,
      onSelect: () => {},
    });
    click(buttonsOf(island.tree())[0]!);
    return island;
  }

  it("candidates SUPERSEDES pool entirely — the same contract SheetPersonStep.candidates already ships", () => {
    const island = open({ candidates: ["arjun"] });
    const picker = buttonsOf(island.tree()).slice(1);
    expect(picker.map((b) => textOf(b))).toEqual(["Arjun"]);
  });

  it("an EMPTY candidates list means nobody is eligible — it must not fall back to the pool", () => {
    // The `""`-vs-absent trap ContextSlot.message already hit (R2b review
    // item 3): "no candidates" and "no narrowing" are different states.
    const island = open({ candidates: [] });
    expect(buttonsOf(island.tree()).slice(1)).toHaveLength(0);
    expect(island.text()).toContain("scorepad.attribution.noRoster");
  });

  it("absent candidates keeps today's pool behaviour exactly — every pre-R2c slot is unchanged", () => {
    const island = open({});
    expect(buttonsOf(island.tree()).slice(1).map((b) => textOf(b))).toEqual(["Kannan", "Arjun", "Root"]);
  });
});

describe("ContextStrip — R2c eligibility blocking (ContextSlot.blocked)", () => {
  const bowlingSide = squad([
    member({ personId: "kannan", onField: true }),
    member({ personId: "arjun", onField: true }),
  ]);
  const names = { kannan: "Kannan", arjun: "Arjun" };

  function open(slot: Record<string, unknown>, onSelect: (s: string, p: string) => void = () => {}) {
    const island = renderIsland(ContextStrip, {
      spec: { slots: [{ id: "bowler", label: "pad.context.bowler", pool: "onfield", required: true, ...slot }] },
      view: { squad: bowlingSide },
      personNames: names,
      t,
      onSelect,
    });
    click(buttonsOf(island.tree())[0]!);
    return island;
  }

  it("a blocked candidate is still RENDERED — removed is the wrong answer, per R2b's ruling", () => {
    const island = open({ blocked: { kannan: "Kannan bowled the last over." } });
    const ids = buttonsOf(island.tree())
      .slice(1)
      .map((b) => propsOf(b)["data-candidate-id"]);
    expect(ids).toEqual(["kannan", "arjun"]);
  });

  it("a blocked candidate is a real native disabled button and does NOT fire onSelect", () => {
    let picked: string | null = null;
    const island = open({ blocked: { kannan: "Kannan bowled the last over." } }, (_s, p) => {
      picked = p;
    });
    const kannan = buttonsOf(island.tree()).find((b) => propsOf(b)["data-candidate-id"] === "kannan")!;
    expect(propsOf(kannan).disabled).toBe(true);
    // No handler at all, not merely a dimmed control: there is nothing for a
    // tap to invoke, so onSelect cannot fire however the button is reached.
    expect(propsOf(kannan).onClick).toBeUndefined();
    expect(picked).toBeNull();
  });

  it("the reason renders as VISIBLE TEXT, never a title/tooltip — this is a touch-first surface", () => {
    const island = open({ blocked: { kannan: "Kannan bowled the last over." } });
    expect(island.text()).toContain("Kannan bowled the last over.");
    const kannan = buttonsOf(island.tree()).find((b) => propsOf(b)["data-candidate-id"] === "kannan")!;
    expect(propsOf(kannan).title).toBeUndefined();
  });

  it("carries stable data-* hooks a Playwright spec can assert on without reading styling", () => {
    const island = open({ blocked: { kannan: "Kannan bowled the last over." } });
    const picker = buttonsOf(island.tree()).slice(1);
    const kannan = picker.find((b) => textOf(b).includes("Kannan"))!;
    const arjun = picker.find((b) => textOf(b).includes("Arjun"))!;
    expect(textOf(kannan)).toContain("Kannan bowled the last over.");
    expect(propsOf(kannan)["data-candidate-id"]).toBe("kannan");
    expect(propsOf(arjun)["data-candidate-id"]).toBe("arjun");
    expect(propsOf(kannan)["data-blocked"]).toBe("true");
    expect(propsOf(arjun)["data-blocked"]).toBeUndefined();
  });

  it("an unblocked candidate still selects normally while a sibling is blocked", () => {
    let picked: string | null = null;
    const island = open({ blocked: { kannan: "nope" } }, (_s, p) => {
      picked = p;
    });
    click(buttonsOf(island.tree()).find((b) => propsOf(b)["data-candidate-id"] === "arjun")!);
    expect(picked).toBe("arjun");
  });

  it("a blocked key naming someone out of SCOPE is ignored, not an error — the two operations compose", () => {
    const island = open({ candidates: ["arjun"], blocked: { kannan: "not even offered" } });
    const picker = buttonsOf(island.tree()).slice(1);
    expect(picker.map((b) => propsOf(b)["data-candidate-id"])).toEqual(["arjun"]);
    expect(island.text()).not.toContain("not even offered");
  });
});
