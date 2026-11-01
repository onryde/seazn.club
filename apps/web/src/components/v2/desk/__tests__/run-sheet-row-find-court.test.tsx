import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunSheetRow } from "@/components/v2/desk/run-sheet-row";
import { RunSheet } from "@/components/v2/desk/run-sheet";
import { buildRunSheet, type RunSheetFixture } from "@/lib/run-sheet-groups";
import { messages } from "@/lib/messages";
import { routes } from "@/lib/routes";
import { Fixture } from "@/server/api-v1/schemas";
import { VENUE_NOUNS, type VenueNoun } from "@/lib/venue";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import en from "@/dictionaries/en/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));

// Match Day B2 (spec 2026-10-31 §9: "Unscheduled fixtures link to the free-court candidate list as well as the schedule
// board"). On a match day an unscheduled match with nobody on a court gets a "Find a court" link into Match Day beside its
// "Set time". Match Day has no deep link into one court's candidate list (the list is the focused court's own panel), so
// the link is to Match Day itself. The word is the sport's own playing area (fix round 1, I1): a football match is asked a
// "pitch", a chess game a "board" - `lib/venue.ts`'s nouns, the same ones Match Day's headers use.
//
// Rendered with no DOM (`apps/web` vitest is node-env); every expected string is the dictionary's or the router's own.

const TZ = "UTC";
const NOW_MS = Date.UTC(2026, 8, 5, 12, 0, 0);
const ENTRANTS = { e1: "Alpha", e2: "Bravo" };
const MATCH_DAY = routes.competitionMatchDay("org", "comp");
/** The default noun is the court (an absent sport reads `venueNoun`'s own default), so the label every row-level case below reads. */
const LABEL = messages["runsheet.action.findCourt.court"];
/** Every fixture status the v1 contract declares - the engine's own list, never typed here. */
const STATUSES: readonly string[] = Fixture.shape.status.options;

function fx(o: Partial<RunSheetFixture> = {}): RunSheetFixture {
  return {
    id: "f1", stage_id: "s1", fixture_no: 1, round_no: 1, seq_in_round: 1,
    scheduled_at: null, status: "scheduled", court_name: null, court_id: null, venue_name: null,
    officials: [], outcome: null, home_entrant_id: "e1", away_entrant_id: "e2",
    home_slot_label: null, away_slot_label: null, lane: null, is_final: false, third_place: false, conditional: false, ext_key: null,
    ...o,
  };
}

function row(f: RunSheetFixture, o: { canEdit?: boolean; matchDayHref?: string; venueNoun?: VenueNoun } = {}): string {
  return renderToStaticMarkup(
    <RunSheetRow
      fixture={f} href="/f/1" tz={TZ} orgTz={TZ} nowMs={NOW_MS}
      canEdit={o.canEdit ?? true} entrantNames={ENTRANTS} matchDayHref={o.matchDayHref} venueNoun={o.venueNoun}
    />,
  );
}
const action = (html: string) => /data-row-action="([a-z_]+)"/.exec(html)?.[1] ?? null;
const findCourts = (html: string) => html.match(/data-testid="run-sheet-find-court"/g)?.length ?? 0;
/** The row rendered, and it is the unscheduled one (the positive pair of every "no link" assertion below). */
function expectUnscheduledRow(html: string): void {
  // At least one seat's name (a side still to be drawn prints "TBD", not its name).
  expect(html.includes("Alpha") || html.includes("Bravo")).toBe(true);
  expect(action(html)).toBe("set_time");
}

