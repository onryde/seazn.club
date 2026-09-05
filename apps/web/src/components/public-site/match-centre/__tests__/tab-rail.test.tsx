// Spectator surface W1, Task 10 — TabRail static-markup tests (brief's own
// Step 1 test, verbatim). `renderToStaticMarkup` needs no DOM (real React
// SSR); TabRail has no hooks. Assertions anchor on `="` — an omitted prop
// serialises as `"$undefined"`, so a bare attribute-name probe would pass in
// both states.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { TabRail } from "../tab-rail";

const dict = en as Dict;

it("TabRail renders one role=tab per tab with aria-selected on the active one, inside a focusable, labelled rail", () => {
  const html = renderToStaticMarkup(
    <TabRail tabs={["summary", "scorecard", "commentary", "info"]} active="scorecard" onChange={() => {}} dict={dict} />,
  );
  expect(html).toContain('role="tablist"');
  expect(html).toContain('tabindex="0"');
  expect(html).toContain('aria-label="');
  expect(html.match(/role="tab"/g)?.length).toBe(4);
  expect(html).toContain('data-testid="mc-tab-scorecard" aria-selected="true"');
  expect(html).toContain('data-testid="mc-tab-summary" aria-selected="false"'); // positive pair of the negative
});

describe("TabRail — accented/quiet pill classes", () => {
  it("the active pill carries the accent background, the inactive pill does not", () => {
    const html = renderToStaticMarkup(
      <TabRail tabs={["summary", "scorecard"]} active="summary" onChange={() => {}} dict={dict} />,
    );
    expect(html).toContain('data-testid="mc-tab-summary" aria-selected="true" class="shrink-0 rounded-full bg-accent');
    expect(html).toContain('data-testid="mc-tab-scorecard" aria-selected="false" class="shrink-0 rounded-full bg-accent-soft');
  });
});
