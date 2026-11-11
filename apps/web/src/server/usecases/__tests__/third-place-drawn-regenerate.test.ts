// W4 matrix-fix, defect 1 (PO ruling): the >=4 gate on a third-place Play-off (X-TP-1) applies when a bracket is DRAWN (no lines
// yet, or a real redraw). A bracket already drawn and STARTED is settled by its own rules: both sides of the third-place match out
// ends it 4,4 (RB4-T6). A Generate on it must not refuse, and must never send the organiser to "Use Shared" (that would delete the
// -3p line mid-event). Found by the T15 matrix run (W4B_Q3_OUT): withdraw seeds 3 and 4 after Start, POST generate -> 422.
// Expected values are the engine's own lines (`engineBracketRows`) and the rulebook's ranks (1, 2, 4, 4).
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { engineBracketRows } from "@/lib/__tests__/engine-bracket-rows";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { completeStage, createStages, generateStageFixtures, getStandings } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOrg } from "./_seed";
import { BADMINTON_PICK, FOOTBALL_PICK, entrantInput, linesOf, win } from "./_plate-rig";

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

const PICKS = [FOOTBALL_PICK, BADMINTON_PICK];

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  ids: string[];
  pick: (typeof PICKS)[number];
}

/** A division of `n` seeded entrants and one root Play-off knockout. `drawn: false` leaves it with no lines; `start` Starts it. */
async function rig(pick: (typeof PICKS)[number], n: number, opts: { drawn?: boolean; start?: boolean } = {}): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "TP " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const div = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: pick.sport.key, variant_key: pick.sport.variant, config: {} });
  const made = await createEntrants(auth, div.id, Array.from({ length: n }, (_, i) => entrantInput(pick.kind, `E${i + 1}`, i + 1)));
  const [stage] = await createStages(auth, div.id, { seq: 1, kind: "knockout", name: "KO", config: { thirdPlace: true }, progression: null });
  if (opts.drawn !== false) await generateStageFixtures(auth, stage!.id);
  if (opts.start === true) await startDivision(auth, div.id);
  return { auth, divisionId: div.id, stageId: stage!.id, ids: made.map((e) => e.id), pick };
}

const keysOf = async (stageId: string) => (await linesOf(stageId)).map((l) => (l as unknown as { id: string }).id).length;
const extKeys = async (stageId: string) => (await sql<{ ext_key: string }[]>`select ext_key from fixtures where stage_id = ${stageId} order by ext_key`).map((r) => r.ext_key);
const bronze = async (stageId: string) => sql<{ id: string }[]>`select id from fixtures where stage_id = ${stageId} and third_place`;

describe.skipIf(!HAS_DB)("a drawn Play-off bracket is never refused KO_THIRD_PLACE_TOO_FEW by a Generate (matrix defect 1)", () => {
  it.each(PICKS.map((p) => [p.sport.key, p] as const))("(a) the repro, %s: 4 entrants, Start, withdraw seeds 3 and 4, Generate answers a no-op, -3p intact, the stage completes 1,2,4,4", async (_k, pick) => {
    const r = await rig(pick, 4, { start: true });
    const want = engineBracketRows(4, true).map((x) => x.ext_key).sort();
    expect(await extKeys(r.stageId), "rig: the engine's Play-off bracket is drawn").toEqual(want);
    const before = (await linesOf(r.stageId)).map((l) => l.id).sort();
    await withdrawEntrantCascade(r.auth, r.ids[2]!);
    await withdrawEntrantCascade(r.auth, r.ids[3]!);
    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.created, "a no-op writes nothing").toBe(0);
    expect(await extKeys(r.stageId), "the -3p line is intact").toEqual(want);
    expect((await bronze(r.stageId)).length).toBe(1);
    expect((await linesOf(r.stageId)).map((l) => l.id).sort(), "the very same rows").toEqual(before);
    // The semi-final losers walked: seeds 1 and 2 are seated in the final. Decide it and the stage completes 1,2,4,4.
    const final = (await linesOf(r.stageId)).find((l) => l.round_no === 2 && l.home_entrant_id !== null && l.away_entrant_id !== null && l.outcome === null);
    expect(final, "rig: the final is playable").toBeTruthy();
    await win({ auth: r.auth, sport: r.pick.sport }, final!, r.ids[0]!);
    await completeStage(r.auth, r.stageId, { publish: false });
    const snap = await getStandings(r.auth, r.stageId);
    const ranks = new Map((snap.rows as { entrantId: string; rank: number }[]).map((x) => [x.entrantId, x.rank]));
    expect([ranks.get(r.ids[0]!), ranks.get(r.ids[1]!), ranks.get(r.ids[2]!), ranks.get(r.ids[3]!)]).toEqual([1, 2, 4, 4]);
  }, 300_000);

  it("(b) an UNDRAWN Play-off on 3 entrants is still refused with the count and the stage (the 7A recovery is unchanged)", async () => {
    const r = await rig(FOOTBALL_PICK, 4, { drawn: false });
    await sql`update entrants set status = 'withdrawn' where id = ${r.ids[3]!}`;
    let err: unknown;
    try {
      await generateStageFixtures(r.auth, r.stageId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    const h = err as HttpError;
    expect([h.status, h.code, (h.extra as { entrants?: number }).entrants, (h.extra as { stageId?: string }).stageId]).toEqual([422, "KO_THIRD_PLACE_TOO_FEW", 3, r.stageId]);
    expect(await keysOf(r.stageId), "nothing was drawn").toBe(0);
  }, 180_000);

  it.each(PICKS.map((p) => [p.sport.key, p] as const))("(c) sequence, %s: draw at 4, Start, withdraw one -> Generate no-op OK -> withdraw another -> Generate still OK, and again", async (_k, pick) => {
    const r = await rig(pick, 4, { start: true });
    const want = engineBracketRows(4, true).map((x) => x.ext_key).sort();
    let calls = 0;
    for (const id of [r.ids[3]!, r.ids[2]!]) {
      await withdrawEntrantCascade(r.auth, id);
      for (let i = 0; i < 2; i++) {
        const out = await generateStageFixtures(r.auth, r.stageId);
        calls++;
        expect(out.created).toBe(0);
        expect(await extKeys(r.stageId)).toEqual(want);
      }
    }
    expect(calls, "anti-vacuity: four Generates answered").toBe(4);
  }, 300_000);

  it("(d) a drawn Play-off that has NOT started is still a real redraw: shrinking to 3 is refused with the count (the gate runs when drawing)", async () => {
    const r = await rig(FOOTBALL_PICK, 4);
    await sql`update entrants set status = 'withdrawn' where id = ${r.ids[3]!}`;
    let err: unknown;
    try {
      await generateStageFixtures(r.auth, r.stageId);
    } catch (e) {
      err = e;
    }
    expect(err, "pre-Start a 4 -> 3 shrink is a redraw of the bracket").toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe("KO_THIRD_PLACE_TOO_FEW");
  }, 180_000);
});
