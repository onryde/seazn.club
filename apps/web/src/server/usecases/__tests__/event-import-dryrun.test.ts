import { describe, expect, it, vi } from "vitest";

// W2a Task 6 — a passthrough spy on the real resolver, for the bracket-overlay case at the end of this file.
vi.mock("@/server/engine-db/fixture-cfg", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/engine-db/fixture-cfg")>();
  return { ...real, resolveFixtureCfg: vi.fn(real.resolveFixtureCfg) };
});

import { builtinModules } from "@seazn/engine/sports";
import { boardgame, DECISIVE_METHODS, DRAWN_METHODS } from "@seazn/engine/sports/boardgame";
import { carrom } from "@seazn/engine/sports/carrom";
import { cricket } from "@seazn/engine/sports/cricket";
import { tennis } from "@seazn/engine/sports/tennis";
import { sql } from "@/lib/db";
import { resolveFixtureCfg } from "@/server/engine-db/fixture-cfg";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { importEvents, IMPORT_CAPS, type ImportStreamResult } from "../event-import";
import {
  seedOrg,
  startedDivisionWithFixture,
  setupDivisionWithFixture,
  startedCricketDivisionWithFixture,
} from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("importEvents — guards and dry run", () => {
  it("rejects the whole stream when an event mid-stream is invalid, and writes NOTHING", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);

    const report = await importEvents(auth, divisionId, {
      import_id: "imp-invalid",
      streams: [{
        fixture: { id: fixtureId },
        events: [
          { type: "core.start", payload: {} },
          { type: "core.not_a_real_event", payload: {} },   // ← index 1
          { type: "core.finalize", payload: {} },
        ],
      }],
    });

    expect(report.results[0]!.status).toBe("rejected");
    expect(report.results[0]!.error?.code).toBe("import.fold_rejected");
    expect(report.results[0]!.error?.eventIndex).toBe(1);
    // The assertion that matters: the ledger, not the response.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
    expect(n).toBe(0);
  });

  // Engine lineup fix (owner ruling 2026-10-15). An import folds its whole stream under the write path (`strictFromSeq: 1`), so a
  // ledger exported from the time generic took a lineup change is refused as a stream, by name, and writes nothing. That is
  // intended: the import is a NEW write of every event in it, and the sport no longer takes this one.
  it("rejects a legacy generic stream that carries a lineup event: import.fold_rejected, LINEUP_NOT_SUPPORTED, at that event, and writes NOTHING", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const [fx] = await sql<{ home_entrant_id: string }[]>`select home_entrant_id from fixtures where id = ${fixtureId}`;

    const report = await importEvents(auth, divisionId, {
      import_id: "imp-legacy-lineup",
      streams: [{
        fixture: { id: fixtureId },
        events: [
          { type: "core.start", payload: {} },
          { type: "core.lineup.retirement", payload: { side: fx!.home_entrant_id, personId: "p-legacy" } }, // ← index 1
          { type: "generic.result", payload: { p1Score: 2, p2Score: 1 } },
        ],
      }],
    });

    expect(report.results[0]!.status).toBe("rejected");
    expect(report.results[0]!.error).toMatchObject({ code: "import.fold_rejected", eventIndex: 1, engineCode: "LINEUP_NOT_SUPPORTED" });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
    expect(n, "nothing written").toBe(0);

    // the control: the same stream without the lineup event is a clean import of the same fixture
    const clean = await importEvents(auth, divisionId, {
      import_id: "imp-legacy-lineup-clean",
      streams: [{
        fixture: { id: fixtureId },
        events: [
          { type: "core.start", payload: {} },
          { type: "generic.result", payload: { p1Score: 2, p2Score: 1 } },
        ],
      }],
    });
    expect(clean.results[0]!.error, "the control stream is not refused").toBeUndefined();
    expect(clean.results[0]!.status, "the control stream is imported").not.toBe("rejected");
  });

  // W2d T18 (HK-TB-2). The import folds every event under the write path, so an untyped `hockey.goal` is refused by name —
  // the breaking change `docs/api-v1-breaking-changes.md` (2026-10-28) documents for this route — and the same stream with
  // the goal typed imports.
  it("rejects an untyped FIH hockey goal: import.fold_rejected, GOAL_KIND_REQUIRED, at that event, and writes NOTHING; typed, it imports", async () => {
    // single-sport: FIH hockey is the one sport whose goal must record its type (`PeriodPreset.goalKindRequired`).
    const s = await seedBracket({ sport: "hockey", variant: "fih-outdoor", stageKind: "league", entrants: 2 });
    const fixtureId = s.fixtureIds[0]!;
    const [fx] = await sql<{ home: string }[]>`select home_entrant_id as home from fixtures where id = ${fixtureId}`;
    const stream = (goal: Record<string, unknown>) => [
      { type: "core.start", payload: {} },
      { type: "hockey.goal", payload: goal }, // ← index 1
      { type: "hockey.period.advance", payload: { to: "Q2" } },
      { type: "hockey.period.advance", payload: { to: "Q3" } },
      { type: "hockey.period.advance", payload: { to: "Q4" } },
      { type: "hockey.period.advance", payload: { to: "FT" } },
    ];
    const report = await importEvents(s.auth, s.divisionId, {
      import_id: "imp-untyped-hockey-goal",
      streams: [{ fixture: { id: fixtureId }, events: stream({ by: fx!.home }) }],
    });
    // No `eventIndex` is asserted: the kernel's GOAL_KIND_REQUIRED names no event (unlike LINEUP_NOT_SUPPORTED above), so
    // the report carries none today. Final-review fix report routes that; this test does not freeze its absence.
    expect(report.results[0]).toMatchObject({
      status: "rejected",
      eventsAppended: 0,
      error: { code: "import.fold_rejected", engineCode: "GOAL_KIND_REQUIRED" },
    });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
    expect(n, "nothing written").toBe(0);

    // The control: the same stream with the goal typed as a field goal imports.
    const typed = await importEvents(s.auth, s.divisionId, {
      import_id: "imp-typed-hockey-goal",
      streams: [{ fixture: { id: fixtureId }, events: stream({ by: fx!.home, kind: "fg" }) }],
    });
    expect(typed.results[0]!.error, "the typed stream is not refused").toBeUndefined();
    expect(typed.results[0]!.status, "the typed stream is imported").not.toBe("rejected");
  });

  // W2e T32 fix round 2 (item 3) — the import half of `docs/api-v1-breaking-changes.md` (2026-10-29): the import folds its
  // stream under the write path, so a football retirement of the starter a `football.sub` took off is rejected by name and
  // writes nothing, and the same stream retiring the substitute it brought on imports. single-sport: football is the one
  // sport with a second substitution vocabulary (`squadsForLineup`).
  it("W2e M12b: a football retirement is judged on the pitch a football.sub left: the starter it took off is rejected (import.fold_rejected, LINEUP_INVALID), the substitute imports", async () => {
    const s = await seedBracket({ sport: "football", variant: "11-a-side", stageKind: "league", entrants: 2 });
    const fixtureId = s.fixtureIds[0]!;
    const [fx] = await sql<{ home: string; away: string }[]>`
      select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${fixtureId}`;
    const person = async (name: string): Promise<string> => {
      const [{ id }] = await sql<{ id: string }[]>`insert into persons (org_id, full_name) values (${s.auth.orgId}, ${name}) returning id`;
      return id;
    };
    const starter = await person("M12b Starter");
    const sub = await person("M12b Substitute");
    const away = await person("M12b Away");
    for (const [entrantId, personId, slot, orderNo] of [
      [fx!.home, starter, "starting", 1],
      [fx!.home, sub, "bench", 2],
      [fx!.away, away, "starting", 1],
    ] as const) {
      await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${entrantId}, ${personId}, ${s.auth.orgId})`;
      await sql`insert into lineups (fixture_id, entrant_id, person_id, org_id, slot, order_no)
                values (${fixtureId}, ${entrantId}, ${personId}, ${s.auth.orgId}, ${slot}, ${orderNo})`;
    }
    const stream = (retiree: string) => [
      { type: "core.start", payload: {} },
      { type: "football.sub", payload: { by: fx!.home, off: starter, on: sub } },
      { type: "core.lineup.retirement", payload: { side: fx!.home, personId: retiree, reason: "injured" } }, // ← index 2
      // An import owes a decided match (`import.not_decided` otherwise): play out the 90 minutes, 1-0.
      { type: "football.goal", payload: { by: fx!.away } },
      { type: "football.period", payload: { phase: "HT" } },
      { type: "football.period", payload: { phase: "FT" } },
    ];

    const refused = await importEvents(s.auth, s.divisionId, {
      import_id: "imp-m12b-starter",
      streams: [{ fixture: { id: fixtureId }, events: stream(starter) }],
    });
    expect(refused.results[0]).toMatchObject({
      status: "rejected",
      eventsAppended: 0,
      // eventIndex 2 is the retirement itself (core.start 0, football.sub 1): the rejection names WHICH event the pitch refused,
      // not just the code, so an importer can fix the one line.
      error: { code: "import.fold_rejected", engineCode: "LINEUP_INVALID", eventIndex: 2 },
    });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
    expect(n, "nothing written").toBe(0);

    // The control: the same stream retiring the substitute football.sub brought on imports, every event of it.
    const imported = await importEvents(s.auth, s.divisionId, {
      import_id: "imp-m12b-substitute",
      streams: [{ fixture: { id: fixtureId }, events: stream(sub) }],
    });
    expect(imported.results[0]!.error, "the substitute's retirement is not refused").toBeUndefined();
    expect(imported.results[0]).toMatchObject({ eventsAppended: stream(sub).length });
    const [retired] = await sql<{ payload: { personId: string } }[]>`
      select payload from score_events where fixture_id = ${fixtureId} and type = 'core.lineup.retirement'`;
    expect(retired?.payload.personId, "the substitute's retirement is the one written").toBe(sub);
  });

  // W2e Task 2 (spec 2026-10-28 §5.2, E25). The import is the second strict write path: it folds every event under the
  // write path, so play after a match-ending sanction with no ending is refused by name, and the same stream with the
  // ending (core.forfeit{disqualified} against the sanctioned side) imports. Every declared end level, from the engine's
  // own declarations.
  it("X-SE-1 event import refuses scoring after an ending sanction: import.fold_rejected, ENDING_SANCTION_PENDING, writes NOTHING; with the ending, it imports", async () => {
    /** One point to `side` in each declaring sport's own event (test input). A declaring sport missing here reds below. */
    type Ev = { type: string; payload: Record<string, unknown> };
    const PLAY: Readonly<Record<string, (side: string) => Ev>> = {
      badminton: (side) => ({ type: "badminton.rally", payload: { wonBy: side } }),
      tennis: (side) => ({ type: "tennis.point", payload: { by: side } }),
    };
    const ends = builtinModules.flatMap((m) => (m.sanctionEnding?.endLevels ?? []).map((level) => ({ m, level })));
    expect(ends.length, "the engine declares end levels (zero = nothing checked)").toBeGreaterThan(0);
    let checked = 0;
    for (const { m, level } of ends) {
      const play = PLAY[m.key];
      expect(play, `${m.key}: a point event for this declaring sport`).toBeDefined();
      const s = await seedBracket({ sport: m.key, variant: Object.keys(m.variants)[0]!, stageKind: "league", entrants: 2 });
      const fixtureId = s.fixtureIds[0]!;
      const [fx] = await sql<{ home: string; away: string }[]>`
        select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${fixtureId}`;
      const stream = (after: Ev): Ev[] => [
        { type: "core.start", payload: {} },
        play!(fx!.home),
        { type: m.sanctionEnding!.eventType, payload: { by: fx!.away, level } },
        after, // ← index 3
      ];
      const report = await importEvents(s.auth, s.divisionId, {
        import_id: `imp-ending-pending-${m.key}-${level}`,
        streams: [{ fixture: { id: fixtureId }, events: stream(play!(fx!.home)) }],
      });
      // ENDING_SANCTION_PENDING names the sanction ({by, level}), not an event, so the report carries no eventIndex.
      expect(report.results[0], `${m.key}/${level}`).toMatchObject({
        status: "rejected",
        eventsAppended: 0,
        error: { code: "import.fold_rejected", engineCode: "ENDING_SANCTION_PENDING" },
      });
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
      expect(n, `${m.key}/${level}: nothing written`).toBe(0);

      // The control: the same stream with the ending after the sanction imports, and the match is decided by it.
      const ended = await importEvents(s.auth, s.divisionId, {
        import_id: `imp-ending-recorded-${m.key}-${level}`,
        streams: [{ fixture: { id: fixtureId }, events: stream({ type: "core.forfeit", payload: { by: fx!.away, reason: "disqualified" } }) }],
      });
      expect(ended.results[0]!.error, `${m.key}/${level}: the ended stream is not refused`).toBeUndefined();
      expect(ended.results[0]!.status, `${m.key}/${level}: the ended stream is imported`).not.toBe("rejected");
      checked++;
    }
    expect(checked).toBe(ends.length);
  });

  // Final review M-1 (W2e PR A; ledger carry T10 M3). The import is the second STRICT write path, so each refusal W2e added to
  // the engine's strict fold reaches an importer by name: `import.fold_rejected` carrying the engine's own code, nothing
  // written, and the same shape with a LEGAL value imported (the control that makes the refusal mean something). The cases
  // below cover the four codes the case above does not (ENDING_SANCTION_PENDING is that one). Every refused value is built
  // from the engine's own declarations (a variant's config, the engine's method lists) and the rulebook's rule, never typed.
  //
  // Which guard each case witnesses (mutation, final review M-1): `engineCode: err.code` in the envelope is witnessed by all four.
  // The dry run's `strictFromSeq: 1` (event-import.ts:310) is witnessed on its own by the tennis and carrom cases, whose refused
  // stream is UNDECIDED under a lenient fold (a lenient dry run then answers import.not_decided); a refused stream that a lenient
  // fold DECIDES (a chase total past the winning run, a result with a contradicting method) is refused a second time by the
  // append-time strict fold (append-event.ts, `strictFromSeq: candidate.seq`), in the same envelope, so the dry run's flag is not
  // observable through those two - they witness the envelope and the append path, not :310.
  type Ev = { type: string; payload: Record<string, unknown> };
  const importOne = async (s: { auth: AuthCtx; divisionId: string }, fixtureId: string, importId: string, events: Ev[]): Promise<ImportStreamResult> =>
    (await importEvents(s.auth, s.divisionId, { import_id: importId, streams: [{ fixture: { id: fixtureId }, events }] })).results[0]!;
  const writtenCount = async (fixtureId: string): Promise<number> =>
    (await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${fixtureId}`)[0]!.n;
  /** The refusal: rejected under `import.fold_rejected` with the engine's code, no event appended, nothing in the ledger. */
  const expectFoldRefused = async (result: ImportStreamResult, fixtureId: string, engineCode: string, label: string): Promise<void> => {
    expect(result, label).toMatchObject({ status: "rejected", eventsAppended: 0, error: { code: "import.fold_rejected", engineCode } });
    expect(await writtenCount(fixtureId), `${label}: nothing written`).toBe(0);
  };
  /** The control: imported, every event of the stream in the ledger. */
  const expectImported = async (result: ImportStreamResult, fixtureId: string, events: Ev[], label: string): Promise<void> => {
    expect(result.error, `${label}: the legal stream is not refused`).toBeUndefined();
    expect(result.status, `${label}: the legal stream is imported`).toBe("imported");
    expect(await writtenCount(fixtureId), `${label}: every event of the stream is in the ledger`).toBe(events.length);
  };

  it("TN-SS-1 event import refuses a set score no set can reach: import.fold_rejected, SET_SCORE_UNREACHABLE, writes NOTHING; the legal score imports", async () => {
    // single-sport: only tennis's nested kernel judges a games score (SET_SCORE_UNREACHABLE); the sweep is every variant tennis declares
    // that plays a set tie-break (a set with none is an advantage set: no finished plain score is unreachable there).
    const declared = Object.keys(tennis.variants).map((key) => ({ key, cfg: tennis.configSchema.parse(tennis.variants[key]) }));
    const withTiebreak = declared.filter((v) => v.cfg.set.tiebreakAt !== null);
    expect(withTiebreak.length, "tennis declares variants that play a set tie-break (zero = nothing checked)").toBeGreaterThan(0);
    let checked = 0;
    for (const { key, cfg } of withTiebreak) {
      const { gamesTo, winBy } = cfg.set;
      const tiebreakAt = cfg.set.tiebreakAt!;
      // ITF Rule 6b / App VI: at tiebreakAt-all the next game is the tie-break, so a finished plain score never has the loser at
      // tiebreakAt or more (RBS:343/345/346/350: 8-6 in a tie-break set, 5-3 at TB-3, 6-4 at TB-4 are impossible). The smallest
      // such score: the loser at tiebreakAt, the winner a winBy lead ahead and at least gamesTo.
      const refused = { winner: Math.max(gamesTo, tiebreakAt + winBy), loser: tiebreakAt };
      // The legal plain final: gamesTo to gamesTo - winBy (6-4, 4-2).
      const legal = { winner: gamesTo, loser: gamesTo - winBy };
      expect(winBy, `${key}: premise, a lead of one would make the refused score the tie-break score itself`).toBeGreaterThan(1);
      expect(legal.loser, `${key}: premise, the legal final sits below the tie-break entry`).toBeLessThan(tiebreakAt);
      const s = await seedBracket({ sport: "tennis", variant: key, stageKind: "league", entrants: 2 });
      const fixtureId = s.fixtureIds[0]!;
      const summary = (score: { winner: number; loser: number }): Ev => ({ type: "tennis.set_summary", payload: { home: score.winner, away: score.loser } });
      const refusedStream: Ev[] = [{ type: "core.start", payload: {} }, summary(refused)];
      await expectFoldRefused(await importOne(s, fixtureId, `imp-set-unreachable-${key}`, refusedStream), fixtureId, "SET_SCORE_UNREACHABLE", `${key} ${refused.winner}-${refused.loser}`);
      // The control: the legal score in as many sets as win the match (a majority of the best of), by the same side.
      const setsToWin = Math.ceil(cfg.bestOf / 2);
      const legalStream: Ev[] = [{ type: "core.start", payload: {} }, ...Array.from({ length: setsToWin }, () => summary(legal))];
      await expectImported(await importOne(s, fixtureId, `imp-set-reachable-${key}`, legalStream), fixtureId, legalStream, `${key} ${legal.winner}-${legal.loser}`);
      checked++;
    }
    expect(checked).toBe(withTiebreak.length);
  });

  it("CK-CH-1 event import refuses a coarse chase total past the winning run: import.fold_rejected, CHASE_OVERSHOOT, writes NOTHING; the winning run itself imports", async () => {
    // single-sport: a chase and its target exist only in cricket's innings model. The sweep is every variant cricket declares.
    // The bound is the Laws' (ICC T20 World Cup 2026 Playing Conditions 16.5.1/16.5.3; RBS:433, RB2A-22): a chase ends AT the winning
    // run, so from one run short the most one delivery adds is a no-ball (1) hit for six (6).
    const NO_BALL = 1;
    const SIX = 6;
    const boundOf = (target: number): number => target - 1 + NO_BALL + SIX;
    const variants = Object.keys(cricket.variants).map((key) => ({ key, cfg: cricket.configSchema.parse(cricket.variants[key]) }));
    expect(variants.length, "cricket declares variants (zero = nothing checked)").toBeGreaterThan(0);
    const summary = (runs: number, wickets: number, legalBalls: number): Ev => ({ type: "cricket.innings.summary", payload: { runs, wickets, legalBalls } });
    let checked = 0;
    for (const { key, cfg } of variants) {
      // The innings before the chase, all out, and the target the Laws give the chase: one more than the other side's total
      // (one innings a side), or one more than its aggregate lead (two a side: H 200 + 100 against A 150 first).
      const quota = cfg.ballsPerInnings ?? 400;
      const before: Ev[] = cfg.inningsPerSide === 1
        ? [summary(99, 10, Math.min(60, quota))]
        : [summary(200, 10, quota), summary(150, 10, quota), summary(100, 10, quota)];
      const target = cfg.inningsPerSide === 1 ? 99 + 1 : 200 + 100 - 150 + 1;
      const s = await seedBracket({ sport: "cricket", variant: key, stageKind: "league", entrants: 2 });
      const fixtureId = s.fixtureIds[0]!;
      const stream = (chaseRuns: number): Ev[] => [{ type: "core.start", payload: {} }, ...before, summary(chaseRuns, 2, 30)];
      await expectFoldRefused(await importOne(s, fixtureId, `imp-chase-overshoot-${key}`, stream(boundOf(target) + 1)), fixtureId, "CHASE_OVERSHOOT", `${key} chase ${boundOf(target) + 1} of target ${target}`);
      // The control: the winning run's own bound is a chase total the engine takes, and it ends the match.
      await expectImported(await importOne(s, fixtureId, `imp-chase-at-bound-${key}`, stream(boundOf(target))), fixtureId, stream(boundOf(target)), `${key} chase ${boundOf(target)} of target ${target}`);
      checked++;
    }
    expect(checked).toBe(variants.length);
  });

  it("BG-RS-1 event import refuses a result whose method contradicts its winner: import.fold_rejected, RESULT_METHOD_CONTRADICTS_WINNER, writes NOTHING; the agreeing result imports", async () => {
    // single-sport: boardgame is the one sport whose result carries a method (the engine's DECISIVE_METHODS / DRAWN_METHODS, the
    // pad's own partition of FIDE Laws 5.1, 5.2 and 9.2-9.6). `adjudication` is in both lists and is free either way.
    const decisiveOnly = DECISIVE_METHODS.filter((m) => !(DRAWN_METHODS as readonly string[]).includes(m));
    const drawnOnly = DRAWN_METHODS.filter((m) => !(DECISIVE_METHODS as readonly string[]).includes(m));
    expect(decisiveOnly.length, "decisive-only methods (zero = nothing checked)").toBeGreaterThan(0);
    expect(drawnOnly.length, "drawn-only methods (zero = nothing checked)").toBeGreaterThan(0);
    // three fixtures: the refusals (which write nothing, so they share one) and one control per direction.
    const s = await seedBracket({ sport: "boardgame", variant: Object.keys(boardgame.variants)[0]!, stageKind: "league", entrants: 3 });
    const [refusals, decisiveControl, drawnControl] = s.fixtureIds as [string, string, string];
    const [fx] = await sql<{ home: string }[]>`select home_entrant_id as home from fixtures where id = ${refusals}`;
    const stream = (result: Record<string, unknown>): Ev[] => [{ type: "core.start", payload: {} }, { type: "boardgame.result", payload: result }];
    let refused = 0;
    for (const method of decisiveOnly) {
      // a win-only method with no winner (null, and the key left out)
      for (const result of [{ winner: null, method }, { method }]) {
        await expectFoldRefused(await importOne(s, refusals, `imp-bg-${method}-${refused}`, stream(result)), refusals, "RESULT_METHOD_CONTRADICTS_WINNER", `${method} ${JSON.stringify(result)}`);
        refused++;
      }
    }
    for (const method of drawnOnly) {
      // a draw-only method with a winner
      await expectFoldRefused(await importOne(s, refusals, `imp-bg-${method}-${refused}`, stream({ winner: fx!.home, method })), refusals, "RESULT_METHOD_CONTRADICTS_WINNER", `${method} with a winner`);
      refused++;
    }
    expect(refused, "refusals checked").toBe(decisiveOnly.length * 2 + drawnOnly.length);
    // The controls: the agreeing shape of each direction imports.
    const decisiveStream = stream({ winner: fx!.home, method: decisiveOnly[0]! });
    await expectImported(await importOne(s, decisiveControl, "imp-bg-decisive-agrees", decisiveStream), decisiveControl, decisiveStream, `${decisiveOnly[0]} with a winner`);
    const drawnStream = stream({ winner: null, method: drawnOnly[0]! });
    await expectImported(await importOne(s, drawnControl, "imp-bg-drawn-agrees", drawnStream), drawnControl, drawnStream, `${drawnOnly[0]} without a winner`);
  });

  it("CA-AD-1 event import refuses a carrom adjustment past the game target: import.fold_rejected, ADJUST_OUT_OF_RANGE, writes NOTHING; the whole target imports", async () => {
    // single-sport: carrom is the one sport with a score adjustment bounded by its game target (`gameTo`, ICF Law 56a). The sweep is
    // every variant carrom declares, both directions of the adjustment (a credit past the target, a deduction past it).
    const variants = Object.keys(carrom.variants).map((key) => ({ key, cfg: carrom.configSchema.parse(carrom.variants[key]) }));
    expect(variants.length, "carrom declares variants (zero = nothing checked)").toBeGreaterThan(0);
    let checked = 0;
    for (const { key, cfg } of variants) {
      const g = cfg.gameTo;
      const s = await seedBracket({ sport: "carrom", variant: key, stageKind: "league", entrants: 2 });
      const fixtureId = s.fixtureIds[0]!;
      const [fx] = await sql<{ home: string }[]>`select home_entrant_id as home from fixtures where id = ${fixtureId}`;
      const adjust = (delta: number): Ev => ({ type: "carrom.game.adjust", payload: { entrantId: fx!.home, delta, reason: "foul" } });
      for (const delta of [g + 1, -(g + 1)]) {
        const stream: Ev[] = [{ type: "core.start", payload: {} }, adjust(delta)];
        await expectFoldRefused(await importOne(s, fixtureId, `imp-adjust-${key}-${delta}`, stream), fixtureId, "ADJUST_OUT_OF_RANGE", `${key} adjust ${delta} past gameTo ${g}`);
        checked++;
      }
      // The control: the whole target in one credit closes a game for that side (Law 56a), and a majority of the best of games
      // (Law 57) decides the match.
      const gamesToWin = Math.ceil(cfg.bestOf / 2);
      const legalStream: Ev[] = [{ type: "core.start", payload: {} }, ...Array.from({ length: gamesToWin }, () => adjust(g))];
      await expectImported(await importOne(s, fixtureId, `imp-adjust-at-target-${key}`, legalStream), fixtureId, legalStream, `${key} adjust +${g}`);
    }
    expect(checked, "refused adjustments").toBe(variants.length * 2);
  });

  it("rejects a fixture that already has events", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    await sql`insert into score_events (fixture_id, org_id, seq, type, payload)
              values (${fixtureId}, ${auth.orgId}, 1, 'core.start', '{}'::jsonb)`;

    const report = await importEvents(auth, divisionId, {
      import_id: "imp-started",
      streams: [{ fixture: { id: fixtureId }, events: [{ type: "core.start", payload: {} }] }],
    });
    expect(report.results[0]!.error?.code).toBe("import.fixture_started");
  });

  it("refuses the whole call when the division has not started", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await setupDivisionWithFixture(auth);
    await expect(
      importEvents(auth, divisionId, {
        import_id: "imp-phase",
        streams: [{ fixture: { id: fixtureId }, events: [{ type: "core.start", payload: {} }] }],
      }),
    ).rejects.toMatchObject({ status: 409, code: "import.division_not_started" });
  });

  it("rejects a stream that never reaches a decided outcome", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const report = await importEvents(auth, divisionId, {
      import_id: "imp-open",
      streams: [{ fixture: { id: fixtureId }, events: [{ type: "core.start", payload: {} }] }],
    });
    expect(report.results[0]!.error?.code).toBe("import.not_decided");
  });

  // Final review I-6. There used to be ONE cap test, built as
  // `eventsPerCall + 1` events in a single stream — which trips the PER-FIXTURE
  // ceiling first (assertWithinCaps checks streams → per-fixture → per-call, and
  // 10,001 > 1,000), so the per-call branch it was named after was never
  // reached. Design doc §9 asks for all three, and each case now pins
  // `error.cap` as well as the status and code: without that field the three
  // are indistinguishable from each other and any one of them can stand in for
  // the other two.
  it("413s a call over the STREAMS cap", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const streams = Array.from({ length: IMPORT_CAPS.streams + 1 }, () => ({
      fixture: { id: fixtureId },
      events: [{ type: "core.start", payload: {} }],
    }));
    await expect(
      importEvents(auth, divisionId, { import_id: "imp-many-streams", streams }),
    ).rejects.toMatchObject({
      status: 413,
      code: "import.too_large",
      extra: { cap: "streams", limit: IMPORT_CAPS.streams, actual: IMPORT_CAPS.streams + 1 },
    });
  });

  it("413s a call over the per-FIXTURE event cap", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const events = Array.from({ length: IMPORT_CAPS.eventsPerFixture + 1 }, () => ({
      type: "core.start", payload: {},
    }));
    await expect(
      importEvents(auth, divisionId, { import_id: "imp-big-fixture", streams: [{ fixture: { id: fixtureId }, events }] }),
    ).rejects.toMatchObject({
      status: 413,
      code: "import.too_large",
      extra: {
        cap: "eventsPerFixture",
        limit: IMPORT_CAPS.eventsPerFixture,
        actual: IMPORT_CAPS.eventsPerFixture + 1,
      },
    });
  });

  it("413s a call over the per-CALL event cap", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    // Every individual stream sits exactly ON the per-fixture ceiling (1,000,
    // not over it) and the stream count is well under 50, so the first two
    // checks pass and this is the only branch that can fire — which is exactly
    // what the old single test could not arrange.
    const events = Array.from({ length: IMPORT_CAPS.eventsPerFixture }, () => ({
      type: "core.start", payload: {},
    }));
    const streamCount = Math.floor(IMPORT_CAPS.eventsPerCall / IMPORT_CAPS.eventsPerFixture) + 1;
    const streams = Array.from({ length: streamCount }, () => ({ fixture: { id: fixtureId }, events }));
    await expect(
      importEvents(auth, divisionId, { import_id: "imp-big-call", streams }),
    ).rejects.toMatchObject({
      status: 413,
      code: "import.too_large",
      extra: {
        cap: "eventsPerCall",
        limit: IMPORT_CAPS.eventsPerCall,
        actual: streamCount * IMPORT_CAPS.eventsPerFixture,
      },
    });
  });

  it("rejects an ext_key that matches two fixtures in the division", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureIds } = await startedDivisionWithFixture(auth, { fixtures: 2 });
    await sql`update fixtures set ext_key = 'M1' where id in ${sql(fixtureIds)}`;
    const report = await importEvents(auth, divisionId, {
      import_id: "imp-ambig",
      streams: [{ fixture: { ext_key: "M1" }, events: [{ type: "core.start", payload: {} }] }],
    });
    expect(report.results[0]!.error).toMatchObject({ code: "import.fixture_unknown", matches: 2 });
  });

  // Added beyond the brief's verbatim list (standing rule: every change ships
  // a test that fails without it) — the brief's own step 4 names
  // import.slots_unfilled as one of the six guards runStream must implement,
  // but neither task's test file exercises it.
  it("rejects a fixture with an unassigned entrant (bye/TBD)", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    await sql`update fixtures set away_entrant_id = null where id = ${fixtureId}`;

    const report = await importEvents(auth, divisionId, {
      import_id: "imp-unfilled",
      streams: [{ fixture: { id: fixtureId }, events: [{ type: "core.start", payload: {} }] }],
    });
    expect(report.results[0]!.error?.code).toBe("import.slots_unfilled");
  });

  // W1 (entitlements v18, 2026-09-02): formerly "rejects a tier-3 event when
  // the org lacks the entitlement (import.entitlement)" — asserted
  // `{code: "import.entitlement", feature: "scoring.ball_by_ball"}` for a
  // bare `cricket.ball` import. Scoring detail is free on every plan now, so
  // `requiredFeatures` never gains that key at all; rewritten to prove the
  // NEGATIVE directly — the same import still fails (this fixture has no
  // lineup declared, `startedCricketDivisionWithFixture`'s own doc), but
  // never for `import.entitlement` any more.
  it("no longer requires an entitlement for a tier-3 event — cricket.ball fails for a different reason", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedCricketDivisionWithFixture(auth);

    const report = await importEvents(auth, divisionId, {
      import_id: "imp-entitlement-gone",
      streams: [{ fixture: { id: fixtureId }, events: [{ type: "cricket.ball", payload: {} }] }],
    });
    // Fix round 1, M-1: pin the ACTUAL code, not just "not import.entitlement"
    // — that alone passes when `error` is `undefined` or the code is
    // anything at all. This fixture has no lineup (`startedCricketDivision
    // WithFixture`'s own doc: seeded with zero members), so the dry-run fold
    // itself refuses the bare `{}` payload with `WRONG_PHASE` before ever
    // reaching a real ball — a structural fold rejection, observed directly
    // (not assumed), pinned so both facts hold: not gated by entitlement, AND
    // failing for the specific reason this test's title claims.
    expect(report.results[0]!.error).toMatchObject({
      code: "import.fold_rejected",
      engineCode: "WRONG_PHASE",
    });
  });

  // Final review C-2: a SECOND entitlement gate the fidelity map cannot
  // express. W1 deletes `requiredFeatureForEvent` and the fidelity gate it
  // drove entirely (scoring detail is free on every plan) — this gate is
  // untouched: a `cricket.revise` with no manual umpire target, under a
  // division whose config enables DLS, is exactly what makes the fold
  // compute a Duckworth-Lewis-Stern target, which is Pro-only at the live
  // scoring door (scoring.ts's `requiresDlsEntitlement`). Without the
  // import-side counterpart a non-entitled org buys a DLS target by
  // importing instead of scoring.
  it("rejects a DLS-computed cricket.revise when the org is denied cricket.dls (import.entitlement)", async () => {
    // V393 (entitlements v18 §2) granted `cricket.dls` on every plan, so no
    // plan withholds it. The import-side gate is still live code and still has
    // to match `scoreEvent`'s, so a DENY override is what drives it.
    const { auth } = await seedOrg();
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${auth.orgId}, 'cricket.dls', false, 'test')
      on conflict (org_id, feature_key) do update set bool_value = false`;
    await invalidateOrgEntitlements(auth.orgId);
    const { divisionId, fixtureId } = await startedCricketDivisionWithFixture(auth);
    // The division-level config is what BOTH paths read (owner ruling R-B) —
    // not the fixture's cfg snapshot — so parity with `scoreEvent` is
    // byte-for-byte rather than approximate.
    await sql`
      update divisions set config = config || '{"dls":{"enabled":true}}'::jsonb
      where id = ${divisionId}`;

    const report = await importEvents(auth, divisionId, {
      import_id: "imp-dls",
      streams: [{ fixture: { id: fixtureId }, events: [{ type: "cricket.revise", payload: {} }] }],
    });
    expect(report.results[0]!.error).toMatchObject({
      code: "import.entitlement",
      feature: "cricket.dls",
    });
  });

  // Non-vacuousness control: an IDENTICAL stream with a manual umpire target is
  // not a DLS computation at all and must sail past the gate — so this rejects
  // for a different reason (the fold, which this fixture has no lineups for),
  // never `import.entitlement`. Without it, a "fix" that demanded `cricket.dls`
  // for every `cricket.revise` would pass the case above.
  it("negative control: a cricket.revise WITH a manual target never asks for cricket.dls", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedCricketDivisionWithFixture(auth);
    await sql`
      update divisions set config = config || '{"dls":{"enabled":true}}'::jsonb
      where id = ${divisionId}`;

    const report = await importEvents(auth, divisionId, {
      import_id: "imp-dls-manual",
      streams: [{
        fixture: { id: fixtureId },
        events: [{ type: "cricket.revise", payload: { target: 148 } }],
      }],
    });
    expect(report.results[0]!.error?.code).not.toBe("import.entitlement");
  });
});

describe.skipIf(!HAS_DB)("bracket overlay reaches every resolveFixtureCfg caller (spec §5.4.1, W2a Task 6)", () => {
  it("event-import.ts importEvents", async () => {
    // The dry-run fold resolves the fixture's cfg before it judges the stream; a start-only stream is then
    // refused not_decided, which writes nothing — the cfg it was judged under is what this case reads.
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    const spy = vi.mocked(resolveFixtureCfg);
    spy.mockClear();
    const report = await importEvents(s.auth, s.divisionId, {
      import_id: "imp-w2a-overlay",
      streams: [{ fixture: { id: s.fixtureIds[0]! }, events: [{ type: "core.start", payload: {} }] }],
    });
    expect(report.results[0]!.error?.code).toBe("import.not_decided"); // the fold ran (a refusal earlier would skip it)
    const calls = spy.mock.calls.map((c, i) => ({
      kind: (c[2] as { kind?: string } | null | undefined)?.kind ?? null,
      out: spy.mock.results[i]!.value as Record<string, unknown> | null,
    }));
    expect(calls.length, "the entry never called resolveFixtureCfg").toBeGreaterThan(0);
    expect(calls.some((c) => c.kind === "knockout" && c.out?.tiebreak === true), JSON.stringify(calls)).toBe(true);
  });
});
