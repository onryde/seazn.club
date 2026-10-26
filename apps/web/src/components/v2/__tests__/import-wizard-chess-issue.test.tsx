// Owner ruling 2026-10-26: chess divisions take individual players only, so an import row that would enter a team
// into one is a blocking plan issue (usecases/imports.ts chessEntrantIssues, code CHESS_INDIVIDUAL_ONLY). The server
// words it in English only; the preview must show the localized line (division named), with a localized badge - not
// the raw code and not the English string - and a code the wizard does not know must still fall back to the server's.
import { afterEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { msgFor } from "@/lib/messages-i18n";

const h = vi.hoisted(() => ({ locale: "en" as "en" | "es", issues: [] as unknown[] }));

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

const SERVER_ENGLISH =
  "division 'Blitz Open' is a chess division — Chess divisions take individual players only — pairs, teams and solo sign-up pools are not available";

const previewWith = (issues: unknown[]) => ({
  importId: "imp-1",
  filename: "roster.csv",
  rowCount: 1,
  mapping: {},
  plan: {
    ops: [{ kind: "entrant.create", ref: "e1", sourceRows: [2], after: { displayName: "Acme Chess", kind: "team" } }],
    stats: { clubs: 0, teams: 1, persons: 1, entrants: 1, rosters: 1, squads: 0 },
    issues,
  },
});

const CHESS_ISSUE = {
  rowNo: 2,
  column: "divisionSlug",
  severity: "error",
  code: "CHESS_INDIVIDUAL_ONLY",
  message: SERVER_ENGLISH,
  messageArgs: { division: "Blitz Open" },
};

afterEach(() => {
  vi.unstubAllGlobals();
  h.locale = "en";
});

async function mount(issues: unknown[]) {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/v1/imports") return { ok: true, json: async () => ({ ok: true, data: previewWith(issues) }) } as Response;
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  const island = renderIsland(ImportWizard, { viewerPlan: "community" as const });
  const input = island.tree().find((e) => propsOf(e).id === "import-file");
  if (!input) throw new Error("file input not found");
  (propsOf(input).onChange as (e: unknown) => void)({
    target: { files: [new File(["x"], "roster.csv", { type: "text/csv" })] },
  });
  await vi.waitFor(() => expect(island.text()).toContain("roster.csv"));
  return island;
}

describe("ImportWizard - the chess-only import issue is localized", () => {
  it("shows the dictionary line with the division named, and the localized badge, in English and Spanish", async () => {
    const line = (loc: "en" | "es") => msgFor(loc, "import.error.chessIndividualOnly", { division: "Blitz Open" });
    const badge = (loc: "en" | "es") => msgFor(loc, "import.issueCode.chessIndividualOnly");
    expect(line("es")).not.toBe(line("en"));
    expect(line("en")).toContain("Blitz Open");

    const island = await mount([CHESS_ISSUE]);
    expect(island.text()).toContain(line("en"));
    expect(island.text()).toContain(badge("en"));
    // Not the server's English string, and not the raw code.
    expect(island.text()).not.toContain(SERVER_ENGLISH);
    expect(island.text()).not.toContain("CHESS_INDIVIDUAL_ONLY");

    h.locale = "es";
    island.rerender({ viewerPlan: "community" });
    expect(island.text()).toContain(line("es"));
    expect(island.text()).toContain(badge("es"));
    expect(island.text()).not.toContain(line("en"));
  });

  it("an issue code the wizard does not map still shows the server's message and its raw code (control)", async () => {
    const island = await mount([{ rowNo: 2, severity: "error", code: "SOME_OTHER_CODE", message: "server says no" }]);
    expect(island.text()).toContain("server says no");
    expect(island.text()).toContain("SOME_OTHER_CODE");
  });
});
