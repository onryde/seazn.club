// W1d Task 14 (item 15c, D17): the run sheet's DEFAULT filter on a match day.
// stages-panel.tsx opens the sheet on "all" in EVERY phase since Match Day PB1
// (owner 2026-11-02; it used to open on "today" on a match day), and a page
// object that widens the filter first never sees the default. readDefaultFilter
// reads it BEFORE the page object's own widening; judgeTodayDefault judges it.
// PB1 also folds a completed stage's card and a finished round: openFoldsAround
// opens them around a row before openFixtureUi clicks it.
//
// Expected values come from the product's text (stages-panel.tsx, run-sheet.tsx,
// division-phase.ts), read here, never from the code under test.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Evidence, type EvidenceFs } from "../lib/browser/evidence.ts";
import { type PageCtx } from "../lib/browser/pages/ctx.ts";
import { ALL_FILTER, ROUND_LIST_PREFIX, TODAY_FILTER, judgeTodayDefault, openFoldsAround, readDefaultFilter, readThenShowAll } from "../lib/browser/pages/run-sheet.ts";
import { DATA, TESTID } from "../lib/browser/selectors.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const src = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
const V2 = "apps/web/src/components/v2";

/** A run sheet whose filter buttons carry `aria-pressed`, whose rows depend on the pressed filter, and whose clicks are logged. */
function fakeRunSheet(o: { pressed: string; rows: Record<string, number[]>; offersFilter?: boolean; noDataFilter?: boolean; pressedButtons?: number }) {
  const log: string[] = [];
  let pressed = o.pressed;
  const filterSel = `[data-testid="${TESTID.runSheetFilter.id}"] ${DATA.runSheetFilterOption.selector}`;
  const valueOf = (s: string): string | null => /\[data-filter="([^"]+)"\]/.exec(s)?.[1] ?? null;
  const page = {
    locator: (s: string) => ({
      count: async () => {
        if (o.offersFilter === false) return 0;
        // The pressed-option query matches one button; the all-option query too; anything else is the rows.
        if (s.startsWith(filterSel)) return s.includes('[aria-pressed="true"]') ? (valueOf(s) === null ? (o.pressedButtons ?? 1) : valueOf(s) === pressed ? 1 : 0) : 1;
        return o.rows[pressed]?.length ?? 0;
      },
      getAttribute: async (a: string) => {
        log.push(`read ${a}`);
        if (a === "aria-pressed") return String(valueOf(s) === pressed);
        if (a === "data-filter") return o.noDataFilter === true ? null : pressed;
        return null;
      },
      click: async () => { log.push(`click ${valueOf(s) ?? s}`); pressed = valueOf(s) ?? pressed; },
      waitFor: async () => { log.push("wait"); },
      evaluateAll: async (fn: (els: { getAttribute: (n: string) => string | null }[]) => unknown) => {
        log.push("read rows");
        return fn((o.rows[pressed] ?? []).map((n) => ({ getAttribute: (name: string) => (name === "data-fixture-no" ? String(n) : null) })));
      },
    }),
    evaluate: async () => ({ scrollWidth: 1280, clientWidth: 1280 }),
    screenshot: async () => new TextEncoder().encode(`screen ${pressed}`),
  };
  const files = new Map<string, Uint8Array>();
  const fs: EvidenceFs = { mkdir: () => undefined, writeFile: (p, d) => { files.set(p, d); }, readFile: (p) => files.get(p) ?? new Uint8Array() };
  const ctx = { page: page as unknown as PageCtx["page"], base: "http://localhost:3999", orgSlug: "org", holdMs: 3000, evidence: new Evidence("/r", "case-1", fs) } as PageCtx;
  return { ctx, log, pressedNow: () => pressed };
}
const SHEET = { today: [1, 3], all: [1, 2, 3, 4], needs_result: [], unscheduled: [] };

