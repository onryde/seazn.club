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
import { BRACKET_KINDS, SETTLE_METHODS, type StageKind } from "@seazn/engine/core";
import { generateSingleElim } from "@seazn/engine/scheduling";
import { builtinModules } from "@seazn/engine/sports";
import { forEachSportAsync } from "@seazn/engine/testkit";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { getFixtureState } from "../fixtures";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import {
  completeStage,
  createStages,
  generateStageFixtures,
  issueChallenge,
  rebuildStageFixtures,
  resolveBracketSeats,
} from "../stages";
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

// ---------------------------------------------------------------------------
// W2a Task 10 — NEW-H1 (spec §5.4.7, plan D4; reproduced at W2a Task 1 by
// apps/web/e2e/bracket-new-h1.spec.ts). In most sports a scorer's
// `core.abandon` folds to `outcome: null` — the SAME row shape the generator
// and this cascade write for their own event-less voids — so `feederIsDead`
// read a rained-off semi-final as a void and walked the other semi-finalist
// through the final. The 2026-09-21 ruling above says an abandoned match is
// stuck and visible. The line between the two is the ledger: an abandon that
// someone recorded is an ACTIVE `core.abandon`; a generator void has no event
// at all. The way out of "stuck" is the organiser's `core.settle` (X-ST-1:
// settle applies to an abandon with no outcome).
// ---------------------------------------------------------------------------

/** The engine's own settle vocabulary; a rename there reds here by name. */
const SETTLE_BY_ORGANISER = (() => {
  const m = SETTLE_METHODS.find((x) => x === "organiser");
  if (m === undefined) throw new Error("the engine declares no 'organiser' settle method");
  return m;
})();

async function fixtureRow(id: string): Promise<Row> {
  const [r] = await sql<Row[]>`
    select id, ext_key, round_no, seq_in_round, home_entrant_id, away_entrant_id,
           home_slot_label, away_slot_label, status, outcome,
           winner_to_fixture, winner_to_slot, loser_to_fixture, loser_to_slot
    from fixtures where id = ${id}`;
  if (!r) throw new Error(`no fixture ${id}`);
  return r;
}

async function post(auth: AuthCtx, id: string, type: string, payload: unknown = {}) {
  const [tip] = await sql<{ s: number }[]>`
    select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`;
  return scoreEvent(auth, id, { expected_seq: tip!.s, type, payload } as never);
}

/** A feed edge names seat 1 or 2; anything else is a broken graph, not "no seat". */
function seatOf(r: Row, slot: number | null): string | null {
  if (slot === 1) return r.home_entrant_id;
  if (slot === 2) return r.away_entrant_id;
  throw new Error(`fixture ${r.id}: a feed edge names slot ${slot}`);
}
function seatLabelOf(r: Row, slot: number | null): string | null {
  if (slot === 1) return r.home_slot_label?.key ?? null;
  if (slot === 2) return r.away_slot_label?.key ?? null;
  throw new Error(`fixture ${r.id}: a feed edge names slot ${slot}`);
}
const otherSlot = (slot: number | null): 1 | 2 => (slot === 1 ? 2 : 1);

/** A scorer's abandon, the shape the console's "Abandon…" control writes: started, then abandoned. */
async function scorerAbandon(auth: AuthCtx, id: string): Promise<void> {
  await post(auth, id, "core.start");
  await post(auth, id, "core.abandon", { reason: "rain" });
}

/** Decide a fixture for its home side by the away side's forfeit — `core.forfeit` is a core event every module folds. */
async function walkoverForHome(auth: AuthCtx, id: string): Promise<void> {
  const r = await fixtureRow(id);
  await post(auth, id, "core.start");
  await post(auth, id, "core.forfeit", { by: r.away_entrant_id, reason: "walkover" });
}

/** Decide a chess game for home over the board: a real `win` with a LOSER (a forfeit's award seats no loser). */
async function chessWinForHome(auth: AuthCtx, id: string): Promise<void> {
  const r = await fixtureRow(id);
  await post(auth, id, "core.start");
  await post(auth, id, "boardgame.result", { winner: r.home_entrant_id, method: "checkmate" });
}

/** Play every line an organiser could put on a court, except `skip`, until none is left. Returns how many. */
async function playOutExcept(
  auth: AuthCtx,
  stageId: string,
  decide: (auth: AuthCtx, id: string) => Promise<void>,
  skip: ReadonlySet<string>,
): Promise<number> {
  let played = 0;
  for (let guard = 0; guard < 16; guard++) {
    const open = (
      await sql<{ id: string }[]>`
        select id from fixtures where stage_id = ${stageId} and status = 'scheduled'
          and home_entrant_id is not null and away_entrant_id is not null
        order by round_no, seq_in_round`
    ).filter((r) => !skip.has(r.id));
    if (open.length === 0) return played;
    for (const f of open) {
      await decide(auth, f.id);
      played++;
    }
  }
  throw new Error("playOutExcept did not converge");
}

/** A later cascade pass, whatever triggers it (another decision, a void): the cascade's own entry point. */
const cascadePass = (stageId: string) => sql.begin((tx) => resolveBracketSeats(tx, stageId));

/** The two first-round lines that feed ONE later seat pair, and a first-round line elsewhere — from the generated
 *  feed graph, never from a typed seed list. */
async function quarterFinals(stageId: string): Promise<{ qa: Row; qb: Row; elsewhere: Row; semiId: string }> {
  const rows = await rowsOf(stageId);
  const first = Math.min(...rows.map((r) => r.round_no));
  const r1 = rows.filter((r) => r.round_no === first && r.home_entrant_id && r.away_entrant_id);
  const semiId = r1[0]?.winner_to_fixture;
  const pair = r1.filter((r) => r.winner_to_fixture === semiId);
  const elsewhere = r1.find((r) => r.winner_to_fixture !== semiId);
  if (!semiId || pair.length !== 2 || !elsewhere) throw new Error("the draw has no two seated lines feeding one semi");
  return { qa: pair[0]!, qb: pair[1]!, elsewhere, semiId };
}

