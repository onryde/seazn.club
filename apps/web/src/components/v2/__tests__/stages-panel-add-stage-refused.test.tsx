// W5 follow-ups fix round 1 (review I2): AddStageForm read EVERY STAGE_NOT_READY from the Generate that follows a saved stage as
// "Stage added - fixtures will generate when the previous stage completes". The engine's shortfall ("takes rank 5, but only 4 are
// available") is a STAGE_NOT_READY too, for a stage that never fills. Now only the wait (`previous_stage_incomplete`) says
// "later"; any other refusal is said by name in a card on the form, with Delete offered for the stage that was saved.
//
// Drives the form's real add() through the hook harness (AddStageForm is exported for it, as the paywall test does); the network
// is the one seam replaced. The copy is the en dictionary's, read through the harness, never retyped from the component.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { t } from "@/lib/i18n-runtime";
import enUi from "@/dictionaries/en/ui.json";

type Call = { url: string; method: string };
const net = vi.hoisted(() => ({
  calls: [] as { url: string; method: string }[],
  generate: (() => Promise.resolve({ created: 3 })) as () => Promise<unknown>,
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string }) => {
      net.calls.push({ url, method: options?.method ?? "GET" });
      if (url.endsWith("/generate")) return net.generate();
      if (options?.method === "DELETE") return Promise.resolve({});
      return Promise.resolve({ id: "s9" });
    },
  };
});

import { AddStageForm } from "@/components/v2/stages-panel";
import { ApiV1Error } from "@/lib/client-v1";
import { SCHEDULE_LOCKED_CODE, SCHEDULE_LOCKED_MESSAGE } from "@/lib/schedule-lock";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const en = (key: string, vars?: Record<string, string | number>) => t(enUi as never, key, vars);

function button(tree: ReactElement[], text: string): ReactElement | undefined {
  return tree.find((n) => n.type === "button" && textOf(n).trim() === text);
}
function click(tree: ReactElement[], text: string): void {
  const btn = button(tree, text);
  if (!btn) throw new Error(`no <button> "${text}" - rendered: ${tree.map((n) => textOf(n)).join(" | ")}`);
  (propsOf(btn).onClick as () => void)();
}
const card = (tree: ReactElement[]) => tree.find((n) => (propsOf(n) as { "data-testid"?: string })["data-testid"] === "add-stage-refused");
const alertText = (tree: ReactElement[]) => textOf(tree.find((n) => (propsOf(n) as { role?: string }).role === "alert")!);

const SHORTFALL = "the previous stage takes rank 5, but only 4 entrants are available — lower the qualifier count or add entrants";

function mount() {
  const onDone = vi.fn();
  const onError = vi.fn();
  const onPaywall = vi.fn();
  const onRefresh = vi.fn();
  const island = renderIsland(AddStageForm, { divisionId: "d1", nextSeq: 2, onDone, onError, onPaywall, onRefresh } as never);
  click(island.tree(), en("schedule.addStage"));
  click(island.tree(), en("schedule.addStageBtn"));
  return { island, onDone, onError, onRefresh };
}

beforeEach(() => {
  net.calls = [];
});

describe("I2 Add stage: 'later' only for the wait; any other Generate refusal is said by name, with Delete offered", () => {
  it("the wait (previous_stage_incomplete): the 'later' notice, no card", async () => {
    net.generate = () => Promise.reject(new ApiV1Error("x", 422, "STAGE_NOT_READY", { reason: "previous_stage_incomplete", stageId: "s9", previousStageId: "s1" }));
    const m = mount();
    await flush();
    expect(m.onDone.mock.calls).toEqual([[en("schedule.notice.stageAddedLater")]]);
    expect(card(m.island.tree()), "no refusal card").toBeUndefined();
  });

  it("the engine's shortfall (a STAGE_NOT_READY without the wait's reason): no 'later' notice; a card names the stage and the refusal, and the board is re-read", async () => {
    net.generate = () => Promise.reject(new ApiV1Error(SHORTFALL, 422, "STAGE_NOT_READY"));
    const m = mount();
    await flush();
    expect(m.onDone, "never the 'later' promise").not.toHaveBeenCalled();
    expect(card(m.island.tree()), "the refusal card").toBeDefined();
    const line = alertText(m.island.tree());
    expect(line).toBe(en("schedule.notice.stageAddedRefused", { name: "Finals", reason: SHORTFALL }));
    expect(m.onRefresh, "the saved stage shows on the board").toHaveBeenCalledTimes(1);
    expect(button(m.island.tree(), en("confirm.deleteStage.label")), "Delete is offered").toBeDefined();
  });

  it("Delete removes the stage that was saved, then says so; Keep closes the card and deletes nothing", async () => {
    net.generate = () => Promise.reject(new ApiV1Error("x", 422, "RR_CUT_EXCEEDS_FIELD", { qualified: 8, max: 6 }));
    const a = mount();
    await flush();
    expect(alertText(a.island.tree()), "a named refusal reads its own copy").toContain(en("roundrobin.refusal.RR_CUT_EXCEEDS_FIELD", { qualified: 8, max: 6 }));
    click(a.island.tree(), en("confirm.deleteStage.label"));
    await flush();
    expect(net.calls.filter((c: Call) => c.method === "DELETE").map((c: Call) => c.url)).toEqual(["/api/v1/stages/s9"]);
    expect(a.onDone.mock.calls).toEqual([[en("schedule.notice.stageDeleted")]]);
    expect(card(a.island.tree()), "the card is gone").toBeUndefined();

    net.calls = [];
    const b = mount();
    await flush();
    click(b.island.tree(), en("schedule.addStage.keepRefused"));
    await flush();
    expect(net.calls.filter((c: Call) => c.method === "DELETE"), "Keep deletes nothing").toEqual([]);
    expect(card(b.island.tree())).toBeUndefined();
    expect(button(b.island.tree(), en("schedule.addStage")), "the form is closed: its opener is back").toBeDefined();
  });

  // Round 2 (R1): SCHEDULE_LOCKED is checked in generate.ts BEFORE the previous-stage wait, so a frozen division whose previous stage
  // still runs refuses with it - and Delete would be refused too (stage-graph.ts, the same freeze). The frozen-board line is the
  // answer there, as before the card existed; "can't be made" with a Delete that fails is the defect.
  it("a frozen division (SCHEDULE_LOCKED): no card, no Delete offered; the lock line goes to the form's red line, as before", async () => {
    net.generate = () => Promise.reject(new ApiV1Error(SCHEDULE_LOCKED_MESSAGE, 422, SCHEDULE_LOCKED_CODE));
    const m = mount();
    await flush();
    expect(card(m.island.tree()), "no refusal card for a freeze").toBeUndefined();
    expect(button(m.island.tree(), en("confirm.deleteStage.label")), "no Delete offered").toBeUndefined();
    expect(m.onDone, "never the 'later' promise").not.toHaveBeenCalled();
    expect(m.onError.mock.calls.filter((c) => c[0] !== ""), "the lock line, once").toEqual([[SCHEDULE_LOCKED_MESSAGE]]);
  });

  it("a filled stage still says how many fixtures it made (the success path is untouched)", async () => {
    net.generate = () => Promise.resolve({ created: 3 });
    const m = mount();
    await flush();
    expect(m.onDone.mock.calls).toEqual([[en("schedule.notice.stageAdded", { n: 3, topN: 4 })]]);
    expect(card(m.island.tree())).toBeUndefined();
  });
});