describe("readDefaultFilter: the filter the organiser first finds on the run sheet", () => {
  it("reads the pressed filter and the rows it shows, and presses nothing", async () => {
    const s = fakeRunSheet({ pressed: "today", rows: SHEET });
    expect(await readDefaultFilter(s.ctx)).toEqual({ filter: "today", rows: [1, 3] });
    expect(s.log.some((l) => l.startsWith("click"))).toBe(false);
    expect(s.pressedNow()).toBe("today");
  });

  it("the empty case: a sheet that offers no filter yet is answered null, never an invented 'all'", async () => {
    const s = fakeRunSheet({ pressed: "all", rows: SHEET, offersFilter: false });
    expect(await readDefaultFilter(s.ctx)).toBeNull();
  });

  it("the rows are numbers, sorted, whatever order the page lists them in", async () => {
    const s = fakeRunSheet({ pressed: "today", rows: { ...SHEET, today: [10, 2, 7] } });
    expect(await readDefaultFilter(s.ctx)).toEqual({ filter: "today", rows: [2, 7, 10] });
  });

  it("two pressed filters at once is refused by name, never read as the first (the sheet offers one at a time)", async () => {
    const s = fakeRunSheet({ pressed: "today", rows: SHEET, pressedButtons: 2 });
    await expect(readDefaultFilter(s.ctx)).rejects.toThrow(/2 pressed filters/);
    expect(s.log).not.toContain("read data-filter");
  });

  it("a pressed filter button that carries no data-filter value is refused by name, never read as a filter called null", async () => {
    const s = fakeRunSheet({ pressed: "today", rows: SHEET, noDataFilter: true });
    await expect(readDefaultFilter(s.ctx)).rejects.toThrow(/data-filter/);
  });

  it("a row with no readable fixture number is refused by name, not read as 0", async () => {
    const s = fakeRunSheet({ pressed: "today", rows: { ...SHEET, today: [Number.NaN] } });
    await expect(readDefaultFilter(s.ctx)).rejects.toThrow(/fixture number/);
  });
});

describe("readThenShowAll: the default is read BEFORE the sheet is widened (D17)", () => {
  it("returns what the sheet showed on arrival ('today', rows 1 and 3), then leaves it on 'all' — the read precedes the click", async () => {
    const s = fakeRunSheet({ pressed: "today", rows: SHEET });
    const seen = await readThenShowAll(s.ctx, true);
    expect(seen).toEqual({ filter: "today", rows: [1, 3] });
    expect(s.pressedNow()).toBe(ALL_FILTER);
    const firstClick = s.log.findIndex((l) => l.startsWith("click"));
    expect(firstClick).toBeGreaterThan(-1);
    expect(s.log.indexOf("read rows")).toBeGreaterThan(-1);
    expect(s.log.indexOf("read rows")).toBeLessThan(firstClick);
  });

  it("asked not to read, it only widens: no read, and the sheet is on 'all'", async () => {
    const s = fakeRunSheet({ pressed: "today", rows: SHEET });
    expect(await readThenShowAll(s.ctx, false)).toBeNull();
    expect(s.log).not.toContain("read rows");
    expect(s.pressedNow()).toBe(ALL_FILTER);
  });
});

describe("judgeTodayDefault: 'all' in every phase, a match day included (D17, Match Day PB1)", () => {
  const seen = (filter: string, rows: number[]) => ({ filter, rows });
  const PHASES = ["setting_up", "scheduled", "match_day", "finished"];

  it("the empty case first: no fixture dated today abstains, counted 0, and says why", () => {
    expect(judgeTodayDefault({ phase: "scheduled", seen: seen("all", [1, 2, 3]), datedToday: [] })).toEqual({ verdict: "abstain", checked: 0, note: expect.stringContaining("no fixture dated today") });
    // ...whatever the sheet opened on: nothing was dated to prove it by.
    expect(judgeTodayDefault({ phase: "match_day", seen: seen("today", []), datedToday: [] }).verdict).toBe("abstain");
  });

  it("every phase: a sheet opened on 'all' passes, one opened on 'today' fails - the match day is no exception now", () => {
    let checked = 0;
    for (const phase of PHASES) {
      expect(judgeTodayDefault({ phase, seen: seen("all", [1, 2, 3, 4]), datedToday: [1, 3] }), phase).toMatchObject({ verdict: "pass", checked: 1 });
      expect(judgeTodayDefault({ phase, seen: seen("today", [1, 3]), datedToday: [1, 3] }), phase).toMatchObject({ verdict: "fail", checked: 1 });
      checked++;
    }
    expect(checked, "anti-vacuity: every phase division-phase.ts declares (pinned below)").toBe(4);
  });

  it("a sheet that offered no filter is a failure of its own, not an abstain", () => {
    expect(judgeTodayDefault({ phase: "match_day", seen: null, datedToday: [1, 3] })).toMatchObject({ verdict: "fail", checked: 0 });
  });

  it("the failure note says what the sheet showed and what it should have", () => {
    const j = judgeTodayDefault({ phase: "match_day", seen: seen("today", [1, 3]), datedToday: [1, 3] });
    expect(j.note).toContain(TODAY_FILTER);
    expect(j.note).toContain(ALL_FILTER);
  });
});

