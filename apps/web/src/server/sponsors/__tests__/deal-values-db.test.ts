// Sponsor deals, Task 2 (preflight F31): the pure domain's value sets ARE the database's. lib/sponsor-deals.ts is
// client-safe, so it cannot read the schema; this suite reads Task 1's named CHECKs back from pg_constraint and holds
// each constant equal to its set, so a value added on one side and not the other fails here rather than as a 23514 on a
// customer's write (or a status the console has no chip for). The comparison is a SET equality: the CHECK's order is
// not meaningful, and the constants' order is pinned against the spec in lib/__tests__/sponsor-deals.test.ts.
//
// Real Postgres required (skipped without DATABASE_URL like every DB suite under src/server).
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { DEAL_STATUSES, END_REASONS, GO_LIVE_RULES, PAYMENT_METHODS, PAYMENT_STATUSES } from "@/lib/sponsor-deals";

const HAS_DB = !!process.env.DATABASE_URL;

/** The quoted literals of a named CHECK on sponsor_orders, read from the catalog (empty when it does not exist). */
async function checkValues(name: string): Promise<string[]> {
  const [row] = await sql<{ def: string }[]>`
    select pg_get_constraintdef(oid) as def from pg_constraint
     where conrelid = 'sponsor_orders'::regclass and contype = 'c' and conname = ${name}`;
  return row ? [...row.def.matchAll(/'([^']+)'/g)].map((m) => m[1]!) : [];
}

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end();
});

describe.skipIf(!HAS_DB)("lib/sponsor-deals value sets = the sponsor_orders CHECKs (F31)", () => {
  it("each constant equals its CHECK's value set, read from pg_constraint (5 sets checked)", async () => {
    // [the V495 constraint name, the constant that must name the same values]
    const SETS: [string, readonly string[]][] = [
      ["sponsor_orders_deal_status_check", DEAL_STATUSES],
      ["sponsor_orders_payment_method_check", PAYMENT_METHODS],
      ["sponsor_orders_go_live_check", GO_LIVE_RULES],
      ["sponsor_orders_payment_status_check", PAYMENT_STATUSES],
      ["sponsor_orders_ended_reason_check", END_REASONS],
    ];
    let checked = 0;
    for (const [name, constant] of SETS) {
      const values = await checkValues(name);
      expect(values.length, `${name} found in the catalog`).toBeGreaterThan(0);
      expect(new Set(values).size, `${name} lists each value once`).toBe(values.length);
      expect(new Set(constant).size, `${name}: the constant lists each value once`).toBe(constant.length);
      expect([...values].sort(), name).toEqual([...constant].sort());
      checked++;
    }
    expect(checked, "value sets checked").toBe(5);
  });
});
