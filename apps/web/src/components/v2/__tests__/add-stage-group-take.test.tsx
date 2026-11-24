// Add stage after groups (owner Option C, 2026-11-24): the form's "Top N" select gives way to ONE count - "Qualify to the knockout" -
// when the stage it follows plays in two or more groups, with a live line saying the split and the round it makes. Single-group (and
// league, Swiss ...) sources keep today's Top N untouched.
//
// Drives the form's real add() through the hook harness (the network is the one seam replaced; it RECORDS the POST body, so the body the
// form builds is what is asserted - never a builder called from the test). Expected phrases are the en dictionary's, read through `t`,
// never retyped; the bracket arithmetic is derived from powers of two, not from the code under test.
// Pure helpers (`addStageGroupSource`, `groupTakeSummary`, `bracketOf`) are asserted as plain functions.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { t } from "@/lib/i18n-runtime";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import { crossPoolDrawCanRefuse } from "@/lib/cross-pool-draw-risk";
import { buildTemplateStages } from "@/lib/format-templates";

const net = vi.hoisted(() => ({ posts: [] as { url: string; body: Record<string, unknown> }[] }));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: Record<string, unknown> }) => {
      if (options?.method === "POST") net.posts.push({ url, body: options.json ?? {} });
      if (url.endsWith("/generate")) return Promise.resolve({ created: 7 });
      return Promise.resolve({ id: "s9" });
    },
  };
});

import { AddStageForm, addStageGroupSource, addStageProgression } from "@/components/v2/stages-panel";
import { bracketOf, defaultGroupCount, groupCountsFor, GroupTakeField, groupTakeSummary } from "@/components/v2/add-stage-group-take";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const en = (key: string, vars?: Record<string, string | number>) => t(enUi as never, key, vars);

function click(tree: ReactElement[], text: string): void {
  const btn = tree.find((n) => n.type === "button" && textOf(n).trim() === text);
  if (!btn) throw new Error(`no <button> "${text}" - rendered: ${tree.map((n) => textOf(n)).join(" | ")}`);
  (propsOf(btn).onClick as () => void)();
}
const field = (tree: ReactElement[]) => tree.find((n) => n.type === GroupTakeField);
const addButton = (tree: ReactElement[]) => tree.find((n) => n.type === "button" && textOf(n).trim() === en("schedule.addStageBtn"))!;
const qualifySelect = (tree: ReactElement[]) => tree.find((n) => n.type === "select" && (propsOf(n) as { "data-format-bound"?: string })["data-format-bound"] === "qualify");

function mount(groupSource: { pools: number; entrants: number | null } | null) {
  const onDone = vi.fn();
  const island = renderIsland(AddStageForm, { divisionId: "d1", nextSeq: 2, groupSource, onDone, onError: vi.fn(), onPaywall: vi.fn(), onRefresh: vi.fn() } as never);
  click(island.tree(), en("schedule.addStage"));
  return { island, onDone };
}
const stagePost = () => net.posts.find((p) => p.url === "/api/v1/divisions/d1/stages")!.body;

beforeEach(() => {
  net.posts = [];
});

