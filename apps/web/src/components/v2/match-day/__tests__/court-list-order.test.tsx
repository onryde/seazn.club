// Match Day E2 item 2 (owner 2026-11-01): the court list's order and its fold.
//
// The rules, from the brief and not from the code:
//  - groups run playing -> called -> up next (a FREE court with a queue: nothing on it, something waiting) -> free -> closed (fix
//    round 1, m2: a court shut by its hours right now is not "free": it has its own group after free, outside the fold); within a
//    group the courts keep the order they came in;
//  - a court that is free with an EMPTY queue folds into one row, "N more courts free (Courts 5–10)", which expands in place;
//  - if EVERY court is free and empty the list is shown whole (nothing to rank them against).
// Two decisions the brief left open, pinned here so they are decisions and not accidents: another competition's court is not free,
// so it is never folded into "free" (it sits between "up next" and "free"); and a fold hides at least two courts.
//
// Anti-vacuity: every sweep reports what it checked, and zero checked fails.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { plural, t } from "@/lib/i18n-runtime";
import { VENUE_NOUNS } from "@/lib/venue";
import type { MatchDayCourt, MatchDayFixture, MatchDayQueued } from "@/lib/match-day/types";
import {
  COURT_GROUPS,
  MIN_FOLDED,
  courtCounts,
  courtGroup,
  foldFreeCourts,
  foldLabel,
  headerCountParts,
  foldedNames,
  orderCourts,
  type CourtGroup,
} from "@/lib/match-day/view";
import { CourtList } from "@/components/v2/match-day/court-list";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import publicEnForWords from "@/dictionaries/en/public.json";
import { levelWords } from "@/lib/score/levels";

/** A live level's words (TB, MTB, Ad) in English (task F5): what the shell hands its lists. */
const WORDS = levelWords(publicEnForWords as Dict);

const dict = en as Dict;
const DICTS: Record<Locale, Dict> = { en, es, fr, nl } as Record<Locale, Dict>;

const fixture = (id: string): MatchDayFixture => ({
  id,
  division_id: "d-1",
  division_name: "Open",
  division_slug: "open",
  fixture_no: 1,
  sport_key: "badminton",
  stage_label: "League",
  round: { code: "R1", label: "Round 1", coded: false },
  home: "Zara Khan",
  away: "Ella Brooks",
  home_entrant_id: "e-1",
  away_entrant_id: "e-2",
  headline: null,
  summary: null,
  serving: null,
  started_at: null,
  called_at: null,
  stream: null,
  scorer_attention: null,
  live_video: null,
  format_line: null,
});
const queued = (id: string): MatchDayQueued => ({
  ...fixture(id),
  planned_at: "2026-10-31T12:00:00.000Z",
  estimated_at: "2026-10-31T12:00:00.000Z",
});

const court = (n: number, o: Partial<MatchDayCourt> = {}): MatchDayCourt => ({
  court_id: `c-${n}`,
  court_name: `Court ${n}`,
  venue_id: "venue-1",
  venue_name: "Main Hall",
  sport_noun: "court",
  state: "free",
  current: null,
  in_use_by: null,
  free_since: null,
  queue: [],
  closure: null,
  ...o,
});
const playing = (n: number) => court(n, { state: "playing", current: fixture(`p-${n}`) });
const called = (n: number) => court(n, { state: "called", current: fixture(`k-${n}`) });
const upNext = (n: number) => court(n, { queue: [queued(`q-${n}`)] });
const elsewhere = (n: number, withQueue = false) =>
  court(n, { state: "in_use_elsewhere", in_use_by: "Winter Open", queue: withQueue ? [queued(`q-${n}`)] : [] });
const free = (n: number) => court(n);
/** Shut by its hours right now (a free court: nothing is on it, but it cannot be called onto without a "Call anyway"). */
const closed = (n: number, o: Partial<MatchDayCourt> = {}) => court(n, { closure: { kind: "now", until: "2026-10-31T15:00:00.000Z" }, ...o });

const ids = (cs: readonly MatchDayCourt[]) => cs.map((c) => c.court_id);

