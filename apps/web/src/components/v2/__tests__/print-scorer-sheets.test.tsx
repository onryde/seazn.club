// Scorer sheets §4.4 — the organiser's print control, driven through its REAL
// state with the hook harness (no jsdom here): what the day picker opens at,
// what one click POSTs, what a refusal shows, and what reaches the downloader.
// The route it POSTs to is Task 8's; `fetch` is stubbed with that route's
// contract (200 application/pdf + a content-disposition filename; refusals in
// the v1 envelope `{ ok:false, error:{ code, message } }`).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";

vi.mock("@/components/upgrade-gate", () => ({ UpgradeGate: vi.fn(() => null) }));
import { UpgradeGate } from "@/components/upgrade-gate";
import { PrintScorerSheets } from "@/components/v2/print-scorer-sheets";

const byTestId = (tree: ReactElement[], id: string) => tree.find((e) => propsOf(e)["data-testid"] === id);
const base: Parameters<typeof PrintScorerSheets>[0] = {
  action: "/api/v1/competitions/c1/exports/scorer-sheets",
  days: ["2026-09-23", "2026-09-24"],
  // Deliberately NOT the first option: a picker that opens at days[0] must
  // fail the "opens at" case rather than pass it by coincidence.
  defaultDay: "2026-09-24",
  allowed: true,
  viewerPlan: "pro",
};
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
const click = (tree: ReactElement[]) => (propsOf(byTestId(tree, "print-sheets-submit")!).onClick as () => void)();
const pick = (tree: ReactElement[], value: string) =>
  (propsOf(byTestId(tree, "print-sheets-day")!).onChange as (e: { target: { value: string } }) => void)({
    target: { value },
  });
const pdf = () =>
  new Response(new Blob(["%PDF-"]), {
    status: 200,
    headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="s-2026-09-24.pdf"' },
  });
const sentBody = (fetchFn: ReturnType<typeof vi.fn>) =>
  JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string) as { date: string };

afterEach(() => vi.unstubAllGlobals());

