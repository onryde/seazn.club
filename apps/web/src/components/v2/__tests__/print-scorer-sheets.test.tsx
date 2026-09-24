// Scorer sheets §4.4 — the organiser's print control, driven through its REAL
// state with the hook harness (no jsdom here): what the day picker opens at,
// what one click POSTs, what a refusal shows, and what reaches the downloader.
// The route it POSTs to is Task 8's; `fetch` is stubbed with that route's
// contract (200 application/pdf + a content-disposition filename; refusals in
// the v1 envelope `{ ok:false, error:{ code, message } }`).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import en from "@/dictionaries/en/ui.json";
import fr from "@/dictionaries/fr/ui.json";

vi.mock("@/components/upgrade-gate", () => ({ UpgradeGate: vi.fn(() => null) }));
import { UpgradeGate } from "@/components/upgrade-gate";
import { PrintScorerSheets } from "@/components/v2/print-scorer-sheets";

const EN = en as Record<string, string>;
const FR = fr as Record<string, string>;

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
/** A refusal must hand the button BACK: enabled, and saying "Print" again —
 *  not stuck on "Preparing…" with nothing in flight. */
const expectIdle = (island: { tree: () => ReactElement[]; text: () => string }) => {
  expect(propsOf(byTestId(island.tree(), "print-sheets-submit")!).disabled).toBe(false);
  expect(propsOf(byTestId(island.tree(), "print-sheets-submit")!).children).toBe(EN["sheets.print"]);
  expect(island.text()).not.toContain(EN["sheets.preparing"]);
};

afterEach(() => vi.unstubAllGlobals());

describe("PrintScorerSheets (scorer sheets §4.4)", () => {
  it("empty case: no printable days → no control at all", () => {
    const island = renderIsland(PrintScorerSheets, { ...base, days: [], defaultDay: null });
    expect(island.tree()).toEqual([]);
    expect(byTestId(island.tree(), "print-sheets")).toBeUndefined();
  });

  it("the empty case outranks the paywall: no days on a plan without the feature renders nothing, not the gate", () => {
    const island = renderIsland(PrintScorerSheets, { ...base, days: [], defaultDay: null, allowed: false });
    expect(island.tree()).toEqual([]);
    expect(island.tree().find((e) => e.type === UpgradeGate)).toBeUndefined();
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
    // The harness calls onClick directly and so walks straight past
    // `disabled` — which is what makes this second tap a test of the
    // handler's own in-flight guard. In a browser `disabled` stops it first;
    // the assertion above pins that half.
    click(island.tree());
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
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
    const error = byTestId(island.tree(), "print-sheets-error");
    expect(error).toBeDefined();
    // Announced, not just painted: the refusal lands after the click, away
    // from the focus, so a screen reader only hears it as an alert.
    expect(propsOf(error!).role).toBe("alert");
    expect(island.text()).toContain("No matches to print on that day.");
    expect(island.text()).not.toContain("No fixtures to print on that day");
    expect(download).not.toHaveBeenCalled();
    expectIdle(island);
  });

  // Each refusal the route can give, named for what the organiser can DO about
  // it. The two scoring-link lines are reused verbatim — a signed-out or
  // throttled organiser is in the same position whichever button they pressed.
  it.each([
    [401, "dlink.error.signedOut", { code: "UNAUTHENTICATED", message: "Authentication required" }],
    [402, "sheets.error.notAllowed", { code: "FEATURE_NOT_IN_PLAN", message: "Feature not in plan" }],
    [403, "sheets.error.notAllowed", { code: "FORBIDDEN", message: "Forbidden" }],
    [429, "dlink.error.rateLimited", { code: "RATE_LIMITED", message: "Too many requests" }],
    [400, "sheets.error.generic", { code: "VALIDATION", message: "date: Invalid" }],
    [422, "sheets.error.generic", { code: "SOMETHING_ELSE", message: "Unprocessable" }],
    [500, "sheets.error.generic", null],
  ] as const)("a %i refusal shows %s, never the server's message, and hands the button back", async (status, key, error) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        error ? Response.json({ ok: false, error }, { status }) : new Response("upstream exploded", { status }),
      ),
    );
    const download = vi.fn();
    const island = renderIsland(PrintScorerSheets, { ...base, download });
    click(island.tree());
    await flush();
    expect(EN[key]).toBeTruthy();
    expect(propsOf(byTestId(island.tree(), "print-sheets-error")!).children).toBe(EN[key]);
    if (error) expect(island.text()).not.toContain(error.message);
    expect(island.text()).not.toContain("upstream exploded");
    expect(download).not.toHaveBeenCalled();
    expectIdle(island);
  });

  it("a dropped connection shows the generic line, and a successful retry clears it", async () => {
    const fetchFn = vi.fn(async () => pdf());
    fetchFn.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchFn);
    const download = vi.fn();
    const island = renderIsland(PrintScorerSheets, { ...base, download });
    click(island.tree());
    await flush();
    expect(propsOf(byTestId(island.tree(), "print-sheets-error")!).children).toBe(EN["sheets.error.generic"]);
    expectIdle(island);
    click(island.tree());
    await flush();
    expect(byTestId(island.tree(), "print-sheets-error")).toBeUndefined();
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("not allowed → the device-links upgrade gate instead of the button", () => {
    const island = renderIsland(PrintScorerSheets, { ...base, allowed: false, viewerPlan: "community" });
    const gate = island.tree().find((e) => e.type === UpgradeGate);
    expect(gate).toBeDefined();
    expect(propsOf(gate!)).toMatchObject({
      feature: "scoring.device_links",
      viewerPlan: "community",
      // The feature's own sentence is about hand-over scoring links; this gate
      // sells PRINTING, so it says so.
      reason: EN["sheets.gate.reason"],
    });
    expect(EN["sheets.gate.reason"]).toBeTruthy();
    expect(byTestId(island.tree(), "print-sheets-submit")).toBeUndefined();
    expect(byTestId(island.tree(), "print-sheets-day")).toBeUndefined();
  });

  it("the gate's reason is in the organiser's language", () => {
    vi.mocked(UpgradeGate).mockImplementationOnce(({ reason }) => <span data-reason="">{reason}</span>);
    const html = renderToStaticMarkup(
      <DictProvider dict={fr} locale="fr">
        <PrintScorerSheets {...base} allowed={false} viewerPlan="community" />
      </DictProvider>,
    );
    expect(FR["sheets.gate.reason"]).toBeTruthy();
    expect(FR["sheets.gate.reason"]).not.toBe(EN["sheets.gate.reason"]);
    expect(html).toBe(`<span data-reason="">${FR["sheets.gate.reason"]!.replaceAll("'", "&#x27;")}</span>`);
  });
});
