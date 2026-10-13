// W2b Task 8 (spec §5.4, plan "The cascade, per fixture of the withdrawn entrant"): what a withdrawal writes on every
// fixture state it can meet, read back from the stored rows and the ledger. Real Postgres, through the usecases the
// buttons call — Withdraw (`withdrawEntrantCascade`), Score (`scoreEvent`), Generate, Complete.
//
// The answers (Appendix A): X-WD-1..5 (product rule W2b-R8), BG-WO-2 / BG-WO-3 (chess walkovers before the game and
// during the tie-break), the D-G2 / D-G3 corners W2a deferred (spec §5.4), and D5 (an expunge stays out of the table).
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, describe, expect, it, vi } from "vitest";
import { SETTLE_METHODS, deciderPending } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import enDict from "@/dictionaries/en/ui.json";
import esDict from "@/dictionaries/es/ui.json";
import frDict from "@/dictionaries/fr/ui.json";
import nlDict from "@/dictionaries/nl/ui.json";
import { classifyActError } from "@/components/v2/stages-panel";
import { ApiV1Error, apiV1 } from "@/lib/client-v1";
import { sql, withTenant } from "@/lib/db";
import { nextMatchLabel, nextMatchRefOf } from "@/lib/next-match-started";
import { scoringErrorText, type MsgFn } from "@/lib/scoring-vocab";
import type { AuthCtx } from "@/server/api-v1/auth";
import { v1 } from "@/server/api-v1/http";
import { declaredVariant, insertLegacyEvents, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import {
  fixtureRow,
  heldFootball,
  labelOf,
  liveEvents,
  playBadminton,
  post,
  rowsOf,
  seatOf,
  type FixtureRow,
} from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { DEPARTED_STATUSES, createEntrants, patchEntrant } from "../entrants";
import { completeStage, createStages, generateStageFixtures, getStandings, writeDepartedSeat } from "../stages";
import { fixtureFeedsNextMatch } from "../fixtures";
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

/** The engine's own settle vocabulary; a rename there reds here by name. */
const SETTLE_BY_ORGANISER = (() => {
  const m = SETTLE_METHODS.find((x) => x === "organiser");
  if (m === undefined) throw new Error("the engine declares no 'organiser' settle method");
  return m;
})();

interface Ev {
  id: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  voids_event_id: string | null;
}
const ledgerOf = (fixtureId: string) =>
  sql<Ev[]>`select id, seq, type, payload, voids_event_id from score_events where fixture_id = ${fixtureId} order by seq`;
/** The events the fold reads: neither a void nor voided. */
function active(evs: readonly Ev[]): Ev[] {
  const voided = new Set(evs.filter((e) => e.voids_event_id !== null).map((e) => e.voids_event_id));
  return evs.filter((e) => e.type !== "core.void" && !voided.has(e.id));
}
const activeTypes = async (fixtureId: string) => active(await ledgerOf(fixtureId)).map((e) => e.type);
const entrantBySeed = async (divisionId: string, seed: number) =>
  (await sql<{ id: string }[]>`select id from entrants where division_id = ${divisionId} and seed = ${seed}`)[0]!.id;
const stageEventCount = async (stageId: string) =>
  (
    await sql<{ n: number }[]>`
      select count(*)::int as n from score_events e join fixtures f on f.id = e.fixture_id where f.stage_id = ${stageId}`
  )[0]!.n;

/** The award a withdrawal's `core.forfeit{by: loser, reason: "withdrew"}` folds to (engine §5.1: the award names its
 *  loser and the closed reason). */
const withdrewAward = (winner: string, loser: string) => ({ kind: "award", winner, loser, reason: "withdrew" });
/** What `awardSeededByes` writes on a seat the cascade stamped dead when nobody WITHDREW from it — a dead feeder's (a
 *  void, a double walkover), a disqualified winner's: a walkover by bye (W2b C-5; the harness maps a seeded bye's reason
 *  "bye" to its "walkover" rows — T7 report). A withdrawn winner's dead seat is `withdrewAward` (owner ruling 116). */
const seatWalkover = (winner: string) => ({ kind: "award", winner, loser: null, reason: "bye" });

/** A withdrawal the organiser recorded BEFORE pressing Start (the division is not live yet, so the cascade is the
 *  plain status flip, `withdrawal.ts`) — the draw was already generated and keeps the departed entrant seated. */
async function withdrawBeforeStart(auth: AuthCtx, divisionId: string, entrantId: string): Promise<void> {
  await sql`update divisions set status = 'scheduled' where id = ${divisionId}`;
  const out = await withdrawEntrantCascade(auth, entrantId);
  expect(out, "rig: before Start a withdrawal writes nothing").toMatchObject({ policy: "none", walkovers: 0, voided: 0 });
  await sql`update divisions set status = 'active' where id = ${divisionId}`;
}

/** Two first-round lines that feed one later seat pair, from the generated feed graph. */
function siblingsInto(rows: readonly FixtureRow[]): { a: FixtureRow; b: FixtureRow; parentId: string } {
  const first = Math.min(...rows.map((r) => r.round_no));
  const r1 = rows.filter((r) => r.round_no === first && r.home_entrant_id && r.away_entrant_id);
  for (const a of r1) {
    const b = r1.find((x) => x.id !== a.id && x.winner_to_fixture !== null && x.winner_to_fixture === a.winner_to_fixture);
    if (b) return { a, b, parentId: a.winner_to_fixture! };
  }
  throw new Error("rig: no two seated first-round lines feed one fixture");
}

const football = { sport: "football", variant: declaredVariant("football", "11-a-side") };
const badminton = { sport: "badminton", variant: declaredVariant("badminton", "bwf") };
const chess = { sport: "boardgame", variant: declaredVariant("boardgame", "classical") };

describe.skipIf(!HAS_DB)("W2b withdrawal cascade, per fixture state (spec §5.4)", () => {
  it("empty case first: an entrant with no fixtures withdraws with every count 0", async () => {
    // single-sport: badminton; nothing is folded, so the empty case is sport-blind.
    const s = await seedBracket({ ...badminton, stageKind: "knockout", entrants: 4 });
    // The entrant list is locked once the division starts, so the late entrant with no fixture is a raw row.
    const [late] = await sql<{ id: string }[]>`
      insert into entrants (division_id, org_id, kind, display_name, seed)
      select division_id, org_id, kind, 'Late', 9 from entrants where division_id = ${s.divisionId} limit 1
      returning id`;
    const before = await stageEventCount(s.stageId);
    const out = await withdrawEntrantCascade(s.auth, late!.id);
    expect(out).toEqual({
      entrant_id: late!.id,
      status: "withdrawn",
      policy: "none",
      walkovers: 0,
      voided: 0,
      skipped_finalized: 0,
      walked_over_held: 0,
      left_to_organiser: [],
    });
    expect(await stageEventCount(s.stageId), "nothing was written").toBe(before);
    // The second call: already withdrawn, refused, and still nothing written.
    await expect(withdrawEntrantCascade(s.auth, late!.id)).rejects.toMatchObject({ status: 409 });
    expect(await stageEventCount(s.stageId)).toBe(before);
  });

  it("X-WD-1: a held knockout fixture is walked over to the remaining side with reason withdrew", async () => {
    // single-sport: football reaches a held bracket fixture by play (0-0 FT, X-BR-2); a badminton abandon folds null.
    const s = await seedBracket({ ...football, stageKind: "knockout", entrants: 4 });
    const sf1 = await heldFootball(s.auth, s.fixtureIds[0]!);
    const leaver = sf1.home_entrant_id!;
    const stays = sf1.away_entrant_id!;
    await withdrawEntrantCascade(s.auth, leaver);
    const after = await fixtureRow(sf1.id);
    expect([after.status, after.outcome]).toEqual(["forfeited", withdrewAward(stays, leaver)]);
    // Retirement credit: the played match stands — nothing the scorer recorded is voided, and the cascade posts no
    // second start; it appends the forfeit alone.
    const act = active(await ledgerOf(sf1.id));
    expect(act.map((e) => e.type)).toEqual(["core.start", "football.period", "football.period", "core.forfeit"]);
    expect(act.at(-1)!.payload).toEqual({ by: leaver, reason: "withdrew" });
  });

  it("Review Focus 5: X-WD-1 walk-over seats the remaining side in the next match", async () => {
    const s = await seedBracket({ ...football, stageKind: "knockout", entrants: 4 });
    const sf1 = await heldFootball(s.auth, s.fixtureIds[0]!);
    const out = await withdrawEntrantCascade(s.auth, sf1.away_entrant_id!);
    expect(out).toMatchObject({ policy: "walkover", walkovers: 1, voided: 0, walked_over_held: 1 });
    const final = await fixtureRow(sf1.winner_to_fixture!);
    expect(seatOf(final, sf1.winner_to_slot), "the remaining side is in the final").toBe(sf1.home_entrant_id);
    // The negative pair: an ordinary (unheld) withdrawal is a walkover, never a held one.
    const sf2 = await fixtureRow(s.fixtureIds[1]!);
    const out2 = await withdrawEntrantCascade(s.auth, sf2.away_entrant_id!);
    expect(out2).toMatchObject({ walkovers: 1, walked_over_held: 0 });
  });

  it("X-WD-2: page_playoff q1 withdrawal walks over, never abandons", async () => {
    // single-sport: badminton, the W2a page_playoff withdrawal rig.
    const s = await seedBracket({ ...badminton, stageKind: "page_playoff", entrants: 4 });
    const rows = await rowsOf(s.stageId);
    const q1 = rows.find((r) => r.home_entrant_id && r.away_entrant_id && r.winner_to_fixture && r.loser_to_fixture);
    const elim = rows.find((r) => r.home_entrant_id && r.away_entrant_id && r.id !== q1?.id);
    if (!q1 || !elim) throw new Error("rig: page_playoff has no seated qualifier beside a seated eliminator");
    const out = await withdrawEntrantCascade(s.auth, q1.home_entrant_id!);
    expect(out).toMatchObject({ policy: "walkover", walkovers: 1, voided: 0 });
    const after = await fixtureRow(q1.id);
    expect([after.status, after.outcome]).toEqual(["forfeited", withdrewAward(q1.away_entrant_id!, q1.home_entrant_id!)]);
    expect(await activeTypes(q1.id), "a forfeit, never an abandon").toEqual(["core.forfeit"]);
    expect(seatOf(await fixtureRow(q1.winner_to_fixture!), q1.winner_to_slot), "q1's winner is in the final").toBe(q1.away_entrant_id);
    // q1's loser edge: the withdrawn loser is never seated (X-DE-1); the seat waits (late) until the eliminator
    // resolves, then its winner walks q2 over and meets q1's winner in the final.
    const q2Before = await fixtureRow(q1.loser_to_fixture!);
    expect(seatOf(q2Before, q1.loser_to_slot)).toBeNull();
    await playBadminton(s.auth, elim.id, true);
    const q2 = await fixtureRow(q1.loser_to_fixture!);
    expect([q2.status, q2.outcome]).toEqual(["forfeited", seatWalkover(elim.home_entrant_id!)]);
    const final = await fixtureRow(q1.winner_to_fixture!);
    expect([final.status, [final.home_entrant_id, final.away_entrant_id].sort()]).toEqual([
      "scheduled",
      [q1.away_entrant_id!, elim.home_entrant_id!].sort(),
    ]);
  });

  it("X-WD-2: a ladder holder's withdrawal walks the pending challenge over (D-G3 corner 4 rewritten)", async () => {
    // single-sport: badminton; seedBracket issues seed 2's challenge against seed 1, the holder.
    const s = await seedBracket({ ...badminton, stageKind: "ladder", entrants: 4 });
    const challenge = s.fixtureIds[0]!;
    const [holder, challenger, l3, l4] = await Promise.all([1, 2, 3, 4].map((n) => entrantBySeed(s.divisionId, n)));
    const out = await withdrawEntrantCascade(s.auth, holder!);
    expect(out).toMatchObject({ policy: "walkover", walkovers: 1, voided: 0 });
    const after = await fixtureRow(challenge);
    expect([after.status, after.outcome]).toEqual(["forfeited", withdrewAward(challenger!, holder!)]);
    expect(await activeTypes(challenge), "a forfeit, never an abandon").toEqual(["core.forfeit"]);
    // Jul3/08 §6: the challenger taking the game takes the position — a walkover win included — so the ladder
    // completes with no hold and no settle, the departed holder one place down. Twice: completion is idempotent.
    for (const call of ["first", "second"]) {
      const done = await completeStage(s.auth, s.stageId);
      const ev = done.events.find((e) => e.type === "stage_completed");
      if (call === "first") expect(ev?.type === "stage_completed" ? ev.finalRanks : null, call).toEqual([challenger, holder, l3, l4]);
      expect(done.completed, call).toBe(true);
    }
  });

  it("R53 (owner ruling 53): a ladder entrant whose challenge is DECIDED withdraws with nothing pending — policy none, nothing walked over or voided; the decided challenge stands", async () => {
    // single-sport: badminton (the ladder rig above). The positive pair is the X-WD-2 test above: one pending
    // challenge → policy walkover, walkovers 1.
    const s = await seedBracket({ ...badminton, stageKind: "ladder", entrants: 4 });
    const challenge = s.fixtureIds[0]!;
    const challenger = await entrantBySeed(s.divisionId, 2);
    await playBadminton(s.auth, challenge, true);
    const decided = await fixtureRow(challenge);
    expect(decided.status, "rig: the challenge is decided").toBe("decided");
    const [{ pending }] = await sql<{ pending: number }[]>`
      select count(*)::int as pending from fixtures
       where stage_id = ${s.stageId} and status in ('scheduled', 'in_play', 'needs_decision')
         and (home_entrant_id = ${challenger!} or away_entrant_id = ${challenger!})`;
    expect(pending, "rig: nothing of the leaver's is pending").toBe(0);
    const out = await withdrawEntrantCascade(s.auth, challenger!);
    expect(out).toMatchObject({ status: "withdrawn", policy: "none", walkovers: 0, voided: 0, walked_over_held: 0 });
    const after = await fixtureRow(challenge);
    expect([after.status, after.outcome], "the decided challenge is unchanged").toEqual([decided.status, decided.outcome]);
  });

  it("R53: an ELIMINATED knockout entrant withdraws with nothing pending — policy none; the winner who beat her is untouched", async () => {
    // single-sport: badminton. The same rule on a knockout: her only line is decided, so nothing walks over.
    const s = await seedBracket({ ...badminton, stageKind: "knockout", entrants: 4 });
    const first = s.fixtureIds[0]!;
    await playBadminton(s.auth, first, true);
    const lost = await fixtureRow(first);
    const loser = lost.away_entrant_id!;
    const out = await withdrawEntrantCascade(s.auth, loser);
    expect(out).toMatchObject({ status: "withdrawn", policy: "none", walkovers: 0, voided: 0 });
    const after = await fixtureRow(first);
    expect([after.status, after.outcome]).toEqual([lost.status, lost.outcome]);
  });

  it("X-WD-3: withdrawing from a fixture whose opponent is TBD stamps the seat dead; the arriving winner walks over", async () => {
    // single-sport: badminton. Six entrants in an eight-line draw: seeds 1 and 2 have byes, so each is seated in
    // round 2 against the winner of a round-1 line nobody has played (the E1 probe's rig; the throw it reproduced was
    // "fixture has an unassigned entrant (bye/TBD)").
    const s = await seedBracket({ ...badminton, stageKind: "knockout", entrants: 6 });
    const rows = await rowsOf(s.stageId);
    const tbd = rows.find((r) => (r.home_entrant_id === null) !== (r.away_entrant_id === null) && r.status === "scheduled");
    if (!tbd) throw new Error("rig: no scheduled line with one seat filled and one TBD");
    const leaverSlot = tbd.home_entrant_id !== null ? 1 : 2;
    const leaver = seatOf(tbd, leaverSlot)!;
    const out = await withdrawEntrantCascade(s.auth, leaver);
    expect(out).toMatchObject({ entrant_id: leaver, status: "withdrawn", policy: "walkover", walkovers: 1, voided: 0 });
    const stamped = await fixtureRow(tbd.id);
    expect(
      { seat: seatOf(stamped, leaverSlot), label: labelOf(stamped, leaverSlot), status: stamped.status, outcome: stamped.outcome },
      "the departed seat is empty and dead; the line waits for its other side",
    ).toEqual({ seat: null, label: BYE_KEY, status: "scheduled", outcome: null });
    expect(await activeTypes(tbd.id), "no event: nobody is on the other side to receive one").toEqual([]);
    // The arriving winner walks over in the same write that seats them — over HER (owner ruling 116): she reached this
    // line through her own first-round bye line, which names her its winner, and then withdrew, so the walkover names
    // her, reason "withdrew", while her seat stays empty and dead.
    const feeder = rows.find((r) => r.winner_to_fixture === tbd.id && r.home_entrant_id && r.away_entrant_id);
    if (!feeder) throw new Error("rig: the TBD seat has no seated feeder");
    expect(rows.find((r) => r.winner_to_fixture === tbd.id && r.winner_to_slot === leaverSlot)?.outcome, "premise: her way in, a bye line she won").toEqual({
      kind: "award", winner: leaver, loser: null, reason: "bye",
    });
    await playBadminton(s.auth, feeder.id, true);
    const after = await fixtureRow(tbd.id);
    expect([after.status, after.outcome]).toEqual(["forfeited", withdrewAward(feeder.home_entrant_id!, leaver)]);
    expect(seatOf(after, leaverSlot), "she is never seated (X-WD-3)").toBeNull();
    expect(seatOf(await fixtureRow(tbd.winner_to_fixture!), tbd.winner_to_slot), "and goes on").toBe(feeder.home_entrant_id);
  });

  it("X-WD-4: both entrants of a line withdraw in turn — the fixture is a double walkover, its fed opponent walks over", async () => {
    // single-sport: badminton. The first withdrawal is recorded before Start (the draw already generated), so the
    // line still seats her when the second entrant withdraws: both sides of the fixture have now withdrawn. Walking it
    // over to either would seat a withdrawn entrant in the next round.
    const s = await seedBracket({ ...badminton, stageKind: "knockout", entrants: 8 });
    const { a, b, parentId } = siblingsInto(await rowsOf(s.stageId));
    await withdrawBeforeStart(s.auth, s.divisionId, a.home_entrant_id!);
    expect((await fixtureRow(a.id)).status, "premise: the flip left the line alone").toBe("scheduled");
    const out = await withdrawEntrantCascade(s.auth, a.away_entrant_id!);
    expect(out).toMatchObject({ walkovers: 1, voided: 0 });
    const dw = await fixtureRow(a.id);
    expect([dw.status, dw.outcome], "a double walkover").toEqual(["forfeited", { kind: "double_walkover" }]);
    expect(await activeTypes(a.id), "no event, as awardSeededByes writes a bye (plan X-WD-4)").toEqual([]);
    expect(seatOf(await fixtureRow(parentId), a.winner_to_slot), "it seats nobody (X-DW-2)").toBeNull();
    // Its fed opponent: the sibling line's winner walks the parent over when it arrives.
    await playBadminton(s.auth, b.id, true);
    const parent = await fixtureRow(parentId);
    expect([parent.status, parent.outcome]).toEqual(["forfeited", seatWalkover(b.home_entrant_id!)]);
  });

  it("X-WD-4 / M-2: an opponent who left by ANY departed status (DEPARTED_STATUSES) gets no walkover — the line is a double walkover; a field opponent does", async () => {
    // single-sport: badminton; the reading is the entrant status, not the sport. The opponent's departure is a bare
    // status write (PATCH /entrants status, or a registration's, writes no cascade), so the draw still seats her.
    const DEPARTURES: (string | null)[] = [...DEPARTED_STATUSES, null];
    let checked = 0;
    for (const departed of DEPARTURES) {
      const s = await seedBracket({ ...badminton, stageKind: "knockout", entrants: 4 });
      const [sf] = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id);
      if (departed !== null) await sql`update entrants set status = ${departed} where id = ${sf!.home_entrant_id}`;
      await withdrawEntrantCascade(s.auth, sf!.away_entrant_id!);
      const after = await fixtureRow(sf!.id);
      expect([after.status, after.outcome], departed ?? "positive pair: the opponent is in the field").toEqual(
        departed === null ? ["forfeited", withdrewAward(sf!.home_entrant_id!, sf!.away_entrant_id!)] : ["forfeited", { kind: "double_walkover" }],
      );
      expect(seatOf(await fixtureRow(sf!.winner_to_fixture!), sf!.winner_to_slot), departed ?? "positive pair").toBe(
        departed === null ? sf!.home_entrant_id : null,
      );
      checked++;
    }
    expect(checked).toBe(DEPARTED_STATUSES.size + 1);
  }, 120_000);

  it("M-1: a line with recorded play is never overwritten by a departure double walkover — writeDepartedSeat refuses it, and the cascade leaves the ledger to the organiser", async () => {
    // single-sport: badminton; the guard is on the ledger, not the sport. Her opponent left by a bare status write
    // (no cascade), and the line went on being played: one game recorded.
    const s = await seedBracket({ ...badminton, stageKind: "knockout", entrants: 4 });
    const [sf] = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id);
    await sql`update entrants set status = 'disqualified' where id = ${sf!.home_entrant_id}`;
    await post(s.auth, sf!.id, "core.start");
    await post(s.auth, sf!.id, "badminton.game.summary", { home: 21, away: 10 });
    const before = await fixtureRow(sf!.id);
    const ledger = await activeTypes(sf!.id);
    expect([before.status, ledger.length > 0], "rig: in play, with live events").toEqual(["in_play", true]);
    await expect(withTenant(s.auth.orgId, (tx) => writeDepartedSeat(tx, sf!.id, sf!.away_entrant_id!, "double_walkover"))).rejects.toThrow(
      /no longer the undecided line/,
    );
    const out = await withdrawEntrantCascade(s.auth, sf!.away_entrant_id!);
    expect(out, "nothing was written on the played line").toMatchObject({ walkovers: 0, voided: 0 });
    // Loop R M-5: and the cascade says so — the line is named as left to the organiser.
    expect(out.left_to_organiser, "the played line is reported").toEqual([sf!.id]);
    const after = await fixtureRow(sf!.id);
    expect([after.status, after.outcome, await activeTypes(sf!.id)]).toEqual([before.status, before.outcome, ledger]);
  });

  it("M-5: both sides gone and only a bare Start on the line — every sport: nothing is played (ruling 112), so the line is a double walkover; where the sport's Start IS play (ruling 118) it is left to the organiser and reported", async () => {
    // Every sport × its first declared variant. The answer is the engine's own declaration (`startIsPlay`), never a list
    // typed here. Her opponent left by a bare status write (no cascade), and the scorer had pressed Start.
    let doubleWalkovers = 0;
    let left = 0;
    for (const m of builtinModules) {
      const label = m.key;
      const s = await seedBracket({ sport: m.key, variant: declaredVariant(m.key, Object.keys(m.variants)[0]!), stageKind: "knockout", entrants: 4 });
      const [sf] = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id && r.winner_to_fixture);
      expect(sf, `${label}: rig: a seated semi that feeds the final`).toBeDefined();
      await sql`update entrants set status = 'withdrawn' where id = ${sf!.home_entrant_id}`;
      await post(s.auth, sf!.id, "core.start");
      const before = await fixtureRow(sf!.id);
      expect([before.status, await activeTypes(sf!.id)], `${label}: rig: a bare Start`).toEqual(["in_play", ["core.start"]]);
      const out = await withdrawEntrantCascade(s.auth, sf!.away_entrant_id!);
      const after = await fixtureRow(sf!.id);
      if ((m as { startIsPlay?: boolean }).startIsPlay === true) {
        expect([out.walkovers, out.left_to_organiser], `${label}: the Start is play — left, and reported`).toEqual([0, [sf!.id]]);
        expect([after.status, after.outcome, await activeTypes(sf!.id)], `${label}: untouched`).toEqual([before.status, before.outcome, ["core.start"]]);
        left++;
      } else {
        expect([out.walkovers, out.left_to_organiser], `${label}: nothing played — a double walkover, nothing left`).toEqual([1, []]);
        expect([after.status, after.outcome], `${label}: X-WD-4`).toEqual(["forfeited", { kind: "double_walkover" }]);
        // Recorded over the Start, as the console's double walkover is (a departure's no-event write refuses any
        // live event, and the Start stands in the record).
        expect(active(await ledgerOf(sf!.id)).map((e) => [e.type, e.type === "core.forfeit" ? e.payload : null]), `${label}: the ledger`).toEqual([
          ["core.start", null],
          ["core.forfeit", { by: "both", reason: "walkover" }],
        ]);
        expect(seatOf(await fixtureRow(sf!.winner_to_fixture!), sf!.winner_to_slot), `${label}: it seats nobody (X-DW-2)`).toBeNull();
        doubleWalkovers++;
      }
    }
    expect(doubleWalkovers + left, "every sport checked").toBe(builtinModules.length);
    // anti-vacuity: both answers are reached — chess declares its Start as play, the racket sports do not.
    expect([doubleWalkovers > 0, left > 0], "both branches reached").toEqual([true, true]);
  }, 300_000);

  it("M-5: a scorer's abandon after a bare Start is not play either — the abandon is voided first (D-G2 corner 1), then the double walkover", async () => {
    // single-sport: badminton; the abandon's void is the kernel's, sport-blind.
    const s = await seedBracket({ ...badminton, stageKind: "knockout", entrants: 4 });
    const [sf] = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id);
    await sql`update entrants set status = 'withdrawn' where id = ${sf!.home_entrant_id}`;
    await post(s.auth, sf!.id, "core.start");
    await post(s.auth, sf!.id, "core.abandon", { reason: "rain" });
    expect((await fixtureRow(sf!.id)).status, "rig: abandoned").toBe("abandoned");
    const out = await withdrawEntrantCascade(s.auth, sf!.away_entrant_id!);
    expect([out.walkovers, out.left_to_organiser]).toEqual([1, []]);
    const after = await fixtureRow(sf!.id);
    expect([after.status, after.outcome]).toEqual(["forfeited", { kind: "double_walkover" }]);
    expect(await activeTypes(sf!.id), "the abandon voided, the Start kept").toEqual(["core.start", "core.forfeit"]);
  });

  it("M-5: play recorded, then voided — nothing is played any more, so the both-gone line is a double walkover over the Start", async () => {
    // single-sport: badminton; the void is the kernel's, sport-blind. The sequence after a void: the engine's reading
    // drops the voided game, so the line is back to a bare Start.
    const s = await seedBracket({ ...badminton, stageKind: "knockout", entrants: 4 });
    const [sf] = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id);
    await sql`update entrants set status = 'withdrawn' where id = ${sf!.home_entrant_id}`;
    await post(s.auth, sf!.id, "core.start");
    await post(s.auth, sf!.id, "badminton.game.summary", { home: 21, away: 10 });
    const [game] = active(await ledgerOf(sf!.id)).filter((e) => e.type === "badminton.game.summary");
    await post(s.auth, sf!.id, "core.void", { event_id: game!.id });
    expect(await activeTypes(sf!.id), "rig: only the Start is active").toEqual(["core.start"]);
    const out = await withdrawEntrantCascade(s.auth, sf!.away_entrant_id!);
    expect([out.walkovers, out.left_to_organiser]).toEqual([1, []]);
    const after = await fixtureRow(sf!.id);
    expect([after.status, after.outcome]).toEqual(["forfeited", { kind: "double_walkover" }]);
    expect(await activeTypes(sf!.id)).toEqual(["core.start", "core.forfeit"]);
  });

  it("M-5: both finalists gone after play on the final — nothing is written (D19), and the played final is reported to the organiser", async () => {
    // single-sport: badminton. The unplayed final (below) is W4's vacant title and reports nothing; a PLAYED one is
    // the organiser's ledger to void or settle, as any played line is.
    const s = await seedBracket({ ...badminton, stageKind: "knockout", entrants: 2 });
    const final = await fixtureRow(s.fixtureIds[0]!);
    expect([final.winner_to_fixture, final.loser_to_fixture], "rig: the line feeds nothing").toEqual([null, null]);
    await sql`update entrants set status = 'withdrawn' where id = ${final.home_entrant_id}`;
    await post(s.auth, final.id, "core.start");
    await post(s.auth, final.id, "badminton.game.summary", { home: 21, away: 10 });
    const out = await withdrawEntrantCascade(s.auth, final.away_entrant_id!);
    expect([out.walkovers, out.left_to_organiser]).toEqual([0, [final.id]]);
    expect(await activeTypes(final.id)).toEqual(["core.start", "badminton.game.summary"]);
  });

  it("X-WD-4: both finalists withdraw — the final stays open (W4 handover)", async () => {
    // single-sport: badminton. Two entrants: the draw is the final alone. A final has no next match, so it cannot be a
    // double walkover (D19, X-DW-3); with both finalists gone the vacant title is W4's (spec §2.2), and nothing is
    // written here.
    const s = await seedBracket({ ...badminton, stageKind: "knockout", entrants: 2 });
    const final = await fixtureRow(s.fixtureIds[0]!);
    expect([final.winner_to_fixture, final.loser_to_fixture], "rig: the line feeds nothing").toEqual([null, null]);
    await withdrawBeforeStart(s.auth, s.divisionId, final.home_entrant_id!);
    const out = await withdrawEntrantCascade(s.auth, final.away_entrant_id!);
    expect(out).toMatchObject({ walkovers: 0, voided: 0, left_to_organiser: [] });
    const after = await fixtureRow(final.id);
    expect([after.status, after.outcome, after.home_entrant_id, after.away_entrant_id]).toEqual([
      "scheduled",
      null,
      final.home_entrant_id,
      final.away_entrant_id,
    ]);
    expect(await activeTypes(final.id)).toEqual([]);
    expect((await completeStage(s.auth, s.stageId)).completed, "the stage is not finished").toBe(false);
  });

  it("X-WD-4 (dead seats): a seat its withdrawn entrant left beside a DEPARTURE double walkover (both of that feeder's sides withdrew) makes the line a double walkover, and its fed opponent walks over", async () => {
    // single-sport: badminton. Every side of the semi's feed departs: QF-B's home before Start (a status flip, the
    // draw keeps her), QF-A played and its winner withdraws while the semi's other side is TBD (X-WD-3 stamps her seat
    // dead), then QF-B's away withdraws — QF-B is a departure double walkover (no event), and so is the semi. The
    // order matters: had QF-B been PLAYED, its winner would have walked the semi over the dead seat in that same write
    // (lane P1, loop F carry-in), so no X-WD-4 line ever follows "played, then its winner withdraws".
    const s = await seedBracket({ ...badminton, stageKind: "knockout", entrants: 8 });
    const rows = await rowsOf(s.stageId);
    const { a, b, parentId } = siblingsInto(rows);
    await withdrawBeforeStart(s.auth, s.divisionId, b.home_entrant_id!);
    await playBadminton(s.auth, a.id, true);
    await withdrawEntrantCascade(s.auth, a.home_entrant_id!);
    expect(labelOf(await fixtureRow(parentId), a.winner_to_slot), "premise: the departed seat is dead").toBe(BYE_KEY);
    const out = await withdrawEntrantCascade(s.auth, b.away_entrant_id!);
    expect(out).toMatchObject({ walkovers: 1, voided: 0 });
    expect([(await fixtureRow(b.id)).status, (await fixtureRow(b.id)).outcome]).toEqual(["forfeited", { kind: "double_walkover" }]);
    const semi = await fixtureRow(parentId);
    expect([semi.status, semi.outcome, semi.home_entrant_id, semi.away_entrant_id], "every side departed: a double walkover").toEqual([
      "forfeited",
      { kind: "double_walkover" },
      null,
      null,
    ]);
    expect([await activeTypes(b.id), await activeTypes(parentId)], "no event on either (plan X-WD-4)").toEqual([[], []]);
    // X-DW-2: the final's seat the semi fed is dead, so the other semi's winner walks the final over when it arrives.
    const final = await fixtureRow(semi.winner_to_fixture!);
    expect(seatOf(final, semi.winner_to_slot)).toBeNull();
    const other = rows.filter((r) => r.winner_to_fixture !== null && r.winner_to_fixture !== parentId && r.round_no === a.round_no);
    expect(other, "rig: the other half's two quarter-finals").toHaveLength(2);
    for (const qf of other) await playBadminton(s.auth, qf.id, true);
    const otherSemi = await fixtureRow(other[0]!.winner_to_fixture!);
    await playBadminton(s.auth, otherSemi.id, true);
    expect((await fixtureRow(final.id)).outcome).toEqual(seatWalkover(otherSemi.home_entrant_id!));
  });

  it("X-WD-4 negative pair (Review Focus 1): a dead seat beside a RECORDED double walkover (nobody withdrew from it) is a void, not a double walkover; a void of the feeder revives the line", async () => {
    // single-sport: badminton. As above, but QF-B's double walkover is recorded (`core.forfeit{by:"both"}`): nobody of
    // QF-B departed, so the semi's two dead seats are not both "through departure" (plan Task 8 table) — it voids, as
    // double-walkover-seating.test.ts's Review Focus 1 rig does for two recorded feeders.
    const s = await seedBracket({ ...badminton, stageKind: "knockout", entrants: 8 });
    const { a, b, parentId } = siblingsInto(await rowsOf(s.stageId));
    await playBadminton(s.auth, a.id, true);
    await withdrawEntrantCascade(s.auth, a.home_entrant_id!);
    expect(labelOf(await fixtureRow(parentId), a.winner_to_slot), "premise: the departed seat is dead").toBe(BYE_KEY);
    await post(s.auth, b.id, "core.forfeit", { by: "both", reason: "walkover" });
    const semi = await fixtureRow(parentId);
    expect([semi.status, semi.outcome, semi.home_entrant_id, semi.away_entrant_id]).toEqual(["abandoned", null, null, null]);
    expect(await activeTypes(parentId)).toEqual([]);
    // Review Focus 1's sequence: voiding QF-B's double walkover puts the semi back to waiting (her seat stays dead).
    const [dwEvent] = active(await ledgerOf(b.id));
    await post(s.auth, b.id, "core.void", { event_id: dwEvent!.id });
    const waiting = await fixtureRow(parentId);
    expect([waiting.status, waiting.outcome, labelOf(waiting, a.winner_to_slot)]).toEqual(["scheduled", null, BYE_KEY]);
    // …and QF-B played for real now walks its winner over her seat — naming her, who withdrew (owner ruling 116).
    await playBadminton(s.auth, b.id, false);
    expect((await fixtureRow(parentId)).outcome).toEqual(withdrewAward(b.away_entrant_id!, a.home_entrant_id!));
  });

  it("X-WD-4: every finalist-to-be withdraws — both semis are double walkovers and the final stays open, never a double walkover (D19, X-DW-3)", async () => {
    // single-sport: badminton. Four entrants; each semi loses one side before Start and the other after it, so both
    // are departure double walkovers and both of the final's seats die through departure. A final has no next match:
    // it is never written a double walkover (the vacant title is W4's).
    const s = await seedBracket({ ...badminton, stageKind: "knockout", entrants: 4 });
    const semis = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id);
    expect(semis, "rig: two seated semis").toHaveLength(2);
    for (const sf of semis) await withdrawBeforeStart(s.auth, s.divisionId, sf.home_entrant_id!);
    for (const sf of semis) await withdrawEntrantCascade(s.auth, sf.away_entrant_id!);
    let checked = 0;
    for (const sf of semis) {
      const r = await fixtureRow(sf.id);
      expect([r.status, r.outcome], `semi ${sf.id}`).toEqual(["forfeited", { kind: "double_walkover" }]);
      checked++;
    }
    expect(checked).toBe(2);
    const final = await fixtureRow(semis[0]!.winner_to_fixture!);
    expect([final.status, final.outcome, final.home_entrant_id, final.away_entrant_id]).toEqual(["scheduled", null, null, null]);
    expect(await activeTypes(final.id)).toEqual([]);
    expect((await completeStage(s.auth, s.stageId)).completed, "nobody holds the title: not finished").toBe(false);
  });

  // ---- loop-F review I-1: a void after her departure stamped the seat she would have taken ----
  /** Void the newest live event of a fixture (the console's Take back). */
  const voidLatest = async (auth: AuthCtx, fixtureId: string) => {
    const last = active(await ledgerOf(fixtureId)).at(-1);
    if (!last) throw new Error(`rig: ${fixtureId} has no live event to void`);
    return post(auth, fixtureId, "core.void", { event_id: last.id });
  };
  /** QF-A played (home X wins), X withdraws while the semi's other side is TBD (D17 stamps her semi seat). */
  async function stampedSemi() {
    const s = await seedBracket({ ...badminton, stageKind: "knockout", entrants: 8 });
    const rows = await rowsOf(s.stageId);
    const { a, b, parentId } = siblingsInto(rows);
    await playBadminton(s.auth, a.id, true);
    await withdrawEntrantCascade(s.auth, a.home_entrant_id!);
    const stamped = await fixtureRow(parentId);
    expect([seatOf(stamped, a.winner_to_slot), labelOf(stamped, a.winner_to_slot)], "rig: her semi seat is stamped dead").toEqual([null, BYE_KEY]);
    const drawn = { key: "slot.winner_match", params: { round: a.round_no, seq: a.seq_in_round } };
    return { s, rows, a, b, parentId, drawn };
  }
  const slotLabel = (r: FixtureRow, slot: number | null) => (slot === 1 ? r.home_slot_label : r.away_slot_label);

  it("I-1: a void of the line she won lifts her stamp — the semi waits for that line again; the other side re-deciding it is seated", async () => {
    // single-sport: badminton; the un-fill reads the feed graph and the entrant status, not the sport.
    const { s, a, parentId, drawn } = await stampedSemi();
    await voidLatest(s.auth, a.id);
    expect((await fixtureRow(a.id)).status, "rig: the line is open again").toBe("in_play");
    const waiting = await fixtureRow(parentId);
    expect([seatOf(waiting, a.winner_to_slot), slotLabel(waiting, a.winner_to_slot), waiting.status, waiting.outcome]).toEqual([
      null,
      drawn,
      "scheduled",
      null,
    ]);
    // Re-decided for the side still in the field: she is seated in the semi (fillSlot writes the waiting seat).
    for (let g = 0; g < 2 && (await fixtureRow(a.id)).status === "in_play"; g++) {
      await post(s.auth, a.id, "badminton.game.summary", { home: 10, away: 21 });
    }
    expect(seatOf(await fixtureRow(parentId), a.winner_to_slot)).toBe(a.away_entrant_id);
  });

  it("I-1: the walkover her stamp gave is reset and what it advanced released; she re-winning is never seated — her opponent walks over again", async () => {
    // single-sport: badminton.
    const { s, a, b, parentId, drawn } = await stampedSemi();
    await playBadminton(s.auth, b.id, true);
    const walked = await fixtureRow(parentId);
    // Owner ruling 116: the walkover over her stamp names her, who withdrew.
    expect([walked.status, walked.outcome], "rig: QF-B's winner walked over her stamp").toEqual(["forfeited", withdrewAward(b.home_entrant_id!, a.home_entrant_id!)]);
    expect(seatOf(await fixtureRow(walked.winner_to_fixture!), walked.winner_to_slot), "rig: and went on").toBe(b.home_entrant_id);
    // R116-2: the walkover shows its credit — the score written beside an award no event recorded.
    const storedLines = async () =>
      (await sql<{ lines: string[] }[]>`
        select array(select p ->> 'line' from jsonb_array_elements(summary -> 'perSide') p) as lines
        from match_states where fixture_id = ${parentId}`)[0]?.lines ?? null;
    const credited = await storedLines();
    expect(credited, "R116-2: the walkover's credited score").not.toBeNull();
    expect(credited!.some((l) => /[1-9]/.test(l)), `R116-2: it credits something (${credited})`).toBe(true);
    await voidLatest(s.auth, a.id);
    const reset = await fixtureRow(parentId);
    expect([reset.status, reset.outcome, seatOf(reset, a.winner_to_slot), slotLabel(reset, a.winner_to_slot), seatOf(reset, b.winner_to_slot)]).toEqual([
      "scheduled",
      null,
      null,
      drawn,
      b.home_entrant_id,
    ]);
    // R116-2: …and the reset takes it back: a re-opened tie shows no score, as before it was awarded.
    expect(await storedLines(), "R116-2: the reset tie stores no score").toBeNull();
    const final = await fixtureRow(walked.winner_to_fixture!);
    expect(seatOf(final, walked.winner_to_slot), "the walkover's advance is taken back").toBeNull();
    expect(slotLabel(final, walked.winner_to_slot)).toEqual({ key: "slot.winner_match", params: { round: walked.round_no, seq: walked.seq_in_round } });
    // She wins the re-opened line again: a departed winner is stamped, never seated, and QF-B's winner walks over.
    await post(s.auth, a.id, "badminton.game.summary", { home: 21, away: 10 });
    expect((await fixtureRow(a.id)).status, "rig: she won it again").toBe("decided");
    const again = await fixtureRow(parentId);
    expect([seatOf(again, a.winner_to_slot), labelOf(again, a.winner_to_slot), again.status, again.outcome]).toEqual([
      null,
      BYE_KEY,
      "forfeited",
      withdrewAward(b.home_entrant_id!, a.home_entrant_id!),
    ]);
    expect(seatOf(await fixtureRow(again.winner_to_fixture!), again.winner_to_slot)).toBe(b.home_entrant_id);
    expect(await storedLines(), "R116-2: walked over again, the same credit").toEqual(credited);
  });

  it("I-1: when the match her stamp's walkover fed has STARTED, the void is refused NEXT_MATCH_STARTED and nothing is written", async () => {
    // single-sport: badminton.
    const { s, rows, a, b, parentId } = await stampedSemi();
    await playBadminton(s.auth, b.id, true);
    const walked = await fixtureRow(parentId);
    // The other half reaches the final too, and the final starts.
    const other = rows.filter((r) => r.round_no === a.round_no && r.winner_to_fixture !== parentId);
    expect(other, "rig: the other half's two quarter-finals").toHaveLength(2);
    for (const qf of other) await playBadminton(s.auth, qf.id, true);
    await playBadminton(s.auth, other[0]!.winner_to_fixture!, true);
    const final = walked.winner_to_fixture!;
    await post(s.auth, final, "core.start");
    const before = await rowsOf(s.stageId);
    const ledgerBefore = await ledgerOf(a.id);
    await expect(voidLatest(s.auth, a.id)).rejects.toMatchObject({ status: 409, code: "NEXT_MATCH_STARTED" });
    expect(await rowsOf(s.stageId), "nothing written").toEqual(before);
    expect(await ledgerOf(a.id), "the void is not recorded").toEqual(ledgerBefore);
  });

  it("I-1 guard: a stamped seat whose OWN line was recorded (not a cascade write) refuses the void NEXT_MATCH_STARTED and writes nothing", async () => {
    // single-sport: badminton. Assumptions are guards: the product cannot start a semi with an empty seat, so the
    // recorded line is planted as a legacy/hand-written row would carry it — a live core.start on the stamped semi.
    // The un-fill must never rewrite a line somebody recorded; it names the match to void first instead.
    const { s, a, parentId } = await stampedSemi();
    await sql`update fixtures set status = 'in_play' where id = ${parentId}`;
    await insertLegacyEvents(parentId, [{ type: "core.start", payload: {} }]);
    const before = await rowsOf(s.stageId);
    const ledgerBefore = await ledgerOf(a.id);
    await expect(voidLatest(s.auth, a.id)).rejects.toMatchObject({ status: 409, code: "NEXT_MATCH_STARTED" });
    expect(await rowsOf(s.stageId), "nothing written").toEqual(before);
    expect(await ledgerOf(a.id), "the void is not recorded").toEqual(ledgerBefore);
  });

  it("I-1: a DEPARTURE double walkover her stamp helped make is revived by the void; the line is re-decided normally", async () => {
    // single-sport: badminton. X-WD-4 (dead seats)'s rig: QF-B's home left before Start, QF-A's winner withdrew (stamp),
    // QF-B's away withdrew — QF-B and the semi are departure double walkovers. Voiding QF-A's last game revives the
    // semi: her stamp lifted, the semi back to waiting for QF-A; QF-B's dead side stays dead.
    const s = await seedBracket({ ...badminton, stageKind: "knockout", entrants: 8 });
    const { a, b, parentId } = siblingsInto(await rowsOf(s.stageId));
    await withdrawBeforeStart(s.auth, s.divisionId, b.home_entrant_id!);
    await playBadminton(s.auth, a.id, true);
    await withdrawEntrantCascade(s.auth, a.home_entrant_id!);
    await withdrawEntrantCascade(s.auth, b.away_entrant_id!);
    expect([(await fixtureRow(parentId)).status, (await fixtureRow(parentId)).outcome], "rig").toEqual(["forfeited", { kind: "double_walkover" }]);
    await voidLatest(s.auth, a.id);
    const revived = await fixtureRow(parentId);
    expect([revived.status, revived.outcome, seatOf(revived, a.winner_to_slot), slotLabel(revived, a.winner_to_slot)]).toEqual([
      "scheduled",
      null,
      null,
      { key: "slot.winner_match", params: { round: a.round_no, seq: a.seq_in_round } },
    ]);
    // QF-A re-decided for the side in the field: she walks over QF-B's dead side.
    for (let g = 0; g < 2 && (await fixtureRow(a.id)).status === "in_play"; g++) {
      await post(s.auth, a.id, "badminton.game.summary", { home: 10, away: 21 });
    }
    expect((await fixtureRow(parentId)).outcome).toEqual(seatWalkover(a.away_entrant_id!));
  });

  it("R-1: a departed LOSER's seat is stamped at the decision — a void of that line revives the third-place line her dead feed voided, and the field side re-deciding it is seated in a LIVE line, never the abandoned one", async () => {
    // single-sport: badminton; the un-fill reads the feed graph and the entrant status, not the sport. Every
    // DEPARTED_STATUSES member: a disqualification is a status change with no cascade, and a W2a-era withdrawal left
    // the same shape (a departed entrant still seated in an unplayed line).
    let checked = 0;
    for (const departed of [...DEPARTED_STATUSES]) {
      const s = await seedBracket({ ...badminton, stageKind: "knockout", entrants: 4, stageConfig: { thirdPlace: true } });
      const rows = await rowsOf(s.stageId);
      const [a, b, ...more] = rows.filter((r) => r.home_entrant_id && r.away_entrant_id);
      if (!a || !b || more.length > 0) throw new Error(`${departed}: rig — two seated semis`);
      if (a.loser_to_fixture === null || a.loser_to_fixture !== b.loser_to_fixture) throw new Error(`${departed}: rig — both semis' losers feed one third-place line`);
      const thirdId = a.loser_to_fixture;
      // The seat's label as the generator drew it — the label a revived seat waits under again.
      const drawn = slotLabel(rows.find((r) => r.id === thirdId)!, a.loser_to_slot);
      expect(drawn, `${departed}: rig — the generator labelled the seat`).not.toBeNull();
      // Semi B walks over at its home's withdrawal: an award, whose loser edge is dead (X-DE-1).
      await withdrawEntrantCascade(s.auth, b.home_entrant_id!);
      // Semi A's away leaves the field with no cascade, then loses semi A: a departed loser (X-WD-5).
      await patchEntrant(s.auth, a.away_entrant_id!, { status: departed } as never);
      await playBadminton(s.auth, a.id, true);
      const voided = await fixtureRow(thirdId);
      expect([voided.status, voided.outcome, voided.home_entrant_id, voided.away_entrant_id], `${departed}: rig — both loser feeds dead: the third-place line is void`).toEqual([
        "abandoned",
        null,
        null,
        null,
      ]);
      await voidLatest(s.auth, a.id);
      expect((await fixtureRow(a.id)).status, `${departed}: rig — semi A is open again`).toBe("in_play");
      const revived = await fixtureRow(thirdId);
      expect([revived.status, revived.outcome, seatOf(revived, a.loser_to_slot), slotLabel(revived, a.loser_to_slot)], `${departed}: the void revives the third-place line, waiting on semi A`).toEqual([
        "scheduled",
        null,
        null,
        drawn,
      ]);
      // Re-decided the other way: she wins (a departed winner is stamped, never seated) and the field side loses — seated
      // in the live third-place line, which then walks him over semi B's dead side.
      for (let g = 0; g < 3 && (await fixtureRow(a.id)).status === "in_play"; g++) {
        await post(s.auth, a.id, "badminton.game.summary", { home: 10, away: 21 });
      }
      expect((await fixtureRow(a.id)).status, `${departed}: rig — she won semi A`).toBe("decided");
      const third = await fixtureRow(thirdId);
      expect([third.status, third.outcome, seatOf(third, a.loser_to_slot)], `${departed}: the field loser is in a live line, walked over semi B's dead side`).toEqual([
        "forfeited",
        seatWalkover(a.home_entrant_id!),
        a.home_entrant_id,
      ]);
      checked++;
    }
    expect(checked).toBe(DEPARTED_STATUSES.size);
  }, 120_000);

  it("R-1 consequence: BOTH semis lost by departed entrants — both third-place seats are departure-dead, a line that feeds nothing stays open (X-WD-4/D19, as a final does), and the stage still completes on its final", async () => {
    // single-sport: badminton. Before R-1 a departed loser's seat was dead but unstamped, so this line was VOIDED; the
    // stamp makes both seats departures, which is X-WD-4's "every side withdrew" — and D19 writes no double walkover on
    // a line with no next match. Bracket completion ranks an unplayed third-place line by the fallback (bracketRanks).
    const s = await seedBracket({ ...badminton, stageKind: "knockout", entrants: 4, stageConfig: { thirdPlace: true } });
    const [a, b] = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id);
    if (!a || !b || a.loser_to_fixture === null || a.loser_to_fixture !== b.loser_to_fixture) throw new Error("rig: two semis into one third-place line");
    for (const sf of [a, b]) {
      await patchEntrant(s.auth, sf.away_entrant_id!, { status: "disqualified" } as never);
      await playBadminton(s.auth, sf.id, true);
    }
    const third = await fixtureRow(a.loser_to_fixture);
    expect([third.status, third.outcome, labelOf(third, 1), labelOf(third, 2)], "both seats stamped dead; nothing written on the line").toEqual([
      "scheduled",
      null,
      BYE_KEY,
      BYE_KEY,
    ]);
    expect(await activeTypes(third.id)).toEqual([]);
    const final = await playBadminton(s.auth, a.winner_to_fixture!, true);
    expect((await completeStage(s.auth, s.stageId)).completed, "the final decided the stage").toBe(true);
    expect(final.status).toBe("decided");
  }, 120_000);

  // ---- loop-F tidy 2: taking back an AWARD releases the loser edge it left dead (X-DE-1) ----
  it("tidy-2: taking back a recorded WALKOVER releases its dead loser edge — the third-place line it settled (a cascade void when both semis walked over, a bye award when one did) waits for that semi again, and the replayed semi's loser is seated in a LIVE line", async () => {
    // single-sport: badminton; the un-fill reads the outcome kind and the feed graph, not the sport. No departure
    // anywhere: an award's loser edge is dead by X-DE-1 alone.
    const SHAPES = ["both semis walk over", "one semi walks over"] as const;
    let checked = 0;
    for (const shape of SHAPES) {
      const both = shape === "both semis walk over";
      const s = await seedBracket({ ...badminton, stageKind: "knockout", entrants: 4, stageConfig: { thirdPlace: true } });
      const rows = await rowsOf(s.stageId);
      const [a, b, ...more] = rows.filter((r) => r.home_entrant_id && r.away_entrant_id);
      if (!a || !b || more.length > 0 || a.loser_to_fixture === null || a.loser_to_fixture !== b.loser_to_fixture) {
        throw new Error(`${shape}: rig — two semis into one third-place line`);
      }
      const thirdId = a.loser_to_fixture;
      const drawnRow = rows.find((r) => r.id === thirdId)!;
      const drawnA = slotLabel(drawnRow, a.loser_to_slot);
      expect(drawnA, `${shape}: rig — the generator labelled the seat`).not.toBeNull();
      // Semi A: a walkover recorded before the start — an award, so its loser edge is dead (X-DE-1).
      await post(s.auth, a.id, "core.forfeit", { by: a.away_entrant_id, reason: "walkover" });
      if (both) await post(s.auth, b.id, "core.forfeit", { by: b.away_entrant_id, reason: "walkover" });
      else await playBadminton(s.auth, b.id, true);
      const settled = await fixtureRow(thirdId);
      expect([settled.status, settled.outcome], `${shape}: rig — the third-place line was settled on semi A's dead loser edge`).toEqual(
        both ? ["abandoned", null] : ["forfeited", seatWalkover(b.away_entrant_id!)],
      );
      // Take back semi A's walkover: the line is open again, and so is the seat its loser drops into.
      await voidLatest(s.auth, a.id);
      expect((await fixtureRow(a.id)).status, `${shape}: rig — semi A is open again`).toBe("scheduled");
      const revived = await fixtureRow(thirdId);
      expect(
        [revived.status, revived.outcome, seatOf(revived, a.loser_to_slot), slotLabel(revived, a.loser_to_slot), seatOf(revived, b.loser_to_slot)],
        `${shape}: the third-place line waits for semi A again`,
      ).toEqual(["scheduled", null, null, drawnA, both ? null : b.away_entrant_id]);
      // Replayed: semi A's loser drops into a live line — walked over semi B's still-dead side, or a match to play.
      await playBadminton(s.auth, a.id, true);
      const third = await fixtureRow(thirdId);
      expect([third.status, third.outcome, third.home_entrant_id !== null && third.away_entrant_id !== null, seatOf(third, a.loser_to_slot)], `${shape}: semi A's loser is in a live line`).toEqual(
        both ? ["forfeited", seatWalkover(a.away_entrant_id!), false, a.away_entrant_id] : ["scheduled", null, true, a.away_entrant_id],
      );
      checked++;
    }
    expect(checked).toBe(SHAPES.length);
  }, 120_000);

  it("tidy-2: double elimination — taking back a winners'-bracket FORFEIT (a W2b award, a legacy chess forfeit win) resets the losers' line it walked over and takes back the name that walkover advanced; the replayed loser drops into a live line", async () => {
    // Two sports, the two outcome shapes a forfeit takes (`killsLoserEdge`): badminton's `award` through core.forfeit,
    // and chess's LEGACY `win{method:"forfeit"}` a pre-W2b stream still folds to (raw SQL — the method is retired on
    // write, D15 — then a note so the next append folds it, as double-walkover-seating's X-DE-1 rig does).
    const SHAPES = [
      { label: "badminton award", ...badminton },
      { label: "chess legacy forfeit win", ...chess },
    ];
    let checked = 0;
    for (const shape of SHAPES) {
      const isChess = shape.sport === "boardgame";
      const win = async (id: string) => {
        if ((await fixtureRow(id)).status === "scheduled") await post(s.auth, id, "core.start");
        if (isChess) await post(s.auth, id, "boardgame.result", { winner: (await fixtureRow(id)).home_entrant_id, method: "checkmate" });
        else for (let g = 0; g < 2; g++) await post(s.auth, id, "badminton.game.summary", { home: 21, away: 10 });
        expect((await fixtureRow(id)).status, `${shape.label}: rig — decided`).toBe("decided");
      };
      const s = await seedBracket({ sport: shape.sport, variant: shape.variant, stageKind: "double_elim", entrants: 4 });
      const rows = await rowsOf(s.stageId);
      const first = Math.min(...rows.map((r) => r.round_no));
      const [m1, m2, ...more] = rows.filter((r) => r.round_no === first && r.home_entrant_id && r.away_entrant_id);
      if (!m1 || !m2 || more.length > 0 || m1.loser_to_fixture === null || m1.loser_to_fixture !== m2.loser_to_fixture) {
        throw new Error(`${shape.label}: rig — two winners' first-round lines drop into one losers' line`);
      }
      const lbId = m1.loser_to_fixture;
      const drawn = slotLabel(rows.find((r) => r.id === lbId)!, m1.loser_to_slot);
      expect(drawn, `${shape.label}: rig — the generator labelled the seat`).not.toBeNull();
      if (isChess) {
        await insertLegacyEvents(m1.id, [
          { type: "core.start", payload: {} },
          { type: "boardgame.result", payload: { winner: m1.home_entrant_id, method: "forfeit" } }, // legacy row
        ]);
        await post(s.auth, m1.id, "core.note", { text: "arbiter's report" });
      } else {
        await post(s.auth, m1.id, "core.forfeit", { by: m1.away_entrant_id, reason: "walkover" });
      }
      const forfeited = await fixtureRow(m1.id);
      expect(forfeited.outcome, `${shape.label}: rig — the forfeit shape`).toMatchObject(isChess ? { kind: "win", method: "forfeit" } : { kind: "award" }); // legacy chess fold
      await win(m2.id);
      const lb = await fixtureRow(lbId);
      expect([lb.status, lb.outcome], `${shape.label}: rig — the losers' line walked m2's loser over m1's dead loser edge`).toEqual(["forfeited", seatWalkover(m2.away_entrant_id!)]);
      if (lb.winner_to_fixture === null) throw new Error(`${shape.label}: rig — the losers' first round feeds the losers' final`);
      const nextId = lb.winner_to_fixture;
      const nextDrawn = slotLabel(rows.find((r) => r.id === nextId)!, lb.winner_to_slot);
      expect(seatOf(await fixtureRow(nextId), lb.winner_to_slot), `${shape.label}: rig — that walkover advanced m2's loser`).toBe(m2.away_entrant_id);

      // Take back the forfeit (chess: the note first, then the legacy result).
      if (isChess) await voidLatest(s.auth, m1.id);
      await voidLatest(s.auth, m1.id);
      expect((await fixtureRow(m1.id)).outcome, `${shape.label}: rig — m1 is undecided again`).toBeNull();
      const reset = await fixtureRow(lbId);
      expect(
        [reset.status, reset.outcome, seatOf(reset, m1.loser_to_slot), slotLabel(reset, m1.loser_to_slot), seatOf(reset, m2.loser_to_slot)],
        `${shape.label}: the losers' line waits for m1 again`,
      ).toEqual(["scheduled", null, null, drawn, m2.away_entrant_id]);
      const next = await fixtureRow(nextId);
      expect([seatOf(next, lb.winner_to_slot), slotLabel(next, lb.winner_to_slot)], `${shape.label}: the name the walkover advanced is taken back`).toEqual([null, nextDrawn]);
      await win(m1.id);
      const live = await fixtureRow(lbId);
      expect([live.status, live.outcome, seatOf(live, m1.loser_to_slot), seatOf(live, m2.loser_to_slot)], `${shape.label}: m1's loser drops into a live losers' line`).toEqual([
        "scheduled",
        null,
        m1.away_entrant_id,
        m2.away_entrant_id,
      ]);
      checked++;
    }
    expect(checked).toBe(SHAPES.length);
  }, 120_000);

  it("tidy-3: double elimination of 8 — a winners' walkover beside a recorded DOUBLE walkover, taken back, revives the losers' second-round void TWO edges away (through the first-round void its dead loser edge made); replayed, its loser walks into a live line, never the abandoned row", async () => {
    // single-sport: badminton; the un-fill reads the outcome kind and the feed graph, not the sport. The loop-F tidy-3
    // reviewer's identity-control rig: the first-round losers' void is reached only through m0's DEAD loser edge — its
    // seat carries no stamp (a void stamps nothing) — so the plan must lock it, and the void it killed beyond it, up front
    // (fed-seats.ts `reachable`); a revive whose target is not locked is skipped as if it were cross-stage.
    const s = await seedBracket({ ...badminton, stageKind: "double_elim", entrants: 8 });
    const rows = await rowsOf(s.stageId);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const first = Math.min(...rows.map((r) => r.round_no));
    const r1 = rows.filter((r) => r.round_no === first && r.home_entrant_id && r.away_entrant_id);
    expect(r1.length, "rig: four winners' first-round lines").toBe(4);
    const m0 = r1.find((x) => r1.some((y) => y.id !== x.id && y.loser_to_fixture === x.loser_to_fixture && y.winner_to_fixture === x.winner_to_fixture));
    const m1 = r1.find((y) => m0 !== undefined && y.id !== m0.id && y.loser_to_fixture === m0.loser_to_fixture && y.winner_to_fixture === m0.winner_to_fixture);
    if (!m0 || !m1 || m0.loser_to_fixture === null || m0.winner_to_fixture === null) throw new Error("rig: two winners' first-round lines sharing both their next matches");
    const lbAId = m0.loser_to_fixture;
    const wbR2Id = m0.winner_to_fixture;
    const lbA = byId.get(lbAId)!;
    const wbR2 = byId.get(wbR2Id)!;
    if (lbA.winner_to_fixture === null || lbA.winner_to_fixture !== wbR2.loser_to_fixture) {
      throw new Error("rig: the first-round losers' line and the winners' second round both drop into one losers' second-round line");
    }
    const lbBId = lbA.winner_to_fixture;
    const drawnLbB = slotLabel(byId.get(lbBId)!, lbA.winner_to_slot);
    expect(drawnLbB, "rig: the generator labelled the seat").not.toBeNull();

    // m0 walks over (an award: its loser edge is dead, X-DE-1); m1 is a recorded double walkover (advances nobody).
    await post(s.auth, m0.id, "core.forfeit", { by: m0.away_entrant_id, reason: "walkover" });
    await post(s.auth, m1.id, "core.forfeit", { by: "both", reason: "walkover" });
    const settled = await Promise.all([lbAId, wbR2Id, lbBId].map(fixtureRow));
    expect(
      settled.map((r) => [r.status, r.outcome]),
      "rig: the losers' first round void (both loser feeds dead), the winners' second round a walkover (an award, its loser edge dead too), so the losers' second round void",
    ).toEqual([
      ["abandoned", null],
      ["forfeited", seatWalkover(m0.home_entrant_id!)],
      ["abandoned", null],
    ]);

    // Take back m0's walkover: both voids it made wait again — the second-round one only through the first's revive.
    await voidLatest(s.auth, m0.id);
    expect((await fixtureRow(m0.id)).status, "rig: m0 is open again").toBe("scheduled");
    const back = await Promise.all([lbAId, lbBId].map(fixtureRow));
    expect(
      back.map((r) => [r.status, r.outcome, r.home_entrant_id, r.away_entrant_id]),
      "the losers' first round AND the second-round void two edges away both wait again",
    ).toEqual([
      ["scheduled", null, null, null],
      ["scheduled", null, null, null],
    ]);
    expect(slotLabel(back[1]!, lbA.winner_to_slot), "the revived seat is back to its drawn label").toEqual(drawnLbB);

    // Replayed: m0's loser walks over m1's dead side into the losers' second round — a live line, walked over the
    // winners' second round's dead loser edge (that line walks m0's winner over m1's side again).
    await playBadminton(s.auth, m0.id, true);
    expect((await fixtureRow(m0.id)).status, "rig: m0 decided").toBe("decided");
    const [lbAEnd, lbBEnd] = await Promise.all([lbAId, lbBId].map(fixtureRow));
    expect([lbAEnd!.status, lbAEnd!.outcome], "the losers' first round walks m0's loser over m1's dead side").toEqual(["forfeited", seatWalkover(m0.away_entrant_id!)]);
    expect(
      [lbBEnd!.status, lbBEnd!.outcome, seatOf(lbBEnd!, lbA.winner_to_slot)],
      "m0's loser is in a LIVE losers' second round (walked over its dead side), never the abandoned row",
    ).toEqual(["forfeited", seatWalkover(m0.away_entrant_id!), m0.away_entrant_id]);
  }, 120_000);

  it("tidy-2 (X-WD-5, legacy): a departed loser's dead seat that carries NO stamp — a line decided before R-1 stamped it — is released too: the third-place void it helped make waits for that semi again", async () => {
    // single-sport: badminton. Before R-1 a departed loser's seat was dead but unstamped (`loserFeederIsDead` reads
    // her departure); the rig writes that legacy shape by clearing the stamp R-1 now writes, back to the drawn label.
    const s = await seedBracket({ ...badminton, stageKind: "knockout", entrants: 4, stageConfig: { thirdPlace: true } });
    const rows = await rowsOf(s.stageId);
    const [a, b] = rows.filter((r) => r.home_entrant_id && r.away_entrant_id);
    if (!a || !b || a.loser_to_fixture === null || a.loser_to_fixture !== b.loser_to_fixture) throw new Error("rig: two semis into one third-place line");
    const thirdId = a.loser_to_fixture;
    const drawn = slotLabel(rows.find((r) => r.id === thirdId)!, a.loser_to_slot);
    const col = a.loser_to_slot === 1 ? sql`home_slot_label` : sql`away_slot_label`;
    await patchEntrant(s.auth, a.away_entrant_id!, { status: "disqualified" } as never);
    await playBadminton(s.auth, a.id, true);
    await sql`update fixtures set ${col} = ${sql.json(drawn as never)} where id = ${thirdId}`;
    expect(labelOf(await fixtureRow(thirdId), a.loser_to_slot), "rig: the legacy shape — her dead seat carries no stamp").not.toBe(BYE_KEY);
    await post(s.auth, b.id, "core.forfeit", { by: b.away_entrant_id, reason: "walkover" });
    const voided = await fixtureRow(thirdId);
    expect([voided.status, voided.outcome, voided.home_entrant_id, voided.away_entrant_id], "X-DW-2 (loser-edge-seat-not-dead killer): both loser feeds dead — the line is void").toEqual(["abandoned", null, null, null]);
    await voidLatest(s.auth, a.id);
    const revived = await fixtureRow(thirdId);
    expect([revived.status, revived.outcome, seatOf(revived, a.loser_to_slot), slotLabel(revived, a.loser_to_slot)], "the void waits for semi A again").toEqual([
      "scheduled",
      null,
      null,
      drawn,
    ]);
  }, 120_000);

  it("tidy-2: page_playoff — q1's walkover taken back revives the q2 void its dead loser edge helped make AND lifts the stamp that void put on the final, which q1's own winner edge resets in the same write; replayed, the final waits for q2", async () => {
    // single-sport: badminton. The one shipped shape where the line a dead loser edge voided feeds the SAME next match
    // as the line's winner edge: the release resets the final (its walkover over the void) and the revive lifts the
    // final's other seat — two writes to one row, in one transaction.
    const s = await seedBracket({ ...badminton, stageKind: "page_playoff", entrants: 4 });
    const rows = await rowsOf(s.stageId);
    const q1 = rows.find((r) => r.home_entrant_id && r.away_entrant_id && r.loser_to_fixture !== null);
    const el = rows.find((r) => r.home_entrant_id && r.away_entrant_id && r.id !== q1?.id);
    if (!q1 || !el || q1.loser_to_fixture === null || q1.winner_to_fixture === null || el.winner_to_fixture !== q1.loser_to_fixture) {
      throw new Error("rig: page_playoff q1 / eliminator into q2");
    }
    const q2Id = q1.loser_to_fixture;
    const finalId = q1.winner_to_fixture;
    const q2Row = rows.find((r) => r.id === q2Id)!;
    if (q2Row.winner_to_fixture !== finalId) throw new Error("rig: q2 feeds the final");
    const finalDrawn = { q1: slotLabel(rows.find((r) => r.id === finalId)!, q1.winner_to_slot), q2: slotLabel(rows.find((r) => r.id === finalId)!, q2Row.winner_to_slot) };
    // The eliminator's two sides leave in turn: a walkover, then its winner's q2 seat stamped dead (D17).
    await withdrawEntrantCascade(s.auth, el.home_entrant_id!);
    await withdrawEntrantCascade(s.auth, el.away_entrant_id!);
    await post(s.auth, q1.id, "core.forfeit", { by: q1.away_entrant_id, reason: "walkover" });
    const q2 = await fixtureRow(q2Id);
    expect([q2.status, q2.outcome, q2.home_entrant_id, q2.away_entrant_id], "rig: q2 is void (one seat departed, the other a forfeit's dead loser edge)").toEqual(["abandoned", null, null, null]);
    const final = await fixtureRow(finalId);
    expect([final.status, final.outcome, labelOf(final, q2Row.winner_to_slot)], "rig: the final walked q1's winner over q2's void").toEqual(["forfeited", seatWalkover(q1.home_entrant_id!), BYE_KEY]);

    await voidLatest(s.auth, q1.id);
    const q2Back = await fixtureRow(q2Id);
    expect([q2Back.status, q2Back.outcome, seatOf(q2Back, q1.loser_to_slot)], "q2 waits for q1's loser again").toEqual(["scheduled", null, null]);
    const finalBack = await fixtureRow(finalId);
    expect(
      [finalBack.status, finalBack.outcome, finalBack.home_entrant_id, finalBack.away_entrant_id, slotLabel(finalBack, q1.winner_to_slot), slotLabel(finalBack, q2Row.winner_to_slot)],
      "the final waits for both lines again — neither seat stamped",
    ).toEqual(["scheduled", null, null, null, finalDrawn.q1, finalDrawn.q2]);
    // Replayed: q1's winner waits in the final for q2, whose loser-edge seat now holds q1's loser — who walks over the
    // eliminator's departed side into the final.
    await playBadminton(s.auth, q1.id, true);
    const last = await fixtureRow(finalId);
    expect([last.status, last.outcome, seatOf(last, q1.winner_to_slot), seatOf(last, q2Row.winner_to_slot)], "a real final: q1's winner against q2's").toEqual([
      "scheduled",
      null,
      q1.home_entrant_id,
      q1.away_entrant_id,
    ]);
  }, 120_000);

  it("tidy-2: the release through a dead loser edge REFUSES when the match beyond it has started (NEXT_MATCH_STARTED, naming that match), and writes nothing", async () => {
    // single-sport: badminton. Double elimination: the losers' line walked m2's loser over m1's dead edge into the
    // losers' final, which is then not waiting. Its other seat is the winners' final's loser, so it cannot be played
    // without m1's OWN winner edge (the winners' final) starting too; the not-waiting state is therefore the import-only
    // `cancelled`, by raw SQL — the precedent knockout-void-unfill's "refuses when the next match is 'cancelled'" set
    // (`hasStarted`: the status alone). The winners' final has NOT started, so the refusal can only come through the
    // loser edge.
    const s = await seedBracket({ ...badminton, stageKind: "double_elim", entrants: 4 });
    const rows = await rowsOf(s.stageId);
    const first = Math.min(...rows.map((r) => r.round_no));
    const [m1, m2] = rows.filter((r) => r.round_no === first && r.home_entrant_id && r.away_entrant_id);
    if (!m1 || !m2 || m1.loser_to_fixture === null) throw new Error("rig: two winners' first-round lines");
    await post(s.auth, m1.id, "core.forfeit", { by: m1.away_entrant_id, reason: "walkover" });
    await playBadminton(s.auth, m2.id, true);
    const lb = await fixtureRow(m1.loser_to_fixture);
    if (lb.winner_to_fixture === null) throw new Error("rig: the losers' line feeds the losers' final");
    await sql`update fixtures set status = 'cancelled' where id = ${lb.winner_to_fixture}`;
    const wbFinal = await fixtureRow(m1.winner_to_fixture!);
    expect([wbFinal.status, wbFinal.outcome, await liveEvents(wbFinal.id)], "rig: the winners' final has not started").toEqual(["scheduled", null, 0]);
    const before = await rowsOf(s.stageId);
    const err = await voidLatest(s.auth, m1.id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, "refused").toMatchObject({ status: 409, code: "NEXT_MATCH_STARTED" });
    expect(nextMatchRefOf((err as { extra?: Record<string, unknown> }).extra)?.fixture_id, "it names the losers' final").toBe(lb.winner_to_fixture);
    expect(await rowsOf(s.stageId), "nothing written").toEqual(before);
  }, 120_000);

  it("R-4: the way out the settle dialog names when BOTH sides of a held line have left — void back into play, then a disqualification forfeit for either side: nobody advances, and the next match walks the other semi's winner over", async () => {
    // single-sport: football, the held-line rig (a 0-0 at full time is held in a bracket). The dialog's state is a
    // LEGACY row (PF-8a: a W2a withdrawal left the held line alone) or a disqualification (a status change, no
    // cascade) — one side each here, the two departures the dialog counts.
    const s = await seedBracket({ ...football, stageKind: "knockout", entrants: 4 });
    const [a, b] = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id);
    if (!a || !b || a.winner_to_fixture === null || a.winner_to_fixture !== b.winner_to_fixture) throw new Error("rig: two semis into one final");
    await heldFootball(s.auth, a.id);
    await sql`update entrants set status = 'withdrawn' where id = ${a.home_entrant_id}`;
    await patchEntrant(s.auth, a.away_entrant_id!, { status: "disqualified" } as never);
    // Nobody can be named: both settles are refused (C17 over DEPARTED_STATUSES).
    let refusals = 0;
    for (const winner of [a.home_entrant_id!, a.away_entrant_id!]) {
      await expect(post(s.auth, a.id, "core.settle", { winner, method: SETTLE_BY_ORGANISER }), winner).rejects.toMatchObject({ code: "SETTLE_NOT_APPLICABLE" });
      refusals++;
    }
    expect(refusals).toBe(2);
    // Step 1, take back: the full-time whistle is voided and the match is live again.
    const [ft] = active(await ledgerOf(a.id)).slice(-1);
    expect([ft?.type, (ft?.payload as { phase?: string } | undefined)?.phase], "rig: the newest live event is full time").toEqual(["football.period", "FT"]);
    await voidLatest(s.auth, a.id);
    expect((await fixtureRow(a.id)).status, "back into play").toBe("in_play");
    // A disqualification of BOTH is not a recordable event: the engine's `core.forfeit` schema admits `by: "both"` only
    // as a walkover (core/events.ts), and football records a walkover only until something is played (R2, walkoverPhases;
    // ruling 112) — this semi's goals were played.
    await expect(post(s.auth, a.id, "core.forfeit", { by: "both", reason: "disqualified" })).rejects.toMatchObject({ code: "INVALID_EVENT" });
    await expect(post(s.auth, a.id, "core.forfeit", { by: "both", reason: "walkover" })).rejects.toMatchObject({ code: "FORFEIT_REASON_WRONG_PHASE" });
    // Step 2, a disqualification forfeit for either side — the console's Forfeit… with the reason "disqualified". Its
    // nominal winner has left too: stamped, never seated (I-1), so nobody advances from the line.
    await post(s.auth, a.id, "core.forfeit", { by: a.home_entrant_id, reason: "disqualified" });
    const closed = await fixtureRow(a.id);
    expect([closed.status, closed.outcome?.kind], "the line is closed by the forfeit").toEqual(["forfeited", "award"]);
    const final = await fixtureRow(a.winner_to_fixture);
    expect([seatOf(final, a.winner_to_slot), labelOf(final, a.winner_to_slot)], "nobody advances from it: the seat is dead").toEqual([null, BYE_KEY]);
    // The other semi decides: its winner walks over the dead seat in the final.
    await post(s.auth, b.id, "core.start");
    await post(s.auth, b.id, "football.goal", { by: b.home_entrant_id });
    await post(s.auth, b.id, "football.period", { phase: "HT" });
    await post(s.auth, b.id, "football.period", { phase: "FT" });
    expect((await fixtureRow(b.id)).status, "rig: the other semi decided").toBe("decided");
    const walked = await fixtureRow(a.winner_to_fixture);
    // A bye, not ruling 116's walkover: the dead seat's winner was DISQUALIFIED, not withdrawn — no "withdrew".
    expect([walked.status, walked.outcome], "the final walks the other semi's winner over").toEqual(["forfeited", seatWalkover(b.home_entrant_id!)]);
  }, 120_000);

  // Loop R M-12: the no-choice sentence now names the dialog's options after play as "one side and the reason that
  // fits, Retirement or Disqualification" — so the retirement route owes the same proof as R-4's disqualification: the
  // line closes, nobody advances, the next match walks the other semi's winner over.
  it("M-12: the same way out with a RETIREMENT — nobody advances, and the next match walks the other semi's winner over", async () => {
    // single-sport: football, the held-line rig (R-4's).
    const s = await seedBracket({ ...football, stageKind: "knockout", entrants: 4 });
    const [a, b] = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id);
    if (!a || !b || a.winner_to_fixture === null || a.winner_to_fixture !== b.winner_to_fixture) throw new Error("rig: two semis into one final");
    await heldFootball(s.auth, a.id);
    await sql`update entrants set status = 'withdrawn' where id = ${a.home_entrant_id}`;
    await patchEntrant(s.auth, a.away_entrant_id!, { status: "disqualified" } as never);
    await voidLatest(s.auth, a.id);
    expect((await fixtureRow(a.id)).status, "back into play").toBe("in_play");
    await post(s.auth, a.id, "core.forfeit", { by: a.home_entrant_id, reason: "retired" });
    const closed = await fixtureRow(a.id);
    expect([closed.status, closed.outcome?.kind, (closed.outcome as { reason?: string } | null)?.reason], "the line is closed by the retirement").toEqual(["forfeited", "award", "retired"]);
    const final = await fixtureRow(a.winner_to_fixture);
    expect([seatOf(final, a.winner_to_slot), labelOf(final, a.winner_to_slot)], "nobody advances from it: the seat is dead").toEqual([null, BYE_KEY]);
    await post(s.auth, b.id, "core.start");
    await post(s.auth, b.id, "football.goal", { by: b.home_entrant_id });
    await post(s.auth, b.id, "football.period", { phase: "HT" });
    await post(s.auth, b.id, "football.period", { phase: "FT" });
    expect((await fixtureRow(b.id)).status, "rig: the other semi decided").toBe("decided");
    const walked = await fixtureRow(a.winner_to_fixture);
    expect([walked.status, walked.outcome], "the final walks the other semi's winner over").toEqual(["forfeited", seatWalkover(b.home_entrant_id!)]);
  }, 120_000);

  it("tidy-2 (R-4 on a FINAL): the void-then-forfeit route names a DEPARTED winner of a line that feeds nothing — why the dialog offers that route only where the line feeds a next match", async () => {
    // single-sport: football, the held-line rig. A two-entrant knockout: its one line is the final.
    const s = await seedBracket({ ...football, stageKind: "knockout", entrants: 2 });
    const [final] = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id);
    if (!final) throw new Error("rig: a seated final");
    expect([final.winner_to_fixture, final.loser_to_fixture, await fixtureFeedsNextMatch(s.auth, final.id)], "rig: the line feeds nothing").toEqual([null, null, false]);
    await heldFootball(s.auth, final.id);
    await sql`update entrants set status = 'withdrawn' where id = ${final.home_entrant_id}`;
    await patchEntrant(s.auth, final.away_entrant_id!, { status: "disqualified" } as never);
    await voidLatest(s.auth, final.id);
    await post(s.auth, final.id, "core.forfeit", { by: final.home_entrant_id, reason: "disqualified" });
    const closed = await fixtureRow(final.id);
    expect([closed.status, closed.outcome?.kind, closed.outcome?.winner], "the forfeit decides the final for a side that has left").toEqual([
      "forfeited",
      "award",
      final.away_entrant_id,
    ]);
    const [{ status }] = await sql<{ status: string }[]>`select status from entrants where id = ${closed.outcome!.winner!}`;
    expect(DEPARTED_STATUSES.has(status), "its winner is departed").toBe(true);
  }, 120_000);

  it("tidy-2: fixtureFeedsNextMatch (the held block's place-or-advance sentence) is false on EXACTLY the lines the generator marks a final or a third-place line, in every bracket shape", async () => {
    // The oracle is the ENGINE's own role metadata (scheduling/bracket.ts `isFinal`, the third-place line), written on
    // generation — never the feed-edge reading under test. Four entrants: a two-entrant double elimination's one
    // winners' match feeds only the grand final (both edges) and is a "final" by D19 without the flag.
    const SHAPES = [
      { label: "knockout", stageKind: "knockout" as const, stageConfig: {} },
      { label: "knockout + third place", stageKind: "knockout" as const, stageConfig: { thirdPlace: true } },
      { label: "double elimination", stageKind: "double_elim" as const, stageConfig: {} },
      { label: "double elimination + reset", stageKind: "double_elim" as const, stageConfig: { bracketReset: true } },
      { label: "page playoff", stageKind: "page_playoff" as const, stageConfig: {} },
    ];
    let rowsChecked = 0;
    let places = 0;
    for (const shape of SHAPES) {
      const s = await seedBracket({ ...badminton, stageKind: shape.stageKind, entrants: 4, stageConfig: shape.stageConfig });
      const rows = await sql<{ id: string; ext_key: string | null; is_final: boolean; third_place: boolean }[]>`
        select id, ext_key, is_final, third_place from fixtures where stage_id = ${s.stageId} order by round_no, seq_in_round`;
      expect(rows.length, `${shape.label}: rig — lines`).toBeGreaterThan(2);
      const got: string[] = [];
      const want: string[] = [];
      for (const r of rows) {
        if (!(await fixtureFeedsNextMatch(s.auth, r.id))) got.push(r.ext_key ?? r.id);
        if (r.is_final || r.third_place) want.push(r.ext_key ?? r.id);
        rowsChecked++;
      }
      expect(want.length, `${shape.label}: the generator marks at least one line that decides a place`).toBeGreaterThan(0);
      expect(got, `${shape.label}: the lines that feed no next match`).toEqual(want);
      places += want.length;
    }
    expect(rowsChecked, "lines checked").toBeGreaterThan(SHAPES.length * 3);
    expect(places, "place-deciding lines checked").toBeGreaterThanOrEqual(SHAPES.length);
  }, 120_000);

  it("I-5: a double-elimination grand final WITH a bracket reset is a final — a double walkover on it is refused, a withdrawal leaves it open, and the resolver never writes one", async () => {
    // single-sport: badminton; the rule reads the feed graph (both edges into the reset), never the sport.
    const reset = { stageKind: "double_elim" as const, stageConfig: { bracketReset: true } };
    // (1) The append guard (D19), on a real reset grand final: a two-entrant field, the winners' match played.
    const two = await seedBracket({ ...badminton, ...reset, entrants: 2 });
    const wb = (await rowsOf(two.stageId)).find((r) => r.home_entrant_id && r.away_entrant_id)!;
    await playBadminton(two.auth, wb.id, true);
    const gf = await fixtureRow(wb.winner_to_fixture!);
    expect([gf.winner_to_fixture !== null, gf.winner_to_fixture === gf.loser_to_fixture], "rig: the grand final's two edges both feed the reset").toEqual([true, true]);
    expect([gf.home_entrant_id, gf.away_entrant_id], "rig: seated").toEqual([wb.home_entrant_id, wb.away_entrant_id]);
    await expect(post(two.auth, gf.id, "core.forfeit", { by: "both", reason: "walkover" })).rejects.toMatchObject({ code: "DOUBLE_WALKOVER_NO_NEXT_MATCH" });
    expect([(await fixtureRow(gf.id)).status, await activeTypes(gf.id)], "nothing written").toEqual(["scheduled", []]);
    // (2) The withdrawal cascade: both finalists gone (one by a bare status write) — the grand final stays open.
    await sql`update entrants set status = 'disqualified' where id = ${gf.home_entrant_id}`;
    expect(await withdrawEntrantCascade(two.auth, gf.away_entrant_id!)).toMatchObject({ walkovers: 0, voided: 0 });
    const open = await fixtureRow(gf.id);
    expect([open.status, open.outcome, open.home_entrant_id, open.away_entrant_id]).toEqual(["scheduled", null, gf.home_entrant_id, gf.away_entrant_id]);
    // (3) The resolver (X-WD-4's departure double walkover): every seat of the grand final dies through departure.
    const four = await seedBracket({ ...badminton, ...reset, entrants: 4 });
    const rows = await rowsOf(four.stageId);
    const first = Math.min(...rows.map((r) => r.round_no));
    const wbR1 = rows.filter((r) => r.round_no === first && r.home_entrant_id && r.away_entrant_id);
    expect(wbR1, "rig: two seated winners' first-round lines").toHaveLength(2);
    for (const m of wbR1) await playBadminton(four.auth, m.id, true);
    const wbFinal = await playBadminton(four.auth, wbR1[0]!.winner_to_fixture!, true);
    const lbR1 = await fixtureRow(wbR1[0]!.loser_to_fixture!);
    const lbFinal = await fixtureRow(lbR1.winner_to_fixture!);
    const grand = await fixtureRow(wbFinal.winner_to_fixture!);
    expect([wbFinal.loser_to_fixture, lbFinal.winner_to_fixture, grand.winner_to_fixture === grand.loser_to_fixture], "rig: the feed graph").toEqual([
      lbFinal.id,
      grand.id,
      true,
    ]);
    await withdrawEntrantCascade(four.auth, wbFinal.home_entrant_id!); // the winners' champion: her grand-final seat stamped
    await withdrawEntrantCascade(four.auth, wbFinal.away_entrant_id!); // dropped to the losers' final: that seat stamped
    await sql`update entrants set status = 'disqualified' where id = ${lbR1.home_entrant_id}`;
    await withdrawEntrantCascade(four.auth, lbR1.away_entrant_id!); // the losers' first round: both sides gone
    const lbF = await fixtureRow(lbFinal.id);
    expect([lbF.status, lbF.outcome], "positive pair: the losers' final feeds the grand final — a double walkover").toEqual(["forfeited", { kind: "double_walkover" }]);
    const g = await fixtureRow(grand.id);
    expect([g.status, g.outcome, g.home_entrant_id, g.away_entrant_id], "the grand final stays open (W4's vacant title)").toEqual(["scheduled", null, null, null]);
    const r2 = await fixtureRow(grand.winner_to_fixture!);
    expect([r2.status, r2.outcome], "the reset is untouched").toEqual(["scheduled", null]);
    expect((await completeStage(four.auth, four.stageId)).completed, "nobody holds the title: not finished").toBe(false);
  }, 120_000);

  it("writeDepartedSeat: a write that finds no row the cascade judged throws (never a silent no-op), in both modes, and writes nothing", async () => {
    // single-sport: badminton; the guard is on the row shape, not the sport.
    const s = await seedBracket({ ...badminton, stageKind: "knockout", entrants: 4 });
    const [sf] = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id);
    const before = await rowsOf(s.stageId);
    const stranger = randomUUID();
    let checked = 0;
    for (const mode of ["tbd", "double_walkover"] as const) {
      await expect(withTenant(s.auth.orgId, (tx) => writeDepartedSeat(tx, sf!.id, stranger, mode))).rejects.toThrow(
        new RegExp(`^writeDepartedSeat: fixture ${sf!.id} is no longer the undecided line entrant ${stranger} was judged on \\(${mode}\\)$`),
      );
      checked++;
    }
    expect(checked).toBe(2);
    // "tbd" also refuses a SEATED entrant whose opponent is seated (it is a walkover, not a dead seat).
    await expect(withTenant(s.auth.orgId, (tx) => writeDepartedSeat(tx, sf!.id, sf!.home_entrant_id!, "tbd"))).rejects.toThrow(/no longer the undecided line/);
    expect(await rowsOf(s.stageId)).toEqual(before);
  });

  it("X-WD-5: a settle never seats a departed loser (every DEPARTED_STATUSES member) on a loser edge (page_playoff q2, third place, double elimination)", async () => {
    // single-sport: football, the held-line rig. After X-WD-1 a held line is walked over at withdrawal, so no settle
    // follows on a new row: the witness is a LEGACY row (PF-8a) — a W2a withdrawal left the held line alone (ruling
    // C17), so the entrant is withdrawn and the line still held. The organiser settles it for the remaining side.
    const SHAPES = [
      { label: "page_playoff q2", stageKind: "page_playoff" as const, stageConfig: {} },
      { label: "knockout third place", stageKind: "knockout" as const, stageConfig: { thirdPlace: true } },
      { label: "double elimination", stageKind: "double_elim" as const, stageConfig: {} },
    ];
    // Review M-2: the server's ONE departed vocabulary (withdrawn, disqualified), never a restated 'withdrawn'; null is
    // the positive pair (nobody departed).
    const DEPARTURES: (string | null)[] = [...DEPARTED_STATUSES, null];
    expect(DEPARTURES.length, "the departed vocabulary is not empty").toBeGreaterThan(2);
    let checked = 0;
    for (const shape of SHAPES) {
      for (const departed of DEPARTURES) {
        const withdrawn = departed !== null;
        const label = `${shape.label} ${departed ?? "(positive pair: nobody departed)"}`;
        const s = await seedBracket({ ...football, stageKind: shape.stageKind, entrants: 4, stageConfig: shape.stageConfig });
        const rows = await rowsOf(s.stageId);
        const line = rows.find((r) => r.home_entrant_id && r.away_entrant_id && r.loser_to_fixture !== null);
        if (!line) throw new Error(`${label}: no seated line with a loser edge`);
        // The other side of the loser-edge target: its feeder is played to a real result first, so that seat holds
        // somebody when the settle runs.
        const otherSlot = line.loser_to_slot === 1 ? 2 : 1;
        const feeder = rows.find(
          (r) =>
            r.id !== line.id &&
            ((r.winner_to_fixture === line.loser_to_fixture && r.winner_to_slot === otherSlot) ||
              (r.loser_to_fixture === line.loser_to_fixture && r.loser_to_slot === otherSlot)),
        );
        if (!feeder) throw new Error(`${label}: the loser-edge target has no feeder on its other side`);
        await post(s.auth, feeder.id, "core.start");
        await post(s.auth, feeder.id, "football.goal", { by: feeder.home_entrant_id });
        await post(s.auth, feeder.id, "football.period", { phase: "HT" });
        await post(s.auth, feeder.id, "football.period", { phase: "FT" });
        const fed = await fixtureRow(line.loser_to_fixture!);
        const opponent = seatOf(fed, otherSlot);
        expect(opponent, `${label}: rig — the other side is seated`).not.toBeNull();
        await heldFootball(s.auth, line.id);
        if (departed !== null) await sql`update entrants set status = ${departed} where id = ${line.away_entrant_id}`;
        await post(s.auth, line.id, "core.settle", { winner: line.home_entrant_id, method: SETTLE_BY_ORGANISER });
        const after = await fixtureRow(line.loser_to_fixture!);
        if (withdrawn) {
          expect(seatOf(after, line.loser_to_slot), `${label}: the withdrawn loser is not seated`).toBeNull();
          expect([after.status, after.outcome], `${label}: the seat is dead, its opponent walks over`).toEqual([
            "forfeited",
            seatWalkover(opponent!),
          ]);
        } else {
          expect(seatOf(after, line.loser_to_slot), label).toBe(line.away_entrant_id);
          expect([after.status, after.outcome], label).toEqual(["scheduled", null]);
        }
        checked++;
      }
    }
    expect(checked).toBe(SHAPES.length * DEPARTURES.length);
  }, 180_000);

  it("D-G2 corner 1: withdrawal from an abandoned, unsettled bracket fixture voids the abandon and walks over with retirement credit", async () => {
    // single-sport: badminton, whose abandon folds to outcome null (held: an active abandon, NEW-H1).
    const s = await seedBracket({ ...badminton, stageKind: "knockout", entrants: 4 });
    const [sf1Id, sf2Id] = s.fixtureIds;
    const sf1 = await fixtureRow(sf1Id!);
    await post(s.auth, sf1.id, "core.start");
    await post(s.auth, sf1.id, "badminton.game.summary", { home: 21, away: 10 });
    await post(s.auth, sf1.id, "core.abandon", { reason: "rain" });
    expect([(await fixtureRow(sf1.id)).status, (await fixtureRow(sf1.id)).outcome], "rig: held by the abandon").toEqual(["abandoned", null]);
    const [abandon] = active(await ledgerOf(sf1.id)).filter((e) => e.type === "core.abandon");

    const out = await withdrawEntrantCascade(s.auth, sf1.home_entrant_id!);
    expect(out).toMatchObject({ walkovers: 1, voided: 0, walked_over_held: 1 });
    const evs = await ledgerOf(sf1.id);
    expect(evs.some((e) => e.type === "core.void" && e.voids_event_id === abandon!.id), "the abandon is voided first").toBe(true);
    // The pre-abandon score stands: the game is still in the ledger, and the forfeit follows it.
    expect(active(evs).map((e) => e.type)).toEqual(["core.start", "badminton.game.summary", "core.forfeit"]);
    const after = await fixtureRow(sf1.id);
    expect([after.status, after.outcome]).toEqual(["forfeited", withdrewAward(sf1.away_entrant_id!, sf1.home_entrant_id!)]);

    // Spec §5.4 corner 1: when the line's other entrant withdraws in turn, her own NEXT fixture walks over — the fed
    // opponent advances, and no settle is ever asked to name a withdrawn entrant (C17 intact).
    await withdrawEntrantCascade(s.auth, sf1.away_entrant_id!);
    const final = await fixtureRow(sf1.winner_to_fixture!);
    expect([seatOf(final, sf1.winner_to_slot), labelOf(final, sf1.winner_to_slot)], "her final seat is dead").toEqual([null, BYE_KEY]);
    const sf2 = await playBadminton(s.auth, sf2Id!, true);
    // Owner ruling 116: she won SF1 (by walkover) and then withdrew, so the final's walkover names her.
    expect((await fixtureRow(final.id)).outcome).toEqual(withdrewAward(sf2.home_entrant_id!, sf1.away_entrant_id!));
    expect((await completeStage(s.auth, s.stageId)).completed).toBe(true);
  });

  it("BG-WO-2 / CD-T13: a chess knockout withdrawal on an unstarted board walks over", async () => {
    const s = await seedBracket({ ...chess, stageKind: "knockout", entrants: 4 });
    const board = await fixtureRow(s.fixtureIds[0]!);
    const out = await withdrawEntrantCascade(s.auth, board.home_entrant_id!);
    expect(out).toMatchObject({ walkovers: 1, walked_over_held: 0 });
    const after = await fixtureRow(board.id);
    expect([after.status, after.outcome]).toEqual(["forfeited", withdrewAward(board.away_entrant_id!, board.home_entrant_id!)]);
    // A walkover before the game: no start is posted for it (R5: withdrew is legal in every phase but "over").
    expect(await activeTypes(board.id)).toEqual(["core.forfeit"]);
  });

  it("BG-WO-3: a chess withdrawal while the tie-break is pending walks over; the classical draw stays in stats", async () => {
    const s = await seedBracket({ ...chess, stageKind: "knockout", entrants: 4 });
    const board = await fixtureRow(s.fixtureIds[0]!);
    await post(s.auth, board.id, "core.start");
    await post(s.auth, board.id, "boardgame.result", { winner: null, method: "agreement" });
    expect((await fixtureRow(board.id)).status, "rig: drawn into the tie-break (in_play, no outcome)").toBe("in_play");
    const out = await withdrawEntrantCascade(s.auth, board.away_entrant_id!);
    expect(out).toMatchObject({ walkovers: 1, walked_over_held: 1 });
    const after = await fixtureRow(board.id);
    expect([after.status, after.outcome]).toEqual(["forfeited", withdrewAward(board.home_entrant_id!, board.away_entrant_id!)]);
    // The classical game stands (ruling D-C6): the drawn result stays an active event, which the stats fold reads.
    const act = active(await ledgerOf(board.id));
    expect(act.map((e) => e.type)).toEqual(["core.start", "boardgame.result", "core.forfeit"]);
    expect(act[1]!.payload).toMatchObject({ winner: null, method: "agreement" });
    expect(seatOf(await fixtureRow(board.winner_to_fixture!), board.winner_to_slot)).toBe(board.home_entrant_id);
  });

  it("D5: a league expunge (under 50%) stays void in the table for every sport, cricket included", async () => {
    // Every sport × its first declared variant, plus every declared variant of a sport whose abandon gives a RESULT
    // in a table (cricket's no-result and Test draw) and every cfg with an award policy (a level award abandon is a
    // draw, FB-AB-1): each would credit the table without the expunge flag (PF-4).
    const cases: { sport: string; variant: string; divisionConfig?: Record<string, unknown>; label: string }[] = [];
    for (const m of builtinModules) {
      const variants = m.key === "cricket" ? Object.keys(m.variants) : [Object.keys(m.variants)[0]!];
      for (const v of variants) {
        cases.push({ sport: m.key, variant: v, label: `${m.key}/${v}` });
        const cfg = m.configSchema.parse(m.variants[v]) as Record<string, unknown>;
        if (cfg.abandonPolicy !== undefined) {
          cases.push({
            sport: m.key,
            variant: v,
            divisionConfig: { ...(m.variants[v] as Record<string, unknown>), abandonPolicy: "award" },
            label: `${m.key}/${v} (award policy)`,
          });
        }
      }
    }
    expect(cases.some((c) => c.sport === "cricket"), "cricket is in the sweep").toBe(true);
    expect(cases.some((c) => c.label.endsWith("(award policy)")), "an award policy is in the sweep").toBe(true);
    let checked = 0;
    for (const c of cases) {
      const s = await seedBracket({
        sport: c.sport,
        variant: declaredVariant(c.sport, c.variant),
        stageKind: "league",
        entrants: 3,
        ...(c.divisionConfig ? { divisionConfig: c.divisionConfig } : {}),
      });
      const leaver = await entrantBySeed(s.divisionId, 3);
      const out = await withdrawEntrantCascade(s.auth, leaver);
      expect([out.policy, out.voided], c.label).toEqual(["expunge", 2]);
      const theirs = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id === leaver || r.away_entrant_id === leaver);
      expect(theirs.length, c.label).toBe(2);
      for (const f of theirs) {
        expect([f.status, f.outcome], c.label).toEqual(["abandoned", null]);
        expect(active(await ledgerOf(f.id)).map((e) => [e.type, e.payload]), c.label).toEqual([
          ["core.abandon", { reason: "withdrew", expunge: true }],
        ]);
      }
      const rows = (await getStandings(s.auth, s.stageId)).rows as { played: number; points: number }[];
      expect(rows.length, c.label).toBeGreaterThan(0);
      expect(rows.filter((r) => r.played !== 0 || r.points !== 0), `${c.label}: zero table delta`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(checked).toBeGreaterThan(builtinModules.length - 1);
  }, 300_000);

  it("D5 / PF-4: a PLAYED game's expunge carries the flag too — its result is voided, then abandoned out of the table", async () => {
    // single-sport: badminton; the second abandon writer (`voidAndAbandon`) is sport-blind.
    const s = await seedBracket({ ...badminton, stageKind: "league", entrants: 4 });
    const leaver = await entrantBySeed(s.divisionId, 4);
    const played = (await rowsOf(s.stageId)).find((r) => r.home_entrant_id === leaver || r.away_entrant_id === leaver)!;
    await playBadminton(s.auth, played.id, true);
    const out = await withdrawEntrantCascade(s.auth, leaver);
    expect([out.policy, out.voided], "1 of 3 played: under half, expunged").toEqual(["expunge", 3]);
    const after = await fixtureRow(played.id);
    expect([after.status, after.outcome]).toEqual(["abandoned", null]);
    expect(active(await ledgerOf(played.id)).map((e) => [e.type, e.payload])).toEqual([
      ["core.start", {}],
      ["core.abandon", { reason: "withdrew", expunge: true }],
    ]);
    const rows = (await getStandings(s.auth, s.stageId)).rows as { played: number; points: number }[];
    expect(rows.filter((r) => r.played !== 0 || r.points !== 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D-G3 corner 3 (spec §5.4): a stepladder qualifier departs BEFORE the draw.
// ---------------------------------------------------------------------------

async function qualifiedStepladder() {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "D-G3 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
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
    Array.from({ length: 4 }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, [{ seq: 1, kind: "stepladder" as never, name: "Finals", config: {} }]);
  const qualified = entrants.map((e) => e.id);
  await sql`update stages set config = ${sql.json({ qualified } as never)} where id = ${stage!.id}`;
  const [e1] = qualified;
  await withdrawEntrantCascade(auth, e1!); // before the draw: a plain status flip
  await generateStageFixtures(auth, stage!.id);
  await sql`update divisions set status = 'active' where id = ${division.id}`;
  await sql`update stages set status = 'active' where id = ${stage!.id}`;
  return { auth, divisionId: division.id, stageId: stage!.id, bySeed: qualified };
}

/** Each rung for HOME, by play (generic.result 2-0): E3 beats E4, then E2 beats E3 and climbs into the final. */
async function playRungs(auth: AuthCtx, stageId: string): Promise<number> {
  let rungs = 0;
  for (let i = 0; i < 4; i++) {
    const rung = (await rowsOf(stageId)).find((x) => x.status === "scheduled" && x.home_entrant_id && x.away_entrant_id && x.winner_to_fixture !== null);
    if (!rung) break;
    await post(auth, rung.id, "core.start");
    await post(auth, rung.id, "generic.result", { p1Score: 2, p2Score: 0 });
    rungs++;
  }
  return rungs;
}

const DICTS: Record<string, Record<string, string>> = { en: enDict, es: esDict, fr: frDict, nl: nlDict };
const msgFor = (locale: string): MsgFn => (k, vars) => {
  const raw = DICTS[locale]![k as string];
  if (raw === undefined) throw new Error(`${locale}: no copy for ${k as string}`);
  return Object.entries(vars ?? {}).reduce((s, [n, v]) => s.replaceAll(`{${n}}`, String(v)), raw);
};

describe.skipIf(!HAS_DB)("D-G3 corner 3: a stepladder qualifier departed before the draw", () => {
  it("D-G3 corner 3: a stepladder qualifier departed before the draw — the rung opponent walks over with no organiser step", async () => {
    // single-sport: generic, W2a's probe-P2 rig (the D-G1 guard's one product path before W2b).
    const r = await qualifiedStepladder();
    const [e1, e2, e3, e4] = r.bySeed;
    const final = (await rowsOf(r.stageId)).find((x) => x.winner_to_fixture === null)!;
    const departedSlot = labelOf(final, 1) === BYE_KEY ? 1 : 2;
    expect(
      { seated: [final.home_entrant_id, final.away_entrant_id], dead: labelOf(final, departedSlot), status: final.status },
      "the departed seed's seat is dead (X-WD-3), the line waits for the climber — never voided",
    ).toEqual({ seated: [null, null], dead: BYE_KEY, status: "scheduled" });
    expect(await playRungs(r.auth, r.stageId), "both rungs played").toBe(2);
    const after = await fixtureRow(final.id);
    expect([after.status, after.outcome], "the climber walks over the departed seed's seat").toEqual(["forfeited", seatWalkover(e2!)]);
    expect(await activeTypes(final.id), "no organiser step").toEqual([]);
    // Where the departed seed ranks — absent (she holds no seat) or last — is not ruled; never above a field entrant.
    const done = await completeStage(r.auth, r.stageId);
    const ev = done.events.find((e) => e.type === "stage_completed");
    const ranks = ev?.type === "stage_completed" ? ev.finalRanks : [];
    expect([done.completed, ranks.filter((id) => id !== e1)]).toEqual([true, [e2, e3, e4]]);
    expect([-1, 3], "the departed seed is unranked or last").toContain(ranks.indexOf(e1!));
  });

  it("D-G3 corner 3: a seat that cannot resolve is refused STAGE_SEAT_DEPARTED naming the entrant and the fixture", async () => {
    // A FORCED row (the positive pair is the walk-over above): the shape the generator wrote before W2b — the
    // departed seed seated in a void final — so the climber is seated into the void row and the line can never
    // resolve. Completion names her and the match instead of CONFIG_INVALID's generic copy.
    const r = await qualifiedStepladder();
    const [e1] = r.bySeed;
    const final = (await rowsOf(r.stageId)).find((x) => x.winner_to_fixture === null)!;
    const departedSlot = labelOf(final, 1) === BYE_KEY ? 1 : 2;
    await (departedSlot === 1
      ? sql`update fixtures set status = 'abandoned', home_entrant_id = ${e1!}, home_slot_label = null where id = ${final.id}`
      : sql`update fixtures set status = 'abandoned', away_entrant_id = ${e1!}, away_slot_label = null where id = ${final.id}`);
    await playRungs(r.auth, r.stageId);
    const err = await completeStage(r.auth, r.stageId).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({
      code: "STAGE_SEAT_DEPARTED",
      data: { reason: "seat_departed", entrantId: e1, fixtureId: final.id, entrant: "E1" },
    });
    // D11: the copy names both — the entrant by name and the match by the board's own label — in every locale, and
    // shows no id. Through the real v1 envelope, the way the console reads a refusal.
    const res = await v1(async () => {
      throw err;
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: Record<string, unknown> & { code: string; message: string } };
    expect(body.error).toMatchObject({ code: "STAGE_SEAT_DEPARTED", reason: "seat_departed", entrant: "E1" });
    const ref = nextMatchRefOf({ next_match: body.error.match });
    expect(ref?.fixture_id, "the match ref crosses the wire").toBe(final.id);
    let checked = 0;
    for (const locale of Object.keys(DICTS)) {
      const m = msgFor(locale);
      const text = scoringErrorText(body.error.code, body.error.message, m, "score.failed", body.error);
      expect(text, locale).toContain("E1");
      expect(text, locale).toContain(nextMatchLabel(ref!, m));
      expect(text, locale).not.toContain(e1!);
      expect(text, locale).not.toContain(final.id);
      expect(text, `${locale}: not the code's generic copy`).not.toBe(m("engineError.STAGE_SEAT_DEPARTED" as never));
      checked++;
    }
    expect(checked).toBe(4);
    // The organiser presses Complete on the stages panel: apiV1 → ApiV1Error → classifyActError — amber, named.
    vi.stubGlobal("fetch", async () =>
      v1(async () => {
        throw err;
      }),
    );
    try {
      const caught = await apiV1(`/api/v1/stages/${r.stageId}/complete`, { method: "POST", json: {} }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(caught).toBeInstanceOf(ApiV1Error);
      const en = msgFor("en");
      const shown = classifyActError(caught, en as never, "en");
      expect(shown).toEqual({
        tone: "warning",
        text: scoringErrorText("STAGE_SEAT_DEPARTED", "", en, "score.failed", { reason: "seat_departed", entrant: "E1", match: body.error.match }),
        refresh: false,
      });
      expect(shown.text).toContain("E1");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// Rule 10 (TEST-STRATEGY): withdrawals interleaved with play, in any order. Two rigs — a chess knockout of 8 (a drawn
// board opens its tie-break, R14) and a badminton page_playoff of 4 — and a drawn sequence of the console's own
// actions. After EVERY step: no withdrawn entrant is seated on an undecided fixture (except both finalists of a final,
// X-WD-4's W4 handover, and her OWN line once the organiser voids its result after she left — loop-F I-1, which the
// alphabet now draws: a void may land on any line, one holding a departed entrant included); no system bye award ever
// has both seats filled (I-1's stale-walkover shape); every forfeit in the stage is a cascade's, reason "withdrew"; the
// cascade never throws; and
// completion, asked at the end, never throws either.
// ---------------------------------------------------------------------------

type Rig10 = "ko8-chess" | "pp4-badminton";
type Act =
  | { t: "withdraw"; i: number }
  | { t: "start"; k: number }
  | { t: "score"; k: number }
  | { t: "draw"; k: number }
  | { t: "abandon"; k: number }
  | { t: "walkover"; k: number }
  | { t: "voidLast"; k: number };

const RIG10: Record<Rig10, { sport: string; variant: string; stageKind: "knockout" | "page_playoff"; entrants: number }> = {
  "ko8-chess": { ...chess, stageKind: "knockout", entrants: 8 },
  "pp4-badminton": { ...badminton, stageKind: "page_playoff", entrants: 4 },
};
const MAX_ACTS = 9;
const act: fc.Arbitrary<Act> = fc.oneof(
  fc.record({ t: fc.constant("withdraw" as const), i: fc.nat(7) }),
  fc.record({ t: fc.constant("start" as const), k: fc.nat(3) }),
  fc.record({ t: fc.constant("score" as const), k: fc.nat(3) }),
  fc.record({ t: fc.constant("draw" as const), k: fc.nat(3) }),
  fc.record({ t: fc.constant("abandon" as const), k: fc.nat(3) }),
  // Loop-F tidy 2: a walkover the ORGANISER records (an award, its loser edge dead — X-DE-1), so a voidLast can take one
  // back and the sequence reaches the dead loser edge's release.
  fc.record({ t: fc.constant("walkover" as const), k: fc.nat(3) }),
  fc.record({ t: fc.constant("voidLast" as const), k: fc.nat(3) }),
);
const run10 = fc.record({ rig: fc.constantFrom<Rig10>("ko8-chess", "pp4-badminton"), acts: fc.array(act, { minLength: 1, maxLength: MAX_ACTS }) });
/** The hand examples, run first: each names the state its withdrawal meets (seed 1 sits on the first line). */
const EXAMPLES10: [{ rig: Rig10; acts: Act[] }][] = [
  [{ rig: "ko8-chess", acts: [{ t: "withdraw", i: 0 }] }], // before the board starts
  [{ rig: "ko8-chess", acts: [{ t: "start", k: 0 }, { t: "withdraw", i: 0 }] }], // after it starts
  [{ rig: "ko8-chess", acts: [{ t: "draw", k: 0 }, { t: "withdraw", i: 0 }] }], // during the tie-break (R14)
  [{ rig: "ko8-chess", acts: [{ t: "abandon", k: 0 }, { t: "withdraw", i: 0 }] }], // void the abandon, then forfeit
  [{ rig: "ko8-chess", acts: [{ t: "withdraw", i: 0 }, { t: "withdraw", i: 7 }, { t: "score", k: 0 }] }], // both sides in turn
  [{ rig: "pp4-badminton", acts: [{ t: "score", k: 0 }, { t: "withdraw", i: 1 }, { t: "withdraw", i: 2 }] }],
  // I-1: seed 1 wins the first line, withdraws (her semi seat stamped), the organiser voids that win, and she wins it
  // again — she is never re-seated.
  [{ rig: "ko8-chess", acts: [{ t: "score", k: 0 }, { t: "withdraw", i: 0 }, { t: "voidLast", k: 0 }, { t: "score", k: 0 }] }],
  // Loop-F tidy 2: the eliminator is played (its winner seated in q2), q1 is walked over (q2 walks the eliminator's
  // winner over q1's dead loser edge), the walkover is taken back, and q1 is played — its loser must meet a live q2,
  // never the bye award q2 was (the stale-bye invariant below).
  [{ rig: "pp4-badminton", acts: [{ t: "score", k: 1 }, { t: "walkover", k: 0 }, { t: "voidLast", k: 0 }, { t: "score", k: 0 }] }],
];
/** Review M-5: fast-check 3.x runs the `examples` INSIDE `numRuns` (3.23.2: examples first, then random draws up to
 *  the total), so the random draws are `numRuns − examples` — the total here is the random count PLUS the examples,
 *  and `runs` below pins it (a fast-check that ran examples on top would count more). */
const RANDOM_RUNS10 = 12;
const NUM_RUNS10 = RANDOM_RUNS10 + EXAMPLES10.length;
/** AGENTS.md #20: the budget is the work's worst case — every run at the action cap — at ~3× the ~0.4 s a seeded rig
 *  and a step (an action, its cascade and the invariant reads) measured. */
const SEED_MS10 = 1_500;
const STEP_MS10 = 1_200;
const BUDGET_MS10 = NUM_RUNS10 * (SEED_MS10 + MAX_ACTS * STEP_MS10);

const PLAYED10 = new Set(["decided", "forfeited", "finalized"]);
const boardgameModule = builtinModules.find((m) => m.key === "boardgame")!;
async function tiebreakPending(fixtureId: string): Promise<boolean> {
  const [m] = await sql<{ state: unknown }[]>`select state from match_states where fixture_id = ${fixtureId}`;
  return deciderPending(boardgameModule as never, { state: (m?.state ?? null) as never, settlement: null });
}
const hasActiveAbandon = async (fixtureId: string) => active(await ledgerOf(fixtureId)).some((e) => e.type === "core.abandon");

/** Expected refusals of a drawn void (a started next match, a phase the event cannot be voided in, …): a typed 4xx. */
function isRefusal(e: unknown): boolean {
  const x = e as { status?: number; code?: string };
  return (typeof x?.status === "number" && x.status >= 400 && x.status < 500) || (typeof x?.code === "string" && x.code.length > 0);
}

describe.skipIf(!HAS_DB)("rule 10: withdrawals in any order", () => {
  it("rule 10: no drawn sequence of withdraw / start / score / draw / abandon / walkover / void seats a withdrawn entrant, seats anyone in a settled bye or a void, writes a forfeit nobody recorded, or throws", async () => {
    const cover = { steps: 0, applied: 0, preStart: 0, postStart: 0, tiebreak: 0, voidThenForfeit: 0, bothSides: 0, refusedVoids: 0, voidAfterDeparture: 0, walkovers: 0, voidedWalkovers: 0 };
    let runs = 0;
    await fc.assert(
      fc.asyncProperty(run10, async ({ rig, acts }) => {
        const shapeOf = RIG10[rig];
        const s = await seedBracket(shapeOf);
        const seeds = await sql<{ id: string; seed: number }[]>`select id, seed from entrants where division_id = ${s.divisionId} order by seed`;
        const firstLines = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id).map((r) => [r.home_entrant_id!, r.away_entrant_id!]);
        const isChess = shapeOf.sport === "boardgame";
        /** Lines the organiser re-opened by voiding their result AFTER an entrant on them departed (I-1). */
        const reopened = new Set<string>();
        /** The walkovers this run's organiser recorded (each a `core.forfeit{reason:"walkover"}`, voided or not). */
        let recordedWalkovers = 0;
        const withdrawnSet = async () =>
          new Set((await sql<{ id: string }[]>`select id from entrants where division_id = ${s.divisionId} and status = 'withdrawn'`).map((r) => r.id));
        const open = async () => {
          const gone = await withdrawnSet();
          return (await rowsOf(s.stageId)).filter(
            (r) =>
              (r.status === "scheduled" || r.status === "in_play") &&
              r.home_entrant_id !== null &&
              r.away_entrant_id !== null &&
              (reopened.has(r.id) || (!gone.has(r.home_entrant_id) && !gone.has(r.away_entrant_id))),
          );
        };
        const startIfNeeded = async (f: FixtureRow) => {
          if (f.status === "scheduled") await post(s.auth, f.id, "core.start");
        };
        for (const [n, a] of acts.entries()) {
          const where = `${rig} step ${n} ${JSON.stringify(a)} of ${JSON.stringify(acts)}`;
          let applied = true;
          if (a.t === "withdraw") {
            const target = seeds[a.i % seeds.length]!;
            if ((await withdrawnSet()).has(target.id)) applied = false;
            else {
              const mine = (await rowsOf(s.stageId)).filter(
                (r) => (r.home_entrant_id === target.id || r.away_entrant_id === target.id) && !PLAYED10.has(r.status),
              );
              for (const f of mine) {
                if (f.status === "scheduled") cover.preStart++;
                else if (f.status === "in_play") {
                  if (isChess && (await tiebreakPending(f.id))) cover.tiebreak++;
                  else cover.postStart++;
                }
              }
              const abandonedBefore = new Set<string>();
              for (const f of mine) if (f.status === "abandoned" && (await hasActiveAbandon(f.id))) abandonedBefore.add(f.id);
              // The cascade never throws, for any sequence.
              await expect(withdrawEntrantCascade(s.auth, target.id), where).resolves.toMatchObject({ status: "withdrawn" });
              for (const id of abandonedBefore) {
                const evs = await ledgerOf(id);
                const acts2 = active(evs).map((e) => e.type);
                if (evs.some((e) => e.type === "core.void") && acts2.at(-1) === "core.forfeit" && !acts2.includes("core.abandon")) cover.voidThenForfeit++;
              }
            }
          } else if (a.t === "voidLast") {
            // Any line with a live event — one holding a departed entrant too (loop-F I-1: a void after her departure).
            const gone = await withdrawnSet();
            const candidates: { f: FixtureRow; last: Ev }[] = [];
            for (const f of await rowsOf(s.stageId)) {
              const last = active(await ledgerOf(f.id)).at(-1);
              if (last) candidates.push({ f, last });
            }
            const pick = candidates[a.k % Math.max(1, candidates.length)];
            if (!pick) applied = false;
            else {
              const err = await post(s.auth, pick.f.id, "core.void", { event_id: pick.last.id }).then(
                () => null,
                (e: unknown) => e,
              );
              if (err === null && pick.last.type === "core.forfeit" && pick.last.payload.reason === "walkover") cover.voidedWalkovers++;
              if (err !== null) {
                expect(isRefusal(err), `${where}: a void is refused, never a 500 (${String(err)})`).toBe(true);
                cover.refusedVoids++;
              } else if ([pick.f.home_entrant_id, pick.f.away_entrant_id].some((x) => x !== null && gone.has(x))) {
                const now = await fixtureRow(pick.f.id);
                if (!PLAYED10.has(now.status)) reopened.add(now.id);
                cover.voidAfterDeparture++;
              }
            }
          } else {
            const list = await open();
            const f = list[a.k % Math.max(1, list.length)];
            if (!f || (a.t === "draw" && !isChess)) applied = false;
            else if (a.t === "start") {
              if (f.status === "scheduled") await post(s.auth, f.id, "core.start");
              else applied = false;
            } else if (a.t === "abandon") {
              await startIfNeeded(f);
              await post(s.auth, f.id, "core.abandon", { reason: "rain" });
            } else if (a.t === "walkover") {
              // Before the start only: the engine's walkover phases (R2, default "pre").
              if (f.status !== "scheduled") applied = false;
              else {
                await post(s.auth, f.id, "core.forfeit", { by: f.away_entrant_id, reason: "walkover" });
                recordedWalkovers++;
                cover.walkovers++;
              }
            } else if (a.t === "draw") {
              if (f.status === "in_play" && (await tiebreakPending(f.id))) applied = false;
              else {
                await startIfNeeded(f);
                await post(s.auth, f.id, "boardgame.result", { winner: null, method: "agreement" });
              }
            } else {
              // score: the home side wins.
              await startIfNeeded(f);
              if (isChess) {
                // A drawn Armageddon is Black's (BG-KO-2): naming the home side as Black advances it.
                await ((await tiebreakPending(f.id))
                  ? post(s.auth, f.id, "boardgame.tiebreak", { rung: "armageddon", black: f.home_entrant_id, result: "draw" })
                  : post(s.auth, f.id, "boardgame.result", { winner: f.home_entrant_id, method: "resign" }));
              } else {
                for (let g = 0; g < 3 && (await fixtureRow(f.id)).status === "in_play"; g++) {
                  await post(s.auth, f.id, "badminton.game.summary", { home: 21, away: 10 });
                }
              }
            }
          }
          if (applied) cover.applied++;
          cover.steps++;

          // ---- the invariants, after every step ----
          const gone = await withdrawnSet();
          const rows = await rowsOf(s.stageId);
          const offenders = rows.flatMap((r) => {
            const seated = [r.home_entrant_id, r.away_entrant_id].filter((x): x is string => x !== null && gone.has(x));
            if (seated.length === 0 || PLAYED10.has(r.status) || reopened.has(r.id)) return [];
            const isFinal = r.winner_to_fixture === null && r.loser_to_fixture === null;
            if (isFinal && seated.length === 2) return []; // X-WD-4: both finalists departed — W4's vacant title
            return [`${r.ext_key ?? r.id} ${r.status} seats ${seated.length} withdrawn`];
          });
          expect(offenders, `${where}: a withdrawn entrant seated on an undecided fixture`).toEqual([]);
          // I-1's stale shape: a system bye award (a walkover over a dead seat) with both seats filled.
          const staleByes = rows.filter((r) => r.outcome?.kind === "award" && r.outcome.reason === "bye" && r.home_entrant_id !== null && r.away_entrant_id !== null);
          expect(staleByes.map((r) => r.ext_key ?? r.id), `${where}: a bye walkover with both seats filled`).toEqual([]);
          // Loop-F tidy 2's other stale shape: somebody seated in a line the cascade VOIDED (abandoned, nothing on it).
          const seatedVoids: string[] = [];
          for (const r of rows) {
            if (r.status === "abandoned" && (r.home_entrant_id !== null || r.away_entrant_id !== null) && (await liveEvents(r.id)) === 0) seatedVoids.push(r.ext_key ?? r.id);
          }
          expect(seatedVoids, `${where}: an entrant seated in a cascade void`).toEqual([]);
          const forfeits = await sql<{ reason: string | null }[]>`
            select e.payload->>'reason' as reason from score_events e join fixtures f on f.id = e.fixture_id
             where f.stage_id = ${s.stageId} and e.type = 'core.forfeit'`;
          expect(forfeits.filter((x) => x.reason !== "withdrew" && x.reason !== "walkover"), `${where}: every forfeit is the cascade's or a recorded walkover`).toEqual([]);
          expect(forfeits.filter((x) => x.reason === "walkover").length, `${where}: every walkover is one the sequence recorded`).toBe(recordedWalkovers);
        }
        for (const [h, a2] of firstLines) {
          const gone = await withdrawnSet();
          if (gone.has(h) && gone.has(a2)) cover.bothSides++;
        }
        await expect(completeStage(s.auth, s.stageId), `${rig} ${JSON.stringify(acts)}: completion never throws`).resolves.toBeDefined();
        runs++;
      }),
      { numRuns: NUM_RUNS10, seed: 20261010, examples: EXAMPLES10 },
    );
    expect(runs).toBe(NUM_RUNS10);
    expect(cover.steps, "steps checked").toBeGreaterThan(0);
    expect(cover.applied, "steps that acted").toBeGreaterThan(0);
    // The alphabet reached every state the brief names.
    for (const key of ["preStart", "postStart", "tiebreak", "voidThenForfeit", "bothSides", "voidAfterDeparture", "walkovers", "voidedWalkovers"] as const) {
      expect(cover[key], `coverage: ${key}`).toBeGreaterThan(0);
    }
  }, BUDGET_MS10);
});
