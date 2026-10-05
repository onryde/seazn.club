// W1d Task 14 (item 15c, D17): the run sheet's DEFAULT filter on a match day.
// stages-panel.tsx opens the sheet on "today" when the division's phase is
// match_day and on "all" otherwise (read once at mount), and a page object that
// widens the filter first never sees it. readDefaultFilter reads the default
// BEFORE the page object's own widening; judgeTodayDefault judges it against
// the phase and the fixtures the product dates today.
//
// Expected values come from the product's text (stages-panel.tsx, run-sheet.tsx,
// division-phase.ts), read here, never from the code under test.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Evidence, type EvidenceFs } from "../lib/browser/evidence.ts";
import { type PageCtx } from "../lib/browser/pages/ctx.ts";
import { ALL_FILTER, TODAY_FILTER, judgeTodayDefault, readDefaultFilter, readThenShowAll } from "../lib/browser/pages/run-sheet.ts";
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

describe("judgeTodayDefault: 'today' on a match day, 'all' otherwise (D17)", () => {
  const seen = (filter: string, rows: number[]) => ({ filter, rows });

  it("match day: pass only when the sheet opened on today AND its rows are exactly the fixtures dated today", () => {
    expect(judgeTodayDefault({ phase: "match_day", seen: seen("today", [1, 3]), datedToday: [1, 3] })).toMatchObject({ verdict: "pass", checked: 1 });
    // The rows may arrive in any order and the dated list too.
    expect(judgeTodayDefault({ phase: "match_day", seen: seen("today", [1, 3]), datedToday: [3, 1] }).verdict).toBe("pass");
  });

  it("match day: a sheet opened on 'all' fails, and so does a 'today' sheet missing or adding a row", () => {
    expect(judgeTodayDefault({ phase: "match_day", seen: seen("all", [1, 2, 3]), datedToday: [1, 3] }).verdict).toBe("fail");
    expect(judgeTodayDefault({ phase: "match_day", seen: seen("today", [1]), datedToday: [1, 3] }).verdict).toBe("fail");
    expect(judgeTodayDefault({ phase: "match_day", seen: seen("today", [1, 2, 3]), datedToday: [1, 3] }).verdict).toBe("fail");
  });

  it("any other phase: the default is 'all'; 'today' there fails", () => {
    for (const phase of ["setting_up", "scheduled", "finished"]) {
      expect(judgeTodayDefault({ phase, seen: seen("all", [1, 2, 3]), datedToday: [1, 3] }), phase).toMatchObject({ verdict: "pass", checked: 1 });
      expect(judgeTodayDefault({ phase, seen: seen("today", [1, 3]), datedToday: [1, 3] }).verdict, phase).toBe("fail");
    }
  });

  it("the empty case first: no fixture dated today abstains, counted 0, and says why", () => {
    expect(judgeTodayDefault({ phase: "scheduled", seen: seen("all", [1, 2, 3]), datedToday: [] })).toEqual({ verdict: "abstain", checked: 0, note: expect.stringContaining("no fixture dated today") });
    // …even when the sheet opened on 'today': nothing was dated to prove it by.
    expect(judgeTodayDefault({ phase: "match_day", seen: seen("today", []), datedToday: [] }).verdict).toBe("abstain");
  });

  it("a sheet that offered no filter is a failure of its own, not an abstain", () => {
    expect(judgeTodayDefault({ phase: "match_day", seen: null, datedToday: [1, 3] })).toMatchObject({ verdict: "fail", checked: 0 });
  });

  it("the failure note says what the sheet showed and what it should have", () => {
    const j = judgeTodayDefault({ phase: "match_day", seen: seen("all", [1, 2, 3]), datedToday: [1, 3] });
    expect(j.note).toContain("all");
    expect(j.note).toContain(TODAY_FILTER);
  });
});

describe("the rule judged is the product's: stages-panel.tsx and run-sheet.tsx say it", () => {
  it("the sheet opens on today on a match day and on all otherwise (stages-panel.tsx, read once at mount)", () => {
    expect(src(`${V2}/stages-panel.tsx`)).toContain(`useState<RunSheetFilter>(phase === "match_day" ? "${TODAY_FILTER}" : "${ALL_FILTER}")`);
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
