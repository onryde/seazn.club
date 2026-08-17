// V363/V364 — the registration redesign schema (design §3).
//
// This is the regression net for a drop-and-replace migration on a table that
// prod holds zero rows of: the shape itself IS the contract, and every column
// dropped here is one an old code path could still be reading. It asserts the
// new tables, the columns that must be GONE, and — where a constraint is the
// whole point — the behaviour rather than the catalog entry: CASCADE is proven
// by deleting a group and counting rows, not by reading pg_constraint.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, withTenant } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

type Row = Record<string, unknown>;

async function seedOrgCompDiv() {
  const tag = randomUUID().slice(0, 8);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values ('Reg Schema', ${`regsch-${tag}`})
    returning id`;
  const [comp] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${org.id}, 'Comp', ${`comp-${tag}`}) returning id`;
  const [div] = await sql<{ id: string }[]>`
    insert into divisions (org_id, competition_id, name, slug, sport_key, variant_key, config, module_version)
    values (${org.id}, ${comp.id}, 'Div', ${`div-${tag}`}, 'generic', 'score', '{}', '1.0.0')
    returning id`;
  return { orgId: org.id, compId: comp.id, divId: div.id, tag };
}

async function seedGroup(compId: string, tag: string) {
  const [group] = await sql<{ id: string; org_id: string }[]>`
    insert into registration_groups
      (competition_id, contact_name, contact_email, access_token_hash, currency)
    values (${compId}, 'Cap Tain', 'cap@example.com', ${`tok-${tag}`}, 'gbp')
    returning id, org_id`;
  return group;
}

async function seedEntry(groupId: string, divId: string, name = "Team A") {
  const [reg] = await sql<{ id: string; org_id: string; status: string }[]>`
    insert into registrations (group_id, division_id, display_name)
    values (${groupId}, ${divId}, ${name})
    returning id, org_id, status`;
  return reg;
}

async function dropOrg(orgId: string) {
  await sql`delete from organizations where id = ${orgId}`;
}

