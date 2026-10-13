// W2b Task 9 (spec §5.4; plan D12, D13) — the W2b delta: (1) it REFUSES to apply while an UNSETTLED held bracket
// fixture's active result is the legacy chess double forfeit (Loop R M-6, W2b-R12: fail closed — a stored
// re-classification seats nobody, asks nothing of a final and leaves match_states behind; the console's own writes put
// such a row right), (2) `division_has_results` counts only results with a verdict (W2b-R13). The delta is read by GLOB, never by number (it is renumbered at merge), and
// its OWN statements run here — inside rolled-back transactions on a dedicated client, because the block and the
// function act on the whole shared test DB (a BYPASSRLS `unsafe` would otherwise rewrite sibling suites' rows).
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { BRACKET_KINDS } from "@seazn/engine/core";
import { connectionOptions, sql } from "@/lib/db";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
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

/** `body` on its own one-connection client inside a transaction that is always rolled back; the notices it raised
 *  (also handed to `body`, so it can act on the delta's notice inside the same transaction). */
async function rolledBack<T>(body: (tx: Tx, notices: readonly string[]) => Promise<T>): Promise<{ value: T; notices: string[] }> {
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
        value = await body(tx, notices);
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  } finally {
    await client.end();
  }
  return { value: value as T, notices };
}

/** The block's verdict as it reports it: its refusal (`raise exception`) parsed, or its one pass notice. Under
 *  `orgId` the block runs as the app's tenant role (`withTenant`'s `app_user` + `app.current_org`), so RLS shows it that
 *  org's rows alone — the shared test DB holds other suites' legacy rows, and only a scoped run has a deterministic
 *  empty case. Without it, the block runs as the migration does: over the whole DB. Assumptions are guards: an error or
 *  a notice that is not the block's is thrown, never read as a verdict. */
const NOTICE = "W2b legacy double forfeit held";
interface Verdict {
  refused: boolean;
  examined: number;
  fixtures: string[];
  stages: string[];
  hint: string | null;
}
async function verdict(opts: { orgId?: string; setup?: (tx: Tx) => Promise<void> } = {}): Promise<Verdict> {
  const { value } = await rolledBack(async (tx, notices): Promise<Verdict> => {
    await opts.setup?.(tx);
    if (opts.orgId !== undefined) {
      await tx`select set_config('app.current_org', ${opts.orgId}, true)`;
      await tx`set local role app_user`;
    }
    try {
      await tx.unsafe(BLOCK!);
    } catch (e) {
      const m = new RegExp(`^${NOTICE}: examined=(\\d+) fixtures=([0-9a-f,-]*) stages=([0-9a-f,-]*)$`).exec((e as Error).message);
      if (!m) throw e;
      const list = (x: string) => (x === "" ? [] : x.split(","));
      return { refused: true, examined: Number(m[1]), fixtures: list(m[2]!), stages: list(m[3]!), hint: (e as { hint?: string }).hint ?? null };
    }
    expect(notices.filter((n) => n.startsWith(NOTICE)), "the block's one pass notice").toEqual([`${NOTICE}: examined=0`]);
    return { refused: false, examined: 0, fixtures: [], stages: [], hint: null };
  });
  return value;
}

const chess = { sport: "boardgame", variant: declaredVariant("boardgame", "classical") };
/** The legacy (pre-W2b) chess double forfeit, as the pad wrote it before D15 retired the method. */
const DF = { winner: null, method: "double_forfeit" }; // legacy row
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

