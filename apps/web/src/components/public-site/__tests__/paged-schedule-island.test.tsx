// W5 follow-ups C, review I1: a big division's paged Schedule (`PagedSchedule`) reads a folded round's rows when it is opened
// (`[divisionSlug]/rounds`, fetch stubbed with the round's rows), and when the page hands it a NEW document (a poll, a
// `router.refresh()`) it reads every still-open folded round AGAIN and draws the new answer - never a "Loading" line that nothing
// will ever replace. A round nobody opened is not read. Node env: driven through the hook harness (effects run on commit).
// Single-sport: the loader is sport-blind (it reads round keys and fixture rows), the sport sweep is the planner's.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { packRows } from "@/lib/packed-rows";
import { pageSchedule, type PagedScheduleData } from "@/lib/schedule-paging";
import type { PublicFixture } from "@/server/public-site/data";
import { pagedScheduleCopy, publicScheduleCopy } from "@/server/public-site/schedule-copy";
import { PagedSchedule } from "../paged-schedule";

const NOW = Date.UTC(2026, 10, 23, 12, 0);
const DAY = 86_400_000;
let n = 0;
const F = (round: number, status: string, o: Partial<PublicFixture> = {}): PublicFixture => ({
  id: `f${++n}`, division_id: "d1", stage_id: "lg", pool_id: null, round_no: round, seq_in_round: n, home_entrant_id: "e1",
  away_entrant_id: "e2", home_slot_label: null, away_slot_label: null, scheduled_at: new Date(NOW + (round - 8) * DAY).toISOString(),
  venue: null, court_label: null, venue_name: null, court_name: null, status, outcome: status === "decided" ? { winner: "home" } : null,
  summary: null, last_seq: null, ext_key: null, ...o,
} as PublicFixture);

/** 15 rounds of 15 (225 rows, over the paging line): rounds 1-7 played, 8-15 to come - round 8 is next, 9-15 folded. */
function rows(): PublicFixture[] {
  n = 0;
  return Array.from({ length: 225 }, (_, i) => F(Math.floor(i / 15) + 1, Math.floor(i / 15) + 1 <= 7 ? "decided" : "scheduled"));
}
function dataOf(all: PublicFixture[]): PagedScheduleData {
  const { groups, rowsOf } = pageSchedule(all, { roundLabels: {}, stageOrder: { lg: 1 }, stageNames: { lg: "League" } });
  return { groups: groups.map((g) => (g.open ? { ...g, rows: packRows(rowsOf.get(g.key)!) } : g)), extras: { slotLabels: {}, forfeit: {} } };
}

