// W4 app-A Task 3 (gap K2; engine row X-SD-5 "never a fixture on a court"): a bracket bye line never takes or keeps a
// court. A `timing: "setup"` progression draws its bracket before anyone qualifies, so its bye line sits `scheduled`
// with no outcome and the bye slot label on its phantom side until the seed confirm awards it (`awardSeededByes`). To
// every placement writer it looked like one more movable match: the auto pass placed it, the board let a drag drop it on
// a court, and the award flipped it to `forfeited` WITH the slot (`forfeited` occupies — schedule/board.ts `OCCUPYING`), so a
// court was held all day by a match nobody plays. A plain bracket's SYSTEM bye (baked `forfeited` at generation) took a
// quick Start's rolling time the same way. A bye is not played; it takes no court and no time (W3 spec §4, X-SW-29).
//
// "Holds a slot" is ONE predicate (`holdsSlot`, lib/rebuild-slots.ts — time, court, venue or pin), read by every
// assertion here rather than a column of its own choosing.
//
// single-sport: badminton — every predicate under test reads seats, status, outcome, slot labels, ext_key and the slot
// columns; no sport field.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dayKeyInTz } from "@seazn/engine/scheduling/tz";
import { sql } from "@/lib/db";
import { buildTemplateStages } from "@/lib/format-templates";
import { holdsSlot } from "@/lib/rebuild-slots";
import { BYE_SLOT_LABEL, isByeLine } from "@/lib/bye-line";
import { feedLabels, type FeedLabelPair } from "@/lib/schedule-board";
import { resolveSlotLabel, type SlotLabel } from "@/lib/slot-label";
import { messages } from "@/lib/messages";
import { BYE_LINE_SHAPES, rowOf as shapeRow } from "@/lib/__tests__/bye-line-shapes";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateStage } from "@/server/api-v1/schemas";
import { appendEvent } from "@/server/engine-db";
import { byeLineSql } from "@/server/engine-db/system-bye-sql";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { fixtureRow, playBadminton, post, rowsOf as bracketRows } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { playedFixtureIds } from "../fixture-results-sql";
import { redoDivision, undoDivision } from "../history";
import { applySchedule, autoSchedule, isMovable, movableFixtureSql, moveFixture, putScheduleSettings, startDivision } from "../schedule";
import { completeStage, confirmSeedProposal, createStages, generateStageFixtures } from "../stages";
import { getCompetitionDesk } from "../competition-desk";
import { listDivisionFixtures, listDivisionFixturesForBoard } from "../fixtures";
import { buildRunSheet, isBye, roundDone, type RunSheetBlock, type RunSheetFixture } from "@/lib/run-sheet-groups";
import { isUnscheduledFixture } from "@/lib/division-phase";
import { RunSheet, runSheetCounts, runSheetKeeps } from "@/components/v2/desk/run-sheet";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import { listDivisionCardStats } from "../card-stats";
import { RunSheetRow } from "@/components/v2/desk/run-sheet-row";
import type { FixtureRow } from "../stages";
import { boardMovable, inBoardTray } from "@/components/v2/board/types";
import { computeDisruptions } from "@/components/v2/board/use-disruption-signals";
import { createCourt, createVenue } from "../venues";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

// `RunSheetRow` (rendered below from the division page's own rows) reaches for `useRouter`; nothing here clicks it.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));

/** The division page's read adapted for the run sheet exactly as stages-panel.tsx's `toRunSheetFixture` does. */
const toSheetRow = (f: FixtureRow): RunSheetFixture => ({
  ...f,
  home_slot_label: f.home_slot_label ?? null,
  away_slot_label: f.away_slot_label ?? null,
  venue_name: f.venue_name ?? null,
  officials: f.officials ?? [],
});
const sheetRowsOf = (blocks: readonly RunSheetBlock[]): RunSheetFixture[] =>
  blocks.flatMap((b) => (b.kind === "bracket" ? b.rounds.flatMap((r) => r.fixtures) : b.fixtures));
/** The feed edges the Fixtures tab passes every row (`feedLabels(fixtures.map(toFeedRow))`, stages-panel.tsx), from the
 *  same division rows — the adapter copied as that module-private `toFeedRow` writes it. */
const feedOf = (rows: readonly FixtureRow[]): Record<string, FeedLabelPair> =>
  feedLabels(
    rows.map((f) => ({
      id: f.id,
      round_no: f.round_no,
      seq_in_round: f.seq_in_round,
      winner_to_fixture: f.winner_to_fixture ?? null,
      winner_to_slot: f.winner_to_slot ?? null,
      loser_to_fixture: f.loser_to_fixture ?? null,
      loser_to_slot: f.loser_to_slot ?? null,
    })),
  );
/** The English catalogue, as the row reads it outside a DictProvider. */
const en = (key: string, vars?: Record<string, string | number>): string =>
  ((messages as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_m, k: string) => String(vars?.[k] ?? `{${k}}`));
