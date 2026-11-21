// W5 stress fix F1: a stage of any size starts. Start (and every bulk re-mint) wrote all of a stage's new lines in ONE
// `insert into fixtures`, and the driver refuses a statement past its bind-parameter ceiling: 17 columns a line, so a stage
// of more than 3,854 lines answered 500 MAX_PARAMETERS_EXCEEDED (a league stopped at 88 entrants; no 500-entrant
// round-robin could start at all), and the 500's body carried the driver's own sentence to the organiser.
//
// What this file pins, on a real database:
//   * the ceiling itself, against the REAL driver: `MAX_BIND_PARAMETERS` binds go through, one more is refused by name;
//   * Start just over the old wall: a badminton league of 89 (89 x 88 / 2 = 3,916 lines), and another sport and shape (the
//     registry's first team sport, two groups of 45 over two legs, 2 x 2 x 45 x 44 / 2 = 3,960 lines). Every expected count is
//     the round-robin formula, never a count the code reports;
//   * all or nothing: a failure in a LATER chunk leaves zero rows (the batches share the caller's transaction);
//   * a row value that would bind more than one parameter is refused before any statement is sent (the chunk arithmetic's own
//     assumption, as a guard);
//   * no driver message reaches a 500's body.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import { sql, statementCount, withTenant } from "@/lib/db";
import { v1 } from "@/server/api-v1/http";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { insertFixtureRows, MAX_BIND_PARAMETERS, rowsPerInsert } from "../fixture-insert";
import { startDivision } from "../schedule";
import { createStages } from "../stages";
import { seedOrg } from "./_seed";

// No organizer analytics leave a test run (the seed's create path fires them).
vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn().mockResolvedValue(undefined) }));

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

type Kind = "individual" | "team";
const moduleOf = (key: string): AnySportModule => builtinModules.find((m) => m.key === key) as AnySportModule;
const variantOf = (key: string): string => Object.keys(moduleOf(key).variants)[0]!;
/** The registry's first sport whose natural entrant is a team (the engine's own declaration). */
function teamSport(): string {
  const m = builtinModules.find((x) => x.entrantModel?.defaultKind === "team");
  if (m === undefined) throw new Error("premise: the registry declares a team sport");
  return m.key;
}

/** `n` seeded entrants in one root stage of `kind`, created but NOT started. */
async function division(sport: string, kind: Kind, n: number, stage: { kind: "league" | "group"; config: Record<string, unknown> }) {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "F1 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "f1-" + randomUUID().slice(0, 6), sport_key: sport, variant_key: variantOf(sport), config: {} });
  await createEntrants(
    auth,
    d.id,
    Array.from({ length: n }, (_, i) => ({ kind, display_name: `P${i + 1}`, seed: i + 1, members: [] })) as never,
  );
  const [st] = await createStages(auth, d.id, { seq: 1, kind: stage.kind, name: "Table", config: stage.config, progression: null });
  return { auth, divisionId: d.id, stageId: st!.id };
}

interface LineRow {
  home_entrant_id: string;
  away_entrant_id: string;
  pool_id: string | null;
  fixture_no: number | null;
}
const linesOf = (stageId: string) =>
  sql<LineRow[]>`select home_entrant_id, away_entrant_id, pool_id, fixture_no from fixtures where stage_id = ${stageId}`;
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Every pair of `members` plays exactly `legs` times among `lines`, nobody plays themself, and no line leaves the set. Returns
 *  the number of pairs checked (anti-vacuity). */
function assertEveryPairExactly(lines: readonly LineRow[], members: readonly string[], legs: number): number {
  const inSet = new Set(members);
  const count = new Map<string, number>();
  for (const l of lines) {
    expect(l.home_entrant_id, "nobody plays themself").not.toBe(l.away_entrant_id);
    expect(inSet.has(l.home_entrant_id) && inSet.has(l.away_entrant_id), "a line between two members of the set").toBe(true);
    const k = pairKey(l.home_entrant_id, l.away_entrant_id);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  let checked = 0;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      expect(count.get(pairKey(members[i]!, members[j]!)) ?? 0, "each pair exactly `legs` times").toBe(legs);
      checked++;
    }
  }
  return checked;
}

