// Match Day PB1 item 3 (owner 2026-11-02): a FINISHED round of a stage card is one bar - the bar is the toggle - and the current and the
// upcoming rounds are open. Applies to every round-sequence kind that draws bars (league, groups, Swiss, Americano); the ladder draws no
// bars and a bracket's bars are named rounds of one tree, so neither folds. Node env, no DOM (AGENTS.md class 2): the DEFAULT is read off the
// real `RunSheet` the stage card mounts (static markup, fed by `buildRunSheet`'s own blocks); the TAP is driven through the hook harness,
// which hands back `RoundBar`'s props (its `toggle.onToggle` is the click). The pixels - the bar a thumb can hit, the list that is really
// gone - are the e2e's (`e2e/stage-card-c3.spec.ts`, `e2e/mobile.spec.ts`).
//
// Expected values come from the engine's own kind declarations (`StageKind`, `ROUND_SEQUENCE_STAGE_KINDS`, `BRACKET_STAGE_KINDS`) and the
// app's status declarations - never a list typed here. Every sweep reports its count and zero is a failure (TEST-STRATEGY).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { StageKind } from "@seazn/engine/core";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import { RunSheet, type RunSheetFilter } from "@/components/v2/desk/run-sheet";
import { BRACKET_STAGE_KINDS, ROUND_SEQUENCE_STAGE_KINDS, buildRunSheet, type RunSheetFixture } from "@/lib/run-sheet-groups";
import enUi from "@/dictionaries/en/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));

const TZ = "UTC";
const DAY = "2026-09-05";
const NOW_MS = Date.UTC(2026, 8, 5, 12, 0, 0);
const DECIDED = { kind: "win", winner: "e1" };

function fx(no: number, round: number, o: Partial<RunSheetFixture> = {}): RunSheetFixture {
  return {
    id: `f${no}`,
    stage_id: "s1",
    fixture_no: no,
    round_no: round,
    seq_in_round: no,
    scheduled_at: `${DAY}T14:00:00.000Z`,
    status: "scheduled",
    court_name: null,
    court_id: null,
    venue_name: null,
    officials: [],
    outcome: null,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    home_slot_label: null,
    away_slot_label: null,
    lane: null,
    is_final: false,
    third_place: false,
    conditional: false,
    ext_key: null,
    ...o,
  };
}
/** A settled match in a round (a result is in). */
const played = (no: number, round: number, at = `${DAY}T09:00:00.000Z`) => fx(no, round, { status: "decided", outcome: DECIDED, scheduled_at: at });

type Stage = { id: string; seq: number; kind: string; name: string };
const stage = (kind: string): Stage[] => [{ id: "s1", seq: 1, kind, name: "Stage" }];

function propsFor(fixtures: RunSheetFixture[], kind: string, o: { awaitingSettle?: string[]; filter?: RunSheetFilter } = {}) {
  const stages = stage(kind);
  return {
    blocks: buildRunSheet({ fixtures, stages, tz: TZ, nowMs: NOW_MS }),
    stages,
    tz: TZ,
    orgTz: TZ,
    nowMs: NOW_MS,
    matchMinutes: 60,
    entrantNames: { e1: "Alpha", e2: "Bravo" },
    canEdit: true,
    hrefFor: (f: RunSheetFixture) => `/f/${f.fixture_no}`,
    filter: o.filter ?? ("all" as RunSheetFilter),
    onFilter: () => {},
    stageId: "s1",
    embedded: true,
    awaitingSettle: o.awaitingSettle,
  };
}
function sheet(fixtures: RunSheetFixture[], kind: string, o: { awaitingSettle?: string[]; filter?: RunSheetFilter } = {}): string {
  return renderToStaticMarkup(
    <DictProvider dict={enUi as Record<string, string>} locale="en">
      <RunSheet {...propsFor(fixtures, kind, o)} />
    </DictProvider>,
  );
}

