// V519 — registrations.cart_position and registration_groups.cart_size (registration redesign B5 T17, spec §6.1,
// orchestrator rulings 2026-11-13: the database is the ONLY writer of a position; references never change after submit).
//
// The rule: a group's entries are numbered 1, 2, 3… in the order they are inserted, and the group's cart_size is the largest
// number it has handed out. Numbers are never reused, never moved, and never chosen by the inserter. These tests drive the
// table the way every non-submit writer does (fixtures, e2e seeds, smoke — none of them name the column), then prove each
// guard by name. The submit path itself is pinned in usecases/__tests__/registration-cart-entry-order.test.ts.
//
// Sport: not applicable — a cart position is the cart's, not the sport's; one generic division.
// Real Postgres required; skipped without DATABASE_URL.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;
const DELTA = fileURLToPath(new URL("../../../../../db/migration/deltas/V519__registration_cart_position.sql", import.meta.url));
const ROLLBACK = new Error("rollback");

async function seedOrgCompDiv() {
  const tag = randomUUID().slice(0, 8);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values ('Cart Position', ${`cartpos-${tag}`}) returning id`;
  const [comp] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug) values (${org!.id}, 'Comp', ${`comp-${tag}`}) returning id`;
  const [div] = await sql<{ id: string }[]>`
    insert into divisions (org_id, competition_id, name, slug, sport_key, variant_key, config, module_version)
    values (${org!.id}, ${comp!.id}, 'Div', ${`div-${tag}`}, 'generic', 'score', '{}', '1.0.0')
    returning id`;
  return { orgId: org!.id, compId: comp!.id, divId: div!.id };
}

async function seedGroup(compId: string) {
  const [group] = await sql<{ id: string; cart_size: number }[]>`
    insert into registration_groups (competition_id, contact_name, contact_email, access_token_hash, currency)
    values (${compId}, 'Cap Tain', 'cap@example.com', ${`tok-${randomUUID()}`}, 'gbp')
    returning id, cart_size`;
  return group!;
}

/** A fixture-style insert: it never names cart_position, exactly like every non-submit writer in the repo. */
async function insertEntry(groupId: string, divId: string, name: string) {
  const [reg] = await sql<{ id: string; cart_position: number }[]>`
    insert into registrations (group_id, division_id, display_name)
    values (${groupId}, ${divId}, ${name})
    returning id, cart_position`;
  return reg!;
}

const cartSize = async (groupId: string) =>
  (await sql<{ cart_size: number }[]>`select cart_size from registration_groups where id = ${groupId}`)[0]!.cart_size;

/** The error a statement raised, or "accepted". */
const outcome = (p: PromiseLike<unknown>) =>
  Promise.resolve(p).then(
    () => "accepted",
    (e: unknown) => String((e as Error).message),
  );

async function dropOrg(orgId: string) {
  await sql`delete from organizations where id = ${orgId}`;
}