describe("courtGroup — every state, with and without a queue", () => {
  it("playing and called are their state whatever is queued; a free court is up next only with a queue; another competition's court is its own group", () => {
    const table: [Partial<MatchDayCourt>, CourtGroup][] = [
      [{ state: "playing" }, "playing"],
      [{ state: "playing", queue: [queued("q")] }, "playing"],
      [{ state: "called" }, "called"],
      [{ state: "called", queue: [queued("q")] }, "called"],
      [{ state: "free" }, "free"],
      [{ state: "free", queue: [queued("q")] }, "up_next"],
      [{ state: "in_use_elsewhere" }, "elsewhere"],
      [{ state: "in_use_elsewhere", queue: [queued("q")] }, "elsewhere"],
      // m2: closed NOW is a group of its own — only for a court with nothing on it and nothing shared; whatever its queue.
      [{ state: "free", closure: { kind: "now", until: null } }, "closed"],
      [{ state: "free", closure: { kind: "now", until: "2026-10-31T15:00:00.000Z" } }, "closed"],
      [{ state: "free", queue: [queued("q")], closure: { kind: "now", until: null } }, "closed"],
      // A break still to come is not closed now; and a match already on the court (or another competition's hold) keeps its state.
      [{ state: "free", closure: { kind: "later", from: "2026-10-31T14:00:00.000Z", until: "2026-10-31T15:00:00.000Z" } }, "free"],
      [{ state: "free", queue: [queued("q")], closure: { kind: "later", from: "2026-10-31T14:00:00.000Z", until: "2026-10-31T15:00:00.000Z" } }, "up_next"],
      [{ state: "playing", closure: { kind: "now", until: null } }, "playing"],
      [{ state: "called", closure: { kind: "now", until: null } }, "called"],
      [{ state: "in_use_elsewhere", closure: { kind: "now", until: null } }, "elsewhere"],
    ];
    for (const [o, group] of table) expect(courtGroup(court(1, o)), JSON.stringify(o)).toBe(group);
    expect(table).toHaveLength(16);
    // The four states the model declares, each answered above (a new state is a compile error in courtGroup; this pins the count).
    expect(new Set(table.map(([o]) => o.state))).toEqual(new Set(["playing", "called", "free", "in_use_elsewhere"]));
  });

  it("the group list is the brief's order, with the not-free group between up next and free and the closed group last (m2)", () => {
    expect([...COURT_GROUPS]).toEqual(["playing", "called", "up_next", "elsewhere", "free", "closed"]);
  });
});

describe("orderCourts", () => {
  it("lists playing, called, up next, then free — the brief's worked example", () => {
    const ordered = orderCourts([free(5), playing(1), upNext(3), called(2), free(6), playing(4)]);
    expect(ids(ordered)).toEqual(["c-1", "c-4", "c-2", "c-3", "c-5", "c-6"]);
  });

  it("m2: a closed court sorts after the free ones, whatever its place in the day", () => {
    const ordered = orderCourts([closed(2), free(5), playing(1), closed(3, { queue: [queued("q-3")] }), upNext(4), free(6), elsewhere(7)]);
    expect(ids(ordered)).toEqual(["c-1", "c-4", "c-7", "c-5", "c-6", "c-2", "c-3"]);
  });

  it("an empty list is an empty list", () => {
    expect(orderCourts([])).toEqual([]);
  });

  it("within a group the given order is kept, and the input is untouched", () => {
    const input = [free(9), free(2), playing(8), playing(3)];
    const before = ids(input);
    expect(ids(orderCourts(input))).toEqual(["c-8", "c-3", "c-9", "c-2"]);
    expect(ids(input)).toEqual(before);
  });

  it("sweep: any arrangement of courts of every group comes out grouped, stable, and the same courts", () => {
    const base = [playing(1), playing(2), called(3), called(4), upNext(5), upNext(6), elsewhere(7), elsewhere(8, true), free(9), free(10), closed(11), closed(12)];
    // A seeded shuffle (no Math.random: a failure must replay).
    let seed = 20261101;
    const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    let checked = 0;
    for (let run = 0; run < 200; run++) {
      const input = [...base];
      for (let i = input.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [input[i], input[j]] = [input[j]!, input[i]!];
      }
      const out = orderCourts(input);
      expect(ids(out).sort()).toEqual(ids(input).sort());
      const ranks = out.map((c) => COURT_GROUPS.indexOf(courtGroup(c)));
      expect(ranks, ids(input).join()).toEqual([...ranks].sort((a, b) => a - b));
      for (const g of COURT_GROUPS) {
        const inOut = out.filter((c) => courtGroup(c) === g).map((c) => c.court_id);
        const inIn = input.filter((c) => courtGroup(c) === g).map((c) => c.court_id);
        expect(inOut, `${g} keeps its relative order`).toEqual(inIn);
        expect(inOut.length, `${g} is not an empty group in this sweep`).toBeGreaterThan(0);
      }
      checked++;
    }
    expect(checked).toBe(200);
  });
});

