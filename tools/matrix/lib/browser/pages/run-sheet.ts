// The run sheet on the division page's fixtures tab, and the way from a row
// to its fixture console (Task 5). Product facts, read at Step 0:
//  - desk/run-sheet.tsx:276 the filter `{ value: "all", … }`; its buttons are
//    `data-filter={f.value}` + `aria-pressed={filter === f.value}` (:547-548)
//    inside data-testid run-sheet-filter. stages-panel.tsx:556 opens it on
//    "today" on match day, which hides rows — so a page object asks for "all".
//  - desk/run-sheet-row.tsx: every row is `<li data-fixture-no={…}>`; its ONE
//    action is a Link `data-row-action={action.kind}` to `href` — except
//    `set_time`, a <button> (:550-553) — and its identity Link (:511) goes to
//    the same `href`. stages-panel.tsx:1417 makes that href
//    routes.fixture(org, comp, div, fixture_no). So the action link is taken
//    when it is a link (open_pad, assign_scorer, score, result, view), and the
//    identity link otherwise: the brief's "open_pad | score | result" would
//    have missed assign_scorer (match day) and set_time (unscheduled).
//  - The console (fixture-console.tsx) shows score-start-match (:1029) until
//    the match starts, then the pad (`score-pad`) and — for an organiser —
//    Forfeit (:1294) or, once decided, Finalize (:1274); a HELD match (W2a: a bracket match that ended level or was
//    abandoned) mounts the Needs a decision block instead of any of them.
import { FINALIZE_TESTID, FORFEIT_TESTID, START_MATCH_TESTID } from "../../../../bench/lib/drivers/scorer.ts";
import { DATA, TESTID } from "../selectors.ts";
import { NEEDS_DECISION } from "./needs-decision.ts";
import { UnsafeSelectorValue, actBudget, attrEquals, awaitScreen, navBudget, selectorValue, shoot, visit, type DivisionWhere, type PageCtx } from "./ctx.ts";
import { paths } from "./paths.ts";

export const ALL_FILTER = "all";
/** The filter the sheet opens on during a match day (stages-panel.tsx:
 *  `useState<RunSheetFilter>(phase === "match_day" ? "today" : "all")`; text-pinned by run-sheet-today.test.ts). */
export const TODAY_FILTER = "today";

/** A run-sheet row: DATA.fixtureRow (`li[data-fixture-no]`) for one fixture number. */
export function fixtureRowSelector(no: number): string {
  if (!Number.isInteger(no) || no < 1) throw new UnsafeSelectorValue("fixture number", no);
  return attrEquals(DATA.fixtureRow.selector, "fixture number", String(no));
}

/** A link to fixture `no`'s console: `[href="…"]` over routes.fixture. Every
 *  slug goes through selectorValue, like every other composed value — the
 *  product's slugs are [a-z0-9-], and one that is not is refused by name
 *  rather than breaking out of the quotes. */
export function fixtureLinkSelector(org: string, comp: string, div: string, no: number): string {
  if (!Number.isInteger(no) || no < 1) throw new UnsafeSelectorValue("fixture number", no);
  return `[href="${paths.fixture(selectorValue("org slug", org), selectorValue("competition slug", comp), selectorValue("division slug", div), no)}"]`;
}

/** Every option of the run sheet's filter: a first act on the fixtures tab
 *  whenever "all" is not already pressed (I-1, the hydration wait). */
export const RUN_SHEET_FILTER_OPTIONS = `[data-testid="${TESTID.runSheetFilter.id}"] ${DATA.runSheetFilterOption.selector}`;

/** The cases (keyed by their Evidence) whose run sheet has been pictured
 *  showing every fixture. Once per case is the proof the walkthrough's screen
 *  list owes (Task 8 review m3, Task 14 carry 2); a later visit widens the
 *  filter again, unpictured. */
const pictured = new WeakSet<object>();

