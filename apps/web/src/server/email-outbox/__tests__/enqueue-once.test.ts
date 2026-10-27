// Outbox phase 3, wave 1, Task 2: what `enqueueEmail` / `enqueueEmailOnce` add on top of phase 1's writer.
// Spec: docs/superpowers/specs/2026-10-25-email-outbox-phase3-design.md (§5 the once-key, the Waves legend for the kind facts).
//
// Claims, and where each is pinned:
//  - the kind facts (who a kind is addressed to, its `transactional` flag) are the spec's legend. Typed here from the spec,
//    never read from the code under test;
//  - the facts guard is ONE-DIRECTIONAL: a literal-address kind that carries an account id is refused before any statement.
//    An account kind without an id and a mismatched `transactional` flag are NOT refused (31 phase-1 sites enqueue
//    `chess_invite` with no user id and 8 enqueue T kinds with `transactional: false` to reach the suppression gate);
//  - `enqueueEmailOnce` writes `recipient_user_id` and `dedupe_key`, returns the id, and returns null (never throws) for a
//    key that is already taken, leaving the original row untouched. The insert has NO conflict target (plan P1), proven as
//    `app_user` inside `withTenant`, the role the writer really runs as. A target needs SELECT, which app_user lacks;
//  - two transactions racing one key give one row and neither aborts (the controller's once-key race call, spec §5);
//  - an insert with no once-key that writes nothing throws, because the target-less `on conflict do nothing` would otherwise
//    swallow a primary-key collision and `enqueueEmail` would return the id of a row that was never written;
//  - the once-key index is GLOBAL across organisations (T1 re-review R-T1f), so a key must embed a globally unique id.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
import { OUTBOX_KIND_FACTS, type OutboxKind } from "../constants";
import {
  OutboxDedupeKeyError,
  OutboxInsertSkippedError,
  OutboxKindMismatchError,
  enqueueEmail,
  enqueueEmailOnce,
  type OutboxMessage,
} from "../enqueue";

// `enqueueEmail` takes its row id from `randomUUID`. The skipped-insert test needs that id to equal a row that already
// exists (a primary-key collision cannot be produced any other way: a real one has odds of 2^-122). The wrapper is a pure
// pass-through unless a test arms `forced.next`, which is used once and cleared; only the dedicated describe below arms it.
const forced = vi.hoisted(() => ({ next: null as string | null }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const randomUUID = (): `${string}-${string}-${string}-${string}-${string}` => {
    const f = forced.next;
    forced.next = null;
    return (f ?? actual.randomUUID()) as `${string}-${string}-${string}-${string}-${string}`;
  };
  return { ...actual, randomUUID, default: { ...actual, randomUUID } };
});

const HAS_DB = !!process.env.DATABASE_URL;

/** The spec's Waves legend, as [To, Tx]: A = account, L = literal address; Tx T = transactional, N = suppression applies.
 *  Typed from the spec's table (kinds in wave order) and never imported from constants.ts. */
const SPEC_LEGEND: Record<string, [to: "account" | "literal", transactional: boolean]> = {
  magic_link: ["literal", true],
  chess_invite: ["account", true],
  registration_confirmation: ["literal", false],
  payment_reminder: ["literal", false],
  registration_promoted: ["literal", false],
  refund_issued: ["literal", false],
  solo_signup_assigned: ["literal", false],
  registration_dispute_alert: ["account", false],
  registration_dispute_lost: ["account", false],
  sponsor_invoice: ["literal", false],
  sponsor_receipt: ["literal", false],
  sponsor_refund: ["literal", false],
  sponsor_dispute_alert: ["account", false],
  sponsor_dispute_won: ["account", false],
  sponsor_dispute_lost: ["account", false],
  pass_revoked: ["account", false],
  trial_ending: ["account", true],
  email_verification: ["literal", true],
  funnel_claim: ["literal", true],
  email_change_confirmation: ["literal", true],
  email_change_notice: ["literal", true],
  account_deletion: ["literal", true],
  org_invite: ["literal", false],
  claim_invite: ["literal", true],
  official_invite: ["literal", true],
  official_assigned: ["literal", true],
  official_assignment_changed: ["literal", true],
  suspension_confirmed: ["account", true],
  suspension_served: ["account", true],
  match_report_submitted: ["account", true],
  group_transfer_offer: ["account", false],
  group_transfer_complete: ["account", false],
  group_org_removed: ["account", false],
  group_org_left: ["account", false],
};

