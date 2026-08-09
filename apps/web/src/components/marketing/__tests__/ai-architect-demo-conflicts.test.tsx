// #364 Task 6 review, finding 1 — the joint conflict list must speak the
// visitor's language.
//
// Both committed joint arrays are empty, so the branch that renders a conflict
// is unreachable from the recordings and its first shipped version printed the
// engine's raw camelCase reason token. On /es, /fr and /nl that is English
// machine vocabulary on a page whose entire argument is "this is the product".
//
// Its own file because the case needs a MUTATED fixture — `vi.mock` is
// file-scoped, and the sibling suite's "no clashes, and it says so" case is the
// recorded truth and has to keep its own empty arrays. The committed JSON is
// never touched: the factory deep-clones it and injects two conflicts.
//
// Rendered in SPANISH deliberately. An English render cannot tell the localized
// label from the raw token — `board.conflict.warn.rest` is literally "rest".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { pickDictPrefixes } from "@/lib/i18n-subset";
import { schedulingRungWeights } from "@/lib/ai-rung";
import type { Dict } from "@/lib/i18n-constants";

import uiEs from "@/dictionaries/es/ui.json";
import marketingEs from "@/dictionaries/es/marketing.json";
// Static imports so the island's dynamic `import()` resolves from the module
// cache. Without them the 235KB JSON is transformed mid-test and the fixture is
// still null after any reasonable flush — which reads as "the branch didn't
// render" rather than "the module wasn't ready". `finals-day` is here because
// the island auto-selects it on mount.
import northsideMocked from "@/demo/ai-templates/northside-open.json";
import "@/demo/ai-templates/finals-day.json";

import { AiArchitectDemo, conflictLabelFor } from "../ai-architect-demo";

const ES: Dict = {
  ...(marketingEs as unknown as Dict),
  ...pickDictPrefixes(uiEs as unknown as Dict, ["board.ai.", "board.conflict."]),
};

const DETAIL = "Court 1 · 09:00 ya ocupada";

vi.mock("@/demo/ai-templates/northside-open.json", async (importOriginal) => {
  const real = (await importOriginal<{ default: unknown }>()).default;
  const copy = structuredClone(real) as {
    board: { fixtures: { id: string; code: string }[] };
    response: { blocking: unknown[]; warnings: unknown[] };
  };
  const [a, b] = copy.board.fixtures;
  // `court` → conflict.court, `rest` → warn.rest (lib/schedule-board.ts
  // REASON_CODE). One carries a detail, one does not — the detail is the muted
  // supplementary line, never the primary label.
  copy.response.blocking = [
    { fixtureId: a!.id, reason: "court", detail: "Court 1 · 09:00 ya ocupada" },
  ];
  copy.response.warnings = [{ fixtureId: b!.id, reason: "rest" }];
  return { default: copy };
});

vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  const marketing = (await import("@/dictionaries/es/marketing.json")).default;
  const ui = (await import("@/dictionaries/es/ui.json")).default;
  const subset = (await import("@/lib/i18n-subset")).pickDictPrefixes;
  const dict = {
    ...(marketing as unknown as Record<string, unknown>),
    ...subset(ui as unknown as Record<string, unknown>, ["board.ai.", "board.conflict."]),
  };
  return { ...actual, useDict: () => dict };
});

const MOCKED = northsideMocked as unknown as {
  board: { fixtures: { id: string; code: string }[] };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r));
}

describe("AiArchitectDemo — a joint run WITH conflicts", () => {
  it("labels each one from the shared board.conflict.* taxonomy, in Spanish", async () => {
    // Anti-vacuity: the es catalog really carries these, so a pass cannot mean
    // "both sides returned the key".
    expect(ES["board.conflict.conflict.court"]).toBe("choque de pista");
    expect(ES["board.conflict.warn.rest"]).toBe("descanso");
    const codes = MOCKED.board.fixtures.slice(0, 2).map((f) => f.code);

    const island = renderIsland(AiArchitectDemo, {
      locale: "es" as const,
      weights: schedulingRungWeights(),
    });
    await settle();
    const card = island.tree().find((el) => propsOf(el)["data-ai-template"] === "northside-open")!;
    (propsOf(card).onClick as () => void)();
    await settle();

    const list = island.tree().find((el) => propsOf(el)["data-ai-conflicts"] !== undefined);
    expect(list, "no conflict list").toBeDefined();
    expect(propsOf(list!)["data-count"]).toBe("2");

    const rows = island.tree().filter((el) => propsOf(el)["data-ai-conflict"] !== undefined);
    expect(rows).toHaveLength(2);
    const first = textOf(propsOf(rows[0]!).children as never);
    const second = textOf(propsOf(rows[1]!).children as never);

    // The localized label is the primary text …
    expect(first).toContain("choque de pista");
    expect(second).toContain("descanso");
    // … the engine's raw token never reaches the page …
    expect(second).not.toContain("rest");
    // … nor does the English fallback from CONFLICT_LABEL.
    expect(first).not.toContain("court clash");
    // The fixture's own code identifies the row, and `detail` survives as
    // supplementary text on the one that has it.
    expect(first).toContain(codes[0]!);
    expect(first).toContain(DETAIL);
    expect(second).toContain(codes[1]!);
    // The row with no detail shows the label ALONE — nothing fell back to the
    // reason token.
    expect(second.replace(codes[1]!, "").trim()).toBe("descanso");
  });

  it("falls back to the code when a locale lacks the key, never to the raw reason", () => {
    // Same contract as ai-diff-panel.tsx:65 — a KNOWN reason with a missing key
    // resolves to the shared English label rather than the camelCase token; an
    // unknown reason has no REASON_CODE entry, so the code IS the reason and
    // there is nothing better to show.
    expect(conflictLabelFor(ES, "court")).toBe("choque de pista");
    expect(conflictLabelFor({}, "court")).toBe("court clash");
    expect(conflictLabelFor({}, "rest")).toBe("rest");
  });
});