/** A run-sheet row inside a stage card and a round list, whose card and round can each be folded; clicks are logged. */
function foldedRow(o: { card: "folded" | "open" | "none"; listId: string | null; round: "folded" | "open" | "none" }) {
  const log: string[] = [];
  let card = o.card;
  let round = o.round;
  const cardToggle = `[data-testid="${TESTID.stageCollapseToggle.id}"]`;
  const bar = o.listId === null ? "" : `[data-testid="${TESTID.runSheetRoundToggle.id}"][aria-controls="${o.listId}"]`;
  const loc = (s: string) => ({
    count: async () => {
      if (s === `${cardToggle}[aria-expanded="false"]`) return card === "folded" ? 1 : 0;
      if (bar !== "" && s === `${bar}[aria-expanded="false"]`) return round === "folded" ? 1 : 0;
      throw new Error(`unexpected count of ${s}`);
    },
    click: async () => {
      if (s === cardToggle) { log.push("open card"); card = "open"; return; }
      if (s === bar) { log.push("open round"); round = "open"; return; }
      throw new Error(`unexpected click on ${s}`);
    },
    waitFor: async () => {
      const ok = s === `${cardToggle}[aria-expanded="true"]` ? card === "open" : s === `${bar}[aria-expanded="true"]` ? round === "open" : false;
      if (!ok) throw Object.assign(new Error(`never: ${s}`), { name: "TimeoutError" });
    },
    getAttribute: async (a: string) => (a === "id" ? o.listId : null),
  });
  const row = {
    locator: (s: string) => {
      if (s === "xpath=ancestor::section[@data-stage-id][1]") return { locator: (inner: string) => loc(inner) };
      if (s === "xpath=ancestor::ul[1]") return loc("ul");
      throw new Error(`unexpected row.locator(${s})`);
    },
  };
  const ctx = { page: { locator: loc } as unknown as PageCtx["page"], base: "http://localhost:3999", orgSlug: "org", holdMs: 3000, evidence: new Evidence("/r", "case-1", { mkdir: () => undefined, writeFile: () => undefined, readFile: () => new Uint8Array() }) } as PageCtx;
  return { ctx, row: row as unknown as Parameters<typeof openFoldsAround>[1], log };
}
const ROUND_LIST = `${ROUND_LIST_PREFIX}11111111-1111-4111-8111-111111111111-2`;

