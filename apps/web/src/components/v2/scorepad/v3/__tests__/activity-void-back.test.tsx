// 2026-11-10 — an older cricket wicket shows no Void; "Void back to here" stands in for it (arm, then Confirm), and the
// confirm names how many entries it will void. Driven through its clicks with the hook harness: the arm is a `useState`
// the static renderer cannot move. Expected copy comes from the English dictionary, expected counts from the ledger below.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { ActivityPanel, activityRowState, type ActivityEvent, type ActivityPanelProps } from "../activity";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { messages, type MessageKey } from "@/lib/messages";
import { t as tRuntime } from "@/lib/i18n-runtime";
import enDict from "../../../../../dictionaries/en/ui.json";
import esDict from "../../../../../dictionaries/es/ui.json";
import frDict from "../../../../../dictionaries/fr/ui.json";
import nlDict from "../../../../../dictionaries/nl/ui.json";

const en = (key: MessageKey, params?: Record<string, string | number>) => tRuntime(messages, key, params);
const t = ((key: MessageKey, params?: Record<string, string | number>) => en(key, params)) as unknown as ActivityPanelProps["t"];

const ball = (id: string, seq: number, extra: Record<string, unknown> = {}): ActivityEvent => ({
  id, seq, type: "cricket.ball", voids: null,
  payload: { over: 0, ballInOver: seq, striker: "h1", nonStriker: "h2", bowler: "a7", runs: { bat: 1 }, ...extra },
});
const WICKET = { wicket: { kind: "bowled", out: "h1", bowlerCredited: true } };
// seq 1 a single, 2 a WICKET, 3 a single, 4 a single, 5 a four: the wicket has three balls behind it.
const LEDGER: ActivityEvent[] = [ball("b1", 1), ball("w2", 2, WICKET), ball("b3", 3), ball("b4", 4), ball("b5", 5)];

const byRole = (tree: ReactElement[], role: string) => tree.filter((e) => propsOf(e)["data-role"] === role);
const rowOf = (tree: ReactElement[], id: string) => byRole(tree, "v3-activity-row").find((e) => propsOf(e)["data-event-id"] === id)!;
const within = (row: ReactElement, role: string) => byRole(walkOf(row), role);
function walkOf(el: ReactElement): ReactElement[] {
  const out: ReactElement[] = [];
  const visit = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (n && typeof n === "object" && "props" in (n as object)) {
      out.push(n as ReactElement);
      visit((n as ReactElement).props && (propsOf(n as ReactElement).children as unknown));
    }
  };
  visit(el);
  return out;
}
const click = (el: ReactElement | undefined) => (propsOf(el!).onClick as () => void)();

