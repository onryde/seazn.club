// Sponsor deals, Task 1: the deal schema on `sponsor_orders` (plan 2026-11-07-sponsor-deals, D1-D6, F4, F5, F22). A
// constraint is only real if something tries to violate it (AGENTS.md class 3), so every named constraint below has an
// accepted row and a refused row in the same `it`, and every refusal names its CONSTRAINT, not just its SQLSTATE (a row
// that breaks two rules would otherwise pass for either). An empty schema cannot pass: the accepted twin fails first.
//
// Expected values are the brief's literals (the value sets, the column list, the FK actions), the controller's F3 ruling
// (`duplicate_payment`) or a declared constant (SPONSOR_TIERS), never read back from the migration and then compared to
// itself. Every sweep reports how many items it checked, and zero checked is a failure.
//
// Rows are written on the privileged `sql` client (the webhook's connection). Real Postgres required (skipped without
// DATABASE_URL like every DB suite under src/server).
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sql, withTenant } from "@/lib/db";
import { SPONSOR_TIERS } from "@/lib/sponsor-tiers";

const HAS_DB = !!process.env.DATABASE_URL;

// ---- the delta, found by SUFFIX, never by number (a renumber before merge is a pure `git mv`) -------------------------
const DELTAS_DIR = resolve(__dirname, "../../../../../../db/migration/deltas");
const SPONSOR_DEALS_DELTA = /^V\d+__sponsor_deals\.sql$/;
const DELTA_MATCHES = readdirSync(DELTAS_DIR).filter((f) => SPONSOR_DEALS_DELTA.test(f));
const DELTA_FILE = resolve(DELTAS_DIR, DELTA_MATCHES[0] ?? "the-sponsor-deals-delta-is-missing.sql");
const deltaText = (): string => readFileSync(DELTA_FILE, "utf8");

// ---- the brief's literals ------------------------------------------------------------------------------------------
/** D2: the deal lifecycle. */
const DEAL_STATUSES = ["draft", "awaiting_payment", "awaiting_approval", "scheduled", "live", "ended"];
const PAYMENT_METHODS = ["online", "offline", "complimentary"];
const GO_LIVE = ["on_payment", "immediate", "on_approval"];
/** The brief's six, plus `duplicate_payment` (controller ruling F3: a second, different intent on an already-paid deal is
 *  recorded by Task 8 as its own ENDED, paid row), plus `written_off` (Task 23 carry 4: the club waived an offline invoice
 *  still due after its deal ended; the CHECK is redefined by the `__sponsor_deal_written_off.sql` delta, which the catalog
 *  reads below carry). */
const ENDED_REASONS = [
  "refunded", "dispute_lost", "ended_now", "expired", "competition_finished", "legacy", "duplicate_payment", "written_off",
];
/** The written-off delta, found by its SUFFIX like this file's own. */
const WRITTEN_OFF_DELTA = /^V\d+__sponsor_deal_written_off\.sql$/;
/** D2: money keeps its meaning, plus `none` for complimentary. */
const PAYMENT_STATUSES = ["pending", "paid", "failed", "refunded", "none"];

/** Every column the delta adds to sponsor_orders: [name, information_schema data_type, nullable, default]. The deal
 *  columns carry NO default, so a seed that forgets one fails loudly (23502) instead of silently becoming a draft. */
const NEW_COLUMNS: readonly [string, string, "YES" | "NO", string | null][] = [
  ["deal_status", "text", "NO", null],
  ["payment_method", "text", "NO", null],
  ["go_live", "text", "NO", null],
  ["tier", "text", "NO", null],
  ["includes_on_stream", "boolean", "NO", null],
  ["package_name", "text", "NO", null],
  ["competition_id", "uuid", "YES", null],
  ["ends_at", "timestamp with time zone", "YES", null],
  ["created_by", "uuid", "YES", null],
  ["invoice_sent_at", "timestamp with time zone", "YES", null],
  ["marked_paid_by", "uuid", "YES", null],
  ["approved_at", "timestamp with time zone", "YES", null],
  ["approved_by", "uuid", "YES", null],
  ["live_at", "timestamp with time zone", "YES", null],
  ["ended_at", "timestamp with time zone", "YES", null],
  ["ended_reason", "text", "YES", null],
  ["parked_at", "timestamp with time zone", "YES", null],
  ["checkout_session_id", "text", "YES", null],
  ["checkout_url", "text", "YES", null],
  ["checkout_expires_at", "timestamp with time zone", "YES", null],
  ["invoice_send_count", "integer", "NO", "0"],
];
/** The NOT NULL deal columns with no default: omitting any one of them is refused. */
const NO_DEFAULT_REQUIRED = NEW_COLUMNS.filter(([, , nullable, dflt]) => nullable === "NO" && dflt === null).map(([c]) => c);

/** Every FK on sponsor_orders: column -> [parent, ON DELETE]. `r` restrict, `n` set null. The sponsor FK moves from set
 *  null to RESTRICT (a deal is history); every actor FK is set null (F22), the house convention, so deleting a user is
 *  never blocked by a deal. org/package are V299's, unchanged. */
const FK_ACTIONS: Readonly<Record<string, [string, "r" | "n"]>> = {
  org_id: ["organizations", "r"],
  package_id: ["sponsor_packages", "r"],
  sponsor_id: ["sponsors", "r"],
  competition_id: ["competitions", "r"],
  created_by: ["users", "n"],
  marked_paid_by: ["users", "n"],
  approved_by: ["users", "n"],
};
/** FKs whose parent the app deletes: each delete walks the FK, so each has an index led by its column. */
const WALKED_FKS = ["sponsor_id", "competition_id"];

