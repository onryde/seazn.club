// V433 camera policy: a column on competitions, divisions and stages, never a
// config key (divisions.config / stages.config are sport-module-validated
// snapshots that strip foreign keys — V209's own note). Competition is NOT NULL
// with 'off' for all existing data (design §5.1); division and stage are
// nullable = inherit (T6 ruling Q1=D: "set per division/stage, defaulting from
// the competition").
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { sql } from "@/lib/db";
import { CAMERA_POLICIES } from "@/lib/camera-policy";
import { seedOnlineChessFixture } from "./_external-play-seed";

const CHECK_VIOLATION = "23514";
const NOT_NULL_VIOLATION = "23502";
const HAS_DB = !!process.env.DATABASE_URL;

/** A rejection carries the constraint NAME for a CHECK, but Postgres sends no
 *  constraint name for a not-null violation (23502) — only SCHEMA/TABLE/COLUMN
 *  (verified against this server: `COLUMN NAME: email`, no `CONSTRAINT NAME`).
 *  Both are captured so each case can assert the field its SQLSTATE actually
 *  populates, instead of asserting `undefined` and passing on any error. */
type Outcome =
  | { accepted: true }
  | {
      accepted: false;
      code: string | undefined;
      constraint: string | undefined;
      column: string | undefined;
    };

const attempt = (p: Promise<unknown>): Promise<Outcome> =>
  p.then(() => ({ accepted: true as const })).catch(
    (err: { code?: string; constraint_name?: string; column_name?: string }) => ({
      accepted: false as const,
      code: err.code,
      constraint: err.constraint_name,
      column: err.column_name,
    }),
  );

describe.skipIf(!HAS_DB)("camera policy columns (V433)", () => {
  let orgId = "";
  let divisionId = "";
  let stageId = "";
  let competitionId = "";

  beforeAll(async () => {
    const seeded = await seedOnlineChessFixture({
      onlinePlay: "lichess", divisionStarted: false, linked: true,
      scheduledAt: new Date(Date.now() + 86_400_000),
    });
    orgId = seeded.orgId;
    divisionId = seeded.divisionId;
    // seedOnlineChessFixture returns no stageId/competitionId — read them back.
    const [s] = await sql<{ id: string; competition_id: string }[]>`
      select st.id, d.competition_id
        from stages st join divisions d on d.id = st.division_id
       where st.division_id = ${divisionId}`;
    stageId = s!.id;
    competitionId = s!.competition_id;
  });

  afterAll(async () => {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });

  it("every existing competition defaults to 'off' — zero video spend on legacy data", async () => {
    const [row] = await sql<{ camera_policy: string }[]>`
      select camera_policy from competitions where id = ${competitionId}`;
    expect(row!.camera_policy).toBe("off");
  });

  it("a stage inherits by default: its own policy is null", async () => {
    const [row] = await sql<{ camera_policy: string | null }[]>`
      select camera_policy from stages where id = ${stageId}`;
    expect(row!.camera_policy).toBeNull();
  });

  it.each(["off", "optional", "required"])("accepts the policy %s on a stage", async (p) => {
    await sql`update stages set camera_policy = ${p} where id = ${stageId}`;
    const [row] = await sql<{ camera_policy: string }[]>`
      select camera_policy from stages where id = ${stageId}`;
    expect(row!.camera_policy).toBe(p);
    await sql`update stages set camera_policy = null where id = ${stageId}`;
  });

  it("refuses a policy outside the vocabulary, by constraint name", async () => {
    expect(
      await attempt(sql`update stages set camera_policy = 'mandatory' where id = ${stageId}`),
    ).toEqual({
      accepted: false,
      code: CHECK_VIOLATION,
      constraint: "stages_camera_policy_check",
      column: undefined,
    });
  });

  it("refuses a null competition policy — the inheritance chain has a floor", async () => {
    expect(
      await attempt(sql`update competitions set camera_policy = null where id = ${competitionId}`),
    ).toEqual({
      accepted: false,
      code: NOT_NULL_VIOLATION,
      constraint: undefined,
      column: "camera_policy",
    });
  });

  // T6 (ruling Q1=D): the division level. Every probe runs in a transaction
  // that is ALWAYS rolled back, so the cases share one seeded parent and
  // leave no rows behind for the next case to trip over.
  describe("divisions.camera_policy", () => {
    const ROLLBACK = new Error("rollback sentinel");
    async function rolledBack<T>(body: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
      let out: T | undefined;
      await sql
        .begin(async (tx) => {
          out = await body(tx);
          throw ROLLBACK;
        })
        .catch((err: unknown) => {
          if (err !== ROLLBACK) throw err;
        });
      return out as T;
    }

    it("empty case: a division inherits by default — its own policy is null", async () => {
      const [row] = await sql<{ camera_policy: string | null }[]>`
        select camera_policy from divisions where id = ${divisionId}`;
      expect(row!.camera_policy).toBeNull();
    });

    it("accepts every declared policy, and null, and reports how many it checked", async () => {
      let checked = 0;
      for (const p of [...CAMERA_POLICIES, null]) {
        const got = await rolledBack(async (tx) => {
          await tx`update divisions set camera_policy = ${p} where id = ${divisionId}`;
          const [row] = await tx<{ camera_policy: string | null }[]>`
            select camera_policy from divisions where id = ${divisionId}`;
          return row!.camera_policy;
        });
        expect(got, `policy ${p}`).toBe(p);
        checked += 1;
      }
      expect(checked, "anti-vacuity: 3 policies + null").toBe(4);
    });

    it("refuses a policy outside the vocabulary, by SQLSTATE and constraint name", async () => {
      const outcome = await rolledBack((tx) =>
        attempt(tx`update divisions set camera_policy = 'mandatory' where id = ${divisionId}`),
      );
      expect(outcome).toEqual({
        accepted: false,
        code: CHECK_VIOLATION,
        constraint: "divisions_camera_policy_check",
        column: undefined,
      });
      // …and the refused value never landed.
      const [row] = await sql<{ camera_policy: string | null }[]>`
        select camera_policy from divisions where id = ${divisionId}`;
      expect(row!.camera_policy).toBeNull();
    });
  });

  it("the org seeded here is real — the suite is not vacuously green", () => {
    expect(orgId).toMatch(/^[0-9a-f-]{36}$/);
    expect(randomUUID()).not.toBe(orgId);
  });
});
