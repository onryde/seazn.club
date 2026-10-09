// W2a Task 13 (loop-H addendum 9; competition-desk _RULES: empty set first, a red attention outranks the phase).
// The desk read a recorded abandon that decided nobody — stored `abandoned`, exactly like the generator's void — as
// TERMINAL, so a knockout whose final was abandoned at a level score read "Finished" with nothing asking the organiser
// for the settle that ends it. Real Postgres, real doors (scoreEvent, the REAL ledger); the distinction is the one
// engine-db/recorded-abandon.ts draws, read through `getCompetitionDesk` and the division page's own read.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { scoreEvent } from "@/server/usecases/scoring";
import { getCompetitionDesk, listFixturesAwaitingSettle } from "../competition-desk";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const seq = async (id: string) =>
  (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
const post = async (auth: Parameters<typeof scoreEvent>[0], id: string, type: string, payload: unknown = {}) =>
  scoreEvent(auth, id, { expected_seq: await seq(id), type, payload } as never);
const status = async (id: string) => (await sql<{ status: string }[]>`select status from fixtures where id = ${id}`)[0]!.status;

/** generic/score: its abandon folds to `no_result` (a LEVEL outcome), the shape `abandonAwaitsSettle` names. */
async function bracket(stageKind: "knockout" | "league", entrants: number) {
  const s = await seedBracket({ sport: "generic", variant: declaredVariant("generic", "score"), stageKind, entrants });
  return { ...s, f: s.fixtureIds[0]! };
}
async function abandonLevel(t: Awaited<ReturnType<typeof bracket>>) {
  await post(t.auth, t.f, "core.start");
  await post(t.auth, t.f, "core.abandon", { reason: "floodlights" });
  expect(await status(t.f), "the rig must actually record the abandon").toBe("abandoned");
}
async function desk(t: Awaited<ReturnType<typeof bracket>>) {
  const d = (await getCompetitionDesk(t.auth, t.competitionId)).divisions.get(t.divisionId);
  expect(d, "the division is on the desk").toBeDefined();
  return { ...d!, held: d!.attention.find((a) => a.kind === "needs_decision") };
}

describe.skipIf(!HAS_DB)("the desk reads a held bracket fixture as owed work (W2a addendum 9)", () => {
  it("empty case first: a fresh knockout holds nothing — no needs_decision row, and the page's read is empty", async () => {
    const t = await bracket("knockout", 2);
    expect((await desk(t)).held).toBeUndefined();
    expect([...(await listFixturesAwaitingSettle(t.auth, t.divisionId))]).toEqual([]);
  });

  it("a knockout FINAL abandoned at a level score is not Finished: one red needs_decision row names it", async () => {
    const t = await bracket("knockout", 2);
    expect(t.fixtureIds, "a two-entrant knockout is one final").toHaveLength(1);
    await abandonLevel(t);
    const d = await desk(t);
    expect(d.phase, "every fixture is stored terminal, so the old read said Finished").not.toBe("finished");
    expect(d.held).toEqual({ kind: "needs_decision", count: 1, fixtureIds: [t.f] });
    expect([...(await listFixturesAwaitingSettle(t.auth, t.divisionId))]).toEqual([t.f]);
    // Ruling D-H2: the abandoned final was under way — in progress, never "Setting up".
    expect(d.phase).toBe("scheduled");
  });

  it("sequence: the void of the abandon makes it live again (no row); the settle decides it (no row, Finished)", async () => {
    const t = await bracket("knockout", 2);
    await abandonLevel(t);
    const [abandon] = await sql<{ id: string }[]>`
      select id from score_events where fixture_id = ${t.f} and type = 'core.abandon'`;
    await appendEvent(t.auth.orgId, t.f, await seq(t.f), { type: "core.void", payload: {}, voids: abandon!.id });
    expect(await status(t.f)).toBe("in_play");
    expect((await desk(t)).held, "a voided abandon is no longer owed a settle").toBeUndefined();
    expect([...(await listFixturesAwaitingSettle(t.auth, t.divisionId))]).toEqual([]);

    await post(t.auth, t.f, "core.abandon", { reason: "floodlights again" });
    expect((await desk(t)).held?.fixtureIds).toEqual([t.f]);
    const [{ home }] = await sql<{ home: string }[]>`select home_entrant_id as home from fixtures where id = ${t.f}`;
    await post(t.auth, t.f, "core.settle", { winner: home, method: "lot" });
    expect(await status(t.f)).toBe("decided");
    const after = await desk(t);
    expect(after.held, "settled: nothing owed").toBeUndefined();
    expect(after.phase, "the positive pair: a decided final IS finished").toBe("finished");
  });

  it("a level knockout RESULT (needs_decision) raises the same row, through the status alone", async () => {
    // Football, not generic: generic REFUSES a level knockout result outright (Task 9). A football 0–0 at full time
    // with no extra time or shootout configured is HELD (X-BR-2) — the stream settle-seating.test.ts pins.
    const s = await seedBracket({ sport: "football", variant: declaredVariant("football", "11-a-side"), stageKind: "knockout", entrants: 2 });
    const t = { ...s, f: s.fixtureIds[0]! };
    await post(t.auth, t.f, "core.start");
    await post(t.auth, t.f, "football.period", { phase: "HT" });
    await post(t.auth, t.f, "football.period", { phase: "FT" });
    expect(await status(t.f), "the rig must actually hold the fixture").toBe("needs_decision");
    const d = await desk(t);
    expect(d.held).toEqual({ kind: "needs_decision", count: 1, fixtureIds: [t.f] });
    expect(d.phase).not.toBe("finished");
    // Ruling D-H2 (fix round 1): the level final WAS played — the phase reads in progress, never "Setting up", and the
    // "N of M played" beside it (card-stats) counts it, so the two agree.
    expect(d.phase).toBe("scheduled");
    expect({ played: d.played, total: d.total }).toEqual({ played: 1, total: 1 });
    // The page's read is the ABANDON half only; the status half needs no ledger.
    expect([...(await listFixturesAwaitingSettle(t.auth, t.divisionId))]).toEqual([]);
  });

  it("a TABLE stage's recorded abandon is a void: no row, and the page's read stays empty", async () => {
    const t = await bracket("league", 2);
    await abandonLevel(t);
    expect((await desk(t)).held).toBeUndefined();
    expect([...(await listFixturesAwaitingSettle(t.auth, t.divisionId))]).toEqual([]);
  });

  it("the generator's void (abandoned, no core.abandon in the ledger) is terminal: no row, and Finished", async () => {
    const t = await bracket("knockout", 2);
    await sql`update fixtures set status = 'abandoned' where id = ${t.f}`;
    const d = await desk(t);
    expect(d.held).toBeUndefined();
    expect(d.phase).toBe("finished");
    expect([...(await listFixturesAwaitingSettle(t.auth, t.divisionId))]).toEqual([]);
  });
});
