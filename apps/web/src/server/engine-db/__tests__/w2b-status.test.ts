// W2b Task 7 (spec §5.4, plan D7 / D15 / D19 / PF-1 / PF-2; ST-G1). The status rule keyed as §5.4 orders it, and the
// append guards W2b adds. Expected statuses come from the spec's ordered rule and Appendix A (CK-AB-1, CK-AB-2,
// X-AB-1, X-AB-3, X-DW-3); points from the variant's own declared cfg (the engine's declaration), never from the code
// under test.
import { afterAll, describe, expect, it } from "vitest";
import { BRACKET_KINDS, DRAW_KINDS } from "@seazn/engine/core";
import { resolvePositions } from "@seazn/engine/sport";
import { football } from "@seazn/engine/sports/football";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { builtinModules } from "@seazn/engine/sports";
import { sql, withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { getStandings } from "@/server/usecases/stages";
import { getFixtureState } from "@/server/usecases/fixtures";
import { scoreEvent } from "@/server/usecases/scoring";
import { importEvents } from "@/server/usecases/event-import";
import { seedOrg, startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { fixtureStatusFromFold } from "../append-event";
import { foldFixture, foldFrom } from "../fold";
import { declaredVariant, insertLegacyEvents, seedBracket } from "./helpers/seed-bracket";
import { qualificationFixtures } from "@/server/public-site/division-qualification";
import { fixtureRow, playBadminton, post, rowsOf, tip } from "./helpers/w2b-rig";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const W = { kind: "win", winner: "h", loser: "a" } as const;
const ev = (type: string, payload: unknown = {}) => ({ type, payload });

describe("PF-1 headline (loop D carry-in): the fold's summary is summaryOf, so a withdrawal over a held draw reads the award", () => {
  // single-sport: football — 0-0 FT is the level result a bracket holds, and its credited forfeit score (FB-WO-1:
  // `awardScore.goals`–0 at 0-0, the variant's declared cfg) differs from the draw, so the headline can witness it.
  const cfg = football.configSchema.parse({}) as { awardScore: { goals: number } };
  const lineups = defaultLineupPair(resolvePositions(football, cfg));
  const level = [ev("core.start"), ev("football.period", { phase: "HT" }), ev("football.period", { phase: "FT" })];
  const fold = (events: { type: string; payload: unknown }[]) =>
    foldFrom("fx", { sportKey: "football", module: football as never, cfg, lineups, envelopes: events.map((e, i) => makeEnvelope(i, e as never)), stageKind: "knockout" });
  it("the away side withdrew: outcome the award, headline G — 0", () => {
    const f = fold([...level, ev("core.forfeit", { by: lineups.away.entrantId, reason: "withdrew" })]);
    expect([f.outcome?.kind, (f.summary as { headline: string }).headline]).toEqual(["award", `${cfg.awardScore.goals} — 0`]);
  });
  it("the negative pair: the held draw reads 0 — 0", () => {
    const f = fold(level);
    expect([f.outcome?.kind, (f.summary as { headline: string }).headline]).toEqual(["draw", "0 — 0"]);
  });
});

describe("D7: fixtureStatusFromFold keyed as spec §5.4 (+ plan finding 5)", () => {
  it("empty case first: nothing folded is scheduled", () => {
    expect(fixtureStatusFromFold(null, [], "league")).toBe("scheduled");
  });

  it("X-AB-2 / ST-G1 / X-DW-1: each row of the order, in a draw kind and in a bracket kind", () => {
    const rows: [string, unknown, unknown[], string, string][] = [
      ["settle wins", W, [ev("core.start"), ev("core.settle", { winner: "h", method: "lot" })], "knockout", "decided"],
      ["abandon, no outcome", null, [ev("core.start"), ev("core.abandon", { reason: "rain" })], "league", "abandoned"],
      ["abandon, level, bracket", { kind: "no_result" }, [ev("core.start"), ev("core.abandon", { reason: "rain" })], "knockout", "abandoned"],
      ["ST-G1: abandon, level, draw kind (cricket NR)", { kind: "no_result" }, [ev("core.start"), ev("core.abandon", { reason: "rain" })], "league", "decided"],
      ["ST-G1: abandon, decisive (DLS / award policy)", { kind: "win", winner: "h", loser: "a", method: "dls" }, [ev("core.start"), ev("core.abandon", { reason: "rain" })], "league", "decided"],
      ["level in a bracket", { kind: "draw" }, [ev("core.start")], "knockout", "needs_decision"],
      ["active core.forfeit", { kind: "award", winner: "h", loser: "a", reason: "walkover" }, [ev("core.forfeit", { by: "a", reason: "walkover" })], "league", "forfeited"],
      ["double walkover (event)", { kind: "double_walkover" }, [ev("core.forfeit", { by: "both", reason: "walkover" })], "knockout", "forfeited"],
      ["finding 5: legacy chess double forfeit, no core.forfeit", { kind: "double_walkover" }, [ev("core.start"), ev("boardgame.result", { winner: null, method: "double_forfeit" })], "league", "forfeited"],
      ["award-policy abandon is decided, not forfeited (no core.forfeit)", { kind: "win", winner: "h", loser: "a", method: "abandoned" }, [ev("core.start"), ev("core.abandon", { reason: "rain" })], "knockout", "decided"],
      // §5.4 keys rule 4 on the EVENT, not the award kind: an award outcome with no core.forfeit behind it (the pre-D8
      // award-policy abandon's shape — W2b D8 made that a win, so no shipped module folds this today) is decided.
      ["an award with no core.forfeit is decided, not forfeited (rule 4 keys on the event)", { kind: "award", winner: "h", loser: "a", reason: "walkover" }, [ev("core.start"), ev("core.abandon", { reason: "rain" })], "league", "decided"],
      ["a win", W, [ev("core.start")], "league", "decided"],
    ];
    let checked = 0;
    for (const [name, outcome, active, kind, want] of rows) {
      expect(fixtureStatusFromFold(outcome as never, active as never, kind), name).toBe(want);
      checked++;
    }
    expect(checked).toBe(rows.length);
  });

  it("D7 rule 2 vs 5: the same level abandon is abandoned in every bracket kind and decided in every draw kind (both halves reached)", () => {
    // The engine's own two halves of StageKind (BRACKET_KINDS / DRAW_KINDS), never a typed list.
    let abandoned = 0;
    let decided = 0;
    for (const kind of [...BRACKET_KINDS, ...DRAW_KINDS]) {
      const got = fixtureStatusFromFold({ kind: "no_result" }, [ev("core.start"), ev("core.abandon", { reason: "rain" })] as never, kind);
      expect(got, kind).toBe(BRACKET_KINDS.has(kind) ? "abandoned" : "decided");
      if (got === "abandoned") abandoned++;
      else decided++;
    }
    expect([abandoned, decided]).toEqual([BRACKET_KINDS.size, DRAW_KINDS.size]);
  });
});

const isEngine = (code: string, reason?: string) =>
  expect.objectContaining({ code, ...(reason === undefined ? {} : { data: expect.objectContaining({ reason }) }) });

/** The fixture is exactly as it was: same tip, same status. */
async function unchanged(id: string, before: { seq: number; status: string }, label: string) {
  expect({ seq: await tip(id), status: (await fixtureRow(id)).status }, label).toEqual(before);
}
const snap = async (id: string) => ({ seq: await tip(id), status: (await fixtureRow(id)).status });

const moduleOf = (key: string) => builtinModules.find((x) => x.key === key)!;
const declaredCfg = (sport: string, variant: string) =>
  moduleOf(sport).configSchema.parse(moduleOf(sport).variants[declaredVariant(sport, variant)]) as Record<string, unknown>;
interface StandingRow {
  entrantId: string;
  played: number;
  won: number;
  lost: number;
  points: number;
  metrics?: Record<string, number>;
}
const standings = async (auth: AuthCtx, stageId: string) => (await getStandings(auth, stageId)).rows as StandingRow[];

describe.skipIf(!HAS_DB)("W2b append guards and the status rule, through scoreEvent (D15, D19, PF-1, PF-2, ST-G1)", () => {
  it("D15: chess boardgame.result{forfeit | double_forfeit} is refused INVALID_EVENT chess_forfeit_method_retired; nothing is written", async () => {
    // single-sport: the two retired methods are boardgame's own (spec §5.2, finding 15).
    let checked = 0;
    for (const payload of [{ method: "forfeit", side: "home" }, { method: "double_forfeit", side: null }] as const) { // legacy methods
      const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
      const id = s.fixtureIds[0]!;
      const f = await fixtureRow(id);
      await post(s.auth, id, "core.start");
      const before = await snap(id);
      await expect(
        post(s.auth, id, "boardgame.result", { winner: payload.side === null ? null : f.home_entrant_id, method: payload.method }),
        payload.method,
      ).rejects.toEqual(isEngine("INVALID_EVENT", "chess_forfeit_method_retired"));
      await unchanged(id, before, payload.method);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("D15 positive pair: an ordinary chess result is accepted, and a legacy stream that already holds a retired method still replays", async () => {
    // single-sport: as above.
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "league", entrants: 3 });
    const [a, b] = s.fixtureIds;
    const fa = await fixtureRow(a!);
    await post(s.auth, a!, "core.start");
    await post(s.auth, a!, "boardgame.result", { winner: fa.home_entrant_id, method: "checkmate" });
    expect((await fixtureRow(a!)).status).toBe("decided");
    // The legacy rows: written before W2b refused the methods (raw SQL, the pre-W2b ledger shape).
    const fb = await fixtureRow(b!);
    await insertLegacyEvents(b!, [
      { type: "core.start", payload: {} },
      { type: "boardgame.result", payload: { winner: null, method: "double_forfeit" } }, // legacy row
    ]);
    const folded = await withTenant(s.auth.orgId, (tx) => foldFixture(tx, b!));
    expect(folded?.outcome, "a legacy double forfeit replays to the double walkover (BG-DW-1)").toEqual({ kind: "double_walkover" });
    // A new append over the legacy stream is accepted (the prior events replay; only the candidate is judged), and
    // its status follows D7 rule 4 for the legacy shape (finding 5).
    const out = await post(s.auth, b!, "core.note", { text: "arbiter's report filed" });
    expect([out.status, (await fixtureRow(b!)).outcome]).toEqual(["forfeited", { kind: "double_walkover" }]);
    expect(fb.status, "rig: the legacy fixture had no status write").toBe("scheduled");
  });

  it("D19 / X-DW-3: a double walkover is refused DOUBLE_WALKOVER_NO_NEXT_MATCH wherever the fixture feeds no seat; the fixture stays scheduled", async () => {
    // single-sport: badminton. The guard reads the stage's feed graph, never the sport.
    const both = { reason: "walkover" } as const;
    const refusals: string[] = [];
    const refuse = async (auth: AuthCtx, id: string, label: string) => {
      const r = await fixtureRow(id);
      expect([r.winner_to_fixture, r.loser_to_fixture], `${label}: rig, the fixture feeds no seat`).toEqual([null, null]);
      expect(r.home_entrant_id !== null && r.away_entrant_id !== null, `${label}: rig, both seats filled`).toBe(true);
      const before = await snap(id);
      await expect(post(auth, id, "core.forfeit", { by: "both", ...both }), label).rejects.toEqual(isEngine("DOUBLE_WALKOVER_NO_NEXT_MATCH"));
      await unchanged(id, before, label);
      expect(before.status, label).toBe("scheduled");
      refusals.push(label);
    };
    // A knockout of two: its one line is the final.
    const ko2 = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 2 });
    await refuse(ko2.auth, ko2.fixtureIds[0]!, "knockout final");
    // A knockout of four with a third-place match: both semis played, so the final and the third-place line are seated.
    const ko4 = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4, stageConfig: { thirdPlace: true } });
    const [sf1, sf2] = ko4.fixtureIds;
    const s1 = await playBadminton(ko4.auth, sf1!, true);
    await playBadminton(ko4.auth, sf2!, true);
    await refuse(ko4.auth, s1.winner_to_fixture!, "knockout final (with a third-place match)");
    await refuse(ko4.auth, s1.loser_to_fixture!, "knockout third-place match");
    // A stepladder of four: play each rung until the last one is seated.
    const sl = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "stepladder", entrants: 4 });
    for (let guard = 0; ; guard++) {
      if (guard > 4) throw new Error("stepladder: the last rung never seated");
      const rows = await rowsOf(sl.stageId);
      const last = rows.find((r) => r.winner_to_fixture === null && r.loser_to_fixture === null)!;
      if (last.home_entrant_id !== null && last.away_entrant_id !== null) {
        await refuse(sl.auth, last.id, "stepladder last rung");
        break;
      }
      const next = rows.find((r) => r.status === "scheduled" && r.home_entrant_id && r.away_entrant_id)!;
      await playBadminton(sl.auth, next.id, true);
    }
    // A page playoff of four: q1, the eliminator and q2 played, so the final is seated.
    const pp = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "page_playoff", entrants: 4 });
    for (const key of ["pp-q1", "pp-elim", "pp-q2"]) {
      const r = (await rowsOf(pp.stageId)).find((x) => x.ext_key === key)!;
      await playBadminton(pp.auth, r.id, true);
    }
    await refuse(pp.auth, (await rowsOf(pp.stageId)).find((x) => x.ext_key === "pp-final")!.id, "page_playoff final");
    expect(refusals).toHaveLength(5);
  });

  it("D19 positive pair: a semi-final (it feeds the final) and a ladder challenge (no edge by design) accept a double walkover", async () => {
    // single-sport: as above.
    const ko4 = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 });
    const sf = ko4.fixtureIds[0]!;
    const out = await post(ko4.auth, sf, "core.forfeit", { by: "both", reason: "walkover" });
    expect([out.status, out.outcome]).toEqual(["forfeited", { kind: "double_walkover" }]);
    const ladder = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "ladder", entrants: 4 });
    const challenge = await fixtureRow(ladder.fixtureIds[0]!);
    expect([challenge.winner_to_fixture, challenge.loser_to_fixture], "rig: a ladder challenge feeds no seat").toEqual([null, null]);
    const before = (await sql<{ config: { ladder_order?: string[] } }[]>`select config from stages where id = ${ladder.stageId}`)[0]!.config.ladder_order;
    const lo = await post(ladder.auth, challenge.id, "core.forfeit", { by: "both", reason: "walkover" });
    expect([lo.status, lo.outcome]).toEqual(["forfeited", { kind: "double_walkover" }]);
    const after = (await sql<{ config: { ladder_order?: string[] } }[]>`select config from stages where id = ${ladder.stageId}`)[0]!.config.ladder_order;
    expect(after, "a ladder double walkover leaves the positions unchanged").toEqual(before);
  });

  it("PF-2: reason withdrew and core.abandon{expunge:true} are refused INVALID_EVENT cascade_only from every writer but the withdrawal cascade", async () => {
    // single-sport: badminton; the guard reads the payload, never the sport.
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "league", entrants: 3 });
    const id = s.fixtureIds[0]!;
    const f = await fixtureRow(id);
    let checked = 0;
    for (const [type, payload] of [
      ["core.forfeit", { by: f.away_entrant_id, reason: "withdrew" }],
      ["core.abandon", { reason: "withdrew", expunge: true }],
    ] as const) {
      const before = await snap(id);
      await expect(post(s.auth, id, type, payload), type).rejects.toEqual(isEngine("INVALID_EVENT", "cascade_only"));
      await unchanged(id, before, type);
      checked++;
    }
    expect(checked).toBe(2);
    // Positive pair: the same writes from the cascade are accepted (and the ordinary reasons from anyone).
    const out = await scoreEvent(s.auth, id, { expected_seq: await tip(id), type: "core.forfeit", payload: { by: f.away_entrant_id, reason: "withdrew" } }, { writer: "withdrawal_cascade" });
    expect([out.status, out.outcome]).toEqual(["forfeited", { kind: "award", winner: f.home_entrant_id, loser: f.away_entrant_id, reason: "withdrew" }]);
    const g = s.fixtureIds[1]!;
    await post(s.auth, g, "core.start");
    const ab = await scoreEvent(s.auth, g, { expected_seq: await tip(g), type: "core.abandon", payload: { reason: "withdrew", expunge: true } }, { writer: "withdrawal_cascade" });
    expect([ab.status, ab.outcome]).toEqual(["abandoned", null]);
  });

  it("PF-2 / M-6: the event importer (appendEventInTx, no writer) is refused the cascade's withdrew forfeit and writes nothing; an ordinary walkover imports", async () => {
    // single-sport: generic — the importer's own rig (usecases/__tests__/_rig.ts); the guard reads the payload, never
    // the sport. The importer is the one writer besides scoreEvent (event-import.ts appendEventInTx, no writer arg).
    const { auth } = await seedOrg();
    const refused = await startedDivisionWithFixture(auth);
    const [f] = await sql<{ away: string }[]>`select away_entrant_id as away from fixtures where id = ${refused.fixtureId}`;
    const report = await importEvents(auth, refused.divisionId, {
      import_id: "imp-pf2-withdrew",
      streams: [{ fixture: { id: refused.fixtureId }, events: [{ type: "core.forfeit", payload: { by: f!.away, reason: "withdrew" } }] }],
    });
    expect(report.results, "the dry run admits it (the engine knows no writer); the writer refuses it").toEqual([
      { fixture: refused.fixtureId, status: "rejected", eventsAppended: 0, error: { code: "import.fold_rejected", engineCode: "INVALID_EVENT" } },
    ]);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${refused.fixtureId}`;
    expect(n, "nothing written").toBe(0);
    // The positive pair: the same stream with an ordinary reason imports — so the refusal above is the reason gate,
    // not the shape of the stream.
    const ok = await startedDivisionWithFixture(auth);
    const [g] = await sql<{ away: string }[]>`select away_entrant_id as away from fixtures where id = ${ok.fixtureId}`;
    const accepted = await importEvents(auth, ok.divisionId, {
      import_id: "imp-pf2-walkover",
      streams: [{ fixture: { id: ok.fixtureId }, events: [{ type: "core.forfeit", payload: { by: g!.away, reason: "walkover" } }] }],
    });
    expect(accepted.results.map((r) => [r.status, r.eventsAppended])).toEqual([["imported", 1]]);
  });

  it("PF-1: a withdrew forfeit over a league draw is refused even from the cascade (ALREADY_DECIDED withdrew_over_result); over a held knockout fixture it is admitted", async () => {
    // single-sport: football reaches a level result by play (0-0 FT) in a league AND a held bracket fixture.
    const lg = await seedBracket({ sport: "football", variant: "11-a-side", stageKind: "league", entrants: 3 });
    const id = lg.fixtureIds[0]!;
    const f = await fixtureRow(id);
    await post(lg.auth, id, "core.start");
    await post(lg.auth, id, "football.period", { phase: "HT" });
    await post(lg.auth, id, "football.period", { phase: "FT" });
    expect([(await fixtureRow(id)).status, (await fixtureRow(id)).outcome?.kind], "rig: a league draw").toEqual(["decided", "draw"]);
    const before = await snap(id);
    await expect(
      scoreEvent(lg.auth, id, { expected_seq: await tip(id), type: "core.forfeit", payload: { by: f.home_entrant_id, reason: "withdrew" } }, { writer: "withdrawal_cascade" }),
    ).rejects.toEqual(isEngine("ALREADY_DECIDED", "withdrew_over_result"));
    await unchanged(id, before, "league draw");
    // The positive pair: the held knockout fixture (needs_decision) walks over with reason withdrew (X-WD-1).
    const ko = await seedBracket({ sport: "football", variant: "11-a-side", stageKind: "knockout", entrants: 4 });
    const sf = ko.fixtureIds[0]!;
    const k = await fixtureRow(sf);
    await post(ko.auth, sf, "core.start");
    await post(ko.auth, sf, "football.period", { phase: "HT" });
    await post(ko.auth, sf, "football.period", { phase: "FT" });
    expect((await fixtureRow(sf)).status, "rig: held").toBe("needs_decision");
    const out = await scoreEvent(ko.auth, sf, { expected_seq: await tip(sf), type: "core.forfeit", payload: { by: k.home_entrant_id, reason: "withdrew" } }, { writer: "withdrawal_cascade" });
    expect([out.status, out.outcome]).toEqual(["forfeited", { kind: "award", winner: k.away_entrant_id, loser: k.home_entrant_id, reason: "withdrew" }]);
  });

  it("ST-G1 / CR-2: a cricket DLS abandon and a rain no-result in a league reach the table (CK-AB-1: the win; CK-AB-2: 1 each)", async () => {
    // single-sport: cricket is the one sport with a DLS result and a points-bearing no-result (ICC T20WC PC 16.10).
    const cfg: Record<string, unknown> = { ...declaredCfg("cricket", "t20"), dls: { enabled: true, edition: "standard" } };
    const points = cfg.points as { win: number; loss: number; noResult: number };
    const dls = await seedBracket({ sport: "cricket", variant: "t20", stageKind: "league", entrants: 2, divisionConfig: cfg });
    const id = dls.fixtureIds[0]!;
    const minBalls = (cfg.minOversForResult as number) * (cfg.ballsPerOver as number);
    await post(dls.auth, id, "core.start");
    await post(dls.auth, id, "cricket.innings.summary", { runs: 150, wickets: 5, legalBalls: cfg.ballsPerInnings });
    await post(dls.auth, id, "cricket.innings.summary", { runs: 80, wickets: 2, legalBalls: 2 * minBalls, partial: true });
    const out = await post(dls.auth, id, "core.abandon", { reason: "rain" });
    expect(out.status, "CK-AB-1: a DLS abandon with a result is decided").toBe("decided");
    const winner = (out.outcome as { winner: string }).winner;
    const rows = await standings(dls.auth, dls.stageId);
    const of = (e: string) => rows.find((r) => r.entrantId === e)!;
    const loser = rows.find((r) => r.entrantId !== winner)!.entrantId;
    expect({ w: [of(winner).won, of(winner).points], l: [of(loser).lost, of(loser).points] }).toEqual({ w: [1, points.win], l: [1, points.loss] });
    // CK-AB-2: a rain no-result before the minimum overs, 1 point each (Appendix A, the rule's own number).
    const nr = await seedBracket({ sport: "cricket", variant: "t20", stageKind: "league", entrants: 2 });
    const n = nr.fixtureIds[0]!;
    await post(nr.auth, n, "core.start");
    const nro = await post(nr.auth, n, "core.abandon", { reason: "rain" });
    expect([nro.status, (nro.outcome as { kind: string }).kind]).toEqual(["decided", "no_result"]);
    expect((await standings(nr.auth, nr.stageId)).map((r) => [r.played, r.points])).toEqual([
      [1, 1],
      [1, 1],
    ]);
    expect(declaredCfg("cricket", "t20").points, "the declared cfg agrees with CK-AB-2").toMatchObject({ noResult: 1 });
  });

  it("X-AB-1: an abandon whose sport gives no result stays out of the table (carrom, generic)", async () => {
    // Two sports whose abandon folds to no outcome (CA-AB-1, GN-AB-1); CR-2 above is the positive pair.
    let checked = 0;
    for (const [sport, variant] of [
      ["carrom", "icf"],
      ["generic", "score"],
    ] as const) {
      const s = await seedBracket({ sport, variant, stageKind: "league", entrants: 2 });
      const id = s.fixtureIds[0]!;
      await post(s.auth, id, "core.start");
      const out = await post(s.auth, id, "core.abandon", { reason: "rain" });
      expect([out.status, out.outcome], sport).toEqual(["abandoned", null]);
      expect((await standings(s.auth, s.stageId)).map((r) => [r.played, r.points]), sport).toEqual([
        [0, 0],
        [0, 0],
      ]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-AB-3: a fixture stored abandoned before W2b keeps its status on read, and moves only when a new event is appended", async () => {
    // single-sport: the cricket no-result is the abandon whose status W2b moves (ST-G1).
    const s = await seedBracket({ sport: "cricket", variant: "t20", stageKind: "league", entrants: 2 });
    const id = s.fixtureIds[0]!;
    await post(s.auth, id, "core.start");
    await post(s.auth, id, "core.abandon", { reason: "rain" });
    // The pre-W2b write: the same ledger, the status the old rule stored (no backfill, X-AB-3).
    await sql`update fixtures set status = 'abandoned' where id = ${id}`;
    const read = await getFixtureState(s.auth, id);
    expect([read.status, (await fixtureRow(id)).status], "a read never rewrites the stored status").toEqual(["abandoned", "abandoned"]);
    const out = await post(s.auth, id, "core.note", { text: "umpires' report" });
    expect([out.status, (await fixtureRow(id)).status], "the next append writes the W2b status").toEqual(["decided", "decided"]);
  });
});

// W2c Task 9 (X-PT-1, owner P-3 "A") — the seam through real `score_events`: the standings fold reads each forfeit's
// played fact from its ledger (`engine-db/forfeit-played.ts` → W2b's `playRecorded`) and hands it to `applyPointsRule`;
// the public qualification view's loader (`qualificationFixtures`) reads the same fact for the same fixture.
// single-sport: badminton is the sport whose rally is the first thing "played" (ruling 112) and whose own ledger keeps
// no generic `for` — so the rule's awarded score is told apart from the sport's credit by key. The expected points and
// score are the stage rule's own (the test's declaration); the sport's credit after play is the rule-less twin's table.
describe.skipIf(!HAS_DB)("X-PT-1 stage points read a forfeit's played fact from its ledger (W2c Task 9)", () => {
  const RULE = { base: { win: 3, draw: 1, loss: 0 }, bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [21, 0] } };
  /** A two-entrant badminton league (with or without the stage rule): `script` runs before the away side withdraws. */
  async function withdrawal(rule: boolean, script: (auth: AuthCtx, id: string, home: string) => Promise<void>) {
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "league", entrants: 2, ...(rule ? { stageConfig: { points: RULE } } : {}) });
    const id = s.fixtureIds[0]!;
    const f = await fixtureRow(id);
    await post(s.auth, id, "core.start");
    await script(s.auth, id, f.home_entrant_id!);
    // PF-2: `withdrew` is the withdrawal cascade's reason — written as the cascade writes it.
    const out = await scoreEvent(s.auth, id, { expected_seq: await tip(id), type: "core.forfeit", payload: { by: f.away_entrant_id, reason: "withdrew" } } as never, { writer: "withdrawal_cascade" });
    expect([out.status, (out.outcome as { reason?: string }).reason], "rig: the withdrawal decided the fixture").toEqual(["forfeited", "withdrew"]);
    const rows = await standings(s.auth, s.stageId);
    // The public view's read of the same fixture, under a stage that scores forfeits (the loader reads only there).
    const [qual] = await qualificationFixtures([{ ...(await fixtureRow(id)), stage_id: s.stageId, pool_id: null }], moduleOf("badminton"), [{ points_rule: RULE }]);
    return { home: rows.find((r) => r.entrantId === f.home_entrant_id)!, away: rows.find((r) => r.entrantId === f.away_entrant_id)!, qualPlayed: qual!.played };
  }
  const rally = async (auth: AuthCtx, id: string, home: string) => {
    await post(auth, id, "badminton.rally", { wonBy: home });
  };

  it("a withdrawal with NOTHING played (Start only) pays the rule's forfeit row, and its awarded score replaces for/against/diff", async () => {
    const t = await withdrawal(true, async () => {});
    expect(t.qualPlayed, "the public view reads the same fact: nothing played").toBe(false);
    expect([t.home.points, t.away.points]).toEqual([RULE.forfeit.winnerPoints, RULE.forfeit.loserPoints]);
    expect(t.home.metrics).toMatchObject({ for: 21, against: 0, diff: 21 });
    expect(t.away.metrics).toMatchObject({ for: 0, against: 21, diff: -21 });
  });

  it("a withdrawal AFTER a rally pays base points and keeps the sport's own credit — no awarded score", async () => {
    const t = await withdrawal(true, rally);
    expect(t.qualPlayed, "the public view reads the same fact: played").toBe(true);
    expect([t.home.points, t.away.points]).toEqual([RULE.base.win, RULE.base.loss]);
    expect(t.home.metrics?.for, "no awarded score: badminton keeps no generic `for`").toBeUndefined();
    // The sport's credit is the rule-less table's, key for key: the rule changed points alone.
    const twin = await withdrawal(false, rally);
    expect(Object.keys(twin.home.metrics ?? {}).length, "premise: the sport credits a ledger").toBeGreaterThan(0);
    expect([t.home.metrics, t.away.metrics]).toEqual([twin.home.metrics, twin.away.metrics]);
  });

  it("a rally the scorer voided is no play (ruling 127): the withdrawal after it is nothing played, so the forfeit row and the awarded score", async () => {
    const t = await withdrawal(true, async (auth, id, home) => {
      await rally(auth, id, home);
      const [r] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${id} and type = 'badminton.rally'`;
      await post(auth, id, "core.void", { event_id: r!.id });
    });
    expect(t.qualPlayed, "the public view reads the same fact: the void took the play back").toBe(false);
    expect([t.home.points, t.away.points]).toEqual([RULE.forfeit.winnerPoints, RULE.forfeit.loserPoints]);
    expect(t.home.metrics).toMatchObject({ for: 21, against: 0, diff: 21 });
  });
});
