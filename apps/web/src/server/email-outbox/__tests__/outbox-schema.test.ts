// V470 email_outbox: the table, its two body/lease CHECKs, the replace trigger and the INSERT-only grant.
// Spec: docs/superpowers/specs/2026-10-19-email-outbox-design.md ("The row", "Statuses", "Credentials at rest").
//
// Claims that are not derivable from the DDL, and where each is pinned:
//  - the status and kind vocabularies are the spec's, and the SQL CHECK lists are the same sets as constants.ts
//    (two copies of one fact: the catalogue is read back, not retyped);
//  - a live credential never survives past a retryable status (body CHECK, counted over every other status);
//  - a lease exists exactly while a row is `sending` (both directions);
//  - a NEW row for the same kind + ref + recipient (case-insensitive) IN THE SAME ORGANISATION supersedes every older
//    non-terminal row, scrubs its body and lease, and touches nothing else (controller ruling 2026-10-20: the trigger
//    is security definer, so it fences tenants itself; two org-less sign-in links still replace each other). The act
//    is the SECOND insert: the older rows are seeded and read back first (ruling R3);
//  - app_user can enqueue and nothing else: the replace runs as the trigger's definer, so a tenant insert still
//    supersedes the older row although the tenant holds no UPDATE.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import {
  ENDED_BADLY_STATUSES,
  LIVE_STATUSES,
  OUTBOX_KINDS,
  OUTBOX_STATUSES,
  REPLACEABLE_STATUSES,
  RETRYABLE_STATUSES,
  type OutboxKind,
  type OutboxStatus,
} from "../constants";

const HAS_DB = !!process.env.DATABASE_URL;

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const INSUFFICIENT_PRIVILEGE = "42501";

// Typed from the spec's "Statuses" paragraph, never from constants.ts: "queued -> sending -> sent -> delivered, with
// delayed between sent and delivered. Terminal: delivered, bounced, complained, failed, suppressed, expired, dead,
// replaced."
const SPEC_STATUSES = [
  "queued", "sending", "sent", "delayed",
  "delivered", "bounced", "complained", "failed", "suppressed", "expired", "dead", "replaced",
];

// Typed from the phase-3 spec's kind table (wave order), never read from constants.ts: the two phase-1 kinds, the five wave-1
// kinds, wave 2's ten in the table's row order, then wave 3's eight in the table's row order. The vocabulary test compares
// constants.ts with it, and the live-CHECK read compares the database's constraint with it as well.
const SPEC_KINDS = [
  "magic_link", "chess_invite", "registration_confirmation", "payment_reminder", "registration_promoted",
  "refund_issued", "solo_signup_assigned",
  "registration_dispute_alert", "registration_dispute_lost", "sponsor_invoice", "sponsor_receipt", "sponsor_refund",
  "sponsor_dispute_alert", "sponsor_dispute_won", "sponsor_dispute_lost", "pass_revoked", "trial_ending",
  "email_verification", "funnel_claim", "email_change_confirmation", "email_change_notice", "account_deletion",
  "org_invite", "claim_invite", "official_invite",
];

describe("email outbox vocabularies (constants.ts)", () => {
  it("the status list is the spec's twelve, in the spec's order", () => {
    expect(SPEC_STATUSES.length).toBe(12);
    expect([...OUTBOX_STATUSES]).toEqual(SPEC_STATUSES);
  });

  it("the kinds are the spec's twenty-five, in the spec's wave order", () => {
    expect(SPEC_KINDS.length).toBe(25);
    expect([...OUTBOX_KINDS]).toEqual(SPEC_KINDS);
  });

  it("every status lands in exactly one of: replaceable, delivered, ended badly, replaced (checked: all twelve)", () => {
    const classes: Array<[string, readonly OutboxStatus[]]> = [
      ["replaceable", REPLACEABLE_STATUSES],
      ["delivered", ["delivered"]],
      ["endedBadly", ENDED_BADLY_STATUSES],
      ["replaced", ["replaced"]],
    ];
    let checked = 0;
    for (const s of OUTBOX_STATUSES) {
      const homes = classes.filter(([, members]) => members.includes(s)).map(([name]) => name);
      expect(homes, `status ${s}`).toHaveLength(1);
      checked++;
    }
    expect(checked).toBe(OUTBOX_STATUSES.length);
    // No class names a status the vocabulary does not have.
    for (const [name, members] of classes) {
      for (const m of members) expect(OUTBOX_STATUSES, `${name}: ${m}`).toContain(m);
    }
  });

  it("LIVE is the replaceable set plus delivered; RETRYABLE is queued and sending, a subset of replaceable", () => {
    expect([...LIVE_STATUSES].sort()).toEqual([...REPLACEABLE_STATUSES, "delivered"].sort());
    expect([...RETRYABLE_STATUSES].sort()).toEqual(["queued", "sending"]);
    for (const s of RETRYABLE_STATUSES) expect(REPLACEABLE_STATUSES).toContain(s);
    // Nothing that ended badly can still deliver.
    for (const s of ENDED_BADLY_STATUSES) expect(LIVE_STATUSES).not.toContain(s);
  });
});

