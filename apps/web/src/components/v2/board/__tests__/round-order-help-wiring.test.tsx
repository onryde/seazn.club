// The wiring half of round-order-help.test.ts: the list an organiser reads must
// actually use the round wording over the code-level (feeder) help and label.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "@/dictionaries/en/ui.json";

vi.mock("@/components/i18n/dict-provider", () => ({
  useMsg: () => (key: string, vars?: Record<string, string | number>) =>
    Object.entries(vars ?? {}).reduce(
      (s, [k, v]) => s.replaceAll(`{${k}}`, String(v)),
      (en as Record<string, string>)[key] ?? key,
    ),
  usePlural: () => (key: string) => key,
}));

const { ConflictList } = await import("../conflict-list");
type BoardConflict = import("../types").BoardConflict;

const render = (conflicts: BoardConflict[]) =>
  renderToStaticMarkup(createElement(ConflictList, { conflicts, board: [], entrantNames: {}, feedLabels: {} }));

describe("ConflictList round-order wording", () => {
  it("says rounds, not feeding, for a round-order conflict under the feeder's code", () => {
    const html = render([
      {
        fixture_id: "f1",
        code: "warn.order",
        blocking: true,
        details: { kind: "round_order_end", round_no: 2, other_round_no: 1 },
      },
    ]);
    expect(html).toContain("Round 2 starts before round 1 has finished");
    expect(html).toContain("out of round order");
    expect(html).not.toMatch(/feeds/i);
  });

  it("keeps the feeder wording for a real feeder conflict", () => {
    const html = render([
      { fixture_id: "f1", code: "warn.order", blocking: true, details: { kind: "order_before_feeder" } },
    ]);
    expect(html).toContain("plays before feeder");
  });
});