describe("openFoldsAround: openFixtureUi opens the folds around a settled row before it clicks (Match Day PB1)", () => {
  it("the empty case first: a row already on screen (open card, open round) - nothing is clicked", async () => {
    const r = foldedRow({ card: "open", listId: ROUND_LIST, round: "open" });
    await openFoldsAround(r.ctx, r.row);
    expect(r.log).toEqual([]);
  });

  it("a completed card and a finished round: the card first, then the round", async () => {
    const r = foldedRow({ card: "folded", listId: ROUND_LIST, round: "folded" });
    await openFoldsAround(r.ctx, r.row);
    expect(r.log).toEqual(["open card", "open round"]);
  });

  it("each fold on its own: only the folded one is opened", async () => {
    const cardOnly = foldedRow({ card: "folded", listId: ROUND_LIST, round: "open" });
    await openFoldsAround(cardOnly.ctx, cardOnly.row);
    expect(cardOnly.log).toEqual(["open card"]);
    const roundOnly = foldedRow({ card: "none", listId: ROUND_LIST, round: "folded" });
    await openFoldsAround(roundOnly.ctx, roundOnly.row);
    expect(roundOnly.log).toEqual(["open round"]);
  });

  it("a bracket's or a ladder's row (its list is no round list): no bar is looked for", async () => {
    for (const listId of [null, "bracket-r1"]) {
      const r = foldedRow({ card: "folded", listId, round: "none" });
      await openFoldsAround(r.ctx, r.row);
      expect(r.log, String(listId)).toEqual(["open card"]);
    }
  });

  it("a ladder's flat list carries a round-list id but no bar names it: the card is opened, no bar is clicked (PB1 n1)", async () => {
    // The real shape (desk/run-sheet.tsx serves the rounds and the flat branch under one id scheme): a prefixed id, and no
    // round toggle for it, so the folded-bar count is 0.
    const r = foldedRow({ card: "folded", listId: ROUND_LIST, round: "none" });
    await openFoldsAround(r.ctx, r.row);
    expect(r.log).toEqual(["open card"]);
    // The positive pair: the same id WITH a folded bar (a table stage's round) is clicked open.
    const withBar = foldedRow({ card: "folded", listId: ROUND_LIST, round: "folded" });
    await openFoldsAround(withBar.ctx, withBar.row);
    expect(withBar.log).toEqual(["open card", "open round"]);
  });

  it("a round list id that could break out of the selector is refused by name", async () => {
    const r = foldedRow({ card: "open", listId: `${ROUND_LIST_PREFIX}x"],a[href`, round: "folded" });
    await expect(openFoldsAround(r.ctx, r.row)).rejects.toThrow(/round list id/);
  });

  it("a toggle that never opens is a named screen failure, not a silent pass", async () => {
    const r = foldedRow({ card: "folded", listId: ROUND_LIST, round: "folded" });
    const stuck = { ...r.row, locator: (s: string) => {
      const l = (r.row as unknown as { locator: (s: string) => { locator: (i: string) => Record<string, unknown> } }).locator(s);
      if (s !== "xpath=ancestor::section[@data-stage-id][1]") return l;
      return { locator: (inner: string) => ({ ...l.locator(inner), click: async () => undefined }) };
    } };
    await expect(openFoldsAround(r.ctx, stuck as unknown as Parameters<typeof openFoldsAround>[1])).rejects.toThrow(/card opened/);
  });
});

describe("the rule judged is the product's: stages-panel.tsx and run-sheet.tsx say it", () => {
  it("the sheet opens on all in every phase (stages-panel.tsx, Match Day PB1) - and the old match-day initializer is gone", () => {
    const sp = src(`${V2}/stages-panel.tsx`);
    expect(sp).toContain(`useState<RunSheetFilter>("${ALL_FILTER}")`);
    expect(sp).not.toMatch(/useState<RunSheetFilter>\(phase/);
  });

  it("a round's list carries the id its bar's aria-controls names, under the prefix openFoldsAround reads (run-sheet.tsx)", () => {
    const rs = src(`${V2}/desk/run-sheet.tsx`);
    expect(rs).toContain("const listId = `" + ROUND_LIST_PREFIX + "${stageId}-${section.round}`;");
    expect(rs).toContain("<ul id={listId} hidden={!open}");
    expect(rs).toContain("aria-controls={toggle.controls}");
  });

  it("'today' keeps a TIMED fixture landing on today's venue-zone day (and a fixture with a stream up): run-sheet.tsx", () => {
    const rs = src(`${V2}/desk/run-sheet.tsx`);
    expect(rs).toContain(`{ value: "${TODAY_FILTER}", label: msg("runsheet.filter.today") }`);
    expect(rs).toContain("f.scheduled_at !== null && dayKeyInTz(Date.parse(f.scheduled_at), tz) === today");
  });

  it("match_day is an in_play fixture or a scheduled one dated today (division-phase.ts), the phase the judge is given", () => {
    const dp = src("apps/web/src/lib/division-phase.ts");
    expect(dp).toContain('export const DIVISION_PHASES = ["setting_up", "scheduled", "match_day", "finished"] as const;');
    expect(dp).toMatch(/match_day/);
  });
});
