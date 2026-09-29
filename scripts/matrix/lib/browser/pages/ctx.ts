// What every organiser page object shares (W1c Task 5): the context it runs
// in, where a division lives, the budgets its waits take, the one way it
// navigates, and how it files its pictures. Nothing here clicks.
import type { Page } from "playwright";
import { FLOOR_MS, budgetMs } from "../budget.ts";
import type { Evidence } from "../evidence.ts";
import { ONBOARDING_PATH, ensureOnboarded, type OnboardPage } from "../session.ts";

export interface PageCtx { page: Page; base: string; orgSlug: string; holdMs: number; evidence: Evidence }
export interface DivisionWhere { compSlug: string; divSlug: string; divisionId: string }

/** A navigation, or a screen a navigation or a refresh must show: the floor
 *  (a prod build's navigation plus first paint), in the product's hold. */
export function navBudget(c: Pick<PageCtx, "holdMs">): number {
  return budgetMs({ base: FLOOR_MS, holdMs: c.holdMs });
}

/** A control and the `requests` round trips the page makes before the answer
 *  a page object waits on: each is a tap at the human pace plus its slack. */
export function actBudget(c: Pick<PageCtx, "holdMs">, requests: number): number {
  return budgetMs({ base: FLOOR_MS, taps: requests, holdMs: c.holdMs });
}

export class LandedElsewhere extends Error {
  readonly wanted: string;
  readonly landed: string;
  constructor(wanted: string, landed: string) {
    super(`browser: navigating to ${wanted} landed on ${landed} — a sign-in wall, a redirect or a missing page, never the screen the step was for`);
    this.name = "LandedElsewhere";
    this.wanted = wanted;
    this.landed = landed;
  }
}

/** The page surface `visit` uses; a Playwright Page meets it. */
export interface VisitPage extends OnboardPage { goto(url: string, o: { timeout: number }): Promise<unknown> }

/** Navigates to `path` on the case's base. A fresh sign-in lands on
 *  onboarding: e2e's own onboarding step runs (session.ts ensureOnboarded) and
 *  the page is visited once more. Wherever it lands after that must be the
 *  path asked for — anything else is LandedElsewhere, never a later timeout
 *  on a control that screen does not have. */
export async function visit(c: Pick<PageCtx, "base" | "holdMs"> & { page: VisitPage }, path: string): Promise<void> {
  const url = new URL(path, c.base);
  const t = navBudget(c);
  await c.page.goto(url.href, { timeout: t });
  if (await ensureOnboarded(c.page)) await c.page.goto(url.href, { timeout: t });
  const landed = new URL(c.page.url());
  if (landed.pathname !== url.pathname) throw new LandedElsewhere(url.pathname, landed.pathname === ONBOARDING_PATH ? `${ONBOARDING_PATH} (again, after completing it)` : landed.pathname);
}

export class ScreenNeverShowed extends Error {
  readonly what: string;
  readonly ms: number;
  constructor(what: string, ms: number, cause: Error) {
    super(`browser: ${what} never showed within ${ms} ms (${cause.message.split("\n")[0]})`);
    this.name = "ScreenNeverShowed";
    this.what = what;
    this.ms = ms;
  }
}

/** Waits through `wait` for a screen the step's own action must bring. Its
 *  budget running out is ScreenNeverShowed, naming the screen; any other
 *  failure (the page closed, a strict-mode clash) is left as it is. */
export async function awaitScreen(wait: () => Promise<unknown>, what: string, ms: number): Promise<void> {
  try {
    await wait();
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") throw new ScreenNeverShowed(what, ms, e);
    throw e;
  }
}

export class UnsafeSelectorValue extends Error {
  readonly what: string;
  constructor(what: string, value: unknown) {
    super(`browser: ${what} ${JSON.stringify(value)} cannot be put in a selector — only letters, digits, _ and - can, so an id never breaks out of its quotes`);
    this.name = "UnsafeSelectorValue";
    this.what = what;
  }
}

/** An id, key or slug about to be quoted inside an attribute selector. The
 *  product's are uuids, sport/variant keys and data-* values: \w and -. */
export function selectorValue(what: string, v: string): string {
  if (!/^[\w-]+$/.test(v)) throw new UnsafeSelectorValue(what, v);
  return v;
}

/** A DATA pin's `[attr]` selector (selectors.ts) narrowed to one value:
 *  `[data-kind]` → `[data-kind="pair"]`. */
export function attrEquals(selector: string, what: string, value: string): string {
  return selector.replace(/\]$/, `="${selectorValue(what, value)}"]`);
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A pathname, whole, as actAndAwait's `want.path`. */
export function exactPath(path: string): RegExp {
  return new RegExp(`^${escapeRegExp(path)}$`);
}

/** An entrant's row by its WHOLE display name. entrants-panel.tsx renders the
 *  name and then a ▸/▾ span inside `entrant-row-disclosure`, so the name is
 *  the text's start; the lookahead refuses a longer name that begins with it
 *  ("Matrix Player 1" must never match "Matrix Player 10"). */
export function entrantNameMatcher(displayName: string): RegExp {
  return new RegExp(`^\\s*${escapeRegExp(displayName)}(?![\\p{L}\\p{N}])`, "u");
}

/** Labels a case has used, per Evidence: the first shot under a label keeps
 *  it, a repeat is numbered (a second stage's generate is `05-generated-2`),
 *  because Evidence refuses a duplicate label outright. */
const used = new WeakMap<object, Map<string, number>>();
export function shotLabel(evidence: object, base: string): string {
  let counts = used.get(evidence);
  if (counts === undefined) {
    counts = new Map();
    used.set(evidence, counts);
  }
  const n = (counts.get(base) ?? 0) + 1;
  counts.set(base, n);
  return n === 1 ? base : `${base}-${n}`;
}

/** Shoots the page under `base` (numbered on a repeat) and returns the label
 *  used, so the shot after the action can name this one as the picture it
 *  must differ from. Shot AFTER the state it proves: callers wait first. */
export async function shoot(c: PageCtx, base: string, mustDiffer?: string): Promise<string> {
  const label = shotLabel(c.evidence, base);
  await c.evidence.shot(c.page, label, mustDiffer === undefined ? {} : { mustDiffer });
  return label;
}
