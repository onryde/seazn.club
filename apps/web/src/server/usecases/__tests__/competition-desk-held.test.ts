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
/** A two-board table stage of any table kind (swiss and americano need their own config and a wider field). */
async function bracketOf(stageKind: "league" | "group" | "swiss" | "americano") {
  const s = await seedBracket({
    sport: "generic",
    variant: declaredVariant("generic", "score"),
    stageKind,
    entrants: stageKind === "americano" ? 8 : 4,
    ...(stageKind === "swiss" ? { stageConfig: { rounds: 3 } } : {}),
    ...(stageKind === "americano" ? { stageConfig: { mode: "americano", courtCount: 2, rounds: 3 } } : {}),
  });
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

  it("I1 / X-AB-5: a TABLE stage's recorded abandon that decided nobody is HELD like a bracket's - a red row, and the page's read names it", async () => {
    // The server's settle guard takes a settle there (abandon-swiss-settle.test.ts) and the console's block offers it
    // (needs-decision.tsx); the desk must not strike it as a void beside a console that demands a decision.
    let checked = 0;
    for (const stageKind of ["league", "group", "swiss", "americano"] as const) {
      const t = await bracketOf(stageKind);
      expect((await desk(t)).held, `${stageKind}: nothing abandoned yet`).toBeUndefined();
      await abandonLevel(t);
      const d = await desk(t);
      expect(d.held, stageKind).toEqual({ kind: "needs_decision", count: 1, fixtureIds: [t.f] });
      expect([...(await listFixturesAwaitingSettle(t.auth, t.divisionId))], `${stageKind}: the division page's read`).toEqual([t.f]);
      checked++;
    }
    expect(checked).toBe(4);
  }, 120_000);

  it("I1 sequence (league): the void of the abandon, a second abandon, and the settle each move the row; a settled match is a result (Finished again)", async () => {
    const t = await bracket("league", 2);
    await abandonLevel(t);
    const held = await desk(t);
    expect(held.held?.fixtureIds).toEqual([t.f]);
    // One board in the whole division, so "Finished" is decided by that board alone: the old read struck it as a void.
    expect(held.phase, "an unresolved board is not Finished").not.toBe("finished");
    const [abandon] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${t.f} and type = 'core.abandon'`;
    await appendEvent(t.auth.orgId, t.f, await seq(t.f), { type: "core.void", payload: {}, voids: abandon!.id });
    expect((await desk(t)).held, "an undone abandon holds nothing").toBeUndefined();
    expect([...(await listFixturesAwaitingSettle(t.auth, t.divisionId))]).toEqual([]);
    await post(t.auth, t.f, "core.abandon", { reason: "floodlights again" });
    expect((await desk(t)).held?.fixtureIds).toEqual([t.f]);
    const [{ home }] = await sql<{ home: string }[]>`select home_entrant_id as home from fixtures where id = ${t.f}`;
    await post(t.auth, t.f, "core.settle", { winner: home, method: "organiser" });
    expect(await status(t.f)).toBe("decided");
    const after = await desk(t);
    expect(after.held, "settled: nothing owed").toBeUndefined();
    expect(after.phase, "the positive pair: a settled single board IS finished").toBe("finished");
    expect([...(await listFixturesAwaitingSettle(t.auth, t.divisionId))]).toEqual([]);
  }, 120_000);

  it("a TABLE stage's withdrawal EXPUNGE (core.abandon{expunge:true}) holds nothing: the match left the table, nothing is owed", async () => {
    const t = await bracket("league", 2);
    await post(t.auth, t.f, "core.start");
    await scoreEvent(
      t.auth,
      t.f,
      { expected_seq: await seq(t.f), type: "core.abandon", payload: { reason: "withdrew", expunge: true } } as never,
      { writer: "withdrawal_cascade" },
    );
    expect(await status(t.f), "the rig must actually record the expunge").toBe("abandoned");
    const d = await desk(t);
    expect(d.held).toBeUndefined();
    expect(d.phase, "an expunged match is out of the table: nothing is owed, the division is Finished").toBe("finished");
    expect([...(await listFixturesAwaitingSettle(t.auth, t.divisionId))]).toEqual([]);
  }, 120_000);

  it("the generator's void (abandoned, no core.abandon in the ledger) is terminal: no row, and Finished", async () => {
    const t = await bracket("knockout", 2);
    await sql`update fixtures set status = 'abandoned' where id = ${t.f}`;
    const d = await desk(t);
    expect(d.held).toBeUndefined();
    expect(d.phase).toBe("finished");
    expect([...(await listFixturesAwaitingSettle(t.auth, t.divisionId))]).toEqual([]);
  });
});
