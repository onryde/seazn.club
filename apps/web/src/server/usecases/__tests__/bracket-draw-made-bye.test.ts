// #850, review round 3, finding 1 (orchestrator reading of the owner's
// second-round ICS ruling): a knockout sit-out the DRAW made is a sit-out
// wherever the cascade finds it, not only in round one.
//
// `resolveBracketSeats` stamps a bye on a seat whose feeder is permanently
// dead. Two very different things kill a feeder:
//   - THE DRAW. A round-one draw bye drops nobody into the losers' bracket or
//     the third-place line — nobody lost it. And a losers'-bracket line fed by
//     two draw byes is void from the start, so the seat IT feeds is dead too.
//     Those seats are sit-outs: `DRAW_BYE_SLOT_LABEL`, dropped from the ICS
//     feed like a first-round draw bye.
//   - A PERSON LEAVING. A withdrawal voids a line or walks it over; the seat it
//     feeds is a walkover and keeps the PLAIN label, exactly as a departed
//     qualifier's walkover does (fourth-round ruling) — it stays in the feed.
// The dividing rule: a dead feeder is draw-made when it is the draw's own bye,
// or a void whose feeders are ALL draw-made. A void with no feeder in the
// stage (a withdrawal void in round one) is not — the empty case says no.
//
// Everything is driven through the real generator, the real scoring door
// (`scoreEvent`), the real withdrawal cascade and confirm, and read back off
// the real rows; the ICS assertions go through the real route over the real
// `getPublicDivision`. Nothing expected is typed: every line is found through
// the rows' own feed edges, and every winner is the loser the sibling line
// actually produced.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// `unstable_cache` has no incremental cache outside a Next request —
// passthrough, never a memoising double (a cached read would hide the rows).
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import { generateDoubleElim } from "@seazn/engine/scheduling";
import { sql } from "@/lib/db";
import { DRAW_BYE_SLOT_LABEL, isSitOutBye } from "@/lib/fixture-bye";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateStage } from "@/server/api-v1/schemas";
import { buildTemplateStages } from "@/components/v2/format-templates";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { getFixtureState } from "../fixtures";
import { scoreEvent } from "../scoring";
import { completeStage, confirmSeedProposal, createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { withdrawEntrantCascade } from "../withdrawal";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Label = { key?: string; params?: Record<string, unknown> } | null;
interface Row {
  id: string;
  ext_key: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_slot_label: Label;
  away_slot_label: Label;
  status: string;
  outcome: { kind?: string; winner?: string; loser?: string } | null;
  winner_to_fixture: string | null;
  loser_to_fixture: string | null;
}

async function rowsOf(stageId: string): Promise<Row[]> {
  return sql<Row[]>`
    select id, ext_key, round_no, seq_in_round, home_entrant_id, away_entrant_id,
           home_slot_label, away_slot_label, status, outcome, winner_to_fixture, loser_to_fixture
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
}

interface Scene {
  auth: AuthCtx;
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  divisionId: string;
  stageId: string;
  ids: string[]; // E1…En, seed order
}

/** A PUBLIC competition (the ICS feed is public) with `field` entrants E1…En,
 *  seeded in order, and one bracket stage of `kind`. */
async function scene(field: number, kind: "knockout" | "double_elim", config: Record<string, unknown> = {}): Promise<Scene> {
  const { auth } = await seedOrg("pro");
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Draw byes " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
  });
  const divSlug = "open-" + randomUUID().slice(0, 6);
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: divSlug,
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
  const [stage] = await createStages(auth, division.id, [{ seq: 1, kind, name: "Finals", config }]);
  return {
    auth,
    orgSlug,
    compSlug: comp.slug,
    divSlug,
    divisionId: division.id,
    stageId: stage!.id,
    ids: entrants.map((e) => e.id),
  };
}

/** A plain bracket: generated from the field, then started. */
async function plainBracket(field: number, kind: "knockout" | "double_elim", config: Record<string, unknown> = {}) {
  const s = await scene(field, kind, config);
  await generateStageFixtures(s.auth, s.stageId);
  await startDivision(s.auth, s.divisionId, {} as never);
  return s;
}

/** A bracket whose `config.qualified` is a published draw — the shape a
 *  progression leaves behind, and the only shape in which a qualifier who
 *  departs BEFORE generation keeps a seat (F14: their pairing is walked over,
 *  or voided when nobody is left). Same rig as `dead-feeder-cascade.test.ts`. */
async function qualifiedBracket(
  field: number,
  kind: "knockout" | "double_elim",
  departBeforeGenerate: (ids: string[]) => string[],
  config: Record<string, unknown> = {},
) {
  const s = await scene(field, kind);
  await sql`update stages set config = ${sql.json({ ...config, qualified: s.ids } as never)} where id = ${s.stageId}`;
  await sql`update divisions set status = 'active' where id = ${s.divisionId}`;
  for (const id of departBeforeGenerate(s.ids)) await withdrawEntrantCascade(s.auth, id);
  await generateStageFixtures(s.auth, s.stageId);
  return s;
}

/** Play `fixtureId` to a decision for whoever is in home (generic sport). */
async function play(auth: AuthCtx, fixtureId: string): Promise<void> {
  for (const [type, payload] of [
    ["core.start", {}],
    ["generic.result", { p1Score: 2, p2Score: 0 }],
  ] as const) {
    await scoreEvent(auth, fixtureId, {
      expected_seq: (await getFixtureState(auth, fixtureId)).last_seq,
      type,
      payload,
    });
  }
}

/** The UIDs the REAL public ICS route emits for the division. */
async function icsUids(s: Scene): Promise<Set<string>> {
  const { GET } = await import("@/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/calendar.ics/route");
  const res = await GET(new Request(`https://seazn.club/shared/${s.orgSlug}/${s.compSlug}/${s.divSlug}/calendar.ics`), {
    params: Promise.resolve({ orgSlug: s.orgSlug, competitionSlug: s.compSlug, divisionSlug: s.divSlug }),
  });
  expect(res.status).toBe(200);
  const body = await res.text();
  return new Set([...body.matchAll(/UID:([0-9a-f-]{36})@seazn\.club/g)].map((m) => m[1]!));
}

