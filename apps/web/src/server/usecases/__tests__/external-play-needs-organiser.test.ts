// The organiser queue's reader, rebuilt against V432 (the pre-redesign one was
// deleted in 340dce7ed with its schema). It is what the division page's
// fixtures tab calls, so it is imported here through the SAME path the page
// uses: the `@/server/usecases/external-play` index.
// Single-sport by construction: only a boardgame division can carry online
// play, so only a chess fixture can ever own a fixture_external_play row.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { NEEDS_REASONS } from "@/server/external-play/types";
import { listNeedsOrganiserExternalPlay, readNeedsReason } from "@/server/usecases/external-play";
import { createDivision } from "../divisions";
import { createStages } from "../stages";
import { seedOnlineChessFixture } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const T = new Date("2026-10-01T12:10:00.000Z");

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

async function seeded() {
  const s = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, scheduledAt: T, linked: true });
  const auth = { orgId: s.orgId, via: "session", userId: s.ownerUserId, role: "owner", keyId: null } as AuthCtx;
  const [f] = await sql<{ fixture_no: number | null }[]>`select fixture_no from fixtures where id = ${s.fixtureId}`;
  return { ...s, auth, fixtureNo: f?.fixture_no ?? null };
}

async function bridge(fixtureId: string, orgId: string, status: string, reason: string | null, lastError: string | null) {
  await sql`
    insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis, needs_reason, last_error)
    values (${fixtureId}, ${orgId}, ${status}, ${T}, ${reason}, ${lastError})`;
}

describe.skipIf(!HAS_DB)("listNeedsOrganiserExternalPlay", () => {
  it("empty case: a division whose fixture has no bridge row lists nothing", async () => {
    const s = await seeded();
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixture_external_play where fixture_id = ${s.fixtureId}`;
    expect(n, "premise: no bridge row").toBe(0);
    expect(await listNeedsOrganiserExternalPlay(s.auth, s.divisionId)).toEqual([]);
  });

  it("one needs_organiser row is listed, with its reason and its last error", async () => {
    const s = await seeded();
    await bridge(s.fixtureId, s.orgId, "needs_organiser", "not_started", "lichess answered 503");
    expect(await listNeedsOrganiserExternalPlay(s.auth, s.divisionId)).toEqual([
      {
        fixtureId: s.fixtureId,
        fixtureNo: s.fixtureNo,
        homeName: "White",
        awayName: "Black",
        scheduledAt: T.toISOString(),
        reason: "not_started",
        lastError: "lichess answered 503",
      },
    ]);
  });

  it("the SEQUENCE through every other status: listed only while needs_organiser", async () => {
    const s = await seeded();
    await bridge(s.fixtureId, s.orgId, "needs_organiser", "aborted", null);
    expect((await listNeedsOrganiserExternalPlay(s.auth, s.divisionId)).map((r) => r.reason)).toEqual(["aborted"]);
    // V432's status CHECK, minus needs_organiser — typed from the migration.
    const others = ["pending", "ready", "live", "finished"];
    let checked = 0;
    for (const status of others) {
      await sql`update fixture_external_play set status = ${status}, needs_reason = null where fixture_id = ${s.fixtureId}`;
      expect(await listNeedsOrganiserExternalPlay(s.auth, s.divisionId), status).toEqual([]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every other status").toBe(4);
    await sql`
      update fixture_external_play set status = 'needs_organiser', needs_reason = 'mismatch'
       where fixture_id = ${s.fixtureId}`;
    expect((await listNeedsOrganiserExternalPlay(s.auth, s.divisionId)).map((r) => r.reason), "back again").toEqual([
      "mismatch",
    ]);
  });

  it("every reason V432 admits is listed as itself, and the TS vocabulary IS the CHECK", async () => {
    // The authority is the database: read the needs_reason CHECK's literals.
    const [def] = await sql<{ d: string }[]>`
      select pg_get_constraintdef(c.oid) as d from pg_constraint c
       where c.conrelid = 'fixture_external_play'::regclass
         and pg_get_constraintdef(c.oid) like '%needs_reason = ANY%'`;
    const dbReasons = [...(def?.d ?? "").matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
    expect(dbReasons.length, "premise: the CHECK was found and parsed").toBeGreaterThan(0);
    expect([...NEEDS_REASONS].sort()).toEqual(dbReasons);

    const s = await seeded();
    await bridge(s.fixtureId, s.orgId, "needs_organiser", NEEDS_REASONS[0]!, null);
    let checked = 0;
    for (const reason of dbReasons) {
      await sql`update fixture_external_play set needs_reason = ${reason} where fixture_id = ${s.fixtureId}`;
      const rows = await listNeedsOrganiserExternalPlay(s.auth, s.divisionId);
      expect(rows.map((r) => r.reason), reason).toEqual([reason]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every reason in the CHECK").toBe(dbReasons.length);
  });

  it("another division of the SAME organisation keeps its own queue; a nameless pairing reads as empty names", async () => {
    const s = await seeded();
    await bridge(s.fixtureId, s.orgId, "needs_organiser", "no_show_both", null);
    const other = await createDivision(s.auth, s.competitionId, {
      name: "Second",
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical", onlinePlay: "lichess", clock: { base: 600, increment: 5 } },
    });
    const [stage] = await createStages(s.auth, other.id, { seq: 1, kind: "league", name: "RR", config: {} });
    const [fx] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status, scheduled_at)
      values (${stage!.id}, ${other.id}, ${s.orgId}, 1, 1, ${`q2-${s.fixtureId.slice(0, 6)}`}, 'scheduled', ${T})
      returning id`;
    await bridge(fx!.id, s.orgId, "needs_organiser", "token_revoked", null);
    expect((await listNeedsOrganiserExternalPlay(s.auth, s.divisionId)).map((r) => r.fixtureId)).toEqual([s.fixtureId]);
    const second = await listNeedsOrganiserExternalPlay(s.auth, other.id);
    expect(second.map((r) => [r.fixtureId, r.homeName, r.awayName, r.reason])).toEqual([
      [fx!.id, "", "", "token_revoked"],
    ]);
  });

  it("TENANCY: another organisation's row is never listed, even asked for by its division id", async () => {
    const a = await seeded();
    const b = await seeded();
    await bridge(b.fixtureId, b.orgId, "needs_organiser", "provider_error", null);
    // The positive pair first: the row is real and eligible for its own org.
    expect((await listNeedsOrganiserExternalPlay(b.auth, b.divisionId)).map((r) => r.fixtureId)).toEqual([
      b.fixtureId,
    ]);
    expect(await listNeedsOrganiserExternalPlay(a.auth, b.divisionId)).toEqual([]);
  });
});

describe("readNeedsReason — the CHECK makes junk impossible; the reader still refuses it", () => {
  it("passes each declared reason through and refuses anything else with a 500", () => {
    let checked = 0;
    for (const r of NEEDS_REASONS) {
      expect(readNeedsReason(r)).toBe(r);
      checked += 1;
    }
    expect(checked).toBe(NEEDS_REASONS.length);
    for (const junk of [null, "no_show_grace_elapsed", "", 1]) {
      let caught: unknown;
      try {
        readNeedsReason(junk);
      } catch (err) {
        caught = err;
      }
      expect(caught, String(junk)).toBeInstanceOf(HttpError);
      expect((caught as HttpError).status).toBe(500);
      expect((caught as HttpError).code).toBe("NEEDS_REASON_UNKNOWN");
    }
  });
});
