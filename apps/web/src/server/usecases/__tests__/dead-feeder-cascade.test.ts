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
import { completeStage, createStages, generateStageFixtures, rebuildStageFixtures } from "../stages";
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
  outcome: { kind?: string; winner?: string; loser?: string } | null;
  winner_to_fixture: string | null;
  winner_to_slot: number | null;
  loser_to_fixture: string | null;
  loser_to_slot: number | null;
}

async function rowsOf(stageId: string): Promise<Row[]> {
  return sql<Row[]>`
    select id, ext_key, round_no, seq_in_round, home_entrant_id, away_entrant_id,
           home_slot_label, away_slot_label, status, outcome,
           winner_to_fixture, winner_to_slot, loser_to_fixture, loser_to_slot
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
async function seedQualifiedStage(
  field: number,
  kind: "knockout" | "double_elim" = "knockout",
  extraConfig: Record<string, unknown> = {},
): Promise<Rig> {
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
    { seq: 1, kind, name: "Finals", config: {} },
  ]);
  const qualified = entrants.map((e) => e.id);
  await sql`update stages set config = ${sql.json({ ...extraConfig, qualified } as never)} where id = ${stage!.id}`;
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

// Driven in a browser on 2026-09-21: on a freshly generated board with a
// departed pairing — nothing played, not one score entered — pressing
// "Rebuild fixtures" and confirming produced the amber notice "Can't rebuild
// — this stage already has recorded results." That sentence is FALSE, and a
// control that tells the organiser something untrue about their own
// competition is worse than one that does nothing.
//
// The cause is the generator's own artefact. rebuildStageFixtures refuses on
// `status in ('in_play','decided','finalized','abandoned')`, and `abandoned`
// is where the C2 void lands — so from the moment a pairing is voided AT
// GENERATION the stage is permanently un-rebuildable. The guard's reason for
// naming `abandoned` is a match that was PLAYED and stopped (match-reports
// accepts a report on exactly that status); a generation-time void has no
// events, no outcome and no report, and a rebuild simply redraws it.
describe.skipIf(!HAS_DB)("Rebuild fixtures on a board the generator itself voided", () => {
  it("a generation-time void is not a recorded result — the rebuild goes through and redraws it", async () => {
    const rig = await seedQualifiedStage(8);
    for (const id of pairingOfSeeds(rig.qualified, 4, 5)) {
      await withdrawEntrantCascade(rig.auth, id);
    }
    await generateStageFixtures(rig.auth, rig.stageId);
    const before = await rowsOf(rig.stageId);
    expect(before.filter(isDead), "the generator voided the departed pairing").toHaveLength(1);

    const out = await rebuildStageFixtures(rig.auth, rig.stageId);
    expect(out.removed, "every fixture was replaced").toBe(before.length);

    // The board comes back the same, void included — a rebuild of an unplayed
    // stage is a redraw, not a repair, so the SHAPE is what is pinned here.
    const after = await rowsOf(rig.stageId);
    expect(after.map((r) => `${r.ext_key}:${r.status}`)).toEqual(
      before.map((r) => `${r.ext_key}:${r.status}`),
    );
    expect(after.map((r) => [r.home_entrant_id, r.away_entrant_id])).toEqual(
      before.map((r) => [r.home_entrant_id, r.away_entrant_id]),
    );
  });

  it("CONTROL — one real result still refuses: the guard was narrowed, not removed", async () => {
    const rig = await seedQualifiedStage(8);
    for (const id of pairingOfSeeds(rig.qualified, 4, 5)) {
      await withdrawEntrantCascade(rig.auth, id);
    }
    await generateStageFixtures(rig.auth, rig.stageId);
    const open = (await rowsOf(rig.stageId)).find(
      (r) => r.status === "scheduled" && r.home_entrant_id && r.away_entrant_id,
    )!;
    await play(rig.auth, open.id);
    await expect(rebuildStageFixtures(rig.auth, rig.stageId)).rejects.toMatchObject({
      code: "STAGE_HAS_RESULTS",
    });
  });

  it("CONTROL — an ABANDONED match that was actually played still refuses", async () => {
    const rig = await seedQualifiedStage(8);
    await generateStageFixtures(rig.auth, rig.stageId);
    const open = (await rowsOf(rig.stageId)).find(
      (r) => r.status === "scheduled" && r.home_entrant_id && r.away_entrant_id,
    )!;
    // Start it, then abandon it: status 'abandoned' like the void, but with a
    // real event ledger behind it. This is the case the guard's `abandoned`
    // clause was written for, and it must survive the narrowing.
    await scoreEvent(rig.auth, open.id, {
      expected_seq: (await getFixtureState(rig.auth, open.id)).last_seq,
      type: "core.start",
      payload: {},
    });
    await scoreEvent(rig.auth, open.id, {
      expected_seq: (await getFixtureState(rig.auth, open.id)).last_seq,
      type: "core.abandon",
      payload: { reason: "waterlogged" },
    });
    const row = (await rowsOf(rig.stageId)).find((r) => r.id === open.id)!;
    expect(row.status, "the fixture really is abandoned").toBe("abandoned");
    await expect(rebuildStageFixtures(rig.auth, rig.stageId)).rejects.toMatchObject({
      code: "STAGE_HAS_RESULTS",
    });
  });
});

/** Abandon `fixtureId` the way an organiser does on the day — `core.abandon`
 *  needs a non-empty `reason` (CoreAbandon is a strictObject), so a bare `{}`
 *  is rejected at runtime. */
async function abandon(auth: AuthCtx, fixtureId: string): Promise<void> {
  await scoreEvent(auth, fixtureId, {
    expected_seq: (await getFixtureState(auth, fixtureId)).last_seq,
    type: "core.start",
    payload: {},
  });
  await scoreEvent(auth, fixtureId, {
    expected_seq: (await getFixtureState(auth, fixtureId)).last_seq,
    type: "core.abandon",
    payload: { reason: "waterlogged" },
  });
}

// Review round 5, N1 — the cascade originally inverted `winner_to_fixture`
// ONLY, so a seat fed by `loser_to_fixture` was invisible to it. That edge is
// intra-stage in four shipped shapes (losers bracket, grand-final reset,
// third-place playoff, page_playoff), and on a `double_elim` ONE ordinary
// withdrawal left three lines "Awaiting draw" forever with `completeStage`
// answering `{completed: false}` — the exact sentence this programme exists to
// delete, one bracket over.
//
// The two predicates genuinely DISAGREE on one row and that is the whole
// point: a walkover is ALIVE as a winner feeder (it advances its winner) and
// DEAD as a loser feeder (`scoring.ts` takes a loser only from `kind: "win"`,
// so an `award` drops nobody). Conflating "produced no loser" with "died" is
// how this bug class keeps coming back, so each test below names which of the
// two it is exercising.
describe.skipIf(!HAS_DB)("a seat fed by a LOSER edge is cascaded too (N1)", () => {
  it("double_elim, one ordinary withdrawal: the losers bracket fills and the stage completes", async () => {
    const rig = await seedQualifiedStage(4, "double_elim");
    await withdrawEntrantCascade(rig.auth, rig.qualified[3]!);
    await generateStageFixtures(rig.auth, rig.stageId);

    const atGen = await rowsOf(rig.stageId);
    expect(
      atGen.some((r) => r.loser_to_fixture !== null),
      "premise: a double_elim really does carry intra-stage loser edges",
    ).toBe(true);
    // Every line that drops a loser somewhere also sends a winner somewhere
    // (bracket.ts: the LB feeds, the GF reset and the third-place playoff are
    // all wired on lines that already carry a winner edge). That implication
    // is WHY `onDecided`'s cascade gate could survive with the loser edge
    // removed from it — the gate is defensive, not currently load-bearing. If
    // the engine ever wires a loser-only line, this reddens and the gate
    // becomes the thing that keeps it working.
    expect(
      atGen.filter((r) => r.loser_to_fixture !== null && r.winner_to_fixture === null).map((r) => r.ext_key),
      "no line feeds a loser seat without also feeding a winner seat",
    ).toEqual([]);

    await playOut(rig.auth, rig.stageId);
    const after = await rowsOf(rig.stageId);

    // Nothing is left that an organiser could never put on a court. This is
    // the assertion that was false before the loser edge was inverted: three
    // lines sat here `scheduled` with one seat permanently TBD.
    expect(
      after.filter((r) => r.status === "scheduled").map((r) => r.ext_key),
      "every line is either played or settled",
    ).toEqual([]);

    // The walkover in the winners bracket is alive one way and dead the other.
    const wbBye = after.find((r) => r.outcome?.kind === "award" && r.loser_to_fixture !== null)!;
    expect(wbBye, "the withdrawal manufactured a walkover that feeds a loser seat").toBeTruthy();
    expect(
      after.find((r) => r.id === wbBye.winner_to_fixture)?.outcome?.winner,
      "ALIVE as a winner feeder: its winner really did advance",
    ).toBeTruthy();

    // ...and the seat it can never drop anybody into OPENS AT the loser of the
    // sibling line, derived from that row's own outcome rather than typed.
    const lb = after.find((r) => r.id === wbBye.loser_to_fixture)!;
    const sibling = after.find((r) => r.outcome?.kind === "win" && r.loser_to_fixture === lb.id)!;
    expect(sibling?.outcome?.loser, "the sibling line produced a loser").toBeTruthy();
    expect(lb.status).toBe("forfeited");
    expect(lb.outcome).toMatchObject({ kind: "award", winner: sibling.outcome!.loser });

    const out = await completeStage(rig.auth, rig.stageId);
    expect(out.completed, "the double_elim can be completed").toBe(true);
    const [st] = await sql<{ status: string }[]>`select status from stages where id = ${rig.stageId}`;
    expect(st!.status).toBe("complete");
  });

  it("a knockout's third-place line is settled when a WALKOVER feeds it (N4)", async () => {
    // A walkover drops nobody: `onDecided` takes a loser only from
    // `kind: "win"`. So the third-place seat fed by the bye semi's LOSER can
    // never be filled, and before the loser edge was inverted it sat naming
    // one real player against a TBD that would never arrive — on a stage the
    // product had already called complete.
    const rig = await seedQualifiedStage(4, "knockout", { thirdPlace: true });
    await withdrawEntrantCascade(rig.auth, rig.qualified[3]!);
    await generateStageFixtures(rig.auth, rig.stageId);

    const atGen = await rowsOf(rig.stageId);
    const semis = atGen.filter((r) => r.loser_to_fixture !== null);
    expect(semis.length, "premise: both semi-finals feed the third-place line").toBe(2);
    const thirdId = semis[0]!.loser_to_fixture;
    expect(semis[1]!.loser_to_fixture, "both semis feed the SAME third-place line").toBe(thirdId);

    await playOut(rig.auth, rig.stageId);
    const after = await rowsOf(rig.stageId);
    const bye = after.find((r) => r.outcome?.kind === "award" && r.loser_to_fixture === thirdId)!;
    expect(bye, "the withdrawal made one semi a walkover").toBeTruthy();
    const playedSemi = after.find((r) => r.outcome?.kind === "win" && r.loser_to_fixture === thirdId)!;
    const third = after.find((r) => r.id === thirdId)!;
    expect(third.status, "the third-place line is no longer waiting on a TBD").toBe("forfeited");
    expect(third.outcome).toMatchObject({ kind: "award", winner: playedSemi.outcome!.loser });
    expect(
      after.filter((r) => r.status === "scheduled").map((r) => r.ext_key),
      "no line is left unplayable",
    ).toEqual([]);
  });

  // OWNER RULING 2026-09-21 — an abandoned match that CARRIES AN OUTCOME is not
  // dead. A withdrawal is someone leaving the competition; an abandonment is a
  // match that was played and produced no result, and a human must rule on it.
  // Before this, `feederIsDead` read `!outcome?.winner`, so a rained-off
  // semi-final silently stamped the final's seat as a bye and walked the other
  // semi-finalist through. These two tests are the ruling; the third is the
  // regression guard for the narrowing, because the generator's OWN void is an
  // `abandoned` row too and must keep cascading.
  it("an abandoned feeder that carries an outcome leaves BOTH of its seats alone", async () => {
    const rig = await seedQualifiedStage(4, "knockout", { thirdPlace: true });
    await generateStageFixtures(rig.auth, rig.stageId);
    const atGen = await rowsOf(rig.stageId);
    const semis = atGen.filter((r) => r.loser_to_fixture !== null);
    const thirdId = semis[0]!.loser_to_fixture!;
    const finalId = semis[0]!.winner_to_fixture!;

    await play(rig.auth, semis[0]!.id);
    await abandon(rig.auth, semis[1]!.id);

    // The shape is read back off the row `core.abandon` actually wrote, not
    // typed here, so a change to the engine's own declarations moves this test
    // rather than leaving it asserting yesterday's fold.
    const rained = (await rowsOf(rig.stageId)).find((r) => r.id === semis[1]!.id)!;
    expect(rained.status).toBe("abandoned");
    expect(rained.outcome, "core.abandon folds to an outcome, not to null").not.toBeNull();
    expect(rained.outcome!.winner, "and that outcome names nobody").toBeFalsy();

    const after = await rowsOf(rig.stageId);
    const final = after.find((r) => r.id === finalId)!;
    const third = after.find((r) => r.id === thirdId)!;
    expect(labelled(final), "the final's empty seat is NOT stamped as a bye").toEqual([]);
    expect(labelled(third), "the third-place line's empty seat is NOT stamped either").toEqual([]);
    expect(final.status, "the final is still waiting, not walked over").toBe("scheduled");
    expect(third.status).toBe("scheduled");
    expect([final.home_entrant_id, final.away_entrant_id]).toContain(null);

    // Stuck AND VISIBLE is the correct state, and the surrounding code has to
    // treat it as a legitimate wait rather than crash on it.
    const out = await completeStage(rig.auth, rig.stageId);
    expect(out.completed, "a human has to rule on the abandoned match first").toBe(false);
    const [st] = await sql<{ status: string }[]>`select status from stages where id = ${rig.stageId}`;
    expect(st!.status, "and the stage stays open rather than closing behind them").not.toBe("complete");
  });

  it("an abandoned feeder with NO outcome — the generator's own void — still cascades", async () => {
    // The regression guard for the narrowing above. The void the generator and
    // this cascade write is an `abandoned` row with a NULL outcome, which is
    // precisely what still counts as dead.
    const rig = await seedQualifiedStage(8);
    for (const id of pairingOfSeeds(rig.qualified, 4, 5)) {
      await withdrawEntrantCascade(rig.auth, id);
    }
    await generateStageFixtures(rig.auth, rig.stageId);
    const atGen = await rowsOf(rig.stageId);
    const voided = atGen.find((r) => r.status === "abandoned")!;
    expect(voided.outcome, "premise: the generator's void carries NO outcome at all").toBeNull();

    await playOut(rig.auth, rig.stageId);
    const after = await rowsOf(rig.stageId);
    const target = after.find((r) => r.id === voided.winner_to_fixture)!;
    expect(target.status, "the void's target is still settled as a walkover").toBe("forfeited");
    const out = await completeStage(rig.auth, rig.stageId);
    expect(out.completed).toBe(true);
  });

  it("a 'cancelled' feeder is dead — defensive, and product-unreachable today", async () => {
    // NOTHING in apps/web/src or packages/engine/src writes
    // `fixtures.status = 'cancelled'`; every production reference reads it. It
    // is a valid value in the v1 output schema, so it may arrive on an import
    // path, and the disjunct stays. That makes raw SQL the ONLY way to reach
    // this branch — writing the row by hand is the point of the test, not a
    // shortcut around a use case.
    const rig = await seedQualifiedStage(8);
    await generateStageFixtures(rig.auth, rig.stageId);
    const atGen = await rowsOf(rig.stageId);
    const first = atGen.find((r) => r.winner_to_fixture !== null)!;
    const sibling = atGen.find(
      (r) => r.winner_to_fixture === first.winner_to_fixture && r.id !== first.id,
    )!;
    await sql`update fixtures set status = 'cancelled', outcome = null,
                home_entrant_id = null, away_entrant_id = null
              where id = ${first.id}`;

    await play(rig.auth, sibling.id);
    const target = (await rowsOf(rig.stageId)).find((r) => r.id === first.winner_to_fixture)!;
    expect(labelled(target), "the cancelled line's target seat is stamped").toHaveLength(1);
    expect(target.status, "and settled as a walkover for the entrant still standing").toBe("forfeited");
  });

  it("a walkover is a LIVE winner feeder even when its sibling feeder is void", async () => {
    // The shape that tells the two predicates apart. One first-round pairing
    // loses BOTH entrants (void), and the pairing beside it loses ONE (a
    // walkover). Their shared semi-final therefore has one dead feeder and one
    // feeder that is `forfeited` with `{kind: "award"}`.
    //
    // A walkover is dead as a LOSER feeder and alive as a WINNER feeder, and
    // this seat is fed by its winner. Judge it with the wrong predicate and
    // BOTH feeders read dead, the semi is voided, and the one entrant still
    // standing in that half of the draw is deleted from the competition.
    const rig = await seedQualifiedStage(8);
    const four = bothFeedersOfOneParent(rig.qualified);
    await withdrawEntrantCascade(rig.auth, four[0]!);
    await withdrawEntrantCascade(rig.auth, four[1]!);
    await withdrawEntrantCascade(rig.auth, four[2]!);
    const survivor = four[3]!;
    await generateStageFixtures(rig.auth, rig.stageId);

    const atGen = await rowsOf(rig.stageId);
    const voided = atGen.filter(isDead);
    expect(voided.length, "one pairing lost both entrants").toBe(1);
    const walkover = atGen.find(
      (r) => r.outcome?.kind === "award" && r.winner_to_fixture === voided[0]!.winner_to_fixture,
    )!;
    expect(walkover, "the pairing beside it is a walkover").toBeTruthy();
    expect(walkover.outcome!.winner, "and its winner is the entrant still standing").toBe(survivor);

    const semi = atGen.find((r) => r.id === voided[0]!.winner_to_fixture)!;
    expect(isDead(semi), "the semi is NOT void: a walkover still sends a winner here").toBe(false);
    expect(
      [semi.home_entrant_id, semi.away_entrant_id],
      "the walkover's winner really took her seat",
    ).toContain(survivor);

    await playOut(rig.auth, rig.stageId);
    const after = await rowsOf(rig.stageId);
    const settledSemi = after.find((r) => r.id === semi.id)!;
    expect(settledSemi.status).toBe("forfeited");
    expect(settledSemi.outcome).toMatchObject({ kind: "award", winner: survivor });
    const out = await completeStage(rig.auth, rig.stageId);
    expect(out.completed).toBe(true);
  });

  it("a feeder in ANOTHER stage is invisible to the cascade, while an in-stage one is stamped (N3)", async () => {
    // POSITIVE PAIR first, so the negative below cannot pass vacuously: the
    // identical shape with the dead feeder IN the stage really is stamped.
    const live = await seedQualifiedStage(8);
    for (const id of pairingOfSeeds(live.qualified, 4, 5)) {
      await withdrawEntrantCascade(live.auth, id);
    }
    await generateStageFixtures(live.auth, live.stageId);
    const liveGen = await rowsOf(live.stageId);
    const liveVoid = liveGen.find(isDead)!;
    const liveSibling = liveGen.find(
      (r) => r.winner_to_fixture === liveVoid.winner_to_fixture && r.id !== liveVoid.id,
    )!;
    await play(live.auth, liveSibling.id);
    const liveTarget = (await rowsOf(live.stageId)).find((r) => r.id === liveVoid.winner_to_fixture)!;
    expect(labelled(liveTarget), "in-stage dead feeder: the seat IS stamped").toHaveLength(1);

    // NEGATIVE. Same board, but the dead feeder is moved into a second stage —
    // which is exactly the shape `wireCrossFeeds` builds, an out-of-stage
    // source that one `where stage_id = $1` read can never see. The cascade
    // must leave that seat alone rather than treat "no feeder I can see" as
    // "feeder is dead" and hand out a free walkover.
    const far = await seedQualifiedStage(8);
    for (const id of pairingOfSeeds(far.qualified, 4, 5)) {
      await withdrawEntrantCascade(far.auth, id);
    }
    await generateStageFixtures(far.auth, far.stageId);
    const [other] = await createStages(far.auth, far.divisionId, [
      { seq: 2, kind: "knockout", name: "Elsewhere", config: {} },
    ]);
    const farGen = await rowsOf(far.stageId);
    const farVoid = farGen.find(isDead)!;
    const farTargetId = farVoid.winner_to_fixture!;
    const farSibling = farGen.find(
      (r) => r.winner_to_fixture === farTargetId && r.id !== farVoid.id,
    )!;
    await sql`update fixtures set stage_id = ${other!.id} where id = ${farVoid.id}`;

    // Playing the sibling is what makes the seat "actionable"; the cascade runs
    // (onDecided) and finds no feeder for the open seat, because its feeder is
    // now another stage's row.
    await play(far.auth, farSibling.id);
    const farTarget = (await rowsOf(far.stageId)).find((r) => r.id === farTargetId)!;
    expect(labelled(farTarget), "cross-stage feeder: the seat is NOT stamped").toEqual([]);
    expect(farTarget.status, "and it is NOT settled as a walkover").toBe("scheduled");
    expect(farTarget.outcome).toBeNull();
  });
});