/** A `db` that records the statements it is handed and answers like postgres.js does for an insert: a row list carrying the
 *  count of rows written. `enqueueEmail` uses it as a tagged template and as `db.json`. */
function stubDb(count = 1) {
  const calls: unknown[][] = [];
  const db = Object.assign(
    async (...args: unknown[]) => {
      calls.push(args);
      return Object.assign([], { count });
    },
    { json: (v: unknown) => v },
  );
  return { db: db as never, calls };
}

/** `stubDb` with an arbitrary `count`, including the values `stubDb`'s default parameter would swallow (`undefined`) and the ones a
 *  broken driver could hand back (`NaN`, a negative). */
function stubDbRaw(count: unknown) {
  const calls: unknown[][] = [];
  const db = Object.assign(
    async (...args: unknown[]) => {
      calls.push(args);
      return Object.assign([], { count });
    },
    { json: (v: unknown) => v },
  );
  return { db: db as never, calls };
}

function msg(over: Partial<OutboxMessage> = {}): OutboxMessage {
  return {
    kind: "registration_confirmation",
    refType: "registration_group",
    refId: `ref-${randomUUID()}`,
    orgId: null,
    to: "someone-private@x.test",
    subject: "You are registered",
    html: "<a href='https://seazn.club/manage?token=SECRET-TOKEN'>Manage</a>",
    text: "Manage: https://seazn.club/manage?token=SECRET-TOKEN",
    transactional: false,
    expiresAt: new Date(Date.now() + 60 * 60_000),
    ...over,
  };
}

