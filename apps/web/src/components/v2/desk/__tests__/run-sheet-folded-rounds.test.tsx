// W5 follow-ups C (owner 2026-11-23, Option A "by round"): a big division's run sheet gets a folded round as a TALLY, not its rows
// (`lib/run-sheet-paging.ts`). The stage card's sheet draws it as a shut bar that says the round's own "N of M done", among the shipped
// rounds by kickoff; opening it reads its rows through `loadRound`, and they draw as any round's rows. Node env, no DOM: the default is
// read off the real `RunSheet`'s static markup, the tap is driven through the hook harness (`RoundBar`'s `toggle.onToggle`). The tallies
// are built by the producer the page uses (`foldedRoundOf`) over rows written here, never typed as numbers.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import { RunSheet, type RunSheetFilter } from "@/components/v2/desk/run-sheet";
import { buildRunSheet, type RunSheetFixture } from "@/lib/run-sheet-groups";
import { foldedRoundOf, type FoldedRunSheetRound } from "@/lib/run-sheet-paging";
import enUi from "@/dictionaries/en/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));

const TZ = "UTC";
const NOW_MS = Date.UTC(2026, 8, 5, 12, 0, 0);
const at = (day: number) => new Date(Date.UTC(2026, 8, day, 14, 0)).toISOString();
const ui = enUi as Record<string, string>;
let no = 0;
function fx(round: number, o: Partial<RunSheetFixture> = {}): RunSheetFixture {
  no += 1;
  return {
    id: `f${no}`, stage_id: "s1", fixture_no: no, round_no: round, seq_in_round: no, scheduled_at: at(round), status: "scheduled",
    court_name: null, court_id: null, venue_name: null, officials: [], outcome: null, home_entrant_id: "e1", away_entrant_id: "e2",
    home_slot_label: null, away_slot_label: null, lane: null, is_final: false, third_place: false, conditional: false, ext_key: null, ...o,
  };
}
const played = (round: number) => fx(round, { status: "decided", outcome: { kind: "win", winner: "e1" }, scheduled_at: at(round) });

/** Round 2 is shipped (the next round); round 1 (finished, 3 results) and round 3 (upcoming, one match untimed) are folded. */
function scene() {
  no = 0;
  const r1 = [played(1), played(1), played(1)];
  const r2 = [fx(2), fx(2)];
  const r3 = [fx(3), fx(3, { scheduled_at: null })];
  const folded: FoldedRunSheetRound[] = [foldedRoundOf("s1", 1, r1, new Set()), foldedRoundOf("s1", 3, r3, new Set())];
  return { r1, r2, r3, folded };
}
const stages = [{ id: "s1", seq: 1, kind: "league", name: "League" }];
function propsFor(shipped: RunSheetFixture[], folded: readonly FoldedRunSheetRound[], o: { filter?: RunSheetFilter; loadRound?: (s: string, r: number) => Promise<RunSheetFixture[]> } = {}) {
  return {
    blocks: buildRunSheet({ fixtures: shipped, stages, tz: TZ, nowMs: NOW_MS }),
    stages, tz: TZ, orgTz: TZ, nowMs: NOW_MS, matchMinutes: 60, entrantNames: { e1: "Alpha", e2: "Bravo" }, canEdit: true,
    hrefFor: (f: RunSheetFixture) => `/f/${f.fixture_no}`, filter: o.filter ?? ("all" as RunSheetFilter), onFilter: () => {},
    stageId: "s1", embedded: true, foldedRounds: folded, loadRound: o.loadRound,
  };
}
const sheet = (props: ReturnType<typeof propsFor>) =>
  renderToStaticMarkup(
    <DictProvider dict={ui} locale="en">
      <RunSheet {...props} />
    </DictProvider>,
  );
const toggles = (html: string) =>
  [...html.matchAll(/<button[^>]*data-testid="run-sheet-round-toggle"[^>]*>/g)].map((m) => ({
    expanded: /aria-expanded="(true|false)"/.exec(m[0])?.[1],
    controls: /aria-controls="([^"]*)"/.exec(m[0])?.[1],
  }));
