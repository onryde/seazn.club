// W2a Task 8 (spec §5.4.3–§5.4.5, rulings 79, C17, P2-7; loop-F addendum items 1–5). Held, never seated; the
// organiser's settle seats both sides. Expected values come from the spec's rule rows and the engine's own
// declarations (SETTLE_METHODS, settledMethod, DRAW_KINDS, BRACKET_KINDS), never from the code under test.
import { afterAll, describe, expect, it, vi } from "vitest";
import { DRAW_KINDS, SETTLE_METHODS, settledMethod } from "@seazn/engine/core";
import { sql, withTenant } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { completeStageIfReady } from "@/server/engine-db/competition";
import { scoreEvent, onDecided } from "@/server/usecases/scoring";
import { loadBracketFixtures } from "@/server/usecases/stages";
import { withdrawEntrantCascade } from "@/server/usecases/withdrawal";
import { assertNoLevelSeat, SEATING_STATUSES } from "../level-seat";
import { declaredVariant, seedBracket } from "./helpers/seed-bracket";

const HAS_DB = !!process.env.DATABASE_URL;

// The onDecided witness (spec §5.4.4: "onDecided is not called for needs_decision"). A held row seats nobody even
// if onDecided DID run (advancingSides reads no side from a level outcome), so the seat alone cannot see the gate.
// onDecided's first act on a row is assertNoLevelSeat with the row's status — a passthrough spy (real behaviour,
// every caller: scoring.ts, competition.ts, stages.ts) records who reached seating, and with which status.
vi.mock("@/server/engine-db/level-seat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/engine-db/level-seat")>();
  return { ...actual, assertNoLevelSeat: vi.fn(actual.assertNoLevelSeat) };
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Outcome = { kind: string; winner?: string; loser?: string; method?: string };
type Row = {
  status: string;
  outcome: Outcome | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  winner_to_fixture: string | null;
  loser_to_fixture: string | null;
};
const row = async (id: string) =>
  (
    await sql<Row[]>`select status, outcome, home_entrant_id, away_entrant_id, winner_to_fixture, loser_to_fixture
                     from fixtures where id = ${id}`
  )[0]!;
