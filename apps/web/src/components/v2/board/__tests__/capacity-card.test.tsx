// CapacityCard (D2) — a pure presentational component over an already-
// computed CapacityReport. renderToStaticMarkup is this repo's client-
// component convention (no jsdom/@testing-library — see
// component-ui-i18n memory / ai-quote-card.test.tsx); a `'`/`&` in expected
// copy is escaped before `toContain`, since React renders them as entity
// references in text nodes.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Dict } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import en from "@/dictionaries/en/ui.json";
import type { CapacityReport } from "@seazn/engine/scheduling/capacity";
import { CapacityCard } from "../capacity-card";

function render(ui: React.ReactElement): string {
  return renderToStaticMarkup(
    <DictProvider dict={en as unknown as Dict} locale="en">
      {ui}
    </DictProvider>,
  );
}

function baseReport(overrides: Partial<CapacityReport> = {}): CapacityReport {
  return {
    verdict: "ok",
    slotSupply: 6,
    slotDemand: 4,
    perDay: [{ date: "2026-10-19", supply: 6, demandCeiling: 4 }],
    restBound: [],
    suggestions: [],
    ...overrides,
  };
}

describe("CapacityCard", () => {
  it("renders nothing when the report is null (nothing to assess yet)", () => {
    expect(render(<CapacityCard report={null} />)).toBe("");
  });

  it("renders the ok verdict chip and the supply/demand summary", () => {
    const html = render(<CapacityCard report={baseReport()} />);
    expect(html).toContain('data-capacity-verdict="ok"');
    expect(html).toContain(en["schedule.capacity.verdict.ok"]);
    // summary is parameterised — assert the two numbers both landed, not the
    // whole interpolated sentence (locale-order-sensitive).
    expect(html).toContain("4");
    expect(html).toContain("6");
  });

  it("renders the impossible verdict chip — apostrophe escaped, per this repo's HTML entity rule", () => {
    const html = render(<CapacityCard report={baseReport({ verdict: "impossible" })} />);
    expect(html).toContain('data-capacity-verdict="impossible"');
    const expectedEscaped = en["schedule.capacity.verdict.impossible"].replace(/'/g, "&#x27;");
    expect(html).toContain(expectedEscaped);
  });

  it("renders the tight verdict chip", () => {
    const html = render(<CapacityCard report={baseReport({ verdict: "tight" })} />);
    expect(html).toContain('data-capacity-verdict="tight"');
    expect(html).toContain(en["schedule.capacity.verdict.tight"]);
  });

  it("shows the rest-violations line only when at least one entrant is violated", () => {
    const clean = render(<CapacityCard report={baseReport()} />);
    expect(clean).not.toContain("schedule.capacity.restViolations".split(".").pop()!);
    const withViolation = render(
      <CapacityCard
        report={baseReport({
          verdict: "impossible",
          restBound: [{ entrantId: "A", need: 100, available: 50, violated: true }],
        })}
      />,
    );
    expect(withViolation).toContain("1");
  });

  it("renders one mini-bar container per day in perDay", () => {
    const html = render(
      <CapacityCard
        report={baseReport({
          perDay: [
            { date: "2026-10-19", supply: 6, demandCeiling: 4 },
            { date: "2026-10-20", supply: 3, demandCeiling: 4 },
          ],
        })}
      />,
    );
    expect(html).toContain("10-19");
    expect(html).toContain("10-20");
  });

  it("renders a suggestion row's label, with the venue word substituted for add_court", () => {
    const html = render(
      <CapacityCard
        report={baseReport({
          verdict: "impossible",
          suggestions: [{ kind: "add_court", amount: 1, flipsVerdict: true }],
        })}
        venueLabel="field"
      />,
    );
    expect(html).toContain("field");
  });

  it("renders an Apply button ONLY for a suggestion kind with a handler in onApply", () => {
    const withHandler = render(
      <CapacityCard
        report={baseReport({
          verdict: "impossible",
          suggestions: [
            { kind: "add_day", amount: 1, flipsVerdict: true },
            { kind: "raise_cap", amount: 1, flipsVerdict: true },
          ],
        })}
        onApply={{ add_day: () => {} }}
      />,
    );
    // Two suggestion rows, but only add_day has a handler wired.
    const applyCount = (withHandler.match(new RegExp(en["schedule.capacity.apply"], "g")) ?? []).length;
    expect(applyCount).toBe(1);
  });

  it("renders no suggestions section at all when there are none", () => {
    const html = render(<CapacityCard report={baseReport()} />);
    expect(html).not.toContain(en["schedule.capacity.suggestions.title"]);
  });

  // P10 §4/Task 6 — the stale state (a debounced refetch pending or in
  // flight, useCapacityReport's own `stale` flag). Must never blank the
  // card or replace real numbers with a spinner: the report is still
  // right there, so every assertion above (verdict chip, summary numbers,
  // bars, suggestions) still has to hold true here too.
  describe("stale", () => {
    it("defaults to not-stale when the prop is omitted — existing callers keep their prior behaviour untouched", () => {
      const html = render(<CapacityCard report={baseReport()} />);
      expect(html).not.toContain("data-capacity-stale");
    });

    it("marks the card stale via a data attribute, without hiding the verdict or the numbers", () => {
      const html = render(<CapacityCard report={baseReport()} stale />);
      expect(html).toContain('data-capacity-stale="true"');
      expect(html).toContain('data-capacity-verdict="ok"'); // verdict still there
      expect(html).toContain("4"); // demand
      expect(html).toContain("6"); // supply
    });

    it("shows a visible stale indicator with its own copy, distinct from the verdict chip's copy", () => {
      const html = render(<CapacityCard report={baseReport()} stale />);
      expect(html).toContain(en["schedule.capacity.stale"]);
      expect(html).toContain(en["schedule.capacity.verdict.ok"]); // both present, not swapped
    });

    it("shows no stale indicator when stale is false", () => {
      const html = render(<CapacityCard report={baseReport()} stale={false} />);
      expect(html).not.toContain(en["schedule.capacity.stale"]);
    });

    it("renders the impossible verdict AND stays stale-marked at the same time — the two are independent axes", () => {
      const html = render(<CapacityCard report={baseReport({ verdict: "impossible" })} stale />);
      expect(html).toContain('data-capacity-verdict="impossible"');
      expect(html).toContain('data-capacity-stale="true"');
    });

    it("keeps suggestions and their Apply buttons rendered while stale", () => {
      const html = render(
        <CapacityCard
          report={baseReport({ verdict: "impossible", suggestions: [{ kind: "add_day", amount: 1, flipsVerdict: true }] })}
          onApply={{ add_day: () => {} }}
          stale
        />,
      );
      expect(html).toContain(en["schedule.capacity.apply"]);
    });
  });
});
