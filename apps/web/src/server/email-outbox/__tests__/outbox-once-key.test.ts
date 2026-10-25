// V472 (email outbox phase 3, wave 1): the once-key, the user-id replace rule, the five new kinds, and the cancel function.
// Spec: docs/superpowers/specs/2026-10-25-email-outbox-phase3-design.md (§5 the once-key, §6 the replace trigger, §7 the void).
//
// Claims that are not derivable from the DDL, and where each is pinned:
//  - the five wave-1 kinds pass the kind CHECK and a typo does not (typed from the spec's kind table, never read from constants.ts);
//  - a second insert of one (kind, dedupe_key) writes NOTHING and leaves the first row untouched. The insert is the one
//    `enqueueEmail` will issue: raw SQL, `on conflict do nothing` with NO target, because as `app_user` a conflict TARGET
//    needs SELECT and fails 42501 (plan P1). The supersede runs AFTER the insert (plan P2), so a row the conflict skipped
//    supersedes nothing: a replay of a once-key must never mark a newer resend `replaced`;
//  - the replace rule matches by `recipient_user_id` when BOTH rows carry one, and by `lower(recipient)` otherwise, always
//    inside one organisation;
//  - a target-less `on conflict do nothing` swallows EVERY unique violation, so the table may carry exactly the three
//    unique indexes it is meant to swallow (a fourth would be silently eaten);
//  - `email_outbox_cancel` ends only the CALLER'S ORG's `queued` rows of one kind, ref type and ref set, for a snake_case
//    reason, and is executable by `app_user` alone (no PUBLIC grant).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, withTenant } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";
const INVALID_PARAMETER_VALUE = "22023";

// Typed from the phase-3 spec's kind table, in its wave order: the five wave-1 kinds. Never read from constants.ts.
const WAVE1_KINDS = [
  "registration_confirmation", "payment_reminder", "registration_promoted", "refund_issued", "solo_signup_assigned",
];

type Outcome =
  | { accepted: true }
  | { accepted: false; code: string | undefined; constraint: string | undefined; message: string };

const attempt = (p: Promise<unknown>): Promise<Outcome> =>
  p.then(() => ({ accepted: true as const })).catch(
    (err: { code?: string; constraint_name?: string; message?: string }) => ({
      accepted: false as const, code: err.code, constraint: err.constraint_name, message: err.message ?? "",
    }),
  );

