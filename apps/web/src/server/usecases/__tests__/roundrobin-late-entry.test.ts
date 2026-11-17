// W5 app-A Task 5 (X-CU-4, X-CU-7, X-CU-11, X-CU-12, X-CU-13; RB5-L3..L9, L13..L16, RB5-E9) — "Add late player" on a started
// league or group stage, driven through the real door (`createEntrants`, the organiser's add) on a real database, seats asserted.
//
// differential: today (3555caa930, Task 4's interim) the add to a started league or group is ACCEPTED with no seat — even on a
// COMPLETE stage — so the late player sits on the list with no fixture; on main (before Task 4) it was refused 422 "the entrant
// list is locked" (entrants.ts:438).
//
// Expected values: the stored schedule's premise is read against the engine's own declaration (`generateRoundRobin` over the
// seeded field: its `rounds[].bye`), and each expected placement is the brief's hand derivation from RB5-L3/L6 over it (the
// five-field scene: byes r1 P5, r2 P4, r3 P3, r4 P2, r5 P1; rounds 1-2 started -> P3 r3, P2 r4, P1 r5 in their byes; P4 r6, P5 r7
// appended). Refusal sentences are typed here from the rulebook-backed table's rows, never read back.
//
// Sports: badminton, and the first engine sport whose entrants are teams (`sportFor("team")`, football on this registry).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { generateRoundRobin } from "@seazn/engine/scheduling";
import { entrantKindCap, type AnySportModule } from "@seazn/engine/sport";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { buildTemplateStages, templatesForSport } from "@/lib/format-templates";
import { decideRoundRobinLateEntry } from "@/lib/roundrobin-late-entry";
import { engineEntrantKinds } from "@/lib/__tests__/_engine-entrant-kinds";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { TableLateEntryResult } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { getCompetitionDesk } from "../competition-desk";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { undoDivision } from "../history";
import { applyTableLateDecision, readTableLatePlace, rootTableStages, type TablePlacingDecision } from "../roundrobin-late-entry";
import { moveFixture, startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages } from "../stages";
import { createCourt, createVenue } from "../venues";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** The refusal table's English rows (lib/roundrobin-refusals.ts), typed here as the oracle. */
const COMPLETE = "This stage is complete. Add the player to the next stage, or reopen the stage.";
const NOTHING = "This player already has a fixture against everyone in the pool.";
const UNKNOWN_POOL = "There's no pool with that name in this stage.";
const NOT_UNDOABLE = "Adding a late player can't be undone. Withdraw the player instead.";

type Kind = "individual" | "pair" | "team";
const moduleOf = (key: string): AnySportModule => builtinModules.find((m) => m.key === key) as AnySportModule;
const variantOf = (key: string): string => Object.keys(moduleOf(key).variants)[0]!;
const offers = (sport: string, template: string): boolean => templatesForSport(sport, engineEntrantKinds(sport)).some((t) => t.key === template);

/** The first engine sport whose natural entrant is `kind` and whose picker offers a league and groups (the registry's own declaration). */
function sportFor(kind: Kind): string {
  const m = builtinModules.find((x) => x.entrantModel?.defaultKind === kind && offers(x.key, "league") && offers(x.key, "groups_ko"));
  if (m === undefined) throw new Error(`no sport's natural entrant is a ${kind}`);
  return m.key;
}

interface Rig {
  auth: AuthCtx;
  competitionId: string;
  divisionId: string;
  stageId: string;
  kind: Kind;
  /** Entrant id by name, and name by id. */
  id: Map<string, string>;
  name: Map<string, string>;
}

interface StageSpec {
  kind: "league" | "group";
  config: Record<string, unknown>;
}

const LEAGUE = (legs = 1): StageSpec => ({ kind: "league", config: { legs } });

