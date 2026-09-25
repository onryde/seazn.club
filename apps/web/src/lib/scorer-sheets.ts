// Scorer sheets §4.4 — which fixtures print on a day, in what order, on which
// page. Pure and client-safe: the print control (T9) and the PDF (T8) share it.
// The loader (server/usecases/scorer-sheets.ts) resolves everything a row
// PRINTS — names, the board's match ref, the org clock — before it gets here;
// this module only decides membership, order and pages.
import type { SlotLabel, SlotLabelLookup } from "@/lib/slot-label";

/** The statuses a sheet prints. An allow-list: every other status the V214
 *  check permits (decided, finalized, forfeited — which is how a bye settles
 *  — abandoned, cancelled) is a match nobody will score from paper. */
export const PRINTABLE_STATUSES: ReadonlySet<string> = new Set(["scheduled", "in_play"]);
/** A printed page is a 3×3 grid of cut-out match cards (owner-approved
 *  2026-09-24), so a page holds nine. */
export const ROWS_PER_PAGE = 9;
/** The label a bracket generator stamps on a bye's phantom side
 *  (stages.ts `BYE_SLOT_LABEL`). A bye can sit `scheduled` until its real
 *  seat fills and `awardSeededByes` settles it, so the status alone does not
 *  exclude it. A seat is a bye only when it is EMPTY and carries this STORED
 *  label (the hub's `hubByeSides`, the player card's upcoming read): "one side
 *  is null" is also every later-round seat still waiting on its feeder, and
 *  those do print (D2); an entrant is never a bye, whatever label rides beside
 *  it. `listSheetDays` repeats this test in SQL. */
export const BYE_SLOT_KEY = "bracket.slot.bye";

/** The member shape `entrantDisplayName` reads (`EntrantNameSource`). */
export interface SheetSide {
  /** Already resolved through `entrantDisplayName` — a one-member individual
   *  is its person's name, not the entrant snapshot. */
  name: string;
  kind: "individual" | "team" | "pair";
  /** Roster order (squad number, then name), so a team prints its players. A
   *  pair's two are in the fixture's saved `pair_order` where it has one, the
   *  order its `name` joins them in. */
  members: { person_id: string; full_name: string }[];
}

export interface SheetCandidate {
  id: string;
  status: string;
  /** ISO 8601, UTC. */
  scheduled_at: string | null;
  /** The org clock (`resolveVenueTz(null, orgTz)`), resolved by the loader,
   *  never a division's own override: calendar-day math wants `orgTz` (repo
   *  rule), so a printed sheet does not depend on the device that prints it.
   *  The board's day tabs use the VIEWER's clock (`dayKey`, ruling R8) and can
   *  differ from this day when that device is outside the org's zone. */
  tz: string;
  division_name: string;
  round_no: number;
  seq_in_round: number;
  /** The match as the schedule board's card names it ("QF·1", "R3·2" where
   *  the board prints the round), in the loader's language (owner ruling
   *  2026-09-24). */
  match_ref: string;
  venue_name: string | null;
  venue_sort: number | null;
  /** The board's court name (venue-qualified where two venues share one);
   *  null = no court, printed under the caller's "Unassigned" heading. */
  court_name: string | null;
  court_sort: number | null;
  home: SheetSide | null;
  away: SheetSide | null;
  /** What an EMPTY seat prints, as the board card names it ("Winner of
   *  QF·1"). Read only when that side is null. */
  home_tbd: string;
  away_tbd: string;
  /** The STORED slot labels — read for the bye check only. */
  home_slot_label: SlotLabel | null;
  away_slot_label: SlotLabel | null;
}

/** What `isPrintable` and `sheetDays` read. */
export type SheetDayRow = Pick<
  SheetCandidate,
  "status" | "scheduled_at" | "tz" | "home" | "away" | "home_slot_label" | "away_slot_label"
>;

export interface SheetPage {
  courtHeading: string | null;
  continued: boolean;
  /** Owner ruling Q7: "Court 2 · page 1 of 2" — numbered within its court. */
  pageInCourt: number;
  pagesInCourt: number;
  rows: SheetCandidate[];
}

/** `YYYY-MM-DD` of an instant on the wall clock of `tz`. */
export function localDateOf(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(iso),
  );
}

function isBye(f: SheetDayRow): boolean {
  return (
    (f.home === null && f.home_slot_label?.key === BYE_SLOT_KEY) ||
    (f.away === null && f.away_slot_label?.key === BYE_SLOT_KEY)
  );
}

