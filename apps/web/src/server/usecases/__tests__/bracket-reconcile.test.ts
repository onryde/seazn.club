// W4 app-A Task 8 (FX-G2, MB-004/005; spec 2026-11-04 §6.5) — Generate over a root knockout that already has its lines,
// driven through the real usecases on a real database. Main inserted by `ext_key` alone: 6 → 7 inserted nothing and said
// "up to date", 8 → 9 seated the field twice beside a second final, and a line that became a bye 500'd ("would strand
// home_slot_label"). Now, before Start, Generate places a newcomer in a bye, turns a departed entrant's line into a bye,
// or — when the bracket crosses a power of two — regenerates it once, slots carried by role; after Start it never
// reshapes.
//
// Expected values: the bye a newcomer takes is RB4-L4 over the STORED bye lines (`rb4L4ExpectedLine`, the oracle shared
// with Task 10 — controller ruling 3); a regenerated bracket's shape is the ENGINE's own bracket of the new field
// (`engineBracketRows`); the bye award is lib/fixture-bye.ts's (the shape every bye writer shares); the copy is main's
// own (X-SD-2 quotes stages.ts) or the plan's (KO_GENERATE_AFTER_START, typed here).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { entrantKindCap } from "@seazn/engine/sport";
import { sql, withTenant } from "@/lib/db";
import { BYE_SLOT_LABEL, isByeLine } from "@/lib/bye-line";
import { byeAward } from "@/lib/fixture-bye";
import { engineBracketRows } from "@/lib/__tests__/engine-bracket-rows";
import { rb4L4ExpectedLine, type StoredByeLine } from "@/lib/__tests__/rb4-l4-oracle";
import type { AuthCtx } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, deleteEntrant } from "../entrants";
import { redoDivision, undoDivision } from "../history";
import { moveFixture, startDivision } from "../schedule";
import { createStages, generateStageFixtures, generateStageFixturesTx, getStageRosterDrift, rebuildStageFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { BracketReconcileNoLinesError, reconcileRootBracket } from "../bracket-reconcile";
import { ByeLineSurgeryError, reopenByeLine, vacateLineToBye } from "../bracket-lines";
import { seedOrg } from "./_seed";
import { ATTACHMENT_OF, STAGE_SETUP_KINDS, attachStageSetup, type StageSetupKind } from "./_stage-setup-rig";
import { knockoutUpdateDrawOffered } from "@/lib/bracket-reconcile";
import { rosterDriftShown } from "@/lib/roster-drift-eligibility";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/** The plan's sentence (task-8-brief.md), typed here: the refusal table is the code under test. */
const AFTER_START = "Play has started, so Generate won't change the bracket. Use Add late player.";
/** Fix round 1 (I1), typed here: a redraw over organiser setup is refused and points to Rebuild. Fix round 2 (item 5):
 *  it names every kind of match setup the redraw would clear, not three of them. */
const REDRAW_OVER_SETUP =
  "The bracket would have to be drawn again, which clears match setup already on its lines (officials, team sheets, scoring devices, streams, player availability or court calls). Use Rebuild fixtures — it lists what it clears first.";
/** Fix round 2 (item 2, controller ruling), typed here: Start reconciles in place only, and names the remedy. */
const START_NEEDS_UPDATE_DRAW = "The draw needs updating — press Update draw first.";
/** Main's own copy (stages.ts, the `entrants.length < 2` refusal) — X-SD-1/X-SD-2 are pins: main already refuses both. */
const NOT_READY = "need at least 2 active entrants to generate";

interface SportPick {
  key: string;
  variant: string;
  kind: "individual" | "pair" | "team";
}
const BADMINTON: SportPick = { key: "badminton", variant: "bwf", kind: "individual" };

/** A sport's pick from the engine's own declarations: its default entrant kind and first variant. */
function pickOf(m: (typeof builtinModules)[number]): SportPick {
  const variant = Object.keys(m.variants)[0];
  if (variant === undefined) throw new Error(`sport ${m.key} declares no variant`);
  return { key: m.key, variant, kind: (m.entrantModel?.defaultKind ?? "individual") as SportPick["kind"] };
}

/** An entrant of the sport's own kind: one inline person per seat, at most two (`entrantKindCap`). */
function entrantInput(kind: SportPick["kind"], name: string, seed: number | null) {
  const seats = Math.min(2, entrantKindCap(kind));
  return {
    kind,
    display_name: name,
    seed,
    members: Array.from({ length: seats }, (_, i) => ({
      new_person: { full_name: `${name} m${i + 1} ${randomUUID().slice(0, 4)}` },
      is_captain: false,
      roles: [],
    })),
  };
}

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  sport: SportPick;
  ids: string[];
  add(name: string, seed?: number | null): Promise<string>;
}

/** A division of `n` entrants (unseeded unless `seeds` says otherwise) and one root knockout stage, generated. */
async function rig(opts: { n: number; sport?: SportPick; seeds?: (number | null)[]; thirdPlace?: boolean; generate?: boolean }): Promise<Rig> {
  const sport = opts.sport ?? BADMINTON;
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W4 T8 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sport.key,
    variant_key: sport.variant,
    config: {},
  });
  const made = await createEntrants(
    auth,
    division.id,
    Array.from({ length: opts.n }, (_, i) => entrantInput(sport.kind, `P${i + 1}`, opts.seeds?.[i] ?? null)),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "knockout",
    name: "KO",
    config: opts.thirdPlace ? { thirdPlace: true } : {},
    progression: null,
  });
  if (opts.generate !== false) await generateStageFixtures(auth, stage!.id);
  return {
    auth,
    divisionId: division.id,
    stageId: stage!.id,
    sport,
    ids: made.map((e) => e.id),
    add: async (name, seed = null) => (await createEntrants(auth, division.id, [entrantInput(sport.kind, name, seed)]))[0]!.id,
  };
}

interface Row {
  id: string;
  ext_key: string | null;
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_slot_label: { key?: string; params?: Record<string, unknown> } | null;
  away_slot_label: { key?: string; params?: Record<string, unknown> } | null;
  status: string;
  outcome: { kind?: string; reason?: string; winner?: string; loser?: string | null } | null;
  winner_to_fixture: string | null;
  winner_to_slot: number | null;
  scheduled_at: Date | null;
  is_final: boolean;
}