describe("foldFreeCourts", () => {
  it("empty case first: no courts, nothing folded", () => {
    expect(foldFreeCourts([], null)).toEqual({ shown: [], folded: [] });
  });

  it("every court free and empty: the list is shown whole — even with one of them open", () => {
    const all = [free(1), free(2), free(3)];
    for (const selected of [null, "c-2"]) {
      const r = foldFreeCourts(all, selected);
      expect(ids(r.shown)).toEqual(["c-1", "c-2", "c-3"]);
      expect(r.folded).toEqual([]);
    }
  });

  it("folds the free, empty courts and nothing else: playing, called, up next and another competition's court stay", () => {
    const ordered = orderCourts([free(5), playing(1), upNext(3), called(2), free(6), elsewhere(7), free(8)]);
    const r = foldFreeCourts(ordered, null);
    expect(ids(r.shown)).toEqual(["c-1", "c-2", "c-3", "c-7"]);
    expect(ids(r.folded)).toEqual(["c-5", "c-6", "c-8"]);
  });

  it("m2: a closed court is never folded into 'free' — it stays shown, after the others, outside the fold", () => {
    const ordered = orderCourts([free(5), playing(1), closed(2), free(6), free(7)]);
    const r = foldFreeCourts(ordered, null);
    expect(ids(r.folded)).toEqual(["c-5", "c-6", "c-7"]);
    expect(ids(r.shown)).toEqual(["c-1", "c-2"]);
    // Closed courts with ONE free one: no fold (a fold hides at least two), everything shown in list order, closed last.
    const one = orderCourts([closed(2), free(5), playing(1)]);
    expect(ids(foldFreeCourts(one, null).shown)).toEqual(["c-1", "c-5", "c-2"]);
    expect(foldFreeCourts(one, null).folded).toEqual([]);
  });

  it("m2: with nothing happening anywhere — every court free or closed — the list is shown whole, closed last", () => {
    const idle = orderCourts([closed(1), free(2), free(3), closed(4)]);
    const r = foldFreeCourts(idle, null);
    expect(ids(r.shown)).toEqual(["c-2", "c-3", "c-1", "c-4"]);
    expect(r.folded).toEqual([]);
  });

  it("a single free court is not worth a fold row", () => {
    const ordered = orderCourts([playing(1), free(2)]);
    expect(foldFreeCourts(ordered, null)).toEqual({ shown: ordered, folded: [] });
    // The fold's plural copy has no singular form, which holds only while a fold hides at least two courts.
    expect(MIN_FOLDED).toBeGreaterThanOrEqual(2);
  });

  it("the court the organiser has open is never folded away from under them", () => {
    const ordered = orderCourts([playing(1), free(4), free(5), free(6)]);
    const r = foldFreeCourts(ordered, "c-5");
    expect(ids(r.shown)).toEqual(["c-1", "c-5"]);
    expect(ids(r.folded)).toEqual(["c-4", "c-6"]);
    // Open on a court that leaves only one to fold: no fold at all.
    const two = orderCourts([playing(1), free(4), free(5)]);
    expect(foldFreeCourts(two, "c-5")).toEqual({ shown: two, folded: [] });
  });

  it("a court that gains a queue leaves the fold, one that loses it joins (the sequence the day produces)", () => {
    const day = (queued5: boolean) => orderCourts([playing(1), free(4), queued5 ? upNext(5) : free(5), free(6)]);
    expect(ids(foldFreeCourts(day(false), null).folded)).toEqual(["c-4", "c-5", "c-6"]);
    expect(ids(foldFreeCourts(day(true), null).folded)).toEqual(["c-4", "c-6"]);
    expect(ids(foldFreeCourts(day(true), null).shown)).toEqual(["c-1", "c-5"]);
  });
});