/** `n` seeded entrants P1..Pn in one root table stage, started (Start draws the table). */
async function started(n: number, opts: { sport?: string; stage?: StageSpec; kind?: Kind; people?: number } = {}): Promise<Rig> {
  const sport = opts.sport ?? "badminton";
  const kind = opts.kind ?? ((moduleOf(sport).entrantModel?.defaultKind ?? "individual") as Kind);
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T5 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: sport, variant_key: variantOf(sport), config: {} });
  const es = await createEntrants(
    auth,
    d.id,
    Array.from({ length: n }, (_, i) => entrantInput(kind, `P${i + 1}`, i + 1, opts.people ?? 0)),
  );
  const spec = opts.stage ?? LEAGUE();
  const [stage] = await createStages(auth, d.id, { seq: 1, kind: spec.kind, name: "Table", config: spec.config, progression: null });
  await startDivision(auth, d.id);
  const id = new Map(es.map((e) => [e.display_name, e.id]));
  const name = new Map(es.map((e) => [e.id, e.display_name]));
  return { auth, competitionId: comp.id, divisionId: d.id, stageId: stage!.id, kind, id, name };
}

function entrantInput(kind: Kind, name: string, seed: number | null, people = 0, extra: Record<string, unknown> = {}) {
  return {
    kind,
    display_name: name,
    seed,
    members: Array.from({ length: people }, (_, i) => ({ new_person: { full_name: `${name} ${i} ${randomUUID().slice(0, 6)}` }, is_captain: false, roles: [] as string[] })),
    ...extra,
  };
}

async function addLate(rig: Rig, name: string, extra: Record<string, unknown> = {}, people = 0) {
  const [row] = await createEntrants(rig.auth, rig.divisionId, [entrantInput(rig.kind, name, null, people, extra) as never]);
  rig.id.set(name, row!.id);
  rig.name.set(row!.id, name);
  return row!;
}

interface Line {
  id: string;
  round_no: number;
  seq_in_round: number;
  ext_key: string | null;
  pool_id: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  scheduled_at: Date | null;
  court_id: string | null;
  status: string;
}

async function lines(stageId: string): Promise<Line[]> {
  return [
    ...(await sql<Line[]>`
      select id, round_no, seq_in_round, ext_key, pool_id, home_entrant_id, away_entrant_id, scheduled_at, court_id, status
        from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`),
  ];
}

/** The late player's lines as "opponent:kind:round", by round — `kind` read off the stored key (`rr-by-` / `rr-cu-`). */
function seats(rig: Rig, rows: readonly Line[], late: string): string[] {
  return rows
    .filter((r) => r.home_entrant_id === late || r.away_entrant_id === late)
    .map((r) => {
      const other = r.home_entrant_id === late ? r.away_entrant_id! : r.home_entrant_id!;
      const kind = /rr-by-/.test(r.ext_key ?? "") ? "bye_slot" : /rr-cu-/.test(r.ext_key ?? "") ? "catch_up_round" : `other(${r.ext_key})`;
      return `${rig.name.get(other)}:${kind}:${r.round_no}`;
    });
}

async function post(auth: AuthCtx, fixtureId: string, type: string): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${fixtureId}`;
  await scoreEvent(auth, fixtureId, { expected_seq: n, type, payload: {} });
}

/** Start the first line of each of `rounds` (a score event: the K4 predicate's first arm). */
async function startRounds(rig: Rig, rounds: number[]): Promise<void> {
  const rows = await lines(rig.stageId);
  for (const r of rounds) await post(rig.auth, rows.find((x) => x.round_no === r)!.id, "core.start");
}

async function entrantCount(divisionId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${divisionId}`;
  return n;
}

async function byesOf(rig: Rig): Promise<string[]> {
  const [row] = await sql<{ b: { round_no: number; entrant_id: string }[] | null }[]>`select config -> 'round_byes' as b from stages where id = ${rig.stageId}`;
  return (row!.b ?? []).map((b) => `r${b.round_no}:${rig.name.get(b.entrant_id) ?? b.entrant_id}`);
}

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "the add is refused").toBeInstanceOf(HttpError);
  return err as HttpError;
}