async function rowsOf(stageId: string): Promise<Row[]> {
  return sql<Row[]>`
    select id, ext_key, pool_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, home_slot_label, away_slot_label,
           status, outcome, winner_to_fixture, winner_to_slot, scheduled_at, is_final
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
}

/** The stored round-1 bye lines (a `bye` award over one seat), for the oracle. */
function storedByeLines(rows: readonly Row[]): StoredByeLine[] {
  return rows
    .filter((r) => r.round_no === 1 && r.outcome?.kind === "award" && r.outcome.reason === "bye" && r.outcome.winner)
    .map((r) => ({ lineId: r.id, holderId: r.outcome!.winner!, seq: r.seq_in_round }));
}

async function seedsOf(divisionId: string): Promise<Map<string, number | null>> {
  const rows = await sql<{ id: string; seed: number | null }[]>`select id, seed from entrants where division_id = ${divisionId}`;
  return new Map(rows.map((r) => [r.id, r.seed]));
}

async function activeIds(divisionId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from entrants where division_id = ${divisionId} and status in ('registered', 'confirmed')`;
  return rows.map((r) => r.id).sort();
}

/** Round 1's seated entrants, one entry per seat (a repeat would show twice). */
const roundOneSeats = (rows: readonly Row[]): string[] =>
  rows
    .filter((r) => r.round_no === 1)
    .flatMap((r) => [r.home_entrant_id, r.away_entrant_id])
    .filter((id): id is string => id !== null)
    .sort();

/** Every line's seats, status, outcome and labels — what a surgery may change. */
const shapeOf = (r: Row) => JSON.stringify([r.home_entrant_id, r.away_entrant_id, r.status, r.outcome, r.home_slot_label, r.away_slot_label]);

