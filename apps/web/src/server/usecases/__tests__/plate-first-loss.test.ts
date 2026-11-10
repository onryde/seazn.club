// W4 app PR B, Task 8 (batch B3b) - the plate is proposed AFTER round two, drawn at the size of its field, and completes for
// every field: X-PL-2 (a field under two completes by name), X-PL-5 (n=5: no proposal after round one, a draft after round two,
// the main final still scheduled), X-PL-7 (auto-progress confirms; a corrected result moves the field; a started plate stands),
// X-SD-11 (the plate's draw order), X-LE-14 (a late entrant is in the plate's field). Through the real usecases on Postgres.
// Expected fields come from the rulebook (RB4-P1/P2: an entrant's FIRST real match loss, a forfeit loser excluded) worked by hand
// over the engine's own draw, never from `firstLossField`.
import { afterAll, describe, expect, it, vi } from "vitest";
import { generateSingleElim } from "@seazn/engine/scheduling";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { knockoutDrawOrder } from "@/server/engine-db/knockout-draw";
import { createEntrants } from "../entrants";
import { completeStage, generateStageFixtures } from "../stages";
import { confirmResolvingTies } from "./_confirm-with-ties";
import { withdrawEntrantCascade } from "../withdrawal";
import { maybeProposePlate } from "../plate-field";
import { computeSeedProposal, getSeedProposal } from "../stages/seed-proposal";
import { entrantInput, linesOf, plateRig, plateSeats, playRound, undecide, win, type PlateRig } from "./_plate-rig";

vi.mock("@/lib/stripe", async (io) => ({
  ...(await io<typeof import("@/lib/stripe")>()),
  getStripe: vi.fn(() => {
    throw new Error("this suite makes no Stripe call");
  }),
}));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn() }));

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** The entrants of `rig` by their P-number (P1 = index 1). */
const P = (rig: PlateRig, ...nums: number[]): string[] => nums.map((k) => rig.entrants[k - 1]!).sort();
const proposalRows = (stageId: string) => sql<{ status: string }[]>`select status from stage_seed_proposals where stage_id = ${stageId} order by created_at, id`;
const stageStatus = async (id: string) => (await sql<{ status: string }[]>`select status from stages where id = ${id}`)[0]!.status;
const fieldOfProposal = async (rig: PlateRig) => (await getSeedProposal(rig.auth, rig.plateId))?.computed.qualifiers.map((q) => q.entrantId).sort() ?? null;

describe.skipIf(!HAS_DB)("X-PL-5: the plate draws after round two (n=5)", () => {
  it("round 1 proposes nothing; round 2 proposes the first losers while the main final is still to play", async () => {
    // n=5 draws a bracket of 8: seeds 1-3 hold byes, so round 1 is ONE match (P4 v P5) and the bye holders open in round 2.
    const rig = await plateRig(5);
    expect(await linesOf(rig.plateId), "day one: the plate has no lines (owner ruling G2)").toHaveLength(0);
    expect(await proposalRows(rig.plateId), "day one: no proposal").toHaveLength(0);

    const r1 = await playRound(rig, 1);
    expect(r1.length, "premise: round 1 of five is one real match").toBe(1);
    expect(await proposalRows(rig.plateId), "after round 1 the bye holders have not played: the field is open, nothing is proposed").toHaveLength(0);
    expect(await linesOf(rig.plateId), "after round 1 the plate still has no lines").toHaveLength(0);
    expect(await stageStatus(rig.plateId), "the plate is pending, not complete").toBe("pending");

    const r2 = await playRound(rig, 2);
    expect(r2.length, "premise: round 2 of five is two matches (P1 v the round-1 winner, P2 v P3)").toBe(2);
    // P5 lost its first match in round 1, P3 in round 2; P4 won round 1 so its round-2 loss is not a first loss (RB4-P1).
    expect(await fieldOfProposal(rig), "the proposal's field is the first losers: P3 and P5").toEqual(P(rig, 3, 5));
    const proposal = await getSeedProposal(rig.auth, rig.plateId);
    expect(proposal?.status, "auto-progress is off: a DRAFT the organiser confirms").toBe("draft");
    const final = (await linesOf(rig.mainId)).filter((l) => l.round_no === 3);
    expect(final.length, "premise: the main draw has its final").toBe(1);
    expect(final[0]!.status, "the proposal came while the main final is still to play").not.toBe("completed");
    expect(final[0]!.outcome, "the final has no result").toBeNull();
    // The plate is drawn at its field: one line, two seats, no seat filled until the draft is confirmed.
    const plate = await linesOf(rig.plateId);
    expect(plate.length, "the plate is drawn at a field of two: one line").toBe(1);
    expect(await plateSeats(rig), "an unconfirmed draft seats nobody").toEqual([]);
  }, 120_000);

  it("a second call changes nothing (idempotent), and Undo-free: the proposal count stays one", async () => {
    const rig = await plateRig(5);
    await playRound(rig, 1);
    await playRound(rig, 2);
    const before = await proposalRows(rig.plateId);
    expect(before, "premise: one draft stands").toEqual([{ status: "draft" }]);
    const out = await maybeProposePlate(rig.auth, rig.mainId);
    expect(out.proposed, "the same field proposes nothing new").toBe(false);
    expect(await proposalRows(rig.plateId), "still one draft").toEqual([{ status: "draft" }]);
    expect(await linesOf(rig.plateId), "and the one plate line").toHaveLength(1);
  }, 120_000);
});