beforeEach(() => stubOutboxEnv());
afterEach(() => {
  forced.next = null;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the kind facts guard (no database)", () => {
  it("the kind facts are the spec's legend", () => {
    let checked = 0;
    for (const [kind, [to, transactional]] of Object.entries(SPEC_LEGEND)) {
      expect(OUTBOX_KIND_FACTS[kind as OutboxKind], kind).toEqual({ to, transactional });
      checked++;
    }
    expect(checked, "every kind of the legend was compared").toBe(34);
    // The other direction: the code declares no kind the legend does not.
    expect(Object.keys(OUTBOX_KIND_FACTS).sort()).toEqual(Object.keys(SPEC_LEGEND).sort());
  });

  it("a literal kind with recipientUserId is refused by name before any statement, for EVERY literal kind", async () => {
    let checked = 0;
    for (const [kind, [to]] of Object.entries(SPEC_LEGEND)) {
      if (to !== "literal") continue;
      for (const call of [enqueueEmail, (db: never, m: OutboxMessage) => enqueueEmailOnce(db, { ...m, dedupeKey: `${randomUUID()}:k` })]) {
        const { db, calls } = stubDb();
        const err = (await call(db, msg({ kind: kind as OutboxKind, recipientUserId: randomUUID() })).catch((e: unknown) => e)) as OutboxKindMismatchError;
        expect(err, kind).toBeInstanceOf(OutboxKindMismatchError);
        expect(err.name).toBe("OutboxKindMismatchError");
        expect(err.code).toBe("EMAIL_OUTBOX_KIND_MISMATCH");
        expect(calls, `${kind}: a refusal issues no statement`).toHaveLength(0);
        checked++;
      }
    }
    expect(checked, "19 literal kinds (magic_link, the five wave-1 kinds, wave 2's three sponsor mails, wave 3's eight and wave 4's two official notices) x 2 writers").toBe(38);
  });

  it("the refusal names the kind and ref type and carries neither the address, the user id nor the body", async () => {
    const userId = randomUUID();
    const err = (await enqueueEmail(stubDb().db, msg({ refType: "registration_group", recipientUserId: userId })).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(OutboxKindMismatchError);
    expect(err.message).toContain("registration_confirmation");
    expect(err.message).toContain("registration_group");
    for (const secret of ["someone-private@x.test", userId, "SECRET-TOKEN"]) expect(err.message, secret).not.toContain(secret);
  });

  it("the guard is one-directional: an account kind with no id, an account kind with an id, a literal kind with no id, and a mismatched transactional flag all go through (positive pairs)", async () => {
    const cases: Array<[string, Partial<OutboxMessage>]> = [
      ["account kind, no user id (31 phase-1 sites)", { kind: "chess_invite", refType: "fixture_seat", transactional: true }],
      ["account kind, with a user id", { kind: "chess_invite", refType: "fixture_seat", transactional: true, recipientUserId: randomUUID() }],
      ["literal kind, no user id", { kind: "registration_confirmation" }],
      ["T kind sent with transactional: false (8 phase-1 sites)", { kind: "magic_link", refType: "login", transactional: false }],
      ["N kind sent with transactional: true", { kind: "registration_confirmation", transactional: true }],
    ];
    for (const [label, over] of cases) {
      const { db, calls } = stubDb();
      await expect(enqueueEmail(db, msg(over)), label).resolves.toMatch(/^[0-9a-f-]{36}$/);
      expect(calls, label).toHaveLength(1);
    }
  });

  it("a refusal is not sticky: the next valid enqueue on the same handle goes through (sequence)", async () => {
    const { db, calls } = stubDb();
    await expect(enqueueEmail(db, msg({ recipientUserId: randomUUID() }))).rejects.toBeInstanceOf(OutboxKindMismatchError);
    await expect(enqueueEmail(db, msg())).resolves.toMatch(/^[0-9a-f-]{36}$/);
    expect(calls).toHaveLength(1);
  });
});

describe("the writer's insert (no database)", () => {
  it("enqueueEmail throws OutboxInsertSkippedError when the insert wrote nothing and no once-key explains it", async () => {
    const { db } = stubDb(0);
    const err = (await enqueueEmail(db, msg()).catch((e: unknown) => e)) as OutboxInsertSkippedError;
    expect(err).toBeInstanceOf(OutboxInsertSkippedError);
    expect(err.name).toBe("OutboxInsertSkippedError");
    expect(err.code).toBe("EMAIL_OUTBOX_INSERT_SKIPPED");
    expect(err.message).toContain("registration_confirmation");
    expect(err.message).toContain("registration_group");
    for (const secret of ["someone-private@x.test", "SECRET-TOKEN"]) expect(err.message, secret).not.toContain(secret);
  });

  it("enqueueEmailOnce maps the same 0 to null, and 1 to the id (the pair)", async () => {
    await expect(enqueueEmailOnce(stubDb(0).db, { ...msg(), dedupeKey: "k-1" })).resolves.toBeNull();
    await expect(enqueueEmailOnce(stubDb(1).db, { ...msg(), dedupeKey: "k-1" })).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  // T2 review m3: "wrote nothing" is `!(written >= 1)`, not `written === 0`. A count that is not a number (a driver that returned no
  // `count`, `NaN`) is not evidence of a row, and a skipped insert reported as written hands the caller the id of a row that
  // does not exist.
  it("a count that is not at least 1 is a skipped insert, whatever it is (0, undefined, NaN, negative)", async () => {
    let checked = 0;
    for (const count of [0, undefined, Number.NaN, -1]) {
      const err = (await enqueueEmail(stubDbRaw(count).db, msg()).catch((e: unknown) => e)) as Error;
      expect(err, `enqueueEmail, count ${String(count)}`).toBeInstanceOf(OutboxInsertSkippedError);
      await expect(enqueueEmailOnce(stubDbRaw(count).db, { ...msg(), dedupeKey: "k-m3" }), `enqueueEmailOnce, count ${String(count)}`).resolves.toBeNull();
      checked++;
    }
    expect(checked, "four unusable counts, two writers each").toBe(4);
    // The positive pair: one written row is an id, from both writers.
    await expect(enqueueEmail(stubDbRaw(1).db, msg())).resolves.toMatch(/^[0-9a-f-]{36}$/);
    await expect(enqueueEmailOnce(stubDbRaw(1).db, { ...msg(), dedupeKey: "k-m3" })).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  // T2 review m2: a blank once-key is refused by name BEFORE the statement. The table's CHECK (`dedupe_key <> ''`) already refuses an
  // empty one, but as a 23514 that aborts the caller's transaction, and it lets a whitespace-only key through to occupy the
  // kind's key space as a single shared "blank" key that would silence every later email of the kind.
  it("an empty or whitespace-only once-key is refused by name before any statement", async () => {
    let checked = 0;
    for (const dedupeKey of ["", " ", "   ", "\t", "\n", " \t\n "]) {
      const { db, calls } = stubDb();
      const err = (await enqueueEmailOnce(db, { ...msg(), dedupeKey }).catch((e: unknown) => e)) as OutboxDedupeKeyError;
      expect(err, JSON.stringify(dedupeKey)).toBeInstanceOf(OutboxDedupeKeyError);
      expect(err.name).toBe("OutboxDedupeKeyError");
      expect(err.code).toBe("EMAIL_OUTBOX_BAD_DEDUPE_KEY");
      expect(err.message).toContain("registration_confirmation");
      expect(err.message).toContain("registration_group");
      for (const secret of ["someone-private@x.test", "SECRET-TOKEN"]) expect(err.message, secret).not.toContain(secret);
      expect(calls, `${JSON.stringify(dedupeKey)}: a refusal issues no statement`).toHaveLength(0);
      checked++;
    }
    expect(checked, "six blank keys").toBe(6);
  });

  it("a key that merely contains whitespace is a key (positive pair), and a refusal is not sticky (sequence)", async () => {
    const { db, calls } = stubDb();
    await expect(enqueueEmailOnce(db, { ...msg(), dedupeKey: " " })).rejects.toBeInstanceOf(OutboxDedupeKeyError);
    expect(calls).toHaveLength(0);
    await expect(enqueueEmailOnce(db, { ...msg(), dedupeKey: "reg 1:submit" })).resolves.toMatch(/^[0-9a-f-]{36}$/);
    await expect(enqueueEmailOnce(db, { ...msg(), dedupeKey: " k " })).resolves.toMatch(/^[0-9a-f-]{36}$/);
    expect(calls, "the two valid keys issued one statement each").toHaveLength(2);
  });

  it("a key that is not a string at all (a caller that cast around the type) is refused by name too, not left to the driver", async () => {
    for (const dedupeKey of [undefined, null, 42]) {
      const { db, calls } = stubDb();
      const err = await enqueueEmailOnce(db, { ...msg(), dedupeKey: dedupeKey as never }).catch((e: unknown) => e);
      expect(err, String(dedupeKey)).toBeInstanceOf(OutboxDedupeKeyError);
      expect(calls).toHaveLength(0);
    }
  });

  it("both writers issue exactly one statement, and a refused expiry or key issues none (the guards run before the statement)", async () => {
    const once = stubDb();
    await enqueueEmailOnce(once.db, { ...msg(), dedupeKey: "k-2" });
    expect(once.calls).toHaveLength(1);
    const plain = stubDb();
    await enqueueEmail(plain.db, msg());
    expect(plain.calls).toHaveLength(1);

    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_OUTBOX_KEK", "");
    const refused = stubDb();
    await expect(enqueueEmailOnce(refused.db, { ...msg(), dedupeKey: "k-3" })).rejects.toMatchObject({ code: "EMAIL_OUTBOX_KEK_MISSING" });
    expect(refused.calls, "an unusable key refuses before the statement").toHaveLength(0);
  });
});

describe.skipIf(!HAS_DB)("enqueueEmail / enqueueEmailOnce against the database", () => {
  /** Every ref, key and address this run writes carries this, so teardown finds the org-less rows and the users. */
  const RUN = randomUUID().slice(0, 8);
  let orgX = "";
  let orgY = "";
  const userIds: string[] = [];

  const newRef = (): string => `${RUN}-${randomUUID()}`;
  /** A globally unique once-key, the way every real call site builds one. */
  const newKey = (suffix = "submit"): string => `${RUN}-${randomUUID()}:${suffix}`;
  const addr = (tag: string): string => `${tag}-${randomUUID().slice(0, 8)}.${RUN}@x.test`;
  const row = (over: Partial<OutboxMessage> = {}): OutboxMessage => msg({ refId: newRef(), to: addr("to"), orgId: orgX, ...over });

  const mkUser = async (tag: string): Promise<string> => {
    const [u] = await sql<{ id: string }[]>`
      insert into users (email, display_name) values (${addr(`user-${tag}`)}, ${`Outbox ${tag}`}) returning id`;
    userIds.push(u!.id);
    return u!.id;
  };

  interface Stored {
    id: string;
    kind: string;
    status: string;
    org_id: string | null;
    recipient: string;
    recipient_user_id: string | null;
    dedupe_key: string | null;
    has_body: boolean;
    attempts: number;
  }
  // A function, not a constant: building the fragment touches the pooled client, which a no-database run must never do at collection.
  const cols = () => sql`id, kind, status, org_id, recipient, recipient_user_id, dedupe_key, body_sealed is not null as has_body, attempts`;
  const byKey = (kind: string, key: string): Promise<Stored[]> =>
    sql<Stored[]>`select ${cols()} from email_outbox where kind = ${kind} and dedupe_key = ${key} order by created_at, id`;
  const byRef = (ref: string): Promise<Stored[]> =>
    sql<Stored[]>`select ${cols()} from email_outbox where ref_id = ${ref} order by created_at, id`;
  const byId = (id: string): Promise<Stored[]> => sql<Stored[]>`select ${cols()} from email_outbox where id = ${id}`;
  /** The whole row as jsonb: a before/after comparison that cannot miss a column. */
  const snapshot = async (id: string): Promise<Record<string, unknown>> =>
    (await sql<{ j: Record<string, unknown> }[]>`select to_jsonb(e) as j from email_outbox e where id = ${id}`)[0]!.j;

  beforeAll(async () => {
    const mk = async (tag: string): Promise<string> => {
      const [o] = await sql<{ id: string }[]>`
        insert into organizations (name, slug) values (${`Enqueue ${tag}`}, ${`enq-${tag}-${RUN}`}) returning id`;
      return o!.id;
    };
    orgX = await mk("x");
    orgY = await mk("y");
  });

  afterAll(async () => {
    await sql`delete from email_outbox where ref_id like ${`${RUN}-%`} or dedupe_key like ${`${RUN}-%`}`;
    if (userIds.length > 0) await sql`delete from users where id in ${sql(userIds)}`;
    await sql`delete from organizations where id in ${sql([orgX, orgY])}`;
  });

  it("a literal kind with recipientUserId is refused and the row count is unchanged; the same call without the id is written (pair)", async () => {
    const userId = await mkUser("lit");
    const ref = newRef();
    const [before] = await sql<{ n: number }[]>`select count(*)::int as n from email_outbox where org_id = ${orgX}`;
    await expect(enqueueEmail(sql, row({ refId: ref, recipientUserId: userId }))).rejects.toBeInstanceOf(OutboxKindMismatchError);
    const [after] = await sql<{ n: number }[]>`select count(*)::int as n from email_outbox where org_id = ${orgX}`;
    expect(after!.n, "a refusal wrote nothing").toBe(before!.n);
    expect(await byRef(ref)).toHaveLength(0);

    const id = await enqueueEmail(sql, row({ refId: ref }));
    expect((await byRef(ref)).map((r) => r.id)).toEqual([id]);
  });

  it("enqueueEmailOnce writes recipient_user_id and dedupe_key and returns the id", async () => {
    const userId = await mkUser("once");
    const key = newKey();
    const m = row({ kind: "chess_invite", refType: "fixture_seat", transactional: true, recipientUserId: userId });
    const id = await enqueueEmailOnce(sql, { ...m, dedupeKey: key });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await byKey("chess_invite", key)).toEqual([
      {
        id,
        kind: "chess_invite",
        status: "queued",
        org_id: orgX,
        recipient: m.to,
        recipient_user_id: userId,
        dedupe_key: key,
        has_body: true,
        attempts: 0,
      },
    ]);
  });

  it("a blank once-key refused inside a transaction does not abort it (the table CHECK would): the next statement on the same handle works", async () => {
    // Without the writer's own refusal the statement runs and the CHECK `dedupe_key <> ''` raises 23514, which leaves the caller's
    // transaction aborted ("current transaction is aborted, commands ignored") for everything after it.
    const ref = newRef();
    const outcome = await sql.begin(async (tx) => {
      const refused = await enqueueEmailOnce(tx, { ...row({ refId: ref }), dedupeKey: "" }).catch((e: unknown) => e);
      const stillUsable = await tx`select 1 as ok`;
      return { refused, ok: stillUsable[0]!.ok };
    });
    expect(outcome.refused).toBeInstanceOf(OutboxDedupeKeyError);
    expect(outcome.ok, "the transaction is still usable").toBe(1);
    expect(await byRef(ref), "nothing was written").toHaveLength(0);
  });

  it("enqueueEmail (no once-key) writes a null recipient_user_id and a null dedupe_key, and the user id when it is given", async () => {
    const userId = await mkUser("plain");
    const lit = row();
    const acct = row({ kind: "chess_invite", refType: "fixture_seat", transactional: true, recipientUserId: userId });
    const litId = await enqueueEmail(sql, lit);
    const acctId = await enqueueEmail(sql, acct);
    const [l] = await byRef(lit.refId);
    const [a] = await byRef(acct.refId);
    expect(l).toMatchObject({ id: litId, recipient_user_id: null, dedupe_key: null });
    expect(a).toMatchObject({ id: acctId, recipient_user_id: userId, dedupe_key: null });
  });

  it("enqueueEmailOnce returns null on a duplicate, does not throw, and the original row is untouched", async () => {
    const key = newKey();
    const first = row({ subject: "first" });
    const id = await enqueueEmailOnce(sql, { ...first, dedupeKey: key });
    expect(id).not.toBeNull();
    const before = await snapshot(id!);

    // A different ref, recipient, subject and body: only the KEY can be what stops it.
    const again = row({ subject: "second", html: "<p>other</p>", text: "other" });
    expect(await enqueueEmailOnce(sql, { ...again, dedupeKey: key })).toBeNull();

    expect(await byKey("registration_confirmation", key)).toHaveLength(1);
    expect(await snapshot(id!), "the first row is byte-for-byte what it was").toEqual(before);
    expect(await byRef(again.refId), "the duplicate wrote no row under its own ref either").toHaveLength(0);
  });

  it("sequence: a duplicate returns null and the very next enqueue on the same handle still works (the transaction is not aborted)", async () => {
    const key = newKey();
    const second = row();
    const third = row();
    await enqueueEmailOnce(sql, { ...row(), dedupeKey: key });
    const out = await sql.begin(async (tx) => {
      const dup = await enqueueEmailOnce(tx, { ...second, dedupeKey: key });
      const next = await enqueueEmail(tx, third);
      return { dup, next };
    });
    expect(out.dup).toBeNull();
    expect((await byRef(third.refId)).map((r) => r.id), "the statement after the skipped insert committed").toEqual([out.next]);
    expect(await byRef(second.refId)).toHaveLength(0);
  });

  it("two concurrent enqueueEmailOnce with one key: one row, neither transaction aborts, the original untouched", async () => {
    const key = newKey();
    const a = row({ subject: "from A" });
    const b = row({ subject: "from B" });

    let releaseA!: () => void;
    const aMayCommit = new Promise<void>((r) => (releaseA = r));
    let aWrote!: (id: string | null) => void;
    const aWroteP = new Promise<string | null>((r) => (aWrote = r));
    let bPid!: (pid: number) => void;
    const bPidP = new Promise<number>((r) => (bPid = r));

    // Tx A writes the key and holds its transaction open, so the key is taken but not yet visible to anyone else.
    const txA = sql.begin(async (tx) => {
      const id = await enqueueEmailOnce(tx, { ...a, dedupeKey: key });
      aWrote(id);
      await aMayCommit;
      return id;
    });
    void txA.catch(() => aWrote(null)); // a failed A must not leave the test waiting for its first write
    let bSettled = false;
    let txB: Promise<{ result: string | null; next: number }> | undefined;
    try {
      const aId = await aWroteP;
      expect(aId, "A won the key").not.toBeNull();

      // Tx B races the same key. It must wait on A's uncommitted insert, not fail and not finish.
      txB = sql.begin(async (tx) => {
        bPid((await tx<{ pid: number }[]>`select pg_backend_pid() as pid`)[0]!.pid);
        const result = await enqueueEmailOnce(tx, { ...b, dedupeKey: key });
        bSettled = true;
        // The statement after the skipped insert: an aborted transaction (23505) would refuse this one.
        const next = (await tx<{ one: number }[]>`select 1 as one`)[0]!.one;
        return { result, next };
      });
      const pid = await bPidP;

      let waitEvent: string | null = null;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const [w] = await sql<{ wait_event_type: string | null }[]>`select wait_event_type from pg_stat_activity where pid = ${pid}`;
        waitEvent = w?.wait_event_type ?? null;
        if (waitEvent === "Lock") break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(waitEvent, "B is waiting on A's lock: the race is real, not two sequential inserts").toBe("Lock");
      expect(bSettled, "B has not finished while A is open").toBe(false);
    } finally {
      releaseA();
    }
    const aCommitted = await txA;
    const out = await txB!;
    expect(out.result, "the loser learns it was skipped").toBeNull();
    expect(out.next, "the loser's transaction is still usable").toBe(1);

    const rows = await byKey("registration_confirmation", key);
    expect(rows, "exactly one row").toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "queued", attempts: 0, has_body: true });
    expect(await byRef(b.refId), "B wrote nothing under its own ref").toHaveLength(0);
    expect(rows[0]!.id, "the row is A's").toBe(aCommitted);
    expect((await byRef(a.refId)).map((r) => r.id)).toEqual([aCommitted]);
  }, 30_000);

  // ---- the writer as the role it runs as ------------------------------------------------------------------------------
  // Everything above runs on the pooled superuser, which can infer a conflict target and bypasses RLS, so it cannot see P1.
  // `enqueueEmail` runs as app_user inside withTenant: INSERT only, no SELECT, the row's org fenced by the policy.

  it("as app_user inside withTenant: enqueueEmail writes the row in the tenant's org, and enqueueEmailOnce writes once and then returns null without throwing", async () => {
    const plain = row();
    const plainId = await withTenant(orgX, (tx) => enqueueEmail(tx, plain));
    expect(await byRef(plain.refId)).toMatchObject([{ id: plainId, org_id: orgX, status: "queued", has_body: true }]);

    const key = newKey();
    const first = row({ subject: "tenant first" });
    const second = row({ subject: "tenant second" });
    const id = await withTenant(orgX, (tx) => enqueueEmailOnce(tx, { ...first, dedupeKey: key }));
    expect(id, "app_user can write the keyed row (a targeted on-conflict would be refused 42501)").toMatch(/^[0-9a-f-]{36}$/);
    const dup = await withTenant(orgX, (tx) => enqueueEmailOnce(tx, { ...second, dedupeKey: key }));
    expect(dup, "the same key again is skipped, not thrown").toBeNull();
    expect(await byKey("registration_confirmation", key)).toMatchObject([{ id, org_id: orgX, dedupe_key: key }]);
    expect(await byRef(second.refId)).toHaveLength(0);
  });

  it("as app_user: a duplicate then another enqueue in ONE tenant transaction both behave, and the transaction commits (sequence)", async () => {
    const key = newKey();
    await withTenant(orgX, (tx) => enqueueEmailOnce(tx, { ...row(), dedupeKey: key }));
    const dupRow = row();
    const nextRow = row();
    const out = await withTenant(orgX, async (tx) => ({
      dup: await enqueueEmailOnce(tx, { ...dupRow, dedupeKey: key }),
      next: await enqueueEmail(tx, nextRow),
    }));
    expect(out.dup).toBeNull();
    expect((await byRef(nextRow.refId)).map((r) => r.id)).toEqual([out.next]);
  });

  // ---- the key is global ----------------------------------------------------------------------------------------------

  it("the once-key is global across organisations: two orgs with different ids never collide, and the same key from another org is skipped", async () => {
    const regA = randomUUID();
    const regB = randomUUID();
    const keyA = `${RUN}-${regA}:submit`;
    const keyB = `${RUN}-${regB}:submit`;
    // Different ids -> different keys -> both written, one in each tenant.
    const idA = await withTenant(orgX, (tx) => enqueueEmailOnce(tx, { ...row({ orgId: orgX }), dedupeKey: keyA }));
    const idB = await withTenant(orgY, (tx) => enqueueEmailOnce(tx, { ...row({ orgId: orgY }), dedupeKey: keyB }));
    expect(idA).not.toBeNull();
    expect(idB).not.toBeNull();
    expect(await byKey("registration_confirmation", keyA)).toMatchObject([{ id: idA, org_id: orgX }]);
    expect(await byKey("registration_confirmation", keyB)).toMatchObject([{ id: idB, org_id: orgY }]);

    // The same key from the other org: the index is not per-org, which is why a key must embed a globally unique id.
    const foreign = row({ orgId: orgY });
    expect(await withTenant(orgY, (tx) => enqueueEmailOnce(tx, { ...foreign, dedupeKey: keyA }))).toBeNull();
    expect(await byRef(foreign.refId)).toHaveLength(0);
    expect(await byKey("registration_confirmation", keyA)).toMatchObject([{ id: idA, org_id: orgX }]);
  });

  it("after the row is withdrawn through email_outbox_cancel, the same key can be queued again (sequence)", async () => {
    const key = newKey();
    const ref = newRef();
    const first = await withTenant(orgX, (tx) => enqueueEmailOnce(tx, { ...row({ kind: "payment_reminder", refType: "registration", refId: ref }), dedupeKey: key }));
    expect(first).not.toBeNull();
    // While queued the key holds.
    expect(await withTenant(orgX, (tx) => enqueueEmailOnce(tx, { ...row({ kind: "payment_reminder", refType: "registration" }), dedupeKey: key }))).toBeNull();

    await withTenant(orgX, (tx) => tx`select * from email_outbox_cancel('payment_reminder', 'registration', ${[ref]}::text[], 'round_voided')`);
    const again = await withTenant(orgX, (tx) => enqueueEmailOnce(tx, { ...row({ kind: "payment_reminder", refType: "registration" }), dedupeKey: key }));
    expect(again, "the cancel freed the key").not.toBeNull();
    const rows = await byKey("payment_reminder", key);
    expect(rows.map((r) => r.id)).toEqual([again]);
    expect((await byId(first!))[0]).toMatchObject({ status: "expired", dedupe_key: null });
  });
});

// The only describe that arms the randomUUID wrapper above.
describe.skipIf(!HAS_DB)("an insert that writes nothing and has no once-key to explain it", () => {
  const RUN = randomUUID().slice(0, 8);

  afterAll(async () => {
    await sql`delete from email_outbox where ref_id like ${`${RUN}-%`}`;
  });

  it("throws OutboxInsertSkippedError instead of returning the id of a row that was never written", async () => {
    const original = msg({ refId: `${RUN}-original`, to: `orig-${RUN}@x.test`, subject: "the original" });
    const takenId = await enqueueEmail(sql, original);
    const [before] = await sql<{ j: Record<string, unknown> }[]>`select to_jsonb(e) as j from email_outbox e where id = ${takenId}`;

    // The writer is handed an id that is already a primary key: `on conflict do nothing` swallows the collision.
    const collider = msg({ refId: `${RUN}-collider`, to: `coll-${RUN}@x.test`, subject: "the collider" });
    forced.next = takenId;
    const err = (await enqueueEmail(sql, collider).catch((e: unknown) => e)) as OutboxInsertSkippedError;
    expect(forced.next, "the wrapper handed the writer the colliding id").toBeNull();
    expect(err).toBeInstanceOf(OutboxInsertSkippedError);
    expect(err.message).toContain("registration_confirmation");
    for (const secret of [collider.to, original.to, "SECRET-TOKEN"]) expect(err.message, secret).not.toContain(secret);

    const [after] = await sql<{ j: Record<string, unknown> }[]>`select to_jsonb(e) as j from email_outbox e where id = ${takenId}`;
    expect(after!.j, "the existing row was not touched").toEqual(before!.j);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from email_outbox where ref_id = ${collider.refId}`;
    expect(n!.n, "nothing was written for the collider").toBe(0);

    // The pair: the next call gets a fresh id and is written.
    await expect(enqueueEmail(sql, collider)).resolves.toMatch(/^[0-9a-f-]{36}$/);
    const [m] = await sql<{ n: number }[]>`select count(*)::int as n from email_outbox where ref_id = ${collider.refId}`;
    expect(m!.n).toBe(1);
  });
});
