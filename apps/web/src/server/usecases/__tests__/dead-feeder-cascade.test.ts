// Owner ruling 2026-09-21 (the cascade) — **a seat whose feeder is
// permanently dead is a bye seat.**
//
// Re-review C2 taught the generator to VOID a bracket line that has nobody
// left to walk over to (`departed-qualifier-void.test.ts`). That closed the
// "a withdrawn entrant is standing on a court" defect and opened a quieter
// one: the void's `winner_to_fixture` target then waits forever on a feeder
// that can never produce a winner. Driven by hand on 2026-09-21 the bracket
// stopped dead — the final read `Winner of R2·1 vs P3 — Awaiting draw`,
// `completeStage` returned `{"completed":false,"events":[]}`, and the stage
// never left `active`. That is C1 reinherited through the void path.
//
// The ruling: stamp `bracket.slot.bye` on the dead feeder's target seat and
// let `awardSeededByes` plus the C1 advancement settle it through the ONE
// existing pathway. No second settle path. Voids compound into further voids
// only when BOTH feeders are void.
//
// And stamp LATE. A withdrawal is a STATUS FLIP — an entrant can be
// reinstated — so a stamp written ahead of need hardens a state a human could
// otherwise undo. The seat is stamped at the moment it becomes actionable
// (the sibling feeder resolves and the seat is genuinely "live entrant +
// permanently dead feeder"), never pre-stamped down the forward chain at
// generation. "no seat is stamped before its sibling feeder resolves" below
// is the test that pins that, and it is the one that fails if the cascade is
// ever made eager.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { generateSingleElim } from "@seazn/engine/scheduling";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { getFixtureState } from "../fixtures";
import { scoreEvent } from "../scoring";
import { completeStage, createStages, generateStageFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
const BYE_KEY = "bracket.slot.bye";

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface Row {
  id: string;
  ext_key: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_slot_label: { key?: string } | null;
  away_slot_label: { key?: string } | null;
  status: string;
  outcome: { kind?: string; winner?: string } | null;
  winner_to_fixture: string | null;
  winner_to_slot: number | null;
}

async function rowsOf(stageId: string): Promise<Row[]> {
  return sql<Row[]>`
    select id, ext_key, round_no, seq_in_round, home_entrant_id, away_entrant_id,
           home_slot_label, away_slot_label, status, outcome,
           winner_to_fixture, winner_to_slot
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
}

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  qualified: string[];
}

/** A knockout stage whose `config.qualified` is a published draw of `field`
 *  entrants — the shape a `timing: "on_complete"` progression leaves behind,
 *  and the shape that was driven by hand into the stuck state above. */
async function seedQualifiedStage(field: number): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Cascade " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: field }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, [
    { seq: 1, kind: "knockout", name: "Finals", config: {} },
  ]);
  const qualified = entrants.map((e) => e.id);
  await sql`update stages set config = ${sql.json({ qualified } as never)} where id = ${stage!.id}`;
  await sql`update divisions set status = 'active' where id = ${division.id}`;
  return { auth, divisionId: division.id, stageId: stage!.id, qualified };
}

function draw(qualified: string[]) {
  return generateSingleElim({
    entrants: qualified,
    seeds: new Map(qualified.map((id, i) => [id, i + 1])),
  });
}

/** The two entrants the ENGINE'S OWN DRAW puts opposite each other at these
 *  seeds — and it throws rather than silently testing a different pairing if
 *  the draw ever stops matching. The brief names seeds 4 and 5; this asserts
 *  that premise instead of assuming it. */
function pairingOfSeeds(qualified: string[], s1: number, s2: number): [string, string] {
  const a = qualified[s1 - 1]!;
  const b = qualified[s2 - 1]!;
  const found = draw(qualified).fixtures.some(
    (f) => (f.home === a && f.away === b) || (f.home === b && f.away === a),
  );
  if (!found) throw new Error(`seeds ${s1} and ${s2} are not drawn against each other`);
  return [a, b];
}

/** The four entrants of the two first-round pairings that feed ONE later
 *  fixture — the shape in which voids must compound. Taken from the engine's
 *  own feed graph, never from a hand-picked seed list. */
function bothFeedersOfOneParent(qualified: string[]): string[] {
  const bracket = draw(qualified);
  const byId = new Map(bracket.fixtures.map((f) => [f.id, f]));
  for (const parent of bracket.fixtures) {
    if (!parent.homeFrom || !parent.awayFrom) continue;
    const a = byId.get(parent.homeFrom.fixtureId);
    const b = byId.get(parent.awayFrom.fixtureId);
    const ids = [a?.home, a?.away, b?.home, b?.away].filter((x): x is string => !!x);
    if (ids.length === 4) return ids;
  }
  throw new Error("the draw has no fixture whose two feeders are both fully seeded");
}

/** Play `fixture` to a decision for whoever is in home. */
async function play(auth: AuthCtx, fixtureId: string): Promise<void> {
  await scoreEvent(auth, fixtureId, {
    expected_seq: (await getFixtureState(auth, fixtureId)).last_seq,
    type: "core.start",
    payload: {},
  });
  await scoreEvent(auth, fixtureId, {
    expected_seq: (await getFixtureState(auth, fixtureId)).last_seq,
    type: "generic.result",
    payload: { p1Score: 2, p2Score: 0 },
  });
}

/** Play every fixture an organiser could actually put on a court, repeatedly,
 *  until none is left — i.e. run the competition the way the product does.
 *  Returns how many real matches that took. */
async function playOut(auth: AuthCtx, stageId: string): Promise<number> {
  let played = 0;
  for (let guard = 0; guard < 12; guard++) {
    const open = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${stageId} and status = 'scheduled'
        and home_entrant_id is not null and away_entrant_id is not null
      order by round_no, seq_in_round`;
    if (open.length === 0) return played;
    for (const f of open) {
      await play(auth, f.id);
      played++;
    }
  }
  throw new Error("playOut did not converge — the bracket keeps producing playable fixtures");
}