describe("the form after a stage of several groups", () => {
  it("shows ONE count (no Top N select), opened on twice the groups, and posts the per-group take: 4 groups -> top 2 of every group", async () => {
    const m = mount({ pools: 4, entrants: 16 });
    const f = field(m.island.tree());
    expect(f, "the group count control").toBeDefined();
    expect(qualifySelect(m.island.tree()), "no Top N select beside it").toBeUndefined();
    expect(propsOf(f!).value, "opens on 4 groups x 2").toBe(8);
    click(m.island.tree(), en("schedule.addStageBtn"));
    await flush();
    expect((stagePost().progression as { sources: { take: unknown[] }[] }).sources[0]!.take).toEqual([{ kind: "topNPerGroup", n: 2 }]);
    expect(stagePost().progression).toMatchObject({ placement: "rank_order", timing: "on_complete" });
    expect(m.onDone.mock.calls, "the notice names the qualifiers, not a Top N").toEqual([[en("schedule.notice.stageAddedGroups", { n: 7, count: 8 })]]);
  });

  it("a count that is not a whole wave posts the remainder as best-Nth: 10 of 4 groups -> top 2 per group + the 2 best 3rd-placed", async () => {
    const m = mount({ pools: 4, entrants: 18 });
    (propsOf(field(m.island.tree())!).onChange as (n: number) => void)(10);
    expect(propsOf(field(m.island.tree())!).value, "the pick holds across the re-render").toBe(10);
    click(m.island.tree(), en("schedule.addStageBtn"));
    await flush();
    const take = (stagePost().progression as { sources: { take: Record<string, unknown>[] }[] }).sources[0]!.take;
    expect(take[0]).toEqual({ kind: "topNPerGroup", n: 2 });
    expect(take[1]).toMatchObject({ kind: "bestNth", nth: 3, count: 2 });
    expect(take.length).toBe(2);
  });

  it("offers exactly the counts the save door accepts: none the builder's own draw warning refuses, none above the field", () => {
    const m = mount({ pools: 4, entrants: 11 });
    const counts = propsOf(field(m.island.tree())!).counts as number[];
    const refusedByBuilder = (q: number) => crossPoolDrawCanRefuse(buildTemplateStages("groups_ko", { qualified: q, poolCount: 4, swissRounds: 3, legs: 1 }));
    expect(counts.length, "anti-vacuity").toBeGreaterThan(3);
    for (const q of counts) expect(refusedByBuilder(q), `${q} offered`).toBe(false);
    expect(Math.max(...counts), "never above the 11 in the field").toBeLessThanOrEqual(11);
    expect(counts.includes(5), "5 of 4 groups is a refused draw: not offered").toBe(false);
    const omitted = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11].filter((q) => !counts.includes(q));
    expect(omitted.length, "anti-vacuity: something was left out").toBeGreaterThan(0);
    for (const q of omitted) expect(refusedByBuilder(q), `${q} left out only because it is refused`).toBe(true);
  });

  it("a count picked for one kind that the chosen kind refuses is not posted: from double elimination (never drawn across groups) back to a knockout falls to an offered count", async () => {
    // From the predicate the form reads: a count double elimination takes (it is not drawn across groups) and a knockout refuses.
    const pools = 4;
    const pick = groupCountsFor({ pools, entrants: null }, "double_elim").find((q) => !groupCountsFor({ pools, entrants: null }, "knockout").includes(q));
    expect(pick, "the premise: some count differs between the two kinds").toBeDefined();
    const m = mount({ pools, entrants: null });
    const setKind = (kind: string) => {
      const sel = m.island.tree().find((n) => n.type === "select" && ["knockout", "stepladder", "double_elim"].includes((propsOf(n) as { value?: string }).value ?? ""))!;
      (propsOf(sel).onChange as (e: unknown) => void)({ target: { value: kind } });
    };
    setKind("double_elim");
    (propsOf(field(m.island.tree())!).onChange as (n: number) => void)(pick!);
    expect(propsOf(field(m.island.tree())!).value, "double elimination takes the pick").toBe(pick);
    setKind("knockout");
    const now = propsOf(field(m.island.tree())!);
    expect(now.counts as number[], "the pick is no longer offered").not.toContain(pick);
    expect(now.counts as number[], "the form moved to an offered count").toContain(now.value);
    click(m.island.tree(), en("schedule.addStageBtn"));
    await flush();
    expect(stagePost().kind).toBe("knockout");
    const posted = (stagePost().progression as { sources: { take: { kind: string; n?: number; count?: number }[] }[] }).sources[0]!.take;
    const slots = posted.reduce((n, r) => n + (r.kind === "topNPerGroup" ? r.n! * pools : r.count!), 0);
    expect(slots, "the posted count is the offered one, not the stale pick").toBe(now.value);
  });

  it("no count the draw can take: no count is offered, the line says why, and Add stage cannot be pressed (a field of one)", () => {
    const m = mount({ pools: 4, entrants: 1 });
    expect(propsOf(field(m.island.tree())!).value).toBeNull();
    expect((propsOf(addButton(m.island.tree())) as { disabled?: boolean }).disabled).toBe(true);
    const shown = GroupTakeField({ msg: en as never, locale: "en", source: { pools: 4, entrants: 1 }, destKind: "knockout", counts: [], value: null, onChange: () => {} }) as ReactElement;
    expect(textOf(shown)).toBe(en("schedule.groupTake.none"));
    expect(textOf(shown)).not.toMatch(/\{\w+\}/);
  });

  it("more groups than the draw takes (9): counts are offered only while the qualifiers come from at most 8 pools - never all nine groups' winners", () => {
    // The draw counts the distinct pools its qualifiers come from (cross-pool-draw.ts), so a take of the best 4 winners out of 9 groups is
    // a draw over 4 pools, inside the bound; the count that takes every group's winner (9) is a draw over 9 pools, outside it.
    const m = mount({ pools: 9, entrants: 18 });
    const offered = propsOf(field(m.island.tree())!).counts as number[];
    expect(offered.length, "anti-vacuity: something is offered").toBeGreaterThan(0);
    expect(offered).toContain(4);
    expect(offered).not.toContain(9);
    expect(Math.max(...offered), "the most the draw takes from 9 groups with no whole-group rule").toBe(8);
  });
});