/** Each round's toggle as the page marks it: `aria-expanded` and the list it controls. */
function toggles(html: string): { expanded: string; controls: string }[] {
  return [...html.matchAll(/<button[^>]*data-testid="run-sheet-round-toggle"[^>]*>/g)].map((m) => ({
    expanded: /aria-expanded="(true|false)"/.exec(m[0])?.[1] ?? "?",
    controls: /aria-controls="([^"]*)"/.exec(m[0])?.[1] ?? "?",
  }));
}
/** Is the list with this id drawn with the `hidden` attribute? (`null`: no such list.) */
function listHidden(html: string, id: string): boolean | null {
  const tag = new RegExp(`<ul[^>]*\\sid="${id}"[^>]*>`).exec(html)?.[0];
  return tag === undefined ? null : /\shidden(=""|\s|>)/.test(tag);
}
const nowRules = (html: string): number => html.split('data-testid="run-sheet-now"').length - 1;
/** Does a NOW rule sit inside a list drawn hidden? (it would be invisible - the rule must not be lost to a fold) */
function nowInsideHidden(html: string): boolean {
  return [...html.matchAll(/<ul[^>]*\shidden=""[^>]*>([\s\S]*?)<\/ul>/g)].some((m) => m[1]!.includes('data-testid="run-sheet-now"'));
}

/** Round 1 finished, round 2 running (one result in, one to come) and round 3 not started: the shape every sweep below reads. */
const THREE_ROUNDS = (): RunSheetFixture[] => [
  played(1, 1),
  played(2, 1),
  played(3, 2, `${DAY}T10:00:00.000Z`),
  fx(4, 2, { scheduled_at: `${DAY}T15:00:00.000Z` }),
  fx(5, 3, { scheduled_at: `${DAY}T16:00:00.000Z` }),
];

describe("PB1 item 3: a finished round starts folded, the current and upcoming rounds open", () => {
  it("the empty case first: a stage with no rows draws no bar, no toggle and no list", () => {
    const html = sheet([], "league");
    expect(html).toBe("");
  });

  it("a finished round is folded, the one being played and the one to come are open - and each toggle names the list it controls", () => {
    const html = sheet(THREE_ROUNDS(), "league");
    const t = toggles(html);
    expect(t.map((x) => x.expanded), "round 1 folded, rounds 2 and 3 open").toEqual(["false", "true", "true"]);
    expect(t.map((x) => x.controls)).toEqual(["run-sheet-rounds-s1-1", "run-sheet-rounds-s1-2", "run-sheet-rounds-s1-3"]);
    expect(listHidden(html, "run-sheet-rounds-s1-1"), "the folded round's list is drawn hidden").toBe(true);
    expect(listHidden(html, "run-sheet-rounds-s1-2")).toBe(false);
    expect(listHidden(html, "run-sheet-rounds-s1-3")).toBe(false);
    // The bar of a folded round still says what happened in it - that is the point of keeping one line.
    expect(html).toContain((enUi as Record<string, string>)["runsheet.round.done.other"]!.replace("{done}", "2").replace("{total}", "2"));
  });

  it("sweep every kind that draws bars: the finished round folds in each, and no other round does", () => {
    let checked = 0;
    for (const kind of ROUND_SEQUENCE_STAGE_KINDS) {
      const html = sheet(THREE_ROUNDS(), kind);
      expect(toggles(html).map((x) => x.expanded), kind).toEqual(["false", "true", "true"]);
      checked++;
    }
    expect(checked, "anti-vacuity: the kinds the engine declares as round sequences").toBe(ROUND_SEQUENCE_STAGE_KINDS.size);
    expect(checked).toBeGreaterThan(0);
  });

  it("the kinds that do not fold: a bracket's named rounds and the ladder's flat list draw no toggle, even when everything is settled", () => {
    const allSettled = [played(1, 1), played(2, 2)];
    let checked = 0;
    for (const kind of StageKind.options) {
      if (ROUND_SEQUENCE_STAGE_KINDS.has(kind)) continue;
      const html = sheet(allSettled, kind);
      expect(toggles(html), `${kind}: no toggle`).toEqual([]);
      expect(html, `${kind}: nothing is drawn hidden`).not.toMatch(/<ul[^>]*\shidden=""/);
      // The positive pair: the rows are there, so "no toggle" is not "nothing rendered".
      expect(html, `${kind}: the rows are drawn`).toContain('data-fixture-no="1"');
      checked++;
    }
    expect(checked, "every other kind swept").toBe(StageKind.options.length - ROUND_SEQUENCE_STAGE_KINDS.size);
    expect(StageKind.options.some((k) => BRACKET_STAGE_KINDS.has(k)), "premise: brackets are among them").toBe(true);
    expect(StageKind.options.includes("ladder"), "premise: so is the ladder").toBe(true);
  });

  it("a round with one match still to play is open; the same round with that match settled is folded (the sequence)", () => {
    const before = sheet([played(1, 1), fx(2, 1, { status: "in_play" })], "league");
    expect(toggles(before).map((x) => x.expanded)).toEqual(["true"]);
    const after = sheet([played(1, 1), played(2, 1)], "league");
    expect(toggles(after).map((x) => x.expanded)).toEqual(["false"]);
  });

  it("a match held for its settle keeps its round open, and the round folds once the verdict is in", () => {
    const rows = [played(1, 1), fx(2, 1, { status: "abandoned" })];
    expect(toggles(sheet(rows, "league", { awaitingSettle: ["f2"] })).map((x) => x.expanded), "held: still owed").toEqual(["true"]);
    expect(toggles(sheet(rows, "league")).map((x) => x.expanded), "settled").toEqual(["false"]);
  });

  it("a walkover and a cancellation are settled: a round of them folds", () => {
    const rows = [
      fx(1, 1, { status: "forfeited", outcome: { kind: "award", winner: "e1", loser: "e2", reason: "walkover" } }),
      fx(2, 1, { status: "cancelled" }),
    ];
    expect(toggles(sheet(rows, "league")).map((x) => x.expanded)).toEqual(["false"]);
  });
});