/** The five-field premise: the stored byes are the engine's own declaration over the seeded field (r1 P5 ... r5 P1). */
async function fiveFieldPremise(rig: Rig): Promise<void> {
  const ids = ["P1", "P2", "P3", "P4", "P5"].map((n) => rig.id.get(n)!);
  const engine = generateRoundRobin({ entrants: ids, seeds: new Map(ids.map((id, i) => [id, i + 1])), config: { legs: 1 } });
  expect(await byesOf(rig), "the stored byes are the engine's").toEqual(engine.rounds.map((r) => `r${r.roundNo}:${rig.name.get(r.bye!)}`));
  expect(await byesOf(rig), "premise: byes r1 P5, r2 P4, r3 P3, r4 P2, r5 P1").toEqual(["r1:P5", "r2:P4", "r3:P3", "r4:P2", "r5:P1"]);
}

describe.skipIf(!HAS_DB)("W5 T5: Add late player into a started league or group (X-CU-4, X-CU-7, X-CU-12, X-CU-13)", () => {
  it("X-CU-4 catch-up: the newcomer plays everyone; every earlier row's seats, round, time and court are byte-equal", async () => {
    const rig = await started(5);
    await fiveFieldPremise(rig);
    // Earlier rows carry a time and a court, so "byte-equal" proves the slots too (setup, not the path under test).
    const venue = await createVenue(rig.auth, { name: "Hall", sort: 0 });
    const court = await createCourt(rig.auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    await sql`update fixtures set scheduled_at = '2030-06-01T09:00:00Z'::timestamptz + (round_no * interval '1 hour') + (seq_in_round * interval '10 minutes'),
                                  court_id = ${court.id} where stage_id = ${rig.stageId}`;
    await startRounds(rig, [1, 2]);
    const before = await lines(rig.stageId);
    const late = await addLate(rig, "Late");
    const result = late.late_entry as TableLateEntryResult;
    expect(result).toMatchObject({ format: "league", case: "catch_up", source: "organiser", appended_rounds: 2 });
    const after = await lines(rig.stageId);
    expect(seats(rig, after, late.id)).toEqual(["P3:bye_slot:3", "P2:bye_slot:4", "P1:bye_slot:5", "P4:catch_up_round:6", "P5:catch_up_round:7"]);
    const kept = after.filter((r) => before.some((b) => b.id === r.id));
    expect(kept, "every earlier row is byte-equal").toEqual(before);
    expect(after).toHaveLength(before.length + 5);
    // The answer names exactly the new lines, each unscheduled.
    const fresh = after.filter((r) => !before.some((b) => b.id === r.id));
    expect(result.fixtures!.map((f) => f.fixture_id).sort()).toEqual(fresh.map((r) => r.id).sort());
    expect(result.fixtures!.every((f) => f.scheduled === false)).toBe(true);
    // The consumed byes leave `round_byes`; the started ones (P5 r1, P4 r2) stay.
    expect(await byesOf(rig)).toEqual(["r1:P5", "r2:P4"]);
  });

  it("X-CU-4 round numbers are never rewritten: an even field appends rounds 6..11 in seed order, every earlier round as it was", async () => {
    const rig = await started(6);
    await startRounds(rig, [1, 2, 3]);
    const before = await lines(rig.stageId);
    expect(Math.max(...before.map((r) => r.round_no)), "premise: 6 entrants play 5 rounds").toBe(5);
    const late = await addLate(rig, "Late");
    const after = await lines(rig.stageId);
    expect(seats(rig, after, late.id)).toEqual(["P1", "P2", "P3", "P4", "P5", "P6"].map((p, i) => `${p}:catch_up_round:${6 + i}`));
    expect(after.filter((r) => before.some((b) => b.id === r.id)).map((r) => `${r.id}@${r.round_no}`)).toEqual(before.map((r) => `${r.id}@${r.round_no}`));
  });

  it("X-CU-7 a bye slot that starts under the lock is appended instead (Review Focus 3)", async () => {
    const rig = await started(5);
    await fiveFieldPremise(rig);
    await startRounds(rig, [1, 2]);
    const [{ id: lateId }] = await sql<{ id: string }[]>`
      insert into entrants (division_id, kind, display_name) values (${rig.divisionId}, 'individual', 'Late') returning id`;
    rig.name.set(lateId!, "Late");
    // The decision is read while round 3 is still unstarted...
    const { stage, decision } = await withTenant(rig.auth.orgId, async (tx) => {
      const [s] = await rootTableStages(tx, rig.divisionId);
      const place = await readTableLatePlace(tx, s!, lateId!, undefined);
      return { stage: s!, place, decision: decideRoundRobinLateEntry(place.input) };
    });
    expect(decision.case).toBe("catch_up");
    // ...then round 3 starts (a score event on its line) before the write.
    await startRounds(rig, [3]);
    const result = await withTenant(rig.auth.orgId, (tx) =>
      applyTableLateDecision(tx, stage, lateId!, decision as TablePlacingDecision, {
        divisionId: rig.divisionId,
        actorId: rig.auth.userId,
        source: "organiser",
        poolId: null,
        poolKey: null,
      }),
    );
    // P3's fixture leaves its now-started round 3 for a round after every round the stage holds (7 -> 8); the rest stand.
    expect(seats(rig, await lines(rig.stageId), lateId!)).toEqual(["P2:bye_slot:4", "P1:bye_slot:5", "P4:catch_up_round:6", "P5:catch_up_round:7", "P3:catch_up_round:8"]);
    expect(result.appended_rounds).toBe(3);
    expect(await byesOf(rig), "P3's started bye is not consumed").toEqual(["r1:P5", "r2:P4", "r3:P3"]);
  });

  it("X-CU-7 stage complete: refused by name; the entrant is not created", async () => {
    const rig = await started(4);
    await sql`update stages set status = 'complete' where id = ${rig.stageId}`;
    const count = await entrantCount(rig.divisionId);
    const before = await lines(rig.stageId);
    const err = await refusal(addLate(rig, "Late"));
    expect(err).toMatchObject({ status: 422, code: "RR_LATE_ENTRY_STAGE_COMPLETE", message: COMPLETE });
    expect(await entrantCount(rig.divisionId), "the refusal rolled the entrant row back").toBe(count);
    expect(await lines(rig.stageId)).toEqual(before);
  });

  it("X-CU-7 nothing started: rebuild_offered, catch-up by default; prefer_rebuild regenerates", async () => {
    const rig = await started(5);
    await fiveFieldPremise(rig);
    const late = await addLate(rig, "Late");
    expect(late.late_entry).toMatchObject({ case: "rebuild_offered", source: "organiser", appended_rounds: 0 });
    // RB5-L3 with every bye unstarted: each member's fixture lands in its own bye round.
    expect(seats(rig, await lines(rig.stageId), late.id)).toEqual(["P5:bye_slot:1", "P4:bye_slot:2", "P3:bye_slot:3", "P2:bye_slot:4", "P1:bye_slot:5"]);
    expect(await byesOf(rig), "every bye became a match").toEqual([]);

    const other = await started(5);
    const redrawn = await addLate(other, "Late", { prefer_rebuild: true });
    expect(redrawn.late_entry).toMatchObject({ case: "rebuild_offered", reason: "rebuilt" });
    const rows = await lines(other.stageId);
    // Rebuild drew a fresh round robin of six: 15 lines, the generator's own keys, no catch-up line, no bye.
    expect(rows).toHaveLength(15);
    expect(rows.every((r) => /^rr-r\d+-c\d+-L1$/.test(r.ext_key ?? "")), "the generator's keys only").toBe(true);
    expect(seats(other, rows, redrawn.id)).toHaveLength(5);
    expect(await byesOf(other), "an even field sits nobody out").toEqual([]);
  });

  it("X-CU-7 a newcomer with nothing owed is refused by name (RB5-E9)", async () => {
    const rig = await started(4);
    await startRounds(rig, [1]);
    // Every member has left the field (status only — the shape where nobody is left to owe): nothing to add.
    await sql`update entrants set status = 'withdrawn' where division_id = ${rig.divisionId}`;
    const count = await entrantCount(rig.divisionId);
    const err = await refusal(addLate(rig, "Late"));
    expect(err).toMatchObject({ status: 422, code: "RR_LATE_ENTRY_NOTHING_TO_ADD", message: NOTHING });
    expect(await entrantCount(rig.divisionId), "rolled back").toBe(count);
  });

  it("X-CU-11 default the smallest pool; an explicit pool is honoured; an unknown pool is refused", async () => {
    // Seven over two pools snake to A = {P1, P4, P5}, B = {P2, P3, P6, P7}: A is the smallest.
    const rig = await started(7, { stage: { kind: "group", config: { legs: 1, pools: { count: 2 } } } });
    await startRounds(rig, [1]);
    const pools = new Map((await sql<{ id: string; key: string }[]>`select id, key from pools where stage_id = ${rig.stageId}`).map((p) => [p.id, p.key]));
    const poolOf = async (entrantId: string) => {
      const rows = (await lines(rig.stageId)).filter((r) => r.home_entrant_id === entrantId || r.away_entrant_id === entrantId);
      return [...new Set(rows.map((r) => pools.get(r.pool_id!)))];
    };
    expect(await poolOf(rig.id.get("P1")!), "premise: P1 is in A").toEqual(["A"]);
    const first = await addLate(rig, "Late A");
    expect(first.late_entry).toMatchObject({ format: "group", case: "catch_up", pool_key: "A" });
    expect(await poolOf(first.id)).toEqual(["A"]);
    expect(seats(rig, await lines(rig.stageId), first.id).map((s) => s.split(":")[0]).sort(), "plays pool A's three").toEqual(["P1", "P4", "P5"]);
    const second = await addLate(rig, "Late B", { late_entry_pool: "B" });
    expect(second.late_entry).toMatchObject({ pool_key: "B" });
    expect(seats(rig, await lines(rig.stageId), second.id).map((s) => s.split(":")[0]).sort(), "plays pool B's four").toEqual(["P2", "P3", "P6", "P7"]);
    const count = await entrantCount(rig.divisionId);
    const err = await refusal(addLate(rig, "Late Z", { late_entry_pool: "Z" }));
    expect(err).toMatchObject({ status: 422, code: "RR_LATE_ENTRY_UNKNOWN_POOL", message: UNKNOWN_POOL });
    expect(await entrantCount(rig.divisionId)).toBe(count);
  });

  it("X-CU-12 catch-up fixtures are written unscheduled and the desk counts them", async () => {
    const rig = await started(5);
    await startRounds(rig, [1, 2]);
    const late = await addLate(rig, "Late");
    const fresh = (await lines(rig.stageId)).filter((r) => r.home_entrant_id === late.id || r.away_entrant_id === late.id);
    expect(fresh).toHaveLength(5);
    expect(fresh.map((r) => [r.scheduled_at, r.court_id])).toEqual(fresh.map(() => [null, null]));
    const desk = await getCompetitionDesk(rig.auth, rig.competitionId);
    const att = desk.divisions.get(rig.divisionId)!.attention.find((a) => a.kind === "unscheduled");
    expect(att, "the desk's unscheduled row carries the catch-up count").toMatchObject({ kind: "unscheduled", catchUp: 5 });
  });

  it("X-CU-12 the desk flag clears when the catch-up line is scheduled", async () => {
    const rig = await started(5);
    const venue = await createVenue(rig.auth, { name: "Hall", sort: 0 });
    const court = await createCourt(rig.auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    await sql`update fixtures set scheduled_at = '2030-06-01T09:00:00Z'::timestamptz + (round_no * interval '1 hour') + (seq_in_round * interval '10 minutes'),
                                  court_id = ${court.id} where stage_id = ${rig.stageId}`;
    await startRounds(rig, [1, 2]);
    const late = await addLate(rig, "Late");
    const placed = (late.late_entry as TableLateEntryResult).fixtures!;
    const catchUp = async () => {
      const desk = await getCompetitionDesk(rig.auth, rig.competitionId);
      const att = desk.divisions.get(rig.divisionId)!.attention.find((a) => a.kind === "unscheduled");
      return att === undefined ? null : ((att as { catchUp?: number }).catchUp ?? 0);
    };
    expect(await catchUp()).toBe(5);
    // Through the real scheduling path (the board's move), one line at a time: each at its own round's hour on a second court,
    // so no court, person or round-order conflict is introduced (the earlier rows sit at 09:00 + round hours on court 1).
    const court2 = await createCourt(rig.auth, venue.id, { name: "Court 2", sort: 1, tags: [] });
    const at = (round: number) => new Date(Date.UTC(2030, 5, 1, 9 + round)).toISOString();
    await moveFixture(rig.auth, placed[0]!.fixture_id, { scheduled_at: at(placed[0]!.round_no), court_id: court2.id });
    expect(await catchUp(), "one scheduled: the count drops by one").toBe(4);
    for (const f of placed.slice(1)) await moveFixture(rig.auth, f.fixture_id, { scheduled_at: at(f.round_no), court_id: court2.id });
    expect(await catchUp(), "all scheduled: no unscheduled row is left at all").toBeNull();
  });

  it("X-CU-13 Undo after Add late player refuses and points to Withdraw", async () => {
    const rig = await started(5);
    await startRounds(rig, [1, 2]);
    const late = await addLate(rig, "Late");
    const before = await lines(rig.stageId);
    const err = await refusal(undoDivision(rig.auth, rig.divisionId));
    expect(err).toMatchObject({ status: 409, code: "RR_LATE_ENTRY_NOT_UNDOABLE", message: NOT_UNDOABLE });
    expect(await lines(rig.stageId), "the refused Undo moved nothing").toEqual(before);
    const [row] = await sql<{ type: string; payload: Record<string, unknown> }[]>`
      select type, payload from division_events where division_id = ${rig.divisionId} order by seq desc limit 1`;
    expect(row).toMatchObject({
      type: "roundrobin_late_entry",
      payload: { source: "organiser", case: "catch_up", stage_id: rig.stageId, entrant_id: late.id, pool_key: null, joined_round: 3 },
    });
    expect((row!.payload.fixture_ids as string[]).sort()).toEqual((late.late_entry as TableLateEntryResult).fixtures!.map((f) => f.fixture_id).sort());
  });
});

describe.skipIf(!HAS_DB)("W5 T5: the sequence (a second late player, after a withdrawal, a pair, two legs, another sport)", () => {
  it("RB5-L16 a second late player owes the first as well as the field; no round seats anyone twice", async () => {
    const rig = await started(5);
    await startRounds(rig, [1, 2]);
    const first = await addLate(rig, "Late 1");
    const second = await addLate(rig, "Late 2");
    const rows = await lines(rig.stageId);
    expect(seats(rig, rows, second.id).map((s) => s.split(":")[0]).sort()).toEqual(["Late 1", "P1", "P2", "P3", "P4", "P5"]);
    // No round seats anyone twice, across both newcomers' lines (design §4.1).
    let checked = 0;
    for (const r of new Set(rows.map((x) => x.round_no))) {
      const seated = rows.filter((x) => x.round_no === r).flatMap((x) => [x.home_entrant_id, x.away_entrant_id]);
      expect(new Set(seated).size, `round ${r}`).toBe(seated.length);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    expect(seats(rig, rows, first.id)).toHaveLength(6);
  });

  it("after a withdrawal the departed owes nothing: the newcomer plays only the field still in", async () => {
    const rig = await started(5);
    await startRounds(rig, [1]);
    await withdrawEntrantCascade(rig.auth, rig.id.get("P2")!);
    const late = await addLate(rig, "Late");
    expect(seats(rig, await lines(rig.stageId), late.id).map((s) => s.split(":")[0]).sort()).toEqual(["P1", "P3", "P4", "P5"]);
  });

  it("after a void: a start taken back (core.void) still counts as started, so that round's bye is not consumed", async () => {
    // fixtureHasResultSql: "a start taken back leaves `scheduled` behind, and its events" — the K4 predicate is monotonic.
    const rig = await started(5);
    await startRounds(rig, [1, 2, 3]);
    const r3 = (await lines(rig.stageId)).find((x) => x.round_no === 3)!;
    const [start] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${r3.id} and type = 'core.start'`;
    const [{ n }] = await sql<{ n: number }[]>`select max(seq)::int as n from score_events where fixture_id = ${r3.id}`;
    await scoreEvent(rig.auth, r3.id, { expected_seq: n, type: "core.void", payload: { event_id: start!.id } });
    expect((await lines(rig.stageId)).find((x) => x.id === r3.id)!.status, "premise: the void walked the line back").toBe("scheduled");
    const late = await addLate(rig, "Late");
    expect(seats(rig, await lines(rig.stageId), late.id)).toEqual(["P2:bye_slot:4", "P1:bye_slot:5", "P3:catch_up_round:6", "P4:catch_up_round:7", "P5:catch_up_round:8"]);
  });

  it("an Add match row is a fixed seat: a bye holder it seats in that round keeps the bye, and the row is never moved", async () => {
    const rig = await started(5);
    await startRounds(rig, [1, 2]);
    // P3 sits out round 3; an organiser's own row there (ext_key adhoc-1) gives P3 a game.
    const [adhoc] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, ext_key, status)
      values (${rig.stageId}, ${rig.divisionId}, 3, 9, ${rig.id.get("P3")!}, ${rig.id.get("P1")!}, 'adhoc-1', 'scheduled') returning id`;
    const before = (await lines(rig.stageId)).find((r) => r.id === adhoc!.id);
    const late = await addLate(rig, "Late");
    const rows = await lines(rig.stageId);
    expect(seats(rig, rows, late.id)).toEqual(["P2:bye_slot:4", "P1:bye_slot:5", "P3:catch_up_round:6", "P4:catch_up_round:7", "P5:catch_up_round:8"]);
    expect(rows.find((r) => r.id === adhoc!.id)).toEqual(before);
    expect(await byesOf(rig)).toEqual(["r1:P5", "r2:P4", "r3:P3"]);
  });

  it("a pair division: the late pair is the entrant and owes every pair", async () => {
    const sport = builtinModules.find((m) => offers(m.key, "league") && engineEntrantKinds(m.key).includes("pair"))?.key;
    expect(sport, "premise: a sport whose league takes pairs").toBeDefined();
    const seatsPerPair = entrantKindCap("pair");
    const rig = await started(4, { sport: sport!, kind: "pair", people: seatsPerPair });
    await startRounds(rig, [1]);
    const late = await addLate(rig, "Late pair", {}, seatsPerPair);
    expect(late.kind).toBe("pair");
    expect(seats(rig, await lines(rig.stageId), late.id)).toEqual(["P1", "P2", "P3", "P4"].map((p, i) => `${p}:catch_up_round:${4 + i}`));
  });

  it("a two-leg league owes both legs: leg 1 for every member, then leg 2, each pair's side flipped", async () => {
    const rig = await started(4, { stage: LEAGUE(2) });
    await startRounds(rig, [1]);
    const late = await addLate(rig, "Late");
    const rows = await lines(rig.stageId);
    expect(seats(rig, rows, late.id)).toEqual([
      "P1:catch_up_round:7", "P2:catch_up_round:8", "P3:catch_up_round:9", "P4:catch_up_round:10",
      "P1:catch_up_round:11", "P2:catch_up_round:12", "P3:catch_up_round:13", "P4:catch_up_round:14",
    ]);
    const mine = rows.filter((r) => r.home_entrant_id === late.id || r.away_entrant_id === late.id);
    expect(mine.map((r) => r.ext_key!.replace(/^.*-L/, "L"))).toEqual(["L1", "L1", "L1", "L1", "L2", "L2", "L2", "L2"]);
    let flipped = 0;
    for (const p of ["P1", "P2", "P3", "P4"]) {
      const [l1, l2] = mine.filter((r) => r.home_entrant_id === rig.id.get(p) || r.away_entrant_id === rig.id.get(p));
      expect(l1!.home_entrant_id === late.id, p).toBe(l2!.away_entrant_id === late.id);
      flipped++;
    }
    expect(flipped).toBe(4);
  });

  it("another sport (teams): the registry's first team sport places a late team by the same rule", async () => {
    const sport = sportFor("team");
    const rig = await started(5, { sport });
    await startRounds(rig, [1, 2]);
    const late = await addLate(rig, "Late");
    expect(seats(rig, await lines(rig.stageId), late.id)).toEqual(["P3:bye_slot:3", "P2:bye_slot:4", "P1:bye_slot:5", "P4:catch_up_round:6", "P5:catch_up_round:7"]);
  });

  it("an empty input: a table not drawn yet takes the late add as a plain entrant, no answer and no line written", async () => {
    // tableLateEntryOffered's `generated` half: Start drew no table (a stage added after Start), so there is nothing to catch up.
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T5 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: "bwf", config: {} });
    await createEntrants(auth, d.id, Array.from({ length: 4 }, (_, i) => entrantInput("individual", `P${i + 1}`, i + 1)));
    const [stage] = await createStages(auth, d.id, { seq: 1, kind: "league", name: "Table", config: { legs: 1 }, progression: null });
    await sql`update divisions set status = 'active' where id = ${d.id}`;
    const [row] = await createEntrants(auth, d.id, [entrantInput("individual", "Late", null)]);
    expect(row!.late_entry).toBeUndefined();
    expect(await lines(stage!.id)).toEqual([]);
  });

  it("the template sweep: every table entry template seats a late add in its entry table only (league, league_ko, groups_ko, group_stepladder, group_playoffs)", async () => {
    const KNOBS = { qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 };
    let checked = 0;
    for (const key of ["league", "league_ko", "groups_ko", "group_stepladder", "group_playoffs"]) {
      const { auth } = await seedOrg("pro");
      const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T5 " + key, visibility: "private", branding: {} });
      const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: "bwf", config: {} });
      await createEntrants(auth, d.id, Array.from({ length: 8 }, (_, i) => entrantInput("individual", `P${i + 1}`, i + 1)));
      const ids: string[] = [];
      for (const [i, s] of buildTemplateStages(key, KNOBS).entries()) {
        const [st] = await createStages(auth, d.id, { seq: i + 1, kind: s.kind, name: s.name, config: s.config, progression: s.progression } as never);
        ids.push(st!.id);
      }
      await startDivision(auth, d.id);
      const [late] = await createEntrants(auth, d.id, [entrantInput("individual", "Late", null)]);
      expect(late!.late_entry, key).toMatchObject({ stage_id: ids[0], case: "rebuild_offered" });
      const mine = await sql<{ stage_id: string }[]>`select stage_id from fixtures where ${late!.id} in (home_entrant_id, away_entrant_id)`;
      expect(mine.length, `${key}: seated`).toBeGreaterThan(0);
      expect(new Set(mine.map((m) => m.stage_id)), `${key}: only in the entry table`).toEqual(new Set([ids[0]]));
      checked++;
    }
    expect(checked).toBe(5);
  }, 300_000);
});
