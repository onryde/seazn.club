// Scorer sheets §4.4 — the loader half: what each candidate row PRINTS, read
// from a real schedule. Real use-cases end to end (the rig), so the names, the
// board's round codes, the feed labels and the venue zone are what the product
// writes. Expected match refs and "Winner of …" labels are DERIVED from the
// board's own `boardRoundCodes` over the stage's rows (owner ruling
// 2026-09-24), never typed in, and read in French so an English default could
// not pass.
import { afterAll, describe, expect, it, vi } from "vitest";
import { sql, withTenant } from "@/lib/db";
import { msgFor } from "@/lib/messages-i18n";
import { matchRef, type SlotLabelLookup } from "@/lib/slot-label";
import { paginateSheet } from "@/lib/scorer-sheets";
import { boardRoundCodes } from "@/components/v2/board/round-codes";
import { seedOrg } from "./_seed";
import { decide, fixturesOf, seedStage, type RigFixture } from "./_sheets-rig";
import { getScheduleSettings, putScheduleSettings, courtNamesById } from "../schedule";
import { createCourt, createVenue } from "../venues";
import { patchFixture } from "../fixtures";
import { MATCH_NAME_COLS, type MatchNameRow } from "../scan-match-names";
import { listSheetDays, loadSheetCandidates } from "../scorer-sheets";
import type { AuthCtx } from "@/server/api-v1/auth";

const HAS_DB = !!process.env.DATABASE_URL;
const fr: SlotLabelLookup = (k, v) => msgFor("fr", k, v);
const en: SlotLabelLookup = (k, v) => msgFor("en", k, v);

