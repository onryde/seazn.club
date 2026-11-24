// V553 (Seazn-hosted video, Phase 4 Task 33): the org's Seazn switch lives on its `seazn` destination row (V541), as
// `org_stream_targets.offered`. Default ON, so every row that existed and every row the V541 trigger makes reads on; only the Seazn
// row may ever read off. Each refusal has its accepted twin in the same `it`, so an empty schema cannot pass (AGENTS.md class 3):
// the twin fails with "column does not exist" first.
//
// Real Postgres required; skipped without DATABASE_URL like every DB suite here. org_stream_targets is FORCE RLS with zero policies
// (V410), so it is reached through the plain `sql` client.
import { describe, expect, it } from "vitest";
import { sql, type Tx } from "@/lib/db";
import { seedOrg } from "@/server/usecases/__tests__/_rig";

const HAS_DB = !!process.env.DATABASE_URL;
/** The constraint V553 names; the refusals below must carry exactly this name, so a differently-named check fails here. */
const OFFERED_CHECK = "org_stream_targets_offered_seazn_only";

const failure = async (p: PromiseLike<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; constraint_name?: string };
    return `${err.code ?? "thrown"}:${err.constraint_name ?? ""}`;
  }
  return "landed";
};

/** Runs `fn` in a transaction that is ALWAYS rolled back, so a probe never leaves a row switched off for another suite to read. */
const ROLLBACK = new Error("rollback: probes leave nothing behind");
async function rolledBack(fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}
const probe = (tx: Tx, q: (sp: Tx) => PromiseLike<unknown>): Promise<string> => failure(tx.savepoint((sp) => q(sp as Tx)));

describe.skipIf(!HAS_DB)("V553__seazn_offered.sql — the org's Seazn switch is real", () => {
  it("offered is a NOT NULL boolean defaulting to true; the V541 trigger's Seazn row and a pasted row both read true", async () => {
    const [col] = await sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name = 'org_stream_targets' and column_name = 'offered'`;
    expect(col).toEqual({ data_type: "boolean", is_nullable: "NO", column_default: "true" });
    const { auth } = await seedOrg();
    await sql`insert into org_stream_targets (org_id, kind, label, rtmp_enc) values (${auth.orgId}, 'youtube', 'Pasted', ${Buffer.from("not-a-real-envelope")})`;
    const rows = await sql<{ kind: string; offered: boolean }[]>`
      select kind, offered from org_stream_targets where org_id = ${auth.orgId} order by kind`;
    expect(rows).toEqual([{ kind: "seazn", offered: true }, { kind: "youtube", offered: true }]);
  });

  it("only the Seazn row may be off: a pasted row switched off (update or insert) is refused by the named check; the Seazn row goes off and back on", async () => {
    const { auth } = await seedOrg();
    const orgId = auth.orgId;
    const key = Buffer.from("not-a-real-envelope");
    let probes = 0;
    await rolledBack(async (tx) => {
      const [pasted] = await tx<{ id: string }[]>`
        insert into org_stream_targets (org_id, kind, label, rtmp_enc) values (${orgId}, 'twitch', 'Pasted', ${key}) returning id`;
      expect(await probe(tx, (sp) => sp`update org_stream_targets set offered = false where id = ${pasted!.id}`), "a pasted row switched off")
        .toBe(`23514:${OFFERED_CHECK}`);
      expect(await probe(tx, (sp) => sp`insert into org_stream_targets (org_id, kind, label, rtmp_enc, offered) values (${orgId}, 'youtube', 'Off', ${key}, false)`),
        "a pasted row inserted off").toBe(`23514:${OFFERED_CHECK}`);
      expect(await probe(tx, (sp) => sp`update org_stream_targets set offered = false where org_id = ${orgId} and kind = 'seazn'`), "the Seazn row off")
        .toBe("landed");
      expect(await probe(tx, (sp) => sp`update org_stream_targets set offered = true where org_id = ${orgId} and kind = 'seazn'`), "the Seazn row back on")
        .toBe("landed");
      probes = 4;
    });
    expect(probes, "probes run").toBe(4);
    const [after] = await sql<{ offered: boolean }[]>`select offered from org_stream_targets where org_id = ${orgId} and kind = 'seazn'`;
    expect(after, "the rollback left the org's switch on").toEqual({ offered: true });
  });

  it("every non-Seazn row in the database reads on (the check holds over the whole table, counted)", async () => {
    const { auth } = await seedOrg();
    await sql`insert into org_stream_targets (org_id, kind, label, rtmp_enc) values (${auth.orgId}, 'youtube', 'Counted', ${Buffer.from("not-a-real-envelope")})`;
    const [{ checked, off }] = await sql<{ checked: number; off: number }[]>`
      select count(*)::int as checked, count(*) filter (where not offered)::int as off from org_stream_targets where kind <> 'seazn'`;
    expect(checked, "anti-vacuity: rows checked").toBeGreaterThan(0);
    expect(off).toBe(0);
  });
});
