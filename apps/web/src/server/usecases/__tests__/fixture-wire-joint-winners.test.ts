// W4 app B, B5b Task 13 (X-CH-4; the gap B5a left): the Fixture API wire carries `joint_winners_at`. A joint-winners final
// is stored `decided` with NO outcome, so without the column a client reading `GET /fixtures/{id}` sees a decided match
// with no result and cannot tell a ruling from a bug. Real Postgres, through the usecases the routes return unmapped.
//
// Expected values come from the rulebook (a declared final carries WHEN it was ruled; every other fixture carries null),
// never from the code under test. Sequence, not only the feature: before the declaration, after it, after the Undo.
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { Fixture } from "@/server/api-v1/schemas";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { playBadminton, rowsOf } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { declareJointWinners, undoJointWinners } from "../joint-winners";
import { getFixture, listDivisionFixtures, patchFixture } from "../fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

describe("Fixture wire schema: joint_winners_at is declared, optional and nullable", () => {
  // The empty case first: a hand-built row that predates the column (dozens of tests build these) still parses.
  it("a row without the key parses, and the key stays absent", () => {
    const row = {
      id: "00000000-0000-4000-8000-000000000001",
      stage_id: "00000000-0000-4000-8000-000000000002",
      division_id: "00000000-0000-4000-8000-000000000003",
    };
    const shape = Object.keys(Fixture.shape);
    expect(shape, "anti-vacuity: the schema has fields").toContain("is_final");
    expect(shape).toContain("joint_winners_at");
    expect(Fixture.shape.joint_winners_at!.safeParse(undefined).success, "absent is fine").toBe(true);
    expect(Fixture.shape.joint_winners_at!.safeParse(null).success, "null is fine").toBe(true);
    expect(Fixture.shape.joint_winners_at!.safeParse("2026-11-10T12:00:00.000Z").success).toBe(true);
    expect(Fixture.shape.joint_winners_at!.safeParse(123).success, "a number is not a timestamp").toBe(false);
    void row;
  });
});

describe.skipIf(!HAS_DB)("B5b T13: the Fixture wire carries joint_winners_at (real Postgres)", () => {
  async function finalSeated() {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 4 });
    const rows = await rowsOf(s.stageId);
    for (const sf of rows.filter((r) => r.home_entrant_id && r.away_entrant_id)) await playBadminton(s.auth, sf.id, true);
    const [final] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${s.stageId} and is_final and not third_place`;
    return { ...s, finalId: final!.id };
  }

  it("null before the ruling, an ISO timestamp on a joint final, null again after the Undo - on the single read, the list and the PATCH", async () => {
    const r = await finalSeated();
    const reads = async () => {
      const one = await getFixture(r.auth, r.finalId);
      const listed = (await listDivisionFixtures(r.auth, r.divisionId)).find((f) => f.id === r.finalId)!;
      const patched = await patchFixture(r.auth, r.finalId, {});
      return { one, listed, patched };
    };

    const before = await reads();
    for (const [name, row] of Object.entries(before)) expect(row.joint_winners_at, `before the ruling (${name})`).toBeNull();

    await declareJointWinners(r.auth, r.finalId);
    const [db] = await sql<{ at: Date }[]>`select joint_winners_at as at from fixtures where id = ${r.finalId}`;
    const during = await reads();
    let checked = 0;
    for (const [name, row] of Object.entries(during)) {
      expect(typeof row.joint_winners_at, `on a joint final (${name}) it is a string`).toBe("string");
      expect(row.joint_winners_at, `(${name})`).toMatch(ISO);
      expect(new Date(row.joint_winners_at as string).getTime(), `(${name}) is the stored instant`).toBe(db!.at.getTime());
      checked++;
    }
    expect(checked, "anti-vacuity: three reads checked").toBe(3);
    // The published schema keeps it: the route serialises the row, and parsing that wire through `Fixture` must not strip the key.
    expect(Fixture.parse(JSON.parse(JSON.stringify(during.one))).joint_winners_at).toBe(during.one.joint_winners_at);
    // The decided final carries no outcome - the reason a client needs the field.
    expect(during.one.outcome).toBeNull();
    expect(during.one.status).toBe("decided");

    await undoJointWinners(r.auth, r.finalId);
    const after = await reads();
    for (const [name, row] of Object.entries(after)) expect(row.joint_winners_at, `after the Undo (${name})`).toBeNull();
  });

  it("another fixture of the same bracket (a semi-final) carries null while the final is ruled joint", async () => {
    const r = await finalSeated();
    await declareJointWinners(r.auth, r.finalId);
    const list = await listDivisionFixtures(r.auth, r.divisionId);
    const others = list.filter((f) => f.id !== r.finalId);
    expect(others.length, "anti-vacuity: the bracket has other fixtures").toBeGreaterThan(0);
    for (const f of others) expect(f.joint_winners_at, `fixture ${f.id}`).toBeNull();
  });
});