function mount(events: ActivityEvent[], extra: Partial<ActivityPanelProps> = {}) {
  const onVoid = vi.fn();
  const onVoidBack = vi.fn();
  const island = renderIsland(ActivityPanel, {
    events, ownEventIds: new Set<string>(), deviceLinkId: null, personNames: {}, t, authority: true, onVoid, onVoidBack, ...extra,
  } as ActivityPanelProps);
  return { island, onVoid, onVoidBack };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a wicket with a ball behind it", () => {
  it("its row shows 'Void back to here' and NO Void; every other row keeps Void", () => {
    const { island } = mount(LEDGER);
    const tree = island.tree();
    const w = rowOf(tree, "w2");
    expect(within(w, "v3-activity-void")).toHaveLength(0);
    const back = within(w, "v3-activity-void-back");
    expect(back).toHaveLength(1);
    expect(textOf(back[0]!)).toBe("Void back to here");
    for (const id of ["b1", "b3", "b4", "b5"]) {
      expect(within(rowOf(tree, id), "v3-activity-void"), `row ${id} keeps Void`).toHaveLength(1);
      expect(within(rowOf(tree, id), "v3-activity-void-back")).toHaveLength(0);
    }
  });

  it("the confirm names the count: three balls behind it plus the wicket is 4 entries, and Confirm sends them newest first", () => {
    const { island, onVoid, onVoidBack } = mount(LEDGER);
    click(within(rowOf(island.tree(), "w2"), "v3-activity-void-back")[0]);
    const armed = rowOf(island.tree(), "w2");
    expect(textOf(within(armed, "v3-activity-void-back-hint")[0]!)).toBe("Voids 4 entries — re-score them after");
    expect(onVoidBack, "arming alone writes nothing").not.toHaveBeenCalled();
    click(within(armed, "v3-activity-void-back-confirm")[0]);
    expect(onVoidBack).toHaveBeenCalledTimes(1);
    expect(onVoidBack).toHaveBeenCalledWith(["b5", "b4", "b3", "w2"]);
    expect(onVoid, "the per-row Void is never used for it").not.toHaveBeenCalled();
  });

  it("Cancel disarms without writing", () => {
    const { island, onVoidBack } = mount(LEDGER);
    click(within(rowOf(island.tree(), "w2"), "v3-activity-void-back")[0]);
    click(within(rowOf(island.tree(), "w2"), "v3-activity-void-cancel")[0]);
    expect(within(rowOf(island.tree(), "w2"), "v3-activity-void-back-hint")).toHaveLength(0);
    expect(within(rowOf(island.tree(), "w2"), "v3-activity-void-back")).toHaveLength(1);
    expect(onVoidBack).not.toHaveBeenCalled();
  });

  it("a surface that cannot run the sequence (no onVoidBack) shows neither control on that row", () => {
    const { island } = mount(LEDGER, { onVoidBack: undefined });
    const w = rowOf(island.tree(), "w2");
    expect(within(w, "v3-activity-void")).toHaveLength(0);
    expect(within(w, "v3-activity-void-back")).toHaveLength(0);
  });

  it("the sequence stays disabled while a resync is in flight, like Void", () => {
    const { island } = mount(LEDGER, { voidDisabled: true });
    expect(propsOf(within(rowOf(island.tree(), "w2"), "v3-activity-void-back")[0]!).disabled).toBe(true);
  });
});

describe("the latest wicket and the rows around it", () => {
  it("a wicket that IS the latest ball keeps the ordinary Void", () => {
    const { island } = mount(LEDGER.slice(0, 2));
    const w = rowOf(island.tree(), "w2");
    expect(within(w, "v3-activity-void")).toHaveLength(1);
    expect(within(w, "v3-activity-void-back")).toHaveLength(0);
  });

  it("an older wicket whose later balls were all voided is the latest again: Void, not Void back", () => {
    const events = [...LEDGER.slice(0, 3), { id: "v4", seq: 4, type: "core.void", payload: {}, voids: "b3" }];
    const { island } = mount(events);
    expect(within(rowOf(island.tree(), "w2"), "v3-activity-void")).toHaveLength(1);
  });

  it("activityRowState: the wicket is flagged, and canVoid is false for it on every surface", () => {
    const s = activityRowState(LEDGER[1]!, LEDGER, new Set(), null, true, true);
    expect(s.wicketBehindBall).toBe(true);
    expect(s.canVoid).toBe(false);
    const device = activityRowState(LEDGER[1]!, LEDGER, new Set(["w2"]), "link-1", true, false);
    expect(device.canVoid).toBe(false);
  });

  it("every locale has the new copy, with the count placeholder in the hint", () => {
    for (const d of [enDict, esDict, frDict, nlDict] as Record<string, string>[]) {
      expect(d["pad.activity.voidBack"]).toBeTruthy();
      expect(d["pad.activity.voidBackHint"]).toContain("{count}");
      expect(d["score.voidBackStopped"]).toMatch(/\{done\}.*\{total\}.*\{reason\}/);
      expect(d["scorepad.refusal.undoWicketNotLatest"]).toBeTruthy();
    }
  });
});