describe("foldedNames", () => {
  const names = (...ns: string[]) => foldedNames(ns, "Court", "Courts");

  it("the brief's example: Court 5 to Court 10 reads 'Courts 5–10'", () => {
    expect(names("Court 5", "Court 6", "Court 7", "Court 8", "Court 9", "Court 10")).toBe("Courts 5–10");
  });

  it("breaks a run where the numbers do", () => {
    expect(names("Court 5", "Court 6", "Court 8")).toBe("Courts 5–6, Court 8");
    expect(names("Court 2", "Court 4", "Court 6")).toBe("Court 2, Court 4, Court 6");
  });

  it("names that carry no number are listed as they are, in the order given", () => {
    expect(names("Centre", "Court 3", "Court 4", "Show Court")).toBe("Centre, Courts 3–4, Show Court");
  });

  it("a run under another word keeps its own word; the sport's noun is pluralised only for its own", () => {
    expect(names("Hall A 1", "Hall A 2", "Hall A 3")).toBe("Hall A 1–3");
    expect(foldedNames(["Pitch 1", "Pitch 2"], "Pitch", "Pitches")).toBe("Pitches 1–2");
    expect(foldedNames(["pitch 1", "pitch 2"], "Pitch", "Pitches")).toBe("Pitches 1–2");
  });

  it("digits as typed survive ('Court 05' to 'Court 06'), two different words do not join, a name is not reordered", () => {
    expect(names("Court 05", "Court 06")).toBe("Courts 05–06");
    expect(names("Court 1", "Hall 2")).toBe("Court 1, Hall 2");
    expect(names("Court 3", "Court 2")).toBe("Court 3, Court 2");
  });

  it("nothing in, nothing out", () => {
    expect(names()).toBe("");
  });
});

describe("the fold row in every locale and every noun (counted)", () => {
  it("each noun x locale x count has copy for the count and the names, no raw placeholder or key left", () => {
    let checked = 0;
    for (const noun of VENUE_NOUNS) {
      for (const [locale, d] of Object.entries(DICTS) as [Locale, Dict][]) {
        for (const count of [2, 5, 10]) {
          const text = plural(d, `matchDay.list.freeFold.${noun}`, count, locale, { names: "NAMES" });
          expect(text, `${locale} ${noun} ${count}`).toContain(String(count));
          expect(text, `${locale} ${noun} ${count}`).toContain("(NAMES)");
          expect(text, `${locale} ${noun} ${count}`).not.toMatch(/[{}]|matchDay\./);
          expect(t(d, `matchDay.list.nounPlural.${noun}`), `${locale} ${noun}`).not.toMatch(/^matchDay\./);
          checked++;
        }
      }
    }
    expect(checked).toBe(VENUE_NOUNS.length * 4 * 3);
  });
});

