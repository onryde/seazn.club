// What every organiser page object shares (W1c Task 5): the context it runs
// in, where a division lives, the budgets its waits take, the one way it
// navigates, and how it files its pictures. Nothing here clicks.
import type { Locator, Page } from "playwright";
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

/** One step's own bound: a tap at the human pace plus its slack, floored. The
 *  bench's executeStep waits this long for a control (fixture-console.ts
 *  forfeitBudgets passes it as waitMs) and then taps it with a bare
 *  click()/fill(), which Playwright bounds by the page's DEFAULT timeout. */
export function stepBudget(c: Pick<PageCtx, "holdMs">): number {
  return budgetMs({ taps: 1, holds: 0, holdMs: c.holdMs });
}

/** Controller ruling F (T5 N1): sets the page's default action timeout to
 *  stepBudget, so every tap no page object bounds itself is one step's bound
 *  in the product's constants — never Playwright's own 30 s. BrowserDriver
 *  calls it on every case page before its first action; the answer is the
 *  bound it set. */
export function boundActions(page: Pick<Page, "setDefaultTimeout">, c: Pick<PageCtx, "holdMs">): number {
  const ms = stepBudget(c);
  page.setDefaultTimeout(ms);
  return ms;
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

/** W1c Task 8 review I-1 (ruling 151's hydration carry). React's key for the
 *  props it attaches to a DOM element as it hydrates (or creates) it. The
 *  browser runs Next's VENDORED React — next/dist/compiled/react-dom/cjs/
 *  react-dom-client.production.js, `internalPropsKey = "__reactProps$" +
 *  randomKey` — which sets it on a server-rendered element only in
 *  prepareToHydrateHostInstance, and whose getListener reads it for every
 *  delegated handler. So an element without it has NO handler: an act on it
 *  reaches nothing, and the dropped click reads later as a product red
 *  (page-objects.test.ts text-pins all three). */
export const REACT_PROPS_KEY = "__reactProps$";

/** The control(s) a page object acts on FIRST after a full page load, so the
 *  load can wait until React has hydrated them. Every element `control`
 *  matches must hydrate — a union (`a.or(b)`) where the first act depends on
 *  the screen (a filter pressed only when it is not, a fold opened only when
 *  folded). */
export type HydrationTarget = Pick<Locator, "first" | "elementHandles">;
export interface FirstAct { readonly control: HydrationTarget; readonly what: string }
/** A screen its page object only READS (text, tables): nothing it does needs
 *  a handler, so its load waits for no hydration (page-objects.test.ts pins
 *  that such a page object acts on nothing). */
export const READS_ONLY = "reads only";

/** React replaces a server-rendered subtree when a hydration mismatch makes it
 *  client-render it. awaitHydrated finds a replaced control again at most this
 *  many times (three waits in all); a control replaced more often is being
 *  re-rendered, and that is no hydration signal. The cap decides only when the
 *  refusal fires: every other exit still needs every matched element hydrated. */
export const REPLACEMENTS_MAX = 2;

export class NeverHydrated extends Error {
  readonly what: string;
  readonly ms: number;
  constructor(what: string, ms: number, why: string) {
    super(`browser: ${what} was never hydrated — ${why}. React attaches its props (${REACT_PROPS_KEY}…) as it hydrates an element and finds no handler without them, so an act now would be dropped and read as a product red`);
    this.name = "NeverHydrated";
    this.what = what;
    this.ms = ms;
  }
}

/** The probe waitForFunction ships to the page — as SOURCE, so it reads
 *  nothing but its argument. Falsy keeps Playwright polling: a matched element
 *  React has not hydrated yet. "replaced": one left the document (React
 *  client-rendered it anew), or none was left to judge — never a pass over
 *  zero elements. */
export function hydrationState(a: { readonly els: readonly { readonly isConnected: boolean }[]; readonly prefix: string }): "hydrated" | "replaced" | false {
  let judged = 0;
  let gone = 0;
  for (const el of a.els) {
    if (!el.isConnected) { gone++; continue; }
    if (!Object.keys(el).some((k) => k.startsWith(a.prefix))) return false;
    judged++;
  }
  return gone > 0 || judged === 0 ? "replaced" : "hydrated";
}

/** Waits until React has hydrated every element `first.control` matches: at
 *  least one attached (else ScreenNeverShowed), then Playwright's own
 *  frame-by-frame poll of the probe — no sleep — each wait bounded by the
 *  navigation budget. Never hydrated is NeverHydrated, naming the control; a
 *  control React replaced is found again, at most REPLACEMENTS_MAX times. */
export async function awaitHydrated(c: { page: Pick<Page, "waitForFunction">; holdMs: number }, first: FirstAct): Promise<void> {
  const ms = navBudget(c);
  for (let replaced = 0; ; replaced++) {
    await awaitScreen(() => first.control.first().waitFor({ state: "attached", timeout: ms }), first.what, ms);
    const els = await first.control.elementHandles();
    let state: unknown;
    try {
      const answer = await c.page.waitForFunction(hydrationState, { els, prefix: REACT_PROPS_KEY }, { polling: "raf", timeout: ms });
      state = await answer.jsonValue();
      await answer.dispose();
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") throw new NeverHydrated(first.what, ms, `not within ${ms} ms (${els.length} element(s) matched)`);
      throw e;
    } finally {
      await Promise.allSettled(els.map((h) => h.dispose()));
    }
    if (state === "hydrated") return;
    if (replaced >= REPLACEMENTS_MAX) throw new NeverHydrated(first.what, ms, `React replaced it ${replaced + 1} time(s) — it is being re-rendered, not hydrated`);
  }
}

/** The page surface `visit` uses; a Playwright Page meets it. */
export interface VisitPage extends OnboardPage, Pick<Page, "waitForFunction"> { goto(url: string, o: { timeout: number }): Promise<unknown> }

/** Navigates to `path` on the case's base. A fresh sign-in lands on
 *  onboarding: e2e's own onboarding step runs (session.ts ensureOnboarded) and
 *  the page is visited once more. Wherever it lands after that must be the
 *  path asked for — anything else is LandedElsewhere, never a later timeout
 *  on a control that screen does not have. Then (I-1) it waits until React
 *  has hydrated the control the page object acts on first — unless the screen
 *  is only read. */
export async function visit(c: Pick<PageCtx, "base" | "holdMs"> & { page: VisitPage }, path: string, first: FirstAct | typeof READS_ONLY): Promise<void> {
  const url = new URL(path, c.base);
  const t = navBudget(c);
  await c.page.goto(url.href, { timeout: t });
  if (await ensureOnboarded(c.page)) await c.page.goto(url.href, { timeout: t });
  const landed = new URL(c.page.url());
  if (landed.pathname !== url.pathname) throw new LandedElsewhere(url.pathname, landed.pathname === ONBOARDING_PATH ? `${ONBOARDING_PATH} (again, after completing it)` : landed.pathname);
  if (first !== READS_ONLY) await awaitHydrated(c, first);
}

/** The page surface `reload` uses; a Playwright Page meets it. */
export type ReloadPage = Pick<Page, "reload" | "waitForFunction">;

/** Reloads the page — a full load, so (I-1) it too waits until React has
 *  hydrated the control the page object acts on first. With visit, the only
 *  full loads the harness makes (page-objects.test.ts pins that). */
export async function reload(c: { page: ReloadPage; holdMs: number }, first: FirstAct): Promise<void> {
  await c.page.reload({ timeout: navBudget(c) });
  await awaitHydrated(c, first);
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
