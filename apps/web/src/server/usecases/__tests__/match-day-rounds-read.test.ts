// Match Day E2 item 7 — a match's round as the SCHEDULE BOARD names it, read through the REAL Match Day reads.
//
// The pure half (lib/match-day/__tests__/rounds.test.ts) proves `matchDayRounds` against `boardRoundCodes`. What only a database can
// show is the READ: that `getMatchDay` and `matchDayCandidates` hand it every fixture of each stage (a semi-final is told from the
// final only by ranking against the whole stage — and the final is not on today's board), in the READER's language, on the same
// columns the board's own read carries. The oracle is the board's own pipeline over the same rows: `listDivisionFixturesForBoard` +
// `listStages` + `boardRoundCodes`, never a table typed here; the design's words (QF / SF / F / 3rd, R{n} for a league) anchor it.
//
// Real Postgres required; skipped without DATABASE_URL (CI runs them).
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { boardRoundCodes } from "@/components/v2/board/round-codes";
import { msgFor } from "@/lib/messages-i18n";
import type { MessageKey } from "@/lib/messages";
import type { Locale } from "@/lib/i18n-constants";
import type { MatchDayFixture, MatchDayRound } from "@/lib/match-day/types";
import { MatchDayFixture as MatchDayFixtureSchema } from "@/server/api-v1/schemas";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { listDivisionFixturesForBoard } from "../fixtures";
import { getMatchDay, matchDayCandidates } from "../match-day";
import { previewCall } from "../match-day-call";
import { putScheduleSettings } from "../schedule";
import { createStages, generateStageFixtures, listStages } from "../stages";
import { GENERIC_CONFIG } from "./_seed";
import { between, place, seedDay, setStatus, type Day } from "./_match-day-seed";
import { createStagesWithLegacy } from "./_legacy-standalone-stage";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const msgIn = (locale: Locale) => (key: MessageKey, vars?: Record<string, string | number>) => msgFor(locale, key, vars);

