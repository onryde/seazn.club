// W5 follow-ups C, review I2 sweep: a big division's desk holds only the window's rows plus a TALLY of its folded rounds
// (`lib/run-sheet-paging.ts`). The Add match form's Round select plans over the stage's lines (`adhocRoundPlan`): over the window
// alone it offered "Round 7 (new)" in a 21-round league and called a folded round where a side already plays "free" - and the server
// writes the round the form sends, so the match landed beside one the side already has. Over a windowed stage the form reads the
// stage's every line (`rounds?round=all`) before it plans. The expected rows are the whole list's own (`stageFixtures` unwindowed),
// never a number typed here. Drives the real island (the hook harness): the rail's Add match, the form it opens.
import { afterEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { StagesPanel } from "@/components/v2/stages-panel";
import { windowRunSheet } from "@/lib/run-sheet-paging";

vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock("@/lib/client-v1", async (importOriginal) => ({ ...(await importOriginal<object>()), apiV1: vi.fn(async () => ({})) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const NOW = Date.now();
/** A 22-player single league (231 lines, over the paging line): rounds 1-5 played, 6-21 to come. */
function league() {
  const rows = [];
  let n = 0;
  for (let round = 1; round <= 21; round++) {
    for (let seq = 1; seq <= 11; seq++) {
      n += 1;
      const done = round <= 5;
      rows.push({
        id: `f${n}`, division_id: "d1", stage_id: "s1", pool_id: null, fixture_no: n, round_no: round, seq_in_round: seq,
        status: done ? "decided" : "scheduled", scheduled_at: new Date(NOW + (round - 6) * 7 * 86_400_000).toISOString(),
        home_entrant_id: `e${seq}`, away_entrant_id: `e${seq + 11}`, outcome: done ? { kind: "win", winner: `e${seq}` } : null,
        home_slot_label: null, away_slot_label: null, court_id: null, court_name: null, venue_name: null, officials: [], lane: null,
        is_final: false, third_place: false, conditional: false, ext_key: null,
      });
    }
  }
  return rows;
}
const calls: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});
function props(fixtures: unknown[], foldedRounds?: unknown[]) {
  return {
    divisionId: "d1", competitionId: "c1", orgSlug: "org", compSlug: "comp", divSlug: "div", tz: "UTC", orgTz: "UTC", canExport: false,
    viewerPlan: "community" as const, canEdit: true, matchMinutes: 60,
    entrantNames: Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`e${i + 1}`, `Player ${i + 1}`])),
    stages: [{ id: "s1", seq: 1, kind: "league", name: "League", config: { legs: 1 }, progression: null, status: "active" }],
    fixtures,
    ...(foldedRounds ? { foldedRounds } : {}),
  };
}
type Island = { tree: () => import("react").ReactElement[] };
async function openAddMatch(island: Island) {
  const rail = island.tree().find((el) => typeof propsOf(el).onToggleAddMatch === "function");
  expect(rail, "premise: the stage rail offers Add match").toBeDefined();
  (propsOf(rail!).onToggleAddMatch as (id: string) => void)("s1");
  await flush();
  await flush();
}
/** The open Add match form (`AddMatchForm`, not exported: found by its own props). */
const form = (island: Island) => {
  const el = island.tree().find((x) => "roundRows" in propsOf(x) && typeof propsOf(x).onCancel === "function");
  expect(el, "premise: the Add match form is open").toBeDefined();
  return propsOf(el!) as { roundRows: { round_no: number }[] | null; roundRowsFailed?: boolean };
};

