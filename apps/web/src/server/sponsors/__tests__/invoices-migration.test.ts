// Sponsor deals, Task 20 (plan 2026-11-07-sponsor-deals D11, F10; spec §7): the invoices delta. Invoice numbers run per org from
// a counter table, `sponsor_orders` carries the deal's number and its invoice token's hash, and `organizations` carries the
// address and bank details printed on every sponsor invoice.
//
// A constraint is only real if something tries to violate it (AGENTS.md class 3), so every named constraint below has a refused
// row AND an accepted twin in the same `it`, and every refusal names its CONSTRAINT, not just its SQLSTATE. Expected values are
// the brief's literals (the column types, RESTRICT, the grant list), never read back from the delta and compared to itself.
// Every sweep reports how many items it checked, and zero checked is a failure. "Another sport" is not applicable: sponsors
// read no sport key.
//
// Rows are written on the privileged `sql` client; the RLS case runs under `withTenant`. Real Postgres required (skipped
// without DATABASE_URL like every DB suite under src/server).
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sql, withTenant } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

// ---- the delta, found by SUFFIX, never by number (it is renumbered at merge: a pure `git mv`) ------------------------------
const DELTAS_DIR = resolve(__dirname, "../../../../../../db/migration/deltas");
const INVOICES_DELTA = /^V\d+__sponsor_invoices\.sql$/;
const DELTA_MATCHES = readdirSync(DELTAS_DIR).filter((f) => INVOICES_DELTA.test(f));
const DELTA_FILE = resolve(DELTAS_DIR, DELTA_MATCHES[0] ?? "the-sponsor-invoices-delta-is-missing.sql");
const deltaText = (): string => readFileSync(DELTA_FILE, "utf8");
/** The delta's SQL with its `--` comments removed, so prose about a statement never passes for the statement. */
const deltaSql = (): string => deltaText().replace(/--.*$/gm, "");

// ---- the brief's literals --------------------------------------------------------------------------------------------------
/** Every column the delta adds: [table, column, information_schema data_type, nullable, default]. */
const NEW_COLUMNS: readonly [string, string, string, "YES" | "NO", string | null][] = [
  ["sponsor_orders", "invoice_number", "integer", "YES", null],
  ["sponsor_orders", "invoice_token_hash", "bytea", "YES", null],
  ["organizations", "sponsor_invoice_address", "text", "YES", null],
  ["organizations", "sponsor_invoice_bank_details", "text", "YES", null],
  ["sponsor_invoice_counters", "org_id", "uuid", "NO", null],
  ["sponsor_invoice_counters", "last_number", "integer", "NO", null],
];

// ---- rig ---------------------------------------------------------------------------------------------------------------------
const uniq = () => randomUUID().slice(0, 8);
const made = { orgIds: [] as string[] };
const refusedBy = (code: string, constraint: string) => ({ code, constraint_name: constraint });

async function newOrg(): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values ('Invoices Org', ${`invoices-${uniq()}`}) returning id`;
  made.orgIds.push(id);
  return id;
}

interface World {
  orgId: string;
  packageId: string;
}

async function world(): Promise<World> {
  const orgId = await newOrg();
  const [{ id: packageId }] = await sql<{ id: string }[]>`
    insert into sponsor_packages (org_id, competition_id, name, price_cents, currency, tier)
    values (${orgId}, ${null}, 'Partner', 25000, 'gbp', 'partner') returning id`;
  return { orgId, packageId };
}

/** An offline deal awaiting payment, with every deal column explicit; `over` changes it (its number, its token hash). */
async function insertDeal(w: World, over: Record<string, unknown> = {}): Promise<string> {
  const [{ id: sponsorId }] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, name) values (${w.orgId}, ${`Acme ${uniq()}`}) returning id`;
  const row: Record<string, unknown> = {
    org_id: w.orgId, package_id: w.packageId, sponsor_name: "Acme", sponsor_email: null,
    amount_cents: 25000, currency: "gbp", status: "pending", sponsor_id: sponsorId,
    deal_status: "awaiting_payment", payment_method: "offline", go_live: "on_payment",
    tier: "partner", includes_on_stream: false, package_name: "Partner", competition_id: null,
    ...over,
  };
  const [r] = await sql<{ id: string }[]>`insert into sponsor_orders ${sql(row as Record<string, never>)} returning id`;
  return r!.id;
}

const counterRow = (orgId: string, lastNumber: number) =>
  sql`insert into sponsor_invoice_counters (org_id, last_number) values (${orgId}, ${lastNumber}) returning org_id`;

