// W2a Task 7 — V432 adds `needs_decision` to fixtures.status and backfills legacy level bracket rows (ruling 82).
// The SQL literals are held to the engine's and the app's own declarations (BRACKET_KINDS, FIXTURE_STATUSES), so
// neither can drift from the migration unseen. The DB cases run the migration's OWN statements, read from the file.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { BRACKET_KINDS } from "@seazn/engine/core";
import { connectionOptions, sql } from "@/lib/db";
import { FIXTURE_STATUSES } from "@/lib/fixture-status";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";

const HAS_DB = !!process.env.DATABASE_URL;
const FILE = resolve(__dirname, "../../../../../db/migration/deltas/V432__fixture_status_needs_decision.sql");
const text = readFileSync(FILE, "utf8");
/** The statements, comments removed: a `--` line naming a literal must not satisfy a regex meant for the SQL. */
const code = text.replace(/--.*$/gm, "");

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const literalSet = (inner: string) => new Set(inner.replace(/\s/g, "").split(",").map((s) => s.replace(/'/g, "")));

describe("V432 needs_decision", () => {
  it("the SQL bracket-kind literal is exactly the engine's BRACKET_KINDS", () => {
    const m = /s\.kind in \(([^)]*)\)/.exec(code);
    expect(m).not.toBeNull();
    expect(literalSet(m![1]!)).toEqual(new Set(BRACKET_KINDS));
  });
  it("the check constraint's status list is exactly FIXTURE_STATUSES", () => {
    const m = /status in\s*\(([^)]*)\)\);/.exec(code);
    expect(m).not.toBeNull();
    expect(literalSet(m![1]!)).toEqual(new Set(FIXTURE_STATUSES));
  });
  it.skipIf(!HAS_DB)("the live DB accepts needs_decision, refuses an unknown status, and clears finished_at for it", async () => {
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    const id = s.fixtureIds[0]!;
    await sql`update fixtures set status = 'decided' where id = ${id}`;
    const [before] = await sql<{ finished_at: Date | null }[]>`select finished_at from fixtures where id = ${id}`;
    expect(before!.finished_at).not.toBeNull(); // the positive pair: decided IS finished
    await sql`update fixtures set status = 'needs_decision' where id = ${id}`;
    const [row] = await sql<{ status: string; finished_at: Date | null }[]>`select status, finished_at from fixtures where id = ${id}`;
    expect(row).toEqual({ status: "needs_decision", finished_at: null });
    await expect(sql`update fixtures set status = 'needs_decisions' where id = ${id}`).rejects.toThrow(/fixtures_status_check/);
  });
  it.skipIf(!HAS_DB)("ruling 82 backfill: V432's update moves a decided level KNOCKOUT row to needs_decision and leaves a level LEAGUE row decided", async () => {
    // Preflight C15. Runs the migration's OWN update statement (read from the file, never retyped), inside a
    // transaction that is rolled back, so the shared test DB keeps every other row as it was.
    const update = /update fixtures f set status = 'needs_decision'[\s\S]*?;/.exec(code)?.[0];
    expect(update, "V432 holds the backfill update").toBeDefined();
    const ko = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    const lg = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "league", entrants: 2 });
    const koId = ko.fixtureIds[0]!;
    const lgId = lg.fixtureIds[0]!;
    const ROLLBACK = new Error("rollback");
    let seen: { id: string; status: string }[] = [];
    await expect(
      sql.begin(async (tx) => {
        await tx`update fixtures set status = 'decided', outcome = '{"kind":"draw"}'::jsonb where id in (${koId}, ${lgId})`;
        await tx.unsafe(update!);
        seen = await tx<{ id: string; status: string }[]>`select id, status from fixtures where id in (${koId}, ${lgId})`;
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
    const byId = new Map(seen.map((r) => [r.id, r.status]));
    expect(byId.size).toBe(2); // both rows were read inside the transaction
    expect(byId.get(koId)).toBe("needs_decision");
    expect(byId.get(lgId)).toBe("decided"); // the negative pair: a league draw is a result, never held
  });
  it.skipIf(!HAS_DB)("review M-4: V432's backfill block reports the rows it moved and the complete stages that hold one, and leaves those stages complete", async () => {
    // The migration's OWN `do` block (read from the file), on a dedicated one-connection client that records the
    // NOTICE, inside a rolled-back transaction. The shared test DB holds other suites' rows, so the counts are held
    // to what the transaction itself saw change, never to a number typed here.
    const block = /do \$\$[\s\S]*?end \$\$;/.exec(code)?.[0];
    expect(block, "V432 wraps its backfill in a do block").toBeDefined();
    const ko = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    const koId = ko.fixtureIds[0]!;
    const url = process.env.DATABASE_URL!;
    /** The block once, on its own client and rolled back, with our knockout stage at `stageStatus`. */
    async function runBlock(stageStatus: "complete" | "active") {
      const notices: string[] = [];
      const client = postgres(url, {
        max: 1,
        ssl: connectionOptions(url).ssl,
        connection: { search_path: connectionOptions(url).schema },
        onnotice: (n) => notices.push(String(n.message)),
      });
      const ROLLBACK = new Error("rollback");
      let delta = -1;
      let stageAfter = "";
      try {
        await expect(
          client.begin(async (tx) => {
            await tx`update fixtures set status = 'decided', outcome = '{"kind":"draw"}'::jsonb where id = ${koId}`;
            await tx`update stages set status = ${stageStatus} where id = ${ko.stageId}`;
            const [b] = await tx<{ n: number }[]>`select count(*)::int as n from fixtures where status = 'needs_decision'`;
            await tx.unsafe(block!);
            const [a] = await tx<{ n: number }[]>`select count(*)::int as n from fixtures where status = 'needs_decision'`;
            delta = a!.n - b!.n;
            stageAfter = (await tx<{ status: string }[]>`select status from stages where id = ${ko.stageId}`)[0]!.status;
            throw ROLLBACK;
          }),
        ).rejects.toBe(ROLLBACK);
      } finally {
        await client.end();
      }
      const v432 = notices.filter((n) => n.startsWith("V432"));
      expect(v432, `${stageStatus}: exactly one V432 notice`).toHaveLength(1);
      const m = /moved=(\d+).*complete_stages_holding_one=(\d+)/.exec(v432[0]!);
      expect(m, v432[0]).not.toBeNull();
      return { delta, moved: Number(m![1]), completeStages: Number(m![2]), stageAfter };
    }
    const complete = await runBlock("complete");
    expect(complete.delta).toBeGreaterThanOrEqual(1); // our row moved
    expect(complete.moved).toBe(complete.delta); // the notice counts exactly the rows the block moved
    expect(complete.completeStages).toBeGreaterThanOrEqual(1); // our complete knockout stage holds one
    expect(complete.stageAfter, "stages.status is a stored flag: the backfill does not reopen a complete stage").toBe("complete");
    // Review N5: the same database with OUR stage still active — every other row identical (both runs roll back) —
    // counts exactly one complete stage fewer. Without the `status = 'complete'` filter the two would be equal.
    const active = await runBlock("active");
    expect(active.moved).toBe(active.delta);
    expect(active.delta).toBe(complete.delta); // the stage's status does not change what moves
    expect(complete.completeStages - active.completeStages, "our stage is counted only while complete").toBe(1);
    expect(active.stageAfter).toBe("active");
  });
});
