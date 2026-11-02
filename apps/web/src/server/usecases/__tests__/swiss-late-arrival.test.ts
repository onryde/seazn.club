// W3 Task 9 — AUTOMATIC arrivals into a running Swiss (spec 2026-10-31-format-matrix-w3-swiss-design.md §4, ruling 250;
// rule X-SW-13): a confirmed registration, a waitlist promotion, an import and a reinstatement each take case (c) — the
// newcomer joins the next round's Pair and no published pairing moves — and never fail: with no round left the arrival
// is recorded as joining after the last round (Review Focus 4). One test per arrival path (the T6 carry: every path that
// makes an entrant active after Start stamps its first round), found by behaviour — every `insert into entrants` and every
// status write that puts an entrant back in the field (task-9 report, "arrival-path sweep").
//
// Expected values come from the plan's rules (case (c): first round = current + 1; no round left: rounds + 1) and from the
// rows before the arrival, never from the code under test.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import type { AuthCtx } from "@/server/api-v1/auth";
import { resolveModule } from "@/server/engine-db";
import { forfeitPlayedFacts } from "@/server/engine-db/forfeit-played";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { undoDivision } from "../history";
import { commitImport, createImport } from "../imports";
import { confirmRegistration, openPromotionSeatGate, promoteOldestWaitlisted, putRegistrationSettings } from "../registrations";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { buildSwissHistory, createStages, generateStageFixtures, type SwissExistingFixture } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedRegistration } from "./_registration-fixtures";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const SPORTS = [
  { sport: "badminton", variant: "bwf" },
  { sport: "boardgame", variant: "classical" },
] as const;
type Sport = { sport: string; variant: string };

const mod = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m as AnySportModule;
};

interface Rig {
  sport: Sport;
  auth: AuthCtx;
  competitionId: string;
  divisionId: string;
  divisionSlug: string;
  stageId: string;
  entrants: string[];
}

async function swissRig(sport: Sport, n: number, rounds: number, entrantKind?: string): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Late arrival " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const slug = "open-" + randomUUID().slice(0, 6);
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug,
    sport_key: sport.sport,
    variant_key: sport.variant,
    config: {},
  });
  const kind = (entrantKind ?? mod(sport.sport).entrantModel?.defaultKind ?? "individual") as "individual" | "pair" | "team";
  const made = await createEntrants(
    auth,
    division.id,
    Array.from({ length: n }, (_, i) => ({ kind, display_name: `P${i + 1}`, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds }, progression: null });
  await startDivision(auth, division.id);
  return {
    sport,
    auth,
    competitionId: comp.id,
    divisionId: division.id,
    divisionSlug: slug,
    stageId: stage!.id,
    entrants: made.map((e) => e.id),
  };
}

interface Row {
  id: string;
  ext_key: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: unknown;
  scheduled_at: Date | null;
  court_id: string | null;
  venue_id: string | null;
  schedule_locked: boolean;
}
const rowsOf = (stageId: string) =>
  sql<Row[]>`
    select id, ext_key, round_no, seq_in_round, home_entrant_id, away_entrant_id, status, outcome,
           scheduled_at, court_id, venue_id, schedule_locked
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
const isBye = (f: Row) => /^sw-r\d+-bye$/.test(f.ext_key ?? "");
const boardsOf = (rows: readonly Row[], r: number) => rows.filter((f) => f.round_no === r && !isBye(f));
const seatedIn = (rows: readonly Row[]) => rows.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((x): x is string => x !== null);

async function homeWins(rig: Rig, f: Row): Promise<void> {
  await scoreEvent(rig.auth, f.id, { expected_seq: 0, type: "core.start", payload: {} });
  if (rig.sport.sport === "boardgame") {
    await scoreEvent(rig.auth, f.id, { expected_seq: 1, type: "boardgame.result", payload: { winner: f.home_entrant_id, method: "resign" } });
  } else {
    await scoreEvent(rig.auth, f.id, { expected_seq: 1, type: "badminton.game.summary", payload: { home: 21, away: 10 } });
    await scoreEvent(rig.auth, f.id, { expected_seq: 2, type: "badminton.game.summary", payload: { home: 21, away: 12 } });
  }
}

async function playRound(rig: Rig, r: number): Promise<void> {
  const boards = boardsOf(await rowsOf(rig.stageId), r);
  expect(boards.length, `rig: round ${r} has boards`).toBeGreaterThan(0);
  for (const f of boards) await homeWins(rig, f);
}

async function firstRoundOf(entrantId: string) {
  const [e] = await sql<{ swiss_first_round: number | null; swiss_first_round_stage_id: string | null; status: string }[]>`
    select swiss_first_round, swiss_first_round_stage_id, status from entrants where id = ${entrantId}`;
  return e!;
}

async function lateRows(divisionId: string) {
  return (
    await sql<{ payload: Record<string, unknown> }[]>`
      select payload from division_events where division_id = ${divisionId} and type = 'swiss_late_entry' order by seq`
  ).map((r) => r.payload);
}

/** A free, offline registration confirmed through `confirmRegistration` → `materialise`. */
async function confirmArrival(rig: Rig, name: string): Promise<{ entrantId: string; registrationStatus: string }> {
  const { registration } = await seedRegistration(
    rig.competitionId,
    rig.divisionId,
    { fee_cents: 0, currency: "eur", payment_method: "offline" },
    { displayName: name },
  );
  const confirmed = await confirmRegistration(rig.auth, registration.id);
  expect(confirmed.entrant_id, `rig: ${name}'s confirmation made an entrant`).toBeTruthy();
  return { entrantId: confirmed.entrant_id!, registrationStatus: confirmed.status };
}