afterAll(async () => {
  if (!HAS_DB) return;
  // The counter and the deals RESTRICT their org (V299's money-record rule; a counter is the authority for "never reused").
  if (made.orgIds.length > 0) {
    await sql`delete from sponsor_invoice_counters where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from sponsor_orders where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from organizations where id = any(${made.orgIds}::uuid[])`;
  }
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

// ---- the file itself (no DB) -------------------------------------------------------------------------------------------------
describe("the sponsor-invoices delta", () => {
  it("exists exactly once, found by its suffix", () => {
    expect(DELTA_MATCHES, "the sponsor-invoices delta is missing").toHaveLength(1);
  });

  it("opens `-- sponsor_invoices — ` without naming a version (migration-header-truth)", () => {
    const first = deltaText().split("\n").find((l) => l.trim() !== "")!;
    expect(first.startsWith("-- sponsor_invoices — "), first).toBe(true);
    expect(first).not.toMatch(/\bV\d+\b/);
  });

  it("legacy rows get no number: the header says so, and the SQL numbers no existing row (no update of sponsor_orders)", () => {
    expect(deltaText(), "the header states it").toMatch(/legacy[^.]*\bnever\b[^.]*\bnumber/i);
    const statements = deltaSql();
    expect(statements, "premise: the SQL adds the column it would have to backfill").toMatch(/add column invoice_number\b/);
    expect(statements, "no backfill").not.toMatch(/\bupdate\s+sponsor_orders\b/i);
  });
});

describe.skipIf(!HAS_DB)("sponsor invoices schema — the constraints are real", () => {
  it("adds every column with the brief's type, nullability and default; the new deal and org columns are nullable with no default, so every existing row reads null (count reported)", async () => {
    const cols = await sql<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>`
      select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name in ${sql([...new Set(NEW_COLUMNS.map(([t]) => t))])}`;
    let checked = 0;
    for (const [table, name, type, nullable, dflt] of NEW_COLUMNS) {
      const c = cols.find((x) => x.table_name === table && x.column_name === name);
      expect(c, `${table}.${name} exists`).toBeDefined();
      expect([c!.data_type, c!.is_nullable, c!.column_default], `${table}.${name}`).toEqual([type, nullable, dflt]);
      checked++;
    }
    expect(checked, "columns checked").toBe(6);
    // The counter has exactly its two columns: nothing else to keep in step.
    expect(cols.filter((x) => x.table_name === "sponsor_invoice_counters").map((x) => x.column_name).sort()).toEqual(["last_number", "org_id"]);
  });

  it("sponsor_invoice_counters_pkey: one counter per org — a second row for the same org is refused by name (23505); another org's row is accepted", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await expect(counterRow(a, 0)).resolves.toHaveLength(1);
    await expect(counterRow(a, 3)).rejects.toMatchObject(refusedBy("23505", "sponsor_invoice_counters_pkey"));
    await expect(counterRow(b, 3)).resolves.toHaveLength(1);
  });

  it("sponsor_invoice_counters_last_number_check: -1 is refused by name (23514); 0 (an org that has numbered nothing) is accepted", async () => {
    await expect(counterRow(await newOrg(), -1)).rejects.toMatchObject(refusedBy("23514", "sponsor_invoice_counters_last_number_check"));
    await expect(counterRow(await newOrg(), 0)).resolves.toHaveLength(1);
  });

  it("sponsor_invoice_counters_org_id_fkey is RESTRICT: deleting an org that has a counter is refused by name (23503); an org without one deletes; a counter for no org is refused", async () => {
    const [fk] = await sql<{ action: string; parent: string }[]>`
      select c.confdeltype as action, p.relname as parent from pg_constraint c join pg_class p on p.oid = c.confrelid
       where c.conname = 'sponsor_invoice_counters_org_id_fkey' and c.conrelid = 'sponsor_invoice_counters'::regclass`;
    expect(fk, "the foreign key exists by its name").toEqual({ action: "r", parent: "organizations" });
    const counted = await newOrg();
    await counterRow(counted, 4);
    await expect(sql`delete from organizations where id = ${counted}`)
      .rejects.toMatchObject(refusedBy("23503", "sponsor_invoice_counters_org_id_fkey"));
    expect((await sql`select last_number from sponsor_invoice_counters where org_id = ${counted}`)[0], "the counter stays").toEqual({ last_number: 4 });
    const bare = await newOrg();
    await expect(sql`delete from organizations where id = ${bare} returning id`).resolves.toHaveLength(1);
    await expect(counterRow(randomUUID(), 0)).rejects.toMatchObject(refusedBy("23503", "sponsor_invoice_counters_org_id_fkey"));
  });

  it("sponsor_orders_org_invoice_number_key: a second deal with the same number in the same org is refused by name (23505); the same number in another org, and any number of unnumbered deals, are accepted", async () => {
    const w = await world();
    const elsewhere = await world();
    await expect(insertDeal(w, { invoice_number: 1 })).resolves.toBeTruthy();
    await expect(insertDeal(w, { invoice_number: 1 })).rejects.toMatchObject(refusedBy("23505", "sponsor_orders_org_invoice_number_key"));
    await expect(insertDeal(w, { invoice_number: 2 }), "the next number").resolves.toBeTruthy();
    await expect(insertDeal(elsewhere, { invoice_number: 1 }), "numbers run per org").resolves.toBeTruthy();
    await expect(insertDeal(w, { invoice_number: null })).resolves.toBeTruthy();
    await expect(insertDeal(w, { invoice_number: null }), "a second unnumbered deal").resolves.toBeTruthy();
  });

  it("sponsor_orders_invoice_token_hash_key: a repeated token hash is refused by name (23505), in another org too (a token names one invoice everywhere); a different hash and any number of null hashes are accepted", async () => {
    const w = await world();
    const elsewhere = await world();
    const hash = randomBytes(32);
    await expect(insertDeal(w, { invoice_number: 1, invoice_token_hash: hash })).resolves.toBeTruthy();
    await expect(insertDeal(w, { invoice_number: 2, invoice_token_hash: hash }))
      .rejects.toMatchObject(refusedBy("23505", "sponsor_orders_invoice_token_hash_key"));
    await expect(insertDeal(elsewhere, { invoice_number: 1, invoice_token_hash: hash }))
      .rejects.toMatchObject(refusedBy("23505", "sponsor_orders_invoice_token_hash_key"));
    await expect(insertDeal(w, { invoice_number: 2, invoice_token_hash: randomBytes(32) })).resolves.toBeTruthy();
    await expect(insertDeal(w, { invoice_token_hash: null })).resolves.toBeTruthy();
    await expect(insertDeal(w, { invoice_token_hash: null }), "a second null hash").resolves.toBeTruthy();
  });

  it("RLS on the counter: enabled and FORCED; under org A's tenant, A reads its own counter and never org B's, cannot write B's, and app_user holds select, insert and update but no delete (count reported)", async () => {
    const [rls] = await sql<{ enabled: boolean; forced: boolean }[]>`
      select relrowsecurity as enabled, relforcerowsecurity as forced from pg_class where oid = 'sponsor_invoice_counters'::regclass`;
    expect(rls).toEqual({ enabled: true, forced: true });

    const a = await newOrg();
    const b = await newOrg();
    await counterRow(a, 2);
    await counterRow(b, 7);
    const seen = await withTenant(a, (tx) => tx<{ org_id: string; last_number: number }[]>`
      select org_id, last_number from sponsor_invoice_counters where org_id in (${a}, ${b})`);
    expect(seen, "A sees its own counter (the twin) and not B's").toEqual([{ org_id: a, last_number: 2 }]);
    await expect(withTenant(a, (tx) => tx`insert into sponsor_invoice_counters (org_id, last_number) values (${b}, 8)`))
      .rejects.toMatchObject({ code: "42501" });
    const moved = await withTenant(a, (tx) => tx`update sponsor_invoice_counters set last_number = 9 where org_id = ${b} returning org_id`);
    expect(moved, "B's counter is invisible to A's update").toHaveLength(0);
    expect((await sql`select last_number from sponsor_invoice_counters where org_id = ${b}`)[0]).toEqual({ last_number: 7 });

    // The grant list (brief): a counter is never deleted by a tenant — a deleted counter would restart at 1 and reuse numbers.
    const GRANTS: [string, boolean][] = [["SELECT", true], ["INSERT", true], ["UPDATE", true], ["DELETE", false]];
    let checked = 0;
    for (const [privilege, held] of GRANTS) {
      const [row] = await sql<{ held: boolean }[]>`select has_table_privilege('app_user', 'sponsor_invoice_counters', ${privilege}) as held`;
      expect(row!.held, privilege).toBe(held);
      checked++;
    }
    expect(checked, "privileges checked").toBe(4);
    await expect(withTenant(a, (tx) => tx`delete from sponsor_invoice_counters where org_id = ${a}`)).rejects.toMatchObject({ code: "42501" });
    expect((await sql`select last_number from sponsor_invoice_counters where org_id = ${a}`)[0], "A's counter stays").toEqual({ last_number: 2 });
  });
});