describe("m5 — the fold label: a range when the names make ONE, else the count and the venue", () => {
  const at = (n: number, venue: { id: string; name: string }, o: Partial<MatchDayCourt> = {}) =>
    court(n, { venue_id: venue.id, venue_name: venue.name, ...o });
  const HALL = { id: "v-hall", name: "City Sports Hall" };
  const ANNEX = { id: "v-annex", name: "Annex" };
  const label = (courts: MatchDayCourt[], d: Dict = dict, locale: Locale = "en") => foldLabel(d, locale, courts, sharedNounOf(courts));
  const sharedNounOf = (courts: MatchDayCourt[]) => (courts[0]?.sport_noun ?? "court") as (typeof VENUE_NOUNS)[number];

  it("one run: the names are the label, as before ('6 more courts free (Courts 5–10)')", () => {
    expect(label([5, 6, 7, 8, 9, 10].map((n) => at(n, HALL)))).toBe("6 more courts free (Courts 5–10)");
    expect(label([at(3, HALL), at(4, HALL)])).toBe("2 more courts free (Courts 3–4)");
  });

  it("names that cannot be ranged, all in ONE venue: '4 free courts · City Sports Hall' - the brief's own example", () => {
    expect(label([at(2, HALL), at(4, HALL), at(6, HALL), at(9, HALL)])).toBe("4 free courts · City Sports Hall");
    // Two runs are not one range either.
    expect(label([5, 6, 8, 9, 10].map((n) => at(n, HALL)))).toBe("5 free courts · City Sports Hall");
    // Names with no number.
    expect(label([at(1, HALL, { court_name: "Centre" }), at(2, HALL, { court_name: "Show Court" })])).toBe("2 free courts · City Sports Hall");
  });

  it("across venues: the count alone - '4 free courts' - with no venue picked over the others", () => {
    const mixed = [at(1, HALL, { court_name: "Court 1 (City Sports Hall)" }), at(1, ANNEX, { court_name: "Court 1 (Annex)" }), at(3, HALL), at(7, ANNEX)];
    expect(label(mixed)).toBe("4 free courts");
    // One run across two venues is still a run (the names say it all): 'Courts 3–4'.
    expect(label([at(3, HALL), at(4, ANNEX)])).toBe("2 more courts free (Courts 3–4)");
  });

  it("the sport's own noun, and every locale (counted): the count form reads in the reader's words, never a raw key, the venue after a middle dot", () => {
    let checked = 0;
    for (const noun of VENUE_NOUNS) {
      for (const [locale, d] of Object.entries(DICTS) as [Locale, Dict][]) {
        const courts = [2, 4, 6].map((n) => at(n, HALL, { sport_noun: noun }));
        const text = foldLabel(d, locale, courts, noun);
        expect(text, `${locale} ${noun}`).toContain("3");
        expect(text, `${locale} ${noun}`).toMatch(/ · City Sports Hall$/);
        expect(text, `${locale} ${noun}`).not.toMatch(/[{}]|matchDay\./);
        // Not the ranged form: no parenthesised names.
        expect(text, `${locale} ${noun}`).not.toContain("(");
        checked++;
      }
    }
    expect(checked).toBe(VENUE_NOUNS.length * 4);
    expect(label([2, 4, 6].map((n) => at(n, HALL, { sport_noun: "pitch", court_name: `Pitch ${n}` })), dict, "en")).toBe("3 free pitches · City Sports Hall");
  });

  it("as drawn: the folded row carries the count-and-venue label, and opening it lists EVERY folded court by name", () => {
    const day = orderCourts([playing(1), ...[4, 6, 9, 12].map((n) => at(n, HALL))]);
    const html = renderToStaticMarkup(<CourtList words={WORDS} courts={day} selectedId={null} dict={dict} locale="en" tz="Europe/London" onSelect={() => {}} />);
    expect(html).toContain("4 free courts · City Sports Hall");
    const island = renderIsland(CourtList, { courts: day, selectedId: null, dict, words: WORDS, locale: "en" as Locale, tz: "Europe/London", onSelect: () => {} });
    const toggle = () => island.tree().find((e) => propsOf(e)["data-testid"] === "md-court-fold-toggle")!;
    (propsOf(toggle()).onClick as () => void)();
    const listed = island.tree().filter((e) => propsOf(e).court !== undefined && (propsOf(e).court as MatchDayCourt).state === "free").map((e) => (propsOf(e).court as MatchDayCourt).court_name);
    expect(listed).toEqual(["Court 4", "Court 6", "Court 9", "Court 12"]);
  });
});