type Outcome =
  | { accepted: true }
  | { accepted: false; code: string | undefined; constraint: string | undefined; column: string | undefined; message: string };

const attempt = (p: Promise<unknown>): Promise<Outcome> =>
  p.then(() => ({ accepted: true as const })).catch(
    (err: { code?: string; constraint_name?: string; column_name?: string; message?: string }) => ({
      accepted: false as const, code: err.code, constraint: err.constraint_name, column: err.column_name,
      message: err.message ?? "",
    }),
  );

describe.skipIf(!HAS_DB)("email_outbox (V470)", () => {
  /** Every ref this run writes starts with this, so teardown can find the org-less rows too. */
  const RUN = randomUUID().slice(0, 8);
  const BODY = Buffer.from("sealed-envelope-bytes");
  const AGED_MS = 3_600_000;
  let orgId = "";
  let otherOrgId = "";

  interface Seed {
    id?: string;
    kind?: OutboxKind;
    refType?: string;
    ref?: string;
    org?: string | null;
    to?: string;
    subject?: string;
    status?: string;
    body?: Buffer | null;
    lease?: boolean;
    transactional?: boolean;
    attempts?: number;
    providerId?: string | null;
    /** status_at one hour in the past, so a later write to it is visible. */
    aged?: boolean;
  }

  const newRef = (): string => `${RUN}-${randomUUID()}`;

  /** The one INSERT every writer in this file uses: no RETURNING (app_user holds no SELECT), the id is client-made. */
  async function insertRow(x: typeof sql, s: Seed = {}): Promise<string> {
    const id = s.id ?? randomUUID();
    const body = s.body === undefined ? BODY : s.body;
    await x`
      insert into email_outbox
        (id, kind, ref_type, ref_id, org_id, recipient, subject, body_sealed, transactional,
         status, attempts, lease_until, expires_at, provider_id, status_at)
      values
        (${id}, ${s.kind ?? "magic_link"}, ${s.refType ?? "login"}, ${s.ref ?? newRef()},
         ${s.org === undefined ? orgId : s.org}, ${s.to ?? `${randomUUID()}@x.test`}, ${s.subject ?? "subject"},
         ${body}, ${s.transactional ?? true},
         ${s.status ?? "queued"}, ${s.attempts ?? 0},
         ${s.lease ? new Date(Date.now() + 60_000) : null},
         now() + interval '1 hour', ${s.providerId ?? null},
         ${s.aged ? new Date(Date.now() - AGED_MS) : new Date()})`;
    return id;
  }

  /** A plain privileged insert; the replace trigger is live. */
  const row = (s: Seed = {}): Promise<string> => insertRow(sql, s);

  /**
   * History: rows that are already in a given status, for the SAME key. In production a row reaches `sent` or
   * `delayed` by an UPDATE after its insert; a plain insert of each would have the next insert replace the last. So
   * this transaction turns triggers off for itself (`session_replication_role = replica`, superuser) and inserts
   * the rows directly in their statuses. The act under test is always a LATER, ordinary insert.
   */
  async function seedHistory(seeds: Seed[]): Promise<string[]> {
    return (await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      const ids: string[] = [];
      for (const s of seeds) ids.push(await insertRow(tx as unknown as typeof sql, { aged: true, ...s }));
      return ids;
    })) as unknown as string[];
  }

  interface Stored {
    id: string;
    status: string;
    body_sealed: Buffer | null;
    lease_until: Date | null;
    status_at: Date;
  }
  const stored = async (ids: string[]): Promise<Map<string, Stored>> => {
    const rows = await sql<Stored[]>`
      select id, status, body_sealed, lease_until, status_at from email_outbox where id in ${sql(ids)}`;
    return new Map(rows.map((r) => [r.id, r]));
  };
  const statusOf = async (id: string): Promise<string | undefined> => (await stored([id])).get(id)?.status;
  /** The whole row as jsonb: a before/after comparison that cannot miss a column. */
  const snapshot = async (ids: string[]): Promise<Array<Record<string, unknown>>> =>
    (await sql<{ j: Record<string, unknown> }[]>`
      select to_jsonb(e) as j from email_outbox e where id in ${sql(ids)} order by id`).map((r) => r.j);

  const bodyFor = (s: OutboxStatus): Buffer | null => (RETRYABLE_STATUSES.includes(s) ? BODY : null);

  beforeAll(async () => {
    const mk = async (tag: string): Promise<string> => {
      const [o] = await sql<{ id: string }[]>`
        insert into organizations (name, slug) values (${`Outbox ${tag}`}, ${`outbox-${tag}-${RUN}`}) returning id`;
      return o!.id;
    };
    orgId = await mk("a");
    otherOrgId = await mk("b");
  });

  afterAll(async () => {
    // org_id is on delete cascade, so the orgs take their rows; the org-less ones are found by the run's prefix.
    await sql`delete from email_outbox where ref_id like ${`${RUN}-%`}`;
    await sql`delete from organizations where id in ${sql([orgId, otherOrgId])}`;
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });

  // ---- the vocabularies ----------------------------------------------------------------------------------------

  it("accepts every declared status and refuses an undeclared one", async () => {
    let accepted = 0;
    for (const s of OUTBOX_STATUSES) {
      await row({ status: s, body: bodyFor(s), lease: s === "sending" });
      accepted++;
    }
    expect(accepted).toBe(OUTBOX_STATUSES.length);
    expect(OUTBOX_STATUSES.length).toBe(12); // spec "Statuses"
    expect(await attempt(row({ status: "opened", body: null }))).toMatchObject({
      accepted: false, code: CHECK_VIOLATION, constraint: "email_outbox_status_valid",
    });
  });

  it("accepts every declared kind and refuses an undeclared one", async () => {
    let accepted = 0;
    for (const kind of OUTBOX_KINDS) {
      await row({ kind });
      accepted++;
    }
    expect(accepted).toBe(OUTBOX_KINDS.length);
    expect(await attempt(row({ kind: "newsletter" as OutboxKind }))).toMatchObject({
      accepted: false, code: CHECK_VIOLATION, constraint: "email_outbox_kind_valid",
    });
  });

  it("the CHECK lists in SQL name exactly the members of constants.ts (kinds and statuses)", async () => {
    const members = async (name: string): Promise<string[]> => {
      const [r] = await sql<{ def: string }[]>`
        select pg_get_constraintdef(oid) as def from pg_constraint
         where conrelid = 'email_outbox'::regclass and conname = ${name}`;
      expect(r, `constraint ${name} exists`).toBeDefined();
      return [...r!.def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!).sort();
    };
    const statuses = await members("email_outbox_status_valid");
    const kinds = await members("email_outbox_kind_valid");
    expect(statuses.length).toBeGreaterThan(0);
    expect(kinds.length).toBeGreaterThan(0);
    expect(statuses).toEqual([...OUTBOX_STATUSES].sort());
    expect(kinds).toEqual([...OUTBOX_KINDS].sort());
    // And the database's list is the spec's own twenty-five, read against the typed list, not only against constants.ts.
    expect(kinds).toEqual([...SPEC_KINDS].sort());
  });

  // ---- the credential and the lease ------------------------------------------------------------------------------

  it("refuses a body on any status outside RETRYABLE_STATUSES, and accepts one on each retryable status", async () => {
    const others = OUTBOX_STATUSES.filter((s) => !RETRYABLE_STATUSES.includes(s));
    let refused = 0;
    for (const s of others) {
      expect(await attempt(row({ status: s, body: BODY })), `status ${s} with a body`).toMatchObject({
        accepted: false, code: CHECK_VIOLATION, constraint: "email_outbox_body_only_while_retryable",
      });
      refused++;
    }
    expect(refused).toBe(OUTBOX_STATUSES.length - RETRYABLE_STATUSES.length);
    expect(refused).toBeGreaterThan(0);
    // The pair: the same body on a retryable status goes in.
    let accepted = 0;
    for (const s of RETRYABLE_STATUSES) {
      expect(await attempt(row({ status: s, body: BODY, lease: s === "sending" })), `status ${s}`).toEqual({ accepted: true });
      accepted++;
    }
    expect(accepted).toBe(RETRYABLE_STATUSES.length);
    // And a retryable row with NO body is accepted: the CHECK is "no body outside retryable", not "a body inside it".
    // Pinned on purpose (controller ruling 2026-10-20, plan Task 3): with no KEK and no Resend key (local dev, CI) the
    // sender enqueues a queued row with a null body and the attempt ends it dead 'no_api_key'; a body that is missing
    // while a key IS set ends it dead 'body_missing'. A "must hold a body" CHECK would refuse those inserts.
    let bodyless = 0;
    for (const s of RETRYABLE_STATUSES) {
      expect(await attempt(row({ status: s, body: null, lease: s === "sending" })), `status ${s} without a body`).toEqual({ accepted: true });
      bodyless++;
    }
    expect(bodyless).toBe(RETRYABLE_STATUSES.length);
  });

  it("refuses lease_until unless status = 'sending', and 'sending' without a lease", async () => {
    const notSending = OUTBOX_STATUSES.filter((s) => s !== "sending");
    let refused = 0;
    for (const s of notSending) {
      expect(await attempt(row({ status: s, body: bodyFor(s), lease: true })), `status ${s} with a lease`).toMatchObject({
        accepted: false, code: CHECK_VIOLATION, constraint: "email_outbox_lease_only_while_sending",
      });
      refused++;
    }
    expect(refused).toBe(OUTBOX_STATUSES.length - 1);
    expect(await attempt(row({ status: "sending", body: BODY, lease: false }))).toMatchObject({
      accepted: false, code: CHECK_VIOLATION, constraint: "email_outbox_lease_only_while_sending",
    });
    // The pair: 'sending' WITH a lease is the one accepted combination.
    expect(await attempt(row({ status: "sending", body: BODY, lease: true }))).toEqual({ accepted: true });
  });

  // ---- the other guards ------------------------------------------------------------------------------------------

  it("refuses a blank ref_type, ref_id or recipient and a negative attempts count, each by its own constraint", async () => {
    const cases: Array<[string, Seed, string]> = [
      ["blank ref_type", { refType: "" }, "email_outbox_ref_type_nonempty"],
      ["blank ref_id", { ref: "" }, "email_outbox_ref_id_nonempty"],
      ["blank recipient", { to: "" }, "email_outbox_recipient_nonempty"],
      ["negative attempts", { attempts: -1 }, "email_outbox_attempts_nonneg"],
    ];
    let refused = 0;
    for (const [label, seed, constraint] of cases) {
      expect(await attempt(row(seed)), label).toMatchObject({ accepted: false, code: CHECK_VIOLATION, constraint });
      refused++;
    }
    expect(refused).toBe(cases.length);
    // The pairs: zero attempts and the smallest non-blank values are fine.
    expect(await attempt(row({ attempts: 0, refType: "x", ref: `${RUN}-x`, to: "a@b" }))).toEqual({ accepted: true });
  });

  it("refuses a row that omits a required column (23502 names it), and accepts the same row with all of them", async () => {
    const full = {
      id: randomUUID(), kind: "magic_link", ref_type: "login", ref_id: newRef(), org_id: orgId,
      recipient: `${randomUUID()}@x.test`, subject: "subject", transactional: true,
      expires_at: new Date(Date.now() + 3_600_000),
    };
    const insertOmitting = (omit: string | null): Promise<unknown> => {
      const values: Record<string, string | boolean | Date> = { ...full, id: randomUUID() };
      if (omit !== null) delete values[omit];
      return sql`insert into email_outbox ${sql(values)}`;
    };
    // The pair first: with nothing omitted the builder's insert goes in, so a refusal below is the omitted column's.
    expect(await attempt(insertOmitting(null))).toEqual({ accepted: true });
    // `transactional` has no default on purpose (the caller must decide whether the suppression list applies), and
    // `expires_at` is what ends a row nobody sent; the rest identify and address it.
    const required = ["kind", "ref_type", "ref_id", "recipient", "subject", "transactional", "expires_at"];
    let refused = 0;
    for (const col of required) {
      expect(await attempt(insertOmitting(col)), `omitting ${col}`).toMatchObject({
        accepted: false, code: "23502", column: col,
      });
      refused++;
    }
    expect(refused).toBe(required.length);
  });

  it("provider_id is unique when present and free when absent", async () => {
    const pid = `re_${randomUUID()}`;
    await row({ providerId: pid });
    expect(await attempt(row({ providerId: pid }))).toMatchObject({
      accepted: false, code: UNIQUE_VIOLATION, constraint: "email_outbox_provider_idx",
    });
    // Two rows with no provider id coexist: the index is partial.
    expect(await attempt(row({ providerId: null }))).toEqual({ accepted: true });
    expect(await attempt(row({ providerId: null }))).toEqual({ accepted: true });
  });

  it("removing an organisation removes its rows; an org-less row is untouched", async () => {
    const [o] = await sql<{ id: string }[]>`
      insert into organizations (name, slug) values ('Outbox cascade', ${`outbox-cascade-${RUN}`}) returning id`;
    const mine = await row({ org: o!.id });
    const orgless = await row({ org: null });
    await sql`delete from organizations where id = ${o!.id}`;
    expect((await stored([mine])).size, "the org's row cascaded away").toBe(0);
    expect((await stored([orgless])).size, "the org-less row stayed").toBe(1);
  });

  // ---- the replace trigger ---------------------------------------------------------------------------------------

  it("a new row for the same kind+ref+recipient+org replaces every older REPLACEABLE row, nulls its body and lease, and leaves terminal rows, other recipients, other refs, other kinds and other orgs alone", async () => {
    const R = newRef();
    const ANN = "Ann@x.test";

    // History: one row per status, all for (magic_link, login, R, Ann@x.test).
    const older = await seedHistory(
      OUTBOX_STATUSES.map((s) => ({ ref: R, to: ANN, status: s, body: bodyFor(s), lease: s === "sending" })),
    );
    // Controls: each differs from the key in exactly ONE part, and is queued, so a replace of it would show.
    const controlSeeds: Array<[string, Seed]> = [
      ["other recipient", { ref: R, to: "bob@x.test" }],
      ["other kind", { ref: R, to: ANN, kind: "chess_invite" }],
      ["other ref_id", { ref: newRef(), to: ANN }],
      ["other ref_type", { ref: R, refType: "other_type", to: ANN }],
      // Same kind, ref and recipient, another TENANT: the definer trigger bypasses RLS, so only its own predicate keeps
      // this row from being superseded (and its body nulled) by a different org's insert.
      ["other org", { ref: R, to: ANN, org: otherOrgId }],
    ];
    const controls = await seedHistory(controlSeeds.map(([, s]) => s));

    // Before the act: every older row holds the status it was seeded in (the history is real, not already replaced).
    const before = await stored(older);
    expect(before.size).toBe(OUTBOX_STATUSES.length);
    OUTBOX_STATUSES.forEach((s, i) => expect(before.get(older[i]!)!.status, `seeded ${s}`).toBe(s));
    for (const id of controls) expect(await statusOf(id)).toBe("queued");
    const replaceableIds = older.filter((_, i) => REPLACEABLE_STATUSES.includes(OUTBOX_STATUSES[i]!));
    const untouchedIds = [...older.filter((_, i) => !REPLACEABLE_STATUSES.includes(OUTBOX_STATUSES[i]!)), ...controls];
    expect(replaceableIds.length).toBe(REPLACEABLE_STATUSES.length);
    expect(untouchedIds.length).toBe(OUTBOX_STATUSES.length - REPLACEABLE_STATUSES.length + controlSeeds.length);
    // Something to scrub: the replaceable set really holds bodies and a lease.
    expect(replaceableIds.filter((id) => before.get(id)!.body_sealed !== null).length).toBe(RETRYABLE_STATUSES.length);
    expect(replaceableIds.filter((id) => before.get(id)!.lease_until !== null).length).toBe(1);
    const untouchedBefore = await snapshot(untouchedIds);

    // The act: the SECOND insert. It differs from the history only in the recipient's letter case.
    const newId = await row({ ref: R, to: "ann@X.test" });

    const after = await stored([...older, newId]);
    for (const id of replaceableIds) {
      const r = after.get(id)!;
      expect(r.status, `older ${before.get(id)!.status} row`).toBe("replaced");
      expect(r.body_sealed, "its body is scrubbed").toBeNull();
      expect(r.lease_until, "its lease is cleared").toBeNull();
      expect(r.status_at.getTime(), "status_at moved").toBeGreaterThan(before.get(id)!.status_at.getTime() + AGED_MS / 2);
    }
    // Every row of the key that is now `replaced`: the four just replaced, plus the one seeded that way.
    const replacedNow = older.filter((id) => after.get(id)!.status === "replaced");
    expect(replacedNow.length).toBe(REPLACEABLE_STATUSES.length + 1);
    // Terminal history and all four controls are byte-identical.
    expect(await snapshot(untouchedIds)).toEqual(untouchedBefore);
    // The new row is the live one and keeps its body.
    expect(after.get(newId)!.status).toBe("queued");
    expect(after.get(newId)!.body_sealed).not.toBeNull();
  });

  it("org-less rows (the sign-in link) replace each other, and an org-less row and an org's row of the same key never replace one another", async () => {
    const R = newRef();
    const ANN = "ann@x.test";

    // The sign-in link's own case: two org-less rows, the newer replaces the older (NULL is not distinct from NULL).
    const first = await row({ ref: R, to: ANN, org: null });
    expect(await statusOf(first)).toBe("queued");
    const second = await row({ ref: R, org: null, to: "ANN@x.test" });
    expect(await statusOf(first), "org-less older row replaced by an org-less newer one").toBe("replaced");
    expect(await statusOf(second)).toBe("queued");

    // Neither direction crosses the org-less / org line.
    const withOrg = await row({ ref: R, to: ANN, org: orgId });
    expect(await statusOf(second), "an org's insert leaves the org-less row alone").toBe("queued");
    expect(await statusOf(withOrg)).toBe("queued");
    const orglessAgain = await row({ ref: R, to: ANN, org: null });
    expect(await statusOf(withOrg), "an org-less insert leaves the org's row alone").toBe("queued");
    expect(await statusOf(second), "but replaces the older org-less one").toBe("replaced");
    expect(await statusOf(orglessAgain)).toBe("queued");
  });

  it("the first row for a key replaces nothing, and a chain of three leaves only the last live", async () => {
    const R = newRef();
    const a = await row({ ref: R, to: "chain@x.test" });
    expect(await statusOf(a), "empty case: the first row of a key stays queued").toBe("queued");

    const b = await row({ ref: R, to: "chain@x.test" });
    expect(await statusOf(a)).toBe("replaced");
    expect(await statusOf(b)).toBe("queued");

    const c = await row({ ref: R, to: "CHAIN@x.test" });
    const s = await stored([a, b, c]);
    expect([s.get(a)!.status, s.get(b)!.status, s.get(c)!.status]).toEqual(["replaced", "replaced", "queued"]);
    expect([s.get(a)!.body_sealed, s.get(b)!.body_sealed]).toEqual([null, null]);
    // A replaced row is not replaced again: its status_at stays where the first replace put it.
    const aAt = s.get(a)!.status_at.getTime();
    await row({ ref: R, to: "chain@x.test" });
    expect((await stored([a])).get(a)!.status_at.getTime()).toBe(aAt);
  });

  // ---- app_user: enqueue and nothing else ------------------------------------------------------------------------

  it("app_user may INSERT inside withTenant without RETURNING, and the replace trigger still runs", async () => {
    const R = newRef();
    const [queued, sending, foreign] = await seedHistory([
      { ref: R, to: "Zed@x.test", status: "queued", body: BODY },
      { ref: R, to: "Zed@x.test", status: "sending", body: BODY, lease: true },
      // Another tenant's pending row for the same key: the tenant insert below must not reach it through the trigger.
      { ref: R, to: "Zed@x.test", status: "queued", body: BODY, org: otherOrgId },
    ]);
    expect(await statusOf(queued!)).toBe("queued");
    expect(await statusOf(foreign!)).toBe("queued");
    expect((await stored([sending!])).get(sending!)!.lease_until).not.toBeNull();

    const newId = randomUUID();
    await withTenant(orgId, (tx) => insertRow(tx as unknown as typeof sql, { id: newId, ref: R, to: "zed@x.test" }));

    const after = await stored([queued!, sending!, newId]);
    for (const id of [queued!, sending!]) {
      expect(after.get(id)!.status).toBe("replaced");
      expect(after.get(id)!.body_sealed).toBeNull();
      expect(after.get(id)!.lease_until).toBeNull();
    }
    expect(after.get(newId)!.status).toBe("queued");
    // The definer trigger bypasses RLS, so it is the fence: the other org's row keeps its status AND its credential.
    const theirs = (await stored([foreign!])).get(foreign!)!;
    expect(theirs.status).toBe("queued");
    expect(theirs.body_sealed).not.toBeNull();
  });

  it("app_user cannot SELECT, UPDATE or DELETE email_outbox (42501 each), nor read an insert back, nor insert for another org or for none", async () => {
    const victim = await row();
    // Org B's pending row. The "another org, same key" insert below names exactly this key. The replace trigger is an
    // AFTER ROW trigger (V472), so a refused insert never reaches it; were it BEFORE ROW it would match this row and
    // supersede it before the policy's WITH CHECK refused, and the refusal would have to roll that back. Either way the
    // row asserted afterwards is the witness that the refused statement touched nothing.
    const SAME_KEY = { ref: newRef(), to: "Pat@x.test" };
    const [theirs] = await seedHistory([{ ...SAME_KEY, status: "queued", body: BODY, org: otherOrgId }]);
    expect(await statusOf(theirs!)).toBe("queued");
    const denied: Array<[string, (tx: typeof sql) => Promise<unknown>, RegExp]> = [
      ["select", (tx) => tx`select id from email_outbox limit 1`, /permission denied for table email_outbox/],
      // `where false`, not `where id = …`: a WHERE that names a column needs SELECT, so a WHERE-by-id statement is refused
      // for lack of SELECT even if UPDATE or DELETE were granted (and RLS would then hide every row without an error).
      // This form reaches the privilege check on its own, and stays harmless if a regression ever lets it through.
      ["update", (tx) => tx`update email_outbox set attempts = 9 where false`, /permission denied for table email_outbox/],
      ["delete", (tx) => tx`delete from email_outbox where false`, /permission denied for table email_outbox/],
      [
        "insert ... returning",
        (tx) => tx`insert into email_outbox (id, kind, ref_type, ref_id, org_id, recipient, subject, body_sealed, transactional, expires_at)
                   values (${randomUUID()}, 'magic_link', 'login', ${newRef()}, ${orgId}, 'r@x.test', 's', ${BODY}, true, now() + interval '1 hour')
                   returning id`,
        /permission denied for table email_outbox/,
      ],
      ["insert for another org", (tx) => insertRow(tx, { org: otherOrgId }), /row-level security policy/],
      [
        "insert for another org, with that org's pending row's key",
        (tx) => insertRow(tx, { ...SAME_KEY, to: "pat@X.test", org: otherOrgId }),
        /row-level security policy/,
      ],
      ["insert with no org", (tx) => insertRow(tx, { org: null }), /row-level security policy/],
    ];
    let checked = 0;
    for (const [label, run, message] of denied) {
      const out = await attempt(withTenant(orgId, (tx) => run(tx as unknown as typeof sql)));
      expect(out, label).toMatchObject({ accepted: false, code: INSUFFICIENT_PRIVILEGE });
      expect((out as { message: string }).message, label).toMatch(message);
      checked++;
    }
    expect(checked).toBe(denied.length);
    expect(checked).toBe(7);
    // Refused, not silently empty: the victim is exactly as it was.
    const [v] = await sql<{ attempts: number }[]>`select attempts from email_outbox where id = ${victim}`;
    expect(v?.attempts).toBe(0);
    // And the other org's pending row survived the refused insert that named its key: status AND credential.
    const survivor = (await stored([theirs!])).get(theirs!)!;
    expect(survivor.status).toBe("queued");
    expect(survivor.body_sealed).not.toBeNull();
  });

  it("app_user holds exactly the INSERT privilege on email_outbox (the other six are checked in the catalogue)", async () => {
    const wanted: Array<[string, boolean]> = [
      ["INSERT", true], ["SELECT", false], ["UPDATE", false], ["DELETE", false],
      ["TRUNCATE", false], ["REFERENCES", false], ["TRIGGER", false],
    ];
    let checked = 0;
    for (const [priv, expected] of wanted) {
      const [r] = await sql<{ has: boolean }[]>`select has_table_privilege('app_user', 'email_outbox', ${priv}) as has`;
      expect(r!.has, priv).toBe(expected);
      checked++;
    }
    expect(checked).toBe(wanted.length);
  });

  it("RLS is enabled and forced, and the only policy is an INSERT policy for app_user scoped to the caller's org", async () => {
    const [c] = await sql<{ on: boolean; forced: boolean }[]>`
      select relrowsecurity as on, relforcerowsecurity as forced from pg_class where oid = 'email_outbox'::regclass`;
    expect(c).toEqual({ on: true, forced: true });
    const policies = await sql<{ policyname: string; cmd: string; roles: string[]; with_check: string | null }[]>`
      select policyname, cmd, roles::text[] as roles, with_check from pg_policies
       where schemaname = current_schema() and tablename = 'email_outbox'`;
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ policyname: "email_outbox_enqueue", cmd: "INSERT", roles: ["app_user"] });
    expect(policies[0]!.with_check).toMatch(/org_id = current_org_id\(\)/);
  });

  it("the replace trigger function is SECURITY DEFINER with a pinned search_path (schema first, pg_temp last)", async () => {
    const fns = await sql<{ prosecdef: boolean; proconfig: string[] | null; owner: string }[]>`
      select p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner
        from pg_proc p
       where p.proname = 'email_outbox_replace_older' and p.pronamespace = current_schema()::regnamespace`;
    expect(fns).toHaveLength(1);
    const fn = fns[0]!;
    // Definer: the tenant caller holds no UPDATE, so an invoker function could not supersede anything.
    expect(fn.prosecdef).toBe(true);
    // A definer function with no pinned search_path runs with the CALLER's, so a tenant that puts its own schema first
    // could shadow `email_outbox` (or a function the body calls) and have the owner's privileges run its code.
    const [schema] = await sql<{ s: string }[]>`select current_schema() as s`;
    expect(fn.proconfig, "search_path is set on the function").not.toBeNull();
    expect(fn.proconfig).toEqual([`search_path=${schema!.s}, pg_temp`]);
  });

  // ---- the table it replaces -------------------------------------------------------------------------------------

  it("email_queue is gone", async () => {
    expect((await sql`select to_regclass('email_queue') as t`)[0]!.t).toBeNull();
    // The pair: this connection does resolve unqualified names in the app schema, so the null above is not a wrong search_path.
    expect((await sql`select to_regclass('email_outbox') as t`)[0]!.t).not.toBeNull();
  });
});