describe.skipIf(!HAS_DB)("email_outbox (V472: once-key, user-id replace, cancel)", () => {
  /** Every ref and address this run writes carries this, so teardown finds the org-less rows and the users. */
  const RUN = randomUUID().slice(0, 8);
  const BODY = Buffer.from("sealed-envelope-bytes");
  const AGED_MS = 3_600_000;
  let orgX = "";
  let orgY = "";
  const userIds: string[] = [];

  interface Seed {
    id?: string;
    kind?: string;
    refType?: string;
    ref?: string;
    org?: string | null;
    to?: string;
    status?: string;
    body?: Buffer | null;
    lease?: boolean;
    userId?: string | null;
    dedupeKey?: string | null;
    meta?: Record<string, unknown>;
    /** status_at one hour in the past, so a later write to it is visible. */
    aged?: boolean;
  }

  const newRef = (): string => `${RUN}-${randomUUID()}`;
  const addr = (tag: string): string => `${tag}-${randomUUID().slice(0, 8)}.${RUN}@x.test`;

  /**
   * The one INSERT this file uses, the shape `enqueueEmail` issues: `on conflict do nothing` with NO target, no RETURNING
   * (app_user holds no SELECT), a client-made id. `count` is the rows written: 0 means the once-key skipped it.
   */
  async function insertRow(x: typeof sql, s: Seed = {}): Promise<{ id: string; count: number }> {
    const id = s.id ?? randomUUID();
    const body = s.body === undefined ? BODY : s.body;
    const res = await x`
      insert into email_outbox
        (id, kind, ref_type, ref_id, org_id, recipient, subject, body_sealed, transactional,
         status, lease_until, expires_at, status_at, recipient_user_id, dedupe_key, meta)
      values
        (${id}, ${s.kind ?? "registration_confirmation"}, ${s.refType ?? "registration"}, ${s.ref ?? newRef()},
         ${s.org === undefined ? orgX : s.org}, ${s.to ?? addr("to")}, ${"subject"},
         ${body}, ${false},
         ${s.status ?? "queued"}, ${s.lease ? new Date(Date.now() + 60_000) : null},
         now() + interval '1 hour', ${s.aged ? new Date(Date.now() - AGED_MS) : new Date()},
         ${s.userId ?? null}, ${s.dedupeKey ?? null}, ${sql.json((s.meta ?? {}) as never)})
      on conflict do nothing`;
    return { id, count: res.count };
  }

  const row = (s: Seed = {}): Promise<{ id: string; count: number }> => insertRow(sql, s);
  /** A row that must have been written: the count is checked here so a later assertion never reads a row that is not there. */
  const mustRow = async (s: Seed = {}): Promise<string> => {
    const r = await row(s);
    expect(r.count, "the seed row was written").toBe(1);
    return r.id;
  };

  interface Stored {
    id: string;
    status: string;
    body_sealed: Buffer | null;
    lease_until: Date | null;
    status_at: Date;
    last_error: string | null;
  }
  const stored = async (ids: string[]): Promise<Map<string, Stored>> => {
    const rows = await sql<Stored[]>`
      select id, status, body_sealed, lease_until, status_at, last_error from email_outbox where id in ${sql(ids)}`;
    return new Map(rows.map((r) => [r.id, r]));
  };
  const statusOf = async (id: string): Promise<string | undefined> => (await stored([id])).get(id)?.status;
  /** The whole row as jsonb: a before/after comparison that cannot miss a column. */
  const snapshot = async (ids: string[]): Promise<Array<Record<string, unknown>>> =>
    (await sql<{ j: Record<string, unknown> }[]>`
      select to_jsonb(e) as j from email_outbox e where id in ${sql(ids)} order by id`).map((r) => r.j);

  const mkUser = async (tag: string): Promise<string> => {
    const [u] = await sql<{ id: string }[]>`
      insert into users (email, display_name) values (${addr(`user-${tag}`)}, ${`Outbox ${tag}`}) returning id`;
    userIds.push(u!.id);
    return u!.id;
  };

  beforeAll(async () => {
    const mk = async (tag: string): Promise<string> => {
      const [o] = await sql<{ id: string }[]>`
        insert into organizations (name, slug) values (${`Once ${tag}`}, ${`once-${tag}-${RUN}`}) returning id`;
      return o!.id;
    };
    orgX = await mk("x");
    orgY = await mk("y");
  });

  afterAll(async () => {
    await sql`delete from email_outbox where ref_id like ${`${RUN}-%`}`;
    if (userIds.length > 0) await sql`delete from users where id in ${sql(userIds)}`;
    await sql`delete from organizations where id in ${sql([orgX, orgY])}`;
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });

  // ---- the five new kinds -----------------------------------------------------------------------------------------

  it('kind CHECK accepts each wave-1 kind and refuses "registration_confirmations"', async () => {
    let accepted = 0;
    for (const kind of WAVE1_KINDS) {
      expect(await attempt(row({ kind })), kind).toEqual({ accepted: true });
      accepted++;
    }
    expect(accepted).toBe(5);
    expect(await attempt(row({ kind: "registration_confirmations" }))).toMatchObject({
      accepted: false, code: CHECK_VIOLATION, constraint: "email_outbox_kind_valid",
    });
  });

  // ---- the once-key -----------------------------------------------------------------------------------------------

  it("a duplicate once-key inserts nothing and leaves the original untouched", async () => {
    const k = `${RUN}-dup-${randomUUID()}`;
    const a = await row({ dedupeKey: k, ref: newRef(), to: addr("first") });
    expect(a.count, "the first row with the key is written").toBe(1);
    const before = await snapshot([a.id]);
    expect(before).toHaveLength(1);

    // A different ref and recipient on purpose: the KEY alone is what refuses it, not the replace rule.
    const second = await row({ dedupeKey: k, ref: newRef(), to: addr("second") });
    expect(second.count, "the duplicate wrote nothing").toBe(0);

    const after = (await stored([a.id])).get(a.id)!;
    expect(after.status).toBe("queued");
    expect(after.body_sealed, "the original keeps its sealed body").not.toBeNull();
    expect(await snapshot([a.id]), "the original is byte-identical").toEqual(before);
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from email_outbox where kind = 'registration_confirmation' and dedupe_key = ${k}`;
    expect(n!.n, "one row carries the key").toBe(1);
    expect((await stored([second.id])).size, "the duplicate's id is not in the table").toBe(0);
  });

  it("a once-key is per kind, and rows with no key never collide", async () => {
    const k = `${RUN}-perkind-${randomUUID()}`;
    expect((await row({ dedupeKey: k, kind: "registration_confirmation" })).count).toBe(1);
    // The same key under another kind is another once-key: the index is on (kind, dedupe_key).
    expect((await row({ dedupeKey: k, kind: "payment_reminder" })).count).toBe(1);
    expect((await row({ dedupeKey: k, kind: "payment_reminder" })).count, "but the same kind twice is one").toBe(0);
    // No key: the index is partial, so any number of keyless rows go in (and the empty case writes, it is not skipped).
    expect((await row({ dedupeKey: null })).count).toBe(1);
    expect((await row({ dedupeKey: null })).count).toBe(1);
  });

  it("a replay after a newer resend leaves the resend live", async () => {
    const k = `${RUN}-replay-${randomUUID()}`;
    const R = newRef();
    const TO = addr("replay");
    // A: the first send, with its once-key.
    const a = await mustRow({ ref: R, to: TO, dedupeKey: k });
    // Z: a person's resend of the same thing (same kind, ref, recipient), no key. It supersedes A.
    const z = await mustRow({ ref: R, to: TO });
    expect(await statusOf(a), "the resend superseded the first send").toBe("replaced");
    expect(await statusOf(z)).toBe("queued");

    // The replay (a webhook redelivered, a sweep that ran twice): the once-key is taken, so nothing is written AND
    // nothing is superseded. Were the supersede to run before the conflict, it would mark Z replaced, the insert would then be
    // skipped, and the person would be left with no live email at all.
    const replay = await row({ ref: R, to: TO, dedupeKey: k });
    expect(replay.count, "the replay wrote nothing").toBe(0);
    const after = await stored([a, z]);
    expect(after.get(z)!.status, "the resend is still live").toBe("queued");
    expect(after.get(z)!.body_sealed, "and still holds its body").not.toBeNull();
    expect(after.get(a)!.status, "the original stays replaced").toBe("replaced");
    const [live] = await sql<{ n: number }[]>`
      select count(*)::int as n from email_outbox
       where kind = 'registration_confirmation' and ref_id = ${R} and status = 'queued'`;
    expect(live!.n, "exactly one live row for the key's thing").toBe(1);
  });

  it("a dedupe_key of '' is refused, and a non-empty key and no key are both accepted", async () => {
    expect(await attempt(row({ dedupeKey: "" }))).toMatchObject({
      accepted: false, code: CHECK_VIOLATION, constraint: "email_outbox_dedupe_key_nonempty",
    });
    expect(await attempt(row({ dedupeKey: `${RUN}-nonempty-${randomUUID()}` }))).toEqual({ accepted: true });
    expect(await attempt(row({ dedupeKey: null }))).toEqual({ accepted: true });
  });

  // ---- the once-key, as the role that will write it ----------------------------------------------------------------
  // Everything above runs on the pooled superuser, which can infer a conflict target and bypasses RLS, so it cannot see P1.
  // `enqueueEmail` runs as app_user inside withTenant: INSERT only, no SELECT, the row's org fenced by the policy.

  it("as app_user inside withTenant: a keyed insert writes one row, the same key again writes none and does not throw, and another org's same key writes none", async () => {
    const k = `${RUN}-tenant-${randomUUID()}`;
    const asTenant = (org: string, s: Seed): Promise<{ id: string; count: number }> =>
      withTenant(org, (tx) => insertRow(tx as unknown as typeof sql, { ...s, org }));

    // A different ref and recipient on every call: the KEY alone decides.
    const first = await asTenant(orgX, { dedupeKey: k, to: addr("t1") });
    expect(first.count, "the first keyed insert is written").toBe(1);
    const again = await asTenant(orgX, { dedupeKey: k, to: addr("t2") });
    expect(again.count, "the same key from the same tenant writes nothing (and did not throw)").toBe(0);
    const foreign = await asTenant(orgY, { dedupeKey: k, to: addr("t3") });
    expect(foreign.count, "the same key from another tenant writes nothing (the key is global to the kind)").toBe(0);
    // The pair: orgY can write as app_user, so that 0 is the key and not a refused tenant.
    const other = await asTenant(orgY, { dedupeKey: `${k}-other`, to: addr("t4") });
    expect(other.count, "orgY's own, different key is written").toBe(1);

    const rows = await sql<{ id: string; org_id: string; status: string; has_body: boolean }[]>`
      select id, org_id, status, body_sealed is not null as has_body
        from email_outbox where kind = 'registration_confirmation' and dedupe_key = ${k}`;
    expect(rows).toEqual([{ id: first.id, org_id: orgX, status: "queued", has_body: true }]);
    expect((await stored([again.id, foreign.id])).size, "neither skipped id is in the table").toBe(0);
  });

  it("as app_user the TARGETED on-conflict form of the spec is refused (42501), and the same statement without a target is accepted", async () => {
    // The spec (§5) wrote `on conflict (kind, dedupe_key) where dedupe_key is not null do nothing`. Inferring that target needs
    // SELECT on the columns; app_user holds INSERT only. This test is what keeps the writer on the target-less form.
    const insertWith = (targeted: boolean, ref: string): Promise<unknown> =>
      withTenant(orgX, (tx) => {
        const x = tx as unknown as typeof sql;
        return x`
          insert into email_outbox (id, kind, ref_type, ref_id, org_id, recipient, subject, transactional, expires_at, dedupe_key)
          values (${randomUUID()}, 'registration_confirmation', 'registration', ${ref}, ${orgX}, ${addr("tg")}, 's', ${false},
                  now() + interval '1 hour', ${`${RUN}-targeted-${randomUUID()}`})
          ${targeted ? x`on conflict (kind, dedupe_key) where dedupe_key is not null do nothing` : x`on conflict do nothing`}`;
      });
    const refused = newRef();
    const out = await attempt(insertWith(true, refused));
    expect(out).toMatchObject({ accepted: false, code: INSUFFICIENT_PRIVILEGE });
    expect((out as { message: string }).message).toMatch(/permission denied|row-level security/);
    const [none] = await sql<{ n: number }[]>`select count(*)::int as n from email_outbox where ref_id = ${refused}`;
    expect(none!.n, "the refused statement wrote nothing").toBe(0);

    // The pair: the identical statement with the target-less clause goes in.
    const ok = newRef();
    expect(await attempt(insertWith(false, ok))).toEqual({ accepted: true });
    const [one] = await sql<{ n: number }[]>`select count(*)::int as n from email_outbox where ref_id = ${ok}`;
    expect(one!.n).toBe(1);
  });

  // ---- replace by user id -------------------------------------------------------------------------------------------

  it("replace by user id", async () => {
    const U = await mkUser("u");
    const W = await mkUser("w");

    // 1. Same kind, ref and user, two addresses: the account's address changed, so the newer row supersedes the older.
    const r1 = newRef();
    const old = await mustRow({ ref: r1, to: addr("old"), userId: U });
    expect(await statusOf(old)).toBe("queued");
    const fresh = await mustRow({ ref: r1, to: addr("new"), userId: U });
    expect(await statusOf(old), "same user, different address: replaced").toBe("replaced");
    expect(await statusOf(fresh)).toBe("queued");

    // 2. Two users at the SAME address (a shared mailbox): both carry a user id, so the user rule decides and neither replaces the other.
    const r2 = newRef();
    const SHARED = addr("shared");
    const u1 = await mustRow({ ref: r2, to: SHARED, userId: U });
    const w1 = await mustRow({ ref: r2, to: SHARED, userId: W });
    expect(await statusOf(u1), "different users, same address: stays queued").toBe("queued");
    expect(await statusOf(w1)).toBe("queued");

    // 3. A row with a user, then a row with NO user at the same address: the address rule applies, so the older is replaced.
    const r3 = newRef();
    const SAME = addr("same");
    const withUser = await mustRow({ ref: r3, to: SAME, userId: U });
    const noUser = await mustRow({ ref: r3, to: SAME.toUpperCase(), userId: null });
    expect(await statusOf(withUser), "user row then user-less row, same address: replaced").toBe("replaced");
    expect(await statusOf(noUser)).toBe("queued");

    // 3b. The mirror: a user-less row, then a row with a user, at the same address. Also the address rule.
    const r4 = newRef();
    const SAME2 = addr("same2");
    const bare = await mustRow({ ref: r4, to: SAME2, userId: null });
    const owned = await mustRow({ ref: r4, to: SAME2, userId: U });
    expect(await statusOf(bare), "user-less row then user row, same address: replaced").toBe("replaced");
    expect(await statusOf(owned)).toBe("queued");

    // 3c. The pair for 3 and 3b: a user row and a user-less row at DIFFERENT addresses share nothing, so neither replaces.
    const r5 = newRef();
    const x1 = await mustRow({ ref: r5, to: addr("p"), userId: U });
    const x2 = await mustRow({ ref: r5, to: addr("q"), userId: null });
    expect(await statusOf(x1), "user row, user-less row, different addresses: stays queued").toBe("queued");
    expect(await statusOf(x2)).toBe("queued");

    // 4. Another kind and another ref never match, whatever the user.
    const r6 = newRef();
    const k1 = await mustRow({ ref: r6, to: addr("k"), userId: U, kind: "payment_reminder" });
    await mustRow({ ref: r6, to: addr("k2"), userId: U, kind: "registration_confirmation" });
    await mustRow({ ref: newRef(), to: addr("k3"), userId: U, kind: "payment_reminder" });
    expect(await statusOf(k1), "same user, another kind or ref: untouched").toBe("queued");
  });

  it("the org fence still holds for the user-id rule", async () => {
    const U = await mkUser("fence");
    const R = newRef();
    const inX = await mustRow({ ref: R, to: addr("a"), userId: U, org: orgX });
    const inY = await mustRow({ ref: R, to: addr("b"), userId: U, org: orgY });
    expect(await statusOf(inX), "the other org's newer row for the same user and ref does not supersede").toBe("queued");
    expect(await statusOf(inY)).toBe("queued");
    // The pair, so the fence is the only thing standing between them: the same user and ref in orgX again does replace.
    const again = await mustRow({ ref: R, to: addr("c"), userId: U, org: orgX });
    expect(await statusOf(inX), "same org: replaced").toBe("replaced");
    expect(await statusOf(inY), "the other org's row is still untouched").toBe("queued");
    expect(await statusOf(again)).toBe("queued");
    expect((await stored([inY])).get(inY)!.body_sealed, "its credential survived").not.toBeNull();
  });

  it("recipient_user_id is set to null, not cascaded, when the user is deleted", async () => {
    const [u] = await sql<{ id: string }[]>`
      insert into users (email, display_name) values (${addr("gone")}, 'Gone') returning id`;
    const id = await mustRow({ userId: u!.id });
    await sql`delete from users where id = ${u!.id}`;
    const [r] = await sql<{ recipient_user_id: string | null }[]>`select recipient_user_id from email_outbox where id = ${id}`;
    expect(r, "the row survived the account").toBeDefined();
    expect(r!.recipient_user_id).toBeNull();
  });

  // ---- the catalogue ------------------------------------------------------------------------------------------------

  it("email_outbox's unique indexes are exactly the three the target-less on-conflict may swallow", async () => {
    const rows = await sql<{ name: string }[]>`
      select c.relname as name
        from pg_index i join pg_class c on c.oid = i.indexrelid
       where i.indrelid = 'email_outbox'::regclass and i.indisunique
       order by c.relname`;
    const names = rows.map((r) => r.name);
    expect(names).toEqual(["email_outbox_once_idx", "email_outbox_pkey", "email_outbox_provider_idx"]);
    // Anti-vacuity: the catalogue query found the three indexes; an empty answer would have failed the equality above.
    const checked = names.length;
    expect(checked).toBe(3);
  });

  const def = async (name: string): Promise<string> => {
    const [r] = await sql<{ d: string }[]>`select indexdef as d from pg_indexes where tablename = 'email_outbox' and indexname = ${name}`;
    expect(r, `index ${name} exists`).toBeDefined();
    return r!.d;
  };

  it("the once-key index and the user index are partial, on the columns the writer and the reader use", async () => {
    const once = await def("email_outbox_once_idx");
    expect(once).toMatch(/UNIQUE INDEX/);
    expect(once).toMatch(/\(kind, dedupe_key\)/);
    expect(once).toMatch(/WHERE \(dedupe_key IS NOT NULL\)/);
    const byUser = await def("email_outbox_recipient_user_idx");
    expect(byUser).not.toMatch(/UNIQUE/);
    expect(byUser).toMatch(/\(recipient_user_id\)/);
    expect(byUser).toMatch(/WHERE \(recipient_user_id IS NOT NULL\)/);
  });

  it("the legacy-invite index is partial on chess invites with no account, on the address EXACTLY (account-deletion.ts's address arm)", async () => {
    // Plan T5: the account-deletion sweep finds a pre-V472 chess invite by `kind = 'chess_invite' and recipient_user_id is null and
    // recipient = <the address exactly>`. No other index leads on `recipient`, so without this one the scrub reads the whole table.
    // The expression is `recipient`, NOT `lower(recipient)`: the statement does not fold case (FU2), so a folded index could not serve it.
    const legacy = await def("email_outbox_legacy_invite_idx");
    expect(legacy).not.toMatch(/UNIQUE/);
    expect(legacy).toMatch(/USING btree \(recipient\) WHERE/);
    expect(legacy).not.toMatch(/lower\(/);
    expect(legacy).toMatch(/kind = 'chess_invite'/);
    expect(legacy).toMatch(/recipient_user_id IS NULL/);
  });

  // ---- email_outbox_cancel -------------------------------------------------------------------------------------------

  describe("email_outbox_cancel", () => {
    const KIND = "payment_reminder";
    const REF_TYPE = "registration";

    interface Cancelled {
      outbox_id: string;
      outbox_kind: string;
      outbox_ref_type: string;
      outbox_ref_id: string;
      outbox_meta: Record<string, unknown>;
    }
    /** Run the function as app_user inside orgX's tenant transaction: the way a usecase calls it. */
    const cancelAsTenant = (org: string, refs: string[], reason: string, kind = KIND, refType = REF_TYPE): Promise<Cancelled[]> =>
      withTenant(org, (tx) =>
        (tx as unknown as typeof sql)<Cancelled[]>`
          select * from email_outbox_cancel(${kind}, ${refType}, ${refs}::text[], ${reason})`,
      ) as Promise<Cancelled[]>;

    it("ends only the caller's org's queued rows of the kind, ref type and refs, and reports them", async () => {
      const r1 = newRef();
      const r2 = newRef();
      const r3 = newRef();
      // orgX: two queued rows on two refs (the targets), plus a sending and a sent row on r1, which must not move.
      const q1 = await mustRow({ kind: KIND, ref: r1, org: orgX, to: addr("q1"), aged: true, meta: { n: 1 } });
      const q2 = await mustRow({ kind: KIND, ref: r2, org: orgX, to: addr("q2"), aged: true, meta: { n: 2 } });
      const sending = await mustRow({ kind: KIND, ref: r1, org: orgX, to: addr("sg"), status: "sending", lease: true, aged: true });
      const sent = await mustRow({ kind: KIND, ref: r1, org: orgX, to: addr("st"), status: "sent", body: null, aged: true });
      // orgY: queued rows on the SAME refs: the function is called in orgX's tenant and must not reach them.
      const y1 = await mustRow({ kind: KIND, ref: r1, org: orgY, to: addr("y1"), aged: true });
      const y2 = await mustRow({ kind: KIND, ref: r2, org: orgY, to: addr("y2"), aged: true });
      // Controls that differ in exactly one part: another kind, another ref type, a ref not in the list.
      const otherKind = await mustRow({ kind: "registration_confirmation", ref: r1, org: orgX, to: addr("ok"), aged: true });
      const otherType = await mustRow({ kind: KIND, refType: "refund", ref: r1, org: orgX, to: addr("ot"), aged: true });
      const otherRef = await mustRow({ kind: KIND, ref: r3, org: orgX, to: addr("or"), aged: true });

      const untouched = [sending, sent, y1, y2, otherKind, otherType, otherRef];
      const before = await snapshot(untouched);
      const queuedBefore = (await stored([q1, q2]));
      expect(queuedBefore.get(q1)!.body_sealed, "something to scrub").not.toBeNull();

      const out = await cancelAsTenant(orgX, [r1, r2], "round_voided");

      // Returns exactly orgX's two queued rows, with their kind, ref type, ref id and meta.
      expect(out.map((r) => r.outbox_id).sort()).toEqual([q1, q2].sort());
      for (const r of out) {
        expect(r.outbox_kind).toBe(KIND);
        expect(r.outbox_ref_type).toBe(REF_TYPE);
      }
      expect(out.find((r) => r.outbox_id === q1)).toMatchObject({ outbox_ref_id: r1, outbox_meta: { n: 1 } });
      expect(out.find((r) => r.outbox_id === q2)).toMatchObject({ outbox_ref_id: r2, outbox_meta: { n: 2 } });

      // Each ended `expired`, with the reason, no body and no lease, and status_at moved.
      const after = await stored([q1, q2]);
      let ended = 0;
      for (const id of [q1, q2]) {
        const r = after.get(id)!;
        expect(r.status).toBe("expired");
        expect(r.last_error).toBe("round_voided");
        expect(r.body_sealed, "the credential is scrubbed").toBeNull();
        expect(r.lease_until).toBeNull();
        expect(r.status_at.getTime(), "status_at moved").toBeGreaterThan(queuedBefore.get(id)!.status_at.getTime() + AGED_MS / 2);
        ended++;
      }
      expect(ended).toBe(2);

      // Everything else is byte-identical: the sending, the sent, orgY's, and the three controls.
      expect(untouched.length).toBe(7);
      expect(await snapshot(untouched)).toEqual(before);

      // A second call finds nothing queued: the cancel is idempotent and reports an empty set rather than the same rows.
      expect(await cancelAsTenant(orgX, [r1, r2], "round_voided")).toEqual([]);
    });

    it("frees the once-key of the row it ends, so a same-key re-enqueue is written; a row it does not end keeps its key", async () => {
      const k = `${RUN}-cancelled-${randomUUID()}`;
      const kSent = `${RUN}-sentkey-${randomUUID()}`;
      const r = newRef();
      const queued = await mustRow({ kind: KIND, ref: r, org: orgX, to: addr("ck"), dedupeKey: k, aged: true });
      const sent = await mustRow({ kind: KIND, ref: r, org: orgX, to: addr("cs"), dedupeKey: kSent, status: "sent", body: null, aged: true });
      // While the email is queued its key is taken.
      expect((await row({ kind: KIND, ref: newRef(), org: orgX, dedupeKey: k })).count, "the key is taken while queued").toBe(0);

      const out = await cancelAsTenant(orgX, [r], "round_voided");
      expect(out.map((o) => o.outbox_id), "only the queued row was ended").toEqual([queued]);
      const keys = await sql<{ id: string; dedupe_key: string | null }[]>`
        select id, dedupe_key from email_outbox where id in ${sql([queued, sent])}`;
      expect(Object.fromEntries(keys.map((x) => [x.id, x.dedupe_key])), "the ended row lost its key, the sent row kept its own").toEqual({
        [queued]: null, [sent]: kSent,
      });
      expect((await stored([queued])).get(queued)!.status).toBe("expired");

      // The point of it (spec §7, wave 3's email change cancels and re-sends): the same key now enqueues.
      const again = await row({ kind: KIND, ref: newRef(), org: orgX, dedupeKey: k });
      expect(again.count, "a cancelled email does not block its re-enqueue").toBe(1);
      // And the pair: the sent row's key is still taken.
      expect((await row({ kind: KIND, ref: newRef(), org: orgX, dedupeKey: kSent })).count, "a sent email's key is still taken").toBe(0);
    });

    it("an empty ref list returns no rows and touches nothing", async () => {
      const r = newRef();
      const q = await mustRow({ kind: KIND, ref: r, org: orgX, aged: true });
      const before = await snapshot([q]);
      expect(await cancelAsTenant(orgX, [], "round_voided")).toEqual([]);
      expect(await snapshot([q])).toEqual(before);
    });

    it("refuses a reason that is not a snake_case word (22023), and accepts the other cancel reason", async () => {
      const r = newRef();
      const q = await mustRow({ kind: KIND, ref: r, org: orgX, aged: true });
      const before = await snapshot([q]);
      const bad = ["Round Voided", "round-voided", "RoundVoided", "round_voided; drop table x", "", "_round", "round voided"];
      let refused = 0;
      for (const reason of bad) {
        const out = await attempt(cancelAsTenant(orgX, [r], reason));
        expect(out, `reason ${JSON.stringify(reason)}`).toMatchObject({ accepted: false, code: INVALID_PARAMETER_VALUE });
        refused++;
      }
      expect(refused).toBe(bad.length);
      // A null reason is refused too (the guard reads `is null` before the regex).
      expect(await attempt(withTenant(orgX, (tx) =>
        (tx as unknown as typeof sql)`select * from email_outbox_cancel(${KIND}, ${REF_TYPE}, ${[r]}::text[], ${null}::text)`,
      ))).toMatchObject({ accepted: false, code: INVALID_PARAMETER_VALUE });
      // Refused, not silently empty: the row is exactly as it was.
      expect(await snapshot([q])).toEqual(before);
      // The pair: a well-formed reason is accepted and ends the row.
      const out = await cancelAsTenant(orgX, [r], "board_settled");
      expect(out.map((o) => o.outbox_id)).toEqual([q]);
      expect((await stored([q])).get(q)!.last_error).toBe("board_settled");
    });

    it("called on the pool, with no tenant, it cancels only org-less rows", async () => {
      const r = newRef();
      const inOrg = await mustRow({ kind: KIND, ref: r, org: orgX, aged: true });
      const orgless = await mustRow({ kind: KIND, ref: r, org: null, aged: true, to: addr("nl") });
      const out = await sql<Cancelled[]>`select * from email_outbox_cancel(${KIND}, ${REF_TYPE}, ${[r]}::text[], 'round_voided')`;
      expect(out.map((o) => o.outbox_id)).toEqual([orgless]);
      expect(await statusOf(inOrg), "an org's row is out of reach of a call with no tenant").toBe("queued");
      expect(await statusOf(orgless)).toBe("expired");
    });

    it("is security definer with a pinned search_path, and executable by app_user alone (no PUBLIC grant)", async () => {
      const fns = await sql<{ prosecdef: boolean; proconfig: string[] | null; proacl: string[] | null }[]>`
        select p.prosecdef, p.proconfig, p.proacl::text[] as proacl
          from pg_proc p
         where p.proname = 'email_outbox_cancel' and p.pronamespace = current_schema()::regnamespace`;
      expect(fns).toHaveLength(1);
      const fn = fns[0]!;
      expect(fn.prosecdef).toBe(true);
      const [schema] = await sql<{ s: string }[]>`select current_schema() as s`;
      expect(fn.proconfig).toEqual([`search_path=${schema!.s}, pg_temp`]);
      // A function created with no REVOKE has a NULL ACL, which means "PUBLIC may execute". So the ACL must exist...
      expect(fn.proacl, "an explicit ACL (a NULL one is the PUBLIC default)").not.toBeNull();
      // ... and an aclitem with an empty grantee (it starts with "=") is the PUBLIC grant.
      const publicGrants = fn.proacl!.filter((a) => a.startsWith("="));
      expect(publicGrants, "no PUBLIC entry").toEqual([]);
      expect(fn.proacl!.length, "at least the owner and app_user are listed").toBeGreaterThanOrEqual(2);
      const [priv] = await sql<{ yes: boolean }[]>`
        select has_function_privilege('app_user', 'email_outbox_cancel(text, text, text[], text)'::regprocedure, 'execute') as yes`;
      expect(priv!.yes).toBe(true);
    });
  });
});
