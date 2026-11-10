// W4 matrix-fix: the cricket plate draws. Found by the T15 local run (W4B_Q5A ko_plate|cricket|t20): the plate's seed proposal
// was refused 422 SEEDING_RULES_MISSING after every first loss was known, while the other ten sports drew it.
import { afterAll, describe, expect, it, vi } from "vitest";
import { computeSeedProposal, generateStageFixtures } from "../stages";
import { sql } from "@/lib/db";
import { scoreEvent } from "../scoring";
import { builtinModules } from "@seazn/engine/sports";
import { foldFirstLoserSeeds } from "@/lib/division-builder/__tests__/first-loss-fold";
import { CRICKET_PICK, FOOTBALL_PICK, linesOf, plateRig, plateSeats, playRound, undecide, win } from "./_plate-rig";

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

describe.skipIf(!HAS_DB)("the plate draws on cricket (matrix defect 2)", () => {
  it.each([
    ["cricket", CRICKET_PICK],
    ["football", FOOTBALL_PICK],
  ] as const)("%s n=8: the plate seats the first losers of the fold", async (_name, pick) => {
    const rig = await plateRig(8, { autoProgress: true, ...pick });
    await playRound(rig, 1);
    const expected = foldFirstLoserSeeds(8).map((s) => rig.entrants[s - 1]!).sort();
    expect(expected.length, "anti-vacuity: the fold names first losers").toBeGreaterThanOrEqual(2);
    expect(await plateSeats(rig)).toEqual(expected);
    const [proposal] = await sql<{ status: string }[]>`select status from stage_seed_proposals where stage_id = ${rig.plateId} order by created_at desc limit 1`;
    expect(proposal?.status).toBe("confirmed");
  }, 300_000);

  it.each([
    ["cricket", CRICKET_PICK],
    ["football", FOOTBALL_PICK],
  ] as const)("%s n=8, auto-progress off: the organiser's explicit seed proposal seats the first losers", async (_name, pick) => {
    const rig = await plateRig(8, { autoProgress: false, ...pick });
    await playRound(rig, 1);
    const expected = foldFirstLoserSeeds(8).map((s) => rig.entrants[s - 1]!).sort();
    const proposal = await computeSeedProposal(rig.auth, rig.plateId);
    expect(proposal.computed.qualifiers.map((q) => q.entrantId).sort()).toEqual(expected);
  }, 300_000);

  it.each([
    ["cricket", CRICKET_PICK],
    ["football", FOOTBALL_PICK],
  ] as const)("%s n=8: Generate on the plate first (as the desk does), then the explicit proposal", async (_name, pick) => {
    const rig = await plateRig(8, { autoProgress: false, ...pick });
    await playRound(rig, 1);
    await generateStageFixtures(rig.auth, rig.plateId);
    const expected = foldFirstLoserSeeds(8).map((s) => rig.entrants[s - 1]!).sort();
    const proposal = await computeSeedProposal(rig.auth, rig.plateId);
    expect(proposal.computed.qualifiers.map((q) => q.entrantId).sort()).toEqual(expected);
  }, 300_000);

  it("cricket n=8: the first line ends LEVEL and is settled (the matrix's hard path), the rest are won; the plate still seats the four first losers", async () => {
    const rig = await plateRig(8, { autoProgress: false, ...CRICKET_PICK });
    const cricket = builtinModules.find((m) => m.key === "cricket")!;
    const balls = (cricket.configSchema.parse(cricket.variants[CRICKET_PICK.sport.variant]) as { ballsPerInnings: number }).ballsPerInnings;
    const round1 = (await linesOf(rig.mainId)).filter((l) => l.round_no === 1);
    const tip = async (id: string) => (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
    const post = async (id: string, type: string, payload: Record<string, unknown> = {}) => scoreEvent(rig.auth, id, { expected_seq: await tip(id), type, payload } as never);
    const [first, ...rest] = round1;
    await post(first!.id, "core.start");
    await post(first!.id, "cricket.innings.summary", { runs: 120, wickets: 5, legalBalls: balls });
    await post(first!.id, "core.abandon", { reason: "matrix: abandoned" });
    await post(first!.id, "core.settle", { winner: first!.home_entrant_id, method: "organiser" });
    for (const f of rest) await win(rig, f, f.home_entrant_id!);
    const losers = round1.map((l) => (l.home_entrant_id === first!.home_entrant_id || rest.some((r) => r.id === l.id && r.home_entrant_id === l.home_entrant_id) ? l.away_entrant_id! : l.home_entrant_id!)).sort();
    expect(losers.length, "anti-vacuity: four first losers").toBe(4);
    const proposal = await computeSeedProposal(rig.auth, rig.plateId);
    expect(proposal.computed.qualifiers.map((q) => q.entrantId).sort()).toEqual(losers);
  }, 300_000);

  it.each([
    ["cricket", CRICKET_PICK],
    ["football", FOOTBALL_PICK],
  ] as const)("%s n=8, auto-progress ON: the LAST first match is abandoned and then settled; the plate ends seating all four first losers", async (_name, pick) => {
    const rig = await plateRig(8, { autoProgress: true, ...pick });
    const round1 = (await linesOf(rig.mainId)).filter((l) => l.round_no === 1);
    const tip = async (id: string) => (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
    const post = async (id: string, type: string, payload: Record<string, unknown> = {}) => scoreEvent(rig.auth, id, { expected_seq: await tip(id), type, payload } as never);
    const last = round1[3]!;
    for (const f of round1.slice(0, 3)) await win(rig, f, f.home_entrant_id!);
    await post(last.id, "core.start");
    if (pick.sport.key === "cricket") {
      const cricket = builtinModules.find((m) => m.key === "cricket")!;
      const balls = (cricket.configSchema.parse(cricket.variants[pick.sport.variant]) as { ballsPerInnings: number }).ballsPerInnings;
      await post(last.id, "cricket.innings.summary", { runs: 100, wickets: 5, legalBalls: balls });
    }
    await post(last.id, "core.abandon", { reason: "abandoned" });
    const midSeats = await plateSeats(rig);
    await post(last.id, "core.settle", { winner: last.away_entrant_id, method: "higher_seed" });
    const losers = [...round1.slice(0, 3).map((l) => l.away_entrant_id!), last.home_entrant_id!].sort();
    console.info(`${pick.sport.key}: plate seated ${midSeats.length} after the abandon, expected ${losers.length} after the settle`);
    expect(await plateSeats(rig), "after the settle the plate holds all four first losers").toEqual(losers);
  }, 300_000);

  // THE defect (matrix W4B_Q5A cricket t20): the plate is drawn while one first match is abandoned (a level cricket result is
  // ruled over later), so the field is 3 for a moment; the organiser's settle then makes it 4. The two fields lay out the SAME three
  // lines (a bracket of 3 and a bracket of 4 differ in where the bye is), so a re-proposal found its lines "right" and seated the
  // fourth qualifier nowhere: 422 SEEDING_RULES_MISSING "regenerate them first", advice that could not work.
  it.each([
    ["cricket", CRICKET_PICK],
    ["football", FOOTBALL_PICK],
  ] as const)("%s n=8, auto-progress off: a draft drawn at 3 first losers, then the abandoned match is settled - the re-proposal redraws at 4 and seats all four", async (_name, pick) => {
    const rig = await plateRig(8, { autoProgress: false, ...pick });
    const round1 = (await linesOf(rig.mainId)).filter((l) => l.round_no === 1);
    const tip = async (id: string) => (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
    const post = async (id: string, type: string, payload: Record<string, unknown> = {}) => scoreEvent(rig.auth, id, { expected_seq: await tip(id), type, payload } as never);
    const last = round1[3]!;
    for (const f of round1.slice(0, 3)) await win(rig, f, f.home_entrant_id!);
    await post(last.id, "core.start");
    await post(last.id, "core.abandon", { reason: "abandoned" });
    const first = await computeSeedProposal(rig.auth, rig.plateId);
    expect(first.computed.qualifiers.length, "rig: the field was 3 while the match was abandoned").toBe(3);
    await post(last.id, "core.settle", { winner: last.away_entrant_id, method: "higher_seed" });
    const losers = [...round1.slice(0, 3).map((l) => l.away_entrant_id!), last.home_entrant_id!].sort();
    const again = await computeSeedProposal(rig.auth, rig.plateId);
    expect(again.computed.qualifiers.map((q) => q.entrantId).sort(), "the re-proposal seats all four first losers").toEqual(losers);
    // The lines are the four-entrant bracket's: four seats labelled by first-loss seed, and no bye label left from the field of 3.
    const labels = await sql<{ h: { key?: string; seed?: number } | null; a: { key?: string; seed?: number } | null }[]>`
      select home_slot_label as h, away_slot_label as a from fixtures where stage_id = ${rig.plateId} and round_no = 1`;
    const seeds = labels.flatMap((l) => [l.h, l.a]).filter((x) => x?.key === "slot.first_loss").map((x) => x!.seed).sort();
    expect(seeds, "four first-loss seats in round 1").toEqual([1, 2, 3, 4]);
    expect(labels.flatMap((l) => [l.h, l.a]).filter((x) => x?.key === "bracket.slot.bye"), "no bye in a field of four").toEqual([]);
  }, 300_000);

  it("the other direction, football: a draft drawn at 4, the last result taken back and the match abandoned - the re-proposal redraws at 3 (no stale fourth seat)", async () => {
    const rig = await plateRig(8, { autoProgress: false, ...FOOTBALL_PICK });
    const round1 = (await linesOf(rig.mainId)).filter((l) => l.round_no === 1);
    for (const f of round1) await win(rig, f, f.home_entrant_id!);
    const four = await computeSeedProposal(rig.auth, rig.plateId);
    expect(four.computed.qualifiers.length, "rig: the field was 4").toBe(4);
    await undecide(rig, round1[3]!.id);
    const tip = (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${round1[3]!.id}`)[0]!.s;
    await scoreEvent(rig.auth, round1[3]!.id, { expected_seq: tip, type: "core.abandon", payload: { reason: "abandoned" } } as never);
    const three = await computeSeedProposal(rig.auth, rig.plateId);
    expect(three.computed.qualifiers.length, "the field is 3 again").toBe(3);
    const labels = await sql<{ h: { key?: string } | null; a: { key?: string } | null }[]>`
      select home_slot_label as h, away_slot_label as a from fixtures where stage_id = ${rig.plateId} and round_no = 1`;
    expect(labels.flatMap((l) => [l.h, l.a]).filter((x) => x?.key === "slot.first_loss"), "three first-loss seats").toHaveLength(3);
    expect(labels.flatMap((l) => [l.h, l.a]).filter((x) => x?.key === "bracket.slot.bye"), "and the bye a field of three has").toHaveLength(1);
  }, 300_000);
});