/** Presses the run sheet's "all" filter unless it is pressed already. A sheet
 *  that offers no filter (nothing to filter yet) is left as it is. The first
 *  time in a case, the sheet is pictured once it shows every fixture — and,
 *  when the filter had to be pressed, before as well, a pair that must differ. */
export async function showAllFixtures(c: PageCtx): Promise<void> {
  const option = `[data-testid="${TESTID.runSheetFilter.id}"] ${attrEquals(DATA.runSheetFilterOption.selector, "run-sheet filter", ALL_FILTER)}`;
  const all = c.page.locator(option);
  if ((await all.count()) === 0) return;
  const first = !pictured.has(c.evidence);
  pictured.add(c.evidence);
  if ((await all.getAttribute("aria-pressed", { timeout: actBudget(c, 1) })) === "true") {
    if (first) await shoot(c, "run-sheet-all");
    return;
  }
  const before = first ? await shoot(c, "run-sheet-all-before") : undefined;
  await all.click({ timeout: actBudget(c, 1) });
  const t = navBudget(c);
  await awaitScreen(() => c.page.locator(`${option}[aria-pressed="true"]`).waitFor({ state: "attached", timeout: t }), "the run sheet showing every fixture", t);
  if (before !== undefined) await shoot(c, "run-sheet-all", before);
}

/** What the run sheet showed the moment the organiser arrived (W1d item 15c, D17): the filter it was pressed on and
 *  the fixture numbers its rows carried, sorted. */
export interface DefaultFilterSeen { readonly filter: string; readonly rows: readonly number[] }

/** The run sheet as the organiser FIRST finds it: which filter is pressed and which rows it draws. Presses nothing, so
 *  it must run BEFORE showAllFixtures widens the sheet (readThenShowAll holds that order). null: the sheet offers no
 *  filter yet (nothing to filter), as showAllFixtures reads it. A row whose fixture number is unreadable is refused by
 *  name, never counted as fixture 0. */
export async function readDefaultFilter(c: PageCtx): Promise<DefaultFilterSeen | null> {
  const pressed = c.page.locator(`${RUN_SHEET_FILTER_OPTIONS}[aria-pressed="true"]`);
  const n = await pressed.count();
  if (n === 0) return null;
  if (n !== 1) throw new Error(`browser: the run sheet shows ${n} pressed filters; it offers one at a time`);
  const filter = await pressed.getAttribute("data-filter", { timeout: actBudget(c, 1) });
  if (filter === null) throw new Error("browser: the run sheet's pressed filter carries no data-filter value");
  const numbers = await c.page.locator(DATA.fixtureRow.selector).evaluateAll((els) => els.map((e) => e.getAttribute("data-fixture-no")));
  const rows = numbers.map((v) => (v !== null && /^\d+$/.test(v) ? Number(v) : Number.NaN));
  if (rows.some((r) => !Number.isInteger(r) || r < 1)) throw new Error(`browser: a run-sheet row carries no readable fixture number (data-fixture-no: ${numbers.map((v) => JSON.stringify(v)).join(", ")})`);
  return { filter, rows: [...rows].sort((a, b) => a - b) };
}

/** The sheet as it arrived (when `read`), then widened to every fixture. The order is the point: widening first
 *  would leave the default unreadable. */
export async function readThenShowAll(c: PageCtx, read: boolean): Promise<DefaultFilterSeen | null> {
  const seen = read ? await readDefaultFilter(c) : null;
  await showAllFixtures(c);
  return seen;
}

/** `runsheet-today-default`'s verdict: the sheet opens on "today" on a match day and on "all" otherwise (stages-panel.tsx),
 *  and "today" draws exactly the fixtures dated today (run-sheet.tsx runSheetKeeps). `phase` is the division's derived
 *  phase as the competition desk shows it; `datedToday` the fixture numbers the product dates today. Nothing dated today
 *  proves nothing, so it abstains, counted 0 (the empty case first). */