describe.skipIf(!HAS_DB)("V519 cart_position / cart_size", () => {
  it("a new group starts at cart_size 0 and numbers its entries 1, 2, 3 in insert order", async () => {
    const { orgId, compId, divId } = await seedOrgCompDiv();
    const group = await seedGroup(compId);
    expect(group.cart_size, "an empty cart has handed out no number").toBe(0);

    const got: number[] = [];
    for (const name of ["A", "B", "C"]) got.push((await insertEntry(group.id, divId, name)).cart_position);
    expect(got).toEqual([1, 2, 3]);
    expect(await cartSize(group.id)).toBe(3);

    // A second group in the same division counts on its own.
    const other = await seedGroup(compId);
    expect((await insertEntry(other.id, divId, "Z")).cart_position).toBe(1);
    expect(await cartSize(other.id)).toBe(1);
    expect(await cartSize(group.id), "the first group is untouched").toBe(3);
    await dropOrg(orgId);
  });

  it("a deleted entry's number is never handed out again", async () => {
    const { orgId, compId, divId } = await seedOrgCompDiv();
    const group = await seedGroup(compId);
    const entries = [];
    for (const name of ["A", "B", "C"]) entries.push(await insertEntry(group.id, divId, name));
    await sql`delete from registrations where id = ${entries[2]!.id}`; // the highest number
    await sql`delete from registrations where id = ${entries[0]!.id}`;
    expect(await cartSize(group.id), "a delete never shrinks the cart").toBe(3);

    const next = await insertEntry(group.id, divId, "D");
    expect(next.cart_position, "not 1 and not 3: both were someone's").toBe(4);
    expect(await cartSize(group.id)).toBe(4);
    const left = await sql<{ cart_position: number }[]>`
      select cart_position from registrations where group_id = ${group.id} order by cart_position`;
    expect(left.map((r) => r.cart_position)).toEqual([2, 4]);
    await dropOrg(orgId);
  });

  it("an insert may not choose its own position", async () => {
    const { orgId, compId, divId } = await seedOrgCompDiv();
    const group = await seedGroup(compId);
    const attempts = [1, 7];
    for (const pos of attempts) {
      const res = await outcome(sql`
        insert into registrations (group_id, division_id, display_name, cart_position)
        values (${group.id}, ${divId}, 'Chooser', ${pos})`);
      expect(res, `position ${pos}`).toContain("cart_position is assigned by the database");
    }
    expect(await cartSize(group.id), "a refused insert hands out nothing").toBe(0);
    expect(attempts.length).toBe(2);
    await dropOrg(orgId);
  });

  it("an entry for a group that does not exist is refused by name", async () => {
    const { orgId, divId } = await seedOrgCompDiv();
    const missing = randomUUID();
    const res = await outcome(sql`
      insert into registrations (group_id, division_id, display_name) values (${missing}, ${divId}, 'Orphan')`);
    expect(res).toContain(`cart_position: registration group ${missing} not found`);
    await dropOrg(orgId);
  });

  it("an entry's position and its cart never change", async () => {
    const { orgId, compId, divId } = await seedOrgCompDiv();
    const group = await seedGroup(compId);
    const other = await seedGroup(compId);
    const a = await insertEntry(group.id, divId, "A");
    const b = await insertEntry(group.id, divId, "B");

    const refusals = [
      sql`update registrations set cart_position = 5 where id = ${a.id}`,
      sql`update registrations set cart_position = ${b.cart_position} + 1 where id = ${b.id}`,
      sql`update registrations set group_id = ${other.id} where id = ${b.id}`,
    ];
    let refused = 0;
    for (const p of refusals) {
      expect(await outcome(p)).toContain("cart_position: an entry's place in its cart never changes");
      refused++;
    }
    expect(refused).toBe(3);

    // Writes that leave both alone are untouched by the guard.
    expect(await outcome(sql`update registrations set status = 'withdrawn' where id = ${a.id}`)).toBe("accepted");
    expect(await outcome(sql`update registrations set cart_position = cart_position, group_id = group_id where id = ${b.id}`)).toBe("accepted");
    const rows = await sql<{ id: string; group_id: string; cart_position: number }[]>`
      select id, group_id, cart_position from registrations where id in ${sql([a.id, b.id])} order by cart_position`;
    expect(rows.map((r) => [r.id, r.group_id, r.cart_position])).toEqual([
      [a.id, group.id, 1],
      [b.id, group.id, 2],
    ]);
    await dropOrg(orgId);
  });

  it("a group's cart_size never shrinks", async () => {
    const { orgId, compId, divId } = await seedOrgCompDiv();
    const group = await seedGroup(compId);
    await insertEntry(group.id, divId, "A");
    await insertEntry(group.id, divId, "B");
    for (const to of [1, 0]) {
      expect(await outcome(sql`update registration_groups set cart_size = ${to} where id = ${group.id}`), `-> ${to}`).toContain(
        "cart_position: a cart's size never shrinks",
      );
    }
    expect(await outcome(sql`update registration_groups set cart_size = cart_size where id = ${group.id}`)).toBe("accepted");
    expect(await outcome(sql`update registration_groups set contact_name = 'Renamed' where id = ${group.id}`)).toBe("accepted");
    expect(await cartSize(group.id)).toBe(2);
    await dropOrg(orgId);
  });

  // B4 review m8: raising a cart's size by hand was the last write left to anything but trg_cart_position. A cart bumped from 2 to 3
  // by hand quotes its two entries "-1" and "-2" of a three-entry cart that never existed, and its next entry is "-4". Only an
  // entry's insert raises it, by exactly one; the guard knows that write by its trigger depth (it runs inside trg_cart_position).
  it("only a new entry raises a cart's size: a hand-written raise is refused, the insert trigger's is accepted", async () => {
    const { orgId, compId, divId } = await seedOrgCompDiv();
    const group = await seedGroup(compId);
    await insertEntry(group.id, divId, "A");
    await insertEntry(group.id, divId, "B");
    const raises = ["cart_size + 1", "cart_size + 5", "3"];
    for (const to of raises) {
      expect(
        await outcome(sql`update registration_groups set cart_size = ${sql.unsafe(to)} where id = ${group.id}`),
        `-> ${to}`,
      ).toContain("cart_position: only a new entry raises a cart's size");
    }
    expect(raises.length, "anti-vacuity: three hand raises refused").toBe(3);
    expect(await cartSize(group.id), "a refused raise writes nothing").toBe(2);

    // The positive pair: an unchanged size and another column are not raises, and the insert trigger still numbers entries,
    // one at a time and several in one statement.
    expect(await outcome(sql`update registration_groups set cart_size = cart_size where id = ${group.id}`)).toBe("accepted");
    expect(await outcome(sql`update registration_groups set contact_name = 'Renamed' where id = ${group.id}`)).toBe("accepted");
    expect((await insertEntry(group.id, divId, "C")).cart_position).toBe(3);
    const pair = await sql<{ cart_position: number }[]>`
      insert into registrations (group_id, division_id, display_name)
      values (${group.id}, ${divId}, 'D'), (${group.id}, ${divId}, 'E')
      returning cart_position`;
    expect(pair.map((r) => r.cart_position).sort()).toEqual([4, 5]);
    expect(await cartSize(group.id)).toBe(5);
    await dropOrg(orgId);
  });

  // B3 review m7: the insert was the one way left to write a cart_size by hand. A new cart that starts at 5 hands its first entry
  // number 6 and quotes every reference with a suffix it never earned (a one-entry cart is quoted bare). A cart starts at 0.
  it("a new group may not start at a cart_size of its own choosing; naming 0, or nothing, is accepted", async () => {
    const { orgId, compId, divId } = await seedOrgCompDiv();
    const insertGroup = (size: number | null) => {
      const token = `tok-${randomUUID()}`;
      return size === null
        ? sql`insert into registration_groups (competition_id, contact_name, contact_email, access_token_hash, currency)
              values (${compId}, 'Cap Tain', 'cap@example.com', ${token}, 'gbp') returning id`
        : sql`insert into registration_groups (competition_id, contact_name, contact_email, access_token_hash, currency, cart_size)
              values (${compId}, 'Cap Tain', 'cap@example.com', ${token}, 'gbp', ${size}) returning id`;
    };
    const refused = [5, 1, -1];
    for (const size of refused) {
      expect(await outcome(insertGroup(size)), `cart_size ${size}`).toContain("cart_position: a new cart's size starts at 0");
    }
    expect(refused.length, "anti-vacuity: three sizes refused").toBe(3);
    const groups = await sql<{ n: number }[]>`select count(*)::int as n from registration_groups where competition_id = ${compId}`;
    expect(groups[0]!.n, "a refused insert writes no cart").toBe(0);

    // The positive pair: 0 named outright, and the column left out (every fixture, seed and the submit path), both start the cart.
    let accepted = 0;
    for (const size of [0, null]) {
      const [g] = (await insertGroup(size)) as unknown as { id: string }[];
      expect(await cartSize(g!.id), `cart_size ${size}`).toBe(0);
      expect((await insertEntry(g!.id, divId, "First")).cart_position, "its first entry is #1").toBe(1);
      accepted += 1;
    }
    expect(accepted).toBe(2);
    await dropOrg(orgId);
  });

  it("the catalog carries the shape: NOT NULL smallints, cart_size default 0, positive CHECK, unique (group_id, cart_position)", async () => {
    const cols = await sql<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>`
      select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
      where table_schema = current_schema()
        and (table_name, column_name) in (('registrations', 'cart_position'), ('registration_groups', 'cart_size'))
      order by table_name`;
    expect(cols.map((c) => [c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default])).toEqual([
      ["registration_groups", "cart_size", "smallint", "NO", "0"],
      ["registrations", "cart_position", "smallint", "NO", null],
    ]);
    const [idx] = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes where schemaname = current_schema() and indexname = 'registrations_group_position_uq'`;
    expect(idx?.indexdef).toMatch(/^CREATE UNIQUE INDEX registrations_group_position_uq ON \S+ USING btree \(group_id, cart_position\)$/);
    const checks = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'registrations'::regclass and conname = 'registrations_cart_position_positive'`;
    expect(checks.map((c) => c.def)).toEqual(["CHECK ((cart_position >= 1))"]);
  });

  // The triggers stand in front of the column's own constraints (an insert never supplies a position; an update never changes
  // one), so each constraint is proven ALONE with the triggers off for one rolled-back transaction (superuser, as in
  // outbox-schema.test.ts).
  it("with the triggers off, the column's own constraints still refuse a zero, a NULL and a duplicate", async () => {
    const { orgId, compId, divId } = await seedOrgCompDiv();
    const group = await seedGroup(compId);
    const first = await insertEntry(group.id, divId, "A");
    const cases: Array<[string, string]> = [
      ["0", "registrations_cart_position_positive"],
      ["null", 'null value in column "cart_position"'],
      [String(first.cart_position), "registrations_group_position_uq"],
    ];
    for (const [value, expected] of cases) {
      const res = await outcome(
        sql.begin(async (tx) => {
          await tx`set local session_replication_role = replica`;
          await tx.unsafe(
            `insert into registrations (group_id, division_id, org_id, display_name, cart_position) values ($1, $2, $3, 'Raw', ${value})`,
            [group.id, divId, orgId],
          );
          throw ROLLBACK;
        }),
      );
      expect(res, `cart_position ${value}`).toContain(expected);
    }
    expect(cases.length).toBe(3);
    await dropOrg(orgId);
  });

  // The backfill block of the delta, run against TEMP tables that shadow the real ones (pg_temp is searched first), so the
  // shared database is never touched. Expected positions are written out from the rule — order by created_at, then id —
  // not computed.
  it("the backfill numbers existing entries by (created_at, id) within each group and sizes every group", async () => {
    const delta = readFileSync(DELTA, "utf8");
    const m = /-- BACKFILL BEGIN[^\n]*\n([\s\S]*?)-- BACKFILL END/.exec(delta);
    expect(m, "the delta marks its backfill block").not.toBeNull();
    const block = m![1]!;
    expect(block.match(/\bupdate\b/gi)?.length, "two updates: positions, then sizes").toBe(2);

    const g = { a: randomUUID(), b: randomUUID(), empty: randomUUID() };
    const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
    // Group a: physically inserted out of order, with a created_at tie broken by id.
    const planted: Array<[string, string, string]> = [
      [id(9), g.a, "2026-01-01 10:00:02+00"],
      [id(3), g.a, "2026-01-01 10:00:01+00"], // tie with id 5 at :01; 3 < 5
      [id(5), g.a, "2026-01-01 10:00:01+00"],
      [id(7), g.a, "2026-01-01 10:00:00+00"],
      [id(1), g.b, "2026-01-02 09:00:00+00"],
    ];
    const [{ schema }] = await sql<{ schema: string }[]>`select current_schema() as schema`;
    const res = await outcome(
      sql.begin(async (tx) => {
        await tx.unsafe(`set local search_path = pg_temp, "${schema}"`);
        await tx`create temp table registrations (id uuid primary key, group_id uuid not null, created_at timestamptz not null, cart_position smallint) on commit drop`;
        await tx`create temp table registration_groups (id uuid primary key, cart_size smallint not null default 0) on commit drop`;
        for (const gid of Object.values(g)) await tx`insert into registration_groups (id) values (${gid})`;
        for (const [rid, gid, at] of planted) {
          await tx`insert into registrations (id, group_id, created_at) values (${rid}, ${gid}, ${at}::text::timestamptz)`;
        }
        await tx.unsafe(block);
        const pos = await tx<{ id: string; cart_position: number }[]>`select id, cart_position from pg_temp.registrations order by id`;
        const sizes = await tx<{ id: string; cart_size: number }[]>`select id, cart_size from pg_temp.registration_groups`;
        const realTouched = await tx<{ n: number }[]>`
          select count(*)::int as n from ${sql(schema)}.registrations where id in ${sql(planted.map((p) => p[0]))}`;
        expect(realTouched[0]!.n, "the real table was never written").toBe(0);
        expect(pos.map((r) => [r.id, r.cart_position])).toEqual([
          [id(1), 1], // group b, alone
          [id(3), 2], // :01, lower id
          [id(5), 3], // :01, higher id
          [id(7), 1], // :00, earliest
          [id(9), 4], // :02, latest
        ]);
        const bySize = new Map(sizes.map((s) => [s.id, s.cart_size]));
        expect([bySize.get(g.a), bySize.get(g.b), bySize.get(g.empty)], "size = entries numbered; an empty cart stays 0").toEqual([4, 1, 0]);
        expect(pos.length + sizes.length, "anti-vacuity: 5 entries and 3 groups checked").toBe(8);
        throw ROLLBACK;
      }),
    );
    expect(res, "the block ran and every assertion inside held").toBe("rollback");
  });
});