describe("the run sheet row's Find a court link", () => {
  // The empty case first: not a match day (no href handed down) is today's row, byte for byte in what it offers.
  it("not a match day: an unscheduled row offers Set time and nothing else", () => {
    const html = row(fx());
    expectUnscheduledRow(html);
    expect(findCourts(html)).toBe(0);
    expect(html).not.toContain(LABEL);
  });

  it("a match day: an unscheduled, seated, courtless row beside Set time links to Match Day", () => {
    const html = row(fx(), { matchDayHref: MATCH_DAY });
    expectUnscheduledRow(html);
    expect(findCourts(html)).toBe(1);
    expect(html).toMatch(new RegExp(`<a [^>]*href="${MATCH_DAY}"[^>]*data-testid="run-sheet-find-court"|<a [^>]*data-testid="run-sheet-find-court"[^>]*href="${MATCH_DAY}"`));
    expect(html).toContain(LABEL);
    // Set time stays THE action (the row's one-action premise): the link is the quieter sibling, never a second primary.
    expect(html).toMatch(/data-row-action="set_time"[^>]*class="[^"]*btn-primary/);
    expect(html).toMatch(/data-testid="run-sheet-find-court"[^>]*class="[^"]*btn-ghost|class="[^"]*btn-ghost[^"]*"[^>]*data-testid="run-sheet-find-court"/);
  });

  it("a viewer is never handed it (Match Day is the organiser's: it 404s for anyone who cannot edit)", () => {
    const html = row(fx(), { canEdit: false, matchDayHref: MATCH_DAY });
    expect(html).toContain("Alpha");
    expect(findCourts(html)).toBe(0);
  });

  it("a match that already has a time is not 'unscheduled': no link", () => {
    const html = row(fx({ scheduled_at: "2026-09-05T14:00:00.000Z" }), { matchDayHref: MATCH_DAY });
    expect(html).toContain("Alpha");
    expect(action(html)).not.toBe("set_time");
    expect(findCourts(html)).toBe(0);
  });

  it("a match with no time but a court already is not looking for one: no link", () => {
    const html = row(fx({ court_id: "c1", court_name: "Court 1" }), { matchDayHref: MATCH_DAY });
    expectUnscheduledRow(html);
    expect(findCourts(html)).toBe(0);
  });

  it("a match whose side is still to be drawn is no candidate (Match Day lists only seated matches): no link", () => {
    for (const side of ["home_entrant_id", "away_entrant_id"] as const) {
      const html = row(fx({ [side]: null }), { matchDayHref: MATCH_DAY });
      expectUnscheduledRow(html);
      expect(findCourts(html), side).toBe(0);
    }
  });

  it("only a scheduled match can be asked for a court: every other status offers no link", () => {
    expect(STATUSES.length).toBeGreaterThan(1);
    let checked = 0;
    let linked = 0;
    for (const status of STATUSES) {
      const html = row(fx({ status: status as RunSheetFixture["status"] }), { matchDayHref: MATCH_DAY });
      // A bye is structural and renders no row of this kind at all: nothing to say about it either way.
      checked += 1;
      linked += findCourts(html);
      if (status !== "scheduled") expect(findCourts(html), status).toBe(0);
    }
    expect(checked).toBe(STATUSES.length);
    // The positive pair: of every status, `scheduled` alone carried the link, so the loop above was not blind.
    expect(linked).toBe(1);
  });

  // The seam: the link is only as real as the path that carries the href from the run sheet to the row. A row-level test proves
  // the row; this proves RunSheet hands it down at EVERY block that can hold an untimed, open match - the unscheduled pile (a
  // league's) and the bracket block (a knockout's untimed round is entirely normal: `buildRunSheet`, F2) - built by the REAL
  // grouping from raw fixtures, not by a block typed here. The day and settled blocks cannot hold a `set_time` row (they hold timed
  // and settled matches), which the row's own guard keeps: a dated match in a day block must show none.
  it("RunSheet carries the href to its rows: the unscheduled pile, a knockout's bracket block, and not a dated match", () => {
    const stages = [
      { id: "s1", kind: "league", name: "League", seq: 1 },
      { id: "s2", kind: "knockout", name: "Finals", seq: 2 },
    ];
    const fixtures = [
      fx({ id: "l1", stage_id: "s1", fixture_no: 1 }),
      fx({ id: "l2", stage_id: "s1", fixture_no: 2 }),
      fx({ id: "k1", stage_id: "s2", fixture_no: 3 }),
      fx({ id: "d1", stage_id: "s1", fixture_no: 4, scheduled_at: "2026-09-05T15:00:00.000Z" }),
    ];
    const blocks = buildRunSheet({ fixtures, stages, tz: TZ, nowMs: NOW_MS });
    // The grouping really made the shapes this test claims to cover.
    expect(blocks.map((b) => b.kind).sort()).toEqual(["bracket", "day", "unscheduled"]);
    const render = (matchDayHref?: string, venueNoun?: VenueNoun) =>
      renderToStaticMarkup(
        <RunSheet
          blocks={blocks} stages={stages} tz={TZ} orgTz={TZ} nowMs={NOW_MS} matchMinutes={30}
          entrantNames={ENTRANTS} canEdit hrefFor={(f) => `/f/${f.fixture_no}`}
          filter="all" onFilter={() => {}} stageId={null} onStageFilter={() => {}} matchDayHref={matchDayHref} venueNoun={venueNoun}
        />,
      );
    expect(findCourts(render()), "not a match day: none anywhere").toBe(0);
    const on = render(MATCH_DAY);
    // Three untimed open matches (two in the pile, one in the bracket) offer Set time; the dated one does not.
    expect(on.match(/data-row-action="set_time"/g)?.length, "untimed rows rendered").toBe(3);
    expect(findCourts(on), "one link per untimed row, in the pile AND the bracket block").toBe(3);
    expect(on.match(new RegExp(`href="${MATCH_DAY}"`, "g"))?.length).toBe(3);
    // The sport's noun rides the same two paths (fix round 1, I1): every link in the pile AND the bracket block says "pitch".
    const pitch = render(MATCH_DAY, "pitch");
    const word = messages["runsheet.action.findCourt.pitch"];
    expect(pitch.match(new RegExp(`>${word}<`, "g"))?.length, "pitch label on all three").toBe(3);
    expect(pitch, "and no row fell back to the court word").not.toContain(`>${messages["runsheet.action.findCourt.court"]}<`);
  });
});

