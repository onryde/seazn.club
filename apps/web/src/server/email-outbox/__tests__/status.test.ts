// Task 8: `latestEmailStatus` (what the arbiter's phase-2 column will read) and `purgeOldEmails` (the 90-day retention), against a
// real Postgres. Spec: docs/superpowers/specs/2026-10-19-email-outbox-design.md; controller rulings T8-R1 (the read runs on the
// privileged connection and takes an explicit org) and the retention ruling (any row older than RETENTION_DAYS is fair game,
// whatever its status).
//
// What is pinned, and by which test:
//  - the answer is ONE row per (ref, recipient case-folded): the newest by `created_at`, never a `replaced` row (the V470 trigger
//    supersedes by KEY, not by clock, so a replaced row can be the newest on the clock);
//  - the ordering is the real sort key: the newer row holds the SMALLER id and the OLDER `status_at`, so neither `id` nor
//    `status_at` can stand in for `created_at`, and a tie on `created_at` falls to `id`;
//  - a resend after a dead row reads as the new row, not the dead one;
//  - another organisation's row with the same ref and recipient is never returned (T8-R1, defence in depth: the phase-2 caller is a
//    tenant page), nor an org-less row, nor a row of another ref type;
//  - the purge removes every status past the retention and keeps a row a day younger, never more than PURGE_BATCH in a call, oldest
//    first, and the unscoped (production) call is exercised in a transaction that is rolled back, so it cannot touch another test
//    file's rows in the shared database.
//
// The history is written with `session_replication_role = replica` (superuser; local and CI `postgres` both are): in production a
// row reaches `sent` or `replaced` by an UPDATE after its insert, and a plain insert of each would have the next insert supersede
// the last. The act under test is always a read, or (for the resend) an ordinary insert with the trigger live.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, statementCount } from "@/lib/db";
import { OUTBOX_STATUSES, PURGE_BATCH, RETENTION_DAYS, type OutboxKind, type OutboxStatus } from "../constants";
import { latestEmailStatus, purgeOldEmails, type EmailStatusRow } from "../status";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `t8s-${randomUUID().slice(0, 8)}`;
const MIN = 60_000;
const DAY = 24 * 3_600_000;
/** RETENTION_DAYS of 24 h in seconds, written from the constant (not read back from the purge's own copy). */
const RETENTION_SECS = RETENTION_DAYS * 24 * 3600;
const REF_TYPE = "fixture_seat";
/** The ids below are chosen for their ORDER, so they share a per-run prefix: the order between two of them is the order of their
 *  tails, and an aborted earlier run cannot collide with this one on the primary key. */
const ID_PREFIX = randomUUID().slice(0, 8);
const idTail = (tail: string): string => `${ID_PREFIX}-${tail}`;

/** Whole seconds, so a Date survives the round trip through timestamptz exactly. */
const NOW = Math.floor(Date.now() / 1000) * 1000;
const minutesAgo = (m: number): Date => new Date(NOW - m * MIN);

// No database: an empty id list is answered without a statement. With no DATABASE_URL a stray statement would THROW, and with one
// the counter pins it, so the test means the same in both modes.
describe("latestEmailStatus with nothing to ask about (no statement)", () => {
  it("empty refIds answers [] and issues no statement", async () => {
    const before = statementCount();
    expect(await latestEmailStatus(randomUUID(), REF_TYPE, [])).toEqual([]);
    expect(statementCount() - before).toBe(0);
  });
});