afterAll(async () => {
  // The rig stubs DEVICE_LINK_KEK once, at import: unstub in afterAll ONLY.
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

async function at(fixtureId: string, iso: string): Promise<void> {
  await sql`update fixtures set scheduled_at = ${iso}::timestamptz where id = ${fixtureId}`;
}

/** The division's own zone override, through the use-case that writes it. */
async function setDivisionTz(auth: AuthCtx, divisionId: string, tz: string): Promise<void> {
  const current = await getScheduleSettings(auth, divisionId);
  await putScheduleSettings(auth, divisionId, { config: current.config, tz });
}

/** The board's round codes for one stage, in `lookup`'s language. */
async function boardCodes(stageId: string, kind: string, lookup: SlotLabelLookup) {
  const rows = await sql<MatchNameRow[]>`select ${sql(MATCH_NAME_COLS)} from fixtures where stage_id = ${stageId}`;
  return boardRoundCodes(rows, [{ id: stageId, kind }], lookup);
}

describe.skipIf(!HAS_DB)("loadSheetCandidates / listSheetDays (scorer sheets §4.4)", () => {
  it("empty case first: an unscheduled competition has no days and no candidates", async () => {
    const { auth } = await seedOrg("pro");
    const { competition, stage } = await seedStage(auth, "league", ["A", "B", "C", "D"]);
    const fx = await fixturesOf(stage.id);
    expect(fx.length).toBeGreaterThan(0); // premise: there ARE fixtures, just no times
    expect(await listSheetDays(auth, competition.id)).toEqual([]);
    expect(await loadSheetCandidates(auth, competition.id, en)).toEqual([]);
    expect(await loadSheetCandidates(auth, competition.id, en, "2026-09-23")).toEqual([]);
  });

  it("a knockout row is named as the board names it — its code, 'Winner of' its feeder, the person — in the caller's language", async () => {
    const { auth } = await seedOrg("pro");
    // Real members, so name resolution runs: a one-member individual is named
    // by its PERSON ("Nia Okafor"), not the entrant snapshot ("N. Okafor").
    const { competition, stage } = await seedStage(auth, "knockout", ["N. Okafor", "B. Lim", "C", "D"], {}, {
      members: (n) => [n === "N. Okafor" ? "Nia Okafor" : `${n} Player`],
    });
    const fx = await fixturesOf(stage.id);
    const semis = fx.filter((f) => f.round_no === 1);
    const final = fx.find((f) => f.round_no === 2)!;
    expect(semis).toHaveLength(2);
    for (const [i, f] of fx.entries()) await at(f.id, new Date(Date.UTC(2026, 8, 23, 9 + i)).toISOString());

    const rows = await loadSheetCandidates(auth, competition.id, fr, "2026-09-23");
    expect(rows.map((r) => r.id).sort()).toEqual(fx.map((f) => f.id).sort());

    const codes = await boardCodes(stage.id, "knockout", fr);
    const enCodes = await boardCodes(stage.id, "knockout", en);
    for (const f of fx) {
      const rc = codes.get(f.id);
      expect(rc, `premise: the board codes knockout fixture r${f.round_no}·${f.seq_in_round}`).toBeDefined();
      const row = rows.find((r) => r.id === f.id)!;
      expect(row.match_ref).toBe(matchRef(f.round_no, rc!.refSeq, fr, rc!.code));
      // Never the round-number form the board does not print for a bracket.
      expect(row.match_ref).not.toBe(matchRef(f.round_no, f.seq_in_round, fr));
    }

    // The final's seats wait on the semis: each named by ITS feeder's board
    // ref, in French ("Vainqueur de DF·1"), which is not the English text.
    const finalRow = rows.find((r) => r.id === final.id)!;
    expect(finalRow.home).toBeNull();
    expect(finalRow.away).toBeNull();
    const feeder = (slot: number): RigFixture =>
      semis.find((s) => s.winner_to_fixture === final.id && s.winner_to_slot === slot)!;
    const winnerOf = (f: RigFixture, lookup: SlotLabelLookup, c: typeof codes) =>
      lookup("slot.winner_match", { ext: matchRef(f.round_no, c.get(f.id)!.refSeq, lookup, c.get(f.id)!.code) });
    expect(finalRow.home_tbd).toBe(winnerOf(feeder(1), fr, codes));
    expect(finalRow.away_tbd).toBe(winnerOf(feeder(2), fr, codes));
    expect(finalRow.home_tbd).not.toBe(winnerOf(feeder(1), en, enCodes));
    expect(finalRow.home_tbd).not.toBe(finalRow.away_tbd);

    // The stored slot labels ride along untouched (the bye check reads them).
    const [stored] = await sql<{ home_slot_label: unknown; away_slot_label: unknown }[]>`
      select home_slot_label, away_slot_label from fixtures where id = ${final.id}`;
    expect(stored!.home_slot_label).not.toBeNull(); // premise: there is a label to carry
    expect(stored!.away_slot_label).not.toBeNull();
    expect(finalRow.home_slot_label).toEqual(stored!.home_slot_label);
    expect(finalRow.away_slot_label).toEqual(stored!.away_slot_label);

    // Seated semis print the person, not the entrant snapshot — every seat,
    // home and away, each person once.
    const seatedNames = rows.filter((r) => r.round_no === 1).flatMap((r) => [r.home?.name, r.away?.name]);
    expect([...seatedNames].sort()).toEqual(["B. Lim Player", "C Player", "D Player", "Nia Okafor"]);
    expect(seatedNames).not.toContain("N. Okafor");
    expect(rows.every((r) => r.division_name === "Open")).toBe(true);
    const okafor = rows.flatMap((r) => [r.home, r.away]).find((s) => s?.name === "Nia Okafor")!;
    expect(okafor.kind).toBe("individual");
    expect(okafor.members.map((m) => m.full_name)).toEqual(["Nia Okafor"]);
  });

  it("a league row keeps the round number — the board codes no league round", async () => {
    const { auth } = await seedOrg("pro");
    const { competition, stage } = await seedStage(auth, "league", ["A", "B", "C", "D"]);
    const fx = await fixturesOf(stage.id);
    const codes = await boardCodes(stage.id, "league", fr);
    expect(codes.size).toBe(0); // premise
    for (const f of fx) await at(f.id, "2026-09-23T09:00:00Z");
    const rows = await loadSheetCandidates(auth, competition.id, fr, "2026-09-23");
    expect(rows).toHaveLength(fx.length);
    for (const r of rows) {
      const f = fx.find((x) => x.id === r.id)!;
      expect(r.match_ref).toBe(matchRef(f.round_no, f.seq_in_round, fr));
      expect([r.round_no, r.seq_in_round]).toEqual([f.round_no, f.seq_in_round]);
    }
  });

  it("a scored fixture is no longer a candidate; times come back as ISO strings", async () => {
    const { auth } = await seedOrg("pro");
    const { competition, stage } = await seedStage(auth, "league", ["A", "B", "C", "D"]);
    const [played, open] = await fixturesOf(stage.id);
    await at(played!.id, "2026-09-23T09:00:00Z");
    await at(open!.id, "2026-09-23T11:30:00Z");
    await decide(auth, played!.id);
    const [{ status }] = await sql<{ status: string }[]>`select status from fixtures where id = ${played!.id}`;
    expect(["decided", "finalized"]).toContain(status); // premise
    const all = await loadSheetCandidates(auth, competition.id, en);
    expect(all.map((r) => r.id)).toEqual([open!.id]);
    expect(all[0]!.scheduled_at).toBe("2026-09-23T11:30:00.000Z");
    expect(all[0]!.status).toBe("scheduled");
  });

  it("the day is the local day in the DIVISION's zone, which beats the org's", async () => {
    const { auth } = await seedOrg("pro");
    await sql`update organizations set timezone = 'America/Los_Angeles' where id = ${auth.orgId}`;
    const { competition, division, stage } = await seedStage(auth, "knockout", ["A", "B", "C", "D"]);
    await setDivisionTz(auth, division.id, "Pacific/Auckland");
    const fx = await fixturesOf(stage.id);
    const [sf1, sf2] = fx.filter((f) => f.round_no === 1);
    const final = fx.find((f) => f.round_no === 2)!;
    await at(sf1!.id, "2026-09-22T12:30:00Z"); // 00:30 NZST, 23 Sep (UTC: the 22nd)
    await at(sf2!.id, "2026-09-23T11:30:00Z"); // 23:30 NZST, 23 Sep
    await at(final.id, "2026-09-23T20:00:00Z"); // 08:00 NZST, 24 Sep (UTC: the 23rd)

    // UTC would say 22 + 23; Los Angeles would say 22 + 23 as well.
    expect(await listSheetDays(auth, competition.id)).toEqual(["2026-09-23", "2026-09-24"]);
    const day = await loadSheetCandidates(auth, competition.id, en, "2026-09-23");
    expect(day.map((r) => r.id).sort()).toEqual([sf1!.id, sf2!.id].sort());
    expect(day.every((r) => r.tz === "Pacific/Auckland")).toBe(true);
    expect((await loadSheetCandidates(auth, competition.id, en, "2026-09-24")).map((r) => r.id)).toEqual([final.id]);
  });

  it("with no division override the org's zone decides the day", async () => {
    const { auth } = await seedOrg("pro");
    await sql`update organizations set timezone = 'America/Los_Angeles' where id = ${auth.orgId}`;
    const { competition, stage } = await seedStage(auth, "league", ["A", "B"]);
    const [f] = await fixturesOf(stage.id);
    await at(f!.id, "2026-09-24T05:00:00Z"); // 22:00 PDT, 23 Sep
    expect(await listSheetDays(auth, competition.id)).toEqual(["2026-09-23"]);
    const [row] = await loadSheetCandidates(auth, competition.id, en, "2026-09-23");
    expect(row!.id).toBe(f!.id);
    expect(row!.tz).toBe("America/Los_Angeles");
  });

  it("a team side carries its roster members' names, in roster order (the sheet prints them under the team)", async () => {
    const { auth } = await seedOrg("pro");
    const { competition, stage } = await seedStage(auth, "league", ["Hawks", "Owls"], {}, {
      entrantKind: "team",
      members: (n) => [`${n} Two`, `${n} One`],
    });
    const [f] = await fixturesOf(stage.id);
    await at(f!.id, "2026-09-23T09:00:00Z");
    const [row] = await loadSheetCandidates(auth, competition.id, en, "2026-09-23");
    expect(row!.home!.kind).toBe("team");
    // A team is named by its snapshot, never by a member.
    expect(["Hawks", "Owls"]).toContain(row!.home!.name);
    expect(row!.home!.members.map((m) => m.full_name)).toEqual([`${row!.home!.name} One`, `${row!.home!.name} Two`]);
  });

  it("courts: the board's venue-qualified name, venue then court order, courtless rows last", async () => {
    const { auth } = await seedOrg("pro");
    const { competition, stage } = await seedStage(auth, "league", ["A", "B", "C", "D", "E", "F"]);
    // Two venues each with a "Court 1": the board tells them apart by venue.
    const hallA = await createVenue(auth, { name: "Hall A", sort: 1 });
    const hallB = await createVenue(auth, { name: "Hall B", sort: 0 });
    const courtA = await createCourt(auth, hallA.id, { name: "Court 1", sort: 0, tags: [] });
    const courtB = await createCourt(auth, hallB.id, { name: "Court 1", sort: 0, tags: [] });
    const fx = await fixturesOf(stage.id);
    const [x, y, z] = fx.filter((f) => f.round_no === 1);
    const [legacy, venueOnly] = fx.filter((f) => f.round_no === 2);
    await patchFixture(auth, x!.id, { court_id: courtA.id });
    await patchFixture(auth, y!.id, { court_id: courtB.id });
    // A pre-P9 row: free-text court, no court entity. Nothing writes the
    // column any more (PatchFixture refuses it), but the board still names a
    // row by it (`courtDisplayName`), so the sheet does too.
    await sql`update fixtures set court_label = 'Court 7' where id = ${legacy!.id}`;
    // Another pre-P9 shape: V374 backfilled `venue_id` from free text with no
    // court. The venue comes through the COURT (every writer since derives it
    // from one, schedule.ts moveFixture), so this row is simply courtless and
    // keeps its place by time under Unassigned.
    await sql`update fixtures set venue_id = ${hallB.id} where id = ${venueOnly!.id}`;
    for (const f of [x!, y!, z!, legacy!]) await at(f.id, "2026-09-23T09:00:00Z");
    await at(venueOnly!.id, "2026-09-23T10:00:00Z");

    const names = await withTenant(auth.orgId, (tx) => courtNamesById(tx));
    expect(names.get(courtA.id)).not.toBe("Court 1"); // premise: the board qualifies them
    const rows = await loadSheetCandidates(auth, competition.id, en, "2026-09-23");
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(x!.id)!.court_name).toBe(names.get(courtA.id));
    expect(byId.get(y!.id)!.court_name).toBe(names.get(courtB.id));
    expect(byId.get(z!.id)!.court_name).toBeNull();
    expect(byId.get(legacy!.id)!.court_name).toBe("Court 7");
    expect(byId.get(venueOnly!.id)!.court_name).toBeNull();
    expect([byId.get(x!.id)!.venue_name, byId.get(x!.id)!.venue_sort, byId.get(x!.id)!.court_sort]).toEqual(["Hall A", 1, 0]);

    // With a day, the loader returns the sheet's rows in print order: Hall B
    // (sort 0) before Hall A (sort 1), then the venue-less legacy court, the
    // courtless rows last, by time.
    expect(rows.map((r) => r.id)).toEqual([y!.id, x!.id, legacy!.id, z!.id, venueOnly!.id]);
    expect(paginateSheet(rows, "Unassigned").map((p) => [p.courtHeading, p.rows.length])).toEqual([
      [names.get(courtB.id), 1],
      [names.get(courtA.id), 1],
      ["Court 7", 1],
      ["Unassigned", 2],
    ]);
  });

  it("a bye line still waiting for its draw is never printed, and gives the day list nothing", async () => {
    const { auth } = await seedOrg("pro");
    const { competition, stage } = await seedStage(auth, "knockout", ["A", "B", "C", "D"]);
    const [bye, real] = (await fixturesOf(stage.id)).filter((f) => f.round_no === 1);
    // The state a seeded bye line holds until its draw lands: one side empty
    // and stamped `bracket.slot.bye`, status still `scheduled`, no outcome
    // (division-phase.ts `fixtureAwaitsSeedDraw`; stages.ts `awardSeededByes`
    // settles it). No rig path stops there, so the stamp is written by hand.
    await sql`
      update fixtures set away_entrant_id = null,
             away_slot_label = ${sql.json({ key: "bracket.slot.bye", params: {} })}
      where id = ${bye!.id}`;
    await at(bye!.id, "2026-09-22T09:00:00Z");
    await at(real!.id, "2026-09-23T09:00:00Z");
    const [{ status }] = await sql<{ status: string }[]>`select status from fixtures where id = ${bye!.id}`;
    expect(status).toBe("scheduled"); // premise: only the label excludes it
    expect(await listSheetDays(auth, competition.id)).toEqual(["2026-09-23"]);
    expect((await loadSheetCandidates(auth, competition.id, en)).map((r) => r.id)).toEqual([real!.id]);
  });

  it("is tenant-scoped: another org cannot load this competition", async () => {
    const a = await seedOrg("pro");
    const b = await seedOrg("pro");
    const { competition } = await seedStage(a.auth, "league", ["A", "B"]);
    await expect(loadSheetCandidates(b.auth, competition.id, en)).rejects.toMatchObject({ status: 404 });
    await expect(listSheetDays(b.auth, competition.id)).rejects.toMatchObject({ status: 404 });
  });
});