async function generateLedgerRows(divisionId: string, stageId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from division_events
     where division_id = ${divisionId} and type = 'fixtures_generated' and payload->>'stage_id' = ${stageId}`;
  return n;
}

/** Rows per round, as a sorted "round:count" list. */
const perRound = (rows: readonly { round_no: number }[]): string[] => {
  const counts = new Map<number, number>();
  for (const r of rows) counts.set(r.round_no, (counts.get(r.round_no) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a - b).map(([round, n]) => `${round}:${n}`);
};

/** The 6 → 7 case on `r` (generated with six): the newcomer takes RB4-L4's line, in place. Returns what it checked. */
async function sixToSeven(r: Rig): Promise<{ wantLine: string; firstBye: string }> {
  const before = await rowsOf(r.stageId);
  const stored = storedByeLines(before);
  expect(stored.length, "premise: six in a bracket of eight hold two byes").toBe(2);
  const want = rb4L4ExpectedLine(stored, await seedsOf(r.divisionId), before.filter((x) => x.round_no === 1).length);
  if (want === null) throw new Error("premise: two byes, so the oracle names a line");
  const firstBye = [...stored].sort((a, b) => a.seq - b.seq)[0]!.lineId;
  const holder = stored.find((l) => l.lineId === want)!.holderId;
  const late = await r.add("P7");

  const out = await generateStageFixtures(r.auth, r.stageId);
  expect(out.reconcile, "FX-G2: placed in place").toEqual({ kind: "in_place", placed: [late], vacated: [], vacated_seats: 0 });
  expect(out.created, "no row inserted").toBe(0);
  const after = await rowsOf(r.stageId);
  expect(after.map((x) => x.id).sort(), "the same lines: none inserted, none deleted").toEqual(before.map((x) => x.id).sort());

  const line = after.find((x) => x.id === want)!;
  expect([line.home_entrant_id, line.away_entrant_id].sort(), "RB4-L4: the newcomer meets the holder").toEqual([holder, late].sort());
  expect([line.status, line.outcome, line.home_slot_label, line.away_slot_label], "the bye is a match again").toEqual(["scheduled", null, null, null]);
  // The holder's round-2 seat is TBD again, labelled as every Generate labels a seat a real line feeds.
  const next = after.find((x) => x.id === line.winner_to_fixture)!;
  const seat = line.winner_to_slot === 1 ? "home" : "away";
  expect(next[`${seat}_entrant_id`], "the displaced holder is out of the next line").toBeNull();
  const label = { key: "slot.winner_match", params: { round: line.round_no, seq: line.seq_in_round } };
  expect(next[`${seat}_slot_label`]).toEqual(label);
  // The positive pair: a seat a real line fed from the first Generate carries the same shape.
  const realFed = before.find((x) => x.round_no === 1 && !isByeLine(x as never) && x.winner_to_fixture !== null)!;
  const realNext = before.find((x) => x.id === realFed.winner_to_fixture)!;
  expect(realNext[realFed.winner_to_slot === 1 ? "home_slot_label" : "away_slot_label"]).toEqual({
    key: "slot.winner_match",
    params: { round: realFed.round_no, seq: realFed.seq_in_round },
  });
  // Nothing else moved.
  let untouched = 0;
  for (const b of before) {
    if (b.id === line.id || b.id === next.id) continue;
    expect(shapeOf(after.find((x) => x.id === b.id)!), `line ${b.ext_key}`).toBe(shapeOf(b));
    untouched++;
  }
  expect(untouched, "anti-vacuity: the other lines compared").toBe(before.length - 2);
  expect(roundOneSeats(after), "every active entrant seated exactly once").toEqual(await activeIds(r.divisionId));
  return { wantLine: want, firstBye };
}

/** The 8 → 9 case on `r` (generated with eight): one regenerate, the engine's bracket of nine, one final, every entrant
 *  seated once, the final keeping its time. */
async function eightToNine(r: Rig): Promise<void> {
  const before = await rowsOf(r.stageId);
  const oldFinal = before.find((x) => x.is_final)!;
  await sql`update fixtures set scheduled_at = '2030-06-15T18:00:00Z' where id = ${oldFinal.id}`;
  const ledger = await generateLedgerRows(r.divisionId, r.stageId);
  const late = await r.add("P9");
  const out = await generateStageFixtures(r.auth, r.stageId);
  expect(out.reconcile?.kind, "FX-G2: across a power of two, regenerate").toBe("regenerated");
  expect(out.reconcile?.placed).toEqual([late]);
  const after = await rowsOf(r.stageId);
  expect(perRound(after), "the engine's bracket of nine, once").toEqual(perRound(engineBracketRows(9, false)));
  expect(after.filter((x) => x.is_final).length, "one final").toBe(1);
  expect(roundOneSeats(after), "every active entrant seated exactly once").toEqual(await activeIds(r.divisionId));
  expect(after.find((x) => x.is_final)!.scheduled_at?.toISOString(), "the final keeps the final's time (by role)").toBe("2030-06-15T18:00:00.000Z");
  expect(await generateLedgerRows(r.divisionId, r.stageId), "one regenerate, one ledger row").toBe(ledger + 1);
}

describe.skipIf(!HAS_DB)("FX-G2 Generate before Start reconciles the bracket", () => {
  it("FX-G2 6→7: Generate seats the newcomer on the lowest-seeded bye line — here the LATER draw position, not the first bye", async () => {
    const r = await rig({ n: 6 });
    const ledger = await generateLedgerRows(r.divisionId, r.stageId);
    const { wantLine, firstBye } = await sixToSeven(r);
    expect(wantLine, "the differential: RB4-L4's line is not the first bye").not.toBe(firstBye);
    expect(await generateLedgerRows(r.divisionId, r.stageId), "an in-place reconcile appends no generate row").toBe(ledger);
    // Sequence: a second Generate after the placement is a named no-op.
    const again = await generateStageFixtures(r.auth, r.stageId);
    expect(again.reconcile).toEqual({ kind: "noop", placed: [], vacated: [], vacated_seats: 0 });
  });

  it("FX-G2 6→7 with seeds: the lowest-seeded holder's bye even where it is the EARLIER draw position", async () => {
    // Seeds 1 and 2 hold the byes (RB4-D2), P1 on the top line. P1 is then unseeded before Start, so P1 — at the top of
    // the draw — is now the lowest-seeded holder: the seed decides, against the draw position.
    const r = await rig({ n: 6, seeds: [1, 2, null, null, null, null] });
    const [p1, p2] = [r.ids[0]!, r.ids[1]!];
    await sql`update entrants set seed = null where id = ${p1}`;
    const stored = storedByeLines(await rowsOf(r.stageId));
    expect(stored.map((l) => l.holderId).sort(), "premise: seeds 1 and 2 hold the byes").toEqual([p1, p2].sort());
    const later = [...stored].sort((a, b) => b.seq - a.seq)[0]!;
    const want = rb4L4ExpectedLine(stored, await seedsOf(r.divisionId), 4);
    expect(stored.find((l) => l.lineId === want)!.holderId, "premise: the oracle picks the unseeded P1").toBe(p1);
    expect(want, "the differential: not the later draw position").not.toBe(later.lineId);
    const { wantLine } = await sixToSeven(r);
    expect(wantLine).toBe(want);
  });

  it("FX-G2 7→6: a removed entrant's line becomes a bye and Generate answers 200 (MB-004/005; main 500'd)", async () => {
    const r = await rig({ n: 7 });
    const before = await rowsOf(r.stageId);
    const real = before.find((x) => x.round_no === 1 && x.home_entrant_id !== null && x.away_entrant_id !== null)!;
    const [stayer, leaver] = [real.home_entrant_id!, real.away_entrant_id!];
    await withdrawEntrantCascade(r.auth, leaver);
    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.reconcile).toEqual({ kind: "in_place", placed: [], vacated: [leaver], vacated_seats: 1 });
    const after = await rowsOf(r.stageId);
    expect(after.map((x) => x.id).sort(), "the same lines").toEqual(before.map((x) => x.id).sort());
    const line = after.find((x) => x.id === real.id)!;
    expect([line.home_entrant_id, line.away_entrant_id, line.away_slot_label], "the leaver's seat is the bye's phantom").toEqual([stayer, null, BYE_SLOT_LABEL]);
    expect([line.status, line.outcome], "the stayer is awarded the bye").toEqual(["forfeited", byeAward(stayer)]);
    expect(isByeLine(line as never), "the product's one bye predicate reads it as a bye").toBe(true);
    const next = after.find((x) => x.id === real.winner_to_fixture)!;
    const seat = real.winner_to_slot === 1 ? "home" : "away";
    expect([next[`${seat}_entrant_id`], next[`${seat}_slot_label`]], "the bye carries the stayer on, the label cleared with the fill").toEqual([stayer, null]);
    expect(roundOneSeats(after), "every active entrant seated exactly once").toEqual(await activeIds(r.divisionId));
  });

  it("FX-G2 7→6 when the leaver HELD a bye: nobody is left on that line, so the bracket regenerates", async () => {
    const r = await rig({ n: 7 });
    const holder = storedByeLines(await rowsOf(r.stageId))[0]!.holderId;
    await withdrawEntrantCascade(r.auth, holder);
    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.reconcile?.kind).toBe("regenerated");
    expect(out.reconcile?.vacated).toEqual([holder]);
    const after = await rowsOf(r.stageId);
    expect(perRound(after)).toEqual(perRound(engineBracketRows(6, false)));
    expect(roundOneSeats(after)).toEqual(await activeIds(r.divisionId));
    expect(storedByeLines(after).length, "six in eight: two byes").toBe(2);
  });

  it("FX-G2 8→9 regenerates once: every active entrant seated exactly once, one final", async () => {
    await eightToNine(await rig({ n: 8 }));
  });

  it("FX-G2 9→8 regenerates once", async () => {
    const r = await rig({ n: 9 });
    const before = await rowsOf(r.stageId);
    const oldFinal = before.find((x) => x.is_final)!;
    await sql`update fixtures set scheduled_at = '2030-06-15T18:00:00Z' where id = ${oldFinal.id}`;
    const leaver = r.ids[4]!;
    await withdrawEntrantCascade(r.auth, leaver);
    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.reconcile).toMatchObject({ kind: "regenerated", placed: [], vacated: [leaver] });
    const after = await rowsOf(r.stageId);
    expect(perRound(after), "the engine's bracket of eight").toEqual(perRound(engineBracketRows(8, false)));
    expect(after.filter((x) => x.is_final).length).toBe(1);
    expect(roundOneSeats(after)).toEqual(await activeIds(r.divisionId));
    expect(roundOneSeats(after)).not.toContain(leaver);
    expect(after.find((x) => x.is_final)!.scheduled_at?.toISOString(), "the final keeps its time").toBe("2030-06-15T18:00:00.000Z");
  });

  it("FX-G2 a second Generate with no roster change is a named no-op", async () => {
    const r = await rig({ n: 6, thirdPlace: true });
    const before = await rowsOf(r.stageId);
    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.reconcile).toEqual({ kind: "noop", placed: [], vacated: [], vacated_seats: 0 });
    expect(out.created).toBe(0);
    expect((await rowsOf(r.stageId)).map(shapeOf)).toEqual(before.map(shapeOf));
  });
});

describe.skipIf(!HAS_DB)("X-SD-1 / X-SD-2 an empty or one-entrant field refuses by name (pins: main already refuses both)", () => {
  it(`X-SD-1 every entrant gone before Start refuses by name: STAGE_NOT_READY "${NOT_READY}", the bracket untouched`, async () => {
    const r = await rig({ n: 3 });
    const before = await rowsOf(r.stageId);
    for (const id of r.ids) await withdrawEntrantCascade(r.auth, id);
    await expect(generateStageFixtures(r.auth, r.stageId)).rejects.toMatchObject({ code: "STAGE_NOT_READY", message: NOT_READY });
    expect((await rowsOf(r.stageId)).map(shapeOf), "never an empty bracket").toEqual(before.map(shapeOf));
  });

  it(`X-SD-2 one entrant refuses "${NOT_READY}"`, async () => {
    const lone = await rig({ n: 1, generate: false });
    await expect(generateStageFixtures(lone.auth, lone.stageId)).rejects.toMatchObject({ code: "STAGE_NOT_READY", message: NOT_READY });
    expect(await rowsOf(lone.stageId)).toEqual([]);
    // And the sequence: two generated, one withdrawn, Generate again.
    const r = await rig({ n: 2 });
    const before = await rowsOf(r.stageId);
    await withdrawEntrantCascade(r.auth, r.ids[1]!);
    await expect(generateStageFixtures(r.auth, r.stageId)).rejects.toMatchObject({ code: "STAGE_NOT_READY", message: NOT_READY });
    expect((await rowsOf(r.stageId)).map(shapeOf)).toEqual(before.map(shapeOf));
  });
});

describe.skipIf(!HAS_DB)("FX-G2 after Start Generate never reshapes", () => {
  async function started(n: number): Promise<Rig> {
    const r = await rig({ n });
    await startDivision(r.auth, r.divisionId);
    return r;
  }
  async function refused(r: Rig): Promise<void> {
    const before = await rowsOf(r.stageId);
    const err = await generateStageFixtures(r.auth, r.stageId).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect([(err as HttpError).status, (err as HttpError).code, (err as HttpError).message]).toEqual([409, "KO_GENERATE_AFTER_START", AFTER_START]);
    expect((await rowsOf(r.stageId)).map(shapeOf), "fixtures unchanged").toEqual(before.map(shapeOf));
  }

  it("FX-G2 after Start Generate never reshapes: an arrival (added by SQL, as an automatic door would) → KO_GENERATE_AFTER_START", async () => {
    const r = await started(6);
    const [org] = await sql<{ org_id: string }[]>`select org_id from divisions where id = ${r.divisionId}`;
    await sql`insert into entrants (org_id, division_id, kind, display_name) values (${org!.org_id}, ${r.divisionId}, 'individual', 'Arrival')`;
    await refused(r);
  });

  it("after Start, a withdrawal then Generate (MB-004's sequence) is the named no-op twice — the cascade already walked it over; never a 500, never a reshape", async () => {
    const r = await started(8);
    const real = (await rowsOf(r.stageId)).find((x) => x.round_no === 1 && x.home_entrant_id !== null && x.away_entrant_id !== null)!;
    await withdrawEntrantCascade(r.auth, real.away_entrant_id!);
    const before = await rowsOf(r.stageId);
    // The premise: the withdrawal's own cascade changed the line (a walkover), so a no-op leaves a bracket that shows it.
    expect(before.find((x) => x.id === real.id)!.status, "the cascade walked the line over").not.toBe("scheduled");
    for (const call of [1, 2]) {
      const out = await generateStageFixtures(r.auth, r.stageId);
      expect(out.reconcile, `call ${call}`).toEqual({ kind: "noop", placed: [], vacated: [], vacated_seats: 0 });
      expect(out.created, `call ${call}`).toBe(0);
      expect((await rowsOf(r.stageId)).map(shapeOf), `call ${call}: fixtures unchanged`).toEqual(before.map(shapeOf));
    }
  });

  it("after Start, a withdrawal AND an arrival → KO_GENERATE_AFTER_START (the arrival decides; the departure does not excuse it)", async () => {
    const r = await started(8);
    const real = (await rowsOf(r.stageId)).find((x) => x.round_no === 1 && x.home_entrant_id !== null && x.away_entrant_id !== null)!;
    await withdrawEntrantCascade(r.auth, real.away_entrant_id!);
    const [org] = await sql<{ org_id: string }[]>`select org_id from divisions where id = ${r.divisionId}`;
    await sql`insert into entrants (org_id, division_id, kind, display_name) values (${org!.org_id}, ${r.divisionId}, 'individual', 'Arrival')`;
    await refused(r);
  });

  it("after Start with the roster unchanged, Generate is still the named no-op (the positive pair)", async () => {
    const r = await started(6);
    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.reconcile).toEqual({ kind: "noop", placed: [], vacated: [], vacated_seats: 0 });
  });
});

describe.skipIf(!HAS_DB)("R27: every sport in the engine registry reconciles alike before Start", () => {
  it("6→7 places in place and 8→9 regenerates once, for every builtin sport (count = the registry)", async () => {
    let sports = 0;
    for (const m of builtinModules) {
      const sport = pickOf(m);
      await sixToSeven(await rig({ n: 6, sport }));
      await eightToNine(await rig({ n: 8, sport }));
      sports++;
    }
    console.info(`R27 FX-G2: ${sports} sports reconciled (6→7 and 8→9 each)`);
    expect(builtinModules.length).toBeGreaterThan(0);
    expect(sports, "anti-vacuity: every registry sport").toBe(builtinModules.length);
  }, 600_000);
});

describe.skipIf(!HAS_DB)("guards: the driver and the surgeries refuse by name", () => {
  it("the driver is never asked to reconcile a stage with no lines (a first Generate is not a reconcile)", async () => {
    const r = await rig({ n: 4, generate: false });
    await expect(
      sql.begin((tx) => reconcileRootBracket(tx as never, { stageId: r.stageId, started: false, active: r.ids.map((id) => ({ id, seed: null })), fresh: [] })),
    ).rejects.toBeInstanceOf(BracketReconcileNoLinesError);
  });

  it("vacateLineToBye refuses a line that is already a bye; reopenByeLine refuses a line that is not one", async () => {
    const r = await rig({ n: 6 });
    const rows = await rowsOf(r.stageId);
    const bye = rows.find((x) => x.round_no === 1 && isByeLine(x as never))!;
    const real = rows.find((x) => x.round_no === 1 && !isByeLine(x as never))!;
    // Each refused by name, for ITS reason: a bye is also not "scheduled" and a real line has no phantom seat, so a bare
    // instanceOf would pass with either shape guard deleted (mutation M4/M5 survived it).
    const vacated = await sql.begin((tx) => vacateLineToBye(tx as never, bye.id, "home")).then(() => null, (e: unknown) => e);
    expect(vacated).toBeInstanceOf(ByeLineSurgeryError);
    expect((vacated as Error).message).toMatch(/the line is already a bye$/);
    const reopened = await sql.begin((tx) => reopenByeLine(tx as never, real.id, r.ids[0]!)).then(() => null, (e: unknown) => e);
    expect(reopened).toBeInstanceOf(ByeLineSurgeryError);
    expect((reopened as Error).message).toMatch(/the line is not a bye$/);
    expect((await rowsOf(r.stageId)).map(shapeOf), "nothing written").toEqual(rows.map(shapeOf));
  });

  it("the next-seat guards: reopenByeLine refuses when its holder is not in the seat the bye feeds; vacateLineToBye refuses when the seat its line feeds is taken — each rolled back whole", async () => {
    const r = await rig({ n: 6 });
    const rows = await rowsOf(r.stageId);
    const bye = rows.find((x) => x.round_no === 1 && isByeLine(x as never))!;
    const real = rows.find((x) => x.round_no === 1 && !isByeLine(x as never))!;
    // (a) the holder taken out of the seat its bye feeds (by hand: no product path does it) — reopen must not guess.
    const seatCol = (slot: number | null) => (slot === 1 ? "home_entrant_id" : "away_entrant_id");
    await sql`update fixtures set ${sql(seatCol(bye.winner_to_slot))} = null where id = ${bye.winner_to_fixture!}`;
    const holderGone = await rowsOf(r.stageId);
    await expect(sql.begin((tx) => reopenByeLine(tx as never, bye.id, r.ids[0]!))).rejects.toThrow(/is not in the seat the line feeds/);
    expect((await rowsOf(r.stageId)).map(shapeOf), "reopen: nothing written").toEqual(holderGone.map(shapeOf));
    // (b) someone already sitting in the seat the real line feeds — vacate must not overwrite them.
    const next = holderGone.find((x) => x.id === real.winner_to_fixture)!;
    const outsider = r.ids.find((id) => id !== next.home_entrant_id && id !== next.away_entrant_id && id !== real.home_entrant_id && id !== real.away_entrant_id)!;
    await sql`update fixtures set ${sql(seatCol(real.winner_to_slot))} = ${outsider}, ${sql(real.winner_to_slot === 1 ? "home_slot_label" : "away_slot_label")} = null where id = ${next.id}`;
    const seatTaken = await rowsOf(r.stageId);
    await expect(sql.begin((tx) => vacateLineToBye(tx as never, real.id, "away"))).rejects.toThrow(/the seat the line feeds is already taken/);
    expect((await rowsOf(r.stageId)).map(shapeOf), "vacate: nothing written").toEqual(seatTaken.map(shapeOf));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// B2 fix round 1.

/** Organiser setup on a line, of a kind a delete cascades into (`_stage-setup-rig.ts` — what Rebuild's confirm names). */
async function attachSetup(r: Rig, kind: StageSetupKind, fixtureId: string): Promise<void> {
  await attachStageSetup(r.auth, kind, fixtureId);
}

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(HttpError);
  return err as HttpError;
}

/** No entrant that is not active sits on a line still to be played (`scheduled`/`in_play`). */
async function ghostsOnPendingLines(r: Rig): Promise<string[]> {
  const active = new Set(await activeIds(r.divisionId));
  return (await rowsOf(r.stageId))
    .filter((x) => x.status === "scheduled" || x.status === "in_play")
    .flatMap((x) => [x.home_entrant_id, x.away_entrant_id])
    .filter((id): id is string => id !== null && !active.has(id));
}

describe.skipIf(!HAS_DB)("fix round 1 I1: Generate never redraws over organiser setup", () => {
  // Fix round 2 (item 5): every kind of setup that can exist before Start — streams, YouTube broadcasts, player
  // availability and Match Day calls joined officials, team sheets and devices.
  it("8→9 with any one kind of match setup on a line: refused 409 KO_REDRAW_WOULD_CLEAR_SETUP, nothing deleted (each kind)", async () => {
    let checked = 0;
    for (const kind of STAGE_SETUP_KINDS) {
      const r = await rig({ n: 8 });
      const before = await rowsOf(r.stageId);
      await attachSetup(r, kind, before.find((x) => x.round_no === 1)!.id);
      await r.add("P9");
      const err = await refusal(generateStageFixtures(r.auth, r.stageId));
      expect([err.status, err.code, err.message], kind).toEqual([409, "KO_REDRAW_WOULD_CLEAR_SETUP", REDRAW_OVER_SETUP]);
      expect((await rowsOf(r.stageId)).map((x) => x.id), `${kind}: the same lines`).toEqual(before.map((x) => x.id));
      checked++;
    }
    expect(checked).toBe(STAGE_SETUP_KINDS.length);
    expect(checked).toBe(8);
  });

  // Two kinds live in sealed tables the tenant role cannot read; Generate's privileged prelude reads them. A pass whose
  // caller never did must not redraw on a guess of "nothing attached".
  it("a Generate pass whose caller never read the sealed setup refuses the redraw rather than guess, and writes nothing", async () => {
    const r = await rig({ n: 8 });
    await r.add("P9");
    const before = await rowsOf(r.stageId);
    await expect(withTenant(r.auth.orgId, (tx) => generateStageFixturesTx(tx, r.auth, r.stageId, {}))).rejects.toThrow(
      /sealed setup counts were not read/,
    );
    expect((await rowsOf(r.stageId)).map((x) => x.id)).toEqual(before.map((x) => x.id));
  });

  it("setup on a line does not block a change IN PLACE (6→7 places the newcomer; the setup stays)", async () => {
    const r = await rig({ n: 6 });
    const real = (await rowsOf(r.stageId)).find((x) => x.round_no === 1 && !isByeLine(x as never))!;
    await attachSetup(r, "lineup", real.id);
    const late = await r.add("P7");
    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.reconcile).toMatchObject({ kind: "in_place", placed: [late] });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from lineups where fixture_id = ${real.id}`;
    expect(n, "the team sheet survives").toBe(1);
  });

  it("a redraw with nothing attached proceeds and reports its slots (the positive pair)", async () => {
    const r = await rig({ n: 8 });
    await r.add("P9");
    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.reconcile?.kind).toBe("regenerated");
    expect(out.reconcile?.slots, "the slot counts ride the answer").toEqual({ kept: 0, freed: 0, unscheduled: 0 });
  });
});