for (const s of SPORTS) {
  describe.runIf(HAS_DB)(`W3 T9 automatic arrivals (${s.sport})`, () => {
    it(`X-SW-13 a payment confirmation during a live round never re-pairs: case (c), first round = current + 1 (${s.sport})`, async () => {
      const rig = await swissRig(s, 4, 3);
      await generateStageFixtures(rig.auth, rig.stageId); // round 1 paired, nothing started: an organiser would re-pair it
      const before = await rowsOf(rig.stageId);
      const { entrantId } = await confirmArrival(rig, "Late");
      expect(await rowsOf(rig.stageId), "nothing moved").toEqual(before);
      expect(await firstRoundOf(entrantId)).toEqual({ swiss_first_round: 2, swiss_first_round_stage_id: rig.stageId, status: "confirmed" });
      expect(await lateRows(rig.divisionId)).toEqual([
        { stage_id: rig.stageId, entrant_id: entrantId, case: "c", round: 2, source: "registration" },
      ]);
    });

    it(`X-SW-13 a waitlist promotion that seats takes case (c) (${s.sport})`, async () => {
      const rig = await swissRig(s, 4, 3);
      await generateStageFixtures(rig.auth, rig.stageId);
      const settings = await putRegistrationSettings(rig.auth, rig.divisionId, {
        enabled: true,
        entrant_kind: mod(s.sport).entrantModel?.defaultKind ?? "individual",
        fee_cents: 0,
        form_fields: [],
        opens_at: null,
        closes_at: null,
        capacity: null,
        refund_lock_at: null,
      });
      expect({ approval: settings.approval, fee: settings.fee_cents }, "premise: a free, auto-approval division seats a promotion").toEqual({
        approval: "auto",
        fee: 0,
      });
      const { registration } = await seedRegistration(
        rig.competitionId,
        rig.divisionId,
        { fee_cents: 0, currency: "eur", payment_method: "offline" },
        { status: "waitlisted", displayName: "Waiter" },
      );
      const before = await rowsOf(rig.stageId);
      // The product's own order (a withdrawal or an expiry): the seat gate opened before the transaction that promotes.
      const gate = await openPromotionSeatGate(rig.divisionId, settings);
      expect(gate, "premise: a seating promotion opens a gate").toBeDefined();
      const promoted = await sql.begin((tx) => promoteOldestWaitlisted(tx, rig.divisionId, settings, undefined, gate));
      expect(promoted?.id).toBe(registration.id);
      expect(promoted?.status).toBe("confirmed");
      const entrantId = promoted!.entrant_id!;
      expect(await rowsOf(rig.stageId)).toEqual(before);
      expect(await firstRoundOf(entrantId)).toMatchObject({ swiss_first_round: 2, swiss_first_round_stage_id: rig.stageId });
      expect(await lateRows(rig.divisionId)).toEqual([
        { stage_id: rig.stageId, entrant_id: entrantId, case: "c", round: 2, source: "waitlist" },
      ]);
    });

    it(`X-SW-13 an automatic arrival with no round left never fails the confirmation (${s.sport})`, async () => {
      const rig = await swissRig(s, 4, 1);
      await generateStageFixtures(rig.auth, rig.stageId);
      await scoreEvent(rig.auth, boardsOf(await rowsOf(rig.stageId), 1)[0]!.id, { expected_seq: 0, type: "core.start", payload: {} });
      const { entrantId, registrationStatus } = await confirmArrival(rig, "Late");
      expect(registrationStatus).toBe("confirmed");
      // Recorded as joining after the last round: rounds + 1.
      expect(await firstRoundOf(entrantId)).toEqual({ swiss_first_round: 2, swiss_first_round_stage_id: rig.stageId, status: "confirmed" });
      expect(await lateRows(rig.divisionId)).toEqual([
        { stage_id: rig.stageId, entrant_id: entrantId, case: "c", round: 2, source: "registration" },
      ]);
      // And with the Swiss over: still confirmed, still recorded after the last round.
      await sql`update stages set status = 'complete' where id = ${rig.stageId}`;
      const second = await confirmArrival(rig, "Later");
      expect(second.registrationStatus).toBe("confirmed");
      expect((await firstRoundOf(second.entrantId)).swiss_first_round).toBe(2);
    });

    it(`an automatic swiss_late_entry is not an undo barrier (${s.sport})`, async () => {
      const rig = await swissRig(s, 4, 3);
      await generateStageFixtures(rig.auth, rig.stageId);
      await confirmArrival(rig, "Late");
      expect((await lateRows(rig.divisionId)).length, "premise: the arrival wrote its row").toBe(1);
      // The newest REVERSIBLE step is the Pair; the automatic row past it is no barrier, so the Undo clears round 1.
      await expect(undoDivision(rig.auth, rig.divisionId)).resolves.toMatchObject({ applied: { type: "fixtures_cleared" } });
      expect(seatedIn((await rowsOf(rig.stageId)).filter((f) => f.round_no === 1))).toEqual([]);
    });

    it(`X-SW-13 a reinstatement after Start rejoins at the next round; the missed round scores 0 (${s.sport})`, async () => {
      const rig = await swissRig(s, 5, 3);
      await generateStageFixtures(rig.auth, rig.stageId);
      await playRound(rig, 1);
      const r1 = await rowsOf(rig.stageId);
      const leaver = boardsOf(r1, 1)[0]!.home_entrant_id!; // won round 1 at home
      await withdrawEntrantCascade(rig.auth, leaver);
      await generateStageFixtures(rig.auth, rig.stageId); // round 2 over four players: no bye row
      const r2 = (await rowsOf(rig.stageId)).filter((f) => f.round_no === 2);
      expect(r2.some(isBye), "premise: round 2 has no bye row (the case where an implicit bye would be inferred)").toBe(false);
      expect(seatedIn(r2)).not.toContain(leaver);
      await playRound(rig, 2);
      await patchEntrant(rig.auth, leaver, { status: "registered" });
      expect(await firstRoundOf(leaver)).toEqual({ swiss_first_round: 3, swiss_first_round_stage_id: rig.stageId, status: "registered" });
      expect(await lateRows(rig.divisionId)).toEqual([
        { stage_id: rig.stageId, entrant_id: leaver, case: "c", round: 3, source: "reinstate" },
      ]);
      // Ruling 251 / FIDE C.04.2 2.4: round 2 was missed, so it scores 0 — the history credits round 1's win and nothing
      // for round 2, and does not spend the bye.
      const rows = (await rowsOf(rig.stageId)) as unknown as SwissExistingFixture[];
      const [d] = await sql<{ sport_key: string; module_version: string }[]>`select sport_key, module_version from divisions where id = ${rig.divisionId}`;
      const facts = await forfeitPlayedFacts(sql, rows.filter((f) => f.home_entrant_id && f.away_entrant_id), resolveModule(d!.sport_key, d!.module_version));
      const hist = buildSwissHistory(rows, [{ id: leaver, seed: 1, swiss_first_round: 3 }], facts);
      expect(hist.score.get(leaver)).toBe(1);
      expect(hist.byes.has(leaver)).toBe(false);
      // The round-3 Pair seats them.
      await generateStageFixtures(rig.auth, rig.stageId);
      expect(seatedIn((await rowsOf(rig.stageId)).filter((f) => f.round_no === 3))).toContain(leaver);
    });

    it(`X-SW-13 a late player withdrawn and then reinstated is a NEW arrival: first round moves to the next round (${s.sport})`, async () => {
      const rig = await swissRig(s, 4, 3);
      await generateStageFixtures(rig.auth, rig.stageId);
      await scoreEvent(rig.auth, boardsOf(await rowsOf(rig.stageId), 1)[0]!.id, { expected_seq: 0, type: "core.start", payload: {} });
      const [late] = await createEntrants(rig.auth, rig.divisionId, [
        { kind: (mod(s.sport).entrantModel?.defaultKind ?? "individual") as "individual" | "pair" | "team", display_name: "Late", members: [] },
      ]);
      expect(late!.late_entry, "premise: the organiser's add, round 1 started with no bye: (c)").toMatchObject({ case: "c", round: 2 });
      await withdrawEntrantCascade(rig.auth, late!.id);
      // Round 1 finished and round 2 paired and played without them.
      for (const f of boardsOf(await rowsOf(rig.stageId), 1)) {
        const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${f.id}`;
        if (n === 0) await scoreEvent(rig.auth, f.id, { expected_seq: 0, type: "core.start", payload: {} });
        await scoreEvent(rig.auth, f.id, { expected_seq: n === 0 ? 1 : n, type: "core.forfeit", payload: { by: f.away_entrant_id, reason: "walkover" } });
      }
      await generateStageFixtures(rig.auth, rig.stageId);
      expect(seatedIn((await rowsOf(rig.stageId)).filter((f) => f.round_no === 2))).not.toContain(late!.id);
      await playRound(rig, 2);
      await patchEntrant(rig.auth, late!.id, { status: "registered" });
      // The earlier admission's stamp (round 2) does not make this a retry: the rounds they were away for are missed.
      expect(await firstRoundOf(late!.id)).toMatchObject({ swiss_first_round: 3, swiss_first_round_stage_id: rig.stageId });
      expect((await lateRows(rig.divisionId)).map((p) => [p.source, p.case, p.round])).toEqual([
        ["organiser", "c", 2],
        ["reinstate", "c", 3],
      ]);
    });
  });
}

describe.runIf(HAS_DB)("W3 T9 automatic arrivals: an import (football)", () => {
  // single-sport: football — an import's `entrant.create` makes TEAM entrants only, and chess is individual-only.
  it("X-SW-13 an import entrant.create during a live round takes case (c)", async () => {
    const csv = (rows: string[]) => ({
      filename: "import.csv",
      contentType: "text/csv",
      buffer: Buffer.from(["Club,Team,Player,DOB,Number,Position,Captain,Division", ...rows].join("\r\n"), "utf8"),
    });
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Import " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const slug = "u12-" + randomUUID().slice(0, 4);
    const division = await createDivision(auth, comp.id, { name: "U12", slug, sport_key: "football", variant_key: "small-sided", config: {} });
    const first = await createImport(
      auth,
      csv(["A SC,A Team,Ada One,2014-01-01,1,,,", "B SC,B Team,Bo Two,2014-01-02,2,,,", "C SC,C Team,Cy Three,2014-01-03,3,,,", "D SC,D Team,Di Four,2014-01-04,4,,,"].map((r) => r + slug)),
    );
    expect(first.plan.issues, "premise: the roster file plans clean").toEqual([]);
    await commitImport(auth, first.importId, null);
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 }, progression: null });
    await startDivision(auth, division.id);
    await generateStageFixtures(auth, stage!.id);
    const before = await rowsOf(stage!.id);
    expect(seatedIn(before).length, "premise: four teams paired").toBe(4);

    const late = await createImport(auth, csv([`E SC,E Team,Ed Five,2014-01-05,5,,,${slug}`]));
    expect(late.plan.stats.entrants, "premise: the file makes one entrant").toBe(1);
    await commitImport(auth, late.importId, null);
    const [e] = await sql<{ id: string; swiss_first_round: number | null; swiss_first_round_stage_id: string | null }[]>`
      select id, swiss_first_round, swiss_first_round_stage_id from entrants where division_id = ${division.id} and display_name = 'E Team'`;
    expect(e).toMatchObject({ swiss_first_round: 2, swiss_first_round_stage_id: stage!.id });
    expect(await rowsOf(stage!.id), "nothing moved").toEqual(before);
    expect(await lateRows(division.id)).toEqual([{ stage_id: stage!.id, entrant_id: e!.id, case: "c", round: 2, source: "import" }]);
  });
});