describe.skipIf(!HAS_DB)("X-PL-7: auto-progress, a corrected result, a started plate", () => {
  it("auto-progress ON confirms and seats the plate at once; OFF leaves a draft", async () => {
    const on = await plateRig(5, { autoProgress: true });
    await playRound(on, 1);
    await playRound(on, 2);
    expect((await getSeedProposal(on.auth, on.plateId))?.status, "auto on: confirmed").toBe("confirmed");
    expect(await plateSeats(on), "auto on: the first losers are seated").toEqual(P(on, 3, 5));
    const off = await plateRig(5, { autoProgress: false });
    await playRound(off, 1);
    await playRound(off, 2);
    expect((await getSeedProposal(off.auth, off.plateId))?.status, "auto off: a draft").toBe("draft");
    expect(await plateSeats(off), "auto off: nobody seated").toEqual([]);
  }, 180_000);

  it("a corrected round-2 result moves the field: the old draw goes stale, its seats go back, the new field is proposed", async () => {
    const rig = await plateRig(5, { autoProgress: true });
    await playRound(rig, 1);
    await playRound(rig, 2);
    expect(await plateSeats(rig), "premise: P3 and P5 are seated").toEqual(P(rig, 3, 5));
    // P2 v P3 is the other round-2 line. Take it back and replay it with P3 winning: P2 now holds the first loss.
    const line = (await linesOf(rig.mainId)).find((l) => l.round_no === 2 && [l.home_entrant_id, l.away_entrant_id].includes(rig.entrants[2]!))!;
    await undecide(rig, line.id);
    expect(await plateSeats(rig), "while the line is open the field is open: the plate stands, as the source correction rules").toEqual(P(rig, 3, 5));
    await win(rig, line, rig.entrants[2]!);
    expect(await plateSeats(rig), "after the replay the plate is seated with the NEW field: P2 and P5").toEqual(P(rig, 2, 5));
    const rows = await proposalRows(rig.plateId);
    expect(rows.map((r) => r.status), "the first proposal is stale, the second confirmed").toEqual(["stale", "confirmed"]);
  }, 180_000);

  it("a plate that has started stands as drawn when a result moves the field", async () => {
    const rig = await plateRig(5, { autoProgress: true });
    await playRound(rig, 1);
    await playRound(rig, 2);
    const plateLine = (await linesOf(rig.plateId))[0]!;
    await win(rig, plateLine, rig.entrants[2]!);
    const line = (await linesOf(rig.mainId)).find((l) => l.round_no === 2 && [l.home_entrant_id, l.away_entrant_id].includes(rig.entrants[2]!))!;
    await undecide(rig, line.id);
    await win(rig, line, rig.entrants[2]!);
    expect(await plateSeats(rig), "a started plate keeps its seats").toEqual(P(rig, 3, 5));
    expect((await proposalRows(rig.plateId)).map((r) => r.status), "and its one proposal stays confirmed").toEqual(["confirmed"]);
  }, 180_000);
});