describe("PB1 item 3: the NOW line survives a folded round", () => {
  it("round 1 finished earlier today and round 2 to come later today: ONE rule, in the open round 2, before its first row", () => {
    const html = sheet(THREE_ROUNDS(), "league");
    expect(nowRules(html), "exactly one NOW rule").toBe(1);
    expect(nowInsideHidden(html), "and not inside a hidden list").toBe(false);
    const nowAt = html.indexOf('data-testid="run-sheet-now"');
    expect(nowAt, "after round 2's list opens").toBeGreaterThan(html.indexOf('id="run-sheet-rounds-s1-2"'));
    expect(nowAt, "before round 2's pending row").toBeLessThan(html.indexOf('data-fixture-no="4"'));
  });

  it("everything today is in the finished round, the next round is another day: the rule is drawn under the folded bar, not lost inside it", () => {
    const rows = [played(1, 1, `${DAY}T09:00:00.000Z`), played(2, 1, `${DAY}T10:00:00.000Z`), fx(3, 2, { scheduled_at: "2026-09-06T10:00:00.000Z" })];
    const html = sheet(rows, "league");
    expect(toggles(html).map((x) => x.expanded), "premise: round 1 folded").toEqual(["false", "true"]);
    expect(nowRules(html), "exactly one NOW rule").toBe(1);
    expect(nowInsideHidden(html), "the rule is not inside the hidden list").toBe(false);
    const nowAt = html.indexOf('data-testid="run-sheet-now"');
    expect(nowAt, "after round 1's bar").toBeGreaterThan(html.indexOf('data-testid="run-sheet-round-toggle"'));
    expect(nowAt, "before round 2's bar").toBeLessThan(html.indexOf('id="run-sheet-rounds-s1-2"'));
  });

  it("the rule's row is itself in the folded round (settled early, its slot is still ahead of the clock): still ONE rule, under the bar", () => {
    // Both matches are decided but their slots are 14:00 and 15:00 and it is 12:00: the clock's "first row still to come" is round 1's own
    // first row. The folded round must neither lose the rule nor draw it twice (once under the bar, once before the hidden row).
    const rows = [played(1, 1, `${DAY}T14:00:00.000Z`), played(2, 1, `${DAY}T15:00:00.000Z`), fx(3, 2, { scheduled_at: "2026-09-06T10:00:00.000Z" })];
    const html = sheet(rows, "league");
    expect(toggles(html).map((x) => x.expanded), "premise: round 1 folded").toEqual(["false", "true"]);
    expect(nowRules(html), "exactly one NOW rule").toBe(1);
    expect(nowInsideHidden(html), "not inside the hidden list").toBe(false);
  });

  it("nothing timed today: no rule, folded or not (the same as before)", () => {
    const rows = [played(1, 1, "2026-09-01T09:00:00.000Z"), fx(2, 2, { scheduled_at: "2026-09-09T09:00:00.000Z" })];
    expect(nowRules(sheet(rows, "league"))).toBe(0);
  });

  it("the sweep: for every kind that folds, the rule appears exactly once and never in a hidden list", () => {
    let checked = 0;
    for (const kind of ROUND_SEQUENCE_STAGE_KINDS) {
      const html = sheet(THREE_ROUNDS(), kind);
      expect(nowRules(html), kind).toBe(1);
      expect(nowInsideHidden(html), kind).toBe(false);
      checked++;
    }
    expect(checked).toBe(ROUND_SEQUENCE_STAGE_KINDS.size);
  });
});