describe("any other source keeps today's Top N", () => {
  it("no group source: the Top N select is there, no group count, and the body is the rankRange take", async () => {
    const m = mount(null);
    expect(field(m.island.tree()), "no group count").toBeUndefined();
    expect(qualifySelect(m.island.tree()), "Top N select").toBeDefined();
    click(m.island.tree(), en("schedule.addStageBtn"));
    await flush();
    expect(stagePost().progression).toEqual(addStageProgression(4));
    expect((stagePost().progression as { sources: { take: unknown[] }[] }).sources[0]!.take).toEqual([{ kind: "rankRange", from: 1, to: 4 }]);
  });
});

describe("addStageGroupSource: which stage the form follows", () => {
  const stage = (seq: number, kind: string, config: Record<string, unknown> = {}, progression: Record<string, unknown> | null = null) => ({ seq, kind, config, progression });
  const groups4 = stage(1, "group", { pools: { count: 4 } });
  it("empty case: no stages, nothing to follow", () => expect(addStageGroupSource([], ["a"])).toBeNull());
  it("a group stage of 4 pools is the source, with the active field", () => expect(addStageGroupSource([groups4], ["a", "b", "c"])).toEqual({ pools: 4, entrants: 3 }));
  it("an unknown field is null, not zero (the draw's bounds alone apply)", () => expect(addStageGroupSource([groups4], undefined)).toEqual({ pools: 4, entrants: null }));
  it("only a GROUP stage is a group source: a knockout that carries a pools config is not", () => {
    expect(addStageGroupSource([stage(1, "knockout", { pools: { count: 4 } })], ["a"])).toBeNull();
  });
  it("one pool, a league and a swiss keep Top N", () => {
    for (const s of [stage(1, "group", { pools: { count: 1 } }), stage(1, "group", {}), stage(1, "league"), stage(1, "swiss", { rounds: 3 })]) expect(addStageGroupSource([s], ["a"]), s.kind).toBeNull();
  });
  it("the LAST stage decides (a second add): groups then a knockout is a knockout source", () => {
    expect(addStageGroupSource([groups4, stage(2, "knockout")], ["a"])).toBeNull();
    expect(addStageGroupSource([stage(2, "knockout"), groups4].reverse(), ["a"]), "order of the array does not matter, seq does").toBeNull();
  });
  it("a FED group stage: its field is not the roster", () => expect(addStageGroupSource([stage(1, "league"), stage(2, "group", { pools: { count: 2 } }, { sources: [] })], ["a", "b"])).toEqual({ pools: 2, entrants: null }));
});

