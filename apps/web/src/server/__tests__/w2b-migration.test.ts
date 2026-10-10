// W2b Task 9 (spec §5.4; plan D12, D13) — the W2b delta: (1) an UNSETTLED held bracket fixture whose active result is
// the legacy chess double forfeit is re-classified as a double walkover (BG-DW-1), (2) `division_has_results` counts
// only results with a verdict (W2b-R13). The delta is read by GLOB, never by number (it is renumbered at merge), and
// its OWN statements run here — inside rolled-back transactions on a dedicated client, because the block and the
// function act on the whole shared test DB (a BYPASSRLS `unsafe` would otherwise rewrite sibling suites' rows).
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { BRACKET_KINDS } from "@seazn/engine/core";
import { boardgame } from "@seazn/engine/sports/boardgame";
import { defaultLineupPair } from "@seazn/engine/testkit";
import { connectionOptions, sql } from "@/lib/db";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { buildMatchCentre, type MatchCentreInput } from "@/server/public-site/match-centre";
import type { PublicFixture } from "@/server/public-site/data";
import type { SideT } from "@/server/public-site/match-centre-schema";
import { resolveBracketSeats } from "@/server/usecases/stages";
import { scoreEvent } from "@/server/usecases/scoring";

const HAS_DB = !!process.env.DATABASE_URL;
const DELTAS = resolve(__dirname, "../../../../../db/migration/deltas");
const NAME = /^V\d+__w2b_double_walkover_and_results\.sql$/;
const files = readdirSync(DELTAS).filter((f) => NAME.test(f));
const text = files.length === 1 ? readFileSync(resolve(DELTAS, files[0]!), "utf8") : "";
/** The statements, comments removed: a `--` line naming a literal must not satisfy a regex meant for the SQL. */
const code = text.replace(/--.*$/gm, "");
const BLOCK = /do \$\$[\s\S]*?end \$\$;/.exec(code)?.[0];
const FUNCTION = /create or replace function division_has_results[\s\S]*?\$\$;/.exec(code)?.[0];

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const literalSet = (inner: string) => new Set(inner.replace(/\s/g, "").split(",").map((s) => s.replace(/'/g, "")));
const quoted = (s: string) => new Set([...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!));

type Tx = postgres.TransactionSql;
const ROLLBACK = new Error("rollback");

/** `body` on its own one-connection client inside a transaction that is always rolled back; the notices it raised. */
async function rolledBack<T>(body: (tx: Tx) => Promise<T>): Promise<{ value: T; notices: string[] }> {
  const url = process.env.DATABASE_URL!;
  const notices: string[] = [];
  const client = postgres(url, {
    max: 1,
    ssl: connectionOptions(url).ssl,
    connection: { search_path: connectionOptions(url).schema },
    onnotice: (n) => notices.push(String(n.message)),
  });
  let value: T | undefined;
  try {
    await expect(
      client.begin(async (tx) => {
        value = await body(tx);
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  } finally {
    await client.end();
  }
  return { value: value as T, notices };
}

/** The block's one notice, parsed. */
function counts(notices: string[]): { examined: number; changed: number } {
  const mine = notices.filter((n) => n.startsWith("W2b double walkover reclassify"));
  expect(mine, "exactly one W2b notice").toHaveLength(1);
  const m = /examined=(\d+) changed=(\d+)/.exec(mine[0]!);
  expect(m, mine[0]).not.toBeNull();
  return { examined: Number(m![1]), changed: Number(m![2]) };
}

const chess = { sport: "boardgame", variant: declaredVariant("boardgame", "classical") };
/** The legacy (pre-W2b) chess double forfeit, as the pad wrote it before D15 retired the method. */
const DF = { winner: null, method: "double_forfeit" };
/** What V432 stored for it: a held no_result. */
const LEGACY_HELD = { kind: "no_result", method: "double_forfeit" };

/** Append raw ledger rows (the write path refuses the retired method now — that is the point of a legacy row). */
async function ledger(tx: Tx, fixtureId: string, rows: { type: string; payload: unknown; voids?: number }[]): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, r] of rows.entries()) {
    const voids = r.voids === undefined ? null : ids[r.voids - 1]!;
    const [e] = await tx<{ id: string }[]>`
      insert into score_events (fixture_id, seq, type, payload, voids_event_id)
      values (${fixtureId}, ${i + 1}, ${r.type}, ${tx.json(r.payload as never)}, ${voids}) returning id`;
    ids.push(e!.id);
  }
  return ids;
}
const held = (tx: Tx, id: string) =>
  tx`update fixtures set status = 'needs_decision', outcome = ${tx.json(LEGACY_HELD as never)} where id = ${id}`;
const rowOf = async (tx: Tx, id: string) =>
  (await tx<{ status: string; outcome: unknown; finished: boolean }[]>`
    select status, outcome, finished_at is not null as finished from fixtures where id = ${id}`)[0]!;

describe("W2b migration — its text (no DB)", () => {
  it("the delta exists exactly once, by name pattern, and holds the block and the function", () => {
    expect(files, `one ${NAME} in db/migration/deltas`).toHaveLength(1);
    expect(BLOCK, "a do block").toBeDefined();
    expect(FUNCTION, "division_has_results").toBeDefined();
  });
  it("the SQL bracket-kind literal is exactly the engine's BRACKET_KINDS", () => {
    const m = /s\.kind in \(([^)]*)\)/.exec(code);
    expect(m).not.toBeNull();
    expect(literalSet(m![1]!)).toEqual(new Set(BRACKET_KINDS));
  });
});

describe.skipIf(!HAS_DB)("W2b migration — BG-DW-1 re-classification (plan D12)", () => {
  it("empty case first: with our row NOT held the block examines none of ours, and the test FAILS unless the seeded held row is examined (exactly one more)", async () => {
    const s = await seedBracket({ ...chess, stageKind: "knockout", entrants: 2 });
    const id = s.fixtureIds[0]!;
    const run = (hold: boolean) =>
      rolledBack(async (tx) => {
        if (hold) {
          await ledger(tx, id, [{ type: "core.start", payload: {} }, { type: "boardgame.result", payload: DF }]);
          await held(tx, id);
        }
        await tx.unsafe(BLOCK!);
        return rowOf(tx, id);
      });
    const idle = await run(false);
    const seeded = await run(true);
    const [a, b] = [counts(idle.notices), counts(seeded.notices)];
    expect(idle.value.status, "the empty case touches nothing of ours").toBe("scheduled");
    expect(b.examined - a.examined, "the seeded row is examined — exactly one more than without it").toBe(1);
    expect(b.changed - a.changed).toBe(1);
    expect([a.examined, a.changed, b.examined >= 1]).toEqual([a.changed, a.examined, true]);
  });

  it("BG-DW-1 migration: an unsettled held chess double forfeit becomes forfeited double_walkover; a settled one is untouched; a voided double forfeit is untouched; a non-bracket row is untouched", async () => {
    // Five rows, one per predicate. The settled and the league rows are HELD on purpose — the only thing that
    // separates them from the row that moves is the predicate under test (a settle; the stage kind).
    const ko = await seedBracket({ ...chess, stageKind: "knockout", entrants: 8 });
    const lg = await seedBracket({ ...chess, stageKind: "league", entrants: 2 });
    const [unsettled, laterVoided, settled, voidedDf] = ko.fixtureIds;
    const league = lg.fixtureIds[0]!;
    const { value, notices } = await rolledBack(async (tx) => {
      await ledger(tx, unsettled!, [{ type: "core.start", payload: {} }, { type: "boardgame.result", payload: DF }]);
      // The double forfeit is the ACTIVE result: a later result was entered and voided.
      const [w] = await tx<{ home: string }[]>`select home_entrant_id as home from fixtures where id = ${laterVoided!}`;
      await ledger(tx, laterVoided!, [
        { type: "core.start", payload: {} },
        { type: "boardgame.result", payload: DF },
        { type: "boardgame.result", payload: { winner: w!.home, method: "resign" } },
        { type: "core.void", payload: {}, voids: 3 },
      ]);
      const [h] = await tx<{ home: string }[]>`select home_entrant_id as home from fixtures where id = ${settled!}`;
      await ledger(tx, settled!, [
        { type: "core.start", payload: {} },
        { type: "boardgame.result", payload: DF },
        { type: "core.settle", payload: { winner: h!.home, method: "organiser" } },
      ]);
      // The double forfeit was voided; the active result is a later agreed draw (a real held level result).
      await ledger(tx, voidedDf!, [
        { type: "core.start", payload: {} },
        { type: "boardgame.result", payload: DF },
        { type: "core.void", payload: {}, voids: 2 },
        { type: "boardgame.result", payload: { winner: null, method: "agreement" } },
      ]);
      await ledger(tx, league, [{ type: "core.start", payload: {} }, { type: "boardgame.result", payload: DF }]);
      for (const id of [unsettled!, laterVoided!, settled!, voidedDf!, league]) await held(tx, id);
      await tx.unsafe(BLOCK!);
      return Object.fromEntries(
        await Promise.all(
          ([["unsettled", unsettled!], ["laterVoided", laterVoided!], ["settled", settled!], ["voidedDf", voidedDf!], ["league", league]] as const).map(
            async ([k, id]) => [k, await rowOf(tx, id)] as const,
          ),
        ),
      );
    });
    const DW = { status: "forfeited", outcome: { kind: "double_walkover" }, finished: true };
    const HELD = { status: "needs_decision", outcome: LEGACY_HELD, finished: true };
    expect(value).toEqual({ unsettled: DW, laterVoided: DW, settled: HELD, voidedDf: HELD, league: HELD });
    const c = counts(notices);
    expect(c.changed, "the notice counts what moved").toBe(c.examined);
    expect(c.changed).toBeGreaterThanOrEqual(2);
  });

  it("D12: after the migration the fed seat resolves lazily — the opponent walks over with no organiser step", async () => {
    const s = await seedBracket({ ...chess, stageKind: "knockout", entrants: 4 });
    const rows = await sql<{ id: string; home: string; winner_to_fixture: string; winner_to_slot: number }[]>`
      select id, home_entrant_id as home, winner_to_fixture, winner_to_slot from fixtures
      where stage_id = ${s.stageId} and home_entrant_id is not null and away_entrant_id is not null order by seq_in_round`;
    expect(rows, "rig: two seated semis").toHaveLength(2);
    const [sf1, sf2] = rows;
    await scoreEvent(s.auth, sf2!.id, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(s.auth, sf2!.id, { expected_seq: 1, type: "boardgame.result", payload: { winner: sf2!.home, method: "resign" } });
    const { value } = await rolledBack(async (tx) => {
      await ledger(tx, sf1!.id, [{ type: "core.start", payload: {} }, { type: "boardgame.result", payload: DF }]);
      await held(tx, sf1!.id);
      await tx.unsafe(BLOCK!);
      const before = await rowOf(tx, sf1!.winner_to_fixture);
      await resolveBracketSeats(tx as never, s.stageId);
      return { before, after: await rowOf(tx, sf1!.winner_to_fixture) };
    });
    expect(value.before.status, "the block itself seats nothing (seats resolve lazily, D12)").toBe("scheduled");
    expect(value.after).toEqual({
      status: "forfeited",
      outcome: { kind: "award", winner: sf2!.home, loser: null, reason: "bye" },
      finished: true,
    });
  });

  it("spec §5.5: no fixture whose active result is a chess double forfeit renders the Level copy after the migration", async () => {
    // The headline the public match centre builds for the row before and after the block. Before: the held status
    // line ("Level — winner to be decided"). After: never that — and Task 13's double-walkover sentence (this last
    // line is red until Task 13 adds the key; carried there by name).
    const s = await seedBracket({ ...chess, stageKind: "knockout", entrants: 2 });
    const id = s.fixtureIds[0]!;
    const { value } = await rolledBack(async (tx) => {
      await ledger(tx, id, [{ type: "core.start", payload: {} }, { type: "boardgame.result", payload: DF }]);
      await held(tx, id);
      const before = await rowOf(tx, id);
      await tx.unsafe(BLOCK!);
      return { before, after: await rowOf(tx, id) };
    });
    const headline = (r: { status: string; outcome: unknown }) => statusLineOf(r.status, r.outcome as PublicFixture["outcome"]);
    expect(headline(value.before), "the positive pair: the held row reads Level").toBe("matchCentre.status.needs_decision");
    expect(headline(value.after)).not.toBe("matchCentre.status.needs_decision");
    expect(headline(value.after), "Task 13: the double-walkover sentence").toMatch(/double_walkover/);
  });
});

describe.skipIf(!HAS_DB)("W2b migration — division_has_results (X-BL-1, D13)", () => {
  it("X-BL-1: division_has_results — one row per outcome kind × status, with a positive pair for each exclusion", async () => {
    const s = await seedBracket({ ...chess, stageKind: "knockout", entrants: 2 });
    const id = s.fixtureIds[0]!;
    const [f] = await sql<{ home: string; away: string }[]>`select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${id}`;
    const WIN = { kind: "win", winner: f!.home, loser: f!.away };
    const CASES: [string, string, unknown, boolean][] = [
      ["no_result decided", "decided", { kind: "no_result" }, false],
      ["no_result abandoned", "abandoned", { kind: "no_result" }, false],
      ["double_walkover forfeited", "forfeited", { kind: "double_walkover" }, false],
      ["single walkover award forfeited", "forfeited", { kind: "award", winner: f!.home, loser: f!.away, reason: "walkover" }, true],
      ["win decided", "decided", WIN, true],
      ["win finalized", "finalized", WIN, true],
      ["draw needs_decision", "needs_decision", { kind: "draw" }, true],
      ["null-outcome abandoned", "abandoned", null, false],
      ["null-outcome scheduled", "scheduled", null, false],
      // The positive pair of the abandoned exclusions: an abandon that carries a verdict (DLS) counts.
      ["win abandoned", "abandoned", { ...WIN, method: "abandoned" }, true],
    ];
    const { value } = await rolledBack(async (tx) => {
      await tx.unsafe(FUNCTION!);
      const seen: [string, boolean][] = [];
      for (const [label, status, outcome] of CASES) {
        await tx`update fixtures set status = ${status}, outcome = ${outcome === null ? null : tx.json(outcome as never)} where id = ${id}`;
        const [r] = await tx<{ has: boolean }[]>`select division_has_results(${s.divisionId}) as has`;
        seen.push([label, r!.has]);
      }
      return seen;
    });
    expect(value).toEqual(CASES.map(([label, , , want]) => [label, want]));
    expect(value.length, "every case was read through the SQL function").toBe(CASES.length);
  });

  it("D13: every status the function's arms read is inside the partial index WHERE and the trigger's finished set", async () => {
    const [fn] = await sql<{ def: string }[]>`select pg_get_functiondef('division_has_results(uuid)'::regprocedure) as def`;
    const [idx] = await sql<{ def: string }[]>`select indexdef as def from pg_indexes where indexname = 'fixtures_division_results_idx'`;
    const [trg] = await sql<{ def: string }[]>`select pg_get_functiondef('fixtures_track_finished()'::regprocedure) as def`;
    const arms = new Set([...fn!.def.matchAll(/status in \(([^)]*)\)/g)].flatMap((m) => [...quoted(m[1]!)]));
    const index = quoted(idx!.def);
    const finished = quoted(/new\.status in \(([^)]*)\)/.exec(trg!.def)?.[1] ?? "");
    expect(arms.size, "the function's status arms were found").toBeGreaterThan(0);
    expect([...arms].filter((x) => !index.has(x)), "every arm status is in the index WHERE").toEqual([]);
    expect([...arms].filter((x) => !finished.has(x)), "every arm status is in the finished set").toEqual([]);
    // The live function is the delta's: it excludes the two no-verdict kinds.
    expect(fn!.def).toMatch(/not in \('no_result', 'double_walkover'\)/);
  });
});

// ── the match centre's headline, for the spec §5.5 row ──────────────────────────────────────────────────────────
const lineups = defaultLineupPair(boardgame.positions);
const SIDES: [SideT, SideT] = [
  { entrantId: lineups.home.entrantId, name: "Anand Viswanathan", short: "ANA", colour: null, badgeUrl: null },
  { entrantId: lineups.away.entrantId, name: "Bela Nakamura", short: "BEL", colour: null, badgeUrl: null },
];
function statusLineOf(status: string, outcome: PublicFixture["outcome"]): string | undefined {
  const input: MatchCentreInput = {
    fixture: {
      id: "fx1", division_id: "d1", stage_id: "s1", pool_id: null, round_no: 1, seq_in_round: 1,
      home_entrant_id: lineups.home.entrantId, away_entrant_id: lineups.away.entrantId, home_slot_label: null, away_slot_label: null,
      scheduled_at: "2026-10-09T09:00:00.000Z", venue: null, court_label: null, venue_name: null, court_name: null,
      status, outcome, summary: null, last_seq: null,
    } as PublicFixture,
    sportKey: "boardgame", cfg: boardgame.configSchema.parse({}), events: [], lineups: { home: [], away: [] }, sides: SIDES,
    venueTz: "UTC", locale: "en", now: new Date("2026-10-09T12:00:00.000Z"),
    hrefs: { division: "/d", competition: "/c", calendar: null }, stage: null, moduleVersion: null, formatLabel: null,
  };
  return buildMatchCentre(input).header.statusLine?.key;
}