// ---- rig ----------------------------------------------------------------------------------------------------------
const uniq = () => randomUUID().slice(0, 8);
const made = { orgIds: [] as string[], userIds: [] as string[] };
const refusedBy = (code: string, constraint: string) => ({ code, constraint_name: constraint });

interface World {
  orgId: string;
  compId: string;
  /** An org-wide package (competition_id null). */
  packageId: string;
}

async function world(): Promise<World> {
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values ('Deals Org', ${`deals-${uniq()}`}) returning id`;
  made.orgIds.push(orgId);
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug) values (${orgId}, 'Deals Cup', ${`deals-cup-${uniq()}`}) returning id`;
  const [{ id: packageId }] = await sql<{ id: string }[]>`
    insert into sponsor_packages (org_id, competition_id, name, price_cents, currency, tier)
    values (${orgId}, ${null}, 'Gold', 25000, 'gbp', 'gold') returning id`;
  return { orgId, compId, packageId };
}

async function sponsor(w: World, competitionId: string | null = null): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, competition_id, name) values (${w.orgId}, ${competitionId}, ${`Acme ${uniq()}`}) returning id`;
  return row!.id;
}

async function user(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${`deals-${uniq()}@test.local`}, 'Deal Actor', true) returning id`;
  made.userIds.push(row!.id);
  return row!.id;
}

type Deal = Record<string, string | number | boolean | Date | null>;

/** A coherent deal: an online, on-payment deal awaiting payment, with every deal column explicit. `over` changes it. */
function deal(w: World, sponsorId: string | null, over: Deal = {}): Deal {
  return {
    org_id: w.orgId, package_id: w.packageId, sponsor_name: "Acme", sponsor_email: "billing@acme.test",
    amount_cents: 25000, currency: "gbp", status: "pending", sponsor_id: sponsorId,
    deal_status: "awaiting_payment", payment_method: "online", go_live: "on_payment",
    tier: "gold", includes_on_stream: false, package_name: "Gold", competition_id: null,
    ended_at: null, ended_reason: null,
    ...over,
  };
}
const LIVE: Deal = { deal_status: "live", status: "paid", live_at: new Date() };
const ended = (reason: string): Deal => ({ deal_status: "ended", ended_at: new Date(), ended_reason: reason });
const COMPLIMENTARY: Deal = { payment_method: "complimentary", status: "none", go_live: "immediate" };

async function insertDeal(row: Deal): Promise<string> {
  const [r] = await sql<{ id: string }[]>`insert into sponsor_orders ${sql(row as Record<string, never>)} returning id`;
  return r!.id;
}

/** The quoted literals of a named CHECK on sponsor_orders, read from the catalog (empty when it does not exist). */
async function checkValues(name: string): Promise<string[]> {
  const [row] = await sql<{ def: string }[]>`
    select pg_get_constraintdef(oid) as def from pg_constraint
     where conrelid = 'sponsor_orders'::regclass and contype = 'c' and conname = ${name}`;
  return row ? [...row.def.matchAll(/'([^']+)'/g)].map((m) => m[1]!) : [];
}

afterAll(async () => {
  if (!HAS_DB) return;
  // Deals RESTRICT their org, package, sponsor and competition, so they go first; the org delete cascades the rest.
  if (made.orgIds.length > 0) {
    await sql`delete from sponsor_orders where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from organizations where id = any(${made.orgIds}::uuid[])`;
  }
  if (made.userIds.length > 0) await sql`delete from users where id = any(${made.userIds}::uuid[])`;
  await sql.end();
});

// ---- the file itself (no DB) ----------------------------------------------------------------------------------------
describe("the sponsor-deals delta", () => {
  it("exists exactly once, found by its suffix", () => {
    expect(DELTA_MATCHES, "the sponsor-deals delta is missing").toHaveLength(1);
  });

  it("opens `-- sponsor_deals — ` without naming a version, and carries its legacy markers exactly once each", () => {
    const text = deltaText();
    const first = text.split("\n").find((l) => l.trim() !== "")!;
    expect(first.startsWith("-- sponsor_deals — "), first).toBe(true);
    expect(first).not.toMatch(/\bV\d+\b/);
    expect(text.match(/^-- legacy:begin$/gm), "legacy:begin").toHaveLength(1);
    expect(text.match(/^-- legacy:end$/gm), "legacy:end").toHaveLength(1);
  });
});