describe("the line under the count: split and round", () => {
  const msgEn = en as never;
  it("a whole wave in a whole round: 8 of 4 groups = Top 2 per group, quarter-finals", () => {
    const s = groupTakeSummary(msgEn, { count: 8, pools: 4, destKind: "knockout" });
    expect(s.take).toBe(en("schedule.groupTake.derived", { count: 8, take: en("templates.detail.take.topNPerGroup", { n: 2 }) }));
    expect(s.round).toBe(en("schedule.groupTake.whole", { round: en("bracket.round.quarter") }));
  });
  it("a remainder and byes: 10 of 4 groups = Top 2 per group and 2 best 3rd-placed, a bracket of 16 with 6 byes", () => {
    const s = groupTakeSummary(msgEn, { count: 10, pools: 4, destKind: "knockout" });
    const take = en("templates.detail.take.and", { a: en("templates.detail.take.topNPerGroup", { n: 2 }), b: en("templates.detail.take.bestNth", { count: 2, nth: 3 }) });
    expect(s.take).toBe(en("schedule.groupTake.derived", { count: 10, take }));
    expect(s.round).toBe(en("schedule.groupTake.byes", { size: 16, byes: 6 }));
  });
  it("every whole round has its own name, derived from the count: 2 final, 4 semi, 8 quarter, 16 round of 16; a stepladder names no round", () => {
    const names = new Map<number, string>([[2, "bracket.round.final"], [4, "bracket.round.semi"], [8, "bracket.round.quarter"]]);
    let checked = 0;
    for (const count of [2, 4, 8, 16, 32]) {
      const s = groupTakeSummary(msgEn, { count, pools: 2, destKind: "knockout" });
      const name = names.has(count) ? en(names.get(count) as never) : en("bracket.round.roundOf", { n: count });
      expect(s.round, `count ${count}`).toBe(en("schedule.groupTake.whole", { round: name }));
      checked += 1;
    }
    expect(checked).toBe(5);
    expect(groupTakeSummary(msgEn, { count: 8, pools: 4, destKind: "stepladder" }).round).toBeNull();
  });
  it("sweep: whole exactly when the count is a power of two, byes = bracket - count, 2..32", () => {
    let checked = 0;
    for (let count = 2; count <= 32; count++) {
      const b = bracketOf(count);
      const power = (count & (count - 1)) === 0;
      expect(b.whole, `count ${count}`).toBe(power);
      expect(b.size - b.byes, `count ${count}`).toBe(count);
      expect(b.size >= count && b.size / 2 < count, `count ${count}: the smallest bracket that holds it`).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(31);
  });
  it("opens on twice the groups when offered, else the offered count nearest 8, and on nothing when nothing is offered", () => {
    expect(defaultGroupCount([2, 4, 6, 8, 10], 3)).toBe(6);
    expect(defaultGroupCount([2, 3, 4, 6, 7, 9], 5), "10 is not offered: nearest to 8").toBe(7);
    expect(defaultGroupCount([], 4)).toBeNull();
  });
  it("every locale reads the line with no placeholder left", () => {
    let checked = 0;
    for (const dict of [enUi, esUi, frUi, nlUi]) {
      const msg = ((key: string, vars?: Record<string, string | number>) => t(dict as never, key, vars)) as never;
      for (const [count, kind] of [[8, "knockout"], [10, "knockout"], [3, "stepladder"]] as const) {
        const s = groupTakeSummary(msg, { count, pools: count === 3 ? 4 : 4, destKind: kind });
        expect(s.take).not.toMatch(/\{\w+\}/);
        if (s.round !== null) expect(s.round).not.toMatch(/\{\w+\}/);
        checked += 1;
      }
    }
    expect(checked).toBe(12);
  });
});