/** The ladder: no generated fixture, no feed edge. A challenge is created on demand and feeds nobody. */
async function ladderAbandonedChallenge(): Promise<{
  stageId: string;
  challengeId: string;
  auth: AuthCtx;
  /** The four entrants in seed order (L1 = seed 1, the holder the challenge was issued against). */
  bySeed: string[];
}> {
  // single-sport: chess, the kinds sweep's sport (its scorer abandon folds to outcome null, the NEW-H1 shape).
  const sport = "boardgame";
  const sportModule = builtinModules.find((m) => m.key === sport)!;
  const variant = declaredVariant(sport, "classical");
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "H1 ladder " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sport,
    variant_key: variant,
    config: sportModule.variants[variant] as Record<string, unknown>,
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: 4 }, (_, i) => ({ kind: "individual" as const, display_name: `L${i + 1}`, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "ladder" as never, name: "Ladder", config: {} });
  await generateStageFixtures(auth, stage!.id);
  expect(await rowsOf(stage!.id), "a ladder generates nothing up front").toEqual([]);
  await startDivision(auth, division.id);
  const { fixture_id } = await issueChallenge(auth, stage!.id, {
    challenger_id: entrants[1]!.id,
    opponent_id: entrants[0]!.id,
  });
  await scorerAbandon(auth, fixture_id);
  return { stageId: stage!.id, challengeId: fixture_id, auth, bySeed: entrants.map((e) => e.id) };
}

const PER_SPORT_MS = 1_000;
const SPORT_SWEEP_BUDGET_MS = Math.max(30_000, builtinModules.length * PER_SPORT_MS * 5);
const PER_SHAPE_MS = 3_000;
interface KindShape {
  kind: StageKind;
  stageConfig: Record<string, unknown>;
}
/** Every bracket kind the engine declares, plus the knockout's third-place line (the one knockout LOSER edge). */
const KIND_SHAPES: readonly KindShape[] = [...BRACKET_KINDS].flatMap((kind): KindShape[] =>
  kind === "knockout"
    ? [
        { kind, stageConfig: {} },
        { kind, stageConfig: { thirdPlace: true } },
      ]
    : [{ kind, stageConfig: {} }],
);
const KIND_SWEEP_BUDGET_MS = Math.max(30_000, KIND_SHAPES.length * PER_SHAPE_MS * 5);