/** "{name} has a bye", the sitter named by a slot label (the shared label renderer, never the row's own side choice). */
const byeSentenceFor = (label: SlotLabel) => en("schedule.bye", { name: resolveSlotLabel(label, en as never, "schedule.tbd") });
/** The two answers a wrong side choice or a missing feed would print — the expected sentence must differ from both. */
const WRONG_BYE_SENTENCES = [en("schedule.bye", { name: en("bracket.slot.bye") }), en("schedule.bye", { name: en("schedule.tbd") })];
/** The run sheet's row, as the Fixtures tab renders it: the one action it offers, and whether it is the bye row. */
function sheetRow(f: RunSheetFixture, names: Record<string, string>, nowMs: number, feed?: Record<string, FeedLabelPair>) {
  const html = renderToStaticMarkup(
    createElement(RunSheetRow, { fixture: f, href: "/f/1", tz: "UTC", orgTz: "UTC", nowMs, canEdit: true, entrantNames: names, feedLabels: feed }),
  );
  return { html, bye: html.includes('data-testid="run-sheet-bye"'), action: /data-row-action="([a-z_]+)"/.exec(html)?.[1] ?? null };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

interface Row {
  id: string;
  ext_key: string | null;
  round_no: number;
  seq_in_round: number;
  status: string;
  outcome: unknown;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_slot_label: unknown;
  away_slot_label: unknown;
  scheduled_at: Date | null;
  court_id: string | null;
  venue_id: string | null;
  schedule_locked: boolean;
}

const rowsOf = (stageId: string) =>
  sql<Row[]>`
    select id, ext_key, round_no, seq_in_round, status, outcome, home_entrant_id, away_entrant_id,
           home_slot_label, away_slot_label, scheduled_at, court_id, venue_id, schedule_locked
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;

const rowOf = async (stageId: string, id: string) => (await rowsOf(stageId)).find((r) => r.id === id)!;

/** Every slot field, as one value — compared whole, so a half-cleared row (court gone, pin kept) cannot pass. */
const slot = (r: Row) => ({ at: r.scheduled_at?.toISOString() ?? null, court: r.court_id, venue: r.venue_id, pin: r.schedule_locked });
const NONE = { at: null, court: null, venue: null, pin: false };

/** The bye slot label, read off the row the way `awardSeededByes` reads it: the stored marker of a bye's phantom side. */
const byeLabelled = (r: Row) =>
  [r.home_slot_label, r.away_slot_label].some((l) => (l as { key?: unknown } | null)?.key === "bracket.slot.bye");

const SETTINGS = (courts: string[], extra: { roundMinutes?: number } = {}) => ({
  config: {
    startAt: "2030-08-01T09:00:00.000Z",
    matchMinutes: 30,
    gapMinutes: 0,
    courts,
    perEntrantMinRest: 0,
    blackouts: [],
    sessionWindows: [],
    ...extra,
  },
  tz: "UTC",
});

async function orgDivision(label: string) {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `${label} ${randomUUID().slice(0, 6)}`,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open singles",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "badminton",
    variant_key: "bwf",
    config: {},
  });
  const venue = await createVenue(auth, { name: "Hall", sort: 0 });
  const c1 = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
  const c2 = await createCourt(auth, venue.id, { name: "Court 2", sort: 1, tags: [] });
  return { auth, competitionId: comp.id, divisionId: division.id, venueId: venue.id, courts: [c1.id, c2.id] };
}

interface LeagueKo {
  auth: AuthCtx;
  competitionId: string;
  divisionId: string;
  venueId: string;
  courts: string[];
  leagueStageId: string;
  koStageId: string;
  nameOf: Map<string, string>;
  /** The day-one bracket's bye line: `scheduled`, no outcome, no seats, the bye label on its phantom side. */
  byeLineId: string;
}

/** `league_ko` Top 3 from the REAL catalogue draft: a league of four, then a bracket of 4 whose seed 1 has a bye. The
 *  league is started (quick-start generates it), the bracket drawn day-one (every seat TBD), and the schedule saved. */
async function leagueKo(): Promise<LeagueKo> {
  const o = await orgDivision("League KO");
  const entrants = await createEntrants(
    o.auth,
    o.divisionId,
    Array.from({ length: 4 }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })),
  );
  const drafts = buildTemplateStages("league_ko", { swissRounds: 5, poolCount: 2, legs: 1, qualified: 3 });
  expect(drafts.map((d) => d.kind), "rig: league_ko is a league then a knockout").toEqual(["league", "knockout"]);
  const ids: string[] = [];
  for (const [i, d] of drafts.entries()) {
    const [stage] = await createStages(
      o.auth,
      o.divisionId,
      CreateStage.parse({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression }),
    );
    ids.push(stage!.id);
  }
  await startDivision(o.auth, o.divisionId);
  await putScheduleSettings(o.auth, o.divisionId, SETTINGS(o.courts));
  await generateStageFixtures(o.auth, ids[1]!); // the day-one bracket
  const bracket = await rowsOf(ids[1]!);
  const byes = bracket.filter(byeLabelled);
  expect(bracket.length, "rig: a Top-3 bracket of 4 is two first-round lines and a final").toBe(3);
  expect(byes.length, "rig: one first-round line is the bye").toBe(1);
  expect(
    [byes[0]!.status, byes[0]!.outcome, byes[0]!.home_entrant_id, byes[0]!.away_entrant_id],
    "premise: the bye line is pre-award — scheduled, no outcome, no seats",
  ).toEqual(["scheduled", null, null, null]);
  return {
    ...o,
    leagueStageId: ids[0]!,
    koStageId: ids[1]!,
    nameOf: new Map(entrants.map((e) => [e.id, e.display_name])),
    byeLineId: byes[0]!.id,
  };
}

/** The auto pass, proposed and applied as the board's Auto-schedule button does. */
async function autoPlace(auth: AuthCtx, stageId: string) {
  const build = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
  await applySchedule(auth, stageId, {
    assignments: build.assignments.map((a) => ({ fixture_id: a.fixture_id, scheduled_at: a.scheduled_at, court_id: a.court_id })),
    source: "auto",
  });
  return build;
}

/** Play the league out — the lower-numbered entrant always wins 2-0, so the table is E1 > E2 > E3 > E4 on points
 *  alone — then complete it and confirm the bracket's seeding. E1 takes the bye. */
async function seedTheBracket(rig: LeagueKo): Promise<void> {
  for (const f of await rowsOf(rig.leagueStageId)) {
    const home = rig.nameOf.get(f.home_entrant_id!)!;
    const away = rig.nameOf.get(f.away_entrant_id!)!;
    const homeWins = Number(home.slice(1)) < Number(away.slice(1));
    await appendEvent(rig.auth.orgId, f.id, 0, { type: "core.start", payload: {}, recordedBy: null });
    for (const game of [1, 2]) {
      await appendEvent(rig.auth.orgId, f.id, game, {
        type: "badminton.game.summary",
        payload: homeWins ? { home: 21, away: 10 } : { home: 10, away: 21 },
        recordedBy: null,
      });
    }
  }
  const done = await completeStage(rig.auth, rig.leagueStageId);
  expect(done.completed, "the league completed").toBe(true);
  expect(done.seed_proposal, "a seed proposal for the bracket").toBeTruthy();
  await confirmSeedProposal(rig.auth, rig.koStageId, { proposalId: done.seed_proposal!.id });
  const bye = await rowOf(rig.koStageId, rig.byeLineId);
  expect(
    [bye.status, (bye.outcome as { kind?: string; reason?: string } | null)?.reason, rig.nameOf.get(bye.home_entrant_id ?? bye.away_entrant_id ?? "")],
    "premise: the confirm awarded the bye to the league winner",
  ).toEqual(["forfeited", "bye", "E1"]);
}

describe.runIf(HAS_DB)("W4 T3 K2 a bracket bye line never takes or keeps a court", () => {
  it("X-SD-5 a knockout bye line placed before seeding keeps no court after the award", async () => {
    const rig = await leagueKo();
    await autoPlace(rig.auth, rig.leagueStageId);
    await autoPlace(rig.auth, rig.koStageId);
    const placed = await rowsOf(rig.koStageId);
    const real = placed.filter((r) => r.id !== rig.byeLineId);
    // K2's first half: the auto pass treated the bye line as one more movable match.
    expect(slot(placed.find((r) => r.id === rig.byeLineId)!), "the auto pass gives a bye line no court and no time").toEqual(NONE);
    expect(real.filter(holdsSlot).length, "positive pair: the pass placed the real first-round line and the final").toBe(2);
    const realBefore = new Map(real.map((r) => [r.id, slot(r)]));

    await seedTheBracket(rig);
    // K2's second half: the award flips the line to `forfeited`, and a forfeited line occupies.
    const after = await rowsOf(rig.koStageId);
    expect(slot(after.find((r) => r.id === rig.byeLineId)!), "the awarded bye holds no slot").toEqual(NONE);
    for (const r of after.filter((x) => x.id !== rig.byeLineId)) {
      expect(slot(r), "positive pair: a real line keeps its slot across the confirm").toEqual(realBefore.get(r.id));
    }
  }, 180_000);

  it("X-SD-5 the board and the desk read a pre-award bye line as the server does: not movable, not in the tray, owed nothing (B1a review #1)", async () => {
    // The server refuses to place a bye line (BYE_LINE_NOT_PLACEABLE), so every screen must agree: the board offers no
    // drag and no tray card, and the desk counts no unscheduled match that no action could ever clear. Read through the
    // REAL producers (`listDivisionFixturesForBoard`, `getCompetitionDesk`) into the board's own predicates.
    const rig = await leagueKo();
    const at = new Date("2030-07-01T10:00:00Z");
    const owed = async () => {
      const d = (await getCompetitionDesk(rig.auth, rig.competitionId, at)).divisions.get(rig.divisionId)!;
      return { field: d.unscheduled, attention: d.attention.find((a) => a.kind === "unscheduled") ?? null };
    };
    await autoPlace(rig.auth, rig.leagueStageId);
    // Positive pair: the bracket's two real lines are owed a slot; the bye line is not.
    expect(await owed(), "before the bracket is placed: its two real lines are owed, the bye line is not").toEqual({
      field: 2,
      attention: { kind: "unscheduled", count: 2 },
    });
    await autoPlace(rig.auth, rig.koStageId);
    expect(slot(await rowOf(rig.koStageId, rig.byeLineId)), "premise: the bye line is still untimed").toEqual(NONE);
    expect(await owed(), "every real line placed: nothing is owed").toEqual({ field: 0, attention: null });
    // Owner-approved quirk (B1a shots): the desk's "N of M played" total counts what its unscheduled count counts — the
    // waiting bye line is no fixture to either. Expected = every non-cancelled line of the division but the rig's bye.
    const division = await listDivisionFixtures(rig.auth, rig.divisionId);
    expect(division.some((f) => f.id === rig.byeLineId), "premise: the division read holds the bye line").toBe(true);
    const desk = (await getCompetitionDesk(rig.auth, rig.competitionId, at)).divisions.get(rig.divisionId)!;
    const lines = division.filter((f) => f.status !== "cancelled" && f.id !== rig.byeLineId).length;
    expect(lines, "anti-vacuity: the league's six and the bracket's two real lines").toBe(8);
    expect([desk.played, desk.total], "the desk's played total leaves the waiting bye line out, as its unscheduled count does").toEqual([0, lines]);

    const board = (await listDivisionFixturesForBoard(rig.auth, rig.divisionId)).filter((f) => f.stage_id === rig.koStageId);
    const bye = board.find((f) => f.id === rig.byeLineId)!;
    expect(bye.bye_line, "the board read marks the bye line").toBe(true);
    expect([boardMovable(bye), inBoardTray(bye)], "the board neither moves it nor trays it").toEqual([false, false]);
    const real = board.filter((f) => f.id !== rig.byeLineId);
    expect(real.length, "anti-vacuity: the real first-round line and the final").toBe(2);
    for (const f of real) {
      expect(Object.prototype.hasOwnProperty.call(f, "bye_line"), `${f.id}: the flag is sent only when true`).toBe(false);
      expect(boardMovable(f), "positive pair: a real line stays movable").toBe(true);
    }
  }, 180_000);

  it("X-SD-5 the division Fixtures tab reads a pre-award bye line as the server does: nothing to schedule, no Unscheduled count, no Set time (B1a review N1)", async () => {
    // The run sheet's "is this a bye" (`isBye`, lib/run-sheet-groups.ts) feeds the stage rail's "N to schedule"
    // badge, the Unscheduled chip and the row's action. A bye line the server will never place must reach none of them:
    // a count no action clears, and a Set time that can only answer BYE_LINE_NOT_PLACEABLE. Fed the division page's own
    // rows (`listDivisionFixtures`, adapted as `toRunSheetFixture` does) into the real builder, counts and row.
    const rig = await leagueKo();
    await autoPlace(rig.auth, rig.leagueStageId);
    const nowMs = Date.parse("2030-07-01T10:00:00Z");
    const wire = await listDivisionFixtures(rig.auth, rig.divisionId);
    const rows = wire.map(toSheetRow);
    const ko = rows.filter((f) => f.stage_id === rig.koStageId);
    const bye = ko.find((f) => f.id === rig.byeLineId)!;
    const real = ko.filter((f) => f.id !== rig.byeLineId);
    expect(real.length, "anti-vacuity: the real first-round line and the final").toBe(2);
    expect([bye.status, bye.scheduled_at, bye.outcome], "premise: the bye line is pre-award and untimed").toEqual(["scheduled", null, null]);
    expect(real.every((f) => f.status === "scheduled" && f.scheduled_at === null), "premise: the real lines are untimed too").toBe(true);

    expect(isBye(bye), "the run sheet reads the bye line as a bye").toBe(true);
    expect(real.map(isBye), "positive pair: a real untimed line is no bye").toEqual([false, false]);

    // The stage rail's "N to schedule" badge: stages-panel.tsx's own expression over the stage's rows.
    const toSchedule = ko.filter((f) => isUnscheduledFixture({ status: f.status, scheduledAt: f.scheduled_at }) && !isBye(f));
    expect(toSchedule.map((f) => f.id).sort(), "the knockout's badge counts the two real lines, not the bye").toEqual(real.map((f) => f.id).sort());

    const blocks = buildRunSheet({
      fixtures: rows,
      stages: [
        { id: rig.leagueStageId, seq: 1, kind: "league" },
        { id: rig.koStageId, seq: 2, kind: "knockout" },
      ],
      tz: "UTC",
      nowMs,
    });
    expect(sheetRowsOf(blocks).some((f) => f.id === rig.byeLineId), "the bye stays on the sheet, a ghost row in its round (R7b)").toBe(true);
    // B1b fix round 1 (Q1, supersedes the B1a quirk): the round bar counts a waiting line only when the server says its award
    // will be a walkover (`awaits_walkover`). A day-one setup bye has no feeder at all - the confirm awards it as a bye - so
    // it is no match: the bye's round counts the real line beside it alone.
    expect(bye.awaits_walkover, "the server's flag: a day-one bye awaits no walkover").toBe(false);
    expect(real.map((f) => f.awaits_walkover), "positive pair: nor does a real line").toEqual([false, false]);
    const koBlock = blocks.find((x) => x.kind === "bracket" && x.stageId === rig.koStageId);
    const byeRound = koBlock && koBlock.kind === "bracket" ? koBlock.rounds.find((r) => r.fixtures.some((f) => f.id === rig.byeLineId)) : undefined;
    const byeRoundNo = bye.round_no;
    expect(ko.filter((f) => f.round_no === byeRoundNo).length, "anti-vacuity: the bye shares its round with a real line").toBe(2);
    expect(roundDone(byeRound?.fixtures ?? [], new Set()), "day one: 0 of 1, the waiting bye no match").toEqual({ done: 0, total: 1 });
    const ctx = { stageId: rig.koStageId, nowMs, matchMinutes: 30 };
    expect(runSheetCounts(blocks, ctx).unscheduled, "the Unscheduled chip counts the two real lines only").toBe(2);
    const keep = { ...ctx, tz: "UTC", today: dayKeyInTz(nowMs, "UTC") };
    expect(runSheetKeeps(bye, "unscheduled", keep), "the Unscheduled filter does not list the bye").toBe(false);
    expect(real.every((f) => runSheetKeeps(f, "unscheduled", keep)), "positive pair: it lists every real line").toBe(true);

    const names = Object.fromEntries(rig.nameOf);
    const byeRow = sheetRow(bye, names, nowMs, feedOf(wire));
    expect([byeRow.bye, byeRow.action], "the bye's row is the bye row, offering nothing — no Set time").toEqual([true, null]);
    // The sitter by name: the day-one draw stamps the bye label on one side and the qualifier it seats on the other, so
    // the row names that qualifier — read off the stored row, not off the row's own side choice.
    const labels = [bye.home_slot_label, bye.away_slot_label] as (SlotLabel | null)[];
    expect(labels.filter((l) => l?.key === BYE_SLOT_LABEL.key).length, "premise: exactly one side is the phantom").toBe(1);
    const qualifier = labels.find((l) => l !== null && l.key !== BYE_SLOT_LABEL.key);
    expect(qualifier, "premise: the other side carries the qualifier it seats").toBeTruthy();
    const want = byeSentenceFor(qualifier!);
    expect(WRONG_BYE_SENTENCES, "anti-vacuity: the right name differs from a side swap and from a missing label").not.toContain(want);
    expect(byeRow.html, "names the qualifier that sits out").toContain(want);
    for (const f of real) {
      const r = sheetRow(f, names, nowMs);
      expect([r.bye, r.action], `positive pair: ${f.id} is offered a time`).toEqual([false, "set_time"]);
    }
  }, 180_000);

  it("X-SD-5 a bye line that holds a slot from before this fix gives it up at the award: time, court, venue and pin", async () => {
    // A legacy line (placed by main's auto pass, or pinned on the board): every slot field set.
    const rig = await leagueKo();
    await sql`
      update fixtures set scheduled_at = '2030-08-01T15:00:00Z', court_id = ${rig.courts[0]!}, venue_id = ${rig.venueId},
        schedule_locked = true
      where id = ${rig.byeLineId}`;
    expect(holdsSlot(await rowOf(rig.koStageId, rig.byeLineId)), "premise: the bye line holds a slot").toBe(true);
    await seedTheBracket(rig);
    expect(slot(await rowOf(rig.koStageId, rig.byeLineId)), "the award takes every slot field off it").toEqual(NONE);
  }, 180_000);

  it("X-SD-5 the board cannot place a bye line — before or after the award — and taking a legacy slot off stays open", async () => {
    const rig = await leagueKo();
    const refusal = { status: 422, code: "BYE_LINE_NOT_PLACEABLE" };
    const at = "2030-08-01T10:00:00.000Z";
    const court = rig.courts[0]!;
    // Pre-award: a time, a court, both, or a pin — each is a slot (`holdsSlot`).
    let refused = 0;
    for (const patch of [{ scheduled_at: at }, { court_id: court }, { scheduled_at: at, court_id: court }, { schedule_locked: true }]) {
      await expect(moveFixture(rig.auth, rig.byeLineId, patch), `pre-award, ${JSON.stringify(patch)}`).rejects.toMatchObject(refusal);
      refused++;
    }
    expect(refused, "anti-vacuity: four placements refused").toBe(4);
    expect(holdsSlot(await rowOf(rig.koStageId, rig.byeLineId)), "nothing written by a refused move").toBe(false);

    // Taking a slot AWAY is not placing one: a legacy bye line holding one can be cleared by hand.
    await sql`update fixtures set scheduled_at = ${at}, court_id = ${court} where id = ${rig.byeLineId}`;
    await expect(moveFixture(rig.auth, rig.byeLineId, { scheduled_at: null, court_id: null }), "clearing a legacy slot").resolves.toBeDefined();
    expect(holdsSlot(await rowOf(rig.koStageId, rig.byeLineId)), "the legacy slot is cleared").toBe(false);

    // Positive pair: the real first-round line of the same bracket moves.
    const real = (await rowsOf(rig.koStageId)).find((r) => r.round_no === 1 && r.id !== rig.byeLineId)!;
    await expect(moveFixture(rig.auth, real.id, { scheduled_at: at, court_id: rig.courts[1]! }), "a real line moves").resolves.toBeDefined();
    expect((await rowOf(rig.koStageId, real.id)).court_id).toBe(rig.courts[1]);

    // After the award the line is `forfeited`: the same named refusal, ahead of the generic status sentence.
    await seedTheBracket(rig);
    await expect(moveFixture(rig.auth, rig.byeLineId, { scheduled_at: at, court_id: court }), "awarded bye").rejects.toMatchObject(refusal);
    expect(holdsSlot(await rowOf(rig.koStageId, rig.byeLineId)), "nothing written to the awarded bye").toBe(false);
  }, 180_000);

  it("X-SD-5 an apply handed a bye line skips it and lands the rest (heldInPlace)", async () => {
    // A stale proposal, or a hand-built body, naming the bye line: nothing is written to it, it is counted as skipped,
    // and the real line in the same apply moves.
    const rig = await leagueKo();
    const real = (await rowsOf(rig.koStageId)).find((r) => r.round_no === 1 && r.id !== rig.byeLineId)!;
    const out = await applySchedule(rig.auth, rig.koStageId, {
      assignments: [
        { fixture_id: rig.byeLineId, scheduled_at: "2030-08-01T15:00:00.000Z", court_id: rig.courts[0]! },
        { fixture_id: real.id, scheduled_at: "2030-08-01T15:00:00.000Z", court_id: rig.courts[1]! },
      ],
      source: "manual",
    });
    expect(out, "the apply reports the bye line it skipped").toMatchObject({ skipped: 1 });
    expect(slot(await rowOf(rig.koStageId, rig.byeLineId)), "the bye line was not written").toEqual(NONE);
    expect((await rowOf(rig.koStageId, real.id)).court_id, "positive pair: the real line in the same apply moved").toBe(rig.courts[1]);
  }, 180_000);

  it("X-SD-5 the AI counts (movableFixtureSql) agree with isMovable, and neither moves a bye line", async () => {
    const rig = await leagueKo();
    const { sqlIds, jsIds } = await sql.begin(async (tx) => {
      const played = await playedFixtureIds(tx, rig.divisionId);
      const all = await tx<Row[]>`
        select id, ext_key, round_no, seq_in_round, status, outcome, home_entrant_id, away_entrant_id,
               home_slot_label, away_slot_label, scheduled_at, court_id, venue_id, schedule_locked
        from fixtures where stage_id = ${rig.koStageId}`;
      const viaSql = await tx<{ id: string }[]>`select f.id from fixtures f where f.stage_id = ${rig.koStageId} and ${movableFixtureSql(tx)}`;
      return { sqlIds: viaSql.map((r) => r.id).sort(), jsIds: all.filter((f) => isMovable(f, played)).map((f) => f.id).sort() };
    });
    expect(sqlIds, "the SQL twin moves what the builder moves").toEqual(jsIds);
    expect(sqlIds.includes(rig.byeLineId), "the bye line is not movable").toBe(false);
    expect(sqlIds.length, "anti-vacuity: the real first-round line and the final are movable").toBe(2);
  }, 180_000);

  it("X-SD-5 a quick Start's rolling times skip a plain bracket's system bye", async () => {
    // A knockout as the FIRST stage: Start generates it (its bye baked `forfeited` at generation) and writes round r's
    // time across it (doc 12 §1.A `roundMinutes`). The sweep read no status, so the bye took round 1's time.
    const o = await orgDivision("KO start");
    await createEntrants(
      o.auth,
      o.divisionId,
      ["P1", "P2", "P3"].map((name, i) => ({ kind: "individual" as const, display_name: name, seed: i + 1, members: [] })),
    );
    const [stage] = await createStages(o.auth, o.divisionId, [{ seq: 1, kind: "knockout", name: "Cup", config: {} }]);
    await putScheduleSettings(o.auth, o.divisionId, SETTINGS(o.courts, { roundMinutes: 45 }));
    await startDivision(o.auth, o.divisionId);
    const rows = await rowsOf(stage!.id);
    const byes = rows.filter((r) => r.status === "forfeited" && (r.home_entrant_id === null) !== (r.away_entrant_id === null));
    expect(rows.length, "rig: a bracket of 4 from three players").toBe(3);
    expect(byes.length, "premise: one first-round line is a baked bye").toBe(1);
    expect(slot(byes[0]!), "no rolling time on the bye").toEqual(NONE);
    const timed = rows.filter((r) => r.id !== byes[0]!.id && r.scheduled_at !== null);
    expect(timed.length, "anti-vacuity: the real first-round line and the final got their rounds' times").toBe(2);
  }, 180_000);

  it("X-SD-5 a frozen, fully placed knockout still starts: its unplaced bye owes the rolling sweep nothing", async () => {
    // Starting an already-built frozen board is the intended path (schedule/: the sweep refuses a frozen board only
    // when it has something to write). Every real line holds its slot; the bye line holds none — it never may — so
    // counting it as a round still to time refused the Start with SCHEDULE_LOCKED.
    const o = await orgDivision("KO frozen start");
    await createEntrants(
      o.auth,
      o.divisionId,
      ["P1", "P2", "P3"].map((name, i) => ({ kind: "individual" as const, display_name: name, seed: i + 1, members: [] })),
    );
    const [stage] = await createStages(o.auth, o.divisionId, [{ seq: 1, kind: "knockout", name: "Cup", config: {} }]);
    await putScheduleSettings(o.auth, o.divisionId, SETTINGS(o.courts, { roundMinutes: 45 }));
    await generateStageFixtures(o.auth, stage!.id);
    const before = await rowsOf(stage!.id);
    const byes = before.filter((r) => isByeLine(r));
    const real = before.filter((r) => !isByeLine(r));
    expect([before.length, byes.length, real.length], "rig: a bracket of 4 from three players, one bye line").toEqual([3, 1, 2]);
    for (const [i, r] of real.entries()) {
      await sql`update fixtures set scheduled_at = ${`2030-08-01T${String(9 + i).padStart(2, "0")}:00:00.000Z`},
                court_id = ${o.courts[i]!} where id = ${r.id}`;
    }
    await sql`update divisions set schedule_locked = true where id = ${o.divisionId}`;
    await expect(startDivision(o.auth, o.divisionId), "the frozen board starts").resolves.toMatchObject({ started: true });
    const after = await rowsOf(stage!.id);
    expect(slot(after.find((r) => r.id === byes[0]!.id)!), "the bye line still holds nothing").toEqual(NONE);
    expect(
      real.map((r) => after.find((a) => a.id === r.id)!.scheduled_at?.toISOString()),
      "positive pair: the real lines keep the slots placed before the freeze",
    ).toEqual(["2030-08-01T09:00:00.000Z", "2030-08-01T10:00:00.000Z"]);
  }, 180_000);

  it("X-SD-5 Undo and Redo of a placement row written before this fix never put a slot on the bye line", async () => {
    // A ledger row from main's auto pass names the bye line among its moves; Undo walks it back and Redo replays it.
    // History's `slotTaker` keeps the replay off the bye line; the real line's move replays (the positive pair).
    const rig = await leagueKo();
    const real = (await rowsOf(rig.koStageId)).find((r) => r.round_no === 1 && r.id !== rig.byeLineId)!;
    const AT = (h: number) => `2030-08-01T${String(h).padStart(2, "0")}:00:00.000Z`;
    const empty = { at: null, court: null };
    const [{ seq }] = await sql<{ seq: number }[]>`
      select coalesce(max(seq), 0)::int + 1 as seq from division_events where division_id = ${rig.divisionId}`;
    await sql`
      insert into division_events (division_id, seq, type, payload)
      values (${rig.divisionId}, ${seq}, 'schedule_applied', ${sql.json({
        moves: [
          { fixture: rig.byeLineId, from: empty, to: { at: AT(9), court: rig.courts[0]! } },
          { fixture: real.id, from: empty, to: { at: AT(10), court: rig.courts[1]! } },
        ],
      } as never)})`;
    await sql`update divisions set seq = ${seq}, edit_watermark = null where id = ${rig.divisionId}`;
    await undoDivision(rig.auth, rig.divisionId);
    await redoDivision(rig.auth, rig.divisionId);
    expect(slot(await rowOf(rig.koStageId, real.id)).at, "positive pair: the Redo replays the real line's placement").toBe(AT(10));
    expect(slot(await rowOf(rig.koStageId, rig.byeLineId)), "the bye line takes no slot from the replay").toEqual(NONE);
  }, 180_000);

  it("X-SD-5 byeLineSql agrees with isByeLine on every shape of the table, and both with the rules", async () => {
    // The SQL twin and the predicate on the SAME stored rows (a real bracket line, rewritten to each shape inside a
    // rolled-back transaction), each held to the table's answer — never merely to each other.
    const rig = await leagueKo();
    const [h, a] = [...rig.nameOf.keys()];
    const ROLLBACK = new Error("rollback");
    const verdict: { name: string; expected: boolean; viaSql: boolean; viaTs: boolean }[] = [];
    await expect(
      sql.begin(async (tx) => {
        for (const shape of BYE_LINE_SHAPES) {
          const row = shapeRow(shape, { H: h!, A: a! });
          await tx`
            update fixtures set ext_key = ${row.ext_key}, status = ${row.status},
              outcome = ${row.outcome === null ? null : tx.json(row.outcome as never)},
              home_entrant_id = ${row.home_entrant_id}, away_entrant_id = ${row.away_entrant_id},
              home_slot_label = ${row.home_slot_label === null ? null : tx.json(row.home_slot_label as never)},
              away_slot_label = ${row.away_slot_label === null ? null : tx.json(row.away_slot_label as never)}
            where id = ${rig.byeLineId}`;
          const [stored] = await tx<(Row & { via_sql: boolean })[]>`
            select f.*, ${byeLineSql(tx)} as via_sql from fixtures f where f.id = ${rig.byeLineId}`;
          verdict.push({ name: shape.name, expected: shape.expected, viaSql: stored!.via_sql, viaTs: isByeLine(stored!) });
        }
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
    let checked = 0;
    for (const v of verdict) {
      expect({ sql: v.viaSql, ts: v.viaTs }, v.name).toEqual({ sql: v.expected, ts: v.expected });
      checked++;
    }
    expect(checked, "anti-vacuity: every shape of the table").toBe(BYE_LINE_SHAPES.length);
    expect(verdict.filter((v) => v.expected).length * verdict.filter((v) => !v.expected).length, "both answers represented").toBeGreaterThan(0);
  }, 180_000);

  it("X-SD-5 after a withdrawal: the dead seat's line is a bye line until the walkover lands, and the withdrew walkover keeps the slot it held (ruling D6)", async () => {
    // Owner ruling 116 (X-WD-3): a winner who withdraws while her next tie's other seat is TBD leaves that seat empty and
    // stamped dead (the bye label), so until the other side arrives the tie IS a pre-award bye line — nobody can be placed
    // on it. The arrival writes a walkover naming her, reason `withdrew`, which is no bye line (`isByeLine`): it keeps
    // the slot the organiser gave the tie before she left (W4 pre-flight D6: "state that a walkover line may keep its
    // slot"). The award clears a slot only for a bye.
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 8 });
    const venue = await createVenue(s.auth, { name: "Hall", sort: 0 });
    const court = await createCourt(s.auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    const play = async (id: string) => {
      await post(s.auth, id, "core.start");
      for (let g = 0; g < 2; g++) await post(s.auth, id, "badminton.game.summary", { home: 21, away: 10 });
      const r = await fixtureRow(id);
      expect(r.status, "rig: the line decided").toBe("decided");
      return r.home_entrant_id!;
    };
    const rows = await bracketRows(s.stageId);
    const first = Math.min(...rows.map((r) => r.round_no));
    const r1 = rows.filter((r) => r.round_no === first && r.home_entrant_id && r.away_entrant_id);
    const a = r1.find((x) => r1.some((y) => y.id !== x.id && y.winner_to_fixture === x.winner_to_fixture))!;
    const b = r1.find((y) => y.id !== a.id && y.winner_to_fixture === a.winner_to_fixture)!;
    const tieId = a.winner_to_fixture!;
    const w1 = await play(a.id);
    const at = "2030-08-01T14:00:00.000Z";
    await moveFixture(s.auth, tieId, { scheduled_at: at, court_id: court.id });
    const placed = slot(await rowOf(s.stageId, tieId));
    expect(holdsSlot(await rowOf(s.stageId, tieId)), "premise: the organiser placed the next tie").toBe(true);

    await withdrawEntrantCascade(s.auth, w1);
    const waiting = await rowOf(s.stageId, tieId);
    expect([waiting.status, waiting.outcome, byeLabelled(waiting)], "premise: her seat is dead and the tie waits, pre-award").toEqual([
      "scheduled",
      null,
      true,
    ]);
    await expect(moveFixture(s.auth, tieId, { court_id: court.id, scheduled_at: "2030-08-01T15:00:00.000Z" }), "a dead-seat tie is not placeable").rejects.toMatchObject({
      status: 422,
      code: "BYE_LINE_NOT_PLACEABLE",
    });
    // B1a review #1: the board agrees. The dead-seat tie keeps its slot (D6) but no board write can move it, so it is no
    // drag target and no disruption either — a repair could never move it off a court that has gone.
    await moveFixture(s.auth, b.id, { scheduled_at: "2030-08-01T10:00:00.000Z", court_id: court.id });
    const board = await listDivisionFixturesForBoard(s.auth, s.divisionId);
    const deadTie = board.find((f) => f.id === tieId)!;
    expect([deadTie.bye_line, boardMovable(deadTie)], "the board marks the dead-seat tie and offers no move").toEqual([true, false]);
    const gone = computeDisruptions(board, { courts: [], blackouts: [], sessionWindows: [], matchMinutes: 30 });
    expect(gone.fixtureIds, "its court gone: the real line is flagged, the dead-seat tie is not").toEqual([b.id]);
    // B1a review N1: and the division Fixtures tab agrees, from the division page's own row: a bye, so its row offers no
    // time edit that could only refuse, and names the side that walks over it, never an unknown sitter.
    const divRows = await listDivisionFixtures(s.auth, s.divisionId);
    const sheetTie = toSheetRow(divRows.find((f) => f.id === tieId)!);
    expect(isBye(sheetTie), "the run sheet reads the dead-seat tie as a bye").toBe(true);
    const tieRow = sheetRow(sheetTie, {}, Date.parse("2030-07-01T10:00:00Z"), feedOf(divRows));
    expect([tieRow.bye, tieRow.action], "its row is the bye row, offering nothing").toEqual([true, null]);
    // The sitter by name: the side `b`'s winner arrives in — the side that walks over her dead seat. That side stores
    // its own "Winner of" label pointing at b (stored wins over the feed edge, `seatLabel`), so the row names b's
    // round and place. Derived from the seeded feeder, not from the row's own side choice.
    expect([b.winner_to_fixture, a.winner_to_slot !== b.winner_to_slot], "premise: b feeds the tie's other side").toEqual([tieId, true]);
    const arrivingSide = (b.winner_to_slot === 1 ? sheetTie.home_slot_label : sheetTie.away_slot_label) as SlotLabel | null;
    expect(arrivingSide, "premise: the arriving side's label points at b").toMatchObject({
      key: "slot.winner_match",
      params: { round: b.round_no, seq: b.seq_in_round },
    });
    const want = byeSentenceFor(arrivingSide!);
    expect(WRONG_BYE_SENTENCES, "anti-vacuity: the right name differs from a side swap and from a missing feed").not.toContain(want);
    expect(tieRow.html, "names the feeder whose winner walks over her dead seat").toContain(want);

    // B1b fix round 1 (Q1): the round bar. Her seat's feeder (`a`) handed on a winner who has withdrawn, so the server flags
    // the tie as awaiting its walkover (`awaits_walkover`): it counts in its round's total and never as done, and once the
    // walkover lands it is done, the total unchanged. Expected totals = the round's lines in the stored bracket. (The final-round
    // shape - a round whose ONLY line is such a tie - is driven for real below, not filtered out of this one: Q2.)
    expect(sheetTie.awaits_walkover, "the server flags the dead-seat tie as awaiting its walkover").toBe(true);
    const tieRound = rows.find((r) => r.id === tieId)!.round_no;
    const linesInRound = rows.filter((r) => r.round_no === tieRound).length;
    expect(linesInRound, "anti-vacuity: the tie's round holds the tie and its sibling").toBe(2);
    const roundOf = async () => {
      const blocks = buildRunSheet({
        fixtures: (await listDivisionFixtures(s.auth, s.divisionId)).map(toSheetRow),
        stages: [{ id: s.stageId, seq: 1, kind: "knockout" }],
        tz: "UTC",
        nowMs: Date.parse("2030-07-01T10:00:00Z"),
      });
      const bracket = blocks.find((x) => x.kind === "bracket");
      return bracket && bracket.kind === "bracket" ? bracket.rounds.find((r) => r.round === tieRound)!.fixtures : [];
    };
    const waitingRound = await roundOf();
    expect(roundDone(waitingRound, new Set()), "waiting: the tie counts in its round, not as done").toEqual({ done: 0, total: linesInRound });

    const arriving = await play(b.id);
    const tie = await rowOf(s.stageId, tieId);
    expect([tie.status, tie.outcome], "the arrival walks over her dead seat").toEqual([
      "forfeited",
      { kind: "award", winner: arriving, loser: w1, reason: "withdrew" },
    ]);
    expect(roundDone(await roundOf(), new Set()), "the walkover landed: done, the total unchanged").toEqual({ done: 1, total: linesInRound });
    expect(slot(tie), "the withdrew walkover keeps the slot it held").toEqual(placed);
  }, 180_000);
});

// W4 B1b fix round 1 (Q1/Q2, controller ruling): the round bar and the desk count by ONE exact rule, driven here through the REAL
// final-round shapes rather than a round filtered down to one line. A knockout of four: the two semi-finals, then the final alone in
// its round. Expected values come from the scenario (which lines are matches), never from the code under test; the desk's
// "N of M played" is held to the sum of the knockout's own round bars at every step, so the two can never tell different stories.
//
// single-sport: badminton — the rule reads the feed edges, seats, labels, status and outcome; no sport field.
describe.skipIf(!HAS_DB)("W4 B1b Q1/Q2: the final-round shapes — the round bar and the desk agree, and no bar reads '0 of 0'", () => {
  const AT = new Date("2030-07-01T10:00:00Z");
  /** The knockout's round bars, off the division page's own read (`listDivisionFixtures`, adapted as the Fixtures tab does). */
  async function barsOf(s: { auth: AuthCtx; divisionId: string; stageId: string }) {
    const wire = await listDivisionFixtures(s.auth, s.divisionId);
    const blocks = buildRunSheet({ fixtures: wire.map(toSheetRow), stages: [{ id: s.stageId, seq: 1, kind: "knockout" }], tz: "UTC", nowMs: AT.getTime() });
    const bracket = blocks.find((x) => x.kind === "bracket");
    const rounds = bracket && bracket.kind === "bracket" ? bracket.rounds : [];
    return { wire, blocks, rounds: rounds.map((r) => ({ round: r.round, ...roundDone(r.fixtures, new Set()) })) };
  }
  /** The bar's words as a person reads them, from the real `RunSheet` the stage card mounts. */
  function barWords(blocks: readonly RunSheetBlock[], stageId: string): string[] {
    const html = renderToStaticMarkup(
      createElement(
        DictProvider,
        { dict: enUi as unknown as ComponentProps<typeof DictProvider>["dict"], locale: "en" } as ComponentProps<typeof DictProvider>,
        createElement(RunSheet, {
          blocks: [...blocks],
          stages: [{ id: stageId, kind: "knockout", name: "Cup" }],
          tz: "UTC",
          orgTz: "UTC",
          nowMs: AT.getTime(),
          matchMinutes: 30,
          entrantNames: {},
          canEdit: true,
          hrefFor: () => "#",
          filter: "all",
          onFilter: () => {},
          stageId,
          embedded: true,
        }),
      ),
    );
    return [...html.matchAll(/<header[^>]*data-testid="run-sheet-round-bar"[^>]*>([\s\S]*?)<\/header>/g)].map((m) =>
      m[1]!.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().replace(/\s+·/g, " ·"),
    );
  }
  const deskOf = async (s: { auth: AuthCtx; competitionId: string; divisionId: string }) => {
    const d = (await getCompetitionDesk(s.auth, s.competitionId, AT)).divisions.get(s.divisionId)!;
    return { played: d.played, total: d.total };
  };
  const sum = (rounds: { done: number; total: number }[]) => ({
    played: rounds.reduce((n, r) => n + r.done, 0),
    total: rounds.reduce((n, r) => n + r.total, 0),
  });
  /** The bye slot label on either side of a wire row (the same stored marker `byeLabelled` reads off a raw row). */
  const wireByeLabelled = (f: { home_slot_label: unknown; away_slot_label: unknown }) =>
    [f.home_slot_label, f.away_slot_label].some((l) => (l as { key?: unknown } | null)?.key === "bracket.slot.bye");
  const EN = enUi as Record<string, string>;
  const DONE = (done: number, total: number) => EN[total === 1 ? "runsheet.round.done.one" : "runsheet.round.done.other"]!.replace("{done}", String(done)).replace("{total}", String(total));

  it("a final waiting on a dead seat whose feeder's winner withdrew: 'Final · 0 of 1' (owed, not done), the desk agrees; the walkover lands '1 of 1'", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 4 });
    const rows = await bracketRows(s.stageId);
    const semis = rows.filter((r) => r.winner_to_fixture !== null);
    expect(semis.length, "rig: two semi-finals").toBe(2);
    const final = rows.find((r) => r.winner_to_fixture === null)!;
    expect(rows.filter((r) => r.round_no === final.round_no).length, "premise: the final is alone in its round").toBe(1);
    const [sf1, sf2] = semis as [(typeof semis)[number], (typeof semis)[number]];
    const w1 = (await playBadminton(s.auth, sf1.id, true)).home_entrant_id!;
    await withdrawEntrantCascade(s.auth, w1);

    const waiting = await barsOf(s);
    const wireFinal = waiting.wire.find((f) => f.id === final.id)!;
    expect([wireFinal.status, wireFinal.outcome, wireByeLabelled(wireFinal)], "premise: her seat is dead and the final waits, pre-award").toEqual(["scheduled", null, true]);
    expect(wireFinal.awaits_walkover, "the server flags it: its dead seat's feeder handed on a winner who withdrew").toBe(true);
    expect(waiting.rounds, "the semis 1 of 2; the final owed its walkover, 0 of 1").toEqual([
      { round: sf1.round_no, done: 1, total: 2 },
      { round: final.round_no, done: 0, total: 1 },
    ]);
    expect(barWords(waiting.blocks, s.stageId).at(-1), "the final's bar, as read").toBe(`Final · ${DONE(0, 1)}`);
    expect(await deskOf(s), "the desk says what the bars add up to").toEqual(sum(waiting.rounds));

    const arriving = (await playBadminton(s.auth, sf2.id, true)).home_entrant_id!;
    const landed = await barsOf(s);
    const finalNow = landed.wire.find((f) => f.id === final.id)!;
    expect([finalNow.status, finalNow.outcome], "the arrival walks over her dead seat").toEqual([
      "forfeited",
      { kind: "award", winner: arriving, loser: w1, reason: "withdrew" },
    ]);
    expect(finalNow.awaits_walkover, "settled: it awaits nothing").toBe(false);
    expect(landed.rounds, "every line done, the totals unchanged").toEqual([
      { round: sf1.round_no, done: 2, total: 2 },
      { round: final.round_no, done: 1, total: 1 },
    ]);
    expect(barWords(landed.blocks, s.stageId).at(-1)).toBe(`Final · ${DONE(1, 1)}`);
    expect(await deskOf(s), "the desk agrees after the walkover too").toEqual(sum(landed.rounds));
  }, 180_000);

  it("a final whose dead seat's feeder handed on nobody (a double walkover): its bye is no match — 'Final · Bye', never '0 of 0'; the desk leaves it out", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 4 });
    const rows = await bracketRows(s.stageId);
    const semis = rows.filter((r) => r.winner_to_fixture !== null);
    const final = rows.find((r) => r.winner_to_fixture === null)!;
    const [sf1, sf2] = semis as [(typeof semis)[number], (typeof semis)[number]];
    const dw = await post(s.auth, sf1.id, "core.forfeit", { by: "both", reason: "walkover" });
    expect([dw.status, dw.outcome], "rig: the double walkover is recorded").toEqual(["forfeited", { kind: "double_walkover" }]);

    // The server stamps the dead seat late (W2b X-DW-2: nothing is decided about the final until its other feeder resolves), so
    // until then the final is an ordinary line waiting on two feeders, and it counts.
    const early = await barsOf(s);
    const earlyFinal = early.wire.find((f) => f.id === final.id)!;
    expect([earlyFinal.status, wireByeLabelled(earlyFinal), earlyFinal.awaits_walkover], "premise: not yet stamped, no bye line").toEqual(["scheduled", false, false]);
    expect(early.rounds.at(-1), "the final still waits: 0 of 1").toEqual({ round: final.round_no, done: 0, total: 1 });

    const arriving = (await playBadminton(s.auth, sf2.id, true)).home_entrant_id!;
    const after = await barsOf(s);
    const finalNow = after.wire.find((f) => f.id === final.id)!;
    expect([finalNow.status, finalNow.outcome, wireByeLabelled(finalNow)], "the final is a bye to the arrival: no feeder winner left the seat").toEqual([
      "forfeited",
      { kind: "award", winner: arriving, loser: null, reason: "bye" },
      true,
    ]);
    expect(after.rounds, "the semis 2 of 2; the final has no line that counts").toEqual([
      { round: sf1.round_no, done: 2, total: 2 },
      { round: final.round_no, done: 0, total: 0 },
    ]);
    const words = barWords(after.blocks, s.stageId);
    expect(words.length, "anti-vacuity: both rounds draw a bar").toBe(2);
    expect(words.at(-1), "the final's bar says it is a bye").toBe(`Final · ${EN["runsheet.round.byes.one"]}`);
    expect(words.join(" | "), "no bar reads 0 of 0").not.toContain(DONE(0, 0));
    expect((await deskOf(s)).total, "the desk's total leaves the bye out, as the bars do").toBe(sum(after.rounds).total);
    const raw = (await listDivisionCardStats(s.auth, s.competitionId)).get(s.divisionId)!;
    const desk = await deskOf(s);
    expect([raw.played - desk.played, raw.total - desk.total], "the desk takes exactly the one bye line out of both numbers").toEqual([1, 1]);
  }, 180_000);
});