/** The division's fixture numbers are exactly 1..total, each once (the insert trigger numbers a fresh division from 1). */
async function assertFixtureNumbersContiguous(divisionId: string, total: number): Promise<void> {
  const rows = await sql<{ fixture_no: number | null }[]>`select fixture_no from fixtures where division_id = ${divisionId}`;
  expect(rows.length).toBe(total);
  const nos = rows.map((r) => r.fixture_no);
  expect(nos.every((n) => n !== null), "every line is numbered").toBe(true);
  const sorted = (nos as number[]).sort((a, b) => a - b);
  expect(sorted[0]).toBe(1);
  expect(sorted[sorted.length - 1]).toBe(total);
  expect(new Set(sorted).size, "no number twice").toBe(total);
}

describe.skipIf(!HAS_DB)("F1: the driver's bind-parameter ceiling", () => {
  it("MAX_BIND_PARAMETERS binds go through the real driver; one more is refused MAX_PARAMETERS_EXCEEDED", async () => {
    const at = Array.from({ length: MAX_BIND_PARAMETERS }, (_, i) => [i]);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from (values ${sql(at as never)}) v(x)`;
    expect(n, "the ceiling's own count of binds goes through").toBe(MAX_BIND_PARAMETERS);
    const over = [...at, [MAX_BIND_PARAMETERS]];
    const err = await sql`select count(*)::int as n from (values ${sql(over as never)}) v(x)`.then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as { code?: string } | null)?.code, "one past the ceiling is the driver's own refusal").toBe("MAX_PARAMETERS_EXCEEDED");
  });

  it("rows per statement is the ceiling over the columns a row binds (17 columns -> 3,854; the stress probe's wall)", () => {
    // The probe's measured wall (stress-report.md F1): 3,828 lines (88 entrants) started, 3,916 (89) did not.
    expect(rowsPerInsert(17)).toBe(Math.floor(MAX_BIND_PARAMETERS / 17));
    expect(rowsPerInsert(17) * 17).toBeLessThanOrEqual(MAX_BIND_PARAMETERS);
    expect((rowsPerInsert(17) + 1) * 17).toBeGreaterThan(MAX_BIND_PARAMETERS);
    expect(rowsPerInsert(17)).toBeGreaterThanOrEqual(3828);
    expect(rowsPerInsert(17)).toBeLessThan(3916);
    expect(() => rowsPerInsert(0), "an empty row shape is refused").toThrow(/rowsPerInsert/);
  });
});

describe.skipIf(!HAS_DB)("F1: Start writes a stage past the old one-statement wall", () => {
  it("a badminton league of 89 starts: n(n-1)/2 lines, every pair once, numbered 1..N", { timeout: 300_000 }, async () => {
    const n = 89;
    const total = (n * (n - 1)) / 2;
    expect(total * 17, "premise: past the one-statement ceiling (17 columns a line)").toBeGreaterThan(MAX_BIND_PARAMETERS);
    const rig = await division("badminton", "individual", n, { kind: "league", config: { legs: 1 } });
    await startDivision(rig.auth, rig.divisionId);
    const lines = await linesOf(rig.stageId);
    expect(lines.length).toBe(total);
    const members = (await sql<{ id: string }[]>`select id from entrants where division_id = ${rig.divisionId}`).map((r) => r.id);
    expect(members.length).toBe(n);
    expect(assertEveryPairExactly(lines, members, 1), "anti-vacuity: pairs checked").toBe(total);
    for (const id of members) expect(lines.filter((l) => l.home_entrant_id === id || l.away_entrant_id === id).length).toBe(n - 1);
    await assertFixtureNumbersContiguous(rig.divisionId, total);
  });

  it("another sport and shape: the first team sport, two groups of 45 over two legs, starts with every in-pool pair twice", { timeout: 300_000 }, async () => {
    const sport = teamSport();
    const perPool = 45;
    const legs = 2;
    const total = 2 * legs * ((perPool * (perPool - 1)) / 2);
    expect(total * 17, "premise: past the one-statement ceiling").toBeGreaterThan(MAX_BIND_PARAMETERS);
    const rig = await division(sport, "team", 2 * perPool, { kind: "group", config: { legs, pools: { count: 2 } } });
    await startDivision(rig.auth, rig.divisionId);
    const lines = await linesOf(rig.stageId);
    expect(lines.length).toBe(total);
    const pools = await sql<{ id: string }[]>`select id from pools where stage_id = ${rig.stageId}`;
    expect(pools.length).toBe(2);
    let checked = 0;
    for (const p of pools) {
      const inPool = lines.filter((l) => l.pool_id === p.id);
      const members = [...new Set(inPool.flatMap((l) => [l.home_entrant_id, l.away_entrant_id]))];
      expect(members.length).toBe(perPool);
      checked += assertEveryPairExactly(inPool, members, legs);
    }
    expect(checked, "anti-vacuity: in-pool pairs checked").toBe(2 * ((perPool * (perPool - 1)) / 2));
    expect(lines.every((l) => l.pool_id !== null), "no line outside a pool").toBe(true);
    await assertFixtureNumbersContiguous(rig.divisionId, total);
  });
});

/** A bare league stage with no lines, for the helper's own cases. */
async function emptyStage(): Promise<{ auth: AuthCtx; divisionId: string; stageId: string }> {
  return division("badminton", "individual", 2, { kind: "league", config: { legs: 1 } });
}

/** Valid line rows for `stageId`: explicit fixture numbers far from the trigger's, so the insert pays no per-row max(). */
function shellRows(stageId: string, divisionId: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    stage_id: stageId,
    division_id: divisionId,
    round_no: 1,
    seq_in_round: i + 1,
    ext_key: `f1-shell-${i + 1}`,
    fixture_no: 100_000 + i,
    status: "scheduled",
  }));
}

describe.skipIf(!HAS_DB)("F1: insertFixtureRows", () => {
  it("all or nothing: a failure in a LATER chunk rolls back every row, the earlier chunk's included", { timeout: 120_000 }, async () => {
    const rig = await emptyStage();
    const size = rowsPerInsert(8);
    const rows = shellRows(rig.stageId, rig.divisionId, size + 5);
    // The last row repeats the first one's primary key: a 23505 raised by the SECOND statement.
    const bad = [...rows.slice(0, -1), { ...rows[rows.length - 1]!, id: rows[0]!.id }];
    let sent = 0;
    const err = await withTenant(rig.auth.orgId, async (tx) => {
      const before = statementCount();
      try {
        await insertFixtureRows(tx, bad);
      } finally {
        sent = statementCount() - before;
      }
    }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    );
    expect(err?.code, "the second chunk's own violation").toBe("23505");
    expect(sent, "anti-vacuity: the first chunk was sent before the failing one").toBe(2);
    expect((await linesOf(rig.stageId)).length, "nothing of either chunk stands").toBe(0);

    // Control: the same rows without the repeated key commit whole, so the rollback above is the later chunk's alone.
    await withTenant(rig.auth.orgId, (tx) => insertFixtureRows(tx, rows));
    expect((await linesOf(rig.stageId)).length).toBe(size + 5);
  });

  it("an empty input sends no statement", async () => {
    const rig = await emptyStage();
    await withTenant(rig.auth.orgId, async (tx) => {
      const before = statementCount();
      await insertFixtureRows(tx, []);
      expect(statementCount() - before).toBe(0);
    });
  });

  it("a row value that binds more than one parameter (an SQL fragment) is refused before any statement is sent", async () => {
    const rig = await emptyStage();
    const err = await withTenant(rig.auth.orgId, async (tx) => {
      const rows = shellRows(rig.stageId, rig.divisionId, 2).map((r, i) => (i === 1 ? { ...r, scheduled_at: tx`now()` } : { ...r, scheduled_at: null }));
      const before = statementCount();
      try {
        await insertFixtureRows(tx, rows as never);
      } finally {
        expect(statementCount() - before, "nothing sent").toBe(0);
      }
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(err)).toMatch(/insertFixtureRows: .*scheduled_at/);
    expect((await linesOf(rig.stageId)).length).toBe(0);
  });

  // Stress fix F3 scoped run (2026-11-21): the guard above refused `tx.json(...)`, which a knockout's bye and walkover lines
  // carry in `outcome` (generate-tx.ts), so every knockout with a bye failed to generate. A json helper is ONE bind (the
  // driver's `Parameter`; its `stringifyValue` sends it through `handleValue`, one `$n`), though it carries the same `then` a
  // query does. Across a chunk boundary so the arithmetic is exercised with it.
  it("a json value (`tx.json`, the driver's one-bind Parameter) goes through, across a chunk boundary", { timeout: 120_000 }, async () => {
    const rig = await emptyStage();
    const size = rowsPerInsert(9);
    let sent = 0;
    await withTenant(rig.auth.orgId, async (tx) => {
      const rows = shellRows(rig.stageId, rig.divisionId, size + 1).map((r, i) => ({ ...r, outcome: tx.json({ kind: "bye", winner: null, n: i } as never) }));
      const before = statementCount();
      await insertFixtureRows(tx, rows as never);
      sent = statementCount() - before;
    });
    expect(sent, "two chunks: the ninth column counts").toBe(2);
    const back = await sql<{ n: number; kind: string }[]>`
      select (outcome->>'n')::int as n, outcome->>'kind' as kind from fixtures where stage_id = ${rig.stageId} order by (outcome->>'n')::int`;
    expect(back.length, "anti-vacuity: every row landed").toBe(size + 1);
    expect(back.every((r, i) => r.n === i && r.kind === "bye"), "each row's own json, stored as json").toBe(true);
  });
});

describe.skipIf(!HAS_DB)("F1: no driver message reaches a 500's body", () => {
  async function bodyOf(err: unknown) {
    const res = await v1(async () => {
      throw err;
    });
    return { status: res.status, json: (await res.json()) as { ok: boolean; error: { code: string; message: string }; requestId?: string } };
  }

  it("the driver's own refusal (MAX_PARAMETERS_EXCEEDED) answers 500 INTERNAL without its sentence", async () => {
    const over = Array.from({ length: MAX_BIND_PARAMETERS + 1 }, (_, i) => [i]);
    const err = await sql`select 1 from (values ${sql(over as never)}) v(x)`.then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message, "premise: the driver's error carries its sentence").toMatch(/MAX_PARAMETERS_EXCEEDED/);
    const { status, json } = await bodyOf(err);
    expect(status).toBe(500);
    expect(json.error.code).toBe("INTERNAL");
    expect(json.error.message).not.toMatch(/MAX_PARAMETERS|parameters|65534/i);
    expect(json.error.message).toBe("Server error");
    expect(typeof json.requestId, "the request id still names the failure for support").toBe("string");
  });

  it("a Postgres refusal (PostgresError) answers 500 INTERNAL without the server's message", async () => {
    const err = await sql`select * from no_such_table_for_f1_body`.then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(postgres.PostgresError);
    expect(err?.message, "premise: the server's message names the relation").toMatch(/no_such_table_for_f1_body/);
    const { status, json } = await bodyOf(err);
    expect(status).toBe(500);
    expect(json.error.message).not.toMatch(/no_such_table|relation/);
    expect(json.error.message).toBe("Server error");
  });

  // B2 review m-4: the positive pair. A plain app error keeps its sentence - the scrub is the driver's and the socket's, not every
  // 500's. An app error that carries a string `code` is read like theirs and scrubbed too (the predicate's documented cost: its
  // sentence is in the log under the request id, not in the body).
  it("a plain app error keeps its message through the 500 (the scrub is the driver's only)", async () => {
    const { status, json } = await bodyOf(new Error("the outbox could not render the receipt"));
    expect(status).toBe(500);
    expect(json.error.code).toBe("INTERNAL");
    expect(json.error.message).toBe("the outbox could not render the receipt");
  });

  it("an app error that carries a string code is read as the driver's: scrubbed, named by the request id", async () => {
    const coded = Object.assign(new Error("enqueue refused: template missing"), { code: "EMAIL_TEMPLATE_MISSING" });
    const { status, json } = await bodyOf(coded);
    expect(status).toBe(500);
    expect(json.error.message).toBe("Server error");
    expect(typeof json.requestId).toBe("string");
  });

  it("a connection failure (the driver's or the socket's own code) answers without its host and port", async () => {
    const dead = postgres("postgres://nobody@127.0.0.1:1/none", { connect_timeout: 2, max: 1, onnotice: () => {} });
    const err = await dead`select 1`.then(
      () => null,
      (e: unknown) => e as Error,
    );
    await dead.end({ timeout: 0 });
    expect(err?.message, "premise: the failure names where it tried").toMatch(/127\.0\.0\.1/);
    const { json } = await bodyOf(err);
    expect(json.error.message).not.toMatch(/127\.0\.0\.1|ECONN|:1\b/);
    expect(json.error.message).toBe("Server error");
  });
});
