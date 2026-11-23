// V549 + V550, Online Chess credits (spec 2026-11-23 §7.1, §7.5): the package table (V549), the ledger's link to it and the
// durable record of a reversed card payment (V550, in the relay suite's stream fold because it changes the ledger). Money state, so every constraint here is driven to its refusal AND to its accepted twin, against
// a real migrated database (AGENTS.md class 3: a constraint is only real if something tries to violate it).
//
// single-sport: online play exists for boardgame only (online-play.ts supportsOnlinePlay); the backfill case below sweeps every
// OTHER sport in the catalogue to prove none of them gets a row.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql, withTenant } from "@/lib/db";
import { ONLINE_SIZES, sizeFor } from "@/lib/online-chess-package";
import { countOnlineHeld } from "@/server/external-play/online-entrant-cap";
import { seedBoardgameSport } from "@/server/usecases/__tests__/_external-play-seed";
import { seedRegistration } from "@/server/usecases/__tests__/_registration-fixtures";
import { SUPERUSER_ONLY } from "../../../../../../../scripts/rls-exempt.ts";

const HAS_DB = !!process.env.DATABASE_URL;
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";
const NOT_NULL_VIOLATION = "23502";
const INSUFFICIENT_PRIVILEGE = "42501";

/** The ladder, typed from the plan's Global Constraints ("16→1/2, 32→2/4, 64→4/8, 128→8/16, 256→16/32"), never read from the DB. */
const LADDER = [16, 32, 64, 128, 256] as const;

const DELTAS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "..", "..", "db", "migration", "deltas");

type Outcome =
  | { accepted: true }
  | { accepted: false; code: string | undefined; constraint: string | undefined };

const outcomeOf = (err: { code?: string; constraint_name?: string }): Outcome =>
  ({ accepted: false, code: err.code, constraint: err.constraint_name });

const attempt = (p: Promise<unknown>): Promise<Outcome> =>
  p.then(() => ({ accepted: true as const }), outcomeOf);

const ROLLBACK = new Error("rollback sentinel");
/** Runs `write` on the privileged pool and rolls it back: an accepted write leaves nothing behind. */
const rolledBack = (write: (tx: typeof sql) => Promise<unknown>): Promise<Outcome> =>
  sql
    .begin(async (tx) => {
      await write(tx as unknown as typeof sql);
      throw ROLLBACK;
    })
    .then(
      () => ({ accepted: false as const, code: "NO_ROLLBACK", constraint: undefined }),
      (err: { code?: string; constraint_name?: string }) => (err === ROLLBACK ? { accepted: true as const } : outcomeOf(err)),
    );

const suffix = (): string => randomUUID().replaceAll("-", "").slice(0, 12);

async function seedOrg(): Promise<string> {
  const s = suffix();
  const [o] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"OC Org " + s}, ${"oc-org-" + s}) returning id`;
  return o!.id;
}

async function seedUser(): Promise<string> {
  const s = suffix();
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name) values (${`oc-${s}@test.local`}, 'Organiser') returning id`;
  return u!.id;
}

type SeedDivision = { id: string; orgId: string; competitionId: string; name: string };

/** A competition and one division in it, by SQL. `config` defaults to online play on Lichess. */
async function seedDivision(orgId: string, o: { sport?: string; config?: Record<string, unknown>; name?: string } = {}): Promise<SeedDivision> {
  const s = suffix();
  const [c] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility) values (${orgId}, ${"OC Cup " + s}, ${"oc-cup-" + s}, 'private')
    returning id`;
  const name = o.name ?? `Open ${s}`;
  const [d] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, name, slug, sport_key, variant_key, config, module_version)
    values (${c!.id}, ${name}, ${"oc-div-" + s}, ${o.sport ?? "boardgame"}, 'classical',
            ${sql.json((o.config ?? { onlinePlay: "lichess" }) as never)}, '1.0.0')
    returning id`;
  return { id: d!.id, orgId, competitionId: c!.id, name };
}

type Pkg = {
  divisionId?: string | null;
  divisionName?: string;
  size?: number | null;
  camerasPaid?: boolean | null;
  creditsPaid?: number;
  creditsRefunded?: number;
  creditsForfeited?: number;
  paidAt?: Date | null;
  paidBy?: string | null;
  frozenAt?: Date | null;
  refundedAt?: Date | null;
};

