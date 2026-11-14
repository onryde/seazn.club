// Quick match carrom (whole review m6, controller PO rec 2026-11-14): a guest's remote pad mounts only after the Start, and
// the engine takes `carrom.toss` only before it, so the skin's pre-match Toss tile is never on screen there and the home
// side broke first in every game one. A quick match pad asks "Who breaks first?" AS PART OF STARTING, the way it asks
// cricket's toss (`cricket-start-toss.ts`), and the answer sends the toss and then the Start.
//
// Every state is a REAL fold of the public carrom module with a quick match's own seats (two name-only sides): who breaks
// first is the ENGINE's answer to the toss the chip builds, never this file's.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { foldMatch, type EventEnvelope, type LineupPair } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { makeEnvelope } from "@seazn/engine/testkit";
import uiEn from "@/dictionaries/en/ui.json";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { ChoiceDock } from "../../detail-dock";
import { StartTossQuestion, useStartWithToss, type StartWithTossInput } from "../../start-match-control";
import type { DockChip, DockSpec } from "../../types";
import { carromTossEvent, carromTossOpen, carromTossQuestion } from "../carrom-start-toss";

const en = uiEn as Record<string, string>;
const HOME = { id: "H", name: "Strikers" };
const AWAY = { id: "A", name: "Queens" };
const NAMELESS: LineupPair = { home: { entrantId: "H", slots: [] }, away: { entrantId: "A", slots: [] } };
const carrom = (builtinModules as readonly AnySportModule[]).find((m) => m.key === "carrom")!;
const CFG = carrom.configSchema.parse({});
type Ev = { type: string; payload: Record<string, unknown>; voids?: string };
const envelopes = (events: readonly Ev[]): EventEnvelope[] =>
  events.map((e, i) => makeEnvelope(i, { type: e.type, payload: e.payload } as never, e.voids));
const fold = (events: readonly Ev[]) => foldMatch(carrom as never, CFG as never, NAMELESS, envelopes(events)) as unknown as Record<string, unknown>;
const toss = (firstBreak: string): Ev => ({ type: "carrom.toss", payload: { firstBreak } });
const START: Ev = { type: "core.start", payload: {} };

describe("carromTossOpen: does Start still owe the toss?", () => {
  it("the empty case first: an empty /state (null) and a fresh pre-start fold both owe it", () => {
    expect(carromTossOpen(null)).toBe(true);
    expect(carromTossOpen(undefined)).toBe(true);
    expect(carromTossOpen(fold([]))).toBe(true);
  });
  it("a held toss is not asked again; a voided one is; a started match never is (the engine refuses a toss after it)", () => {
    expect(carromTossOpen(fold([toss("A")]))).toBe(false);
    expect(carromTossOpen(fold([toss("A"), { type: "core.void", payload: {}, voids: "e-0" }]))).toBe(true);
    expect(carromTossOpen(fold([START]))).toBe(false);
    expect(() => foldMatch(carrom as never, CFG as never, NAMELESS, envelopes([START, toss("A")]))).toThrow(/toss must precede core.start/);
  });
});

describe("the question", () => {
  it("'Who breaks first?' (the skin's own Toss sheet title) names both sides as typed, home first", () => {
    const q = carromTossQuestion(HOME, AWAY, (k) => k);
    expect(q.title).toBe("pad.carrom.sheet.toss.firstBreak.title");
    expect(en[q.title]).toBe("Who breaks first?");
    expect(q.requires).toBe("firstBreak");
    expect(q.chips.map((c) => c.labelText)).toEqual(["Strikers", "Queens"]);
    expect(q.chips.map((c) => carromTossEvent(c))).toEqual([
      { type: "carrom.toss", payload: { firstBreak: "H" } },
      { type: "carrom.toss", payload: { firstBreak: "A" } },
    ]);
  });
  it("the engine's answer: the chip's side breaks first; with no toss the home side does (the default the guest could not change)", () => {
    const [home, away] = carromTossQuestion(HOME, AWAY, (k) => k).chips;
    expect(fold([carromTossEvent(away!) as Ev, START]).firstBreak).toBe("away");
    expect(fold([carromTossEvent(home!) as Ev, START]).firstBreak).toBe("home");
    expect(fold([START]).firstBreak, "witness: without the toss, home").toBe("home");
  });
});