describe.skipIf(!HAS_DB)("NEW-H1: a scorer's abandon is not a generator void (spec §5.4.7, D4)", () => {
  it("NEW-H1: a scorer's abandon (an active core.abandon, outcome null) is NOT a dead feeder — the final stays stuck and visible", async () => {
    // single-sport: badminton is the probe's sport (bracket-new-h1.spec.ts) and folds a scorer's abandon to outcome null — asserted below; every sport is swept further down.
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 4 });
    const [sf1, sf2] = s.fixtureIds;
    await scoreEvent(s.auth, sf1!, { expected_seq: 0, type: "core.start", payload: {} } as never);
    await scoreEvent(s.auth, sf1!, { expected_seq: 1, type: "core.abandon", payload: { reason: "injury" } } as never);
    const abandoned = await fixtureRow(sf1!);
    expect(abandoned.status).toBe("abandoned");
    expect(abandoned.outcome, "the NEW-H1 shape: abandoned with NO outcome").toBeNull();
    const [r2] = await sql<{ away_entrant_id: string; winner_to_fixture: string }[]>`select away_entrant_id, winner_to_fixture from fixtures where id = ${sf2!}`;
    await scoreEvent(s.auth, sf2!, { expected_seq: 0, type: "core.start", payload: {} } as never);
    await scoreEvent(s.auth, sf2!, { expected_seq: 1, type: "core.forfeit", payload: { by: r2!.away_entrant_id, reason: "walkover" } } as never);
    const [fin] = await sql<{ status: string; outcome: unknown }[]>`select status, outcome from fixtures where id = ${r2!.winner_to_fixture}`;
    expect(fin).toEqual({ status: "scheduled", outcome: null });
    // The positive pair: the seat WAS actionable (its sibling filled), so the cascade really did look at it.
    const final = await fixtureRow(r2!.winner_to_fixture);
    const decided = await fixtureRow(sf2!);
    expect(seatOf(final, decided.winner_to_slot), "the other semi's winner took her seat").toBe(decided.outcome!.winner);
    expect(seatOf(final, abandoned.winner_to_slot), "the abandoned semi's seat is still empty").toBeNull();
    expect(seatLabelOf(final, abandoned.winner_to_slot), "and it is NOT stamped as a bye").not.toBe(BYE_KEY);
  });

  it("NEW-H1: the generator's own void (abandoned, outcome null, NO core.abandon event) is still dead — the walkover still happens", async () => {
    // single-sport: badminton, the same rig as the case above; the raw-SQL void is the event-less shape the existing dead-feeder cases build.
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 4 });
    const [sf1, sf2] = s.fixtureIds;
    await sql`update fixtures set status = 'abandoned', outcome = null where id = ${sf1!}`;
    const [events] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${sf1!}`;
    expect(events!.n, "premise: the generator's void has no ledger at all").toBe(0);
    const [r2] = await sql<{ away_entrant_id: string; winner_to_fixture: string }[]>`select away_entrant_id, winner_to_fixture from fixtures where id = ${sf2!}`;
    await scoreEvent(s.auth, sf2!, { expected_seq: 0, type: "core.start", payload: {} } as never);
    await scoreEvent(s.auth, sf2!, { expected_seq: 1, type: "core.forfeit", payload: { by: r2!.away_entrant_id, reason: "walkover" } } as never);
    const [fin] = await sql<{ status: string }[]>`select status from fixtures where id = ${r2!.winner_to_fixture}`;
    expect(fin!.status).toBe("forfeited");
  });

  it("NEW-H1: a VOIDED scorer abandon is not active — a feeder the generator later voids is dead and the walkover happens", async () => {
    // single-sport: badminton, the same rig as the cases above.
    // preflight C22: this case asserts the feeder's seat outcome (the final's status), not only the feeder's status.
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 4 });
    const [sf1, sf2] = s.fixtureIds;
    await scoreEvent(s.auth, sf1!, { expected_seq: 0, type: "core.start", payload: {} } as never);
    await scoreEvent(s.auth, sf1!, { expected_seq: 1, type: "core.abandon", payload: { reason: "injury" } } as never);
    const [ab] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${sf1!} and type = 'core.abandon'`;
    await scoreEvent(s.auth, sf1!, { expected_seq: 2, type: "core.void", payload: { event_id: ab!.id } } as never);
    const [live] = await sql<{ status: string }[]>`select status from fixtures where id = ${sf1!}`;
    expect(live!.status).toBe("in_play"); // the abandon is gone; the match is live again
    // The generator's void, written without an event (the raw-SQL shape the existing dead-feeder cases use).
    await sql`update fixtures set status = 'abandoned', outcome = null where id = ${sf1!}`;
    const [r2] = await sql<{ away_entrant_id: string; winner_to_fixture: string }[]>`select away_entrant_id, winner_to_fixture from fixtures where id = ${sf2!}`;
    await scoreEvent(s.auth, sf2!, { expected_seq: 0, type: "core.start", payload: {} } as never);
    await scoreEvent(s.auth, sf2!, { expected_seq: 1, type: "core.forfeit", payload: { by: r2!.away_entrant_id, reason: "walkover" } } as never);
    const [fin] = await sql<{ status: string }[]>`select status from fixtures where id = ${r2!.winner_to_fixture}`;
    expect(fin!.status).toBe("forfeited"); // feederIsDead(sf1) === true: the voided abandon did not count as active
  });

  it("NEW-H1: reverse order — the sibling decided FIRST, then the abandon, then a decision elsewhere runs the cascade: the seat still waits", async () => {
    // single-sport: badminton, the NEW-H1 shape. An abandon alone runs no cascade (onDecided needs an outcome), so the
    // pass that would have walked the sibling through comes from ANOTHER line's decision — the order Task 1 left undriven.
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 8 });
    const { qa, qb, elsewhere, semiId } = await quarterFinals(s.stageId);
    await walkoverForHome(s.auth, qb.id);
    await scorerAbandon(s.auth, qa.id);
    expect((await fixtureRow(qa.id)).outcome, "premise: the NEW-H1 shape").toBeNull();
    await walkoverForHome(s.auth, elsewhere.id); // onDecided → resolveBracketSeats over the whole stage
    const semi = await fixtureRow(semiId);
    expect(seatOf(semi, qb.winner_to_slot), "the sibling's winner holds her seat").toBe(qb.home_entrant_id);
    expect(seatOf(semi, qa.winner_to_slot), "the abandoned line's seat waits").toBeNull();
    expect(seatLabelOf(semi, qa.winner_to_slot)).not.toBe(BYE_KEY);
    expect([semi.status, semi.outcome]).toEqual(["scheduled", null]);
    // A second pass, whatever triggers it, has nothing to do.
    expect(await cascadePass(s.stageId)).toEqual([]);
  });

  it(
    "NEW-H1: every sport — a scorer-abandoned semi never walks the other semi-finalist through the final, whatever its abandon folds to",
    async () => {
      let nullShape = 0;
      let outcomeShape = 0;
      const checked = await forEachSportAsync(async ({ key, module: sportModule }) => {
        // The sport's FIRST declared variant: an engine declaration, never a guessed key.
        const variant = Object.keys(sportModule.variants)[0];
        if (variant === undefined) throw new Error(`${key} declares no variant`);
        const s = await seedBracket({ sport: key, variant: declaredVariant(key, variant), stageKind: "knockout", entrants: 4 });
        const [sf1, sf2] = s.fixtureIds;
        if (!sf1 || !sf2) throw new Error(`${key}: a 4-draw knockout seats two semis`);
        await scorerAbandon(s.auth, sf1);
        const abandoned = await fixtureRow(sf1);
        expect(abandoned.status, key).toBe("abandoned"); // D3 order 2: an active abandon is abandoned, whatever it folds to
        if (abandoned.outcome === null) nullShape++;
        else outcomeShape++;
        await walkoverForHome(s.auth, sf2);
        const decided = await fixtureRow(sf2);
        const winner = decided.outcome?.winner;
        expect(winner, `${key}: the sibling semi produced a winner`).toBeTruthy();
        expect(decided.winner_to_fixture, `${key}: both semis feed one final`).toBe(abandoned.winner_to_fixture);
        const final = await fixtureRow(abandoned.winner_to_fixture!);
        expect(seatOf(final, decided.winner_to_slot), `${key}: the sibling's winner is seated`).toBe(winner);
        expect(seatOf(final, abandoned.winner_to_slot), `${key}: the abandoned semi's seat waits`).toBeNull();
        expect(seatLabelOf(final, abandoned.winner_to_slot), `${key}: and is not a bye`).not.toBe(BYE_KEY);
        expect([final.status, final.outcome], key).toEqual(["scheduled", null]);
        expect(await cascadePass(s.stageId), `${key}: a later pass has nothing to do`).toEqual([]);
      });
      expect(checked).toBe(builtinModules.length);
      expect(nullShape + outcomeShape).toBe(checked);
      expect(nullShape, "the NEW-H1 shape (abandon → outcome null) was reached").toBeGreaterThan(0);
      expect(outcomeShape, "the 2026-09-21 shape (abandon → an outcome) was reached too").toBeGreaterThan(0);
    },
    SPORT_SWEEP_BUDGET_MS,
  );

  it(
    "NEW-H1 / X-ST-1: every bracket kind — the seats an abandoned feeder feeds wait unstamped while the rest plays out; the organiser's settle fills both edges and the bracket finishes",
    async () => {
      // single-sport: chess — its scorer abandon folds to outcome null (the NEW-H1 shape, asserted per kind) and one
      // boardgame.result is a real win with a LOSER, so every loser edge is driven; every sport is swept above.
      let kinds = 0;
      let edges = 0;
      let loserEdges = 0;
      const actionableByShape: Record<string, number> = {};
      for (const { kind, stageConfig } of KIND_SHAPES) {
        const label = `${kind}${stageConfig.thirdPlace ? "+third-place" : ""}`;
        if (kind === "ladder") {
          // The empty case: a ladder wires no feed edge, so an abandoned challenge strands no seat and the cascade
          // has nothing to judge. Proven on a real challenge, not assumed.
          const l = await ladderAbandonedChallenge();
          const rows = await rowsOf(l.stageId);
          expect(rows.map((r) => r.id), label).toEqual([l.challengeId]);
          expect(rows.filter((r) => r.winner_to_fixture || r.loser_to_fixture), `${label}: no feed edge`).toEqual([]);
          expect([rows[0]!.status, rows[0]!.outcome], label).toEqual(["abandoned", null]);
          expect(await cascadePass(l.stageId), label).toEqual([]);
          actionableByShape[label] = 0;
          kinds++;
          continue;
        }
        const s = await seedBracket({ sport: "boardgame", variant: declaredVariant("boardgame", "classical"), stageKind: kind, entrants: 4, stageConfig });
        const feeder = (await rowsOf(s.stageId)).find(
          (r) => r.home_entrant_id && r.away_entrant_id && (r.winner_to_fixture || r.loser_to_fixture),
        );
        if (!feeder) throw new Error(`${label}: no seated line feeds a seat`);
        const out = [
          { via: "winner" as const, to: feeder.winner_to_fixture, slot: feeder.winner_to_slot },
          { via: "loser" as const, to: feeder.loser_to_fixture, slot: feeder.loser_to_slot },
        ].filter((e): e is { via: "winner" | "loser"; to: string; slot: number | null } => e.to !== null);
        await scorerAbandon(s.auth, feeder.id);
        const abandoned = await fixtureRow(feeder.id);
        expect([abandoned.status, abandoned.outcome], `${label}: the NEW-H1 shape`).toEqual(["abandoned", null]);

        await playOutExcept(s.auth, s.stageId, chessWinForHome, new Set([feeder.id]));
        expect(await cascadePass(s.stageId), `${label}: a later pass has nothing to do`).toEqual([]);
        actionableByShape[label] = 0;
        for (const e of out) {
          const t = await fixtureRow(e.to);
          const where = `${label}, ${e.via} edge`;
          expect(seatOf(t, e.slot), `${where}: the seat waits`).toBeNull();
          expect(seatLabelOf(t, e.slot), `${where}: not a bye`).not.toBe(BYE_KEY);
          expect([t.status, t.outcome], `${where}: not walked over`).toEqual(["scheduled", null]);
          // Actionable = its sibling seat is filled, the state in which the cascade WOULD stamp a dead feeder's seat.
          if (seatOf(t, otherSlot(e.slot)) !== null) actionableByShape[label]++;
          edges++;
          if (e.via === "loser") loserEdges++;
        }
        expect(actionableByShape[label], `${label}: at least one seat was actionable, so the cascade really looked`).toBeGreaterThan(0);
        expect((await completeStage(s.auth, s.stageId)).completed, `${label}: the stage waits for the organiser`).toBe(false);

        // The way out: the organiser settles the abandoned line; both of its edges fill (a settle is a win, X-ST-1).
        await post(s.auth, feeder.id, "core.settle", { winner: feeder.home_entrant_id, method: SETTLE_BY_ORGANISER });
        for (const e of out) {
          expect(seatOf(await fixtureRow(e.to), e.slot), `${label}, ${e.via} edge after the settle`).toBe(
            e.via === "winner" ? feeder.home_entrant_id : feeder.away_entrant_id,
          );
        }
        await playOutExcept(s.auth, s.stageId, chessWinForHome, new Set());
        expect((await completeStage(s.auth, s.stageId)).completed, `${label}: the bracket finishes`).toBe(true);
        kinds++;
      }
      expect(kinds).toBe(KIND_SHAPES.length);
      expect(Object.keys(actionableByShape).sort()).toEqual(
        KIND_SHAPES.map(({ kind, stageConfig }) => `${kind}${stageConfig.thirdPlace ? "+third-place" : ""}`).sort(),
      );
      expect(edges, "feed edges checked across the bracket kinds").toBeGreaterThan(0);
      expect(loserEdges, "loser edges checked (third place, double_elim, page_playoff): both edges, not one").toBeGreaterThan(0);
      expect(loserEdges, "and winner edges too").toBeLessThan(edges);
    },
    KIND_SWEEP_BUDGET_MS,
  );

  it("NEW-H1 / X-BR-2: a HELD feeder (needs_decision) is not dead either — neither of its seats is stamped, and the settle fills both", async () => {
    // single-sport: football — a 0–0 full time is a play-produced level result, held in a bracket (X-BR-2). W2b's
    // "decided, nobody advances" clause will sit beside the abandon clause and must not sweep a held row in.
    const s = await seedBracket({ sport: "football", variant: declaredVariant("football", "11-a-side"), stageKind: "knockout", entrants: 4, stageConfig: { thirdPlace: true } });
    const [sf1, sf2] = s.fixtureIds;
    await post(s.auth, sf1!, "core.start");
    await post(s.auth, sf1!, "football.period", { phase: "HT" });
    await post(s.auth, sf1!, "football.period", { phase: "FT" });
    const held = await fixtureRow(sf1!);
    expect([held.status, held.outcome?.kind], "premise: held").toEqual(["needs_decision", "draw"]);
    // sf2 by walkover: its award seats a winner in the final and drops NO loser, so the third-place line ends up with
    // one dead feeder (sf2, an award) beside the held one — a held feeder read as dead would void that line.
    await walkoverForHome(s.auth, sf2!);
    expect(await cascadePass(s.stageId)).toEqual([]);
    const final = await fixtureRow(held.winner_to_fixture!);
    expect(seatOf(final, otherSlot(held.winner_to_slot)), "the final's other seat is filled: actionable").not.toBeNull();
    expect(seatOf(final, held.winner_to_slot)).toBeNull();
    expect(seatLabelOf(final, held.winner_to_slot)).not.toBe(BYE_KEY);
    expect([final.status, final.outcome]).toEqual(["scheduled", null]);
    const third = await fixtureRow(held.loser_to_fixture!);
    expect([third.status, third.outcome], "the third-place line is not voided").toEqual(["scheduled", null]);
    expect(seatLabelOf(third, held.loser_to_slot)).not.toBe(BYE_KEY);

    await post(s.auth, sf1!, "core.settle", { winner: held.home_entrant_id, method: SETTLE_BY_ORGANISER });
    expect(seatOf(await fixtureRow(final.id), held.winner_to_slot)).toBe(held.home_entrant_id);
    expect(seatOf(await fixtureRow(third.id), held.loser_to_slot)).toBe(held.away_entrant_id);
  });

  it("NEW-H1 (after a withdrawal): a page-playoff withdrawal's own abandon holds the line like a scorer's — her opponent is settled through, never eliminated by an invented walkover (X-ST-1, ruling C17)", async () => {
    // single-sport: badminton, where the withdrawal's core.abandon folds to outcome null — the NEW-H1 shape (generic's
    // folds to no_result and was already held under the 2026-09-21 ruling).
    // page_playoff is the bracket kind whose withdrawal WRITES an abandon: it is not in BRACKET_WALKOVER_KINDS, so
    // withdrawal.ts voids the departed entrant's pending lines with core.abandon (the open-format branch). The walkover
    // kinds never do on a seated line — their planner names the opponent and writes core.forfeit.
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "page_playoff", entrants: 4 });
    const rows = await rowsOf(s.stageId);
    const q1 = rows.find((r) => r.home_entrant_id && r.away_entrant_id && r.winner_to_fixture && r.loser_to_fixture);
    const elim = rows.find((r) => r.home_entrant_id && r.away_entrant_id && r.id !== q1?.id);
    if (!q1 || !elim) throw new Error("page_playoff: no seated qualifier with both edges beside a seated eliminator");
    const departing = q1.home_entrant_id!;
    const opponent = q1.away_entrant_id!;
    await withdrawEntrantCascade(s.auth, departing);
    const voided = await fixtureRow(q1.id);
    expect([voided.status, voided.outcome], "premise: the withdrawal abandoned the line, outcome null").toEqual(["abandoned", null]);
    const active = await sql<{ reason: string }[]>`
      select a.payload->>'reason' as reason from score_events a
      where a.fixture_id = ${q1.id} and a.type = 'core.abandon'
        and not exists (select 1 from score_events v where v.fixture_id = a.fixture_id and v.voids_event_id = a.id)`;
    expect(active.map((r) => r.reason), "premise: an ACTIVE core.abandon, written by the withdrawal").toEqual(["entrant withdrew"]);

    await walkoverForHome(s.auth, elim.id); // the eliminator's winner reaches qualifier 2, beside q1's LOSER seat
    const q2 = await fixtureRow(q1.loser_to_fixture!);
    expect(seatOf(q2, otherSlot(q1.loser_to_slot)), "q2's other seat is filled: actionable").not.toBeNull();
    expect(seatOf(q2, q1.loser_to_slot), "q1's loser seat waits").toBeNull();
    expect(seatLabelOf(q2, q1.loser_to_slot)).not.toBe(BYE_KEY);
    expect([q2.status, q2.outcome], "the eliminator's winner is NOT walked through q2").toEqual(["scheduled", null]);
    const final = await fixtureRow(q1.winner_to_fixture!);
    expect([final.home_entrant_id, final.away_entrant_id, final.status], "nobody walked into the final").toEqual([null, null, "scheduled"]);
    expect(await cascadePass(s.stageId)).toEqual([]);

    // The organiser's way through: never for the departed entrant (C17); for her opponent it seats them in the final.
    await expect(post(s.auth, q1.id, "core.settle", { winner: departing, method: SETTLE_BY_ORGANISER })).rejects.toMatchObject({
      code: "SETTLE_NOT_APPLICABLE",
    });
    await post(s.auth, q1.id, "core.settle", { winner: opponent, method: SETTLE_BY_ORGANISER });
    expect(seatOf(await fixtureRow(final.id), q1.winner_to_slot), "her opponent goes through").toBe(opponent);
  });
});

