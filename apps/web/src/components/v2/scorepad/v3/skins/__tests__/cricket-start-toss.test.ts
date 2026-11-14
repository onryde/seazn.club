// Quick match cricket (decision log 2026-11-13): a guest scores a cricket match with toss, over summaries, innings totals
// and closes (bands 0–1). The engine takes a toss only before `core.start` ("toss must precede core.start", the fold's own
// WRONG_PHASE), and the remote pad mounts the live pad only once the match has started, so its "pre" Toss tile is never on
// screen there. The quick match pad therefore asks the toss AS PART OF STARTING, the way tennis asks "Who serves first?"
// (S2-7): "Who won the toss?", then "Bat or bowl?", then the toss and the Start (`runTossThenStart`). Only a quick match
// pad asks it (`quickMatchToss`): the console mounts its pad before the Start and keeps its own Toss tile, and an organiser's
// remote pad is unchanged.
//
// Every state is a REAL fold of the public cricket module with a quick match's own seats (two name-only sides): which side
// bats first is the ENGINE's answer to the toss the chips build, never this file's.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { foldMatch, type EventEnvelope, type LineupPair } from "@seazn/engine/core";
import { cricketPadRules } from "@seazn/engine/pad";
import { cricket } from "@seazn/engine/sports/cricket";
import { makeEnvelope } from "@seazn/engine/testkit";
import uiEn from "@/dictionaries/en/ui.json";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { ChoiceDock } from "../../detail-dock";
import { StartTossQuestion, useStartWithToss, type StartWithTossInput } from "../../start-match-control";
import type { DockChip, DockSpec } from "../../types";
import { cricketTossElectedQuestion, cricketTossOpen, cricketTossWonQuestion } from "../cricket-start-toss";

const en = uiEn as Record<string, string>;
const t = (key: string) => key;
const HOME = { id: "H", name: "Falcons" };
const AWAY = { id: "A", name: "Kites" };
const NAMELESS: LineupPair = { home: { entrantId: "H", slots: [] }, away: { entrantId: "A", slots: [] } };
const CFG = cricket.configSchema.parse(cricket.variants.t20);
type Ev = { type: string; payload: Record<string, unknown>; voids?: string };
const envelopes = (events: readonly Ev[]): EventEnvelope[] =>
  events.map((e, i) => makeEnvelope(i, { type: e.type, payload: e.payload } as never, e.voids));
const fold = (events: readonly Ev[]) => foldMatch(cricket, CFG, NAMELESS, envelopes(events)) as unknown as Record<string, unknown>;
const toss = (wonBy: string, elected: string): Ev => ({ type: "cricket.toss", payload: { wonBy, elected } });
const START: Ev = { type: "core.start", payload: {} };

describe("cricketTossOpen: does Start still owe the toss?", () => {
  it("the empty case first: an empty /state (null) and a fresh pre-start fold both owe it", () => {
    expect(cricketTossOpen(null)).toBe(true);
    expect(cricketTossOpen(undefined)).toBe(true);
    expect(cricketTossOpen(fold([]))).toBe(true);
  });
  it("a held toss is not asked again; a voided one is", () => {
    expect(cricketTossOpen(fold([toss("A", "bowl")]))).toBe(false);
    expect(cricketTossOpen(fold([toss("A", "bowl"), { type: "core.void", payload: {}, voids: "e-0" }]))).toBe(true);
  });
  it("a started match is never asked: the engine refuses a toss after the Start", () => {
    expect(cricketTossOpen(fold([START]))).toBe(false);
    expect(() => foldMatch(cricket, CFG, NAMELESS, envelopes([START, toss("A", "bat")]))).toThrow(/toss must precede core.start/);
  });
});

describe("the two questions", () => {
  it("'Who won the toss?' names both sides as typed, home first; 'Bat or bowl?' offers the engine's own elections", () => {
    const won = cricketTossWonQuestion(HOME, AWAY, t);
    expect(won.title).toBe("pad.cricket.sheet.toss.wonBy.title");
    expect(won.requires).toBe("wonBy");
    expect(won.chips.map((c) => c.labelText)).toEqual(["Falcons", "Kites"]);
    expect(won.chips.map((c) => c.mutate({}))).toEqual([{ wonBy: "H" }, { wonBy: "A" }]);
    const elected = cricketTossElectedQuestion(t);
    expect(elected.title).toBe("pad.cricket.sheet.toss.elected.title");
    expect(elected.requires).toBe("elected");
    expect(cricketPadRules.tossElections.length, "premise: the engine declares the elections").toBeGreaterThan(0);
    expect(elected.chips.map((c) => c.id)).toEqual([...cricketPadRules.tossElections]);
    for (const c of [...won.chips, ...elected.chips]) {
      expect(en[c.label], `${c.id}: ${c.label} is an English key`).toBeTruthy();
    }
  });
});