describe.skipIf(!HAS_DB)("W2b migration — a held legacy chess double forfeit fails the delta closed (Loop R M-6, W2b-R12)", () => {
  const START = { type: "core.start", payload: {} };
  const LEGACY_DF = { type: "boardgame.result", payload: DF };

  it("M-6 fail closed — empty case first: with no held legacy double forfeit the block passes and says so; with one it refuses, naming exactly that fixture and its stage, with the remedy", async () => {
    const s = await seedBracket({ ...chess, stageKind: "knockout", entrants: 2 });
    const id = s.fixtureIds[0]!;
    const hold = async (tx: Tx) => {
      await ledger(tx, id, [START, LEGACY_DF]);
      await held(tx, id);
    };
    expect(await verdict({ orgId: s.auth.orgId }), "the empty case: nothing to refuse").toEqual({ refused: false, examined: 0, fixtures: [], stages: [], hint: null });
    const seeded = await verdict({ orgId: s.auth.orgId, setup: hold });
    expect({ ...seeded, hint: null }, "the one held row, by name").toEqual({ refused: true, examined: 1, fixtures: [id], stages: [s.stageId], hint: null });
    expect(seeded.hint, "the remedy").toMatch(/void each fixture double forfeit and record the double walkover/);
    // Over the whole DB, as the migration really runs: the same row is refused beside whatever else the DB holds, and
    // the list it names is as long as the count it reports.
    const wide = await verdict({ setup: hold });
    expect([wide.refused, wide.fixtures.includes(id), wide.stages.includes(s.stageId), wide.fixtures.length]).toEqual([true, true, true, wide.examined]);
  });

  it("BG-DW-1 migration: the refusal names an unsettled held chess double forfeit (also when a later result was voided), never a settled one, a voided double forfeit or a non-bracket row", async () => {
    // Five rows, one per predicate. The settled and the league rows are HELD on purpose — the only thing that
    // separates them from a refused row is the predicate under test (a settle; the stage kind). Over the whole DB, so
    // the stage kinds of two orgs are read together; membership, not a count (the shared DB holds other suites' rows).
    const ko = await seedBracket({ ...chess, stageKind: "knockout", entrants: 8 });
    const lg = await seedBracket({ ...chess, stageKind: "league", entrants: 2 });
    const [unsettled, laterVoided, settled, voidedDf] = ko.fixtureIds;
    const league = lg.fixtureIds[0]!;
    const v = await verdict({
      setup: async (tx) => {
        await ledger(tx, unsettled!, [START, LEGACY_DF]);
        // The double forfeit is the ACTIVE result: a later result was entered and voided.
        const [w] = await tx<{ home: string }[]>`select home_entrant_id as home from fixtures where id = ${laterVoided!}`;
        await ledger(tx, laterVoided!, [START, LEGACY_DF, { type: "boardgame.result", payload: { winner: w!.home, method: "resign" } }, { type: "core.void", payload: {}, voids: 3 }]);
        const [h] = await tx<{ home: string }[]>`select home_entrant_id as home from fixtures where id = ${settled!}`;
        await ledger(tx, settled!, [START, LEGACY_DF, { type: "core.settle", payload: { winner: h!.home, method: "organiser" } }]);
        // The double forfeit was voided; the active result is a later agreed draw (a real held level result).
        await ledger(tx, voidedDf!, [START, LEGACY_DF, { type: "core.void", payload: {}, voids: 2 }, { type: "boardgame.result", payload: { winner: null, method: "agreement" } }]);
        await ledger(tx, league, [START, LEGACY_DF]);
        for (const id of [unsettled!, laterVoided!, settled!, voidedDf!, league]) await held(tx, id);
      },
    });
    expect(v.refused, "the delta refuses").toBe(true);
    const named = Object.fromEntries(
      ([["unsettled", unsettled!], ["laterVoided", laterVoided!], ["settled", settled!], ["voidedDf", voidedDf!], ["league", league]] as const).map(([k, id]) => [k, v.fixtures.includes(id)]),
    );
    expect(named).toEqual({ unsettled: true, laterVoided: true, settled: false, voidedDf: false, league: false });
    expect([v.stages.includes(ko.stageId), v.stages.includes(lg.stageId)], "the stages it names").toEqual([true, false]);
  });

  it("M-6: the remedy it names, through the console — void the double forfeit, record the double walkover — clears the row, and the cascade a stored re-classification never ran walks the other semi's winner over the final", async () => {
    const s = await seedBracket({ ...chess, stageKind: "knockout", entrants: 4 });
    const rows = await sql<{ id: string; home: string; winner_to_fixture: string }[]>`
      select id, home_entrant_id as home, winner_to_fixture from fixtures
      where stage_id = ${s.stageId} and home_entrant_id is not null and away_entrant_id is not null order by seq_in_round`;
    expect(rows, "rig: two seated semis").toHaveLength(2);
    const [sf1, sf2] = rows;
    await scoreEvent(s.auth, sf2!.id, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(s.auth, sf2!.id, { expected_seq: 1, type: "boardgame.result", payload: { winner: sf2!.home, method: "resign" } });
    // The legacy row, COMMITTED — the console acts on stored rows only. The write path refuses the retired method now.
    const ids = await sql.begin(async (tx) => {
      const out = await ledger(tx as never, sf1!.id, [START, LEGACY_DF]);
      await held(tx as never, sf1!.id);
      return out;
    });
    expect(await verdict({ orgId: s.auth.orgId }), "the delta refuses the stored row").toMatchObject({ refused: true, fixtures: [sf1!.id] });
    await scoreEvent(s.auth, sf1!.id, { expected_seq: 2, type: "core.void", payload: { event_id: ids[1]! } } as never);
    const dw = await scoreEvent(s.auth, sf1!.id, { expected_seq: 3, type: "core.forfeit", payload: { by: "both", reason: "walkover" } } as never);
    expect([dw.status, dw.outcome], "the double walkover, recorded").toEqual(["forfeited", { kind: "double_walkover" }]);
    expect((await verdict({ orgId: s.auth.orgId })).refused, "the delta now applies").toBe(false);
    const [final] = await sql<{ status: string; outcome: unknown }[]>`select status, outcome from fixtures where id = ${sf1!.winner_to_fixture}`;
    expect(final, "the cascade walked the other semi's winner over the final").toEqual({
      status: "forfeited",
      outcome: { kind: "award", winner: sf2!.home, loser: null, reason: "bye" },
    });
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