/** Could this fixture go on a sheet at all: a printable status, a time, and
 *  not a bye. The loader and every function below share this one test. */
export function isPrintable(f: SheetDayRow): f is SheetDayRow & { scheduled_at: string } {
  return PRINTABLE_STATUSES.has(f.status) && f.scheduled_at !== null && !isBye(f);
}
const printable = isPrintable;

const LAST = Number.MAX_SAFE_INTEGER;

/** Court (venue, then court — `courtNamesById`'s own order), courtless last;
 *  then time; then the match ref's order (round, seq); then division and id,
 *  so a reprint lists a tie the same way. */
function compare(a: SheetCandidate, b: SheetCandidate): number {
  return (
    (a.court_name === null ? 1 : 0) - (b.court_name === null ? 1 : 0) ||
    (a.venue_sort ?? LAST) - (b.venue_sort ?? LAST) ||
    (a.venue_name ?? "").localeCompare(b.venue_name ?? "") ||
    (a.court_sort ?? LAST) - (b.court_sort ?? LAST) ||
    (a.court_name ?? "").localeCompare(b.court_name ?? "", undefined, { numeric: true }) ||
    Date.parse(a.scheduled_at!) - Date.parse(b.scheduled_at!) ||
    a.round_no - b.round_no ||
    a.seq_in_round - b.seq_in_round ||
    a.division_name.localeCompare(b.division_name) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** The day's sheet rows, filtered AND ordered. */
export function selectSheetFixtures(candidates: readonly SheetCandidate[], day: string): SheetCandidate[] {
  return candidates.filter((f) => printable(f) && localDateOf(f.scheduled_at, f.tz) === day).sort(compare);
}

/** The local days that have something to print, ascending. The pure oracle
 *  the `listSheetDays` SQL parity test checks against. */
export function sheetDays(candidates: readonly SheetDayRow[]): string[] {
  const days = new Set<string>();
  for (const f of candidates) if (printable(f)) days.add(localDateOf(f.scheduled_at, f.tz));
  return [...days].sort();
}

/** Today if it has fixtures, else the next day that does, else the last. */
export function defaultSheetDay(days: readonly string[], today: string): string | null {
  if (days.length === 0) return null;
  return days.find((d) => d >= today) ?? days[days.length - 1]!;
}

/** A page's court heading ("Court 2 · page 1 of 2"), kept in three parts so
 *  the renderer can shorten the court's NAME alone: a long venue name must
 *  never cost the page count. `before`/`after` are whatever the locale's
 *  template puts either side of `{court}` — no locale is assumed to lead with
 *  the court. */
export interface SheetHeading {
  before: string;
  court: string;
  after: string;
}

/** `sheets.pdf.courtPage`, split round its `{court}`. */
export function courtPageHeading(t: SlotLabelLookup, court: string, n: number, of: number): SheetHeading {
  // A character no court name or dictionary line carries, so the split can
  // only land on the placeholder.
  const MARK = "\u0000";
  const whole = t("sheets.pdf.courtPage", { court: MARK, n, of });
  const at = whole.indexOf(MARK);
  return { before: whole.slice(0, at), court, after: whole.slice(at + MARK.length) };
}

/** Pages of at most ROWS_PER_PAGE rows. Each court starts a page; a court
 *  longer than a page continues with its heading repeated. `rows` must come
 *  from `selectSheetFixtures` (grouped by court). */
export function paginateSheet(rows: readonly SheetCandidate[], noCourt: string): SheetPage[] {
  const pages: SheetPage[] = [];
  let current: SheetPage | null = null;
  for (const row of rows) {
    const heading = row.court_name ?? noCourt;
    if (!current || current.courtHeading !== heading || current.rows.length === ROWS_PER_PAGE) {
      const continued: boolean = current !== null && current.courtHeading === heading;
      current = { courtHeading: heading, continued, pageInCourt: 0, pagesInCourt: 0, rows: [] };
      pages.push(current);
    }
    current.rows.push(row);
  }
  const total = new Map<string | null, number>();
  for (const p of pages) total.set(p.courtHeading, (total.get(p.courtHeading) ?? 0) + 1);
  const seen = new Map<string | null, number>();
  for (const p of pages) {
    p.pageInCourt = (seen.get(p.courtHeading) ?? 0) + 1;
    seen.set(p.courtHeading, p.pageInCourt);
    p.pagesInCourt = total.get(p.courtHeading)!;
  }
  return pages;
}