describe("m2 — a closed court is not counted free", () => {
  it("the header's free count leaves closed courts out; courts and playing are unchanged", () => {
    const day = [playing(1), called(2), free(3), upNext(4), closed(5), closed(6, { queue: [queued("q-6")] }), elsewhere(7)];
    expect(courtCounts(day)).toEqual({ courts: 7, playing: 1, free: 2 });
    // Without the closed ones the free count is the same: they were never in it.
    expect(courtCounts(day.filter((c) => courtGroup(c) !== "closed")).free).toBe(2);
    // The empty case: every court shut — none is free.
    expect(courtCounts([closed(1), closed(2)])).toEqual({ courts: 2, playing: 0, free: 0 });
    expect(courtCounts([])).toEqual({ courts: 0, playing: 0, free: 0 });
  });

  it("the header line follows: '7 courts · 1 playing · 2 free' for that day, in the reader's words", () => {
    const day = [playing(1), called(2), free(3), upNext(4), closed(5), closed(6), elsewhere(7)];
    const parts = headerCountParts(dict, "en", "court", day, []);
    expect(parts).toEqual(["7 courts", "1 playing", "2 free"]);
  });

  it("the row says 'Closed', not 'Free'; the dot is its own; a free court still says 'Free'", () => {
    const render = (courts: MatchDayCourt[]) =>
      renderToStaticMarkup(<CourtList words={WORDS} courts={courts} selectedId={null} dict={dict} locale="en" tz="Europe/London" onSelect={() => {}} />);
    const html = render(orderCourts([playing(1), free(2), closed(3)]));
    const rowOf = (id: string) => new RegExp(`<button[^>]*data-court-id="${id}"[\\s\\S]*?</button>`).exec(html)![0];
    expect(rowOf("c-3")).toContain(">Closed</span>");
    expect(rowOf("c-3")).not.toContain(">Free</span>");
    expect(rowOf("c-3")).toContain('data-closed="true"');
    expect(rowOf("c-2")).toContain(">Free</span>");
    expect(rowOf("c-2")).not.toContain("data-closed");
    // The closure line stays on the card.
    expect(rowOf("c-3")).toContain("Closed until 15:00");
  });

  it("closed courts list AFTER the fold row, outside it; opening the fold does not move them", () => {
    const day = orderCourts([free(5), free(6), free(7), playing(1), closed(2), closed(3)]);
    const html = renderToStaticMarkup(<CourtList words={WORDS} courts={day} selectedId={null} dict={dict} locale="en" tz="Europe/London" onSelect={() => {}} />);
    const at = (needle: string) => html.indexOf(needle);
    expect(at('data-court-id="c-1"')).toBeGreaterThan(-1);
    expect(at('data-testid="md-court-fold"')).toBeGreaterThan(at('data-court-id="c-1"'));
    expect(at('data-court-id="c-2"')).toBeGreaterThan(at('data-testid="md-court-fold"'));
    expect(at('data-court-id="c-3"')).toBeGreaterThan(at('data-court-id="c-2"'));
    expect(html).toContain("3 more courts free");
    // The fold's count does not include the closed courts.
    expect(html).not.toContain("5 more courts free");
  });

  it("every locale has the words: the row's 'Closed' and the panel's closed title, none a raw key (counted)", () => {
    let checked = 0;
    for (const [locale, d] of Object.entries(DICTS) as [Locale, Dict][]) {
      for (const key of ["matchDay.state.closed", "matchDay.free.closedTitle"] as const) {
        const text = t(d, key, { court: "Court 5" });
        expect(text, `${locale} ${key}`).not.toMatch(/^matchDay\.|[{}]/);
        expect(text.length, `${locale} ${key}`).toBeGreaterThan(3);
        checked++;
      }
      expect(t(d, "matchDay.free.closedTitle", { court: "Court 5" }), locale).toContain("Court 5");
      expect(t(d, "matchDay.state.closed"), locale).not.toBe(t(d, "matchDay.state.free"));
    }
    expect(checked).toBe(8);
  });
});