/** A package row as the privileged writers will write it. The default is a fresh UNPAID row at 16. */
const insertPackage = (db: typeof sql, orgId: string, p: Pkg = {}) => db<{ id: string }[]>`
  insert into division_online_packages
    (org_id, division_id, division_name, size, cameras_paid, credits_paid, credits_refunded, credits_forfeited,
     paid_at, paid_by, frozen_at, refunded_at)
  values (${orgId}, ${p.divisionId ?? null}, ${p.divisionName ?? "Open"}, ${p.size === undefined ? 16 : p.size},
          ${p.camerasPaid ?? null}, ${p.creditsPaid ?? 0}, ${p.creditsRefunded ?? 0}, ${p.creditsForfeited ?? 0},
          ${p.paidAt ?? null}, ${p.paidBy ?? null}, ${p.frozenAt ?? null}, ${p.refundedAt ?? null})
  returning id`;

/** A PAID row at 32 without cameras: price(32, false) = 2 credits (Global Constraints). */
const PAID_32: Pkg = { size: 32, camerasPaid: false, creditsPaid: 2, paidAt: new Date("2026-11-20T10:00:00Z") };

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe.skipIf(!HAS_DB)("V549 + V550 online chess packages: schema", () => {
  // ─── RLS and sealing ──────────────────────────────────────────────────────────────────────────────────────────────────
  describe("who can reach the rows", () => {
    it("app_user can read its own org's package and no other's", async () => {
      const orgA = await seedOrg();
      const orgB = await seedOrg();
      const divA = await seedDivision(orgA);
      const divB = await seedDivision(orgB);
      const [pkgA] = await insertPackage(sql, orgA, { divisionId: divA.id, divisionName: divA.name });
      const [pkgB] = await insertPackage(sql, orgB, { divisionId: divB.id, divisionName: divB.name });
      const both = [pkgA!.id, pkgB!.id];

      const privileged = await sql<{ id: string }[]>`select id from division_online_packages where id in ${sql(both)} order by id`;
      expect(privileged.length, "premise: the privileged pool sees both rows").toBe(2);

      const asA = await withTenant(orgA, (tx) => tx<{ id: string }[]>`select id from division_online_packages`);
      expect(asA.map((r) => r.id), "org A reads exactly its own row").toEqual([pkgA!.id]);
      const aReadsB = await withTenant(orgA, (tx) => tx<{ id: string }[]>`select id from division_online_packages where id = ${pkgB!.id}`);
      expect(aReadsB, "org A asking for B's row by id reads nothing").toEqual([]);
      const asB = await withTenant(orgB, (tx) => tx<{ id: string }[]>`select id from division_online_packages`);
      expect(asB.map((r) => r.id), "org B reads exactly its own row").toEqual([pkgB!.id]);

      // The empty case: app_user with NO org set reads nothing at all (current_org_id() is null).
      const noOrg = await sql.begin(async (tx) => {
        await tx`set local role app_user`;
        return tx<{ id: string }[]>`select id from division_online_packages where id in ${tx(both)}`;
      });
      expect(noOrg, "no tenant context, no rows").toEqual([]);
    });

    it("app_user cannot insert, update or delete a package", async () => {
      const org = await seedOrg();
      const div = await seedDivision(org);
      const [pkg] = await insertPackage(sql, org, { divisionId: div.id, divisionName: div.name });
      const writes: Array<[string, (tx: typeof sql) => Promise<unknown>]> = [
        ["insert", (tx) => insertPackage(tx, org, { divisionName: "Mine" })],
        ["update", (tx) => tx`update division_online_packages set size = 256 where id = ${pkg!.id}`],
        ["delete", (tx) => tx`delete from division_online_packages where id = ${pkg!.id}`],
      ];
      let checked = 0;
      for (const [verb, write] of writes) {
        const got = await attempt(withTenant(org, (tx) => write(tx as unknown as typeof sql)));
        expect(got, verb).toEqual({ accepted: false, code: INSUFFICIENT_PRIVILEGE, constraint: undefined });
        checked += 1;
      }
      expect(checked, "anti-vacuity: insert, update, delete").toBe(3);
      const [after] = await sql<{ size: number }[]>`select size from division_online_packages where id = ${pkg!.id}`;
      expect(after, "the pair: the row is still there, unchanged").toEqual({ size: 16 });
    });

    it("app_user cannot read stream_pack_reversals (nor write one); the privileged pool can", async () => {
      const org = await seedOrg();
      const intent = `pi_oc_${suffix()}`;
      await sql`insert into stream_pack_reversals (stripe_payment_intent_id, org_id, purchased) values (${intent}, ${org}, 20)`;
      const read = await attempt(withTenant(org, (tx) => tx`select * from stream_pack_reversals`));
      expect(read, "select").toEqual({ accepted: false, code: INSUFFICIENT_PRIVILEGE, constraint: undefined });
      const write = await attempt(withTenant(org, (tx) => tx`
        insert into stream_pack_reversals (stripe_payment_intent_id, org_id, purchased) values (${`pi_oc_${suffix()}`}, ${org}, 5)`));
      expect(write, "insert").toEqual({ accepted: false, code: INSUFFICIENT_PRIVILEGE, constraint: undefined });
      const [row] = await sql<{ purchased: number }[]>`select purchased from stream_pack_reversals where stripe_payment_intent_id = ${intent}`;
      expect(row, "the pair: the privileged pool reads it").toEqual({ purchased: 20 });
    });

    it("the catalogue: packages are tenant-READABLE only, reversals are sealed like the ledger, and no ledger grant was widened", async () => {
      const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;
      /** Typed from spec §7.1: "READ by the tenant role … No write grant", and reversals "No policy, no grant to app_user". */
      const EXPECTED: Record<string, { policies: number; select: boolean }> = {
        division_online_packages: { policies: 1, select: true },
        stream_pack_reversals: { policies: 0, select: false },
        org_stream_credits: { policies: 0, select: false },
      };
      let checked = 0;
      for (const [table, want] of Object.entries(EXPECTED)) {
        const [t] = await sql<{ enabled: boolean; forced: boolean; policies: number }[]>`
          select c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
                 (select count(*)::int from pg_policies p where p.tablename = c.relname and p.schemaname = n.nspname) as policies
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = current_schema() and c.relname = ${table} and c.relkind = 'r'`;
        expect(t, table).toEqual({ enabled: true, forced: true, policies: want.policies });
        for (const priv of PRIVILEGES) {
          const [g] = await sql<{ granted: boolean }[]>`
            select has_table_privilege('app_user', (current_schema() || '.' || ${table})::regclass, ${priv}) as granted`;
          expect(g!.granted, `${table} ${priv}`).toBe(priv === "SELECT" ? want.select : false);
          checked += 1;
        }
      }
      expect(checked, "anti-vacuity: 3 tables x 7 privileges").toBe(21);

      const policies = await sql<{ policyname: string; cmd: string; roles: string[]; qual: string }[]>`
        select policyname, cmd, roles::text[] as roles, qual from pg_policies
         where schemaname = current_schema() and tablename = 'division_online_packages'`;
      // The idiom of V271's competition_passes (the neighbouring read-only tenant table): `org_id = current_org_id()`.
      expect(policies).toEqual([
        { policyname: "division_online_packages_read", cmd: "SELECT", roles: ["app_user"], qual: "(org_id = current_org_id())" },
      ]);

      // CI's RLS guard (scripts/check-rls.ts, rls-coverage.test.ts) exempts a sealed org_id table BY NAME. The reversals
      // table is sealed, so it must be named; the package table carries a policy, so it must NOT be (an exemption there
      // would hide a dropped policy).
      expect(SUPERUSER_ONLY.has("stream_pack_reversals"), "reversals exempt by name").toBe(true);
      expect(SUPERUSER_ONLY.has("division_online_packages"), "packages are a normal tenant table").toBe(false);
    });
  });

  // ─── The CHECKs ───────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("a row's states, and nothing else", () => {
    it("refuses paid_at without credits, cameras_paid without paid_at, refunded+forfeited > paid, refunded_at on an unpaid row", async () => {
      const org = await seedOrg();
      const paidAt = new Date("2026-11-20T10:00:00Z");
      // Each case breaks exactly ONE rule (the others hold), so it names the constraint that answers it.
      const cases: Array<[string, Pkg, string]> = [
        ["paid_at set, nothing debited", { paidAt, camerasPaid: false, creditsPaid: 0 }, "division_online_packages_paid_credits_check"],
        ["credits debited, paid_at null", { paidAt: null, camerasPaid: null, creditsPaid: 2 }, "division_online_packages_paid_credits_check"],
        ["cameras_paid set, paid_at null", { paidAt: null, camerasPaid: false, creditsPaid: 0 }, "division_online_packages_paid_cameras_check"],
        ["paid_at set, cameras_paid null", { paidAt, camerasPaid: null, creditsPaid: 2 }, "division_online_packages_paid_cameras_check"],
        ["refunded + forfeited > paid", { ...PAID_32, creditsRefunded: 2, creditsForfeited: 1 }, "division_online_packages_returned_check"],
        ["refunded_at on an unpaid row", { refundedAt: new Date() }, "division_online_packages_refunded_paid_check"],
      ];
      let checked = 0;
      for (const [name, p, constraint] of cases) {
        expect(await rolledBack((tx) => insertPackage(tx, org, p)), name).toEqual({ accepted: false, code: CHECK_VIOLATION, constraint });
        checked += 1;
      }
      expect(checked, "anti-vacuity: both directions of the two pairs, the bound, the refund stamp").toBe(6);

      // The accepted twins: the four states of spec §7.1, plus the bound's own edge (returned == paid is a FULL refund).
      const accepted: Array<[string, Pkg]> = [
        ["unpaid", {}],
        ["paid", PAID_32],
        ["paid with cameras", { size: 32, camerasPaid: true, creditsPaid: 4, paidAt }],
        ["frozen, grandfathered (unpaid at 256)", { size: 256, frozenAt: new Date() }],
        ["refunded in full, part forfeited (returned == paid)", { ...PAID_32, creditsRefunded: 1, creditsForfeited: 1, refundedAt: new Date() }],
        ["moved down: part returned, still live", { size: 16, camerasPaid: false, creditsPaid: 2, creditsRefunded: 1, paidAt }],
      ];
      for (const [name, p] of accepted) {
        expect(await rolledBack((tx) => insertPackage(tx, org, p)), name).toEqual({ accepted: true });
      }
      expect(accepted.length).toBe(6);
    });

    it("a size off the ladder is refused (a stored 0 or 48 is impossible), and each ladder size is accepted", async () => {
      expect([...ONLINE_SIZES], "the DB ladder and the price leaf's are one list").toEqual([...LADDER]);
      const org = await seedOrg();
      const OFF_LADDER = [0, 48, 15, 17, 255, 257, 512, -16];
      let refused = 0;
      for (const size of OFF_LADDER) {
        expect(await rolledBack((tx) => insertPackage(tx, org, { size })), `size ${size}`).toEqual({
          accepted: false, code: CHECK_VIOLATION, constraint: "division_online_packages_size_check",
        });
        refused += 1;
      }
      expect(refused, "anti-vacuity: off-ladder sizes").toBe(OFF_LADDER.length);
      let accepted = 0;
      for (const size of LADDER) {
        expect(await rolledBack((tx) => insertPackage(tx, org, { size })), `size ${size}`).toEqual({ accepted: true });
        accepted += 1;
      }
      expect(accepted, "anti-vacuity: ladder sizes").toBe(5);
      expect(await rolledBack((tx) => insertPackage(tx, org, { size: null })), "no size at all").toEqual({
        accepted: false, code: NOT_NULL_VIOLATION, constraint: undefined,
      });
    });

    it("the three counters refuse a negative", async () => {
      const org = await seedOrg();
      const cases: Array<[string, Pkg, string]> = [
        // credits_paid >= 0 is also implied by the bound (refunded + forfeited <= paid, both >= 0); constraints are checked in
        // name order, so its own check answers first. Recorded in the commit's mutation table.
        ["credits_paid -1", { ...PAID_32, creditsPaid: -1 }, "division_online_packages_credits_paid_check"],
        ["credits_refunded -1", { ...PAID_32, creditsRefunded: -1 }, "division_online_packages_credits_refunded_check"],
        ["credits_forfeited -1", { ...PAID_32, creditsForfeited: -1 }, "division_online_packages_credits_forfeited_check"],
      ];
      let checked = 0;
      for (const [name, p, constraint] of cases) {
        expect(await rolledBack((tx) => insertPackage(tx, org, p)), name).toEqual({ accepted: false, code: CHECK_VIOLATION, constraint });
        checked += 1;
      }
      expect(checked).toBe(3);
    });
  });

  // ─── One live row per division ────────────────────────────────────────────────────────────────────────────────────────
  it("refuses a second live row for one division; allows one after refunded_at is set", async () => {
    const org = await seedOrg();
    const div = await seedDivision(org);
    const other = await seedDivision(org);
    const LIVE_INDEX = { accepted: false, code: UNIQUE_VIOLATION, constraint: "division_online_packages_live" };

    const [first] = await insertPackage(sql, org, { divisionId: div.id });
    expect(await attempt(insertPackage(sql, org, { divisionId: div.id })), "a second live row, unpaid").toEqual(LIVE_INDEX);
    expect(await attempt(insertPackage(sql, org, { ...PAID_32, divisionId: div.id })), "a second live row, paid").toEqual(LIVE_INDEX);
    expect(await attempt(insertPackage(sql, org, { divisionId: other.id })), "another division is not blocked").toEqual({ accepted: true });

    // Pay, then refund in full: the row becomes history, and the division may hold a new live row.
    await sql`update division_online_packages set paid_at = now(), credits_paid = 2, cameras_paid = false where id = ${first!.id}`;
    expect(await attempt(insertPackage(sql, org, { divisionId: div.id })), "paid is still live").toEqual(LIVE_INDEX);
    await sql`update division_online_packages set refunded_at = now(), credits_refunded = 2 where id = ${first!.id}`;
    const [second] = await insertPackage(sql, org, { divisionId: div.id });
    expect(second, "after the refund, a new live row").toBeDefined();

    // The sequence: the new live row blocks a third, frozen or not.
    expect(await attempt(insertPackage(sql, org, { divisionId: div.id })), "a third, beside the new live row").toEqual(LIVE_INDEX);
    await sql`update division_online_packages set size = 256, frozen_at = now() where id = ${second!.id}`;
    expect(await attempt(insertPackage(sql, org, { divisionId: div.id })), "a frozen row is live").toEqual(LIVE_INDEX);

    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from division_online_packages where division_id = ${div.id}`;
    expect(n, "one history row and one live row").toBe(2);

    // Rows whose division is gone (division_id null) never collide: each is history of its own deleted division.
    expect(await attempt(insertPackage(sql, org, { divisionId: null })), "a first orphan").toEqual({ accepted: true });
    expect(await attempt(insertPackage(sql, org, { divisionId: null })), "a second orphan").toEqual({ accepted: true });
  });

  // ─── The ledger's link ────────────────────────────────────────────────────────────────────────────────────────────────
  describe("the ledger names a session or a package, never both", () => {
    async function ledgerRig() {
      const org = await seedOrg();
      const div = await seedDivision(org);
      const [pkg] = await insertPackage(sql, org, { ...PAID_32, divisionId: div.id, divisionName: div.name });
      const [target] = await sql<{ id: string }[]>`
        insert into org_stream_targets (org_id, kind, label, rtmp_enc)
        values (${org}, 'youtube', 'Club channel', ${Buffer.from("not-a-real-envelope")}) returning id`;
      const [session] = await sql<{ id: string }[]>`
        insert into fixture_stream_sessions (org_id, mode, state, target_id, created_by, sport_key, competition_id, division_id,
                                             entitlement_via_override)
        values (${org}, 'passthrough', 'requested', ${target!.id}, ${randomUUID()}, 'boardgame', ${div.competitionId}, ${div.id}, true)
        returning id`;
      return { org, div, pkgId: pkg!.id, sessionId: session!.id };
    }
    const ledgerRow = (tx: typeof sql, org: string, o: { session?: string | null; pkg?: string | null; reason?: string; delta?: number }) => tx`
      insert into org_stream_credits (org_id, delta, reason, balance_after, bucket, session_id, online_package_id)
      values (${org}, ${o.delta ?? -1}, ${o.reason ?? "consume"}, 0, 'pack', ${o.session ?? null}, ${o.pkg ?? null})`;

    it("refuses a ledger row naming both a session and a package", async () => {
      const r = await ledgerRig();
      expect(await rolledBack((tx) => ledgerRow(tx, r.org, { session: r.sessionId, pkg: r.pkgId })), "both").toEqual({
        accepted: false, code: CHECK_VIOLATION, constraint: "org_stream_credits_one_subject",
      });
      // The accepted twins: each subject alone, and neither (a purchase or a grant names no subject).
      const twins: Array<[string, { session?: string | null; pkg?: string | null; reason?: string; delta?: number }]> = [
        ["a package consume", { pkg: r.pkgId }],
        ["a package refund", { pkg: r.pkgId, reason: "refund", delta: 1 }],
        ["a stream consume", { session: r.sessionId }],
        ["a grant, no subject", { reason: "grant", delta: 5 }],
      ];
      for (const [name, o] of twins) {
        expect(await rolledBack((tx) => ledgerRow(tx, r.org, o)), name).toEqual({ accepted: true });
      }
      expect(twins.length).toBe(4);
    });

    it("a ledger row cannot name a package that does not exist, and a package the ledger names cannot be deleted", async () => {
      const r = await ledgerRig();
      expect(await rolledBack((tx) => ledgerRow(tx, r.org, { pkg: randomUUID() })), "a missing package").toEqual({
        accepted: false, code: FK_VIOLATION, constraint: "org_stream_credits_online_package_id_fkey",
      });
      await ledgerRow(sql, r.org, { pkg: r.pkgId });
      expect(await rolledBack((tx) => tx`delete from division_online_packages where id = ${r.pkgId}`), "a debited package").toEqual({
        accepted: false, code: FK_VIOLATION, constraint: "org_stream_credits_online_package_id_fkey",
      });
      // The pair: an unpaid row with no ledger rows is what the doors delete (spec §7.1 "an unpaid row is DELETED").
      const other = await seedDivision(r.org);
      const [unpaid] = await insertPackage(sql, r.org, { divisionId: other.id });
      expect(await rolledBack((tx) => tx`delete from division_online_packages where id = ${unpaid!.id}`), "an unpaid row").toEqual({
        accepted: true,
      });
    });

    it("the ledger is indexed by package, partially (rows naming no package stay out of it)", async () => {
      const rows = await sql<{ indexdef: string }[]>`
        select indexdef from pg_indexes
         where schemaname = current_schema() and tablename = 'org_stream_credits' and indexname = 'org_stream_credits_online_package_id'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.indexdef).toMatch(/\(online_package_id\) WHERE \(online_package_id IS NOT NULL\)$/);
    });
  });

  // ─── Deletes ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("deletes", () => {
    const snapshot = async (id: string) => {
      const [row] = await sql<Record<string, unknown>[]>`select * from division_online_packages where id = ${id}`;
      return row;
    };

    it("keeps a paid row with division_id null when its division is deleted", async () => {
      const org = await seedOrg();
      const organiser = await seedUser();
      const div = await seedDivision(org, { name: "Rapid Open" });
      const [pkg] = await insertPackage(sql, org, { ...PAID_32, divisionId: div.id, divisionName: div.name, paidBy: organiser });
      const before = await snapshot(pkg!.id);
      expect(before, "premise").toMatchObject({ division_id: div.id, division_name: "Rapid Open", credits_paid: 2 });

      await sql`delete from divisions where id = ${div.id}`;
      const after = await snapshot(pkg!.id);
      expect(after, "the paid row is the record of a payment: it outlives the division").toEqual({ ...before, division_id: null });
    });

    it("a competition delete (which cascades its divisions) keeps the row the same way", async () => {
      const org = await seedOrg();
      const div = await seedDivision(org, { name: "Blitz Open" });
      const [pkg] = await insertPackage(sql, org, { size: 256, frozenAt: new Date("2026-11-21T09:00:00Z"), divisionId: div.id, divisionName: div.name });
      const before = await snapshot(pkg!.id);
      await sql`delete from competitions where id = ${div.competitionId}`;
      expect(await snapshot(pkg!.id)).toEqual({ ...before, division_id: null });
    });

    it("an org delete takes its packages, the ledger rows naming them, and its reversals", async () => {
      const org = await seedOrg();
      const div = await seedDivision(org);
      const [pkg] = await insertPackage(sql, org, { ...PAID_32, divisionId: div.id, divisionName: div.name });
      await sql`insert into org_stream_credits (org_id, delta, reason, balance_after, bucket) values (${org}, 2, 'grant', 2, 'pack')`;
      await sql`
        insert into org_stream_credits (org_id, delta, reason, balance_after, bucket, online_package_id)
        values (${org}, -2, 'consume', 0, 'pack', ${pkg!.id})`;
      await sql`insert into stream_pack_reversals (stripe_payment_intent_id, org_id, purchased) values (${`pi_oc_${suffix()}`}, ${org}, 2)`;
      await sql`delete from organizations where id = ${org}`;
      const [left] = await sql<{ packages: number; ledger: number; reversals: number }[]>`
        select (select count(*) from division_online_packages where org_id = ${org})::int as packages,
               (select count(*) from org_stream_credits where org_id = ${org})::int as ledger,
               (select count(*) from stream_pack_reversals where org_id = ${org})::int as reversals`;
      expect(left).toEqual({ packages: 0, ledger: 0, reversals: 0 });
    });
  });

  // ─── stream_pack_reversals ────────────────────────────────────────────────────────────────────────────────────────────
  it("stream_pack_reversals: one row per payment intent, and a reversal of nothing is refused", async () => {
    const org = await seedOrg();
    const intent = `pi_oc_${suffix()}`;
    const reversal = (tx: typeof sql, purchased: number, pi = intent) =>
      tx`insert into stream_pack_reversals (stripe_payment_intent_id, org_id, purchased) values (${pi}, ${org}, ${purchased})`;
    let checked = 0;
    for (const purchased of [0, -5]) {
      expect(await rolledBack((tx) => reversal(tx, purchased)), `purchased ${purchased}`).toEqual({
        accepted: false, code: CHECK_VIOLATION, constraint: "stream_pack_reversals_purchased_check",
      });
      checked += 1;
    }
    expect(checked).toBe(2);
    await reversal(sql, 20);
    expect(await attempt(reversal(sql, 20)), "the same intent again").toEqual({
      accepted: false, code: UNIQUE_VIOLATION, constraint: "stream_pack_reversals_pkey",
    });
    expect(await attempt(reversal(sql, 5, `pi_oc_${suffix()}`)), "another intent").toEqual({ accepted: true });
  });

  // ─── The backfill ─────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("the backfill: one row per existing online division", () => {
    /** The migration's backfill statement, sliced from the file between its markers. Read inside the test, never at module
     *  scope: a missing file must fail a test, not collect zero tests. */
    function backfillStatement(): string {
      const file = readdirSync(DELTAS).filter((f) => /^V\d+__online_chess_packages\.sql$/.test(f));
      expect(file, "exactly one online_chess_packages delta").toHaveLength(1);
      const text = readFileSync(join(DELTAS, file[0]!), "utf8");
      const begin = text.split("-- @backfill-begin").length - 1;
      const end = text.split("-- @backfill-end").length - 1;
      expect({ begin, end }, "one marker pair").toEqual({ begin: 1, end: 1 });
      const body = text.slice(text.indexOf("-- @backfill-begin"), text.indexOf("-- @backfill-end"));
      expect(body, "the slice is the insert").toMatch(/insert into division_online_packages/);
      return body;
    }

    /** Runs the backfill exactly as written, against a session-local TEMP copy of the table: an unqualified
     *  `division_online_packages` resolves to pg_temp first, so the statement reads the real divisions and writes nothing
     *  real (the shared test database already holds other suites' live rows, and the real table takes no lock here). */
    async function runBackfill(statement: string, divisionIds: string[]) {
      let out: { rows: Array<{ division_id: string; org_id: string; division_name: string; size: number; frozen_at: Date | null;
        paid_at: Date | null; cameras_paid: boolean | null; credits_paid: number; credits_refunded: number; credits_forfeited: number;
        refunded_at: Date | null; paid_by: string | null }>; now: Date } | null = null;
      await sql
        .begin(async (tx) => {
          const [{ schema }] = await tx<{ schema: string }[]>`select current_schema() as schema`;
          await tx.unsafe(`create temp table division_online_packages (like "${schema}".division_online_packages including all) on commit drop`);
          await tx.unsafe(statement);
          const rows = await tx<NonNullable<typeof out>["rows"]>`
            select division_id, org_id, division_name, size, frozen_at, paid_at, cameras_paid, credits_paid, credits_refunded,
                   credits_forfeited, refunded_at, paid_by
              from pg_temp.division_online_packages where division_id in ${tx(divisionIds)}`;
          const [{ now }] = await tx<{ now: Date }[]>`select now() as now`;
          out = { rows, now };
          throw ROLLBACK;
        })
        .catch((e) => {
          if (e !== ROLLBACK) throw e;
        });
      return out!;
    }

    const entrants = (divisionId: string, n: number, status = "confirmed") => sql`
      insert into entrants (division_id, kind, display_name, status)
      select ${divisionId}, 'individual', 'E' || g, ${status} from generate_series(1, ${n}) g`;
    const FEES = { fee_cents: 0, currency: "gbp", payment_method: "offline" as const };
    const signUp = async (d: SeedDivision, status: "pending" | "paid" | "confirmed" | "waitlisted" | "withdrawn" | "expired" | "rejected",
      o: { freeAgent?: boolean; entrantId?: string } = {}) => {
      const { registration } = await seedRegistration(d.competitionId, d.id, FEES, { status, displayName: `Reg ${suffix()}` });
      if (o.freeAgent) await sql`update registrations set free_agent = true where id = ${registration.id}`;
      if (o.entrantId) await sql`update registrations set entrant_id = ${o.entrantId} where id = ${registration.id}`;
    };
    const swissStage = async (divisionId: string) => {
      const [s] = await sql<{ id: string; org_id: string }[]>`
        insert into stages (division_id, seq, kind, name) values (${divisionId}, 1, 'swiss', 'Swiss') returning id, org_id`;
      return s!;
    };

    it("unopened: the smallest ladder size holding the places held (P14, computed once); opened: 256 and frozen; every row unpaid", async () => {
      await seedBoardgameSport();
      const org = await seedOrg();
      const organiser = await seedUser();

      // Each case: what it seeds, the places it holds (counted by hand from the seed, then checked against the cap's own
      // count), and the size spec §7.1 says the migration writes. Every boundary case has a wrong neighbour one place away.
      type Case = { name: string; seed: (d: SeedDivision) => Promise<void>; held: number; size: number; frozen: boolean };
      const CASES: Case[] = [
        { name: "empty", seed: async () => {}, held: 0, size: 16, frozen: false },
        { name: "16 live, 2 departed (withdrawn, disqualified)", held: 16, size: 16, frozen: false, seed: async (d) => {
          await entrants(d.id, 16);
          await entrants(d.id, 1, "withdrawn");
          await entrants(d.id, 1, "disqualified");
        } },
        { name: "16 live + 1 pending sign-up, a Swiss stage never opened", held: 17, size: 32, frozen: false, seed: async (d) => {
          await entrants(d.id, 16, "registered");
          await signUp(d, "pending");
          await swissStage(d.id);
        } },
        { name: "16 live; sign-ups that hold nothing (waitlisted, withdrawn, expired, rejected, a free agent, one already an entrant)",
          held: 16, size: 16, frozen: false, seed: async (d) => {
            await entrants(d.id, 16);
            for (const s of ["waitlisted", "withdrawn", "expired", "rejected"] as const) await signUp(d, s);
            await signUp(d, "pending", { freeAgent: true });
            const [e] = await sql<{ id: string }[]>`select id from entrants where division_id = ${d.id} limit 1`;
            await signUp(d, "confirmed", { entrantId: e!.id });
          } },
        { name: "63 live + a paid and a confirmed sign-up with no entrant", held: 65, size: 128, frozen: false, seed: async (d) => {
          await entrants(d.id, 63);
          await signUp(d, "paid");
          await signUp(d, "confirmed");
        } },
        { name: "exactly 128", held: 128, size: 128, frozen: false, seed: async (d) => { await entrants(d.id, 128); } },
        // Over the online cap (stored before the cap existed, §5.2): no ladder size holds it, and sizeFor has no answer. The
        // migration writes 256, so the division reads as full, exactly as the cap reads it today (onlineRoomLeft).
        { name: "257 live, over the cap", held: 257, size: 256, frozen: false, seed: async (d) => { await entrants(d.id, 257); } },
        { name: "a round opened, 3 live", held: 3, size: 256, frozen: true, seed: async (d) => {
          await entrants(d.id, 3);
          const stage = await swissStage(d.id);
          await sql`insert into stage_round_opens (stage_id, org_id, round_no, opened_by) values (${stage.id}, ${stage.org_id}, 1, ${organiser})`;
        } },
        // P8: the package reads the STAMP, not anyRoundOpened's `opened_at <= now` (spec §5.4: that read can answer false
        // for a division that did open). A stamp dated ahead of the clock is still an opened round.
        { name: "a round stamp dated ahead of the clock, 2 live", held: 2, size: 256, frozen: true, seed: async (d) => {
          await entrants(d.id, 2);
          const stage = await swissStage(d.id);
          await sql`insert into stage_round_opens (stage_id, org_id, round_no, opened_by, opened_at)
                    values (${stage.id}, ${stage.org_id}, 1, ${organiser}, now() + interval '1 day')`;
        } },
      ];
      const seeded: Array<{ d: SeedDivision; c: Case }> = [];
      for (const c of CASES) {
        const d = await seedDivision(org, { name: c.name.slice(0, 60) });
        await c.seed(d);
        seeded.push({ d, c });
      }

      // Not online: no row. Online play off (absent, and stored 'off'), and every OTHER sport with 'lichess' stored.
      const notOnline: SeedDivision[] = [
        await seedDivision(org, { config: {} }),
        await seedDivision(org, { config: { onlinePlay: "off" } }),
      ];
      const otherSports = (await sql<{ key: string }[]>`select key from sports where key <> 'boardgame' order by key`).map((r) => r.key);
      expect(otherSports.length, "anti-vacuity: the catalogue holds other sports").toBeGreaterThan(0);
      for (const sport of otherSports) notOnline.push(await seedDivision(org, { sport, config: { onlinePlay: "lichess" } }));

      const statement = backfillStatement();
      const { rows, now } = await runBackfill(statement, [...seeded.map((s) => s.d.id), ...notOnline.map((d) => d.id)]);

      let checked = 0;
      for (const { d, c } of seeded) {
        // The hand count is the cap's count (online-entrant-cap.ts, the one authority for places held).
        expect(await countOnlineHeld(sql, d.id), `${c.name}: places held`).toBe(c.held);
        // And the size is the price leaf's answer where it has one (P14).
        if (c.held <= 256 && !c.frozen) expect(sizeFor(c.held), `${c.name}: sizeFor`).toBe(c.size);
        const row = rows.filter((r) => r.division_id === d.id);
        expect(row, `${c.name}: one row`).toHaveLength(1);
        expect(row[0], c.name).toEqual({
          division_id: d.id, org_id: org, division_name: d.name, size: c.size, frozen_at: c.frozen ? now : null,
          paid_at: null, cameras_paid: null, credits_paid: 0, credits_refunded: 0, credits_forfeited: 0, refunded_at: null, paid_by: null,
        });
        checked += 1;
      }
      expect(checked, "anti-vacuity: online divisions checked").toBe(CASES.length);
      const strays = rows.filter((r) => notOnline.some((d) => d.id === r.division_id));
      expect(strays, `no row for a division that does not play online (${notOnline.length} checked)`).toEqual([]);
      expect(notOnline.length).toBe(2 + otherSports.length);

      // The backfill wrote to the temp copy only.
      const [{ real }] = await sql<{ real: number }[]>`
        select count(*)::int as real from division_online_packages where division_id in ${sql(seeded.map((s) => s.d.id))}`;
      expect(real, "nothing reached the real table").toBe(0);
    });
  });
});