describe("useStartWithToss / StartTossQuestion: the quick match carrom Start", () => {
  type Toss = { type: string; payload: Record<string, unknown> };
  const msg = (key: string) => key;
  function Page(props: StartWithTossInput) {
    const start = useStartWithToss(props);
    return start.asking
      ? createElement(StartTossQuestion, { home: HOME, away: AWAY, msg, start })
      : createElement("button", { type: "button", "data-testid": "score-start-match", onClick: start.press }, "Start match");
  }
  function page(over: Partial<StartWithTossInput> = {}) {
    const onStart = vi.fn();
    let settle: () => void = () => {};
    const sent: Toss[] = [];
    const onTossThenStart = vi.fn((tossEvent: Toss) => {
      sent.push(tossEvent);
      return new Promise<void>((r) => {
        settle = r;
      });
    });
    const base: StartWithTossInput = { sportKey: "carrom", state: null, quickMatchToss: true, onStart, onTossThenStart, ...over };
    const island = renderIsland(Page, base);
    const dock = () => {
      const el = island.tree().find((e) => e.type === StartTossQuestion);
      if (!el) return null;
      const rendered = StartTossQuestion(el.props as Parameters<typeof StartTossQuestion>[0]);
      const d = (rendered.props as { children: ReturnType<typeof createElement> }).children;
      expect(d.type).toBe(ChoiceDock);
      return { spec: propsOf(d).spec as DockSpec, key: d.key, choose: propsOf(d).onChoose as (c: DockChip) => void, cancel: propsOf(d).onCancel as () => void };
    };
    const press = () => (propsOf(island.tree().find((e) => e.type === "button")!).onClick as () => void)();
    return { island, base, onStart, onTossThenStart, sent, dock, press, settle: () => settle() };
  }

  it("Start asks who breaks first, and the answer sends ONE toss, then the button comes back once the writes settle", async () => {
    const c = page();
    c.press();
    expect(c.onStart).not.toHaveBeenCalled();
    const q = c.dock()!;
    expect(q.spec.title).toBe("pad.carrom.sheet.toss.firstBreak.title");
    q.choose(q.spec.chips[1]!);
    expect(c.sent).toEqual([{ type: "carrom.toss", payload: { firstBreak: "A" } }]);
    // The resync mid-sequence (whole review I-1): the fold holds the toss now; the question on screen stays carrom's.
    c.island.rerender({ ...c.base, state: fold([toss("A")]) });
    expect(c.dock()!.spec.title).toBe("pad.carrom.sheet.toss.firstBreak.title");
    expect(c.dock()!.key).toBe(q.key);
    c.settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(c.dock(), "settled: the button is back").toBeNull();
    expect(c.onTossThenStart).toHaveBeenCalledTimes(1);
    expect(c.onStart).not.toHaveBeenCalled();
  });

  it("Cancel sends nothing and puts the button back; a held toss only starts", () => {
    const c = page();
    c.press();
    c.dock()!.cancel();
    expect(c.dock()).toBeNull();
    expect(c.onTossThenStart).not.toHaveBeenCalled();
    const held = page({ state: fold([toss("H")]) });
    held.press();
    expect(held.onStart).toHaveBeenCalledTimes(1);
    expect(held.dock()).toBeNull();
  });

  it("not a quick match pad (the console, an organiser's remote pad): the plain Start, as before", () => {
    const c = page({ quickMatchToss: undefined });
    c.press();
    expect(c.onStart).toHaveBeenCalledTimes(1);
    expect(c.dock()).toBeNull();
  });
});

describe("only the quick match pad asks (the seam, read in the source)", () => {
  const read = (rel: string) => readFileSync(resolve(import.meta.dirname, rel), "utf8");
  it("the remote pad passes its quick match flag; the console passes none", () => {
    expect(read("../../../../device-score-pad.tsx")).toMatch(/useStartWithToss\(\{[^;]*quickMatchToss: quickMatch,\n\s*\}\);/);
    expect(read("../../../../fixture-console.tsx")).not.toContain("quickMatchToss");
  });
});
