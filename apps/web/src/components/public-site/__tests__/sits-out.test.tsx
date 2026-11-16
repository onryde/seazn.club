// W5 app PR A, Task 3 (X-SF-4, FX-G21; owner R24 pick 4 option A): the public fixtures list says who sits out a round - "Sits out: Eve" under
// the round's heading in the round view. Driven through the real producers: the byes are the ENGINE's own schedule (`rounds[].bye`),
// stored the way Generate stores them (`config.round_byes`), turned into lines by the page's own helper (`publicSitsOutLines`) and
// rendered by the real `Schedule`. A withdrawn entrant is not named (the filter is this task's own: differential, none on main).
//
// Node render only (no DOM in apps/web vitest). Every sweep reports its count; zero checked is a failure.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { generateRoundRobin } from "@seazn/engine/scheduling";
import publicEn from "@/dictionaries/en/public.json";
import publicEs from "@/dictionaries/es/public.json";
import publicFr from "@/dictionaries/fr/public.json";
import publicNl from "@/dictionaries/nl/public.json";
import type { Dict } from "@/lib/i18n-constants";
import type { PublicFixture } from "@/server/public-site/data";
import { publicSitsOutLines } from "@/server/public-site/schedule-copy";
import { Schedule, type ScheduleCopy } from "../schedule";

const DICTS = { en: publicEn, es: publicEs, fr: publicFr, nl: publicNl } as unknown as Record<string, Dict>;
const COPY: ScheduleCopy = {
  timeTbd: "(time tbd)", allEntrants: "(all)", live: "(live)", ended: "(ended)", tbd: "(tbd)", held: "(held)",
  filterLabel: "(filter)", viewLabel: "(view)", viewDay: "(day)", viewRound: "(round)", calendar: "(calendar)",
  timesIn: "(times in {zone})", empty: "(empty)", roundOpened: "(opened)",
};

const IDS = ["a", "b", "c", "d", "e"];
const NAMES: Record<string, string> = { a: "Ana", b: "Bo", c: "Cy", d: "Di", e: "Eve" };
const SCHEDULE = generateRoundRobin({ entrants: IDS, config: { legs: 1 } });
/** The stage's `config.round_byes`, exactly as Generate writes it from the engine's schedule. */
const ROUND_BYES = SCHEDULE.rounds.flatMap((r) => (r.bye === undefined ? [] : [{ pool: null, round_no: r.roundNo, leg: r.leg, entrant_id: r.bye }]));
const FIXTURES: PublicFixture[] = SCHEDULE.fixtures.map((f, i) => ({
  id: `f${i + 1}`,
  division_id: "d1",
  stage_id: "s1",
  pool_id: null,
  round_no: f.roundNo,
  seq_in_round: f.court,
  home_entrant_id: f.home,
  away_entrant_id: f.away,
  home_slot_label: null,
  away_slot_label: null,
  scheduled_at: null,
  venue: null,
  court_label: null,
  venue_name: null,
  court_name: null,
  status: "scheduled",
  outcome: null,
  summary: null,
  last_seq: null,
}));

const render = (sitsOut: Record<string, string> | undefined) =>
  renderToStaticMarkup(
    <Schedule
      fixtures={FIXTURES}
      entrantNames={NAMES}
      divisionPath="/o/c/d"
      tz="Europe/London"
      slotLabels={{}}
      roundLabels={Object.fromEntries(FIXTURES.map((f) => [f.id, `Round ${f.round_no}`]))}
      stageOrder={{ s1: 1 }}
      stageNames={{ s1: "League" }}
      {...(sitsOut ? { sitsOut } : {})}
      copy={COPY}
      locale="en"
    />,
  );
/** Each round group's heading and its sits-out line (null when it has none), in page order. */
const groups = (html: string) =>
  [...html.matchAll(/<section class="mb-6"><h3[^>]*>([^<]*)[^]*?<\/h3>(<p data-testid="schedule-sits-out"[^>]*>([^<]*)<\/p>)?/g)].map((m) => ({
    heading: m[1]!.trim(),
    line: m[3] ?? null,
  }));
const lines = (dict: Dict, statuses: Record<string, string> = {}) =>
  publicSitsOutLines(dict, [{ id: "s1", round_byes: ROUND_BYES }], NAMES, statuses);

describe("public fixtures list: Sits out (X-SF-4)", () => {
  it("premise: the engine draws 5 rounds, one bye each, every entrant once (rulebook: an odd field rests one per round)", () => {
    expect(ROUND_BYES).toHaveLength(5);
    expect(ROUND_BYES.map((b) => b.round_no).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(ROUND_BYES.map((b) => b.entrant_id).sort()).toEqual(IDS);
  });

  it("the empty case first: no sitsOut prop (the embed, an even field) draws no line, and the rounds still render", () => {
    const html = render(undefined);
    expect(html).not.toContain("schedule-sits-out");
    expect(groups(html), "anti-vacuity: five round groups").toHaveLength(5);
  });

  it("five teams: every round names the one team resting, in the round view", () => {
    const html = render(lines(publicEn as unknown as Dict));
    const got = groups(html);
    expect(got).toHaveLength(5);
    // The expected line per round is the engine's own bye, named: derived from `SCHEDULE.rounds`, not from the code under test.
    SCHEDULE.rounds.forEach((r, i) => {
      expect(got[i]!.heading).toBe(`Round ${r.roundNo}`);
      expect(got[i]!.line, `round ${r.roundNo}`).toBe(`Sits out: ${NAMES[r.bye!]}`);
    });
    expect(new Set(got.map((g) => g.line)).size, "five different lines: a round's line is its own").toBe(5);
  });

  it("a withdrawn entrant is not named: her round has no line (differential: main named nobody; unfiltered, this would name her)", () => {
    const departedRound = ROUND_BYES.find((b) => b.entrant_id === "c")!.round_no;
    const html = render(lines(publicEn as unknown as Dict, { a: "registered", c: "withdrawn", d: "disqualified" }));
    const got = groups(html);
    const byRound = new Map(got.map((g) => [Number(/\d+/.exec(g.heading)![0]), g.line]));
    expect(byRound.get(departedRound), "Cy withdrew").toBeNull();
    const dRound = ROUND_BYES.find((b) => b.entrant_id === "d")!.round_no;
    expect(byRound.get(dRound), "Di was disqualified").toBeNull();
    expect(html).not.toMatch(/Sits out: (Cy|Di)/);
    expect(got.filter((g) => g.line !== null), "the three still in the field are still named").toHaveLength(3);
  });

  it("the line is in the org's words in all four locales, never a key", () => {
    let checked = 0;
    for (const loc of ["en", "es", "fr", "nl"]) {
      const out = lines(DICTS[loc]!);
      expect(Object.keys(out)).toHaveLength(5);
      for (const line of Object.values(out)) {
        expect(line, loc).not.toContain("division.sitsOut");
        expect(line, loc).toMatch(/Ana|Bo|Cy|Di|Eve/);
        if (loc !== "en") expect(line, `${loc} is translated`).not.toMatch(/^Sits out/);
        checked += 1;
      }
    }
    expect(checked).toBe(20);
  });
});