describe("useStartWithToss / StartTossQuestion: the quick match cricket Start", () => {
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
      return new Promise<void>((resolve) => {
        settle = resolve;
      });
    });
    const island = renderIsland(Page, { sportKey: "cricket", state: null, quickMatchToss: true, onStart, onTossThenStart, ...over });
    const startButton = () => island.tree().find((el) => el.type === "button" && propsOf(el)["data-testid"] === "score-start-match");
    const question = () => island.tree().find((el) => el.type === StartTossQuestion);
    const dock = () => {
      const el = question();
      expect(el, "the question is up").toBeDefined();
      const rendered = StartTossQuestion(el!.props as Parameters<typeof StartTossQuestion>[0]);
      expect(propsOf(rendered)["data-testid"]).toBe("score-start-toss");
      const d = (rendered.props as { children: ReturnType<typeof createElement> }).children;
      expect(d.type).toBe(ChoiceDock);
      return { spec: propsOf(d).spec as DockSpec, choose: propsOf(d).onChoose as (c: DockChip) => void, cancel: propsOf(d).onCancel as () => void, key: d.key };
    };
    const press = () => (propsOf(startButton()!).onClick as () => void)();
    return { onStart, onTossThenStart, sent, startButton, question, dock, press, settle: () => settle() };
  }

  it("Start asks who won, then bat or bowl, and the answers send ONE toss the real fold seats", async () => {
    const c = page();
    c.press();
    expect(c.onStart).not.toHaveBeenCalled();
    const first = c.dock();
    expect(first.spec.title).toBe("pad.cricket.sheet.toss.wonBy.title");
    first.choose(first.spec.chips[1]!); // Kites won
    expect(c.sent, "the first answer sends nothing").toEqual([]);
    const second = c.dock();
    expect(second.spec.title).toBe("pad.cricket.sheet.toss.elected.title");
    expect(second.key, "a fresh dock for the second question (its own single claim)").not.toBe(first.key);
    second.choose(second.spec.chips.find((x) => x.id === "bowl")!);
    expect(c.sent).toEqual([{ type: "cricket.toss", payload: { wonBy: "A", elected: "bowl" } }]);
    // The engine's answer: Kites won and bowled, so the Falcons bat first. The other election flips it (witness).
    expect(fold([c.sent[0]! as Ev, START]).battingFirst).toBe("home");
    expect(fold([toss("A", "bat"), START]).battingFirst).toBe("away");
    expect(c.startButton(), "mid-sequence the question stays up").toBeUndefined();
    c.settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(c.startButton(), "once both writes settle the button is back").toBeDefined();
    expect(c.onTossThenStart).toHaveBeenCalledTimes(1);
    expect(c.onStart).not.toHaveBeenCalled();
  });

  it("Cancel on the second question sends nothing, and the next Start asks from the first question again", () => {
    const c = page();
    c.press();
    const first = c.dock();
    first.choose(first.spec.chips[0]!);
    c.dock().cancel();
    expect(c.startButton()).toBeDefined();
    expect(c.onTossThenStart).not.toHaveBeenCalled();
    c.press();
    expect(c.dock().spec.title, "a second Start starts over").toBe("pad.cricket.sheet.toss.wonBy.title");
  });

  it("a held toss: Start only starts", () => {
    const c = page({ state: fold([toss("H", "bat")]) });
    c.press();
    expect(c.onStart).toHaveBeenCalledTimes(1);
    expect(c.question()).toBeUndefined();
  });

  it("not a quick match pad (the console, an organiser's remote pad): the plain Start, as before", () => {
    const c = page({ quickMatchToss: undefined });
    c.press();
    expect(c.onStart).toHaveBeenCalledTimes(1);
    expect(c.question()).toBeUndefined();
    expect(c.onTossThenStart).not.toHaveBeenCalled();
  });

  it("another sport with the flag on: unchanged (tennis still asks its own question, badminton just starts)", () => {
    const b = page({ sportKey: "badminton" });
    b.press();
    expect(b.onStart).toHaveBeenCalledTimes(1);
    const tn = page({ sportKey: "tennis" });
    tn.press();
    expect(tn.dock().spec.title).toBe("pad.tennis.start.toss.title");
  });
});