const calls: string[] = [];
/** The rounds route stubbed: round `key`'s rows as `current()` holds them now. */
function stubFetch(current: () => PublicFixture[], fail: number[] = []) {
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    if (fail.includes(calls.length)) return new Response("{}", { status: 500 });
    const key = new URL(url, "http://x").searchParams.get("round")!;
    const { rowsOf } = pageSchedule(current(), { roundLabels: {}, stageOrder: { lg: 1 }, stageNames: { lg: "League" } });
    return new Response(JSON.stringify({ ok: true, data: { kind: "round", key, rows: rowsOf.get(key) ?? [], extras: { slotLabels: {}, forfeit: {} } } }), { status: 200 });
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

const dict = en as unknown as Dict;
const props = (data: PagedScheduleData) => ({
  data,
  entrantNames: { e1: "Alpha", e2: "Bravo" },
  divisionPath: "/live/o/c/d",
  tz: "UTC",
  copy: publicScheduleCopy(dict, () => "TBD"),
  pagedCopy: pagedScheduleCopy(dict),
  locale: "en",
});
type Island = { tree: () => ReactElement[]; rerender: (p: never) => void };
const sectionAt = (island: Island, key: string) => island.tree().findIndex((el) => propsOf(el)["data-round-key"] === key && propsOf(el)["data-testid"] === "paged-round");
const toggleOf = (island: Island, key: string) => island.tree().slice(sectionAt(island, key)).find((el) => propsOf(el)["data-testid"] === "paged-round-toggle")!;
const loadingIn = (island: Island, key: string) => {
  const tree = island.tree();
  const at = sectionAt(island, key);
  const next = tree.findIndex((el, i) => i > at && propsOf(el)["data-testid"] === "paged-round");
  return tree.slice(at, next === -1 ? undefined : next).some((el) => propsOf(el)["data-testid"] === "paged-round-loading");
};
const courtsIn = (island: Island, key: string) => {
  const tree = island.tree();
  const at = sectionAt(island, key);
  const next = tree.findIndex((el, i) => i > at && propsOf(el)["data-testid"] === "paged-round");
  return tree
    .slice(at, next === -1 ? undefined : next)
    .filter((el) => (propsOf(el).fixture as PublicFixture | undefined)?.id !== undefined && propsOf(el).railMode !== undefined)
    .map((el) => (propsOf(el).fixture as PublicFixture).court_name);
};
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("review I1: an open folded round of the paged Schedule is read again under a new document, never stuck on Loading", () => {
  it("opening folded round 9 reads it once and draws its rows", async () => {
    let now = rows();
    stubFetch(() => now);
    const data = dataOf(now);
    const key9 = data.groups.find((g) => g.roundNo === 9)!.key;
    expect(data.groups.find((g) => g.roundNo === 9)!.open, "premise: round 9 is folded").toBe(false);
    const island = renderIsland(PagedSchedule, props(data) as never) as unknown as Island;
    (propsOf(toggleOf(island, key9)).onClick as () => void)();
    await settle();
    expect(calls.length).toBe(1);
    expect(courtsIn(island, key9)).toEqual(Array(15).fill(null));
    now = [];
  });

  it("a new document (round 9's first match moved to Court 4) re-reads the open round and draws the new answer; not stuck on Loading", async () => {
    let now = rows();
    stubFetch(() => now);
    const data = dataOf(now);
    const key9 = data.groups.find((g) => g.roundNo === 9)!.key;
    const island = renderIsland(PagedSchedule, props(data) as never) as unknown as Island;
    (propsOf(toggleOf(island, key9)).onClick as () => void)();
    await settle();
    expect(courtsIn(island, key9).length, "premise: round 9 is drawn").toBe(15);
    // A change that does not move the plan (round 9 stays folded, so the new document still ships none of its rows).
    const first9 = now.find((f) => f.round_no === 9)!.id;
    now = now.map((f) => (f.id === first9 ? { ...f, court_name: "Court 4" } : f));
    const next = dataOf(now);
    expect(next.groups.find((g) => g.key === key9)!.rows, "premise: still folded").toBeUndefined();
    island.rerender(props(next) as never);
    await settle();
    expect(calls.length, "round 9 is read again, once").toBe(2);
    expect(loadingIn(island, key9), "not stuck on Loading").toBe(false);
    expect(courtsIn(island, key9)).toEqual(["Court 4", ...Array(14).fill(null)]);
  });

  it("a new document reads nothing for a folded round nobody opened", async () => {
    const now = rows();
    stubFetch(() => now);
    const island = renderIsland(PagedSchedule, props(dataOf(now)) as never) as unknown as Island;
    island.rerender(props(dataOf(now)) as never);
    await settle();
    expect(calls).toEqual([]);
  });

  it("a failed read says so with Try again, is not retried on its own, and Try again reads the round again", async () => {
    const now = rows();
    stubFetch(() => now, [1]);
    const data = dataOf(now);
    const key9 = data.groups.find((g) => g.roundNo === 9)!.key;
    const island = renderIsland(PagedSchedule, props(data) as never) as unknown as Island;
    (propsOf(toggleOf(island, key9)).onClick as () => void)();
    await settle();
    const alert = island.tree().find((el) => propsOf(el).role === "alert")!;
    expect(alert, "the failure is said").toBeDefined();
    await settle();
    expect(calls.length, "no read loop").toBe(1);
    const retry = island.tree().slice(island.tree().indexOf(alert)).find((el) => el.type === "button")!;
    (propsOf(retry).onClick as () => void)();
    await settle();
    expect(calls.length).toBe(2);
    expect(courtsIn(island, key9).length).toBe(15);
  });
});

// Review minor: the team search's answer is checked against the pick it was asked for. A slow answer for an earlier pick, landing after
// a newer pick's, must never draw the earlier team's rows under "Showing <newer team>"; nor may an answer naming another team.
describe("the team search draws only the answer for the team on screen", () => {
  type Answer = { kind: "entrant"; entrantId: string; rounds: { key: string; rows: PublicFixture[] }[]; extras: { slotLabels: object; forfeit: object } };
  const answerFor = (entrantId: string, key: string): Answer => ({
    kind: "entrant",
    entrantId,
    rounds: [{ key, rows: [F(9, "scheduled", { id: `${entrantId}-row` })] }],
    extras: { slotLabels: {}, forfeit: {} },
  });
  /** Fetch held open per entrant until the test answers it. */
  function deferredFetch() {
    const pending = new Map<string, (body: unknown) => void>();
    vi.stubGlobal("fetch", (url: string) => {
      calls.push(url);
      const entrant = new URL(url, "http://x").searchParams.get("entrant")!;
      return new Promise((resolve) => pending.set(entrant, (body) => resolve(new Response(JSON.stringify({ ok: true, data: body }), { status: 200 }))));
    });
    return pending;
  }
  const pick = (island: Island, name: string) => {
    const input = island.tree().find((el) => propsOf(el)["data-testid"] === "paged-team-search")!;
    (propsOf(input).onChange as (e: { target: { value: string } }) => void)({ target: { value: name.slice(0, 3) } });
    const button = island.tree().find((el) => el.type === "button" && textOf(el) === name)!;
    expect(button, `premise: ${name} is suggested`).toBeDefined();
    (propsOf(button).onClick as () => void)();
  };
  const teamRows = (island: Island) =>
    island.tree().filter((el) => propsOf(el).railMode !== undefined && (propsOf(el).fixture as PublicFixture | undefined)?.id?.endsWith("-row")).map((el) => (propsOf(el).fixture as PublicFixture).id);

  it("Alpha asked, then Bravo; Bravo answers first, Alpha's late answer is dropped: Bravo's rows stay", async () => {
    const pending = deferredFetch();
    const data = dataOf(rows());
    const key9 = data.groups.find((g) => g.roundNo === 9)!.key;
    const island = renderIsland(PagedSchedule, props(data) as never) as unknown as Island;
    pick(island, "Alpha");
    pick(island, "Bravo");
    expect(calls.length, "premise: two reads out").toBe(2);
    pending.get("e2")!(answerFor("e2", key9));
    await settle();
    expect(teamRows(island)).toEqual(["e2-row"]);
    pending.get("e1")!(answerFor("e1", key9));
    await settle();
    expect(teamRows(island), "Alpha's late answer never replaces Bravo's").toEqual(["e2-row"]);
  });

  it("an answer naming another team is not drawn: the search says it failed", async () => {
    const pending = deferredFetch();
    const data = dataOf(rows());
    const key9 = data.groups.find((g) => g.roundNo === 9)!.key;
    const island = renderIsland(PagedSchedule, props(data) as never) as unknown as Island;
    pick(island, "Bravo");
    pending.get("e2")!(answerFor("e1", key9));
    await settle();
    expect(teamRows(island)).toEqual([]);
    expect(island.tree().some((el) => propsOf(el).role === "alert"), "the failure is said").toBe(true);
  });
});

