// Review 4 of #857, nit. The shift's outcome picked its plural form with
// `=== 1`, which is English's rule, not the reader's: French puts 0 in the
// singular ("0 rencontre déplacée"), so a shift that moved nothing read
// "0 rencontres déplacées". The panel now asks the locale's own rule.
//
// The harness has no provider tree, so the French lookup is bound here — the
// same technique use-board-actions-locale.test.tsx uses for `useMsg`.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => async () => true,
}));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  const { plural, t } = await import("@/lib/i18n-runtime");
  const fr = (await import("@/dictionaries/fr/ui.json")).default as unknown as Parameters<typeof t>[0];
  return {
    ...actual,
    useMsg: () => (key: string, vars?: Record<string, string | number>) => t(fr, key as never, vars),
    useMsgPlural: () => (key: string, count: number, vars?: Record<string, string | number>) =>
      plural(fr, key, count, "fr", vars),
  };
});

const shift = vi.hoisted(() => ({ answer: {} as unknown }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: vi.fn((url: string) => Promise.resolve(url === "/api/v1/schedule/shift" ? shift.answer : {})),
  };
});

import { ConstraintsPanel } from "../constraints-panel";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import frUi from "@/dictionaries/fr/ui.json";

const FR = frUi as unknown as Record<string, string>;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const props = {
  divisionId: "d1",
  initialSettings: { division_id: "d1", config: { courts: ["Court 1"], matchMinutes: 30, gapMinutes: 0, constraints: {} } },
  canEdit: true,
  orgTz: "UTC",
  viewerPlan: "community" as const,
};
const byTestid = (tree: ReactElement[], id: string) => tree.filter((el) => propsOf(el)["data-testid"] === id);

describe("ConstraintsPanel — the shift's outcome in French", () => {
  it("a shift that moved nothing says it in the singular, as French does for 0", async () => {
    shift.answer = { shifted: 0, skipped: { decided: 2, locked: 0 }, seq: 9 };
    const island = renderIsland(ConstraintsPanel, props);
    await flush();
    const button = island
      .tree()
      .find((el) => el.type === "button" && textOf(el) === FR["constraints.bulkShift.button"]);
    expect(button, "the shift button").toBeDefined();
    (propsOf(button!).onClick as () => Promise<void>)();
    await flush();
    await flush();

    expect(byTestid(island.tree(), "bulk-shift-outcome").map(textOf)).toEqual(["0 rencontre déplacée."]);
    expect(byTestid(island.tree(), "bulk-shift-kept").map(textOf)).toEqual([
      "2 rencontres avec un résultat ou un score enregistré ont été laissées en place.",
    ]);
  });
});