const byId = (rows: Row[], id: string | null) => rows.find((r) => r.id === id)!;
/** The empty seat's label of a one-seated row. */
const phantom = (r: Row): Label => (r.home_entrant_id === null ? r.home_slot_label : r.away_slot_label);
/** The line that feeds `target` through its LOSER edge, other than `not`. */
const loserFeederOf = (rows: Row[], target: string, not?: string) =>
  rows.find((r) => r.loser_to_fixture === target && r.id !== not)!;

/** A seat the draw made empty: settled for the one entrant standing, marked as
 *  the DRAW's sit-out, and treated as one by the predicate the ICS feed runs. */
function expectDrawSitOut(r: Row, winner: string | undefined, kind: string) {
  expect(winner, "premise: the sibling line produced someone to seat").toBeTruthy();
  expect(r.status, `${r.ext_key} is settled`).toBe("forfeited");
  expect(r.outcome).toMatchObject({ kind: "award", winner });
  expect(phantom(r), `${r.ext_key}'s empty seat carries the DRAW marker`).toEqual(DRAW_BYE_SLOT_LABEL);
  expect(isSitOutBye(r, kind), `${r.ext_key} is a sit-out`).toBe(true);
}

/** A seat a WITHDRAWAL made empty: the same settled walkover, the same bye
 *  key every renderer reads — and NOT the draw's marker, so not a sit-out. */