describe("I2 sweep: the Add match form on a windowed stage plans over every line of the stage", () => {
  it("the whole list: the form plans over the stage's 231 lines and reads nothing", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return new Response("{}", { status: 500 });
    });
    const island = renderIsland(StagesPanel, props(league()) as never);
    await openAddMatch(island);
    expect(form(island).roundRows?.length).toBe(231);
    expect(calls).toEqual([]);
  });

  it("the window: the form reads the stage's every line once, then plans over the same rows the whole list gives", async () => {
    const all = league();
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ ok: true, data: all }), { status: 200 });
    });
    const w = windowRunSheet(all, [{ id: "s1", kind: "league" }], { held: new Set(), nowMs: NOW, tz: "UTC" });
    expect(w.shipped.length, "premise: the window ships a fraction").toBeLessThan(all.length / 4);
    const island = renderIsland(StagesPanel, props(w.shipped, w.folded) as never);
    await openAddMatch(island);
    expect(calls.length).toBe(1);
    expect(new URL(calls[0]!, "http://x").searchParams.get("round")).toBe("all");
    expect(form(island).roundRows?.map((r) => r.round_no)).toEqual(all.map((f) => f.round_no));
    expect(form(island).roundRowsFailed).toBe(false);
  });

  it("the window, the read fails: the form says so and offers no round (never plans over the window alone)", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return new Response("{}", { status: 500 });
    });
    const all = league();
    const w = windowRunSheet(all, [{ id: "s1", kind: "league" }], { held: new Set(), nowMs: NOW, tz: "UTC" });
    const island = renderIsland(StagesPanel, props(w.shipped, w.folded) as never);
    await openAddMatch(island);
    expect(calls.length, "read once, not in a loop").toBe(1);
    expect(form(island).roundRows, "no round planned over the window alone").toBeNull();
    expect(form(island).roundRowsFailed, "the failure is said").toBe(true);
  });

  it("the form over a windowed stage, as drawn: Reading while the lines are out, the failure line when they fail, never a Round select", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const all = league();
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    const w = windowRunSheet(all, [{ id: "s1", kind: "league" }], { held: new Set(), nowMs: NOW, tz: "UTC" });
    const island = renderIsland(StagesPanel, props(w.shipped, w.folded) as never);
    await openAddMatch(island);
    const el = island.tree().find((x) => "roundRows" in propsOf(x) && typeof propsOf(x).onCancel === "function")!;
    const failed = renderToStaticMarkup(createElement(el.type as never, propsOf(el) as never));
    const loading = renderToStaticMarkup(createElement(el.type as never, { ...propsOf(el), roundRowsFailed: false } as never));
    expect(failed).toContain('data-testid="add-match-rounds-failed"');
    expect(failed).not.toContain('data-testid="add-match-round"');
    expect(loading).toContain('data-testid="add-match-rounds-loading"');
    expect(loading).not.toContain('data-testid="add-match-round"');
    const whole = renderToStaticMarkup(createElement(el.type as never, { ...propsOf(el), roundRows: [], roundRowsFailed: false } as never));
    expect(whole, "premise: with lines the select is drawn").toContain('data-testid="add-match-round"');
  });

  // Review N1: the failure line tells the organiser to close the form and open it again - so that must read the lines again.
  it("the read fails; closing and reopening the form by the rail reads again and plans over the whole list", async () => {
    const all = league();
    let n = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      n += 1;
      return n === 1 ? new Response("{}", { status: 500 }) : new Response(JSON.stringify({ ok: true, data: all }), { status: 200 });
    });
    const w = windowRunSheet(all, [{ id: "s1", kind: "league" }], { held: new Set(), nowMs: NOW, tz: "UTC" });
    const island = renderIsland(StagesPanel, props(w.shipped, w.folded) as never);
    await openAddMatch(island);
    expect(form(island).roundRowsFailed, "premise: the first read failed").toBe(true);
    // Close by the rail's own toggle, then open again.
    await openAddMatch(island);
    expect(island.tree().some((x) => "roundRows" in propsOf(x) && typeof propsOf(x).onCancel === "function"), "premise: closed").toBe(false);
    await openAddMatch(island);
    expect(calls.length, "reopened: read again").toBe(2);
    expect(form(island).roundRows?.length).toBe(231);
    expect(form(island).roundRowsFailed).toBe(false);
  });

  it("a failed read, then Cancel, then open: read again", async () => {
    const all = league();
    let n = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      n += 1;
      return n === 1 ? new Response("{}", { status: 500 }) : new Response(JSON.stringify({ ok: true, data: all }), { status: 200 });
    });
    const w = windowRunSheet(all, [{ id: "s1", kind: "league" }], { held: new Set(), nowMs: NOW, tz: "UTC" });
    const island = renderIsland(StagesPanel, props(w.shipped, w.folded) as never);
    await openAddMatch(island);
    expect(form(island).roundRowsFailed, "premise: the first read failed").toBe(true);
    const cancel = island.tree().find((x) => "roundRows" in propsOf(x) && typeof propsOf(x).onCancel === "function")!;
    (propsOf(cancel).onCancel as () => void)();
    await flush();
    await openAddMatch(island);
    expect(calls.length, "reopened after Cancel: read again").toBe(2);
    expect(form(island).roundRows?.length).toBe(231);
  });
});