describe.skipIf(!HAS_DB)("fix round 1 I2: the departures in-place cannot express, and a deleted seat", () => {
  it("(a) both players of one first-round match leave before Start (8→6): one redraw, nobody gone on a line, every player seated once", async () => {
    const r = await rig({ n: 8 });
    const line = (await rowsOf(r.stageId)).find((x) => x.round_no === 1 && x.home_entrant_id !== null && x.away_entrant_id !== null)!;
    await withdrawEntrantCascade(r.auth, line.home_entrant_id!);
    await withdrawEntrantCascade(r.auth, line.away_entrant_id!);
    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.reconcile).toMatchObject({ kind: "regenerated", placed: [], vacated_seats: 2 });
    expect([...out.reconcile!.vacated].sort()).toEqual([line.home_entrant_id, line.away_entrant_id].sort());
    const after = await rowsOf(r.stageId);
    expect(perRound(after), "the engine's bracket of six").toEqual(perRound(engineBracketRows(6, false)));
    expect(roundOneSeats(after)).toEqual(await activeIds(r.divisionId));
    expect(await ghostsOnPendingLines(r)).toEqual([]);
  });

  it("(b) an entrant DELETED from a real line before Start: the line becomes a bye for the stayer, and the answer counts the seat", async () => {
    const r = await rig({ n: 8 });
    const line = (await rowsOf(r.stageId)).find((x) => x.round_no === 1 && x.home_entrant_id !== null && x.away_entrant_id !== null)!;
    await deleteEntrant(r.auth, line.away_entrant_id!);
    const premise = (await rowsOf(r.stageId)).find((x) => x.id === line.id)!;
    expect([premise.away_entrant_id, premise.status], "premise: the FK emptied the seat on a scheduled match").toEqual([null, "scheduled"]);
    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.reconcile, "a seat was vacated, never 'up to date'").toEqual({ kind: "in_place", placed: [], vacated: [], vacated_seats: 1 });
    const after = (await rowsOf(r.stageId)).find((x) => x.id === line.id)!;
    expect(isByeLine(after as never), "the line is now a bye").toBe(true);
    expect(after.outcome).toEqual(byeAward(line.home_entrant_id!));
    expect(roundOneSeats(await rowsOf(r.stageId))).toEqual(await activeIds(r.divisionId));
  });

  it("(c) a bye HOLDER deleted before Start: nobody is left on that line, so the bracket is drawn again once", async () => {
    const r = await rig({ n: 6 });
    const bye = storedByeLines(await rowsOf(r.stageId))[0]!;
    await deleteEntrant(r.auth, bye.holderId);
    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.reconcile?.kind).toBe("regenerated");
    const after = await rowsOf(r.stageId);
    expect(perRound(after), "the engine's bracket of five").toEqual(perRound(engineBracketRows(5, false)));
    expect(roundOneSeats(after)).toEqual(await activeIds(r.divisionId));
    expect(after.filter((x) => x.round_no === 1 && x.status === "scheduled" && (x.home_entrant_id === null || x.away_entrant_id === null)).length, "no empty seat on a match").toBe(0);
  });
});

