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

// W5 B4 (stress F8): Start spent ~95% of its time inside the fixtures insert. The V263 trigger `assign_fixture_no` reads
// `max(fixture_no)` of the division for EVERY row, and under the app's role (`withTenant`: app_user, the tenant policy's org
// filter on fixtures) that read grew with the rows already written, so a 4,950-line league spent 9.6 s numbering (the same rows
// numbered in advance: 0.8 s). `insertFixtureRows` now numbers the rows itself, once per call, exactly as the trigger would:
// the trigger's own key (`fixture_no:<division>`), then the division's max, then max+1 onward in row order. The trigger skips a
// row that arrives numbered (`if new.fixture_no is null`), and stays for every single-row writer.

/** Unnumbered line rows (the production callers' shape: the trigger, or now the helper, numbers them). */
function unnumberedRows(stageId: string, divisionId: string, count: number, tag: string) {
  return Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    stage_id: stageId,
    division_id: divisionId,
    round_no: 1,
    seq_in_round: i + 1,
    ext_key: `f8-${tag}-${String(i + 1).padStart(5, "0")}`,
    status: "scheduled",
  }));
}

describe.skipIf(!HAS_DB)("F8: insertFixtureRows numbers the lines once per call", () => {
  it("numbers as the trigger does: max+1 onward in row order, across a chunk boundary; a second call continues", { timeout: 120_000 }, async () => {
    const rig = await emptyStage();
    // Three lines numbered by the TRIGGER itself, one statement each (V263: the division's max + 1): the rule's own witness.
    for (const row of unnumberedRows(rig.stageId, rig.divisionId, 3, "pre")) await withTenant(rig.auth.orgId, (tx) => tx`insert into fixtures ${tx(row as never)}`);
    const pre = await sql<{ fixture_no: number }[]>`select fixture_no from fixtures where stage_id = ${rig.stageId} order by fixture_no`;
    expect(pre.map((r) => r.fixture_no), "premise: the trigger numbers a fresh division 1, 2, 3").toEqual([1, 2, 3]);

    const size = rowsPerInsert(7);
    const first = unnumberedRows(rig.stageId, rig.divisionId, size + 2, "a");
    const second = unnumberedRows(rig.stageId, rig.divisionId, 4, "b");
    let sent = 0;
    await withTenant(rig.auth.orgId, async (tx) => {
      const before = statementCount();
      await insertFixtureRows(tx, first);
      sent = statementCount() - before;
    });
    await withTenant(rig.auth.orgId, (tx) => insertFixtureRows(tx, second));
    const noOf = new Map((await sql<{ id: string; fixture_no: number }[]>`select id, fixture_no from fixtures where stage_id = ${rig.stageId}`).map((r) => [r.id, r.fixture_no]));
    const expected = [...first, ...second].map((_, i) => 3 + i + 1);
    const got = [...first, ...second].map((r) => noOf.get(r.id));
    expect(got.length, "anti-vacuity: rows checked").toBe(size + 6);
    expect(got, "max+1 onward, in the order the rows were handed over").toEqual(expected);
    expect(sent, "the rows' own chunks, plus the lock and the one max() read").toBe(2 + 2);
  });

  it("reads the division's fixtures once per call, not once per line (the per-row max() made Start quadratic)", { timeout: 120_000 }, async () => {
    const rig = await emptyStage();
    const rows = unnumberedRows(rig.stageId, rig.divisionId, 600, "scan");
    const scans = (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) =>
      tx<{ n: number }[]>`select (coalesce(idx_scan, 0) + coalesce(seq_scan, 0))::int as n from pg_stat_xact_user_tables where relid = 'fixtures'::regclass`;
    const delta = await withTenant(rig.auth.orgId, async (tx) => {
      const [before] = await scans(tx);
      await insertFixtureRows(tx, rows);
      const [after] = await scans(tx);
      return after!.n - before!.n;
    });
    expect((await linesOf(rig.stageId)).length, "anti-vacuity: every line landed").toBe(600);
    expect(delta, "one read of the division's numbers for 600 lines").toBe(1);
  });

  it("rows of two divisions in one call are refused before any statement is sent (one division's numbering per call)", async () => {
    const a = await emptyStage();
    const b = await emptyStage();
    const rows = [...unnumberedRows(a.stageId, a.divisionId, 1, "x"), ...unnumberedRows(b.stageId, b.divisionId, 1, "y")];
    let sent = -1;
    const err = await withTenant(a.auth.orgId, async (tx) => {
      const before = statementCount();
      try {
        await insertFixtureRows(tx, rows);
      } finally {
        sent = statementCount() - before;
      }
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(err)).toMatch(/insertFixtureRows: .*two divisions/);
    expect(sent, "nothing sent").toBe(0);
  });

  it("a row with no division is refused before any statement is sent (nothing to number it under)", async () => {
    const rig = await emptyStage();
    const rows = unnumberedRows(rig.stageId, rig.divisionId, 2, "nodiv").map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "division_id")));
    let sent = -1;
    const err = await withTenant(rig.auth.orgId, async (tx) => {
      const before = statementCount();
      try {
        await insertFixtureRows(tx, rows);
      } finally {
        sent = statementCount() - before;
      }
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(err)).toMatch(/insertFixtureRows: a row names no division/);
    expect(sent, "nothing sent").toBe(0);
  });

  it("rows a caller numbered itself keep their numbers (no lock, no read)", async () => {
    const rig = await emptyStage();
    let sent = 0;
    await withTenant(rig.auth.orgId, async (tx) => {
      const before = statementCount();
      await insertFixtureRows(tx, shellRows(rig.stageId, rig.divisionId, 3));
      sent = statementCount() - before;
    });
    const nos = (await sql<{ fixture_no: number }[]>`select fixture_no from fixtures where stage_id = ${rig.stageId} order by fixture_no`).map((r) => r.fixture_no);
    expect(nos).toEqual([100_000, 100_001, 100_002]);
    expect(sent, "one statement: the insert alone").toBe(1);
  });
});

