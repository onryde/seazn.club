// The documents menu saves a fetched file through the shared `downloadBlob`
// (lib/download-blob.ts) — the routine the scorer-sheets print control uses —
// rather than a private copy of it. Driven through the menu's REAL click
// handler with the hook harness; `document` is stubbed only for the
// dismiss-on-outside-tap listeners the menu attaches on mount.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";

vi.mock("@/lib/download-blob", () => ({ downloadBlob: vi.fn() }));
import { downloadBlob } from "@/lib/download-blob";
import { DocumentsMenu } from "@/components/v2/board/documents-menu";

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
const menuItems = (tree: ReactElement[]) => tree.filter((e) => propsOf(e).role === "menuitem");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(downloadBlob).mockClear();
});

describe("DocumentsMenu download", () => {
  it("hands the fetched file to the shared downloadBlob, named after its export", async () => {
    vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const fetchFn = vi.fn(async () => new Response(new Blob(["%PDF-"]), { status: 200 }));
    vi.stubGlobal("fetch", fetchFn);
    const island = renderIsland(DocumentsMenu, { divisionId: "d1", competitionId: "c1" });
    // The first row is the order of play; its first item is the PDF.
    (propsOf(menuItems(island.tree())[0]!).onClick as () => void)();
    await flush();
    expect(fetchFn).toHaveBeenCalledWith("/api/v1/divisions/d1/exports/timetable?format=pdf");
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, name] = vi.mocked(downloadBlob).mock.calls[0]!;
    expect(name).toBe("timetable.pdf");
    expect(await blob.text()).toBe("%PDF-");
  });

  it("a refusal never reaches the downloader", async () => {
    vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: false, error: { code: "X", message: "nope" } }, { status: 500 })),
    );
    const island = renderIsland(DocumentsMenu, { divisionId: "d1", competitionId: "c1" });
    (propsOf(menuItems(island.tree())[0]!).onClick as () => void)();
    await flush();
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(island.text()).toContain("nope");
  });
});