/** The day's league plus a generated 8-entrant knockout (QF x4, SF x2, final, bronze) in the same competition. */
async function seedWithKnockout(day: Day) {
  const division = await createDivision(day.auth, day.comp.id, {
    name: "Knockout",
    slug: "knockout",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(
    day.auth,
    division.id,
    Array.from({ length: 8 }, (_, i) => ({ kind: "individual" as const, display_name: `Seed ${i + 1}`, seed: i + 1, members: [] })),
  );
  await putScheduleSettings(day.auth, division.id, {
    config: {
      startAt: "2026-11-01T00:00:00.000Z",
      matchMinutes: 30,
      gapMinutes: 0,
      courts: [day.courts.c1, day.courts.c2, day.courts.c3],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
  });
  const [stage] = await createStages(day.auth, division.id, { seq: 1, kind: "knockout", name: "Knockout", config: { thirdPlace: true } });
  await generateStageFixtures(day.auth, stage!.id);
  const rows = await sql<{ id: string; round_no: number; seq_in_round: number; is_final: boolean; third_place: boolean }[]>`
    select id, round_no, seq_in_round, is_final, third_place from fixtures where stage_id = ${stage!.id} order by round_no, seq_in_round`;
  const pick = (round_no: number, seq = 1) => rows.find((r) => r.round_no === round_no && r.seq_in_round === seq && !r.third_place)!.id;
  return {
    divisionId: division.id,
    qf: [1, 2, 3, 4].map((s) => pick(1, s)),
    sf: [pick(2, 1), pick(2, 2)],
    final: rows.find((r) => r.is_final)!.id,
    bronze: rows.find((r) => r.third_place)!.id,
    count: rows.length,
  };
}

/** Another division in the day's competition with ONE generated stage of `kind` over `n` seeded entrants (a Swiss stage is
 *  generated twice: the first call mints the round's shells, the second seats them - PR #803's split), returning its fixtures. */
async function seedStageDivision(day: Day, o: { slug: string; kind: "swiss" | "page_playoff"; n: number; config: Record<string, unknown> }) {
  const division = await createDivision(day.auth, day.comp.id, {
    name: o.slug,
    slug: o.slug,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(
    day.auth,
    division.id,
    Array.from({ length: o.n }, (_, i) => ({ kind: "individual" as const, display_name: `${o.slug} ${i + 1}`, seed: i + 1, members: [] })),
  );
  await putScheduleSettings(day.auth, division.id, {
    config: {
      startAt: "2026-11-01T00:00:00.000Z",
      matchMinutes: 30,
      gapMinutes: 0,
      courts: [day.courts.c1, day.courts.c2, day.courts.c3],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
  });
  const [stage] = await createStagesWithLegacy(day.auth, division.id, { seq: 1, kind: o.kind, name: o.slug, config: o.config, progression: null });
  await generateStageFixtures(day.auth, stage!.id);
  if (o.kind === "swiss") await generateStageFixtures(day.auth, stage!.id);
  const rows = await sql<{ id: string; round_no: number; seq_in_round: number; ext_key: string | null; is_final: boolean; home_entrant_id: string | null; away_entrant_id: string | null }[]>`
    select id, round_no, seq_in_round, ext_key, is_final, home_entrant_id, away_entrant_id
      from fixtures where stage_id = ${stage!.id} order by round_no, seq_in_round`;
  return { divisionId: division.id, stageId: stage!.id, rows };
}

/** What the board itself says each fixture of `divisionId` is: its code and name, else the board's own R{n} fallback. */
async function boardsRounds(day: Day, divisionId: string, locale: Locale): Promise<Map<string, MatchDayRound>> {
  const msg = msgIn(locale);
  const [fixtures, stages] = await Promise.all([listDivisionFixturesForBoard(day.auth, divisionId), listStages(day.auth, divisionId)]);
  const codes = boardRoundCodes(fixtures, stages, msg);
  return new Map(
    fixtures.map((f) => {
      const rc = codes.get(f.id);
      return [f.id, rc ? { code: rc.code, label: rc.label, coded: true } : { code: `R${f.round_no}`, label: msg("schedule.round", { n: f.round_no }), coded: false }];
    }),
  );
}

const shownOf = (view: Awaited<ReturnType<typeof getMatchDay>>): MatchDayFixture[] => [
  ...view.courts.flatMap((c) => [...(c.current ? [c.current] : []), ...c.queue]),
  ...view.playing_no_court,
];

describe.skipIf(!HAS_DB)("Match Day E2-7 — round codes on the real reads", () => {
  it("every match on today's board carries the board's own round — a league's R{n} and a knockout's QF / SF / F / 3rd — in the reader's language", async () => {
    const day = await seedDay();
    const ko = await seedWithKnockout(day);
    const { p1, p2, p3, p4 } = (() => {
      const [a, b, c, d] = day.comp.pairs;
      return { p1: a!, p2: b!, p3: c!, p4: d! };
    })();
    const leagueA = between(day.comp, p1, p2).id;
    const leagueB = between(day.comp, p3, p4).id;
    // Today: two league matches and the knockout's quarter-final, a semi-final and the bronze match. The FINAL is not on today's
    // board (planned tomorrow), so a semi-final can be told from it only by ranking against the whole stage.
    await place(day, leagueA, 60, day.courts.c1);
    await place(day, leagueB, 90, day.courts.c1);
    await place(day, ko.qf[0]!, 60, day.courts.c2);
    await place(day, ko.sf[0]!, 120, day.courts.c2);
    await place(day, ko.bronze, 150, day.courts.c3);
    await place(day, ko.final, 24 * 60 + 60, day.courts.c3);

    let checked = 0;
    for (const locale of ["en", "fr"] as Locale[]) {
      const view = await getMatchDay(day.auth, day.comp.id, new Date(Date.parse("2026-11-07T10:00:00.000Z")), { locale });
      const [league, knockout] = await Promise.all([boardsRounds(day, day.comp.divisionId, locale), boardsRounds(day, ko.divisionId, locale)]);
      const board = new Map([...league, ...knockout]);
      const shown = shownOf(view);
      expect(shown.length, `${locale}: five matches are on today's board`).toBe(5);
      for (const f of shown) {
        expect(f.round, `${locale} ${f.id}`).toEqual(board.get(f.id));
        // The wire's own schema accepts it.
        expect(MatchDayFixtureSchema.shape.round.safeParse(f.round).success, `${locale} ${f.id}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(10);

    // The design's words, not read back from the board: the semi-final is SF although the final is not on the page, the bronze match
    // is 3rd (not F), a quarter-final QF, and a league match keeps its plain R{n}.
    const en = await getMatchDay(day.auth, day.comp.id, new Date(Date.parse("2026-11-07T10:00:00.000Z")), { locale: "en" });
    const byId = new Map(shownOf(en).map((f) => [f.id, f.round]));
    expect(byId.get(ko.sf[0]!)).toEqual({ code: "SF", label: "Semi-finals", coded: true });
    expect(byId.get(ko.bronze)).toEqual({ code: "3rd", label: "Third place", coded: true });
    expect(byId.get(ko.qf[0]!)).toEqual({ code: "QF", label: "Quarter-finals", coded: true });
    const [r] = await sql<{ round_no: number }[]>`select round_no from fixtures where id = ${leagueA}`;
    expect(byId.get(leagueA)).toEqual({ code: `R${r!.round_no}`, label: `Round ${r!.round_no}`, coded: false });

    // The reader's language: the same semi-final reads differently in French, and what French says is the board's own.
    const fr = await getMatchDay(day.auth, day.comp.id, new Date(Date.parse("2026-11-07T10:00:00.000Z")), { locale: "fr" });
    const frSf = shownOf(fr).find((f) => f.id === ko.sf[0]!)!.round;
    expect(frSf.label).not.toBe("Semi-finals");
    expect(frSf.label).toBe(msgFor("fr", "bracket.round.semi"));
  });

  it("a match in play is named too, and the round does not change as its stage's other matches finish (the sequence)", async () => {
    const day = await seedDay();
    const ko = await seedWithKnockout(day);
    await place(day, ko.sf[0]!, 60, day.courts.c1);
    await setStatus(ko.sf[0]!, "in_play");
    const now = new Date(Date.parse("2026-11-07T10:30:00.000Z"));
    const before = shownOf(await getMatchDay(day.auth, day.comp.id, now)).find((f) => f.id === ko.sf[0]!)!;
    expect(before.round).toEqual({ code: "SF", label: "Semi-finals", coded: true });
    // The quarter-finals finish and the final is cancelled: the stage's other rows change, the semi-final is still a semi-final.
    await sql`update fixtures set status = 'decided' where id = any(${ko.qf})`;
    await sql`update fixtures set status = 'cancelled' where id = ${ko.final}`;
    const after = shownOf(await getMatchDay(day.auth, day.comp.id, now)).find((f) => f.id === ko.sf[0]!)!;
    expect(after.round).toEqual(before.round);

    // A match in play on NO court is on the board too ("Playing, no court"), and is named the same way.
    await setStatus(ko.sf[1]!, "in_play");
    const noCourt = await getMatchDay(day.auth, day.comp.id, now);
    expect(noCourt.playing_no_court.map((f) => f.id)).toEqual([ko.sf[1]!]);
    expect(noCourt.playing_no_court[0]!.round).toEqual({ code: "SF", label: "Semi-finals", coded: true });
  });

  it("the free court's candidates carry the board's round too, in the reader's language", async () => {
    const day = await seedDay();
    const ko = await seedWithKnockout(day);
    // Both semi-finals wait on Courts 1 and 3; Court 2 is free and can call either (the other courts' next matches).
    await place(day, ko.sf[0]!, 60, day.courts.c1);
    await place(day, ko.sf[1]!, 60, day.courts.c3);
    await sql`update fixtures set home_entrant_id = e1.id, away_entrant_id = e2.id
                from (select id from entrants where division_id = ${ko.divisionId} order by seed limit 1) e1,
                     (select id from entrants where division_id = ${ko.divisionId} order by seed offset 1 limit 1) e2
               where fixtures.id = any(${ko.sf})`;
    const now = new Date(Date.parse("2026-11-07T10:00:00.000Z"));
    let checked = 0;
    for (const locale of ["en", "nl"] as Locale[]) {
      const board = await boardsRounds(day, ko.divisionId, locale);
      const list = await matchDayCandidates(day.auth, day.comp.id, day.courts.c2, now, { locale });
      const ours = list.filter((c) => ko.sf.includes(c.fixture.id));
      expect(ours.length, `${locale}: both semi-finals are candidates for the free court`).toBe(2);
      for (const c of ours) {
        expect(c.fixture.round, `${locale} ${c.fixture.id}`).toEqual(board.get(c.fixture.id));
        // The design's word for English; Dutch says it its own way ("HF"), and the board's own code is what the line above pinned.
        if (locale === "en") expect(c.fixture.round.code).toBe("SF");
        checked++;
      }
    }
    expect(checked).toBe(4);
    const nl = await matchDayCandidates(day.auth, day.comp.id, day.courts.c2, now, { locale: "nl" });
    const en = await matchDayCandidates(day.auth, day.comp.id, day.courts.c2, now);
    expect(nl.find((c) => c.fixture.id === ko.sf[0]!)!.fixture.round.label).not.toBe(en.find((c) => c.fixture.id === ko.sf[0]!)!.fixture.round.label);
  });

  it("the call preview's pushed matches carry the board's round too, in the reader's language", async () => {
    const day = await seedDay();
    const ko = await seedWithKnockout(day);
    const [p1, p2] = day.comp.pairs;
    const called = between(day.comp, p1!, p2!).id;
    // Court 1 holds the cup's two semi-finals and a league match at +45, +60 and +75; calling Ann & Bob's match there at +31 (30
    // minutes) pushes all three past their plan. The cup's FINAL is on no court at all: the semi-finals are still semi-finals.
    const [p3, p4] = [day.comp.pairs[2]!, day.comp.pairs[3]!];
    const league = between(day.comp, p3, p4).id;
    await place(day, ko.sf[0]!, 45, day.courts.c1);
    await place(day, ko.sf[1]!, 60, day.courts.c1);
    await place(day, league, 75, day.courts.c1);
    const now = new Date(Date.parse("2026-11-07T10:31:00.000Z"));
    let checked = 0;
    for (const locale of ["en", "fr"] as Locale[]) {
      const board = new Map([...(await boardsRounds(day, ko.divisionId, locale)), ...(await boardsRounds(day, day.comp.divisionId, locale))]);
      const out = await previewCall(day.auth, called, day.courts.c1, now, { locale });
      expect(out.shifts.map((s) => s.fixture_id), `${locale}: all three pushed, in planned order`).toEqual([ko.sf[0]!, ko.sf[1]!, league]);
      for (const shift of out.shifts) {
        expect(shift.round, `${locale} ${shift.fixture_id}`).toEqual(board.get(shift.fixture_id));
        checked++;
      }
    }
    expect(checked).toBe(6);
    const en = await previewCall(day.auth, called, day.courts.c1, now);
    expect(en.shifts[0]!.round).toEqual({ code: "SF", label: "Semi-finals", coded: true });
    const fr = await previewCall(day.auth, called, day.courts.c1, now, { locale: "fr" });
    expect(fr.shifts[0]!.round.label).toBe(msgFor("fr", "bracket.round.semi"));
    expect(fr.shifts[0]!.round.label).not.toBe(en.shifts[0]!.round.label);
    // The empty case: a call that pushes nothing names nobody.
    await place(day, ko.sf[0]!, 600, day.courts.c1);
    await place(day, ko.sf[1]!, 660, day.courts.c1);
    await place(day, league, 720, day.courts.c1);
    expect((await previewCall(day.auth, called, day.courts.c1, now)).shifts).toEqual([]);
  });

  it("m7 — a SWISS stage keeps the plain R{n} on the real read (a coded bracket role would be wrong for it), and says so in the reader's language", async () => {
    const day = await seedDay();
    const swiss = await seedStageDivision(day, { slug: "swiss", kind: "swiss", n: 4, config: { rounds: 2 } });
    const seated = swiss.rows.filter((r) => r.home_entrant_id !== null && r.away_entrant_id !== null);
    expect(seated.length, "premise: the round's two pairings are seated").toBe(2);
    await place(day, seated[0]!.id, 60, day.courts.c1);
    await place(day, seated[1]!.id, 60, day.courts.c2);
    let checked = 0;
    for (const locale of ["en", "fr"] as Locale[]) {
      const view = await getMatchDay(day.auth, day.comp.id, new Date(Date.parse("2026-11-07T10:00:00.000Z")), { locale });
      const board = await boardsRounds(day, swiss.divisionId, locale);
      const shown = shownOf(view).filter((f) => seated.some((r) => r.id === f.id));
      expect(shown.length, `${locale}: both Swiss matches are on the board`).toBe(2);
      for (const f of shown) {
        expect(f.round, `${locale} ${f.id}`).toEqual(board.get(f.id));
        // The design's words: a Swiss round is "R{n}", uncoded - never QF / SF / F.
        expect(f.round.coded, `${locale} ${f.id}`).toBe(false);
        expect(f.round.code, `${locale} ${f.id}`).toBe(`R${seated[0]!.round_no}`);
        expect(f.round.label, `${locale} ${f.id}`).toBe(msgFor(locale, "schedule.round", { n: seated[0]!.round_no }));
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("m7 — a PAGE PLAYOFF is named Q1 / E by the fixtures' ext_key, which the real read must carry (without it Q1 and the Eliminator read as quarter-finals)", async () => {
    const day = await seedDay();
    const pp = await seedStageDivision(day, { slug: "playoff", kind: "page_playoff", n: 4, config: {} });
    const byKey = new Map(pp.rows.map((r) => [r.ext_key, r]));
    expect([...byKey.keys()].sort(), "premise: the stage carries the page playoff's own keys").toEqual(["pp-elim", "pp-final", "pp-q1", "pp-q2"]);
    const q1 = byKey.get("pp-q1")!;
    const elim = byKey.get("pp-elim")!;
    expect(q1.home_entrant_id && q1.away_entrant_id && elim.home_entrant_id && elim.away_entrant_id, "premise: both opening matches are seated").toBeTruthy();
    await place(day, q1.id, 60, day.courts.c1);
    await place(day, elim.id, 60, day.courts.c2);
    let checked = 0;
    for (const locale of ["en", "nl"] as Locale[]) {
      const view = await getMatchDay(day.auth, day.comp.id, new Date(Date.parse("2026-11-07T10:00:00.000Z")), { locale });
      const board = await boardsRounds(day, pp.divisionId, locale);
      const shown = new Map(shownOf(view).map((f) => [f.id, f.round]));
      expect([...shown.keys()].sort(), `${locale}: the two opening matches are on the board`).toEqual([q1.id, elim.id].sort());
      for (const r of [q1, elim]) {
        expect(shown.get(r.id), `${locale} ${r.ext_key}`).toEqual(board.get(r.id));
        checked++;
      }
      // The design's words, not read back from the board: Qualifier 1 and the Eliminator, which share a round and every flag.
      expect(shown.get(q1.id)!.code, locale).toBe(msgFor(locale, "bracket.roundShort.qualifier1"));
      expect(shown.get(elim.id)!.code, locale).toBe(msgFor(locale, "bracket.roundShort.eliminator"));
      expect(shown.get(q1.id)!.code, `${locale}: two different codes for two matches of one round`).not.toBe(shown.get(elim.id)!.code);
    }
    expect(checked).toBe(4);
    const en = await getMatchDay(day.auth, day.comp.id, new Date(Date.parse("2026-11-07T10:00:00.000Z")), { locale: "en" });
    expect(shownOf(en).find((f) => f.id === q1.id)!.round).toEqual({ code: "Q1", label: "Qualifier 1", coded: true });
    expect(shownOf(en).find((f) => f.id === elim.id)!.round).toEqual({ code: "E", label: "Eliminator", coded: true });
  });

  it("m7 — the FINAL itself, on today's board and read for real, is F (and the bronze match beside it 3rd): both told apart by their flags, not by a tomorrow that hides them", async () => {
    const day = await seedDay();
    const ko = await seedWithKnockout(day);
    // The final and the bronze match are seated (their feeders are not played here) and planned today on two courts.
    await sql`update fixtures set home_entrant_id = e1.id, away_entrant_id = e2.id
                from (select id from entrants where division_id = ${ko.divisionId} order by seed limit 1) e1,
                     (select id from entrants where division_id = ${ko.divisionId} order by seed offset 1 limit 1) e2
               where fixtures.id = any(${[ko.final, ko.bronze]})`;
    await place(day, ko.final, 60, day.courts.c1);
    await place(day, ko.bronze, 60, day.courts.c2);
    let checked = 0;
    for (const locale of ["en", "fr"] as Locale[]) {
      const view = await getMatchDay(day.auth, day.comp.id, new Date(Date.parse("2026-11-07T10:00:00.000Z")), { locale });
      const board = await boardsRounds(day, ko.divisionId, locale);
      const shown = new Map(shownOf(view).map((f) => [f.id, f.round]));
      expect([...shown.keys()].sort(), `${locale}: exactly the final and the bronze match are on the board`).toEqual([ko.final, ko.bronze].sort());
      for (const id of [ko.final, ko.bronze]) {
        expect(shown.get(id), `${locale} ${id}`).toEqual(board.get(id));
        checked++;
      }
      expect(shown.get(ko.final)!.label, locale).toBe(msgFor(locale, "bracket.round.final"));
      expect(shown.get(ko.bronze)!.label, locale).toBe(msgFor(locale, "bracket.round.thirdPlace"));
    }
    expect(checked).toBe(4);
    const en = await getMatchDay(day.auth, day.comp.id, new Date(Date.parse("2026-11-07T10:00:00.000Z")), { locale: "en" });
    const rounds = new Map(shownOf(en).map((f) => [f.id, f.round]));
    expect(rounds.get(ko.final)).toEqual({ code: "F", label: "Final", coded: true });
    expect(rounds.get(ko.bronze)).toEqual({ code: "3rd", label: "Third place", coded: true });
  });

  it("an empty board names nobody (the empty case)", async () => {
    const day = await seedDay();
    const view = await getMatchDay(day.auth, day.comp.id, new Date(Date.parse("2026-11-07T10:00:00.000Z")));
    expect(shownOf(view)).toEqual([]);
  });
});