describe.skipIf(!HAS_DB)("latestEmailStatus and purgeOldEmails (V470 email_outbox)", () => {
  let orgA = "";
  let orgB = "";
  let orgC = "";

  interface Seed {
    id?: string;
    kind?: OutboxKind;
    refType?: string;
    ref: string;
    org?: string | null;
    to?: string;
    status?: OutboxStatus;
    createdAt: Date;
    statusAt?: Date;
  }

  /** One row, exactly as given. No body (allowed in every status); a `sending` row gets the lease its CHECK requires. */
  async function insertRow(x: typeof sql, s: Seed): Promise<string> {
    const id = s.id ?? randomUUID();
    const status = s.status ?? "queued";
    await x`
      insert into email_outbox
        (id, kind, ref_type, ref_id, org_id, recipient, subject, transactional, status, lease_until, expires_at, created_at, status_at)
      values
        (${id}, ${s.kind ?? "chess_invite"}, ${s.refType ?? REF_TYPE}, ${s.ref}, ${s.org === undefined ? orgA : s.org},
         ${s.to ?? `${randomUUID()}@x.test`}, 'subject', true, ${status},
         ${status === "sending" ? new Date(NOW + 5 * MIN) : null}, ${new Date(NOW + 60 * MIN)},
         ${s.createdAt}, ${s.statusAt ?? s.createdAt})`;
    return id;
  }
  /** History: rows already in a given status for one key, in the order given (the trigger is off for this transaction). */
  async function history(seeds: Seed[]): Promise<string[]> {
    return (await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      const ids: string[] = [];
      for (const s of seeds) ids.push(await insertRow(tx as unknown as typeof sql, s));
      return ids;
    })) as unknown as string[];
  }
  const newRef = (): string => `${RUN}-${randomUUID()}`;
  const latest = (org: string, ref: string | string[], refType = REF_TYPE): Promise<EmailStatusRow[]> =>
    latestEmailStatus(org, refType, Array.isArray(ref) ? ref : [ref]);

  beforeAll(async () => {
    const mk = async (tag: string): Promise<string> => {
      const [o] = await sql<{ id: string }[]>`
        insert into organizations (name, slug) values (${`Status ${tag}`}, ${`status-${tag}-${RUN}`}) returning id`;
      return o!.id;
    };
    orgA = await mk("a");
    orgB = await mk("b");
    orgC = await mk("c");
  });
  afterAll(async () => {
    await sql`delete from email_outbox where ref_id like ${`${RUN}-%`}`;
    await sql`delete from organizations where id in ${sql([orgA, orgB, orgC])}`;
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });

  // ---- latestEmailStatus ----------------------------------------------------------------------------------------------

  describe("latestEmailStatus", () => {
    it("newest non-replaced row per ref + recipient, case-folded; a replaced row is skipped even when it is the newest", async () => {
      const ref = newRef();
      await history([
        { ref, to: "Ann@x.test", status: "bounced", createdAt: minutesAgo(50), statusAt: minutesAgo(49) },
        { ref, to: "ANN@x.test", status: "sent", createdAt: minutesAgo(30), statusAt: minutesAgo(29) },
        { ref, to: "ann@x.test", status: "replaced", createdAt: minutesAgo(10), statusAt: minutesAgo(9) },
      ]);
      // One row: three spellings of one recipient are one recipient. Its status is the newest NON-replaced row's (the sent one,
      // although a replaced row is newer on the clock), and `at` is that row's `status_at`, the recipient is as that row stored it.
      expect(await latest(orgA, ref)).toEqual([
        { refId: ref, recipient: "ANN@x.test", kind: "chess_invite", status: "sent", at: minutesAgo(29) },
      ]);
    });

    it("a kind narrows the ask BEFORE the fold: a newer row of another kind on the same ref and mailbox neither answers nor hides the kind's own (final review m4)", async () => {
      const ref = newRef();
      await history([
        { ref, to: "ann@x.test", kind: "chess_invite", status: "delivered", createdAt: minutesAgo(30), statusAt: minutesAgo(29) },
        { ref, to: "ann@x.test", kind: "magic_link", status: "bounced", createdAt: minutesAgo(10), statusAt: minutesAgo(9) },
      ]);
      // Asked for the chess invite: its own row answers, although the other kind's row is the newest on the ref.
      const chess = await latestEmailStatus(orgA, REF_TYPE, [ref], "chess_invite");
      expect(chess.map((r) => [r.kind, r.status])).toEqual([["chess_invite", "delivered"]]);
      // The other kind asks for its own, and gets it; the positive pair, so the filter is for the kind and not a constant.
      expect((await latestEmailStatus(orgA, REF_TYPE, [ref], "magic_link")).map((r) => [r.kind, r.status])).toEqual([["magic_link", "bounced"]]);
      // A kind with no row on the ref answers nothing (not the other kind's row).
      const lonely = newRef();
      await history([{ ref: lonely, to: "bo@x.test", kind: "magic_link", status: "sent", createdAt: minutesAgo(5), statusAt: minutesAgo(4) }]);
      expect(await latestEmailStatus(orgA, REF_TYPE, [lonely], "chess_invite")).toEqual([]);
      // No kind asked: the newest of any kind answers, as before (the other callers' behaviour is unchanged).
      expect((await latest(orgA, ref)).map((r) => [r.kind, r.status])).toEqual([["magic_link", "bounced"]]);
    });

    it("sweeps the vocabulary: each status reads as itself when it is the only row, and a ref whose every row is replaced reads as none", async () => {
      let checked = 0;
      for (const status of OUTBOX_STATUSES) {
        const ref = newRef();
        await history([{ ref, to: "solo@x.test", status, createdAt: minutesAgo(20), statusAt: minutesAgo(19) }]);
        const rows = await latest(orgA, ref);
        if (status === "replaced") expect(rows, "replaced is never an answer").toEqual([]);
        else expect(rows, status).toEqual([{ refId: ref, recipient: "solo@x.test", kind: "chess_invite", status, at: minutesAgo(19) }]);
        checked += 1;
      }
      expect(checked, "anti-vacuity: every status in the registry was judged").toBe(OUTBOX_STATUSES.length);
    });

    it("ordering perturbs the key: the newer row has the SMALLER id and the OLDER status_at, and still wins", async () => {
      const ref = newRef();
      // `created_at` says: newer is the 'delivered' row. `id` says the other (larger). `status_at` says the other (later).
      await history([
        {
          id: idTail("ffff-4fff-8fff-ffffffffffff"),
          ref, to: "ann@x.test", status: "sent", createdAt: minutesAgo(40), statusAt: minutesAgo(1),
        },
        {
          id: idTail("0000-4000-8000-000000000001"),
          ref, to: "ann@x.test", status: "delivered", createdAt: minutesAgo(15), statusAt: minutesAgo(14),
        },
      ]);
      const [row, ...rest] = await latest(orgA, ref);
      expect(rest, "one recipient, one row").toEqual([]);
      expect(row).toMatchObject({ status: "delivered", at: minutesAgo(14) });
    });

    it("a tie on created_at falls to the larger id (six tied rows, inserted smallest id first)", async () => {
      const ref = newRef();
      const tied = Array.from({ length: 6 }, (_, i) => idTail(`0001-4000-8000-00000000000${i + 1}`));
      const statuses: OutboxStatus[] = ["queued", "sent", "delayed", "failed", "bounced", "delivered"];
      await history(tied.map((id, i) => ({ id, ref, to: "tie@x.test", status: statuses[i]!, createdAt: minutesAgo(5), statusAt: new Date(NOW - 5 * MIN + i * 1000) })));
      const rows = await latest(orgA, ref);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status, "the largest id of the tie").toBe(statuses[5]);
    });

    it("resend after dead: a dead row, then a fresh queued row for the same recipient, reads queued; before the resend it read dead", async () => {
      const ref = newRef();
      await history([{ ref, to: "Ann@x.test", status: "dead", createdAt: minutesAgo(60), statusAt: minutesAgo(59) }]);
      expect((await latest(orgA, ref)).map((r) => r.status), "premise: before the resend").toEqual(["dead"]);
      // The act is the SECOND insert, with the trigger live (a dead row is terminal, so it is not replaced).
      await insertRow(sql, { ref, to: "ann@x.test", status: "queued", createdAt: new Date(NOW) });
      const rows = await latest(orgA, ref);
      expect(rows.map((r) => r.status)).toEqual(["queued"]);
      expect((await sql<{ status: string }[]>`select status from email_outbox where ref_id = ${ref} and lower(recipient) = 'ann@x.test' and created_at < ${new Date(NOW)}`)[0]!.status, "the dead row stayed dead").toBe("dead");
    });

    it("two recipients on one ref are two rows; an unknown ref reads none; several refs in one call each answer for themselves", async () => {
      const refA = newRef();
      const refB = newRef();
      const unknown = newRef();
      await history([
        { ref: refA, to: "ann@x.test", status: "delivered", createdAt: minutesAgo(30) },
        { ref: refA, to: "bob@x.test", status: "failed", createdAt: minutesAgo(29) },
        { ref: refB, to: "ann@x.test", status: "queued", createdAt: minutesAgo(28) },
      ]);
      const rows = await latest(orgA, [refA, refB, unknown]);
      expect(rows.map((r) => [r.refId, r.recipient, r.status]).sort()).toEqual(
        [[refA, "ann@x.test", "delivered"], [refA, "bob@x.test", "failed"], [refB, "ann@x.test", "queued"]].sort(),
      );
      expect(await latest(orgA, unknown), "an unknown ref").toEqual([]);
      // A ref that was not asked about is not answered, however many exist for the org.
      expect((await latest(orgA, refB)).map((r) => r.refId)).toEqual([refB]);
    });

    it("another organisation's row with the same ref and recipient is never returned, and neither is an org-less row or another ref type (T8-R1)", async () => {
      const ref = newRef();
      // The other orgs' rows are the NEWEST, so a read that forgets the org filter returns one of them for orgA.
      await history([
        { ref, to: "ann@x.test", status: "delivered", createdAt: minutesAgo(40), org: orgA },
        { ref, to: "ann@x.test", status: "bounced", createdAt: minutesAgo(30), org: orgB },
        { ref, to: "ann@x.test", status: "dead", createdAt: minutesAgo(20), org: null },
        { ref, to: "ann@x.test", status: "failed", createdAt: minutesAgo(10), org: orgA, refType: "another_ref_type" },
      ]);
      expect((await latest(orgA, ref)).map((r) => r.status), "org A reads only its own").toEqual(["delivered"]);
      expect((await latest(orgB, ref)).map((r) => r.status), "org B reads only its own").toEqual(["bounced"]);
      expect(await latest(orgC, ref), "an org with no row for the ref reads none").toEqual([]);
      expect((await latest(orgA, ref, "another_ref_type")).map((r) => r.status)).toEqual(["failed"]);
    });

    it("the answer carries the kind of the row (a chess invite and a sign-in link are told apart)", async () => {
      const ref = newRef();
      await history([{ ref, kind: "magic_link", refType: "login", to: "ann@x.test", status: "sent", createdAt: minutesAgo(3), org: orgA }]);
      expect((await latest(orgA, ref, "login")).map((r) => r.kind)).toEqual(["magic_link"]);
    });
  });

  // ---- purgeOldEmails -------------------------------------------------------------------------------------------------

  describe("purgeOldEmails", () => {
    const ageOf = (days: number, extraMs = 0): Date => new Date(NOW - days * DAY - extraMs);
    const rowsLeft = async (ids: string[]): Promise<Set<string>> =>
      new Set((await sql<{ id: string }[]>`select id from email_outbox where id = any(${ids}::uuid[])`).map((r) => r.id));

    it("removes a row older than RETENTION_DAYS, whatever its status, and keeps a row a day younger (and one a minute inside)", async () => {
      const old: string[] = [];
      const young: string[] = [];
      for (const status of OUTBOX_STATUSES) {
        old.push(...(await history([{ ref: newRef(), org: null, status, createdAt: ageOf(RETENTION_DAYS, 3_600_000) }])));
        young.push(...(await history([{ ref: newRef(), org: null, status, createdAt: ageOf(RETENTION_DAYS - 1) }])));
      }
      // The boundary: a minute past the retention goes, a minute inside it stays. Anchored to the DATABASE's clock (M2 of the Task 8
      // review): the rows are written, then moved to `now()` less the retention, so the minute's margin is measured by the one clock
      // that does the comparing, whatever the test process's clock reads or how long the module has been loaded.
      const justOut = (await history([{ ref: newRef(), org: null, status: "sent", createdAt: new Date(NOW) }]))[0]!;
      const justIn = (await history([{ ref: newRef(), org: null, status: "sent", createdAt: new Date(NOW) }]))[0]!;
      await sql`update email_outbox set created_at = now() - make_interval(secs => ${RETENTION_SECS + 60}) where id = ${justOut}`;
      await sql`update email_outbox set created_at = now() - make_interval(secs => ${RETENTION_SECS - 60}) where id = ${justIn}`;
      old.push(justOut);
      young.push(justIn);
      const all = [...old, ...young];
      expect(old.length, "anti-vacuity: one old row per status, plus the boundary row").toBe(OUTBOX_STATUSES.length + 1);

      expect(await purgeOldEmails({ onlyIds: all })).toBe(old.length);
      const left = await rowsLeft(all);
      expect(old.filter((id) => left.has(id)), "no old row survived").toEqual([]);
      expect(young.filter((id) => !left.has(id)), "no young row was removed").toEqual([]);
    });

    it("M1: the cut-off is STRICT - a row exactly RETENTION_DAYS old, to the microsecond, is kept; one microsecond older goes; one microsecond younger stays", async () => {
      // `now()` is the transaction's start time and does not move inside it, so a row can be written EXACTLY on the cut-off the purge
      // computes in the same transaction. The purge runs through the `db` seam on that transaction, scoped to these three rows, and
      // the transaction is rolled back, so nothing is left and no other file's rows are touched. A `<=` in the purge also deletes
      // the exact row, which reads as 2 removed and `exactly: false` below.
      class Rollback extends Error {}
      const seen: { offsets: string[]; removed: number; left: { exactly: boolean; older: boolean; younger: boolean } } = {
        offsets: [],
        removed: -1,
        left: { exactly: false, older: false, younger: false },
      };
      await expect(
        sql.begin(async (tx) => {
          const t = tx as unknown as typeof sql;
          const mk = (): Promise<string> => insertRow(t, { ref: newRef(), org: null, status: "dead", createdAt: new Date(NOW) });
          const exactly = await mk();
          const older = await mk();
          const younger = await mk();
          await tx`update email_outbox set created_at = now() - make_interval(secs => ${RETENTION_SECS}) where id = ${exactly}`;
          await tx`update email_outbox set created_at = now() - make_interval(secs => ${RETENTION_SECS}) - interval '1 microsecond' where id = ${older}`;
          await tx`update email_outbox set created_at = now() - make_interval(secs => ${RETENTION_SECS}) + interval '1 microsecond' where id = ${younger}`;
          // Premise: the boundary rows really sit where they claim (the offsets from the cut-off, in microseconds, read from the database).
          const offsets = await tx<{ id: string; us: string }[]>`
            select id, (extract(epoch from (created_at - (now() - make_interval(secs => ${RETENTION_SECS})))) * 1000000)::bigint::text as us
              from email_outbox where id = any(${[exactly, older, younger]}::uuid[])`;
          seen.offsets = [older, exactly, younger].map((id) => offsets.find((r) => r.id === id)?.us ?? "missing");
          seen.removed = await purgeOldEmails({ db: tx, onlyIds: [exactly, older, younger] });
          const present = new Set((await tx<{ id: string }[]>`select id from email_outbox where id = any(${[exactly, older, younger]}::uuid[])`).map((r) => r.id));
          seen.left = { exactly: present.has(exactly), older: present.has(older), younger: present.has(younger) };
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      expect(seen.offsets, "premise: the rows sit at -1, 0 and +1 microsecond from the cut-off").toEqual(["-1", "0", "1"]);
      expect(seen.removed, "only the row OLDER than the cut-off was removed").toBe(1);
      expect(seen.left).toEqual({ exactly: true, older: false, younger: true });
    });

    it("never removes more than PURGE_BATCH in one call, the OLDEST first, and the rest go on the next calls; a drained purge removes none", async () => {
      const extra = 3;
      const total = PURGE_BATCH + extra;
      // created_at runs from RETENTION_DAYS + 1 day old (n = 0, the oldest) towards RETENTION_DAYS + 1 day less `total` seconds (the
      // newest), so the three that must be left are the three NEWEST, and the row order of the heap is not the order of the key.
      const base = NOW - (RETENTION_DAYS + 1) * DAY;
      const ids = (await sql<{ id: string }[]>`
        insert into email_outbox (id, kind, ref_type, ref_id, org_id, recipient, subject, transactional, status, expires_at, created_at, status_at)
        select gen_random_uuid(), 'magic_link', 'login', ${`${RUN}-batch-`}::text || n, null, 'batch' || n || '@x.test', 's', true, 'expired',
               ${new Date(NOW)}::timestamptz, ${new Date(base)}::timestamptz + make_interval(secs => (${total}::int - n)::double precision),
               ${new Date(base)}::timestamptz
          from generate_series(1, ${total}::int) as n
        returning id`).map((r) => r.id);
      expect(ids).toHaveLength(total);
      // `n` counts down from `total`, so created_at is oldest for the LARGEST n: order the ids oldest -> newest by the key itself.
      const byAge = (await sql<{ id: string }[]>`select id from email_outbox where id = any(${ids}::uuid[]) order by created_at, id`).map((r) => r.id);

      expect(await purgeOldEmails({ onlyIds: ids }), "the first call is bounded").toBe(PURGE_BATCH);
      const left = await rowsLeft(ids);
      expect([...left].sort(), "the oldest PURGE_BATCH went, the newest `extra` stayed").toEqual(byAge.slice(PURGE_BATCH).sort());
      expect(await purgeOldEmails({ onlyIds: ids }), "the second call takes the rest").toBe(extra);
      expect((await rowsLeft(ids)).size).toBe(0);
      expect(await purgeOldEmails({ onlyIds: ids }), "the empty case: nothing left, nothing removed").toBe(0);
    });

    it("is one statement, and the scope restricts it: [] removes nothing, a list removes only those rows", async () => {
      const a = (await history([{ ref: newRef(), org: null, status: "expired", createdAt: ageOf(RETENTION_DAYS, DAY) }]))[0]!;
      const b = (await history([{ ref: newRef(), org: null, status: "expired", createdAt: ageOf(RETENTION_DAYS, DAY) }]))[0]!;
      expect(await purgeOldEmails({ onlyIds: [] }), "an empty scope is no row, not every row").toBe(0);
      expect((await rowsLeft([a, b])).size).toBe(2);
      const before = statementCount();
      expect(await purgeOldEmails({ onlyIds: [a] })).toBe(1);
      expect(statementCount() - before, "one bounded delete").toBe(1);
      expect([...(await rowsLeft([a, b]))]).toEqual([b]);
      expect(await purgeOldEmails({ onlyIds: [b] })).toBe(1);
    });

    it("skips a row another transaction holds instead of waiting for it, and takes it on the next call once it is released", async () => {
      // A purge that waited on a held row would stall the whole tick (it is the tick's last statement, after its sends). The holder
      // is a transaction that has `select ... for update` the row, as a worker mid-claim or a hook mid-write would.
      const held = (await history([{ ref: newRef(), org: null, status: "expired", createdAt: ageOf(RETENTION_DAYS, DAY) }]))[0]!;
      const free = (await history([{ ref: newRef(), org: null, status: "expired", createdAt: ageOf(RETENTION_DAYS, DAY) }]))[0]!;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockedP = new Promise<void>((resolve) => (locked = resolve));
      const holder = sql.begin(async (tx) => {
        await tx`select id from email_outbox where id = ${held} for update`;
        locked();
        await gate;
      });
      try {
        await lockedP;
        const WAITED = "waited";
        const first = await Promise.race([purgeOldEmails({ onlyIds: [held, free] }), new Promise<string>((r) => setTimeout(() => r(WAITED), 4_000))]);
        expect(first, "the purge did not wait for the held row").not.toBe(WAITED);
        expect(first, "and deleted the free one").toBe(1);
        expect([...(await rowsLeft([held, free]))], "the held row is still there").toEqual([held]);
      } finally {
        release();
        await holder;
      }
      expect(await purgeOldEmails({ onlyIds: [held] }), "released: the next call takes it").toBe(1);
    });

    it("the production call (no scope) removes old rows and leaves young ones; run in a transaction that is rolled back, so no other file's rows are touched", async () => {
      class Rollback extends Error {}
      let removed = -1;
      let leftInTx: { old: boolean; young: boolean } | null = null;
      await expect(
        sql.begin(async (tx) => {
          const t = tx as unknown as typeof sql;
          const old = await insertRow(t, { ref: newRef(), org: null, status: "dead", createdAt: ageOf(RETENTION_DAYS, DAY) });
          const young = await insertRow(t, { ref: newRef(), org: null, status: "dead", createdAt: ageOf(RETENTION_DAYS - 1) });
          removed = await purgeOldEmails({ db: tx });
          const present = new Set((await tx<{ id: string }[]>`select id from email_outbox where id = any(${[old, young]}::uuid[])`).map((r) => r.id));
          leftInTx = { old: present.has(old), young: present.has(young) };
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      expect(removed, "at least the one old row this transaction wrote").toBeGreaterThanOrEqual(1);
      expect(leftInTx).toEqual({ old: false, young: true });
    });
  });
});