describe("PB1 item 3: the bar is the toggle - a tap opens and closes it, and the choice is kept", () => {
  /** `RoundBar` is a nested component (the harness expands one level), so its element - and the props the tap lives in - is found by its
   *  `toggle` prop. */
  const bars = (island: { tree: () => ReactElement[] }) => island.tree().filter((el) => propsOf(el).toggle !== undefined);
  const barOpen = (island: { tree: () => ReactElement[] }) => bars(island).map((el) => (propsOf(el).toggle as { open: boolean }).open);
  const tap = (island: { tree: () => ReactElement[] }, i: number) => (propsOf(bars(island)[i]!).toggle as { onToggle: () => void }).onToggle();
  const listHiddenFlags = (island: { tree: () => ReactElement[] }) =>
    island
      .tree()
      .filter((el) => el.type === "ul" && typeof propsOf(el).id === "string" && String(propsOf(el).id).startsWith("run-sheet-rounds-"))
      .map((el) => propsOf(el).hidden === true);

  it("opens a folded round and folds it again, any number of times; the list follows the bar", () => {
    const island = renderIsland(RunSheet, propsFor(THREE_ROUNDS(), "league") as never);
    expect(barOpen(island), "default").toEqual([false, true, true]);
    expect(listHiddenFlags(island)).toEqual([true, false, false]);
    const seen: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      tap(island, 0);
      seen.push(barOpen(island)[0]!);
      expect(listHiddenFlags(island)[0], "opened: its list shows").toBe(false);
      tap(island, 0);
      seen.push(barOpen(island)[0]!);
      expect(listHiddenFlags(island)[0], "folded: its list is hidden").toBe(true);
    }
    expect(seen).toEqual([true, false, true, false, true, false]);
  });

  it("an open round can be folded by hand, and one tap on a round leaves the others alone", () => {
    const island = renderIsland(RunSheet, propsFor(THREE_ROUNDS(), "league") as never);
    tap(island, 1);
    expect(barOpen(island), "round 2 folded, the rest as they were").toEqual([false, false, true]);
    tap(island, 0);
    expect(barOpen(island)).toEqual([true, false, true]);
  });

  it("the choice is kept across the re-render a router refresh brings (same page visit)", () => {
    const island = renderIsland(RunSheet, propsFor(THREE_ROUNDS(), "league") as never);
    tap(island, 0); // open the finished round
    tap(island, 2); // fold the upcoming one
    island.rerender(propsFor(THREE_ROUNDS(), "league") as never);
    expect(barOpen(island)).toEqual([true, true, false]);
  });

  it("a round that finishes on the next render is folded; one nobody touched follows its new default", () => {
    const rows = THREE_ROUNDS();
    const island = renderIsland(RunSheet, propsFor(rows, "league") as never);
    expect(barOpen(island)).toEqual([false, true, true]);
    const settled = rows.map((f) => (f.id === "f4" ? { ...f, status: "decided", outcome: DECIDED } : f));
    island.rerender(propsFor(settled, "league") as never);
    expect(barOpen(island), "round 2 is done now, so folded").toEqual([false, false, true]);
  });

  it("the ladder (no bars) has nothing to tap", () => {
    const island = renderIsland(RunSheet, propsFor([played(1, 1), played(2, 2)], "ladder") as never);
    expect(bars(island)).toEqual([]);
    const lists = listHiddenFlags(island);
    expect(lists.length, "positive pair: the ladder's one flat list is drawn").toBe(1);
    expect(lists.some(Boolean), "and never hidden").toBe(false);
  });
});