describe("PrintScorerSheets (scorer sheets §4.4)", () => {
  it("empty case: no printable days → no control at all", () => {
    const island = renderIsland(PrintScorerSheets, { ...base, days: [], defaultDay: null });
    expect(island.tree()).toEqual([]);
    expect(byTestId(island.tree(), "print-sheets")).toBeUndefined();
  });

  it("each half of the empty case stands alone: no days, or no default day, renders nothing", () => {
    // Mutated one at a time, each clause would otherwise be covered by the other.
    expect(renderIsland(PrintScorerSheets, { ...base, days: [], defaultDay: "2026-09-24" }).tree()).toEqual([]);
    expect(renderIsland(PrintScorerSheets, { ...base, defaultDay: null }).tree()).toEqual([]);
  });

  it("the picker OPENS AT the default day, not the first option", () => {
    const island = renderIsland(PrintScorerSheets, base);
    expect(byTestId(island.tree(), "print-sheets")).toBeDefined();
    expect(propsOf(byTestId(island.tree(), "print-sheets-day")!).value).toBe("2026-09-24");
  });

  it("offers every printable day, in order, each named as the board's day tabs name it", () => {
    const island = renderIsland(PrintScorerSheets, base);
    const options = island.tree().filter((e) => e.type === "option");
    expect(options.map((o) => propsOf(o).value)).toEqual(["2026-09-23", "2026-09-24"]);
    // `dayLabel(day, locale)` — the schedule board's own tab label — in the
    // page's locale ("en" outside a provider), never the runtime's.
    expect(options.map((o) => propsOf(o).children)).toEqual(["Wed, Sep 23", "Thu, Sep 24"]);
  });

  it("submit POSTs {date} as JSON to the action and hands the blob to the downloader", async () => {
    const fetchFn = vi.fn(async () => pdf());
    vi.stubGlobal("fetch", fetchFn);
    const download = vi.fn();
    const island = renderIsland(PrintScorerSheets, { ...base, download });
    click(island.tree());
    await flush();
    expect(fetchFn).toHaveBeenCalledWith(
      base.action,
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-09-24" }),
      }),
    );
    expect(download).toHaveBeenCalledWith(expect.any(Blob), "s-2026-09-24.pdf");
    expect(await (download.mock.calls[0]![0] as Blob).text()).toBe("%PDF-");
  });

  it("a response without a filename still saves, under the generic name", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["%PDF-"]), { status: 200 })));
    const download = vi.fn();
    const island = renderIsland(PrintScorerSheets, { ...base, download });
    click(island.tree());
    await flush();
    expect(download).toHaveBeenCalledWith(expect.any(Blob), "scorer-sheets.pdf");
  });

  it("the day the organiser PICKS is the day that is POSTed", async () => {
    const fetchFn = vi.fn(async () => pdf());
    vi.stubGlobal("fetch", fetchFn);
    const island = renderIsland(PrintScorerSheets, { ...base, download: vi.fn() });
    pick(island.tree(), "2026-09-23");
    expect(propsOf(byTestId(island.tree(), "print-sheets-day")!).value).toBe("2026-09-23");
    click(island.tree());
    await flush();
    expect(sentBody(fetchFn)).toEqual({ date: "2026-09-23" });
  });

  it("a picked day that drops off the list on a re-render falls back to the new default — the screen and the POST agree", async () => {
    const fetchFn = vi.fn(async () => pdf());
    vi.stubGlobal("fetch", fetchFn);
    const download = vi.fn();
    const island = renderIsland(PrintScorerSheets, { ...base, download });
    pick(island.tree(), "2026-09-23");
    // The board moved every match off the 23rd; the page re-renders the list.
    island.rerender({ ...base, download, days: ["2026-09-24", "2026-09-25"], defaultDay: "2026-09-25" });
    expect(propsOf(byTestId(island.tree(), "print-sheets-day")!).value).toBe("2026-09-25");
    click(island.tree());
    await flush();
    expect(sentBody(fetchFn)).toEqual({ date: "2026-09-25" });
  });

  it("while a print is in flight the button is disabled and says so — a second tap cannot POST again", async () => {
    let release: (r: Response) => void = () => {};
    const fetchFn = vi.fn(() => new Promise<Response>((r) => (release = r)));
    vi.stubGlobal("fetch", fetchFn);
    const island = renderIsland(PrintScorerSheets, { ...base, download: vi.fn() });
    expect(propsOf(byTestId(island.tree(), "print-sheets-submit")!).disabled).toBe(false);
    expect(island.text()).toContain("Print scorer sheets");
    click(island.tree());
    await flush();
    const submit = propsOf(byTestId(island.tree(), "print-sheets-submit")!);
    expect(submit.disabled).toBe(true);
    expect(island.text()).toContain("Preparing…");
    release(pdf());
    await flush();
    expect(propsOf(byTestId(island.tree(), "print-sheets-submit")!).disabled).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a 422 shows the LOCALISED no-matches copy, not the server's English", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { ok: false, error: { code: "NO_FIXTURES_ON_DAY", message: "No fixtures to print on that day" } },
          { status: 422 },
        ),
      ),
    );
    const download = vi.fn();
    const island = renderIsland(PrintScorerSheets, { ...base, download });
    click(island.tree());
    await flush();
    expect(byTestId(island.tree(), "print-sheets-error")).toBeDefined();
    expect(island.text()).toContain("No matches to print on that day.");
    expect(island.text()).not.toContain("No fixtures to print on that day");
    expect(download).not.toHaveBeenCalled();
  });

  it("any other refusal (429, 500, a non-JSON body) shows the localised generic line, never the server's message", async () => {
    for (const res of [
      Response.json({ ok: false, error: { code: "RATE_LIMITED", message: "Too many requests" } }, { status: 429 }),
      new Response("upstream exploded", { status: 500 }),
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => res));
      const island = renderIsland(PrintScorerSheets, { ...base, download: vi.fn() });
      click(island.tree());
      await flush();
      expect(propsOf(byTestId(island.tree(), "print-sheets-error")!).children).toBe(
        "The sheets could not be prepared. Try again.",
      );
      expect(island.text()).not.toContain("Too many requests");
    }
  });

  it("a dropped connection shows the generic line, and a successful retry clears it", async () => {
    const fetchFn = vi.fn(async () => pdf());
    fetchFn.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchFn);
    const download = vi.fn();
    const island = renderIsland(PrintScorerSheets, { ...base, download });
    click(island.tree());
    await flush();
    expect(byTestId(island.tree(), "print-sheets-error")).toBeDefined();
    click(island.tree());
    await flush();
    expect(byTestId(island.tree(), "print-sheets-error")).toBeUndefined();
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("not allowed → the device-links upgrade gate instead of the button", () => {
    const island = renderIsland(PrintScorerSheets, { ...base, allowed: false, viewerPlan: "community" });
    const gate = island.tree().find((e) => e.type === UpgradeGate);
    expect(gate).toBeDefined();
    expect(propsOf(gate!)).toMatchObject({ feature: "scoring.device_links", viewerPlan: "community" });
    expect(byTestId(island.tree(), "print-sheets-submit")).toBeUndefined();
    expect(byTestId(island.tree(), "print-sheets-day")).toBeUndefined();
  });
});