describe.skipIf(!HAS_DB)("X-PL-2: a field under two completes by name", () => {
  const plateEvent = async (rig: PlateRig) =>
    (
      await sql<{ payload: { outcome?: string; losers?: number; finalRanks?: unknown[] } }[]>`
        select payload from division_events where division_id = ${rig.divisionId} and type = 'stage_completed' and payload->>'stageId' = ${rig.plateId}`
    )[0];

  it("n=4, one forfeit: the final is the walkover winner's first real match - the plate completes once it is played, with one loser", async () => {
    const rig = await plateRig(4, { autoProgress: true });
    // Round 1: P1 v P4, P2 v P3. P3 withdraws: P2 takes a walkover (no match played), and a forfeit loser is no first loss (RB4-P2).
    await withdrawEntrantCascade(rig.auth, rig.entrants[2]!);
    await playRound(rig, 1);
    expect(await stageStatus(rig.plateId), "P2 has not played a real match yet: the field is open and the plate waits").toBe("pending");
    expect(await proposalRows(rig.plateId), "nothing proposed while the field is open").toHaveLength(0);
    // P2 wins the final: it never lost a first match, so the only first loser is P4 - one entrant is no bracket.
    await playRound(rig, 2, () => rig.entrants[1]!);
    expect(await stageStatus(rig.plateId), "one first loser (P4) is no bracket: the plate completes").toBe("complete");
    expect(await linesOf(rig.plateId), "with no fixtures").toHaveLength(0);
    expect(await proposalRows(rig.plateId), "and no proposal").toHaveLength(0);
    const ev = await plateEvent(rig);
    expect(ev?.payload.outcome, "the ledger names the outcome").toBe("plate_too_small");
    expect(ev?.payload.losers, "the field it saw").toBe(1);
    expect(ev?.payload.finalRanks, "no ranks").toEqual([]);
    // The division is not stuck behind it: the final's result completes the main draw, and the division with it.
    await completeStage(rig.auth, rig.mainId, { publish: false });
    expect(await stageStatus(rig.mainId), "the main draw is complete").toBe("complete");
    const [division] = await sql<{ status: string }[]>`select status from divisions where id = ${rig.divisionId}`;
    expect(division?.status, "the division completes with a too-small plate behind it").toBe("completed");
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from division_events where division_id = ${rig.divisionId} and type = 'division_completed'`;
    expect(n, "completed once").toBe(1);
  }, 180_000);

  it("n=4, the walkover winner loses the final: that IS a first loss, so the field is two and the plate is a bracket", async () => {
    const rig = await plateRig(4, { autoProgress: true });
    await withdrawEntrantCascade(rig.auth, rig.entrants[2]!);
    await playRound(rig, 1);
    await playRound(rig, 2, () => rig.entrants[0]!);
    expect(await stageStatus(rig.plateId), "two first losers (P4 and P2): not a completion").not.toBe("complete");
    expect(await plateSeats(rig), "the plate seats P2 and P4").toEqual(P(rig, 2, 4));
  }, 180_000);

  it("a field of ZERO: every first match a forfeit - the plate still completes, naming 0", async () => {
    const rig = await plateRig(4, { autoProgress: true });
    await withdrawEntrantCascade(rig.auth, rig.entrants[2]!);
    await withdrawEntrantCascade(rig.auth, rig.entrants[3]!);
    await withdrawEntrantCascade(rig.auth, rig.entrants[1]!);
    expect(await stageStatus(rig.plateId), "three withdrawals: P1 walks over everyone, nobody lost a real match").toBe("complete");
    expect((await plateEvent(rig))?.payload.losers, "field 0").toBe(0);
    expect(await linesOf(rig.plateId), "no fixtures").toHaveLength(0);
  }, 180_000);

  it("a direct propose on a field under two is refused by name, never an empty draw (PLATE_FIELD_TOO_SMALL)", async () => {
    const rig = await plateRig(4, { autoProgress: false });
    await withdrawEntrantCascade(rig.auth, rig.entrants[2]!);
    await playRound(rig, 1);
    await playRound(rig, 2, () => rig.entrants[1]!);
    expect(await stageStatus(rig.plateId), "premise: the field is complete with one loser").toBe("complete");
    const err = await computeSeedProposal(rig.auth, rig.plateId).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, "refused").toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 422, code: "PLATE_FIELD_TOO_SMALL" });
  }, 180_000);

  it("a field of two or more is NOT too small: n=4 with no forfeit seats P3 and P4", async () => {
    const rig = await plateRig(4, { autoProgress: true });
    await playRound(rig, 1);
    expect(await stageStatus(rig.plateId), "two first losers: a bracket, not a completion").not.toBe("complete");
    expect(await plateSeats(rig)).toEqual(P(rig, 3, 4));
  }, 120_000);
});

describe.skipIf(!HAS_DB)("X-LE-14: a late entrant is in the plate's field", () => {
  it("n=7: the late add takes the bye, loses round 1, and is seated in the plate", async () => {
    const rig = await plateRig(7, { autoProgress: true });
    const [late] = await createEntrants(rig.auth, rig.divisionId, [entrantInput(rig.kind, "Late")]);
    expect(late?.id, "premise: the late entrant was added").toBeTruthy();
    rig.seedOf.set(late!.id, null);
    // The late player takes P1's bye line and meets P1 in round 1 (RB4-L3); P1 wins. With no bye left, round 1 decides every first match.
    await playRound(rig, 1);
    expect(await plateSeats(rig), "the plate's field is the round-1 losers, the late entrant among them").toEqual([late!.id, ...P(rig, 5, 6, 7)].sort());
  }, 180_000);
});

describe.skipIf(!HAS_DB)("X-SD-11: the plate's draw order", () => {
  it("seeded entrants first by main seed, the unseeded after in the plate's own draw order - not their main-draw position", async () => {
    // Eight entrants, none seeded: the main draw shuffles all of them; the home side wins every round-1 line, so the plate's field
    // is the four AWAY seats - four unseeded entrants whose plate order is the plate's own draw.
    let attempts = 0;
    for (;;) {
      attempts++;
      const rig = await plateRig(8, { seeded: 0, autoProgress: true });
      const main = (await linesOf(rig.mainId)).filter((l) => l.round_no === 1);
      const mainOrder = main.flatMap((l) => [l.away_entrant_id!]);
      await playRound(rig, 1, (home) => home);
      const field = await plateSeats(rig);
      expect(field, "premise: the field is the four away seats").toEqual([...mainOrder].sort());
      const [plateRow] = await sql<{ id: string; config: Record<string, unknown> }[]>`select id, config from stages where id = ${rig.plateId}`;
      // The engine's own first-loss order (each qualifier's `source.rank`) is the order the plate's draw is fed in.
      const byFirstLoss = [...(await getSeedProposal(rig.auth, rig.plateId))!.computed.qualifiers].sort((a, b) => a.source.rank - b.source.rank).map((q) => q.entrantId);
      const drawn = knockoutDrawOrder(plateRow!.id, byFirstLoss.map((id) => ({ id, seed: null, swiss_first_round: null })), plateRow!.config).map((e) => e.id);
      const expected = generateSingleElim({ entrants: drawn, seeds: new Map(drawn.map((id, i) => [id, i + 1] as const)) }).fixtures.filter((f) => f.round === 0);
      const expectedPairs = expected.map((f) => [f.home, f.away].sort().join("|")).sort();
      const actualPairs = (await linesOf(rig.plateId)).filter((l) => l.round_no === 1).map((l) => [l.home_entrant_id, l.away_entrant_id].sort().join("|")).sort();
      // The premise that gives the test teeth: the plate's order is not simply the main draw's position order.
      const byMainPosition = generateSingleElim({ entrants: mainOrder, seeds: new Map(mainOrder.map((id, i) => [id, i + 1] as const)) }).fixtures.filter((f) => f.round === 0);
      const mainPairs = byMainPosition.map((f) => [f.home, f.away].sort().join("|")).sort();
      if (JSON.stringify(mainPairs) === JSON.stringify(expectedPairs) && attempts < 6) continue;
      expect(JSON.stringify(mainPairs), "premise: the plate's order differs from the main-draw position order").not.toBe(JSON.stringify(expectedPairs));
      expect(actualPairs, "round 1 of the plate pairs the field as the plate's own draw order gives").toEqual(expectedPairs);
      return;
    }
  }, 300_000);
});

describe.skipIf(!HAS_DB)("a withdrawal after the proposal", () => {
  it("a first loser who withdraws while the proposal is a draft: it is re-proposed without them", async () => {
    const rig = await plateRig(8, { autoProgress: false });
    await playRound(rig, 1);
    expect(await fieldOfProposal(rig), "premise: P5-P8 are proposed").toEqual(P(rig, 5, 6, 7, 8));
    await withdrawEntrantCascade(rig.auth, rig.entrants[7]!);
    expect(await fieldOfProposal(rig), "the draft now holds P5-P7 only").toEqual(P(rig, 5, 6, 7));
    expect((await getSeedProposal(rig.auth, rig.plateId))?.status, "still a draft").toBe("draft");
  }, 180_000);
});

describe.skipIf(!HAS_DB)("X-SD-11: qualifying_main seeds the main draw by qualifying rank, on the fold", () => {
  it("n=8, the better seed always wins: the qualifying finishing order P1,P2,P3,P4 draws the main as P1 v P4 and P2 v P3", async () => {
    // plateRig's `plateId` is the SECOND stage: here the main draw. Eight entrants draw a bracket of 8 with no bye; no third-place
    // match, so the semi-final losers (P3, P4) are level and the tie is resolved better-seed-first (the desk's pick).
    const rig = await plateRig(8, { template: "qualifying_main" });
    await generateStageFixtures(rig.auth, rig.plateId); // the main draw's day-one TBD bracket, as the organiser's Generate lays it out
    for (const round of [1, 2, 3]) await playRound(rig, round);
    await completeStage(rig.auth, rig.mainId, { publish: false });
    const proposal = (await getSeedProposal(rig.auth, rig.plateId))!;
    await confirmResolvingTies(rig.auth, rig.plateId, proposal.id);
    const round1 = (await linesOf(rig.plateId)).filter((l) => l.round_no === 1);
    const pairs = round1.map((l) => [l.home_entrant_id, l.away_entrant_id].sort().join("|")).sort();
    const expected = [P(rig, 1, 4).join("|"), P(rig, 2, 3).join("|")].sort();
    expect(round1.length, "premise: a field of four draws two round-1 lines").toBe(2);
    expect(pairs, "E1 v E4 and E2 v E3 (RB4-D1: the fold)").toEqual(expected);
  }, 300_000);
});