export function judgeTodayDefault(a: { phase: string; seen: DefaultFilterSeen | null; datedToday: readonly number[] }): { verdict: "pass" | "fail" | "abstain"; checked: number; note: string } {
  if (a.datedToday.length === 0) return { verdict: "abstain", checked: 0, note: `no fixture dated today, so the default filter has nothing to be proven by (phase ${a.phase})` };
  if (a.seen === null) return { verdict: "fail", checked: 0, note: `the run sheet offered no filter, so its default (phase ${a.phase}) could not be read` };
  const want = a.phase === "match_day" ? TODAY_FILTER : ALL_FILTER;
  if (a.seen.filter !== want) return { verdict: "fail", checked: 1, note: `phase ${a.phase}: the sheet opened on '${a.seen.filter}', it should open on '${want}'` };
  if (want === TODAY_FILTER) {
    const dated = [...a.datedToday].sort((x, y) => x - y).join(", ");
    const rows = a.seen.rows.join(", ");
    if (rows !== dated) return { verdict: "fail", checked: 1, note: `phase ${a.phase}: the '${TODAY_FILTER}' sheet drew fixtures [${rows}], the product dates [${dated}] today` };
  }
  return { verdict: "pass", checked: 1, note: `phase ${a.phase}: the sheet opened on '${a.seen.filter}'${want === TODAY_FILTER ? `, drawing exactly the ${a.datedToday.length} fixture(s) dated today` : ""}` };
}

/** The controls a console mounts for an organiser, one set per state it can be in: Start (scheduled), the pad and
 *  Forfeit (in play), Finalize (decided) and — W2a, found live — the Needs a decision block (HELD: a bracket match that
 *  ended level or was abandoned mounts none of the other four). */
export const CONSOLE_MOUNTED_TESTIDS: readonly string[] = Object.freeze([START_MATCH_TESTID, TESTID.scorePad.id, FORFEIT_TESTID, FINALIZE_TESTID, NEEDS_DECISION.block]);
/** Any control the console mounts for an organiser, whatever the match's state. */
const CONSOLE_MOUNTED = CONSOLE_MOUNTED_TESTIDS.map((id) => `[data-testid="${id}"]`).join(", ");

/** From the division's fixtures tab to fixture `fixtureNo`'s console, through
 *  its run-sheet row. */
export async function openFixtureUi(c: PageCtx, where: DivisionWhere, fixtureNo: number): Promise<void> {
  const { page } = c;
  const row = page.locator(fixtureRowSelector(fixtureNo));
  // The first act is the filter (when "all" is not pressed), else the row's link.
  await visit(c, paths.division(c.orgSlug, where.compSlug, where.divSlug, "fixtures"), { control: page.locator(RUN_SHEET_FILTER_OPTIONS).or(row.locator("a")), what: `the run sheet's filter and row #${fixtureNo}'s links` });
  await showAllFixtures(c);
  const t = navBudget(c);
  await awaitScreen(() => row.waitFor({ state: "attached", timeout: t }), `run-sheet row #${fixtureNo}`, t);
  const href = paths.fixture(c.orgSlug, where.compSlug, where.divSlug, fixtureNo);
  const toConsole = fixtureLinkSelector(c.orgSlug, where.compSlug, where.divSlug, fixtureNo);
  const action = row.locator(`a${DATA.rowAction.selector}${toConsole}`);
  const link = (await action.count()) > 0 ? action : row.locator(`a${toConsole}`).first();
  await link.click({ timeout: actBudget(c, 1) });
  await awaitScreen(() => page.waitForURL((u) => u.pathname === href, { timeout: t }), `fixture #${fixtureNo}'s console at ${href}`, t);
  await awaitScreen(() => page.locator(CONSOLE_MOUNTED).first().waitFor({ state: "attached", timeout: t }), `fixture #${fixtureNo}'s console controls`, t);
}