function expectWalkover(r: Row, winner: string | undefined, kind: string) {
  expect(winner, "premise: someone is left to walk over to").toBeTruthy();
  expect(r.status, `${r.ext_key} is settled`).toBe("forfeited");
  expect(r.outcome).toMatchObject({ kind: "award", winner });
  expect(phantom(r)?.key, `${r.ext_key} is still a bye seat to every renderer`).toBe(DRAW_BYE_SLOT_LABEL.key);
  expect(phantom(r), `${r.ext_key} is NOT marked as the draw's`).not.toEqual(DRAW_BYE_SLOT_LABEL);
  expect(isSitOutBye(r, kind), `${r.ext_key} is a walkover, not a sit-out`).toBe(false);
}

describe.skipIf(!HAS_DB)("#850 R3-1 — a seat the DRAW left empty is a sit-out, wherever the cascade finds it", () => {
  it("double_elim, 6 entrants: after winners' round one, both losers'-bracket byes are the draw's sit-outs and leave the ICS feed", async () => {
    const s = await plainBracket(6, "double_elim");
    const gen = await rowsOf(s.stageId);
    // The draw's own round-one byes, by their own marker, and the lines their
    // LOSER edge feeds — each fed by exactly one draw bye and one real match.
    const drawByes = gen.filter((r) => isSitOutBye(r, "double_elim"));
    expect(drawByes, "premise: 6 into 8 leaves two draw byes").toHaveLength(2);
    const targets = drawByes.map((b) => b.loser_to_fixture!);
    expect(new Set(targets).size, "premise: each feeds its own losers'-bracket line").toBe(2);
    const reals = targets.map((t, i) => loserFeederOf(gen, t, drawByes[i]!.id));
    for (const m of reals) expect([m.home_entrant_id, m.away_entrant_id].every(Boolean), "a real pairing").toBe(true);

    for (const m of reals) await play(s.auth, m.id);
    const after = await rowsOf(s.stageId);
    for (const [i, t] of targets.entries()) {
      expectDrawSitOut(byId(after, t), byId(after, reals[i]!.id).outcome?.loser, "double_elim");
    }

    const uids = await icsUids(s);
    for (const t of targets) expect(uids.has(t), "a sit-out is not an event").toBe(false);
    // Positive pair — an empty feed cannot pass: the played matches and the
    // next winners'-bracket matches ARE there.
    for (const m of reals) expect(uids.has(m.id), "a played match stays").toBe(true);
    for (const m of reals) expect(uids.has(byId(after, m.id).winner_to_fixture!), "the next match stays").toBe(true);
  });

  it("knockout, 3 entrants with a third-place match: the third-place bye is the draw's sit-out and leaves the ICS feed", async () => {
    const s = await plainBracket(3, "knockout", { thirdPlace: true });
    const gen = await rowsOf(s.stageId);
    const drawByes = gen.filter((r) => isSitOutBye(r, "knockout"));
    expect(drawByes, "premise: 3 into 4 leaves one draw bye").toHaveLength(1);
    const thirdId = drawByes[0]!.loser_to_fixture!;
    expect(byId(gen, thirdId).ext_key, "premise: its loser edge feeds the third-place line").toBe("se-3p");
    const semi = loserFeederOf(gen, thirdId, drawByes[0]!.id);

    await play(s.auth, semi.id);
    const after = await rowsOf(s.stageId);
    expectDrawSitOut(byId(after, thirdId), byId(after, semi.id).outcome?.loser, "knockout");

    const uids = await icsUids(s);
    expect(uids.has(thirdId), "the third-place sit-out is not an event").toBe(false);
    expect(uids.has(drawByes[0]!.id), "nor is the first-round draw bye").toBe(false);
    expect(uids.has(semi.id), "the played semi stays").toBe(true);
    expect(uids.has(byId(after, semi.id).winner_to_fixture!), "the final stays").toBe(true);
  });

  it("double_elim, 5 entrants: a losers'-bracket VOID fed only by draw byes passes the draw's marker on to the seat it feeds", async () => {
    const s = await plainBracket(5, "double_elim");
    const gen = await rowsOf(s.stageId);
    // Two draw byes that feed ONE losers'-bracket line void it at generation.
    const voids = gen.filter((r) => r.status === "abandoned");
    expect(voids, "premise: exactly one line is void from the start").toHaveLength(1);
    const voidLine = voids[0]!;
    expect(voidLine.outcome, "premise: a void carries no outcome").toBeNull();
    const voidFeeders = gen.filter((r) => r.loser_to_fixture === voidLine.id);
    expect(voidFeeders.map((r) => isSitOutBye(r, "double_elim")), "premise: both of its feeders are draw byes").toEqual([
      true,
      true,
    ]);
    // The seat the void feeds waits on the winners'-bracket line whose loser
    // drops in beside it — both of that line's seats are filled at generation.
    const target = voidLine.winner_to_fixture!;
    const dropper = loserFeederOf(gen, target);
    expect([dropper.home_entrant_id, dropper.away_entrant_id].every(Boolean), "premise: playable now").toBe(true);

    await play(s.auth, dropper.id);
    const after = await rowsOf(s.stageId);
    expectDrawSitOut(byId(after, target), byId(after, dropper.id).outcome?.loser, "double_elim");
    const uids = await icsUids(s);
    expect(uids.has(target), "the sit-out is not an event").toBe(false);
    expect(uids.has(dropper.id), "the match that fed it stays").toBe(true);
  });

  it("league_ko with a third-place match: the draw's bye made at CONFIRM still marks the third-place sit-out", async () => {
    // The progression path: the bracket is drawn over placeholder seats and
    // filled by `confirmSeedProposal`, which runs the same cascade.
    const { auth } = await seedOrg();
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "League KO " + randomUUID().slice(0, 6),
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
    const entrants = await createEntrants(
      auth,
      division.id,
      Array.from({ length: 4 }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })),
    );
    const nameOf = new Map(entrants.map((e) => [e.id, e.display_name]));
    const drafts = buildTemplateStages("league_ko", { swissRounds: 5, poolCount: 2, legs: 1, qualified: 3 });
    const stageIds: string[] = [];
    for (const [i, d] of drafts.entries()) {
      const config = d.kind === "knockout" ? { ...d.config, thirdPlace: true } : d.config;
      const input = CreateStage.parse({ seq: i + 1, kind: d.kind, name: d.name, config, progression: d.progression });
      const [stage] = await createStages(auth, division.id, input);
      stageIds.push(stage!.id);
    }
    const [leagueId, koId] = stageIds as [string, string];
    await startDivision(auth, division.id);
    await generateStageFixtures(auth, koId);
    // Badminton: the lower-numbered entrant always wins 2-0. Through the
    // scoring DOOR (`scoreEvent`), whose `onDecided` runs the cascade.
    const badminton = async (f: { id: string; home_entrant_id: string | null; away_entrant_id: string | null }) => {
      const homeWins = Number(nameOf.get(f.home_entrant_id!)!.slice(1)) < Number(nameOf.get(f.away_entrant_id!)!.slice(1));
      const steps: [string, Record<string, number>][] = [["core.start", {}]];
      for (let game = 0; game < 2; game++) {
        steps.push(["badminton.game.summary", homeWins ? { home: 21, away: 10 } : { home: 10, away: 21 }]);
      }
      for (const [type, payload] of steps) {
        await scoreEvent(auth, f.id, { expected_seq: (await getFixtureState(auth, f.id)).last_seq, type, payload } as never);
      }
    };
    for (const f of await rowsOf(leagueId)) await badminton(f);
    const done = await completeStage(auth, leagueId);
    expect(done.seed_proposal, "premise: the league proposes a draw").toBeTruthy();
    await confirmSeedProposal(auth, koId, { proposalId: done.seed_proposal!.id });

    const confirmed = await rowsOf(koId);
    const drawByes = confirmed.filter((r) => isSitOutBye(r, "knockout"));
    expect(drawByes, "premise: 3 qualifiers into 4 leave one draw bye").toHaveLength(1);
    const thirdId = drawByes[0]!.loser_to_fixture!;
    expect(byId(confirmed, thirdId).ext_key).toBe("se-3p");
    const semi = loserFeederOf(confirmed, thirdId, drawByes[0]!.id);
    await badminton(semi);
    const after = await rowsOf(koId);
    expectDrawSitOut(byId(after, thirdId), byId(after, semi.id).outcome?.loser, "knockout");
  });
});

