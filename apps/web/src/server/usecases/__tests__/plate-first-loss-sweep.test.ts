// W4 app PR B, Task 8 (X-PL-8, FX-G14): the plate draws at its field size and completes for EVERY entrant count the builder
// offers. A coverage sweep: it builds nothing. Expected values come from RB4-P1 and the fold, never from the code under test:
// `foldFirstLoserSeeds(n)` plays the engine's own single-elimination draw with the better seed winning every line and names the
// seeds whose FIRST real match was a loss (a bye is no match). The sweep then drives the REAL usecases - Start, the scorer's own
// events for rounds 1 and 2, the proposal, the auto-confirm - and compares who the plate SEATS.
//
// Enumerated: n = 4..33 (the builder's floor, KO_PLATE_TOO_FEW, is 4), and a sample past the next powers of two (65-67, 129-131: the
// byes grow with the gap to the power). Football over the whole list - a team sport scored by three events and a period close; the
// plate's field reads the main stage's lines, never a sport field, so one sport carries the full enumeration. The named
// n = 5, 6, 7, 9, 17 (the cases the owner's rulebook names) are repeated in badminton, the other scoring shape the rig drives.
import { afterAll, describe, expect, it, vi } from "vitest";
import { generateSingleElim } from "@seazn/engine/scheduling";
import { sql } from "@/lib/db";
import { completeStage } from "../stages";
import { PLATE_MIN } from "@/lib/format-size-gates";
import { foldFirstLoserSeeds } from "@/lib/division-builder/__tests__/first-loss-fold";
import { BADMINTON_PICK, FOOTBALL_PICK, linesOf, plateRig, plateSeats, playRound } from "./_plate-rig";

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

const RANGE = Array.from({ length: 30 }, (_, i) => i + 4);
const NS = [...RANGE, 65, 66, 67, 129, 130, 131];
const NAMED = [5, 6, 7, 9, 17];
const checked = new Set<string>();
const fieldSizes = new Set<number>();

/** Play every remaining line of `stageId`, round by round, the better seed winning (a round's winners are seated by the feeds). */
async function playOut(rig: Awaited<ReturnType<typeof plateRig>>, stageId: string): Promise<number> {
  const rounds = Math.max(...(await linesOf(stageId)).map((l) => l.round_no));
  let played = 0;
  for (let r = 1; r <= rounds; r++) played += (await playRound(rig, r, undefined, stageId)).length;
  return played;
}

async function sweepOne(n: number, pick: typeof FOOTBALL_PICK): Promise<void> {
  const rig = await plateRig(n, { autoProgress: true, ...pick });
  await playRound(rig, 1);
  await playRound(rig, 2);
  const expectedSeeds = foldFirstLoserSeeds(n);
  expect(expectedSeeds.length, `n=${n}: the fold names at least two first losers (the builder's floor guarantees a bracket)`).toBeGreaterThanOrEqual(2);
  const expected = expectedSeeds.map((s) => rig.entrants[s - 1]!).sort();
  expect(await plateSeats(rig), `${pick.sport.key} n=${n}: the plate seats exactly the entrants whose first real match was a loss`).toEqual(expected);
  const [stage] = await sql<{ status: string }[]>`select status from stages where id = ${rig.plateId}`;
  expect(stage!.status, `n=${n}: the plate is not left pending`).not.toBe("pending");
  const [proposal] = await sql<{ status: string }[]>`select status from stage_seed_proposals where stage_id = ${rig.plateId} order by created_at desc limit 1`;
  expect(proposal?.status, `n=${n}: auto-progress confirmed the one proposal`).toBe("confirmed");
  // The plate was drawn at its field: EXACTLY the lines the engine's own single-elimination draw of k entrants declares.
  const k = expected.length;
  const ids = Array.from({ length: k }, (_, i) => `q${i + 1}`);
  const declared = generateSingleElim({ entrants: ids, seeds: new Map(ids.map((id, i) => [id, i + 1] as const)) }).fixtures.length;
  expect((await linesOf(rig.plateId)).length, `n=${n}: the plate holds exactly the ${declared} lines a bracket of ${k} declares`).toBe(declared);
  // RB4-P6 / FX-G14: play everything out and complete - the stages and the division - with no 409 at Complete.
  await playOut(rig, rig.mainId);
  await playOut(rig, rig.plateId);
  await completeStage(rig.auth, rig.mainId, { publish: false });
  await completeStage(rig.auth, rig.plateId, { publish: false });
  const stages = await sql<{ status: string }[]>`select status from stages where division_id = ${rig.divisionId}`;
  expect(stages.map((s) => s.status), `n=${n}: both stages complete`).toEqual(["complete", "complete"]);
  const [division] = await sql<{ status: string }[]>`select status from divisions where id = ${rig.divisionId}`;
  expect(division!.status, `n=${n}: the division completes`).toBe("completed");
  const [{ c }] = await sql<{ c: number }[]>`select count(*)::int as c from division_events where division_id = ${rig.divisionId} and type = 'division_completed'`;
  expect(c, `n=${n}: completed exactly once`).toBe(1);
  fieldSizes.add(k);
  checked.add(`${pick.sport.key} n=${n}`);
}

describe.skipIf(!HAS_DB)("the plate completes for every offered n (X-PL-8)", () => {
  it("the builder's floor is the sweep's floor", () => {
    expect(Math.min(...NS), "the sweep starts at the ko_plate floor").toBe(PLATE_MIN);
  });
  it.each(NS)("football n=%i: the plate seats the first losers of the fold", async (n) => {
    await sweepOne(n, FOOTBALL_PICK);
  }, 900_000);
  it.each(NAMED)("badminton n=%i (a named case): the same field, another scoring shape", async (n) => {
    await sweepOne(n, BADMINTON_PICK);
  }, 900_000);
  it("anti-vacuity: every enumerated case was checked, and the fields differ across n", () => {
    expect(checked.size, "cases checked = cases enumerated").toBe(NS.length + NAMED.length);
    expect(fieldSizes.size, "the sweep met several different field sizes (not one number repeated)").toBeGreaterThan(5);
    console.info(`plate sweep: ${checked.size} (sport, n) cases played out and completed; n values: ${NS.length}`);
  });
});
