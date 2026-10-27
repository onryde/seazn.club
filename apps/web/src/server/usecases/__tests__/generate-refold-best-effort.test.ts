// W2d concern 2 review m4: the generate's table refold runs AFTER the fixtures committed (usecases/stages.ts
// `refoldStageTable`). A refold that throws — a rank-time refusal, anti-goal 2 — must not turn the committed generate
// into a failed one: the caller would retry, create 0 and see success, with the event and the page refresh skipped the
// first time. The refold is logged and the table is left to the next refold. Real Postgres; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));
const refold = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock("@/server/engine-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/engine-db")>();
  return {
    ...actual,
    recomputeStandings: async (...args: Parameters<typeof actual.recomputeStandings>) => {
      refold.calls++;
      if (refold.fail) throw new Error("test: a rank-time refusal");
      return actual.recomputeStandings(...args);
    },
  };
});

import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { deleteEntrant } from "@/server/usecases/entrants";
import { generateStageFixtures, getStandings } from "@/server/usecases/stages";
import { tableScene } from "@/server/engine-db/__tests__/helpers/w2d-table-rig";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const count = async (table: "fixtures" | "standings_snapshots", stageId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)} where stage_id = ${stageId}`)[0]!.n;

describe.skipIf(!HAS_DB)("W2d concern 2 m4 — the post-commit table refold is best-effort", () => {
  it("a refold that throws leaves the generate committed and successful, logs it, and the organiser's read writes the table", async () => {
    // single-sport: the refold's failure handling is the usecase's (sport-agnostic)
    const s = await tableScene({ entrants: 4 });
    const stageId = s.stageIds[0]!;
    const errors = vi.spyOn(log, "error");
    refold.fail = true;
    refold.calls = 0;
    const out = await generateStageFixtures(s.auth, stageId);
    expect(refold.calls, "premise: the generate tried its refold").toBe(1);
    expect(out.created, "the generate still answers with what it created").toBe(6);
    expect(await count("fixtures", stageId), "and its fixtures stay committed").toBe(6);
    expect(await count("standings_snapshots", stageId), "no table was written").toBe(0);
    expect(errors.mock.calls.some(([o]) => (o as { event?: string })?.event === "stage_table_refold_failed"), "the refusal is logged").toBe(true);
    // Same helper on the roster delete: the delete commits too.
    await deleteEntrant(s.auth, s.entrants[3]!);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from entrants where id = ${s.entrants[3]!}`)[0]!.n, "the delete committed").toBe(0);
    // Recovery: the organiser's Standings read refolds lazily.
    refold.fail = false;
    const read = await getStandings(s.auth, stageId);
    expect(read.rows.length, "the organiser's read writes the table of the 3 left").toBe(3);
    expect(await count("standings_snapshots", stageId)).toBe(1);
    errors.mockRestore();
  });
});