describe.skipIf(!HAS_DB)("fix round 1 G1: Start reconciles a root knockout that already has its lines", () => {
  it("withdraw before Start, then Start WITHOUT Generate: no withdrawn entrant sits on a line still to be played", async () => {
    const r = await rig({ n: 8 });
    const line = (await rowsOf(r.stageId)).find((x) => x.round_no === 1 && x.home_entrant_id !== null && x.away_entrant_id !== null)!;
    await withdrawEntrantCascade(r.auth, line.away_entrant_id!);
    expect(await ghostsOnPendingLines(r), "premise: before Start the withdrawn entrant still sits on the match").toEqual([line.away_entrant_id]);
    const started = await startDivision(r.auth, r.divisionId);
    expect(started.started).toBe(true);
    expect(await ghostsOnPendingLines(r)).toEqual([]);
    expect(isByeLine((await rowsOf(r.stageId)).find((x) => x.id === line.id)! as never), "the stayer has a bye").toBe(true);
  });

  it("an entrant DELETED from a real line before Start: Start makes the line a bye for the stayer — no match starts with an empty seat", async () => {
    const r = await rig({ n: 8 });
    const line = (await rowsOf(r.stageId)).find((x) => x.round_no === 1 && x.home_entrant_id !== null && x.away_entrant_id !== null)!;
    await deleteEntrant(r.auth, line.away_entrant_id!);
    await startDivision(r.auth, r.divisionId);
    const after = await rowsOf(r.stageId);
    expect(isByeLine(after.find((x) => x.id === line.id)! as never), "the stayer has a bye").toBe(true);
    expect(after.filter((x) => x.round_no === 1 && x.status === "scheduled" && (x.home_entrant_id === null || x.away_entrant_id === null)).length).toBe(0);
  });

  it("a player added before Start is placed by Start (6→7 in place)", async () => {
    const r = await rig({ n: 6 });
    const late = await r.add("P7");
    await startDivision(r.auth, r.divisionId);
    expect(roundOneSeats(await rowsOf(r.stageId))).toEqual(await activeIds(r.divisionId));
    expect(roundOneSeats(await rowsOf(r.stageId))).toContain(late);
  });

  // Fix round 2 (item 2, controller ruling): Start reconciles IN PLACE ONLY. A redraw deletes every line — printed sheets
  // stop, slots move, public pages hold the old lines — and Start has no notice to say so; Update draw does. So every
  // cause a redraw has is refused at Start by name, before any write, organiser setup or none.
  it("Start never redraws: each cause of a redraw refuses 409 KO_START_NEEDS_UPDATE_DRAW, nothing deleted or changed, the division stays in setup", async () => {
    const causes: [string, () => Promise<Rig>][] = [
      ["8→9: a newcomer with no bye to take", async () => {
        const r = await rig({ n: 8 });
        await r.add("P9");
        return r;
      }],
      ["P2: 8 drawn, both players of one first-round match withdraw", async () => {
        const r = await rig({ n: 8 });
        const line = (await rowsOf(r.stageId)).find((x) => x.round_no === 1 && x.home_entrant_id !== null && x.away_entrant_id !== null)!;
        await withdrawEntrantCascade(r.auth, line.home_entrant_id!);
        await withdrawEntrantCascade(r.auth, line.away_entrant_id!);
        return r;
      }],
      ["8→9 with a team sheet on a line (the setup refusal is Update draw's to give, never Start's)", async () => {
        const r = await rig({ n: 8 });
        await attachSetup(r, "lineup", (await rowsOf(r.stageId)).find((x) => x.round_no === 1)!.id);
        await r.add("P9");
        return r;
      }],
    ];
    let checked = 0;
    for (const [cause, make] of causes) {
      const r = await make();
      const before = await rowsOf(r.stageId);
      const err = await refusal(startDivision(r.auth, r.divisionId));
      expect([err.status, err.code, err.message], cause).toEqual([409, "KO_START_NEEDS_UPDATE_DRAW", START_NEEDS_UPDATE_DRAW]);
      const [d] = await sql<{ status: string }[]>`select status from divisions where id = ${r.divisionId}`;
      expect(d!.status, cause).toBe("setup");
      const after = await rowsOf(r.stageId);
      expect(after.map((x) => x.id), `${cause}: the same lines`).toEqual(before.map((x) => x.id));
      expect(after.map(shapeOf), `${cause}: unchanged`).toEqual(before.map(shapeOf));
      checked++;
    }
    expect(checked).toBe(causes.length);
  });

  // Fix round 2 (item 4): the fourth clause of Start's `roster_drift` read (schedule.ts) — a first-round bye with nobody on
  // it. Only that clause sees this case: the deleted holder is no entrant at all, so no other clause fires.
  it("a bye HOLDER deleted before Start: Start refuses KO_START_NEEDS_UPDATE_DRAW and starts nothing (a bye with nobody on it is never started)", async () => {
    const r = await rig({ n: 6 });
    const bye = storedByeLines(await rowsOf(r.stageId))[0]!;
    await deleteEntrant(r.auth, bye.holderId);
    const before = await rowsOf(r.stageId);
    expect(
      before.filter((x) => x.round_no === 1 && x.home_entrant_id === null && x.away_entrant_id === null).length,
      "premise: the FK left a first-round line with nobody on it",
    ).toBe(1);
    const err = await refusal(startDivision(r.auth, r.divisionId));
    expect([err.status, err.code]).toEqual([409, "KO_START_NEEDS_UPDATE_DRAW"]);
    const [d] = await sql<{ status: string }[]>`select status from divisions where id = ${r.divisionId}`;
    expect(d!.status).toBe("setup");
    expect((await rowsOf(r.stageId)).map(shapeOf)).toEqual(before.map(shapeOf));
  });

  it("the remedy Start names works: after its refusal, Update draw redraws once, and Start then starts with every player seated once", async () => {
    const r = await rig({ n: 8 });
    const line = (await rowsOf(r.stageId)).find((x) => x.round_no === 1 && x.home_entrant_id !== null && x.away_entrant_id !== null)!;
    await withdrawEntrantCascade(r.auth, line.home_entrant_id!);
    await withdrawEntrantCascade(r.auth, line.away_entrant_id!);
    expect((await refusal(startDivision(r.auth, r.divisionId))).code).toBe("KO_START_NEEDS_UPDATE_DRAW");
    const drawn = await generateStageFixtures(r.auth, r.stageId);
    expect(drawn.reconcile?.kind, "Update draw is the redraw, with its notice").toBe("regenerated");
    const started = await startDivision(r.auth, r.divisionId);
    expect([started.started, started.generated]).toEqual([true, 0]);
    expect(roundOneSeats(await rowsOf(r.stageId))).toEqual(await activeIds(r.divisionId));
    expect(await ghostsOnPendingLines(r)).toEqual([]);
  });

  it("Start with the roster unchanged changes no line (the positive pair) — not even when the stage's config moved since the draw", async () => {
    let checked = 0;
    for (const configMoved of [false, true]) {
      const r = await rig({ n: 6 });
      const before = await rowsOf(r.stageId);
      // A config change alone (a third-place match switched on) would make a fresh draw's lines differ: Start must not
      // read that as a reason to redraw — only the roster is its business.
      if (configMoved) await sql`update stages set config = config || '{"thirdPlace": true}'::jsonb where id = ${r.stageId}`;
      await startDivision(r.auth, r.divisionId);
      expect((await rowsOf(r.stageId)).map((x) => x.id), `config moved: ${configMoved}`).toEqual(before.map((x) => x.id));
      expect((await rowsOf(r.stageId)).map(shapeOf), `config moved: ${configMoved}`).toEqual(before.map(shapeOf));
      checked++;
    }
    expect(checked).toBe(2);
  });
});