describe.skipIf(!HAS_DB)("V363/V364 registration schema", () => {
  it("registration_groups carries the cart: contact, ref, token, payment envelope", async () => {
    const cols = await sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns
      where table_name = 'registration_groups'`;
    const byName = new Map(cols.map((c) => [c.column_name, c.is_nullable]));

    for (const c of [
      "id", "org_id", "competition_id", "contact_name", "contact_email", "user_id",
      "ref_code", "access_token_hash", "locale", "amount_cents", "currency",
      "payment_method", "checkout_session_id", "payment_intent_id", "expires_at",
      "reminded_at", "refunded_cents", "refunded_at", "disputed_at", "dispute_id",
      "offline_marked_paid_at", "offline_marked_paid_by", "fee_percent",
      "privacy_consent_at", "privacy_consent_version", "created_at", "updated_at",
    ]) {
      expect(byName.has(c), `registration_groups.${c} missing`).toBe(true);
    }
    // The cart cannot exist without an owner, a competition, a contact or a token.
    for (const c of ["org_id", "competition_id", "contact_name", "contact_email", "access_token_hash"]) {
      expect(byName.get(c), `${c} should be NOT NULL`).toBe("NO");
    }
    // …but never requires an account, and is not paid at insert time.
    for (const c of ["user_id", "payment_intent_id", "expires_at", "ref_code"]) {
      expect(byName.get(c), `${c} should be nullable`).toBe("YES");
    }
  });

  it("registration_players replaces the roster jsonb, guardian name included", async () => {
    const cols = await sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns
      where table_name = 'registration_players'`;
    const byName = new Map(cols.map((c) => [c.column_name, c.is_nullable]));

    for (const c of [
      "id", "registration_id", "org_id", "full_name", "email", "dob", "gender",
      "guardian_name", "source", "consent_status", "consent_at", "user_id",
      "claim_token_hash", "person_id", "squad_number", "is_captain", "created_at", "updated_at",
    ]) {
      expect(byName.has(c), `registration_players.${c} missing`).toBe(true);
    }
    for (const c of ["registration_id", "org_id", "full_name", "source", "consent_status"]) {
      expect(byName.get(c), `${c} should be NOT NULL`).toBe("NO");
    }
    // Only the divisions that need them demand dob/gender, so the column cannot.
    // user_id is nullable too — most players never link an account (#402).
    for (const c of ["dob", "gender", "email", "person_id", "guardian_name", "user_id"]) {
      expect(byName.get(c), `${c} should be nullable`).toBe("YES");
    }
  });

  it("registration_players.user_id survives a user delete — SET NULL, not cascade", async () => {
    const { orgId, compId, divId, tag } = await seedOrgCompDiv();
    const group = await seedGroup(compId, tag);
    const reg = await seedEntry(group.id, divId);
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`u-${tag}@test.local`}, 'Linked User', true)
      returning id`;
    const [player] = await sql<{ id: string; user_id: string | null }[]>`
      insert into registration_players (registration_id, full_name, source, user_id)
      values (${reg.id}, 'Linked Player', 'captain_entered', ${userId})
      returning id, user_id`;
    expect(player.user_id).toBe(userId);

    await sql`delete from users where id = ${userId}`;

    const rows = await sql<{ user_id: string | null }[]>`
      select user_id from registration_players where id = ${player.id}`;
    expect(rows, "the player row must survive the user delete").toHaveLength(1);
    expect(rows[0]!.user_id).toBeNull();

    await dropOrg(orgId);
  });

  it("registrations keeps only per-entry state; the cart columns are gone", async () => {
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_name = 'registrations'`;
    const names = new Set(cols.map((c) => c.column_name));

    for (const c of ["group_id", "join_code", "free_agent", "status", "amount_cents", "display_name", "answers", "entrant_id"]) {
      expect(names.has(c), `registrations.${c} should still exist`).toBe(true);
    }
    // Dropped: the roster jsonb, the payment/identity envelope (now the group's),
    // and the per-person fields (now the player row's). refunded_cents is NOT
    // in this list: V367 adds it back, but scoped to the entry rather than the
    // cart — see the dedicated test below.
    for (const c of [
      "roster", "contact_email", "access_token_hash", "ref_code", "locale", "user_id",
      "payment_method", "checkout_session_id", "payment_intent_id", "expires_at",
      "reminded_at", "refunded_at", "disputed_at", "dispute_id",
      "offline_marked_paid_at", "offline_marked_paid_by", "fee_percent", "currency",
      "privacy_consent_at", "privacy_consent_version",
      "dob", "gender", "guardian_name", "guardian_consent",
    ]) {
      expect(names.has(c), `registrations.${c} should be dropped`).toBe(false);
    }
  });

  // V367 (RS002): per-entry refunds get their OWN column rather than being
  // derived from the cart's — registration_groups.refunded_cents stays the
  // cart's accumulated total, untouched by this migration.
  it("registrations.refunded_cents (V367): entry-scoped, defaults 0, never negative", async () => {
    const cols = await sql<{ column_name: string; is_nullable: string; column_default: string | null }[]>`
      select column_name, is_nullable, column_default from information_schema.columns
      where table_name = 'registrations' and column_name = 'refunded_cents'`;
    expect(cols, "registrations.refunded_cents missing").toHaveLength(1);
    expect(cols[0]!.is_nullable, "refunded_cents should be NOT NULL").toBe("NO");
    expect(cols[0]!.column_default ?? "").toContain("0");

    const { orgId, compId, divId, tag } = await seedOrgCompDiv();
    const group = await seedGroup(compId, tag);

    // Omitted at insert → defaults to 0.
    const reg = await seedEntry(group.id, divId);
    const [row] = await sql<{ refunded_cents: number }[]>`
      select refunded_cents from registrations where id = ${reg.id}`;
    expect(row!.refunded_cents).toBe(0);

    // A negative value is rejected — a refund can only ever add to what has
    // already gone out.
    await expect(
      sql`update registrations set refunded_cents = -1 where id = ${reg.id}`,
    ).rejects.toThrow();

    await dropOrg(orgId);
  });

  it("every entry belongs to a group — group_id is NOT NULL", async () => {
    const { orgId, divId } = await seedOrgCompDiv();
    await expect(
      sql`insert into registrations (division_id, display_name) values (${divId}, 'Orphan')`,
    ).rejects.toThrow();
    await dropOrg(orgId);
  });

  it("status accepts 'rejected' and still refuses anything outside the set", async () => {
    const { orgId, compId, divId, tag } = await seedOrgCompDiv();
    const group = await seedGroup(compId, tag);
    const reg = await seedEntry(group.id, divId);
    expect(reg.status).toBe("pending");

    await sql`update registrations set status = 'rejected' where id = ${reg.id}`;
    const [after] = await sql<{ status: string }[]>`
      select status from registrations where id = ${reg.id}`;
    expect(after.status).toBe("rejected");

    await expect(
      sql`update registrations set status = 'declined' where id = ${reg.id}`,
    ).rejects.toThrow();
    await dropOrg(orgId);
  });

  it("deleting a group cascades to its entries and their players", async () => {
    const { orgId, compId, divId, tag } = await seedOrgCompDiv();
    const group = await seedGroup(compId, tag);
    const a = await seedEntry(group.id, divId, "Team A");
    const b = await seedEntry(group.id, divId, "Team B");
    for (const reg of [a, b]) {
      await sql`
        insert into registration_players (registration_id, full_name, source)
        values (${reg.id}, 'Player One', 'captain_entered')`;
    }

    const [before] = await sql<{ regs: string; players: string }[]>`
      select
        (select count(*) from registrations where group_id = ${group.id}) as regs,
        (select count(*) from registration_players where registration_id in (${a.id}, ${b.id})) as players`;
    expect(Number(before.regs)).toBe(2);
    expect(Number(before.players)).toBe(2);

    await sql`delete from registration_groups where id = ${group.id}`;

    const [after] = await sql<{ regs: string; players: string }[]>`
      select
        (select count(*) from registrations where group_id = ${group.id}) as regs,
        (select count(*) from registration_players where registration_id in (${a.id}, ${b.id})) as players`;
    expect(Number(after.regs)).toBe(0);
    expect(Number(after.players)).toBe(0);

    await dropOrg(orgId);
  });

  it("org_id is filled by the set_org trigger on both new tables", async () => {
    const { orgId, compId, divId, tag } = await seedOrgCompDiv();
    const group = await seedGroup(compId, tag);
    expect(group.org_id).toBe(orgId);

    const reg = await seedEntry(group.id, divId);
    const [player] = await sql<{ org_id: string }[]>`
      insert into registration_players (registration_id, full_name, source)
      values (${reg.id}, 'Player One', 'self_joined')
      returning org_id`;
    expect(player.org_id).toBe(orgId);
    await dropOrg(orgId);
  });

  it("a join code resolves to exactly one entry ACROSS divisions; NULL codes never collide", async () => {
    const { orgId, compId, divId, tag } = await seedOrgCompDiv();
    const group = await seedGroup(compId, tag);
    const a = await seedEntry(group.id, divId, "Team A");
    const b = await seedEntry(group.id, divId, "Team B");

    await sql`update registrations set join_code = ${`JOIN-${tag}`} where id = ${a.id}`;
    await expect(
      sql`update registrations set join_code = ${`JOIN-${tag}`} where id = ${b.id}`,
    ).rejects.toThrow();

    // The index is GLOBAL, not per-division, because a `?join=<CODE>` link
    // carries nothing but the code — so it must not resolve to two entries in
    // different divisions either. Same-division collisions alone cannot tell
    // the two designs apart, so this case is the one that pins it.
    const [otherDiv] = await sql<{ id: string }[]>`
      insert into divisions (org_id, competition_id, name, slug, sport_key, variant_key, config, module_version)
      values (${orgId}, ${compId}, 'Div 2', ${`div2-${tag}`}, 'generic', 'score', '{}', '1.0.0')
      returning id`;
    const crossDiv = await seedEntry(group.id, otherDiv.id, "Team X");
    await expect(
      sql`update registrations set join_code = ${`JOIN-${tag}`} where id = ${crossDiv.id}`,
    ).rejects.toThrow();

    // Both left NULL is the normal case (individual entries hand out no link).
    const c = await seedEntry(group.id, divId, "Team C");
    const d = await seedEntry(group.id, divId, "Team D");
    expect(c.id).not.toBe(d.id);

    await dropOrg(orgId);
  });

  it("player rows police source, consent status and gender", async () => {
    const { orgId, compId, divId, tag } = await seedOrgCompDiv();
    const group = await seedGroup(compId, tag);
    const reg = await seedEntry(group.id, divId);

    const [p] = await sql<{ consent_status: string; is_captain: boolean }[]>`
      insert into registration_players (registration_id, full_name, source)
      values (${reg.id}, 'Player One', 'captain_entered')
      returning consent_status, is_captain`;
    expect(p.consent_status).toBe("pending");
    expect(p.is_captain).toBe(false);

    for (const bad of [
      sql`insert into registration_players (registration_id, full_name, source)
          values (${reg.id}, 'Bad Source', 'imported')`,
      sql`insert into registration_players (registration_id, full_name, source, consent_status)
          values (${reg.id}, 'Bad Consent', 'self_joined', 'maybe')`,
      sql`insert into registration_players (registration_id, full_name, source, gender)
          values (${reg.id}, 'Bad Gender', 'self_joined', 'w')`,
    ]) {
      await expect(bad).rejects.toThrow();
    }

    // A guardian consent records who gave it.
    await sql`
      insert into registration_players (registration_id, full_name, source, consent_status, consent_at, guardian_name)
      values (${reg.id}, 'Minor Player', 'captain_entered', 'guardian', now(), 'Parent Name')`;

    await dropOrg(orgId);
  });

  it("a claim token resolves to exactly one player row", async () => {
    const { orgId, compId, divId, tag } = await seedOrgCompDiv();
    const group = await seedGroup(compId, tag);
    const reg = await seedEntry(group.id, divId);
    const insert = (name: string, token: string | null) => sql`
      insert into registration_players (registration_id, full_name, source, claim_token_hash)
      values (${reg.id}, ${name}, 'captain_entered', ${token})`;

    await insert("One", `claim-${tag}`);
    await expect(insert("Two", `claim-${tag}`)).rejects.toThrow();
    // Most players never get a token — NULLs must not collide.
    await insert("Three", null);
    await insert("Four", null);

    await dropOrg(orgId);
  });

  it("divisions carry category and age band as first-class columns", async () => {
    const { orgId, divId } = await seedOrgCompDiv();
    for (const cat of ["open", "mens", "womens", "mixed"]) {
      await sql`update divisions set category = ${cat} where id = ${divId}`;
    }
    await expect(
      sql`update divisions set category = 'coed' where id = ${divId}`,
    ).rejects.toThrow();

    await sql`update divisions set age_min = 12, age_max = 16 where id = ${divId}`;
    await expect(
      sql`update divisions set age_min = 18, age_max = 16 where id = ${divId}`,
    ).rejects.toThrow();
    // An open-ended band is legal in either direction.
    await sql`update divisions set age_min = null, age_max = 16 where id = ${divId}`;
    await sql`update divisions set age_min = 40, age_max = null where id = ${divId}`;

    await dropOrg(orgId);
  });

  it("registration_settings default to today's behaviour: auto approval, no free agents", async () => {
    const { orgId, divId } = await seedOrgCompDiv();
    const [s] = await sql<{ approval: string; allow_free_agents: boolean }[]>`
      insert into registration_settings (division_id) values (${divId})
      returning approval, allow_free_agents`;
    expect(s.approval).toBe("auto");
    expect(s.allow_free_agents).toBe(false);

    await sql`update registration_settings set approval = 'manual' where division_id = ${divId}`;
    await expect(
      sql`update registration_settings set approval = 'on_request' where division_id = ${divId}`,
    ).rejects.toThrow();

    await dropOrg(orgId);
  });

  // The first cut of V363 created both tables with no RLS, no tenant policy and
  // no GRANT — invisible to every catalog assertion and to the whole typecheck,
  // and fatal the moment an organiser-scoped call went through `withTenant`
  // (`permission denied for table registration_groups`). These two run as
  // `app_user` with the tenant GUC set, exactly as production does, so they fail
  // on a missing grant AND on a missing policy.
  it("registration_groups is readable under withTenant and isolated per org", async () => {
    const a = await seedOrgCompDiv();
    const b = await seedOrgCompDiv();
    const ga = await seedGroup(a.compId, a.tag);
    await seedGroup(b.compId, b.tag);

    const seen = await withTenant(a.orgId, async (tx) => {
      const rows = await tx<{ id: string }[]>`select id from registration_groups`;
      return rows.map((r) => r.id);
    });
    expect(seen).toContain(ga.id);
    // Org B's cart is invisible from inside org A's transaction.
    expect(seen).toHaveLength(1);

    await dropOrg(a.orgId);
    await dropOrg(b.orgId);
  });

  it("registration_players is readable under withTenant and isolated per org", async () => {
    const a = await seedOrgCompDiv();
    const b = await seedOrgCompDiv();
    for (const o of [a, b]) {
      const group = await seedGroup(o.compId, o.tag);
      const reg = await seedEntry(group.id, o.divId);
      await sql`
        insert into registration_players (registration_id, full_name, source)
        values (${reg.id}, ${`Player ${o.tag}`}, 'captain_entered')`;
    }

    const names = await withTenant(a.orgId, async (tx) => {
      const rows = await tx<{ full_name: string }[]>`select full_name from registration_players`;
      return rows.map((r) => r.full_name);
    });
    expect(names).toEqual([`Player ${a.tag}`]);

    await dropOrg(a.orgId);
    await dropOrg(b.orgId);
  });

  it("indexes the reads that matter (group siblings, entry players, person lookup)", async () => {
    const rows = await sql<Row[]>`
      select indexname from pg_indexes
      where tablename in ('registrations','registration_groups','registration_players')`;
    const names = new Set(rows.map((r) => String(r.indexname)));
    for (const idx of [
      "registrations_group_idx",
      "registrations_join_code_key",
      "registration_groups_ref_code_key",
      "registration_groups_competition_idx",
      "registration_groups_checkout_idx",
      "registration_players_registration_idx",
      "registration_players_person_idx",
      "registration_players_claim_token_key",
    ]) {
      expect(names.has(idx), `missing index ${idx}`).toBe(true);
    }
  });
});

// One shared client per file: end it AND uncache it, so a later DB test file in
// the same worker (isolate:false) opens a fresh connection instead of an ended one.
afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});