const doneWords = (done: number, total: number) => ui["runsheet.round.done.other"]!.replace("{done}", String(done)).replace("{total}", String(total));
type Island = { tree: () => ReactElement[]; rerender: (p: never) => void };
const bars = (island: Island) => island.tree().filter((el) => propsOf(el).toggle !== undefined);
const tap = (island: Island, i: number) => (propsOf(bars(island)[i]!).toggle as { onToggle: () => void }).onToggle();
const rowsDrawn = (island: Island) => island.tree().filter((el) => propsOf(el).inRound === true && propsOf(el).fixture !== undefined).map((el) => (propsOf(el).fixture as RunSheetFixture).id);
const loadLine = (island: Island) => island.tree().find((el) => propsOf(el)["data-run-sheet-round-load"] !== undefined);
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("C: a folded round of a big run sheet is a shut bar that loads its rows when opened", () => {
  it("the folded rounds draw shut among the shipped round, in kickoff order, saying their own N of M done, with no row", () => {
    const { r2, folded } = scene();
    const html = sheet(propsFor(r2, folded));
    expect(toggles(html)).toEqual([
      { expanded: "false", controls: "run-sheet-rounds-s1-1" },
      { expanded: "true", controls: "run-sheet-rounds-s1-2" },
      { expanded: "false", controls: "run-sheet-rounds-s1-3" },
    ]);
    expect(html).toContain(doneWords(3, 3));
    expect(html).toContain(doneWords(0, 2));
    const linked = [...new Set([...html.matchAll(/href="\/f\/(\d+)"/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
    expect(linked, "only round 2's two rows are drawn").toEqual(r2.map((f) => f.fixture_no));
  });

  it("without folded rounds the sheet is exactly what it was", () => {
    const { r2 } = scene();
    const withNone = sheet(propsFor(r2, []));
    const plain = Object.fromEntries(Object.entries(propsFor(r2, [])).filter(([k]) => k !== "foldedRounds" && k !== "loadRound"));
    expect(withNone).toBe(sheet(plain as never));
  });

  it("Unscheduled keeps the folded round holding an untimed match and drops the one that holds none; Needs result keeps neither", () => {
    const { r2, folded } = scene();
    const unscheduled = toggles(sheet(propsFor(r2, folded, { filter: "unscheduled" }))).map((t) => t.controls);
    expect(unscheduled).toEqual(["run-sheet-rounds-s1-3"]);
    const owed = toggles(sheet(propsFor(r2, folded, { filter: "needs_result" }))).map((t) => t.controls);
    expect(owed.filter((c) => c === "run-sheet-rounds-s1-1" || c === "run-sheet-rounds-s1-3")).toEqual([]);
  });

  it("another stage's folded rounds are not this sheet's", () => {
    const { r2, folded } = scene();
    const elsewhere = folded.map((r) => ({ ...r, stageId: "s2" }));
    expect(toggles(sheet(propsFor(r2, elsewhere))).map((t) => t.controls)).toEqual(["run-sheet-rounds-s1-2"]);
  });

  it("opening a folded bar reads exactly that round once, says it is loading, then draws its rows; shutting it keeps them", async () => {
    const { r2, r3, folded } = scene();
    const loadRound = vi.fn(async () => r3);
    const island = renderIsland(RunSheet, propsFor(r2, folded, { loadRound }) as never) as unknown as Island;
    tap(island, 2);
    expect(loadRound.mock.calls).toEqual([["s1", 3]]);
    expect(propsOf(loadLine(island)!)["data-run-sheet-round-load"], "while the read is out").toBe("loading");
    await settle();
    expect(rowsDrawn(island).filter((id) => r3.some((f) => f.id === id)).sort()).toEqual(r3.map((f) => f.id).sort());
    expect(loadLine(island)).toBeUndefined();
    tap(island, 2);
    tap(island, 2);
    expect(loadRound, "a loaded round is not read again").toHaveBeenCalledTimes(1);
  });

  it("a failed read says so with Try again, and Try again reads the round again", async () => {
    const { r2, r1, folded } = scene();
    const loadRound = vi.fn().mockRejectedValueOnce(new Error("rounds 500")).mockResolvedValueOnce(r1);
    const island = renderIsland(RunSheet, propsFor(r2, folded, { loadRound }) as never) as unknown as Island;
    tap(island, 0);
    await settle();
    const line = loadLine(island)!;
    expect(propsOf(line)["data-run-sheet-round-load"]).toBe("error");
    const retry = island.tree().find((el) => el.type === "button" && propsOf(el).onClick !== undefined && propsOf(el).children === ui["runsheet.round.retry"]);
    expect(retry, "the Try again button").toBeDefined();
    (propsOf(retry!).onClick as () => void)();
    await settle();
    expect(loadRound).toHaveBeenCalledTimes(2);
    expect(rowsDrawn(island).filter((id) => r1.some((f) => f.id === id)).length).toBe(3);
  });

  it("review I1: a new render of the page (router.refresh, new folded rounds) re-reads every OPEN folded round and draws its new rows - never stuck on Loading", async () => {
    const { r2, r3, folded } = scene();
    // The second read answers the round as it now stands: its first match has been played.
    const replayed = [{ ...r3[0]!, status: "decided", outcome: { kind: "win", winner: "e1" } }, r3[1]!];
    const loadRound = vi.fn().mockResolvedValueOnce(r3).mockResolvedValueOnce(replayed);
    const island = renderIsland(RunSheet, propsFor(r2, folded, { loadRound }) as never) as unknown as Island;
    tap(island, 2);
    await settle();
    expect(rowsDrawn(island).filter((id) => r3.some((f) => f.id === id)).length, "premise: the round's rows are drawn").toBe(2);
    island.rerender(propsFor(r2, [...folded], { loadRound }) as never);
    await settle();
    expect(loadRound.mock.calls, "the open round is read again, once").toEqual([["s1", 3], ["s1", 3]]);
    expect(loadLine(island), "not stuck on Loading").toBeUndefined();
    const drawn = island.tree().filter((el) => propsOf(el).inRound === true && (propsOf(el).fixture as RunSheetFixture | undefined)?.id === r3[0]!.id);
    expect(drawn.map((el) => (propsOf(el).fixture as RunSheetFixture).status), "the new answer's row").toEqual(["decided"]);
  });

  it("a new render reads nothing for a folded round nobody opened", async () => {
    const { r2, folded } = scene();
    const loadRound = vi.fn(async () => []);
    const island = renderIsland(RunSheet, propsFor(r2, folded, { loadRound }) as never) as unknown as Island;
    island.rerender(propsFor(r2, [...folded], { loadRound }) as never);
    await settle();
    expect(loadRound).not.toHaveBeenCalled();
  });
});
