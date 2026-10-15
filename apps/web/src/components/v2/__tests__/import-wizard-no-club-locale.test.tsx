// The import preview groups its rows by club, and rows with no club gather
// under a "— no club —" heading built inside a `useMemo` keyed on `[preview]`
// alone. The heading is copy (`msg("import.noClub")`), so a copy-catalog change
// with the same preview left it in the old language while every other string
// on the screen moved. `msg` is now a dep of that memo.
import { afterEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { msgFor } from "@/lib/messages-i18n";

const h = vi.hoisted(() => ({ locale: "en" as "en" | "es" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  const { msgFor: lookup } = await import("@/lib/messages-i18n");
  type Key = Parameters<typeof lookup>[1];
  const bound = {
    en: (k: Key, v?: Record<string, string | number>) => lookup("en", k, v),
    es: (k: Key, v?: Record<string, string | number>) => lookup("es", k, v),
  };
  return { ...actual, useMsg: () => bound[h.locale] };
});

import { ImportWizard } from "@/components/v2/import-wizard";

// One clubless row — the case that lands under the "no club" heading.
const PREVIEW = {
  importId: "imp-1",
  filename: "roster.csv",
  rowCount: 1,
  mapping: {},
  plan: {
    ops: [{ kind: "entrant.create", ref: "e1", sourceRows: [1], after: { displayName: "Solo Player" } }],
    stats: { clubs: 0, teams: 0, persons: 1, entrants: 1, rosters: 1, squads: 0 },
    issues: [],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  h.locale = "en";
});

async function mountWithPreview() {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/v1/imports") return { ok: true, json: async () => ({ ok: true, data: PREVIEW }) } as Response;
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  const island = renderIsland(ImportWizard, { viewerPlan: "community" as const });
  const input = island.tree().find((e) => propsOf(e).id === "import-file");
  if (!input) throw new Error("file input not found");
  (propsOf(input).onChange as (e: unknown) => void)({
    target: { files: [new File(["name\nSolo Player"], "roster.csv", { type: "text/csv" })] },
  });
  await vi.waitFor(() => expect(island.text()).toContain("Solo Player"));
  return island;
}

describe("ImportWizard — the clubless group heading follows the copy catalog", () => {
  it("a catalog change with the same preview re-titles the clubless group", async () => {
    const en = msgFor("en", "import.noClub");
    const es = msgFor("es", "import.noClub");
    expect(es).not.toBe(en);

    const island = await mountWithPreview();
    expect(island.text()).toContain(en);

    h.locale = "es";
    island.rerender({ viewerPlan: "community" });

    expect(island.text()).toContain(es);
    expect(island.text()).not.toContain(en);
  });
});