describe("the court list as drawn", () => {
  const rowsOf = (html: string): string[] =>
    [...html.matchAll(/data-testid="md-court-row" data-court-id="([^"]+)"/g)].map((m) => m[1]!);
  const render = (courts: MatchDayCourt[], selectedId: string | null = null) =>
    renderToStaticMarkup(<CourtList words={WORDS} courts={courts} selectedId={selectedId} dict={dict} locale="en" tz="Europe/London" onSelect={() => {}} />);

  const tenCourts = orderCourts([
    free(5), free(6), free(7), free(8), free(9), free(10),
    playing(1), called(2), upNext(3), upNext(4),
  ]);

  it("the day's list: the live courts in order, then ONE row for the five free ones — 'Courts 5–10' — and no folded court drawn", () => {
    const html = render(tenCourts);
    expect(rowsOf(html)).toEqual(["c-1", "c-2", "c-3", "c-4"]);
    expect(html).toContain('data-testid="md-court-fold"');
    expect(html).toContain("6 more courts free (Courts 5–10)");
    expect(html).toMatch(/data-testid="md-court-fold-toggle"[^>]*aria-expanded="false"/);
    // The folded courts are not drawn at all while the row is closed.
    for (const n of [5, 6, 7, 8, 9, 10]) expect(html).not.toContain(`data-court-id="c-${n}"`);
  });

  it("every court free and empty: unfolded, no fold row", () => {
    const html = render([free(1), free(2), free(3)]);
    expect(rowsOf(html)).toEqual(["c-1", "c-2", "c-3"]);
    expect(html).not.toContain('data-testid="md-court-fold"');
  });

  it("the open court stays on the list and the fold's label follows it - the names no longer form ONE range, so the label is the count and the venue (m5)", () => {
    const html = render(tenCourts, "c-7");
    expect(rowsOf(html)).toEqual(["c-1", "c-2", "c-3", "c-4", "c-7"]);
    expect(html).toContain("5 free courts · Main Hall");
    expect(html).not.toContain("Courts 5–6, Courts 8–10");
  });

  it("a football day says pitches: the sport's own noun in the row and its range", () => {
    const pitch = (n: number) => court(n, { sport_noun: "pitch", court_name: `Pitch ${n}` });
    const html = render(orderCourts([playing(1), pitch(2), pitch(3), pitch(4)]));
    expect(html).toContain("3 more pitches free (Pitches 2–4)");
  });

  it("the row opens and closes in place, and the courts it opens are the folded ones, in order", () => {
    const island = renderIsland(CourtList, { courts: tenCourts, selectedId: null, dict, words: WORDS, locale: "en" as Locale, tz: "Europe/London", onSelect: () => {} });
    const toggle = (tree: ReactElement[]) => tree.find((e) => propsOf(e)["data-testid"] === "md-court-fold-toggle")!;
    const folded = (tree: ReactElement[]) =>
      tree.filter((e) => propsOf(e).court !== undefined && (propsOf(e).court as MatchDayCourt).state === "free" && (propsOf(e).court as MatchDayCourt).queue.length === 0);

    expect(folded(island.tree())).toHaveLength(0);
    expect(propsOf(toggle(island.tree()))["aria-expanded"]).toBe(false);

    (propsOf(toggle(island.tree())).onClick as () => void)();
    expect(propsOf(toggle(island.tree()))["aria-expanded"]).toBe(true);
    expect(folded(island.tree()).map((e) => (propsOf(e).court as MatchDayCourt).court_id)).toEqual(["c-5", "c-6", "c-7", "c-8", "c-9", "c-10"]);

    (propsOf(toggle(island.tree())).onClick as () => void)();
    expect(propsOf(toggle(island.tree()))["aria-expanded"]).toBe(false);
    expect(folded(island.tree())).toHaveLength(0);
  });

  it("the fold row is a real control: a 44px target (min-h-14) that is a button", () => {
    const html = render(tenCourts);
    const tag = /<button[^>]*data-testid="md-court-fold-toggle"[^>]*>/.exec(html)?.[0] ?? "";
    expect(tag).toMatch(/\bmin-h-14\b/);
  });
});