// Fix round 2 (item 1, overturns FR1-6): Delete is a primary setup button, and a deleted entrant leaves an EMPTY first-round
// place — no ghost (nobody is named) and no unplaced entrant (nobody is missing). The drift read sees it as `vacantLines`,
// so the banner (with Rebuild) and Update draw both appear, and the organiser is never stuck behind a refusal.
describe.skipIf(!HAS_DB)("fix round 2 item 1: a deleted entrant's empty first-round place is drift", () => {
  async function deskOffer(r: Rig, drift: Awaited<ReturnType<typeof getStageRosterDrift>>): Promise<boolean> {
    const [stage] = await sql<{ kind: string; progression: unknown; config: unknown }[]>`
      select kind, progression, config from stages where id = ${r.stageId}`;
    const [d] = await sql<{ status: string }[]>`select status from divisions where id = ${r.divisionId}`;
    const rows = await rowsOf(r.stageId);
    return knockoutUpdateDrawOffered({
      stage: stage!,
      divisionStatus: d!.status,
      fixtureCount: rows.length,
      matchesBegun: rows.filter((x) => !isByeLine(x as never) && x.status !== "scheduled").length,
      rosterDrifted: rosterDriftShown(drift),
    });
  }

  it("P1: 6 drawn, a scoring device linked, the bye HOLDER deleted → drift, Update draw offered and refused over the device by name, the banner's Rebuild clears it", async () => {
    const r = await rig({ n: 6 });
    const rows = await rowsOf(r.stageId);
    const real = rows.find((x) => x.round_no === 1 && !isByeLine(x as never))!;
    await attachSetup(r, "device", real.id);
    const clean = await getStageRosterDrift(r.auth, r.stageId);
    expect([clean.vacantLines, rosterDriftShown(clean), await deskOffer(r, clean)], "premise: a fresh draw is not drifted").toEqual([0, false, false]);

    await deleteEntrant(r.auth, storedByeLines(rows)[0]!.holderId);
    const drift = await getStageRosterDrift(r.auth, r.stageId);
    expect([drift.ghosts, drift.unplaced], "nobody is named: the place is empty, not held").toEqual([[], []]);
    expect(drift.vacantLines, "the bye with nobody on it").toBe(1);
    expect(drift.attachments.deviceLinks).toBe(1);
    expect(rosterDriftShown(drift), "the banner, with its Rebuild").toBe(true);
    expect(await deskOffer(r, drift), "Update draw").toBe(true);

    expect((await refusal(generateStageFixtures(r.auth, r.stageId))).code, "Update draw: a redraw over the device").toBe("KO_REDRAW_WOULD_CLEAR_SETUP");
    await rebuildStageFixtures(r.auth, r.stageId);
    const after = await getStageRosterDrift(r.auth, r.stageId);
    expect([after.vacantLines, rosterDriftShown(after)], "Rebuild settled it").toEqual([0, false]);
    expect(roundOneSeats(await rowsOf(r.stageId))).toEqual(await activeIds(r.divisionId));
  });

  it("an entrant deleted from a REAL first-round match counts too (a match with an empty seat); a withdrawal does not (it is a ghost, named)", async () => {
    const r = await rig({ n: 8 });
    const lines = (await rowsOf(r.stageId)).filter((x) => x.round_no === 1 && x.home_entrant_id !== null && x.away_entrant_id !== null);
    await deleteEntrant(r.auth, lines[0]!.away_entrant_id!);
    const deleted = await getStageRosterDrift(r.auth, r.stageId);
    expect([deleted.vacantLines, deleted.ghosts.length, rosterDriftShown(deleted)]).toEqual([1, 0, true]);
    await withdrawEntrantCascade(r.auth, lines[1]!.away_entrant_id!);
    const both = await getStageRosterDrift(r.auth, r.stageId);
    expect([both.vacantLines, both.ghosts.map((e) => e.id)]).toEqual([1, [lines[1]!.away_entrant_id]]);
  });

  it("a later round's empty seats are a bracket waiting on its winners, never drift", async () => {
    const r = await rig({ n: 8 });
    const rows = await rowsOf(r.stageId);
    expect(rows.filter((x) => x.round_no > 1 && (x.home_entrant_id === null || x.away_entrant_id === null)).length, "premise: later rounds wait on winners").toBeGreaterThan(0);
    expect((await getStageRosterDrift(r.auth, r.stageId)).vacantLines).toBe(0);
  });
});