// Whole review I-1 (2026-11-14): the device page resyncs `/state` after the toss write lands and before the Start settles.
// The question is still up (its answer marked), but the fold now holds the toss, so a kind read off it live fell through
// to tennis: "Who serves first?" over the cricket pad, a fresh dock (new key, new claim) whose tap posted a tennis toss to
// a cricket match. The kind is frozen at the press: the question on screen is the one the scorer answered.
describe("the question on screen stays the one the press asked (whole review I-1)", () => {
  const msg = (key: string) => key;
  function Page(props: StartWithTossInput) {
    const start = useStartWithToss(props);
    return start.asking
      ? createElement(StartTossQuestion, { home: HOME, away: AWAY, msg, start })
      : createElement("button", { type: "button", "data-testid": "score-start-match", onClick: start.press }, "Start match");
  }
  function harness(sportKey: string) {
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    let settle: () => void = () => {};
    const base: StartWithTossInput = {
      sportKey,
      state: null,
      quickMatchToss: true,
      onStart: vi.fn(),
      onTossThenStart: (tossEvent) => {
        sent.push(tossEvent);
        return new Promise<void>((r) => {
          settle = r;
        });
      },
    };
    const island = renderIsland(Page, base);
    const dock = () => {
      const el = island.tree().find((e) => e.type === StartTossQuestion);
      if (!el) return null;
      const r = StartTossQuestion(el.props as Parameters<typeof StartTossQuestion>[0]);
      const d = (r.props as { children: ReturnType<typeof createElement> }).children;
      return { spec: propsOf(d).spec as DockSpec, key: d.key, choose: propsOf(d).onChoose as (c: DockChip) => void };
    };
    const press = () => (propsOf(island.tree().find((e) => e.type === "button")!).onClick as () => void)();
    return { island, base, sent, dock, press, settle: () => settle() };
  }

  it("cricket: the toss lands and /state resyncs mid-sequence; the question stays 'Bat or bowl?', never tennis's", async () => {
    const h = harness("cricket");
    h.press();
    const won = h.dock()!;
    won.choose(won.spec.chips[1]!);
    const elected = h.dock()!;
    elected.choose(elected.spec.chips.find((x) => x.id === "bat")!);
    expect(h.sent).toEqual([{ type: "cricket.toss", payload: { wonBy: "A", elected: "bat" } }]);
    // The resync: the fold now holds the toss (so the live reading owes none), the Start not yet.
    const resynced = fold([toss("A", "bat")]);
    expect(cricketTossOpen(resynced), "premise: the resynced fold owes no toss").toBe(false);
    h.island.rerender({ ...h.base, state: resynced });
    const after = h.dock();
    expect(after, "the question is still up until the writes settle").not.toBeNull();
    expect(after!.spec.title).toBe("pad.cricket.sheet.toss.elected.title");
    expect(after!.spec.title).not.toBe("pad.tennis.start.toss.title");
    expect(after!.key, "the same dock, so its one claim still holds").toBe(elected.key);
    expect(h.sent, "nothing more sent").toHaveLength(1);
    h.settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.dock(), "settled: the button is back").toBeNull();
  });
});

describe("only the quick match pad asks (the seam, read in the source)", () => {
  // The harness cannot mount either page; the e2e cricket leg (e2e/mobile/quick-match.spec.ts) drives the remote pad.
  const read = (rel: string) => readFileSync(resolve(import.meta.dirname, rel), "utf8");
  it("the remote pad passes its quick match flag; the console passes none", () => {
    expect(read("../../../../device-score-pad.tsx")).toMatch(/useStartWithToss\(\{[^;]*quickMatchToss: quickMatch,\n\s*\}\);/);
    const console_ = read("../../../../fixture-console.tsx");
    expect(console_, "premise: the console mounts the Start hook").toContain("useStartWithToss({");
    expect(console_).not.toContain("quickMatchToss");
  });
});