// ---------------------------------------------------------------------------
// W2a Task 10, fix round 1 (loop G review). The cascade above holds a recorded
// abandon's SEATS; the minors below pin what its first build left unwitnessed.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("NEW-H1 fix round 1: the clauses and sequences the first build left unwitnessed", () => {
  it("NEW-H1 (M1): an event-less abandoned feeder that CARRIES an outcome (no_result) is not dead — the seat waits", async () => {
    // single-sport: badminton, the probe's rig. The row is the generator's event-less shape given the no_result a
    // cricket, carrom or generic abandon folds to: with no ledger, `has_active_abandon` cannot answer for it, so the
    // `outcome === null` clause must.
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 4 });
    const [sf1, sf2] = s.fixtureIds;
    await sql`update fixtures set status = 'abandoned', outcome = ${sql.json({ kind: "no_result" } as never)} where id = ${sf1!}`;
    const [events] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${sf1!}`;
    expect(events!.n, "premise: no ledger at all").toBe(0);
    await walkoverForHome(s.auth, sf2!);
    const fed = await fixtureRow(sf1!);
    const final = await fixtureRow(fed.winner_to_fixture!);
    expect(seatOf(final, otherSlot(fed.winner_to_slot)), "the sibling's winner is seated: actionable").not.toBeNull();
    expect(seatOf(final, fed.winner_to_slot), "the no-result line's seat waits").toBeNull();
    expect(seatLabelOf(final, fed.winner_to_slot)).not.toBe(BYE_KEY);
    expect([final.status, final.outcome], "nobody walked through the final").toEqual(["scheduled", null]);
  });

  it("NEW-H1 (M2): abandon → settle → void of the settle — the line is abandoned again with its abandon active, and the seat the settle filled is released and waits", async () => {
    // single-sport: badminton, the probe's sport (abandon folds to outcome null).
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 4 });
    const [sf1, sf2] = s.fixtureIds;
    await scorerAbandon(s.auth, sf1!);
    await walkoverForHome(s.auth, sf2!);
    const fed = await fixtureRow(sf1!);
    await post(s.auth, sf1!, "core.settle", { winner: fed.home_entrant_id, method: SETTLE_BY_ORGANISER });
    expect((await fixtureRow(sf1!)).status, "the settle decides the line").toBe("decided");
    expect(seatOf(await fixtureRow(fed.winner_to_fixture!), fed.winner_to_slot), "and seats its winner").toBe(fed.home_entrant_id);

    const [settle] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${sf1!} and type = 'core.settle'`;
    await post(s.auth, sf1!, "core.void", { event_id: settle!.id });
    const back = await fixtureRow(sf1!);
    expect([back.status, back.outcome], "back to the abandon").toEqual(["abandoned", null]);
    const active = await sql<{ id: string }[]>`
      select a.id from score_events a
      where a.fixture_id = ${sf1!} and a.type = 'core.abandon'
        and not exists (select 1 from score_events v where v.fixture_id = a.fixture_id and v.voids_event_id = a.id)`;
    expect(active.length, "the abandon is still active").toBe(1);
    const final = await fixtureRow(fed.winner_to_fixture!);
    expect(seatOf(final, otherSlot(fed.winner_to_slot)), "the sibling keeps her seat").not.toBeNull();
    expect(seatOf(final, fed.winner_to_slot), "the settled winner's seat is released").toBeNull();
    expect(seatLabelOf(final, fed.winner_to_slot), "and waits — not stamped a bye").not.toBe(BYE_KEY);
    expect([final.status, final.outcome]).toEqual(["scheduled", null]);
    expect(await cascadePass(s.stageId), "a later pass has nothing to do").toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("characterisation (ruling D-G2, deferred to W2b): what a withdrawal does to a held line today", () => {
  it("characterisation (D-G2, W2b): a settle for the opponent of a page-playoff withdrawal seats the WITHDRAWN entrant on q1's loser edge in q2", async () => {
    // single-sport: badminton, the withdrawal case's rig. Pins TODAY's behaviour so W2b changes it on purpose: whether
    // a loser edge may seat a departed entrant is W2b's (spec §2.3, ruling D-G2).
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "page_playoff", entrants: 4 });
    const q1 = (await rowsOf(s.stageId)).find((r) => r.home_entrant_id && r.away_entrant_id && r.winner_to_fixture && r.loser_to_fixture);
    if (!q1) throw new Error("page_playoff: no seated qualifier with both edges");
    const departing = q1.home_entrant_id!;
    await withdrawEntrantCascade(s.auth, departing);
    await post(s.auth, q1.id, "core.settle", { winner: q1.away_entrant_id, method: SETTLE_BY_ORGANISER });
    const q2 = await fixtureRow(q1.loser_to_fixture!);
    expect(seatOf(q2, q1.loser_to_slot), "the departed entrant is seated on the loser edge").toBe(departing);
    const [e] = await sql<{ status: string }[]>`select status from entrants where id = ${departing}`;
    expect(e!.status, "and she IS withdrawn").toBe("withdrawn");
  });

  it("characterisation (D-G2, W2b): a knockout line its scorer abandoned whose BOTH entrants then withdraw refuses every settle (C17) and its seat waits; the organiser's escape — void the abandon, forfeit, forfeit forward — finishes the stage", async () => {
    // single-sport: badminton (abandon folds to outcome null). W2b's X-WD-1 / double-walkover clause owns the answer.
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 4 });
    const [sf1, sf2] = s.fixtureIds;
    const r1 = await fixtureRow(sf1!);
    await scorerAbandon(s.auth, sf1!);
    const w1 = await withdrawEntrantCascade(s.auth, r1.home_entrant_id!);
    const w2 = await withdrawEntrantCascade(s.auth, r1.away_entrant_id!);
    expect([w1.walkovers, w1.voided, w2.walkovers, w2.voided], "the withdrawals leave the abandoned line alone").toEqual([0, 0, 0, 0]);
    await walkoverForHome(s.auth, sf2!);
    for (const who of [r1.home_entrant_id, r1.away_entrant_id]) {
      await expect(post(s.auth, sf1!, "core.settle", { winner: who, method: SETTLE_BY_ORGANISER })).rejects.toMatchObject({
        code: "SETTLE_NOT_APPLICABLE",
      });
    }
    const final = await fixtureRow(r1.winner_to_fixture!);
    expect(seatOf(final, otherSlot(r1.winner_to_slot)), "the other semi's winner is seated").not.toBeNull();
    expect(seatOf(final, r1.winner_to_slot), "the abandoned line's seat waits").toBeNull();
    expect(seatLabelOf(final, r1.winner_to_slot)).not.toBe(BYE_KEY);
    expect((await completeStage(s.auth, s.stageId)).completed, "stuck").toBe(false);

    const [ab] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${sf1!} and type = 'core.abandon'`;
    await post(s.auth, sf1!, "core.void", { event_id: ab!.id });
    await post(s.auth, sf1!, "core.forfeit", { by: r1.home_entrant_id, reason: "walkover" });
    expect(seatOf(await fixtureRow(final.id), r1.winner_to_slot), "the award carries the withdrawn away entrant forward").toBe(
      r1.away_entrant_id,
    );
    await post(s.auth, final.id, "core.start");
    await post(s.auth, final.id, "core.forfeit", { by: r1.away_entrant_id, reason: "withdrawn" });
    expect((await completeStage(s.auth, s.stageId)).completed, "the escape finishes the stage").toBe(true);
  });

  it("characterisation (D-G2, W2b): page_playoff — both q1 entrants withdraw (the first writes the abandon); every settle is refused and q2's loser seat and the final wait", async () => {
    // single-sport: badminton. The open-format branch abandons q1 on the first withdrawal; the second finds nothing pending.
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "page_playoff", entrants: 4 });
    const rows = await rowsOf(s.stageId);
    const q1 = rows.find((r) => r.home_entrant_id && r.away_entrant_id && r.winner_to_fixture && r.loser_to_fixture);
    const elim = rows.find((r) => r.home_entrant_id && r.away_entrant_id && r.id !== q1?.id);
    if (!q1 || !elim) throw new Error("page_playoff: no seated qualifier beside a seated eliminator");
    const w1 = await withdrawEntrantCascade(s.auth, q1.home_entrant_id!);
    const w2 = await withdrawEntrantCascade(s.auth, q1.away_entrant_id!);
    expect([w1.voided, w2.voided], "the first withdrawal abandons q1; the second finds nothing pending").toEqual([1, 0]);
    await walkoverForHome(s.auth, elim.id);
    for (const who of [q1.home_entrant_id, q1.away_entrant_id]) {
      await expect(post(s.auth, q1.id, "core.settle", { winner: who, method: SETTLE_BY_ORGANISER })).rejects.toMatchObject({
        code: "SETTLE_NOT_APPLICABLE",
      });
    }
    const q2 = await fixtureRow(q1.loser_to_fixture!);
    expect(seatOf(q2, q1.loser_to_slot)).toBeNull();
    expect([q2.status, q2.outcome]).toEqual(["scheduled", null]);
    const final = await fixtureRow(q1.winner_to_fixture!);
    expect([final.home_entrant_id, final.away_entrant_id, final.status]).toEqual([null, null, "scheduled"]);
    expect((await completeStage(s.auth, s.stageId)).completed, "stuck").toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W2a Task 10, fix round 1 — ruling D-G1 (loop G review, measured). A recorded
// abandon that decided nobody is not the generator's void at COMPLETION either:
// `engineFixtureStatus` maps `abandoned` to `void`, `void` is in the engine's
// SETTLED set, so a scorer-abandoned FINAL completed the stage and
// `bracketRanks` ranked its two unbeaten finalists LAST (their missing loss
// reads as elimination round −1). An abandoned ladder challenge completed the
// ladder the same way. The stage now waits for the organiser's settle.
// ---------------------------------------------------------------------------

async function completion(auth: AuthCtx, stageId: string) {
  const r = await completeStage(auth, stageId);
  const done = r.events.find((e) => e.type === "stage_completed");
  const [st] = await sql<{ status: string }[]>`select status from stages where id = ${stageId}`;
  const [ev] = await sql<{ n: number }[]>`
    select count(*)::int as n from division_events where type = 'stage_completed' and payload->>'stageId' = ${stageId}`;
  return {
    completed: r.completed,
    ranks: done?.type === "stage_completed" ? done.finalRanks : null,
    stageStatus: st!.status,
    completedEvents: ev!.n,
  };
}

/** A 4-draw knockout whose two semis are walked over for home, then whose FINAL its scorer abandons. */
async function abandonedFinal(sport: string, variant: string) {
  const s = await seedBracket({ sport, variant: declaredVariant(sport, variant), stageKind: "knockout", entrants: 4 });
  const [sf1, sf2] = s.fixtureIds;
  if (!sf1 || !sf2) throw new Error(`${sport}: a 4-draw knockout seats two semis`);
  await walkoverForHome(s.auth, sf1);
  await walkoverForHome(s.auth, sf2);
  const semis = [await fixtureRow(sf1), await fixtureRow(sf2)];
  const finalId = semis[0]!.winner_to_fixture!;
  const final = await fixtureRow(finalId);
  expect([final.home_entrant_id, final.away_entrant_id].sort(), `${sport}: both semi winners reached the final`).toEqual(
    semis.map((r) => r.home_entrant_id).sort(),
  );
  await scorerAbandon(s.auth, finalId);
  return { s, final, sfLosers: semis.map((r) => r.away_entrant_id!), abandoned: await fixtureRow(finalId) };
}

describe.skipIf(!HAS_DB)("D-G1: a recorded abandon that decided nobody holds stage completion (W2a T10 fix round 1)", () => {
  it("D-G1: a scorer-abandoned FINAL holds the knockout open — completeStage answers false and ranks nobody, twice; the organiser's settle completes it with the settled winner champion", async () => {
    // single-sport: badminton, the reviewer's probe (4 players, both semis by walkover, final abandoned); every sport is swept below.
    const { s, final, sfLosers, abandoned } = await abandonedFinal("badminton", "bwf");
    expect([abandoned.status, abandoned.outcome], "premise: the NEW-H1 shape on the final").toEqual(["abandoned", null]);
    for (const call of ["first", "second"]) {
      const c = await completion(s.auth, s.stageId);
      expect(c, `${call} call: not complete, nothing ranked, nothing written`).toEqual({
        completed: false,
        ranks: null,
        stageStatus: "active",
        completedEvents: 0,
      });
    }
    // The way out (X-ST-1): settle for the AWAY finalist, so the champion is not whoever a seed or a home seat favours.
    await post(s.auth, final.id, "core.settle", { winner: final.away_entrant_id, method: SETTLE_BY_ORGANISER });
    const c = await completion(s.auth, s.stageId);
    expect([c.completed, c.stageStatus, c.completedEvents]).toEqual([true, "complete", 1]);
    expect(c.ranks!.slice(0, 2), "champion = the settle's winner, runner-up = the other finalist").toEqual([
      final.away_entrant_id,
      final.home_entrant_id,
    ]);
    expect(new Set(c.ranks!.slice(2)), "the semi-final losers are 3rd and 4th").toEqual(new Set(sfLosers));
    expect(c.ranks).toHaveLength(4);
  });

  it(
    "D-G1: every sport — a final its scorer abandoned holds the stage open whatever the abandon folds to (null or no_result); the settle completes it",
    async () => {
      let nullShape = 0;
      let levelShape = 0;
      const checked = await forEachSportAsync(async ({ key, module: sportModule }) => {
        const variant = Object.keys(sportModule.variants)[0];
        if (variant === undefined) throw new Error(`${key} declares no variant`);
        const { s, final, sfLosers, abandoned } = await abandonedFinal(key, variant);
        expect(abandoned.status, key).toBe("abandoned");
        if (abandoned.outcome === null) nullShape++;
        else {
          expect(abandoned.outcome.kind, `${key}: an abandon that carries an outcome carries no winner`).toBe("no_result");
          levelShape++;
        }
        const held = await completion(s.auth, s.stageId);
        expect([held.completed, held.stageStatus, held.completedEvents], `${key}: held open`).toEqual([false, "active", 0]);
        await post(s.auth, final.id, "core.settle", { winner: final.away_entrant_id, method: SETTLE_BY_ORGANISER });
        const done = await completion(s.auth, s.stageId);
        expect(done.completed, `${key}: the settle completes it`).toBe(true);
        expect(done.ranks!.slice(0, 2), key).toEqual([final.away_entrant_id, final.home_entrant_id]);
        expect(new Set(done.ranks!.slice(2)), key).toEqual(new Set(sfLosers));
      });
      expect(checked).toBe(builtinModules.length);
      expect(nullShape + levelShape).toBe(checked);
      expect(nullShape, "abandon → outcome null was reached").toBeGreaterThan(0);
      expect(levelShape, "abandon → no_result was reached").toBeGreaterThan(0);
    },
    SPORT_SWEEP_BUDGET_MS * 2,
  );

  it("D-G1: a ladder whose only challenge its scorer abandoned is not complete, twice; the settle completes it in ladder order", async () => {
    // single-sport: chess, the ladder rig's sport (abandon folds to outcome null).
    const l = await ladderAbandonedChallenge();
    for (const call of ["first", "second"]) {
      const c = await completion(l.auth, l.stageId);
      expect(c, `${call} call`).toEqual({ completed: false, ranks: null, stageStatus: "active", completedEvents: 0 });
    }
    // Settle for the HOLDER (seed 1): the challenger did not climb, so the ladder keeps its seed order (Jul3/08 §6:
    // the order is initialised from seeds and moves only when a challenger wins).
    await post(l.auth, l.challengeId, "core.settle", { winner: l.bySeed[0], method: SETTLE_BY_ORGANISER });
    const c = await completion(l.auth, l.stageId);
    expect([c.completed, c.stageStatus, c.completedEvents]).toEqual([true, "complete", 1]);
    expect(c.ranks).toEqual(l.bySeed);
  });

  it("D-G1 guard: the unbeaten default never ranks a FIELD entrant — a final settled with nobody winning while both finalists are in the field is refused CONFIG_INVALID, never snapshotted with its finalists last", async () => {
    // single-sport: badminton, the probe's rig. The row is FORCED — the generator's event-less void given two seated
    // finalists. No product path writes it after D-G1 (a recorded abandon holds the stage open; the generator voids
    // only empty lines and departed ones), so this guard is reachable only through a bug, and this is how a test gets there.
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 4 });
    const [sf1, sf2] = s.fixtureIds;
    await walkoverForHome(s.auth, sf1!);
    await walkoverForHome(s.auth, sf2!);
    const semis = [await fixtureRow(sf1!), await fixtureRow(sf2!)];
    const final = await fixtureRow(semis[0]!.winner_to_fixture!);
    await sql`update fixtures set status = 'abandoned', outcome = null where id = ${final.id}`;
    await expect(completeStage(s.auth, s.stageId)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    const [st] = await sql<{ status: string }[]>`select status from stages where id = ${s.stageId}`;
    expect(st!.status, "nothing was written").toBe("active");

    // The positive pair: the same void with BOTH finalists departed is the F14 shape (walkoverDepartedQualifiers) —
    // departed entrants are ranked by the unbeaten default, last, legitimately, and the stage completes.
    await sql`update entrants set status = 'withdrawn' where id in ${sql([final.home_entrant_id!, final.away_entrant_id!])}`;
    const c = await completion(s.auth, s.stageId);
    expect(c.completed).toBe(true);
    expect(new Set(c.ranks!.slice(0, 2)), "the semi-final losers lost later than anyone departed").toEqual(
      new Set(semis.map((r) => r.away_entrant_id)),
    );
    expect(new Set(c.ranks!.slice(2)), "the departed finalists are last").toEqual(
      new Set([final.home_entrant_id, final.away_entrant_id]),
    );
  });
});