// Fix round 1 (I1): the word follows the sport's playing area, one WHOLE string per noun per locale (es/fr/nl carry grammatical
// gender, so there is no `{noun}` slot to fill). Every expected string below is read from the dictionaries.
describe("the Find link names the sport's playing area", () => {
  const LOCALES: Record<string, Record<string, string>> = { en, es, fr, nl };
  const labelKey = (noun: string) => `runsheet.action.findCourt.${noun}`;

  it("every noun lib/venue.ts can answer: the link reads that noun's own string, and the five differ", () => {
    expect(VENUE_NOUNS.length).toBeGreaterThan(1);
    let checked = 0;
    const read = new Set<string>();
    for (const noun of VENUE_NOUNS) {
      const html = row(fx(), { matchDayHref: MATCH_DAY, venueNoun: noun });
      const want = (messages as Record<string, string>)[labelKey(noun)]!;
      expect(want, `${noun}: the English string exists`).toBeTruthy();
      expect(findCourts(html), noun).toBe(1);
      expect(html, noun).toContain(`data-testid="run-sheet-find-court"`);
      expect(html, noun).toContain(`>${want}<`);
      read.add(want);
      checked += 1;
    }
    expect(checked).toBe(VENUE_NOUNS.length);
    // Five nouns, five sentences: a lookup that ignored the noun could not read five different strings.
    expect(read.size).toBe(VENUE_NOUNS.length);
  });

  it("absent noun is the court (the default `venueNoun` itself answers)", () => {
    expect(row(fx(), { matchDayHref: MATCH_DAY })).toContain(`>${messages["runsheet.action.findCourt.court"]}<`);
  });

  it("all four locales carry all five, each naming the locale's own Match Day word for that noun; the old single key is gone", () => {
    let checked = 0;
    for (const [locale, d] of Object.entries(LOCALES)) {
      expect(d["runsheet.action.findCourt"], `${locale}: the one-size key is retired`).toBeUndefined();
      for (const noun of VENUE_NOUNS) {
        const label = d[labelKey(noun)];
        const word = d[`matchDay.noun.${noun}`];
        expect(typeof label, `${locale} ${labelKey(noun)}`).toBe("string");
        expect(label!.trim().length, `${locale} ${noun}`).toBeGreaterThan(0);
        expect(typeof word, `${locale} matchDay.noun.${noun}`).toBe("string");
        // The label is a whole sentence about the SAME word the Match Day headers use for this noun.
        expect(label!.toLocaleLowerCase(locale), `${locale} ${noun}`).toContain(word!.toLocaleLowerCase(locale));
        checked += 1;
      }
    }
    expect(checked).toBe(Object.keys(LOCALES).length * VENUE_NOUNS.length);
  });
});