describe.skipIf(!HAS_DB)("sponsor deals schema — the constraints are real", () => {
  it("adds every deal column with the brief's type, nullability and default (count reported)", async () => {
    const cols = await sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>`
      select column_name, data_type, is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name = 'sponsor_orders'`;
    let checked = 0;
    for (const [name, type, nullable, dflt] of NEW_COLUMNS) {
      const c = cols.find((x) => x.column_name === name);
      expect(c, `${name} exists`).toBeDefined();
      expect([c!.data_type, c!.is_nullable, c!.column_default], name).toEqual([type, nullable, dflt]);
      checked++;
    }
    expect(checked, "columns checked").toBe(21);
    // ...and sponsor_email is nullable now (an offline or complimentary deal may have no billing address).
    expect(cols.find((x) => x.column_name === "sponsor_email")?.is_nullable).toBe("YES");
  });

  it("each no-default NOT NULL deal column, when omitted, is refused by NOT NULL (23502) naming it; the full row is accepted (count reported)", async () => {
    const w = await world();
    await expect(insertDeal(deal(w, await sponsor(w)))).resolves.toBeTruthy();
    let refused = 0;
    for (const col of NO_DEFAULT_REQUIRED) {
      const row = deal(w, await sponsor(w));
      delete row[col];
      await expect(insertDeal(row), col).rejects.toMatchObject({ code: "23502", column_name: col });
      refused++;
    }
    expect(refused, "required columns checked").toBe(6);
  });

  it("sponsor_packages.includes_on_stream is boolean NOT NULL default false: a package written without it reads false, and it takes true", async () => {
    const [col] = await sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name = 'sponsor_packages' and column_name = 'includes_on_stream'`;
    expect(col).toEqual({ data_type: "boolean", is_nullable: "NO", column_default: "false" });
    const w = await world();
    const [pkg] = await sql<{ includes_on_stream: boolean }[]>`select includes_on_stream from sponsor_packages where id = ${w.packageId}`;
    expect(pkg!.includes_on_stream).toBe(false);
    const [on] = await sql<{ includes_on_stream: boolean }[]>`
      update sponsor_packages set includes_on_stream = true where id = ${w.packageId} returning includes_on_stream`;
    expect(on!.includes_on_stream).toBe(true);
  });

  it("every value CHECK's set equals the brief's literals, read from the catalog (6 sets reported)", async () => {
    const SETS: readonly [string, readonly string[]][] = [
      ["sponsor_orders_deal_status_check", DEAL_STATUSES],
      ["sponsor_orders_payment_method_check", PAYMENT_METHODS],
      ["sponsor_orders_go_live_check", GO_LIVE],
      ["sponsor_orders_tier_check", SPONSOR_TIERS],
      ["sponsor_orders_ended_reason_check", ENDED_REASONS],
      ["sponsor_orders_payment_status_check", PAYMENT_STATUSES],
    ];
    let checked = 0;
    for (const [name, expected] of SETS) {
      const values = await checkValues(name);
      expect(values.length, `${name} found`).toBeGreaterThan(0);
      expect([...values].sort(), name).toEqual([...expected].sort());
      checked++;
    }
    expect(checked, "value sets checked").toBe(6);
  });

  it("the old unnamed status CHECK (sponsor_orders_status_check) is gone; the new one accepts `none` and refuses anything else by name", async () => {
    const old = await sql`select 1 from pg_constraint where conrelid = 'sponsor_orders'::regclass and conname = 'sponsor_orders_status_check'`;
    expect(old).toHaveLength(0);
    const w = await world();
    await expect(insertDeal(deal(w, await sponsor(w), COMPLIMENTARY))).resolves.toBeTruthy();
    let accepted = 0;
    for (const s of ["pending", "paid", "failed", "refunded"]) {
      await expect(insertDeal(deal(w, await sponsor(w), { status: s })), s).resolves.toBeTruthy();
      accepted++;
    }
    expect(accepted).toBe(4);
    await expect(insertDeal(deal(w, await sponsor(w), { status: "comped" })))
      .rejects.toMatchObject(refusedBy("23514", "sponsor_orders_payment_status_check"));
  });

  it("deal_status: each of the six accepted in its own shape, anything else refused by name (count reported)", async () => {
    const w = await world();
    let accepted = 0;
    for (const s of DEAL_STATUSES) {
      const shape = s === "ended" ? ended("ended_now") : s === "live" ? LIVE : { deal_status: s };
      await expect(insertDeal(deal(w, await sponsor(w), shape)), s).resolves.toBeTruthy();
      accepted++;
    }
    expect(accepted).toBe(6);
    await expect(insertDeal(deal(w, await sponsor(w), { deal_status: "paused" })))
      .rejects.toMatchObject(refusedBy("23514", "sponsor_orders_deal_status_check"));
  });

  it("payment_method: online, offline, complimentary accepted, anything else refused by name (count reported)", async () => {
    const w = await world();
    let accepted = 0;
    for (const m of PAYMENT_METHODS) {
      const shape = m === "complimentary" ? COMPLIMENTARY : { payment_method: m };
      await expect(insertDeal(deal(w, await sponsor(w), shape)), m).resolves.toBeTruthy();
      accepted++;
    }
    expect(accepted).toBe(3);
    await expect(insertDeal(deal(w, await sponsor(w), { payment_method: "cash" })))
      .rejects.toMatchObject(refusedBy("23514", "sponsor_orders_payment_method_check"));
  });

  it("go_live: on_payment, immediate, on_approval accepted, anything else refused by name (count reported)", async () => {
    const w = await world();
    let accepted = 0;
    for (const g of GO_LIVE) {
      await expect(insertDeal(deal(w, await sponsor(w), { go_live: g })), g).resolves.toBeTruthy();
      accepted++;
    }
    expect(accepted).toBe(3);
    await expect(insertDeal(deal(w, await sponsor(w), { go_live: "tomorrow" })))
      .rejects.toMatchObject(refusedBy("23514", "sponsor_orders_go_live_check"));
  });

  it("tier: every SPONSOR_TIERS value accepted, anything else refused by name (count reported)", async () => {
    const w = await world();
    let accepted = 0;
    for (const t of SPONSOR_TIERS) {
      await expect(insertDeal(deal(w, await sponsor(w), { tier: t })), t).resolves.toBeTruthy();
      accepted++;
    }
    expect(accepted).toBe(SPONSOR_TIERS.length);
    expect(accepted).toBeGreaterThan(0);
    await expect(insertDeal(deal(w, await sponsor(w), { tier: "platinum" })))
      .rejects.toMatchObject(refusedBy("23514", "sponsor_orders_tier_check"));
  });

  it("ended_reason: each of the eight accepted on an ended deal, anything else refused by name (count reported)", async () => {
    const w = await world();
    let accepted = 0;
    for (const r of ENDED_REASONS) {
      // A write-off is of an unpaid OFFLINE deal that went live (sponsor_orders_written_off_unpaid_offline, tested below).
      const shape = r === "written_off" ? { ...ended(r), payment_method: "offline", live_at: new Date() } : ended(r);
      await expect(insertDeal(deal(w, await sponsor(w), shape)), r).resolves.toBeTruthy();
      accepted++;
    }
    expect(accepted).toBe(8);
    await expect(insertDeal(deal(w, await sponsor(w), ended("bored"))))
      .rejects.toMatchObject(refusedBy("23514", "sponsor_orders_ended_reason_check"));
  });

  it("written_off_unpaid_offline: a write-off is of an unpaid OFFLINE deal that went live only; every other method, money or a deal never live refused by name (9 rows reported)", async () => {
    expect(readdirSync(DELTAS_DIR).filter((f) => WRITTEN_OFF_DELTA.test(f)), "the written-off delta, by suffix").toHaveLength(1);
    const w = await world();
    // Every row but the never-live ones went live: the money is owed because the sponsor had the placement (`endedStillDue`, m9).
    const WENT_LIVE = { live_at: new Date() };
    const ACCEPTED: [string, Deal][] = [
      ["offline, pending, went live", { payment_method: "offline", status: "pending", ...WENT_LIVE }],
      ["offline, failed, went live", { payment_method: "offline", status: "failed", ...WENT_LIVE }],
    ];
    const REFUSED: [string, Deal][] = [
      ["online, pending (a card deal ended unpaid claims nothing)", { payment_method: "online", status: "pending", ...WENT_LIVE }],
      ["online, failed", { payment_method: "online", status: "failed", ...WENT_LIVE }],
      ["offline, paid (nothing left to write off)", { payment_method: "offline", status: "paid", ...WENT_LIVE }],
      ["offline, refunded", { payment_method: "offline", status: "refunded", ...WENT_LIVE }],
      ["complimentary (never invoiced)", { ...COMPLIMENTARY, go_live: "immediate", ...WENT_LIVE }],
      // T23 review m9: a deal that never went live owed nothing, so there is nothing to write off.
      ["offline, pending, never live", { payment_method: "offline", status: "pending", live_at: null }],
      ["offline, failed, never live", { payment_method: "offline", status: "failed", live_at: null }],
    ];
    let checked = 0;
    for (const [label, shape] of ACCEPTED) {
      await expect(insertDeal(deal(w, await sponsor(w), { ...ended("written_off"), ...shape })), label).resolves.toBeTruthy();
      checked++;
    }
    for (const [label, shape] of REFUSED) {
      await expect(insertDeal(deal(w, await sponsor(w), { ...ended("written_off"), ...shape })), label)
        .rejects.toMatchObject(refusedBy("23514", "sponsor_orders_written_off_unpaid_offline"));
      checked++;
    }
    expect(checked, "rows checked").toBe(9);
    // The other reasons are untouched by it: an online deal ended unpaid by the sweep is still accepted.
    await expect(insertDeal(deal(w, await sponsor(w), { ...ended("expired"), payment_method: "online", status: "pending" }))).resolves.toBeTruthy();
  });

  it("comp_needs_no_payment: a complimentary deal goes live immediately or on approval, never on payment", async () => {
    const w = await world();
    await expect(insertDeal(deal(w, await sponsor(w), { ...COMPLIMENTARY, go_live: "immediate" }))).resolves.toBeTruthy();
    await expect(insertDeal(deal(w, await sponsor(w), { ...COMPLIMENTARY, go_live: "on_approval" }))).resolves.toBeTruthy();
    // An offline deal may wait on payment: the rule is about complimentary only.
    await expect(insertDeal(deal(w, await sponsor(w), { payment_method: "offline", go_live: "on_payment" }))).resolves.toBeTruthy();
    await expect(insertDeal(deal(w, await sponsor(w), { ...COMPLIMENTARY, go_live: "on_payment" })))
      .rejects.toMatchObject(refusedBy("23514", "sponsor_orders_comp_needs_no_payment"));
  });

  it("none_iff_complimentary: money status `none` exactly when the deal is complimentary, both directions", async () => {
    const w = await world();
    await expect(insertDeal(deal(w, await sponsor(w), COMPLIMENTARY))).resolves.toBeTruthy();
    await expect(insertDeal(deal(w, await sponsor(w), { payment_method: "offline", status: "pending" }))).resolves.toBeTruthy();
    await expect(insertDeal(deal(w, await sponsor(w), { ...COMPLIMENTARY, status: "pending" })))
      .rejects.toMatchObject(refusedBy("23514", "sponsor_orders_none_iff_complimentary"));
    await expect(insertDeal(deal(w, await sponsor(w), { payment_method: "offline", status: "none" })))
      .rejects.toMatchObject(refusedBy("23514", "sponsor_orders_none_iff_complimentary"));
    await expect(insertDeal(deal(w, await sponsor(w), { payment_method: "online", status: "none" })))
      .rejects.toMatchObject(refusedBy("23514", "sponsor_orders_none_iff_complimentary"));
  });

  it("online_has_email: an online deal needs a billing address; offline and complimentary may have none", async () => {
    const w = await world();
    await expect(insertDeal(deal(w, await sponsor(w), { sponsor_email: "billing@acme.test" }))).resolves.toBeTruthy();
    await expect(insertDeal(deal(w, await sponsor(w), { payment_method: "offline", sponsor_email: null }))).resolves.toBeTruthy();
    await expect(insertDeal(deal(w, await sponsor(w), { ...COMPLIMENTARY, sponsor_email: null }))).resolves.toBeTruthy();
    await expect(insertDeal(deal(w, await sponsor(w), { sponsor_email: null })))
      .rejects.toMatchObject(refusedBy("23514", "sponsor_orders_online_has_email"));
  });

  it("sponsor_or_legacy: only an ENDED legacy row may lack a sponsor — never a live, open, or otherwise-ended deal (MUTATE: drop `ended_reason = 'legacy'`)", async () => {
    const w = await world();
    await expect(insertDeal(deal(w, null, ended("legacy")))).resolves.toBeTruthy();
    await expect(insertDeal(deal(w, await sponsor(w), ended("legacy")))).resolves.toBeTruthy();
    // ended_reason is NULL on these two: a CHECK passes on NULL, so `or ended_reason = 'legacy'` alone would let them in.
    await expect(insertDeal(deal(w, null, LIVE))).rejects.toMatchObject(refusedBy("23514", "sponsor_orders_sponsor_or_legacy"));
    await expect(insertDeal(deal(w, null))).rejects.toMatchObject(refusedBy("23514", "sponsor_orders_sponsor_or_legacy"));
    await expect(insertDeal(deal(w, null, ended("refunded")))).rejects.toMatchObject(refusedBy("23514", "sponsor_orders_sponsor_or_legacy"));
    // A legacy REASON on a deal that has not ended is no excuse. ended_shape refuses that row too, and first (CHECKs run in
    // name order), so the two guards would cover for each other: the sponsor rule's own `deal_status = 'ended'` half is
    // proven ALONE, with ended_shape lifted inside a rolled-back transaction.
    const mixed = deal(w, null, { ...LIVE, ended_reason: "legacy" });
    await expect(insertDeal(mixed)).rejects.toMatchObject(refusedBy("23514", "sponsor_orders_ended_shape"));
    const ROLLBACK = new Error("rolled back on purpose");
    let alone: unknown = "not reached";
    await expect(sql.begin(async (tx) => {
      await tx`set local lock_timeout = '5s'`;
      await tx`alter table sponsor_orders drop constraint sponsor_orders_ended_shape`;
      alone = await tx`insert into sponsor_orders ${tx(mixed as Record<string, never>)} returning id`.then(() => "accepted", (e: unknown) => e);
      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);
    expect(alone).toMatchObject(refusedBy("23514", "sponsor_orders_sponsor_or_legacy"));
  });

  it("ended_shape: a deal is ended IFF it has both its end time and its reason — every mixed shape refused by name (count reported; MUTATE: the one-sided `= (ended_at is not null and ended_reason is not null)`)", async () => {
    const w = await world();
    // Accepted: ended with both; not ended with neither (each of the five other lifecycle states).
    await expect(insertDeal(deal(w, await sponsor(w), ended("expired")))).resolves.toBeTruthy();
    let accepted = 0;
    for (const s of DEAL_STATUSES.filter((x) => x !== "ended")) {
      await expect(insertDeal(deal(w, await sponsor(w), s === "live" ? LIVE : { deal_status: s })), s).resolves.toBeTruthy();
      accepted++;
    }
    expect(accepted, "not-ended states accepted with neither").toBe(5);
    // Refused: every mixed shape (controller ruling 2026-11-09), on a live deal and on an open one.
    const MIXED: readonly [string, Deal][] = [
      ["ended, no end time", { ...ended("expired"), ended_at: null }],
      ["ended, no reason", { ...ended("expired"), ended_reason: null }],
      ["ended, neither", { ...ended("expired"), ended_at: null, ended_reason: null }],
      ["live, a reason and no end time", { ...LIVE, ended_reason: "expired" }],
      ["live, an end time and no reason", { ...LIVE, ended_at: new Date() }],
      ["live, both", { ...LIVE, ended_at: new Date(), ended_reason: "expired" }],
      ["awaiting payment, a reason and no end time", { ended_reason: "refunded" }],
      ["awaiting payment, an end time and no reason", { ended_at: new Date() }],
    ];
    let refused = 0;
    for (const [label, shape] of MIXED) {
      await expect(insertDeal(deal(w, await sponsor(w), shape)), label).rejects.toMatchObject(refusedBy("23514", "sponsor_orders_ended_shape"));
      refused++;
    }
    expect(refused, "mixed shapes refused").toBe(8);
  });

  it("one live deal per sponsor: a second live deal is refused by name; live beside ended, scheduled, or another sponsor's live is accepted (MUTATE: drop the index)", async () => {
    const w = await world();
    const s = await sponsor(w);
    await expect(insertDeal(deal(w, s, LIVE))).resolves.toBeTruthy();
    await expect(insertDeal(deal(w, s, ended("ended_now")))).resolves.toBeTruthy();
    await expect(insertDeal(deal(w, s, { deal_status: "scheduled", status: "paid" }))).resolves.toBeTruthy();
    await expect(insertDeal(deal(w, await sponsor(w), LIVE))).resolves.toBeTruthy();
    await expect(insertDeal(deal(w, s, LIVE))).rejects.toMatchObject(refusedBy("23505", "sponsor_orders_one_live_per_sponsor"));
    // The second call through an UPDATE: the scheduled deal cannot go live while the first is live.
    await expect(sql`update sponsor_orders set deal_status = 'live' where sponsor_id = ${s} and deal_status = 'scheduled'`)
      .rejects.toMatchObject(refusedBy("23505", "sponsor_orders_one_live_per_sponsor"));
  });

  it("F3 ruling: a duplicate payment on an already-paid deal is recorded as its own ENDED, paid row beside the live one", async () => {
    const w = await world();
    const s = await sponsor(w);
    await expect(insertDeal(deal(w, s, { ...LIVE, payment_intent_id: `pi_first_${uniq()}` }))).resolves.toBeTruthy();
    const dup = await insertDeal(deal(w, s, { ...ended("duplicate_payment"), status: "paid", payment_intent_id: `pi_second_${uniq()}` }));
    const [row] = await sql<{ deal_status: string; status: string; ended_reason: string; sponsor_id: string }[]>`
      select deal_status, status, ended_reason, sponsor_id from sponsor_orders where id = ${dup}`;
    expect(row).toEqual({ deal_status: "ended", status: "paid", ended_reason: "duplicate_payment", sponsor_id: s });
  });

  it("every FK's ON DELETE is the brief's: sponsor and competition RESTRICT, every actor set null (count reported)", async () => {
    const fks = await sql<{ col: string; parent: string; action: string }[]>`
      select a.attname as col, p.relname as parent, c.confdeltype as action
        from pg_constraint c
        join pg_class p on p.oid = c.confrelid
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       where c.conrelid = 'sponsor_orders'::regclass and c.contype = 'f'`;
    const got = Object.fromEntries(fks.map((k) => [k.col, [k.parent, k.action]]));
    expect(got).toEqual(FK_ACTIONS);
    expect(fks.length, "foreign keys checked").toBe(7);
  });

  it("deleting a sponsor that has a deal is refused by name (23503); deleting one with no deal is accepted", async () => {
    const w = await world();
    const withDeal = await sponsor(w);
    await insertDeal(deal(w, withDeal, ended("ended_now")));
    await expect(sql`delete from sponsors where id = ${withDeal}`).rejects.toMatchObject(refusedBy("23503", "sponsor_orders_sponsor_id_fkey"));
    const bare = await sponsor(w);
    await expect(sql`delete from sponsors where id = ${bare} returning id`).resolves.toHaveLength(1);
  });

  // Product ruling (controller, 2026-11-09, Task 5): a deal holds its sponsor only when it carries money or document
  // history. The tenant's prune policy (V300's fence, widened by this delta) admits exactly the other deals, so a sponsor
  // delete takes them with it; deleteSponsor's 409 is the app's answer for the rest, and this policy is the fence under it.
  // A legacy row passes only as V300 admitted it, an abandoned checkout (pending, no intent, undisputed, and so no sponsor:
  // before deals an order got its sponsor only when paid), because deleteCompetition sweeps those (review I1, 2026-11-09).
  it("the tenant's prune policy admits exactly the deals without money or document history: never paid or refunded money, a stored Checkout session or a legacy order beyond V300's abandoned checkout (count reported)", async () => {
    const w = await world();
    const COMP: Deal = { payment_method: "complimentary", status: "none", go_live: "immediate" };
    const KINDS: [string, Deal, "deleted" | "fenced"][] = [
      ["a draft", { deal_status: "draft" }, "deleted"],
      ["awaiting payment (open: ended_reason null)", {}, "deleted"],
      ["a failed payment, with its intent", { status: "failed", payment_intent_id: `pi_${uniq()}` }, "deleted"],
      ["a live complimentary deal", { ...COMP, deal_status: "live", live_at: new Date() }, "deleted"],
      ["an ended complimentary deal", { ...COMP, ...ended("ended_now") }, "deleted"],
      ["an unpaid deal that ended", ended("expired"), "deleted"],
      ["paid money", { ...LIVE, payment_intent_id: `pi_${uniq()}` }, "fenced"],
      ["refunded money", { ...ended("refunded"), status: "refunded", paid_at: new Date() }, "fenced"],
      ["a legacy abandoned checkout (pending, no intent, undisputed, no sponsor: V300's admission)",
        { ...ended("legacy"), sponsor_id: null }, "deleted"],
      ["a legacy paid order", { ...ended("legacy"), status: "paid", paid_at: new Date(), payment_intent_id: `pi_${uniq()}` }, "fenced"],
      ["a legacy pending order that reached Stripe (an intent)", { ...ended("legacy"), sponsor_id: null, payment_intent_id: `pi_${uniq()}` }, "fenced"],
      ["a legacy pending order once disputed", { ...ended("legacy"), sponsor_id: null, disputed_at: new Date() }, "fenced"],
      ["a legacy failed payment (V300 admitted only pending)", { ...ended("legacy"), sponsor_id: null, status: "failed" }, "fenced"],
      ["a stored Checkout session", { checkout_session_id: `cs_test_${uniq()}`, checkout_url: "https://checkout.stripe.test/x" }, "fenced"],
    ];
    let checked = 0;
    for (const [label, over, expected] of KINDS) {
      const id = await insertDeal(deal(w, await sponsor(w), over));
      const gone = await withTenant(w.orgId, (tx) => tx`delete from sponsor_orders where id = ${id} returning id`);
      expect(gone.length === 1 ? "deleted" : "fenced", label).toBe(expected);
      checked++;
    }
    expect(checked, "deal kinds checked").toBe(KINDS.length);
    expect(checked).toBe(14);
    // The tenant fence never crosses orgs, whatever the deal.
    const elsewhere = await world();
    const theirs = await insertDeal(deal(elsewhere, await sponsor(elsewhere), { deal_status: "draft" }));
    await expect(withTenant(w.orgId, (tx) => tx`delete from sponsor_orders where id = ${theirs} returning id`)).resolves.toHaveLength(0);
  });

  it("deleting a competition a deal is scoped to is refused by name (23503); deleting one with no deal is accepted", async () => {
    const w = await world();
    // An org-wide sponsor and package, so only the deal's own competition_id names the competition.
    await insertDeal(deal(w, await sponsor(w), { ...ended("competition_finished"), competition_id: w.compId }));
    await expect(sql`delete from competitions where id = ${w.compId}`)
      .rejects.toMatchObject(refusedBy("23503", "sponsor_orders_competition_id_fkey"));
    const [{ id: bare }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug) values (${w.orgId}, 'Bare Cup', ${`bare-${uniq()}`}) returning id`;
    await expect(sql`delete from competitions where id = ${bare} returning id`).resolves.toHaveLength(1);
  });

  it("F22: deleting the user who created, marked paid, or approved a deal is accepted, and the deal's actor then reads null (MUTATE: drop set null on approved_by)", async () => {
    const w = await world();
    const [creator, marker, approver] = [await user(), await user(), await user()];
    const id = await insertDeal(deal(w, await sponsor(w), {
      ...LIVE, payment_method: "offline", go_live: "on_approval",
      created_by: creator, marked_paid_by: marker, approved_by: approver, approved_at: new Date(),
    }));
    for (const u of [creator, marker, approver]) {
      await expect(sql`delete from users where id = ${u} returning id`).resolves.toHaveLength(1);
    }
    const [row] = await sql`select created_by, marked_paid_by, approved_by from sponsor_orders where id = ${id}`;
    expect(row).toEqual({ created_by: null, marked_paid_by: null, approved_by: null });
  });

  it("the walked FKs (sponsor_id, competition_id) each have an index led by their column (count reported)", async () => {
    const rows = await sql<{ col: string; indexed: boolean }[]>`
      select a.attname as col,
             exists (select 1 from pg_index i
                      where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1]
                        and (i.indpred is null
                             or pg_get_expr(i.indpred, i.indrelid) = '(' || quote_ident(a.attname) || ' IS NOT NULL)')) as indexed
        from pg_constraint c
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       where c.conrelid = 'sponsor_orders'::regclass and c.contype = 'f' and a.attname in ${sql(WALKED_FKS)}`;
    expect(rows.length, "walked FKs checked").toBe(2);
    for (const r of rows) expect(r.indexed, r.col).toBe(true);
  });

  it("final review m6: the hourly sweep's query walks the open-deals partial index in its own order - no scan of ended rows, no sort (MUTATE: drop the index, or change its predicate)", async () => {
    // The sweep's query as sweepSponsorDeals issues it from the route (no org scope). Pinned against the source first, so a
    // change to the sweep's WHERE or ORDER BY reds here, where the index has to change with it.
    const source = readFileSync(resolve(__dirname, "../../usecases/sponsor-deals.ts"), "utf8");
    expect(source, "the sweep still reads open deals by this predicate, in this order").toMatch(
      /from sponsor_orders\s+where deal_status <> 'ended' \$\{scope\}\s+order by created_at, id`/,
    );
    const SWEEP =
      "select id, org_id, deal_status, competition_id, ends_at, checkout_session_id from sponsor_orders where deal_status <> 'ended' order by created_at, id";
    // A test database is too small for the planner to prefer any index on cost, so the seq scan and the bitmap scan (which
    // reads in heap order and sorts after) are priced out: what is left is whether an index CAN serve the query - its predicate
    // implied by the WHERE, its key the ORDER BY.
    const plan = await sql.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      await tx`set local enable_bitmapscan = off`;
      return JSON.stringify(await tx.unsafe(`explain (format json) ${SWEEP}`));
    });
    expect(plan).toContain('"Index Name":"sponsor_orders_open_sweep_idx"');
    // Neither a full Sort nor an Incremental Sort (Postgres 13+, CI runs 16): an index on a PREFIX of the order key would
    // still be walked, then sorted incrementally.
    expect(plan, "keyed on the sweep's order: nothing to sort").not.toMatch(/"Node Type":"(Incremental )?Sort"/);
  });

  // D6: the legacy block is the file's own text between its markers, run as the migration runs it, in a transaction that
  // is rolled back. In the migration it runs BEFORE the NOT NULLs and before every CHECK on the table, so the test lifts
  // them (each CHECK's catalog definition is kept), plants a pre-migration row (no deal columns, no sponsor: V283's set
  // null took it), runs the block, then imposes the NOT NULLs and re-adds every CHECK from its kept definition, which
  // validates the rewritten row exactly as the migration does. One row per case, so "touched exactly 1" is the planted
  // row and not 0.
  const LEGACY_CASES: readonly { label: string; paid: boolean }[] = [
    { label: "a paid, disputed order whose placement was deleted (ended_at = paid_at)", paid: true },
    { label: "an abandoned checkout that never paid (ended_at = created_at)", paid: false },
  ];
  for (const c of LEGACY_CASES) {
    it(`legacy block: ${c.label} becomes an ENDED legacy deal with its package's snapshot, money untouched, exactly 1 row touched`, async () => {
      const block = /^-- legacy:begin\n([\s\S]*?)^-- legacy:end$/m.exec(deltaText())?.[1];
      expect(block, "the delta carries its legacy block").toBeDefined();
      const w = await world();
      const pkgName = `Legacy Silver ${uniq()}`;
      const [{ id: pkg }] = await sql<{ id: string }[]>`
        insert into sponsor_packages (org_id, competition_id, name, price_cents, currency, tier)
        values (${w.orgId}, ${w.compId}, ${pkgName}, 12345, 'eur', 'silver') returning id`;
      const ROLLBACK = new Error("rolled back on purpose");
      type Money = Record<string, string | null>;
      let before: Money = {};
      let after: Money = {};
      let got: Record<string, unknown> = {};
      let touched = -1;
      let reimposed = 0;
      await expect(sql.begin(async (tx) => {
        await tx`set local lock_timeout = '5s'`;
        // The stamps are compared as text, so read them in one zone whatever the session's.
        await tx`set local timezone = 'UTC'`;
        const checks = await tx<{ name: string; def: string }[]>`
          select conname as name, pg_get_constraintdef(oid) as def from pg_constraint
           where conrelid = 'sponsor_orders'::regclass and contype = 'c'`;
        for (const k of checks) await tx.unsafe(`alter table sponsor_orders drop constraint ${k.name}`);
        await tx`alter table sponsor_orders
                   alter column deal_status drop not null, alter column payment_method drop not null,
                   alter column go_live drop not null, alter column tier drop not null,
                   alter column includes_on_stream drop not null, alter column package_name drop not null`;
        const [{ id }] = await tx<{ id: string }[]>`
          insert into sponsor_orders (org_id, package_id, sponsor_name, sponsor_email, payment_intent_id, amount_cents, currency,
                                      status, sponsor_id, created_at, paid_at, disputed_at, dispute_id)
          values (${w.orgId}, ${pkg}, 'Old Sponsor', 'old@acme.test', ${c.paid ? `pi_legacy_${uniq()}` : null}, 12345, 'eur',
                  ${c.paid ? "paid" : "pending"}, ${null}, '2026-03-01 10:00:00.123456+00',
                  -- Sent as TEXT: a timestamptz parameter goes through a JS Date and loses its microseconds.
                  ${c.paid ? "2026-03-02 11:00:00.654321+00" : null}::text::timestamptz,
                  ${c.paid ? "2026-03-09 12:00:00.5+00" : null}::text::timestamptz,
                  ${c.paid ? `dp_legacy_${uniq()}` : null})
          returning id`;
        const money = (t: typeof tx) => t<Money[]>`
          select status, payment_intent_id, amount_cents::text, currency, sponsor_email, created_at::text, paid_at::text,
                 disputed_at::text, dispute_id
            from sponsor_orders where id = ${id}`;
        before = (await money(tx))[0]!;
        touched = (await tx.unsafe(block!)).count;
        after = (await money(tx))[0]!;
        got = (await tx`
          select deal_status, ended_reason, ended_at::text, payment_method, go_live, tier, package_name, competition_id,
                 includes_on_stream, sponsor_id
            from sponsor_orders where id = ${id}`)[0]!;
        // What the migration does next: the NOT NULLs, then every CHECK. A row the block left short fails here.
        await tx`alter table sponsor_orders
                   alter column deal_status set not null, alter column payment_method set not null,
                   alter column go_live set not null, alter column tier set not null,
                   alter column includes_on_stream set not null, alter column package_name set not null`;
        for (const k of checks) {
          await tx.unsafe(`alter table sponsor_orders add constraint ${k.name} ${k.def}`);
          reimposed++;
        }
        throw ROLLBACK;
      })).rejects.toBe(ROLLBACK);
      expect(touched, "rows the legacy block touched").toBe(1);
      // The brief's ten named CHECKs plus the money status one, plus Task 23's written_off_unpaid_offline (the
      // `__sponsor_deal_written_off.sql` delta); zero would mean nothing was validated.
      expect(reimposed, "CHECKs re-imposed on the rewritten row").toBe(12);
      expect(got).toEqual({
        deal_status: "ended",
        ended_reason: "legacy",
        ended_at: c.paid ? "2026-03-02 11:00:00.654321+00" : "2026-03-01 10:00:00.123456+00",
        payment_method: "online",
        go_live: "on_payment",
        tier: "silver",
        package_name: pkgName,
        competition_id: w.compId,
        includes_on_stream: false,
        sponsor_id: null,
      });
      expect(Object.keys(before).length, "money columns compared").toBe(9);
      expect(after, "status and every money column are byte-equal").toEqual(before);
      if (c.paid) expect([before.status, before.disputed_at === null, before.dispute_id === null]).toEqual(["paid", false, false]);
    });
  }
});
