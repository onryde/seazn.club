import "server-only";
// Scorer sheets §4.4 — the fixtures a printed sheet could show, with
// everything a row PRINTS resolved here, once:
//  - the match ref and each empty seat's "Winner of …" exactly as the schedule
//    board names them (owner ruling 2026-09-24): `boardMatchNamer`, the scan
//    screens' own namer, over the whole competition's rows — the board reads
//    the whole competition, and a feeder may sit on another day or be over;
//  - the court as the board names it (`courtDisplayName` over
//    `courtNamesById`, venue-qualified where two venues share a name);
//  - each side through `entrantDisplayName`, with its roster and THIS
//    fixture's saved lineup, so a pair reads in its `pair_order` exactly as
//    Confirm and the pad name it (fix batch 2, item 3);
//  - the day and the times on the ORG clock (`resolveVenueTz(null, orgTz)`),
//    never a division's own tz override: the repo rule is that calendar-day
//    math wants `orgTz` (schedule.ts `ScheduleSettingsOut`), and a printed
//    sheet must not depend on the device that prints it (controller ruling
//    2026-09-24). The board's day tabs bucket on the VIEWER's device clock
//    (`dayKey`, ruling R8), so they can differ from the sheet's day when the
//    printing device is outside the org's zone.
// Which rows print on a day, in what order and on which page is the pure
// half's (lib/scorer-sheets.ts). Page auth (editor, same-origin) is the
// ROUTE's job; this is RLS-bounded by withTenant.
import { withTenant, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { entrantDisplayName, pairOrdered, type EntrantNameSource } from "@/lib/entrant-name";
import type { SlotLabel, SlotLabelLookup } from "@/lib/slot-label";
import { resolveVenueTz } from "@/lib/tz";
import { courtDisplayName } from "@/components/v2/board/types";
import type { Locale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import { intlLocaleFor } from "@/lib/public-date-locale";
import {
  BYE_SLOT_KEY,
  PRINTABLE_STATUSES,
  courtPageHeading,
  isPrintable,
  localDateOf,
  paginateSheet,
  selectSheetFixtureRange,
  selectSheetFixtures,
  type SheetCandidate,
  type SheetSide,
} from "@/lib/scorer-sheets";
import type { SheetModel } from "@/server/scorer-sheet-pdf";
import { log } from "@/server/logger";
import { boardMatchNamer, MATCH_NAME_COLS, type MatchNameRow } from "./scan-match-names";
import { courtNamesById } from "./schedule";
import {
  ensureDeviceLinks,
  hashDeviceLinkToken,
  isFinishedFixtureStatus,
  type EnsuredDeviceLink,
} from "./device-links";
import { orgBranding } from "./exports";

/** The competition's clock: its organisation's zone, else UTC. 404 when the
 *  competition is not this tenant's. */
async function competitionClock(tx: Tx, competitionId: string): Promise<string> {
  const [comp] = await tx<{ org_tz: string | null }[]>`
    select o.timezone as org_tz
    from competitions c left join organizations o on o.id = c.org_id
    where c.id = ${competitionId}`;
  if (!comp) throw new HttpError(404, "competition not found");
  return resolveVenueTz(null, comp.org_tz);
}

/** One fixture of the competition: the board's naming columns plus what a
 *  sheet row prints. */
type FixtureRow = MatchNameRow & {
  division_id: string;
  division_name: string;
  status: string;
  /** postgres hands a timestamptz back as a Date. */
  scheduled_at: Date | string | null;
  court_id: string | null;
  court_label: string | null;
  court_entity_name: string | null;
  court_sort: number | null;
  venue_name: string | null;
  venue_sort: number | null;
};

async function readFixtures(tx: Tx, competitionId: string): Promise<FixtureRow[]> {
  return tx<FixtureRow[]>`
    select ${tx(MATCH_NAME_COLS.map((c) => `f.${c}`))},
           f.division_id, d.name as division_name, f.status, f.scheduled_at,
           f.court_id, f.court_label, c.name as court_entity_name, c.sort as court_sort,
           v.name as venue_name, v.sort as venue_sort
    from fixtures f
    join divisions d on d.id = f.division_id
    left join courts c on c.id = f.court_id
    left join venues v on v.id = c.venue_id
    where d.competition_id = ${competitionId}`;
}

const isoOf = (at: Date | string | null): string | null => (at === null ? null : new Date(at).toISOString());

interface EntrantRow {
  id: string;
  name: string;
  kind: SheetSide["kind"];
  members: SheetSide["members"];
}

/** Every entrant of the competition, with its roster in roster order
 *  (usecases/entrants.ts `withMembers`: squad number, then name). */
async function readEntrants(tx: Tx, competitionId: string): Promise<Map<string, EntrantRow>> {
  const rows = await tx<EntrantRow[]>`
    select e.id, e.display_name as name, e.kind,
           coalesce((
             select json_agg(json_build_object('person_id', p.id, 'full_name', p.full_name)
                             order by em.squad_number nulls last, p.full_name)
             from entrant_members em join persons p on p.id = em.person_id
             where em.entrant_id = e.id), '[]'::json) as members
    from entrants e
    join divisions d on d.id = e.division_id
    where d.competition_id = ${competitionId}`;
  return new Map(rows.map((e) => [e.id, e]));
}

type PairOrderSlot = { person_id: string; pair_order: number };
const lineupKey = (fixtureId: string, entrantId: string) => `${fixtureId}:${entrantId}`;

/** Every saved `pair_order` in the competition's lineups, by fixture and
 *  entrant: the rows `getLineup` hands Confirm and the pad, narrowed to the
 *  one column a name reads. */
async function readPairOrders(tx: Tx, competitionId: string): Promise<Map<string, PairOrderSlot[]>> {
  const rows = await tx<(PairOrderSlot & { fixture_id: string; entrant_id: string })[]>`
    select l.fixture_id, l.entrant_id, l.person_id, l.pair_order
    from lineups l
    join fixtures f on f.id = l.fixture_id
    join divisions d on d.id = f.division_id
    where d.competition_id = ${competitionId} and l.pair_order is not null`;
  const out = new Map<string, PairOrderSlot[]>();
  for (const r of rows) {
    const key = lineupKey(r.fixture_id, r.entrant_id);
    out.set(key, [...(out.get(key) ?? []), { person_id: r.person_id, pair_order: r.pair_order }]);
  }
  return out;
}

/** One seated side as this fixture's card prints it: named through
 *  `entrantDisplayName` with the fixture's lineup, and a pair's members in that
 *  same order, since the card prints them one per line. */
function sheetSide(e: EntrantRow, lineup: EntrantNameSource["lineup"]): SheetSide {
  return {
    name: entrantDisplayName({ ...e, lineup }),
    kind: e.kind,
    members: e.kind === "pair" ? [...pairOrdered(e.members, lineup)] : e.members,
  };
}

/**
 * The competition's printable fixtures (`isPrintable`), every row named and on
 * the org clock. With `day`: exactly that day's sheet rows, in print order
 * (`selectSheetFixtures`). `lookup` is the sheet's language — required, so no
 * caller prints English by default.
 */
export async function loadSheetCandidates(
  auth: AuthCtx,
  competitionId: string,
  lookup: SlotLabelLookup,
  day?: string,
  divisionId?: string,
): Promise<SheetCandidate[]> {
  const read = await withTenant(auth.orgId, async (tx) => {
    const tz = await competitionClock(tx, competitionId);
    if (divisionId !== undefined) {
      const [d] = await tx<{ id: string }[]>`
        select id from divisions where id = ${divisionId} and competition_id = ${competitionId}`;
      if (!d) throw new HttpError(404, "division not found");
    }
    const rows = await readFixtures(tx, competitionId);
    const stages = await tx<{ id: string; kind: string }[]>`
      select s.id, s.kind from stages s join divisions d on d.id = s.division_id
      where d.competition_id = ${competitionId}`;
    const entrants = await readEntrants(tx, competitionId);
    const pairOrders = await readPairOrders(tx, competitionId);
    const courtNames = Object.fromEntries(await courtNamesById(tx));
    return { tz, rows, stages, entrants, pairOrders, courtNames };
  });
  const { tz } = read;
  const name = boardMatchNamer(read.rows, read.stages, lookup);
  const side = (fixtureId: string, entrantId: string | null) => {
    const e = entrantId === null ? undefined : read.entrants.get(entrantId);
    return e === undefined ? null : sheetSide(e, read.pairOrders.get(lineupKey(fixtureId, e.id)));
  };
  const candidates: SheetCandidate[] = [];
  for (const r of read.rows) {
    if (divisionId !== undefined && r.division_id !== divisionId) continue;
    const scheduled_at = isoOf(r.scheduled_at);
    const home = side(r.id, r.home_entrant_id);
    const away = side(r.id, r.away_entrant_id);
    const home_slot_label = r.home_slot_label as SlotLabel | null;
    const away_slot_label = r.away_slot_label as SlotLabel | null;
    if (!isPrintable({ status: r.status, scheduled_at, tz, home, away, home_slot_label, away_slot_label })) continue;
    // Every row is one the namer was built from.
    const names = name(r.id)!;
    candidates.push({
      id: r.id,
      status: r.status,
      scheduled_at,
      tz,
      division_name: r.division_name,
      round_no: r.round_no,
      seq_in_round: r.seq_in_round,
      match_ref: names.ref,
      venue_name: r.venue_name,
      venue_sort: r.venue_sort,
      court_name: courtDisplayName(
        { court_id: r.court_id, court_name: r.court_entity_name, court_label: r.court_label },
        read.courtNames,
      ),
      court_sort: r.court_sort,
      home,
      away,
      home_tbd: names.home,
      away_tbd: names.away,
      home_slot_label,
      away_slot_label,
    });
  }
  return day === undefined ? candidates : selectSheetFixtures(candidates, day);
}

/**
 * The org-clock days that have something to print, ascending. Read on every
 * schedule-page render, so it is ONE query that returns only the days: the
 * same exclusions as `isPrintable`, spelled in SQL — a printable status, a
 * time, and no seat that is EMPTY and stamped a bye. `coalesce` keeps an
 * unlabelled empty seat (a null key — a Swiss shell, say) from turning the
 * whole `not (...)` null and dropping a row that prints.
 */
export async function listSheetDays(auth: AuthCtx, competitionId: string): Promise<string[]> {
  return withTenant(auth.orgId, async (tx) => {
    const tz = await competitionClock(tx, competitionId);
    const rows = await tx<{ day: string }[]>`
      select distinct to_char(f.scheduled_at at time zone ${tz}, 'YYYY-MM-DD') as day
      from fixtures f
      join divisions d on d.id = f.division_id
      where d.competition_id = ${competitionId}
        and f.status in ${tx([...PRINTABLE_STATUSES])}
        and f.scheduled_at is not null
        and not (f.home_entrant_id is null and coalesce(f.home_slot_label->>'key', '') = ${BYE_SLOT_KEY})
        and not (f.away_entrant_id is null and coalesce(f.away_slot_label->>'key', '') = ${BYE_SLOT_KEY})
      order by day`;
    return rows.map((r) => r.day);
  });
}

/**
 * Every card's link, proven in ONE read before anything is printed (owner
 * ruling 2026-09-24): a fixture in the map must hold exactly one live link —
 * not revoked, not expired, the predicate `ensureDeviceLinks` re-opens by —
 * and that link's hash must be the secret the card will print. A fixture the
 * map left out must be one that finished since the sheet chose it (the only
 * reason `ensureDeviceLinks` skips one). Returns the ids that fail.
 */
async function unprovenLinks(
  auth: AuthCtx,
  ids: readonly string[],
  links: ReadonlyMap<string, EnsuredDeviceLink>,
): Promise<string[]> {
  const rows = await withTenant(auth.orgId, (tx) =>
    tx<{ id: string; status: string; token_hash: string | null }[]>`
      select f.id, f.status, dl.token_hash
      from fixtures f
      left join device_links dl on dl.fixture_id = f.id and dl.revoked_at is null
        and (dl.expires_at is null or dl.expires_at > now())
      where f.id in ${tx([...ids])}`,
  );
  const live = new Map<string, { status: string; hashes: string[] }>();
  for (const r of rows) {
    const f = live.get(r.id) ?? { status: r.status, hashes: [] };
    if (r.token_hash !== null) f.hashes.push(r.token_hash);
    live.set(r.id, f);
  }
  return ids.filter((id) => {
    const f = live.get(id);
    if (f === undefined) return true;
    const link = links.get(id);
    if (link === undefined) return !isFinishedFixtureStatus(f.status);
    return f.hashes.length !== 1 || f.hashes[0] !== hashDeviceLinkToken(link.secret);
  });
}

/** What one print covered, for the `scorer_sheets_printed` event: counts only,
 *  never a token, URL or link id (a card's QR is a live credential). */
export interface SheetSummary {
  /** Cards printed. */
  fixtureCount: number;
  /** Distinct courts among them, as the board names them. */
  courtCount: number;
  /** Cards with no court (the "Unassigned" pages). */
  courtlessCount: number;
}

/** The renderer's model plus the print's summary (the renderer ignores it). */
export type ScorerSheet = SheetModel & { summary: SheetSummary };

/**
 * The printable model for one day (§4.4). Shaped like exports.ts's
 * `buildAdmitTicketsDoc`: branding resolved OUTSIDE any tenant transaction,
 * 422 on nothing to print rather than an empty 200. Links are ENSURED —
 * re-shown, never rotated (T2) — and then PROVEN (`unprovenLinks`): one card
 * without a working code refuses the whole sheet, never a partial one.
 * `loadSheetCandidates` runs first, so a foreign competition 404s before
 * anything is minted. `opts.printedAt` is the request's instant (ISO); the
 * sheet prints it on the org clock.
 */
export async function buildScorerSheet(
  auth: AuthCtx,
  competitionId: string,
  days: string | { from?: string; to?: string },
  origin: string,
  locale: Locale,
  opts: { printedAt: string; divisionId?: string },
): Promise<ScorerSheet> {
  const t: SlotLabelLookup = (k, v) => msgFor(locale, k, v);
  const all = await loadSheetCandidates(auth, competitionId, t, undefined, opts.divisionId);
  const chosen = typeof days === "string" ? selectSheetFixtures(all, days) : selectSheetFixtureRange(all, days);
  const nothing = () => new HttpError(422, "No fixtures to print on that day", "NO_FIXTURES_ON_DAY");
  if (chosen.length === 0) throw nothing();
  const [comp] = await withTenant(auth.orgId, (tx) =>
    tx<{ name: string; org_name: string }[]>`
      select c.name, o.name as org_name
      from competitions c join organizations o on o.id = c.org_id
      where c.id = ${competitionId}`,
  );
  if (!comp) throw new HttpError(404, "competition not found");
  const branding = await orgBranding(auth.orgId, comp.org_name, competitionId);

  const ids = chosen.map((c) => c.id);
  const links = await ensureDeviceLinks(auth, competitionId, ids);
  const unproven = await unprovenLinks(auth, ids, links);
  if (unproven.length > 0) {
    log.error({ competitionId, days, fixtureIds: unproven }, "scorer sheet: links not proven, sheet refused");
    throw new HttpError(500, t("sheets.error.linksIncomplete"), "SHEET_LINKS_INCOMPLETE");
  }
  // Finished since the rows were chosen: left off, the rest still print.
  const printed = chosen.filter((c) => links.has(c.id));
  if (printed.length === 0) throw nothing();

  const intl = intlLocaleFor(locale);
  const time = (iso: string, tz: string) =>
    new Intl.DateTimeFormat(intl, { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  // The footer's "YYYY-MM-DD HH:MM" stamp, on the same (org) clock as the
  // cards' times — a Paris organiser must not read the server's UTC.
  const part = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: chosen[0]!.tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(opts.printedAt))
      .map((p) => [p.type, p.value]),
  );
  const printedAt = `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}`;
  // A calendar day, formatted at UTC noon so no zone shifts it (poster.pdf's rule).
  const fmtDay = (d: string, o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(intl, { timeZone: "UTC", ...o }).format(new Date(`${d}T12:00:00Z`));
  const dayOf = (r: SheetCandidate) => localDateOf(r.scheduled_at!, r.tz);
  const dayKeys = [...new Set(printed.map(dayOf))];
  const long = { weekday: "long", day: "numeric", month: "long", year: "numeric" } as const;
  const dayLabel =
    dayKeys.length === 1
      ? fmtDay(dayKeys[0]!, long)
      : `${fmtDay(dayKeys[0]!, { day: "numeric", month: "short" })} – ${fmtDay(dayKeys.at(-1)!, { day: "numeric", month: "short", year: "numeric" })}`;
  // One division: it is the title, the competition rides in the description.
  const oneDivision = opts.divisionId !== undefined;
  const title = oneDivision ? printed[0]!.division_name : comp.name;
  const description = oneDivision ? `${comp.name} · ${dayLabel}` : dayLabel;
  // Court first, days inside it: a court's cards stay together across days, so a
  // multi-day sheet stamps the day on each card's time instead of on the page.
  const multiDay = dayKeys.length > 1;
  const pages = paginateSheet(printed, t("sheets.pdf.noCourt"));
  // A pair prints one member per line; its name is already their " / " join.
  const pairOf = (s: SheetSide | null) =>
    s !== null && s.kind === "pair" && s.members.length >= 2 ? s.members.map((m) => m.full_name) : [];
  return {
    header: {
      kind: "scoresheet",
      title,
      description,
      meta: { printedAt },
      ...(branding !== undefined ? { branding } : {}),
      sections: [],
      pageBreaks: "auto",
    },
    labels: { eyebrow: t("sheets.pdf.eyebrow"), checkNames: t("sheets.pdf.checkNames") },
    pages: pages.map((p) => ({
      heading: courtPageHeading(t, p.courtHeading ?? "", p.pageInCourt, p.pagesInCourt),
      rows: p.rows.map((r) => ({
        fixtureId: r.id,
        url: `${origin}/score/${links.get(r.id)!.secret}`,
        time: multiDay
          ? `${fmtDay(dayOf(r), { weekday: "short", day: "numeric" })} · ${time(r.scheduled_at!, r.tz)}`
          : time(r.scheduled_at!, r.tz),
        matchRef: r.match_ref,
        division: r.division_name,
        home: r.home?.name ?? r.home_tbd,
        away: r.away?.name ?? r.away_tbd,
        homeTbd: r.home === null,
        awayTbd: r.away === null,
        homePair: pairOf(r.home),
        awayPair: pairOf(r.away),
      })),
    })),
    summary: {
      fixtureCount: printed.length,
      courtCount: new Set(printed.flatMap((r) => (r.court_name === null ? [] : [r.court_name]))).size,
      courtlessCount: printed.filter((r) => r.court_name === null).length,
    },
  };
}
