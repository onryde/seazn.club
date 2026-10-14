// V439 / D12: rounds are organiser-driven. The open stamp is its own table
// keyed (stage_id, round_no) because v2 has no rounds table — a round is a
// column on fixtures (V214__fixtures.sql:10). Claims:
//   - a round opens ONCE: a second press collides on the unique key, so
//     "Open round" is idempotent at the schema level, not just in the usecase;
//   - the row records WHO, and that actor cannot be deleted out from under it;
//   - its org IS its stage's org — one composite FK through stages_id_org_key,
//     so an open row cannot carry another tenant's org beside this stage;
//   - the EMPTY case first: a stage with no open row has no open rounds at
//     all, which is what "not yet playable" means and what every window
//     calculation now hangs off.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { seedOnlineChessFixture } from "./_external-play-seed";
import { seedOrg } from "./_seed";

const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";
const STAGE_ORG_FK = "stage_round_opens_stage_org_fkey";
const HAS_DB = !!process.env.DATABASE_URL;

type Outcome =
  | { accepted: true }
  | { accepted: false; code: string | undefined; constraint: string | undefined };

const attempt = (p: Promise<unknown>): Promise<Outcome> =>
  p.then(() => ({ accepted: true as const })).catch(
    (err: { code?: string; constraint_name?: string }) => ({
      accepted: false as const, code: err.code, constraint: err.constraint_name,
    }),
  );

describe.skipIf(!HAS_DB)("stage_round_opens (V439, D12)", () => {
  let orgId = "";
  let stageId = "";
  let userId = "";
  let foreignOrgId = "";

  beforeAll(async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess", divisionStarted: false, linked: true,
      scheduledAt: new Date(Date.now() + 86_400_000),
    });
    orgId = s.orgId;
    userId = s.home.userId;
    const [st] = await sql<{ id: string }[]>`
      select id from stages where division_id = ${s.divisionId}`;
    stageId = st!.id;
    foreignOrgId = (await seedOrg()).auth.orgId;
    if (foreignOrgId === orgId) throw new Error("foreign org is the stage's org");
  });

  afterAll(async () => {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });

  it("the empty case: a freshly seeded stage has NO opened rounds", async () => {
    const [{ count }] = await sql<{ count: string }[]>`
      select count(*)::text as count from stage_round_opens where stage_id = ${stageId}`;
    expect(Number(count)).toBe(0);
  });

  it("accepts the organiser's press, stamping when and who", async () => {
    expect(await attempt(sql`
      insert into stage_round_opens (stage_id, org_id, round_no, opened_by)
      values (${stageId}, ${orgId}, 1, ${userId})`,
    )).toEqual({ accepted: true });
    const [row] = await sql<{ opened_at: Date; opened_by: string; round_no: number }[]>`
      select opened_at, opened_by, round_no from stage_round_opens
       where stage_id = ${stageId} and round_no = 1`;
    expect(row!.opened_by).toBe(userId);
    expect(row!.round_no).toBe(1);
    expect(row!.opened_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("a round opens ONCE — a second press is refused, not a second window", async () => {
    expect(await attempt(sql`
      insert into stage_round_opens (stage_id, org_id, round_no, opened_by)
      values (${stageId}, ${orgId}, 1, ${userId})`,
    )).toEqual({
      accepted: false, code: UNIQUE_VIOLATION,
      constraint: "stage_round_opens_stage_id_round_no_key",
    });
  });

  it("round 2 of the same stage is a different round, not a duplicate", async () => {
    expect(await attempt(sql`
      insert into stage_round_opens (stage_id, org_id, round_no, opened_by)
      values (${stageId}, ${orgId}, 2, ${userId})`,
    )).toEqual({ accepted: true });
  });

  it("refuses deleting the organiser who opened a round", async () => {
    expect(await attempt(sql`delete from users where id = ${userId}`)).toEqual({
      accepted: false, code: FK_VIOLATION,
      constraint: "stage_round_opens_opened_by_fkey",
    });
  });

  it("refuses an open row for a stage that does not exist", async () => {
    expect(await attempt(sql`
      insert into stage_round_opens (stage_id, org_id, round_no, opened_by)
      values (${randomUUID()}, ${orgId}, 1, ${userId})`,
    )).toEqual({
      accepted: false, code: FK_VIOLATION, constraint: STAGE_ORG_FK,
    });
  });

  // Reviewer probe, 2026-10-09: a REAL stage with a REAL but different org was
  // accepted, because org_id was only proven to exist. The positive pair is
  // "accepts the organiser's press" above — same stage, its own org.
  it("refuses an open row whose org is not its stage's org", async () => {
    expect(await attempt(sql`
      insert into stage_round_opens (stage_id, org_id, round_no, opened_by)
      values (${stageId}, ${foreignOrgId}, 3, ${userId})`,
    )).toEqual({ accepted: false, code: FK_VIOLATION, constraint: STAGE_ORG_FK });
  });
});