/** A fixture can never hand a winner onward once it is settled without one. */
function isDead(r: Row): boolean {
  return (r.status === "abandoned" || r.status === "cancelled") && !r.outcome?.winner;
}

function labelled(r: Row): string[] {
  const out: string[] = [];
  if (r.home_slot_label?.key === BYE_KEY) out.push(`${r.ext_key}:home`);
  if (r.away_slot_label?.key === BYE_KEY) out.push(`${r.ext_key}:away`);
  return out;
}

/** Everything that feeds `fixtureId`, from the rows' own winner_to_fixture
 *  edge — the same edge the production cascade walks. */
function feedersOf(rows: Row[], fixtureId: string): Row[] {
  return rows.filter((r) => r.winner_to_fixture === fixtureId);
}

describe.skipIf(!HAS_DB)("a seat whose feeder is permanently dead is a bye seat", () => {
  it("the driven shape completes: seeds 4 and 5 depart, the bracket still reaches a champion", async () => {
    const rig = await seedQualifiedStage(8);
    for (const id of pairingOfSeeds(rig.qualified, 4, 5)) {
      await withdrawEntrantCascade(rig.auth, id);
    }
    await generateStageFixtures(rig.auth, rig.stageId);

    // The pairing itself is void — nobody to walk over to (re-review C2).
    const atGen = await rowsOf(rig.stageId);
    const voids = atGen.filter(isDead);
    expect(voids.length, "exactly one line has nobody left on either side").toBe(1);

    const played = await playOut(rig.auth, rig.stageId);
    const after = await rowsOf(rig.stageId);

    // The void's target settled, and it OPENS AT the survivor of its sibling
    // feeder — derived from that row's own outcome, never a name typed here.
    const target = after.find((r) => r.id === voids[0]!.winner_to_fixture);
    expect(target, "the void line feeds a later seat").toBeTruthy();
    const sibling = feedersOf(after, target!.id).find((r) => r.id !== voids[0]!.id);
    expect(sibling?.outcome?.winner, "the sibling feeder produced a winner").toBeTruthy();
    expect(target!.status).toBe("forfeited");
    expect(target!.outcome).toMatchObject({ kind: "award", winner: sibling!.outcome!.winner });

    // ...and the final became playable rather than sitting on "Awaiting draw".
    const final = after.find((r) => r.winner_to_fixture === null && r.round_no === Math.max(...after.map((x) => x.round_no)));
    expect(final!.home_entrant_id, "the final's home seat is occupied").toBeTruthy();
    expect(final!.away_entrant_id, "the final's away seat is occupied").toBeTruthy();
    expect(final!.outcome?.winner, "the final was played").toBeTruthy();
    // 3 live quarter-finals + 1 live semi + the final. The fourth quarter is
    // void and its semi is a walkover, so neither is played by hand.
    expect(played).toBe(5);

    const out = await completeStage(rig.auth, rig.stageId);
    expect(out.completed, "the stage can be completed").toBe(true);
    const [st] = await sql<{ status: string }[]>`select status from stages where id = ${rig.stageId}`;
    expect(st!.status).toBe("complete");
  });

  it("voids compound: both feeders of a seat are void, so that seat is void too", async () => {
    const rig = await seedQualifiedStage(8);
    for (const id of bothFeedersOfOneParent(rig.qualified)) {
      await withdrawEntrantCascade(rig.auth, id);
    }
    await generateStageFixtures(rig.auth, rig.stageId);

    const atGen = await rowsOf(rig.stageId);
    const r1Voids = atGen.filter((r) => isDead(r) && r.round_no === Math.min(...atGen.map((x) => x.round_no)));
    expect(r1Voids.length, "both first-round pairings are void").toBe(2);
    // Both feeders of their shared target are dead, so the target is dead —
    // and NOT stamped as a bye: a bye needs a live entrant to award to.
    const parentId = r1Voids[0]!.winner_to_fixture;
    expect(r1Voids[1]!.winner_to_fixture, "both voids feed the same seat").toBe(parentId);
    const parent = atGen.find((r) => r.id === parentId)!;
    expect(isDead(parent), "the compounded seat is void, not a playable match").toBe(true);
    expect(labelled(parent), "a seat with nobody to award to is not a bye").toEqual([]);

    // The surviving half of the draw plays out, and the final — whose other
    // feeder is the compounded void — becomes a walkover rather than a
    // permanent "Awaiting draw".
    const played = await playOut(rig.auth, rig.stageId);
    expect(played).toBe(3); // two live quarter-finals, then their semi
    const after = await rowsOf(rig.stageId);
    const final = after.find((r) => r.winner_to_fixture === null && r.round_no === Math.max(...after.map((x) => x.round_no)))!;
    const liveFeeder = feedersOf(after, final.id).find((r) => !isDead(r))!;
    expect(final.status).toBe("forfeited");
    expect(final.outcome).toMatchObject({ kind: "award", winner: liveFeeder.outcome!.winner });

    const out = await completeStage(rig.auth, rig.stageId);
    expect(out.completed).toBe(true);
  });

  it("no seat is stamped before its sibling feeder resolves (cascade late, not eagerly)", async () => {
    const rig = await seedQualifiedStage(8);
    for (const id of pairingOfSeeds(rig.qualified, 4, 5)) {
      await withdrawEntrantCascade(rig.auth, id);
    }
    await generateStageFixtures(rig.auth, rig.stageId);

    // At generation the void's target has an EMPTY sibling seat waiting on an
    // unplayed quarter-final. Nothing is actionable, so nothing is stamped —
    // any label here is the forward chain being hardened ahead of need.
    const atGen = await rowsOf(rig.stageId);
    expect(atGen.flatMap(labelled), "generation pre-stamped the forward chain").toEqual([]);

    // Play only the quarter-final that does NOT share a semi with the void.
    const voidRow = atGen.find(isDead)!;
    const stuckSemi = voidRow.winner_to_fixture;
    const elsewhere = atGen.find(
      (r) => r.status === "scheduled" && r.home_entrant_id && r.away_entrant_id && r.winner_to_fixture !== stuckSemi,
    )!;
    await play(rig.auth, elsewhere.id);

    const mid = await rowsOf(rig.stageId);
    expect(mid.flatMap(labelled), "a seat was stamped while its sibling feeder was still live").toEqual([]);

    // Now resolve the sibling, and exactly one seat — the dead one — is stamped
    // and immediately settled.
    const sibling = mid.find((r) => r.status === "scheduled" && r.winner_to_fixture === stuckSemi && r.home_entrant_id && r.away_entrant_id)!;
    await play(rig.auth, sibling.id);
    const after = await rowsOf(rig.stageId);
    const semi = after.find((r) => r.id === stuckSemi)!;
    expect(semi.status).toBe("forfeited");
    expect(semi.outcome?.winner).toBe(
      after.find((r) => r.id === sibling.id)!.outcome!.winner,
    );
  });

  it("CONTROL — a live feeder is never stamped: a full slate plays through with no bye anywhere", async () => {
    const rig = await seedQualifiedStage(8);
    await generateStageFixtures(rig.auth, rig.stageId);
    const played = await playOut(rig.auth, rig.stageId);
    expect(played, "four quarters, two semis, one final").toBe(7);
    const after = await rowsOf(rig.stageId);
    expect(after.flatMap(labelled), "a bye was stamped on a bracket with no departures").toEqual([]);
    expect(after.filter(isDead).map((r) => r.ext_key), "a line was voided with nobody missing").toEqual([]);
    const out = await completeStage(rig.auth, rig.stageId);
    expect(out.completed).toBe(true);
  });
});