const seq = async (id: string) =>
  (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
const post = async (auth: Parameters<typeof scoreEvent>[0], id: string, type: string, payload: unknown = {}) =>
  scoreEvent(auth, id, { expected_seq: await seq(id), type, payload } as never);
const seated = async (fixtureId: string) => {
  const r = await row(fixtureId);
  return [r.home_entrant_id, r.away_entrant_id].filter((x) => x !== null);
};
/** A frozen pre-deploy cfg without the bracket overlay's tie-break (Review Focus 4): a drawn chess game then HOLDS
 *  instead of opening phase "tiebreak". The snapshot is frozen by the first append. */
const dropTiebreak = (id: string) => sql`update fixtures set config_snapshot = config_snapshot - 'tiebreak' where id = ${id}`;
const LEVEL_KINDS = ["draw", "tie", "no_result"] as const;

/** A 4-draw bracket: two seated semis feeding an empty final (and, for double_elim, a losers line). */
async function semi(sport: string, variant: string, stageKind: "knockout" | "double_elim" = "knockout") {
  const s = await seedBracket({ sport, variant: declaredVariant(sport, variant), stageKind, entrants: 4 });
  const sf = s.fixtureIds[0]!;
  const r = await row(sf);
  return { ...s, sf, final: r.winner_to_fixture!, home: r.home_entrant_id!, away: r.away_entrant_id! };
}
/** A chess semi whose drawn game is held (needs_decision). */
async function heldChess(stageKind: "knockout" | "double_elim" = "knockout") {
  const t = await semi("boardgame", "classical", stageKind);
  await appendEvent(t.auth.orgId, t.sf, 0, { type: "core.start", payload: {} });
  await dropTiebreak(t.sf);
  await post(t.auth, t.sf, "boardgame.result", { winner: null, method: "agreement" });
  expect((await row(t.sf)).status, "the rig must actually hold the fixture").toBe("needs_decision");
  return t;
}

describe("X-BR-1: assertNoLevelSeat — the bug shape, forced", () => {
  it("empty case first: silent on no outcome, on a win, and outside brackets", () => {
    expect(() => assertNoLevelSeat({ fixtureId: "f", stageKind: "knockout", status: "scheduled", outcome: null })).not.toThrow();
    expect(() =>
      assertNoLevelSeat({ fixtureId: "f", stageKind: "knockout", status: "decided", outcome: { kind: "win", winner: "a", loser: "b" } }),
    ).not.toThrow();
    let checked = 0;
    for (const k of DRAW_KINDS) {
      expect(() => assertNoLevelSeat({ fixtureId: "f", stageKind: k, status: "decided", outcome: { kind: "draw" } }), k).not.toThrow();
      checked++;
    }
    expect(checked).toBe(DRAW_KINDS.size);
  });

  it("X-BR-1: a level outcome under a seating status in a bracket throws LEVEL_RESULT_SEATED, per level kind and per seating status", () => {
    let checked = 0;
    for (const kind of LEVEL_KINDS)
      for (const status of SEATING_STATUSES) {
        expect(
          () => assertNoLevelSeat({ fixtureId: "f", stageKind: "knockout", status, outcome: { kind } }),
          `${kind} ${status}`,
        ).toThrow(expect.objectContaining({ code: "LEVEL_RESULT_SEATED" }));
        checked++;
      }
    expect(checked).toBe(LEVEL_KINDS.length * 3);
    expect([...SEATING_STATUSES].sort()).toEqual(["decided", "finalized", "forfeited"]);
    // The held status is the RIGHT home for the same outcome — the negative pair.
    expect(() => assertNoLevelSeat({ fixtureId: "f", stageKind: "knockout", status: "needs_decision", outcome: { kind: "draw" } })).not.toThrow();
  });
});

describe.skipIf(!HAS_DB)("X-BR-1: every seating read path asserts the bug shape (forced rows)", () => {
  it("X-BR-1: onDecided refuses a level knockout row stored decided, and seats nobody", async () => {
    const t = await semi("boardgame", "classical");
    await sql`update fixtures set status = 'decided', outcome = '{"kind":"draw"}'::jsonb where id = ${t.sf}`;
    await expect(onDecided(t.auth, t.sf)).rejects.toMatchObject({ code: "LEVEL_RESULT_SEATED" });
    expect(await seated(t.final)).toEqual([]);
  });
  it("X-BR-1: the bracket completion read (completeStageIfReady → toBracketFixture) refuses the forced shape", async () => {
    const t = await semi("boardgame", "classical");
    await sql`update fixtures set status = 'decided', outcome = '{"kind":"tie"}'::jsonb where id = ${t.sf}`;
    await expect(completeStageIfReady(t.auth.orgId, t.stageId)).rejects.toMatchObject({
      code: "LEVEL_RESULT_SEATED",
    });
  });
  it("X-BR-1: the completed-bracket rebuild read (stages.ts loadBracketFixtures) refuses the forced shape; a held row reads clean", async () => {
    const t = await semi("boardgame", "classical");
    await sql`update fixtures set status = 'needs_decision', outcome = '{"kind":"no_result"}'::jsonb where id = ${t.sf}`;
    const clean = await withTenant(t.auth.orgId, (tx) => loadBracketFixtures(tx, t.stageId));
    expect(clean.length).toBeGreaterThan(0); // the positive pair: a held row is a legal row
    await sql`update fixtures set status = 'finalized' where id = ${t.sf}`;
    await expect(withTenant(t.auth.orgId, (tx) => loadBracketFixtures(tx, t.stageId))).rejects.toMatchObject({
      code: "LEVEL_RESULT_SEATED",
    });
  });
});

describe.skipIf(!HAS_DB)("X-BR-2 / X-ST-1: held, never seated; the settle seats both", () => {
  it("X-BR-2: a level football knockout result is held — needs_decision, nobody seated in the final, onDecided not run; the settle runs it", async () => {
    const t = await semi("football", "11-a-side");
    const seatChecks = () => vi.mocked(assertNoLevelSeat).mock.calls.map(([f]) => f).filter((f) => f.fixtureId === t.sf);
    await post(t.auth, t.sf, "core.start");
    await post(t.auth, t.sf, "football.period", { phase: "HT" });
    vi.mocked(assertNoLevelSeat).mockClear();
    await post(t.auth, t.sf, "football.period", { phase: "FT" }); // 0–0, no extra time, no shootout configured
    const r = await row(t.sf);
    expect(r.outcome).toEqual({ kind: "draw" });
    expect(r.status).toBe("needs_decision");
    expect(await seated(t.final)).toEqual([]);
    expect(seatChecks(), "nothing reached seating for the held fixture").toEqual([]);
    await post(t.auth, t.sf, "core.settle", { winner: t.away, method: "organiser" });
    expect(seatChecks().map((f) => f.status), "the settle's decision reached onDecided").toContain("decided");
    expect(await seated(t.final)).toEqual([t.away]);
  });

  it("BG-KO-1: a drawn chess knockout game is accepted, the fixture sits in_play in phase tiebreak, and it is NOT DRAW_NOT_ALLOWED", async () => {
    // Loop-F addendum 2: the REAL overlay (Task 6), through the append path — no snapshot edit.
    const t = await semi("boardgame", "classical");
    await post(t.auth, t.sf, "core.start");
    const out = await post(t.auth, t.sf, "boardgame.result", { winner: null, method: "agreement" });
    expect(out.status).toBe("in_play");
    expect(out.outcome).toBeNull();
    const [ms] = await sql<{ phase: string }[]>`select state->>'phase' as phase from match_states where fixture_id = ${t.sf}`;
    expect(ms!.phase).toBe("tiebreak");
    const [snap] = await sql<{ tiebreak: boolean }[]>`select (config_snapshot->>'tiebreak')::boolean as tiebreak from fixtures where id = ${t.sf}`;
    expect(snap!.tiebreak).toBe(true); // the overlay froze into the snapshot
    expect(await seated(t.final)).toEqual([]);
  });

  it("X-ST-1: settle seats the winner in the final AND the loser on its loser line (right answer differs from an award)", async () => {
    const t = await heldChess("double_elim");
    await post(t.auth, t.sf, "core.settle", { winner: t.away, method: "lot" });
    const r = await row(t.sf);
    expect(r.status).toBe("decided");
    expect(r.outcome).toEqual({ kind: "win", winner: t.away, loser: t.home, method: settledMethod("lot") });
    expect(await seated(t.final)).toEqual([t.away]);
    expect(await seated(r.loser_to_fixture!)).toEqual([t.home]); // an award would seat no loser
  });

  it("X-ST-1: every settle method reaches the stored outcome", async () => {
    let checked = 0;
    for (const method of SETTLE_METHODS) {
      const t = await semi("generic", "score");
      await post(t.auth, t.sf, "core.start");
      await post(t.auth, t.sf, "core.abandon", { reason: "rain" });
      await post(t.auth, t.sf, "core.settle", { winner: t.home, method });
      expect((await row(t.sf)).outcome?.method).toBe(settledMethod(method));
      checked++;
    }
    expect(checked).toBe(SETTLE_METHODS.length);
  });

  it("Review Focus 1: a void of the settle returns the fixture to needs_decision and empties the seat it filled", async () => {
    const t = await heldChess();
    await post(t.auth, t.sf, "core.settle", { winner: t.home, method: "organiser" });
    expect(await seated(t.final)).toEqual([t.home]); // the positive pair: the settle DID seat
    const [settle] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${t.sf} and type = 'core.settle'`;
    await post(t.auth, t.sf, "core.void", { event_id: settle!.id });
    expect((await row(t.sf)).status).toBe("needs_decision");
    expect(await seated(t.final)).toEqual([]);
  });

  it("Review Focus 1: once the next match has started, the void of the settle is refused NEXT_MATCH_STARTED and nothing changes", async () => {
    const t = await heldChess();
    await post(t.auth, t.sf, "core.settle", { winner: t.home, method: "organiser" });
    await sql`insert into score_events (id, fixture_id, seq, type, payload, recorded_at)
              values (gen_random_uuid(), ${t.final}, 1, 'core.note', '{"text":"warm-up"}', now())`;
    const [settle] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${t.sf} and type = 'core.settle'`;
    await expect(post(t.auth, t.sf, "core.void", { event_id: settle!.id })).rejects.toMatchObject({ code: "NEXT_MATCH_STARTED" });
    expect((await row(t.sf)).status).toBe("decided");
    expect(await seated(t.final)).toEqual([t.home]);
  });

  it("GN-KO-1: a generic draw in a bracket is refused LEVEL_RESULT_IN_BRACKET and leaves the ledger untouched", async () => {
    const t = await semi("generic", "score");
    await post(t.auth, t.sf, "core.start");
    const before = await seq(t.sf);
    await expect(post(t.auth, t.sf, "generic.result", { p1Score: 1, p2Score: 1 })).rejects.toMatchObject({
      code: "LEVEL_RESULT_IN_BRACKET",
    });
    expect(await seq(t.sf)).toBe(before);
    expect((await row(t.sf)).status).toBe("in_play");
  });

  it("CK-KO-1: a cricket knockout no-result is held, then settled by the higher group finisher", async () => {
    const t = await semi("cricket", "t20");
    await post(t.auth, t.sf, "core.start");
    await post(t.auth, t.sf, "core.abandon", { reason: "rain" }); // cricket folds an abandon to no_result (finding 19)
    const r = await row(t.sf);
    expect(r.outcome).toEqual({ kind: "no_result" });
    expect(r.status).toBe("abandoned"); // D3 order 2: stuck and visible until settled
    expect(await seated(t.final)).toEqual([]);
    await post(t.auth, t.sf, "core.settle", { winner: t.home, method: "higher_seed" });
    expect((await row(t.sf)).status).toBe("decided");
    expect(await seated(t.final)).toEqual([t.home]);
  });

  it("X-ST-1 (ruling C17, Review Focus 5): a withdrawal leaves a held fixture needs_decision; a settle naming the withdrawn entrant is refused SETTLE_NOT_APPLICABLE (withdrawn), and a settle for the remaining one seats them", async () => {
    const t = await heldChess();
    await withdrawEntrantCascade(t.auth, t.away);
    const r = await row(t.sf);
    expect(r.status).toBe("needs_decision"); // withdrawBracketEntrant skips it (withdrawal.ts → "void", stage.ts)
    expect(r.outcome).toEqual({ kind: "draw" });
    expect(await seated(t.final)).toEqual([]);
    const before = await seq(t.sf);
    await expect(post(t.auth, t.sf, "core.settle", { winner: t.away, method: "organiser" })).rejects.toMatchObject({
      code: "SETTLE_NOT_APPLICABLE",
      data: { reason: "withdrawn" },
    });
    expect(await seq(t.sf)).toBe(before); // the refusal wrote nothing
    expect(await seated(t.final)).toEqual([]);
    await post(t.auth, t.sf, "core.settle", { winner: t.home, method: "organiser" }); // the positive pair
    expect((await row(t.sf)).status).toBe("decided");
    expect(await seated(t.final)).toEqual([t.home]);
  });

  it("X-ST-1 (Review Focus 2): a second settle is refused SETTLE_NOT_APPLICABLE and seats nobody twice", async () => {
    const t = await semi("generic", "score");
    await post(t.auth, t.sf, "core.start");
    await post(t.auth, t.sf, "core.abandon", { reason: "rain" });
    await post(t.auth, t.sf, "core.settle", { winner: t.home, method: "lot" });
    await expect(post(t.auth, t.sf, "core.settle", { winner: t.away, method: "lot" })).rejects.toMatchObject({
      code: "SETTLE_NOT_APPLICABLE",
    });
    expect(await seated(t.final)).toEqual([t.home]);
  });
});

describe.skipIf(!HAS_DB)("P2-7 / finding 27: finalize in a bracket is refused while settleApplies", () => {
  const refusesFinalize = async (t: { auth: Parameters<typeof scoreEvent>[0]; sf: string }) => {
    const before = await seq(t.sf);
    await expect(post(t.auth, t.sf, "core.finalize")).rejects.toMatchObject({ code: "LEVEL_RESULT_IN_BRACKET" });
    expect(await seq(t.sf)).toBe(before);
  };

  it("P2-7: a HELD level result (needs_decision) cannot be finalized; once settled it can", async () => {
    const t = await heldChess();
    await refusesFinalize(t);
    await post(t.auth, t.sf, "core.settle", { winner: t.home, method: "organiser" });
    await post(t.auth, t.sf, "core.finalize");
    expect((await row(t.sf)).status).toBe("finalized");
  });

  it("P2-7: an abandon with NO outcome cannot be finalized (isLevelOutcome alone would let it through); once settled it can", async () => {
    // boardgame leaves an abandon undecided (boardgame.ts core.abandon: phase "abandoned", outcome null).
    const t = await semi("boardgame", "classical");
    await post(t.auth, t.sf, "core.start");
    await post(t.auth, t.sf, "core.abandon", { reason: "venue closed" });
    const r = await row(t.sf);
    expect(r.outcome, "the rig: an abandon with nothing decided").toBeNull();
    expect(r.status).toBe("abandoned");
    await refusesFinalize(t);
    await post(t.auth, t.sf, "core.settle", { winner: t.away, method: "lot" });
    await post(t.auth, t.sf, "core.finalize");
    expect((await row(t.sf)).status).toBe("finalized");
    expect(await seated(t.final)).toEqual([t.away]);
  });

  it("P2-7: a chess game with its tie-break PENDING cannot be finalized", async () => {
    const t = await semi("boardgame", "classical");
    await post(t.auth, t.sf, "core.start");
    await post(t.auth, t.sf, "boardgame.result", { winner: null, method: "agreement" }); // real overlay → phase tiebreak
    expect((await row(t.sf)).status).toBe("in_play");
    await refusesFinalize(t);
  });

  it("finding 27: a football level abandon (no_result) is refused finalize, and accepted once settled", async () => {
    const t = await semi("football", "11-a-side");
    await post(t.auth, t.sf, "core.start");
    await post(t.auth, t.sf, "core.abandon", { reason: "floodlights" }); // football folds a level abandon to no_result
    await refusesFinalize(t);
    await post(t.auth, t.sf, "core.settle", { winner: t.home, method: "organiser" });
    await post(t.auth, t.sf, "core.finalize");
    expect((await row(t.sf)).status).toBe("finalized");
  });
});

describe.skipIf(!HAS_DB)("loop-F addendum 3: a settle outside a bracket is refused (the engine has no stage gate)", () => {
  it("SETTLE_NOT_APPLICABLE (not_bracket) in every DRAW kind: the ledger is untouched and the draw stays the result", async () => {
    // Every DRAW kind the engine declares (league, group, swiss, americano), counted: a draw there is a RESULT that
    // standings credit as a draw, and the engine's settle precondition (settleApplies) would accept it — the server
    // must refuse it, or standings would read a settled win.
    let checked = 0;
    for (const kind of DRAW_KINDS) {
      const s = await seedBracket({ sport: "generic", variant: declaredVariant("generic", "score"), stageKind: kind,
        entrants: kind === "americano" ? 8 : 4,
        ...(kind === "swiss" ? { stageConfig: { rounds: 3 } } : {}),
        ...(kind === "americano" ? { stageConfig: { mode: "americano", courtCount: 2, rounds: 3 } } : {}),
      });
      const id = s.fixtureIds[0]!;
      const [f] = await sql<{ home: string }[]>`select home_entrant_id as home from fixtures where id = ${id}`;
      await post(s.auth, id, "core.start");
      await post(s.auth, id, "generic.result", { p1Score: 1, p2Score: 1 });
      const before = await seq(id);
      expect((await row(id)).status, kind).toBe("decided");
      await expect(post(s.auth, id, "core.settle", { winner: f!.home, method: "organiser" }), kind).rejects.toMatchObject({
        code: "SETTLE_NOT_APPLICABLE",
        data: { reason: "not_bracket" },
      });
      expect(await seq(id), kind).toBe(before);
      expect((await row(id)).outcome, kind).toEqual({ kind: "draw" });
      checked++;
    }
    expect(checked).toBe(DRAW_KINDS.size);
    expect(checked).toBeGreaterThan(0);
  });
});
