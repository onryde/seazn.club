// W4 matrix-fix: the cricket plate draws. Found by the T15 local run (W4B_Q5A ko_plate|cricket|t20): the plate's seed proposal
// was refused 422 SEEDING_RULES_MISSING after every first loss was known, while the other ten sports drew it.
import { afterAll, describe, expect, it, vi } from "vitest";
import { computeSeedProposal, generateStageFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
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

  // Round 2 (review m1): the HARM direction of the seat check. A false "stale" deletes the plate's rows and with them the
  // organiser's court and time. An UNCHANGED field, bye or not, must keep every row id and what was set on it.
  it.each([
    ["cricket", CRICKET_PICK, 8, 3],
    ["football", FOOTBALL_PICK, 5, 0],
    ["football", FOOTBALL_PICK, 7, 0],
  ] as const)("%s n=%s: proposing twice on an unchanged field (bye-bearing) keeps every plate row and its court and time", async (_name, pick, n, abandonLast) => {
    const rig = await plateRig(n, { autoProgress: false, ...pick });
    if (abandonLast === 3) {
      // A field of three first losers: three won first matches, the fourth abandoned (a bracket of 3 carries a bye).
      const round1 = (await linesOf(rig.mainId)).filter((l) => l.round_no === 1);
      for (const f of round1.slice(0, 3)) await win(rig, f, f.home_entrant_id!);
      const id = round1[3]!.id;
      const tip = (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
      await scoreEvent(rig.auth, id, { expected_seq: tip, type: "core.start", payload: {} } as never);
      await scoreEvent(rig.auth, id, { expected_seq: tip + 1, type: "core.abandon", payload: { reason: "abandoned" } } as never);
    } else {
      await playRound(rig, 1);
      await playRound(rig, 2);
    }
    const first = await computeSeedProposal(rig.auth, rig.plateId);
    const k = first.computed.qualifiers.length;
    expect(k, "anti-vacuity: a field with a bye (3, or the fold's count for a non power-of-two main draw)").toBeGreaterThanOrEqual(2);
    const byes = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures where stage_id = ${rig.plateId} and (home_slot_label->>'key' = 'bracket.slot.bye' or away_slot_label->>'key' = 'bracket.slot.bye')`;
    if (n === 8) expect(byes[0]!.n, "rig: the field of three drew a bye").toBe(1);
    const before = await linesOf(rig.plateId);
    const target = before[0]!;
    await sql`update fixtures set scheduled_at = '2030-01-01T10:00:00Z', court_label = 'C1' where id = ${target.id}`;
    const second = await computeSeedProposal(rig.auth, rig.plateId);
    expect(second.computed.qualifiers.length, "the same field").toBe(k);
    expect((await linesOf(rig.plateId)).map((l) => l.id), "the very same rows, in order").toEqual(before.map((l) => l.id));
    const [row] = await sql<{ court_label: string | null; scheduled_at: Date | null }[]>`select court_label, scheduled_at from fixtures where id = ${target.id}`;
    expect([row!.court_label, row!.scheduled_at?.toISOString()], "the organiser's court and time survived the second proposal").toEqual(["C1", "2030-01-01T10:00:00.000Z"]);
  }, 600_000);

  // Round 2 (review m2): a CONFIRMED plate whose field then shrinks while the main draw is still open. The plate is un-filled and
  // redrawn only when a correction lands in a COMPLETED knockout source (seed-stale.ts correctBracketDependent, X-QM-4, which
  // knockout-source-correction.test.ts pins for the same size); before that the confirmed slate stands. The seat check lives on the
  // proposal's call, which a confirmed plate refuses (409) before it reaches the write, so it can never wipe a confirmed plate:
  // pinned here, the harm direction. (The reviewer's 4 -> 3 redraw of a confirmed plate is not reachable on an open source.)
  it("football n=8, auto-progress ON: a confirmed plate (four seats) stands untouched when its field shrinks to three before the main draw completes", async () => {
    const rig = await plateRig(8, { autoProgress: true, ...FOOTBALL_PICK });
    const round1 = (await linesOf(rig.mainId)).filter((l) => l.round_no === 1);
    for (const f of round1) await win(rig, f, f.home_entrant_id!);
    const [confirmed] = await sql<{ status: string }[]>`select status from stage_seed_proposals where stage_id = ${rig.plateId} order by created_at desc limit 1`;
    expect(confirmed?.status, "rig: auto-progress confirmed the plate at 4").toBe("confirmed");
    const before = await linesOf(rig.plateId);
    await undecide(rig, round1[3]!.id);
    await withdrawEntrantCascade(rig.auth, round1[3]!.home_entrant_id!);
    const [after] = await sql<{ status: string }[]>`select status from stage_seed_proposals where stage_id = ${rig.plateId} order by created_at desc limit 1`;
    expect(after?.status, "the confirmed slate stands").toBe("confirmed");
    const now = await linesOf(rig.plateId);
    expect(now.map((l) => l.id), "same rows").toEqual(before.map((l) => l.id));
    const seated = new Set(now.flatMap((l) => [l.home_entrant_id, l.away_entrant_id]).filter((x) => x !== null));
    expect(seated.size, "all four first losers still hold their seats").toBe(4);
  }, 300_000);
});