describe.skipIf(!HAS_DB)("#850 R3-1 — a seat a WITHDRAWAL left empty is a walkover: plain label, still in the ICS feed", () => {
  it("double_elim, 6 entrants, a real pairing departs before the draw: its void's seats are walkovers, while the draw's own losers'-bracket bye in the same bracket is a sit-out", async () => {
    // Seeds 3 and 6 are drawn against each other — read off the engine's own
    // draw, never assumed.
    const pairing = (ids: string[]) => {
      const drawn = generateDoubleElim({ entrants: ids, seeds: new Map(ids.map((id, i) => [id, i + 1])) });
      const line = drawn.fixtures.find((f) => f.home === ids[2] || f.away === ids[2])!;
      expect([line.home, line.away].sort(), "premise: seeds 3 and 6 meet in round one").toEqual([ids[2], ids[5]].sort());
      return [ids[2]!, ids[5]!];
    };
    const s = await qualifiedBracket(6, "double_elim", pairing);
    const gen = await rowsOf(s.stageId);
    const voidLine = gen.find((r) => r.status === "abandoned" && [r.home_entrant_id, r.away_entrant_id].includes(s.ids[2]!))!;
    expect(voidLine, "premise: the departed pairing is void").toBeTruthy();

    // (a) The void has NO feeder in the stage — the empty case. The seat its
    //     winner edge feeds is a walkover for the bye holder beside it,
    //     settled at generation.
    const wbSeat = byId(gen, voidLine.winner_to_fixture);
    const holder = wbSeat.home_entrant_id ?? wbSeat.away_entrant_id;
    expectWalkover(wbSeat, holder ?? undefined, "double_elim");

    // (b) The draw's OWN bye in the same bracket still makes a sit-out.
    const drawByes = gen.filter((r) => isSitOutBye(r, "double_elim"));
    const liveBye = drawByes.find((b) => byId(gen, b.loser_to_fixture).status !== "abandoned")!;
    const lbSitOut = liveBye.loser_to_fixture!;
    const firstReal = loserFeederOf(gen, lbSitOut, liveBye.id);
    await play(s.auth, firstReal.id);

    // (c) A void fed by one draw-made feeder and one withdrawal-made one is
    //     NOT draw-made, and neither is the void it compounds into: the seat
    //     at the end of that chain is a walkover. Reached by playing the other
    //     side of the losers' bracket through to it.
    let rows = await rowsOf(s.stageId);
    const wbNext = byId(rows, byId(rows, firstReal.id).winner_to_fixture);
    await play(s.auth, wbNext.id);
    rows = await rowsOf(s.stageId);
    const lbMajor = byId(rows, byId(rows, lbSitOut).winner_to_fixture);
    expect([lbMajor.home_entrant_id, lbMajor.away_entrant_id].every(Boolean), "premise: the major line is playable").toBe(true);
    await play(s.auth, lbMajor.id);
    rows = await rowsOf(s.stageId);
    const chainEnd = byId(rows, lbMajor.winner_to_fixture);
    const deadSide = rows.find((r) => r.winner_to_fixture === chainEnd.id && r.id !== lbMajor.id)!;
    expect(deadSide.status, "premise: the chain end's other feeder is a compounded void").toBe("abandoned");

    const after = await rowsOf(s.stageId);
    expectDrawSitOut(byId(after, lbSitOut), byId(after, firstReal.id).outcome?.loser, "double_elim");
    expectWalkover(byId(after, chainEnd.id), byId(after, lbMajor.id).outcome?.winner, "double_elim");

    const uids = await icsUids(s);
    expect(uids.has(wbSeat.id), "a walkover stays in the feed").toBe(true);
    expect(uids.has(chainEnd.id), "a walkover stays in the feed").toBe(true);
    expect(uids.has(lbSitOut), "the draw's sit-out does not").toBe(false);
  });

  it("double_elim, 5 entrants, a withdrawal AFTER the draw walks a match of two bye holders over: the losers'-bracket seat it empties is a walkover", async () => {
    // The winners'-bracket line of two draw-bye holders is a WALKOVER once one
    // of them leaves. Its feeders are draw byes — but through their WINNER
    // edge, which is alive (it seated both players). A walkover drops nobody,
    // so the losers'-bracket line it feeds is void beside the draw-made one;
    // the seat that void empties is the withdrawal's doing, not the draw's.
    const s = await plainBracket(5, "double_elim");
    const gen = await rowsOf(s.stageId);
    const byeHolders = gen.filter((r) => isSitOutBye(r, "double_elim")).map((r) => r.outcome!.winner!);
    const twoByes = gen.find(
      (r) => r.round_no > gen[0]!.round_no && byeHolders.includes(r.home_entrant_id!) && byeHolders.includes(r.away_entrant_id!),
    )!;
    expect(twoByes, "premise: two bye holders meet in winners' round two").toBeTruthy();
    await withdrawEntrantCascade(s.auth, twoByes.away_entrant_id!);

    let rows = await rowsOf(s.stageId);
    const walked = byId(rows, twoByes.id);
    expect(walked.outcome, "premise: the line is walked over").toMatchObject({ kind: "award", winner: twoByes.home_entrant_id });
    const lbVoid = byId(rows, walked.loser_to_fixture);
    expect(lbVoid.status, "premise: the losers'-bracket line it feeds is void").toBe("abandoned");

    // Play the other half of the losers' bracket through to the seat beside
    // that void.
    const other = rows.find((r) => r.status === "scheduled" && r.home_entrant_id && r.away_entrant_id)!;
    await play(s.auth, other.id);
    for (let guard = 0; guard < 8; guard++) {
      rows = await rowsOf(s.stageId);
      const target = byId(rows, lbVoid.winner_to_fixture);
      if (target.status !== "scheduled") break;
      const open = rows.find(
        (r) => r.status === "scheduled" && r.home_entrant_id && r.away_entrant_id && r.id !== target.id,
      );
      if (!open) break;
      await play(s.auth, open.id);
    }
    const after = await rowsOf(s.stageId);
    const target = byId(after, lbVoid.winner_to_fixture);
    const liveFeeder = after.find((r) => r.winner_to_fixture === target.id && r.id !== lbVoid.id)!;
    expectWalkover(target, liveFeeder.outcome?.winner, "double_elim");
    const uids = await icsUids(s);
    expect(uids.has(target.id), "a walkover stays in the feed").toBe(true);
  });

  it("knockout, 4 entrants with a third-place match, one qualifier departs before the draw: the third-place seat is a walkover", async () => {
    // Same bracket family as the 3-entrant sit-out above, the other answer: a
    // WALKOVER semi drops nobody into the third-place line either, but it is a
    // two-sided award, not the draw's bye.
    const s = await qualifiedBracket(4, "knockout", (ids) => [ids[3]!], { thirdPlace: true });
    const gen = await rowsOf(s.stageId);
    const walked = gen.find((r) => r.outcome?.kind === "award" && r.home_entrant_id && r.away_entrant_id)!;
    expect(walked, "premise: the departed qualifier's semi is a two-sided walkover").toBeTruthy();
    const thirdId = walked.loser_to_fixture!;
    const semi = loserFeederOf(gen, thirdId, walked.id);
    await play(s.auth, semi.id);
    const after = await rowsOf(s.stageId);
    expectWalkover(byId(after, thirdId), byId(after, semi.id).outcome?.loser, "knockout");
    const uids = await icsUids(s);
    expect(uids.has(thirdId), "a walkover stays in the feed").toBe(true);
  });
});
