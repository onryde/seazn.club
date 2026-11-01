// Match Day B2 (spec docs/superpowers/specs/2026-10-31-match-day-design.md §9, owner request 2026-10-31): the competition page's
// divisions list shows five at a time and hides finished divisions until asked. Pure, so the same answer renders on the server
// and in a unit test, and so a rule written here is reachable by one: the page that calls it is an async server component.

/** The owner's number: "show 5 at a time". */
export const LEDGER_PER_PAGE = 5;

/** The URL's two keys. `dpage`, not `page`: the competition page's other surfaces own the short names. */
export const LEDGER_PAGE_PARAM = "dpage";
export const LEDGER_FINISHED_PARAM = "finished";

/**
 * A division the default view leaves out: finished AND with nothing owed. A finished division that still carries an attention
 * (a result missing, a ban to review) is the organiser's work, and a list that hid it would be the "absent means suppressed,
 * not safe" shape - so it stays, whatever the toggle says. A desk that failed to load has no phase to be finished in.
 */
function isHideable(r: { phase: string; attention: readonly unknown[] }): boolean {
  return r.phase === "finished" && r.attention.length === 0;
}

export interface LedgerPage<R> {
  rows: R[];
  /** The page actually shown (the one asked for, clamped into 1..pages). */
  page: number;
  /** At least 1: an empty list is one empty page. */
  pages: number;
  /** How many divisions the default view hides - the number the toggle's label carries, in either state. */
  finishedCount: number;
}

/**
 * One page of the divisions list. Filters first and pages the rest, so a hidden division never leaves a gap or an extra page.
 * `rows` arrive already in ledger order; the order is kept.
 */
export function pageLedger<R extends { phase: string; attention: readonly unknown[] }>(
  rows: readonly R[],
  opts: { page: number; showFinished: boolean; perPage?: number },
): LedgerPage<R> {
  const perPage = opts.perPage ?? LEDGER_PER_PAGE;
  if (!Number.isInteger(perPage) || perPage < 1) {
    throw new RangeError(`pageLedger: perPage must be a positive whole number, got ${perPage}`);
  }
  const finishedCount = rows.filter(isHideable).length;
  const shown = opts.showFinished ? [...rows] : rows.filter((r) => !isHideable(r));
  const pages = Math.max(1, Math.ceil(shown.length / perPage));
  // A page that is not a whole number is a broken query, not a request: the first page. One past the end is a stale link (a
  // division finished since it was bookmarked): the last page, which is the nearest thing that exists.
  const asked = Number.isInteger(opts.page) && opts.page >= 1 ? opts.page : 1;
  const page = Math.min(asked, pages);
  return { rows: shown.slice((page - 1) * perPage, page * perPage), page, pages, finishedCount };
}

export interface LedgerQuery {
  page: number;
  showFinished: boolean;
  /** Every other query param, in order: the pager and the toggle keep them. */
  rest: [string, string][];
}

type SearchParams = Record<string, string | string[] | undefined>;

/** The ledger's state from the page's `searchParams`. Total: a malformed value is the default, never an error. */
export function ledgerQueryOf(sp: SearchParams): LedgerQuery {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const rawPage = first(sp[LEDGER_PAGE_PARAM]);
  // ASCII digits only: `Number("٣")` is 3 in no locale a URL should be read in, and `Number("")` is 0 (which would read as a page).
  const page = rawPage !== undefined && /^[0-9]+$/.test(rawPage) && Number(rawPage) >= 1 ? Number(rawPage) : 1;
  const rest: [string, string][] = [];
  for (const [k, v] of Object.entries(sp)) {
    if (k === LEDGER_PAGE_PARAM || k === LEDGER_FINISHED_PARAM || v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) rest.push([k, one]);
  }
  return { page, showFinished: first(sp[LEDGER_FINISHED_PARAM]) === "1", rest };
}

/**
 * The URL for one state of the ledger, keeping the other query params. Only what differs from the default is written, so the
 * first page of the default view is the bare path and a reload or the back button lands exactly where the link said.
 */
export function ledgerHref(base: string, rest: readonly (readonly [string, string])[], next: { page: number; showFinished: boolean }): string {
  const q = new URLSearchParams();
  for (const [k, v] of rest) q.append(k, v);
  if (next.page > 1) q.set(LEDGER_PAGE_PARAM, String(next.page));
  if (next.showFinished) q.set(LEDGER_FINISHED_PARAM, "1");
  const s = q.toString();
  return s === "" ? base : `${base}?${s}`;
}