// W5 B4 review m-4: the batch's numbering and the V263 trigger's (the single-row writers': ad-hoc, a Swiss late entry, a restore)
// must take the SAME advisory key, or the two read the division's max side by side and hand out one number twice. Every caller holds
// `division:` today, so the bug would be latent - this pins the key itself, on two real connections, in both orders: the second
// writer WAITS on the first's numbering key (an ungranted advisory lock while the first is still open), then numbers after it, and the
// division's numbers come out unique and gap-free. A key the trigger does not take reds here: the second writer waits on the first's
// uncommitted row instead (a transactionid lock), and fails on the unique index once the first commits.
describe.skipIf(!HAS_DB)("F8: the batch and the trigger number under ONE key (m-4)", () => {
  type T = Parameters<Parameters<typeof withTenant>[1]>[0];
  it("a writer holding the numbering key makes the other WAIT, then number after it - batch first and trigger first", { timeout: 120_000 }, async () => {
    let checked = 0;
    for (const order of ["batch first", "trigger first"] as const) {
      const rig = await emptyStage();
      const batch = unnumberedRows(rig.stageId, rig.divisionId, 5, `${order === "batch first" ? "a" : "b"}-batch`);
      const [single] = unnumberedRows(rig.stageId, rig.divisionId, 1, `${order === "batch first" ? "a" : "b"}-one`);
      const byBatch = (tx: T) => insertFixtureRows(tx, batch);
      const byTrigger = (tx: T) => tx`insert into fixtures ${tx(single as never)}`;
      const [firstWrite, secondWrite] = order === "batch first" ? [byBatch, byTrigger] : [byTrigger, byBatch];

      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let holding!: () => void;
      const isHolding = new Promise<void>((resolve) => (holding = resolve));
      const first = withTenant(rig.auth.orgId, async (tx) => {
        await firstWrite(tx);
        holding();
        await released;
      });
      await isHolding;
      let secondPid = 0;
      const second = withTenant(rig.auth.orgId, async (tx) => {
        secondPid = (await tx<{ pid: number }[]>`select pg_backend_pid() as pid`)[0]!.pid;
        await secondWrite(tx);
      }).then(
        () => null,
        (e: unknown) => e,
      );
      // The second writer is blocked - and on WHICH lock is the point: the numbering key (advisory), not the first's row. The holder
      // is released whatever this finds, so a red here never leaves a transaction open behind it (the file's afterAll would hang).
      try {
        const waitingOn = await vi.waitFor(
          async () => {
            const rows = await sql<{ locktype: string }[]>`select locktype from pg_locks where pid = ${secondPid} and not granted`;
            if (secondPid === 0 || rows.length === 0) throw new Error("the second writer is not blocked yet");
            return rows.map((r) => r.locktype);
          },
          { timeout: 30_000, interval: 50 },
        );
        expect(waitingOn, `${order}: the second writer waits on the numbering key itself`).toEqual(["advisory"]);
      } finally {
        release();
      }
      await first;
      expect(await second, `${order}: the second writer goes through once the first commits`).toBeNull();

      const nos = await sql<{ fixture_no: number; ext_key: string }[]>`
        select fixture_no, ext_key from fixtures where division_id = ${rig.divisionId} order by fixture_no`;
      expect(nos.map((r) => r.fixture_no), `${order}: unique and gap-free`).toEqual([1, 2, 3, 4, 5, 6]);
      const firstKeys = (order === "batch first" ? batch : [single!]).map((r) => r.ext_key);
      expect(
        nos.slice(0, firstKeys.length).map((r) => r.ext_key),
        `${order}: the writer that held the key numbered first, in its row order`,
      ).toEqual(firstKeys);
      checked++;
    }
    expect(checked, "anti-vacuity: both orders").toBe(2);
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