describe.skipIf(!HAS_DB)("fix round 1 m6: a change in place clears the Redo it would make stale", () => {
  it("move a match, Undo it, its player leaves, Generate makes it a bye — the old Redo is gone, and the bye takes no time", async () => {
    const r = await rig({ n: 8 });
    const line = (await rowsOf(r.stageId)).find((x) => x.round_no === 1 && x.home_entrant_id !== null && x.away_entrant_id !== null)!;
    await moveFixture(r.auth, line.id, { scheduled_at: "2030-06-15T10:00:00.000Z" });
    await undoDivision(r.auth, r.divisionId);
    // Fix round 2 (item 6): Undo nulled the move's time, so a time is put back on the match by hand — written raw, so it
    // is no step the Redo would carry — and the bye's "no time" below is then the vacate's doing, not Undo's.
    await sql`update fixtures set scheduled_at = '2030-06-15T11:00:00.000Z' where id = ${line.id}`;
    const [mid] = await sql<{ edit_watermark: number | null; scheduled_at: Date | null }[]>`
      select d.edit_watermark, f.scheduled_at from divisions d join fixtures f on f.division_id = d.id
       where d.id = ${r.divisionId} and f.id = ${line.id}`;
    expect(mid!.edit_watermark, "premise: a Redo is waiting").not.toBeNull();
    expect(mid!.scheduled_at, "premise: the match holds a time").not.toBeNull();
    await withdrawEntrantCascade(r.auth, line.away_entrant_id!);
    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.reconcile?.kind).toBe("in_place");
    const [after] = await sql<{ edit_watermark: number | null }[]>`select edit_watermark from divisions where id = ${r.divisionId}`;
    expect(after!.edit_watermark, "the in-place Generate clears the watermark, as a Generate that creates does").toBeNull();
    await expect(redoDivision(r.auth, r.divisionId), "nothing to redo").rejects.toMatchObject({ status: 422 });
    const bye = (await rowsOf(r.stageId)).find((x) => x.id === line.id)!;
    expect([isByeLine(bye as never), bye.scheduled_at], "the bye holds no time").toEqual([true, null]);
  });
});
